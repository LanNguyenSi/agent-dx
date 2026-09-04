import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  beginInplace,
  beginWorktree,
  cleanupWorktree,
  countNumstatFiles,
  findNodeModulesDirs,
  isScratchWorktreePath,
  listRegisteredWorktrees,
  liveForeignOwner,
  parseWorktreeListLines,
  parseWorktreeListZ,
  readScratchOwner,
  rejectsOption,
  SCRATCH_OWNER_FILE,
  SCRATCH_OWNER_MAX_AGE_HOURS,
  scratchOwnerState,
} from "../src/probe/isolation.js";
import { resolveDeepestExisting } from "../src/probe/containment.js";
import { runArgv } from "../src/probe/run.js";
import { parseGitVersion } from "../src/doctor/index.js";
import {
  withPathPrepended,
  writeGitShim,
  type GitShimMode,
} from "./helpers/git-shim.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** True when the host git is new enough to understand `git worktree
 * add --relative-paths` / `worktree.useRelativePaths` (git >= 2.48,
 * which writes every admin entry's `gitdir` file relative to its own
 * directory rather than absolute). Gates the one test that exercises
 * this through a real git rather than a hand-written fixture, so an
 * older git (e.g. the 2.30 container in CI) skips it instead of
 * failing on an option it does not have. */
function gitSupportsRelativePaths(): boolean {
  const out = execFileSync("git", ["--version"], { encoding: "utf8" });
  const version = parseGitVersion(out);
  if (version === undefined) return false;
  return version.major > 2 || (version.major === 2 && version.minor >= 48);
}

// Call-through mock (the same shape probe-worktree.test.ts uses): every
// call runs the real runner, and the recorded calls are what lets a test
// assert what `beginWorktree` passed into each git invocation. This is
// the one seam every git call in isolation.ts goes through.
vi.mock("../src/probe/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/probe/run.js")>();
  return { ...actual, runArgv: vi.fn(actual.runArgv) };
});

/** The recorded `runArgv` calls for `git`, in order. */
function gitCalls(): Parameters<typeof runArgv>[] {
  return vi
    .mocked(runArgv)
    .mock.calls.filter((call) => call[0] === "git") as Parameters<
    typeof runArgv
  >[];
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-isolation-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.mocked(runArgv).mockClear();
});

describe("beginInplace", () => {
  it("copies the target into the log dir and restores it byte for byte", () => {
    const dir = makeTmpDir();
    const logDir = makeTmpDir();
    const target = path.join(dir, "fixture.js");
    const original = "original content\n";
    fs.writeFileSync(target, original);

    const session = beginInplace(target, logDir);
    fs.writeFileSync(target, "mutated\n");
    expect(session.restore()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("never overwrites a backup name that already exists: it claims a distinct one", () => {
    const dir = makeTmpDir();
    const logDir = makeTmpDir();
    const target = path.join(dir, "fixture.js");
    fs.writeFileSync(target, "original content\n");

    // A backup from an earlier session sharing this log dir (the
    // stale-marker recovery path re-uses the log dir of the probe that
    // recovers it). Its content is the only copy of some other target's
    // pre-mutation state, so overwriting it would destroy that state.
    const takenPath = path.join(logDir, "backup-fixture.js");
    const takenContent = "an earlier session's backup\n";
    fs.writeFileSync(takenPath, takenContent);

    const session = beginInplace(target, logDir);

    expect(session.backupPath).not.toBe(takenPath);
    expect(fs.readFileSync(takenPath, "utf8")).toBe(takenContent);
    expect(fs.readFileSync(session.backupPath, "utf8")).toBe(
      "original content\n",
    );
  });

  it("refuses to write into a backup name that appears between choosing it and opening it, and claims the next name instead", () => {
    const dir = makeTmpDir();
    const logDir = makeTmpDir();
    const target = path.join(dir, "fixture.js");
    fs.writeFileSync(target, "original content\n");

    // The window an `existsSync` check before the copy would leave open,
    // reproduced exactly: the name is free when it is chosen and taken by
    // the time it is opened. Only the `O_EXCL` create itself sees that,
    // which is why the seam is at the open and not around it.
    const racerContent = "a concurrent session's backup\n";
    const firstBackup = path.join(logDir, "backup-fixture.js");
    let raced = false;
    const open = (filePath: string, flags: string): number => {
      if (!raced) {
        raced = true;
        fs.writeFileSync(filePath, racerContent);
      }
      return fs.openSync(filePath, flags);
    };

    const session = beginInplace(target, logDir, { open });

    expect(raced).toBe(true);
    // The other session's backup is untouched: not truncated, not
    // overwritten with this session's copy of the target. Asserted
    // first, so a regression is reported as the data loss it is rather
    // than as an unexpected backup name.
    expect(fs.readFileSync(firstBackup, "utf8")).toBe(racerContent);
    expect(session.backupPath).toBe(path.join(logDir, "backup-1-fixture.js"));
    expect(fs.readFileSync(session.backupPath, "utf8")).toBe(
      "original content\n",
    );
  });

  it("keeps claiming further distinct names as more of them are taken", () => {
    const dir = makeTmpDir();
    const logDir = makeTmpDir();
    const target = path.join(dir, "fixture.js");
    fs.writeFileSync(target, "original content\n");

    const first = beginInplace(target, logDir);
    const second = beginInplace(target, logDir);
    const third = beginInplace(target, logDir);

    const paths = [first.backupPath, second.backupPath, third.backupPath];
    expect(new Set(paths).size).toBe(3);
    for (const backupPath of paths) {
      expect(fs.readFileSync(backupPath, "utf8")).toBe("original content\n");
    }
  });
});

describe("countNumstatFiles", () => {
  it("is 0 for empty numstat output (a clean tree)", () => {
    expect(countNumstatFiles("")).toBe(0);
  });

  it("counts one record per plain file, NUL-delimited", () => {
    const numstat = ["3\t1\tfoo.js", "5\t0\tbar.js"].join("\0") + "\0";
    expect(countNumstatFiles(numstat)).toBe(2);
  });

  it("counts a binary file's '-\\t-\\tpath' record as one file, never by scanning its content", () => {
    // A binary file's numstat record uses "-" for both counts; its
    // content (the diff's own binary hunk) is never involved in this
    // count at all -- only the numstat listing is parsed.
    const numstat = "-\t-\timage.png\0";
    expect(countNumstatFiles(numstat)).toBe(1);
  });

  it("counts a rename record (empty path field, then old and new path tokens) as one file", () => {
    // git's own `-z` rename shape: "<added>\t<deleted>\t" (empty path),
    // then the old path, then the new path, each its own NUL-terminated
    // token.
    const numstat = ["0\t0\t", "old-name.js", "new-name.js"].join("\0") + "\0";
    expect(countNumstatFiles(numstat)).toBe(1);
  });

  it("counts a rename mixed with plain files correctly", () => {
    const numstat =
      ["1\t1\tfoo.js", "0\t0\t", "old.js", "new.js", "2\t2\tbar.js"].join(
        "\0",
      ) + "\0";
    expect(countNumstatFiles(numstat)).toBe(3);
  });

  it("a real 'git diff HEAD --numstat -z' against a tracked modification matches the byte-count for a single file", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-numstat-test-"),
    );
    tmpDirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.js"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
      { cwd: dir },
    );
    fs.writeFileSync(path.join(dir, "a.js"), "one\ntwo\n");
    const numstat = execFileSync("git", ["diff", "HEAD", "--numstat", "-z"], {
      cwd: dir,
    }).toString("utf8");
    expect(countNumstatFiles(numstat)).toBe(1);
  });
});

describe("findNodeModulesDirs", () => {
  it("finds node_modules at depth 1 and depth 3, but not at depth 4", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "a", "b", "node_modules"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, "a", "b", "c", "node_modules"), {
      recursive: true,
    });

    const found = findNodeModulesDirs(root);

    expect(found).toContain(path.join(root, "node_modules"));
    expect(found).toContain(path.join(root, "a", "b", "node_modules"));
    expect(found).not.toContain(path.join(root, "a", "b", "c", "node_modules"));
  });

  it("does not find a node_modules at depth 5, one level further than the already-excluded depth 4", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "a", "b", "c", "d", "node_modules"), {
      recursive: true,
    });

    expect(findNodeModulesDirs(root)).toEqual([]);
  });

  it("links a node_modules that is itself a symlink to a directory (a hoisted or workspace-linked install)", () => {
    const root = makeTmpDir();
    const realDir = makeTmpDir();
    fs.writeFileSync(path.join(realDir, "marker.txt"), "present\n");
    fs.symlinkSync(realDir, path.join(root, "node_modules"), "dir");

    const found = findNodeModulesDirs(root);

    expect(found).toEqual([path.join(root, "node_modules")]);
  });

  it("does not link a node_modules symlink that dangles (points at nothing)", () => {
    const root = makeTmpDir();
    fs.symlinkSync(
      path.join(root, "does-not-exist"),
      path.join(root, "node_modules"),
      "dir",
    );

    expect(findNodeModulesDirs(root)).toEqual([]);
  });

  it("never recurses into a node_modules directory it already found", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "node_modules", "some-pkg", "node_modules"), {
      recursive: true,
    });

    const found = findNodeModulesDirs(root);

    expect(found).toEqual([path.join(root, "node_modules")]);
  });

  it("does not descend into .git", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, ".git", "node_modules"), {
      recursive: true,
    });

    expect(findNodeModulesDirs(root)).toEqual([]);
  });
});

describe("beginWorktree / cleanupWorktree", () => {
  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd });
  }

  function initRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return repo;
  }

  it("creates a detached worktree with a clean tree reporting syncedTrackedFiles 0, then removes it fully on cleanup", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();

    const result = await beginWorktree({
      root: repo,
      cwd: repo,
      logDir,
      links: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.existsSync(result.worktreePath)).toBe(true);
    expect(
      fs.readFileSync(path.join(result.worktreePath, "fixture.js"), "utf8"),
    ).toBe("module.exports = {};\n");
    expect(result.syncedTrackedFiles).toBe(0);
    expect(result.syncedUntrackedFiles).toBe(0);

    const cleanup = await cleanupWorktree(repo, result.worktreePath, logDir, {
      scratchRoot: logDir,
    });
    expect(cleanup.ok).toBe(true);
    expect(fs.existsSync(result.worktreePath)).toBe(false);
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(list).not.toContain(result.worktreePath);
  });

  it("syncs an uncommitted tracked modification and reports its count", async () => {
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, "fixture.js"),
      "module.exports = { a: 1 };\n",
    );
    const logDir = makeTmpDir();

    const result = await beginWorktree({
      root: repo,
      cwd: repo,
      logDir,
      links: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.syncedTrackedFiles).toBe(1);
    expect(
      fs.readFileSync(path.join(result.worktreePath, "fixture.js"), "utf8"),
    ).toBe("module.exports = { a: 1 };\n");
  });

  it("copies an untracked, non-ignored file to the same relative path and reports its count", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "extra.txt"), "untracked content\n");
    const logDir = makeTmpDir();

    const result = await beginWorktree({
      root: repo,
      cwd: repo,
      logDir,
      links: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.syncedUntrackedFiles).toBe(1);
    expect(
      fs.readFileSync(path.join(result.worktreePath, "extra.txt"), "utf8"),
    ).toBe("untracked content\n");
  });

  it("symlinks node_modules and --link extras into the worktree, reported in linked", async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, "node_modules"));
    fs.writeFileSync(
      path.join(repo, "node_modules", "marker.txt"),
      "present\n",
    );
    // `--link` extras must sit inside the containment root, so a real
    // one lives inside the repository, just under a name
    // `findNodeModulesDirs` would never pick up on its own.
    const cacheDir = path.join(repo, "vendor-cache");
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, "cache-marker.txt"), "x\n");
    const logDir = makeTmpDir();

    const result = await beginWorktree({
      root: repo,
      cwd: repo,
      logDir,
      links: [cacheDir],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.linked).toContain(path.join(repo, "node_modules"));
    expect(result.linked).toContain(cacheDir);
    expect(
      fs.readFileSync(
        path.join(result.worktreePath, "node_modules", "marker.txt"),
        "utf8",
      ),
    ).toBe("present\n");
  });

  it("maps cwd onto the worktree at the same relative offset from root", async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    const logDir = makeTmpDir();

    const result = await beginWorktree({
      root: repo,
      cwd: path.join(repo, "sub"),
      logDir,
      links: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mappedCwd).toBe(path.join(result.worktreePath, "sub"));
  });

  it("worktree_sync_failed when git worktree add itself fails (not a git repository)", async () => {
    const notARepo = makeTmpDir();
    const logDir = makeTmpDir();

    const result = await beginWorktree({
      root: notARepo,
      cwd: notARepo,
      logDir,
      links: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("worktree_sync_failed");
    expect(result.worktreePath).toBeUndefined();
  });

  describe("under a caller's signal and tracking hook", () => {
    /** A repository whose sync exercises every git call: a tracked
     * modification (so the diff is non-empty) and an untracked file. */
    function initDirtyRepo(): string {
      const repo = initRepo();
      fs.writeFileSync(
        path.join(repo, "fixture.js"),
        "module.exports = { a: 1 };\n",
      );
      fs.writeFileSync(path.join(repo, "extra.txt"), "untracked\n");
      return repo;
    }

    /** A repository with a tracked change big enough that `git diff HEAD
     * --binary` takes hundreds of milliseconds, which is the window an
     * abort has to land in. Generated here, never checked in: the
     * committed blob is one byte, and the incompressible content is
     * written into the working tree afterwards. */
    function initRepoWithSlowDiff(): string {
      const repo = initRepo();
      fs.writeFileSync(path.join(repo, "big.bin"), "x");
      git(repo, ["add", "-A"]);
      git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "big"]);
      fs.writeFileSync(
        path.join(repo, "big.bin"),
        randomBytes(40 * 1024 * 1024),
      );
      return repo;
    }

    async function waitFor(
      predicate: () => boolean,
      what: string,
      timeoutMs = 15000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`${what} never happened`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    function worktreeBlocks(repo: string): string[] {
      return execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repo,
        encoding: "utf8",
      })
        .split("\n\n")
        .filter((block) => block.trim().length > 0);
    }

    it("passes the caller's signal into every git call and registers every one of them through track", async () => {
      const repo = initDirtyRepo();
      const logDir = makeTmpDir();
      const controller = new AbortController();
      const tracked: Promise<unknown>[] = [];
      const closures: Promise<void>[] = [];

      const result = await beginWorktree({
        root: repo,
        cwd: repo,
        logDir,
        links: [],
        signal: controller.signal,
        track: async (started, closed) => {
          tracked.push(started);
          closures.push(closed);
          return started;
        },
      });

      expect(result.ok).toBe(true);
      // worktree add, the tracked diff, the numstat count, the apply,
      // and the untracked listing: every one of them under the signal.
      const calls = gitCalls();
      expect(calls.length).toBe(5);
      for (const call of calls) {
        expect(call[2].signal).toBe(controller.signal);
      }
      // ... and every one of them registered as the caller's in-flight
      // run, so a signal handler waits for it instead of restoring or
      // removing the worktree underneath it.
      expect(tracked).toHaveLength(calls.length);
      expect(closures).toHaveLength(calls.length);
      await Promise.all(closures);
    });

    it("an abort during the tracked-diff capture is reported as aborted, never as a sync failure", async () => {
      const repo = initRepoWithSlowDiff();
      const logDir = makeTmpDir();
      const controller = new AbortController();

      const started = beginWorktree({
        root: repo,
        cwd: repo,
        logDir,
        links: [],
        signal: controller.signal,
      });
      // `git diff --output=<path>` creates that file when it starts, so
      // its appearance is the diff phase actually being under way; no
      // fixed sleep decides when the abort lands.
      const diffFile = (): string | undefined => {
        for (const entry of fs.readdirSync(logDir)) {
          if (!entry.startsWith("wt-")) continue;
          const candidate = path.join(logDir, entry, "tracked.diff");
          if (fs.existsSync(candidate)) return candidate;
        }
        return undefined;
      };
      await waitFor(() => diffFile() !== undefined, "the tracked diff started");
      const diffPath = diffFile()!;
      controller.abort();

      const result = await started;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("aborted");
      // The step named is the diff capture itself, not a later call
      // that inherited the abort: a diff left running to completion
      // would report the numstat count instead.
      expect(result.detail).toContain("the tracked-diff capture");
      // The capture really was cut short: a finished `git diff HEAD
      // --binary` of a 40 MB change writes more than the 40 MB itself
      // (the literal hunk is base85-encoded), and this file is a
      // fraction of that. Asserted before the no-growth check below,
      // which a completed diff would also satisfy.
      const sizeAtAbort = fs.statSync(diffPath).size;
      expect(sizeAtAbort).toBeLessThan(40 * 1024 * 1024);
      // ... and the killed git child wrote nothing more after the abort.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.statSync(diffPath).size).toBe(sizeAtAbort);

      const cleanup = await cleanupWorktree(
        repo,
        result.worktreePath!,
        logDir,
        {
          scratchRoot: logDir,
        },
      );
      expect(cleanup.ok).toBe(true);
      expect(worktreeBlocks(repo)).toHaveLength(1);
    }, 30000);

    it("an abort during the untracked-file copy is reported as aborted", async () => {
      const repo = initRepo();
      const many = path.join(repo, "many");
      fs.mkdirSync(many, { recursive: true });
      for (let i = 0; i < 6000; i += 1) {
        fs.writeFileSync(
          path.join(many, `u-${String(i).padStart(5, "0")}.txt`),
          "x".repeat(64),
        );
      }
      const logDir = makeTmpDir();
      const controller = new AbortController();
      let worktreePath: string | undefined;

      const started = beginWorktree({
        root: repo,
        cwd: repo,
        logDir,
        links: [],
        signal: controller.signal,
        onWorktreeAttempt: (p) => {
          worktreePath = p;
        },
      });
      // The first copied entry appearing in the worktree is the copy
      // phase being under way; `git ls-files` sorts, so this is the
      // first of the 6000, with the rest of the phase still ahead.
      await waitFor(
        () =>
          worktreePath !== undefined &&
          fs.existsSync(path.join(worktreePath, "many", "u-00000.txt")),
        "the untracked copy started",
      );
      controller.abort();

      const result = await started;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("aborted");
      expect(result.detail).toContain("untracked-file copy");
      // Stopped partway, not merely reported as stopped after copying
      // everything anyway.
      expect(
        fs.existsSync(path.join(worktreePath!, "many", "u-05999.txt")),
      ).toBe(false);

      const cleanup = await cleanupWorktree(repo, worktreePath!, logDir, {
        scratchRoot: logDir,
      });
      expect(cleanup.ok).toBe(true);
      expect(worktreeBlocks(repo)).toHaveLength(1);
    }, 30000);

    it("an abort that lands before git worktree add returns leaves nothing registered", async () => {
      const repo = initRepo();
      const logDir = makeTmpDir();
      const controller = new AbortController();
      controller.abort();
      let worktreePath: string | undefined;

      const result = await beginWorktree({
        root: repo,
        cwd: repo,
        logDir,
        links: [],
        signal: controller.signal,
        onWorktreeAttempt: (p) => {
          worktreePath = p;
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("aborted");
      // The caller knows the path even though the add never returned
      // successfully, which is what lets it clean up a registration git
      // may already have written.
      expect(worktreePath).toBeDefined();
      // Nothing is registered, so the gate admits the path only through
      // its scratch shape under the log dir it was to be created in.
      const cleanup = await cleanupWorktree(repo, worktreePath!, logDir, {
        scratchRoot: logDir,
      });
      expect(cleanup.ok).toBe(true);
      expect(worktreeBlocks(repo)).toHaveLength(1);
      expect(fs.existsSync(worktreePath!)).toBe(false);
    });
  });

  it("an untracked symlink whose target resolves inside --log-dir is recreated as a symlink, while the log dir's own content is never synced", async () => {
    const repo = initRepo();
    // The log dir sits inside the repository, so its content is
    // untracked too; only the link that merely points at it is a source.
    const logDir = path.join(repo, "scratch-logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "inside.txt"), "scratch\n");
    fs.symlinkSync("scratch-logs", path.join(repo, "log-link"));

    const result = await beginWorktree({
      root: repo,
      cwd: repo,
      logDir,
      links: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.syncedUntrackedFiles).toBe(1);
    const linkInWorktree = path.join(result.worktreePath, "log-link");
    expect(fs.lstatSync(linkInWorktree).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkInWorktree)).toBe("scratch-logs");
    expect(
      fs.existsSync(
        path.join(result.worktreePath, "scratch-logs", "inside.txt"),
      ),
    ).toBe(false);
  });
});

