import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import { readMarkerFor } from "../src/lock.js";
import { execCommand } from "../src/exec.js";

// Call-through mock: every call runs the real implementation unless a
// test explicitly overrides it for one call (mirrors probe.test.ts's own
// seam). Used to corrupt the tracked-diff sync's own output for the
// worktree_sync_failed test, without touching a shell pipeline that
// would hide the exit code this package must observe.
vi.mock("../src/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/exec.js")>();
  return { ...actual, execCommand: vi.fn(actual.execCommand) };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-probe-worktree-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

let savedLockDir: string | undefined;
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

/** Every test gets its own lock dir, so a leftover lock/marker from one
 * test can never be observed by another. */
function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "function unused(n) {",
  "  return n * 2;",
  "}",
  "module.exports = { isPositive };",
  "",
].join("\n");

const FIXTURE_TEST_JS = [
  "const assert = require('node:assert');",
  "const { isPositive } = require('./fixture.js');",
  "assert.strictEqual(isPositive(5), true);",
  "assert.strictEqual(isPositive(-5), false);",
  "",
].join("\n");

/** A fresh git repo (mkdtemp + git init, never the checkout itself) with
 * a committed fixture.js and fixture.test.js. */
function initRepo(): { repo: string } {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { repo };
}

function baseOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 2,
    form: "replace",
    replaceText: "  return false;",
    testCommand: "node fixture.test.js",
    isolation: "worktree",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

function worktreeList(repo: string): string {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
}

describe("probe(): worktree isolation, killed and survived on a clean tree", () => {
  it("kills the mutant, reports isolation.mode worktree with syncedTrackedFiles 0, and leaves the original tree byte-identical", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(result.isolation.mode).toBe("worktree");
    expect(result.isolation.syncedTrackedFiles).toBe(0);
    expect(result.isolation.syncedUntrackedFiles).toBe(0);
    expect(result.isolation.path).toBeTruthy();

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);

    // Cleanup after success: no worktree left registered.
    expect(worktreeList(repo)).not.toContain(result.isolation.path as string);
    expect(fs.existsSync(result.isolation.path as string)).toBe(false);
  });

  it("reports survived when the mutant does not affect the test outcome", async () => {
    useLockDir();
    const { repo } = initRepo();

    const result = await probe(
      baseOptions(repo, { line: 5, replaceText: "  return n * 3;" }),
    );

    expect(result.status).toBe("survived");
    expect(result.isolation.mode).toBe("worktree");
  });
});

describe("probe(): worktree isolation syncs the working tree, not just HEAD", () => {
  it("syncs an uncommitted tracked modification: syncedTrackedFiles reflects it and the baseline sees the modified content", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.appendFileSync(path.join(repo, "fixture.js"), "\n// TRACKED_MARKER\n");
    const checkMarker =
      "node -e \"if (!require('fs').readFileSync('fixture.js','utf8').includes('TRACKED_MARKER')) process.exit(1)\"";

    const result = await probe(baseOptions(repo, { testCommand: checkMarker }));

    expect(result.isolation.syncedTrackedFiles).toBe(1);
    expect(result.baseline?.exitCode).toBe(0);
  });

  it("copies an untracked, non-ignored file to the worktree, and that file is what makes the mutant catchable", async () => {
    useLockDir();
    const { repo } = initRepo();
    // A strict check gated on an untracked, non-ignored marker file: the
    // weak assertion alone (isPositive(5) === true) still holds after
    // this mutation, so only the strict check (run when the marker
    // exists) actually discriminates the mutant.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "if (fs.existsSync('strict.marker')) {",
        "  assert.strictEqual(isPositive(-5), false);",
        "}",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "strict test",
    ]);
    // A mutation that keeps isPositive(5) === true (the weak check keeps
    // passing without the marker) but breaks isPositive(-5) === false
    // (the strict check, gated on the untracked marker).
    fs.writeFileSync(path.join(repo, "strict.marker"), "");

    const result = await probe(
      baseOptions(repo, {
        form: "match",
        replaceText: undefined,
        matchText: "n > 0",
        withText: "n >= -5",
      }),
    );

    expect(result.isolation.syncedUntrackedFiles).toBe(1);
    expect(result.status).toBe("killed");
  });

  it("negative control: with the copy step disabled (the untracked marker never reaches the worktree), the same mutant survives instead of being killed", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "const { isPositive } = require('./fixture.js');",
        "assert.strictEqual(isPositive(5), true);",
        "if (fs.existsSync('strict.marker')) {",
        "  assert.strictEqual(isPositive(-5), false);",
        "}",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "strict test",
    ]);
    fs.writeFileSync(path.join(repo, "strict.marker"), "");

    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const mockExec = vi.mocked(execCommand);
    mockExec.mockImplementation(async (cmd, options) => {
      const result = await actualExec.execCommand(cmd, options);
      // Simulate a disabled copy step: strip whatever `git ls-files
      // --others` reported, so beginWorktree's own copy loop has nothing
      // to iterate over.
      if (cmd.startsWith("git ls-files --others")) {
        fs.writeFileSync(result.logPath, "");
      }
      return result;
    });

    try {
      const result = await probe(
        baseOptions(repo, {
          form: "match",
          replaceText: undefined,
          matchText: "n > 0",
          withText: "n >= -5",
        }),
      );

      expect(result.isolation.syncedUntrackedFiles).toBe(0);
      expect(result.status).toBe("survived");
    } finally {
      mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
        actualExec.execCommand(...args),
      );
    }
  });
});

