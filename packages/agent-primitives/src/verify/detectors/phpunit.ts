import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/**
 * Strips PHPUnit's own `--colors=always` SGR escape sequences
 * (`ESC [ <params> m`, e.g. `\x1b[30;42m`, `\x1b[0m`) from `output` before
 * any of this detector's row/line patterns see it. Measured on real
 * captures (`phpunit-pass-colorized.txt`, `phpunit-fail-colorized.txt`;
 * see `test/fixtures/README.md`): PHPUnit colorizes the `OK (...)` line,
 * the `FAILURES!`/`ERRORS!`/`WARNINGS!` marker, EACH comma-separated
 * segment of the `Tests: N, Assertions: M, ...` tally line individually
 * (its own `ESC...m` pair around every segment, not one pair around the
 * whole line), and a non-`.` progress marker character (`F`, `E`, `W`,
 * ...) -- never the version banner, the post-run `Time:`/`Memory:` line,
 * a numbered entry header, or a `file:line` locator, none of which this
 * function's callers need protected from a stray escape sequence either
 * way. `^`/`$`-anchored patterns (`OK_LINE`, `FAILURES_MARKER`,
 * `TALLY_LINE`, `PROGRESS_COUNTER_LINE`, ...) fail to match a colorized
 * line unmodified -- the escape sequence sits between the anchor and the
 * text the pattern expects there -- so every one of this file's line
 * patterns is applied to output already passed through this function,
 * never to a caller's raw bytes. Removing the escape sequences leaves
 * PHPUnit's own wording (and every digit/count in it) byte-identical to
 * the `--colors=never` shape, since PHPUnit wraps tokens in colour
 * rather than replacing or reformatting them -- confirmed by comparing a
 * stripped colorized capture against its `--colors=never` twin. A global
 * match (not anchored to a line), since the tally line's per-segment
 * escapes are not confined to the line's own start/end.
 *
 * Exported for `test/verify.test.ts`'s directory-derived
 * `PROGRESS_COUNTER_LINE` positive control alone (so a captured
 * colorized fixture's row is checked the same way production code
 * checks it, not against a second, independently written strip
 * function): every production caller in this file uses this same
 * function directly.
 */
