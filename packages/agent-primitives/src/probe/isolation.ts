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
   * though it is skipped entirely (0 files copied), the same as any
   * other skipped entry (see `warnings`). Entries inside `logDir` itself
   * (this probe's own scratch space) are excluded from this count
   * entirely, the same as they are excluded from the sync. */
  syncedUntrackedFiles: number;
  /** Non-fatal notes from the untracked-file sync: a nested repository
   * directory skipped, or an untracked entry that was neither a regular
   * file, a symlink, nor a nested repository. Empty on a sync with
   * nothing to report. */
  warnings: string[];
  logPaths: string[];
}

export interface WorktreeSyncFailure {
  ok: false;
  /** `aborted` when the caller's `signal` stopped the sync (a
   * SIGINT/SIGTERM this probe is handling, or a library caller's own
   * abort): a run that was stopped, never a sync that failed, and never
   * a verdict. `worktree_sync_failed` is every other non-zero git exit
   * or filesystem failure. */
  reason: "worktree_sync_failed" | "aborted";
  detail: string;
  logPaths: string[];
  /** Set once `git worktree add` itself succeeded, so a failure in a
   * later sync step still leaves the caller able to register (and clean
   * up) the worktree directory that already exists on disk. */
  worktreePath?: string;
}

export type BeginWorktreeResult = WorktreeSyncSuccess | WorktreeSyncFailure;

/** Registers one started child run, together with a promise of when its
 * stdio has truly closed, as the caller's one in-flight run. The same
 * hook `probe/index.ts` passes its `--pre`, `-t`, and `git apply` calls,
 * so a signal handler can wait for whatever this function has running
 * before it acts. */
export type TrackGitCall = <T>(
  started: Promise<T>,
  closed: Promise<void>,
) => Promise<T>;

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
  /** The caller's abort signal, threaded into every git call this
   * function makes and checked between batches of the untracked-file
   * copy. Without it a SIGINT/SIGTERM landing mid-sync would leave the
   * git child running (and this function copying) while the caller has
   * already decided to stop. Omitted, the sync is uninterruptible. */
  signal?: AbortSignal;
  /** Registers every git call this function makes as the caller's one
   * in-flight run (see `TrackGitCall`). Omitted, the calls run
   * untracked. */
  track?: TrackGitCall;
  /** Called synchronously with the path `git worktree add` is about to
   * create, BEFORE it runs. The caller records it for cleanup: an
   * interrupted `git worktree add` can leave a registered worktree
   * behind, and only a caller that already knows the path can remove
   * it. */
  onWorktreeAttempt?: (worktreePath: string) => void;
  /** Called synchronously once `git worktree add` has succeeded and
   * before any sync step runs, so the caller can write its own
   * leftover-recovery marker while the rest of the sync is still ahead:
   * a signal from this point on always has either a cleanup to run or a
   * marker for `doctor` and the next probe to act on. */
  onWorktreeCreated?: (worktreePath: string) => void;
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
 * - anything else (a plain directory, a FIFO, a socket, a device node
 *   -- none of which `git ls-files --others --exclude-standard` reports)
 *   is skipped, named in `warnings`, rather than failing the whole sync
 *   over content that was never a file to begin with. A plain directory
 *   is deliberately not walked: recursing would be an unbounded descent
 *   for a shape this listing does not produce.
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
  if (st.isDirectory() && fs.existsSync(path.join(srcAbs, ".git"))) {
    warnings.push(
      `skipped a nested repository directory in the untracked sync: ${displayRelPath}`,
    );
    return;
  }
  if (!st.isFile()) {
    warnings.push(
      `skipped an untracked entry that is neither a regular file, a symlink, nor a nested repository: ${displayRelPath}`,
    );
    return;
  }
  copyRegularFile(srcAbs, destAbs);
}

/** Runs `git argv...` in `cwd`, logging into `runDir` under
 * `logFileName`, under `signal` when one is given. */
