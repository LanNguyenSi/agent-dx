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
  type InplaceSession,
  type WorktreeSyncSuccess,
} from "./isolation.js";
import {
  applyPatchForReal,
  computeMutant,
  DEFAULT_GIT_APPLY_TIMEOUT_MS,
  formatMutantSummary,
  formatVerifiedAppliedVia,
  type MutantForm,
  type MutantSpec,
} from "./mutant.js";

export type IsolationMode = "worktree" | "inplace";
export type ExpectVerdict = "fail" | "pass";

export interface ProbeOptions {
  /** As given on the CLI; resolved against `cwd`. */
  file: string;
  line: number;
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
 *    worktree (`git worktree remove --force` then `git worktree
 *    prune`), releasing the repository-keyed marker only once that
 *    succeeds; a no-op when no worktree session was ever started.
 *    Best-effort: a failed cleanup leaves the marker in place for the
 *    next probe on this repository (or `doctor`) to recover.
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

/**
 * Runs the full probe pipeline: lock -> containment -> stale-marker
 * recovery -> baseline -> mutate -> pre+test -> restore -> verify ->
 * classify. See 01-plan.md's "`probe`: mutation-probe runner" section
 * for the full contract this implements.
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
  const displayFile = path.resolve(cwd, opts.file);
  // The git work-tree root when there is one, else `cwd`: the same value
  // `containmentRoot` computes, kept in two variables because the lock
  // below has to tell "in a repository" from "not in one".
  const gitRoot = findGitRoot(cwd);
  const root = gitRoot ?? path.resolve(cwd);
  const links = opts.links ?? [];
  const displayLinks = links.map((l) => path.resolve(cwd, l));
  // `--timeout` is the caller saying how long any step of this probe may
  // run, so every `git apply` gets that same bound; without one they
  // keep the fixed default, since an apply that hangs would otherwise
  // sit under an in-flight marker forever.
  const gitApplyTimeoutMs = opts.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS;

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

  let restoreState: RestoreState | null = null;
  // Set once `beginWorktree` succeeds; read both by the pipeline below
  // (to route the mutation, exec cwd, and patch apply at the worktree
  // instead of the original tree) and by `finally`/the signal handler
  // (to clean the worktree up on every exit path).
  let wtSession: WorktreeSyncSuccess | undefined;
  let wtWorktreePath: string | undefined;
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
      const result = await cleanupWorktree(
        realRoot,
        worktreePathForCleanup,
        opts.logDir,
      ).catch(() => ({ ok: false, logPaths: [] as string[] }));
      if (result.ok) {
        removeMarkerFor(realRoot);
      } else {
        warnings.push(
          `git worktree remove/prune did not fully succeed for ${worktreePathForCleanup}; ` +
            `it is left registered for the next probe on this repository (or ` +
            `\`agent-primitives doctor\`) to recover`,
        );
      }
    })();
    return wtCleanupPromise;
  };
  // Populated inside the try block as soon as each becomes known, so the
  // `finally` block's emergency-restore path can build a full result
  // even when it is reached via a thrown error partway through.
  let mutantField: MutantField | undefined;
  let mutantSummary: string | undefined;
  let verifiedAppliedVia: string | undefined;
  let baseline: ExecPhaseField | undefined;
  // Scopes every child this probe starts: the `--pre`/`-t` commands
  // through `exec.ts` and every `git apply` through `run.ts`. The
  // SIGINT/SIGTERM handler aborts it before restoring, which SIGKILLs
  // that child's whole process group, so an emergency restore never
  // races a process still running against (and possibly still writing)
  // the target file.
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
    lockResult.release,
    () => execController.abort(),
    waitForInFlight,
    opts.exitOnSignal ?? false,
    cleanupWtSession,
  );
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
        };
      }
    }

    const marker = readMarkerFor(absFile);
    if (marker) {
      // Under the lock, ANY marker for this target is an unfinished
      // probe: the lock already excludes a second live probe, and pids
      // recycle, so the marker's own `pid` field is not consulted here
      // (it is written for a human reading the marker file, nothing
      // more). Hash-based recovery is unconditional.
      const currentHash = fs.existsSync(displayFile)
        ? await sha256File(displayFile).catch(() => undefined)
        : undefined;
      // The one thing every recovery path below except "already back at
      // preHash" needs is the backup itself; when it is gone (its
      // per-run log dir can easily not have survived, e.g. cleaned up
      // or never created on this machine at all), automatic recovery is
      // not possible and must say so by name, not surface as a generic
      // restore failure.
      if (!fs.existsSync(marker.backupPath) && currentHash !== marker.preHash) {
        return {
          status: "inconclusive",
          reason: "stale_probe_marker",
          warnings: [
            ...warnings,
            `stale probe marker found for ${displayFile}, but its backup is missing (${marker.backupPath}); automatic recovery is not possible; delete the marker file to clear it: ${markerFilePathFor(absFile)}`,
          ],
          isolation: isolationField,
        };
      }
      if (currentHash !== undefined && currentHash === marker.mutatedHash) {
        // The backup is hashed and required to match the marker's own
        // recorded pre-mutation hash BEFORE it is copied anywhere. The
        // copy is destructive and irreversible: a backup that is corrupt,
        // truncated, or simply not this target's content would otherwise
        // be written over the target, destroying the only remaining copy
        // of the mutated file and reporting `stale_probe_marker` as if
        // the target had been left alone.
        const backupHash = await sha256File(marker.backupPath).catch(
          () => undefined,
        );
        if (backupHash !== marker.preHash) {
          return {
            status: "inconclusive",
            reason: "stale_probe_marker",
            warnings: [
              ...warnings,
              `stale probe marker found for ${displayFile}, but its backup does not match the pre-mutation hash the marker records (${marker.backupPath}); the target was left untouched; inspect the backup, then delete the marker file to clear it: ${markerFilePathFor(absFile)}`,
            ],
            isolation: isolationField,
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
            status: "inconclusive",
            reason: "stale_probe_marker",
            warnings: [
              ...warnings,
              `automatic recovery of a stale probe marker failed; backup at ${marker.backupPath}`,
            ],
            isolation: isolationField,
          };
        }
        removeMarkerFor(absFile);
        warnings.push("recovered_stale_probe");
      } else if (currentHash !== undefined && currentHash === marker.preHash) {
        // Already back at the pre-mutation content (e.g. a previous
        // invocation restored but crashed before removing the marker):
        // nothing to recover, just clear the stale marker and continue.
        removeMarkerFor(absFile);
        warnings.push(
          `removed a stale probe marker whose target already matched its recorded pre-mutation hash; backup at ${marker.backupPath}`,
        );
      } else {
        return {
          status: "inconclusive",
          reason: "stale_probe_marker",
          warnings: [
            ...warnings,
            `stale in-flight probe marker found for ${displayFile}; backup at ${marker.backupPath}`,
          ],
          isolation: isolationField,
        };
      }
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
      // A leftover worktree from a previous run on this same repository
      // that never reached its own cleanup (SIGKILL, a crash): the lock
      // already excludes a live probe on this repository, so any marker
      // found here is unconditionally treated as stale, mirroring the
      // absFile marker recovery above. Recovery is a plain remove+prune;
      // nothing in the original tree was ever touched by a worktree-mode
      // probe, so there is no backup/hash proof to check first.
      const staleWt = readMarkerFor(realRoot);
      if (staleWt) {
        await cleanupWorktree(realRoot, staleWt.targetPath, opts.logDir).catch(
          () => undefined,
        );
        removeMarkerFor(realRoot);
        warnings.push("recovered_stale_worktree");
      }

      const wt = await beginWorktree({
        root,
        cwd,
        logDir: opts.logDir,
        links: absLinks,
      });
      if (!wt.ok) {
        if (wt.worktreePath) {
          wtWorktreePath = wt.worktreePath;
          await cleanupWtSession();
        }
        return {
          status: "inconclusive",
          reason: wt.reason,
          warnings: [...warnings, wt.detail],
          isolation: isolationField,
          dryRunLogPaths: wt.logPaths,
        };
      }
      wtSession = wt;
      wtWorktreePath = wt.worktreePath;
      writeMarker(realRoot, {
        targetPath: wt.worktreePath,
        backupPath: realRoot,
        preHash: "",
        mutatedHash: "",
        pid: process.pid,
        timestamp: new Date().toISOString(),
      });
      isolationField.path = wt.worktreePath;
      isolationField.linked = wt.linked;
      isolationField.syncedTrackedFiles = wt.syncedTrackedFiles;
      isolationField.syncedUntrackedFiles = wt.syncedUntrackedFiles;
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

    // Backed up immediately, before the baseline (or anything else) ever
    // runs against the target: a baseline command that itself rewrites
    // the target (a formatter, a codegen step, ...) must never end up
    // being the thing this backup captures, and the check just below
    // (re-hashing after the baseline) needs a backup that already exists
    // and is verified in order to have anything trustworthy to restore
    // from once a mutation is actually applied. `restoreState` is set
    // right away too, so a signal landing anywhere from here on has a
    // (possibly no-op) restore to run instead of nothing.
    const session = beginInplace(mutationFilePath, opts.logDir);
    restoreState = {
      restore: session.restore,
      targetPath: session.targetPath,
      markerKey: absFile,
      backupPath: session.backupPath,
      preHash,
    };
    const discardBackup = () => {
      restoreState = null;
      try {
        fs.rmSync(session.backupPath, { force: true });
      } catch {
        // Best-effort: an orphaned backup file is clutter, never a
        // correctness problem (nothing references it once no marker
        // points at it).
      }
    };
    /** Restores `session` and decides the marker's fate, UNLESS
     * `phaseAborted` is true and the signal handler already did both
     * (see `deferToHandlerIfActive`): then this reuses the handler's own
     * outcome instead of racing it with a second, redundant restore.
     * Every abort-adjacent restore from here on goes through this, so
     * "the handler's restore is the last write" holds regardless of
     * which phase the signal landed in, and the marker is only ever
     * removed once, by whichever of the two actually decided to. */
    const restoreOnce = async (
      phaseAborted: boolean,
    ): Promise<{ ok: boolean; verified: boolean }> => {
      if (phaseAborted) {
        const handlerOutcome = await deferToHandlerIfActive(
          crashHandlers,
          exitOnSignalFlag,
        );
        if (handlerOutcome !== undefined) {
          restoreState = null;
          return {
            ok: true,
            verified: handlerOutcome?.verified ?? false,
          };
        }
      }
      const result = await restoreAndVerify(session, preHash);
      restoreState = null;
      if (result.verified) removeMarkerFor(absFile);
      return result;
    };
    const backupHash = await sha256File(session.backupPath).catch(
      () => undefined,
    );
    if (backupHash !== preHash) {
      discardBackup();
      return {
        status: "inconclusive",
        reason: "backup_verification_failed",
        warnings: [
          ...warnings,
          `the backup taken at ${session.backupPath} did not match the target's pre-mutation hash; the target itself was left untouched`,
        ],
        isolation: isolationField,
      };
    }

