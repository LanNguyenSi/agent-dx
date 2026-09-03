# Changelog

All notable changes to `agent-primitives` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Envelope bound and reduction.** The bound is enforced by one generic,
  progress-guarded loop over the whole (deep-copied) result graph rather
  than a fixed cascade of name-based ladders plus a hard iteration cut.
  Each pass walks the graph once and applies the first step that makes
  byte progress: shorten the largest array anywhere, then the longest
  string anywhere, then drop whole keys largest-first until the remaining
  excess is covered. Each step cuts to what the remaining excess needs
  (bounded by halving, so progress stays geometric) instead of halving
  unconditionally, and keys are dropped in bulk, which is what keeps a
  wide result of thousands of small fields from costing one full traversal
  per field. The whole loop runs under a work budget (`reductionBudgetMs`,
  default 200ms); once it is spent, every reducible field is dropped at
  once and a warning says so, so a pathological shape costs a worse result
  rather than a stall. The fixed envelope fields are never touched, so the
  real invariant is `serializedLength(envelope) <= max(maxChars,
  skeletonFloor)`; whenever the literal requested `-m`/`maxChars` cannot be
  honored, a warning names the envelope's true final length, solved
  exactly (the warning's own digits are part of the length it reports)
  instead of approximated by a loop that gave up after a fixed number of
  tries. An array's truncation marker counts from the array's original
  length, so a result reduced over several passes reports how many
  elements are missing in total, not how many the last pass happened to
  drop. Serialized lengths are total: a field whose value JSON omits
  (`undefined`, a function) is measured as contributing nothing instead of
  throwing mid-reduction and turning the command into `status: error`, and
  such a field is never dropped for zero progress. A result that cannot be
  copied or serialized at all (a function value, a BigInt, a cycle, a
  graph too deep) yields the skeleton plus a warning naming the reason,
  keeping the command's real status instead of reporting `status: error`.
  `buildEnvelope` deep-copies `extra` before any reduction, so the
  caller's object, and for `doctor` the `-f text` rendering built from
  that same object, is never mutated by a shallow-spread aliasing bug.

- **CLI output and error mapping.** stdout is written and drained through
  the write callback before the process exits, instead of exiting right
  after `write()` returns, which could truncate output larger than the
  pipe buffer. The callback's own error argument is now honoured: a
  non-EPIPE write failure exits `2` with one line on stderr naming it,
  EPIPE keeps the command's own exit code and says nothing, and the
  stream's `'error'` listener stays as defense in depth. `-f text` output
  never exceeds `-m`: its truncation marker names the full length, and
  below the marker's own size the marker itself is cut short instead of
  overshooting the requested bound. Commander's usage errors are
  intercepted and emitted as a JSON `usage_error` result with exit `2`;
  a non-commander, non-usage error reports `status: "error"` through the
  exported `mapTopLevelError` (no test-only env seam in shipped code);
  `-C` at a missing or non-directory path is a usage error; `-f text` is
  one shared renderer with a pretty-JSON fallback for commands without
  one.

- **`doctor`.** `-r`/`-o` entries are rejected as a usage error when they
  are not a plain binary name, which blocks `../` traversal into an
  arbitrary `--version` execution. `version` is reported only when there
  is one, so a binary that runs but prints nothing no longer ships an
  undefined-valued property. A `--version` capture that times out is
  recorded as `versionCheck: "timed_out"` with a warning rather than read
  as silent, empty output, and all captures share one aggregate deadline
  (default 3000ms); once it is spent, remaining tools are still checked
  for presence but their capture is skipped
  (`versionCheck: "skipped_deadline"`) with one summary warning.

- **`exec`.** The log write stream carries an error listener and surfaces
  a failure as `logWriteFailed`/`logWriteError` on `ExecResult` instead of
  crashing on an unhandled `'error'` event. stdout/stderr decoding uses
  `StringDecoder`, so a multi-byte character split across two chunks no
  longer becomes a replacement character.

- **Tests.** Every CLI test spawns through one shared helper that hands
  the child a PATH of exactly four resolved binaries (node, npm, git, sh),
  a fixed temp directory, and no inherited environment, and that attaches
  its readers before returning rather than after a sleep. The suite's
  assertions are therefore about this CLI rather than about what the host
  happens to have installed or how fast it happens to be.

### Added

- Initial package scaffold: the shared envelope module (bounded
  serialization, status-to-exit-code mapping), an `exec` runner with fixed
  output tails, a `hash` helper, commander error interception (usage errors
  become a JSON `usage_error` result, exit 2), and a working `doctor`
  subcommand. `probe`, `verify`, and `init` exist as stubs returning
  `not_implemented`; later releases fill them in.
