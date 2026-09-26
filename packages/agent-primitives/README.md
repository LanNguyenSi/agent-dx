# agent-primitives

Agent-first CLI primitives for narrow subagents: a mutation-probe runner, a
verify runner, a PATH doctor, and an identifier-drift guard, each returning
one bounded JSON result instead of raw tool output.

## Overview

`agent-primitives` is an agent-first CLI: JSON on stdout by default, one
bounded result object per invocation, and stable exit codes (`0` ok, `1`
finding, `2` cannot conclude, including a usage error). It exists to remove a
few recurring failure classes in agent-driven review and implementation work:
hand-edited mutation probes that forget to restore a file, verify output that
blows past a harness's output cap, and "which binary is even on PATH"
guesswork. Unlike its sibling packages, it defaults to JSON output (`-f,
--format text` opts into a human-readable rendering instead), because its
primary caller is another agent, not a terminal. Part of
[agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling
for teams shipping with AI agents.

## Key features

- `doctor`: checks a fixed list of required and optional binaries on `PATH`
  and reports a few environment signals (git worktree, `node_modules`,
  whether a rebuild is likely needed).
- `verify`: runs named checks (`build`, `typecheck`, `lint`, `test` by
  default) and reports a compact, bounded summary instead of raw output.
- `probe`: runs one mutation probe (or a `--plan` of several), confirms the
  baseline passes first, and reports whether the target test caught the
  mutant, restoring the file afterward either way.
- `init`: installs the package's own skill document into a harness's skill
  directory.
- `drift`: finds prose and comments that still cite an identifier a change
  deleted or renamed.
- Non-Node repositories are supported: PHP (PHPUnit, PHPStan,
  PHP_CodeSniffer) output is recognized by `verify` and `probe` alongside
  vitest, tsc, and eslint.
- Every command accepts the same global flags (`-f/--format`, `-C/--cwd`,
  `-m/--max-chars`, `-l/--log-dir`); see
  [Output shape](docs/output-shape.md) for the JSON envelope and the
  `-m` reduction algorithm.

## Install / quick start

```bash
npx agent-primitives doctor
```

For a binary that stays on `PATH`, so a subagent started as an ordinary
child process finds it too:

```bash
npm install -g agent-primitives
agent-primitives doctor
```

Requires Node >= 20.

## Usage

```bash
agent-primitives probe --file src/foo.js -n 12 -r 'return false;' \
  -t 'npm test'
```

Mutates line 12 of `src/foo.js` to `return false;`, confirms `npm test`
passes first (the baseline), reruns it against the mutant, restores the
file, and reports whether the test caught it (`killed`) or missed it
(`survived`).

## Documentation

- [`doctor`](docs/doctor.md): PATH and environment checks.
- [`verify`](docs/verify.md): run named checks with a bounded summary.
- [`probe`](docs/probe.md): the mutation-probe runner, `--plan`, and the
  result shape.
- [`init`](docs/init.md): install the package's skill into a harness.
- [`drift`](docs/drift.md): the identifier-drift guard for docs and
  comments.
- [Non-JS test runners](docs/non-js-test-runners.md): PHP and other
  non-Node test runner support, including the "Python bytecode cache"
  section a `probe` warning points to.
- [Output shape](docs/output-shape.md): the JSON envelope, global flags,
  and the `-m/--max-chars` reduction algorithm.

## Development

To work on the package itself, build it from source:

```bash
git clone https://github.com/LanNguyenSi/agent-dx.git
cd agent-dx/packages/agent-primitives
npm install
npm run build
node dist/cli.js doctor
```

`npm test` runs the build first (`pretest`), then the test suite
(vitest).

## License

MIT
