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
   * create, BEFORE it runs. The caller records it, and writes its
   * leftover-recovery marker, at this point rather than once the add
   * has succeeded: git registers the worktree (`locked` for the
   * duration of the checkout) before the add returns, so a signal, a
   * `SIGKILL`, or a crash from here on always has either a cleanup that
   * knows the path or a marker for `doctor` and the next probe to act
   * on. A marker for an add that never registered anything is cleared
   * harmlessly by that same recovery. */
  onWorktreeAttempt?: (worktreePath: string) => void;
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

/** `relPath`'s own resolved location under `root`: the parent directory
 * through realpath, the entry's basename re-appended verbatim. Unlike
 * resolving the whole path, this never follows the entry itself when it
 * is a symlink, so the answer is about where the entry sits, not where
 * it points. */
function entryOwnPath(root: string, relPath: string): string {
  const abs = path.join(root, relPath);
  return path.join(
    resolveDeepestExisting(path.dirname(abs)),
    path.basename(abs),
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
 * the worktree path through `onWorktreeAttempt` before `git worktree
 * add` runs, so no moment from the add onward is one where an
 * interrupted run has nothing to clean up and nothing to report.
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
    // The probe's own scratch space (this run's worktree, its
    // tracked-diff file, or a leftover from a previous run sharing this
    // --log-dir): never itself a source to sync into the very worktree
    // it is scratch space for. Decided on the entry's OWN location, not
    // on where a symlink entry points: an untracked symlink whose
    // target resolves inside `logDir` is still a link that lives in the
    // source tree, and `copyUntrackedEntry` recreates it as a link
    // (never following it) the same as any other symlink.
    return !isPathContained(logDirReal, entryOwnPath(root, relPath));
  });
  try {
    for (let i = 0; i < syncableRelPaths.length; i += 1) {
      // Checked before the first entry and once per batch (never per
      // entry: the yield, not the check, is what costs). The signal can
      // only ever have fired during a yield, so a check anywhere else
      // in the batch, or after the last batch (which no yield follows),
      // would read the same value this one does.
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

/** The shape of every worktree this module creates: a directory named
 * `wt` inside a per-run scratch directory `wt-<uuid>` (see
 * `beginWorktree`). The one shape `cleanupWorktree` is ever willing to
 * delete: an operator's own worktree, whatever it is called, never
 * matches it. Exported for `doctor` and the tests. */
export function isScratchWorktreePath(p: string): boolean {
  const normalized = path.resolve(p);
  return (
    path.basename(normalized) === "wt" &&
    /^wt-[0-9a-f-]{36}$/.test(path.basename(path.dirname(normalized)))
  );
}

/** The `worktree <path>` records of a `git worktree list --porcelain
 * -z` listing, in order (the main worktree first). `-z` ends every
 * record with NUL (and every block with a second one), so a path with a
 * newline in it still parses. Exported for `doctor`, which runs the
 * same listing through its own synchronous spawn. */
export function parseWorktreeListZ(stdout: string): string[] {
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record.startsWith("worktree ")) {
      paths.push(record.slice("worktree ".length));
    }
  }
  return paths;
}

export interface RegisteredWorktrees {
  /** True when the listing ran, exited 0, and was captured whole;
   * `paths` is empty (and says nothing) otherwise. */
  ok: boolean;
  /** Every registered worktree of the repository, the main one first,
   * each through `resolveDeepestExisting` so a caller can compare it
   * with a path of its own spelling. */
  paths: string[];
  logPath: string;
}

/** `git worktree list --porcelain -z` for the repository at `root`,
 * logged under `logDir` and registered through `track`, never under an
 * abort signal: this is the cleanup and recovery side (see
 * `cleanupWorktree` for why). */
export async function listRegisteredWorktrees(
  root: string,
  logDir: string,
  opts: { track?: TrackGitCall } = {},
): Promise<RegisteredWorktrees> {
  const track: TrackGitCall = opts.track ?? ((started) => started);
  const result = await trackGit(
    track,
    gitArgv(
      ["worktree", "list", "--porcelain", "-z"],
      logDir,
      `worktree-list-${randomUUID()}.log`,
      root,
    ),
  );
  const ok = result.exitCode === 0 && !result.outputTruncated;
  return {
    ok,
    paths: ok
      ? parseWorktreeListZ(result.stdout).map((p) =>
          resolveDeepestExisting(path.resolve(p)),
        )
      : [],
    logPath: result.logPath,
  };
}

