import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPathContained, resolveDeepestExisting } from "./containment.js";
import { runArgv, type RunArgvResult } from "./run.js";

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

/** Whether `p` (already known to be a symlink) points at a directory,
 * following the link exactly once. A dangling symlink (or one this
 * process cannot stat) is never linkable. */
function isDirectoryFollowingLink(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `node_modules` directory or directory symlink under `root`, at or
 * above `NODE_MODULES_LINK_DEPTH` segments deep, none of them nested
 * inside another `node_modules` this walk already found (a `node_modules`
 * entry is never itself recursed into, whether it is a real directory or
 * a symlink to one). For every OTHER entry, a symlink is not followed
 * (`Dirent` from `readdirSync` reports the entry's own type, not its
 * target's): this is what keeps the general walk itself from following a
 * symlinked directory into a cycle. A `node_modules` entry is the one
 * exception -- it is never recursed into either way, so following it
 * once just to classify it (a real directory, or a symlink to one, e.g.
 * a workspace's hoisted install) cannot introduce a cycle, and skipping
 * that one `stat` would otherwise silently drop every symlinked
 * `node_modules` from `linked`. `.git` is skipped outright: descending
 * into it would walk a large, irrelevant tree for no directory this
 * function could ever want. The walk itself goes one level past the
 * cutoff (never further), which is exactly enough to prove a directory
 * at the next depth is excluded rather than simply unvisited.
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
      if (entry.name === ".git") continue;
      const childPath = path.join(dir, entry.name);
      const childDepth = depth + 1;
      if (entry.name === "node_modules") {
        const isLinkableDir =
          entry.isDirectory() ||
          (entry.isSymbolicLink() && isDirectoryFollowingLink(childPath));
        if (isLinkableDir && childDepth <= NODE_MODULES_LINK_DEPTH) {
          found.push(childPath);
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      walk(childPath, childDepth);
    }
  }
  walk(root, 0);
  return found;
}

/** Number of file records in a `git diff --numstat -z` listing. Parsed
 * from the NUL-delimited token stream rather than from the diff's own
 * content: a normal record is one token (`<added>\t<removed>\t<path>`,
 * `-` for binary counts); a rename record is a token whose path field is
 * empty (`<added>\t<removed>\t`) followed by two further tokens (the old
 * and new path), still counted as one file. This is the single source
 * of truth for `syncedTrackedFiles`; nothing about the diff's own text
 * (which can contain a line that merely looks like a numstat record, or
 * arbitrary non-UTF-8 bytes for a binary hunk) is ever scanned for the
 * count. */
export function countNumstatFiles(numstatZOutput: string): number {
  const tokens = numstatZOutput
    .split("\0")
    .filter((t, i, all) => t !== "" || i !== all.length - 1);
  let count = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const parts = token.split("\t");
    if (parts.length >= 3 && parts[2] === "") {
      // Rename: this token's path field is empty; the old and new paths
      // are the next two tokens. Still one file.
      i += 3;
    } else {
      i += 1;
    }
    count += 1;
  }
  return count;
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
  /** Number of `git diff HEAD --numstat -z` records synced into the
   * worktree (0 for a clean tree); NOT necessarily the number of bytes
   * or hunks, and unrelated to `syncedUntrackedFiles` below. */
  syncedTrackedFiles: number;
  /** Number of `git ls-files --others --exclude-standard` ENTRIES this
   * sync acted on (attempted to copy, recreate as a symlink, or skip
   * with a warning) -- not the number of files that ended up on disk in
   * the worktree. A nested-repository entry counts as one here even
   * though it is skipped entirely (0 files copied), and a plain
   * directory entry (rare; see `warnings`) counts as one even though it
   * may expand into several copied files. Entries inside `logDir` itself
   * (this probe's own scratch space) are excluded from this count
   * entirely, the same as they are excluded from the sync. */
  syncedUntrackedFiles: number;
  /** Non-fatal notes from the untracked-file sync: a nested repository
   * directory skipped, or an untracked entry that was neither a regular
   * file, a directory, nor a symlink. Empty on a sync with nothing to
   * report. */
  warnings: string[];
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
  /** Scratch space: this run's own subdirectory (see the docblock below)
   * is created under here. */
  logDir: string;
  /** Absolute, already-contained extra directories to symlink into the
   * worktree in addition to the `node_modules` directories this
   * function finds on its own. */
  links: string[];
}

/** A regular file, copied byte for byte. */
function copyRegularFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** A symlink, recreated (dangling or not) rather than followed: the
 * worktree's copy must carry the SAME link target the source tree has,
 * not whatever that target currently resolves to (which may not even
 * exist). */
function copySymlink(src: string, dest: string): void {
  const linkTarget = fs.readlinkSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  fs.symlinkSync(linkTarget, dest);
}

/**
 * Copies one untracked entry (`relPath`, relative to `root`) into the
 * worktree, dispatching on the entry's own type rather than assuming a
 * regular file:
 *
 * - a regular file is copied byte for byte;
 * - a symlink (dangling or not) is recreated as a symlink pointing at
 *   the same target, never followed;
 * - a directory containing its own `.git` is a nested repository (this
 *   is the only way `git ls-files --others` ever reports a directory
 *   path at all: it refuses to descend across a `.git` boundary) --
 *   skipped outright, named in `warnings`, rather than copying an
 *   unrelated repository's checkout (and its own `.git`) into this one's
 *   worktree;
 * - any other directory is walked and its contents copied entry by
 *   entry, the same as this function would handle any of them one level
 *   up;
 * - anything else (a FIFO, a socket, a device node -- none of which
 *   `git ls-files` should ever report) is skipped, named in `warnings`,
 *   rather than failing the whole sync over content that was never a
 *   file to begin with.
 *
 * A missing entry (reported by `git ls-files` a moment ago, gone by the
 * time this runs) is silently skipped: a best-effort sync over a race,
 * not a bug. Only a genuine I/O failure on an entry this function DID
 * decide to copy (a regular file it cannot read, or a destination it
 * cannot write) propagates, and is exactly what should still fail the
 * whole sync as `worktree_sync_failed`.
 */
function copyUntrackedEntry(
  srcAbs: string,
  destAbs: string,
  displayRelPath: string,
  warnings: string[],
): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(srcAbs);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    copySymlink(srcAbs, destAbs);
    return;
  }
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(srcAbs, ".git"))) {
      warnings.push(
        `skipped a nested repository directory in the untracked sync: ${displayRelPath}`,
      );
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(srcAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      copyUntrackedEntry(
        path.join(srcAbs, entry.name),
        path.join(destAbs, entry.name),
        path.join(displayRelPath, entry.name),
        warnings,
      );
    }
    return;
  }
  if (!st.isFile()) {
    warnings.push(
      `skipped an untracked entry that is not a regular file, a directory, or a symlink: ${displayRelPath}`,
    );
    return;
  }
  copyRegularFile(srcAbs, destAbs);
}

