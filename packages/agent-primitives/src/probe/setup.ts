import fs from "node:fs";
import path from "node:path";
import { sha256File } from "../hash.js";
import {
  acquireLock,
  markerFilePathFor,
  readMarkerFor,
  removeMarkerFor,
} from "../lock.js";
import { isPathContained } from "./containment.js";
import type { WorktreeSyncSuccess } from "./isolation.js";
import {
  createRunController,
  deferToHandlerIfActive,
  noteIncompleteOutput,
  openTarget,
  prepareWorktreeSession,
  runPreThenTest,
  type ExecPhaseField,
  type IsolationField,
  type IsolationMode,
  type MutantRuntime,
  type ProbeStatus,
  type RunController,
  type TargetSession,
} from "./session.js";

/**
 * The shared run setup: isolation fallback, the `--allow-outside`
 * refusal, containment, the lock, stale in-flight marker recovery, the
 * `-i worktree` sync (via `session.ts`'s `prepareWorktreeSession`),
 * every target's backup (via `session.ts`'s `openTarget`), and the one
 * baseline. `openRunSetup` is what `index.ts`'s `probe()` and
 * `probePlan()` both call before their first mutant; this module builds
 * on `session.ts` and never imports `step.ts` or `index.ts` (see
 * `index.ts`'s own docblock for the module's import direction --
 * nothing here actually calls `step.ts`'s `prepareMutant`/
 * `runMutantAttempt`: the single probe's one mutant is computed through
 * the `beforeBaseline` hook `index.ts` supplies, and a plan's mutants
 * are applied by `index.ts`'s own loop after this setup returns).
 */

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
export async function recoverTargetMarker(
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

/** One file a run will mutate, named the way the entry point that
 * produced it names things: a refusal about this target has to read like
 * the command the caller actually ran. */
export interface RunTargetInput {
  displayFile: string;
  absFile: string;
  /** Where a refusal points back at the caller's own input: `--file` for
   * the single probe, `plan.mutants[2].file` for a plan. */
  label: string;
  /** How a prose warning names this target: "the target" for the single
   * probe, which has exactly one, the path itself for a plan, which may
   * carry several. */
  subject: string;
}

/** The lock set and the run controller, handed to the caller the moment
 * they exist: from then on the caller's own `finally` owns the teardown,
 * whether the setup goes on to refuse, to succeed, or to throw. */
export interface RunSetupContext {
  controller: RunController;
  /** Releases every lock this run took, in the order they were taken. */
  releaseLocks: () => void;
}

/** A refusal from the shared setup, in the neutral shape both entry
 * points map onto their own envelope: the single probe's `ProbeResult`,
 * a plan's `ProbePlanResult` with the mutants it never reached. */
export interface RunSetupRefusal {
  status: ProbeStatus;
  reason: string;
  /** The warnings to report, this refusal's own message already
   * appended. */
  warnings: string[];
  /** Absent where the refusing path reports no exec logs at all, which
   * is the caller's cue to omit the field entirely rather than report an
   * empty one. */
  logPaths?: string[];
  /** Present once the baseline itself has a verdict to report. */
  baseline?: ExecPhaseField;
  /** Whether the single probe reports its own `mutant` field beside this
   * refusal. Its dry run (`beforeBaseline`) computes that field before
   * the baseline runs, so a `--pre` failure and the post-baseline hash
   * check report it while the failing baseline itself never did: the
   * flag is what keeps that envelope exactly as it was before this
   * segment became shared. A plan carries its mutant fields per result
   * and ignores it. */
  reportsMutant: boolean;
}

/** Everything a run needs before its first mutant may be applied: the
 * runtime the mutant step takes, every target opened and backed up, and
 * the one baseline they were all measured against. */
export interface OpenedRun {
  rt: MutantRuntime;
  /** One session per DISTINCT target, in first-named order; a plan
   * reuses one for every mutant that names the same file. */
  targets: TargetSession[];
  baseline: ExecPhaseField;
  /** The caller's own prior logs, the worktree sync's, and whatever
   * `beforeBaseline` produced: what a caller folds into the log paths of
   * everything it reports from here on. */
  logPaths: string[];
}

export interface RunSetupInput {
  /** Already resolved by the caller, which needs them before this point
   * (the `-p` derivation resolves `--file` against `root`). */
  cwd: string;
  root: string;
  gitRoot: string | undefined;
  realRoot: string;
  logDir: string;
  wtScratchRoot: string;
  isolation: IsolationMode;
  allowOutside: boolean;
  displayLinks: string[];
  absLinks: string[];
  timeoutMs?: number;
  gitApplyTimeoutMs: number;
  testCommand: string;
  preCommand?: string;
  exitOnSignal: boolean;
  /** The run's warnings: every warning this setup produces is pushed
   * here, and a refusal carries the array as it stood when it happened. */
  warnings: string[];
  /** Filled in as the setup learns the effective mode, the worktree path
   * and what it synced; the caller reports this same object. */
  isolationField: IsolationField;
  /** In the caller's own order. A file named twice (a plan with two
   * mutants in one file) is opened once and shares one session. */
  targets: RunTargetInput[];
  /** Exec logs the caller produced before this setup ran (`-p`'s own
   * `git apply --numstat`), carried by every refusal that reports log
   * paths. */
  priorLogPaths: string[];
  /** The status a containment refusal reports: `inconclusive` for the
   * single probe, whose contract has classified it that way since before
   * `--plan` existed, `usage_error` for a plan, where every refusal made
   * before anything runs is a usage error. */
  outsideRootStatus: ProbeStatus;
  /** Called with the run context the moment the locks and the controller
   * exist. */
  onContext: (context: RunSetupContext) => void;
  /** Runs on the opened targets AFTER they are backed up and BEFORE the
   * baseline: the single probe computes its one mutant there, so a
   * mutant that cannot be applied is reported without a baseline ever
   * running. A plan computes each mutant inside its own loop and passes
   * nothing. A failure discards every backup and refuses the run. */
  beforeBaseline?: (input: {
    targets: TargetSession[];
    rt: MutantRuntime;
  }) => Promise<
    | { ok: true; logPaths: string[] }
    | { ok: false; reason: string; logPaths: string[] }
  >;
  /** Whether the signal handler's one restore slot stays armed (to
   * whichever target `openTarget` opened last) while the baseline runs.
   * Defaults to `true`, the single probe's released contract: it only
   * ever has one target, so an armed slot restores that same target on
   * a signal, a no-op copy unless the baseline itself rewrote it. A
   * plan passes `false`: with more than one target, an armed slot only
   * ever covers the LAST one opened, so a signal mid-baseline would
   * restore that one target and leave every other target as the
   * baseline wrote it -- an asymmetry across targets that contradicts
   * the plan's own non-signal rule ("left as the baseline wrote it, not
   * restored"). With the slot cleared, a signal during a plan's baseline
   * restores nothing, leaving every target as the baseline wrote it,
   * same as the non-signal path; the per-mutant step re-arms the slot
   * for its own target regardless of this flag, right before it applies
   * that mutant. */
  armRestoreDuringBaseline?: boolean;
}

export type RunSetupOutcome =
  { ok: true; run: OpenedRun } | { ok: false; refusal: RunSetupRefusal };

/**
 * The setup both entry points run before their first mutant: isolation
 * fallback, the `--allow-outside` refusal, containment, the lock, stale
 * in-flight marker recovery, the worktree sync, every target's backup,
 * and the one baseline (I1). One implementation, so the single probe and
 * a plan cannot drift apart on any of it -- which they had: a target the
 * baseline rewrote left its backup behind in a plan and not in a single
 * probe, and the content the mutant was computed against was read from a
 * different file in each.
 *
 * Returns the opened targets and the baseline, or the refusal the caller
 * maps onto its own envelope. Nothing here applies a mutant: past a
 * successful return the caller owns the mutant step, and from the
 * `onContext` call onwards it owns the teardown (worktree cleanup,
 * handler removal, lock release) on every path, this function throwing
 * included.
 */
export async function openRunSetup(
  input: RunSetupInput,
): Promise<RunSetupOutcome> {
  const {
    cwd,
    root,
    gitRoot,
    realRoot,
    logDir,
    wtScratchRoot,
    allowOutside,
    displayLinks,
    absLinks,
    warnings,
    isolationField,
    priorLogPaths,
  } = input;
  const exitOnSignal = input.exitOnSignal;
  const refuse = (
    status: ProbeStatus,
    reason: string,
    message?: string,
    extra: {
      logPaths?: string[];
      baseline?: ExecPhaseField;
      reportsMutant?: boolean;
    } = {},
  ): RunSetupOutcome => ({
    ok: false,
    refusal: {
      status,
      reason,
      warnings: message === undefined ? [...warnings] : [...warnings, message],
      ...(extra.logPaths !== undefined ? { logPaths: extra.logPaths } : {}),
      ...(extra.baseline !== undefined ? { baseline: extra.baseline } : {}),
      reportsMutant: extra.reportsMutant ?? false,
    },
  });

  // `worktree` needs a real git work tree to branch a worktree off of;
  // outside one there is nothing to isolate into, so the mode falls back
  // to `inplace` (named in a warning) instead of failing outright.
  let effectiveIsolation = input.isolation;
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
  // worktree copy, and a path outside the root has no well-defined
  // worktree copy to re-base onto at all. Rejected outright, mirroring
  // `patch_allow_outside_unsupported`, rather than surfacing as a raw
  // ENOENT or `backup_verification_failed` once the pipeline reaches a
  // target it never actually synced.
  if (effectiveIsolation === "worktree" && allowOutside) {
    return refuse(
      "usage_error",
      "worktree_allow_outside_unsupported",
      "--isolation worktree cannot be combined with --allow-outside",
    );
  }

  // Containment for EVERY target of the run (and every `--link`) up
  // front: one file outside the root refuses the whole run rather than
  // being discovered halfway through, with earlier mutants already run.
  if (!allowOutside) {
    const outside = [
      ...input.targets.map((target) => ({
        display: target.displayFile,
        real: target.absFile,
      })),
      ...displayLinks.map((display, i) => ({ display, real: absLinks[i] })),
    ].filter((p) => !isPathContained(realRoot, p.real));
    if (outside.length > 0) {
      return refuse(
        input.outsideRootStatus,
        "file_outside_root",
        `outside the containment root (${root}): ${[
          ...new Set(outside.map((p) => p.display)),
        ].join(", ")}`,
        // Carries a `-p`-derived `--file`'s own numstat log path through,
        // same as every other early return the caller makes; empty for an
        // explicit `--file`, which never runs that listing.
        { logPaths: priorLogPaths },
      );
    }
  }

  // One entry per distinct target file: the marker recovery, the backup
  // and the restore between mutants are all per FILE, not per mutant.
  const distinct: RunTargetInput[] = [];
  const distinctPaths = new Set<string>();
  for (const target of input.targets) {
    if (distinctPaths.has(target.absFile)) continue;
    distinctPaths.add(target.absFile);
    distinct.push(target);
  }

  // The lock is keyed on the repository, not on the target file, for
  // BOTH modes, whenever one exists: an `inplace` run mutates the one
  // working tree that every probe in the same repository builds and
  // tests in, and a `worktree` run shares the same worktree machinery
  // (and, once linked, the same node_modules caches) with every other
  // probe on that repository, so two probes on the same repository are
  // never independent even when their target files differ. It is refused
  // rather than queued, the same contract a second probe on the same
  // file has always had. Outside a repository there is no shared tree
  // and each target file is its own identity, so a run takes one lock
  // per distinct target -- the same identities a single probe on each of
  // those files would take, so a plan and a single probe still exclude
  // each other there. Acquisition never queues (a held lock is refused
  // outright), so taking several cannot deadlock; a refusal releases
  // whatever this call already took. The `inplace` marker stays keyed on
  // the target file (it records that one file's backup and hashes); the
  // `worktree` leftover marker is keyed on the repository-root identity
  // (see the stale-worktree recovery in `prepareWorktreeSession`).
  const lockIdentities =
    gitRoot !== undefined ? [realRoot] : [...distinctPaths].sort();
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
  let controller: RunController;
  try {
    controller = createRunController({
      realRoot,
      logDir,
      wtScratchRoot,
      exitOnSignal,
      releaseLock: releaseLocks,
      warnings,
    });
  } catch (err) {
    // Nothing owns the locks yet (`onContext` below is what hands them
    // over), so they are released here rather than left held by a run
    // that never started.
    releaseLocks();
    throw err;
  }
  input.onContext({ controller, releaseLocks });
  const { crashHandlers, cleanupWtSession } = controller;

  // Stale in-flight markers, one per distinct target: any marker found
  // here is an unfinished run, since the lock above already excludes a
  // live one on this repository.
  for (const target of distinct) {
    const stale = await recoverTargetMarker(
      target.displayFile,
      target.absFile,
      warnings,
    );
    if (stale) {
      return refuse("inconclusive", stale.reason, stale.warning);
    }
    if (!fs.existsSync(target.displayFile)) {
      return refuse(
        "usage_error",
        "file_not_found",
        `${target.label} not found: ${target.displayFile}`,
      );
    }
  }

  let wtSession: WorktreeSyncSuccess | undefined;
  let setupLogPaths = [...priorLogPaths];
  if (effectiveIsolation === "worktree") {
    const preparedWt = await prepareWorktreeSession({
      root,
      cwd,
      realRoot,
      logDir,
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
          // path's own cleanup-and-return would print an envelope for a
          // run the handler is about to end with no output at all.
          await deferToHandlerIfActive(crashHandlers, exitOnSignal);
        }
        await cleanupWtSession();
      }
      return {
        ok: false,
        refusal: {
          status: "inconclusive",
          reason: preparedWt.reason,
          warnings: [...warnings, ...preparedWt.warnings],
          ...(preparedWt.logPaths !== undefined
            ? { logPaths: preparedWt.logPaths }
            : {}),
          reportsMutant: false,
        },
      };
    }
    wtSession = preparedWt.session;
    isolationField.path = wtSession.worktreePath;
    isolationField.linked = wtSession.linked;
    isolationField.syncedTrackedFiles = wtSession.syncedTrackedFiles;
    isolationField.syncedUntrackedFiles = wtSession.syncedUntrackedFiles;
    setupLogPaths = [...priorLogPaths, ...wtSession.logPaths];
  }

  // `--pre`/`-t` run in the invocation cwd (where the operator ran the
  // probe from), not the containment root: a run started from a
  // subdirectory of a monorepo must see the same cwd its test command
  // would normally get. For `worktree`, that cwd is remapped onto the
  // worktree; the real apply uses `applyRoot`, since a patch's paths are
  // relative to the repository (or its worktree copy), not to wherever
  // the run was invoked from.
  const rt: MutantRuntime = {
    root,
    logDir,
    applyRoot: wtSession !== undefined ? wtSession.worktreePath : root,
    execEnv: {
      cwd: wtSession !== undefined ? wtSession.mappedCwd : cwd,
      logDir,
      timeoutMs: input.timeoutMs,
      signal: controller.execController.signal,
    },
    gitApplyTimeoutMs: input.gitApplyTimeoutMs,
    effectiveIsolation,
    testCommand: input.testCommand,
    preCommand: input.preCommand,
    signal: controller.execController.signal,
    track: controller.track,
    crashHandlers,
    exitOnSignal,
    setRestoreState: controller.setRestoreState,
  };

  // Every target is backed up (and each backup verified by hash) BEFORE
  // the baseline runs: a baseline command that itself rewrites a target
  // (a formatter, a codegen step, ...) must never end up being what the
  // backup captured, and the re-hash after the baseline needs a backup
  // that already exists and is verified in order to have anything
  // trustworthy to restore from once a mutation is actually applied.
  // `restoreState` is armed right away too (inside `openTarget`), so a
  // signal landing anywhere from here on has a (possibly no-op) restore
  // to run instead of nothing.
  const opened: { named: RunTargetInput; target: TargetSession }[] = [];
  /** Every backup taken so far, dropped together: a refusal partway
   * through this loop must not leave the targets it already opened with
   * a backup file on disk and an armed restore slot behind it. */
  const discardOpened = (): void => {
    for (const entry of opened) entry.target.discardBackup();
  };
  for (const named of distinct) {
    // The path actually mutated: the worktree's own copy of the target
    // under `-i worktree` (never the original tree), the target itself
    // for `inplace`.
    const mutationFilePath =
      wtSession !== undefined
        ? path.join(
            wtSession.worktreePath,
            path.relative(root, named.displayFile),
          )
        : named.displayFile;
    // A gitignored target is neither tracked (so the tracked-diff sync
    // never carries it) nor an untracked-non-ignored file (so the
    // untracked sync explicitly excludes it): under `worktree`, that
    // combination means `mutationFilePath` was simply never created, and
    // nothing downstream (`beginInplace`'s own read of it, first) can
    // succeed against it. Named here, by a typed reason, instead of
    // surfacing several frames later as a raw ENOENT.
    if (wtSession !== undefined && !fs.existsSync(mutationFilePath)) {
      discardOpened();
      return refuse(
        "inconclusive",
        "target_not_synced",
        `${named.label} (${named.displayFile}) was not synced into the ` +
          `worktree; it is neither a tracked file nor an untracked, ` +
          `non-ignored one, so a gitignored target cannot be probed under ` +
          `--isolation worktree`,
        { logPaths: wtSession.logPaths },
      );
    }
    const preHash = await sha256File(named.displayFile);
    const result = await openTarget(rt, {
      displayFile: named.displayFile,
      absFile: named.absFile,
      mutationFilePath,
      preHash,
      // Read from the file that is actually mutated, which is what the
      // mutant is computed against. Under `worktree` that is the synced
      // copy rather than the original tree's file; the two are provably
      // the same bytes past the backup verification just below, which
      // hashes a copy of THIS file against `preHash`, taken from the
      // original.
      originalContent: fs.readFileSync(mutationFilePath, "utf8"),
    });
    if (!result.ok) {
      discardOpened();
      return refuse(
        "inconclusive",
        "backup_verification_failed",
        result.warning,
      );
    }
    opened.push({ named, target: result.target });
  }
  const targets = opened.map((entry) => entry.target);

  const hook =
    input.beforeBaseline === undefined
      ? { ok: true as const, logPaths: [] as string[] }
      : await input.beforeBaseline({ targets, rt });
  const stepLogPaths = [...setupLogPaths, ...hook.logPaths];
  if (!hook.ok) {
    discardOpened();
    return refuse("inconclusive", hook.reason, undefined, {
      logPaths: stepLogPaths,
    });
  }

  // A plan (more than one target possible) clears the restore slot here,
  // before the baseline runs: `openTarget` armed it once per target
  // above, so it currently points at whichever target was opened last.
  // Left armed, a signal mid-baseline would restore only that one
  // target and leave every other target as the baseline wrote it -- see
  // `armRestoreDuringBaseline`'s docblock. The single probe (default
  // `true`) keeps its released one-target contract unchanged.
  if (input.armRestoreDuringBaseline === false) {
    controller.setRestoreState(null);
  }

  // (2) baseline: unmutated, must exit 0. Once per run (I1).
  const baselineStart = Date.now();
  const baselineRun = await runPreThenTest(
    { testCommand: input.testCommand, preCommand: input.preCommand },
    rt.execEnv,
    controller.track,
  );
  if (!baselineRun.ok) {
    noteIncompleteOutput(warnings, "baseline --pre", baselineRun.pre);
    // An aborted `--pre` (this run was signalled, or its caller aborted
    // it) never ran to a conclusion, so it is not a `--pre` that failed:
    // it is a run that was stopped.
    const preAborted = baselineRun.pre.aborted;
    if (preAborted) {
      // Nothing has mutated any target yet: ordering only, same as the
      // dry-run site in `prepareMutant`.
      await deferToHandlerIfActive(crashHandlers, exitOnSignal);
    }
    discardOpened();
    return refuse(
      "inconclusive",
      preAborted ? "aborted" : "pre_failed",
      preAborted
        ? `--pre was aborted during the baseline run; see ${baselineRun.pre.logPath}`
        : `--pre exited ${baselineRun.pre.exitCode} during the baseline run; see ${baselineRun.pre.logPath}`,
      {
        logPaths: [...stepLogPaths, baselineRun.pre.logPath],
        reportsMutant: true,
      },
    );
  }
  const baselineTest = baselineRun.test;
  noteIncompleteOutput(warnings, "baseline", baselineTest);
  const baseline: ExecPhaseField = {
    exitCode: baselineTest.exitCode,
    durationMs: Date.now() - baselineStart,
    logPath: baselineTest.logPath,
    timedOut: baselineTest.timedOut,
  };
  if (baselineTest.exitCode !== 0 || baselineTest.aborted) {
    if (baselineTest.aborted) {
      // If the handler is active it may already have restored a target
      // (a no-op copy of still-original content, since nothing has
      // mutated one at this phase); wait for that before re-hashing
      // below, so the re-hash reads settled content.
      await deferToHandlerIfActive(crashHandlers, exitOnSignal);
    }
    // A failing baseline is still a baseline that ran commands against
    // the working tree, and one of them may have rewritten a target (a
    // formatter, a codegen step). Re-hash before deciding what to do
    // with each backup: discarding one silently would throw away the
    // only copy of that target's pre-baseline content.
    for (const entry of opened) {
      const postHash = await sha256File(entry.target.mutationFilePath).catch(
        () => undefined,
      );
      if (postHash === entry.target.preHash) {
        entry.target.discardBackup();
      } else {
        // Keep the backup file itself: nothing was mutated, so there is
        // nothing to restore, and the target is deliberately left as the
        // baseline wrote it.
        warnings.push(
          `the failing baseline run also rewrote ${entry.named.subject}; the target is left as the baseline wrote it (not restored), and its pre-baseline content is kept at ${entry.target.session.backupPath}`,
        );
      }
    }
    // Stop treating a mutation as in flight, whichever branch above each
    // target took.
    controller.setRestoreState(null);
    // An aborted baseline is not a red baseline: nothing about the test
    // was learned, the run was stopped. Reported apart from a baseline
    // that genuinely failed, so a caller cannot read a cancelled run as
    // a broken test suite.
    if (baselineTest.aborted) {
      warnings.push(
        `the baseline run was aborted; see ${baselineTest.logPath}`,
      );
    }
    return refuse(
      "inconclusive",
      baselineTest.aborted ? "aborted" : "baseline_failed",
      undefined,
      { logPaths: stepLogPaths, baseline },
    );
  }

  // The baseline run (the `--pre`/`-t` commands themselves, not this
  // package) is the only thing that has touched the filesystem since the
  // backups were taken and verified above: re-hash each target and, if
  // one no longer matches its `preHash`, a formatter/codegen/build step
  // run as part of the baseline rewrote it. Stopping here (before any
  // mutation or marker exists) leaves that rewrite exactly as the
  // baseline left it -- restoring from the backup would instead throw
  // away a legitimate write this run never made, and the backup goes
  // with it, since no mutant will be applied against it at all.
  for (const entry of opened) {
    const postBaselineHash = await sha256File(
      entry.target.mutationFilePath,
    ).catch(() => undefined);
    if (postBaselineHash !== entry.target.preHash) {
      discardOpened();
      return refuse(
        "inconclusive",
        "target_changed_during_baseline",
        `${entry.named.subject} changed during the baseline run (before any mutation was applied); the target is left as the baseline run wrote it, not restored`,
        { logPaths: stepLogPaths, baseline, reportsMutant: true },
      );
    }
  }

  return {
    ok: true,
    run: { rt, targets, baseline, logPaths: stepLogPaths },
  };
}
