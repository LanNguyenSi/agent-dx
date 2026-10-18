import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DISALLOWED_TOOLS,
  buildSessionArgs,
  composePrompt,
  runEntry,
  runGrouped,
} from "../eval/runner.js";
import type { RunnerOptions } from "../eval/runner.js";
import { PASSED_ENV, sessionEnv, setupEnv } from "../eval/isolation.js";
import { makeVariant, sha256 } from "../eval/variants.js";
import {
  FAKE_GUARD,
  STUB,
  makeEntry,
  makeFixtureRepo,
  reviewerReturn,
  stubBin,
} from "./eval-helpers.js";
import type { FixtureRepo } from "./eval-helpers.js";

const PROMPT = [
  "---",
  "name: reviewer",
  'description: "Stub reviewer."',
  "---",
  "",
  "You are the reviewer under test.",
  "",
].join("\n");

/** Variables that must never reach a session or a setup command. */
const UNLISTED = {
  AGENT_TASKS_TOKEN: "agent-tasks-secret-value",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks-501/inbox.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "messaging-secret-value",
  CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
  SOME_SERVICE_TOKEN: "service-secret-value",
  GH_TOKEN: "gh-secret",
  GITHUB_TOKEN: "ghs-secret",
  NPM_TOKEN: "npm-secret",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
};

let repo: FixtureRepo;
let work: string;
let recordDir: string;
let finalText: string;

beforeAll(() => {
  repo = makeFixtureRepo();
  work = realpathSync(mkdtempSync(join(tmpdir(), "ow-eval-run-")));
  finalText = join(work, "final.txt");
  writeFileSync(finalText, reviewerReturn([{ severity: "medium" }]));
  mkdirSync(join(work, "data", "dataset"), { recursive: true });
});

