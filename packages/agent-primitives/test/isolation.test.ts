import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  beginInplace,
  beginWorktree,
  cleanupWorktree,
  countNumstatFiles,
  findNodeModulesDirs,
} from "../src/probe/isolation.js";

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

    const cleanup = await cleanupWorktree(repo, result.worktreePath, logDir);
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
    // `--link` extras are contained (per T-002): a real one lives inside
    // the repository, just under a name `findNodeModulesDirs` would
    // never pick up on its own.
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
});
