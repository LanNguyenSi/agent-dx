# test fixtures

Three kinds of fixture live here, consumed by `verify.test.ts`,
`cli.test.ts` and `probe.test.ts`; none of them is picked up by this
package's own `npm test` (`vitest.config.ts` excludes
`test/fixtures/**`).

## `single-probe-result-master-a908951.json`

Four `probe()` results (an `inplace` kill, a `worktree` `-p` kill, a
survivor, a failing baseline), captured from the package as it stood at
master `a908951` -- before the mutant step was extracted so a `--plan`
run could reuse it -- with durations zeroed and the random parts of
temp/log paths replaced by tokens (`<REPO>`, `<LOGS>`, `exec-<id>.log`).
`probe.test.ts` reproduces the same four runs and compares against this
file, so any change to the single-mutant path shows up as a diff rather
than as an unnoticed drift. Regenerate it only when a single-probe
result is DELIBERATELY changed, and say so in the CHANGELOG.

## `captured/`

Raw stdout+stderr text, captured once from real tool runs against tiny
throwaway projects (not committed), then trimmed of the capture
directory's own absolute path and wall-clock timing so the fixture holds
only the output shape a detector parses. Tool versions used for the
capture:

- vitest 4.1.11
- typescript 5.9.3 (`tsc`)
- eslint 10.9.1 (stylish formatter, the CLI default; see the package
  README's `verify` section for the Node floor this requires to develop
  against)

`vitest-json-filter-match.txt` and `vitest-json-filter-miss.txt` are
normalized captures from `vitest 4.1.11 --run --reporter=json` against the
same 43-test file: a matching `-t` selected one test (`passed: 1`, `pending:
42`), while a missing filter selected none (`passed: 0`, `pending: 43`). The
volatile timestamps, per-test result list, suite counters, snapshot object,
and final status were removed; the five stable top-level test totals are kept
verbatim so the detector exercises JSON's real summary shape.

`node-test-name-pattern-match.txt` and `node-test-name-pattern-miss.txt`
are normalized Node 26.6.0 `node --test --test-reporter=spec` captures from
one real top-level test. Both report `tests 1` and `pass 1`; Node counts the
file for a name-pattern miss, so its result is indistinguishable from the
matching assertion and deliberately remains outside the zero-tests heuristic.

`tsc-vitest-concat.txt` is the one exception: not a raw capture, but two
of the other captures (`tsc-errors.txt` and the vitest mixed-run capture)
concatenated, so a single check's output can be made to carry both
shapes at once for the ambiguous-selection tests. `tsc-errors-many.txt`
is a real capture too (a throwaway project with 70 type errors, one per
line), used to exercise the tail-truncation warning against more
diagnostic lines than exec.ts's own 60-line tail bound keeps.
`*-colorized.txt` fixtures carry ANSI SGR escape codes: the eslint one is
a real `FORCE_COLOR=1` capture (stylish colorizes by default outside a
TTY-detected terminal); the tsc one is inline SGR sequences hand-added to
a real capture, since `tsc --pretty false` (the shape this detector
targets) never colorizes on its own, so there is no non-pretty colorized
shape to capture from a real run. `vitest-fail-space-in-path.txt` is a
real capture of a test file whose path contains a space, exercising the
` FAIL  file > name` line's structural (not `\S+`) file capture.
`vitest-expected-fail.txt` is a real capture of an `it.fails` run (the
`Tests  N passed | M expected fail (T)` shape). `vitest-collection-error.txt`
is a real capture of a broken import (a file that fails to collect: the
` FAIL  file [ file ]` and `Tests  no tests` shapes). `tsc-errors-bare.txt`
is a real capture of `tsc --noEmit` without `--pretty false`, run
non-interactively (no TTY) against the same `tsc-project` sources as
`tsc-errors.txt`, showing the shape is identical either way.
`vitest-all-expected-fail.txt` is a real capture of a run whose *only*
test is `it.fails` (`Tests  1 expected fail (1)`, no `passed`/`failed`
segment at all): unlike the mixed `vitest-expected-fail.txt` capture
above, this is the only fixture that can tell whether the `expected
fail` alternative in the detector's own summary-line pattern is actually
load-bearing, since no other segment is present to select the detector
on its own. `vitest-fail-bracket-name.txt` is a real capture of a
failing test whose own name ends in a bracketed segment (`parses row
[1,2,3]`), exercising the ` FAIL ` line's suite/name shape against a
name that could otherwise be mistaken for the file-only shape's
collection-error marker. `tsc-space-in-path.txt` is a real capture of a
type error in a file whose relative path contains a space, exercising
the diagnostic line's structural (not `\S+`) file capture.
`eslint-scoped-rule-id.txt` is a real capture, via the `@typescript-eslint`
plugin, of a scoped, slash-separated rule id
(`@typescript-eslint/no-unused-vars`) whose message also happens to
carry an inline regex literal (`/^_/u`) right before the rule id column,
exercising the rule id capture's grammar against both shapes at once.

### PHP captures (`phpunit-*`, `phpstan-*`, `phpcs-*`)