/** The `worktrees/` administrative directory of the repository at
 * `root`: under the common git dir, which is `.git` for a main worktree
 * and the main repository's `.git` for a linked one. `git rev-parse`
 * does not enumerate worktrees, so it still answers when `git worktree
 * list` cannot. */
async function worktreeAdminDir(
  root: string,
  logDir: string,
  track: TrackGitCall,
): Promise<{ dir?: string; logPath: string }> {
  const result = await trackGit(
    track,
    gitArgv(
      ["rev-parse", "--git-common-dir"],
      logDir,
      `git-common-dir-${randomUUID()}.log`,
      root,
    ),
  );
  const out = result.stdout.trim();
  if (result.exitCode !== 0 || out.length === 0) {
    return { logPath: result.logPath };
  }
  return {
    dir: path.join(path.resolve(root, out), "worktrees"),
    logPath: result.logPath,
  };
}

/** Removes the administrative entry a `git worktree add` killed in its
 * first moments leaves half-written: `gitdir` already names `target`'s
 * own `.git` file and `locked` is present, but `commondir` is empty
 * (git creates the file before it writes the content). git itself
 * cannot act on such an entry (`list`, `remove`, and `unlock` all die
 * reading the empty `commondir`, and `prune` skips a locked entry), so
 * every `git worktree` command in the repository fails until the entry
 * is gone, and nothing short of deleting it clears it. Only an entry
 * naming the already-gated `target` is ever touched. Returns true when
 * one was removed. */
