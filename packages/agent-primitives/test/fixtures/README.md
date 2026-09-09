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

## `vitest-project/`, `tsc-project/`, `eslint-project/`

Minimal, self-contained projects with one deliberately failing check
each, used by the live integration tests: each project's `package.json`
script calls its tool by bare name (`vitest run`, `tsc --noEmit --pretty
false`, `eslint .`), which resolves through this package's own
`node_modules/.bin` via npm's normal ancestor-directory lookup (these
fixtures need no `node_modules` of their own). No reporter flags are
passed; detectors parse the tool's default text output.
