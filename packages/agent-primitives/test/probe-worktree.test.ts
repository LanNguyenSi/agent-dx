import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import {
  markerFilePathFor,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
} from "../src/lock.js";
import { resolveDeepestExisting } from "../src/probe/containment.js";
import {
  isScratchWorktreePath,
  parseWorktreeListZ,
  readScratchOwner,
  SCRATCH_OWNER_FILE,
} from "../src/probe/isolation.js";
import { runArgv } from "../src/probe/run.js";
import { withPathPrepended, writeGitShim } from "./helpers/git-shim.js";

// Call-through mock, the same shape as the one below for
// "../src/probe/run.js": lets a test pin the run id `beginWorktree`
// derives its scratch subdirectory name from, to reproduce a genuine
// run-id collision (the refusal to reuse a pre-existing tracked-diff
// scratch file) without waiting on an actual `randomUUID` clash.
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
    // would leave: the worktree registered and on disk at the probe's
    // own scratch shape under its log dir, a marker recording its path
    // and that log dir, keyed on the repository root, with a dead pid).
    const staleLogDir = makeTmpDir();
    const stalePath = path.join(staleLogDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    const staleAdd = spawnSync(
      "git",
      ["worktree", "add", "--detach", "--", stalePath, "HEAD"],
      { cwd: repo },
    );
    expect(staleAdd.status).toBe(0);

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: stalePath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: staleLogDir,
    });

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    // The stale worktree itself is gone (removed as part of recovery).
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a leftover whose registration is still `locked initializing` (the add died with the process) is recovered by the next invocation", async () => {
    useLockDir();
    const { repo } = initRepo();
    const staleLogDir = makeTmpDir();
    const stalePath = path.join(staleLogDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", stalePath, "HEAD"]);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [adminEntry] = fs.readdirSync(adminDir);
    fs.writeFileSync(path.join(adminDir, adminEntry, "locked"), "initializing");
    expect(worktreeList(repo)).toContain("locked initializing");
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: stalePath,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: staleLogDir,
    });

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a registered worktree of the scratch shape with no marker at all is still recovered by the next invocation", async () => {
    useLockDir();
    const { repo } = initRepo();
    const stalePath = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", stalePath, "HEAD"]);
    const realRoot = resolveDeepestExisting(repo);
    expect(readMarkerFor(realRoot)).toBeUndefined();

    const result = await probe(baseOptions(repo));

    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a marker naming a directory outside the scratch shape is refused: nothing is deleted, the marker stays, and the run reports it", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outside = path.join(makeTmpDir(), "somebody-elses-directory");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "precious.txt"), "keep me\n");
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: outside,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: path.dirname(outside),
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(
      result.warnings.some(
        (w) => w.includes(outside) && w.includes(markerFilePathFor(realRoot)),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(readMarkerFor(realRoot)).toBeDefined();
    // Nothing of this run's own was started either: no worktree added.
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  });

  it("a marker naming the operator's own registered worktree is refused: it stays registered and intact", async () => {
    useLockDir();
    const { repo } = initRepo();
    const own = path.join(makeTmpDir(), "feature-branch");
    git(repo, ["worktree", "add", "--detach", "--", own, "HEAD"]);
    fs.writeFileSync(path.join(own, "work-in-progress.txt"), "uncommitted\n");
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");
    const realRoot = resolveDeepestExisting(repo);
    writeMarker(realRoot, {
      targetPath: own,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid,
      timestamp: new Date().toISOString(),
      scratchRoot: path.dirname(own),
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(worktreeList(repo)).toContain(resolveDeepestExisting(own));
    expect(
      fs.readFileSync(path.join(own, "work-in-progress.txt"), "utf8"),
    ).toBe("uncommitted\n");
    expect(readMarkerFor(realRoot)).toBeDefined();
  });

  it("a removal at the end of a run that does not take keeps the marker and warns with the path and the manual command", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    // Neither the removal nor the prune runs: the registration is left
    // behind on purpose, the way a git that refuses would leave it.
    mockRun.mockImplementation(async (file, args, options) => {
      if (
        file === "git" &&
        args[0] === "worktree" &&
        (args[1] === "remove" || args[1] === "prune")
      ) {
        return {
          exitCode: 128,
          durationMs: 0,
          stdout: "",
          stderr: "shimmed: did not run",
          logPath: path.join(options.logDir, "shimmed.log"),
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          logWriteFailed: false,
          stdioClosed: true,
        };
      }
      return actualRun.runArgv(file, args, options);
    });

    try {
      const result = await probe(baseOptions(repo));
      const worktreePath = result.isolation.path as string;

      // The verdict stands: the cleanup is best-effort.
      expect(result.status).toBe("killed");
      expect(readMarkerFor(realRoot)?.targetPath).toBe(worktreePath);
      expect(
        result.warnings.some(
          (w) =>
            w.includes(`the worktree at ${worktreePath} was not removed`) &&
            w.includes(
              `git -C ${realRoot} worktree remove --force --force -- ${worktreePath}`,
            ),
        ),
      ).toBe(true);
      // Still registered (git's own removal never ran); the directory
      // itself is gone, deleted for a path the gate admitted.
      expect(worktreeList(repo)).toContain(
        resolveDeepestExisting(worktreePath),
      );
      expect(fs.existsSync(worktreePath)).toBe(false);
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
      git(repo, ["worktree", "prune"]);
    }
  });
});

