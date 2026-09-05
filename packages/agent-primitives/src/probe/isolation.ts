import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPidAlive } from "../lock.js";
import { isPathContained, resolveDeepestExisting } from "./containment.js";
import { GIT_CONTENT_WRITE_CONFIG_ARGS } from "./mutant.js";
import { runArgv, type RunArgvResult } from "./run.js";

/** The oldest git whose `git apply --allow-empty` the worktree sync
 * relies on. An older release rejects the option, so `beginWorktree`
 * reports `worktree_sync_failed` on it; `doctor` warns below this. */
export const GIT_MIN_VERSION_WORKTREE_SYNC = "2.35";

/** The oldest git whose `git worktree list --porcelain -z` the registry
 * listing relies on. An older release rejects `-z`, and
 * `listRegisteredWorktrees` then falls back to the newline-separated
 * form (see `parseWorktreeListLines`); `doctor` warns below this. */
export const GIT_MIN_VERSION_WORKTREE_LIST_Z = "2.36";

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
 * hook `probe/session.ts`'s `createRunController` produces and
 * `probe/step.ts`/`probe/setup.ts` pass along to its own `--pre`, `-t`,
 * and `git apply` calls, so a signal handler can wait for whatever this
 * function has running before it acts. */
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
 * reasoning `probe/session.ts`'s `startRunArgvTracked` states for the
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
 * file, the owner record (`owner.json`: this process's pid, written
 * before the add so a probe under another lock directory can tell a
 * worktree in use from a leftover), and the sync's own logs -- lives at
 * `<logDir>/wt-<random>/`, a fresh, never-before-seen subdirectory
 * rather than a fixed name
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
 * `worktree_sync_failed`; the caller (`probe/session.ts`'s
 * `prepareWorktreeSession`) never treats a sync failure as a verdict.
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
  // Written before anything is registered with git: from the add
  // onward, a probe under another lock directory that finds this
  // worktree in the registry reads this record and leaves the worktree
  // alone while this process is alive and the record is within its
  // bound (see `liveForeignOwner`).
  try {
    writeScratchOwner(runDir, logDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "worktree_sync_failed",
      detail: `writing the scratch owner record failed: ${message}`,
      logPaths,
    };
  }
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
    [
      ...GIT_CONTENT_WRITE_CONFIG_ARGS,
      "worktree",
      "add",
      "--detach",
      "--",
      worktreePath,
      "HEAD",
    ],
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
    [
      ...GIT_CONTENT_WRITE_CONFIG_ARGS,
      "-C",
      worktreePath,
      "apply",
      "--allow-empty",
      "--",
      diffPath,
    ],
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
 * `beginWorktree`), the uuid in its 8-4-4-4-12 lowercase hex layout and
 * nothing looser. The one shape `cleanupWorktree` is ever willing to
 * delete: an operator's own worktree, whatever it is called, never
 * matches it. Exported for `doctor` and the tests. */
export function isScratchWorktreePath(p: string): boolean {
  const normalized = path.resolve(p);
  return (
    path.basename(normalized) === "wt" &&
    /^wt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      path.basename(path.dirname(normalized)),
    )
  );
}

/** The file `beginWorktree` writes into the per-run scratch directory,
 * next to `wt`, recording which process the worktree belongs to. */
export const SCRATCH_OWNER_FILE = "owner.json";

export interface ScratchOwner {
  pid: number;
  /** When the record was written (ISO 8601): what `scratchOwnerState`
   * measures `SCRATCH_OWNER_MAX_AGE_HOURS` against. */
  timestamp: string;
  /** The resolved `--log-dir` the scratch directory was created under: a
   * breadcrumb for a human reading `owner.json`, never read by the gate,
   * which checks containment against the recovering run's own log dir. */
  logDir: string;
}

/** Where the owner record of the scratch directory holding
 * `worktreePath` sits: `<log-dir>/wt-<uuid>/owner.json`. */
export function scratchOwnerPath(worktreePath: string): string {
  return path.join(
    path.dirname(path.resolve(worktreePath)),
    SCRATCH_OWNER_FILE,
  );
}

function writeScratchOwner(runDir: string, logDir: string): void {
  const owner: ScratchOwner = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    logDir: path.resolve(logDir),
  };
  fs.writeFileSync(
    path.join(runDir, SCRATCH_OWNER_FILE),
    JSON.stringify(owner),
  );
}

/** The owner record of the scratch directory holding `worktreePath`, or
 * undefined when there is none or it does not parse. */
