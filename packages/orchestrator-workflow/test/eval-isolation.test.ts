import { spawn } from "node:child_process";
import {
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

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DISALLOWED_TOOLS,
  checkPlacement,
  createRunScratch,
  hostGitEnv,
  isInside,
  redactPaths,
  redactSecrets,
  scanForSecrets,
  secretValues,
  sessionSettings,
} from "../eval/isolation.js";
import {
  leftoverTotal,
  parseGuardEnvelope,
  runGuarded,
  sweepByCwd,
} from "../eval/processes.js";
import { FAKE_GUARD } from "./eval-helpers.js";

let work: string;

beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "ow-eval-iso-")));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("run scratch", () => {
  it("creates an opaque run directory with empty session directories", () => {
    const a = createRunScratch(join(work, "s"));
    const b = createRunScratch(join(work, "s"));
    expect(a.id).toMatch(/^[0-9a-f]{12}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.root).toBe(join(work, "s", a.id));
    for (const dir of [a.evidence, a.runFiles, a.tmp, a.gh, a.meta]) {
      expect(readdirSync(dir), dir).toEqual([]);
    }
    expect(readdirSync(a.home)).toEqual([".claude"]);
    expect(a.configDir).toBe(join(a.home, ".claude"));
  });
});

describe("placement of scratch and results", () => {
  const base = {
    scratchRoot: "/tmp/eval-scratch",
    outDir: "/srv/results",
    datasetDir: "/srv/data/dataset",
    home: "/home/someone",
  };

  it("accepts directories outside the dataset tree and the home", () => {
    expect(checkPlacement(base)).toBeNull();
  });

  it("refuses a results or scratch directory in the dataset's parent tree", () => {
    expect(checkPlacement({ ...base, outDir: "/srv/data/out" })).toContain(
      "--out",
    );
    expect(checkPlacement({ ...base, outDir: "/srv/data" })).toContain("--out");
    expect(
      checkPlacement({ ...base, scratchRoot: "/srv/data/dataset/s" }),
    ).toContain("--scratch");
  });

  it("refuses a scratch directory in the home or in the results", () => {
    expect(
      checkPlacement({ ...base, scratchRoot: "/home/someone/tmp" }),
    ).toContain("inside the home directory");
    expect(
      checkPlacement({ ...base, scratchRoot: "/srv/results/scratch" }),
    ).toContain("inside --out");
  });

  it("refuses a path a permission rule would read as a pattern", () => {
    expect(checkPlacement({ ...base, outDir: "/srv/res*ults" })).toContain(
      "pattern",
    );
  });

  it("decides containment by path segments, not by string prefix", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a/../b", "/a")).toBe(false);
  });
});

describe("session settings", () => {
  let scratch: ReturnType<typeof createRunScratch>;
  let settings: Record<string, any>;
  beforeAll(() => {
    scratch = createRunScratch(join(work, "settings"));
    settings = sessionSettings({
      scratch,
      scratchRoot: join(work, "settings"),
      denied: ["/home/someone", "/srv/data"],
    });
  });

  it("turns the sandbox on, strict, with no way out", () => {
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.excludedCommands).toEqual([]);
    expect(settings.sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    });
  });

  it("denies reads of the protected trees and of other runs, and opens only this run", () => {
    const fs = settings.sandbox.filesystem;
    expect(fs.denyRead).toEqual(
      expect.arrayContaining(["/home/someone", "/srv/data"]),
    );
    expect(fs.denyRead).toContain(join(work, "settings"));
    expect(fs.allowRead).toEqual([
      scratch.checkout,
      scratch.evidence,
      scratch.runFiles,
      scratch.home,
      scratch.tmp,
    ]);
    expect(fs.allowWrite).toEqual([scratch.evidence]);
    expect(fs.denyWrite).toEqual(["/home/someone", "/srv/data"]);
  });

  it("denies the file tools the protected trees and the session's own meta files", () => {
    const deny: string[] = settings.permissions.deny;
    for (const path of ["/home/someone", "/srv/data", scratch.meta]) {
      expect(deny).toContain(`Read(/${path})`);
      expect(deny).toContain(`Read(/${path}/**)`);
      expect(deny).toContain(`Edit(/${path}/**)`);
    }
    expect(deny).toEqual(expect.arrayContaining(["SendMessage", "ListAgents"]));
    expect(
      deny.some((r) => r.startsWith("Glob(") || r.startsWith("Grep(")),
    ).toBe(false);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.crossSessionInbound).toBe("refuse");
    expect(settings.isolatePeerMachines).toBe(true);
  });

  it("disallows every tool that reaches another session or a remote service", () => {
    for (const tool of [
      "SendMessage",
      "ListAgents",
      "TaskStop",
      "RemoteTrigger",
      "PushNotification",
      "Artifact",
      "CronCreate",
      "Monitor",
      "Workflow",
    ]) {
      expect(DISALLOWED_TOOLS, tool).toContain(tool);
    }
  });
});

