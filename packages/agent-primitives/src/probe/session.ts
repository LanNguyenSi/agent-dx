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
  markerFilePathFor,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
} from "../lock.js";
import { resolveDeepestExisting } from "./containment.js";
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
import type { MutantDiffField, MutantForm } from "./mutant.js";

/**
 * The run-controller layer of the probe pipeline: the SIGINT/SIGTERM
 * handling, the in-flight-run tracking the handler waits on, the
 * `-i worktree` session (sync a fresh worktree, clean it up on every
 * exit path), and `openTarget`'s per-file backup/restore. `step.ts`'s
 * per-mutant step and `setup.ts`'s shared run setup both build on this
 * layer; this layer imports neither of them (see `index.ts`'s own
 * docblock for the module's import direction).
 *
 * The field-shape types below (`IsolationMode`, `ExpectVerdict`,
 * `MutantField`, `MutationProbeField`, `ExecPhaseField`,
 * `TestPhaseField`, `IsolationField`, `ProbeStatus`) live here rather
 * than in `index.ts` because `step.ts` and `setup.ts` both need to name
 * them and neither may import `index.ts` (that would make the import
 * graph a cycle); `index.ts` re-exports them so the package's own public
 * import path (`src/index.ts` importing from `./probe/index.js`) is
 * unchanged.
 */

export type IsolationMode = "worktree" | "inplace";
export type ExpectVerdict = "fail" | "pass";

export interface MutantField {
  file: string;
  line: number;
  before: string;
  after: string;
  form: MutantForm;
  /** Present only for a `patch` mutant whose applied change is not
   * fully shown by `before`/`after` alone; see
   * `MutantComputed.diff`'s docblock in `mutant.ts` for exactly when. */
  diff?: MutantDiffField;
}

export interface MutationProbeField {
  mutant: string;
  verified_applied_via: string;
  result: string;
  restored_verified: boolean;
  /** Present only where `result` alone does not say why (e.g.
   * `"not_run"` for a baseline that failed before any mutant could be
   * applied): a machine-readable cause, the same string a `ProbeResult`
   * would otherwise carry only as its own top-level `reason`. */
  reason?: string;
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
  /** The `--env NAME=VALUE` overrides this run applied (redacted by
   * `redactEnvOverrides` below, never the whole merged environment):
   * present only when at least one was given, so the isolation a caller
   * asked for is visible in the report instead of only inferable from
   * the command string. */
  env?: Record<string, string>;
}

/**
 * The baseline run's own captured tail, plus everything `step.ts`'s
 * classify step needs about it beyond the raw text: whether either tail
 * was itself truncated (`exec.ts`'s `TAIL_LINES`/`TAIL_CHARS` bound --
 * both zero-tests checks and the generic byte-identical fallback only
 * ever see this captured tail, never the command's full output), and
 * whether `--require-baseline-evidence` was given AND matched this
 * baseline (as opposed to not given at all -- a miss already refuses
 * before any mutant is applied, so a caller-supplied miss never reaches
 * here). `true` here is the caller's own opt-in evidence that this
 * runner's output is trustworthy, which is exactly the evidence the
 * generic fallback exists to stand in for absent that opt-in -- so the
 * fallback is skipped entirely once this is `true` (see `step.ts`).
 * Declared here (the bottom of the `session.ts <- step.ts <- setup.ts <-
 * index.ts` layering) rather than in `setup.ts`, which produces it, so
 * `step.ts` can name the type without importing `setup.ts` at all. */
export interface BaselineOutput {
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  requireBaselineEvidenceMatched: boolean;
}

/** A `--env` override name that looks like it carries a credential:
 * `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `KEY`, singular or
 * plural, as its own `_`-delimited segment (case-insensitive) --
 * anchored on `^`/`_` before it and `_`/`$` after it, so it matches a
 * whole SCREAMING_SNAKE_CASE word, e.g. `GITHUB_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY`, `DATABASE_PASSWORD`, `MY_CREDENTIALS`,
 * `MY_SECRETS`, `API_KEYS`, `AUTH_TOKENS`, `PASSWORDS`, never a
 * substring inside a longer segment: `TOKENIZER_MODEL` and `KEYBOARD`
 * are left alone, since neither word appears as its own segment
 * there. */
const SECRET_ENV_NAME_PATTERN =
  /(^|_)(TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY)S?(_|$)/i;

/**
 * Redacts `--env` override values whose NAME matches
 * `SECRET_ENV_NAME_PATTERN`, keeping every name visible so the shape of
 * what was overridden is still legible, and replacing a matching value
 * with the literal string `"<redacted>"`. `--env` overrides are echoed
 * verbatim into the envelope (`ProbeResult.env`, `TestPhaseField.env`)
 * and that envelope routinely gets pasted into PRs, task trackers and
 * chat -- an unredacted secret passed via `--env` would otherwise leak
 * into all of those. */
