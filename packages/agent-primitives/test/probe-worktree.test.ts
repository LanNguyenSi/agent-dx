import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import { readMarkerFor } from "../src/lock.js";
import { runArgv } from "../src/probe/run.js";

// Call-through mock, the same shape as the one above for
// "../src/probe/run.js": lets a test pin the run id `beginWorktree`
// derives its scratch subdirectory name from, to reproduce a genuine
// collision (finding #1's "refuse a pre-existing diff file" guard)
// without waiting on an actual `randomUUID` clash.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

// Call-through mock: every call runs the real implementation unless a
// test explicitly overrides it for one call (mirrors probe.test.ts's own
// seam). Used to corrupt the tracked-diff sync's own output for the
// worktree_sync_failed test, without touching a shell pipeline that
// would hide the exit code this package must observe. Isolation.ts runs
// every git call through this argv runner (never `execCommand`'s
// shell), so this is the one seam that reaches all of them.
vi.mock("../src/probe/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/probe/run.js")>();
  return { ...actual, runArgv: vi.fn(actual.runArgv) };
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

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      // Simulate a disabled copy step: strip whatever `git ls-files
      // --others` reported, so beginWorktree's own copy loop has nothing
      // to iterate over.
      if (args[0] === "ls-files" && args.includes("--others")) {
        return { ...result, stdout: "" };
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
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
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

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      if (args[0] === "diff" && args.includes("--binary")) {
        // `git diff HEAD --binary --output=<path>` writes the diff
        // straight to that file (never through this call's own stdout
        // capture); overwriting it here, after the real call already
        // produced it, is what corrupts the sync's own diff content.
        const outputArg = args.find((a) => a.startsWith("--output="));
        if (outputArg === undefined) {
          throw new Error("expected a --output= argument on this diff call");
        }
        const diffPath = outputArg.slice("--output=".length);
        // A hunk whose context matches nothing in fixture.js: cannot
        // apply cleanly against a freshly checked-out HEAD worktree.
        fs.writeFileSync(
          diffPath,
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
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
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
    // knows where to look for the worktree: it lands at
    // `<logDir>/wt-<random>/wt`, a fresh per-run subdirectory of
    // `logDir` rather than a fixed name directly under it (see
    // isolation.ts's own docblock on why), so the exact path is
    // discovered once the run is under way rather than pinned up front.
    const logDir = makeTmpDir();
    const findWorktreePath = (): string | undefined => {
      for (const entry of fs.readdirSync(logDir)) {
        if (entry.startsWith("wt-")) {
          const candidate = path.join(logDir, entry, "wt");
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      return undefined;
    };
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

    // The worktree really is there, mid-run, before it gets torn down:
    // asserted first, so a regression that never creates it in the first
    // place is reported as that, not as a false pass on "gone after
    // SIGTERM".
    const worktreePath = findWorktreePath();
    expect(worktreePath).toBeDefined();
    expect(fs.existsSync(worktreePath!)).toBe(true);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
    expect(fs.existsSync(worktreePath!)).toBe(false);
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

describe("probe(): worktree isolation, a reused --log-dir never replays a previous run", () => {
  it("two probes sharing one --log-dir each get their own scratch subdirectory (not one fixed name reused)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const sharedLogDir = makeTmpDir();

    const result1 = await probe(baseOptions(repo, { logDir: sharedLogDir }));
    expect(result1.status).toBe("killed");
    const result2 = await probe(baseOptions(repo, { logDir: sharedLogDir }));
    expect(result2.status).toBe("killed");

    const subdirs = fs
      .readdirSync(sharedLogDir)
      .filter((e) => e.startsWith("wt-"));
    expect(subdirs.length).toBe(2);
  });

  it("refuses to reuse a pre-existing tracked-diff scratch file (a run-id collision) rather than silently replaying it", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();
    const fixedId = "11111111-1111-1111-1111-111111111111";
    const mockUuid = vi.mocked(randomUUID);
    mockUuid.mockReturnValue(fixedId as ReturnType<typeof randomUUID>);

    // Pre-seed the exact scratch file this run's `beginWorktree` call
    // will compute (given the pinned run id above), with content from
    // an imagined "previous run": exactly the collision the pre-existing
    // check refuses instead of silently treating as this run's own.
    const staleDiffPath = path.join(logDir, `wt-${fixedId}`, "tracked.diff");
    fs.mkdirSync(path.dirname(staleDiffPath), { recursive: true });
    fs.writeFileSync(staleDiffPath, "stale content from an earlier run\n");

    try {
      const result = await probe(baseOptions(repo, { logDir }));
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("worktree_sync_failed");
      // Refused before ever being touched: neither read as this run's
      // own diff nor overwritten.
      expect(fs.readFileSync(staleDiffPath, "utf8")).toBe(
        "stale content from an earlier run\n",
      );
    } finally {
      mockUuid.mockReset();
      mockUuid.mockImplementation(
        (await vi.importActual<typeof import("node:crypto")>("node:crypto"))
          .randomUUID,
      );
    }
  });
});

describe("probe(): worktree isolation, argv-only git calls (no shell injection)", () => {
  it("a --log-dir containing shell metacharacters is passed to git as an opaque argv element, never executed", async () => {
    useLockDir();
    const { repo } = initRepo();
    const base = makeTmpDir();
    const logDir = path.join(base, "$(touch PWNED)x");
    const pwnedMarker = path.join(base, "PWNED");

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    expect(fs.existsSync(pwnedMarker)).toBe(false);
  });
});

describe("probe(): worktree isolation, tracked-diff sync preserves non-UTF-8 bytes", () => {
  it("a non-UTF-8 byte in a non-target tracked file survives the sync byte for byte (never routed through a UTF-8-decoding capture)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const otherFile = path.join(repo, "other.bin");
    fs.writeFileSync(otherFile, "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "other file",
    ]);
    // A lone UTF-8 continuation byte (0x80): never valid on its own, so
    // decoding as UTF-8 and re-encoding would replace it with U+FFFD,
    // changing both the bytes and the hash.
    const binaryContent = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x80, 0x0d, 0x0a,
    ]);
    fs.writeFileSync(otherFile, binaryContent);
    const expectedSha = createHash("sha256")
      .update(binaryContent)
      .digest("hex");

    const shaOutDir = makeTmpDir();
    const shaOutPath = path.join(shaOutDir, "sha-out.txt");
    const previousEnv = process.env.SHA_OUT_PATH;
    process.env.SHA_OUT_PATH = shaOutPath;
    try {
      const result = await probe(
        baseOptions(repo, {
          preCommand:
            "node -e \"const fs=require('fs'),crypto=require('crypto');" +
            "const h=crypto.createHash('sha256').update(fs.readFileSync('other.bin')).digest('hex');" +
            'fs.writeFileSync(process.env.SHA_OUT_PATH, h);"',
        }),
      );
      expect(result.status).toBe("killed");
      expect(fs.readFileSync(shaOutPath, "utf8")).toBe(expectedSha);
    } finally {
      if (previousEnv === undefined) delete process.env.SHA_OUT_PATH;
      else process.env.SHA_OUT_PATH = previousEnv;
    }
  });
});

