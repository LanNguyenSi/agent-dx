import { execFileSync, spawnSync } from "node:child_process";
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
  parseWorktreeListZ,
} from "../src/probe/isolation.js";
import { resolveDeepestExisting } from "../src/probe/containment.js";
import { runArgv } from "../src/probe/run.js";

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
