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
- eslint 10.9.1 (stylish formatter, the CLI default)

## `vitest-project/`, `tsc-project/`, `eslint-project/`

Minimal, self-contained projects with one deliberately failing check
each, used by the live integration tests: each project's `package.json`
script calls its tool by bare name (`vitest run`, `tsc --noEmit --pretty
false`, `eslint .`), which resolves through this package's own
`node_modules/.bin` via npm's normal ancestor-directory lookup (these
fixtures need no `node_modules` of their own). No reporter flags are
passed; detectors parse the tool's default text output.