function removeHalfWrittenAdminEntry(
  adminDir: string,
  target: string,
): boolean {
  let ids: string[];
  try {
    ids = fs.readdirSync(adminDir);
  } catch {
    return false;
  }
  let removed = false;
  for (const id of ids) {
    const entry = path.join(adminDir, id);
    let gitdir: string;
    try {
      gitdir = fs.readFileSync(path.join(entry, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    if (gitdir.length === 0) continue;
    if (!fs.existsSync(path.join(entry, "locked"))) continue;
    let commondirBytes: number;
    try {
      commondirBytes = fs.statSync(path.join(entry, "commondir")).size;
    } catch {
      continue;
    }
    if (commondirBytes > 0) continue;
    if (resolveDeepestExisting(path.dirname(gitdir)) !== target) continue;
    try {
      fs.rmSync(entry, { recursive: true, force: true });
      removed = true;
    } catch {
      // Best-effort: reported through the assertion that follows.
    }
  }
  return removed;
}

export interface CleanupWorktreeOptions {
  track?: TrackGitCall;
  /** The `--log-dir` the worktree was created under: this session's
   * own, or the one a leftover's marker recorded. A path git does not
   * report as a registered worktree of the repository is deleted only
   * when it is of the scratch shape AND sits under this directory;
   * omitted, only a registered scratch worktree can be removed. */
  scratchRoot?: string;
}

export interface CleanupWorktreeResult {
  /** True only when, after the removal, `git worktree list` no longer
   * reports the path AND nothing is left of it on disk: an assertion of
   * the outcome, never an inference from a git exit code. */
  ok: boolean;
  /** True when the path failed the gate below and nothing at all was
   * run against it. */
  refused: boolean;
  /** Why `ok` is false, for the caller's warning. */
  detail?: string;
  logPaths: string[];
}

/**
 * Removes one worktree of this module's own making and asserts that it
 * is gone. The directory is deleted first, then `git worktree remove
 * --force --force` runs, then `git worktree prune`. The directory goes
 * first because `remove` validates it as a worktree before acting, and
 * an add killed before it had written the worktree's own `.git` file
 * leaves a directory that fails that validation, while a missing
 * directory is accepted; the second `--force` is what then clears the
 * `locked` registration an interrupted add leaves behind, which a
 * single `--force` refuses and `prune` skips. `prune` covers a
 * registration that was never locked. `ok` is then asserted by
 * re-running `git worktree list` and checking the path itself, never
 * read off an exit code: `remove` exits non-zero for a path that was
 * never registered, and `prune` exits 0 while skipping a locked entry.
 * When that listing itself fails, the one state git cannot recover
 * from on its own is handled here: an entry the add left half-written
 * (see `removeHalfWrittenAdminEntry`) is removed when it names this
 * same path, and the prune and the assertion run again.
 *
 * Nothing is run against the path before it passes a gate, because the
 * path can come from a marker file, not only from this process's own
 * `beginWorktree`: it must be of the scratch shape (see
 * `isScratchWorktreePath`), never the repository root or its main
 * worktree, and either reported by `git worktree list` as a worktree
 * of this repository before the removal, or contained (through
 * realpath) in `scratchRoot`. Any other path is refused: neither git
 * nor the recursive delete touches it, and the result says so, so the
 * caller can keep its marker and name the path.
 *
 * The caller's abort signal is deliberately NOT threaded into these git
 * calls, unlike every call in `beginWorktree`: this is the cleanup a
 * SIGINT/SIGTERM asks for, so running it under the very signal that
 * triggered it would kill the removal at spawn time and leave behind
 * exactly the worktree it exists to remove. `track` still applies, so a
 * signal arriving while a normal-path cleanup is in flight waits for
 * the removal instead of exiting through the middle of it.
 */
export async function cleanupWorktree(
  root: string,
  worktreePath: string,
  logDir: string,
  opts: CleanupWorktreeOptions = {},
): Promise<CleanupWorktreeResult> {
  const track: TrackGitCall = opts.track ?? ((started) => started);
  const logPaths: string[] = [];
  const target = resolveDeepestExisting(path.resolve(worktreePath));
  const rootReal = resolveDeepestExisting(path.resolve(root));

  const before = await listRegisteredWorktrees(root, logDir, { track });
  logPaths.push(before.logPath);
  const registeredBefore = before.paths.includes(target);
  const mainWorktree = before.paths[0];
  const contained =
    opts.scratchRoot !== undefined &&
    isPathContained(
      resolveDeepestExisting(path.resolve(opts.scratchRoot)),
      target,
    );
  let refusal: string | undefined;
  if (!isScratchWorktreePath(target)) {
    refusal =
      "it is not of the probe's own scratch shape (<log-dir>/wt-<id>/wt)";
  } else if (target === rootReal || target === mainWorktree) {
    refusal = "it is the repository itself";
  } else if (!registeredBefore && !contained) {
    refusal =
      opts.scratchRoot === undefined
        ? "git does not report it as a worktree of this repository"
        : `git does not report it as a worktree of this repository and it is not under the recorded log dir ${opts.scratchRoot}`;
  }
  if (refusal !== undefined) {
    return {
      ok: false,
      refused: true,
      detail: `refusing to remove ${worktreePath}: ${refusal}`,
      logPaths,
    };
  }

  // Reached only for a path the gate above admitted.
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // Best-effort: whatever is still there fails the assertion below.
  }
  const removeResult = await trackGit(
    track,
    gitArgv(
      ["worktree", "remove", "--force", "--force", "--", worktreePath],
      logDir,
      `worktree-remove-${randomUUID()}.log`,
      root,
    ),
  );
  logPaths.push(removeResult.logPath);
  const pruneResult = await trackGit(
    track,
    gitArgv(
      ["worktree", "prune"],
      logDir,
      `worktree-prune-${randomUUID()}.log`,
      root,
    ),
  );
  logPaths.push(pruneResult.logPath);

  let after = await listRegisteredWorktrees(root, logDir, { track });
  logPaths.push(after.logPath);
  if (!after.ok) {
    const admin = await worktreeAdminDir(root, logDir, track);
    logPaths.push(admin.logPath);
    if (
      admin.dir !== undefined &&
      removeHalfWrittenAdminEntry(admin.dir, target)
    ) {
      const pruneAgain = await trackGit(
        track,
        gitArgv(
          ["worktree", "prune"],
          logDir,
          `worktree-prune-${randomUUID()}.log`,
          root,
        ),
      );
      logPaths.push(pruneAgain.logPath);
      after = await listRegisteredWorktrees(root, logDir, { track });
      logPaths.push(after.logPath);
    }
  }
  const stillRegistered = !after.ok || after.paths.includes(target);
  const stillOnDisk = fs.existsSync(worktreePath);
  const ok = !stillRegistered && !stillOnDisk;
  const detail = ok
    ? undefined
    : !after.ok
      ? `git worktree list did not run cleanly after the removal; see ${after.logPath}`
      : stillRegistered
        ? `git still reports it as a worktree after the removal; see ${removeResult.logPath}`
        : "something is still on disk at the path after the removal";
  return {
    ok,
    refused: false,
    ...(detail !== undefined ? { detail } : {}),
    logPaths,
  };
}