    const mutantSpec: MutantSpec = {
      form: opts.form,
      file: displayFile,
      line: opts.line,
      replaceText: opts.replaceText,
      matchText: opts.matchText,
      withText: opts.withText,
      patchPath: opts.patchPath,
    };
    // The dry run's own `git apply` calls get the same controller the
    // `--pre`/`-t` commands do, and are tracked the same way: a signal
    // landing while one of them is running kills it and the handler
    // waits for it to settle, rather than letting an interrupted apply
    // finish writing after this process has moved on.
    const computeMutantStarted = startRunArgvTracked(
      computeMutant(mutantSpec, {
        root,
        logDir: opts.logDir,
        originalContent,
        signal: execController.signal,
        timeoutMs: gitApplyTimeoutMs,
      }),
    );
    const computed = await track(
      computeMutantStarted.result,
      computeMutantStarted.closed,
    );
    // Folded in once, here, so every downstream `dryRunLogPaths:
    // computed.logPaths` (every return from this point on) also carries
    // the worktree setup's own exec logs (`git worktree add`, the
    // tracked-diff sync, the untracked-file listing) without touching
    // each of those return sites individually.
    if (wtSession) {
      computed.logPaths = [...wtSession.logPaths, ...computed.logPaths];
    }
    if (!computed.applicable) {
      if (computed.reasonCode === "aborted") {
        // Ordering only: nothing has mutated the target yet at this
        // phase, so there is nothing for a deferred restore's outcome
        // to change here; this just keeps this call from returning (or,
        // in CLI mode, ever returning) while the handler is still doing
        // its own (harmless, no-op) restore and lock release.
        await deferToHandlerIfActive(crashHandlers, exitOnSignalFlag);
      }
      discardBackup();
      return {
        status: "inconclusive",
        reason: computed.reasonCode ?? "mutant_not_applicable",
        warnings: computed.reason ? [...warnings, computed.reason] : warnings,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    mutantField = {
      file: displayFile,
      line: opts.line,
      before: computed.before,
      after: computed.after,
      form: opts.form,
    };
    mutantSummary = formatMutantSummary(
      displayFile,
      opts.line,
      computed.before,
      computed.after,
    );
    verifiedAppliedVia = formatVerifiedAppliedVia(
      displayFile,
      opts.line,
      computed.before,
      computed.after,
    );

    // `--pre`/`-t` run in the invocation cwd (where the operator ran the
    // probe from), not the containment root: a probe run from a
    // subdirectory of a monorepo must see the same cwd its test command
    // would normally get. For `worktree`, that cwd is remapped onto the
    // worktree (`execCwd`, computed above); the real apply below uses
    // `applyRoot`, since a patch's paths are relative to the repository
    // (or its worktree copy), not to wherever the probe was invoked from.
    const execEnv = {
      cwd: execCwd,
      logDir: opts.logDir,
      timeoutMs: opts.timeoutMs,
      signal: execController.signal,
    };

    // (2) baseline: unmutated, must exit 0.
    const baselineStart = Date.now();
    const baselineRun = await runPreThenTest(opts, execEnv, track);
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
      discardBackup();
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
        dryRunLogPaths: [...computed.logPaths, baselineRun.pre.logPath],
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
        discardBackup();
      } else {
        // Keep the backup file itself, and stop treating a mutation as in
        // flight: nothing was mutated, so there is nothing to restore, and
        // the target is deliberately left as the baseline wrote it.
        restoreState = null;
        warnings.push(
          `the failing baseline run also rewrote the target; the target is left as the baseline wrote it (not restored), and its pre-baseline content is kept at ${session.backupPath}`,
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
        dryRunLogPaths: computed.logPaths,
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
      discardBackup();
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
        dryRunLogPaths: computed.logPaths,
      };
    }

    // (3) marker, apply, verify the hash changed. The in-flight marker
    // is `inplace`-only: it exists to let the next invocation recover
    // the ORIGINAL tree from a SIGKILL/crash mid-mutation, and a
    // `worktree` probe never mutates the original tree at all (the
    // repository-keyed worktree marker above covers the worktree's own
    // leftover-on-crash case instead).
    if (effectiveIsolation === "inplace") {
      writeMarker(absFile, {
        targetPath: displayFile,
        backupPath: session.backupPath,
        preHash,
        mutatedHash: computed.mutatedHash,
        pid: process.pid,
        timestamp: new Date().toISOString(),
      });
    }

    if (opts.form === "patch") {
      // The one `git apply` that writes to the real target, and the only
      // command that runs while the in-flight marker is up: it gets the
      // signal controller too, so a SIGINT/SIGTERM kills it and the
      // handler waits for it to settle before restoring. Without that,
      // an interrupted apply outlives this process and lands on the
      // target after the restore, with the marker already gone.
      const applyStarted = startRunArgvTracked(
        applyPatchForReal(opts.patchPath ?? "", applyRoot, opts.logDir, {
          signal: execController.signal,
          timeoutMs: gitApplyTimeoutMs,
        }),
      );
      const applyResult = await track(applyStarted.result, applyStarted.closed);
      if (applyResult.exitCode !== 0) {
        const { ok, verified } = await restoreOnce(applyResult.aborted);
        if (!ok || !verified) {
          return {
            status: "inconclusive",
            reason: "restore_failed",
            warnings: [
              ...warnings,
              `restore failed; the original content is preserved at backup path ${session.backupPath}`,
            ],
            mutant: mutantField,
            mutation_probe: {
              mutant: mutantSummary,
              verified_applied_via: verifiedAppliedVia,
              result: "inconclusive",
              restored_verified: false,
            },
            baseline,
            isolation: isolationField,
            dryRunLogPaths: [...computed.logPaths, applyResult.logPath],
          };
        }
        // A `git apply` killed by its own bound, or by this probe's
        // signal handler, never said anything about the patch: it is
        // reported under its own reason rather than as a patch that does
        // not apply, so a probe that was stopped is not read as a
        // verdict about the mutant.
        return {
          status: "inconclusive",
          reason: applyResult.timedOut
            ? "git_apply_timeout"
            : applyResult.aborted
              ? "aborted"
              : "mutant_not_applicable",
          warnings: [
            ...warnings,
            applyResult.timedOut
              ? `git apply against the real target hit its ${gitApplyTimeoutMs}ms timeout and was killed; see ${applyResult.logPath}`
              : applyResult.aborted
                ? `git apply against the real target was aborted and killed; see ${applyResult.logPath}`
                : `git apply failed against the real target after the dry run succeeded; see ${applyResult.logPath}`,
          ],
          baseline,
          isolation: isolationField,
          dryRunLogPaths: [...computed.logPaths, applyResult.logPath],
        };
      }
    } else {
      fs.writeFileSync(mutationFilePath, computed.newContent);
    }

    const afterApplyHash = await sha256File(mutationFilePath);
    if (afterApplyHash === preHash || afterApplyHash !== computed.mutatedHash) {
      const { ok, verified } = await restoreAndVerify(session, preHash);
      restoreState = null;
      if (verified) removeMarkerFor(absFile);
      if (!ok || !verified) {
        return {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed; the original content is preserved at backup path ${session.backupPath}`,
          ],
          mutant: mutantField,
          mutation_probe: {
            mutant: mutantSummary,
            verified_applied_via: verifiedAppliedVia,
            result: "inconclusive",
            restored_verified: false,
          },
          baseline,
          isolation: isolationField,
          dryRunLogPaths: computed.logPaths,
        };
      }
      // The restore above succeeded and verified, so this is a structured
      // "cannot conclude" for the caller, not an exception: throwing here
      // would surface through the CLI as `status: "error"` under an
      // unknown command, losing both the reason and the `mutation_probe`
      // evidence that the target really is back at its pre-mutation
      // content.
      return {
        status: "inconclusive",
        reason: "apply_hash_mismatch",
        warnings: [
          ...warnings,
          `the applied mutant's hash does not match what the dry run predicted for ${displayFile} (expected ${computed.mutatedHash}, got ${afterApplyHash}); the target was restored and the restore verified`,
        ],
        mutant: mutantField,
        mutation_probe: {
          mutant: mutantSummary,
          verified_applied_via: verifiedAppliedVia,
          result: "inconclusive",
          restored_verified: verified,
        },
        baseline,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    // (4) --pre then -t, mutated.
    const mutantRun = await runPreThenTest(opts, execEnv, track);
    if (!mutantRun.ok) {
      noteIncompleteOutput(warnings, "mutant --pre", mutantRun.pre);
      const { ok, verified } = await restoreOnce(mutantRun.pre.aborted);
      if (!ok || !verified) {
        return {
          status: "inconclusive",
          reason: "restore_failed",
          warnings: [
            ...warnings,
            `restore failed; the original content is preserved at backup path ${session.backupPath}`,
          ],
          mutant: mutantField,
          mutation_probe: {
            mutant: mutantSummary,
            verified_applied_via: verifiedAppliedVia,
            result: "inconclusive",
            restored_verified: false,
          },
          baseline,
          isolation: isolationField,
          dryRunLogPaths: computed.logPaths,
        };
      }
      const preAborted = mutantRun.pre.aborted;
      return {
        status: "inconclusive",
        reason: preAborted ? "aborted" : "pre_failed",
        warnings: [
          ...warnings,
          preAborted
            ? `--pre was aborted during the mutant run; see ${mutantRun.pre.logPath}`
            : `--pre exited ${mutantRun.pre.exitCode} during the mutant run; see ${mutantRun.pre.logPath}`,
        ],
        mutant: mutantField,
        mutation_probe: {
          mutant: mutantSummary,
          verified_applied_via: verifiedAppliedVia,
          result: "inconclusive",
          restored_verified: verified,
        },
        baseline,
        isolation: isolationField,
        dryRunLogPaths: [...computed.logPaths, mutantRun.pre.logPath],
      };
    }
    const testResult = mutantRun.test;
    noteIncompleteOutput(warnings, "mutant", testResult);

    // (5) restore, (6) verify restore by hash.
    const { ok: restoreOk, verified: restoredVerified } = await restoreOnce(
      testResult.aborted,
    );

    const testField: TestPhaseField = {
      command: opts.testCommand,
      exitCode: testResult.exitCode,
      durationMs: testResult.durationMs,
      timedOut: testResult.timedOut,
      stdoutTail: testResult.stdoutTail,
      stderrTail: testResult.stderrTail,
      logPath: testResult.logPath,
    };

    if (!restoreOk || !restoredVerified) {
      return {
        status: "inconclusive",
        reason: "restore_failed",
        warnings: [
          ...warnings,
          `restore failed; the original content is preserved at backup path ${session.backupPath}`,
        ],
        mutant: mutantField,
        mutation_probe: {
          mutant: mutantSummary,
          verified_applied_via: verifiedAppliedVia,
          result: "inconclusive",
          restored_verified: false,
        },
        baseline,
        test: testField,
        isolation: isolationField,
        dryRunLogPaths: computed.logPaths,
      };
    }

    // (7) classify. The marker was already removed above by `restoreOnce`
    // (or deliberately kept, when a signal handler's own restore could
    // not confirm true stdio closure within its bound). Lock release
    // happens in `finally`.

    // Defense in depth for `worktree`: nothing above should ever have
    // written to `displayFile` (every mutate/backup/restore step used
    // `mutationFilePath`, inside the worktree, instead). Re-hashing it
    // against `preHash` here catches a wiring bug directly instead of
    // silently shipping a verdict computed while the claim "the original
    // tree is untouched" no longer holds.
    if (effectiveIsolation === "worktree") {
      const originalTreeHashAfter = await sha256File(displayFile).catch(
        () => undefined,
      );
      if (originalTreeHashAfter !== preHash) {
        return {
          status: "inconclusive",
          reason: "worktree_original_tree_modified",
          warnings: [
            ...warnings,
            `BUG: ${displayFile} in the original tree changed during a ` +
              `worktree-mode probe; this should be impossible and is a ` +
              `defect in isolation, not a normal probe outcome`,
          ],
          mutant: mutantField,
          mutation_probe: {
            mutant: mutantSummary,
            verified_applied_via: verifiedAppliedVia,
            result: "inconclusive",
            restored_verified: restoredVerified,
          },
          baseline,
          test: testField,
          isolation: isolationField,
          dryRunLogPaths: computed.logPaths,
        };
      }
    }

    let status: "killed" | "survived" | "inconclusive";
    let reason: string | undefined;
    if (testResult.aborted) {
      // The run was stopped (a SIGINT/SIGTERM this probe handled, or a
      // caller's abort) before the test could say anything about the
      // mutant. Never `killed`: an aborted test child exits non-zero,
      // which under `--expect fail` is indistinguishable from a mutant
      // the suite really caught, and reporting that would be a verdict
      // nothing measured.
      status = "inconclusive";
      reason = "aborted";
      warnings.push(`the mutant run was aborted; see ${testResult.logPath}`);
    } else if (testResult.timedOut) {
      status = "inconclusive";
      reason = "timeout";
    } else {
      const testPassed = testResult.exitCode === 0;
      const killed = opts.expect === "fail" ? !testPassed : testPassed;
      status = killed ? "killed" : "survived";
    }

    return {
      status,
      reason,
      warnings,
      mutant: mutantField,
      mutation_probe: {
        mutant: mutantSummary,
        verified_applied_via: verifiedAppliedVia,
        result: status,
        restored_verified: restoredVerified,
      },
      baseline,
      test: testField,
      isolation: isolationField,
      dryRunLogPaths: computed.logPaths,
    };
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    let emergencyResult: ProbeResult | undefined;
    if (restoreState) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above. The rule this backstop
      // enforces: no path out of this function may leave the target
      // mutated, whether it returns or throws. A restore failure here
      // still has to surface as `inconclusive`/`restore_failed`, never
      // silently as whatever exception triggered this path.
      const state = restoreState;
      restoreState = null;
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