describe("probe(): worktree isolation, the removal waits for a sync step that outlives the handler's own settle wait", () => {
  it("git worktree list/remove start only after the sync's in-flight git call has settled, even when the handler gave up waiting for it", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "extra.txt"), "untracked\n");
    const savedBound = process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS;
    process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS = "50";
    const events: string[] = [];
    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      if (file === "git" && args[0] === "ls-files") {
        events.push("sync:ls-files:started");
        // The signal lands while this call is in flight, and the call
        // does not die with it: the abort signal is withheld from the
        // real runner and the result reports `aborted: false`, so the
        // sync behaves like a git child the handler's kill never
        // reached, still running long after the handler's 50 ms wait
        // for it has expired.
        process.emit("SIGTERM" as never);
        const { signal: _withheld, ...withoutSignal } = options;
        const result = await actualRun.runArgv(file, args, withoutSignal);
        await new Promise((resolve) => setTimeout(resolve, 300));
        events.push("sync:ls-files:settled");
        return { ...result, aborted: false };
      }
      // The recovery step lists worktrees before the sync starts; only
      // the calls after the sync's own call are the cleanup's.
      if (
        file === "git" &&
        args[0] === "worktree" &&
        args[1] !== "add" &&
        events.includes("sync:ls-files:started")
      ) {
        events.push(`cleanup:${args[1]}:started`);
      }
      return actualRun.runArgv(file, args, options);
    });

    try {
      const result = await probe(baseOptions(repo));

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("aborted");
      const settled = events.indexOf("sync:ls-files:settled");
      const firstCleanup = events.findIndex((e) => e.startsWith("cleanup:"));
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(firstCleanup).toBeGreaterThan(settled);
      expect(events).toContain("cleanup:remove:started");
      expect(
        worktreeList(repo)
          .split("\n\n")
          .filter((b) => b.trim().length > 0),
      ).toHaveLength(1);
    } finally {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
      if (savedBound === undefined) {
        delete process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS;
      } else {
        process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS = savedBound;
      }
    }
  });
});

