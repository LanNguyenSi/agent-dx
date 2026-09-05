import fs from "node:fs";
import path from "node:path";
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
import type { WorktreeSyncSuccess } from "./isolation.js";
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
import {
  createRunController,
  deferToHandlerIfActive,
  noteIncompleteOutput,
  openTarget,
  prepareWorktreeSession,
  restoreAndVerify,
  runPreThenTest,
  startRunArgvTracked,
  type ExecPhaseField,
  type ExpectVerdict,
  type IsolationField,
  type IsolationMode,
  type MutantField,
  type MutantRuntime,
  type MutationProbeField,
  type ProbeStatus,
  type RunController,
  type TargetSession,
  type TestPhaseField,
} from "./session.js";

export type {
  ExecPhaseField,
  ExpectVerdict,
  IsolationField,
  IsolationMode,
  MutantField,
  MutationProbeField,
  ProbeStatus,
  TestPhaseField,
};

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
 * This checks by PATH (`statSync`/`accessSync`), never by an open
 * descriptor, unlike `parsePlanFile`'s own metadata check (an `fstatSync`
 * on the descriptor it then reads from): the two techniques differ
 * because what runs after them differs. `parsePlanFile` reads the plan
 * itself in this process, so its bound has to hold across the same
 * descriptor the read uses, closing the stat-then-read race a path-based
 * check would leave open. A patch's own bytes are never read here or
 * anywhere else in this process -- `git apply` (a child process) is what
 * streams the file from its path, both for the dry run and the real
 * apply -- so there is no read in this process for an open descriptor to
 * protect; git's own handling of the path it is given governs from
 * there.
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

/** One file a run will mutate, named the way the entry point that
 * produced it names things: a refusal about this target has to read like
 * the command the caller actually ran. */
