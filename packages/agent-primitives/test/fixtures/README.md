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
(`/app/...` -> the project-relative path) and wall-clock timing
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

### Diff-blank-row, multi-frame, and message-reset captures

Same throwaway-`composer`-project-under-scratch-directory, same
disposable-Docker-container (`composer:2`, `php:8.3-cli`), same trimming
convention as the captures above; PHP 8.3.33 (cli), PHPUnit 9.6.36.
Command for all three: `docker run --rm -v <scratch>:/work -w /work
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
this directory uses (this project's own throwaway captures used `/work`
as their container mount point throughout, not `/app`).

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

## `vitest-project/`, `tsc-project/`, `eslint-project/`

Minimal, self-contained projects with one deliberately failing check
each, used by the live integration tests: each project's `package.json`
script calls its tool by bare name (`vitest run`, `tsc --noEmit --pretty
false`, `eslint .`), which resolves through this package's own
`node_modules/.bin` via npm's normal ancestor-directory lookup (these
fixtures need no `node_modules` of their own). No reporter flags are
passed; detectors parse the tool's default text output.