describe("probe(): worktree isolation, a signal landing while the worktree is still being synced", () => {
  /** sha256 of every file in the original tree that this section
   * asserts is left untouched, keyed by relative path. */
  function treeHashes(
    repo: string,
    relPaths: string[],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rel of relPaths) {
      out[rel] = createHash("sha256")
        .update(fs.readFileSync(path.join(repo, rel)))
        .digest("hex");
    }
    return out;
  }

  async function waitFor(
    predicate: () => boolean,
    what: string,
    timeoutMs = 20000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`${what} never happened`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** The path of this run's scratch subdirectory content, once it
   * exists: `<logDir>/wt-<random>/<name>`. */
  function scratchPath(logDir: string, name: string): string | undefined {
    for (const entry of fs.readdirSync(logDir)) {
      if (!entry.startsWith("wt-")) continue;
      const candidate = path.join(logDir, entry, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /** The `--pre`/`-t` exec logs this run wrote directly into `--log-dir`
   * (the sync's own git logs live in its scratch subdirectory instead).
   * Empty means the run never got past the sync, which is what makes an
   * assertion about a signal landing mid-sync say what it claims. */
  function execLogs(logDir: string): string[] {
    return fs.readdirSync(logDir).filter((f) => f.startsWith("exec-"));
  }

  /** Spawns the CLI worktree probe under a pinned lock dir and log dir,
   * with stdout captured so the signal contract (no envelope on a
   * signalled run) can be asserted. */
  function spawnProbe(
    repo: string,
    lockDir: string,
    logDir: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): { child: ReturnType<typeof spawn>; stdout: () => string } {
    let stdout = "";
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
          // git's own messages are read back from its log below; a
          // fixed locale keeps them the messages this file expects.
          LC_ALL: "C",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    return { child, stdout: () => stdout };
  }

  /** A repository with a tracked change big enough that `git diff HEAD
   * --binary` runs for hundreds of milliseconds. The committed blob is
   * one byte; the incompressible content is written into the working
   * tree here, never checked in. */
  function makeSlowDiffRepo(): string {
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "big.bin"), "x");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "big"]);
    fs.writeFileSync(path.join(repo, "big.bin"), randomBytes(40 * 1024 * 1024));
    return repo;
  }

  it("SIGTERM during the tracked-diff capture exits 143 with no output, removes the worktree, and leaves no marker, no lock, and the original tree untouched", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowDiffRepo();
    const logDir = makeTmpDir();
    const before = treeHashes(repo, [
      "fixture.js",
      "fixture.test.js",
      "big.bin",
    ]);

    const { child, stdout } = spawnProbe(repo, lockDir, logDir);
    // `git diff --output=<path>` creates that file as it starts, so its
    // appearance is the sync's diff phase actually running: no fixed
    // sleep decides when the signal lands.
    await waitFor(
      () => scratchPath(logDir, "tracked.diff") !== undefined,
      "the tracked diff started",
    );
    const diffPath = scratchPath(logDir, "tracked.diff")!;
    const worktreePath = path.join(path.dirname(diffPath), "wt");
    expect(fs.existsSync(worktreePath)).toBe(true);

    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(stdout()).toBe("");
    // The signal really did land inside the sync: nothing had run a
    // baseline command yet.
    expect(execLogs(logDir)).toEqual([]);
    // The worktree is gone from disk and from git's registry.
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
    expect(
      treeHashes(repo, ["fixture.js", "fixture.test.js", "big.bin"]),
    ).toEqual(before);
    // No git child outlived the exit: the interrupted diff of a 40 MB
    // change would still be writing into this file if it had.
    const sizeAtExit = fs.statSync(diffPath).size;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fs.statSync(diffPath).size).toBe(sizeAtExit);
  }, 40000);

  it("SIGTERM during the untracked-file copy exits 143 with no output, removes the worktree, and leaves no marker, no lock, and the original tree untouched", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const many = path.join(repo, "many");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 6000; i += 1) {
      fs.writeFileSync(
        path.join(many, `u-${String(i).padStart(5, "0")}.txt`),
        "x".repeat(64),
      );
    }
    const logDir = makeTmpDir();
    const before = treeHashes(repo, ["fixture.js", "fixture.test.js"]);

    const { child, stdout } = spawnProbe(repo, lockDir, logDir);
    // The first of the 6000 entries appearing inside the worktree is the
    // copy phase being under way, with the rest of it still ahead.
    await waitFor(
      () => scratchPath(logDir, "wt") !== undefined,
      "the worktree was created",
    );
    const worktreePath = scratchPath(logDir, "wt")!;
    await waitFor(
      () => fs.existsSync(path.join(worktreePath, "many", "u-00000.txt")),
      "the untracked copy started",
    );
    // `git ls-files` sorts, so the last of the 6000 entries is copied
    // last: its absence is this phase still being under way at the
    // moment the signal is sent, not a run that had already finished
    // syncing and would exit the same way for unrelated reasons.
    expect(fs.existsSync(path.join(worktreePath, "many", "u-05999.txt"))).toBe(
      false,
    );

    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(stdout()).toBe("");
    // The signal really did land inside the sync: nothing had run a
    // baseline command yet.
    expect(execLogs(logDir)).toEqual([]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
    expect(treeHashes(repo, ["fixture.js", "fixture.test.js"])).toEqual(before);
  }, 40000);

  it("SIGKILL during the tracked-diff capture leaves a marker at the repository key that doctor reports and the next probe recovers", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowDiffRepo();
    const logDir = makeTmpDir();

    const { child } = spawnProbe(repo, lockDir, logDir);
    await waitFor(
      () => scratchPath(logDir, "tracked.diff") !== undefined,
      "the tracked diff started",
    );
    const worktreePath = path.join(
      path.dirname(scratchPath(logDir, "tracked.diff")!),
      "wt",
    );

    // SIGKILL, not SIGTERM: no handler runs, so nothing cleans up. The
    // marker written right after `git worktree add` succeeded is the
    // only trail left, and this is what it is for.
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const { resolveDeepestExisting } =
      await import("../src/probe/containment.js");
    const realRoot = resolveDeepestExisting(repo);
    const marker = readMarkerFor(realRoot);
    expect(marker).toBeDefined();
    expect(marker!.targetPath).toBe(worktreePath);
    expect(execLogs(logDir)).toEqual([]);
    // The leftover really is registered: asserted before the recovery
    // steps, so a regression that never created one reads as that.
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(2);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({ cwd: repo, lockDir });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(worktreePath);

    // The next probe on this repository recovers it and reaches a normal
    // verdict. The big working-tree change is dropped first: it is the
    // slow-diff device of this test, not part of what recovery proves.
    fs.rmSync(path.join(repo, "big.bin"), { force: true });
    git(repo, ["checkout", "--", "big.bin"]);
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(worktreePath)).toBe(false);
  }, 40000);

  /** A repository whose checkout has enough files that `git worktree
   * add` runs for hundreds of milliseconds, generated here and never
   * checked in, with one more device on top: the first of those files
   * carries a smudge filter that reports it has started (by creating
   * the file named in `SMUDGE_STARTED`) and then blocks. A signal sent
   * once that file exists lands while git is provably inside the
   * checkout, with the worktree registered, locked, and partly on
   * disk, rather than at whatever point a poll happened to catch. The
   * next probe on the repository has to run with the filter set back
   * to `cat` (see `releaseGate`). */
  function makeSlowAddRepo(): string {
    const { repo } = initRepo();
    const many = path.join(repo, "many");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 3000; i += 1) {
      fs.writeFileSync(
        path.join(many, `f-${String(i).padStart(5, "0")}.txt`),
        "x".repeat(64),
      );
    }
    fs.writeFileSync(
      path.join(repo, ".gitattributes"),
      "many/f-00000.txt filter=gate\n",
    );
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "many"]);
    // The started-file path travels via an env var, never interpolated
    // into the command string.
    git(repo, [
      "config",
      "filter.gate.smudge",
      'touch "$SMUDGE_STARTED" && sleep 30 && cat',
    ]);
    return repo;
  }

  function releaseGate(repo: string): void {
    git(repo, ["config", "filter.gate.smudge", "cat"]);
  }

  /** Resolves once the gated checkout has reached its blocking filter:
   * `git worktree add` is then inside the checkout for certain. */
  async function waitForGate(startedPath: string): Promise<void> {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(startedPath)) {
      if (Date.now() > deadline) throw new Error("the checkout never started");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** The pid of the `git worktree add` child the spawned CLI has
   * running, read from the process table (`/proc` on Linux, `ps`
   * elsewhere). The CLI starts it in a process group of its own, so a
   * `SIGKILL` to the CLI alone leaves it running: it then completes,
   * and git tidies up after itself, or dies on its closed output pipe
   * and its own junk handler does the same. A leftover of the kind a
   * crash of the whole process tree leaves (registered, locked, on
   * disk) needs the git child killed as well. */
  function gitAddChildOf(cliPid: number): number | undefined {
    if (process.platform === "linux") {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^[0-9]+$/.test(entry)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
          const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(afterComm[1]) !== cliPid) continue;
          const argv = fs
            .readFileSync(`/proc/${entry}/cmdline`, "utf8")
            .split("\0");
          if (argv.includes("worktree") && argv.includes("add")) {
            return Number(entry);
          }
        } catch {
          // The process ended between the listing and the read.
        }
      }
      return undefined;
    }
    const table = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
    });
    for (const line of table.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match || Number(match[2]) !== cliPid) continue;
      if (/\bworktree\b/.test(match[3]) && /\badd\b/.test(match[3])) {
        return Number(match[1]);
      }
    }
    return undefined;
  }

  /** Kills the CLI and then the whole process group of its `git
   * worktree add` child, once that add is blocked inside its checkout:
   * the state a crash of the whole tree leaves behind. */
  async function crashDuringAdd(
    child: ReturnType<typeof spawn>,
    startedPath: string,
  ): Promise<void> {
    await waitForGate(startedPath);
    const gitPid = gitAddChildOf(child.pid!);
    expect(gitPid).toBeDefined();
    child.kill("SIGKILL");
    process.kill(-gitPid!, "SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }

  /** This run's scratch directory under `logDir` (`wt-<random>`), which
   * survives the cleanup: only the worktree inside it is removed. */
  function scratchDir(logDir: string): string {
    const entries = fs.readdirSync(logDir).filter((e) => e.startsWith("wt-"));
    expect(entries).toHaveLength(1);
    return path.join(logDir, entries[0]);
  }

  it("SIGTERM while git worktree add is running exits 143 with no output and leaves no registration, nothing on disk, no marker, and no lock", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowAddRepo();
    const logDir = makeTmpDir();

    const started = path.join(makeTmpDir(), "smudge-started");
    const { child, stdout } = spawnProbe(repo, lockDir, logDir, {
      SMUDGE_STARTED: started,
    });
    await waitForGate(started);
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    expect(exitCode).toBe(143);
    expect(stdout()).toBe("");
    // The add really was cut short: git prints this line only once the
    // checkout has completed, and the diff phase never started.
    const scratch = scratchDir(logDir);
    expect(
      fs.readFileSync(path.join(scratch, "worktree-add.log"), "utf8"),
    ).not.toContain("HEAD is now at");
    expect(fs.existsSync(path.join(scratch, "tracked.diff"))).toBe(false);
    expect(execLogs(logDir)).toEqual([]);
    // Nothing registered (the locked entry an interrupted add leaves is
    // cleared too), nothing on disk, no marker, the lock released.
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(scratch, "wt"))).toBe(false);
    expect(readMarkerFor(resolveDeepestExisting(repo))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 40000);

  it("a crash while git worktree add is running leaves the marker written before the add, which doctor reports and the next probe recovers", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowAddRepo();
    const logDir = makeTmpDir();
    const realRoot = resolveDeepestExisting(repo);

    const started = path.join(makeTmpDir(), "smudge-started");
    const { child } = spawnProbe(repo, lockDir, logDir, {
      SMUDGE_STARTED: started,
    });
    await crashDuringAdd(child, started);

    const scratch = scratchDir(logDir);
    const worktreePath = path.join(scratch, "wt");
    expect(
      fs.readFileSync(path.join(scratch, "worktree-add.log"), "utf8"),
    ).not.toContain("HEAD is now at");
    // The marker was written before the add ran, so it is here even
    // though the add never returned; it names the path and the log dir.
    const marker = readMarkerFor(realRoot);
    expect(marker).toBeDefined();
    expect(marker!.targetPath).toBe(worktreePath);
    expect(marker!.scratchRoot).toBe(path.resolve(logDir));
    // The leftover really is registered (locked, as an interrupted add
    // leaves it): asserted before the recovery steps, so a regression
    // that never created one reads as that.
    expect(worktreeList(repo)).toContain("locked initializing");
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(2);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({
      cwd: repo,
      lockDir,
      required: [],
      optional: [],
    });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(worktreePath);
    expect(staleWorktreeCheck?.detail).toContain("remove --force --force");

    releaseGate(repo);
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  }, 40000);

  it("a crash while git worktree add is running, with the marker then deleted by hand: doctor still reports the registration and the next probe still recovers", async () => {
    const lockDir = useLockDir();
    const repo = makeSlowAddRepo();
    const logDir = makeTmpDir();
    const realRoot = resolveDeepestExisting(repo);

    const started = path.join(makeTmpDir(), "smudge-started");
    const { child } = spawnProbe(repo, lockDir, logDir, {
      SMUDGE_STARTED: started,
    });
    await crashDuringAdd(child, started);

    const worktreePath = path.join(scratchDir(logDir), "wt");
    expect(readMarkerFor(realRoot)).toBeDefined();
    removeMarkerFor(realRoot);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeList(repo)).toContain("locked initializing");
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(2);

    const { doctor } = await import("../src/doctor/index.js");
    const doctorResult = await doctor({
      cwd: repo,
      lockDir,
      required: [],
      optional: [],
    });
    const staleWorktreeCheck = doctorResult.checks.find(
      (c) => c.name === "stale-worktree",
    );
    expect(staleWorktreeCheck?.ok).toBe(false);
    expect(staleWorktreeCheck?.detail).toContain(
      resolveDeepestExisting(worktreePath),
    );

    releaseGate(repo);
    const result = await probe(baseOptions(repo, { logDir }));
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(result.status).toBe("killed");
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(
      worktreeList(repo)
        .split("\n\n")
        .filter((b) => b.trim().length > 0),
    ).toHaveLength(1);
  }, 40000);
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

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    // Every git call in isolation.ts runs with `cwd: root` (the
    // repository), so a shell that DID expand this would create PWNED
    // there, not under `--log-dir` itself or this process's own cwd;
    // checked in all three places nothing was ever created anywhere.
    expect(fs.existsSync(path.join(repo, "PWNED"))).toBe(false);
    expect(fs.existsSync(path.join(base, "PWNED"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "PWNED"))).toBe(false);
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

  it("a valid untracked symlink and a dangling one are both recreated as symlinks (not copied as files), neither aborting the sync", async () => {
    useLockDir();
    const { repo } = initRepo();
    fs.writeFileSync(path.join(repo, "link-target.txt"), "target\n");
    fs.symlinkSync("link-target.txt", path.join(repo, "valid-link.txt"));
    fs.symlinkSync("does-not-exist.txt", path.join(repo, "dangling-link.txt"));

    const outDir = makeTmpDir();
    const outPath = path.join(outDir, "link-check.json");
    const previousEnv = process.env.LINK_CHECK_OUT_PATH;
    process.env.LINK_CHECK_OUT_PATH = outPath;
    try {
      const result = await probe(
        baseOptions(repo, {
          preCommand:
            "node -e \"const fs=require('fs');" +
            "const valid=fs.lstatSync('valid-link.txt').isSymbolicLink();" +
            "const dangling=fs.lstatSync('dangling-link.txt').isSymbolicLink();" +
            'fs.writeFileSync(process.env.LINK_CHECK_OUT_PATH, JSON.stringify({valid,dangling}));"',
        }),
      );

      expect(result.status).toBe("killed");
      expect(result.reason).toBeUndefined();
      const linkCheck = JSON.parse(fs.readFileSync(outPath, "utf8"));
      expect(linkCheck).toEqual({ valid: true, dangling: true });
    } finally {
      if (previousEnv === undefined) delete process.env.LINK_CHECK_OUT_PATH;
      else process.env.LINK_CHECK_OUT_PATH = previousEnv;
    }
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

  it("an untracked plain directory entry is skipped with a warning naming it, neither walked nor mistaken for a nested repository", async () => {
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
        // Real `git ls-files --others --exclude-standard` never reports
        // a plain (non-repository) directory as its own entry: it lists
        // files, or a directory only at a nested `.git` boundary. The
        // entry is stubbed in here because that is the only way to
        // reach the skip-with-a-warning fallback this asserts.
        return { ...result, stdout: result.stdout + "plain-untracked-dir\0" };
      }
      return result;
    });

    try {
      const result = await probe(baseOptions(repo));
      // The entry is skipped, not walked and not copied, and the sync
      // continues to a normal verdict rather than failing over it.
      expect(result.status).toBe("killed");
      expect(
        result.warnings.some(
          (w) =>
            w.includes(
              "neither a regular file, a symlink, nor a nested repository",
            ) && w.includes("plain-untracked-dir"),
        ),
      ).toBe(true);
      expect(
        result.warnings.some((w) =>
          w.includes("skipped a nested repository directory"),
        ),
      ).toBe(false);
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

/** The registry blocks the real git reports, never a shim. */
function worktreeBlocks(repo: string): string[] {
  return worktreeList(repo)
    .split("\n\n")
    .filter((b) => b.trim().length > 0);
}

describe("probe(): worktree isolation on a git that rejects -z (older than 2.36)", () => {
  it("removes its worktree without a false not-removed warning or a kept marker, and the next probe on the repository is not blocked", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "reject-z");
    const logDir = makeTmpDir();

    const first = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(first.status).toBe("killed");
    expect(
      first.warnings.filter(
        (w) => w.includes("was not removed") || w.includes("could not run"),
      ),
    ).toEqual([]);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(first.isolation.path as string)).toBe(false);
    expect(worktreeBlocks(repo)).toHaveLength(1);

    const second = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(second.status).toBe("killed");
    expect(second.warnings).not.toContain("recovered_stale_worktree");
    expect(second.warnings.filter((w) => w.includes("could not run"))).toEqual(
      [],
    );
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);
  });
});

