# verify detector fixtures

Two kinds of fixture live here, both consumed only by `verify.test.ts` and
`cli.test.ts`; neither is picked up by this package's own `npm test`
(`vitest.config.ts` excludes `test/fixtures/**`).

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

## `vitest-project/`, `tsc-project/`, `eslint-project/`

Minimal, self-contained projects with one deliberately failing check
each, used by the live integration tests: each project's `package.json`
script calls its tool by bare name (`vitest run`, `tsc --noEmit --pretty
false`, `eslint .`), which resolves through this package's own
`node_modules/.bin` via npm's normal ancestor-directory lookup (these
fixtures need no `node_modules` of their own). No reporter flags are
passed; detectors parse the tool's default text output.