afterAll(() => {
  rmSync(repo.dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  recordDir = mkdtempSync(join(work, "rec-"));
});

function claude(vars: Record<string, string> = {}): string {
  return stubBin(work, {
    STUB_RECORD_DIR: recordDir,
    STUB_FINAL_TEXT_FILE: finalText,
    STUB_FUTURE_SHA: repo.futureSha,
    ...vars,
  });
}

function options(over: Partial<RunnerOptions> = {}): RunnerOptions {
  const out = mkdtempSync(join(work, "out-"));
  return {
    claudeBin: claude(),
    guardBin: FAKE_GUARD,
    model: "opus",
    effort: "high",
    timeoutMs: 60_000,
    budgetUsd: 7,
    maxRssMiB: 4096,
    scratchRoot: join(work, "scratch"),
    outDir: out,
    datasetDir: join(work, "data", "dataset"),
    bare: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    keepCheckout: false,
    force: false,
    retryFailed: true,
    env: {
      ...process.env,
      ...UNLISTED,
      ANTHROPIC_API_KEY: "sk-test",
    },
    ...over,
  };
}

function call(n = 0): Record<string, any> {
  return JSON.parse(readFileSync(join(recordDir, `call-${n}.json`), "utf8"));
}

const variant = makeVariant("stub-variant", "test", PROMPT);

// Every run builds a checkout, runs a guarded setup command and session, and
// sweeps the process table twice: give each test room under a loaded suite.
describe("runEntry with a stub session", { timeout: 60_000 }, () => {
  it("runs the session in an isolated, remote-free checkout of the head commit", async () => {
    const opts = options();
    const entry = makeEntry(repo);
    const result = await runEntry(entry, variant, 1, opts);

    expect(result.status).toBe("completed");
    expect(result.failure).toBeNull();
    expect(result.check.valid).toBe(true);
    expect(result.cost_usd).toBe(0.25);
    expect(result.turns).toBe(4);
    expect(result.session_wall_ms).toBeGreaterThan(0);
    expect(result.session_wall_ms).toBeLessThanOrEqual(result.wall_ms);
    expect(result.model).toBe("opus");
    expect(result.effort).toBe("high");
    expect(result.variant).toEqual({
      id: "stub-variant",
      source: "test",
      sha256: sha256(PROMPT),
    });

    const rec = call();
    expect(rec.head).toBe(repo.headSha);
    expect(rec.branch).toBe("");
    expect(rec.remotes).toBe("");
    expect(rec.refs).toBe("");
    expect(rec.futureReachable).toBe("no");
    expect(rec.setupMarker).toBe(true);
    expect(rec.fetchHead).toBe(false);
    expect(rec.env.ANTHROPIC_API_KEY).toBe("sk-test");
    const runRoot = join(opts.scratchRoot, result.scratch_id);
    expect(rec.cwd).toBe(join(runRoot, "checkout"));
    expect(rec.env.HOME).toBe(join(runRoot, "home"));
    expect(rec.env.CLAUDE_CONFIG_DIR).toBe(join(rec.env.HOME, ".claude"));
    expect(rec.env.TMPDIR).toBe(join(runRoot, "tmp"));
    expect(rec.env.CLAUDE_CODE_TMPDIR).toBe(join(runRoot, "tmp"));
    expect(rec.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  });

  it("passes the session only the allowlist, and the key to the session alone", async () => {
    const envDump = join(work, `setup-env-${Date.now()}.json`);
    const entry = makeEntry(repo, {
      setup: [
        {
          cwd: ".",
          argv: [
            process.execPath,
            "-e",
            "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
            envDump,
          ],
        },
      ],
    });
    const opts = options({
      apiKeyEnv: "EVAL_KEY",
      env: {
        ...options().env,
        EVAL_KEY: "sk-from-eval-key",
        ANTHROPIC_API_KEY: "sk-must-not-pass",
      },
    });
    const result = await runEntry(entry, variant, 1, opts);
    expect(result.status).toBe("completed");

    const setup: Record<string, string> = JSON.parse(
      readFileSync(envDump, "utf8"),
    );
    const session = call();
    for (const name of Object.keys(UNLISTED)) {
      expect(Object.keys(setup), `setup: ${name}`).not.toContain(name);
      expect(session.envNames, `session: ${name}`).not.toContain(name);
    }
    for (const names of [Object.keys(setup), session.envNames as string[]]) {
      expect(names.filter((n) => /_TOKEN$/.test(n))).toEqual([]);
      expect(names).not.toContain("EVAL_KEY");
    }
    expect(Object.keys(setup)).not.toContain("ANTHROPIC_API_KEY");
    expect(session.env.ANTHROPIC_API_KEY).toBe("sk-from-eval-key");
    expect(setup.HOME).toBe(session.env.HOME);
    expect(setup.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(setup.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(setup.GIT_SSH_COMMAND).toBe("false");
    expect(setup.GIT_TERMINAL_PROMPT).toBe("0");
    expect(setup.npm_config_cache).toBe(join(opts.scratchRoot, "npm-cache"));
    expect(setup.GH_CONFIG_DIR).toBe(
      join(opts.scratchRoot, result.scratch_id, "gh"),
    );
    const allowed = new Set<string>([
      ...PASSED_ENV,
      "HOME",
      "CLAUDE_CONFIG_DIR",
      "TMPDIR",
      "GH_CONFIG_DIR",
      "npm_config_cache",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_SSH_COMMAND",
      "GIT_TERMINAL_PROMPT",
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      "CLAUDE_CODE_TMPDIR",
      "ANTHROPIC_API_KEY",
    ]);
    const extra = (session.envNames as string[]).filter(
      (n) =>
        !allowed.has(n) &&
        !n.startsWith("LC_") &&
        !n.startsWith("STUB_") &&
        // Set by the shells and node between the runner and the stub.
        !["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(n),
    );
    expect(extra).toEqual([]);
  });

  it("starts the session with the documented flags and the prompt on stdin", async () => {
    const opts = options();
    const result = await runEntry(makeEntry(repo), variant, 1, opts);
    const rec = call();
    const argv: string[] = rec.argv;
    const valueOf = (flag: string): string => argv[argv.indexOf(flag) + 1];
    const runRoot = join(opts.scratchRoot, result.scratch_id);

    expect(argv[0]).toBe("-p");
    expect(valueOf("--agent")).toBe("reviewer");
    expect(valueOf("--model")).toBe("opus");
    expect(valueOf("--effort")).toBe("high");
    expect(valueOf("--permission-mode")).toBe("bypassPermissions");
    expect(valueOf("--settings")).toBe(join(runRoot, "meta", "settings.json"));
    expect(valueOf("--add-dir")).toBe(join(runRoot, "evidence"));
    expect(argv).toContain("--strict-mcp-config");
    expect(valueOf("--mcp-config")).toBe('{"mcpServers":{}}');
    expect(valueOf("--disallowedTools").split(",")).toEqual(
      expect.arrayContaining([
        "Edit",
        "Write",
        "NotebookEdit",
        "Agent",
        "WebFetch",
        "WebSearch",
        "SendMessage",
        "ListAgents",
      ]),
    );
    expect(valueOf("--disallowedTools").split(",")).toEqual(DISALLOWED_TOOLS);
    expect(argv).toContain("--no-session-persistence");
    expect(valueOf("--output-format")).toBe("json");
    expect(valueOf("--max-budget-usd")).toBe("7");
    expect(argv).toContain("--bare");

    expect(rec.agents).toEqual({
      reviewer: {
        description: "Stub reviewer.",
        prompt: "\nYou are the reviewer under test.\n",
      },
    });
    expect(rec.stdin).toContain(join(runRoot, "checkout"));
    expect(rec.stdin).toContain(join(runRoot, "evidence"));
    expect(rec.stdin).toContain(join(runRoot, "run"));
    expect(rec.stdin).toContain("Review target (evaluation harness)");
    expect(rec.stdin).toContain(`${repo.baseSha}..${repo.headSha}`);
    expect(rec.stdin).toContain("Add a second line to a.txt.");
    expect(rec.stdin).not.toContain("{{");
    expect(result.prompt_sha256).toBe(sha256(rec.stdin));
  });

  it("sandboxes the session through the settings file", async () => {
    const opts = options();
    const result = await runEntry(makeEntry(repo), variant, 1, opts);
    const settings = call().settings;
    const runRoot = join(opts.scratchRoot, result.scratch_id);
    const home = opts.env.HOME!;
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      network: {
        allowedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
    });
    const fs = settings.sandbox.filesystem;
    expect(fs.denyRead).toEqual(
      expect.arrayContaining([
        home,
        join(work, "data"),
        opts.outDir,
        repo.dir,
        opts.scratchRoot,
      ]),
    );
    expect(fs.allowRead).toEqual(
      expect.arrayContaining([
        join(runRoot, "checkout"),
        join(runRoot, "evidence"),
      ]),
    );
    expect(fs.allowRead).not.toContain(join(runRoot, "meta"));
    expect(fs.allowWrite).toEqual([join(runRoot, "evidence")]);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(/${home}/**)`,
        `Edit(/${home}/**)`,
        `Read(/${join(work, "data")}/**)`,
        `Read(/${opts.outDir}/**)`,
        `Read(/${join(runRoot, "meta")}/**)`,
        "SendMessage",
        "ListAgents",
      ]),
    );
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.crossSessionInbound).toBe("refuse");
    // The settings file is kept with the run record.
    expect(
      JSON.parse(
        readFileSync(
          join(
            opts.outDir,
            "stub-variant",
            "entry-a",
            "run-1",
            "settings.json",
          ),
          "utf8",
        ),
      ),
    ).toEqual(settings);
  });

  it("writes the run record files and removes the checkout", async () => {
    const opts = options();
    const result = await runEntry(makeEntry(repo), variant, 2, opts);
    const dir = join(opts.outDir, "stub-variant", "entry-a", "run-2");
    for (const name of [
      "result.json",
      "prompt.md",
      "session.json",
      "stderr.log",
      "agents.json",
      "settings.json",
      "setup.log",
    ]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toEqual(
      result,
    );
    expect(result.repeat).toBe(2);
    expect(result.checkout.cleaned_up).toBe(true);
    expect(result.checkout.dirty_after_setup).toBe(false);
    expect(existsSync(join(opts.scratchRoot, result.scratch_id))).toBe(false);
    expect(result.processes.setup).toHaveLength(1);
    expect(result.processes.session).toMatchObject({
      guard_reason: "none",
      guard_leftovers: 0,
      swept: [],
    });
  });

  it("names its scratch directories opaquely and keeps ids and dataset paths out of the prompt", async () => {
    const opts = options();
    const control = makeEntry(repo, {
      id: "zz-sample-control",
      kind: "control",
      known_findings: [],
    });
    const result = await runEntry(control, variant, 1, opts);
    expect(result.status).toBe("completed");
    expect(result.scratch_id).toMatch(/^[0-9a-f]{12}$/);
    const rec = call();
    for (const text of [rec.stdin, rec.cwd, JSON.stringify(rec.argv)]) {
      expect(text).not.toContain("zz-sample-control");
      expect(text).not.toContain("-control");
      expect(text).not.toContain("stub-variant");
      expect(text).not.toContain(opts.outDir);
      expect(text).not.toContain(join(work, "data"));
    }
  });

  it("refuses a prompt that would name the entry id or a protected path", async () => {
    const opts = options();
    const leaky = makeEntry(repo, {
      brief: `Review {{WORKTREE}}; this is entry entry-a, results in ${opts.outDir}.`,
    });
    const result = await runEntry(leaky, variant, 1, opts);
    expect(result.status).toBe("setup_failed");
    expect(result.failure).toContain("names the entry id or a protected path");
    expect(existsSync(join(recordDir, "call-0.json"))).toBe(false);
  });

  it("keeps the run scratch when asked, and never passes the real home", async () => {
    const opts = options({ keepCheckout: true, bare: false });
    const result = await runEntry(makeEntry(repo), variant, 1, opts);
    const runRoot = join(opts.scratchRoot, result.scratch_id);
    expect(result.checkout.cleaned_up).toBe(false);
    expect(existsSync(join(runRoot, "checkout", "a.txt"))).toBe(true);
    const rec = call();
    expect(rec.argv).not.toContain("--bare");
    expect(rec.env.HOME).not.toBe(process.env.HOME);
    expect(rec.env.HOME).toBe(join(runRoot, "home"));
    rmSync(runRoot, { recursive: true, force: true });
  });

  it("returns the stored record instead of running again, unless forced", async () => {
    const opts = options();
    const first = await runEntry(makeEntry(repo), variant, 1, opts);
    const second = await runEntry(makeEntry(repo), variant, 1, opts);
    expect(second.started_at).toBe(first.started_at);
    expect(existsSync(join(recordDir, "call-1.json"))).toBe(false);
    await runEntry(makeEntry(repo), variant, 1, { ...opts, force: true });
    expect(existsSync(join(recordDir, "call-1.json"))).toBe(true);
  });

  it("runs a failed record again on resume, unless retries are off", async () => {
    const opts = options({ claudeBin: claude({ STUB_MODE: "error" }) });
    const failed = await runEntry(makeEntry(repo), variant, 1, opts);
    expect(failed.status).toBe("session_failed");

    const kept = await runEntry(makeEntry(repo), variant, 1, {
      ...opts,
      claudeBin: claude(),
      retryFailed: false,
    });
    expect(kept.started_at).toBe(failed.started_at);
    expect(kept.status).toBe("session_failed");

    const retried = await runEntry(makeEntry(repo), variant, 1, {
      ...opts,
      claudeBin: claude(),
    });
    expect(retried.status).toBe("completed");
    expect(retried.previous_status).toBe("session_failed");
    expect(existsSync(join(recordDir, "call-1.json"))).toBe(true);
  });

  it("marks a dirty tree after setup", async () => {
    const entry = makeEntry(repo, {
      setup: [
        {
          cwd: ".",
          argv: [
            "node",
            "-e",
            "require('fs').writeFileSync('untracked.txt','x')",
          ],
        },
      ],
    });
    const result = await runEntry(entry, variant, 1, options());
    expect(result.status).toBe("completed");
    expect(result.checkout.dirty_after_setup).toBe(true);
  });

  it("excludes a run whose setup command fails, without starting a session", async () => {
    const entry = makeEntry(repo, {
      setup: [{ cwd: ".", argv: ["node", "-e", "process.exit(3)"] }],
    });
    const opts = options();
    const result = await runEntry(entry, variant, 1, opts);
    expect(result.status).toBe("setup_failed");
    expect(result.checkout.setup_ok).toBe(false);
    expect(existsSync(join(recordDir, "call-0.json"))).toBe(false);
    expect(result.checkout.cleaned_up).toBe(true);
    const detail = readFileSync(
      join(opts.outDir, "stub-variant", "entry-a", "run-1", "setup-error.txt"),
      "utf8",
    );
    expect(detail).toContain("setup command 1");
    expect(detail).toContain("exit 3");
  });

  it("excludes a run whose head commit cannot be fetched", async () => {
    const entry = makeEntry(repo);
    entry.repo.head_sha = "f".repeat(40);
    const result = await runEntry(entry, variant, 1, options());
    expect(result.status).toBe("setup_failed");
  });

  it("records a session that exits with an error or prints no JSON", async () => {
    const failed = await runEntry(
      makeEntry(repo),
      variant,
      1,
      options({ claudeBin: claude({ STUB_MODE: "error" }) }),
    );
    expect(failed.status).toBe("session_failed");
    expect(failed.final_text).toBe("");
    expect(failed.check.valid).toBe(false);

    const garbage = await runEntry(
      makeEntry(repo),
      variant,
      1,
      options({ claudeBin: claude({ STUB_MODE: "garbage" }) }),
    );
    expect(garbage.status).toBe("session_failed");
    expect(garbage.failure).toBe("no JSON result on stdout");
  });

  it("records a JSON error result that exits 0 as a failed session", async () => {
    const result = await runEntry(
      makeEntry(repo),
      variant,
      1,
      options({ claudeBin: claude({ STUB_MODE: "error-exit0" }) }),
    );
    expect(result.exit_code).toBe(0);
    expect(result.status).toBe("session_failed");
    expect(result.failure).toBe("the session reported an error");
  });

  it("records an invalid return as completed but not valid", async () => {
    const bad = join(work, "bad.txt");
    writeFileSync(bad, "I looked and it is fine.");
    const result = await runEntry(
      makeEntry(repo),
      variant,
      1,
      options({ claudeBin: claude({ STUB_FINAL_TEXT_FILE: bad }) }),
    );
    expect(result.status).toBe("completed");
    expect(result.check.valid).toBe(false);
    expect(result.check.reasons).toEqual(["no yaml fenced block"]);
  });

  it("stops a session at the wall-clock bound and kills its whole process group", async () => {
    const opts = options({
      timeoutMs: 1500,
      claudeBin: claude({ STUB_MODE: "hang" }),
    });
    const started = Date.now();
    const result = await runEntry(makeEntry(repo), variant, 1, opts);
    expect(result.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(30_000);
    const childPid = Number(readFileSync(join(recordDir, "child.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(result.processes.session?.guard_reason).toBe("timeout");
  }, 60_000);

  it("kills a descendant that left the process group, before the checkout is deleted", async () => {
    const opts = options({ claudeBin: claude({ STUB_MODE: "escape" }) });
    const result = await runEntry(makeEntry(repo), variant, 1, opts);
    expect(result.status).toBe("completed");
    const escaped = Number(
      readFileSync(join(recordDir, "escaped.pid"), "utf8"),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(escaped, 0)).toThrow();
    const swept = result.processes.session!.swept;
    expect(swept.map((p) => p.pid)).toContain(escaped);
    expect(swept.find((p) => p.pid === escaped)!.cwd).toBe(
      join(opts.scratchRoot, result.scratch_id, "checkout"),
    );
    expect(result.checkout.cleaned_up).toBe(true);
  }, 60_000);

  it("reports a missing guard binary as a failed session", async () => {
    const result = await runEntry(
      makeEntry(repo, { setup: [] }),
      variant,
      1,
      options({ guardBin: join(work, "no-such-guard") }),
    );
    expect(result.status).toBe("session_failed");
    expect(result.failure).toContain("no-such-guard");
  });
});

const realGuard = ((): string | null => {
  const r = spawnSync("agent-primitives", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? "agent-primitives" : null;
})();

describe.runIf(realGuard !== null)(
  "runEntry under the real agent-primitives guard",
  () => {
    it("leaves no descendant of the session running", async () => {
      const opts = options({
        guardBin: realGuard!,
        claudeBin: claude({ STUB_MODE: "escape" }),
      });
      const result = await runEntry(makeEntry(repo), variant, 1, opts);
      expect(result.status).toBe("completed");
      expect(result.processes.session?.guard_reason).not.toBeNull();
      const escaped = Number(
        readFileSync(join(recordDir, "escaped.pid"), "utf8"),
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(escaped, 0)).toThrow();
      const session = result.processes.session!;
      expect(session.guard_leftovers + session.swept.length).toBeGreaterThan(0);
    }, 60_000);
  },
);

describe("runGrouped", () => {
  it("escalates to SIGKILL when the group ignores SIGTERM, and leaves nothing running", async () => {
    const out = join(work, "g.out");
    const started = Date.now();
    const result = await runGrouped(STUB, [], {
      cwd: work,
      env: {
        ...process.env,
        STUB_MODE: "hang-stubborn",
        STUB_RECORD_DIR: recordDir,
      },
      timeoutMs: 600,
      killGraceMs: 400,
      stdoutFile: out,
      stderrFile: out,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const childPid = Number(readFileSync(join(recordDir, "child.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 30_000);

  it("ends a cooperative group on SIGTERM without waiting for the kill grace", async () => {
    const out = join(work, "c.out");
    const started = Date.now();
    const result = await runGrouped(STUB, [], {
      cwd: work,
      env: { ...process.env, STUB_MODE: "hang", STUB_RECORD_DIR: recordDir },
      timeoutMs: 600,
      killGraceMs: 20_000,
      stdoutFile: out,
      stderrFile: out,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 60_000);

  it("kills a group member the leader left behind after exiting", async () => {
    const out = join(work, "h.out");
    const pidFile = join(work, "h.pid");
    const script = `const {spawn}=require('child_process');const c=spawn('sleep',['300'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`;
    const result = await runGrouped(process.execPath, ["-e", script], {
      cwd: work,
      env: process.env,
      timeoutMs: 20_000,
      stdoutFile: out,
      stderrFile: out,
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(() =>
      process.kill(Number(readFileSync(pidFile, "utf8")), 0),
    ).toThrow();
  });

  it("reports a missing binary as a spawn error", async () => {
    const out = join(work, "m.out");
    const result = await runGrouped("definitely-not-a-binary", [], {
      cwd: work,
      env: process.env,
      timeoutMs: 5000,
      stdoutFile: out,
      stderrFile: out,
    });
    expect(result.spawnError).toContain("ENOENT");
    expect(result.code).toBeNull();
  });
});

describe("environment allowlist, buildSessionArgs, composePrompt", () => {
  it("passes only the allowlist to setup and session, and the key to the session only", () => {
    const base: NodeJS.ProcessEnv = {
      ...UNLISTED,
      PATH: "/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: "/real/home",
      TMPDIR: "/real/tmp",
      CLAUDE_CONFIG_DIR: "/real/home/.claude",
      ANTHROPIC_API_KEY: "sk-base",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
    };
    const scratch = {
      home: "/s/home",
      configDir: "/s/home/.claude",
      tmp: "/s/tmp",
      gh: "/s/gh",
    };
    const setup = setupEnv(base, { scratch, npmCache: "/s/npm" });
    const session = sessionEnv(base, {
      scratch,
      npmCache: "/s/npm",
      apiKey: "sk-session",
    });
    for (const env of [setup, session]) {
      for (const name of Object.keys(UNLISTED))
        expect(env[name], name).toBeUndefined();
      expect(env.PATH).toBe("/bin");
      expect(env.LANG).toBe("C");
      expect(env.LC_ALL).toBe("C");
      // Scratch values win over the inherited ones.
      expect(env.HOME).toBe("/s/home");
      expect(env.TMPDIR).toBe("/s/tmp");
      expect(env.CLAUDE_CONFIG_DIR).toBe("/s/home/.claude");
      expect(env.GH_CONFIG_DIR).toBe("/s/gh");
      expect(env.npm_config_cache).toBe("/s/npm");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    }
    expect(setup.ANTHROPIC_API_KEY).toBeUndefined();
    expect(setup.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    // The session key is the one handed over, never the inherited variable.
    expect(session.ANTHROPIC_API_KEY).toBe("sk-session");
    expect(
      sessionEnv(base, { scratch, npmCache: "/s/npm" }).ANTHROPIC_API_KEY,
    ).toBeUndefined();
    expect(session.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(base.GH_TOKEN).toBe("gh-secret");
  });

  it("adds --bare only in bare mode", () => {
    const common = {
      agentsFile: "/a.json",
      settingsFile: "/s.json",
      addDirs: ["/e"],
      model: "m",
      effort: "e",
      budgetUsd: 3,
    };
    expect(buildSessionArgs({ ...common, bare: true })).toContain("--bare");
    expect(buildSessionArgs({ ...common, bare: false })).not.toContain(
      "--bare",
    );
  });

  it("composes briefing, target block and task specification in that order", () => {
    const entry = makeEntry(repo);
    const text = composePrompt(entry, {
      worktree: "/w",
      evidenceDir: "/e",
      runDir: "/r",
    });
    const iBrief = text.indexOf(
      "Review the change in /w. Evidence goes to /e, run files to /r.",
    );
    const iTarget = text.indexOf("## Review target (evaluation harness)");
    const iSpec = text.indexOf("## Task specification");
    expect(iBrief).toBeGreaterThanOrEqual(0);
    expect(iTarget).toBeGreaterThan(iBrief);
    expect(iSpec).toBeGreaterThan(iTarget);
  });
});