export function readScratchOwner(
  worktreePath: string,
): ScratchOwner | undefined {
  try {
    const raw = fs.readFileSync(scratchOwnerPath(worktreePath), "utf8");
    const parsed = JSON.parse(raw) as Partial<ScratchOwner>;
    if (typeof parsed.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      timestamp: String(parsed.timestamp ?? ""),
      logDir: String(parsed.logDir ?? ""),
    };
  } catch {
    return undefined;
  }
}

/** How long a timestamped record vouches for what it names, measured
 * from the record's own timestamp: the scratch owner record below, and
 * a probe marker's own `timestamp` field (`doctor`'s `stale-worktree`
 * check; see `isTimestampPastBound`). A probe's worktree lives for one
 * run, so a record or marker older than this names a run that is long
 * over: the pid it carries is either recycled or some unrelated
 * process, and reading it as a probe in flight would park the leftover
 * for as long as that pid happens to stay alive. Past the bound the
 * worktree is a leftover whatever the pid says. Exported for `doctor`'s
 * hint and the tests. */
export const SCRATCH_OWNER_MAX_AGE_HOURS = 24;

const SCRATCH_OWNER_MAX_AGE_MS = SCRATCH_OWNER_MAX_AGE_HOURS * 60 * 60 * 1000;

/** What the owner record of a scratch directory says about the process
 * behind it: `none` when there is no record (or it does not parse),
 * `self` for this process's own, `dead` when the pid is gone, `expired`
 * when the pid is alive but the record's timestamp does not parse or
 * lies more than `SCRATCH_OWNER_MAX_AGE_HOURS` from the clock in either
 * direction, and `live` only for an alive pid under a record within
 * that bound. Only `live` is a probe in flight. */
export type ScratchOwnerState = "none" | "self" | "dead" | "expired" | "live";

/** True when `timestamp` (the record's own, never the file's mtime) does
 * not parse or lies more than `SCRATCH_OWNER_MAX_AGE_HOURS` away from
 * `now`. A future-dated record is as untrustworthy as a stale one, and
 * so is a record with no `timestamp` field at all -- an older marker
 * shape predating this field, `undefined` here rather than a string
 * despite the field's declared type, since a hand-parsed JSON file is
 * never guaranteed to carry every field its type says it must -- which
 * is stale by definition, an explicit branch rather than a value that
 * merely happens to make `Date.parse` return `NaN`. The one bound this
 * package applies to a record's own age, shared by the scratch owner
 * record's classification below and by `doctor`'s `stale-worktree`
 * check, which applies it to a probe marker's `timestamp` field (never
 * the marker file's mtime, the same choice made here) the same way: a
 * marker whose pid happens to still resolve to *something* must not be
 * read as vouching for a run forever. */
export function isTimestampPastBound(
  timestamp: string | undefined,
  now: number,
): boolean {
  if (timestamp === undefined) return true;
  const written = Date.parse(timestamp);
  return (
    !Number.isFinite(written) ||
    Math.abs(now - written) > SCRATCH_OWNER_MAX_AGE_MS
  );
}

function classifyScratchOwner(
  owner: ScratchOwner,
  now: number,
): ScratchOwnerState {
  if (owner.pid === process.pid) return "self";
  if (!isPidAlive(owner.pid)) return "dead";
  if (isTimestampPastBound(owner.timestamp, now)) return "expired";
  return "live";
}

/** The `ScratchOwnerState` of the scratch directory holding
 * `worktreePath`, read against the clock now. Exported for the tests;
 * `liveForeignOwner` is what the gate, the recovery, and `doctor` ask. */
export function scratchOwnerState(worktreePath: string): ScratchOwnerState {
  const owner = readScratchOwner(worktreePath);
  return owner === undefined ? "none" : classifyScratchOwner(owner, Date.now());
}

/** The pid of a process other than this one that owns the scratch
 * directory holding `worktreePath` and is a probe still in flight (the
 * record classifies as `live`: an alive pid, by the same liveness check
 * the lock and marker files use, under a record within
 * `SCRATCH_OWNER_MAX_AGE_HOURS`), or undefined for every other state:
 * no owner record, this process itself, a dead owner, or a record past
 * the bound. The lock serializes probes only within one lock directory,
 * so a probe under another `AGENT_PRIMITIVES_LOCK_DIR` finds this one's
 * worktree in git's registry while it is still in use; this record is
 * what tells the two apart, for as long as the bound lets it. Exported
 * for `doctor` and the recovery path. */