export function stripAnsiSgr(output: string): string {
  return output.replace(/\x1b\[[0-9;]*m/g, "");
}

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
 * `Risky`, and, under PHPUnit 11, the two-word `PHPUnit Deprecations`,
 * `PHPUnit Warnings`, `PHPUnit Notices` -- captured real:
 * `phpunit-two-word-deprecation-tally.txt`'s `Tests: 2, Assertions: 2,
 * PHPUnit Deprecations: 1.`, a clean `OK, but there were issues!` run
 * where BOTH tests genuinely ran and passed) are captured whole here
 * and picked apart by `NAMED_COUNT` below rather than by position:
 * PHPUnit prints `Errors:` before `Failures:` when a run has both
 * (`ERRORS!` wins the marker in that case), so a tally parsed by a
 * fixed `Failures`-then-`Errors` position would either miss the shape
 * or misread which count is which. The optional `(?:PHPUnit )?` prefix
 * on each token is what widens this from a single word to the two-word
 * `PHPUnit <Name>` shape: without it the ENTIRE tally line fails to
 * match once a two-word token is anywhere in the trailing group (the
 * repeated group requires every token from the first comma onward to
 * fit the shape, not just the tokens before the mismatch), which is
 * exactly the graceful-fallback-to-all-zero-counts failure mode
 * `phpunit-error-data-provider.txt`'s own `Tests: 1, Assertions: 1,
 * Errors: 1, PHPUnit Deprecations: 1.` line exercised before this
 * change.
 */
const TALLY_LINE =
  /^Tests: (\d+), Assertions: (\d+)((?:, (?:PHPUnit )?[A-Za-z]+: \d+)*)\.\s*$/m;
/** Picks one `Name: N` token (or, under PHPUnit 11, one two-word
 * `PHPUnit Name: N` token) out of `TALLY_LINE`'s captured trailing
 * group, order-independent. */
const NAMED_COUNT = /((?:PHPUnit )?[A-Za-z]+):\s*(\d+)/g;
/** The tally line's head alone, as an entry-body terminator: matches the
 * same line `TALLY_LINE` does without requiring the trailing `.` to be
 * present, so a tally cut short by output truncation still ends the
 * entry above it rather than being folded into its message. */
const TALLY_HEAD_LINE = /^Tests: \d+, Assertions: \d+/;
const NO_TESTS_EXECUTED = /^No tests executed!\s*$/m;
/**
 * PHPUnit's own version banner, the very first line of EVERY run's
 * output (captured real: `PHPUnit 9.6.36 by Sebastian Bergmann and
 * contributors.` on every fixture in this suite; `PHPUnit 11.5.56 by
 * Sebastian Bergmann and contributors.` on the PHPUnit-11-only
 * captures), whatever the run does or does not go on to print
 * afterward. Used to recognize output as PHPUnit's OWN at all when it
 * carries no other shape this detector knows (see
 * `phpunitResultUnreadable` below): `exec.ts` truncates a long capture
 * by dropping lines off the FRONT and keeping the tail (this file's
 * other docblocks already rely on that same fact), so a genuinely
 * front-truncated capture drops this banner near the very top long
 * before it would ever drop a tally line at the very end -- a capture
 * that still carries the banner but none of `OK_LINE`/`TALLY_LINE`/
 * `NO_TESTS_EXECUTED` is therefore PHPUnit's own output with its result
 * report missing, not one this package's own truncation merely cut
 * short. What such a shape says about whether anything RAN is a
 * separate question, and `phpunitResultUnreadable` answers it with
 * "unreadable" rather than with a count: the banner alone says only
 * that PHPUnit started.
 *
 * Known limit of that same fact, the other way around: `exec.ts` keeps
 * only a bounded tail (60 lines / 6000 chars). An `exit()`/`die()`
 * mid-suite kill in a suite that prints MORE than that tail bound before
 * the kill -- many progress characters, a large fixture setup dump --
 * can itself push the banner (the very first line PHPUnit prints) out of
 * the kept tail, the same way any other front-truncation would. Such an
 * output carries none of `PHPUNIT_BANNER`/`OK_LINE`/`TALLY_LINE`/
 * `NO_TESTS_EXECUTED` at all, so `matches()` below falls to `generic`
 * and this detector never sees it, exactly as it did before
 * `phpunitResultUnreadable` existed; `probe`'s separate byte-identical
 * generic fallback is what still has a chance of catching a MUTANT that
 * changes such a large, front-truncated run's shape (never a baseline
 * that already was this shape to begin with -- the same residual
 * `phpunitResultUnreadable` closes for the SMALL, banner-preserving
 * case).
 * `phpunit-exit-mid-suite.txt` itself is small enough that its banner
 * always survives truncation; there is no captured fixture for the
 * large, banner-truncated case (a synthetic one pins it instead, see
 * `test/verify.test.ts`), since reproducing it would need a suite large
 * enough to overrun the tail bound before its second test's `exit()`
 * call. A suite large enough to complete its first full progress ROW
 * before the kill has a second, unrelated consequence, independent of
 * truncation: the row's own `N / M (P%)` counter is then in the output,
 * so `phpunitResultUnreadable` no longer recognizes the shape and the
 * reading falls silent (`"not_zero"`) instead of reporting the result
 * as unreadable. Both limits are documented in docs/non-js-test-runners.md.
 *
 * The major version is captured HERE, by this one pattern, and read off
 * it by `phpunitMajorVersion` below -- never by a second, separately
 * maintained copy of the same text. The two must widen together (the
 * prerelease tail is exactly the kind of change that has to land in
 * every copy at once), and a version read that disagrees with the shape
 * check is precisely how a banner-present run ends up read as
 * banner-less. The prerelease tail (`(?:-[\w.]+)?`) covers PHPUnit's own
 * pre-stable banners -- `PHPUnit 11.0.0-RC1`, `PHPUnit 12.0.0-alpha.1`,
 * a `-dev` build -- so such a run is read at its real major rather than
 * falling through to the no-banner reading (see
 * `TALLY_CATEGORIES`/`phpunitZeroTestsVerdict` for what that reading
 * costs). Requires at least one dot after the major (`11.5.56`,
 * `11.0.0-RC1`): every PHPUnit release banner measured here prints a
 * full `major.minor.patch`.
 */
const PHPUNIT_BANNER =
  /^PHPUnit (\d+)\.[\d.]+(?:-[\w.]+)? by Sebastian Bergmann and contributors\.\s*$/m;

/**
 * PHPUnit's own post-run timing line, printed once the suite itself has
 * FINISHED and immediately above the result report (measured: `Time:
 * 00:00.007, Memory: 8.00 MB` under PHPUnit 11.5.56 and `Time:
 * 00:00.005, Memory: 4.00 MB` under 9.6.36, the same shape in both, and
 * in both majors this line PRECEDES the `OK (`/`FAILURES!` line rather
 * than following it; see `test/fixtures/README.md` for the commands).
 * Its presence is positive evidence that PHPUnit reached the end of its
 * run: a run whose result REPORT is merely suppressed
 * (`--no-results`, PHPUnit 10 and up) still prints it, so it is what
 * separates such a completed run from one killed mid-suite (see
 * `phpunitResultUnreadable`).
 *
 * Deliberately matched against PHPUnit's own real line, not against
 * this suite's older captures: every `phpunit-*` fixture from before
 * the `--no-results` captures elides this line's volatile digits to
 * `Time: [elided]`, which this pattern does NOT match. That is harmless
 * rather than a calibration gap -- each of those captures also carries
 * an `OK (` line or a tally, so none of them ever reaches the one
 * reading this pattern is consulted in -- and the captures where the
 * line IS load-bearing keep it verbatim, exactly as PHPUnit printed it
 * (see `test/fixtures/README.md`).
 */
const TIME_MEMORY_LINE = /^Time: \S+, Memory: /m;
/**
 * The closed alphabet a PHPUnit progress marker is drawn from, ahead of
 * the `N / M (P%)` counter on a full row: `.` pass, `F` failure, `E`
 * error, `W` warning, `I` incomplete, `R` risky, `S` skipped, `D`
 * deprecation, `N` notice. Measured in this suite's captures: `.`, `F`
 * and `W` under PHPUnit 9.6.36 and 11.5.56, `E`, `I`, `R` and `S` under
 * 9.6.36, `D` and `N` under 11.5.56
 * (`phpunit-warnings-deprecations-notices-executed.txt`'s `WDN ... 3 / 3
 * (100%)` row).
 *
 * Closed on purpose. An open letter class also accepts a line made of
 * one ordinary word and the counter (`Aborted 5 / 9 ( 55%)`), which
 * would count as completion evidence PHPUnit never gave. A word made
 * only of marker letters (`FEW 3 / 3 (100%)`) still matches: by shape
 * and alphabet it is a real row, so this is not proof of origin. A
 * marker this alphabet does not know makes its row unrecognized, so the
 * run reads as
 * not completed (for `probe`, a refusal), the safe direction; and the
 * alphabet cannot go stale silently, because `test/verify.test.ts`'s
 * directory-derived positive control fails as soon as a capture with an
 * unknown marker is added.
 */
const PROGRESS_MARKER_CLASS = ".FEWIRSDN";
/**
 * PHPUnit's own progress counter,
 * `^[<marker class>]*[ \t]*(N) \/ (M) \([ \t]*P%\)[ \t]*$`: the `N / M
 * (P%)` tail it prints at the right edge of every FULL progress row
 * (measured identical under 9.6.36 and 11.5.56: `..` padded out to `2 /
 * 2 (100%)`, and padded inside the parentheses to `( 33%)` for a
 * one-digit percentage, hence the padding there). Its presence means
 * PHPUnit itself stated how many of its tests it had reached by then,
 * which a run that died before finishing its first progress row never
 * does -- the other half of the completion evidence
 * `phpunitResultUnreadable` requires to be ABSENT before it reports a
 * run's result as unreadable, and (via `progressCounterAttempted` below)
 * the source of `Summary.attempted` for a suppressed-report run whose
 * real tally cannot be read at all.
 *
 * Anchored to the WHOLE line, from its very start (`^[<marker
 * class>]*[ \t]*`, not merely `\b` ahead of the digits): a genuine
 * progress row is nothing BUT zero or more `PROGRESS_MARKER_CLASS`
 * characters, then horizontal padding, then the counter, so requiring
 * the line to start that way is what tells a real row apart from a line
 * that merely ENDS in the same shape (a failure message or a PHP
 * fatal-error line reporting some unrelated `N / M (P%)`-shaped
 * fraction, which the earlier `\b`-only anchor could not tell apart
 * from PHPUnit's own row and read as completion evidence it never was
 * -- a documented limit before that change, closed and pinned: see
 * `test/verify.test.ts`'s "unreadable-result tightening mutants" describe
 * block). The progress characters themselves are read but not required
 * to be a SPECIFIC one (`..`, `.F`, `WDN`, any mix of the
 * `PROGRESS_MARKER_CLASS` alphabet): a suppressed-report run prints exactly the
 * same counter whether its tests passed or failed (captured real:
 * `phpunit-no-results-green.txt`'s `..` and
 * `phpunit-no-results-red.txt`'s `.F`, the same `2 / 2 (100%)` tail on
 * both), which is also why the counter is read as evidence of
 * COMPLETION only and never turned into a `passed` count: it counts
 * tests PHPUnit reached, not tests that passed, so deriving `passed: 2`
 * from it would read the red capture as green (see `Summary.attempted`,
 * which names it "attempted" for exactly this reason).
 *
 * The padding is horizontal only (`[ \t]*`, never `\s`), on both sides
 * of the counter (ahead of the digits and inside/after the percentage):
 * `\s` also matches a newline, which under this pattern's `m` flag let a
 * marker-only line bleed across its own line break into the counter
 * line below it and still read as one combined row -- pinned by
 * `test/verify.test.ts`'s dedicated padding case, which checks the
 * actual matched text stays confined to the counter's own line rather
 * than merely that `.test()` returns `true` (a bare boolean check cannot
 * tell a same-line match from a two-line one here, since the counter
 * line alone, with zero leading marker characters, is already a valid
 * match on its own).
 *
 * Built from one shared source string (`PROGRESS_COUNTER_LINE_SOURCE`)
 * rather than two independently-typed-out patterns, so the boolean
 * completion check below and the count extraction in
 * `progressCounterAttempted` can never drift onto two different shapes:
 * the non-global `m`-flag form is used for `.test()` (a single boolean
 * question), the global form for `matchAll` (every row in a long
 * output, so the LAST one -- the state nearest completion -- can be
 * read rather than the first).
 */
const PROGRESS_COUNTER_LINE_SOURCE = `^[${PROGRESS_MARKER_CLASS}]*[ \\t]*(\\d+) \\/ (\\d+) \\([ \\t]*\\d+%\\)[ \\t]*$`;
/**
 * Exported for `test/verify.test.ts`'s directory-derived positive
 * control alone (every real `N / M (P%)`-shaped line across every
 * captured phpunit fixture must match this, sans allowlist): every
 * production caller in this file uses the same object via the internal
 * name below, never a second, independently constructed copy.
 */
export const PROGRESS_COUNTER_LINE = new RegExp(
  PROGRESS_COUNTER_LINE_SOURCE,
  "m",
);
const PROGRESS_COUNTER_LINE_GLOBAL = new RegExp(
  PROGRESS_COUNTER_LINE_SOURCE,
  "gm",
);

/**
 * The attempted-test count PHPUnit's own progress counter last reported,
 * or `undefined` when no such row is in `output` at all. Takes the LAST
 * matching row (`matchAll`, not the first `exec`): a long suite prints
 * this counter once per full row as it goes, so the last one is the
 * count nearest the run's own end, never an earlier, incomplete one.
 * Read only as "tests PHPUnit reached", never as "tests that passed"
 * (see `PROGRESS_COUNTER_LINE`'s own docblock and `Summary.attempted`):
 * callers never fold this into `passed`.
 */
function progressCounterAttempted(output: string): number | undefined {
  let attempted: number | undefined;
  for (const match of output.matchAll(PROGRESS_COUNTER_LINE_GLOBAL)) {
    attempted = Number(match[1]);
  }
  return attempted;
}

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
 * the error and failure sections, plus PHPUnit 11's own `PHPUnit error`
 * kind (`There was 1 PHPUnit error:`, printed for a suite-level failure
 * such as an invalid data provider, distinct from an ordinary `error`
 * section on a test that ran and threw). A risky, warning, incomplete or
 * skipped entry names a real `Class::method` too (captured real: `1)
 * RiskyRealTest::testNoAssertions` in `phpunit-risky-and-real.txt`, and
 * the two risky entries of `phpunit-two-failures-and-risky.txt`), so the
 * entry header's own grammar cannot tell them apart -- the section
 * header above them can, and it is the only thing that can. Those
 * entries are dropped rather than reported: `DetectorParseResult` has no
 * `notes` field to put them in, and `summary.skipped`/`summary.warnings`
 * already carry their counts, so dropping them keeps the result contract
 * unchanged.
 *
 * `PHPUnit error` is collected as a `failures` entry rather than dropped
 * because PHPUnit's own tally line counts it under `Errors:`, not under
 * any not-executed category (captured real:
 * `phpunit-error-data-provider.txt`'s `Tests: 1, Assertions: 1, Errors:
 * 1, PHPUnit Deprecations: 1.`, an `ERRORS!` run from a `@dataProvider`
 * that throws): the entry loop already reports every ordinary `error`
 * section entry as a `failures` item and counts it in `summary.errors`
 * via `TALLY_CATEGORIES`, so treating `PHPUnit error` the same way keeps
 * `summary.failed + summary.errors >= failures.length` (the invariant
 * documented on `phpunitDetector` below) rather than quietly breaking it
 * for this one PHPUnit-11-only section kind. (PHPUnit's own stated
 * `Tests: 1` in that same capture refers only to the one test that
 * genuinely ran and passed, `DataProviderThrowsTest::testOk` -- the
 * failed-provider test was never counted as an attempted test at all,
 * only as an error -- so `deriveCounts`'s budget arithmetic, which has
 * no way to tell that apart from an ordinary self-contradictory tally,
 * ends up reporting `passed: 0` for this capture even though a real test
 * did pass; that pre-existing imperfection is unrelated to whether this
 * section kind is collected, and is not something this change
 * introduces or fixes.)
 */
const COLLECTED_SECTION_KINDS = new Set(["error", "failure", "PHPUnit error"]);

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
 * Matched against the entry loop's RAW (untrimmed) line, never a
 * trimmed one: a diff message's indented context/added/removed rows
 * (`sebastian/diff`'s output prefixes every row with a space, `-` or
 * `+`, so a row whose own content happens to look like `word:digits`,
 * e.g. an indented ` port:12`, is still indented in the raw line) must
 * never be mistaken for the locator, which PHPUnit itself never
 * indents. Requiring the match to start on a non-whitespace character
 * (`\S`, not `.`) is what excludes an indented row; without it the
 * regex would still match an indented line's leading space as part of
 * its `(.+)` capture (captured real:
 * `phpunit-diff-indented-locator.txt`'s diff carries a blank context
 * row rendered as a single space -- not a zero-length line -- directly
 * above an indented ` port:12` context row that is structurally
 * identical to a locator once trimmed). Captured structurally (`\S.*`
 * up to the last `:` followed by only digits to end of line), not
 * `\S+`, so a path containing a colon is still handled the same way any
 * other detector here treats a locator line; the blank-line
 * precondition is what the entry loop below actually enforces (captured
 * real: `phpunit-error-message-with-port.txt`'s first message line,
 * "RuntimeException: upstream unreachable at api.example.com:8080",
 * ends in `:8080` and is not preceded by a blank line, so it is never
 * mistaken for the locator that follows it). Note that this anchor does
 * NOT exclude a diff's `-`/`+`-prefixed removed/added rows on its own
 * (`-` and `+` are themselves non-whitespace, so `\S` matches them);
 * those rows stay unreachable only because PHPUnit's diff renderer
 * never directly precedes one with a zero-length line, which is what
 * the entry loop's blank-line precondition actually enforces. An
 * uncaught exception can also print more than one such line back to
 * back, with no blank line between them (captured real:
 * `phpunit-nested-throw-frames.txt`'s `src/Thrower.php:5` /
 * `src/Thrower.php:10` / `tests/NestedThrowTest.php:11`, three frames
 * from an innermost throw site out through its callers to the test
 * method, trimmed of the capture mount point the same way every other
 * path in this file's fixtures is): the entry loop below reports only
 * the FIRST such line as `file`/`line` (the frame closest to the fault,
 * matching every single-frame capture's own convention: the
 * throw/assertion site, not the outermost test-method caller) and
 * consumes every immediately-following `file:line` line after it
 * (consecutive with it -- no blank line, no other text, in between)
 * without adding any of them to `message`, rather than folding the
 * extra frames into the message text; a LATER locator-shaped line that
 * is not consecutive with the captured frame (captured real:
 * `phpunit-chained-exception.txt`'s `Caused by` block) is folded into
 * `message` like any other text instead of being consumed. */
const ENTRY_FILE_LINE = /^(\S.*):(\d+)$/;
/** A PHP-level deprecation notice PHPUnit lets through to its own
 * output (e.g. a dynamic-property-creation notice on PHP 8.2+, captured
 * on a green run alongside its `OK (...)` line): reported as a free-text
 * detector warning rather than folded into `failures`, since the run
 * itself still passed.
 */
const DEPRECATION_LINE = /^Deprecated: (.+)$/gm;

/**
 * PHPUnit's tally categories, and the one attribute the whole derivation
 * below turns on: did a test counted here actually RUN its body? This
 * table is PHPUnit 9's own reading; it changes in exactly one row under
 * PHPUnit 10/11 (see the `Warnings` row below and `tallyCategoriesFor`
 * further down).
 *
 * | Category   | executed   | Lands in                                  |
 * | ---------- | ---------- | ----------------------------------------- |
 * | Failures   | yes        | `summary.failed`                          |
 * | Errors     | yes        | `summary.errors`                          |
 * | Risky      | yes        | `summary.passed` (ran; no defect counted) |
 * | Skipped    | no         | `summary.skipped`                         |
 * | Incomplete | no         | `summary.skipped`                         |
 * | Warnings   | no (<=9)   | `summary.warnings` (<=9)                  |
 * |            | yes (10+)  | `summary.passed` (10+)                    |
 *
 * Risky is executed: a risky test ran, PHPUnit merely flagged it (it
 * performed no assertions, say), so it may not be read as "nothing
 * happened". Under PHPUnit 9, a plain `Warnings: N` token is NOT
 * executed: PHPUnit counts a synthetic `WarningTestCase` in its total
 * (`No tests found in class "X".` is one whole `Tests: 1` on its own),
 * so treating a warning as executed reads a run in which nothing at all
 * ran as a green `passed: 1`. Erring toward "inconclusive" is the
 * fail-safe direction for both the summary and `probe`'s zero-tests
 * guard; erring toward "green" would misread a warnings-only run
 * (captured real: `phpunit-warnings.txt`, PHPUnit 9.6.36) as passing.
 *
 * PHPUnit 10 and 11 repurposed the same plain `Warnings: N` token: it now
 * counts N tests that DID run and raised a PHP-level warning (e.g.
 * `E_USER_WARNING`) during their own execution, not a synthetic
 * per-class warning (captured real: a PHPUnit 11.5.56 run against a
 * single test that triggers `E_USER_WARNING`, `Tests: 1, Assertions: 1,
 * Warnings: 1.`, exit `0`; see `test/fixtures/README.md`). Reading that
 * as not-executed under 10/11 would misderive `passed: 0` from a run
 * that genuinely ran and passed its one test -- the exact false reading
 * `phpunitZeroTestsVerdict` exists to avoid, now flipped the other way.
 * `tallyCategoriesFor` below reads PHPUnit's own major version out of
 * its banner (`phpunitMajorVersion`) and, for major 10 and up, treats
 * `Warnings` the same way `Risky` already is: `executed: true`,
 * `reportsAs: "passed"` (ran, no defect subtracted from the executed
 * budget). Major 9 and below, and any output whose banner is not present
 * at all (front-truncated by `exec.ts`'s tail-keeping truncation -- see
 * `PHPUNIT_BANNER`'s own docblock -- so there is no version to read),
 * keep the PHPUnit 9 reading above as the fail-safe default: this
 * package was originally captured against PHPUnit 9.6.36, and every
 * PHPUnit 9 fixture's derived summary stays byte-identical either way.
 *
 * That default is a fail-safe for the SUMMARY, where a number has to be
 * printed either way, and it is deliberately NOT treated as a verdict
 * about whether anything ran: a banner-less output whose zero-tests
 * reading turns on this very row reads `"ambiguous"`, not `"zero"` (see
 * `phpunitZeroTestsVerdict`), so a truncated green PHPUnit 11 run is
 * never ASSERTED to have executed nothing merely because its banner did
 * not survive truncation. A nonzero count in such a row is also named in
 * a detector warning by `parse` below whenever this output's own version
 * reads it as executed, since the version-aware reading folds it into
 * `passed` and leaves `summary.warnings` at `0`.
 *
 * PHPUnit 11's `Deprecations` and `Notices` tokens (plain, PHP-level) and
 * their two-word `PHPUnit Deprecations`/`PHPUnit Warnings`/`PHPUnit
 * Notices` counterparts (meta -- about the TEST SUITE's own use of a
 * deprecated PHPUnit feature, such as the old doc-comment `@dataProvider`
 * annotation, not about the code under test) are a separate case,
 * deliberately NOT a `TallyCategory` at all: they are parsed by
 * `NAMED_COUNT` (so a two-word one no longer breaks the whole
 * `TALLY_LINE` match, see that constant's own docblock) but never
 * assigned into any `RawTally` field -- `parseTally`'s switch below has
 * no case for any of them and they fall straight through unspent, on
 * every PHPUnit version, with no version check needed. That is the
 * correct reading, not an oversight: like the 10+ `Warnings` reading
 * above, a deprecation/notice (plain or two-word) is raised INSIDE a
 * test that genuinely ran (captured real:
 * `phpunit-two-word-deprecation-tally.txt`'s `Tests: 2, Assertions: 2,
 * PHPUnit Deprecations: 1.`, a clean `OK, but there were issues!` run
 * where BOTH tests actually executed and passed). Marking it
 * `executed: false` and taking it out of the budget the way
 * `Skipped`/`Incomplete`/PHPUnit-9 `Warnings` are would silently turn
 * that `passed: 2` into `passed: 1` -- a real, passing test misread as
 * not executed. Leaving the token unspent keeps the full stated total
 * flowing to `passed` instead, which is the correct reading here (the
 * fixture's own two tests genuinely both ran and passed).
 * `phpunit-error-data-provider.txt`'s own `PHPUnit Deprecations: 1`
 * (alongside a real `Errors: 1`, from an invalid `@dataProvider`) is
 * spent the same way: unhandled, so it does not additionally distort
 * the already-imperfect budget PHPUnit's own stated `Tests: 1` vs
 * `Errors: 1` split leaves behind (see `COLLECTED_SECTION_KINDS`'s own
 * docblock for that capture's `PHPUnit error` section).
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
  /** This category's field in `NamedTallyCounts`/`RawTally` -- this
   * package's own lowercase field name, which is also the key
   * `parseTally` assigns into after lowercasing PHPUnit's token. */
  readonly name: keyof NamedTallyCounts;
  /** PHPUnit's OWN token for this category, capitalized exactly as it
   * prints it in its tally line (`Warnings: 1`, not `warnings: 1`).
   * What a detector warning quotes, so a reader can search the tool's
   * real output for the text the warning names; never a second matcher
   * (`NAMED_COUNT` keeps matching the printed token and `parseTally`
   * lowercases it to reach `name` above). */
  readonly token: string;
  /** Whether a test counted here actually RAN its body. */
  readonly executed: boolean;
  /** Which `Summary` field this category is reported in. A category
   * reporting as `passed` is never deducted from the executed budget; it
   * IS the remainder (see `deriveCounts`). */
  readonly reportsAs: "passed" | "failed" | "errors" | "skipped" | "warnings";
}

const TALLY_CATEGORIES: readonly TallyCategory[] = [
  { name: "failures", token: "Failures", executed: true, reportsAs: "failed" },
  { name: "errors", token: "Errors", executed: true, reportsAs: "errors" },
  { name: "risky", token: "Risky", executed: true, reportsAs: "passed" },
  { name: "skipped", token: "Skipped", executed: false, reportsAs: "skipped" },
  {
    name: "incomplete",
    token: "Incomplete",
    executed: false,
    reportsAs: "skipped",
  },
  {
    name: "warnings",
    token: "Warnings",
    executed: false,
    reportsAs: "warnings",
  },
];

/**
 * The major version PHPUnit states in its own banner (see
 * `PHPUNIT_BANNER` for the pattern itself, the captured major, and the
 * front-truncation limit that applies here too): `11` for `PHPUnit
 * 11.5.56 by Sebastian Bergmann and contributors.`, `11` for a `PHPUnit
 * 11.0.0-RC1` prerelease banner too, `undefined` when the banner is not
 * present in `output` at all.
 */
function phpunitMajorVersion(output: string): number | undefined {
  const match = PHPUNIT_BANNER.exec(output);
  return match ? Number(match[1]) : undefined;
}

/**
 * Every row of `TALLY_CATEGORIES` that PHPUnit 10 and up read
 * differently, as a table rather than as an `if` in
 * `tallyCategoriesFor` below: a plain `Warnings: N` token counts tests
 * that DID run there, so it is folded into `passed` the same way `Risky`
 * already is (see `TALLY_CATEGORIES`'s own docblock for the measurement
 * behind that). A future category whose reading also turns on the major
 * version joins by adding a row HERE: both the version-aware reading and
 * the ambiguity set below (`VERSION_DEPENDENT_CATEGORIES`) are
 * derived from this table, so neither has to be widened by hand.
 */
const MAJOR_10_CATEGORY_OVERRIDES: readonly TallyCategory[] = [
  { name: "warnings", token: "Warnings", executed: true, reportsAs: "passed" },
];

/** `TALLY_CATEGORIES` with every `MAJOR_10_CATEGORY_OVERRIDES` row
 * applied in place, order preserved: the reading a PHPUnit 10-or-later
 * output gets, built once here rather than rebuilt per call. */
const MAJOR_10_TALLY_CATEGORIES: readonly TallyCategory[] =
  TALLY_CATEGORIES.map(
    (category) =>
      MAJOR_10_CATEGORY_OVERRIDES.find(
        (override) => override.name === category.name,
      ) ?? category,
  );

/**
 * `TALLY_CATEGORIES` above, adjusted for every row that changes by
 * PHPUnit major version (`MAJOR_10_CATEGORY_OVERRIDES`): major 10 and up
 * take the override row, major 9 and below -- and a `majorVersion` of
 * `undefined` (no banner in the output at all) -- keep
 * `TALLY_CATEGORIES` unchanged, as the fail-safe default. A reading
 * taken under that default when the banner is merely MISSING (rather
 * than known to be a 9) is not a verdict on its own: see
 * `phpunitZeroTestsVerdict`, which reports such a reading as
 * `ambiguous` instead of asserting it.
 */
function tallyCategoriesFor(
  majorVersion: number | undefined,
): readonly TallyCategory[] {
  if (majorVersion === undefined || majorVersion < 10) return TALLY_CATEGORIES;
  return MAJOR_10_TALLY_CATEGORIES;
}

/**
 * The tally categories whose reading actually DIFFERS between the two
 * tables, derived from the tables themselves rather than listed again by
 * hand (add a version-dependent row to `MAJOR_10_CATEGORY_OVERRIDES` and
 * it joins here on its own): a nonzero count in one of these is what
 * makes a banner-less output's zero-tests reading depend on a version
 * that is not there to be read (see `phpunitZeroTestsVerdict`).
 *
 * Holds the BASE (PHPUnit 9) rows, so each carries both the fallback
 * reading a caller compares against and PHPUnit's own printed `token`
 * for the count it names in a warning.
 */
const VERSION_DEPENDENT_CATEGORIES: readonly TallyCategory[] =
  TALLY_CATEGORIES.filter((base, index) => {
    const under10Plus = MAJOR_10_TALLY_CATEGORIES[index];
    return (
      base.executed !== under10Plus.executed ||
      base.reportsAs !== under10Plus.reportsAs
    );
  });

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
  // `Deprecations`, `Notices`, and their two-word `PHPUnit `-prefixed
  // counterparts intentionally have no branch here (see
  // `TALLY_CATEGORIES`'s own docblock): a token matched by `NAMED_COUNT`
  // whose lowercased name is none of the six below is read and then
  // dropped, never spent out of the budget.
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
 * not-executed categories are taken out of it first (`tallyCategoriesFor`
 * decides which those are, version-aware -- see `TALLY_CATEGORIES`'s own
 * docblock), what remains is `executed`, the two defect categories are
 * taken out of that, and whatever is still left is `passed` (which is
 * where Risky, and a PHPUnit 10+ Warnings token, land, since nothing
 * takes either out).
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
  return deriveCountsWith(
    output,
    tallyCategoriesFor(phpunitMajorVersion(output)),
  );
}

/**
 * `deriveCounts` above with the category table passed in rather than
 * read off the output's own banner: the arithmetic is identical, only
 * the table differs. Lets `phpunitZeroTestsVerdict` run the SAME
 * derivation under both readings of a banner-less output (PHPUnit 9's
 * and PHPUnit 10+'s) and compare them, instead of a second,
 * near-identical copy of the spending loop existing just for that.
 */
function deriveCountsWith(
  output: string,
  categories: readonly TallyCategory[],
): DerivedCounts | undefined {
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
  for (const category of categories) {
    if (category.executed) continue;
    reported[category.reportsAs] += take(tally[category.name]);
  }
  const executed = remaining;
  // Then the executed categories that report a defect. A category
  // reporting as `passed` (Risky, and a PHPUnit 10+ Warnings) is
  // deliberately not taken out: it is part of the remainder below, which
  // is what makes such a test count as executed and as non-failing at
  // once.
  for (const category of categories) {
    if (!category.executed || category.reportsAs === "passed") continue;
    reported[category.reportsAs] += take(tally[category.name]);
  }
  reported.passed += remaining;
  return { total, executed, ...reported };
}

/**
 * Output that is PHPUnit's own (its version banner is present, see
 * `PHPUNIT_BANNER`) and from which NOTHING can be read about whether
 * any test ran, because every shape PHPUnit uses to say so is absent:
 * no `OK (`, no `FAILURES!`/`ERRORS!`/`WARNINGS!` marker (hence no
 * `Tests: N, Assertions: M` tally either, since one always accompanies
 * the other here), no `No tests executed!`, no `N / M (P%)` progress
 * counter (`PROGRESS_COUNTER_LINE`), and no post-run `Time: <t>,
 * Memory: <m>` line (`TIME_MEMORY_LINE`).
 *
 * The name states the READING, and the reading is an absence, not a
 * count: this function's verdict in `phpunitZeroTestsVerdict` below is
 * `"ambiguous"`, never `"zero"`. Answering an absence in the
 * zero-tests vocabulary is a false claim, and the flagship capture
 * proves it: `phpunit-exit-mid-suite.txt` (a three-test class whose
 * SECOND test calls `exit(0)`, terminating the PHP process mid-run,
 * exit `0`) carries ONE progress dot, i.e. one test that genuinely ran
 * and passed before the kill, so "executed nothing" is false for the
 * very shape this function was introduced for. What is true of it is
 * only that PHPUnit never got to report anything.
 *
 * The last two conjuncts are what keep a COMPLETED run out of this
 * reading, measured on both majors (see `test/fixtures/README.md` for
 * every command, version and exit code):
 *
 *   - `--no-results` (PHPUnit 10 and up; 9.6.36 rejects the flag with
 *     `Unknown option "--no-results"`, exit `1`) suppresses the result
 *     report but not the run: captured real, a green two-test suite
 *     prints banner, `Runtime:`, `..  2 / 2 (100%)` and `Time:
 *     00:00.007, Memory: 8.00 MB`, then stops, exit `0`
 *     (`phpunit-no-results-green.txt`). Both tests ran and passed.
 *     Without these two conjuncts that capture matches every other
 *     check above and is read as a killed run, which is the false
 *     claim this arm shipped with before (`verify` warning
 *     `no_tests_executed` on a green run, `probe` refusing every
 *     baseline of such a project).
 *   - The same flag on a RED suite prints the identical counter and
 *     `Time:` shape with `.F` progress characters, exit `1`
 *     (`phpunit-no-results-red.txt`): the counter counts tests
 *     PHPUnit reached, never tests that passed, which is why neither
 *     conjunct is ever turned into a count here.
 *
 * What remains in the reading is output where PHPUnit printed its
 * banner and then effectively nothing: a mid-suite `exit()`/`die()`
 * (captured real on both majors -- `phpunit-exit-mid-suite.txt` under
 * 11.5.56, banner, `Runtime:` and one dot; `phpunit-exit-mid-suite-9.txt`
 * under 9.6.36, banner and one dot -- so this arm is not version-
 * specific), a suppressed-report run whose `--filter` matched nothing
 * (`phpunit-no-results-filter-miss.txt`, banner and `Runtime:` alone,
 * exit `0`), and a `--list-tests` listing (`phpunit-list-tests.txt`,
 * banner plus `Available tests:` and the test names; 9.6.36 prints
 * `Available test(s):` for the same flag). The last one is over-caution
 * and documented as such: a listing never claimed to run anything, and
 * reporting it as unreadable is the fail-safe direction rather than a
 * correct description. `die()` is PHP-equivalent to `exit()` and
 * produces the identical shape; ANY other cause that kills the PHP
 * process before PHPUnit finishes reporting (a fatal signal, a `pcntl`
 * call, a C extension segfault) looks the same from the outside and is
 * covered the same way, not because this function was written to be
 * general, but because it has no way to tell those apart from
 * `exit()`/`die()` and does not try to.
 *
 * All FOUR marker checks (`FAILURES!`/`ERRORS!`/`WARNINGS!` explicitly,
 * plus `TALLY_LINE`) are listed independently here, not folded into "no
 * tally", because a marker without an accompanying tally is not
 * something a real PHPUnit run ever prints (see `PHPUNIT_BANNER`'s own
 * note on front-truncation) but IS something a synthetic test fixture
 * can construct on purpose (`test/cli.test.ts`'s fake phpunit-style
 * `RUNNER_JS`, whose mutant variant prints a `FAILURES!`-shaped line
 * with no tally at all): such a fixture's own marker is still a real,
 * deliberate completion signal, not a sign PHPUnit itself was cut off,
 * so it must not be misread as this function's own shape. All four
 * conjuncts are pinned by the suite (`test/verify.test.ts`'s isolated
 * ERRORS!-alone, WARNINGS!-alone and TALLY_LINE-alone synthetic cases
 * join the pre-existing FAILURES! fixture): each fixture carries exactly
 * one of the four shapes and none of the others, no completion evidence
 * either, so replacing that one conjunct with `true` is the only way to
 * misread it as unreadable, and the corresponding test catches it.
 */
function phpunitResultUnreadable(output: string): boolean {
  return (
    PHPUNIT_BANNER.test(output) &&
    !OK_LINE.test(output) &&
    !FAILURES_MARKER.test(output) &&
    !ERRORS_MARKER.test(output) &&
    !WARNINGS_MARKER.test(output) &&
    !TALLY_LINE.test(output) &&
    !NO_TESTS_EXECUTED.test(output) &&
    // Neither piece of positive completion evidence, as ONE operand:
    // either one on its own is enough to say PHPUnit got to the end of
    // its run, so the reading needs both to be absent (see the two
    // constants' own docblocks, and the suppressed-report captures).
    !(TIME_MEMORY_LINE.test(output) || PROGRESS_COUNTER_LINE.test(output))
  );
}

/** What `output` says about whether PHPUnit executed any test at all:
 * `"zero"` (it executed nothing), `"not_zero"` (nothing here says it
 * executed nothing), or `"ambiguous"` (the zero-tests reading cannot be
 * established from this output at all). `"ambiguous"` covers more than
 * one cause, and deliberately does not distinguish them in the type: a
 * tally whose reading turns on a PHPUnit major version the output does
 * not state is one instance, an output with no result report in it at
 * all (`phpunitResultUnreadable`) is another. A caller must never
 * collapse `"ambiguous"` into either of the other two: `"zero"` there is
 * a false claim, `"not_zero"` a false green. */
export type PhpunitZeroTestsVerdict = "zero" | "not_zero" | "ambiguous";

export interface PhpunitZeroTestsReading {
  verdict: PhpunitZeroTestsVerdict;
  /** One clause naming why this reading came out the way it did,
   * suitable for a caller's own warning text (`verify` puts it straight
   * into its `zero_tests_ambiguous:` warning). Always populated, for
   * every verdict. */
  reason: string;
}

/**
 * What `output` shows about whether PHPUnit executed any test, as a
 * THREE-valued reading rather than a boolean, because one of the tally
 * categories is read differently by different PHPUnit majors and the
 * version is not always in the output to read.
 *
 * `"zero"` -- nothing executed, on an unambiguous reading: the explicit
 * `No tests executed!` line; or a derived `executed` count (the stated
 * total less every not-executed category, per `tallyCategoriesFor`) of
 * zero where that derivation does not depend on an absent version.
 * Those two are the ONLY origins of this verdict: a verdict that
 * nothing ran is a claim about the run, so it is only ever taken from
 * something PHPUnit itself stated, never from an absence in its output
 * (see `phpunitResultUnreadable`, whose arm reports `"ambiguous"`).
 * That covers a stated
 * `OK (0 tests, 0 assertions)` (defensive -- not observed from a real
 * capture; PHPUnit 9.6.36 prints `No tests executed!` for an empty suite
 * instead), an all-skipped/all-incomplete run, and a PHPUnit 9
 * warnings-only run (`Tests: 1, Assertions: 0, Warnings: 1.`, exit `0`,
 * captured real: `phpunit-warnings.txt`, PHPUnit 9.6.36, whose own
 * banner states the 9 -- a shape that reads as a green `passed: 1` under
 * any derivation that counts a synthetic PHPUnit warning as an executed
 * test). It deliberately does NOT cover a risky run: `Tests: 1,
 * Assertions: 0, Risky: 1.` ran its test. Under PHPUnit 10/11 the same
 * plain `Warnings: N` token is executed (see `TALLY_CATEGORIES`), so a
 * comparable PHPUnit 11 capture reads `"not_zero"`.
 *
 * `"ambiguous"` -- the reading cannot be established from this output,
 * for either of two reasons.
 *
 * The first: PHPUnit's own result report is absent altogether
 * (`phpunitResultUnreadable` -- banner present, but no summary line, no
 * progress counter and no post-run `Time:` line), the shape a mid-suite
 * `exit()`/`die()` leaves behind. Nothing in such an output says how
 * many tests ran, and the captured `exit()` fixture itself shows one
 * test that DID run (one progress dot) before the kill, so `"zero"`
 * would be false there rather than merely unproven.
 *
 * The second: the output states no PHPUnit version
 * (`phpunitMajorVersion` is `undefined`, e.g. because `exec.ts`'s
 * tail-keeping truncation dropped the banner off the front of a long
 * run, see `PHPUNIT_BANNER`) AND its tally carries a nonzero count in a
 * category whose reading turns on that missing version
 * (`VERSION_DEPENDENT_CATEGORIES`) in a way that changes THIS
 * verdict: the two candidate readings are run side by side (the same
 * derivation, two tables, via `deriveCountsWith`) and disagree about
 * whether anything executed. A long green PHPUnit 11 run ending in
 * `Tests: 15, Assertions: 15, Warnings: 15.` whose banner fell out of
 * the kept tail is exactly this shape: read as a 9 it executed nothing,
 * read as a 10+ it ran and passed all 15, and the output itself does not
 * say which. Where the two readings AGREE (a nonzero `Warnings` count
 * alongside other, version-independent executed tests, say) the verdict
 * is that agreed value, not `"ambiguous"`: the count is unreadable, but
 * the zero-tests question is not.
 *
 * `"not_zero"` -- everything else, including an output carrying no
 * summary shape at all. It is not a claim that tests DID run; it is the
 * absence of evidence that none did.
 *
 * Consumed by `verify` (which warns `no_tests_executed:` only on
 * `"zero"`, and `zero_tests_ambiguous:` on `"ambiguous"`, so it never
 * asserts a hollow pass it cannot actually read) and by
 * `probe/zero-tests.ts` (which refuses on anything but `"not_zero"`, the
 * fail-safe direction there -- see that module's own docblock). Both are
 * built on this one function rather than on
 * `passed`/`failed`/`errors`: a red run with both a real failure and a
 * real skip (`Tests: 3, Assertions: 2, Failures: 1, Skipped: 1.`,
 * captured real: `phpunit-skip-and-fail.txt`) parses those three fields
 * to 0 under a `passed === 0 && failed === 0 && errors === 0` check,
 * which misreads it as "nothing executed" even though the suite
 * genuinely caught something.
 */
export function phpunitZeroTestsVerdict(
  output: string,
): PhpunitZeroTestsReading {
  // Strip `--colors=always` SGR escapes first (see `stripAnsiSgr`'s own
  // docblock): every pattern this function consults below is anchored
  // and fails to match a colorized line otherwise. A no-op for
  // `--colors=never`/uncoloured output (nothing to strip), so this is
  // safe for every caller regardless of how the output was captured.
  output = stripAnsiSgr(output);
  if (NO_TESTS_EXECUTED.test(output)) {
    return {
      verdict: "zero",
      reason: "phpunit printed its own `No tests executed!` line",
    };
  }
  if (phpunitResultUnreadable(output)) {
    return {
      verdict: "ambiguous",
      reason:
        "phpunit printed its version banner but neither a result summary, nor a progress counter, nor its post-run `Time: <t>, Memory: <m>` line, so whether any of its tests ran cannot be read from this output at all (a mid-suite `exit()`/`die()` produces exactly this shape, and its own first test may well have run and passed before the kill)",
    };
  }
  const majorVersion = phpunitMajorVersion(output);
  const counts = deriveCountsWith(output, tallyCategoriesFor(majorVersion));
  if (counts === undefined) {
    return {
      verdict: "not_zero",
      reason: "this output carries no phpunit summary line to read at all",
    };
  }
  if (majorVersion === undefined) {
    const ambiguity = versionAmbiguity(output, counts);
    if (ambiguity !== undefined) return ambiguity;
  }
  return counts.executed === 0
    ? {
        verdict: "zero",
        reason:
          "phpunit's own tally line leaves zero executed tests once every not-executed category is taken out of its stated total",
      }
    : {
        verdict: "not_zero",
        reason: `phpunit's own tally line leaves ${counts.executed} executed test(s)`,
      };
}

/**
 * The `"ambiguous"` reading for a banner-less `output`, or `undefined`
 * when there is nothing ambiguous about it: the same derivation run
 * under the PHPUnit 10+ table (`fallback` is the one already run under
 * the fail-safe default table) disagrees about whether anything
 * executed, and the tally carries a nonzero count in at least one of the
 * categories the two tables read differently. Names those counts in the
 * reason, so a caller's warning says which number it cannot read rather
 * than only that something is unreadable.
 */
function versionAmbiguity(
  output: string,
  fallback: DerivedCounts,
): PhpunitZeroTestsReading | undefined {
  const tally = parseTally(output);
  if (tally === undefined) return undefined;
  const under10Plus = deriveCountsWith(output, MAJOR_10_TALLY_CATEGORIES);
  if (under10Plus === undefined) return undefined;
  if ((under10Plus.executed === 0) === (fallback.executed === 0)) {
    return undefined;
  }
  // Non-empty whenever the two readings disagree: the tables differ in
  // these rows and nowhere else, and a zero count spends nothing out of
  // the budget under either of them, so a disagreement requires a
  // nonzero count in at least one of these categories. Named by
  // PHPUnit's own printed token (`Warnings: 15`), not by this package's
  // lowercase field name, so the text quotes something a reader can
  // find in the tool's real output.
  const named = VERSION_DEPENDENT_CATEGORIES.filter(
    (category) => tally[category.name] > 0,
  )
    .map((category) => `\`${category.token}: ${tally[category.name]}\``)
    .join(", ");
  return {
    verdict: "ambiguous",
    reason: `this output states no PHPUnit version banner (dropped off the front of a truncated capture, or never printed), and its tally's ${named} count(s) are read differently per major version: PHPUnit 9 reads them as tests that never ran (leaving ${fallback.executed} executed), PHPUnit 10 and up as tests that did run (leaving ${under10Plus.executed}); the summary reported alongside this warning carries the PHPUnit 9 reading, the fail-safe default for an output with no version in it to read`,
  };
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
   * load-bearing shapes among the first six checks: every captured
   * fixture that carries a `FAILURES!`/`ERRORS!`/`WARNINGS!` marker also
   * carries `TALLY_LINE` on the very next line, so `TALLY_LINE` alone
   * already selects this detector for all of them (measured: replacing
   * any one of the three marker checks below with `false` still leaves
   * the whole suite green). They are kept anyway as redundant, cheap
   * shape signals, not because any of them is required by a captured
   * shape. The one marker check actually removed from here was the
   * all-skipped/incomplete/risky "still exit 0" marker (`OK, but
   * incomplete, skipped, or risky tests!`): unlike the three kept above,
   * a mutant removing IT survived too, so it was dropped rather than
   * kept as decoration (see `isMarkerLine`'s docblock for the same
   * marker's other, still-real, removal). `PHPUNIT_BANNER` IS load-
   * bearing, on its own: it is the only one of the seven checks here
   * that selects this detector for `phpunit-exit-mid-suite.txt` (an
   * `exit()` mid-suite run carries PHPUnit's own version banner and
   * nothing else this detector recognizes -- see
   * `phpunitResultUnreadable`),
   * and removing it drops that fixture to the `generic` fallback.
   */
  matches(input: DetectorInput): boolean {
    // Stripped once here (see `stripAnsiSgr`'s own docblock): every
    // check below is line-anchored and misses a `--colors=always` row
    // otherwise, a no-op for uncoloured output.
    const output = stripAnsiSgr(input.output);
    return (
      OK_LINE.test(output) ||
      FAILURES_MARKER.test(output) ||
      ERRORS_MARKER.test(output) ||
      WARNINGS_MARKER.test(output) ||
      TALLY_LINE.test(output) ||
      NO_TESTS_EXECUTED.test(output) ||
      PHPUNIT_BANNER.test(output)
    );
  },
  parse(input: DetectorInput): DetectorParseResult {
    // Stripped once here too, same reason as `matches` above: every
    // downstream helper (`deriveCounts`, the entry loop, the tally and
    // deprecation scans) reads this same local `output`.
    const output = stripAnsiSgr(input.output);
    const failures: DetectorParseResult["failures"] = [];
    // `No tests executed!` (and any other shape neither summary line
    // matched) leaves every count at 0: correct as-is, not a false
    // "nothing failed" claim -- same convention as the vitest detector's
    // "no test files" case.
    const derivedCounts = deriveCounts(output);
    const counts = derivedCounts ?? {
      total: 0,
      executed: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      warnings: 0,
    };
    // `Summary.attempted`: only when the real tally could not be
    // derived at all (a suppressed-report run, `--no-results`, or any
    // other output with no `OK (`/tally line of its own) AND a progress
    // counter is in the output to read one from. A run whose real tally
    // WAS derived never sets this -- the real counts already say
    // everything this field would, and setting it alongside them would
    // invite a reader to add it to `passed` instead of reading it as
    // "attempted, not passed" (see `Summary.attempted`'s own docblock).
    const attempted =
      derivedCounts === undefined
        ? progressCounterAttempted(output)
        : undefined;

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
      // is misread as the locator on its own first line. Tested against
      // the RAW line, never a trimmed one: a diff message's blank
      // context row is `sebastian/diff`'s own one-space-prefixed empty
      // content, never a zero-length line (captured real:
      // `phpunit-diff-indented-locator.txt`); that fixture's indented
      // `port:12` row is kept out of `file`/`line` by `ENTRY_FILE_LINE`'s
      // own `\S` anchor, while the raw-length test here is what the
      // `phpunit-raw-blank-check.txt` shape below relies on (see
      // test/fixtures/README.md for which fixture pins which half). Reset back to `false` on every
      // ordinary message line, not only on a consumed locator/frame
      // line (captured real: `phpunit-message-reset.txt`'s blank line
      // followed by two ordinary message lines, the second of which
      // ends `abc:99` -- structurally a locator -- but is not itself
      // preceded by a blank line, so without this reset the earlier
      // blank line's `precededByBlank` would still read `true` here and
      // misread `abc:99` as the locator, discarding the real one that
      // follows). This blank check is itself pinned independently of
      // `ENTRY_FILE_LINE`'s own `\S` anchor (captured real:
      // `phpunit-raw-blank-check.txt`'s message embeds a genuinely
      // one-space line -- not a zero-length one -- immediately followed
      // by an UNINDENTED `abc:99` line: the anchor alone would happily
      // match that unindented line, so only testing the raw line's
      // *length*, not its trimmed length, keeps `precededByBlank` false
      // there and stops `abc:99` from being misread as the locator).
      let precededByBlank = false;
      // Whether the previous non-terminator line was itself a consumed
      // `file`/`line` locator or frame: gates the extra-frame branch
      // below to lines that are truly CONSECUTIVE with the one already
      // captured (no blank line, no other text, in between), matching
      // the multi-frame capture's own shape (`phpunit-nested-throw-frames.txt`'s
      // three frames print back to back with nothing between them).
      // Without this narrower gate, ANY later locator-shaped line in the
      // entry body -- however far from the captured frame -- would be
      // silently dropped instead of folded into `message` (captured
      // real: `phpunit-chained-exception.txt`'s PHPUnit 9.6 `Caused by`
      // block, whose own `LogicException: inner:42` message line and
      // its own locator line sit well after the first exception's
      // frame, separated by a blank line and a `Caused by` line; a
      // broader "any later locator" rule would swallow that entire
      // block instead of keeping its text in `message`).
      let precededByFrame = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (isEntryBodyTerminator(line)) break;
        if (line.length === 0) {
          precededByBlank = true;
          precededByFrame = false;
          continue;
        }
        if (file === undefined && precededByBlank) {
          const fileLine = ENTRY_FILE_LINE.exec(line);
          if (fileLine) {
            file = fileLine[1];
            entryLine = Number(fileLine[2]);
            precededByBlank = false;
            precededByFrame = true;
            continue;
          }
        } else if (
          file !== undefined &&
          precededByFrame &&
          ENTRY_FILE_LINE.test(line)
        ) {
          // A stack-trace frame immediately (no blank line, no other
          // text) following the one already captured above: consumed
          // and dropped rather than folded into `message` (captured
          // real: `phpunit-nested-throw-frames.txt`'s second and third
          // `file:line` frames). `DetectorParseResult` has no field to
          // hold extra frames in, the same reasoning that already drops
          // a risky/warning/incomplete/skipped entry elsewhere in this
          // file. `precededByFrame` keeps this branch from also
          // consuming an UNRELATED later locator, such as a chained
          // exception's own `Caused by` locator (captured real:
          // `phpunit-chained-exception.txt`), which is preceded by a
          // blank line and other text, not by a consumed frame.
          precededByBlank = false;
          precededByFrame = true;
          continue;
        }
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          message = message.length > 0 ? `${message} ${trimmed}` : trimmed;
        }
        precededByBlank = false;
        precededByFrame = false;
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

    // A version-dependent tally category that THIS output's own stated
    // version reads as executed (today: a PHPUnit 10+ plain `Warnings:
    // N`, see `TALLY_CATEGORIES`) is folded into `passed`, which leaves
    // its own count nowhere in `summary` at all -- `summary.warnings`
    // stays `0` for a PHPUnit 11 run that raised N warnings. Said out
    // loud here instead, naming the count, so the signal moves rather
    // than vanishing. Driven off the same two tables the reading itself
    // is, so this carries no second copy of the version threshold and a
    // future version-dependent category is covered by adding its row.
    const parsedTally = parseTally(output);
    if (parsedTally !== undefined) {
      const majorVersion = phpunitMajorVersion(output);
      const categories = tallyCategoriesFor(majorVersion);
      for (const fallbackReading of VERSION_DEPENDENT_CATEGORIES) {
        const name = fallbackReading.name;
        const count = parsedTally[name];
        const reading = categories.find((category) => category.name === name);
        if (count <= 0 || reading === undefined) continue;
        if (!reading.executed) continue;
        if (reading.executed === fallbackReading.executed) continue;
        warnings.push(
          `phpunit_${name}: PHPUnit ${majorVersion} reads this run's \`${fallbackReading.token}: ${count}\` tally count as ${count} test(s) that ran, so it is reported in summary.passed rather than in summary.${fallbackReading.reportsAs}.`,
        );
      }
    }

    return {
      summary: {
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        errors: counts.errors,
        warnings: counts.warnings,
        ...(attempted !== undefined ? { attempted } : {}),
      },
      failures,
      warnings,
    };
  },
};
