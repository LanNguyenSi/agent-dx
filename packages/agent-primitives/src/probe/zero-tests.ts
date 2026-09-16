import { vitestDetector } from "../verify/detectors/vitest.js";
import {
  phpunitDetector,
  phpunitZeroTestsVerdict,
} from "../verify/detectors/phpunit.js";
import { combinedOutput } from "../exec.js";

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
 *
 * A third shape, PHPUnit's, reuses `phpunitDetector.matches` (to decide
 * whether the output is PHPUnit's at all) and `phpunitZeroTestsVerdict`
 * (the actual zero-tests reading, built on PHPUnit's own STATED total
 * less every category that did not execute -- Skipped and Incomplete
 * always, a plain `Warnings` count under PHPUnit 9, per the
 * version-aware tally-category table in `verify/detectors/phpunit.ts` --
 * rather than on `passed`/`failed`/`errors`, since a run with both a
 * real failure and a real skip parses those three to `0` too) from that
 * same module, so this module never re-implements PHPUnit's own
 * regexes.
 *
 * That reading is three-valued, and this module deliberately collapses
 * it in the FAIL-SAFE direction: an `"ambiguous"` output is reported as
 * detected here, exactly like a `"zero"` one, so the caller refuses the
 * run rather than scoring it. Both of that verdict's causes are
 * collapsed the same way: a tally whose version-dependent count decides
 * the question with no version banner left to read it against, and an
 * output carrying PHPUnit's banner but no result report at all (a
 * mid-suite `exit()`/`die()` -- see `phpunitZeroTestsVerdict`). A
 * refusal on such a run costs a probe result; the other collapse
 * would buy a verdict with a false one, since a mutant run whose tally
 * cannot be read as executing anything would otherwise be compared
 * against the baseline as if it had run and passed, and reported
 * `survived`. A run whose result report is merely SUPPRESSED rather
 * than missing (PHPUnit 10+ `--no-results`, which still prints its
 * progress counter and post-run `Time:` line) reads `"not_zero"` and is
 * scored normally: refusing those would refuse every baseline of a
 * project that runs PHPUnit that way.
 *
 * The refusal's own reason (`no_tests_executed`, see `session.ts`) is
 * the nearest of the existing reasons and OVERSTATES what is known for
 * either ambiguous cause: the run may in fact have executed every one
 * of its tests under a PHPUnit 10+ reading, and an unreadable-result
 * run may well have executed and passed a test before it was killed
 * (the captured `exit()` fixture's own single progress dot is exactly
 * that). That overstatement is an accepted, recorded limit of this
 * release rather than an oversight -- a dedicated refusal reason for
 * "cannot be read" is a follow-up, since `RefusalReason` is part of
 * `probe`'s published result contract -- and it is the only thing kept
 * imprecise here: the verdict itself, and every text `verify` prints,
 * name the absence for what it is. `verify` keeps the two apart, since
 * it warns rather than refuses and can afford the distinction.
 */

export type ZeroTestsDetectorName = "vitest" | "node_test" | "phpunit";

export interface ZeroTestsEvidence {
  detected: boolean;
  via?: ZeroTestsDetectorName;
}

/**
 * Node's built-in test runner (`node --test`) summary line, in either of
 * its two default shapes: the "spec" reporter's `ℹ tests <n>` (the
 * default when stdout is not TAP-consuming) and the `tap` reporter's `#
 * tests <n>`. Anchored on the whole `tests <n>` token so it never fires
 * on unrelated text that merely contains the word "tests".
 */
const NODE_TEST_SUMMARY_LINE = /^[ℹ#]\s*tests\s+(\d+)\s*$/m;

/** A JSON reporter result must occupy one complete stream, never a fragment
 * embedded in mixed runner output. These stable Vitest 4 tally fields and
 * their arithmetic reject malformed, partial, and lookalike objects. */
interface VitestJsonSummary {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
}

const VITEST_JSON_COUNT_KEYS = [
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
] as const;

function parseVitestJsonSummary(output: string): VitestJsonSummary | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const counts = {} as VitestJsonSummary;
  for (const key of VITEST_JSON_COUNT_KEYS) {
    const count = record[key];
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      return undefined;
    }
    counts[key] = count;
  }
  if (
    counts.numTotalTests !==
    counts.numPassedTests +
      counts.numFailedTests +
      counts.numPendingTests +
      counts.numTodoTests
  ) {
    return undefined;
  }
  return counts;
}

function findVitestJsonSummary(
  stdoutTail: string,
  stderrTail: string,
): VitestJsonSummary | undefined {
  return (
    parseVitestJsonSummary(stdoutTail) ?? parseVitestJsonSummary(stderrTail)
  );
}

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
  const jsonSummary = findVitestJsonSummary(stdoutTail, stderrTail);
  if (jsonSummary !== undefined) {
    if (jsonSummary.numPassedTests + jsonSummary.numFailedTests === 0) {
      return { detected: true, via: "vitest" };
    }
    return { detected: false };
  }
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
  if (phpunitDetector.matches(input)) {
    // Built on PHPUnit's own STATED total (via `phpunitZeroTestsVerdict`),
    // never on `passed`/`failed`/`errors` alone: those three parse to `0`
    // for a run that had a real failure alongside a real skip too, and a
    // warnings-only run (`Tests: 1, Assertions: 0, Warnings: 1.`, exit
    // `0`) reads as `passed: 1` on any derivation that counts a synthetic
    // PHPUnit warning as an executed test (see that function's docblock).
    // Anything but a clean `"not_zero"` is reported as detected: an
    // `"ambiguous"` reading is refused rather than scored, the fail-safe
    // collapse for a probe (see this module's own docblock).
    if (phpunitZeroTestsVerdict(combined).verdict !== "not_zero") {
      return { detected: true, via: "phpunit" };
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
  if (findVitestJsonSummary(stdoutTail, stderrTail) !== undefined) {
    return true;
  }
  const input = { output: combined, command: "", exitCode: 0 };
  if (vitestDetector.matches(input)) {
    return true;
  }
  if (phpunitDetector.matches(input)) {
    return true;
  }
  return hasNodeTestSummaryLine(combined);
}
