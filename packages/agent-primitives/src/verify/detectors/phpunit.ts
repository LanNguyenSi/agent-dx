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
 * a `WARNINGS!` marker (a test class with no test methods, or any other
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
/**
 * The tally line's own head (`Tests: N, Assertions: M`), always present
 * whenever a `FAILURES!`/`ERRORS!`/`WARNINGS!` marker or the
 * all-skipped/incomplete/risky "still exit 0" marker (`OK, but
 * incomplete, skipped, or risky tests!`, captured real: an all-skipped
 * run, an all-risky run, and a risky-plus-real run, see
 * `test/fixtures/README.md`) is. The trailing `, Name: N` groups
 * (any of `Errors`, `Failures`, `Warnings`, `Skipped`, `Incomplete`,
 * `Risky`) are captured whole here and picked apart by `NAMED_COUNT`
 * below rather than by position: PHPUnit prints `Errors:` before
 * `Failures:` when a run has both (`ERRORS!` wins the marker in that
 * case), so a tally parsed by a fixed `Failures`-then-`Errors` position
 * would either miss the shape or misread which count is which.
 */
const TALLY_LINE =
  /^Tests: (\d+), Assertions: (\d+)((?:, [A-Za-z]+: \d+)*)\.\s*$/m;
/** Picks one `Name: N` token out of `TALLY_LINE`'s captured trailing
 * group, order-independent. */
const NAMED_COUNT = /([A-Za-z]+):\s*(\d+)/g;
/** The tally line's head alone, as an entry-body terminator: matches the
 * same line `TALLY_LINE` does without requiring the trailing `.` to be
 * present, so a tally cut short by output truncation still ends the
 * entry above it rather than being folded into its message. */
const TALLY_HEAD_LINE = /^Tests: \d+, Assertions: \d+/;
const NO_TESTS_EXECUTED = /^No tests executed!\s*$/m;

/**
 * PHPUnit's own defect-section header, printed once above each group of
 * numbered entries: `There was 1 error:` / `There were 2 errors:` and
 * the same singular/plural pair for `failure`, `warning`, `risky test`,
 * `incomplete test`, `skipped test`. The captured fixtures exercise the
 * singular `error`, `failure`, `warning` and `risky test` forms and the
 * plural `failure`/`risky test` forms (`There were 2 failures:` / `There
 * were 2 risky tests:` in `phpunit-two-failures-and-risky.txt`); the
 * kind is captured (`error`, `risky test`, ...) rather than assumed,
 * since only some kinds contribute to `failures` (see
 * `COLLECTED_SECTION_KINDS`).
 */
const DEFECT_SECTION_HEADER = /^There (?:was|were) \d+ (.+?)s?:\s*$/;
/**
 * The defect kinds whose numbered entries become `failures` entries:
 * only the error and failure sections. A risky, warning, incomplete or
 * skipped entry names a real `Class::method` too (captured real: `1)
 * RiskyRealTest::testNoAssertions` in `phpunit-risky-and-real.txt`, and
 * the two risky entries of `phpunit-two-failures-and-risky.txt`), so the
 * entry header's own grammar cannot tell them apart -- the section
 * header above them can, and it is the only thing that can. Those
 * entries are dropped rather than reported: `DetectorParseResult` has no
 * `notes` field to put them in, and `summary.skipped`/`summary.warnings`
 * already carry their counts, so dropping them keeps the result contract
 * unchanged.
 */
const COLLECTED_SECTION_KINDS = new Set(["error", "failure"]);

/** One `N) Class::method` failure/error header, PHPUnit's own numbered
 * entry format. Only collected inside an error/failure section (see
 * `COLLECTED_SECTION_KINDS`). */
const ENTRY_HEADER = /^\d+\) (.+?)::(.+)$/;
/** Any numbered entry header, `Class::method` or not (`1) Warning` has
 * no `::`): an entry-body terminator, so a warning entry following a
 * collected one still ends it. */
const ENTRY_START = /^\d+\) /;
/** The `--` divider PHPUnit prints between two defect sections (captured
 * real: between the error and failure sections of
 * `phpunit-errors-and-failures.txt`, and again between the failure and
 * risky sections of `phpunit-two-failures-and-risky.txt`). An
 * entry-body terminator: without it the divider and everything after it
 * up to the next entry header was being folded into the preceding
 * entry's message. */