interface RunTargetInput {
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
interface RunSetupContext {
  controller: RunController;
  /** Releases every lock this run took, in the order they were taken. */
  releaseLocks: () => void;
}

/** A refusal from the shared setup, in the neutral shape both entry
 * points map onto their own envelope: the single probe's `ProbeResult`,
 * a plan's `ProbePlanResult` with the mutants it never reached. */
interface RunSetupRefusal {
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
interface OpenedRun {
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

interface RunSetupInput {
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

type RunSetupOutcome =
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
async function openRunSetup(input: RunSetupInput): Promise<RunSetupOutcome> {
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

/**
 * Runs the full probe pipeline: lock -> containment -> stale-marker
 * recovery -> baseline -> mutate -> pre+test -> restore -> verify ->
 * classify. Setup through baseline is `openRunSetup` above, which
 * `probePlan` runs too; the mutate -> test -> restore -> classify step
 * is `prepareMutant`/`runMutantAttempt`, which `probePlan` runs once per
 * mutant. See `probePlan`'s docblock for the invariants that split holds
 * to.
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

  // Populated by the shared setup's `beforeBaseline` hook below as soon
  // as each becomes known, so the `finally` block's emergency-restore
  // path can build a full result even when it is reached via a thrown
  // error partway through.
  let mutantField: MutantField | undefined;
  let mutantSummary: string | undefined;
  let verifiedAppliedVia: string | undefined;
  let prepared: Extract<PreparedMutant, { ok: true }> | undefined;
  let baseline: ExecPhaseField | undefined;
  // The locks and the run controller, handed over by `openRunSetup` the
  // moment they exist: from then on this function's own `finally` owns
  // the teardown, however the setup ends.
  let context: RunSetupContext | undefined;
  // Set by the `catch` below and read by `finally`'s emergency-restore
  // path, so its warning can name what actually triggered the restore
  // instead of just "an unexpected error".
  let caughtError: unknown;
  const spec: MutantStepSpec = {
    form: opts.form,
    line,
    replaceText: opts.replaceText,
    matchText: opts.matchText,
    withText: opts.withText,
    patchPath: opts.patchPath,
    expect: opts.expect,
  };

  try {
    const setup = await openRunSetup({
      cwd,
      root,
      gitRoot,
      realRoot,
      logDir: opts.logDir,
      wtScratchRoot,
      isolation: opts.isolation,
      allowOutside: opts.allowOutside ?? false,
      displayLinks,
      absLinks,
      timeoutMs: opts.timeoutMs,
      gitApplyTimeoutMs,
      testCommand: opts.testCommand,
      preCommand: opts.preCommand,
      exitOnSignal: opts.exitOnSignal ?? false,
      warnings,
      isolationField,
      targets: [
        { displayFile, absFile, label: "--file", subject: "the target" },
      ],
      priorLogPaths: derivationLogPaths,
      // What a single probe has always reported for a target outside the
      // containment root; a plan calls the same finding a usage error.
      outsideRootStatus: "inconclusive",
      onContext: (runContext) => {
        context = runContext;
      },
      // The dry run, before the baseline: the single probe computes its
      // one mutant against the target's original content here, so a
      // mutant that cannot be applied is reported without a baseline
      // ever running, and a `--pre` failure or a target the baseline
      // rewrote still reports the mutant this probe would have applied.
      // A plan computes each of its mutants inside its own loop instead.
      beforeBaseline: async ({ targets, rt }) => {
        const computed = await prepareMutant(rt, targets[0], spec, warnings);
        if (!computed.ok) {
          return {
            ok: false,
            reason: computed.reason,
            logPaths: computed.logPaths,
          };
        }
        prepared = computed;
        mutantField = computed.mutant;
        mutantSummary = computed.mutantSummary;
        verifiedAppliedVia = computed.verifiedAppliedVia;
        return { ok: true, logPaths: computed.logPaths };
      },
    });
    if (!setup.ok) {
      const { refusal } = setup;
      return {
        status: refusal.status,
        reason: refusal.reason,
        warnings: refusal.warnings,
        ...(refusal.reportsMutant && mutantField !== undefined
          ? { mutant: mutantField }
          : {}),
        ...(refusal.baseline !== undefined
          ? { baseline: refusal.baseline }
          : {}),
        isolation: isolationField,
        ...(refusal.logPaths !== undefined
          ? { dryRunLogPaths: refusal.logPaths }
          : {}),
      };
    }
    const { rt, targets, logPaths: stepLogPaths } = setup.run;
    baseline = setup.run.baseline;
    if (prepared === undefined) {
      // Unreachable: `openRunSetup` returns `ok` only past the
      // `beforeBaseline` hook above, which is where this is set. A
      // typed narrowing, and never a silent one.
      throw new Error(
        "internal error: the mutant was not prepared before the baseline",
      );
    }
    const preparedMutant = prepared;

    // (3) marker, (4) apply, pre+test, (5) restore, (6) verify the
    // restore by hash, (7) classify: one mutant, through the same step a
    // plan runs once per mutant.
    const outcome = await runMutantAttempt(
      rt,
      targets[0],
      spec,
      {
        computed: preparedMutant.computed,
        mutant: preparedMutant.mutant,
        mutantSummary: preparedMutant.mutantSummary,
        verifiedAppliedVia: preparedMutant.verifiedAppliedVia,
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
    // No context means the setup refused (or threw) before it took a
    // lock: nothing was opened, nothing is in flight, and there is
    // nothing to tear down.
    const inFlightRestore = context?.controller.getRestoreState();
    if (context !== undefined && inFlightRestore) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above. The rule this backstop
      // enforces: no path out of this function may leave the target
      // mutated, whether it returns or throws. A restore failure here
      // still has to surface as `inconclusive`/`restore_failed`, never
      // silently as whatever exception triggered this path.
      const state = inFlightRestore;
      context.controller.setRestoreState(null);
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
    if (context !== undefined) {
      await context.controller.cleanupWtSession();
      context.controller.crashHandlers.remove();
      context.releaseLocks();
    }
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
 * applied. The pipeline is the single probe's, not a copy of it: the
 * setup through the baseline is `openRunSetup`, the very function
 * `probe()` calls, and the mutate -> pre+test -> restore -> verify ->
 * classify step is `prepareMutant`/`runMutantAttempt`, likewise shared,
 * run once per mutant between that setup and one shared teardown.
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
 *   setup, the same one step, and the same teardown it always did --
 *   which is now literally the same code, so a refusal a plan makes and
 *   the one a single probe makes for the same reason cannot drift apart
 *   again (they had: a target the baseline rewrote left its backup
 *   behind here and not there).
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
  /** Every verdict this plan has collected, in `planned` order: hoisted
   * out of the mutant loop so every exit path -- the loop's own returns,
   * a refusal before it, and the emergency-restore path in `finally` --
   * reports the verdicts that were actually reached instead of claiming
   * the plan never ran. */
  const results: PlanMutantResult[] = [];
  /** The mutant the loop is inside RIGHT NOW, cleared as soon as its
   * result is pushed: what the emergency-restore path in `finally`
   * reports for a mutant an unexpected error unwound the stack on, since
   * `not_run` would claim it was never attempted. */
  let inFlight:
    | {
        item: PlannedMutant;
        warnings: string[];
        logs: string[];
        mutant?: MutantField;
        mutantSummary?: string;
        verifiedAppliedVia?: string;
      }
    | undefined;
  /** The plan's results as they stand: every verdict collected, the
   * mutant in flight (when the caller has one to report), then `not_run`
   * for every mutant the plan never reached. */
  const resultsSoFar = (
    inFlightEntry?: PlanMutantResult,
  ): PlanMutantResult[] => {
    const reached = [
      ...results,
      ...(inFlightEntry === undefined ? [] : [inFlightEntry]),
    ];
    return [...reached, ...planned.slice(reached.length).map(notRunResult)];
  };
  const refuse = (
    status: ProbeStatus,
    reason: string,
    message?: string,
  ): ProbePlanResult => {
    const entries = resultsSoFar();
    return {
      status,
      reason,
      warnings: message === undefined ? warnings : [...warnings, message],
      results: entries,
      summary: summarize(entries),
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
    if (item.spec.form === "patch") {
      // Metadata only, the same check the single probe makes for `-p`
      // before anything hands the patch to `git apply`: an unusable
      // patch is a caller error naming the entry it belongs to, not a
      // mutant that turns out not to be applicable halfway through the
      // plan.
      const unusable = patchUnusableReason(
        item.spec.patchPath ?? "",
        `plan.mutants[${String(item.index)}].patch`,
      );
      if (unusable !== undefined) {
        return refuse("usage_error", "patch_not_readable", unusable);
      }
    }
  }

  let baseline: ExecPhaseField | undefined;
  // The locks and the run controller, handed over by `openRunSetup` the
  // moment they exist: from then on this function's own `finally` owns
  // the teardown, however the setup ends.
  let context: RunSetupContext | undefined;
  let caughtError: unknown;

  try {
    const setup = await openRunSetup({
      cwd,
      root,
      gitRoot,
      realRoot,
      logDir: opts.logDir,
      wtScratchRoot,
      isolation: opts.isolation,
      allowOutside: opts.allowOutside ?? false,
      displayLinks,
      absLinks,
      timeoutMs: opts.timeoutMs,
      gitApplyTimeoutMs,
      testCommand: opts.testCommand,
      preCommand: opts.preCommand,
      exitOnSignal: opts.exitOnSignal ?? false,
      warnings,
      isolationField,
      targets: planned.map((item) => ({
        displayFile: item.displayFile,
        absFile: item.absFile,
        label: `plan.mutants[${String(item.index)}].file`,
        subject: item.displayFile,
      })),
      priorLogPaths: [],
      // Every refusal a plan makes before anything runs is a usage
      // error, this one included (AC9); the single probe reports the
      // same finding as `inconclusive`.
      outsideRootStatus: "usage_error",
      onContext: (runContext) => {
        context = runContext;
      },
      // No `beforeBaseline`: a plan computes each mutant inside the loop
      // below, right before it is applied.
      // A plan can open more than one target; leaving the restore slot
      // armed to whichever one `openTarget` opened last would restore
      // only that target on a signal mid-baseline and leave every other
      // target as the baseline wrote it. See the field's own docblock.
      armRestoreDuringBaseline: false,
    });
    if (!setup.ok) {
      const { refusal } = setup;
      if (refusal.logPaths !== undefined) setupLogPaths = refusal.logPaths;
      // Nothing was collected yet, so these are all `not_run` -- the
      // same helper the loop's own returns and the emergency path use,
      // rather than a second way of saying it.
      const entries = resultsSoFar();
      return {
        status: refusal.status,
        reason: refusal.reason,
        warnings: refusal.warnings,
        ...(refusal.baseline !== undefined
          ? { baseline: refusal.baseline }
          : {}),
        results: entries,
        summary: summarize(entries),
        isolation: isolationField,
        ...(setupLogPaths.length > 0 ? { dryRunLogPaths: setupLogPaths } : {}),
      };
    }
    const { rt } = setup.run;
    baseline = setup.run.baseline;
    setupLogPaths = setup.run.logPaths;
    // Keyed by the resolved path every planned mutant carries, so the
    // mutants that share a file share one backup and one restore.
    const targets = new Map<string, TargetSession>(
      setup.run.targets.map((target) => [target.absFile, target]),
    );

    // One mutant at a time, never in parallel: each is applied against a
    // target proven to be back at its pre-mutation content, tested, and
    // restored before the next one is even computed.
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
      // From here until this mutant's result is pushed, an unexpected
      // error unwinding the stack lands in `finally` with this mutant
      // applied: the emergency-restore path reports THIS entry rather
      // than calling it `not_run`.
      inFlight = { item, warnings: mutantWarnings, logs: [] };
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
        inFlight = undefined;
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
        if (prepared.reason === "aborted" || rt.crashHandlers.isHandling()) {
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
        inFlight = undefined;
        continue;
      }
      // The evidence the emergency-restore path needs to report this
      // mutant honestly: it is applied from here on.
      inFlight = {
        item,
        warnings: mutantWarnings,
        logs: prepared.logPaths,
        mutant: prepared.mutant,
        mutantSummary: prepared.mutantSummary,
        verifiedAppliedVia: prepared.verifiedAppliedVia,
      };
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
      inFlight = undefined;
      // I3: a restore that could not be verified is terminal for the
      // plan. I5: so is a signal, whether this mutant's own phase
      // reported the abort or the handler is only just acting on it --
      // the next mutant must never start.
      if (outcome.restoreFailed) terminal = "restore_failed";
      else if (outcome.aborted || rt.crashHandlers.isHandling()) {
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
    // No context means the setup refused (or threw) before it took a
    // lock: nothing was opened, nothing is in flight, and there is
    // nothing to tear down.
    const inFlightRestore = context?.controller.getRestoreState();
    if (context !== undefined && inFlightRestore) {
      // Reached only when something unwound the stack (a thrown error)
      // while a mutation was still in flight and never went through one
      // of the explicit restore points above: no path out of this
      // function may leave a target mutated, whether it returns or
      // throws.
      const state = inFlightRestore;
      context.controller.setRestoreState(null);
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
        // The verdicts already collected are reported as they stand,
        // and the mutant that was in flight as what it is: applied, its
        // restore unverified. Only the mutants this plan never reached
        // are `not_run`.
        const entries = resultsSoFar(
          inFlight === undefined
            ? undefined
            : {
                index: inFlight.item.index,
                file: inFlight.item.displayFile,
                expect: inFlight.item.spec.expect,
                status: "inconclusive",
                reason: "restore_failed",
                warnings: inFlight.warnings,
                ...(inFlight.mutant !== undefined
                  ? { mutant: inFlight.mutant }
                  : {}),
                ...(inFlight.mutantSummary !== undefined &&
                inFlight.verifiedAppliedVia !== undefined
                  ? {
                      mutation_probe: {
                        mutant: inFlight.mutantSummary,
                        verified_applied_via: inFlight.verifiedAppliedVia,
                        result: "inconclusive" as const,
                        restored_verified: false,
                      },
                    }
                  : {}),
                logs: inFlight.logs,
              },
        );
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
          results: entries,
          summary: summarize(entries),
          isolation: isolationField,
          ...(setupLogPaths.length > 0
            ? { dryRunLogPaths: setupLogPaths }
            : {}),
        };
      }
    }
    // Once per plan (I4), before the locks are released, so a concurrent
    // probe never observes the lock as free while this run's worktree
    // removal is still in flight.
    if (context !== undefined) {
      await context.controller.cleanupWtSession();
      context.controller.crashHandlers.remove();
      context.releaseLocks();
    }
    if (emergencyResult) return emergencyResult;
  }
}