describe("probe(): worktree isolation, untracked entries by type", () => {
  it("a nested repository directory is skipped with a warning instead of aborting the sync", async () => {
    useLockDir();
    const { repo } = initRepo();
    const nestedDir = path.join(repo, "vendor", "nested-repo");
    fs.mkdirSync(nestedDir, { recursive: true });
    git(nestedDir, ["init", "-q"]);
    fs.writeFileSync(path.join(nestedDir, "file.txt"), "nested\n");

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(
      result.warnings.some(
        (w) =>
          w.includes("nested repository") &&
          w.includes(path.join("vendor", "nested-repo")),
      ),
    ).toBe(true);
  });

  it("a valid untracked symlink and a dangling one are both recreated as symlinks, neither aborting the sync", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "link-target.txt"), "target\n");
    fs.symlinkSync("link-target.txt", path.join(repo, "valid-link.txt"));
    fs.symlinkSync("does-not-exist.txt", path.join(repo, "dangling-link.txt"));

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });

  it("the probe's own --log-dir, when it sits inside the repository, is excluded from the untracked sync entirely", async () => {
    useLockDir();
    const { repo } = initRepo();
    const inRepoLogDir = path.join(repo, "scratch-logs");
    fs.mkdirSync(inRepoLogDir, { recursive: true });

    const result = await probe(baseOptions(repo, { logDir: inRepoLogDir }));

    expect(result.status).toBe("killed");
    // Nothing from the probe's own scratch space (its worktree, its
    // tracked-diff file, its exec logs) was ever treated as an
    // untracked source file to copy.
    expect(result.isolation.syncedUntrackedFiles).toBe(0);
  });

  it("an untracked directory entry without its own .git is walked and its files copied, not treated as a nested repository", async () => {
    useLockDir();
    const { repo } = initRepo();
    const plainDir = path.join(repo, "plain-untracked-dir");
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, "inner.txt"), "hello\n");

    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      const result = await actualRun.runArgv(file, args, options);
      if (args[0] === "ls-files" && args.includes("--others")) {
        // Real `git ls-files` never reports a plain (non-repository)
        // directory as its own entry; this simulates the shape handled
        // defensively anyway, to prove the walk -- not a nested-
        // repository skip -- is what runs for it.
        return { ...result, stdout: result.stdout + "plain-untracked-dir\0" };
      }
      return result;
    });

    try {
      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("killed");
      expect(result.warnings.some((w) => w.includes("nested repository"))).toBe(
        false,
      );
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
    }
  });
});