describe("probe(): worktree isolation, node_modules and --pre", () => {
  it("symlinks node_modules found in the source tree (depth <= 3) and lists them in isolation.linked", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(
      path.join(repo, "node_modules", "marker.txt"),
      "present\n",
    );
    fs.mkdirSync(path.join(repo, "a", "b", "node_modules"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repo, "a", "b", "c", "node_modules"), {
      recursive: true,
    });

    const result = await probe(baseOptions(repo));

    expect(result.isolation.linked).toContain(path.join(repo, "node_modules"));
    expect(result.isolation.linked).toContain(
      path.join(repo, "a", "b", "node_modules"),
    );
    expect(result.isolation.linked).not.toContain(
      path.join(repo, "a", "b", "c", "node_modules"),
    );
  });

  it("--pre rebuilds inside the worktree, and the mutant reaches a test that executes built output", async () => {
    useLockDir();
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(
      path.join(repo, "src", "lib.js"),
      [
        "function isPositive(n) {",
        "  return n > 0;",
        "}",
        "module.exports = { isPositive };",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(repo, "dist"));
    fs.writeFileSync(path.join(repo, "dist", "lib.js"), "");
    fs.writeFileSync(
      path.join(repo, "run-test.js"),
      [
        "const assert = require('node:assert');",
        "const { isPositive } = require('./dist/lib.js');",
        "assert.strictEqual(isPositive(5), true);",
        "assert.strictEqual(isPositive(-5), false);",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

    const result = await probe(
      baseOptions(repo, {
        file: "src/lib.js",
        line: 2,
        replaceText: "  return false;",
        preCommand: "cp src/lib.js dist/lib.js",
        testCommand: "node run-test.js",
      }),
    );

    expect(result.status).toBe("killed");
    expect(result.baseline?.exitCode).toBe(0);
    // Untouched by the whole run: the worktree's own dist/ absorbed the
    // rebuild, never the original tree's.
    expect(fs.readFileSync(path.join(repo, "dist", "lib.js"), "utf8")).toBe("");
  });
});

describe("probe(): worktree isolation, non-git fallback", () => {
  it("falls back to inplace with a warning naming the fallback, outside a git work tree", async () => {
    useLockDir();
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "fixture.js"), FIXTURE_JS);
    fs.writeFileSync(path.join(dir, "fixture.test.js"), FIXTURE_TEST_JS);

    const result = await probe(baseOptions(dir));

    expect(result.status).toBe("killed");
    expect(result.isolation.mode).toBe("inplace");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("not inside a git work tree") && w.includes("inplace"),
      ),
    ).toBe(true);
  });
});

describe("probe(): worktree isolation, sync failure", () => {
  it("a deliberately conflicting tracked diff yields worktree_sync_failed, exit-class inconclusive, and no verdict", async () => {
    useLockDir();
    const { repo } = initRepo();

    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const mockExec = vi.mocked(execCommand);
    mockExec.mockImplementation(async (cmd, options) => {
      const result = await actualExec.execCommand(cmd, options);
      if (cmd.startsWith("git diff HEAD --binary")) {
        // A hunk whose context matches nothing in fixture.js: cannot
        // apply cleanly against a freshly checked-out HEAD worktree.
        fs.writeFileSync(
          result.logPath,
          [
            "diff --git a/fixture.js b/fixture.js",
            "index 0000000..1111111 100644",
            "--- a/fixture.js",
            "+++ b/fixture.js",
            "@@ -1,1 +1,1 @@",
            "-this line does not exist in fixture.js",
            "+neither does this one",
            "",
          ].join("\n"),
        );
      }
      return result;
    });

    try {
      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("worktree_sync_failed");
      expect(result.mutant).toBeUndefined();
    } finally {
      mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
        actualExec.execCommand(...args),
      );
    }
  });
});