describe("isScratchWorktreePath / parseWorktreeListZ", () => {
  it("accepts exactly a `wt` directory inside a `wt-<uuid>` directory", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(isScratchWorktreePath(`/x/logs/wt-${id}/wt`)).toBe(true);
    expect(isScratchWorktreePath(`/x/logs/wt-${id}/wt/`)).toBe(true);
    expect(isScratchWorktreePath(`/x/logs/wt-${id}`)).toBe(false);
    expect(isScratchWorktreePath(`/x/logs/wt-${id}/other`)).toBe(false);
    expect(isScratchWorktreePath(`/x/logs/wt-short/wt`)).toBe(false);
    expect(isScratchWorktreePath(`/x/logs/wt`)).toBe(false);
    expect(isScratchWorktreePath("/x/feature-branch")).toBe(false);
  });

  it("pins the uuid layout itself (8-4-4-4-12 lowercase hex), not just the character class and length", () => {
    const real = randomUUID();
    expect(isScratchWorktreePath(`/x/logs/wt-${real}/wt`)).toBe(true);
    expect(isScratchWorktreePath(`/x/logs/wt-${"-".repeat(36)}/wt`)).toBe(
      false,
    );
    expect(isScratchWorktreePath(`/x/logs/wt-${"a".repeat(36)}/wt`)).toBe(
      false,
    );
    expect(isScratchWorktreePath(`/x/logs/wt-${real.toUpperCase()}/wt`)).toBe(
      false,
    );
    // The right groups in the wrong places: still 36 characters of the
    // right class.
    expect(
      isScratchWorktreePath(
        `/x/logs/wt-${real.slice(9)}-${real.slice(0, 8)}/wt`,
      ),
    ).toBe(false);
  });

  it("parses the newline-separated porcelain listing into the worktree paths, in order, with quoted lock reasons and bare entries", () => {
    const listing = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /logs/wt-1/wt",
      "HEAD abc",
      "detached",
      'locked "why\\nnot"',
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /bare.git",
      "bare",
      "",
    ].join("\n");
    expect(parseWorktreeListLines(listing)).toEqual({
      ok: true,
      paths: ["/repo", "/logs/wt-1/wt", "/bare.git"],
    });
    expect(parseWorktreeListLines("")).toEqual({ ok: true, paths: [] });
  });

  it("refuses a newline-separated listing whose worktree path contains a newline, however the continuation reads, rather than misreading it", () => {
    const withTail = (tail: string): string =>
      [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        `worktree /logs/wt-1/wt${tail}`,
        "HEAD abc",
        "detached",
        "",
      ].join("\n");
    // A continuation that is no attribute at all.
    expect(parseWorktreeListLines(withTail("\nfoo")).ok).toBe(false);
    // Continuations that read as attributes: each lands out of order
    // or twice, since git prints HEAD right after the path.
    for (const tail of [
      "\nHEAD deadbeef",
      "\nbranch refs/heads/x",
      "\ndetached",
      "\nlocked",
      "\nprunable",
      "\nbare",
      "\nworktree /elsewhere",
      // Continuations that read as a block boundary: the path's own
      // block then ends after its worktree line alone, which no block
      // git prints ever does, so the line after the boundary never
      // starts a phantom block that registers a path of its own.
      "\n\nworktree /elsewhere",
      "\n",
    ]) {
      const parsed = parseWorktreeListLines(withTail(tail));
      expect(parsed.ok, tail).toBe(false);
    }
    expect(parseWorktreeListLines(withTail("\n\nworktree /elsewhere"))).toEqual(
      {
        ok: false,
        detail: "line 5 is a worktree path with nothing after it in its block",
      },
    );
    // The same rule at the end of the listing, with and without a
    // trailing newline; a complete last block needs no trailing newline.
    expect(
      parseWorktreeListLines("worktree /repo\nHEAD abc\n\nworktree /x"),
    ).toEqual({
      ok: false,
      detail: "line 4 is a worktree path with nothing after it in its block",
    });
    expect(parseWorktreeListLines("worktree /repo\n").ok).toBe(false);
    expect(parseWorktreeListLines("worktree /repo").ok).toBe(false);
    expect(parseWorktreeListLines("worktree /repo\nHEAD abc")).toEqual({
      ok: true,
      paths: ["/repo"],
    });
    // A block that does not start with a worktree path.
    expect(parseWorktreeListLines("HEAD abc\ndetached\n").ok).toBe(false);
  });

  it("parses the NUL-terminated porcelain records into the worktree paths, in order", () => {
    const listing =
      ["worktree /repo", "HEAD abc", "branch refs/heads/main", ""].join("\0") +
      "\0" +
      [
        "worktree /logs/wt-1/wt",
        "HEAD abc",
        "detached",
        "locked initializing",
        "",
      ].join("\0") +
      "\0";
    expect(parseWorktreeListZ(listing)).toEqual(["/repo", "/logs/wt-1/wt"]);
    expect(parseWorktreeListZ("")).toEqual([]);
  });
});