const ENTRY_DIVIDER = /^--\s*$/;
/** The `file:line` locator line PHPUnit prints under each entry's own
 * message, set off by a blank line above (and below) in the default
 * reporter -- never the entry's first line, which is always its message.
 * Captured structurally (`.+` up to the last `:` followed by only digits
 * to end of line), not `\S+`, so a path containing a colon is still
 * handled the same way any other detector here treats a locator line;
 * the blank-line precondition is what the entry loop below actually
 * enforces (captured real: `phpunit-error-message-with-port.txt`'s
 * first message line, "RuntimeException: upstream unreachable at
 * api.example.com:8080", ends in `:8080` and is not preceded by a blank
 * line, so it is never mistaken for the locator that follows it). */
const ENTRY_FILE_LINE = /^(.+):(\d+)$/;
/** A PHP-level deprecation notice PHPUnit lets through to its own
 * output (e.g. a dynamic-property-creation notice on PHP 8.2+, captured
 * on a green run alongside its `OK (...)` line): reported as a free-text
 * detector warning rather than folded into `failures`, since the run
 * itself still passed.
 */
const DEPRECATION_LINE = /^Deprecated: (.+)$/gm;

/**
 * PHPUnit's tally categories, and the one attribute the whole derivation
 * below turns on: did a test counted here actually RUN its body?
 *
 * | Category   | executed | Lands in                                  |
 * | ---------- | -------- | ----------------------------------------- |
 * | Failures   | yes      | `summary.failed`                          |
 * | Errors     | yes      | `summary.errors`                          |
 * | Risky      | yes      | `summary.passed` (ran; no defect counted) |
 * | Skipped    | no       | `summary.skipped`                         |
 * | Incomplete | no       | `summary.skipped`                         |
 * | Warnings   | no       | `summary.warnings`                        |
 *
 * Risky is executed: a risky test ran, PHPUnit merely flagged it (it
 * performed no assertions, say), so it may not be read as "nothing
 * happened". Warnings is NOT executed: PHPUnit counts a synthetic
 * `WarningTestCase` in its total (`No tests found in class "X".` is one
 * whole `Tests: 1` on its own), so treating a warning as executed reads
 * a run in which nothing at all ran as a green `passed: 1`. Erring
 * toward "inconclusive" is the fail-safe direction for both the summary
 * and `probe`'s zero-tests guard; erring toward "green" would misread a
 * warnings-only run (captured real: `phpunit-warnings.txt`) as passing.
 *
 * `executed` and `passed` are derived by spending the stated total once,
 * category by category, rather than by subtracting one named category
 * at a time (a derivation that grows a new subtraction per newly
 * captured shape with no invariant tying the result to the stated
 * total): `deriveCounts` below spends the total exactly once, so
 * `passed + failed + errors + skipped + warnings === total` holds by
 * construction for every input, including an inconsistent one (see
 * `test/verify.test.ts`'s summary-invariant test, which pins the
 * equality, not merely a `<=` bound).
 */
interface TallyCategory {
  /** The `Name:` token PHPUnit prints for this category in its tally. */
  readonly name: keyof NamedTallyCounts;
  /** Whether a test counted here actually RAN its body. */
  readonly executed: boolean;
  /** Which `Summary` field this category is reported in. A category
   * reporting as `passed` is never deducted from the executed budget; it
   * IS the remainder (see `deriveCounts`). */
  readonly reportsAs: "passed" | "failed" | "errors" | "skipped" | "warnings";
}

const TALLY_CATEGORIES: readonly TallyCategory[] = [
  { name: "failures", executed: true, reportsAs: "failed" },
  { name: "errors", executed: true, reportsAs: "errors" },
  { name: "risky", executed: true, reportsAs: "passed" },
  { name: "skipped", executed: false, reportsAs: "skipped" },
  { name: "incomplete", executed: false, reportsAs: "skipped" },
  { name: "warnings", executed: false, reportsAs: "warnings" },
];

/** The named counts PHPUnit prints after `Assertions: M` (each present
 * only when nonzero, hence each defaulting to `0` here). */