No PHP toolchain lives on the dev machine these were captured on: each
was produced in a throwaway `composer` project under a scratch
directory (never committed), run through disposable Docker containers
(`composer:2` for `composer require`, `php:8.3-cli` for the tools
themselves), then trimmed of the capture directory's own absolute path
(`/app/...` -> the project-relative path; the later capture sections
below name their own mount point) and wall-clock timing
(`Time: 00:00.NNN, Memory: N.NN MB` / `Time: NNNms; Memory: NMB` ->
`Time: [elided]`), the same convention the vitest/tsc/eslint captures
above use. Tool versions used for the capture: PHP 8.3.33 (cli),
PHPUnit 9.6.36, PHPStan 2.2.13, PHP_CodeSniffer 3.13.6 (`--standard=PSR12`).

- `phpunit-pass.txt`: `vendor/bin/phpunit --colors=never
  tests/CalcTest.php` against a two-test suite, both passing. Exit `0`.
- `phpunit-fail.txt`: the same command against a suite with one failing
  assertion (`assertSame(5, Calc::add(2, 2))`), exercising the numbered
  `N) Class::method` entry, its message, and its `file:line` locator
  line. Exit `1`.
- `phpunit-no-tests-executed.txt`: `vendor/bin/phpunit --colors=never
  tests/CalcTest.php --filter=NoSuchTest` (a filter matching nothing).
  Exit `0` -- the shape `probe`'s zero-tests guard exists to catch,
  since a `0` exit here is not a real pass.
- `phpunit-deprecation-notice.txt`: a green single-test run against a
  class that creates a dynamic property (deprecated on PHP 8.2+),
  capturing PHP's own `Deprecated: ...` notice line alongside PHPUnit's
  `OK (1 test, 1 assertion)`. Exit `0`. PHPUnit 9.6 has no
  `--fail-on-deprecation`-style flag (that is a PHPUnit 10+ feature),
  and neither `convertWarningsToExceptions`/`convertNoticesToExceptions`
  in `phpunit.xml` nor `assertArraySubset` (removed outright in 9.6,
  not merely deprecated) produced a non-zero-exit green run under 9.6.36
  on PHP 8.3; this fixture is therefore the deprecation-notice capture
  the task asked for, on a `0` exit, not the non-zero-exit variant.
- `phpstan-clean.txt` / `phpstan-errors.txt`: `vendor/bin/phpstan
  analyse --level=5 --no-progress --no-ansi <dir>` against a clean
  one-class file (exit `0`, ` [OK] No errors`) and a two-error file (a
  wrong return type, an undefined variable; exit `1`, the per-file table
  plus ` [ERROR] Found 2 errors`).
- `phpcs-clean.txt` / `phpcs-errors.txt`: `vendor/bin/phpcs
  --standard=PSR12 --no-colors <dir>` against a PSR-12-clean one-class
  file (exit `0`, empty stdout -- PHPCS's own default report prints
  nothing at all on a clean run, so there is no "no errors" shape to
  capture) and a file with tabs, missing braces/visibility, and no
  namespace (exit `2`, `FOUND 12 ERRORS AFFECTING 5 LINES` plus one row
  per finding).

### PHPUnit tally-shape and PHPCS multi-file captures

Same throwaway-`composer`-project-under-scratch-directory, same
disposable-Docker-container, same trimming convention as the captures
above; same tool versions (PHP 8.3.33, PHPUnit 9.6.36, PHPStan 2.2.13,
PHP_CodeSniffer 3.13.6, `--standard=PSR12`). See CHANGELOG (Unreleased)
for the detector behaviour these captures pin.

- `phpunit-skip-and-fail.txt`: `vendor/bin/phpunit --colors=never
  tests/SkipFailTest.php` against a three-test suite (one pass, one
  failing assertion, one `markTestSkipped`). Exit `1`. `FAILURES!` plus
  `Tests: 3, Assertions: 2, Failures: 1, Skipped: 1.` -- a tally regex
  that assumed a fixed `Failures`-then-`Skipped` order parses this to
  `failed: 0`, misread by `probe`'s zero-tests guard as nothing
  executed.
- `phpunit-all-skipped.txt`: the same command against a two-test suite
  where both tests `markTestSkipped`. Exit `0`. `OK, but incomplete,
  skipped, or risky tests!` plus `Tests: 2, Assertions: 0, Skipped: 2.`
  -- no `FAILURES!`/`ERRORS!` marker at all, a shape `probe`'s
  zero-tests guard must still recognize as zero tests executed.
- `phpunit-errors-and-failures.txt`: the same command against a
  six-test suite (two pass, one failing assertion, one thrown
  exception, one skipped, one incomplete). Exit `2`. `ERRORS!` (not
  `FAILURES!`, even though the run has both) plus `Tests: 6, Assertions:
  3, Errors: 1, Failures: 1, Skipped: 1, Incomplete: 1.` -- PHPUnit
  prints `Errors:` before `Failures:` in the tally whenever a run has
  both, and only the `ERRORS!` marker (never both), exercising the
  order-independent named-count parsing.
- `phpunit-warnings.txt`: the same command against a test class with
  no public test methods (`No tests found in class "..."`, a genuine
  PHPUnit-level warning, not an exception). Exit `0`, measured directly
  against a live run (an earlier recording of this same fixture's exit
  code as `2` was wrong). A PHPUnit-level warning does not fail the run
  under 9.6, which is why `probe`'s zero-tests guard, not the exit
  code, is what catches this shape. `WARNINGS!` plus `Tests: 1,
  Assertions: 0, Warnings: 1.`