/** Runs `git argv...` in `cwd`, logging into `runDir` under `logFileName`. */
function gitArgv(
  args: string[],
  runDir: string,
  logFileName: string,
  cwd: string,
): Promise<RunArgvResult> {
  return runArgv("git", args, {
    cwd,
    logDir: runDir,
    logFileName,
    timeoutMs: 30_000,
  });
}

/**
 * Begins a `worktree` probe session: `git worktree add --detach` at a
 * fresh subdirectory of `logDir`, then syncs the current working tree's
 * state into it so the worktree is a faithful copy of what the operator
 * sees, not just `HEAD`.
 *
 * Every git call goes through `run.ts`'s `runArgv` (an explicit argv
 * array, no shell): `--log-dir` and every synced path reach `git` as
 * opaque arguments, never interpolated into a shell string, so neither
 * can execute anything regardless of what characters they contain.
 *
 * This run's own scratch state -- the worktree itself, the tracked-diff
 * file, and the sync's own logs -- lives at `<logDir>/wt-<random>/`, a
 * fresh, never-before-seen subdirectory rather than a fixed name
 * directly under `logDir`. A caller commonly passes the SAME `--log-dir`
 * across separate probe invocations (the CLI's own default is one fixed
 * directory unless `--log-dir` is given per run); a fixed diff-file name
 * plus a previous run's leftover content there is exactly how a stale
 * diff gets replayed into a fresh, clean-tree worktree and silently
 * changes the verdict.
 *
 * Tracked modifications are synced via `git diff HEAD --binary
 * --output=<path>` (git writes the diff to that file directly -- never
 * through this process's own stdout capture, which decodes as UTF-8 and
 * would corrupt a binary hunk) followed by `git apply --allow-empty`
 * against that file in the worktree, run unconditionally so an empty
 * diff still exercises `--allow-empty` rather than being skipped. The
 * file count synced (`syncedTrackedFiles`) comes from a SEPARATE `git
 * diff HEAD --numstat -z`, never from scanning the diff's own text.
 *
 * Untracked, non-ignored files (`git ls-files --others --exclude-standard
 * -z`) are copied by relative path via `copyUntrackedEntry` (regular
 * files, symlinks, and nested-repository or plain directories each
 * handled by type; see its own docblock), except any entry that falls
 * inside `logDir` itself -- this probe's own scratch space, including
 * the worktree this call just created -- which is never a source file to
 * sync into the very worktree it is scratch space for. Every
 * `node_modules` directory (or directory symlink) up to
 * `NODE_MODULES_LINK_DEPTH` plus every `--link` extra is symlinked. Any
 * non-zero git exit, or a genuine I/O failure while copying, is
 * `worktree_sync_failed`; the caller (`probe/index.ts`) never treats a
 * sync failure as a verdict.
 */
