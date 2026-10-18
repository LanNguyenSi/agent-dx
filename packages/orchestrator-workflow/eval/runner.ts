import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { substitutePlaceholders } from "./dataset.js";
import type { DatasetEntry } from "./dataset.js";
import {
  DISALLOWED_TOOLS,
  createRunScratch,
  hostGitEnv,
  pathForms,
  protectedHome,
  redactSecrets,
  sessionEnv,
  sessionSettings,
  setupEnv,
  setupNpmCache,
  systemTempRoots,
} from "./isolation.js";
import type { RunScratch } from "./isolation.js";
import { runGuarded } from "./processes.js";
import type { GuardedResult } from "./processes.js";
import { checkReturn, mediumPlusCount } from "./score.js";
import type { ProcessRecord, RunResult, RunStatus } from "./score.js";
import { sha256, splitPrompt } from "./variants.js";
import type { PromptVariant } from "./variants.js";

export { DISALLOWED_TOOLS } from "./isolation.js";
export { runGrouped } from "./processes.js";
export type { GroupedOptions, GroupedResult } from "./processes.js";

export const RESULT_SCHEMA = 2;

export const EVAL_TARGET_BLOCK = [
  "## Review target (evaluation harness)",
  "",
  "The change under review is the commit range {{BASE_SHA}}..{{HEAD_SHA}} of the repository checked out in {{WORKTREE}}. HEAD is detached at the head commit and the working tree is clean. Run files named in the briefing (other briefs, evidence files, run notes, tracker pages) do not exist in this environment; the common reviewer rules and the task specification are inlined in this message. Treat a missing run file as unavailable evidence, not as a finding against the change. There is no tracker and no network path out of this environment.",
  "",
  "Return your normal reviewer output.",
].join("\n");

const GIT_TIMEOUT_MS = 300_000;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

/** How a guarded command ended, for the run record. */
export function processRecord(result: GuardedResult): ProcessRecord {
  return {
    guard_reason: result.guard?.reason ?? null,
    guard_leftovers:
      (result.guard?.leftover_count ?? 0) + (result.guard?.survivor_count ?? 0),
    guard_killed: result.guard?.killed_count ?? 0,
    leftover_check_failed: result.guard?.leftover_check_failed ?? false,
    peak_rss_mib: result.guard?.peak_rss_mib ?? null,
    swept: result.swept.killed,
    sweep_unavailable: result.swept.unavailable,
    processes: result.guard?.processes ?? [],
  };
}

export interface GuardSettings {
  /** The `agent-primitives` binary. */
  bin: string;
  maxRssMiB: number;
  /** Directory guard's envelopes and logs go to. */
  logDir: string;
  /** Directories whose resident processes are killed after each command. */
  sweepRoots: string[];
}

export interface CheckoutResult {
  setupOk: boolean;
  dirtyAfterSetup: boolean;
  error: string | null;
  processes: ProcessRecord[];
}

const DEFAULT_SETUP_TIMEOUT_S = 900;

/**
 * Builds an isolated checkout of the entry's head commit: a fresh repository
 * that fetches only the head and base commits from the local source (so no
 * later history and no tags exist in it), detached at the head, with the
 * remote removed again before anything runs. Then runs the setup commands,
 * each under `agent-primitives guard`, with `env` (the setup allowlist).
 */
export async function prepareCheckout(
  entry: DatasetEntry,
  dir: string,
  env: NodeJS.ProcessEnv,
  setupLog: string,
  guard: GuardSettings,
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
      processes: [],
    };
  }
  const processes: ProcessRecord[] = [];
  for (const [i, command] of entry.setup.entries()) {
    const result = await runGuarded(command.argv[0], command.argv.slice(1), {
      guardBin: guard.bin,
      cwd: join(dir, command.cwd),
      env,
      timeoutMs: (command.timeout_s ?? DEFAULT_SETUP_TIMEOUT_S) * 1000,
      maxRssMiB: guard.maxRssMiB,
      stdinFile: null,
      stdoutFile: setupLog,
      stderrFile: setupLog,
      logDir: join(guard.logDir, `setup-${i + 1}`),
      sweepRoots: guard.sweepRoots,
    });
    processes.push(processRecord(result));
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.rssCapHit ||
      result.spawnError !== null
    ) {
      return {
        setupOk: false,
        dirtyAfterSetup: false,
        error: `setup command ${i + 1} (${command.argv.join(" ")}) failed: ${
          result.spawnError ??
          (result.timedOut
            ? "timeout"
            : result.rssCapHit
              ? "memory cap"
              : `exit ${result.code}`)
        }`,
        processes,
      };
    }
  }
  const dirty = git(dir, ["status", "--porcelain"], env).trim().length > 0;
  return { setupOk: true, dirtyAfterSetup: dirty, error: null, processes };
}