describe("cleanupWorktree: the removal is asserted, and every delete goes through the gate", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  function initRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return repo;
  }

  function registeredPaths(repo: string): string[] {
    return parseWorktreeListZ(
      git(repo, ["worktree", "list", "--porcelain", "-z"]),
    ).map(resolveDeepestExisting);
  }

  /** A scratch-shaped path under `logDir`, the shape `beginWorktree`
   * itself produces. */
  function scratchPath(logDir: string): string {
    return path.join(logDir, `wt-${randomUUID()}`, "wt");
  }

  /** A worktree registered by hand at `worktreePath`, then marked
   * `locked` with the reason an interrupted `git worktree add` leaves. */
  function addLockedWorktree(repo: string, worktreePath: string): void {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
    const adminDir = path.join(repo, ".git", "worktrees");
    const entries = fs.readdirSync(adminDir);
    expect(entries).toHaveLength(1);
    fs.writeFileSync(path.join(adminDir, entries[0], "locked"), "initializing");
    expect(
      git(repo, ["worktree", "list", "--porcelain"]).includes(
        "locked initializing",
      ),
    ).toBe(true);
  }

  /** Makes the `git worktree remove` step report failure without
   * running, leaving every other git call real. Returns the restore. */
  async function shimRemoveToFail(): Promise<() => void> {
    const actualRun = await vi.importActual<
      typeof import("../src/probe/run.js")
    >("../src/probe/run.js");
    const mockRun = vi.mocked(runArgv);
    mockRun.mockImplementation(async (file, args, options) => {
      if (file === "git" && args[0] === "worktree" && args[1] === "remove") {
        return {
          exitCode: 128,
          durationMs: 0,
          stdout: "",
          stderr: "shimmed: the removal did not run",
          logPath: path.join(options.logDir, "shimmed-remove.log"),
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          logWriteFailed: false,
          stdioClosed: true,
        };
      }
      return actualRun.runArgv(file, args, options);
    });
    return () => {
      mockRun.mockImplementation((...args: Parameters<typeof runArgv>) =>
        actualRun.runArgv(...args),
      );
    };
  }

  it("clears a `locked initializing` registration (what an interrupted add leaves) and asserts it is gone", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    addLockedWorktree(repo, worktreePath);

    const cleanup = await cleanupWorktree(repo, worktreePath, logDir, {
      scratchRoot: logDir,
    });

    expect(cleanup.ok).toBe(true);
    expect(cleanup.refused).toBe(false);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it("reports ok:false when the removal does not take: the locked registration survives the shimmed removal, and prune exiting 0 is not read as success", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    addLockedWorktree(repo, worktreePath);
    const restore = await shimRemoveToFail();

    try {
      const cleanup = await cleanupWorktree(repo, worktreePath, logDir, {
        scratchRoot: logDir,
      });

      expect(cleanup.ok).toBe(false);
      expect(cleanup.refused).toBe(false);
      expect(cleanup.detail).toContain("still reports it as a worktree");
      // The registration is still there (locked, so `prune` skipped it
      // even though its directory is gone) ...
      expect(registeredPaths(repo)).toContain(
        resolveDeepestExisting(worktreePath),
      );
      // ... and nothing is left on disk: the recursive delete ran, for
      // a path the gate had admitted, after git's own removal did not.
      expect(fs.existsSync(worktreePath)).toBe(false);
    } finally {
      restore();
      git(repo, [
        "worktree",
        "remove",
        "--force",
        "--force",
        "--",
        worktreePath,
      ]);
    }
  });

  it("reports ok:true with a detail naming the surviving admin entry when the gitdir-files fallback finds the target only in goneTargets: the removal is a clean success, but git worktree prune has not cleared its registration yet", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    addLockedWorktree(repo, worktreePath);
    const restoreRemove = await shimRemoveToFail();
    const shimDir = makeTmpDir();
    writeGitShim(shimDir, "no-worktree-list");

    try {
      const cleanup = await withPathPrepended(shimDir, () =>
        cleanupWorktree(repo, worktreePath, logDir, { scratchRoot: logDir }),
      );

      // The shimmed `remove` never really ran, and the real `prune`
      // (unshimmed: only `worktree list` is intercepted here) skips a
      // locked entry, so the admin entry survives; `git worktree list`
      // itself cannot run at all, so the outcome is asserted through
      // the gitdir-files fallback instead, which finds the entry's own
      // target gone (the recursive delete really ran) and reports it
      // in `goneTargets`, not `paths`: a clean, verified removal, but
      // with a detail naming the surviving entry rather than none at
      // all -- distinct from the `still reports it as a worktree`
      // case above, where the real listing itself could still run.
      expect(cleanup.ok).toBe(true);
      expect(cleanup.verified).toBe(true);
      expect(cleanup.detail).toContain("admin entry");
      expect(cleanup.detail).toContain("worktree prune");
      expect(fs.existsSync(worktreePath)).toBe(false);
    } finally {
      restoreRemove();
      git(repo, [
        "worktree",
        "remove",
        "--force",
        "--force",
        "--",
        worktreePath,
      ]);
    }
  });

  it("clears the registration of an add that died before writing the worktree's own .git file (locked, no HEAD, a directory git refuses to validate)", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    addLockedWorktree(repo, worktreePath);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [adminEntry] = fs.readdirSync(adminDir);
    fs.rmSync(path.join(adminDir, adminEntry, "HEAD"), { force: true });
    fs.rmSync(path.join(worktreePath, ".git"), { force: true });
    // git refuses this one outright, the state a kill in the first
    // milliseconds of an add leaves behind.
    const refused = spawnSync(
      "git",
      ["worktree", "remove", "--force", "--force", "--", worktreePath],
      { cwd: repo, encoding: "utf8" },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("validation failed");

    const cleanup = await cleanupWorktree(repo, worktreePath, logDir, {
      scratchRoot: logDir,
    });

    expect(cleanup.ok).toBe(true);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(adminDir) ? fs.readdirSync(adminDir) : []).toEqual([]);
  });

  it("clears the half-written entry of an add killed while its commondir was still empty, which makes every git worktree command in the repository fail", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    addLockedWorktree(repo, worktreePath);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [adminEntry] = fs.readdirSync(adminDir);
    // git creates `commondir` before it writes the content, so a kill
    // in between leaves it empty (never missing, which git tolerates).
    fs.writeFileSync(path.join(adminDir, adminEntry, "commondir"), "");
    fs.rmSync(path.join(adminDir, adminEntry, "HEAD"), { force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
    // git is stuck on this entry: even the listing dies on it.
    const listing = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(listing.status).not.toBe(0);
    expect(listing.stderr).toContain("commondir");

    const cleanup = await cleanupWorktree(repo, worktreePath, logDir, {
      scratchRoot: logDir,
    });

    expect(cleanup.ok).toBe(true);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
    expect(fs.existsSync(path.join(adminDir, adminEntry))).toBe(false);
  });

  it("clears the same half-written entry when its gitdir file is written relative to its own admin entry directory (worktree.useRelativePaths), matching the target through the same resolution the gitdir-files listing uses", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    addLockedWorktree(repo, worktreePath);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [adminEntry] = fs.readdirSync(adminDir);
    const entryDir = path.join(adminDir, adminEntry);
    const originalGitdir = fs
      .readFileSync(path.join(entryDir, "gitdir"), "utf8")
      .trim();
    fs.writeFileSync(
      path.join(entryDir, "gitdir"),
      `${path.relative(entryDir, originalGitdir)}\n`,
    );
    // git creates `commondir` before it writes the content, so a kill
    // in between leaves it empty (never missing, which git tolerates).
    fs.writeFileSync(path.join(entryDir, "commondir"), "");
    fs.rmSync(path.join(entryDir, "HEAD"), { force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
    // git is stuck on this entry: even the listing dies on it.
    const listing = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(listing.status).not.toBe(0);
    expect(listing.stderr).toContain("commondir");

    const cleanup = await cleanupWorktree(repo, worktreePath, logDir, {
      scratchRoot: logDir,
    });

    expect(cleanup.ok).toBe(true);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
    expect(fs.existsSync(entryDir)).toBe(false);
  });

  it("leaves a half-written entry that names some other path alone, and asserts its own removal through the gitdir-files fallback", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const other = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    addLockedWorktree(repo, other);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [adminEntry] = fs.readdirSync(adminDir);
    fs.writeFileSync(path.join(adminDir, adminEntry, "commondir"), "");
    const ours = scratchPath(logDir);
    fs.mkdirSync(ours, { recursive: true });

    const cleanup = await cleanupWorktree(repo, ours, logDir, {
      scratchRoot: logDir,
    });

    // git is stuck on the other entry (its own `commondir` is
    // corrupt), so `git worktree list` cannot run for this repository
    // at all; but the OTHER entry's `gitdir` file is intact (only its
    // `commondir` was zeroed), and `ours` was never registered by git
    // in the first place, so the gitdir-files fallback reads the admin
    // directory fine, finds `other` and nothing named `ours`, and the
    // removal is asserted rather than left unverified.
    expect(cleanup.ok).toBe(true);
    expect(cleanup.verified).toBe(true);
    expect(cleanup.refused).toBe(false);
    expect(cleanup.detail).toBeUndefined();
    expect(fs.existsSync(path.join(adminDir, adminEntry, "gitdir"))).toBe(true);
    expect(fs.existsSync(ours)).toBe(false);
  });

  it("deletes a scratch-shaped directory under the scratch root that git never registered (an add that died before registering)", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "half-written.txt"), "x\n");

    const cleanup = await cleanupWorktree(repo, worktreePath, logDir, {
      scratchRoot: logDir,
    });

    expect(cleanup.ok).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(registeredPaths(repo)).toHaveLength(1);
  });

  it("clears a registration whose directory was already deleted by hand", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const worktreePath = scratchPath(logDir);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
    fs.rmSync(worktreePath, { recursive: true, force: true });
    expect(registeredPaths(repo)).toHaveLength(2);

    const cleanup = await cleanupWorktree(repo, worktreePath, logDir, {
      scratchRoot: logDir,
    });

    expect(cleanup.ok).toBe(true);
    expect(registeredPaths(repo)).toHaveLength(1);
  });

  it("refuses a path outside the scratch shape: nothing is run against it and nothing is deleted", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const outside = path.join(makeTmpDir(), "somebody-elses-directory");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "precious.txt"), "keep me\n");

    const cleanup = await cleanupWorktree(repo, outside, logDir, {
      scratchRoot: logDir,
    });

    expect(cleanup.ok).toBe(false);
    expect(cleanup.refused).toBe(true);
    expect(cleanup.detail).toContain(outside);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    // Refused before any git call beyond the listing: no remove, no prune.
    expect(
      gitCalls().filter((c) => c[1][0] === "worktree" && c[1][1] !== "list"),
    ).toHaveLength(0);
  });

  it("refuses a scratch-shaped path that is neither registered nor under the scratch root, and one with no scratch root at all", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const elsewhere = scratchPath(makeTmpDir());
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "precious.txt"), "keep me\n");

    const wrongRoot = await cleanupWorktree(repo, elsewhere, logDir, {
      scratchRoot: logDir,
    });
    expect(wrongRoot.ok).toBe(false);
    expect(wrongRoot.refused).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, "precious.txt"))).toBe(true);

    const noRoot = await cleanupWorktree(repo, elsewhere, logDir);
    expect(noRoot.ok).toBe(false);
    expect(noRoot.refused).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, "precious.txt"))).toBe(true);
  });

  it("refuses the repository itself even when its own path is of the scratch shape", async () => {
    const outer = makeTmpDir();
    const repo = path.join(outer, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    const logDir = makeTmpDir();

    const cleanup = await cleanupWorktree(repo, repo, logDir, {
      scratchRoot: outer,
    });

    expect(cleanup.ok).toBe(false);
    expect(cleanup.refused).toBe(true);
    expect(cleanup.detail).toContain("the repository itself");
    expect(fs.existsSync(path.join(repo, "fixture.js"))).toBe(true);
  });

  it("refuses an operator's own registered worktree (not the scratch shape): it stays registered and intact", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const own = path.join(makeTmpDir(), "feature-branch");
    git(repo, ["worktree", "add", "--detach", "--", own, "HEAD"]);
    fs.writeFileSync(path.join(own, "work-in-progress.txt"), "uncommitted\n");

    const cleanup = await cleanupWorktree(repo, own, logDir, {
      scratchRoot: path.dirname(own),
    });

    expect(cleanup.ok).toBe(false);
    expect(cleanup.refused).toBe(true);
    expect(registeredPaths(repo)).toContain(resolveDeepestExisting(own));
    expect(
      fs.readFileSync(path.join(own, "work-in-progress.txt"), "utf8"),
    ).toBe("uncommitted\n");
  });
});