describe("probe(): worktree isolation, a gitignored target is never synced", () => {
  it("--file that is gitignored yields a typed target_not_synced reason, not a raw ENOENT", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.js\n");
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "gitignore",
    ]);
    fs.writeFileSync(path.join(repo, "ignored.js"), FIXTURE_JS);

    const result = await probe(baseOptions(repo, { file: "ignored.js" }));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_not_synced");
  });
});

describe("probe(): worktree isolation, --allow-outside is rejected as a usage error", () => {
  it("--allow-outside combined with --isolation worktree is worktree_allow_outside_unsupported, not a raw path or hash failure", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outsideDir = makeTmpDir();
    const outsideFile = path.join(outsideDir, "outside.js");
    fs.writeFileSync(outsideFile, FIXTURE_JS);

    const result = await probe(
      baseOptions(repo, {
        file: path.relative(repo, outsideFile),
        allowOutside: true,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("worktree_allow_outside_unsupported");
  });
});

describe("probe(): worktree isolation, a real SIGKILL leaves a recoverable marker", () => {
  it("SIGKILL to a CLI worktree probe mid-run leaves a marker at the repository key that doctor reports and the next probe recovers from", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();
    // Written OUTSIDE the worktree (an absolute path, via an env var):
    // the test command's own cwd is the worktree's copy, which is what
    // this test leaves leftover on disk by design (SIGKILL, no
    // cleanup) -- but the readiness signal itself must survive
    // independent of that.
    const readyDir = makeTmpDir();
    const ready = path.join(readyDir, "ready.txt");

    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.READY_ABS_PATH, 'running');",
        "setTimeout(() => { process.exit(0); }, 15000);",
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
      "slow test",
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
        "  return false;",
        "-t",
        "node fixture.test.js",
        "-i",
        "worktree",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          AGENT_PRIMITIVES_LOG_DIR: logDir,
          READY_ABS_PATH: ready,
        },
        stdio: "ignore",
      },
    );

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("ready.txt never appeared before the deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    // SIGKILL, not SIGTERM: bypasses this probe's own signal handler
    // entirely, so nothing here runs cleanup -- exactly the crash the
    // repository-keyed marker exists to recover from.
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    const marker = readMarkerFor(realRoot);
    expect(marker).toBeDefined();
    // The leftover worktree really is still there (nothing cleaned it
    // up): asserted before the doctor/recovery steps below, so a
    // regression that never actually created one is reported as that.
    expect(fs.existsSync(marker!.targetPath)).toBe(true);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({ cwd: repo, lockDir });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(marker!.targetPath);

    // Restore the normal test command (the killed run's own left a
    // command that depends on an env var only that spawned CLI had) so
    // the recovery run below is a normal probe, not a repeat of the
    // crash.
    fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "restore normal test command",
    ]);

    // The next probe on this repository recovers automatically: the
    // leftover worktree is removed and a normal verdict is produced.
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(marker!.targetPath)).toBe(false);
  }, 30000);
});

describe("probe(): worktree isolation, the original-tree defense-in-depth guard", () => {
  it("a test command that writes to the original tree's target (an absolute path, bypassing the worktree remap) is caught as worktree_original_tree_modified", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absTarget = path.join(repo, "fixture.js");
    // The path travels via an env var, not interpolated into the shell
    // command string: this test is about the original-tree guard, not
    // about quoting a path safely into `-e`.
    const previousEnv = process.env.ORIGINAL_TREE_TARGET;
    process.env.ORIGINAL_TREE_TARGET = absTarget;

    try {
      const result = await probe(
        baseOptions(repo, {
          testCommand:
            "node -e \"require('fs').writeFileSync(process.env.ORIGINAL_TREE_TARGET, 'CLOBBERED')\"",
        }),
      );

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("worktree_original_tree_modified");
    } finally {
      if (previousEnv === undefined) delete process.env.ORIGINAL_TREE_TARGET;
      else process.env.ORIGINAL_TREE_TARGET = previousEnv;
    }
  });
});