export function liveForeignOwner(worktreePath: string): number | undefined {
  const owner = readScratchOwner(worktreePath);
  if (owner === undefined) return undefined;
  return classifyScratchOwner(owner, Date.now()) === "live"
    ? owner.pid
    : undefined;
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

/** The attribute lines one block of `git worktree list --porcelain`
 * (without `-z`) can carry, each keyed by its first word and placed in
 * the order git prints them: `worktree` first, then `bare` or `HEAD`,
 * then `branch` or `detached`, then `locked`, then `prunable`. Lock and
 * prune reasons are quoted onto one line in this form; only the
 * worktree path is printed raw. */
const PORCELAIN_LINE_ORDER: Record<string, number> = {
  worktree: 0,
  bare: 1,
  HEAD: 1,
  branch: 2,
  detached: 2,
  locked: 3,
  prunable: 4,
};

export type ParsedWorktreeList =
  { ok: true; paths: string[] } | { ok: false; detail: string };

/** Parses the newline-separated `git worktree list --porcelain` output
 * (the form every release since `worktree list` itself has, and the
 * fallback for a git that rejects `-z`) into the worktree paths, in
 * order, the main worktree first. A worktree path containing a newline
 * is the one thing this form cannot represent: its continuation shows
 * up as a line that is not an attribute, as an attribute out of the
 * fixed order (git always prints `bare` or `HEAD` right after
 * `worktree`, so a continuation line can never sit between the two
 * without breaking the order), or as a block boundary, when what
 * follows the newline is an empty line or the end of the listing. That
 * last shape is caught by the block rule: every block git prints
 * carries a second line (`bare` or `HEAD`), so a block that ends after
 * its `worktree` line alone is a path cut short, never a worktree.
 * Each of these refuses the WHOLE listing, naming the line, rather
 * than reading it as two paths, as a shorter one, or as a path plus a
 * phantom block that a later line then starts. Exported for `doctor`,
 * which runs the same fallback through its own synchronous spawn. */
export function parseWorktreeListLines(stdout: string): ParsedWorktreeList {
  const paths: string[] = [];
  const lines = stdout.split("\n");
  // -1 between blocks: the next line must be a `worktree` line.
  let lastOrder = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) {
      if (lastOrder === 0) {
        return {
          ok: false,
          detail: `line ${i} is a worktree path with nothing after it in its block`,
        };
      }
      lastOrder = -1;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const order = PORCELAIN_LINE_ORDER[key];
    if (order === undefined) {
      return {
        ok: false,
        detail: `line ${i + 1} is not a porcelain attribute`,
      };
    }
    if (lastOrder === -1 && order !== 0) {
      return {
        ok: false,
        detail: `line ${i + 1} starts a block with ${key} instead of a worktree path`,
      };
    }
    if (lastOrder !== -1 && order <= lastOrder) {
      return {
        ok: false,
        detail: `line ${i + 1} carries ${key} out of the porcelain attribute order`,
      };
    }
    lastOrder = order;
    if (key === "worktree") paths.push(line.slice("worktree ".length));
  }
  if (lastOrder === 0) {
    return {
      ok: false,
      detail: `line ${lines.length} is a worktree path with nothing after it in its block`,
    };
  }
  return { ok: true, paths };
}

/** What `rejectsOption` reads of a finished git call: the exit status
 * (`null` when the call never ran to an exit) and the captured stderr.
 * `RunArgvResult` fits it, and so does the synchronous spawn `doctor`
 * runs its own listing through. */
export interface GitCallOutcome {
  exitCode: number | null;
  stderr: string;
}

/** True when git rejected an option this call passed, which is how a
 * release older than the one the option first appeared in answers:
 * exit status 129 (git's usage-error status, the same in every locale)
 * or the untranslated `unknown switch`/`unknown option` text. Either
 * signal alone is enough. Any other non-zero exit is a listing that
 * failed for a reason of its own, never one to fall back from: the
 * fallback form would answer for a git that could not list at all. The
 * one copy of this predicate; `doctor` calls it through this export
 * rather than carrying its own. */
export function rejectsOption(result: GitCallOutcome): boolean {
  return (
    result.exitCode !== 0 &&
    (result.exitCode === 129 || /unknown (switch|option)/.test(result.stderr))
  );
}