export function redactEnvOverrides(
  overrides: Record<string, string>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(overrides)) {
    redacted[name] = SECRET_ENV_NAME_PATTERN.test(name) ? "<redacted>" : value;
  }
  return redacted;
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

/** Every `reason` a single-mutant `probe()` run's refusal (a status
 * short of `killed`/`survived`, reported before or during
 * `setup.ts`'s `openRunSetup`) can carry. Covers both how `refuse()`
 * itself is called (`setup.ts`) and the one refusal `openRunSetup`
 * builds by hand instead (the worktree sync failure, `"aborted"` or
 * `"worktree_sync_failed"`), so every reason that can reach
 * `index.ts`'s refusal-to-envelope mapping has exactly one entry in
 * `REFUSAL_RESULT_SHAPE` below. Deliberately excludes the reasons a
 * mutant-phase outcome (`step.ts`'s `runMutantAttempt`, past
 * `openRunSetup`) can report (`apply_hash_mismatch`,
 * `worktree_original_tree_modified`, `restore_failed`, `timeout`, a
 * mutant-phase `pre_failed`/`aborted`): those already always carry both
 * `mutant` and `mutation_probe` (a real mutant was applied), so they
 * need no contract entry to stay consistent.
 *
 * `"no_tests_executed"` and `"baseline_evidence_not_matched"` are both
 * baseline-phase refusals too, reported from the same point
 * `"baseline_failed"`/`"target_changed_during_baseline"` are (after the
 * mutant is computed, on a baseline that otherwise exited 0): the first
 * when the baseline's own output shows a known test runner (vitest,
 * node's built-in `--test`) executed nothing (see `zero-tests.ts`), the
 * second when an opt-in `--require-baseline-evidence <regex>` was given
 * and did not match the baseline output. Both `true`, the same as the
 * other baseline-phase reasons. */
export type RefusalReason =
  | "worktree_allow_outside_unsupported"
  | "test_command_escapes_isolation"
  | "file_outside_root"
  | "probe_in_progress"
  | "lock_unavailable"
  | "stale_probe_marker"
  | "file_not_found"
  | "stale_worktree"
  | "worktree_sync_failed"
  | "target_not_synced"
  | "backup_verification_failed"
  | "mutant_not_applicable"
  | "git_apply_timeout"
  | "aborted"
  | "pre_failed"
  | "baseline_failed"
  | "target_changed_during_baseline"
  | "no_tests_executed"
  | "baseline_evidence_not_matched";

/**
 * The single source of truth for which fields a single-mutant `probe()`
 * refusal reports beside the common envelope: whether `mutant` (the
 * computed-but-never-applied mutant) and `mutation_probe` (its
 * `result: "not_run"` summary) are present. One rule decides every row:
 * present once `openRunSetup`'s `beforeBaseline` hook has computed the
 * run's one mutant, absent before that point -- so `pre_failed`,
 * `baseline_failed`, `target_changed_during_baseline`, and `aborted`
 * (both of the baseline phase's own abort paths: an aborted `--pre` and
 * an aborted baseline test, `setup.ts`'s two `baselineRun`/
 * `baselineTest` branches) are `true`; `mutant_not_applicable` and
 * every earlier refusal (a containment, lock, stale-marker, or
 * worktree-sync refusal, `git_apply_timeout` included) are `false`.
 * `"aborted"` is also the reason two OTHER refusals report from a point
 * BEFORE the mutant is computed (the worktree sync's own abort, and the
 * dry run's own abort inside `beforeBaseline`): this table's `true` for
 * `"aborted"` is still correct for those, because `index.ts` gates the
 * actual fields on the mutant/mutant-summary values it captured itself,
 * which stay `undefined` on both of those earlier paths regardless of
 * what this table says -- so a `true` entry here only ever manifests
 * once one of the two baseline-phase abort paths actually set them.
 * `"stale_worktree"` is the third reason the worktree sync can report,
 * a leftover worktree from a previous run that could not be removed;
 * also always before the mutant is computed, so also `false`.
 * `refuse()` (`setup.ts`) reads this table to fill `reportsMutant`
 * mechanically, one shared lookup rather than a per-call-site flag;
 * `index.ts` reads it a second time, by `mutationProbe`, to decide
 * `mutation_probe`. Checked exhaustively against `probe()`'s own
 * behavior by `test/probe-refusal-contract.test.ts`, and against the
 * README's "Refusal reason shape" table (under "Result shape") by
 * `test/readme-conformance.test.ts`; update all three together with any
 * change here. */
export const REFUSAL_RESULT_SHAPE: Record<
  RefusalReason,
  { mutant: boolean; mutationProbe: boolean }