interface NamedTallyCounts {
  errors: number;
  failures: number;
  warnings: number;
  skipped: number;
  incomplete: number;
  risky: number;
}

interface RawTally extends NamedTallyCounts {
  total: number;
}

/** The derived, invariant-respecting counts: the five `Summary` fields
 * plus the two the derivation itself is defined in terms of. */
interface DerivedCounts {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  warnings: number;
}

function parseTally(output: string): RawTally | undefined {
  const head = TALLY_LINE.exec(output);
  if (!head) return undefined;
  const counts: RawTally = {
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
 * Derives every count from PHPUnit's own STATED total by spending that
 * total, never by adding parsed parts up: `total` is a budget, the
 * not-executed categories are taken out of it first (`TALLY_CATEGORIES`
 * decides which those are), what remains is `executed`, the two defect
 * categories are taken out of that, and whatever is still left is
 * `passed` (which is where Risky lands, since nothing takes it out).
 *
 * Every `take` is clamped to the remaining budget, so two invariants
 * hold for ANY input, a self-contradictory tally included (`Tests: 2,
 * ..., Failures: 3, Skipped: 5.` cannot come from a real run, but a
 * truncated or interleaved output can present one):
 *
 *   passed + failed + errors === executed
 *   passed + failed + errors + skipped + warnings === total
 *
 * so the summary can never claim more tests than the run itself stated,
 * and `passed` can never go negative. Order of the takes is fixed and
 * load-bearing only for such an inconsistent input: the not-executed
 * categories are trusted first (an over-count there shrinks `executed`
 * toward zero, i.e. toward "inconclusive"), defects next, and `passed`
 * -- the only reading that can turn into a false green -- absorbs the
 * remainder last.
 *
 * Returns `undefined` when the output carries neither shape (`No tests
 * executed!`, or output too truncated to hold either line).
 */
function deriveCounts(output: string): DerivedCounts | undefined {
  const okMatch = OK_LINE.exec(output);
  if (okMatch) {
    const total = Number(okMatch[1]);
    return {
      total,
      executed: total,
      passed: total,
      failed: 0,
      errors: 0,
      skipped: 0,
      warnings: 0,
    };
  }
  const tally = parseTally(output);
  if (!tally) return undefined;

  const total = Math.max(tally.total, 0);
  let remaining = total;
  const take = (count: number): number => {
    const taken = Math.min(Math.max(count, 0), remaining);
    remaining -= taken;
    return taken;
  };
  const reported = { passed: 0, failed: 0, errors: 0, skipped: 0, warnings: 0 };
  // Not executed first (the table decides which those are): whatever
  // they take is out of `executed` before it is even computed.
  for (const category of TALLY_CATEGORIES) {
    if (category.executed) continue;
    reported[category.reportsAs] += take(tally[category.name]);
  }
  const executed = remaining;
  // Then the executed categories that report a defect. A category
  // reporting as `passed` (Risky) is deliberately not taken out: it is
  // part of the remainder below, which is what makes a risky test count
  // as executed and as non-failing at once.
  for (const category of TALLY_CATEGORIES) {
    if (!category.executed || category.reportsAs === "passed") continue;
    reported[category.reportsAs] += take(tally[category.name]);
  }
  reported.passed += remaining;
  return { total, executed, ...reported };
}

/**
 * Whether `output` shows PHPUnit executed zero tests: either the
 * explicit `No tests executed!` line, or a run whose derived `executed`
 * count (the stated total less every not-executed category, per
 * `TALLY_CATEGORIES`) is zero. That covers a stated `OK (0 tests, 0
 * assertions)` (defensive -- not observed from a real capture; PHPUnit
 * 9.6.36 prints `No tests executed!` for an empty suite instead), an
 * all-skipped/all-incomplete run, and a warnings-only run (`Tests: 1,
 * Assertions: 0, Warnings: 1.`, exit `0`, captured real:
 * `phpunit-warnings.txt`, a shape that reads as a green `passed: 1`
 * under any derivation that counts a synthetic PHPUnit warning as an
 * executed test). It deliberately does NOT cover a risky run: `Tests:
 * 1, Assertions: 0, Risky: 1.` ran its test.
 *
 * Reused by `probe/zero-tests.ts` so its gate is never built on
 * `passed`/`failed`/`errors` alone: a red run with both a real failure
 * and a real skip (`Tests: 3, Assertions: 2, Failures: 1, Skipped: 1.`,
 * captured real: `phpunit-skip-and-fail.txt`) parses those three fields
 * to 0 under a `passed === 0 && failed === 0 && errors === 0` check,
 * which misreads it as "nothing executed" even though the suite
 * genuinely caught something.
 */
export function phpunitZeroTestsExecuted(output: string): boolean {
  if (NO_TESTS_EXECUTED.test(output)) return true;
  const counts = deriveCounts(output);
  return counts !== undefined && counts.executed === 0;
}

/**
 * Whether `line` is one of PHPUnit's own end-of-run marker lines. Built
 * from the marker constants above rather than a second copy of their
 * text.
 *
 * Does NOT check the all-skipped/incomplete/risky "still exit 0" marker
 * (`OK, but incomplete, skipped, or risky tests!`): PHPUnit only ever
 * prints that marker when the run has no error/failure section at all,
 * so every real capture that carries it reaches this function (both
 * call sites below) with `collecting` already `false` -- the check
 * would be a no-op in both places it would run, and a mutant removing
 * it survived the whole suite for exactly that reason.
 */
function isMarkerLine(line: string): boolean {
  return (
    FAILURES_MARKER.test(line) ||
    ERRORS_MARKER.test(line) ||
    WARNINGS_MARKER.test(line) ||
    NO_TESTS_EXECUTED.test(line)
  );
}

/**
 * Where one numbered entry's message body ends. PHPUnit closes an entry
 * with no terminator of its own, so the body runs until the next thing
 * that cannot belong to it:
 *
 *   1. the next numbered entry header (`N) ...`, `Class::method` or the
 *      `1) Warning` shape) -- captured real:
 *      `phpunit-errors-and-failures.txt`'s two entries, and
 *      `phpunit-two-failures-and-risky.txt`'s four.
 *   2. the `--` divider between two defect sections -- captured real:
 *      the same two fixtures' dividers between their error/failure and
 *      failure/risky sections.
 *   3. the next defect-section header (`There was 1 failure:`) --
 *      defensive, no capture behind it: every real capture measured so
 *      far prints the `--` divider ahead of a second section header too
 *      (arm 2 above already terminates the entry in that case), so this
 *      arm has never been observed to fire on its own; kept in case a
 *      PHPUnit version or reporter omits the divider.
 *   4. an end-of-run marker line (`ERRORS!`, `WARNINGS!`, `FAILURES!`,
 *      `No tests executed!`, see `isMarkerLine`) -- captured real:
 *      `phpunit-fail.txt`'s single entry ends at `FAILURES!` with no
 *      divider ahead of it.
 *   5. the tally line's head (`Tests: N, Assertions: M`) -- defensive,
 *      no capture behind it: `exec.ts` truncates a long capture by
 *      dropping lines off the FRONT and keeping the tail, so the tally
 *      line, always the very last thing PHPUnit prints, is never itself
 *      cut short in any output this package produces; kept for an
 *      output truncated some other way.
 *
 * The scan resumes ON the terminator line rather than after it, so a
 * section header terminator still flips the collecting state.
 */
function isEntryBodyTerminator(line: string): boolean {
  return (
    ENTRY_START.test(line) ||
    ENTRY_DIVIDER.test(line) ||
    DEFECT_SECTION_HEADER.test(line) ||
    isMarkerLine(line) ||
    TALLY_HEAD_LINE.test(line)
  );
}

/**
 * Known boundary: this detector reads PHPUnit's own numbered
 * `FAILURES!`/`ERRORS!` entries (`N) Class::method`) and the
 * `OK (...)`/`Tests: ...` summary lines. It does not parse PHPUnit's
 * JUnit XML output, nor forced-ANSI output.
 *
 * Measured (PHPUnit 9.6.36, PHP 8.3.33), against the earlier claim that
 * they fall to `generic`: the `--testdox` and `--teamcity` reporters
 * both still print the same end-of-run marker and the same `Tests: N,
 * Assertions: M, ...` tally line, so this detector is still selected and
 * every `summary` count is correct under them; what they drop is the
 * numbered `N) Class::method` entries, so `failures` comes back empty.
 *
 * A numbered entry is collected only inside an error or failure section
 * (`COLLECTED_SECTION_KINDS`), which is also the boundary for a
 * truncated output: if the tail kept an entry but not the section header
 * above it, that entry is dropped rather than guessed at. The summary
 * counts still carry it, and `summary.failed + summary.errors >=
 * failures.length` holds either way.
 */
export const phpunitDetector: Detector = {
  name: "phpunit",
  /**
   * `OK_LINE`, `TALLY_LINE` and `NO_TESTS_EXECUTED` are the only
   * load-bearing shapes here: every captured fixture that carries a
   * `FAILURES!`/`ERRORS!`/`WARNINGS!` marker also carries `TALLY_LINE`
   * on the very next line, so `TALLY_LINE` alone already selects this
   * detector for all of them (measured: replacing any one of the three
   * marker checks below with `false` still leaves the whole suite
   * green). They are kept anyway as redundant, cheap shape signals, not
   * because any of them is required by a captured shape. The one marker
   * check actually removed from here was the all-skipped/incomplete/
   * risky "still exit 0" marker (`OK, but incomplete, skipped, or risky
   * tests!`): unlike the three kept above, a mutant removing IT
   * survived too, so it was dropped rather than kept as decoration (see
   * `isMarkerLine`'s docblock for the same marker's other, still-real,
   * removal).
   */
  matches(input: DetectorInput): boolean {
    const output = input.output;
    return (
      OK_LINE.test(output) ||
      FAILURES_MARKER.test(output) ||
      ERRORS_MARKER.test(output) ||
      WARNINGS_MARKER.test(output) ||
      TALLY_LINE.test(output) ||
      NO_TESTS_EXECUTED.test(output)
    );
  },
  parse(input: DetectorInput): DetectorParseResult {
    const output = input.output;
    const failures: DetectorParseResult["failures"] = [];
    // `No tests executed!` (and any other shape neither summary line
    // matched) leaves every count at 0: correct as-is, not a false
    // "nothing failed" claim -- same convention as the vitest detector's
    // "no test files" case.
    const counts = deriveCounts(output) ?? {
      total: 0,
      executed: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      warnings: 0,
    };

    const lines = output.split("\n");
    let collecting = false;
    for (let i = 0; i < lines.length; i++) {
      const section = DEFECT_SECTION_HEADER.exec(lines[i]);
      if (section) {
        collecting = COLLECTED_SECTION_KINDS.has(section[1]);
        continue;
      }
      if (isMarkerLine(lines[i]) || TALLY_HEAD_LINE.test(lines[i])) {
        collecting = false;
        continue;
      }
      const header = ENTRY_HEADER.exec(lines[i]);
      if (!header || !collecting) continue;
      const name = `${header[1]}::${header[2]}`;
      let file: string | undefined;
      let entryLine: number | undefined;
      let message = "";
      // Whether the previous non-terminator line inside this entry was
      // blank: PHPUnit always sets its `file:line` locator off with a
      // blank line above it, and the entry's own message never is (the
      // message starts on the line right after the `N) Class::method`
      // header). Without this guard a message ending in `:<digits>`
      // (captured real: `phpunit-error-message-with-port.txt`'s
      // "RuntimeException: upstream unreachable at api.example.com:8080")
      // is misread as the locator on its own first line.
      let precededByBlank = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (isEntryBodyTerminator(line)) break;
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          precededByBlank = true;
          continue;
        }
        if (file === undefined && precededByBlank) {
          const fileLine = ENTRY_FILE_LINE.exec(trimmed);
          if (fileLine) {
            file = fileLine[1];
            entryLine = Number(fileLine[2]);
            precededByBlank = false;
            continue;
          }
        }
        message = message.length > 0 ? `${message} ${trimmed}` : trimmed;
        precededByBlank = false;
      }
      // Resume ON the terminator line, so a section header or marker
      // that ended this entry is still seen by the outer scan.
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
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        errors: counts.errors,
        warnings: counts.warnings,
      },
      failures,
      warnings,
    };
  },
};
