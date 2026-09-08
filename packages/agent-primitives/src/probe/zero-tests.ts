import { vitestDetector } from "../verify/detectors/vitest.js";

/**
 * Detects when a test command's own output shows that no test actually
 * ran, so a baseline (or a mutant run) that exits 0 with nothing
 * executed is never read as a real pass -- and, symmetrically, a
 * baseline/mutant pair that both show nothing executed is never read as
 * a real "survived". Two purpose-built detectors: vitest's own summary
 * shapes (reused from `verify/detectors/vitest.ts` rather than
 * reimplemented, since that module already parses every vitest 4
 * summary shape and is exercised by real captured fixtures), and node's
 * built-in test runner's zero-count summary line. `hasKnownTestSummary`
 * backs the generic byte-identical fallback (`step.ts`'s classify step)
 * for a suite neither detector recognizes at all.
 *
 * Consumed by `setup.ts` (the baseline-stage check, before a mutant is
 * even applied) and `step.ts` (the mutant-stage check, and the generic
 * fallback that compares against the baseline's own output); see the
 * `"no_tests_executed"` `RefusalReason` in `session.ts` for how a hit
 * here turns into a refusal or a verdict override.
 */

export type ZeroTestsDetectorName = "vitest" | "node_test";

export interface ZeroTestsEvidence {
  detected: boolean;
  via?: ZeroTestsDetectorName;
}

function combinedOutput(stdoutTail: string, stderrTail: string): string {
  return `${stdoutTail}\n${stderrTail}`;
}

/**
 * Node's built-in test runner (`node --test`) summary line, in either of
 * its two default shapes: the "spec" reporter's `ℹ tests <n>` (the
 * default when stdout is not TAP-consuming) and the `tap` reporter's `#
 * tests <n>`. Anchored on the whole `tests <n>` token so it never fires
 * on unrelated text that merely contains the word "tests".
 */
const NODE_TEST_SUMMARY_LINE = /^[ℹ#]\s*tests\s+(\d+)\s*$/m;

/**
 * Whether `stdoutTail`/`stderrTail` shows a KNOWN test-runner summary
 * whose count is zero: vitest's "No test files found" (no matching
 * file), an all-skipped or otherwise 0-passed/0-failed vitest `Tests`
 * summary (a `-t`/name filter that matched no test inside files vitest
 * still loaded), or node's built-in test runner reporting `tests 0`.
 * `via` names which detector matched, for a caller's own warning text.
 */
export function detectKnownZeroTestsEvidence(
  stdoutTail: string,
  stderrTail: string,
): ZeroTestsEvidence {
  const combined = combinedOutput(stdoutTail, stderrTail);
  const input = { output: combined, command: "", exitCode: 0 };
  if (vitestDetector.matches(input)) {
    const parsed = vitestDetector.parse(input);
    // `skipped`/`todo` tests are not "executed": a run whose `Tests`
    // line carries only a skipped/todo segment (nothing `passed`, nothing
    // `failed`) never actually exercised the code under test, whatever
    // the process's own exit code says.
    if (parsed.summary.passed === 0 && parsed.summary.failed === 0) {
      return { detected: true, via: "vitest" };
    }
    return { detected: false };
  }
  const nodeMatch = NODE_TEST_SUMMARY_LINE.exec(combined);
  if (nodeMatch !== null && Number(nodeMatch[1]) === 0) {
    return { detected: true, via: "node_test" };
  }
  return { detected: false };
}

/**
 * Node's built-in test runner summary line, count-agnostic: reused by
 * `detectKnownZeroTestsEvidence` above (which additionally checks the
 * captured count is `0`) and by `hasKnownTestSummary` below, so the two
 * never drift apart into two independently-maintained copies of the
 * same pattern.
 */
function hasNodeTestSummaryLine(combined: string): boolean {
  return NODE_TEST_SUMMARY_LINE.test(combined);
}

/**
 * Whether `stdoutTail`/`stderrTail` carries ANY summary line one of the
 * detectors above recognizes, zero-count or not (a normal `Tests  5
 * passed (5)` included): used by the generic byte-identical fallback
 * (`step.ts`) to stay out of the way of output these detectors already
 * understand, so the fallback only ever fires for a genuinely unknown
 * test runner.
 */
export function hasKnownTestSummary(
  stdoutTail: string,
  stderrTail: string,
): boolean {
  const combined = combinedOutput(stdoutTail, stderrTail);
  if (vitestDetector.matches({ output: combined, command: "", exitCode: 0 })) {
    return true;
  }
  return hasNodeTestSummaryLine(combined);
}
