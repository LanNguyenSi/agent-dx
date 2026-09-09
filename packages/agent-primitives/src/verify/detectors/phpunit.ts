import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/**
 * PHPUnit 9.6's default (non-TestDox) text reporter, captured from real
 * runs (see `test/fixtures/README.md` for the exact command, tool
 * version, and PHP version used): a green run's `OK (N tests, M
 * assertions)` line; a red run's `FAILURES!`/`ERRORS!` marker (`ERRORS!`
 * whenever the run has at least one error, even alongside failures --
 * PHPUnit never prints both markers together) plus its `Tests: N,
 * Assertions: M, ...` tally line (the named counts after `Assertions: M`
 * -- `Errors`, `Failures`, `Warnings`, `Skipped`, `Incomplete`, `Risky`
 * -- appear only when nonzero, in PHPUnit's own fixed order, which this
 * detector does not rely on: each is picked out by name, not position);
 * a `WARNINGS!` marker (a `@dataProvider`-less test class, or any other
 * PHPUnit-level warning) with the same tally shape; an all
 * skipped/incomplete/risky run's `OK, but incomplete, skipped, or risky
 * tests!` marker, exit `0`, with the same tally shape; and the "no tests
 * matched at all" `No tests executed!` line (an empty suite, or a
 * `--filter` that matched nothing). Anchored on these whole-line tokens
 * so this detector never fires on vitest's `Tests  N (failed|passed|...)
 * (T)` shape (no `OK (`, `FAILURES!`, `Tests: N, Assertions: M` token
 * there) or on tsc/eslint's diagnostic-line shapes.
 */
const OK_LINE = /^OK \((\d+) tests?, \d+ assertions?\)\s*$/m;
const FAILURES_MARKER = /^FAILURES!\s*$/m;
const ERRORS_MARKER = /^ERRORS!\s*$/m;
const WARNINGS_MARKER = /^WARNINGS!\s*$/m;
/** The all-skipped/incomplete/risky "still exit 0" marker: no
 * `FAILURES!`/`ERRORS!`/`WARNINGS!` line at all, only this one, followed
 * by the same `Tests: ...` tally shape (captured real: an all-skipped
 * run and an all-risky run, see `test/fixtures/README.md`). Round-1
 * review finding: before this marker was recognized, an all-skipped run
 * matched no shape here at all, so `probe`'s zero-tests guard never
 * fired for it. */
const INCOMPLETE_SKIPPED_RISKY_MARKER =
  /^OK, but incomplete, skipped, or risky tests!\s*$/m;
/**
 * The tally line's own head (`Tests: N, Assertions: M`), always present
 * whenever any of `FAILURES!`/`ERRORS!`/`WARNINGS!`/
 * `INCOMPLETE_SKIPPED_RISKY_MARKER` is. The trailing `, Name: N` groups
 * (any of `Errors`, `Failures`, `Warnings`, `Skipped`, `Incomplete`,
 * `Risky`) are captured whole here and picked apart by `NAMED_COUNT`
 * below rather than by position: round-1 review finding, PHPUnit prints
 * `Errors:` before `Failures:` when a run has both (`ERRORS!` wins the
 * marker in that case), so a tally parsed by a fixed `Failures`-then-
 * `Errors` position would either miss the shape or misread which count
 * is which.
 */
const TALLY_LINE =
  /^Tests: (\d+), Assertions: (\d+)((?:, [A-Za-z]+: \d+)*)\.\s*$/m;
/** Picks one `Name: N` token out of `TALLY_LINE`'s captured trailing
 * group, order-independent. */
const NAMED_COUNT = /([A-Za-z]+):\s*(\d+)/g;
const NO_TESTS_EXECUTED = /^No tests executed!\s*$/m;

/** One `N) Class::method` failure/error header, PHPUnit's own numbered
 * entry format under `FAILURES!`/`ERRORS!`. Never matches a `WARNINGS!`
 * entry (`N) Warning`, no `::`) or a `RISKY!`/skipped entry under
 * `INCOMPLETE_SKIPPED_RISKY_MARKER` naming a real `Class::method` (not
 * captured by this detector at all: known boundary, see below). */
const ENTRY_HEADER = /^\d+\) (.+?)::(.+)$/;
/** The `file:line` locator line PHPUnit prints under each entry's own
 * message (its own line, set off by a blank line above and below in the
 * default reporter). Captured structurally (`.+` up to the last `:`
 * followed by only digits to end of line), not `\S+`, so a path
 * containing a colon is still handled the same way any other detector
 * here treats a locator line. */
const ENTRY_FILE_LINE = /^(.+):(\d+)$/;
/** A PHP-level deprecation notice PHPUnit lets through to its own
 * output (e.g. a dynamic-property-creation notice on PHP 8.2+, captured
 * on a green run alongside its `OK (...)` line): reported as a free-text
 * detector warning rather than folded into `failures`, since the run
 * itself still passed.
 */
const DEPRECATION_LINE = /^Deprecated: (.+)$/gm;

/** Parses a matched `TALLY_LINE`'s named counts (all default `0` when
 * absent from the line, since PHPUnit only prints a nonzero one). */
interface TallyCounts {
  total: number;
  errors: number;
  failures: number;
  warnings: number;
  skipped: number;
  incomplete: number;
  risky: number;
}