function gitArgv(
  args: string[],
  runDir: string,
  logFileName: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<RunArgvResult> {
  return runArgv("git", args, {
    cwd,
    logDir: runDir,
    logFileName,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
}

/** Registers one already-started git call with the caller's tracking
 * hook. `run.ts` settles only on `close`, so the call's own settling
 * already IS true stdio closure and `closed` just mirrors it (the same
 * reasoning `probe/index.ts`'s `startRunArgvTracked` states for the
 * `git apply` calls). */
function trackGit(
  track: TrackGitCall,
  started: Promise<RunArgvResult>,
): Promise<RunArgvResult> {
  return track(
    started,
    started.then(
      () => undefined,
      () => undefined,
    ),
  );
}

/** How many untracked entries are copied between two yields back to the
 * event loop. The copy itself is synchronous, and a synchronous loop
 * over thousands of entries blocks the event loop, and with it this
 * process's own SIGINT/SIGTERM handler: the abort would only be seen
 * once the whole phase had finished, which is exactly the window a
 * probe interrupted mid-sync must not have. */
const UNTRACKED_COPY_YIELD_EVERY = 32;

/** Yields to the event loop, giving a pending signal handler (and the
 * abort it triggers) a turn to run before the next batch. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
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
 * files, symlinks, and nested repositories each handled by type, any
 * other entry skipped with a warning; see its own docblock), except any
 * entry that falls inside `logDir` itself -- this probe's own scratch
 * space, including the worktree this call just created -- which is never
 * a source file to sync into the very worktree it is scratch space for.
 * Every `node_modules` directory (or directory symlink) up to
 * `NODE_MODULES_LINK_DEPTH` plus every `--link` extra is symlinked. Any
 * non-zero git exit, or a genuine I/O failure while copying, is
 * `worktree_sync_failed`; the caller (`probe/index.ts`) never treats a
 * sync failure as a verdict.
 *
 * The whole sync runs under the caller's `signal` and through its
 * `track` hook: every git call below is killed when the signal fires
 * and is the caller's registered in-flight run while it lasts, and the
 * untracked-file copy checks the same signal between batches. A sync
 * stopped that way returns `aborted`, never `worktree_sync_failed`: it
 * is a run that was stopped, not a sync that failed. The caller learns
 * the worktree path through `onWorktreeAttempt` (before `git worktree
 * add` runs, since an interrupted add can leave a registered worktree
 * behind) and again through `onWorktreeCreated` (once the add
 * succeeded, before any sync step), so no window between the add and
 * the end of the sync is one where an interrupted run has nothing to
 * clean up and nothing to report.
 */
export async function beginWorktree(
  opts: BeginWorktreeOptions,
): Promise<BeginWorktreeResult> {
  const { root, cwd, logDir, links, signal } = opts;
  const track: TrackGitCall = opts.track ?? ((started) => started);
  const runDir = path.join(logDir, `wt-${randomUUID()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const worktreePath = path.join(runDir, "wt");
  const logPaths: string[] = [];
  const runGit = (
    args: string[],
    logFileName: string,
    gitCwd: string,
  ): Promise<RunArgvResult> =>
    trackGit(track, gitArgv(args, runDir, logFileName, gitCwd, signal));
  const abortedResult = (step: string): WorktreeSyncFailure => ({
    ok: false,
    reason: "aborted",
    detail: `the worktree sync was aborted during ${step}`,
    logPaths,
    ...(fs.existsSync(worktreePath) ? { worktreePath } : {}),
  });

  opts.onWorktreeAttempt?.(worktreePath);
  const addResult = await runGit(
    ["worktree", "add", "--detach", "--", worktreePath, "HEAD"],
    "worktree-add.log",
    root,
  );
  logPaths.push(addResult.logPath);
  if (addResult.aborted) return abortedResult("git worktree add");
  if (addResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git worktree add failed; see ${addResult.logPath}`,
      logPaths,
    };
  }
  opts.onWorktreeCreated?.(worktreePath);

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
  const diffResult = await runGit(
    ["diff", "HEAD", "--binary", `--output=${diffPath}`],
    "tracked-diff.log",
    root,
  );
  logPaths.push(diffResult.logPath);
  if (diffResult.aborted) return abortedResult("the tracked-diff capture");
  if (diffResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git diff HEAD --binary failed; see ${diffResult.logPath}`,
      logPaths,
      worktreePath,
    };
  }

  const numstatResult = await runGit(
    ["diff", "HEAD", "--numstat", "-z"],
    "tracked-diff-numstat.log",
    root,
  );
  logPaths.push(numstatResult.logPath);
  if (numstatResult.aborted)
    return abortedResult("the tracked-diff file count");
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
  const applyResult = await runGit(
    ["-C", worktreePath, "apply", "--allow-empty", "--", diffPath],
    "worktree-apply.log",
    root,
  );
  logPaths.push(applyResult.logPath);
  if (applyResult.aborted) return abortedResult("the tracked-diff apply");
  if (applyResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `git apply --allow-empty failed against the worktree; see ${applyResult.logPath}`,
      logPaths,
      worktreePath,
    };
  }

  const untrackedResult = await runGit(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "untracked-files.log",
    root,
  );
  logPaths.push(untrackedResult.logPath);
  if (untrackedResult.aborted) {
    return abortedResult("the untracked-file listing");
  }
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
    for (let i = 0; i < syncableRelPaths.length; i += 1) {
      // Checked before the first entry and once per batch (never per
      // entry: the yield, not the check, is what costs). The signal can
      // only ever have fired during a yield, so a check anywhere else
      // in the batch would read the same value this one does.
      if (i % UNTRACKED_COPY_YIELD_EVERY === 0) {
        if (i > 0) await yieldToEventLoop();
        if (signal?.aborted) return abortedResult("the untracked-file copy");
      }
      const relPath = syncableRelPaths[i];
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

  if (signal?.aborted) return abortedResult("the untracked-file copy");

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
 * Removes a worktree via `git worktree remove --force`, then deletes
 * whatever is left of its directory, then runs `git worktree prune`.
 * All three run unconditionally, because this also has to clear what an
 * INTERRUPTED `git worktree add` leaves: git creates the worktree
 * directory and its administrative entry before the checkout is
 * finished, so a killed add can leave a registration `remove` refuses
 * to act on and `prune` will not touch while the directory is still
 * there. Deleting the directory (always this probe's own scratch space
 * under `--log-dir`, never anything the operator owns) and pruning
 * afterwards clears both halves. `ok` therefore reports the outcome
 * that matters -- nothing left on disk, and the prune that unregisters
 * it succeeded -- rather than `git worktree remove`'s exit code, which
 * is non-zero for a path that was never registered in the first place.
 *
 * The caller's abort signal is deliberately NOT threaded into these two
 * git calls, unlike every call in `beginWorktree`: this is the cleanup
 * a SIGINT/SIGTERM asks for, so running it under the very signal that
 * triggered it would kill the removal at spawn time and leave behind
 * exactly the worktree it exists to remove. `track` still applies, so a
 * signal arriving while a normal-path cleanup is in flight waits for
 * the removal instead of exiting through the middle of it.
 *
 * Best-effort and side-effect-only otherwise: the caller decides what a
 * failure here means (a warning, and the repository-keyed marker is
 * left in place for the next invocation to recover).
 */
export async function cleanupWorktree(
  root: string,
  worktreePath: string,
  logDir: string,
  opts: { track?: TrackGitCall } = {},
): Promise<{ ok: boolean; logPaths: string[] }> {
  const track: TrackGitCall = opts.track ?? ((started) => started);
  const removeResult = await trackGit(
    track,
    gitArgv(
      ["worktree", "remove", "--force", "--", worktreePath],
      logDir,
      `worktree-remove-${randomUUID()}.log`,
      root,
    ),
  );
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // Best-effort: whatever is still there is reported through `ok`
    // below, which re-checks the path rather than trusting this call.
  }
  const pruneResult = await trackGit(
    track,
    gitArgv(
      ["worktree", "prune"],
      logDir,
      `worktree-prune-${randomUUID()}.log`,
      root,
    ),
  );
  return {
    ok: pruneResult.exitCode === 0 && !fs.existsSync(worktreePath),
    logPaths: [removeResult.logPath, pruneResult.logPath],
  };
}