> = {
  worktree_allow_outside_unsupported: { mutant: false, mutationProbe: false },
  test_command_escapes_isolation: { mutant: false, mutationProbe: false },
  file_outside_root: { mutant: false, mutationProbe: false },
  probe_in_progress: { mutant: false, mutationProbe: false },
  lock_unavailable: { mutant: false, mutationProbe: false },
  stale_probe_marker: { mutant: false, mutationProbe: false },
  file_not_found: { mutant: false, mutationProbe: false },
  stale_worktree: { mutant: false, mutationProbe: false },
  worktree_sync_failed: { mutant: false, mutationProbe: false },
  target_not_synced: { mutant: false, mutationProbe: false },
  backup_verification_failed: { mutant: false, mutationProbe: false },
  mutant_not_applicable: { mutant: false, mutationProbe: false },
  git_apply_timeout: { mutant: false, mutationProbe: false },
  aborted: { mutant: true, mutationProbe: true },
  pre_failed: { mutant: true, mutationProbe: true },
  baseline_failed: { mutant: true, mutationProbe: true },
  target_changed_during_baseline: { mutant: true, mutationProbe: true },
  no_tests_executed: { mutant: true, mutationProbe: true },
  baseline_evidence_not_matched: { mutant: true, mutationProbe: true },
};

/** Restores `session` and verifies the restore by hash. A restore whose
 * copy itself throws is treated the same as a restore that copies but
 * lands on the wrong content: both fail `verified`. Takes only the two
 * fields it uses, so the signal handler can call it with a
 * `RestoreState` and both paths go through the same restore-then-hash
 * rather than each rolling its own. */
export async function restoreAndVerify(
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

export interface RestoreState {
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
export async function deferToHandlerIfActive(
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
export function noteIncompleteOutput(
  warnings: string[],
  phase: string,
  result: ExecResult,
): void {
  if (!result.outputMayBeIncomplete) return;
  warnings.push(
    `${phase}: the command exited while something it spawned still held its output pipes open; the captured output may be incomplete (see ${result.logPath})`,
  );
}

/** The two `ProbeOptions` fields `runPreThenTest` needs: kept as its own
 * small type (rather than `Pick<ProbeOptions, ...>`) because `ProbeOptions`
 * itself stays in `index.ts` (the CLI-facing entry-point options), which
 * this module may not import; the shape is identical to those two fields. */
export interface PreAndTestCommand {
  testCommand: string;
  preCommand?: string;
}

export type RunPhaseResult =
  { ok: true; test: ExecResult } | { ok: false; pre: ExecResult };

/** A started run together with `closed`: a promise that resolves once
 * that run's stdio has TRULY closed, which can be later than the run's
 * own promise settling (`exec.ts`'s flush-grace shortcut) or, for a
 * `runArgv`-based call, exactly when it settles (see `run.ts`'s own
 * docblock: it never takes that shortcut). The signal handler waits on
 * `closed`, not on `result`, so its restore is guaranteed to be the
 * last write only once `closed` is confirmed within its bound. */
export interface TrackedRun<T> {
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
export function startRunArgvTracked<T>(started: Promise<T>): TrackedRun<T> {
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
export async function runPreThenTest(
  opts: PreAndTestCommand,
  env: {
    cwd: string;
    logDir: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The `process.env` this run's `--pre`/`-t` executes against
     * (merged with `--env` overrides when any were given): declared
     * here, not left to fall out of a wider type structurally matching
     * by accident, so a future rewrite of this parameter's fields (or
     * of `MutantRuntime.execEnv`, the only caller of this signature)
     * that drops `env` is a compiler error instead of a silent,
     * clean-compiling loss of every `--env` override. */
    env?: NodeJS.ProcessEnv;
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
export type TrackFn = <T>(
  started: Promise<T>,
  closed: Promise<void>,
) => Promise<T>;

/** The signal-, abort- and worktree-cleanup machinery one probe run
 * owns, whether that run applies one mutant or a whole plan: the
 * handler's restore slot, the in-flight child tracking the handler waits
 * on, and the once-only worktree cleanup every exit path funnels
 * through. */
export interface RunController {
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

export function createRunController(input: {
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

/** Everything a mutant step needs that is the same for every mutant of
 * one run: the isolation it runs under, the exec environment, and the
 * signal machinery it shares with the pipeline that owns it. */
export interface MutantRuntime {
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
    /** Merged (`process.env` plus every `--env` override) when at least
     * one override was given; omitted otherwise, so `execCommand`'s own
     * `options.env ?? process.env` default is unchanged when `--env` was
     * never used. */
    env?: NodeJS.ProcessEnv;
  };
  /** The raw `--env` overrides (unmerged, never the whole environment),
   * present only when at least one was given: what `runMutantAttempt`
   * echoes verbatim under the mutant's `test.env`. */
  envOverrides?: Record<string, string>;
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
export interface TargetSession {
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
export function openTarget(
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
export async function prepareWorktreeSession(input: {
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
      reason: "stale_worktree" | "worktree_sync_failed" | "aborted";
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
  // mirroring `setup.ts`'s own absFile marker recovery
  // (`recoverTargetMarker`), and so is any
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