function parseTally(output: string): TallyCounts | undefined {
  const head = TALLY_LINE.exec(output);
  if (!head) return undefined;
  const counts: TallyCounts = {
    total: Number(head[1]),
    errors: 0,
    failures: 0,
    warnings: 0,
    skipped: 0,
    incomplete: 0,
    risky: 0,
  };
  for (const match of head[3].matchAll(NAMED_COUNT)) {
    const key = match[1].toLowerCase();
    const value = Number(match[2]);
    if (key === "errors") counts.errors = value;
    else if (key === "failures") counts.failures = value;
    else if (key === "warnings") counts.warnings = value;
    else if (key === "skipped") counts.skipped = value;
    else if (key === "incomplete") counts.incomplete = value;
    else if (key === "risky") counts.risky = value;
  }
  return counts;
}

/**
 * Whether `output` shows PHPUnit executed zero tests: either the
 * explicit `No tests executed!` line, a stated `OK (0 tests, ...)`
 * (defensive -- not observed from a real capture; PHPUnit 9.6.36
 * prints `No tests executed!` for an empty suite instead, see
 * `test/fixtures/README.md`), or a tally line whose own stated total,
 * less its Skipped and Incomplete counts, is zero. Risky is
 * DELIBERATELY excluded from that subtraction: a risky test still ran
 * (it just performed no assertions, or PHPUnit otherwise flagged it),
 * unlike a skipped or incomplete one, which never executed its body at
 * all. Reused by `probe/zero-tests.ts` so its gate is never built on
 * `passed`/`failed`/`errors` alone -- round-1 review finding: a red run
 * with both a real failure and a real skip (`Tests: 3, Assertions: 2,
 * Failures: 1, Skipped: 1.`) parsed those three fields to 0 under the
 * OLD fixed-shape tally regex, which a `passed === 0 && failed === 0 &&
 * errors === 0` check misread as "nothing executed" even though the
 * suite genuinely caught something.
 */
export function phpunitZeroTestsExecuted(output: string): boolean {
  if (NO_TESTS_EXECUTED.test(output)) return true;
  const okMatch = OK_LINE.exec(output);
  if (okMatch) return Number(okMatch[1]) === 0;
  const tally = parseTally(output);
  if (tally) {
    return tally.total - tally.skipped - tally.incomplete <= 0;
  }
  return false;
}

/**
 * Known boundary: this detector reads PHPUnit's own numbered
 * `FAILURES!`/`ERRORS!` entries (`N) Class::method`) and the
 * `OK (...)`/`Tests: ...` summary lines. It does not parse PHPUnit's
 * TestDox reporter or its JUnit XML output. A `WARNINGS!`/skipped/
 * incomplete/risky entry (`N) Warning`, or a listed skip/risky reason)
 * is never added to `failures`: the risky-entry header does carry a
 * real `Class::method` name and so would match `ENTRY_HEADER`'s own
 * grammar, but no captured fixture this detector is tested against
 * exercises that combination (every all-skipped/all-risky/warnings-only
 * capture here prints zero numbered `Class::method` entries alongside
 * its marker), so this remains a documented, untested boundary rather
 * than a verified guarantee.
 */
export const phpunitDetector: Detector = {
  name: "phpunit",
  matches(input: DetectorInput): boolean {
    const output = input.output;
    return (
      OK_LINE.test(output) ||
      FAILURES_MARKER.test(output) ||
      ERRORS_MARKER.test(output) ||
      WARNINGS_MARKER.test(output) ||
      INCOMPLETE_SKIPPED_RISKY_MARKER.test(output) ||
      TALLY_LINE.test(output) ||
      NO_TESTS_EXECUTED.test(output)
    );
  },
  parse(input: DetectorInput): DetectorParseResult {
    const output = input.output;
    const failures: DetectorParseResult["failures"] = [];
    let passed = 0;
    let failed = 0;
    let errors = 0;
    let skipped = 0;
    let warningsCount = 0;

    const okMatch = OK_LINE.exec(output);
    const tally = parseTally(output);
    if (okMatch) {
      passed = Number(okMatch[1]);
    } else if (tally) {
      failed = tally.failures;
      errors = tally.errors;
      skipped = tally.skipped + tally.incomplete + tally.risky;
      warningsCount = tally.warnings;
      const executed = tally.total - tally.skipped - tally.incomplete;
      passed = Math.max(executed - failed - errors, 0);
    }
    // `No tests executed!` (and any other shape none of the above
    // matched, unreachable when `matches` gated this call) leaves every
    // count at 0: correct as-is, not a false "nothing failed" claim --
    // same convention as the vitest detector's "no test files" case.

    const lines = output.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const header = ENTRY_HEADER.exec(lines[i]);
      if (!header) continue;
      const name = `${header[1]}::${header[2]}`;
      let file: string | undefined;
      let entryLine: number | undefined;
      let message = "";
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (
          ENTRY_HEADER.test(line) ||
          /^(FAILURES!|ERRORS!|WARNINGS!|OK, but incomplete, skipped, or risky tests!)\s*$/.test(
            line,
          ) ||
          /^Tests: \d+, Assertions: \d+/.test(line)
        ) {
          break;
        }
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (file === undefined) {
          const fileLine = ENTRY_FILE_LINE.exec(trimmed);
          if (fileLine) {
            file = fileLine[1];
            entryLine = Number(fileLine[2]);
            continue;
          }
        }
        message = message.length > 0 ? `${message} ${trimmed}` : trimmed;
      }
      i = j - 1;
      failures.push({
        ...(file ? { file } : {}),
        ...(entryLine !== undefined ? { line: entryLine } : {}),
        name,
        message: message.length > 0 ? message : `${name} failed`,
      });
    }

    const warnings: string[] = [];
    for (const match of output.matchAll(DEPRECATION_LINE)) {
      warnings.push(`phpunit_deprecation: ${match[1].trim()}`);
    }

    return {
      summary: {
        passed,
        failed,
        skipped,
        errors,
        warnings: warningsCount,
      },
      failures,
      warnings,
    };
  },
};
