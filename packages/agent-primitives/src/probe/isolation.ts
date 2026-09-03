import fs from "node:fs";
import path from "node:path";
import { execCommand } from "../exec.js";

export interface InplaceSession {
  backupPath: string;
  targetPath: string;
  /**
   * Restores `targetPath` from the backup made at `beginInplace` time.
   * Synchronous and exception-safe (returns `false` instead of
   * throwing) so it can run from a signal handler as well as from the
   * normal async control flow. This is the single mutation-probed
   * function for the whole restore guarantee: a no-op here must fail
   * both the SIGTERM test and every post-run hash assertion.
   */
  restore(): boolean;
}

/** Test seam: lets a test inject an `open` that makes the backup name
 * appear on disk exactly in the window between choosing that name and
 * opening it, which is the race the `O_EXCL` create below exists to
 * close and which cannot be produced reliably from outside. Defaults to
 * the genuine `fs.openSync`. */
export interface InplaceDeps {
  open?: (filePath: string, flags: string) => number;
}

/**
 * Begins an `inplace` probe session: copies the target file to a backup
 * path under `logDir` before anything mutates it. The backup name
 * includes the original basename (for a human skimming the log dir) and
 * a counter to stay unique across repeated calls with the same target
 * inside one log dir (e.g. the stale-marker recovery path re-uses the
 * same log dir as the probe that recovers it). The name itself is
 * claimed atomically via an `O_EXCL` create (`wx`): a check-then-copy
 * (`existsSync` then `copyFileSync`) would leave a window for two
 * concurrent sessions in the same log dir to both observe a name as free
 * and both write to it, silently clobbering one session's backup with
 * the other's. The atomicity is the create's own, not a check before it:
 * an `EEXIST` here means somebody else won the name, whether they took
 * it an hour ago or between this line and the previous one.
 */