- `phpcs-two-files.txt`: `vendor/bin/phpcs --standard=PSR12 --no-colors
  <dir>` against two files, each with the same tab-indentation and
  missing-visibility violations. Exit `2`. Two separate `FILE: ...` /
  `FOUND 8 ERRORS AFFECTING 6 LINES` blocks, one per file -- PHPCS never
  prints one grand-total summary across files, so summing every block
  (rather than reading only the first) is required to avoid
  undercounting a multi-file run.
- `phpcs-warnings-only.txt`: the same command against a file with two
  over-long lines (PSR12's `Generic.Files.LineLength` warns above 120
  characters, with no hard error threshold under PSR12's own
  configuration). Exit `1` -- the measured PHPCS exit mapping this
  fixture pins: `0` clean, `1` warnings only (no errors), `2` errors
  present (fixable or not), `3` a processing error (verified
  separately, not captured here as a fixture: `phpcs` prints usage help
  to stderr and exits `3` when a standard names no sniffs at all, an
  operator-input error rather than a lint result).

### Risky and errors-plus-skipped captures

Same throwaway-`composer`-project-under-scratch-directory, same
disposable-Docker-container (`composer:2`, `php:8.3-cli`), same trimming
convention as the captures above; PHP 8.3.33 (cli), PHPUnit 9.6.36. All
three exist to pin the executed/not-executed line drawn through
PHPUnit's tally categories (see CHANGELOG (Unreleased)).

- `phpunit-risky-and-real.txt`: `vendor/bin/phpunit --colors=never
  tests/RiskyRealTest.php` against a two-test class, one asserting, one
  performing no assertion at all (PHPUnit 9.6 flags that as risky by
  default). Exit `0`. `OK, but incomplete, skipped, or risky tests!`
  plus `Tests: 2, Assertions: 1, Risky: 1.`, and a numbered `1)
  RiskyRealTest::testNoAssertions` entry under a `There was 1 risky
  test:` header -- a real `Class::method` entry that is NOT a failure,
  which is why the entry loop keys on the section header rather than on
  the entry header's own grammar.
- `phpunit-risky-only.txt`: the same command against a one-test class
  whose single test performs no assertion. Exit `0`. `Tests: 1,
  Assertions: 0, Risky: 1.` -- one test ran, so this is NOT a
  zero-tests-executed run, even though it carries the same marker an
  all-skipped run does.
- `phpunit-errors-and-skipped.txt`: the same command against a
  three-test class (one passing, one throwing, one `markTestSkipped`),
  with no failing assertion anywhere. Exit `2`. `ERRORS!` plus `Tests:
  3, Assertions: 1, Errors: 1, Skipped: 1.` -- an `Errors:` count with
  no `Failures:` count beside it.

### Entry-locator and plural-header captures

Same throwaway-`composer`-project-under-scratch-directory, same
disposable-Docker-container (`composer:2`, `php:8.3-cli`), same trimming
convention as the captures above; PHP 8.3.33 (cli), PHPUnit 9.6.36.

- `phpunit-error-message-with-port.txt`: `vendor/bin/phpunit
  --colors=never tests/PortTest.php` against a two-test class, one
  passing, one throwing `RuntimeException('upstream unreachable at
  api.example.com:8080')`. Exit `2`. The entry's message ("RuntimeException:
  upstream unreachable at api.example.com:8080") ends in `:8080` and
  sits on the entry's own first line, not preceded by a blank line, so
  it is never mistaken for the `file:line` locator that follows it two
  lines later (`tests/PortTest.php:14`), which IS preceded by a blank
  line.
- `phpunit-two-failures-and-risky.txt`: `vendor/bin/phpunit
  --colors=never tests/PluralTest.php` against a four-test class (two
  failing assertions, two tests performing no assertion at all). Exit
  `1`. `There were 2 failures:` and, after a `--` divider, `There were 2
  risky tests:` in the same run -- pins the plural form of the
  defect-section header (`DEFECT_SECTION_HEADER`'s `s?` is otherwise
  only exercised by its singular forms) and that both risky entries are
  excluded from `failures` even when a plural section precedes them.
  `FAILURES!` plus `Tests: 4, Assertions: 2, Failures: 2, Risky: 2.`

Measured in the same session, not captured as fixtures: PHPUnit's
`--testdox` and `--teamcity` reporters both still print the run's marker
line and its `Tests: N, Assertions: M, ...` tally unchanged (only the
numbered `N) Class::method` entries are absent), so the `phpunit`
detector is still selected under them and its summary counts are
correct, with `failures` empty.

### Diff-blank-row, multi-frame, message-reset, and indented-message captures

Same throwaway-`composer`-project-under-scratch-directory, same
disposable-Docker-container (`composer:2`, `php:8.3-cli`), same trimming
convention as the captures above; PHP 8.3.33 (cli), PHPUnit 9.6.36.
Command for all four: `docker run --rm -v <scratch>:/work -w /work
composer:2 composer require --dev phpunit/phpunit:^9.6` followed by
`docker run --rm -v <scratch>:/work -w /work php:8.3-cli
vendor/bin/phpunit --colors=never tests/<File>.php`; both composer
commands exited `0`.