describe("probe(): worktree isolation, concurrent probes on one repository serialize", () => {
  it("a second probe on a different file in the same repository is probe_in_progress while the first is still running", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "fixture2.js"), FIXTURE_JS);
    fs.writeFileSync(path.join(repo, "fixture2.test.js"), FIXTURE_TEST_JS);
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "second file",
    ]);

    const slow = baseOptions(repo, {
      testCommand: "sleep 1 && node fixture.test.js",
    });
    const first = probe(slow);
    // Give the first call a head start so it has acquired the
    // repository-keyed lock by the time the second one runs.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await probe(
      baseOptions(repo, {
        file: "fixture2.js",
        testCommand: "node fixture2.test.js",
      }),
    );

    expect(second.status).toBe("inconclusive");
    expect(second.reason).toBe("probe_in_progress");

    const firstResult = await first;
    expect(firstResult.status).toBe("killed");
  }, 15000);
});

describe("probe(): worktree isolation, cleanup after SIGTERM and stale-worktree recovery", () => {
  it("SIGTERM during a slow mutant run still cleans up the worktree and leaves no lock", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    // Pinned (rather than the CLI's own per-run default) so the test
    // knows exactly where the worktree lands.
    const logDir = makeTmpDir();
    const worktreePath = path.join(logDir, "wt");
    // Written OUTSIDE the worktree (via an absolute path in an env var,
    // inherited all the way down to the grandchild): the worktree itself
    // gets removed as part of the SIGTERM cleanup this test is proving,
    // so a heartbeat file living inside it could not be read afterward
    // regardless of whether the grandchild was actually killed.
    const heartbeatDir = makeTmpDir();
    const heartbeat = path.join(heartbeatDir, "heartbeat-out.txt");

    fs.writeFileSync(
      path.join(repo, "heartbeat-worker.js"),
      [
        "const fs = require('node:fs');",
        "const target = process.env.HEARTBEAT_ABS_PATH;",
        "let n = 0;",
        "const tick = () => {",
        "  n += 1;",
        "  fs.writeFileSync(target, String(n));",
        "};",
        "tick();",
        "const id = setInterval(tick, 100);",
        "setTimeout(() => { clearInterval(id); process.exit(0); }, 10000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('SLOW_MARKER')) {",
        "  spawn(process.execPath, ['heartbeat-worker.js'], { stdio: 'inherit' });",
        "  setTimeout(() => { process.exit(0); }, 10000);",
        "} else { process.exit(0); }",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "heartbeat test",
    ]);

    const child = spawn(
      "node",
      [
        CLI_PATH,
        "probe",
        "--file",
        "fixture.js",
        "-n",
        "2",
        "-r",
        "  return false; // SLOW_MARKER",
        "-t",
        "node fixture.test.js",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          AGENT_PRIMITIVES_LOG_DIR: logDir,
          HEARTBEAT_ABS_PATH: heartbeat,
        },
        stdio: "ignore",
      },
    );

    const deadline = Date.now() + 10000;
    while (!fs.existsSync(heartbeat)) {
      if (Date.now() > deadline) {
        throw new Error("heartbeat.txt never appeared before the deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
    // Only the main worktree (the repo itself) is left registered: the
    // probe's own worktree was removed as part of the SIGTERM cleanup.
    const list = worktreeList(repo);
    expect(list.split("\n\n").filter((b) => b.trim().length > 0)).toHaveLength(
      1,
    );

    const countAtExit = fs.readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const countAfterSettling = fs.readFileSync(heartbeat, "utf8");
    expect(countAfterSettling).toBe(countAtExit);
  }, 20000);

  it("a leftover worktree marker (simulating a SIGKILL) is recovered by the next invocation on the same repository", async () => {
    useLockDir();
    const { repo } = initRepo();

    // Build a real leftover worktree by hand (what a SIGKILL mid-run
    // would leave: the worktree registered and on disk, a marker
    // recording its path, keyed on the repository root, with a dead pid).
    const staleLogDir = makeTmpDir();
    const staleAdd = spawnSync(
      "git",
      ["worktree", "add", "--detach", path.join(staleLogDir, "wt"), "HEAD"],
      { cwd: repo },
    );
    expect(staleAdd.status).toBe(0);

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const { writeMarker } = await import("../src/lock.js");
    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: path.join(staleLogDir, "wt"),
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
    });

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    // The stale worktree itself is gone (removed as part of recovery).
    expect(fs.existsSync(path.join(staleLogDir, "wt"))).toBe(false);
  });
});
