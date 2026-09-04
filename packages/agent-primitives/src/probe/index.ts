import fs from "node:fs";
import path from "node:path";
import {
  execCommand,
  stdioWatchBoundMs,
  type ExecOptions,
  type ExecResult,
} from "../exec.js";
import { sha256File } from "../hash.js";
import {
  acquireLock,
  markerFilePathFor,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
} from "../lock.js";
import {
  findGitRoot,
  isPathContained,
  resolveDeepestExisting,
} from "./containment.js";
import {
  beginInplace,
  beginWorktree,
  cleanupWorktree,
  isScratchWorktreePath,
  listRegisteredWorktrees,
  liveForeignOwner,
  type InplaceSession,
  type WorktreeSyncSuccess,
} from "./isolation.js";
import {
  applyPatchForReal,
  computeMutant,
  DEFAULT_GIT_APPLY_TIMEOUT_MS,
  formatMutantSummary,
  formatVerifiedAppliedVia,
  listPatchTouchedPaths,
  PATCH_MAX_BYTES,
  type MutantComputed,
  type MutantForm,
  type MutantSpec,
} from "./mutant.js";
import type { PlanMutantSpec } from "./plan.js";

export type IsolationMode = "worktree" | "inplace";
export type ExpectVerdict = "fail" | "pass";

export interface ProbeOptions {
  /** As given on the CLI; resolved against `cwd`. Optional only for
   * `form: "patch"`: when omitted, derived from the single path the
   * patch touches (`git apply --numstat`), resolved against the
   * containment root. Every other form still requires it. */
  file?: string;
  /** 1-indexed line number of the line to mutate. Required for every
   * form except `patch`, whose line is decided by the patch itself: the
   * reported `mutant.line` is always the first line the applied diff
   * changes, and a `line` passed alongside `form: "patch"` is neither
   * used nor echoed -- when it names a different line, that disagreement
   * is reported as a warning. */
  line?: number;
  form: MutantForm;
  replaceText?: string;
  matchText?: string;
  withText?: string;
  patchPath?: string;
  testCommand: string;
  preCommand?: string;
  isolation: IsolationMode;
  expect: ExpectVerdict;
  /** Timeout in milliseconds, applied to every `--pre`/`-t` invocation
   * and to every `git apply` the `patch` form runs. Omitted, the
   * commands run unbounded and `git apply` keeps
   * `DEFAULT_GIT_APPLY_TIMEOUT_MS`. */
  timeoutMs?: number;
  links?: string[];
  allowOutside?: boolean;
  cwd: string;
  logDir: string;
  /**
   * Whether the SIGINT/SIGTERM handler ends the host process once it has
   * killed the in-flight child, waited for that run to settle, restored
   * the target and released the lock. `true` is right for the
   * CLI, where this call owns the process and the signal means "stop
   * now"; the default `false` is right for a library caller, whose
   * process must not be terminated by a function it called. With `false`
   * the handler still does the emergency restore and lock release, and
   * the pipeline then unwinds normally through its own restore points
   * (restoring an already-restored target from the same backup is a
   * no-op that still verifies).
   */
  exitOnSignal?: boolean;
}

export interface MutantField {
  file: string;
  line: number;
  before: string;
  after: string;
  form: MutantForm;
}

export interface MutationProbeField {
  mutant: string;
  verified_applied_via: string;
  result: string;
  restored_verified: boolean;
}

export interface ExecPhaseField {
  exitCode: number | null;
  durationMs: number;
  logPath: string;
  /** True when this phase's own run hit `--timeout`, so a killed
   * baseline (never a red/failing one) is distinguishable from a
   * genuinely failing baseline; both still classify as `baseline_failed`
   * (a non-zero exit either way), but this field tells the two apart. */
  timedOut: boolean;
}

export interface TestPhaseField extends ExecPhaseField {
  command: string;
  stdoutTail: string;
  stderrTail: string;
}

export interface IsolationField {
  mode: IsolationMode;
  path: string | null;
  linked: string[];
  syncedTrackedFiles: number;
  syncedUntrackedFiles: number;
}

export type ProbeStatus =
  "killed" | "survived" | "inconclusive" | "usage_error";

export interface ProbeResult {
  status: ProbeStatus;
  reason?: string;
  warnings: string[];
  mutant?: MutantField;
  mutation_probe?: MutationProbeField;
  baseline?: ExecPhaseField;
  test?: TestPhaseField;
  isolation: IsolationField;
  /** Exec log paths produced while computing the mutant (the dry-run
   * `git apply` and `--numstat` check for `patch`; empty otherwise).
   * The caller (`cli.ts`) folds this together with `baseline`/`test`'s
   * own `logPath` into the envelope's `logs`. */
  dryRunLogPaths?: string[];
}

function emptyIsolationField(mode: IsolationMode): IsolationField {
  return {
    mode,
    path: null,
    linked: [],
    syncedTrackedFiles: 0,
    syncedUntrackedFiles: 0,
  };
}

/** Restores `session` and verifies the restore by hash. A restore whose
 * copy itself throws is treated the same as a restore that copies but
 * lands on the wrong content: both fail `verified`. Takes only the two
 * fields it uses, so the signal handler can call it with a
 * `RestoreState` and both paths go through the same restore-then-hash
 * rather than each rolling its own. */
async function restoreAndVerify(
  session: Pick<InplaceSession, "restore" | "targetPath">,
  preHash: string,
): Promise<{ ok: boolean; verified: boolean }> {
  let ok = false;
  try {
    ok = session.restore();
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, verified: false };
  const restoredHash = await sha256File(session.targetPath).catch(
    () => undefined,
  );
  return { ok: true, verified: restoredHash === preHash };
}

interface RestoreState {
  /** The same `InplaceSession.restore` used by the normal (non-signal)
   * control flow: the signal path must reuse it rather than duplicate
   * the copy logic, so a bug in the restore implementation breaks both
   * paths identically (and is caught by mutating just the one place). */
  restore: () => boolean;
  /** The file's path as seen by `session.restore()`/hashing (the
   * display path, not necessarily the resolved realpath used for the
   * lock/marker key). */
  targetPath: string;
  /** The identity used to key the marker (the resolved realpath), so an
   * emergency restore removes the same marker the normal flow would. */
  markerKey: string;
  backupPath: string;
  preHash: string;
}

const DEFAULT_SIGNAL_SETTLE_BOUND_MS = 2000;

/** How long the signal handler waits for the child it just killed to
 * actually settle before it restores anyway. A `SIGKILL`ed process group
 * is gone in milliseconds, so this is only ever reached when something
 * put itself out of the group's reach; restoring under it is still
 * better than leaving the target mutated, and the restore is verified by
 * hash either way.
 *
 * Overridable via `AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS`, an
 * internal test seam (undocumented, not a CLI flag): a real test of the
 * past-the-bound path needs an out-of-group writer that outlives the
 * bound, and shortening the bound itself keeps that test in
 * milliseconds instead of seconds. Production code never sets it.
 *
 * Whatever the source, the bound always stays below `exec.ts`'s stdio
 * watch bound: past that bound `exec.ts` tears the pipes down itself
 * and reports no close for it, so a settle bound at or beyond it would
 * only wait into a window where no genuine close can arrive any more.
 * Exported only for the unit test of that clamp. */
export function signalSettleBoundMs(): number {
  const ceiling = stdioWatchBoundMs() - 1;
  const override = process.env.AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS;
  if (override !== undefined) {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, ceiling);
    }
  }
  return Math.min(DEFAULT_SIGNAL_SETTLE_BOUND_MS, ceiling);
}

/** What the crash handler's restore attempt found, or `null` when no
 * mutation was in flight (nothing to restore). `closedInTime` says
 * whether the in-flight run's stdio was confirmed truly closed within
 * `signalSettleBoundMs()` before the restore ran: only then is the
 * restore guaranteed to be the last write, so only then does the
 * handler remove the marker. A `false` here with `verified: true` means
 * the target IS back at its pre-mutation content, but the marker (and
 * the backup) are kept anyway, leaving a recovery trail for a write
 * that might still land from whatever never closed. Exported (like
 * `installCrashHandlers` and `CrashHandlers` below) only for the
 * re-entrancy unit test; `probe()` is the only production caller. */
export interface CrashHandlerOutcome {
  verified: boolean;
  closedInTime: boolean;
}

export interface CrashHandlers {
  /** Removes both signal handlers, so concurrent `probe()` calls in the
   * same process never interfere with each other's signal handling. */
  remove: () => void;
  /** True once a signal has been received and the handler has started
   * (and not yet necessarily finished) acting on it. The normal control
   * flow checks this at every point it is about to act on an aborted
   * run, so its own return (or restore) never races the handler's. */
  isHandling: () => boolean;
  /** Resolves once the handler has finished acting: it has attempted a
   * restore if one was in flight (recording the outcome above, or
   * `null` when there was nothing to restore) and released the lock.
   * Settles at most once, the same as the handler itself does. */
  handled: Promise<CrashHandlerOutcome | null>;
}

/**
 * Installs SIGINT/SIGTERM handlers scoped to one `probe()` call, whose
 * whole purpose is that the emergency restore (or, for `worktree`, the
 * worktree removal) is the LAST write this probe makes. In order:
 *
 * 1. `abortInFlight` kills whatever child is currently running (a
 *    `--pre`/`-t` command, or a `git apply`) by `SIGKILL`ing its whole
 *    process group outright. Not `SIGTERM`: a command that traps it
 *    would sit out any grace period, and the escalation timer that would
 *    eventually reach it dies with this process.
 * 2. `waitForInFlight` waits (bounded by `signalSettleBoundMs()`) for
 *    that child's run to truly close its stdio, which is also once
 *    every write it had in flight has landed -- not merely for its
 *    promise to settle, which can happen earlier (see `exec.ts`'s
 *    flush-grace shortcut).
 * 3. If a mutation is in flight (per `getRestoreState`, `inplace` only),
 *    the target is restored via the session's own `restore()`. The
 *    marker is removed only when that restore verified AND step 2
 *    confirmed true closure within the bound: a restore that failed, or
 *    one whose "last write" guarantee the bound could not confirm,
 *    leaves the marker (and the backup) for the next invocation to
 *    recover from, or for `doctor` to report.
 * 4. `cleanupWtSession` removes a `worktree` session's detached
 *    worktree through `cleanupWorktree` (the directory itself, then
 *    `git worktree remove --force --force`, then `git worktree prune`,
 *    then an assertion against `git worktree list` and the disk),
 *    releasing the repository-keyed marker only once that assertion
 *    holds; a no-op only when `git worktree add` was never even
 *    started. It waits for the sync to settle first and then removes
 *    whatever stage it reached, so a signal landing while the worktree
 *    is still being synced (or while `git worktree add` itself is
 *    running) is cleaned up the same as one landing after it. The
 *    marker for that worktree is written before the add runs, so even
 *    a cleanup that fails leaves a trail. Best-effort: a failed cleanup
 *    keeps the marker and records a warning naming the path and the
 *    manual command, for the next probe on this repository (or
 *    `doctor`) to act on.
 *
 * The lock is released and the process ended when `exitOnSignal` says
 * to, only once all of the above has settled.
 *
 * A second signal arriving while the first is still being handled is
 * ignored rather than starting a second pass beside the first.
 */
export function installCrashHandlers(
  getRestoreState: () => RestoreState | null,
  releaseLock: () => void,
  abortInFlight: () => void,
  waitForInFlight: () => Promise<boolean>,
  exitOnSignal: boolean,
  cleanupWtSession: () => Promise<void>,
): CrashHandlers {
  let handling = false;
  let resolveHandled:
    ((outcome: CrashHandlerOutcome | null) => void) | undefined;
  const handled = new Promise<CrashHandlerOutcome | null>((res) => {
    resolveHandled = res;
  });
  const handler = (signal: NodeJS.Signals) => {
    if (handling) return;
    handling = true;
    void (async () => {
      try {
        abortInFlight();
      } catch {
        // Best-effort: a failure to abort the in-flight child must never
        // block the restore/lock-release that follows.
      }
      let closedInTime = true;
      try {
        closedInTime = await waitForInFlight();
      } catch {
        // Best-effort, for the same reason; treated as "did not
        // confirm" so the marker-retention path below is the safe one.
        closedInTime = false;
      }
      // Test-only seam (undocumented, not a CLI flag): artificially
      // slows this handler's own restore-then-exit, after the child is
      // already killed and waited for, so a test can force the race
      // this function's mutual exclusion with the normal control flow
      // exists to remove. Production code never sets it; the delay
      // lands after `abortInFlight`/`waitForInFlight` so it never
      // widens the window a real signal handler leaves the target
      // mutated for.
      const testDelayMs = Number(
        process.env.AGENT_PRIMITIVES_TEST_HANDLER_DELAY_MS ?? "0",
      );
      if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, testDelayMs));
      }
      const state = getRestoreState();
      let outcome: CrashHandlerOutcome | null = null;
      if (state) {
        // `restoreAndVerify` is the same restore-then-hash the normal
        // control flow uses: the marker is removed only for a restore
        // that is verified to have landed on the pre-mutation content
        // AND that step 2 confirmed was truly the last write, so a
        // restore that failed, wrote the wrong bytes, or could not be
        // confirmed as final leaves the marker for the next invocation
        // (or `doctor`) to act on.
        const { verified } = await restoreAndVerify(
          { restore: state.restore, targetPath: state.targetPath },
          state.preHash,
        );
        outcome = { verified, closedInTime };
        if (verified && closedInTime) removeMarkerFor(state.markerKey);
      }
      try {
        await cleanupWtSession();
      } catch {
        // Best-effort: a failed worktree cleanup leaves the
        // repository-keyed marker in place, which is exactly what lets
        // the next probe on this repository (or `doctor`) recover it.
      }
      try {
        releaseLock();
      } catch {
        // Best-effort.
      }
      resolveHandled?.(outcome);
      if (exitOnSignal) process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    remove: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
    isHandling: () => handling,
    handled,
  };
}