- `phpunit-diff-indented-locator.txt`: a two-string `assertSame` whose
  compared strings share an embedded blank line and an embedded
  `port:12` line, differing only on their last line (`tests/DiffTest.php`,
  `testConfigDiff`). Exit `1`. PHPUnit's own diff renderer
  (`sebastian/diff`) prefixes every row with a space, `-` or `+`, so an
  unchanged blank line inside the diff prints as a single space, never
  as a zero-length line, and the unchanged `port:12` row directly below
  it prints indented (` port:12`) -- structurally identical to a
  `file:line` locator once trimmed. Pins `ENTRY_FILE_LINE`'s own `\S`
  anchor, which is what actually keeps the indented `port:12` row from
  being read as the locator here: the row is never blank-gated in the
  first place (a raw-length blank check already reads the one-space row
  above it as non-blank, so the entry loop never even reaches the
  indented row looking for a locator), so this fixture alone does not
  discriminate a raw-length blank check from a trim-based one -- see
  `phpunit-raw-blank-check.txt` below for the fixture that does. The
  real locator is instead read correctly two lines later
  (`tests/DiffTest.php:11`).
- `phpunit-nested-throw-frames.txt`: an uncaught `RuntimeException`
  thrown from a function called by another function called by the test
  itself (`tests/NestedThrowTest.php`, `testThrows`, via
  `src/Thrower.php`). Exit `2`. PHPUnit prints one `file:line` line per
  frame, back to back with no blank line between them
  (`src/Thrower.php:5`, the throw site; `src/Thrower.php:10`, its
  caller; `tests/NestedThrowTest.php:11`, the test method) -- pins that
  the entry loop reports only the first (innermost, throw-site) frame as
  `file`/`line` and consumes the remaining CONSECUTIVE frames (no blank
  line, no other text, between them) without folding them into
  `message`; see `phpunit-chained-exception.txt` below for the fixture
  pinning that a later, non-consecutive locator is folded into `message`
  instead of consumed.
- `phpunit-message-reset.txt`: an uncaught `RuntimeException` whose own
  message embeds a blank line followed by two ordinary lines, the second
  of which (`abc:99`) is structurally identical to a locator
  (`tests/MessageResetTest.php`, `testBlankThenColonDigitText`). Exit
  `2`. Pins that the entry loop resets its blank-tracking flag after
  every ordinary message line, not only after a consumed locator/frame
  line: without that reset, the flag set by the message's own embedded
  blank line would still read `true` by the time `abc:99` is reached
  (even though an intervening ordinary line, not a blank one, immediately
  precedes it), misreading `abc:99` as the locator and discarding the
  real one (`tests/MessageResetTest.php:9`) as a dropped extra frame.
- `phpunit-indented-message-line.txt`: an uncaught `RuntimeException`
  whose own message embeds a genuinely blank (zero-length) line directly
  followed by a two-space-indented `file:42` line
  (`tests/IndentedMessageTest.php`, `testIndentedLine`). Exit `2`. Unlike
  `phpunit-diff-indented-locator.txt`'s blank row (one space, not zero
  characters, so the blank check alone already keeps it out), this line
  is preceded by a REAL blank line, isolating the locator regex's own
  raw-vs-trimmed behavior: `ENTRY_FILE_LINE` still never matches it,
  because it requires a non-whitespace first character on the raw line,
  so the real locator (`tests/IndentedMessageTest.php:9`) is still found
  further down.

### Raw-blank-check and chained-exception captures

Same throwaway-`composer`-project-under-scratch-directory, same
disposable-Docker-container (`composer:2`, `php:8.3-cli`); PHP 8.3.33
(cli), PHPUnit 9.6.36. Command for both: `docker run --rm -v
<scratch>:/work -w /work composer:2 composer require --dev
phpunit/phpunit:^9.6` (exit `0`) followed by `docker run --rm -v
<scratch>:/work -w /work php:8.3-cli vendor/bin/phpunit --colors=never
tests/<File>.php`. Both captures mount the scratch project at `/work`
and are trimmed of that mount point down to the project-relative path
(`/work/tests/RawBlankCheckTest.php:9` -> `tests/RawBlankCheckTest.php:9`),
the same mount-and-trim convention every other `phpunit-*` capture in
the earlier `phpunit-*` captures use (the captures in this section and
in the preceding diff-blank-row section were mounted at `/work`; the
earlier PHP captures above document their own `/app` mount, and every
fixture is trimmed to the project-relative path either way).

- `phpunit-raw-blank-check.txt`: an uncaught `RuntimeException` whose
  own message embeds a genuinely one-space line (not a zero-length one)
  directly followed by an UNINDENTED `abc:99` line
  (`tests/RawBlankCheckTest.php`, `testSingleSpaceLineThenLocator`).
  Exit `2`. Pins that the entry loop's blank check tests the RAW line's
  *length*, not its trimmed length: `ENTRY_FILE_LINE`'s `\S` anchor does
  NOT protect here, because `abc:99` is already unindented and matches
  the anchor fine, so a trim-based blank check (`line.trim().length ===
  0`) would treat the one-space line as blank and misread the following
  `abc:99` as the locator, discarding the real one
  (`tests/RawBlankCheckTest.php:9`) as a dropped extra frame; only
  testing the raw line's own length keeps that from happening. Unlike
  `phpunit-diff-indented-locator.txt` above, this fixture discriminates
  the blank check on its own, independently of the `\S` anchor.