describe("secrets and redaction", () => {
  it("finds the key and credential-looking values by kind, never returning them", () => {
    const values = secretValues(
      {
        SOME_TOKEN: "abcdefghijklmnop",
        SHORT_TOKEN: "short",
        PLAIN: "abcdefghijklmnopqrst",
      },
      "sk-the-api-key-value",
    );
    expect(values.map((v) => v.name)).toEqual([
      "the API key",
      "the value of SOME_TOKEN",
    ]);
    const text =
      "x sk-the-api-key-value y abcdefghijklmnop -----BEGIN OPENSSH PRIVATE KEY----- ghp_abcdefghijklmnopqrstuvwxyz0123";
    const hits = scanForSecrets(text, values);
    expect(hits).toEqual([
      "the API key",
      "the value of SOME_TOKEN",
      "private key block",
      "GitHub token",
    ]);
    expect(hits.join(" ")).not.toContain("sk-the-api-key-value");
    const clean = redactSecrets(text, values);
    expect(scanForSecrets(clean, values)).toEqual([]);
    expect(clean).toContain("<redacted: the API key>");
  });

  it("never treats an empty value as a match", () => {
    expect(scanForSecrets("text", [{ name: "empty", value: "" }])).toEqual([]);
    expect(redactSecrets("text", [{ name: "empty", value: "" }])).toBe("text");
  });

  it("redacts a whole path under a protected tree, and only the prefix of a session path", () => {
    const text =
      "see /w/x/checkout/src/a.ts and /o/results/current/sample-control/run-1/result.json, then /o/results.";
    const out = redactPaths(text, [
      { path: "/w/x/checkout", label: "<worktree>" },
      { path: "/o/results", label: "<results>", whole: true },
    ]);
    expect(out).toBe("see <worktree>/src/a.ts and <results>, then <results>.");
  });

  it("gives host git commands nothing but the passed variables and fixed git settings", () => {
    const env = hostGitEnv({ PATH: "/bin", GH_TOKEN: "x", HOME: "/h" });
    expect(env).toEqual({
      PATH: "/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSH_COMMAND: "false",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

describe("guarded commands and the sweep", { timeout: 60_000 }, () => {
  it("parses guard's envelope and rejects anything else", () => {
    const report = parseGuardEnvelope(
      JSON.stringify({
        command: "guard",
        reason: "leftover",
        childExitCode: 0,
        killedCount: 0,
        leftoverCount: 2,
        survivorCount: 1,
        leftoverCheckFailed: false,
        peakRssMiB: 12.5,
        leftovers: [{ pid: 5, inGroup: false, command: "sleep 9" }],
      }),
    );
    expect(report).toMatchObject({
      reason: "leftover",
      exit_code: 0,
      leftover_count: 2,
      survivor_count: 1,
      peak_rss_mib: 12.5,
      processes: [{ pid: 5, in_group: false, command: "sleep 9" }],
    });
    expect(parseGuardEnvelope("not json")).toBeNull();
    expect(parseGuardEnvelope('{"command":"verify","reason":"x"}')).toBeNull();
  });

  it("runs a command under the guard with its stdin, stdout and stderr in files", async () => {
    const dir = mkdtempSync(join(work, "g-"));
    writeFileSync(join(dir, "in.txt"), "hello");
    const result = await runGuarded(
      process.execPath,
      [
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('got '+s);console.error('warn');process.exit(4)})",
      ],
      {
        guardBin: FAKE_GUARD,
        cwd: dir,
        env: { PATH: process.env.PATH },
        timeoutMs: 20_000,
        maxRssMiB: 512,
        stdinFile: join(dir, "in.txt"),
        stdoutFile: join(dir, "out.txt"),
        stderrFile: join(dir, "err.txt"),
        logDir: join(dir, "log"),
        sweepRoots: [],
      },
    );
    expect(result.code).toBe(4);
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeNull();
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("got hello\n");
    expect(readFileSync(join(dir, "err.txt"), "utf8")).toBe("warn\n");
    const argv: string[] = JSON.parse(
      readFileSync(join(dir, "log", "fake-guard-argv.json"), "utf8"),
    ).argv;
    expect(argv.slice(0, 7)).toEqual([
      "--format",
      "json",
      "--log-dir",
      join(dir, "log"),
      "guard",
      "20",
      "512",
    ]);
  });

  it("kills a process left working inside a swept root, and only there", async () => {
    const inside = mkdtempSync(join(work, "in-"));
    const outside = mkdtempSync(join(work, "out-"));
    const start = (cwd: string): number => {
      const child = spawn("sleep", ["300"], {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child.pid!;
    };
    const a = start(inside);
    const b = start(outside);
    await new Promise((r) => setTimeout(r, 300));
    const swept = sweepByCwd([inside], { PATH: process.env.PATH });
    expect(swept.unavailable).toBeNull();
    expect(swept.killed.map((p) => p.pid)).toEqual([a]);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(a, 0)).toThrow();
    expect(() => process.kill(b, 0)).not.toThrow();
    process.kill(b, "SIGKILL");
    expect(leftoverTotal({ guard: null, swept })).toBe(1);
  });

  it("reports guard's timeout and a leftover it killed", async () => {
    const dir = mkdtempSync(join(work, "t-"));
    mkdirSync(join(dir, "log"));
    const common = {
      guardBin: FAKE_GUARD,
      cwd: dir,
      env: { PATH: process.env.PATH },
      maxRssMiB: 512,
      stdinFile: null,
      stdoutFile: join(dir, "o"),
      stderrFile: join(dir, "e"),
      logDir: join(dir, "log"),
      sweepRoots: [],
    };
    const slow = await runGuarded("sleep", ["30"], {
      ...common,
      timeoutMs: 800,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.guard?.reason).toBe("timeout");
    const leaving = await runGuarded(
      process.execPath,
      [
        "-e",
        "require('child_process').spawn('sleep',['30'],{stdio:'ignore'}).unref()",
      ],
      { ...common, timeoutMs: 20_000 },
    );
    expect(leaving.guard?.reason).toBe("leftover");
    expect(leftoverTotal(leaving)).toBe(1);
  });
});