export interface RegisteredWorktrees {
  /** True when a listing ran and paths were determined, through
   * `git worktree list` (`ok: true` with exit 0, captured whole, and
   * parsed) or, when neither form of that could run to a parse,
   * through the `gitdir-files` fallback below. `paths` is empty (and
   * says nothing) otherwise. A false here means the registry is
   * UNKNOWN, never known to be empty, and `detail` says why. */
  ok: boolean;
  /** Every registered worktree the listing found, the main one first
   * for `nul`/`newline`, each through `resolveDeepestExisting` so a
   * caller can compare it with a path of its own spelling. For
   * `gitdir-files` this never includes the main worktree (see `form`)
   * and never an entry whose target no longer exists on disk (see
   * `goneTargets`): a stale admin entry naming a removed directory
   * must not read as "still registered" to `cleanupWorktree`'s
   * assertion. */
  paths: string[];
  /** Which listing produced `paths`: `nul` for `--porcelain -z`,
   * `newline` for the fallback a git older than
   * `GIT_MIN_VERSION_WORKTREE_LIST_Z` gets, `gitdir-files` for the
   * third source (see `listRegisteredWorktreesViaGitdirFiles`) used
   * when neither `git worktree list` form ran to a parse. Absent when
   * nothing ran to a parse at all. */
  form?: "nul" | "newline" | "gitdir-files";
  /** For `form: "gitdir-files"` when `ok` is true only: every admin
   * entry whose target directory no longer exists on disk, resolved
   * through `resolveDeepestExisting` like `paths`. Kept apart from
   * `paths` rather than folded into it, so a leftover admin entry for a
   * worktree `cleanupWorktree` just removed reads as "gone", not as
   * "still registered". Absent for `nul`/`newline`, when `ok` is
   * false, and when the gitdir-files listing found no such entry. */
  goneTargets?: string[];
  /** Why `ok` is false; for a `gitdir-files` listing, also names any
   * admin entry in `goneTargets` even when that leaves `ok` true (a
   * gone target is fully known, not an error). An admin entry whose
   * `gitdir` file could not be read, was missing, or was empty (a
   * relative path is resolved, never one of these -- see
   * `worktreeDirFromGitdirFile`) makes the WHOLE gitdir-files listing
   * `ok: false`, named here by id and reason: `ok: true` for this form
   * means every entry was read to a parse, so a caller can trust an
   * entry's absence from `paths` to mean it really is gone, never that
   * this source merely could not read it. */
  detail?: string;
  /** The log of the last listing attempted. */
  logPath: string;
  /** The logs of every listing attempted, the rejected `-z` form first
   * when the fallback ran, and the `git rev-parse --git-common-dir`
   * log when the `gitdir-files` fallback ran. */
  logPaths: string[];
}

/** `git worktree list --porcelain -z` for the repository at `root`,
 * logged under `logDir` and registered through `track`, never under an
 * abort signal: this is the cleanup and recovery side (see
 * `cleanupWorktree` for why). When git rejects `-z` (a release older
 * than `GIT_MIN_VERSION_WORKTREE_LIST_Z`), the newline-separated
 * `--porcelain` listing runs instead and is parsed by
 * `parseWorktreeListLines`. A listing that fails for any other reason,
 * or whose fallback fails or does not parse, is reported as not ok:
 * unknown, which the callers treat as "could not check", never as
 * "nothing registered" and never as "still registered". */
async function listRegisteredWorktreesViaGit(
  root: string,
  logDir: string,
  track: TrackGitCall,
): Promise<RegisteredWorktrees> {
  const list = (args: string[]): Promise<RunArgvResult> =>
    trackGit(
      track,
      gitArgv(args, logDir, `worktree-list-${randomUUID()}.log`, root),
    );
  const resolveAll = (paths: string[]): string[] =>
    paths.map((p) => resolveDeepestExisting(path.resolve(p)));
  const logPaths: string[] = [];

  const nul = await list(["worktree", "list", "--porcelain", "-z"]);
  logPaths.push(nul.logPath);
  if (nul.exitCode === 0 && !nul.outputTruncated) {
    return {
      ok: true,
      paths: resolveAll(parseWorktreeListZ(nul.stdout)),
      form: "nul",
      logPath: nul.logPath,
      logPaths,
    };
  }
  if (!rejectsOption(nul)) {
    return {
      ok: false,
      paths: [],
      detail: nul.outputTruncated
        ? "the listing was cut short"
        : `git worktree list --porcelain -z exited ${String(nul.exitCode)}`,
      logPath: nul.logPath,
      logPaths,
    };
  }

  const newline = await list(["worktree", "list", "--porcelain"]);
  logPaths.push(newline.logPath);
  if (newline.exitCode !== 0 || newline.outputTruncated) {
    return {
      ok: false,
      paths: [],
      detail: newline.outputTruncated
        ? "git rejected -z and the newline-separated listing was cut short"
        : `git rejected -z and git worktree list --porcelain exited ${String(newline.exitCode)}`,
      logPath: newline.logPath,
      logPaths,
    };
  }
  const parsed = parseWorktreeListLines(newline.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      paths: [],
      form: "newline",
      detail: `git rejected -z and the newline-separated listing could not be parsed (${parsed.detail})`,
      logPath: newline.logPath,
      logPaths,
    };
  }
  return {
    ok: true,
    paths: resolveAll(parsed.paths),
    form: "newline",
    logPath: newline.logPath,
    logPaths,
  };
}