describe("rejectsOption", () => {
  it("is true on the usage-error status alone, with nothing on stderr", () => {
    expect(rejectsOption({ exitCode: 129, stderr: "" })).toBe(true);
  });

  it("is true on the unknown-switch or unknown-option text alone, whatever the non-zero status", () => {
    expect(
      rejectsOption({ exitCode: 128, stderr: "error: unknown switch `z'\n" }),
    ).toBe(true);
    expect(
      rejectsOption({
        exitCode: 1,
        stderr: "error: unknown option `porcelain'\n",
      }),
    ).toBe(true);
  });

  it("is false for a failure that names no option, for a call that never exited, and for one that succeeded", () => {
    expect(
      rejectsOption({
        exitCode: 128,
        stderr: "fatal: not a git repository\n",
      }),
    ).toBe(false);
    expect(rejectsOption({ exitCode: 1, stderr: "" })).toBe(false);
    expect(rejectsOption({ exitCode: null, stderr: "" })).toBe(false);
    expect(
      rejectsOption({ exitCode: 0, stderr: "error: unknown switch `z'\n" }),
    ).toBe(false);
  });
});

describe("listRegisteredWorktrees and cleanupWorktree on a git that rejects -z, and on one whose listing cannot run", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  function initRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return repo;
  }

  function scratchPath(logDir: string): string {
    return path.join(logDir, `wt-${randomUUID()}`, "wt");
  }

  /** The registry as the real git (never the shim) reports it. */
  function registeredPaths(repo: string): string[] {
    return parseWorktreeListZ(
      git(repo, ["worktree", "list", "--porcelain", "-z"]),
    ).map(resolveDeepestExisting);
  }

  function addScratchWorktree(repo: string, worktreePath: string): void {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", worktreePath, "HEAD"]);
  }

  function shimDir(mode: GitShimMode): string {
    const dir = makeTmpDir();
    writeGitShim(dir, mode);
    return dir;
  }

  /** The `git worktree list` calls made so far, in order. */
  function listCalls(): Parameters<typeof runArgv>[] {
    return gitCalls().filter(
      (c) => c[1][0] === "worktree" && c[1][1] === "list",
    );
  }

  it("lists through the fallback when git rejects -z with the usage-error status alone, nothing on stderr", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = scratchPath(logDir);
    addScratchWorktree(repo, wt);

    const listed = await withPathPrepended(shimDir("reject-z-silent"), () =>
      listRegisteredWorktrees(repo, logDir),
    );

    expect(listed.ok).toBe(true);
    expect(listed.form).toBe("newline");
    expect(listed.paths).toEqual([
      resolveDeepestExisting(repo),
      resolveDeepestExisting(wt),
    ]);
    expect(listed.logPaths).toHaveLength(2);
    expect(fs.readFileSync(listed.logPaths[0], "utf8")).not.toContain(
      "unknown switch",
    );
    expect(listCalls()).toHaveLength(2);
  });

  it("does not retry as the newline-separated form when the -z listing dies with a fatal message and any other status, but still falls back to the gitdir-files third source", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = scratchPath(logDir);
    addScratchWorktree(repo, wt);

    const listed = await withPathPrepended(shimDir("fail-z"), () =>
      listRegisteredWorktrees(repo, logDir),
    );

    // The newline-separated `worktree list` form is never tried (a
    // failure of git's own, not an option rejection, is never one to
    // retry with different args): exactly one `worktree list` call.
    expect(listCalls()).toHaveLength(1);
    // But the gitdir-files fallback, which needs no `worktree list`
    // call at all, still runs and succeeds: linked worktrees only, so
    // the main worktree is absent from `paths`.
    expect(listed.ok).toBe(true);
    expect(listed.form).toBe("gitdir-files");
    expect(listed.paths).toEqual([resolveDeepestExisting(wt)]);
    expect(listed.detail).toBeUndefined();
    expect(listed.goneTargets).toBeUndefined();
  });

  it("lists through the newline-separated --porcelain fallback when git rejects -z, reporting the paths the -z form reports", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = scratchPath(logDir);
    addScratchWorktree(repo, wt);

    const listed = await withPathPrepended(shimDir("reject-z"), () =>
      listRegisteredWorktrees(repo, logDir),
    );

    expect(listed.ok).toBe(true);
    expect(listed.form).toBe("newline");
    expect(listed.paths).toEqual(registeredPaths(repo));
    expect(listed.paths).toEqual([
      resolveDeepestExisting(repo),
      resolveDeepestExisting(wt),
    ]);
    // The -z form really ran first and was rejected: its log says so.
    expect(listed.logPaths).toHaveLength(2);
    expect(fs.readFileSync(listed.logPaths[0], "utf8")).toContain(
      "unknown switch",
    );
  });

  it("falls back to the gitdir-files third source, rather than reporting an unknown registry, when no listing form runs but a linked worktree's admin entry is still on disk", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = scratchPath(logDir);
    addScratchWorktree(repo, wt);

    const listed = await withPathPrepended(shimDir("no-worktree-list"), () =>
      listRegisteredWorktrees(repo, logDir),
    );

    expect(listed.ok).toBe(true);
    expect(listed.form).toBe("gitdir-files");
    expect(listed.paths).toEqual([resolveDeepestExisting(wt)]);
    expect(listed.detail).toBeUndefined();
  });

  it("reports an unknown registry (ok false, the reason, no paths) when no listing form runs and the repository has no linked worktree at all, never an empty one", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();

    const listed = await withPathPrepended(shimDir("no-worktree-list"), () =>
      listRegisteredWorktrees(repo, logDir),
    );

    // No `git worktree add` was ever run against this repository, so
    // it has no `worktrees/` admin directory at all for the
    // gitdir-files fallback to read either: the registry stays
    // genuinely unknown.
    expect(listed.ok).toBe(false);
    expect(listed.paths).toEqual([]);
    expect(listed.form).toBeUndefined();
    expect(listed.detail).toContain("exited 128");
  });

  it("resolves a gitdir file rewritten relative to its own admin entry directory, the form `worktree.useRelativePaths` (git >= 2.48) writes, never against process.cwd()", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const good = scratchPath(logDir);
    addScratchWorktree(repo, good);
    const adminDir = path.join(repo, ".git", "worktrees");
    const [entryId] = fs.readdirSync(adminDir);
    expect(entryId).toBeDefined();
    const entryDir = path.join(adminDir, entryId);
    const originalGitdir = fs
      .readFileSync(path.join(entryDir, "gitdir"), "utf8")
      .trim();
    expect(path.isAbsolute(originalGitdir)).toBe(true);
    // The form git writes under `worktree.useRelativePaths`: relative
    // to the admin entry's OWN directory (verified against a real git
    // in the next test), never against the calling process's `cwd`,
    // which at this point (wherever the test runner started) is
    // nowhere near `entryDir` or `good` -- a resolution against
    // `process.cwd()` instead would land far from `good` and fail the
    // assertions below.
    const relativeGitdir = path.relative(entryDir, originalGitdir);
    fs.writeFileSync(path.join(entryDir, "gitdir"), `${relativeGitdir}\n`);

    const listed = await withPathPrepended(shimDir("no-worktree-list"), () =>
      listRegisteredWorktrees(repo, logDir),
    );

    expect(listed.ok).toBe(true);
    expect(listed.form).toBe("gitdir-files");
    expect(listed.paths).toEqual([resolveDeepestExisting(good)]);
    expect(listed.goneTargets).toBeUndefined();
    expect(listed.detail).toBeUndefined();
  });

  it.skipIf(!gitSupportsRelativePaths())(
    "resolves a gitdir file a real `git worktree add --relative-paths` wrote, on a git that supports it",
    async () => {
      const repo = initRepo();
      const logDir = makeTmpDir();
      const good = scratchPath(logDir);
      fs.mkdirSync(path.dirname(good), { recursive: true });
      git(repo, [
        "worktree",
        "add",
        "--relative-paths",
        "--detach",
        "--",
        good,
        "HEAD",
      ]);
      const adminDir = path.join(repo, ".git", "worktrees");
      const [entryId] = fs.readdirSync(adminDir);
      const raw = fs.readFileSync(
        path.join(adminDir, entryId, "gitdir"),
        "utf8",
      );
      // Confirms the fixture really exercises the relative form, not
      // an absolute path this git wrote anyway.
      expect(path.isAbsolute(raw.trim())).toBe(false);

      const listed = await withPathPrepended(shimDir("no-worktree-list"), () =>
        listRegisteredWorktrees(repo, logDir),
      );

      expect(listed.ok).toBe(true);
      expect(listed.form).toBe("gitdir-files");
      expect(listed.paths).toEqual([resolveDeepestExisting(good)]);
    },
  );

  it.skipIf(isRoot)(
    "reports the gitdir-files listing as not ok, naming every admin entry it could not read by id and reason, rather than silently dropping them from an otherwise ok result",
    async () => {
      const repo = initRepo();
      const logDir = makeTmpDir();
      const good = scratchPath(logDir);
      addScratchWorktree(repo, good);
      const adminDir = path.join(repo, ".git", "worktrees");
      const [goodEntry] = fs.readdirSync(adminDir);
      expect(goodEntry).toBeDefined();

      const missingId = "bogus-missing";
      fs.mkdirSync(path.join(adminDir, missingId), { recursive: true });
      // No gitdir file at all in this one.

      const emptyId = "bogus-empty";
      fs.mkdirSync(path.join(adminDir, emptyId), { recursive: true });
      fs.writeFileSync(path.join(adminDir, emptyId, "gitdir"), "");

      const unreadableId = "bogus-unreadable";
      fs.mkdirSync(path.join(adminDir, unreadableId), { recursive: true });
      const unreadableGitdir = path.join(adminDir, unreadableId, "gitdir");
      fs.writeFileSync(unreadableGitdir, "/some/fake/.git\n");
      fs.chmodSync(unreadableGitdir, 0o000);

      try {
        const listed = await withPathPrepended(
          shimDir("no-worktree-list"),
          () => listRegisteredWorktrees(repo, logDir),
        );

        // Not ok: this source cannot vouch that `good` is really the
        // ONLY registered worktree when three other entries could not
        // be read at all -- a caller must not trust an empty-looking
        // `paths` here the way it would trust a fully known one.
        expect(listed.ok).toBe(false);
        expect(listed.form).toBe("gitdir-files");
        expect(listed.paths).toEqual([]);
        expect(listed.goneTargets).toBeUndefined();
        for (const id of [missingId, emptyId, unreadableId]) {
          expect(listed.detail).toContain(id);
        }
        expect(listed.detail).toContain("gitdir file is empty");
        expect(listed.detail).toContain("could not be read");
      } finally {
        fs.chmodSync(unreadableGitdir, 0o644);
      }
    },
  );

  it.skipIf(isRoot)(
    "cleanupWorktree reports the removal as ok but unverified, naming the unreadable admin entry, when the gitdir-files fallback cannot read every entry after the removal",
    async () => {
      const repo = initRepo();
      const logDir = makeTmpDir();
      const wt = scratchPath(logDir);
      addScratchWorktree(repo, wt);
      const adminDir = path.join(repo, ".git", "worktrees");
      // A second, unrelated admin entry with an unreadable gitdir
      // file, LOCKED so `git worktree prune` (which cleanupWorktree
      // itself runs, for real, as part of its own removal) leaves it
      // alone: without the lock, prune clears a broken, unlocked
      // entry eagerly on its own -- even one it cannot itself read --
      // before the gitdir-files fallback ever gets a chance to see it.
      const otherId = "bogus-unreadable";
      const otherDir = path.join(adminDir, otherId);
      fs.mkdirSync(otherDir, { recursive: true });
      const otherGitdir = path.join(otherDir, "gitdir");
      fs.writeFileSync(otherGitdir, "/some/fake/.git\n");
      fs.chmodSync(otherGitdir, 0o000);
      fs.writeFileSync(path.join(otherDir, "locked"), "bogus");

      try {
        const cleanup = await withPathPrepended(
          shimDir("no-worktree-list"),
          () => cleanupWorktree(repo, wt, logDir, { scratchRoot: logDir }),
        );

        expect(cleanup.ok).toBe(true);
        expect(cleanup.verified).toBe(false);
        expect(cleanup.detail).toContain("could not run after the removal");
        expect(cleanup.detail).toContain(otherId);
        expect(cleanup.detail).toContain("could not be read as a gitdir file");
        expect(fs.existsSync(wt)).toBe(false);
      } finally {
        fs.chmodSync(otherGitdir, 0o644);
      }
    },
  );

  it("keeps an admin entry whose target no longer exists apart from paths, in goneTargets, so cleanupWorktree never reads it as still registered", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const present = scratchPath(logDir);
    addScratchWorktree(repo, present);
    const goneParent = makeTmpDir();
    const gone = scratchPath(goneParent);
    addScratchWorktree(repo, gone);
    const goneResolved = resolveDeepestExisting(gone);
    // The target directory is removed by hand, never through git, so
    // its admin entry is left dangling exactly the way one would be
    // between `git worktree remove` unregistering a locked entry only
    // partway and a `prune` that has not run yet.
    fs.rmSync(gone, { recursive: true, force: true });

    const listed = await withPathPrepended(shimDir("no-worktree-list"), () =>
      listRegisteredWorktrees(repo, logDir),
    );

    expect(listed.ok).toBe(true);
    expect(listed.form).toBe("gitdir-files");
    expect(listed.paths).toEqual([resolveDeepestExisting(present)]);
    expect(listed.paths).not.toContain(goneResolved);
    expect(listed.goneTargets).toEqual([goneResolved]);
    expect(listed.detail).toContain(goneResolved);
    expect(listed.detail).toContain("no longer exists on disk");

    // `gone` sits outside this run's own log dir, so cleanupWorktree's
    // gate can only admit it on the "registered" clause; the
    // gone-target entry must not read as that, so it is refused, and
    // refused for "not registered", never for "still registered".
    const cleanup = await withPathPrepended(shimDir("no-worktree-list"), () =>
      cleanupWorktree(repo, gone, logDir, { scratchRoot: logDir }),
    );
    expect(cleanup.refused).toBe(true);
    expect(cleanup.detail).toContain(
      "git does not report it as a worktree of this repository",
    );
    expect(cleanup.detail).not.toContain("still reports it as a worktree");
  });

  it("cleanupWorktree asserts the removal through the fallback listing on a git that rejects -z: ok, verified, nothing registered afterwards", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = scratchPath(logDir);
    addScratchWorktree(repo, wt);

    const cleanup = await withPathPrepended(shimDir("reject-z"), () =>
      cleanupWorktree(repo, wt, logDir, { scratchRoot: logDir }),
    );

    expect(cleanup.ok).toBe(true);
    expect(cleanup.verified).toBe(true);
    expect(cleanup.detail).toBeUndefined();
    expect(fs.existsSync(wt)).toBe(false);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
  });

  it("cleanupWorktree reports a removal that took as ok but unverified, naming the listing failure, when no listing form runs; the registration is really gone", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = scratchPath(logDir);
    addScratchWorktree(repo, wt);

    const cleanup = await withPathPrepended(shimDir("no-worktree-list"), () =>
      cleanupWorktree(repo, wt, logDir, { scratchRoot: logDir }),
    );

    expect(cleanup.ok).toBe(true);
    expect(cleanup.verified).toBe(false);
    expect(cleanup.detail).toContain("could not run after the removal");
    expect(cleanup.detail).toContain("unverified");
    expect(cleanup.detail).toContain(
      "the directory is gone; the registration could not be checked",
    );
    expect(cleanup.detail).not.toContain("git worktree remove exited");
    expect(fs.existsSync(wt)).toBe(false);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
  });

  it("cleanupWorktree judges a scratch directory git never registered by the disk alone when no listing form runs: ok, unverified, the directory gone, whatever git worktree remove exited", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = scratchPath(logDir);
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, "stale.txt"), "leftover\n");

    const cleanup = await withPathPrepended(shimDir("no-worktree-list"), () =>
      cleanupWorktree(repo, wt, logDir, { scratchRoot: logDir }),
    );

    expect(cleanup.ok).toBe(true);
    expect(cleanup.verified).toBe(false);
    expect(cleanup.refused).toBe(false);
    expect(cleanup.detail).toContain(
      "the directory is gone; the registration could not be checked",
    );
    expect(fs.existsSync(wt)).toBe(false);
    // The removal really ran against a path git never registered and
    // failed as git fails it; the disk check is what decided.
    const removeLog = cleanup.logPaths.find((p) =>
      path.basename(p).startsWith("worktree-remove-"),
    );
    expect(removeLog).toBeDefined();
    expect(fs.readFileSync(removeLog as string, "utf8")).toContain("fatal:");
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
  });

  it("cleanupWorktree removes a registered scratch worktree outside the current log dir, found through the gitdir-files fallback, even though git worktree list itself cannot run", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const elsewhere = scratchPath(makeTmpDir());
    addScratchWorktree(repo, elsewhere);
    fs.writeFileSync(path.join(elsewhere, "precious.txt"), "keep me\n");

    const cleanup = await withPathPrepended(shimDir("no-worktree-list"), () =>
      cleanupWorktree(repo, elsewhere, logDir, { scratchRoot: logDir }),
    );

    // The gate admits `elsewhere` on the "registered" clause, not the
    // "contained in scratchRoot" one: the gitdir-files fallback finds
    // its admin entry before the removal, so the path is eligible
    // whether or not it sits under this run's `--log-dir`.
    expect(cleanup.refused).toBe(false);
    expect(cleanup.ok).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(false);
    // Once `elsewhere` is removed, the repository has no linked
    // worktree left at all, so the admin directory itself disappears
    // and the post-removal listing has nothing to read even through
    // the fallback: the removal is reported as done but unverified,
    // exactly like a repository whose registry could never be checked.
    expect(cleanup.verified).toBe(false);
    expect(cleanup.detail).toContain("could not run after the removal");
    expect(registeredPaths(repo)).not.toContain(
      resolveDeepestExisting(elsewhere),
    );
  });

  it("cleanupWorktree refuses a scratch-shaped worktree outside the current log dir that was never registered and whose repository has no admin directory for the gitdir-files fallback to read: nothing is deleted", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const elsewhere = scratchPath(makeTmpDir());
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "precious.txt"), "keep me\n");

    const cleanup = await withPathPrepended(shimDir("no-worktree-list"), () =>
      cleanupWorktree(repo, elsewhere, logDir, { scratchRoot: logDir }),
    );

    expect(cleanup.ok).toBe(false);
    expect(cleanup.refused).toBe(true);
    expect(cleanup.detail).toContain("registration could not be checked");
    expect(cleanup.detail).toContain("not under this run's log dir");
    expect(fs.readFileSync(path.join(elsewhere, "precious.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(fs.existsSync(elsewhere)).toBe(true);
  });
});

