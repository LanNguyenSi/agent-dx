import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BLANKED_ENV,
  buildSessionArgs,
  composePrompt,
  runEntry,
  runGrouped,
  scrubEnv,
} from "../eval/runner.js";
import type { RunnerOptions } from "../eval/runner.js";
import { makeVariant, sha256 } from "../eval/variants.js";
import { makeEntry, makeFixtureRepo, reviewerReturn } from "./eval-helpers.js";
import type { FixtureRepo } from "./eval-helpers.js";

const STUB = fileURLToPath(
  new URL("./fixtures/eval/stub-claude.mjs", import.meta.url),
);

const PROMPT = [
  "---",
  "name: reviewer",
  'description: "Stub reviewer."',
  "---",
  "",
  "You are the reviewer under test.",
  "",
].join("\n");

let repo: FixtureRepo;
let work: string;
let recordDir: string;
let finalText: string;

beforeAll(() => {
  repo = makeFixtureRepo();
  work = mkdtempSync(join(tmpdir(), "ow-eval-run-"));
  finalText = join(work, "final.txt");
  writeFileSync(finalText, reviewerReturn([{ severity: "medium" }]));
});

afterAll(() => {
  rmSync(repo.dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  recordDir = mkdtempSync(join(work, "rec-"));
});

function options(over: Partial<RunnerOptions> = {}): RunnerOptions {
  const out = mkdtempSync(join(work, "out-"));
  return {
    claudeBin: STUB,
    model: "opus",
    effort: "high",
    timeoutMs: 60_000,
    budgetUsd: 7,
    scratchRoot: join(work, "scratch"),
    outDir: out,
    bare: true,
    isolateHome: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    keepCheckout: false,
    force: false,
    env: {
      ...process.env,
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "ghs-secret",
      ANTHROPIC_API_KEY: "sk-test",
      STUB_RECORD_DIR: recordDir,
      STUB_FINAL_TEXT_FILE: finalText,
      STUB_FUTURE_SHA: repo.futureSha,
    },
    ...over,
  };
}

function call(n = 0): Record<string, any> {
  return JSON.parse(readFileSync(join(recordDir, `call-${n}.json`), "utf8"));
}

const variant = makeVariant("stub-variant", "test", PROMPT);

describe("runEntry with a stub session", () => {
  it("runs the session in an isolated, remote-free checkout of the head commit", async () => {
    const opts = options();
    const entry = makeEntry(repo);
    const result = await runEntry(entry, variant, 1, opts);

    expect(result.status).toBe("completed");
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
    expect(rec.env.GH_TOKEN).toBe("");
    expect(rec.env.GITHUB_TOKEN).toBe("");
    expect(rec.env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(rec.env.HOME).not.toBe(process.env.HOME);
    expect(rec.env.CLAUDE_CONFIG_DIR).toBe(join(rec.env.HOME, ".claude"));
  });

  it("starts the session with the documented flags and the prompt on stdin", async () => {
    const opts = options();
    const result = await runEntry(makeEntry(repo), variant, 1, opts);
    const rec = call();
    const argv: string[] = rec.argv;
    const valueOf = (flag: string): string => argv[argv.indexOf(flag) + 1];

    expect(argv[0]).toBe("-p");
    expect(valueOf("--agent")).toBe("reviewer");
    expect(valueOf("--model")).toBe("opus");
    expect(valueOf("--effort")).toBe("high");
    expect(valueOf("--permission-mode")).toBe("bypassPermissions");
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
      ]),
    );
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
    expect(rec.stdin).toContain(
      join(opts.scratchRoot, "stub-variant-entry-a-r1"),
    );
    expect(rec.stdin).toContain("Review target (evaluation harness)");
    expect(rec.stdin).toContain(`${repo.baseSha}..${repo.headSha}`);
    expect(rec.stdin).toContain("Add a second line to a.txt.");
    expect(rec.stdin).not.toContain("{{");
    expect(result.prompt_sha256).toBe(sha256(rec.stdin));
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
    ]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toEqual(
      result,
    );
    expect(result.repeat).toBe(2);
    expect(result.checkout.cleaned_up).toBe(true);
    expect(result.checkout.dirty_after_setup).toBe(false);
    expect(existsSync(join(opts.scratchRoot, "stub-variant-entry-a-r2"))).toBe(
      false,
    );
    expect(existsSync(join(dir, "home"))).toBe(false);
  });

  it("keeps the checkout and the real home when asked", async () => {
    const opts = options({
      keepCheckout: true,
      bare: false,
      isolateHome: false,
    });
    const result = await runEntry(makeEntry(repo), variant, 1, opts);
    const clone = join(opts.scratchRoot, "stub-variant-entry-a-r1");
    expect(result.checkout.cleaned_up).toBe(false);
    expect(existsSync(join(clone, "a.txt"))).toBe(true);
    const rec = call();
    expect(rec.argv).not.toContain("--bare");
    expect(rec.env.HOME).toBe(process.env.HOME);
    rmSync(clone, { recursive: true, force: true });
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
    const failed = await runEntry(makeEntry(repo), variant, 1, {
      ...options(),
      env: { ...options().env, STUB_MODE: "error", STUB_RECORD_DIR: recordDir },
    });
    expect(failed.status).toBe("session_failed");
    expect(failed.final_text).toBe("");
    expect(failed.check.valid).toBe(false);

    const garbage = await runEntry(makeEntry(repo), variant, 1, {
      ...options(),
      env: {
        ...options().env,
        STUB_MODE: "garbage",
        STUB_RECORD_DIR: recordDir,
      },
    });
    expect(garbage.status).toBe("session_failed");
  });

  it("records an invalid return as completed but not valid", async () => {
    const bad = join(work, "bad.txt");
    writeFileSync(bad, "I looked and it is fine.");
    const result = await runEntry(makeEntry(repo), variant, 1, {
      ...options(),
      env: {
        ...options().env,
        STUB_FINAL_TEXT_FILE: bad,
        STUB_RECORD_DIR: recordDir,
      },
    });
    expect(result.status).toBe("completed");
    expect(result.check.valid).toBe(false);
    expect(result.check.reasons).toEqual(["no yaml fenced block"]);
  });

  it("stops a session at the wall-clock bound and kills its whole process group", async () => {
    const opts = options({ timeoutMs: 1500 });
    const started = Date.now();
    const result = await runEntry(makeEntry(repo), variant, 1, {
      ...opts,
      env: { ...opts.env, STUB_MODE: "hang", STUB_RECORD_DIR: recordDir },
    });
    expect(result.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(30_000);
    const childPid = Number(readFileSync(join(recordDir, "child.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 60_000);
});

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

describe("scrubEnv, buildSessionArgs, composePrompt", () => {
  it("blanks every credential variable and lets extras win", () => {
    const base: NodeJS.ProcessEnv = { KEEP: "1" };
    for (const name of BLANKED_ENV) base[name] = "secret";
    const env = scrubEnv(base, { HOME: "/scratch" });
    for (const name of BLANKED_ENV) expect(env[name], name).toBe("");
    expect(env.KEEP).toBe("1");
    expect(env.HOME).toBe("/scratch");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(base.GH_TOKEN).toBe("secret");
  });

  it("adds --bare only in bare mode", () => {
    const common = {
      agentsFile: "/a.json",
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