export async function beginWorktree(
  opts: BeginWorktreeOptions,
): Promise<BeginWorktreeResult> {
  const { root, cwd, logDir, links } = opts;
  const runDir = path.join(logDir, `wt-${randomUUID()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const worktreePath = path.join(runDir, "wt");
  const logPaths: string[] = [];

  const addResult = await gitArgv(
    ["worktree", "add", "--detach", "--", worktreePath, "HEAD"],
    runDir,
    "worktree-add.log",
    root,
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

  const diffPath = path.join(runDir, "tracked.diff");
  // `runDir` was just created fresh, above, so this can only fire on a
  // genuine bug (a `randomUUID` collision, or something else writing
  // into this run's own scratch directory before this point) -- refused
  // outright rather than risking exactly the stale-diff replay this
  // fresh-directory scheme exists to prevent.
  if (fs.existsSync(diffPath)) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `refusing to reuse a pre-existing tracked-diff scratch file at ${diffPath}`,
      logPaths,
      worktreePath,
    };
  }
  const diffResult = await gitArgv(
    ["diff", "HEAD", "--binary", `--output=${diffPath}`],
    runDir,
    "tracked-diff.log",
    root,
  );
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

  const numstatResult = await gitArgv(
    ["diff", "HEAD", "--numstat", "-z"],
    runDir,
    "tracked-diff-numstat.log",
    root,
  );
  logPaths.push(numstatResult.logPath);
  if (numstatResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git diff HEAD --numstat failed; see ${numstatResult.logPath}`,
      logPaths,
      worktreePath,
    };
  }
  const syncedTrackedFiles = countNumstatFiles(numstatResult.stdout);

  // Run unconditionally, even against an empty `tracked.diff`: that is
  // exactly the case `--allow-empty` exists for (a bare `git apply`
  // exits 128 on empty input), and the clean-tree path has to exercise
  // the same exec call as every other tree state.
  const applyResult = await gitArgv(
    ["-C", worktreePath, "apply", "--allow-empty", "--", diffPath],
    runDir,
    "worktree-apply.log",
    root,
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

  const untrackedResult = await gitArgv(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    runDir,
    "untracked-files.log",
    root,
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
  const untrackedRelPaths = untrackedResult.stdout
    .split("\0")
    .filter((p) => p.length > 0);

  const logDirReal = resolveDeepestExisting(path.resolve(logDir));
  const syncWarnings: string[] = [];
  const syncableRelPaths = untrackedRelPaths.filter((relPath) => {
    const srcReal = resolveDeepestExisting(path.join(root, relPath));
    // The probe's own scratch space (this run's worktree, its
    // tracked-diff file, or a leftover from a previous run sharing this
    // --log-dir): never itself a source to sync into the very worktree
    // it is scratch space for.
    return !isPathContained(logDirReal, srcReal);
  });
  try {
    for (const relPath of syncableRelPaths) {
      copyUntrackedEntry(
        path.join(root, relPath),
        path.join(worktreePath, relPath),
        relPath,
        syncWarnings,
      );
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
    syncedUntrackedFiles: syncableRelPaths.length,
    warnings: syncWarnings,
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
  const removeResult = await gitArgv(
    ["worktree", "remove", "--force", "--", worktreePath],
    logDir,
    `worktree-remove-${randomUUID()}.log`,
    root,
  );
  const pruneResult = await gitArgv(
    ["worktree", "prune"],
    logDir,
    `worktree-prune-${randomUUID()}.log`,
    root,
  );
  return {
    ok: removeResult.exitCode === 0 && pruneResult.exitCode === 0,
    logPaths: [removeResult.logPath, pruneResult.logPath],
  };
}
