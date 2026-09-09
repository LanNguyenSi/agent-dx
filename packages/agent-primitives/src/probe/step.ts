import fs from "node:fs";
import { sha256File } from "../hash.js";
import { removeMarkerFor, writeMarker } from "../lock.js";
import {
  combinedOutput,
  reportedNoVerdict,
  signalNumberFromExitCode,
  wasSignalKilled,
} from "../exec.js";
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
  redactEnvOverrides,
  restoreAndVerify,
  runPreThenTest,
  startRunArgvTracked,
  type BaselineOutput,
  type ExpectVerdict,
  type MutantField,
  type MutantRuntime,
  type MutationProbeField,
  type TargetSession,
  type TestPhaseField,
} from "./session.js";
import {
  detectKnownZeroTestsEvidence,
  hasKnownTestSummary,
} from "./zero-tests.js";

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
  | {
      ok: false;
      reason: "mutant_not_applicable" | "git_apply_timeout" | "aborted";
      logPaths: string[];
    };

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
  // A multi-line patch whose applied-diff excerpt could not be computed
  // (or had to be refused) surfaces here rather than leaving `diff`
  // silently missing with no trace of why.
  if (computed.diffWarning !== undefined) {
    warnings.push(computed.diffWarning);
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
      ...(computed.diff !== undefined ? { diff: computed.diff } : {}),
    },
    mutantSummary: formatMutantSummary(
      target.displayFile,
      computed.line,
      computed.before,
      computed.after,
      computed.diff,
    ),
    verifiedAppliedVia: formatVerifiedAppliedVia(
      target.displayFile,
      computed.line,
      computed.before,
      computed.after,
      computed.diff,
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
  /** The same baseline run `setup.ts` already checked for zero-tests
   * evidence, carried through so the classify step below can compare a
   * "survived"-shaped mutant run against it: the generic byte-identical
   * fallback (`zero-tests.ts`'s `hasKnownTestSummary`) a suite neither
   * built-in detector recognizes needs both sides to decide anything. */
  baselineOutput: BaselineOutput,
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
    // A `--pre` that never reported an exit code of its own is named as
    // such, rather than through the plain form's `--pre exited null`,
    // which reads as if `null` were a status the command itself chose;
    // the two no-verdict shapes (this package's `--timeout`, and a kill
    // from outside it) are named apart, since `--pre` has no `timedOut`
    // field of its own in the envelope. Mirrors `setup.ts`'s own
    // baseline-side `--pre` prose.
    warnings.push(
      preAborted
        ? `--pre was aborted during the mutant run; see ${mutantRun.pre.logPath}`
        : mutantRun.pre.exitCode === null
          ? mutantRun.pre.timedOut
            ? `--pre timed out during the mutant run, no exit code was reported; see ${mutantRun.pre.logPath}`
            : `--pre was terminated by a signal during the mutant run, no exit code was reported; see ${mutantRun.pre.logPath}`
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
    ...(rt.envOverrides ? { env: redactEnvOverrides(rt.envOverrides) } : {}),
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
  // The mutation-probe verdict `mutation_probe.result` reports: equal to
  // `status` except for the zero-tests override just below, where it is
  // forced to `"not_run"` regardless of `status` -- the commands did
  // run, but nothing they measured backs a real verdict, so this reports
  // the same as a baseline-stage zero-tests refusal would have (see
  // `REFUSAL_RESULT_SHAPE.no_tests_executed` in `session.ts`).
  let mutationProbeResult: string;
  if (testResult.aborted) {
    // The run was stopped (a SIGINT/SIGTERM this probe handled, or a
    // caller's abort) before the test could say anything about the
    // mutant. Never `killed`: an aborted test child exits non-zero, which
    // under `--expect fail` is indistinguishable from a mutant the suite
    // really caught, and reporting that would be a verdict nothing
    // measured.
    status = "inconclusive";
    reason = "aborted";
    mutationProbeResult = status;
    warnings.push(`the mutant run was aborted; see ${testResult.logPath}`);
  } else if (reportedNoVerdict(testResult)) {
    // The mutant run never reported an exit code of its own: this
    // package's own `--timeout` killed it (`timedOut: true`), or a
    // kill from outside this probe reached the run's own process-group
    // leader, which `exec.ts` reports as `exitCode: null` with
    // `timedOut: false` (the same `reportedNoVerdict` shapes
    // `setup.ts` refuses a baseline for). Neither `killed` nor
    // `survived` may be read out of such a run: under `--pass-regex` a
    // partial output printed before the kill can match the pattern and
    // read as a PASS the run never earned, and under the exit-code
    // default a `null` exit code is not `0`, which reads as "the test
    // failed" and, under `--expect fail`, certifies a KILL the suite
    // never actually made. Same handling for both shapes -- one run
    // without a verdict, one `inconclusive`/`timeout` outcome, so the
    // reported reason contract is unchanged -- with the signal shape
    // named in `warnings`, since `reason: "timeout"` beside
    // `test.timedOut: false` would otherwise read as this package's
    // own bound having fired.
    status = "inconclusive";
    reason = "timeout";
    mutationProbeResult = status;
    // A timeout is excluded (`wasSignalKilled`, not the branch condition
    // itself): this package's own `--timeout` already reports itself
    // through `test.timedOut`, so only the kill-from-outside shape needs
    // a warning to say what happened to the run.
    if (wasSignalKilled(testResult)) {
      warnings.push(
        `the mutant run was terminated by a signal, no exit code was reported; nothing about this mutant was measured; see ${testResult.logPath}`,
      );
    }
  } else {
    // `rt.passRegex` (`--pass-regex`/`passWhen.regex`): once given, it
    // is THIS mutant run's verdict in place of its exit code too, the
    // same predicate `setup.ts` already applied to the baseline --
    // "passed" is the regex matching the run's own combined
    // stdout+stderr, "failed" is the regex absent, whatever the exit
    // code says.
    const testCombinedOutput = combinedOutput(
      testResult.stdoutTail,
      testResult.stderrTail,
    );
    const testPassed =
      rt.passRegex !== undefined
        ? rt.passRegex.test(testCombinedOutput)
        : testResult.exitCode === 0;
    const killed = spec.expect === "fail" ? !testPassed : testPassed;
    status = killed ? "killed" : "survived";
    mutationProbeResult = status;

    // The 128 + N band (see `exec.ts`'s `signalNumberFromExitCode`):
    // computed once here, ahead of the `--pass-regex`-only block below,
    // because the FAIL direction below needs it whether or not
    // `--pass-regex` is even given -- the plain exit-code default reads
    // a band code as an ordinary non-zero failure exactly the same way
    // a real one would.
    const mutantSignalCode = signalNumberFromExitCode(testResult.exitCode);
    // A kill that lands on the test process while its `sh -c` wrapper
    // SURVIVES arrives as an ordinary non-zero exit code, never as the
    // `null` the no-verdict branch above catches. On the FAIL direction
    // (`!testPassed`: the plain exit-code default reading a band code
    // as a failure, or `--pass-regex` failing to match a run the kill
    // cut off before it printed) that ordinary-looking exit code is
    // read as a genuine failure -- which under `--expect fail` is
    // exactly the KILLED verdict this whole mechanism exists to
    // certify -- with nothing said about it unless this fires. The
    // verdict is not second-guessed (nothing here can tell that code
    // apart from a runner exiting `137` on its own); the reader is
    // told. The PASS direction gets its own wording below, scoped to
    // `--pass-regex` (the plain default can never read a non-zero exit
    // code as a pass), so the two never both fire for the same run.
    if (!testPassed && mutantSignalCode !== undefined) {
      warnings.push(
        `the mutant run exited with ${String(testResult.exitCode)}, the code a shell reports for a process killed by signal ${String(mutantSignalCode)}; the ${status} verdict may rest on a run that was cut short; see ${testResult.logPath}`,
      );
    }

    if (rt.passRegex !== undefined) {
      if (testPassed && testResult.exitCode !== 0) {
        // Same deprecation-notice shape `setup.ts` warns about for the
        // baseline: named here too, so a caller reading `warnings` sees
        // why a red exit code was still read as a pass on the mutant
        // side as well. `testResult.exitCode` is a real number in this
        // whole block: a run that reported none returned above as
        // `inconclusive`/`timeout`, so no warning here can frame a
        // `null` as an exit code.
        //
        // And the same 128 + N band gets the same separate wording it
        // gets on the baseline side: a kill that lands on the test
        // process while its `sh -c` wrapper survives arrives as an
        // ordinary non-zero exit code, never as the `null` the
        // no-verdict branch above catches, so a mutant run cut short
        // that way would otherwise be reported `survived` with nothing
        // said about it. The verdict stands (nothing here can tell that
        // code apart from a runner exiting `137` on its own, and
        // `--pass-regex` means "ignore the exit code" by construction);
        // the reader is told.
        warnings.push(
          mutantSignalCode !== undefined
            ? `--pass-regex (${rt.passRegex.source}) matched the mutant run's output but the mutant run exited with ${String(testResult.exitCode)}, the code a shell reports for a process killed by signal ${String(mutantSignalCode)}; the suite may have been cut short; see ${testResult.logPath}`
            : `--pass-regex (${rt.passRegex.source}) matched the mutant run's output despite a non-zero exit code (${String(testResult.exitCode)}); treated as a pass (e.g. deprecation-notice noise), not a failure; see ${testResult.logPath}`,
        );
      } else if (
        !testPassed &&
        testResult.stdoutTail.length === 0 &&
        testResult.stderrTail.length === 0
      ) {
        // No output at all: a regex can never match empty output, so
        // this reads as "failed" the same as a real test failure would
        // -- but a process that crashed before printing anything (a
        // segfault, an uncaught exception before the runner's own
        // reporter ever ran) is not the same finding as a suite that
        // ran and reported failures. Distinguishable in the envelope
        // via `test.exitCode` (kept as data regardless of `passRegex`)
        // together with the empty `test.stdoutTail`/`test.stderrTail`
        // this warning already names; a caller that cares tells the two
        // apart by checking for exactly this shape.
        warnings.push(
          `the mutant run produced no output at all (exit code ${String(testResult.exitCode)}); --pass-regex (${rt.passRegex.source}) cannot match empty output, so this reads as a crash, not a genuine test failure -- see test.exitCode and the empty test.stdoutTail/test.stderrTail; see ${testResult.logPath}`,
        );
      } else if (!testPassed) {
        // A genuine miss with real (non-empty) output. Under the
        // ordinary `--expect fail` shape this is the ROUTINE, expected
        // outcome -- the predicate agrees the mutant broke the suite,
        // exactly like every other killed mutant in an N-mutant plan --
        // so warning on every one of them would fill `warnings` with N
        // near-duplicate entries that read as noise, not as N distinct
        // findings (a healthy plan run would otherwise never have an
        // empty `warnings` array at all). Warned only when the miss is
        // actually ambiguous: (1) either side of this run's own captured
        // tail was truncated, so the pattern may have matched output
        // this run never even captured; (2) the exit code itself reads
        // `0` despite the predicate reading "failed" -- the process and
        // the predicate disagree, worth a second look regardless of
        // `--expect`; or (3) `--expect pass`, where a miss means the
        // mutant SURVIVED rather than being killed -- not the routine
        // "predicate agrees the mutant broke the suite" shape at all.
        // Named explicitly, the same as `--require-baseline-evidence`'s
        // own miss is on the baseline side, so a caller reading
        // `warnings` sees which pattern was checked and against what,
        // rather than only the bare `killed`/`survived` verdict.
        const truncatedSides = [
          testResult.stdoutTruncated ? "stdout" : undefined,
          testResult.stderrTruncated ? "stderr" : undefined,
        ].filter((side): side is string => side !== undefined);
        const ambiguousMiss =
          truncatedSides.length > 0 ||
          testResult.exitCode === 0 ||
          spec.expect === "pass";
        if (ambiguousMiss) {
          const truncatedNote =
            truncatedSides.length > 0
              ? ` (the mutant run's captured ${truncatedSides.join(" and ")} tail was truncated; the pattern may have matched output outside the captured tail)`
              : "";
          warnings.push(
            `--pass-regex (${rt.passRegex.source}) did not match the mutant run's output${truncatedNote}; see ${testResult.logPath}`,
          );
        }
      }
    }

    // Zero-tests-executed detection, mutant side: the mutant run's OWN
    // output shows a known test runner executed nothing (the same
    // detector `setup.ts` already ran against the baseline). Applies
    // regardless of `status`: a known runner reporting zero tests
    // executed is real evidence on its own, whatever the exit code said.
    const mutantZeroTests = detectKnownZeroTestsEvidence(
      testResult.stdoutTail,
      testResult.stderrTail,
    );
    // The generic byte-identical fallback: scoped to a verdict whose own
    // predicate on THIS mutant's run reads as PASSING -- exit code `0`
    // by default, or `testPassed` itself (`--pass-regex`'s own match)
    // when that flag is given -- the exact silent-pass evidence this
    // whole mechanism distrusts. Whichever direction `--expect` points,
    // a mutant run whose predicate reads FAILING already carries a real
    // signal -- the run itself disagreed with the baseline -- that this
    // output-only heuristic has no business second-guessing; that holds
    // for a `survived` verdict under `--expect fail` bound to a passing
    // predicate exactly as it does for a `killed` verdict under
    // `--expect pass` bound to a passing predicate, and it excludes a
    // `survived` verdict under `--expect pass`, which is `survived`
    // precisely because the predicate read FAILING.
    const restsOnPassingVerdict = testPassed;
    // Silence on both sides is common and legitimate (many hand-rolled
    // test scripts print nothing on a pass, relying on the exit code
    // alone -- this package's own fixtures included), so it is excluded
    // outright rather than misread as "nothing ran": two EMPTY tails are
    // trivially "identical" whether or not real tests executed, so empty
    // output carries no discriminating signal either way and must never
    // flip a real survivor to inconclusive.
    const hasComparableOutput =
      testResult.stdoutTail.length > 0 ||
      testResult.stderrTail.length > 0 ||
      baselineOutput.stdoutTail.length > 0 ||
      baselineOutput.stderrTail.length > 0;
    // Both this comparison and the two `hasKnownTestSummary` checks only
    // ever see each side's CAPTURED tail (`exec.ts`'s
    // `TAIL_LINES`/`TAIL_CHARS` bound), never the command's full output:
    // a truncated tail that happens to compare byte-identical to the
    // other side proves nothing about the untruncated output, so the
    // fallback stays out of the way entirely once either side was cut.
    const eitherTailTruncated =
      testResult.stdoutTruncated ||
      testResult.stderrTruncated ||
      baselineOutput.stdoutTruncated ||
      baselineOutput.stderrTruncated;
    const genericFallback =
      restsOnPassingVerdict &&
      hasComparableOutput &&
      !eitherTailTruncated &&
      !mutantZeroTests.detected &&
      // The caller's own opt-in evidence (`--require-baseline-evidence`,
      // matched against the baseline) is exactly the evidence this
      // fallback stands in for absent that opt-in: once the caller has
      // supplied and confirmed it, a genuine survivor of a quiet,
      // deterministic runner (e.g. `node --test --test-reporter=dot`'s
      // bare `..`) is reported `survived`, not second-guessed here.
      !baselineOutput.requireBaselineEvidenceMatched &&
      !hasKnownTestSummary(testResult.stdoutTail, testResult.stderrTail) &&
      !hasKnownTestSummary(
        baselineOutput.stdoutTail,
        baselineOutput.stderrTail,
      ) &&
      testResult.stdoutTail === baselineOutput.stdoutTail &&
      testResult.stderrTail === baselineOutput.stderrTail;
    if (mutantZeroTests.detected || genericFallback) {
      status = "inconclusive";
      reason = "no_tests_executed";
      mutationProbeResult = "not_run";
      warnings.push(
        mutantZeroTests.detected
          ? `the mutant run's own output shows no test was actually executed (${mutantZeroTests.via}); see ${testResult.logPath}`
          : `the baseline and mutant runs produced byte-identical output with no test-summary line either built-in detector recognizes; see ${testResult.logPath}`,
      );
    }
  }

  return {
    status,
    reason,
    mutant,
    mutation_probe: {
      mutant: mutantSummary,
      verified_applied_via: verifiedAppliedVia,
      result: mutationProbeResult,
      restored_verified: restoredVerified,
      ...(reason === "no_tests_executed" ? { reason } : {}),
    },
    test: testField,
    logPaths,
    restoreFailed: false,
    aborted: testResult.aborted,
  };
}
