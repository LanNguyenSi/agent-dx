import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { substitutePlaceholders } from "./dataset.js";
import type { DatasetEntry } from "./dataset.js";
import { checkReturn, mediumPlusCount } from "./score.js";
import type { RunResult, RunStatus } from "./score.js";
import { sha256, splitPrompt } from "./variants.js";
import type { PromptVariant } from "./variants.js";

export const RESULT_SCHEMA = 1;

/** Variables that could carry a credential for a write path; blanked in every child. */
export const BLANKED_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
];

/** Tools the session may not use: file edits, as in the shipped agent, plus subagents and the web. */
export const DISALLOWED_TOOLS = [
  "Agent",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "NotebookEdit",
];

export const EVAL_TARGET_BLOCK = [
  "## Review target (evaluation harness)",
  "",
  "The change under review is the commit range {{BASE_SHA}}..{{HEAD_SHA}} of the repository checked out in {{WORKTREE}}. HEAD is detached at the head commit and the working tree is clean. Run files named in the briefing (other briefs, evidence files, run notes, tracker pages) do not exist in this environment; the common reviewer rules and the task specification are inlined in this message. Treat a missing run file as unavailable evidence, not as a finding against the change. There is no tracker and no network path out of this environment.",
  "",
  "Return your normal reviewer output.",
].join("\n");

/** Environment for a child: credentials blanked, prompts for credentials off. */
export function scrubEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of BLANKED_ENV) env[name] = "";
  env.GIT_TERMINAL_PROMPT = "0";
  return { ...env, ...extra };
}

export interface GroupedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  stdoutFile: string;
  stderrFile: string;
  killGraceMs?: number;
}

export interface GroupedResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  wallMs: number;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs a command in its own process group with a wall-clock bound. On the
 * bound the whole group gets SIGTERM, then SIGKILL after a grace period; and
 * once the leader has exited, any group member it left behind is killed too.
 */
export function runGrouped(
  command: string,
  args: string[],
  options: GroupedOptions,
): Promise<GroupedResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = openSync(options.stdoutFile, "a");
    const err = openSync(options.stderrFile, "a");
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", out, err],
    });
    const pid = child.pid;

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (pid !== undefined) killGroup(pid, "SIGKILL");
      closeSync(out);
      closeSync(err);
      resolve({
        code,
        signal,
        timedOut,
        spawnError,
        wallMs: Date.now() - started,
      });
    };

    let hardTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killGroup(pid, "SIGTERM");
      hardTimer = setTimeout(() => {
        if (pid !== undefined) killGroup(pid, "SIGKILL");
      }, options.killGraceMs ?? 3000);
    }, options.timeoutMs);

    child.on("error", (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));

    child.stdin?.on("error", () => {
      // The child may exit before reading its input.
    });
    child.stdin?.end(options.stdin ?? "");
  });
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export interface CheckoutResult {
  setupOk: boolean;
  dirtyAfterSetup: boolean;
  error: string | null;
}

const DEFAULT_SETUP_TIMEOUT_S = 900;

/**
 * Builds an isolated checkout of the entry's head commit: a fresh repository
 * that fetches only the head and base commits from the local source (so no
 * later history and no tags exist in it), detached at the head, with the
 * remote removed again before anything runs. Then runs the setup commands.
 */
export async function prepareCheckout(
  entry: DatasetEntry,
  dir: string,
  env: NodeJS.ProcessEnv,
  setupLog: string,
): Promise<CheckoutResult> {
  const { path, head_sha: head, base_sha: base } = entry.repo;
  try {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--quiet"], env);
    git(dir, ["config", "gc.auto", "0"], env);
    git(dir, ["remote", "add", "origin", path], env);
    git(
      dir,
      [
        "-c",
        "uploadpack.allowAnySHA1InWant=true",
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        head,
        base,
      ],
      env,
    );
    git(
      dir,
      [
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--quiet",
        "--detach",
        head,
      ],
      env,
    );
    git(dir, ["remote", "remove", "origin"], env);
    rmSync(join(dir, ".git", "FETCH_HEAD"), { force: true });
    if (git(dir, ["remote"], env).trim().length > 0) {
      throw new Error("a git remote is still configured in the checkout");
    }
  } catch (error) {
    return {
      setupOk: false,
      dirtyAfterSetup: false,
      error: `checkout failed: ${error instanceof Error ? error.message : error}`,
    };
  }
  for (const [i, command] of entry.setup.entries()) {
    const result = await runGrouped(command.argv[0], command.argv.slice(1), {
      cwd: join(dir, command.cwd),
      env,
      timeoutMs: (command.timeout_s ?? DEFAULT_SETUP_TIMEOUT_S) * 1000,
      stdoutFile: setupLog,
      stderrFile: setupLog,
    });
    if (result.code !== 0 || result.timedOut || result.spawnError !== null) {
      return {
        setupOk: false,
        dirtyAfterSetup: false,
        error: `setup command ${i + 1} (${command.argv.join(" ")}) failed: ${
          result.spawnError ??
          (result.timedOut ? "timeout" : `exit ${result.code}`)
        }`,
      };
    }
  }
  const dirty = git(dir, ["status", "--porcelain"], env).trim().length > 0;
  return { setupOk: true, dirtyAfterSetup: dirty, error: null };
}