describe("probe(): worktree isolation when git worktree list cannot run in any form", () => {
  it("reports the removal as done but unverified, clears its marker, and the next probe is not stale_worktree", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");
    const logDir = makeTmpDir();

    const first = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(first.status).toBe("killed");
    const worktreePath = first.isolation.path as string;
    expect(
      first.warnings.some(
        (w) =>
          w.includes(`the worktree at ${worktreePath} was removed, but`) &&
          w.includes("unverified"),
      ),
    ).toBe(true);
    expect(first.warnings.some((w) => w.includes("was not removed"))).toBe(
      false,
    );
    expect(
      first.warnings.some((w) =>
        w.includes(`git worktree list could not run for ${realRoot}`),
      ),
    ).toBe(true);
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(worktreeBlocks(repo)).toHaveLength(1);

    const second = await withPathPrepended(shimDir, () =>
      probe(baseOptions(repo, { logDir })),
    );

    expect(second.status).toBe("killed");
    expect(second.reason).not.toBe("stale_worktree");
    expect(second.warnings).not.toContain("recovered_stale_worktree");
    expect(readMarkerFor(realRoot)).toBeUndefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);
  });
});

describe("probe(): worktree isolation, a marker never certifies its own containment", () => {
  function deadPid(): number {
    const pid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!pid) throw new Error("failed to obtain a dead pid for the test");
    return pid;
  }

  it("a marker naming an unregistered scratch-shaped directory under its own recorded log dir, outside this run's --log-dir, is refused: nothing is deleted and the marker stays", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const pretendRoot = makeTmpDir();
    const planted = path.join(pretendRoot, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "precious.txt"), "keep me\n");
    writeMarker(realRoot, {
      targetPath: planted,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot: pretendRoot,
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_worktree");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(planted) &&
          w.includes("not under this run's log dir") &&
          w.includes(markerFilePathFor(realRoot)),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(planted, "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(readMarkerFor(realRoot)).toBeDefined();
    expect(worktreeBlocks(repo)).toHaveLength(1);
  });

  it("the same marker with the directory under this run's own --log-dir is recovered, whatever log dir the marker recorded", async () => {
    useLockDir();
    const { repo } = initRepo();
    const realRoot = resolveDeepestExisting(repo);
    const logDir = makeTmpDir();
    const planted = path.join(logDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "stale.txt"), "leftover\n");
    writeMarker(realRoot, {
      targetPath: planted,
      backupPath: realRoot,
      preHash: "",
      mutatedHash: "",
      pid: deadPid(),
      timestamp: new Date().toISOString(),
      scratchRoot: makeTmpDir(),
    });

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(fs.existsSync(planted)).toBe(false);
    expect(readMarkerFor(realRoot)).toBeUndefined();
  });
});