- `phpunit-chained-exception.txt`: a `RuntimeException` constructed with
  a chained `LogicException` as its previous-exception argument
  (`tests/ChainedThrowTest.php`, `testChainedException`,
  `new RuntimeException("outer", 0, new LogicException("inner:42"))`).
  Exit `2`. PHPUnit 9.6 prints the first exception's own `file:line`
  locator, then a blank line, a `Caused by` line, the chained
  exception's own message line (`LogicException: inner:42` --
  structurally a locator itself), a blank line, and the chained
  exception's own `file:line` locator (here identical to the first,
  since both exceptions are constructed on the same source line). Pins
  that the entry loop's extra-frame branch only consumes a later
  locator-shaped line when it is CONSECUTIVE with the frame already
  captured (no blank line, no other text, in between): neither the
  `Caused by` block's message line nor its own locator line is
  consecutive with the first exception's frame (a blank line and, for
  the message line, the `Caused by` line itself sit in between), so both
  are folded into `message` as ordinary text
  (`RuntimeException: outer Caused by LogicException: inner:42
  tests/ChainedThrowTest.php:9`) instead of being silently dropped the
  way a true consecutive frame is. This is the fixture that discriminates
  a broader "any later locator-shaped line is a frame" rule (which would
  drop the `Caused by` block's message text entirely) from the narrower
  consecutive-only rule the entry loop actually implements.

### PHPUnit 11 captures (tracker 3a0c5242)

Real PHPUnit 11 output, captured for the three residuals recorded when
the PHP detectors first shipped (PR #227; see CHANGELOG (Unreleased)),
plus two more for the version-aware plain `Warnings` reading (same
tracker, see CHANGELOG (Unreleased)). Unlike every other `phpunit-*`
fixture above (all PHPUnit 9.6.36), all
five were captured against PHPUnit 11.5.56, PHP 8.3.33 (cli), same
`composer:2`/`php:8.3-cli` disposable-Docker-container method as the
captures above: `docker run --rm -v <scratch>:/work -w /work composer:2
composer require --dev phpunit/phpunit:^11.5` (exit `0`) followed by
`docker run --rm -v <scratch>:/work -w /work php:8.3-cli
vendor/bin/phpunit --colors=never tests/<File>.php`. All five captures
mount the scratch project at `/work` and are trimmed of that mount point
down to the project-relative path, and of wall-clock timing (`Time:
00:00.NNN, Memory: N.NN MB` -> `Time: [elided]`), the same trimming
convention every other capture in this file uses. PHPUnit 11 additionally
prints a `Runtime:       PHP 8.3.33` line right under its own version
banner that PHPUnit 9.6 never printed; kept verbatim, untrimmed, since
it is part of the real captured shape.

- `phpunit-error-data-provider.txt`: `vendor/bin/phpunit --colors=never
  tests/DataProviderThrowsTest.php` against a two-test class
  (`testOk`, which asserts and passes; `testSomething`, whose
  `@dataProvider provider` static method throws a `RuntimeException`
  before PHPUnit can ever call the test method itself). Exit `2`.
  `There was 1 PHPUnit error:` -- PHPUnit 11's own defect-section kind
  for a suite-level failure like an invalid data provider, distinct from
  an ordinary `There was 1 error:` on a test that ran and threw --
  followed by a `1) DataProviderThrowsTest::testSomething` entry, its
  message, and a `file:line` locator two lines later
  (`tests/DataProviderThrowsTest.php:20`). `ERRORS!` plus `Tests: 1,
  Assertions: 1, Errors: 1, PHPUnit Deprecations: 1.` -- the tally's own
  `Errors: 1` is what the `PHPUnit error` section kind is collected
  against (see `COLLECTED_SECTION_KINDS`'s own docblock); the tally's
  `PHPUnit Deprecations: 1` (from using the old doc-comment
  `@dataProvider` annotation instead of the `#[DataProvider]` attribute)
  is this fixture's own two-word tally token, alongside the
  `phpunit-two-word-deprecation-tally.txt` capture below. Note PHPUnit's
  own `Tests: 1` here counts only `testOk`, the one test that actually
  ran (the progress line prints a single `.`, `1 / 1 (100%)`); the
  provider failure is reported only via `Errors: 1`, never added to the
  stated total, which is why this specific capture's derived
  `summary.passed` reads `0` even though `testOk` genuinely passed -- a
  pre-existing property of how `deriveCounts` spends PHPUnit's own
  stated total (see that function's own docblock on a self-contradictory
  tally), not something this capture's parsing change introduces or
  fixes.
- `phpunit-two-word-deprecation-tally.txt`: `vendor/bin/phpunit
  --colors=never tests/OldAnnotationProviderTest.php` against a
  two-test class using the old doc-comment `@dataProvider` annotation on
  a data provider that returns two values normally (no error, unlike
  the fixture above). Exit `0`. `OK, but there were issues!` (PHPUnit
  11's own replacement for `OK, but incomplete, skipped, or risky
  tests!` when the only issue is a deprecation/notice, not a
  skip/incomplete/risky test; recognized here via `TALLY_LINE` alone,
  the same way every other marker-less all-skipped-style run already is)
  plus `Tests: 2, Assertions: 2, PHPUnit Deprecations: 1.` -- BOTH tests
  genuinely ran and passed, isolating the two-word tally token from any
  accompanying error/failure, which is what proves `PHPUnit
  Deprecations` must NOT be treated as a not-executed category the way
  `Skipped`/`Incomplete` (and PHPUnit 9's plain `Warnings`) are (see
  `TALLY_CATEGORIES`'s own docblock): doing so would misderive
  `summary.passed` as `1` here, not `2`.
- `phpunit-exit-mid-suite.txt`: `vendor/bin/phpunit --colors=never
  tests/ExitMidSuiteTest.php` against a three-test class whose SECOND
  test (`testExits`) calls `exit(0)` as its entire body, before either
  test after it (`testNeverRuns`) or PHPUnit's own summary ever prints.
  Exit `0`. The captured bytes are exactly PHPUnit's own version banner,
  a blank line, `Runtime:       PHP 8.3.33`, a blank line, and a single
  `.` progress character for `testFirst` (the one test that ran before
  `testExits` killed the process) -- no trailing newline, since the
  process was terminated mid-write, not trimmed off. No `OK (`, no
  `FAILURES!`/`ERRORS!`/`WARNINGS!` marker, no `Tests: N, Assertions: M`
  tally, no `No tests executed!`: PHPUnit itself never got the chance to
  print any completion shape at all. This is the capture residual (c)
  named (tracker 3a0c5242): before `PHPUNIT_BANNER`/`phpunitTruncatedRun`
  (see their own docblocks in `src/verify/detectors/phpunit.ts`), this
  detector's `matches()` returned `false` for this exact shape (falling
  to `generic`), `verify` reported a plain, uninformative `pass` from
  the exit code alone, and `probe`'s zero-tests guard did not recognize
  it either -- only `probe`'s separate byte-identical generic fallback
  stood any chance of catching a MUTANT that changed this shape, and
  never caught a baseline that was already this shape to begin with.
  `die()` produces the identical shape to `exit()`; this fixture stands
  in for both.
- `phpunit-warning-test-executed.txt`: `vendor/bin/phpunit --colors=never
  tests/WarnOnlyTest.php` against a one-test class whose single test
  calls `trigger_error('a test-level warning', E_USER_WARNING)` and then
  asserts. Exit `0`. `OK, but there were issues!` plus `Tests: 1,
  Assertions: 1, Warnings: 1.` -- captured to pin the version-aware
  plain `Warnings` reading (tracker 3a0c5242): under PHPUnit 9 a plain
  `Warnings: N` token counts a synthetic per-class warning that never
  ran a body (not executed), but here the ONE test genuinely ran,
  asserted, and passed -- PHPUnit 10/11 repurposed the same token to
  count tests that ran and raised a PHP-level warning.
  `phpunitZeroTestsVerdict` must read `not_zero` for this capture and
  `deriveCounts` must derive `passed: 1`, not `passed: 0`, once the
  tally-category table is read version-aware off this capture's own
  `PHPUnit 11.5.56` banner. The count itself is then named in a
  `phpunit_warnings:` detector warning, since the version-aware reading
  folds it into `passed` and leaves `summary.warnings` at `0`.
- `phpunit-warnings-deprecations-notices-executed.txt`:
  `vendor/bin/phpunit --colors=never tests/WarnDeprecationNoticeTest.php`
  against a three-test class, one test each calling `trigger_error` with
  `E_USER_WARNING`, `E_USER_DEPRECATED`, and `E_USER_NOTICE`
  respectively, each then asserting. Exit `0`. `OK, but there were
  issues!` plus `Tests: 3, Assertions: 3, Warnings: 1, Deprecations: 1,
  Notices: 1.` -- isolates the plain (one-word) `Warnings`, `Deprecations`
  and `Notices` tokens together, all three genuinely-run and passing
  tests: `deriveCounts` must derive `passed: 3` here (the version-aware
  `Warnings` reading plus the pre-existing unspent `Deprecations`/
  `Notices` reading), not `passed: 2` (the pre-fix misreading that
  treated plain `Warnings` as not-executed on every PHPUnit version).

### Suppressed-result-report captures (tracker 3a0c5242)

Real captures taken to separate a run whose result REPORT is missing
(killed mid-suite) from one whose report is merely SUPPRESSED, after the
banner-without-completion reading misread the latter as the former.
Same disposable-Docker method as the captures above, with two scratch
projects (`p11`, `p9`) under a scratch directory that was deleted after
the captures were taken (the scratch directory lived outside this
repository):

```
docker run --rm -v <scratch>/p11:/work -w /work composer:2 \
  composer require --dev phpunit/phpunit:^11.5          # exit 0 -> 11.5.56
docker run --rm -v <scratch>/p9:/work -w /work composer:2 \
  composer require --dev phpunit/phpunit:^9.6           # exit 0 -> 9.6.36
docker run --rm -v <scratch>/p11:/work -w /work php:8.3-cli \
  vendor/bin/phpunit --colors=never <flags> <file>
docker run --rm -v <scratch>/p9:/work -w /work php:8.3-cli \
  vendor/bin/phpunit --colors=never <flags> <file>
```

PHPUnit 11.5.56 / PHP 8.3.33 (cli) and PHPUnit 9.6.36 / PHP 8.3.33
(cli). These five captures are kept BYTE-VERBATIM, including the
`Time: 00:00.NNN, Memory: N.NN MB` line's own timing digits, and are the
one exception to the `Time: [elided]` trimming convention every capture
above uses: the presence and SHAPE of that line is exactly what the
reading under test turns on (`TIME_MEMORY_LINE` in
`src/verify/detectors/phpunit.ts`), so eliding it would calibrate the
pattern to this suite's own editing rather than to PHPUnit's output.
Nothing needed trimming for the mount point: none of the five prints a
path.

- `phpunit-no-results-green.txt`: `--no-results tests/GreenTwoTest.php`
  against a two-test class that both asserts and passes. Exit `0`.
  Banner, `Runtime:       PHP 8.3.33`, `..` padded out to `2 / 2
  (100%)`, and `Time: 00:00.007, Memory: 8.00 MB`. No `OK (`, no
  marker, no tally: `--no-results` suppresses PHPUnit's result report,
  not the run, and both tests genuinely ran and passed. This is the
  round-3 counterexample that made the banner-without-completion arm a
  false claim (measured against the pre-fix detector: verdict `zero`,
  reason "phpunit printed its version banner but no completion line at
  all, so the run was killed before it could report anything"), and the
  reason the arm now additionally requires the progress counter and the
  `Time:`/`Memory:` line to be ABSENT. The derived summary stays
  `passed: 0` (the graceful all-zero convention for output with no
  tally to read); the counter is deliberately not turned into a count,
  since the red capture below prints the identical counter.
- `phpunit-no-results-red.txt`: `--no-results tests/RedTwoTest.php`
  against a two-test class, one passing and one failing an
  `assertSame`. Exit `1`. Identical shape to the green capture with
  `.F` progress characters and the same `2 / 2 (100%)` counter, and,
  because `--no-results` is in force, NO defect section and no tally:
  the counter counts tests PHPUnit reached, never tests that passed.
  Pins that the pass-only zero-tests warning never fires here, since
  the check's own status is `fail`.
- `phpunit-no-results-filter-miss.txt`: `--no-results --filter
  NoSuchTest tests/GreenTwoTest.php`. Exit `0`. Banner and `Runtime:`
  alone -- no progress row at all, hence no counter, and no `Time:`
  line either, since the suppressed report takes it with it. Reads as
  an unreadable result (`"ambiguous"`), so `probe` refuses it
  fail-closed. Measured contrast, both majors: the SAME filter miss
  WITHOUT `--no-results` prints PHPUnit's own `No tests executed!` line
  (11.5.56: banner, `Runtime:`, `No tests executed!`, exit `0`; 9.6.36:
  banner, `No tests executed!`, exit `0` -- the same shape the existing
  `phpunit-no-tests-executed.txt` capture already holds), a statement
  rather than an absence, so the ambiguity here comes from the
  suppressed report and not from the filter.
- `phpunit-list-tests.txt`: `--list-tests tests/GreenTwoTest.php`. Exit
  `0`. Banner, `Available tests:`, and the two ` - GreenTwoTest::testX`
  lines; no `Runtime:` line, no counter, no `Time:` line. Reads as an
  unreadable result too, which is documented over-caution: a listing
  never claimed to run anything. Measured wording difference on the
  same flag under 9.6.36: `Available test(s):` instead of `Available
  tests:` (banner, that header, and three ` - ExitMidSuiteTest::testX`
  lines, exit `0`) -- neither header is parsed, so the difference costs
  nothing here.
- `phpunit-exit-mid-suite-9.txt`: `tests/ExitMidSuiteTest.php` under
  PHPUnit 9.6.36, the same three-test class as
  `phpunit-exit-mid-suite.txt` above (second test's body is `exit(0)`).
  Exit `0`. Banner, a blank line, and a single `.`, with no trailing
  newline (the process was terminated mid-write): 9.6 prints no
  `Runtime:` line, which is the only difference from the 11.5.56
  capture's own banner/blank/`Runtime:`/blank/`.` shape. Pins that the
  unreadable-result reading is not version-specific.

Two more measurements from the same runs, recorded here rather than
captured as files:

- `--no-results --no-progress tests/GreenTwoTest.php` and `--no-output
  tests/GreenTwoTest.php` (both PHPUnit 11.5.56) print NOTHING at all:
  zero bytes, exit `0`. A zero-byte fixture file would pin nothing
  about which tool produced it, so both shapes are pinned as
  constructed empty-output tests instead (`test/verify.test.ts`): such
  output carries no PHPUnit evidence whatsoever, so selection falls to
  the `generic` detector and no phpunit claim is made either way.
- `--no-results` under PHPUnit 9.6.36 is not a known flag at all:
  banner, `Unknown option "--no-results"`, exit `1`. The
  suppressed-report shape is therefore a PHPUnit 10-and-up shape only,
  which is why no 9.x suppressed-report capture exists in this
  directory.

### `--colors=always` captures (ANSI SGR residual)

Same throwaway-composer-project-under-scratch-directory, same
disposable-Docker-container (`composer:2`, `php:8.3-cli`), same trimming
convention as the captures above. The first six (`Calc`/`CalcFail`,
`MultiRowTest`): PHP 8.3.33 (cli), PHPUnit 9.6.36. Command for those
six: `docker run --rm -v <scratch>:/app -w /app composer:2 composer
require --dev phpunit/phpunit:^9.6` (exit `0`), followed by `docker run
--rm -v <scratch>:/app -w /app php:8.3-cli vendor/bin/phpunit
--colors=<always|never> tests/<File>.php` against a two-test `Calc`
suite (`testAddsTwoNumbers`, `testAddsNegativeNumbers`, both passing), a
two-test `CalcFail` suite (`testAddsTwoNumbers` passing, `testAddWrong`
asserting `5 === Calc::add(2, 2)` and failing), and a `MultiRowTest`
class (below). The last pair (`RedTwoTest`, `--no-results`) reuses
PHPUnit 11.5.56 / PHP 8.3.33 (cli) and the `/work` mount, same command
shape as the "PHPUnit 11 captures" section below with `composer
require --dev phpunit/phpunit:^11.5`.

- `phpunit-pass-colorized.txt`: `--colors=always` against the `Calc`
  suite. Exit `0`. `phpunit-pass-colorized-twin.txt` is the SAME
  session's `--colors=never` run against the identical source files (a
  true twin, not merely another green-run fixture): stripping every
  `ESC [ <params> m` SGR sequence from the colorized capture reproduces
  the twin byte-for-byte (`test/verify.test.ts` pins this equality
  directly, and pins that `phpunitDetector.parse`/`phpunitZeroTestsVerdict`
  read the two identically). `phpunit-pass-colorized-twin.txt` is byte-
  identical to `phpunit-pass.txt` above (same suite, same `--colors=never`
  flag): kept as its own file rather than reused, since it is this
  colorized capture's own same-session twin and the equality test above
  asserts against it by that name, not against `phpunit-pass.txt`.
- `phpunit-fail-colorized.txt`: `--colors=always` against the
  `CalcFail` suite. Exit `1`. `phpunit-fail-colorized-twin.txt` is its
  own `--colors=never` twin, same relationship as above.
- `phpunit-multirow-colorized.txt`: `--colors=always` against a
  `MultiRowTest` class (PHPUnit 9.6.36, same disposable-container
  method), a 70-case `@dataProvider` (`testCounts`) whose progress wraps
  onto a second row (`65 / 70 ( 92%)` then `70 / 70 (100%)`) and whose
  case 30 calls `markTestSkipped`, producing a coloured non-`.` `S`
  marker mid first row. Exit `0` (a skip is not a failure).
  `phpunit-multirow-colorized-twin.txt` is the same session's
  `--colors=never` run, same relationship as above. Added because every
  other colorized capture above is a two-test, single-row run, which
  left the multi-row progress wrap unpinned.
- `phpunit-no-results-red-colorized.txt`: `--colors=always --no-results`
  against a `RedTwoTest` class (PHPUnit 11.5.56, `testPasses` passing,
  `testFails` asserting `5 === 2 + 2` and failing), same disposable-
  container method and mount (`/work`) as the PHPUnit 11 captures below.
  Exit `1`. `phpunit-no-results-red-colorized-twin.txt` is the same
  session's `--colors=never` run, same relationship as above; it is NOT
  byte-identical to `phpunit-no-results-red.txt` (that capture keeps its
  own `Time:`/`Memory:` line byte-verbatim per the suppressed-report
  captures' own convention below, while this twin elides it like every
  other capture in this section, since the equality this pair pins is
  colour-stripping, not completion-timing shape). Added because the
  suppressed-report shape (`summary.attempted` is the only reading) had
  no colorized capture: before the fix, `progressCounterAttempted` read
  `attempted: undefined` from the colorized capture's escaped `.`+`F`
  progress row (`PROGRESS_COUNTER_LINE` is anchored) while the twin
  still read `attempted: 2`; after the fix both read `attempted: 2`.

Measured (the reason this detector strips ANSI SGR sequences before any
row/line pattern sees the output, rather than leaving colour out of
scope): PHPUnit's `--colors=always` colorizes the `OK (...)` line, the
`FAILURES!`/`ERRORS!`/`WARNINGS!` marker, EACH comma-separated segment
of the `Tests: N, Assertions: M, ...` tally line in its OWN `ESC...m`
pair (not one pair around the whole line), and a non-`.` progress
marker character (`F` in `phpunit-fail-colorized.txt`'s `.` + escaped
`F` progress row) -- never the version banner, the post-run
`Time:`/`Memory:` line, a numbered entry header, or a `file:line`
locator. Every one of those colorized shapes sits directly against this
detector's `^`/`$`-anchored patterns (`OK_LINE`, `FAILURES_MARKER`,
`TALLY_LINE`, `PROGRESS_COUNTER_LINE`), so an unmodified capture fails
every one of them and the run's own tally goes unread -- confirmed
before the fix by parsing `phpunit-fail-colorized.txt` and getting
`summary.failed: 0` on a run that genuinely failed one test. Colour
placement was read from these two real captures before the detector was
touched, not guessed at.

## `vitest-project/`, `tsc-project/`, `eslint-project/`

Minimal, self-contained projects with one deliberately failing check
each, used by the live integration tests: each project's `package.json`
script calls its tool by bare name (`vitest run`, `tsc --noEmit --pretty
false`, `eslint .`), which resolves through this package's own
`node_modules/.bin` via npm's normal ancestor-directory lookup (these
fixtures need no `node_modules` of their own). No reporter flags are
passed; detectors parse the tool's default text output.