export interface RunnerOptions {
  claudeBin: string;
  model: string;
  effort: string;
  timeoutMs: number;
  budgetUsd: number;
  /** Directory the per-run checkouts are created in; must be outside any repository under test. */
  scratchRoot: string;
  /** Directory the run records are written to. */
  outDir: string;
  /** Pass `--bare`: no hooks, no CLAUDE.md discovery, API-key auth only. */
  bare: boolean;
  /** Point HOME and the Claude config dir at a scratch directory for the session. */
  isolateHome: boolean;
  /** Name of the environment variable that holds the API key. */
  apiKeyEnv: string;
  keepCheckout: boolean;
  force: boolean;
  env: NodeJS.ProcessEnv;
}

export function runDirFor(
  outDir: string,
  variantId: string,
  entryId: string,
  repeat: number,
): string {
  return join(outDir, variantId, entryId, `run-${repeat}`);
}

/** Arguments of the headless session; the prompt itself goes in on stdin. */
export function buildSessionArgs(options: {
  agentsFile: string;
  model: string;
  effort: string;
  budgetUsd: number;
  bare: boolean;
}): string[] {
  const args = [
    "-p",
    "--agents",
    options.agentsFile,
    "--agent",
    "reviewer",
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
    "--no-session-persistence",
    "--output-format",
    "json",
    "--max-budget-usd",
    String(options.budgetUsd),
  ];
  if (options.bare) args.push("--bare");
  return args;
}

/** The message the session receives: briefing, fixed target block, task specification. */
export function composePrompt(
  entry: DatasetEntry,
  values: { worktree: string; evidenceDir: string; runDir: string },
): string {
  const map = {
    WORKTREE: values.worktree,
    EVIDENCE_DIR: values.evidenceDir,
    RUN_DIR: values.runDir,
    BASE_SHA: entry.repo.base_sha,
    HEAD_SHA: entry.repo.head_sha,
  };
  return substitutePlaceholders(
    [
      entry.brief,
      "",
      EVAL_TARGET_BLOCK,
      "",
      "## Task specification",
      "",
      entry.task_spec,
      "",
    ].join("\n"),
    map,
  );
}

interface SessionJson {
  result?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseSession(stdoutFile: string): SessionJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stdoutFile, "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as SessionJson)
      : null;
  } catch {
    return null;
  }
}

