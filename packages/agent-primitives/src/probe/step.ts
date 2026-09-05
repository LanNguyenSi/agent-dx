import fs from "node:fs";
import { sha256File } from "../hash.js";
import { removeMarkerFor, writeMarker } from "../lock.js";
import {
  applyPatchForReal,
  computeMutant,
  formatMutantSummary,
  formatVerifiedAppliedVia,
  type MutantComputed,
  type MutantForm,
  type MutantSpec,
} from "./mutant.js";
import {
  deferToHandlerIfActive,
  noteIncompleteOutput,
  restoreAndVerify,
  runPreThenTest,
  startRunArgvTracked,
  type ExpectVerdict,
  type MutantField,
  type MutantRuntime,
  type MutationProbeField,
  type TargetSession,
  type TestPhaseField,
} from "./session.js";

/**
 * The per-mutant step of the probe pipeline: `prepareMutant` (compute a
 * mutant without touching the real target) and `runMutantAttempt` (apply
 * it, run `--pre`/`-t`, restore, verify, classify). Both build on
 * `session.ts`'s run-controller layer (`MutantRuntime`, `TargetSession`,
 * `restoreAndVerify`, the tracked-run helpers); neither imports
 * `setup.ts` or `index.ts` (see `index.ts`'s own docblock for the
 * module's import direction).
 */

/** One mutant of a run: exactly one form plus the verdict it is expected
 * to produce. `expect` is per mutant, so a plan can mix a mutant that
 * must break the test with one that must not. */
export interface MutantStepSpec {
  form: MutantForm;
  line?: number;
  replaceText?: string;
  matchText?: string;
  withText?: string;
  patchPath?: string;
  expect: ExpectVerdict;
}

export type PreparedMutant =
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
export async function prepareMutant(
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
export interface MutantAttemptOutcome {
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
export async function runMutantAttempt(
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