/** Resolves one admin entry's `gitdir` file content (`raw`, as read
 * from disk, untrimmed) to the worktree directory it names. `gitdir`
 * names the linked worktree's own `.git` FILE, one level below the
 * worktree itself, so the worktree directory is that file's own
 * `path.dirname`. Git writes this file as an ABSOLUTE path by default;
 * under `worktree.useRelativePaths` (git >= 2.48) it writes every
 * `gitdir` file relative to the admin entry's OWN directory instead
 * (`adminEntryDir`, e.g. `<git-common-dir>/worktrees/<id>`) -- git's
 * own resolution semantics for this file, never the calling process's
 * `cwd`, which a plain `path.resolve` would otherwise pick up by
 * accident. Shared by `listRegisteredWorktreesViaGitdirFiles` and
 * `removeHalfWrittenAdminEntry`, which both read this same file, so
 * relative content is resolved the same way in both places (before
 * this helper existed, `removeHalfWrittenAdminEntry` also assumed an
 * absolute path and so never matched an entry written under that
 * config). Returns `undefined` for empty or whitespace-only content --
 * nothing to resolve -- never a throw. Also `undefined` when the
 * resolved content does not actually name a `.git` FILE: git always
 * writes this file as `<worktree>/.git`, so a resolved path whose
 * basename is not `.git`, or whose directory resolves back to
 * `adminEntryDir` itself (the shape junk content like a stray word
 * takes once resolved relative to the admin entry's own directory --
 * `path.dirname` of `<adminEntryDir>/<junk>` is `adminEntryDir`), is
 * never a real worktree, so the caller must treat it the same as an
 * unreadable entry rather than list it as a registered one. This is
 * stricter than git's own reader, which also accepts content without
 * the `/.git` suffix and takes it as the worktree path itself; such a
 * hand-written entry makes this source report the listing as not ok
 * (the fallback errs toward "unverified", never toward guessing a
 * worktree path). Every git release writes `<worktree>/.git`. */
function worktreeDirFromGitdirFile(
  adminEntryDir: string,
  raw: string,
): string | undefined {
  const gitdir = raw.trim();
  if (gitdir.length === 0) return undefined;
  const absoluteGitdir = path.isAbsolute(gitdir)
    ? gitdir
    : path.resolve(adminEntryDir, gitdir);
  if (path.basename(absoluteGitdir) !== ".git") return undefined;
  const worktreeDir = path.dirname(absoluteGitdir);
  if (worktreeDir === adminEntryDir) return undefined;
  return worktreeDir;
}

/** The third listing source: `<git-common-dir>/worktrees/<id>/gitdir`
 * read directly, with no `git worktree list` invocation at all, so it
 * still answers when that command is broken outright (any exit status,
 * any option) rather than only when it rejects `-z`. `gitdir` names the
 * linked worktree's own `.git` FILE, resolved to the worktree directory
 * through `worktreeDirFromGitdirFile` (which also handles a relative
 * `gitdir` file -- see that function). Two things this source cannot do
 * that `git worktree list` can: it never names the MAIN worktree (git's
 * admin directory carries no entry for it -- only a linked worktree
 * gets one), and it does not know whether an entry is locked or
 * prunable, so an admin entry `git worktree prune` would clear is
 * listed the same as a live one, UNLESS its target directory is
 * already gone, in which case it is reported apart, in `goneTargets`,
 * rather than folded into `paths` as though it were still there: a
 * stale entry naming a target `cleanupWorktree` just removed must read
 * as "not registered", never as "still registered".
 *
 * An entry whose `gitdir` file is missing, unreadable, empty, or
 * otherwise fails to resolve to a worktree directory makes the WHOLE
 * listing `ok: false` (never a silent drop from an otherwise `ok: true`
 * result): `ok: true` for this form means every admin entry was read,
 * so a caller can trust an entry's ABSENCE from `paths` to mean it
 * really is gone, not merely that this source could not read it. Such
 * an entry is still named, by id and reason, in `detail`, so a caller
 * that only logs the failure still has something concrete to report. A
 * RELATIVE `gitdir` file is no longer one of these odd cases -- it is
 * resolved (see `worktreeDirFromGitdirFile`), not rejected.
 *
 * Returns `undefined` when even this cannot run: `git rev-parse
 * --git-common-dir` itself failed (see `worktreeAdminDir`), or the
 * resulting directory cannot be read at all. The registry is then
 * truly unknown, and the caller (`listRegisteredWorktrees`) reports
 * its own `git worktree list` failure instead of this one. */