describe("the scratch owner record", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  function initRepo(): string {
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    return repo;
  }

  function registeredPaths(repo: string): string[] {
    return parseWorktreeListZ(
      git(repo, ["worktree", "list", "--porcelain", "-z"]),
    ).map(resolveDeepestExisting);
  }

  it("beginWorktree writes owner.json next to wt with this process's pid and the resolved log dir, before the add runs", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    let ownerAtAttempt: ReturnType<typeof readScratchOwner>;

    const result = await beginWorktree({
      root: repo,
      cwd: repo,
      logDir,
      links: [],
      onWorktreeAttempt: (worktreePath) => {
        ownerAtAttempt = readScratchOwner(worktreePath);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ownerAtAttempt?.pid).toBe(process.pid);
    const owner = readScratchOwner(result.worktreePath);
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.logDir).toBe(path.resolve(logDir));
    expect(
      fs.existsSync(
        path.join(path.dirname(result.worktreePath), SCRATCH_OWNER_FILE),
      ),
    ).toBe(true);
    // This process's own record never blocks its own cleanup.
    const cleanup = await cleanupWorktree(repo, result.worktreePath, logDir, {
      scratchRoot: logDir,
    });
    expect(cleanup.ok).toBe(true);
  });

  it("cleanupWorktree refuses a scratch worktree whose owner record names another live process, and admits it once that process is gone", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = path.join(logDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", wt, "HEAD"]);
    const sleeper = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        stdio: "ignore",
      },
    );
    const exited = new Promise<void>((resolve) => {
      sleeper.once("exit", () => resolve());
    });
    try {
      fs.writeFileSync(
        path.join(path.dirname(wt), SCRATCH_OWNER_FILE),
        JSON.stringify({
          pid: sleeper.pid,
          timestamp: new Date().toISOString(),
          logDir,
        }),
      );

      const refused = await cleanupWorktree(repo, wt, logDir, {
        scratchRoot: logDir,
      });

      expect(refused.ok).toBe(false);
      expect(refused.refused).toBe(true);
      expect(refused.detail).toContain(
        `a live probe (pid ${String(sleeper.pid)}) owns it`,
      );
      expect(fs.existsSync(wt)).toBe(true);
      expect(registeredPaths(repo)).toContain(resolveDeepestExisting(wt));
      // Refused before any git call beyond the listing: no remove, no prune.
      expect(
        gitCalls().filter((c) => c[1][0] === "worktree" && c[1][1] !== "list"),
      ).toHaveLength(0);
    } finally {
      sleeper.kill("SIGKILL");
    }
    await exited;

    const admitted = await cleanupWorktree(repo, wt, logDir, {
      scratchRoot: logDir,
    });

    expect(admitted.ok).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
  });

  const FAR_PAST = "2020-01-01T00:00:00.000Z";

  /** A pid that is alive from any user's point of view: pid 1 always
   * exists, and `isPidAlive` reads the EPERM a non-root user gets from
   * signalling it as alive. */
  const ALIVE_PID = 1;

  function writeOwner(
    wt: string,
    owner: { pid: number; timestamp: string },
  ): void {
    fs.writeFileSync(
      path.join(path.dirname(wt), SCRATCH_OWNER_FILE),
      JSON.stringify({ ...owner, logDir: path.dirname(path.dirname(wt)) }),
    );
  }

  it("scratchOwnerState tells none, self, dead, expired, and live apart, and liveForeignOwner answers only for live", () => {
    const wt = path.join(makeTmpDir(), `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const fresh = new Date().toISOString();
    expect(scratchOwnerState(wt)).toBe("none");
    expect(liveForeignOwner(wt)).toBeUndefined();

    writeOwner(wt, { pid: process.pid, timestamp: fresh });
    expect(scratchOwnerState(wt)).toBe("self");
    expect(liveForeignOwner(wt)).toBeUndefined();

    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeOwner(wt, { pid: dead, timestamp: fresh });
    expect(scratchOwnerState(wt)).toBe("dead");
    expect(liveForeignOwner(wt)).toBeUndefined();

    writeOwner(wt, { pid: ALIVE_PID, timestamp: fresh });
    expect(scratchOwnerState(wt)).toBe("live");
    expect(liveForeignOwner(wt)).toBe(ALIVE_PID);

    // Past the bound, an alive pid no longer vouches for the worktree.
    writeOwner(wt, { pid: ALIVE_PID, timestamp: FAR_PAST });
    expect(scratchOwnerState(wt)).toBe("expired");
    expect(liveForeignOwner(wt)).toBeUndefined();
    // Just inside the bound still does; just outside no longer does.
    const boundMs = SCRATCH_OWNER_MAX_AGE_HOURS * 60 * 60 * 1000;
    const marginMs = 60_000;
    writeOwner(wt, {
      pid: ALIVE_PID,
      timestamp: new Date(Date.now() - boundMs + marginMs).toISOString(),
    });
    expect(scratchOwnerState(wt)).toBe("live");
    writeOwner(wt, {
      pid: ALIVE_PID,
      timestamp: new Date(Date.now() - boundMs - marginMs).toISOString(),
    });
    expect(scratchOwnerState(wt)).toBe("expired");
    // A record dated past the bound into the future, and one whose
    // timestamp does not parse, count as expired too.
    writeOwner(wt, {
      pid: ALIVE_PID,
      timestamp: new Date(Date.now() + boundMs + marginMs).toISOString(),
    });
    expect(scratchOwnerState(wt)).toBe("expired");
    writeOwner(wt, { pid: ALIVE_PID, timestamp: "not a timestamp" });
    expect(scratchOwnerState(wt)).toBe("expired");
  });

  it("cleanupWorktree refuses a scratch worktree under a fresh record naming an alive pid, and admits the same worktree once the record is past the bound", async () => {
    const repo = initRepo();
    const logDir = makeTmpDir();
    const wt = path.join(logDir, `wt-${randomUUID()}`, "wt");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repo, ["worktree", "add", "--detach", "--", wt, "HEAD"]);

    writeOwner(wt, { pid: ALIVE_PID, timestamp: new Date().toISOString() });
    const refused = await cleanupWorktree(repo, wt, logDir, {
      scratchRoot: logDir,
    });

    expect(refused.ok).toBe(false);
    expect(refused.refused).toBe(true);
    expect(refused.detail).toContain(
      `a live probe (pid ${String(ALIVE_PID)}) owns it`,
    );
    expect(fs.existsSync(wt)).toBe(true);

    writeOwner(wt, { pid: ALIVE_PID, timestamp: FAR_PAST });
    const admitted = await cleanupWorktree(repo, wt, logDir, {
      scratchRoot: logDir,
    });

    expect(admitted.ok).toBe(true);
    expect(admitted.verified).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(registeredPaths(repo)).toEqual([resolveDeepestExisting(repo)]);
  });
});