/**
 * Called at every point the normal control flow has just detected that
 * a phase's run was aborted, before it acts on that (restoring, or
 * returning). When this probe's own signal handler is the one that
 * caused the abort (`crashHandlers.isHandling()`), the normal flow must
 * not race the handler's own restore-then-exit (the CLI would otherwise
 * print an envelope and exit 2 while the handler is about to exit 130 or
 * 143 with no output). Returns `undefined` when the handler is NOT
 * active (the abort came from somewhere else, e.g. a caller's own
 * `AbortSignal`), telling the caller to keep its existing behavior
 * unchanged.
 *
 * In CLI mode (`exitOnSignal`), this call never returns when the
 * handler is active: it awaits a promise nothing ever resolves, so the
 * only way out is the handler's own `process.exit`, which happens
 * before this process is ever given the chance to build and print an
 * envelope the handler is about to make moot. In library mode, it
 * awaits the handler's own outcome and returns that, so the caller
 * skips a second, redundant restore against a target the handler has
 * already (and authoritatively) restored.
 */
async function deferToHandlerIfActive(
  crashHandlers: CrashHandlers,
  exitOnSignal: boolean,
): Promise<CrashHandlerOutcome | null | undefined> {
  if (!crashHandlers.isHandling()) return undefined;
  if (exitOnSignal) {
    await new Promise<never>(() => {
      // Deliberately never resolves: only the handler's own
      // `process.exit` ends this process from here.
    });
  }
  return crashHandlers.handled;
}

/** Records, as a warning, that a phase's captured output may be missing
 * whatever was still in flight when the run settled: the command had
 * exited but something it spawned still held its stdout/stderr open, so
 * `exec.ts` settled on its flush grace rather than waiting on the pipes.
 * The exit code (and therefore the verdict) is unaffected; only the
 * tails and the log file are. */
function noteIncompleteOutput(
  warnings: string[],
  phase: string,
  result: ExecResult,
): void {
  if (!result.outputMayBeIncomplete) return;
  warnings.push(
    `${phase}: the command exited while something it spawned still held its output pipes open; the captured output may be incomplete (see ${result.logPath})`,
  );
}

type RunPhaseResult =
  { ok: true; test: ExecResult } | { ok: false; pre: ExecResult };

/** A started run together with `closed`: a promise that resolves once
 * that run's stdio has TRULY closed, which can be later than the run's
 * own promise settling (`exec.ts`'s flush-grace shortcut) or, for a
 * `runArgv`-based call, exactly when it settles (see `run.ts`'s own
 * docblock: it never takes that shortcut). The signal handler waits on
 * `closed`, not on `result`, so its restore is guaranteed to be the
 * last write only once `closed` is confirmed within its bound. */
interface TrackedRun<T> {
  result: Promise<T>;
  closed: Promise<void>;
}

/** Starts `cmd` through `execCommand`, wiring its `onStdioClosed` hook
 * into `closed` above. A rejected run (the child could not even be
 * spawned) settles `closed` too: there is no child left to wait on. */
function startExecTracked(
  cmd: string,
  options: ExecOptions,
): TrackedRun<ExecResult> {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((res) => {
    resolveClosed = res;
  });
  const result = execCommand(cmd, {
    ...options,
    onStdioClosed: () => resolveClosed?.(),
  });
  result.catch(() => resolveClosed?.());
  return { result, closed };
}

/** Wraps an already-started `runArgv`-based call (every `git apply`):
 * `run.ts` only ever settles on `close` (see its own docblock), so the
 * call's own settling already IS true stdio closure; `closed` just
 * mirrors it instead of needing its own callback wiring. */
function startRunArgvTracked<T>(started: Promise<T>): TrackedRun<T> {
  return {
    result: started,
    closed: started.then(
      () => undefined,
      () => undefined,
    ),
  };
}

/** Runs `--pre` (if given) then the test command, both against `env`.
 * A non-zero `--pre` exit short-circuits before the test ever runs, so
 * the caller can classify it as `pre_failed` instead of quietly letting
 * a stale build (or any other `--pre` failure) produce a false verdict. */