describe("probe(): worktree isolation, a live probe under another lock directory", () => {
  it("a second probe under a different AGENT_PRIMITIVES_LOCK_DIR leaves the first probe's live worktree alone, and a third probe after the first finishes finds nothing to recover", async () => {
    const lockDirFirst = makeTmpDir();
    // This process's probes run under a different lock dir than the
    // first (CLI) probe, so the lock cannot serialize them.
    useLockDir();
    const { repo } = initRepo();
    const logDirFirst = makeTmpDir();
    const signals = makeTmpDir();
    const ready = path.join(signals, "ready.txt");
    const release = path.join(signals, "release.txt");
    // Only the first (CLI) probe gets the two signal paths in its
    // environment: its test announces itself through `ready` and then
    // holds until `release` exists, so the first probe provably sits in
    // its test, worktree in use, for as long as this test wants. The
    // in-process probes below run the same file without either path
    // and go straight to the assertions.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const ready = process.env.READY_ABS_PATH;",
        "const release = process.env.RELEASE_ABS_PATH;",
        "if (ready) fs.writeFileSync(ready, 'running');",
        "const started = Date.now();",
        "function run() {",
        "  const assert = require('node:assert');",
        "  const { isPositive } = require('./fixture.js');",
        "  assert.strictEqual(isPositive(5), true);",
        "  assert.strictEqual(isPositive(-5), false);",
        "}",
        "function wait() {",
        "  if (!release || fs.existsSync(release) || Date.now() - started > 15000) {",
        "    run();",
        "    return;",
        "  }",
        "  setTimeout(wait, 50);",
        "}",
        "wait();",
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
          AGENT_PRIMITIVES_LOCK_DIR: lockDirFirst,
          AGENT_PRIMITIVES_LOG_DIR: logDirFirst,
          READY_ABS_PATH: ready,
          RELEASE_ABS_PATH: release,
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let firstStdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      firstStdout += chunk;
    });
    const firstClosed = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("the first probe's test never signalled readiness");
      }
      if (child.exitCode !== null) {
        throw new Error(
          `the first probe exited early with ${String(child.exitCode)}: ${firstStdout}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The first probe's worktree is registered, on disk, and owned by
    // the CLI process, which is still running its test.
    const scratchDuring = parseWorktreeListZ(
      execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
        cwd: repo,
        encoding: "utf8",
      }),
    )
      .map(resolveDeepestExisting)
      .filter(isScratchWorktreePath);
    expect(scratchDuring).toHaveLength(1);
    const firstWorktree = scratchDuring[0];
    expect(readScratchOwner(firstWorktree)?.pid).toBe(child.pid);

    const second = await probe(baseOptions(repo));

    expect(second.status).toBe("killed");
    expect(
      second.warnings.some(
        (w) =>
          w.includes(firstWorktree) &&
          w.includes(`live probe (pid ${String(child.pid)})`),
      ),
    ).toBe(true);
    expect(second.warnings).not.toContain("recovered_stale_worktree");
    // The first probe is still held in its test: its worktree is intact
    // and registered after the second probe has run to completion.
    expect(fs.existsSync(firstWorktree)).toBe(true);
    expect(fs.existsSync(path.join(firstWorktree, "fixture.js"))).toBe(true);
    expect(worktreeList(repo)).toContain(firstWorktree);

    fs.writeFileSync(release, "go");
    expect(await firstClosed).toBe(0);
    const firstResult = JSON.parse(firstStdout) as {
      status: string;
      warnings: string[];
    };
    expect(firstResult.status).toBe("killed");
    expect(
      firstResult.warnings.filter((w) => w.includes("was not removed")),
    ).toEqual([]);
    expect(fs.existsSync(firstWorktree)).toBe(false);

    const third = await probe(baseOptions(repo));

    expect(third.status).toBe("killed");
    expect(third.warnings).not.toContain("recovered_stale_worktree");
    expect(third.warnings.filter((w) => w.includes("live probe"))).toEqual([]);
    expect(worktreeBlocks(repo)).toHaveLength(1);
  }, 30000);
});

describe("probe(): worktree isolation, the owner record's bound", () => {
  /** A pid that is alive from any user's point of view: pid 1 always
   * exists, and the liveness check reads the EPERM a non-root user gets
   * from signalling it as alive. */
  const ALIVE_PID = 1;

  function writeOwner(wt: string, timestamp: string): void {
    fs.writeFileSync(
      path.join(path.dirname(wt), SCRATCH_OWNER_FILE),
      JSON.stringify({
        pid: ALIVE_PID,
        timestamp,
        logDir: path.dirname(path.dirname(wt)),
      }),
    );
  }

  function registeredScratch(repo: string): string[] {
    return parseWorktreeListZ(
      execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
        cwd: repo,
        encoding: "utf8",
      }),
    )
      .map(resolveDeepestExisting)
      .filter(isScratchWorktreePath);
  }

  it("recovers a registered scratch worktree whose owner record is past the bound even though its pid is alive, and leaves one under a fresh record alone", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();
    const expired = path.join(logDir, `wt-${randomUUID()}`, "wt");
    const fresh = path.join(logDir, `wt-${randomUUID()}`, "wt");
    for (const wt of [expired, fresh]) {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git(repo, ["worktree", "add", "--detach", "--", wt, "HEAD"]);
    }
    writeOwner(expired, "2020-01-01T00:00:00.000Z");
    writeOwner(fresh, new Date().toISOString());
    const expiredResolved = resolveDeepestExisting(expired);
    const freshResolved = resolveDeepestExisting(fresh);

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("killed");
    expect(result.warnings).toContain("recovered_stale_worktree");
    expect(
      result.warnings.filter(
        (w) =>
          w.includes(freshResolved) &&
          w.includes(`live probe (pid ${String(ALIVE_PID)})`),
      ),
    ).toHaveLength(1);
    expect(
      result.warnings.filter(
        (w) => w.includes(expiredResolved) && w.includes("live probe"),
      ),
    ).toEqual([]);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(registeredScratch(repo)).toEqual([freshResolved]);
  });
});