/** Runs one entry once with one prompt variant and writes the run record. */
export async function runEntry(
  entry: DatasetEntry,
  variant: PromptVariant,
  repeat: number,
  options: RunnerOptions,
): Promise<RunResult> {
  const runDir = runDirFor(options.outDir, variant.id, entry.id, repeat);
  const resultFile = join(runDir, "result.json");
  if (!options.force && existsSync(resultFile)) {
    return JSON.parse(readFileSync(resultFile, "utf8")) as RunResult;
  }
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const evidenceDir = join(runDir, "evidence");
  const runFilesDir = join(runDir, "rundir");
  mkdirSync(evidenceDir);
  mkdirSync(runFilesDir);

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const cloneDir = join(
    options.scratchRoot,
    `${variant.id}-${entry.id}-r${repeat}`,
  );
  rmSync(cloneDir, { recursive: true, force: true });
  mkdirSync(options.scratchRoot, { recursive: true });

  const baseEnv = scrubEnv(options.env);
  const setupLog = join(runDir, "setup.log");
  const checkout = await prepareCheckout(entry, cloneDir, baseEnv, setupLog);

  const composedPrompt = composePrompt(entry, {
    worktree: cloneDir,
    evidenceDir,
    runDir: runFilesDir,
  });
  writeFileSync(join(runDir, "prompt.md"), composedPrompt);

  const record = (
    status: RunStatus,
    session: {
      code: number | null;
      signal: string | null;
      finalText: string;
      cost: number | null;
      turns: number | null;
      sessionMs: number | null;
      sessionWallMs: number | null;
    },
  ): RunResult => {
    if (!options.keepCheckout)
      rmSync(cloneDir, { recursive: true, force: true });
    const result: RunResult = {
      schema: RESULT_SCHEMA,
      entry_id: entry.id,
      kind: entry.kind,
      repeat,
      started_at: startedAt,
      variant: {
        id: variant.id,
        source: variant.source,
        sha256: variant.sha256,
      },
      prompt_sha256: sha256(composedPrompt),
      model: options.model,
      effort: options.effort,
      status,
      exit_code: session.code,
      signal: session.signal,
      wall_ms: Date.now() - started,
      session_wall_ms: session.sessionWallMs,
      cost_usd: session.cost,
      turns: session.turns,
      session_ms: session.sessionMs,
      final_text: session.finalText,
      check: checkReturn(session.finalText),
      checkout: {
        head_sha: entry.repo.head_sha,
        setup_ok: checkout.setupOk,
        dirty_after_setup: checkout.dirtyAfterSetup,
        cleaned_up: !existsSync(cloneDir),
      },
    };
    writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };

  if (!checkout.setupOk) {
    writeFileSync(join(runDir, "setup-error.txt"), `${checkout.error ?? ""}\n`);
    return record("setup_failed", {
      code: null,
      signal: null,
      finalText: "",
      cost: null,
      turns: null,
      sessionMs: null,
      sessionWallMs: null,
    });
  }

  const { frontmatter, body } = splitPrompt(variant.text);
  const agentsFile = join(runDir, "agents.json");
  writeFileSync(
    agentsFile,
    `${JSON.stringify(
      {
        reviewer: {
          description:
            typeof frontmatter.description === "string"
              ? frontmatter.description
              : "Reviewer under test",
          prompt: body,
        },
      },
      null,
      2,
    )}\n`,
  );

  const extra: Record<string, string> = {};
  if (options.bare) {
    const key = options.env[options.apiKeyEnv];
    if (key !== undefined) extra.ANTHROPIC_API_KEY = key;
    if (options.isolateHome) {
      const home = join(runDir, "home");
      mkdirSync(join(home, ".claude"), { recursive: true });
      extra.HOME = home;
      extra.CLAUDE_CONFIG_DIR = join(home, ".claude");
    }
  }
  const stdoutFile = join(runDir, "session.json");
  const stderrFile = join(runDir, "stderr.log");
  const session = await runGrouped(
    options.claudeBin,
    buildSessionArgs({
      agentsFile,
      model: options.model,
      effort: options.effort,
      budgetUsd: options.budgetUsd,
      bare: options.bare,
    }),
    {
      cwd: cloneDir,
      env: scrubEnv(options.env, extra),
      timeoutMs: options.timeoutMs,
      stdin: composedPrompt,
      stdoutFile,
      stderrFile,
    },
  );
  if (options.isolateHome)
    rmSync(join(runDir, "home"), { recursive: true, force: true });

  const json = session.timedOut ? null : parseSession(stdoutFile);
  const finalText = json && typeof json.result === "string" ? json.result : "";
  let status: RunStatus = "completed";
  if (session.timedOut) status = "timeout";
  else if (
    session.spawnError !== null ||
    json === null ||
    json.is_error === true ||
    session.code !== 0
  ) {
    status = "session_failed";
  }
  return record(status, {
    code: session.code,
    signal: session.signal,
    finalText,
    cost: json ? num(json.total_cost_usd) : null,
    turns: json ? num(json.num_turns) : null,
    sessionMs: json ? num(json.duration_ms) : null,
    sessionWallMs: session.wallMs,
  });
}

/** One-line progress summary of a run. */
export function summarizeRun(result: RunResult): string {
  const cost = result.cost_usd === null ? "n/a" : result.cost_usd.toFixed(2);
  return `${result.variant.id} ${result.entry_id} run-${result.repeat}: ${result.status}, valid=${result.check.valid}, medium+ findings=${mediumPlusCount(result.check)}, cost=${cost} USD, ${(result.wall_ms / 1000).toFixed(0)} s`;
}