export function beginInplace(
  targetPath: string,
  logDir: string,
  deps: InplaceDeps = {},
): InplaceSession {
  const open = deps.open ?? fs.openSync;
  fs.mkdirSync(logDir, { recursive: true });
  const base = path.basename(targetPath);
  let backupPath = path.join(logDir, `backup-${base}`);
  let n = 0;
  let fd: number;
  for (;;) {
    try {
      fd = open(backupPath, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      n += 1;
      backupPath = path.join(logDir, `backup-${n}-${base}`);
    }
  }
  const data = fs.readFileSync(targetPath);
  fs.writeSync(fd, data);
  fs.closeSync(fd);
  return {
    backupPath,
    targetPath,
    restore(): boolean {
      try {
        fs.copyFileSync(backupPath, targetPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** How many path segments below `root` a `node_modules` directory may sit
 * at and still be linked (`root/node_modules` is depth 1,
 * `root/a/b/node_modules` is depth 3). This is the single mutation-probed
 * constant for the whole depth cutoff: raising it must make a
 * previously-excluded deeper `node_modules` start showing up in `linked`. */
const NODE_MODULES_LINK_DEPTH = 3;

/**
 * Every `node_modules` directory under `root`, at or above
 * `NODE_MODULES_LINK_DEPTH` segments deep, none of them nested inside
 * another `node_modules` this walk already found (a `node_modules` entry
 * is never itself recursed into). Symlinks are not followed (`Dirent`
 * from `readdirSync` reports the entry's own type, not its target's), so
 * a symlinked directory can neither hide a `node_modules` nor create a
 * cycle. `.git` is skipped outright: descending into it would walk a
 * large, irrelevant tree for no directory this function could ever want.
 * The walk itself goes one level past the cutoff (never further), which
 * is exactly enough to prove a directory at the next depth is excluded
 * rather than simply unvisited.
 */
export function findNodeModulesDirs(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > NODE_MODULES_LINK_DEPTH + 1) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git") continue;
      const childPath = path.join(dir, entry.name);
      const childDepth = depth + 1;
      if (entry.name === "node_modules") {
        if (childDepth <= NODE_MODULES_LINK_DEPTH) found.push(childPath);
        continue;
      }
      walk(childPath, childDepth);
    }
  }
  walk(root, 0);
  return found;
}

/** Number of `diff --git ` headers in a `git diff --binary` output: the
 * file count for `syncedTrackedFiles`, `0` for an empty (clean-tree)
 * diff. */
export function countDiffFiles(diffText: string): number {
  const matches = diffText.match(/^diff --git /gm);
  return matches ? matches.length : 0;
}

export interface WorktreeSyncSuccess {
  ok: true;
  worktreePath: string;
  /** `cwd` re-based onto the worktree, at the same relative offset from
   * `root` that `cwd` itself has. */
  mappedCwd: string;
  /** Absolute source-tree paths of every directory symlinked into the
   * worktree (linked `node_modules` directories plus `--link` extras). */
  linked: string[];
  syncedTrackedFiles: number;
  syncedUntrackedFiles: number;
  logPaths: string[];
}

export interface WorktreeSyncFailure {
  ok: false;
  reason: "worktree_sync_failed";
  detail: string;
  logPaths: string[];
  /** Set once `git worktree add` itself succeeded, so a failure in a
   * later sync step still leaves the caller able to register (and clean
   * up) the worktree directory that already exists on disk. */
  worktreePath?: string;
}

export type BeginWorktreeResult = WorktreeSyncSuccess | WorktreeSyncFailure;

export interface BeginWorktreeOptions {
  /** The repository root (display path, not necessarily a realpath). */
  root: string;
  /** The invocation cwd; must be `root` or a descendant of it. */
  cwd: string;
  /** Scratch space: the worktree is created at `<logDir>/wt`, and
   * `<logDir>/tracked.diff` carries the tracked-diff sync file. */
  logDir: string;
  /** Absolute, already-contained extra directories to symlink into the
   * worktree in addition to the `node_modules` directories this
   * function finds on its own. */
  links: string[];
}

/**
 * Begins a `worktree` probe session: `git worktree add --detach` at
 * `<logDir>/wt`, then syncs the current working tree's state into it so
 * the worktree is a faithful copy of what the operator sees, not just
 * `HEAD`. Tracked modifications are synced via two separately observable
 * exec calls (`git diff HEAD --binary` written to `<logDir>/tracked.diff`,
 * then `git apply --allow-empty` against that file in the worktree, run
 * unconditionally so an empty diff still exercises `--allow-empty`
 * rather than being skipped); untracked, non-ignored files are copied by
 * relative path; every `node_modules` directory up to
 * `NODE_MODULES_LINK_DEPTH` plus every `--link` extra is symlinked. Any
 * non-zero exit or filesystem failure along the way is
 * `worktree_sync_failed`; the caller (`probe/index.ts`) never treats a
 * sync failure as a verdict.
 */
export async function beginWorktree(
  opts: BeginWorktreeOptions,
): Promise<BeginWorktreeResult> {
  const { root, cwd, logDir, links } = opts;
  fs.mkdirSync(logDir, { recursive: true });
  const worktreePath = path.join(logDir, "wt");
  const logPaths: string[] = [];

  const addResult = await execCommand(
    `git worktree add --detach -- ${JSON.stringify(worktreePath)} HEAD`,
    { cwd: root, logDir, timeoutMs: 30_000 },
  );
  logPaths.push(addResult.logPath);
  if (addResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git worktree add failed; see ${addResult.logPath}`,
      logPaths,
    };
  }

  const diffPath = path.join(logDir, "tracked.diff");
  const diffResult = await execCommand("git diff HEAD --binary", {
    cwd: root,
    logDir,
    logFileName: "tracked.diff",
    timeoutMs: 30_000,
  });
  logPaths.push(diffResult.logPath);
  if (diffResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git diff HEAD --binary failed; see ${diffResult.logPath}`,
      logPaths,
      worktreePath,
    };
  }
  let diffText = "";
  try {
    diffText = fs.readFileSync(diffPath, "utf8");
  } catch {
    diffText = "";
  }
  const syncedTrackedFiles = countDiffFiles(diffText);

  // Run unconditionally, even against an empty `tracked.diff`: that is
  // exactly the case `--allow-empty` exists for (a bare `git apply`
  // exits 128 on empty input), and the clean-tree path has to exercise
  // the same exec call as every other tree state.
  const applyResult = await execCommand(
    `git -C ${JSON.stringify(worktreePath)} apply --allow-empty -- ${JSON.stringify(diffPath)}`,
    { cwd: root, logDir, timeoutMs: 30_000 },
  );
  logPaths.push(applyResult.logPath);
  if (applyResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git apply --allow-empty failed against the worktree; see ${applyResult.logPath}`,
      logPaths,
      worktreePath,
    };
  }

  const untrackedResult = await execCommand(
    "git ls-files --others --exclude-standard -z",
    {
      cwd: root,
      logDir,
      logFileName: "untracked-files.log",
      timeoutMs: 30_000,
    },
  );
  logPaths.push(untrackedResult.logPath);
  if (untrackedResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git ls-files --others --exclude-standard failed; see ${untrackedResult.logPath}`,
      logPaths,
      worktreePath,
    };
  }
  let untrackedRaw = "";
  try {
    untrackedRaw = fs.readFileSync(untrackedResult.logPath, "utf8");
  } catch {
    untrackedRaw = "";
  }
  const untrackedRelPaths = untrackedRaw
    .split("\0")
    .filter((p) => p.length > 0);
  try {
    for (const relPath of untrackedRelPaths) {
      const src = path.join(root, relPath);
      const dest = path.join(worktreePath, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `copying an untracked file into the worktree failed: ${message}`,
      logPaths,
      worktreePath,
    };
  }

  const nodeModulesDirs = findNodeModulesDirs(root);
  const linked: string[] = [];
  try {
    for (const absDir of [...nodeModulesDirs, ...links]) {
      const relPath = path.relative(root, absDir);
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) continue;
      const dest = path.join(worktreePath, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // A sync step above (or the checkout itself) may already have
      // created something at this path; clear it first so the symlink
      // create is never blocked by EEXIST.
      fs.rmSync(dest, { recursive: true, force: true });
      fs.symlinkSync(absDir, dest, "dir");
      linked.push(absDir);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `linking a directory into the worktree failed: ${message}`,
      logPaths,
      worktreePath,
    };
  }

  const mappedCwd = path.join(worktreePath, path.relative(root, cwd));

  return {
    ok: true,
    worktreePath,
    mappedCwd,
    linked,
    syncedTrackedFiles,
    syncedUntrackedFiles: untrackedRelPaths.length,
    logPaths,
  };
}

/**
 * Removes a worktree via `git worktree remove --force` followed by `git
 * worktree prune`, both run unconditionally (prune also clears any
 * administrative state a partial or already-gone worktree left behind).
 * Best-effort and side-effect-only: the caller decides what a failure
 * here means (a warning, and the repository-keyed marker is left in
 * place for the next invocation to recover).
 */
export async function cleanupWorktree(
  root: string,
  worktreePath: string,
  logDir: string,
): Promise<{ ok: boolean; logPaths: string[] }> {
  const removeResult = await execCommand(
    `git worktree remove --force -- ${JSON.stringify(worktreePath)}`,
    { cwd: root, logDir, timeoutMs: 30_000 },
  );
  const pruneResult = await execCommand("git worktree prune", {
    cwd: root,
    logDir,
    timeoutMs: 30_000,
  });
  return {
    ok: removeResult.exitCode === 0 && pruneResult.exitCode === 0,
    logPaths: [removeResult.logPath, pruneResult.logPath],
  };
}