export interface RunnerOptions {
  claudeBin: string;
  /** The `agent-primitives` binary that bounds every command. */
  guardBin: string;
  model: string;
  effort: string;
  timeoutMs: number;
  budgetUsd: number;
  /** Cap on the summed resident memory of a session's or a setup command's process tree. */
  maxRssMiB: number;
  /** Directory the per-run scratch directories are created in; outside the home and the dataset tree. */
  scratchRoot: string;
  /** Directory the run records are written to. */
  outDir: string;
  /** The dataset directory; its parent tree is read-denied to the session. */
  datasetDir: string;
  /** Pass `--bare`: no hooks, no CLAUDE.md discovery, API-key auth only. */
  bare: boolean;
  /** Name of the environment variable that holds the API key. */
  apiKeyEnv: string;
  keepCheckout: boolean;
  force: boolean;
  /** Run again an entry whose stored record did not complete. */
  retryFailed: boolean;
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
  settingsFile: string;
  addDirs: string[];
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
    // `claude --help` (2.1.302): with "none" anything that would prompt is denied
    // automatically instead of waiting for an answer nobody gives.
    "--permission-prompts",
    "none",
    "--settings",
    options.settingsFile,
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
  for (const dir of options.addDirs) args.push("--add-dir", dir);
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

/**
 * The strings a text shown to the reviewer or the judge must not contain:
 * the entry id and every path of the results, dataset and home trees.
 */
export function forbiddenStrings(
  entryId: string,
  options: Pick<RunnerOptions, "outDir" | "datasetDir" | "env">,
): string[] {
  return [
    entryId,
    ...pathForms(options.outDir),
    ...pathForms(options.datasetDir),
    ...pathForms(dirname(options.datasetDir)),
    ...pathForms(protectedHome(options.env)),
  ];
}

/** The forbidden strings that occur in `text`. */
export function blindnessViolations(
  text: string,
  forbidden: string[],
): string[] {
  return forbidden.filter((s) => s.length > 0 && text.includes(s));
}

/** The session settings for one run (see `sessionSettings`). */
export function settingsForRun(
  entry: DatasetEntry | null,
  scratch: RunScratch,
  options: Pick<RunnerOptions, "scratchRoot" | "outDir" | "datasetDir" | "env">,
): Record<string, unknown> {
  return sessionSettings({
    scratch,
    scratchRoot: options.scratchRoot,
    denied: [
      protectedHome(options.env),
      dirname(options.datasetDir),
      options.outDir,
      ...(entry === null ? [] : [entry.repo.path]),
    ],
    tempRoots: systemTempRoots(),
  });
}

/** `claude --version` of a binary, run with `env` (no key), or null when it fails. */
export function cliVersion(
  claudeBin: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const r = spawnSync(claudeBin, ["--version"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const out = r.status === 0 ? r.stdout.trim() : "";
  return out.length > 0 ? out : null;
}

/** Writes the agent definition the session runs as. */
export function writeAgentsFile(file: string, variant: PromptVariant): void {
  const { frontmatter, body } = splitPrompt(variant.text);
  writeFileSync(
    file,
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
}

export interface SessionJson {
  result?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseSession(stdoutFile: string): SessionJson | null {
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

/**
 * What Claude Code prints to stderr when it ignores `--permission-mode` and
 * runs in `default` mode, where a headless session stalls on its first
 * approval.
 */
export const FORCED_MODE_MARKER = "Permission mode forced";

/** The session's stderr, or "" when it is missing. */
export function readStderr(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Status of a finished session, with the reason when it did not complete. */
export function sessionStatus(
  session: GuardedResult,
  json: SessionJson | null,
  stderr: string,
): { status: RunStatus; failure: string | null } {
  const forced = stderr
    .split("\n")
    .find((line) => line.includes(FORCED_MODE_MARKER));
  if (forced !== undefined)
    return {
      status: "session_failed",
      failure: `permission mode not applied: ${forced.trim().slice(0, 200)}`,
    };
  if (session.timedOut)
    return { status: "timeout", failure: "wall-clock bound" };
  if (session.spawnError !== null)
    return { status: "session_failed", failure: session.spawnError };
  if (session.rssCapHit)
    return { status: "session_failed", failure: "memory cap" };
  if (json === null)
    return { status: "session_failed", failure: "no JSON result on stdout" };
  if (json.is_error === true)
    return {
      status: "session_failed",
      failure: "the session reported an error",
    };
  if (session.code !== 0)
    return { status: "session_failed", failure: `exit ${session.code}` };
  return { status: "completed", failure: null };
}

const MAX_COPIED_FILE = 32 * 1024 * 1024;

/** Copies regular files and directories only: no symlink, FIFO or device is followed or opened. */
function copyPlain(from: string, to: string): void {
  if (!existsSync(from)) return;
  try {
    cpSync(from, to, {
      recursive: true,
      filter: (src) => {
        const st = lstatSync(src);
        return st.isDirectory() || (st.isFile() && st.size <= MAX_COPIED_FILE);
      },
    });
  } catch {
    // A record copy is best effort; the run result does not depend on it.
  }
}

/** Removes a tree, also one the session made unwritable. */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    try {
      execFileSync("chmod", ["-R", "u+rwx", path], {
        stdio: "ignore",
        timeout: 60_000,
        env: hostGitEnv(process.env),
      });
    } catch {
      // Fall through to the second attempt.
    }
    rmSync(path, { recursive: true, force: true });
  }
}

const META_FILES = [
  "prompt.md",
  "agents.json",
  "settings.json",
  "session.json",
  "stderr.log",
];

/** Runs one entry once with one prompt variant and writes the run record. */
export async function runEntry(
  entry: DatasetEntry,
  variant: PromptVariant,
  repeat: number,
  options: RunnerOptions,
): Promise<RunResult> {
  const runDir = runDirFor(options.outDir, variant.id, entry.id, repeat);
  const resultFile = join(runDir, "result.json");
  let previousStatus: RunStatus | null = null;
  if (!options.force && existsSync(resultFile)) {
    const stored = JSON.parse(readFileSync(resultFile, "utf8")) as RunResult;
    if (stored.status === "completed" || !options.retryFailed) return stored;
    previousStatus = stored.status;
  }
  removeTree(runDir);
  mkdirSync(runDir, { recursive: true });

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const apiKey = options.env[options.apiKeyEnv];
  const scratch = createRunScratch(options.scratchRoot);
  const guard: GuardSettings = {
    bin: options.guardBin,
    maxRssMiB: options.maxRssMiB,
    logDir: join(runDir, "guard"),
    sweepRoots: [scratch.root],
  };

  const setupLog = join(runDir, "setup.log");
  const childSetupEnv = setupEnv(options.env, {
    scratch,
    npmCache: setupNpmCache(options.scratchRoot),
  });
  const version = cliVersion(options.claudeBin, childSetupEnv);
  const checkout = await prepareCheckout(
    entry,
    scratch.checkout,
    childSetupEnv,
    setupLog,
    guard,
  );

  const composedPrompt = composePrompt(entry, {
    worktree: scratch.checkout,
    evidenceDir: scratch.evidence,
    runDir: scratch.runFiles,
  });
  const promptFile = join(scratch.meta, "prompt.md");
  writeFileSync(promptFile, composedPrompt);
  const agentsFile = join(scratch.meta, "agents.json");
  writeAgentsFile(agentsFile, variant);
  const settingsFile = join(scratch.meta, "settings.json");
  writeFileSync(
    settingsFile,
    `${JSON.stringify(settingsForRun(entry, scratch, options), null, 2)}\n`,
  );

  let sessionProcesses: ProcessRecord | null = null;
  const record = (
    status: RunStatus,
    failure: string | null,
    session: {
      code: number | null;
      finalText: string;
      cost: number | null;
      turns: number | null;
      sessionMs: number | null;
      sessionWallMs: number | null;
    },
  ): RunResult => {
    // The API key never reaches a record, even if the session printed it.
    const keyOnly =
      apiKey === undefined ? [] : [{ name: "the API key", value: apiKey }];
    for (const name of META_FILES) {
      const from = join(scratch.meta, name);
      if (existsSync(from))
        writeFileSync(
          join(runDir, name),
          redactSecrets(readFileSync(from, "utf8"), keyOnly),
        );
    }
    copyPlain(scratch.evidence, join(runDir, "evidence"));
    if (!options.keepCheckout) removeTree(scratch.root);
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
      cli_version: version,
      status,
      failure,
      exit_code: session.code,
      signal: null,
      wall_ms: Date.now() - started,
      session_wall_ms: session.sessionWallMs,
      cost_usd: session.cost,
      turns: session.turns,
      session_ms: session.sessionMs,
      final_text: redactSecrets(session.finalText, keyOnly),
      check: checkReturn(session.finalText),
      scratch_id: scratch.id,
      paths: {
        worktree: scratch.checkout,
        evidence: scratch.evidence,
        run_files: scratch.runFiles,
      },
      checkout: {
        head_sha: entry.repo.head_sha,
        setup_ok: checkout.setupOk,
        dirty_after_setup: checkout.dirtyAfterSetup,
        cleaned_up: !existsSync(scratch.checkout),
      },
      processes: { setup: checkout.processes, session: sessionProcesses },
      previous_status: previousStatus,
    };
    writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
  const noSession = {
    code: null,
    finalText: "",
    cost: null,
    turns: null,
    sessionMs: null,
    sessionWallMs: null,
  };

  if (!checkout.setupOk) {
    writeFileSync(join(runDir, "setup-error.txt"), `${checkout.error ?? ""}\n`);
    return record("setup_failed", checkout.error, noSession);
  }
  const leaks = blindnessViolations(
    composedPrompt,
    forbiddenStrings(entry.id, options),
  );
  if (leaks.length > 0) {
    const failure = `the composed prompt names the entry id or a protected path (${leaks.length} occurrence(s)); fix the entry's brief or task_spec`;
    writeFileSync(join(runDir, "setup-error.txt"), `${failure}\n`);
    return record("setup_failed", failure, noSession);
  }

  const stdoutFile = join(scratch.meta, "session.json");
  const session = await runGuarded(
    options.claudeBin,
    buildSessionArgs({
      agentsFile,
      settingsFile,
      addDirs: [scratch.evidence],
      model: options.model,
      effort: options.effort,
      budgetUsd: options.budgetUsd,
      bare: options.bare,
    }),
    {
      guardBin: options.guardBin,
      cwd: scratch.checkout,
      env: sessionEnv(options.env, {
        scratch,
        npmCache: join(scratch.tmp, "npm-cache"),
        apiKey,
      }),
      timeoutMs: options.timeoutMs,
      maxRssMiB: options.maxRssMiB,
      stdinFile: promptFile,
      stdoutFile,
      stderrFile: join(scratch.meta, "stderr.log"),
      logDir: join(guard.logDir, "session"),
      sweepRoots: guard.sweepRoots,
    },
  );
  sessionProcesses = processRecord(session);

  const json = session.timedOut ? null : parseSession(stdoutFile);
  const finalText = json && typeof json.result === "string" ? json.result : "";
  const { status, failure } = sessionStatus(
    session,
    json,
    readStderr(join(scratch.meta, "stderr.log")),
  );
  return record(status, failure, {
    code: session.code,
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
  const left =
    result.processes.session === null
      ? 0
      : result.processes.session.guard_leftovers +
        result.processes.session.swept.length;
  return `${result.variant.id} ${result.entry_id} run-${result.repeat}: ${result.status}${result.failure ? ` (${result.failure})` : ""}, valid=${result.check.valid}, medium+ findings=${mediumPlusCount(result.check)}, cost=${cost} USD, ${(result.wall_ms / 1000).toFixed(0)} s${left > 0 ? `, ${left} leftover process(es) killed` : ""}`;
}