async function listRegisteredWorktreesViaGitdirFiles(
  root: string,
  logDir: string,
  track: TrackGitCall,
): Promise<RegisteredWorktrees | undefined> {
  const admin = await worktreeAdminDir(root, logDir, track);
  const logPaths = [admin.logPath];
  if (admin.dir === undefined) return undefined;
  let ids: string[];
  try {
    ids = fs.readdirSync(admin.dir);
  } catch {
    return undefined;
  }
  const paths: string[] = [];
  const goneTargets: string[] = [];
  const odd: string[] = [];
  for (const id of ids) {
    const entryDir = path.join(admin.dir, id);
    const gitdirFile = path.join(entryDir, "gitdir");
    let raw: string;
    try {
      raw = fs.readFileSync(gitdirFile, "utf8");
    } catch (err) {
      odd.push(
        `${id}: gitdir file could not be read (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    const worktreeDir = worktreeDirFromGitdirFile(entryDir, raw);
    if (worktreeDir === undefined) {
      odd.push(
        raw.trim().length === 0
          ? `${id}: gitdir file is empty`
          : `${id}: gitdir file does not name a .git file`,
      );
      continue;
    }
    const resolved = resolveDeepestExisting(worktreeDir);
    if (fs.existsSync(worktreeDir)) {
      paths.push(resolved);
    } else {
      goneTargets.push(resolved);
    }
  }
  const detailParts: string[] = [];
  if (odd.length > 0) {
    detailParts.push(
      `${String(odd.length)} admin ${odd.length === 1 ? "entry" : "entries"} ` +
        `could not be read as a gitdir file: ${odd.join("; ")}`,
    );
  }
  if (goneTargets.length > 0) {
    detailParts.push(
      `${String(goneTargets.length)} admin ${goneTargets.length === 1 ? "entry names" : "entries name"} ` +
        `a target that no longer exists on disk: ${goneTargets.join(", ")}`,
    );
  }
  // `ok: true` for this form means every admin entry was read to a
  // parse: any entry this source could not read at all (`odd`) leaves
  // the registry only PARTIALLY known, which must not be reported the
  // same as a fully known, merely smaller, one -- a caller (notably
  // `cleanupWorktree`'s post-removal assertion) that took an empty or
  // short `paths` at face value here would misread a leftover admin
  // entry this source simply could not read as "not registered". A
  // `goneTargets` entry is not one of these: its target is fully known
  // (resolved and confirmed gone), just reported apart from `paths`.
  const ok = odd.length === 0;
  return {
    ok,
    paths: ok ? paths : [],
    form: "gitdir-files",
    ...(ok && goneTargets.length > 0 ? { goneTargets } : {}),
    ...(detailParts.length > 0 ? { detail: detailParts.join("; ") } : {}),
    logPath: admin.logPath,
    logPaths,
  };
}

/**
 * Every registered worktree of the repository at `root`: `git worktree
 * list --porcelain -z` (falling back to the newline-separated form on a
 * git older than `GIT_MIN_VERSION_WORKTREE_LIST_Z`, see
 * `listRegisteredWorktreesViaGit`), and, only when NEITHER of those ran
 * to a parse, the `gitdir-files` third source (see
 * `listRegisteredWorktreesViaGitdirFiles`): a dead listing -- git
 * itself broken, not merely an option it rejects -- no longer leaves a
 * caller with nothing but the disk to judge a leftover by. The
 * fallback lists linked worktrees only: the main worktree carries no
 * admin entry, so a caller comparing `paths` against the repository
 * root itself must not read its absence as "not registered" (see
 * `cleanupWorktree`, which is already gated against the main worktree
 * by its own `mainWorktree` check on the `nul`/`newline` forms and
 * never relies on this form for that). When the fallback cannot run
 * either, the original `git worktree list` failure is what `ok`,
 * `form`, and `detail` report; the fallback's own inability to help is
 * not itself surfaced as a separate error.
 */
export async function listRegisteredWorktrees(
  root: string,
  logDir: string,
  opts: { track?: TrackGitCall } = {},
): Promise<RegisteredWorktrees> {
  const track: TrackGitCall = opts.track ?? ((started) => started);
  const viaGit = await listRegisteredWorktreesViaGit(root, logDir, track);
  if (viaGit.ok) return viaGit;
  const viaGitdir = await listRegisteredWorktreesViaGitdirFiles(
    root,
    logDir,
    track,
  );
  if (viaGitdir === undefined) return viaGit;
  return {
    ...viaGitdir,
    logPaths: [...viaGit.logPaths, ...viaGitdir.logPaths],
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
 * own `.git` file and `locked` is present, but `commondir` exists and
 * is empty (git creates the file before it writes the content). An
 * absent `commondir` is harmless, since git then falls back to the
 * main repository; only an existing empty one breaks git: `list`,
 * `remove`, and `unlock` all die reading it, and `locked` is what keeps
 * `prune` from clearing the entry, so every `git worktree` command in
 * the repository fails until the entry is gone, and nothing short of
 * deleting it clears it. Only an entry naming the already-gated
 * `target` is ever touched: `gitdir` is resolved through the same
 * `worktreeDirFromGitdirFile` the listing above uses, so an entry
 * written under `worktree.useRelativePaths` (a relative `gitdir` file)
 * matches here too, not only an absolute one. Returns true when one
 * was removed. */
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
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(entry, "gitdir"), "utf8");
    } catch {
      continue;
    }
    const worktreeDir = worktreeDirFromGitdirFile(entry, raw);
    if (worktreeDir === undefined) continue;
    if (!fs.existsSync(path.join(entry, "locked"))) continue;
    let commondirBytes: number;
    try {
      commondirBytes = fs.statSync(path.join(entry, "commondir")).size;
    } catch {
      continue;
    }
    if (commondirBytes > 0) continue;
    if (resolveDeepestExisting(worktreeDir) !== target) continue;
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
  /** The CURRENT run's own `--log-dir`, never a directory read from a
   * marker: a marker names both the path and, if it were trusted for
   * this, the root that path is to be checked against, which would let
   * the marker certify itself. A path git does not report as a
   * registered worktree of the repository is deleted only when it is of
   * the scratch shape AND sits under this directory; omitted, only a
   * registered scratch worktree can be removed. */
  scratchRoot?: string;
}

export interface CleanupWorktreeResult {
  /** True only when the path is gone: with `verified`, `git worktree
   * list` no longer reports it AND nothing is left of it on disk, an
   * assertion of the outcome rather than an inference from a git exit
   * code; without `verified`, nothing is left on disk, judged by the
   * disk alone, the one check left when the listing cannot run at all.
   * `git worktree remove`'s exit status decides nothing either way: it
   * is non-zero for a path that was never registered, which is exactly
   * the leftover an add killed early leaves. */
  ok: boolean;
  /** True when the listing ran after the removal, so `ok` was asserted
   * against git's own registry. False when it could not run in any form
   * and `ok` rests on the disk check alone; `detail` then says so even
   * for an `ok` result, for the caller's warning. */
  verified: boolean;
  /** True when the path failed the gate below and nothing at all was
   * run against it. */
  refused: boolean;
  /** Why `ok` is false, or why an `ok` result is unverified; also set
   * on an `ok: true`, `verified: true` result when the `gitdir-files`
   * listing found the target's admin entry still on disk in
   * `goneTargets` (the target itself is gone, but `git worktree prune`
   * has not cleared its registration yet), so a caller can still surface
   * that survivor even though the removal itself is a clean success. */
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
 * same path, and the prune and the assertion run again. When the
 * listing still cannot run in any form (see `listRegisteredWorktrees`),
 * the registry is unknown rather than "still registered": `ok` then
 * rests on the disk check alone (never on `remove`'s exit status,
 * which is non-zero for a path git never registered), `verified` is
 * false, and `detail` says so, so the caller can report the outcome as
 * unverified instead of reporting a removal that took as one that did
 * not.
 *
 * Nothing is run against the path before it passes a gate, because the
 * path can come from a marker file, not only from this process's own
 * `beginWorktree`: it must be of the scratch shape (see
 * `isScratchWorktreePath`), never the repository root or its main
 * worktree, not owned by another live process (see
 * `liveForeignOwner`), and either reported by `git worktree list` as a
 * worktree of this repository before the removal, or contained
 * (through realpath) in `scratchRoot`, the current run's own log dir.
 * Any other path is refused, and so is one whose registration could
 * not be checked and that is not under that log dir: neither git nor
 * the recursive delete touches it, and the result says so, so the
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
  logPaths.push(...before.logPaths);
  const registeredBefore = before.ok && before.paths.includes(target);
  // `paths[0]` is the main worktree only for `nul`/`newline`, which list
  // it first; `gitdir-files` never carries an entry for the main
  // worktree at all (see `RegisteredWorktrees.form`), so its first
  // entry is just some linked worktree, never one to compare `target`
  // against as "the main worktree". `rootReal` below is what actually
  // gates the repository root either way.
  const mainWorktree =
    before.ok && before.form !== "gitdir-files" ? before.paths[0] : undefined;
  const contained =
    opts.scratchRoot !== undefined &&
    isPathContained(
      resolveDeepestExisting(path.resolve(opts.scratchRoot)),
      target,
    );
  const foreignOwner = liveForeignOwner(target);
  let refusal: string | undefined;
  if (!isScratchWorktreePath(target)) {
    refusal =
      "it is not of the probe's own scratch shape (<log-dir>/wt-<uuid>/wt)";
  } else if (target === rootReal || target === mainWorktree) {
    refusal = "it is the repository itself";
  } else if (foreignOwner !== undefined) {
    refusal = `a live probe (pid ${foreignOwner}) owns it`;
  } else if (!registeredBefore && !contained) {
    const registration = before.ok
      ? "git does not report it as a worktree of this repository"
      : `git worktree list could not run (${before.detail ?? "unknown"}), so its registration could not be checked`;
    refusal =
      opts.scratchRoot === undefined
        ? registration
        : `${registration}, and it is not under this run's log dir ${opts.scratchRoot}`;
  }
  if (refusal !== undefined) {
    return {
      ok: false,
      verified: false,
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

  let afterGit = await listRegisteredWorktreesViaGit(root, logDir, track);
  logPaths.push(...afterGit.logPaths);
  if (!afterGit.ok) {
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
      afterGit = await listRegisteredWorktreesViaGit(root, logDir, track);
      logPaths.push(...afterGit.logPaths);
    }
  }
  // The half-written-entry repair above always gets its chance against
  // the real `git worktree list` failure first, whether or not the
  // gitdir-files fallback below could also verify the outcome: the
  // repair fixes git's own admin state for every future listing on
  // this repository, which the fallback (a read, never a write) cannot
  // do. Only a listing still broken after that falls further back to
  // the third source.
  let after: RegisteredWorktrees = afterGit;
  if (!afterGit.ok) {
    const viaGitdir = await listRegisteredWorktreesViaGitdirFiles(
      root,
      logDir,
      track,
    );
    if (viaGitdir !== undefined) {
      logPaths.push(...viaGitdir.logPaths);
      after = viaGitdir;
    }
  }
  const stillOnDisk = fs.existsSync(worktreePath);
  if (after.ok) {
    const stillRegistered = after.paths.includes(target);
    const ok = !stillRegistered && !stillOnDisk;
    // A `gitdir-files` listing keeps a gone target apart from `paths`
    // (see `RegisteredWorktrees.goneTargets`), so `stillRegistered` is
    // false for it and `ok` above reads as a clean removal; but the
    // ADMIN ENTRY itself is still on disk (git's own `remove`/`prune`
    // could not clear it -- the very reason this fallback listing was
    // needed at all), so the outcome, while correctly `ok`, is worth a
    // `detail` naming that survivor rather than none at all: a future
    // `git worktree prune` on this repository clears it once `git
    // worktree list` works again.
    const staleAdminEntry =
      ok &&
      after.form === "gitdir-files" &&
      (after.goneTargets?.includes(target) ?? false);
    const detail = ok
      ? staleAdminEntry
        ? `its admin entry under this repository's worktrees directory ` +
          `still exists (git worktree prune could not clear it); a future ` +
          `git worktree prune on this repository clears it`
        : undefined
      : stillRegistered
        ? `git still reports it as a worktree after the removal; see ${removeResult.logPath}`
        : "something is still on disk at the path after the removal";
    return {
      ok,
      verified: true,
      refused: false,
      ...(detail !== undefined ? { detail } : {}),
      logPaths,
    };
  }
  // The registry is unknown, not "still registered": the outcome rests
  // on the disk alone, the one check left, and is reported as
  // unverified either way so the caller never presents it as asserted.
  // `remove`'s exit status is not consulted: it is non-zero for a path
  // git never registered (an add killed before it registered anything,
  // or a marker naming such a path), and demanding 0 here would report
  // that leftover as not removed after its directory is gone, with no
  // command left that could remove it any further.
  const listingFailed = `git worktree list could not run after the removal (${after.detail ?? "unknown"}; see ${after.logPath})`;
  const ok = !stillOnDisk;
  const detail = ok
    ? `${listingFailed}, so the removal is unverified: the directory is gone; the registration could not be checked`
    : `${listingFailed}, and something is still on disk at the path`;
  return {
    ok,
    verified: false,
    refused: false,
    detail,
    logPaths,
  };
}