async function runPreThenTest(
  opts: Pick<ProbeOptions, "preCommand" | "testCommand">,
  env: {
    cwd: string;
    logDir: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
  /** Registers each started run (and when its stdio truly closes) as
   * the probe's one in-flight child, so the signal handler can wait for
   * it to settle before restoring. */
  track: <T>(started: Promise<T>, closed: Promise<void>) => Promise<T>,
): Promise<RunPhaseResult> {
  if (opts.preCommand) {
    const started = startExecTracked(opts.preCommand, env);
    const pre = await track(started.result, started.closed);
    if (pre.exitCode !== 0) return { ok: false, pre };
  }
  const started = startExecTracked(opts.testCommand, env);
  const test = await track(started.result, started.closed);
  return { ok: true, test };
}

/** Registers a started run (and when its stdio truly closes) as the
 * probe's one in-flight child; see `TrackedRun` and `probe`'s own
 * `track`. */
type TrackFn = <T>(started: Promise<T>, closed: Promise<void>) => Promise<T>;

/** The signal-, abort- and worktree-cleanup machinery one probe run
 * owns, whether that run applies one mutant or a whole plan: the
 * handler's restore slot, the in-flight child tracking the handler waits
 * on, and the once-only worktree cleanup every exit path funnels
 * through. */
interface RunController {
  /** Scopes every child this run starts: the `--pre`/`-t` commands
   * through `exec.ts` and every `git apply` through `run.ts`. The
   * SIGINT/SIGTERM handler aborts it before restoring, which SIGKILLs
   * that child's whole process group, so an emergency restore never
   * races a process still running against (and possibly still writing)
   * the target file. */
  execController: AbortController;
  track: TrackFn;
  crashHandlers: CrashHandlers;
  /** Removes this run's worktree, at most once however many callers
   * (the pipeline's `finally`, the signal handler) reach it. */
  cleanupWtSession: () => Promise<void>;
  /** The slot the signal handler reads: the restore state of whatever
   * mutation is in flight RIGHT NOW, or `null` when none is. */
  setRestoreState: (state: RestoreState | null) => void;
  getRestoreState: () => RestoreState | null;
  /** Handed to `beginWorktree` as `onWorktreeAttempt`: records the path
   * and writes the repository-keyed marker before `git worktree add`
   * runs. */
  noteWorktreeAttempt: (worktreePath: string) => void;
  /** The promise that settles once `beginWorktree` has returned, however
   * it returned; the cleanup waits for it before removing anything. */
  setSyncSettled: (settled: Promise<void>) => void;
}

function createRunController(input: {
  realRoot: string;
  logDir: string;
  wtScratchRoot: string;
  exitOnSignal: boolean;
  releaseLock: () => void;
  warnings: string[];
}): RunController {
  const { realRoot, logDir, wtScratchRoot, warnings } = input;
  let restoreState: RestoreState | null = null;
  // The worktree's path, set as soon as `git worktree add` is ABOUT to
  // create it (not once it succeeded) and read by `finally`/the signal
  // handler to clean it up on every exit path: an add interrupted
  // partway can leave a registered worktree, and cleanup needs the path
  // to remove it.
  let wtWorktreePath: string | undefined;
  // Settles when `beginWorktree` has returned, however it returned. The
  // sync writes into the worktree (the tracked-diff apply, the
  // untracked-file copy), so a cleanup that started while the sync was
  // still running would be removing a directory another part of this
  // same process is still writing into. Awaited by `cleanupWtSession`
  // below, and bounded in practice by the sync's own abort handling:
  // every git call it makes dies with the abort, and its copy loop
  // checks the abort between batches. The wait matters exactly when
  // that bound does not hold: a sync step that outlives the signal
  // handler's own settle wait (`waitForInFlight` gives up after
  // `signalSettleBoundMs()`) is still waited for here, so the removal
  // never runs underneath a step that is still writing.
  let wtSyncSettled: Promise<void> | undefined;
  // The finally block and the SIGINT/SIGTERM handler can both reach
  // cleanup for the same run (aborting the in-flight test unblocks the
  // main pipeline's own `await` at roughly the same time the handler
  // reaches its own cleanup call): both must resolve to the SAME
  // in-flight promise rather than a flag that lets the second caller
  // return before the first caller's real `git worktree remove`/`prune`
  // has actually finished, which would let the process exit while that
  // work is still running.
  let wtCleanupPromise: Promise<void> | undefined;
  const cleanupWtSession = (): Promise<void> => {
    if (wtCleanupPromise) return wtCleanupPromise;
    if (wtWorktreePath === undefined) return Promise.resolve();
    const worktreePathForCleanup = wtWorktreePath;
    wtCleanupPromise = (async () => {
      await wtSyncSettled;
      const result = await cleanupWorktree(
        realRoot,
        worktreePathForCleanup,
        logDir,
        { track, scratchRoot: wtScratchRoot },
      ).catch((err: unknown) => ({
        ok: false,
        verified: false,
        refused: false,
        detail: err instanceof Error ? err.message : String(err),
        logPaths: [] as string[],
      }));
      if (result.ok) {
        removeMarkerFor(realRoot);
        if (!result.verified || result.detail !== undefined) {
          // Gone as far as could be checked, but not asserted against
          // git's registry: said so, never presented as asserted. A
          // `verified: true` result can still carry a `detail` (a
          // gitdir-files-listed admin entry surviving `git worktree
          // prune`, see `cleanupWorktree`), which is worth surfacing
          // even though the removal itself is a clean success.
          warnings.push(
            `the worktree at ${worktreePathForCleanup} was removed, but ` +
              `${result.detail ?? "the removal could not be verified"}`,
          );
        }
      } else {
        // The marker stays: it is what lets the next probe on this
        // repository, and `doctor`, find the leftover. The manual `git
        // worktree remove` is named only when git could list, so the
        // registration is known; when it could not, that command cannot
        // be relied on either (it fails for a path git never
        // registered), and the marker file is the one escape left.
        const kept =
          `its marker is kept for the next probe on this repository ` +
          `(or \`agent-primitives doctor\`) to act on`;
        warnings.push(
          result.verified
            ? `the worktree at ${worktreePathForCleanup} was not removed ` +
                `(${result.detail ?? "unknown"}); ${kept}; run \`git -C ` +
                `${realRoot} worktree remove --force --force -- ` +
                `${worktreePathForCleanup}\` manually`
            : `the worktree at ${worktreePathForCleanup} was not removed ` +
                `(${result.detail ?? "unknown"}); ${kept}; inspect the path, ` +
                `then delete the marker file to clear it: ` +
                `${markerFilePathFor(realRoot)}`,
        );
      }
    })();
    return wtCleanupPromise;
  };
  const execController = new AbortController();
  // The one child in flight at any moment, as the promise of its run,
  // together with a promise of when its stdio TRULY closes (see
  // `TrackedRun`). The handler waits on the latter, not the former: a
  // run's own promise can settle early (`exec.ts`'s flush-grace
  // shortcut) while a descendant that left the process group still
  // holds the pipes, and only true closure means every write the run
  // had in flight has actually landed.
  let inFlight: Promise<unknown> | null = null;
  let inFlightClosed: Promise<void> | null = null;
  const track = async <T>(
    started: Promise<T>,
    closed: Promise<void>,
  ): Promise<T> => {
    inFlight = started;
    inFlightClosed = closed;
    try {
      return await started;
    } finally {
      if (inFlight === started) {
        inFlight = null;
        inFlightClosed = null;
      }
    }
  };
  /** Waits, bounded by `signalSettleBoundMs()`, for whatever is
   * currently in flight to truly close its stdio. Returns `true` when
   * that closure was confirmed within the bound (or nothing was in
   * flight at all), `false` when the bound expired first: the caller
   * (the signal handler) uses this to decide whether removing the
   * marker is safe. */
  const waitForInFlight = async (): Promise<boolean> => {
    const pendingClosed = inFlightClosed;
    if (pendingClosed === null) return true;
    let timer: NodeJS.Timeout | undefined;
    let closedInTime = false;
    await Promise.race([
      pendingClosed.then(() => {
        closedInTime = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, signalSettleBoundMs());
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return closedInTime;
  };
  const crashHandlers = installCrashHandlers(
    () => restoreState,
    input.releaseLock,
    () => execController.abort(),
    waitForInFlight,
    input.exitOnSignal,
    cleanupWtSession,
  );
  return {
    execController,
    track,
    crashHandlers,
    cleanupWtSession,
    setRestoreState: (state) => {
      restoreState = state;
    },
    getRestoreState: () => restoreState,
    noteWorktreeAttempt: (worktreePath) => {
      wtWorktreePath = worktreePath;
      writeMarker(realRoot, {
        targetPath: worktreePath,
        backupPath: realRoot,
        preHash: "",
        mutatedHash: "",
        pid: process.pid,
        timestamp: new Date().toISOString(),
        scratchRoot: wtScratchRoot,
      });
    },
    setSyncSettled: (settled) => {
      wtSyncSettled = settled;
    },
  };
}

/**
 * The metadata-only usability check every `-p/--patch` path shares,
 * returning the message for a patch that cannot be used at all and
 * `undefined` for one that can.
 *
 * Nothing here opens the file or reads its bytes (`git apply` streams it
 * in a child of its own). That is deliberate. `fs.statSync` cannot block
 * -- querying a FIFO's metadata does not open it -- while an unbounded
 * read of a writer-less FIFO blocks forever (measured: it outlives
 * `SIGTERM` and needs `SIGKILL`), so a FIFO or socket is refused by
 * `isFile()` before anything can wait on it, and an oversized file is
 * refused by its recorded size without being loaded. `statSync` and
 * `accessSync` both follow symlinks (unlike `lstatSync`), so a symlink
 * to a regular readable file is accepted and a symlink to a FIFO or a
 * directory is still rejected by what it resolves to.
 * `accessSync(R_OK)` is what catches a patch whose permissions deny
 * reading, which a `stat` alone cannot see.
 *
 * `label` names the option in the message: `-p/--patch` for the single
 * probe, the plan's own path (`plan.mutants[2].patch`) for a plan.
 */
export function patchUnusableReason(
  patchPath: string,
  label = "-p/--patch",
): string | undefined {
  const absPatchPath = path.resolve(patchPath);
  let patchStat: fs.Stats;
  try {
    patchStat = fs.statSync(absPatchPath);
  } catch {
    return `${label} could not be read: ${absPatchPath}`;
  }
  if (!patchStat.isFile()) {
    return `${label} is not a regular file: ${absPatchPath}`;
  }
  if (patchStat.size > PATCH_MAX_BYTES) {
    return (
      `${label} is ${String(patchStat.size)} bytes, over the ` +
      `${String(PATCH_MAX_BYTES)}-byte cap: ${absPatchPath}`
    );
  }
  try {
    fs.accessSync(absPatchPath, fs.constants.R_OK);
  } catch {
    return `${label} could not be read: ${absPatchPath}`;
  }
  return undefined;
}

/**
 * Recovers (or refuses) an in-flight marker left for `displayFile` by a
 * previous invocation, under the lock: any marker found here is an
 * unfinished probe, since the lock already excludes a second live probe
 * and pids recycle, so the marker's own `pid` field is not consulted (it
 * is written for a human reading the marker file, nothing more).
 * Hash-based recovery is unconditional.
 *
 * Returns `undefined` when there is nothing left to act on (no marker,
 * or one this call recovered), and the reason plus its warning when the
 * caller must stop. Warnings for a recovery that succeeded are pushed
 * onto `warnings` directly, in the order the single-probe pipeline has
 * always pushed them.
 */
async function recoverTargetMarker(
  displayFile: string,
  absFile: string,
  warnings: string[],
): Promise<{ reason: string; warning: string } | undefined> {
  const marker = readMarkerFor(absFile);
  if (!marker) return undefined;
  const currentHash = fs.existsSync(displayFile)
    ? await sha256File(displayFile).catch(() => undefined)
    : undefined;
  // The one thing every recovery path below except "already back at
  // preHash" needs is the backup itself; when it is gone (its per-run
  // log dir can easily not have survived, e.g. cleaned up or never
  // created on this machine at all), automatic recovery is not possible
  // and must say so by name, not surface as a generic restore failure.
  if (!fs.existsSync(marker.backupPath) && currentHash !== marker.preHash) {
    return {
      reason: "stale_probe_marker",
      warning: `stale probe marker found for ${displayFile}, but its backup is missing (${marker.backupPath}); automatic recovery is not possible; delete the marker file to clear it: ${markerFilePathFor(absFile)}`,
    };
  }
  if (currentHash !== undefined && currentHash === marker.mutatedHash) {
    // The backup is hashed and required to match the marker's own
    // recorded pre-mutation hash BEFORE it is copied anywhere. The copy
    // is destructive and irreversible: a backup that is corrupt,
    // truncated, or simply not this target's content would otherwise be
    // written over the target, destroying the only remaining copy of the
    // mutated file and reporting `stale_probe_marker` as if the target
    // had been left alone.
    const backupHash = await sha256File(marker.backupPath).catch(
      () => undefined,
    );
    if (backupHash !== marker.preHash) {
      return {
        reason: "stale_probe_marker",
        warning: `stale probe marker found for ${displayFile}, but its backup does not match the pre-mutation hash the marker records (${marker.backupPath}); the target was left untouched; inspect the backup, then delete the marker file to clear it: ${markerFilePathFor(absFile)}`,
      };
    }
    let restored = false;
    try {
      fs.copyFileSync(marker.backupPath, displayFile);
      restored = true;
    } catch {
      restored = false;
    }
    const restoredHash = restored
      ? await sha256File(displayFile).catch(() => undefined)
      : undefined;
    if (!restored || restoredHash !== marker.preHash) {
      return {
        reason: "stale_probe_marker",
        warning: `automatic recovery of a stale probe marker failed; backup at ${marker.backupPath}`,
      };
    }
    removeMarkerFor(absFile);
    warnings.push("recovered_stale_probe");
    return undefined;
  }
  if (currentHash !== undefined && currentHash === marker.preHash) {
    // Already back at the pre-mutation content (e.g. a previous
    // invocation restored but crashed before removing the marker):
    // nothing to recover, just clear the stale marker and continue.
    removeMarkerFor(absFile);
    warnings.push(
      `removed a stale probe marker whose target already matched its recorded pre-mutation hash; backup at ${marker.backupPath}`,
    );
    return undefined;
  }
  return {
    reason: "stale_probe_marker",
    warning: `stale in-flight probe marker found for ${displayFile}; backup at ${marker.backupPath}`,
  };
}

/** Everything a mutant step needs that is the same for every mutant of
 * one run: the isolation it runs under, the exec environment, and the
 * signal machinery it shares with the pipeline that owns it. */
interface MutantRuntime {
  root: string;
  logDir: string;
  /** The tree a `patch` mutant's real `git apply` runs against: the
   * worktree copy under `-i worktree`, the containment root otherwise. */
  applyRoot: string;
  execEnv: {
    cwd: string;
    logDir: string;
    timeoutMs?: number;
    signal: AbortSignal;
  };
  gitApplyTimeoutMs: number;
  effectiveIsolation: IsolationMode;
  testCommand: string;
  preCommand?: string;
  signal: AbortSignal;
  track: TrackFn;
  crashHandlers: CrashHandlers;
  exitOnSignal: boolean;
  /** Hands the pipeline's one `RestoreState` slot -- the slot the signal
   * handler reads -- to this step, so the handler always owns the
   * CURRENT mutant's restore state and never a previous one's. */
  setRestoreState: (state: RestoreState | null) => void;
}

/** One target file, opened once: its backup, the hashes the restore is
 * verified against, and the restore itself. A plan reuses one of these
 * for every mutant that targets the same file; the single probe has
 * exactly one. */
interface TargetSession {
  displayFile: string;
  absFile: string;
  /** The path actually mutated: the worktree's own copy of the target
   * under `-i worktree` (never the original tree), `displayFile` itself
   * for `inplace`. */
  mutationFilePath: string;
  preHash: string;
  originalContent: string;
  session: InplaceSession;
  /** Restores the session and decides the marker's fate, UNLESS
   * `phaseAborted` is true and the signal handler already did both (see
   * `deferToHandlerIfActive`): then this reuses the handler's own
   * outcome instead of racing it with a second, redundant restore. Every
   * abort-adjacent restore goes through this, so "the handler's restore
   * is the last write" holds regardless of which phase the signal landed
   * in, and the marker is only ever removed once, by whichever of the
   * two actually decided to. */
  restoreOnce: (
    phaseAborted: boolean,
  ) => Promise<{ ok: boolean; verified: boolean }>;
  /** Stops treating a mutation as in flight and removes the backup file.
   * Only ever right on a path where nothing was mutated; a plan never
   * calls it between mutants, since every later mutant on this file
   * restores from that same backup. */
  discardBackup: () => void;
}

/**
 * Opens `target` for mutation: takes the backup BEFORE anything else
 * runs against the file (a baseline command that itself rewrites the
 * target -- a formatter, a codegen step -- must never end up being what
 * the backup captured), arms the signal handler's restore slot, and
 * verifies the backup by hash before a single mutation is applied.
 *
 * A backup that does not hash to the target's pre-mutation content is
 * refused here, with the backup file removed and the target itself left
 * untouched: without a trustworthy backup there is nothing to restore
 * from, so nothing may be mutated.
 */
function openTarget(
  rt: MutantRuntime,
  input: {
    displayFile: string;
    absFile: string;
    mutationFilePath: string;
    preHash: string;
    originalContent: string;
  },
): Promise<
  { ok: true; target: TargetSession } | { ok: false; warning: string }
> {
  const session = beginInplace(input.mutationFilePath, rt.logDir);
  rt.setRestoreState({
    restore: session.restore,
    targetPath: session.targetPath,
    markerKey: input.absFile,
    backupPath: session.backupPath,
    preHash: input.preHash,
  });
  const discardBackup = () => {
    rt.setRestoreState(null);
    try {
      fs.rmSync(session.backupPath, { force: true });
    } catch {
      // Best-effort: an orphaned backup file is clutter, never a
      // correctness problem (nothing references it once no marker
      // points at it).
    }
  };
  const restoreOnce = async (
    phaseAborted: boolean,
  ): Promise<{ ok: boolean; verified: boolean }> => {
    if (phaseAborted) {
      const handlerOutcome = await deferToHandlerIfActive(
        rt.crashHandlers,
        rt.exitOnSignal,
      );
      if (handlerOutcome !== undefined) {
        rt.setRestoreState(null);
        return { ok: true, verified: handlerOutcome?.verified ?? false };
      }
    }
    const result = await restoreAndVerify(session, input.preHash);
    rt.setRestoreState(null);
    if (result.verified) removeMarkerFor(input.absFile);
    return result;
  };
  return sha256File(session.backupPath)
    .catch(() => undefined)
    .then((backupHash) => {
      if (backupHash !== input.preHash) {
        discardBackup();
        return {
          ok: false as const,
          warning: `the backup taken at ${session.backupPath} did not match the target's pre-mutation hash; the target itself was left untouched`,
        };
      }
      return {
        ok: true as const,
        target: {
          displayFile: input.displayFile,
          absFile: input.absFile,
          mutationFilePath: input.mutationFilePath,
          preHash: input.preHash,
          originalContent: input.originalContent,
          session,
          restoreOnce,
          discardBackup,
        },
      };
    });
}

/** One mutant of a run: exactly one form plus the verdict it is expected
 * to produce. `expect` is per mutant, so a plan can mix a mutant that
 * must break the test with one that must not. */
interface MutantStepSpec {
  form: MutantForm;
  line?: number;
  replaceText?: string;
  matchText?: string;
  withText?: string;
  patchPath?: string;
  expect: ExpectVerdict;
}

type PreparedMutant =
  | {
      ok: true;
      computed: MutantComputed;
      mutant: MutantField;
      mutantSummary: string;
      verifiedAppliedVia: string;
      logPaths: string[];
    }
  | { ok: false; reason: string; logPaths: string[] };

/**
 * Step 1 of a mutant: compute what it would do WITHOUT touching the real
 * target (pure string work for `replace`/`match`, a `git apply` dry run
 * against a scratch copy for `patch`), and derive the evidence strings
 * from what that comparison actually found.
 *
 * `computed.line` -- never the caller's `-n` -- is what every piece of
 * reported evidence uses, so the line number and the `before` content
 * quoted beside it always come from the same comparison and can never
 * name different lines.
 */
async function prepareMutant(
  rt: MutantRuntime,
  target: TargetSession,
  spec: MutantStepSpec,
  warnings: string[],
): Promise<PreparedMutant> {
  const mutantSpec: MutantSpec = {
    form: spec.form,
    file: target.displayFile,
    // `undefined` only ever reaches here for the `patch` form, which
    // ignores it; every other form was refused by the caller without one.
    line: spec.line,
    replaceText: spec.replaceText,
    matchText: spec.matchText,
    withText: spec.withText,
    patchPath: spec.patchPath,
  };
  // The dry run's own `git apply` calls get the same controller the
  // `--pre`/`-t` commands do, and are tracked the same way: a signal
  // landing while one of them is running kills it and the handler waits
  // for it to settle, rather than letting an interrupted apply finish
  // writing after this process has moved on.
  const started = startRunArgvTracked(
    computeMutant(mutantSpec, {
      root: rt.root,
      logDir: rt.logDir,
      originalContent: target.originalContent,
      signal: rt.signal,
      timeoutMs: rt.gitApplyTimeoutMs,
    }),
  );
  const computed = await rt.track(started.result, started.closed);
  if (!computed.applicable) {
    if (computed.reasonCode === "aborted") {
      // Ordering only: nothing has mutated the target yet at this phase,
      // so there is nothing for a deferred restore's outcome to change
      // here; this just keeps the caller from returning (or, in CLI
      // mode, ever returning) while the handler is still doing its own
      // (harmless, no-op) restore and lock release.
      await deferToHandlerIfActive(rt.crashHandlers, rt.exitOnSignal);
    }
    if (computed.reason) warnings.push(computed.reason);
    return {
      ok: false,
      reason: computed.reasonCode ?? "mutant_not_applicable",
      logPaths: computed.logPaths,
    };
  }
  // An `-n` passed with `-p` anyway is neither used nor silently
  // swallowed: when it names a different line, both numbers go into a
  // warning, so a caller who expected the probe to target their line
  // finds out rather than reading their own number back from the result.
  if (
    spec.form === "patch" &&
    spec.line !== undefined &&
    spec.line !== computed.line
  ) {
    warnings.push(
      `-n ${String(spec.line)} differs from the patch's first changed line ` +
        `${String(computed.line)}; mutant.line reports ${String(computed.line)}`,
    );
  }
  return {
    ok: true,
    computed,
    mutant: {
      file: target.displayFile,
      line: computed.line,
      before: computed.before,
      after: computed.after,
      form: spec.form,
    },
    mutantSummary: formatMutantSummary(
      target.displayFile,
      computed.line,
      computed.before,
      computed.after,
    ),
    verifiedAppliedVia: formatVerifiedAppliedVia(
      target.displayFile,
      computed.line,
      computed.before,
      computed.after,
    ),
    logPaths: computed.logPaths,
  };
}

/** What one mutant attempt produced, without the fields that belong to
 * the run rather than to the mutant (`baseline`, `isolation`): the
 * caller folds those in. `restoreFailed` and `aborted` are what a plan
 * reads to decide that nothing further may be applied. */
interface MutantAttemptOutcome {
  status: "killed" | "survived" | "inconclusive";
  reason?: string;
  mutant?: MutantField;
  mutation_probe?: MutationProbeField;
  test?: TestPhaseField;
  logPaths: string[];
  restoreFailed: boolean;
  aborted: boolean;
}

/**
 * Steps 3 to 7 of one mutant, on a target whose backup is already taken
 * and verified and whose baseline has already passed: write the in-flight
 * marker, apply, verify the applied hash, run `--pre`/`-t`, restore,
 * verify the restore by hash, classify.
 *
 * Every exit from this function has already restored the target (or
 * reports `restore_failed` saying it could not): a caller may apply a
 * further mutant only after an outcome whose `restoreFailed` is false.
 */
async function runMutantAttempt(
  rt: MutantRuntime,
  target: TargetSession,
  spec: MutantStepSpec,
  prepared: {
    computed: MutantComputed;
    mutant: MutantField;
    mutantSummary: string;
    verifiedAppliedVia: string;
    logPaths: string[];
  },
  warnings: string[],
): Promise<MutantAttemptOutcome> {
  const { computed, mutant, mutantSummary, verifiedAppliedVia } = prepared;
  const logPaths = prepared.logPaths;
  const inconclusiveProbe = (
    restoredVerified: boolean,
  ): MutationProbeField => ({
    mutant: mutantSummary,
    verified_applied_via: verifiedAppliedVia,
    result: "inconclusive",
    restored_verified: restoredVerified,
  });
  const restoreFailedOutcome = (
    extraLogPaths: string[] = [],
    test?: TestPhaseField,
  ): MutantAttemptOutcome => {
    warnings.push(
      `restore failed; the original content is preserved at backup path ${target.session.backupPath}`,
    );
    return {
      status: "inconclusive",
      reason: "restore_failed",
      mutant,
      mutation_probe: inconclusiveProbe(false),
      ...(test ? { test } : {}),
      logPaths: [...logPaths, ...extraLogPaths],
      restoreFailed: true,
      aborted: false,
    };
  };

  // The signal handler must own THIS mutant's restore state from the
  // moment the file is about to change until the restore is verified;
  // for the single probe this re-arms the same state `openTarget`
  // already set, for a plan it hands the handler mutant N's state in
  // place of mutant N-1's.
  rt.setRestoreState({
    restore: target.session.restore,
    targetPath: target.session.targetPath,
    markerKey: target.absFile,
    backupPath: target.session.backupPath,
    preHash: target.preHash,
  });

  // (3) marker, apply, verify the hash changed. The in-flight marker is
  // `inplace`-only: it exists to let the next invocation recover the
  // ORIGINAL tree from a SIGKILL/crash mid-mutation, and a `worktree`
  // probe never mutates the original tree at all (the repository-keyed
  // worktree marker covers the worktree's own leftover-on-crash case
  // instead).
  if (rt.effectiveIsolation === "inplace") {
    writeMarker(target.absFile, {
      targetPath: target.displayFile,
      backupPath: target.session.backupPath,
      preHash: target.preHash,
      mutatedHash: computed.mutatedHash,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
  }

  if (spec.form === "patch") {
    // The one `git apply` that writes to the real target, and the only
    // command that runs while the in-flight marker is up: it gets the
    // signal controller too, so a SIGINT/SIGTERM kills it and the
    // handler waits for it to settle before restoring. Without that, an
    // interrupted apply outlives this process and lands on the target
    // after the restore, with the marker already gone.
    const applyStarted = startRunArgvTracked(
      applyPatchForReal(spec.patchPath ?? "", rt.applyRoot, rt.logDir, {
        signal: rt.signal,
        timeoutMs: rt.gitApplyTimeoutMs,
      }),
    );
    const applyResult = await rt.track(
      applyStarted.result,
      applyStarted.closed,
    );
    if (applyResult.exitCode !== 0) {
      const { ok, verified } = await target.restoreOnce(applyResult.aborted);
      if (!ok || !verified) {
        return restoreFailedOutcome([applyResult.logPath]);
      }
      // A `git apply` killed by its own bound, or by this probe's signal
      // handler, never said anything about the patch: it is reported
      // under its own reason rather than as a patch that does not apply,
      // so a probe that was stopped is not read as a verdict about the
      // mutant.
      warnings.push(
        applyResult.timedOut
          ? `git apply against the real target hit its ${rt.gitApplyTimeoutMs}ms timeout and was killed; see ${applyResult.logPath}`
          : applyResult.aborted
            ? `git apply against the real target was aborted and killed; see ${applyResult.logPath}`
            : `git apply failed against the real target after the dry run succeeded; see ${applyResult.logPath}`,
      );
      return {
        status: "inconclusive",
        reason: applyResult.timedOut
          ? "git_apply_timeout"
          : applyResult.aborted
            ? "aborted"
            : "mutant_not_applicable",
        logPaths: [...logPaths, applyResult.logPath],
        restoreFailed: false,
        aborted: applyResult.aborted,
      };
    }
  } else {
    fs.writeFileSync(target.mutationFilePath, computed.newContent);
  }

  const afterApplyHash = await sha256File(target.mutationFilePath);
  if (
    afterApplyHash === target.preHash ||
    afterApplyHash !== computed.mutatedHash
  ) {
    const { ok, verified } = await restoreAndVerify(
      target.session,
      target.preHash,
    );
    rt.setRestoreState(null);
    if (verified) removeMarkerFor(target.absFile);
    if (!ok || !verified) return restoreFailedOutcome();
    // The restore above succeeded and verified, so this is a structured
    // "cannot conclude" for the caller, not an exception: throwing here
    // would surface through the CLI as `status: "error"` under an
    // unknown command, losing both the reason and the `mutation_probe`
    // evidence that the target really is back at its pre-mutation
    // content.
    warnings.push(
      `the applied mutant's hash does not match what the dry run predicted for ${target.displayFile} (expected ${computed.mutatedHash}, got ${afterApplyHash}); the target was restored and the restore verified`,
    );
    return {
      status: "inconclusive",
      reason: "apply_hash_mismatch",
      mutant,
      mutation_probe: inconclusiveProbe(verified),
      logPaths,
      restoreFailed: false,
      aborted: false,
    };
  }

  // (4) --pre then -t, mutated.
  const mutantRun = await runPreThenTest(
    { preCommand: rt.preCommand, testCommand: rt.testCommand },
    rt.execEnv,
    rt.track,
  );
  if (!mutantRun.ok) {
    noteIncompleteOutput(warnings, "mutant --pre", mutantRun.pre);
    const { ok, verified } = await target.restoreOnce(mutantRun.pre.aborted);
    // The `--pre` log path is deliberately not folded in here (unlike the
    // `pre_failed` return below it): a restore that failed is reported
    // with the mutant's own dry-run logs, the same set every other
    // `restore_failed` carries.
    if (!ok || !verified) return restoreFailedOutcome();
    const preAborted = mutantRun.pre.aborted;
    warnings.push(
      preAborted
        ? `--pre was aborted during the mutant run; see ${mutantRun.pre.logPath}`
        : `--pre exited ${mutantRun.pre.exitCode} during the mutant run; see ${mutantRun.pre.logPath}`,
    );
    return {
      status: "inconclusive",
      reason: preAborted ? "aborted" : "pre_failed",
      mutant,
      mutation_probe: inconclusiveProbe(verified),
      logPaths: [...logPaths, mutantRun.pre.logPath],
      restoreFailed: false,
      aborted: preAborted,
    };
  }
  const testResult = mutantRun.test;
  noteIncompleteOutput(warnings, "mutant", testResult);

  // (5) restore, (6) verify restore by hash.
  const { ok: restoreOk, verified: restoredVerified } =
    await target.restoreOnce(testResult.aborted);

  const testField: TestPhaseField = {
    command: rt.testCommand,
    exitCode: testResult.exitCode,
    durationMs: testResult.durationMs,
    timedOut: testResult.timedOut,
    stdoutTail: testResult.stdoutTail,
    stderrTail: testResult.stderrTail,
    logPath: testResult.logPath,
  };

  if (!restoreOk || !restoredVerified) {
    return restoreFailedOutcome([], testField);
  }

  // (7) classify. The marker was already removed above by `restoreOnce`
  // (or deliberately kept, when a signal handler's own restore could not
  // confirm true stdio closure within its bound). Lock release happens in
  // the caller's `finally`.

  // Defense in depth for `worktree`: nothing above should ever have
  // written to `displayFile` (every mutate/backup/restore step used
  // `mutationFilePath`, inside the worktree, instead). Re-hashing it
  // against `preHash` here catches a wiring bug directly instead of
  // silently shipping a verdict computed while the claim "the original
  // tree is untouched" no longer holds.
  if (rt.effectiveIsolation === "worktree") {
    const originalTreeHashAfter = await sha256File(target.displayFile).catch(
      () => undefined,
    );
    if (originalTreeHashAfter !== target.preHash) {
      warnings.push(
        `BUG: ${target.displayFile} in the original tree changed during a ` +
          `worktree-mode probe; this should be impossible and is a ` +
          `defect in isolation, not a normal probe outcome`,
      );
      return {
        status: "inconclusive",
        reason: "worktree_original_tree_modified",
        mutant,
        mutation_probe: inconclusiveProbe(restoredVerified),
        test: testField,
        logPaths,
        restoreFailed: false,
        aborted: false,
      };
    }
  }

  let status: "killed" | "survived" | "inconclusive";
  let reason: string | undefined;
  if (testResult.aborted) {
    // The run was stopped (a SIGINT/SIGTERM this probe handled, or a
    // caller's abort) before the test could say anything about the
    // mutant. Never `killed`: an aborted test child exits non-zero, which
    // under `--expect fail` is indistinguishable from a mutant the suite
    // really caught, and reporting that would be a verdict nothing
    // measured.
    status = "inconclusive";
    reason = "aborted";
    warnings.push(`the mutant run was aborted; see ${testResult.logPath}`);
  } else if (testResult.timedOut) {
    status = "inconclusive";
    reason = "timeout";
  } else {
    const testPassed = testResult.exitCode === 0;
    const killed = spec.expect === "fail" ? !testPassed : testPassed;
    status = killed ? "killed" : "survived";
  }

  return {
    status,
    reason,
    mutant,
    mutation_probe: {
      mutant: mutantSummary,
      verified_applied_via: verifiedAppliedVia,
      result: status,
      restored_verified: restoredVerified,
    },
    test: testField,
    logPaths,
    restoreFailed: false,
    aborted: testResult.aborted,
  };
}

/**
 * The `-i worktree` setup both pipelines share: recover (or refuse) a
 * leftover worktree from a previous run on this repository, then sync a
 * fresh detached worktree for THIS run. Exactly once per run, whether
 * that run applies one mutant or a whole plan (I4).
 *
 * Warnings about what was recovered are pushed onto `warnings` as they
 * happen; a failure returns the messages the caller appends to its own
 * result instead, since only the caller knows the shape that result has.
 */
async function prepareWorktreeSession(input: {
  root: string;
  cwd: string;
  realRoot: string;
  logDir: string;
  wtScratchRoot: string;
  absLinks: string[];
  controller: RunController;
  warnings: string[];
}): Promise<
  | { ok: true; session: WorktreeSyncSuccess }
  | {
      ok: false;
      reason: string;
      warnings: string[];
      /** Present only for a failure that produced exec logs (the sync
       * itself); a refusal before any worktree existed carries none, and
       * the caller then omits the field entirely. */
      logPaths?: string[];
      /** Whether `git worktree add` was reached: only then does the
       * caller have a worktree to clean up (and a possible abort to
       * defer to the signal handler for). */
      fromSync: boolean;
    }
> {
  const { root, cwd, realRoot, logDir, wtScratchRoot, controller, warnings } =
    input;
  const { track } = controller;
  // A leftover worktree from a previous run on this same repository
  // that never reached its own cleanup (SIGKILL, a crash): the lock
  // already excludes a live probe on this repository under this
  // lock directory, so a marker found here is treated as stale,
  // mirroring the absFile marker recovery above, and so is any
  // registered worktree of the probe's own scratch shape whether or
  // not a marker names it (a marker can be deleted by hand, and git
  // registers the worktree before `git worktree add` returns). The
  // one exception is a worktree whose scratch directory records a
  // live owner (see `liveForeignOwner`: an alive pid under a record
  // within its bound): a probe running under another lock
  // directory, which the lock cannot see; it is named in a warning
  // and left alone, never removed and never treated as stale.
  // Recovery is the same gated remove-and-assert every
  // removal goes through, gated against THIS run's own log dir,
  // never against a root the marker recorded; nothing in the
  // original tree was ever touched by a worktree-mode probe, so
  // there is no backup/hash proof to check first. A leftover that
  // cannot be removed, or a marker naming a path the gate refuses,
  // stops this run with the marker kept: never a silent drop, and
  // never a delete of something the gate could not vouch for. A
  // registry that cannot be read is said so in a warning, not
  // treated as empty.
  const staleWt = readMarkerFor(realRoot);
  const registered = await listRegisteredWorktrees(realRoot, logDir, {
    track,
  });
  if (!registered.ok) {
    warnings.push(
      `git worktree list could not run for ${realRoot} ` +
        `(${registered.detail ?? "unknown"}; see ${registered.logPath}); ` +
        `a worktree a previous run left registered could not be checked for`,
    );
  }
  const leftovers: {
    path: string;
    fromMarker: boolean;
  }[] = [];
  const unremoved: string[] = [];
  const markerFile = markerFilePathFor(realRoot);
  if (staleWt) {
    if (typeof staleWt.targetPath === "string") {
      leftovers.push({ path: staleWt.targetPath, fromMarker: true });
    } else {
      unremoved.push(
        `the stale worktree marker for ${realRoot} names no worktree path; delete the marker file to clear it: ${markerFile}`,
      );
    }
  }
  for (const registeredPath of registered.paths) {
    if (!isScratchWorktreePath(registeredPath)) continue;
    if (registeredPath === realRoot) continue;
    const known = leftovers.some(
      (l) => resolveDeepestExisting(path.resolve(l.path)) === registeredPath,
    );
    if (!known) leftovers.push({ path: registeredPath, fromMarker: false });
  }
  let recovered = 0;
  for (const leftover of leftovers) {
    const livePid = liveForeignOwner(leftover.path);
    if (livePid !== undefined) {
      warnings.push(
        `a worktree of the probe's own scratch shape at ${leftover.path} ` +
          `belongs to a live probe (pid ${livePid}) and was left alone`,
      );
      continue;
    }
    const cleanup = await cleanupWorktree(realRoot, leftover.path, logDir, {
      track,
      scratchRoot: wtScratchRoot,
    }).catch((err: unknown) => ({
      ok: false,
      verified: false,
      refused: false,
      detail: err instanceof Error ? err.message : String(err),
      logPaths: [] as string[],
    }));
    if (cleanup.ok) {
      recovered += 1;
      if (!cleanup.verified || cleanup.detail !== undefined) {
        // See the same-shaped warning in `cleanupWtSession` above:
        // a `verified: true` result can still carry a `detail`
        // worth surfacing (a surviving gitdir-files admin entry).
        warnings.push(
          `the leftover worktree at ${leftover.path} was removed, but ` +
            `${cleanup.detail ?? "the removal could not be verified"}`,
        );
      }
      continue;
    }
    const detail = cleanup.detail ?? "unknown";
    // A marker-named path the gate refused, or one whose removal
    // could not be verified (git could not list, so whether the
    // path was ever registered is unknown and the manual `git
    // worktree remove` cannot be relied on), gets the marker file
    // as its one escape; the manual command is named only for a
    // path git could still list.
    if (leftover.fromMarker && (cleanup.refused || !cleanup.verified)) {
      unremoved.push(
        `the stale worktree marker for ${realRoot} names ${leftover.path}, ` +
          `which was not removed (${detail}); inspect it, then delete the ` +
          `marker file to clear it: ${markerFile}`,
      );
    } else {
      unremoved.push(
        `a leftover worktree at ${leftover.path} was not removed ` +
          `(${detail}); run \`git -C ${realRoot} worktree remove --force ` +
          `--force -- ${leftover.path}\` manually` +
          (leftover.fromMarker
            ? `, then delete the marker file if it persists: ${markerFile}`
            : ""),
      );
    }
  }
  if (unremoved.length > 0) {
    return {
      ok: false,
      reason: "stale_worktree",
      warnings: unremoved,
      fromSync: false,
    };
  }
  if (recovered > 0) warnings.push("recovered_stale_worktree");
  // The marker's worktree was recovered, the marker named nothing
  // to recover any more, or it named a worktree a live probe owns.
  // That last case keeps nothing by keeping the marker: the marker
  // is a single slot keyed by the repository, and this run's own
  // `onWorktreeAttempt` below overwrites it before the sync starts,
  // so the live probe's trail is git's registry listing and its
  // scratch directory's `owner.json`, never this file.
  if (staleWt) removeMarkerFor(realRoot);

  // Started, not awaited, so `wtSyncSettled` is assigned before this
  // function yields for the first time: from here on every exit path
  // (this one, `finally`, the signal handler) can wait for the sync
  // before touching the worktree it is writing into.
  const wtStarted = beginWorktree({
    root,
    cwd,
    logDir,
    links: input.absLinks,
    signal: controller.execController.signal,
    track,
    // Before `git worktree add` runs, with the whole sync still
    // ahead: git registers the worktree (locked, for the duration
    // of the checkout) before the add returns, so from this point
    // on a signal has a cleanup that knows the path, and a
    // `SIGKILL` or a crash leaves a marker `doctor` and the next
    // probe on this repository act on; never a registered worktree
    // with no trace of it anywhere. The marker records the log dir
    // the path was created under for whoever inspects it; the
    // cleanup checks a path git does not report against the
    // recovering run's own log dir, never against this record.
    onWorktreeAttempt: controller.noteWorktreeAttempt,
  });
  controller.setSyncSettled(
    wtStarted.then(
      () => undefined,
      () => undefined,
    ),
  );
  const wt = await wtStarted;
  if (!wt.ok) {
    return {
      ok: false,
      reason: wt.reason,
      warnings: [wt.detail],
      logPaths: wt.logPaths,
      fromSync: true,
    };
  }
  warnings.push(...wt.warnings);
  return { ok: true, session: wt };
}

/**
 * Runs the full probe pipeline: lock -> containment -> stale-marker
 * recovery -> baseline -> mutate -> pre+test -> restore -> verify ->
 * classify. `probePlan` below runs the same pipeline with the mutate ->
 * test -> restore -> classify step in a loop, sharing the setup and the
 * teardown; see its own docblock for the invariants that split holds to.
 */
export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const warnings: string[] = [];
  const isolationField = emptyIsolationField(opts.isolation);

  // `--allow-outside` places the scratch copy for a `-p` dry run at
  // `--file`'s path relative to the containment root; when `--file` is
  // allowed to resolve outside that root, that relative path can carry
  // `../` components that escape the scratch directory entirely (a real
  // path-traversal risk, not just a usability gap). Rejected outright
  // rather than reworked into a basename-only placement, which would
  // still have to reject any patch whose own diff headers name a
  // different relative path.
  if (opts.form === "patch" && opts.allowOutside) {
    return {
      status: "usage_error",
      reason: "patch_allow_outside_unsupported",
      warnings: [
        ...warnings,
        "-p/--patch cannot be combined with --allow-outside",
      ],
      isolation: isolationField,
    };
  }

  const cwd = path.resolve(opts.cwd);
  // The git work-tree root when there is one, else `cwd`: the same value
  // `containmentRoot` computes, kept in two variables because the lock
  // below has to tell "in a repository" from "not in one".
  const gitRoot = findGitRoot(cwd);
  const root = gitRoot ?? path.resolve(cwd);
  // `--timeout` is the caller saying how long any step of this probe may
  // run, so every `git apply` gets that same bound; without one they
  // keep the fixed default, since an apply that hangs would otherwise
  // sit under an in-flight marker forever. Computed here, ahead of where
  // it used to sit (right before the containment/lock block below),
  // because the `-p` derivation immediately below runs its own `git
  // apply --numstat` and needs the same bound. That derivation (both the
  // `--file` numstat listing and the `-n` hunk-header read) runs before
  // `execController` below exists, so unlike every later `git apply`/
  // test invocation in this function it is not wired to the signal
  // handler's abort; `--timeout` (`gitApplyTimeoutMs`) is the only bound
  // on how long it may run.
  const gitApplyTimeoutMs = opts.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS;

  // `-p/--patch` derives `--file` from the single path `git apply
  // --numstat` reports the patch touches, resolved against the
  // containment root -- `root`, never `cwd`, since they differ when
  // `--cwd` is a subdirectory of the repository, and never the patch
  // file's own directory, since a patch is portable and carries no base
  // directory of its own. It has to run before the containment check
  // below, which needs `displayFile`. Two or more touched paths without
  // an explicit `--file` is ambiguous and refused outright, rather than
  // guessed at: the caller has to say which one is the mutation target.
  //
  // `-n/--line` is NOT derived here, and for the `patch` form it is not
  // required at all: the line a patch changes is whatever the applied
  // diff changed, which the dry run below reports back as
  // `computed.line`. Nothing between here and there needs it.
  let displayFile: string;
  const line = opts.line;
  let derivationLogPaths: string[] = [];
  // Check the `-p/--patch` path once here, before anything else looks
  // at it: an unusable `-p` (missing, a directory or another
  // non-regular file, unreadable permissions, or larger than this
  // package accepts) is a caller usage error, not something for `git
  // apply --numstat` to diagnose. Without this check, a bad `-p` given
  // without `--file` fell into the `--file` derivation's own `git apply
  // --numstat` failure below and came back as
  // `inconclusive`/`mutant_not_applicable` ("failed to parse the
  // patch") -- a diagnosis that points at the patch's *content*, not at
  // the path itself being wrong. Doing it once, ahead of the numstat
  // listing (and ahead of the lock, the in-flight marker and any
  // worktree, so a refusal here leaves nothing behind), means every
  // path that hands this patch to `git apply` -- `--file` derivation,
  // the dry run, the real apply -- shares the same `patch_not_readable`
  // diagnosis instead of several different ones.
  //
  // Every check there is metadata-only; see `patchUnusableReason` for
  // why nothing here opens the patch or reads its bytes.
  if (opts.form === "patch") {
    const unusable = patchUnusableReason(opts.patchPath ?? "");
    if (unusable !== undefined) {
      return {
        status: "usage_error",
        reason: "patch_not_readable",
        warnings: [...warnings, unusable],
        isolation: isolationField,
      };
    }
  }
  if (opts.file !== undefined) {
    displayFile = path.resolve(cwd, opts.file);
  } else if (opts.form === "patch") {
    const listing = await listPatchTouchedPaths(
      opts.patchPath ?? "",
      opts.logDir,
      { timeoutMs: gitApplyTimeoutMs },
    );
    derivationLogPaths = [listing.logPath];
    if (!listing.ok) {
      return {
        status: "inconclusive",
        reason: listing.reasonCode ?? "mutant_not_applicable",
        warnings: [...warnings, listing.reason],
        isolation: isolationField,
        dryRunLogPaths: derivationLogPaths,
      };
    }
    if (listing.paths.length !== 1) {
      return {
        status: "usage_error",
        reason: "patch_file_ambiguous",
        warnings: [
          ...warnings,
          `-p/--patch touches ${listing.paths.length} paths and no --file ` +
            `names which one to mutate: ${listing.paths.join(", ")}`,
        ],
        isolation: isolationField,
        dryRunLogPaths: derivationLogPaths,
      };
    }
    displayFile = path.resolve(root, listing.paths[0]);
  } else {
    return {
      status: "usage_error",
      reason: "file_required",
      warnings: [
        ...warnings,
        "--file is required unless -p/--patch derives it from a single-path patch",
      ],
      isolation: isolationField,
    };
  }
  // `patch` is exempt: its line comes from the applied diff, so there is
  // nothing for the caller to be required to supply.
  if (line === undefined && opts.form !== "patch") {
    return {
      status: "usage_error",
      reason: "line_required",
      warnings: [...warnings, "-n/--line is required"],
      isolation: isolationField,
      dryRunLogPaths: derivationLogPaths,
    };
  }
  const links = opts.links ?? [];
  const displayLinks = links.map((l) => path.resolve(cwd, l));

  // Containment and the lock/marker key are resolved through realpath
  // (before either check), so an in-repo symlink pointing outside the
  // root cannot be used to mutate a file the containment check would
  // otherwise have refused. Everything else (the mutation itself,
  // hashing, `mutant.file`, warnings) keeps using the display paths:
  // writes through a symlink already reach the same physical file, and
  // showing the user's own path (rather than a resolved realpath, which
  // can differ even with no symlink involved, e.g. macOS's `/var` ->
  // `/private/var`) is what "display the user path" means here.
  const realRoot = resolveDeepestExisting(root);
  const absFile = resolveDeepestExisting(displayFile);
  const absLinks = displayLinks.map(resolveDeepestExisting);
  // The `--log-dir` this run's worktree (if any) is created under,
  // recorded in the repository-keyed marker and handed to every
  // `cleanupWorktree` call for this session, the leftover recovery
  // included: a path that git does not (yet, or any more) report as a
  // registered worktree is only ever deleted when it sits under here.
  // Never the log dir a marker recorded: a marker that supplied both
  // the path and the root to check it against would certify itself.
  const wtScratchRoot = path.resolve(opts.logDir);

  // `worktree` needs a real git work tree to branch a worktree off of;
  // outside one there is nothing to isolate into, so the mode falls back
  // to `inplace` (named in a warning) instead of failing outright.
  let effectiveIsolation = opts.isolation;
  if (effectiveIsolation === "worktree" && gitRoot === undefined) {
    effectiveIsolation = "inplace";
    warnings.push(
      "not inside a git work tree; falling back to --isolation inplace",
    );
  }
  isolationField.mode = effectiveIsolation;

  // `--allow-outside` computes the scratch/worktree-relative placement
  // of a path outside the containment root by relativizing it against
  // that root; for `worktree` that placement is then re-based onto the
  // worktree copy (`mutationFilePath` below), and a path outside the
  // root has no well-defined worktree copy to re-base onto at all.
  // Rejected outright, mirroring `patch_allow_outside_unsupported`,
  // rather than surfacing as a raw ENOENT or `backup_verification_failed`
  // once the pipeline reaches a target it never actually synced.
  if (effectiveIsolation === "worktree" && opts.allowOutside) {
    return {
      status: "usage_error",
      reason: "worktree_allow_outside_unsupported",
      warnings: [
        ...warnings,
        "--isolation worktree cannot be combined with --allow-outside",
      ],
      isolation: isolationField,
    };
  }

  // The lock is keyed on the repository, not on the target file, for
  // BOTH modes, whenever one exists: an `inplace` probe mutates the one
  // working tree that every probe in the same repository builds and
  // tests in, and a `worktree` probe shares the same worktree machinery
  // (and, once linked, the same node_modules caches) with every other
  // probe on that repository, so two probes on the same repository are
  // never independent even when their target files differ. It is
  // refused rather than queued, the same contract a second probe on the
  // same file has always had. Outside a repository there is no shared
  // tree, and the target file itself is the identity. The `inplace`
  // marker stays keyed on the target file (it records that one file's
  // backup and hashes); the `worktree` leftover marker is keyed on this
  // same repository-root identity (see the stale-worktree recovery
  // below).
  const lockIdentity = gitRoot !== undefined ? realRoot : absFile;
  const lockResult = acquireLock(lockIdentity);
  if (!lockResult.ok) {
    return {
      status: "inconclusive",
      reason: lockResult.reason,
      warnings:
        lockResult.reason === "lock_unavailable"
          ? [...warnings, lockResult.detail]
          : warnings,
      isolation: isolationField,
    };
  }

  // The completed sync, set once `beginWorktree` succeeds: read by the
  // pipeline below to route the mutation, exec cwd, and patch apply at
  // the worktree instead of the original tree.
  let wtSession: WorktreeSyncSuccess | undefined;
  // Populated inside the try block as soon as each becomes known, so the
  // `finally` block's emergency-restore path can build a full result
  // even when it is reached via a thrown error partway through.
  let mutantField: MutantField | undefined;
  let mutantSummary: string | undefined;
  let verifiedAppliedVia: string | undefined;
  let baseline: ExecPhaseField | undefined;
  const controller = createRunController({
    realRoot,
    logDir: opts.logDir,
    wtScratchRoot,
    exitOnSignal: opts.exitOnSignal ?? false,
    releaseLock: lockResult.release,
    warnings,
  });
  const { execController, track, crashHandlers, cleanupWtSession } = controller;
  const exitOnSignalFlag = opts.exitOnSignal ?? false;
  // Set by the `catch` below and read by `finally`'s emergency-restore
  // path, so its warning can name what actually triggered the restore
  // instead of just "an unexpected error".
  let caughtError: unknown;

  try {
    if (!opts.allowOutside) {
      const outside = [
        { display: displayFile, real: absFile },
        ...links.map((_l, i) => ({
          display: displayLinks[i],
          real: absLinks[i],
        })),
      ].filter((p) => !isPathContained(realRoot, p.real));
      if (outside.length > 0) {
        return {
          status: "inconclusive",
          reason: "file_outside_root",
          warnings: [
            ...warnings,
            `outside the containment root (${root}): ${outside
              .map((p) => p.display)
              .join(", ")}`,
          ],
          isolation: isolationField,
          // Carries a `-p`-derived `--file`'s own numstat log path
          // through, same as every other early return above; empty for
          // an explicit `--file`, which never runs that listing.
          dryRunLogPaths: derivationLogPaths,
        };
      }
    }

    const staleMarker = await recoverTargetMarker(
      displayFile,
      absFile,
      warnings,
    );
    if (staleMarker) {
      return {
        status: "inconclusive",
        reason: staleMarker.reason,
        warnings: [...warnings, staleMarker.warning],
        isolation: isolationField,
      };
    }

    if (!fs.existsSync(displayFile)) {
      return {
        status: "usage_error",
        reason: "file_not_found",
        warnings: [...warnings, `--file not found: ${displayFile}`],
        isolation: isolationField,
      };
    }

    const preHash = await sha256File(displayFile);
    const originalContent = fs.readFileSync(displayFile, "utf8");

    if (effectiveIsolation === "worktree") {
      const preparedWt = await prepareWorktreeSession({
        root,
        cwd,
        realRoot,
        logDir: opts.logDir,
        wtScratchRoot,
        absLinks,
        controller,
        warnings,
      });
      if (!preparedWt.ok) {
        if (preparedWt.fromSync) {
          if (preparedWt.reason === "aborted") {
            // The signal handler owns the cleanup and the exit from here
            // (in CLI mode this call never returns); racing it with this
            // path's own cleanup-and-return would print an envelope for
            // a run the handler is about to end with no output at all.
            await deferToHandlerIfActive(crashHandlers, exitOnSignalFlag);
          }
          await cleanupWtSession();
        }
        return {
          status: "inconclusive",
          reason: preparedWt.reason,
          warnings: [...warnings, ...preparedWt.warnings],
          isolation: isolationField,
          ...(preparedWt.logPaths !== undefined
            ? { dryRunLogPaths: preparedWt.logPaths }
            : {}),
        };
      }
      wtSession = preparedWt.session;
      isolationField.path = wtSession.worktreePath;
      isolationField.linked = wtSession.linked;
      isolationField.syncedTrackedFiles = wtSession.syncedTrackedFiles;
      isolationField.syncedUntrackedFiles = wtSession.syncedUntrackedFiles;
    }

    // The path actually mutated: the worktree's own copy of `--file` for
    // `worktree` (never the original tree), `displayFile` itself for
    // `inplace`. Every remaining step below -- backup, mutate, `--pre`/
    // `-t`, restore, hash-verify -- operates on this path and, for the
    // patch form and the exec env, on `applyRoot`/`execCwd` below; the
    // sequence and its rules are otherwise identical between the two
    // modes.
    const mutationFilePath =
      wtSession !== undefined
        ? path.join(wtSession.worktreePath, path.relative(root, displayFile))
        : displayFile;
    const applyRoot = wtSession !== undefined ? wtSession.worktreePath : root;
    const execCwd = wtSession !== undefined ? wtSession.mappedCwd : cwd;

    // A gitignored `--file` is neither tracked (so the tracked-diff sync
    // never carries it) nor an untracked-non-ignored file (so the
    // untracked sync explicitly excludes it): under `worktree`, that
    // combination means `mutationFilePath` was simply never created, and
    // nothing downstream (`beginInplace`'s own read of it, first) can
    // succeed against it. Named here, by a typed reason, instead of
    // surfacing several frames later as a raw ENOENT.
    if (wtSession !== undefined && !fs.existsSync(mutationFilePath)) {
      return {
        status: "inconclusive",
        reason: "target_not_synced",
        warnings: [
          ...warnings,
          `--file (${displayFile}) was not synced into the worktree; it is ` +
            `neither a tracked file nor an untracked, non-ignored one, so a ` +
            `gitignored target cannot be probed under --isolation worktree`,
        ],
        isolation: isolationField,
        dryRunLogPaths: wtSession.logPaths,
      };
    }

    // `--pre`/`-t` run in the invocation cwd (where the operator ran the
    // probe from), not the containment root: a probe run from a
    // subdirectory of a monorepo must see the same cwd its test command
    // would normally get. For `worktree`, that cwd is remapped onto the
    // worktree (`execCwd`, computed above); the real apply below uses
    // `applyRoot`, since a patch's paths are relative to the repository
    // (or its worktree copy), not to wherever the probe was invoked from.
    const rt: MutantRuntime = {
      root,
      logDir: opts.logDir,
      applyRoot,
      execEnv: {
        cwd: execCwd,
        logDir: opts.logDir,
        timeoutMs: opts.timeoutMs,
        signal: execController.signal,
      },
      gitApplyTimeoutMs,
      effectiveIsolation,
      testCommand: opts.testCommand,
      preCommand: opts.preCommand,
      signal: execController.signal,
      track,
      crashHandlers,
      exitOnSignal: exitOnSignalFlag,
      setRestoreState: controller.setRestoreState,
    };

    // Backed up immediately, before the baseline (or anything else) ever
    // runs against the target: a baseline command that itself rewrites
    // the target (a formatter, a codegen step, ...) must never end up
    // being the thing this backup captures, and the check just below
    // (re-hashing after the baseline) needs a backup that already exists
    // and is verified in order to have anything trustworthy to restore
    // from once a mutation is actually applied. `restoreState` is set
    // right away too (inside `openTarget`), so a signal landing anywhere
    // from here on has a (possibly no-op) restore to run instead of
    // nothing.
    const opened = await openTarget(rt, {
      displayFile,
      absFile,
      mutationFilePath,
      preHash,
      originalContent,
    });
    if (!opened.ok) {
      return {
        status: "inconclusive",
        reason: "backup_verification_failed",
        warnings: [...warnings, opened.warning],
        isolation: isolationField,
      };
    }
    const target = opened.target;

    const prepared = await prepareMutant(
      rt,
      target,
      {
        form: opts.form,
        line,
        replaceText: opts.replaceText,
        matchText: opts.matchText,
        withText: opts.withText,
        patchPath: opts.patchPath,
        expect: opts.expect,
      },
      warnings,
    );
    // Folded in once, here, so every downstream `dryRunLogPaths:
    // stepLogPaths` (every return from this point on) also carries the
    // worktree setup's own exec logs (`git worktree add`, the
    // tracked-diff sync, the untracked-file listing) and the `-p`
    // derivation's own `git apply --numstat` log (empty unless `--file`
    // was derived) without touching each of those return sites
    // individually.
    const stepLogPaths = [
      ...derivationLogPaths,
      ...(wtSession ? wtSession.logPaths : []),
      ...prepared.logPaths,
    ];
    if (!prepared.ok) {
      target.discardBackup();
      return {
        status: "inconclusive",
        reason: prepared.reason,
        warnings,
        isolation: isolationField,
        dryRunLogPaths: stepLogPaths,
      };
    }
    mutantField = prepared.mutant;
    mutantSummary = prepared.mutantSummary;
    verifiedAppliedVia = prepared.verifiedAppliedVia;

    // (2) baseline: unmutated, must exit 0.
    const baselineStart = Date.now();
    const baselineRun = await runPreThenTest(opts, rt.execEnv, track);
    if (!baselineRun.ok) {
      noteIncompleteOutput(warnings, "baseline --pre", baselineRun.pre);
      // An aborted `--pre` (this probe was signalled, or its caller
      // aborted it) never ran to a conclusion, so it is not a `--pre`
      // that failed: it is a run that was stopped.
      const preAborted = baselineRun.pre.aborted;
      if (preAborted) {
        // Nothing has mutated the target yet: ordering only, same as
        // the computeMutant-dry-run site above.
        await deferToHandlerIfActive(crashHandlers, exitOnSignalFlag);
      }
      target.discardBackup();
      return {
        status: "inconclusive",
        reason: preAborted ? "aborted" : "pre_failed",
        warnings: [
          ...warnings,
          preAborted
            ? `--pre was aborted during the baseline run; see ${baselineRun.pre.logPath}`
            : `--pre exited ${baselineRun.pre.exitCode} during the baseline run; see ${baselineRun.pre.logPath}`,
        ],
        mutant: mutantField,
        isolation: isolationField,
        dryRunLogPaths: [...stepLogPaths, baselineRun.pre.logPath],
      };
    }
    const baselineTest = baselineRun.test;
    noteIncompleteOutput(warnings, "baseline", baselineTest);
    baseline = {
      exitCode: baselineTest.exitCode,
      durationMs: Date.now() - baselineStart,
      logPath: baselineTest.logPath,
      timedOut: baselineTest.timedOut,
    };
    if (baselineTest.exitCode !== 0 || baselineTest.aborted) {
      if (baselineTest.aborted) {
        // If the handler is active it may already have restored the
        // target (a no-op copy of still-original content, since nothing
        // has mutated it yet at this phase); wait for that before
        // re-hashing below, so the re-hash reads settled content.
        await deferToHandlerIfActive(crashHandlers, exitOnSignalFlag);
      }
      // A failing baseline is still a baseline that ran commands against
      // the working tree, and one of them may have rewritten the target
      // (a formatter, a codegen step). Re-hash before deciding what to do
      // with the backup: discarding it silently would throw away the only
      // copy of the target's pre-baseline content.
      const postHash = await sha256File(mutationFilePath).catch(
        () => undefined,
      );
      if (postHash === preHash) {
        target.discardBackup();
      } else {
        // Keep the backup file itself, and stop treating a mutation as in
        // flight: nothing was mutated, so there is nothing to restore, and
        // the target is deliberately left as the baseline wrote it.
        controller.setRestoreState(null);
        warnings.push(
          `the failing baseline run also rewrote the target; the target is left as the baseline wrote it (not restored), and its pre-baseline content is kept at ${target.session.backupPath}`,
        );
      }
      // An aborted baseline is not a red baseline: nothing about the
      // test was learned, the run was stopped. Reported apart from a
      // baseline that genuinely failed, so a caller cannot read a
      // cancelled probe as a broken test suite.
      if (baselineTest.aborted) {
        warnings.push(
          `the baseline run was aborted; see ${baselineTest.logPath}`,
        );
      }
      return {
        status: "inconclusive",
        reason: baselineTest.aborted ? "aborted" : "baseline_failed",
        warnings,
        baseline,
        isolation: isolationField,
        dryRunLogPaths: stepLogPaths,
      };
    }

    // The baseline run (the `--pre`/`-t` commands themselves, not this
    // probe) is the only thing that has touched the filesystem since the
    // backup was taken and verified above: re-hash the target and, if it
    // no longer matches `preHash`, a formatter/codegen/build step run as
    // part of the baseline rewrote it. Aborting here (before any
    // mutation or marker exists) leaves that rewrite exactly as the
    // baseline left it -- restoring from the backup would instead throw
    // away a legitimate write this probe never made.
    const postBaselineHash = await sha256File(mutationFilePath).catch(
      () => undefined,
    );
    if (postBaselineHash !== preHash) {
      target.discardBackup();
      return {
        status: "inconclusive",
        reason: "target_changed_during_baseline",
        warnings: [
          ...warnings,
          `the target changed during the baseline run (before any mutation was applied); the target is left as the baseline run wrote it, not restored`,
        ],
        mutant: mutantField,
        baseline,
        isolation: isolationField,
        dryRunLogPaths: stepLogPaths,
      };
    }

    // (3) marker, (4) apply, pre+test, (5) restore, (6) verify the
    // restore by hash, (7) classify: one mutant, through the same step a
    // plan runs once per mutant.
    const outcome = await runMutantAttempt(
      rt,
      target,
      {
        form: opts.form,
        line,
        replaceText: opts.replaceText,
        matchText: opts.matchText,
        withText: opts.withText,
        patchPath: opts.patchPath,
        expect: opts.expect,
      },
      {
        computed: prepared.computed,
        mutant: prepared.mutant,
        mutantSummary: prepared.mutantSummary,
        verifiedAppliedVia: prepared.verifiedAppliedVia,
        logPaths: stepLogPaths,
      },
      warnings,
    );
    return {
      status: outcome.status,
      reason: outcome.reason,
      warnings,
      ...(outcome.mutant !== undefined ? { mutant: outcome.mutant } : {}),
      ...(outcome.mutation_probe !== undefined
        ? { mutation_probe: outcome.mutation_probe }
        : {}),
      baseline,
      ...(outcome.test !== undefined ? { test: outcome.test } : {}),
      isolation: isolationField,
      dryRunLogPaths: outcome.logPaths,
    };
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    let emergencyResult: ProbeResult | undefined;
    const inFlightRestore = controller.getRestoreState();
    if (inFlightRestore) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above. The rule this backstop
      // enforces: no path out of this function may leave the target
      // mutated, whether it returns or throws. A restore failure here
      // still has to surface as `inconclusive`/`restore_failed`, never
      // silently as whatever exception triggered this path.
      const state = inFlightRestore;
      controller.setRestoreState(null);
      let restored = false;
      try {
        restored = state.restore();
      } catch {
        restored = false;
      }
      let verified = false;
      if (restored) {
        const hash = await sha256File(state.targetPath).catch(() => undefined);
        verified = hash === state.preHash;
      }
      if (verified) {
        removeMarkerFor(state.markerKey);
      } else {
        const causeMessage =
          caughtError instanceof Error
            ? caughtError.message
            : caughtError !== undefined
              ? String(caughtError)
              : undefined;
        emergencyResult = {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed after an unexpected error${
              causeMessage ? ` (${causeMessage})` : ""
            }; the original content is preserved at backup path ${state.backupPath}`,
          ],
          ...(mutantField ? { mutant: mutantField } : {}),
          ...(mutantSummary && verifiedAppliedVia
            ? {
                mutation_probe: {
                  mutant: mutantSummary,
                  verified_applied_via: verifiedAppliedVia,
                  result: "inconclusive",
                  restored_verified: false,
                },
              }
            : {}),
          ...(baseline ? { baseline } : {}),
          isolation: isolationField,
        };
      }
    }
    // Runs on every exit path (a normal return, a thrown error, or the
    // emergency-restore path above) and is idempotent: a signal handler
    // that already ran it leaves this a no-op. Cleanup happens before
    // the lock is released, so a concurrent probe on the same repository
    // never observes the lock as free while this run's worktree removal
    // is still in flight.
    await cleanupWtSession();
    crashHandlers.remove();
    lockResult.release();
    if (emergencyResult) return emergencyResult;
  }
}

/** Options for one `--plan` run: the mutants, the command they share,
 * and the run-shaping values already resolved (a plan file's own values
 * and any command-line override are reconciled by the caller, see
 * `cli.ts`). */
export interface ProbePlanOptions {
  /** At least one; applied in this order, never in parallel. */
  mutants: PlanMutantSpec[];
  testCommand: string;
  preCommand?: string;
  isolation: IsolationMode;
  /** The plan-level default; a mutant's own `expect` wins over it. */
  expect: ExpectVerdict;
  timeoutMs?: number;
  links?: string[];
  allowOutside?: boolean;
  cwd: string;
  logDir: string;
  /** See `ProbeOptions.exitOnSignal`: `true` for the CLI, whose process
   * exists to run exactly this plan. */
  exitOnSignal?: boolean;
}

/** A mutant's verdict inside a plan. `not_run` is the honest report for
 * a mutant a terminal failure stopped the plan before reaching: never
 * `inconclusive`, which would claim the mutant was attempted. */
export type PlanMutantStatus =
  "killed" | "survived" | "inconclusive" | "not_run";

export interface PlanMutantResult {
  /** Position in the plan's own `mutants` array, so a result is
   * traceable back to the entry that produced it even when several
   * mutants share a file. */
  index: number;
  file: string;
  expect: ExpectVerdict;
  status: PlanMutantStatus;
  reason?: string;
  /** This mutant's own warnings; the plan's setup and teardown warnings
   * stay on the plan. */
  warnings: string[];
  mutant?: MutantField;
  mutation_probe?: MutationProbeField;
  test?: TestPhaseField;
  /** Exec log paths this mutant produced (its dry run, its real apply). */
  logs: string[];
}

export interface PlanSummaryField {
  total: number;
  killed: number;
  survived: number;
  inconclusive: number;
  not_run: number;
}

export interface ProbePlanResult {
  status: ProbeStatus;
  reason?: string;
  warnings: string[];
  /** The one baseline every mutant of this plan was measured against;
   * absent when the plan never reached it. */
  baseline?: ExecPhaseField;
  results: PlanMutantResult[];
  summary: PlanSummaryField;
  isolation: IsolationField;
  /** Exec log paths the plan's own setup produced (the worktree sync);
   * a mutant's own logs stay on its result. */
  dryRunLogPaths?: string[];
}

function summarize(results: PlanMutantResult[]): PlanSummaryField {
  const count = (status: PlanMutantStatus): number =>
    results.filter((r) => r.status === status).length;
  return {
    total: results.length,
    killed: count("killed"),
    survived: count("survived"),
    inconclusive: count("inconclusive"),
    not_run: count("not_run"),
  };
}

/**
 * Runs a list of mutants that share one test command against ONE
 * baseline, in order, each applied and then restored before the next is
 * applied. The pipeline is the single probe's, with the mutate ->
 * pre+test -> restore -> verify -> classify step (`prepareMutant` and
 * `runMutantAttempt`, the very functions `probe()` calls) run once per
 * mutant between a shared setup and a shared teardown.
 *
 * The invariants this split holds to:
 *
 * - I1 exactly one baseline per plan, run before any mutant is applied.
 * - I2 the target is restored, and that restore verified by hash, before
 *   the next mutant is applied; the loop re-hashes the target itself
 *   before every apply, so a restore that silently did not happen stops
 *   the plan instead of letting mutant N+1 land on mutant N's content.
 * - I3 a restore that could not be verified is terminal: nothing further
 *   is applied and every remaining mutant is reported `not_run`, with
 *   the marker and the backup left exactly as the single probe leaves
 *   them.
 * - I4 the worktree is synced once per plan and cleaned up once, however
 *   the plan ends.
 * - I5 a signal restores the in-flight mutant and ends the plan: the
 *   handler owns the CURRENT mutant's restore state at every moment
 *   (`runMutantAttempt` re-arms it before each apply and clears it after
 *   each verified restore), and the loop stops rather than starting the
 *   next mutant. On the CLI the handler ends the process itself, with
 *   exit 130/143 and no output.
 * - I6 the single-probe path is unchanged: `probe()` runs the same
 *   setup, the same one step, and the same teardown it always did.
 */
export async function probePlan(
  opts: ProbePlanOptions,
): Promise<ProbePlanResult> {
  const warnings: string[] = [];
  const isolationField = emptyIsolationField(opts.isolation);
  const cwd = path.resolve(opts.cwd);
  const gitRoot = findGitRoot(cwd);
  const root = gitRoot ?? path.resolve(cwd);
  const realRoot = resolveDeepestExisting(root);
  const gitApplyTimeoutMs = opts.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS;
  const links = opts.links ?? [];
  const displayLinks = links.map((l) => path.resolve(cwd, l));
  const absLinks = displayLinks.map(resolveDeepestExisting);
  const wtScratchRoot = path.resolve(opts.logDir);

  /** One entry of the plan, resolved: every path in a plan file (`file`,
   * `patch`) is resolved against the invocation cwd, so one plan means
   * the same thing from wherever it is run with the same `--cwd`. */
  interface PlannedMutant {
    index: number;
    displayFile: string;
    absFile: string;
    spec: MutantStepSpec;
  }
  const planned: PlannedMutant[] = opts.mutants.map((mutant, index) => {
    const displayFile = path.resolve(cwd, mutant.file);
    return {
      index,
      displayFile,
      absFile: resolveDeepestExisting(displayFile),
      spec: {
        form: mutant.form,
        line: mutant.line,
        replaceText: mutant.replaceText,
        matchText: mutant.matchText,
        withText: mutant.withText,
        patchPath:
          mutant.patchPath === undefined
            ? undefined
            : path.resolve(cwd, mutant.patchPath),
        expect: mutant.expect ?? opts.expect,
      },
    };
  });
  // The plan's own setup logs (the worktree sync), folded into every
  // return from here on so a refusal after the sync still names the logs
  // it produced. Declared ahead of `refuse` below, which reads it.
  let setupLogPaths: string[] = [];
  const notRunResult = (item: PlannedMutant): PlanMutantResult => ({
    index: item.index,
    file: item.displayFile,
    expect: item.spec.expect,
    status: "not_run",
    warnings: [],
    logs: [],
  });
  const allNotRun = (): PlanMutantResult[] => planned.map(notRunResult);
  const refuse = (
    status: ProbeStatus,
    reason: string,
    message?: string,
  ): ProbePlanResult => {
    const results = allNotRun();
    return {
      status,
      reason,
      warnings: message === undefined ? warnings : [...warnings, message],
      results,
      summary: summarize(results),
      isolation: isolationField,
      ...(setupLogPaths.length > 0 ? { dryRunLogPaths: setupLogPaths } : {}),
    };
  };

  // Validation, all of it before the lock, the marker, the baseline or
  // any worktree: a plan that cannot be used leaves nothing behind.
  if (planned.length === 0) {
    return refuse(
      "usage_error",
      "plan_empty",
      "--plan carries no mutants; a plan needs at least one",
    );
  }
  for (const item of planned) {
    if (item.spec.form !== "patch" && item.spec.line === undefined) {
      return refuse(
        "usage_error",
        "plan_invalid",
        `plan.mutants[${String(item.index)}].line is required for the "${item.spec.form}" form`,
      );
    }
    if (item.spec.form === "patch" && opts.allowOutside) {
      // Same refusal the single probe makes for `-p` with
      // `--allow-outside`, and for the same reason: the dry run's
      // scratch placement is relative to the containment root, which a
      // path outside that root can escape with `../` components.
      return refuse(
        "usage_error",
        "patch_allow_outside_unsupported",
        `plan.mutants[${String(item.index)}] uses "patch", which cannot be combined with --allow-outside`,
      );
    }
  }

  // `worktree` needs a real git work tree to branch a worktree off of;
  // outside one there is nothing to isolate into, so the mode falls back
  // to `inplace` (named in a warning) instead of failing outright.
  let effectiveIsolation = opts.isolation;
  if (effectiveIsolation === "worktree" && gitRoot === undefined) {
    effectiveIsolation = "inplace";
    warnings.push(
      "not inside a git work tree; falling back to --isolation inplace",
    );
  }
  isolationField.mode = effectiveIsolation;
  if (effectiveIsolation === "worktree" && opts.allowOutside) {
    return refuse(
      "usage_error",
      "worktree_allow_outside_unsupported",
      "--isolation worktree cannot be combined with --allow-outside",
    );
  }

  for (const item of planned) {
    if (item.spec.form !== "patch") continue;
    const unusable = patchUnusableReason(
      item.spec.patchPath ?? "",
      `plan.mutants[${String(item.index)}].patch`,
    );
    if (unusable !== undefined) {
      return refuse("usage_error", "patch_not_readable", unusable);
    }
  }

  // Containment for EVERY file of the plan (and every `--link`) up
  // front: one file outside the root refuses the whole plan rather than
  // being discovered halfway through, with earlier mutants already run.
  if (!opts.allowOutside) {
    const outside = [
      ...planned.map((item) => ({
        display: item.displayFile,
        real: item.absFile,
      })),
      ...displayLinks.map((display, i) => ({ display, real: absLinks[i] })),
    ].filter((p) => !isPathContained(realRoot, p.real));
    if (outside.length > 0) {
      return refuse(
        "usage_error",
        "file_outside_root",
        `outside the containment root (${root}): ${[
          ...new Set(outside.map((p) => p.display)),
        ].join(", ")}`,
      );
    }
  }

  // The lock is keyed on the repository whenever there is one, exactly
  // as the single probe keys it: two probes on the same repository are
  // never independent, whatever their target files. Outside a
  // repository there is no shared tree and each target file is its own
  // identity, so a plan takes one lock per distinct target -- the same
  // identities a single probe on each of those files would take, so a
  // plan and a single probe still exclude each other there. Acquisition
  // never queues (a held lock is refused outright), so taking several
  // cannot deadlock; a refusal releases whatever this call already took.
  const lockIdentities =
    gitRoot !== undefined
      ? [realRoot]
      : [...new Set(planned.map((item) => item.absFile))].sort();
  const acquired: (() => void)[] = [];
  const releaseLocks = (): void => {
    for (const release of acquired) release();
  };
  for (const identity of lockIdentities) {
    const lockResult = acquireLock(identity);
    if (!lockResult.ok) {
      releaseLocks();
      return refuse(
        "inconclusive",
        lockResult.reason,
        lockResult.reason === "lock_unavailable"
          ? lockResult.detail
          : undefined,
      );
    }
    acquired.push(lockResult.release);
  }

  let wtSession: WorktreeSyncSuccess | undefined;
  let baseline: ExecPhaseField | undefined;
  const controller = createRunController({
    realRoot,
    logDir: opts.logDir,
    wtScratchRoot,
    exitOnSignal: opts.exitOnSignal ?? false,
    releaseLock: releaseLocks,
    warnings,
  });
  const { execController, track, crashHandlers, cleanupWtSession } = controller;
  const exitOnSignalFlag = opts.exitOnSignal ?? false;
  let caughtError: unknown;

  try {
    // Stale in-flight markers, one per distinct target: the same
    // hash-based recovery the single probe runs, refusing the whole plan
    // when any target's marker cannot be recovered.
    const distinct = new Map<
      string,
      { displayFile: string; absFile: string }
    >();
    for (const item of planned) {
      if (!distinct.has(item.absFile)) {
        distinct.set(item.absFile, {
          displayFile: item.displayFile,
          absFile: item.absFile,
        });
      }
    }
    for (const entry of distinct.values()) {
      const stale = await recoverTargetMarker(
        entry.displayFile,
        entry.absFile,
        warnings,
      );
      if (stale) {
        return refuse("inconclusive", stale.reason, stale.warning);
      }
      if (!fs.existsSync(entry.displayFile)) {
        return refuse(
          "usage_error",
          "file_not_found",
          `plan file not found: ${entry.displayFile}`,
        );
      }
    }

    if (effectiveIsolation === "worktree") {
      const prepared = await prepareWorktreeSession({
        root,
        cwd,
        realRoot,
        logDir: opts.logDir,
        wtScratchRoot,
        absLinks,
        controller,
        warnings,
      });
      if (!prepared.ok) {
        if (prepared.fromSync) {
          if (prepared.reason === "aborted") {
            // The signal handler owns the cleanup and the exit from here
            // (in CLI mode this call never returns); racing it with this
            // path's own cleanup-and-return would print an envelope for
            // a run the handler is about to end with no output at all.
            await deferToHandlerIfActive(crashHandlers, exitOnSignalFlag);
          }
          await cleanupWtSession();
        }
        const results = allNotRun();
        return {
          status: "inconclusive",
          reason: prepared.reason,
          warnings: [...warnings, ...prepared.warnings],
          results,
          summary: summarize(results),
          isolation: isolationField,
          ...(prepared.logPaths !== undefined
            ? { dryRunLogPaths: prepared.logPaths }
            : {}),
        };
      }
      wtSession = prepared.session;
      isolationField.path = wtSession.worktreePath;
      isolationField.linked = wtSession.linked;
      isolationField.syncedTrackedFiles = wtSession.syncedTrackedFiles;
      isolationField.syncedUntrackedFiles = wtSession.syncedUntrackedFiles;
      setupLogPaths = wtSession.logPaths;
    }

    const rt: MutantRuntime = {
      root,
      logDir: opts.logDir,
      applyRoot: wtSession !== undefined ? wtSession.worktreePath : root,
      execEnv: {
        cwd: wtSession !== undefined ? wtSession.mappedCwd : cwd,
        logDir: opts.logDir,
        timeoutMs: opts.timeoutMs,
        signal: execController.signal,
      },
      gitApplyTimeoutMs,
      effectiveIsolation,
      testCommand: opts.testCommand,
      preCommand: opts.preCommand,
      signal: execController.signal,
      track,
      crashHandlers,
      exitOnSignal: exitOnSignalFlag,
      setRestoreState: controller.setRestoreState,
    };

    // Every target is backed up (and each backup verified by hash)
    // BEFORE the baseline runs, the same ordering the single probe
    // keeps: a baseline command that rewrites a target must never be
    // what a backup captured. One session per distinct file, reused by
    // every mutant that targets it -- the file is restored to that same
    // pre-mutation content between mutants, so one backup stays valid
    // for all of them.
    const targets = new Map<string, TargetSession>();
    for (const entry of distinct.values()) {
      const mutationFilePath =
        wtSession !== undefined
          ? path.join(
              wtSession.worktreePath,
              path.relative(root, entry.displayFile),
            )
          : entry.displayFile;
      // A gitignored target is neither tracked nor an untracked,
      // non-ignored file, so under `worktree` it was simply never
      // synced; named by a typed reason instead of surfacing as a raw
      // ENOENT several frames later.
      if (wtSession !== undefined && !fs.existsSync(mutationFilePath)) {
        return refuse(
          "inconclusive",
          "target_not_synced",
          `${entry.displayFile} was not synced into the worktree; it is ` +
            `neither a tracked file nor an untracked, non-ignored one, so a ` +
            `gitignored target cannot be probed under --isolation worktree`,
        );
      }
      const preHash = await sha256File(entry.displayFile);
      const opened = await openTarget(rt, {
        displayFile: entry.displayFile,
        absFile: entry.absFile,
        mutationFilePath,
        preHash,
        originalContent: fs.readFileSync(mutationFilePath, "utf8"),
      });
      if (!opened.ok) {
        return refuse(
          "inconclusive",
          "backup_verification_failed",
          opened.warning,
        );
      }
      targets.set(entry.absFile, opened.target);
    }
    // Nothing is mutated until the first mutant is applied, so nothing
    // is in flight for the handler to restore; `runMutantAttempt` arms
    // the slot per mutant from here on.
    controller.setRestoreState(null);

    // (2) baseline: unmutated, must exit 0. Once per plan (I1).
    const baselineStart = Date.now();
    const baselineRun = await runPreThenTest(opts, rt.execEnv, track);
    if (!baselineRun.ok) {
      noteIncompleteOutput(warnings, "baseline --pre", baselineRun.pre);
      const preAborted = baselineRun.pre.aborted;
      if (preAborted) {
        await deferToHandlerIfActive(crashHandlers, exitOnSignalFlag);
      }
      for (const target of targets.values()) target.discardBackup();
      return refuse(
        "inconclusive",
        preAborted ? "aborted" : "pre_failed",
        preAborted
          ? `--pre was aborted during the baseline run; see ${baselineRun.pre.logPath}`
          : `--pre exited ${baselineRun.pre.exitCode} during the baseline run; see ${baselineRun.pre.logPath}`,
      );
    }
    const baselineTest = baselineRun.test;
    noteIncompleteOutput(warnings, "baseline", baselineTest);
    baseline = {
      exitCode: baselineTest.exitCode,
      durationMs: Date.now() - baselineStart,
      logPath: baselineTest.logPath,
      timedOut: baselineTest.timedOut,
    };
    // A baseline that failed (or was stopped) ends the plan with no
    // mutant applied at all: every target is still at its pre-baseline
    // hash unless the baseline itself rewrote it, and a backup whose
    // target the baseline rewrote is kept rather than discarded, so the
    // pre-baseline content survives.
    if (baselineTest.exitCode !== 0 || baselineTest.aborted) {
      if (baselineTest.aborted) {
        await deferToHandlerIfActive(crashHandlers, exitOnSignalFlag);
      }
      for (const target of targets.values()) {
        const postHash = await sha256File(target.mutationFilePath).catch(
          () => undefined,
        );
        if (postHash === target.preHash) {
          target.discardBackup();
        } else {
          warnings.push(
            `the failing baseline run also rewrote ${target.displayFile}; the target is left as the baseline wrote it (not restored), and its pre-baseline content is kept at ${target.session.backupPath}`,
          );
        }
      }
      controller.setRestoreState(null);
      if (baselineTest.aborted) {
        warnings.push(
          `the baseline run was aborted; see ${baselineTest.logPath}`,
        );
      }
      const results = allNotRun();
      return {
        status: "inconclusive",
        reason: baselineTest.aborted ? "aborted" : "baseline_failed",
        warnings,
        baseline,
        results,
        summary: summarize(results),
        isolation: isolationField,
        dryRunLogPaths: setupLogPaths,
      };
    }

    // The baseline's own commands are the only thing that has touched
    // the filesystem since the backups were taken: a target the baseline
    // rewrote is left exactly as the baseline wrote it, and no mutant is
    // applied on top of it.
    for (const target of targets.values()) {
      const postBaselineHash = await sha256File(target.mutationFilePath).catch(
        () => undefined,
      );
      if (postBaselineHash !== target.preHash) {
        const results = allNotRun();
        return {
          status: "inconclusive",
          reason: "target_changed_during_baseline",
          warnings: [
            ...warnings,
            `${target.displayFile} changed during the baseline run (before any mutation was applied); the target is left as the baseline run wrote it, not restored`,
          ],
          baseline,
          results,
          summary: summarize(results),
          isolation: isolationField,
          dryRunLogPaths: setupLogPaths,
        };
      }
    }

    // One mutant at a time, never in parallel: each is applied against a
    // target proven to be back at its pre-mutation content, tested, and
    // restored before the next one is even computed.
    const results: PlanMutantResult[] = [];
    let terminal: string | undefined;
    for (const item of planned) {
      if (terminal !== undefined) {
        results.push(notRunResult(item));
        continue;
      }
      const target = targets.get(item.absFile);
      // Unreachable in practice: every planned mutant's file was opened
      // above, and this map is keyed by the same resolved path. Kept as
      // a typed narrowing that reports `not_run` rather than throwing,
      // so a future caller that plans a target it never opened cannot
      // turn that into an unhandled exception mid-plan.
      if (target === undefined) {
        results.push(notRunResult(item));
        continue;
      }
      const mutantWarnings: string[] = [];
      // I2, checked from the applying side: the previous mutant's
      // restore was verified when it ran, and the target is verified to
      // be back at its pre-mutation content here, before this mutant is
      // applied on top of it. A restore that silently did not happen
      // stops the plan instead of producing a verdict about a mutant
      // measured against another mutant's content.
      const currentHash = await sha256File(target.mutationFilePath).catch(
        () => undefined,
      );
      if (currentHash !== target.preHash) {
        terminal = "target_not_restored";
        results.push({
          index: item.index,
          file: item.displayFile,
          expect: item.spec.expect,
          status: "inconclusive",
          reason: "target_not_restored",
          warnings: [
            `${target.displayFile} was not at its pre-mutation content when this mutant was about to be applied; nothing further was applied, and the original content is preserved at backup path ${target.session.backupPath}`,
          ],
          logs: [],
        });
        continue;
      }
      const prepared = await prepareMutant(
        rt,
        target,
        item.spec,
        mutantWarnings,
      );
      if (!prepared.ok) {
        // Nothing was applied, so this mutant is inconclusive on its own
        // and the plan continues -- unless the run itself was stopped.
        if (prepared.reason === "aborted" || crashHandlers.isHandling()) {
          terminal = "aborted";
        }
        results.push({
          index: item.index,
          file: item.displayFile,
          expect: item.spec.expect,
          status: "inconclusive",
          reason: prepared.reason,
          warnings: mutantWarnings,
          logs: prepared.logPaths,
        });
        continue;
      }
      const outcome = await runMutantAttempt(
        rt,
        target,
        item.spec,
        {
          computed: prepared.computed,
          mutant: prepared.mutant,
          mutantSummary: prepared.mutantSummary,
          verifiedAppliedVia: prepared.verifiedAppliedVia,
          logPaths: prepared.logPaths,
        },
        mutantWarnings,
      );
      results.push({
        index: item.index,
        file: item.displayFile,
        expect: item.spec.expect,
        status: outcome.status,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        warnings: mutantWarnings,
        ...(outcome.mutant !== undefined ? { mutant: outcome.mutant } : {}),
        ...(outcome.mutation_probe !== undefined
          ? { mutation_probe: outcome.mutation_probe }
          : {}),
        ...(outcome.test !== undefined ? { test: outcome.test } : {}),
        logs: outcome.logPaths,
      });
      // I3: a restore that could not be verified is terminal for the
      // plan. I5: so is a signal, whether this mutant's own phase
      // reported the abort or the handler is only just acting on it --
      // the next mutant must never start.
      if (outcome.restoreFailed) terminal = "restore_failed";
      else if (outcome.aborted || crashHandlers.isHandling()) {
        terminal = "aborted";
      }
    }

    // The exit-code contract, one step stricter than "any survived is a
    // finding": exit 1 (`survived`) is reserved for a plan that
    // CONCLUDED and found a survivor, so a plan that stopped early, or
    // one carrying a mutant nothing could be learned from, is exit 2
    // (`inconclusive`) even when a survivor is among its results.
    const summary = summarize(results);
    let status: ProbeStatus;
    let reason: string | undefined = terminal;
    if (terminal !== undefined) {
      status = "inconclusive";
    } else if (summary.inconclusive > 0 || summary.not_run > 0) {
      status = "inconclusive";
      reason = "mutant_inconclusive";
    } else if (summary.survived > 0) {
      status = "survived";
    } else {
      status = "killed";
    }
    return {
      status,
      ...(reason !== undefined ? { reason } : {}),
      warnings,
      baseline,
      results,
      summary,
      isolation: isolationField,
      dryRunLogPaths: setupLogPaths,
    };
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    let emergencyResult: ProbePlanResult | undefined;
    const inFlightRestore = controller.getRestoreState();
    if (inFlightRestore) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above: no path out of this
      // function may leave a target mutated, whether it returns or
      // throws.
      const state = inFlightRestore;
      controller.setRestoreState(null);
      let restored = false;
      try {
        restored = state.restore();
      } catch {
        restored = false;
      }
      let verified = false;
      if (restored) {
        const hash = await sha256File(state.targetPath).catch(() => undefined);
        verified = hash === state.preHash;
      }
      if (verified) {
        removeMarkerFor(state.markerKey);
      } else {
        const causeMessage =
          caughtError instanceof Error
            ? caughtError.message
            : caughtError !== undefined
              ? String(caughtError)
              : undefined;
        const results = allNotRun();
        emergencyResult = {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed after an unexpected error${
              causeMessage ? ` (${causeMessage})` : ""
            }; the original content is preserved at backup path ${state.backupPath}`,
          ],
          ...(baseline ? { baseline } : {}),
          results,
          summary: summarize(results),
          isolation: isolationField,
        };
      }
    }
    // Once per plan (I4), before the locks are released, so a concurrent
    // probe never observes the lock as free while this run's worktree
    // removal is still in flight.
    await cleanupWtSession();
    crashHandlers.remove();
    releaseLocks();
    if (emergencyResult) return emergencyResult;
  }
}
