# Changelog

All notable changes to `agent-primitives` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Round-3 review hardening: the envelope reduction is now one generic,
  progress-guarded loop over the whole (deep-copied) result graph instead
  of a fixed cascade of name-based ladders (`failures`/`message`/`*Tail`)
  plus a 100-iteration hard cut; it caps the largest array anywhere,
  then the longest string anywhere, then drops the largest remaining
  subtree, repeating until the result fits or nothing makes further byte
  progress, with no fixed iteration count. The fixed envelope fields are
  still never touched, so the real invariant is `serializedLength(envelope)
  <= max(maxChars, skeletonFloor)`; whenever the literal requested
  `-m`/`maxChars` cannot be honored, a warning names the envelope's true
  final length instead of silently exceeding it or understating it (the
  warning is computed to a fixed point so its own stated number matches
  what actually ships). `buildEnvelope` deep-copies `extra`
  (`structuredClone`) before any reduction, so the caller's object -
  and, for `doctor`, the `-f text` rendering built from that same
  object - is never mutated by a shallow-spread aliasing bug. The
  `AGENT_PRIMITIVES_TEST_FORCE_RUNTIME_ERROR` test-only env seam is
  removed; the top-level error mapping is now the exported
  `mapTopLevelError` (CommanderError/UsageError -> `usage_error`,
  everything else -> `error`), unit-tested directly. The EPIPE guard maps
  a non-EPIPE stdout write error to one stderr line and exit `2` instead
  of rethrowing (an unhandled crash); `exec`'s log write stream now
  carries an error listener and surfaces a failure as
  `logWriteFailed`/`logWriteError` on `ExecResult` instead of crashing on
  an unhandled `'error'` event. `doctor`'s `--version` captures now share
  one aggregate deadline (default 3000ms) across every tool combined;
  once spent, remaining captures are skipped
  (`versionCheck: "skipped_deadline"`) with one summary warning, instead
  of each tool only paying its own per-tool timeout with no overall
  budget.

- Round-1 review hardening: the envelope hard bound never cuts the fixed
  fields (`tool`, `version`, `command`, `status`, `durationMs`, `cwd`,
  `truncated`, `warnings`, `logs`); `buildEnvelope`'s base fields win over
  a colliding `extra` key instead of the reverse; stdout is written and
  drained (via the write callback, with an EPIPE guard) before the
  process exits, instead of exiting right after `write()` returns, which
  could truncate output larger than the pipe buffer; `doctor`'s `-r`/`-o`
  entries are rejected as a usage error when they are not a plain binary
  name (blocks `../` traversal into an arbitrary `--version` execution);
  an unwritable log directory now pushes a warning instead of failing
  silently; a non-commander, non-usage-error thrown during a command now
  reports `status: "error"` instead of being folded into `usage_error`;
  `-f text` is now a single shared renderer with a pretty-JSON fallback
  for commands without one, bounded by `-m`; `-C` at a missing or
  non-directory path is now a usage error; a `--version` capture that
  times out is recorded as `versionCheck: "timed_out"` with a warning
  rather than read as silent, empty output; `exec`'s stdout/stderr
  decoding uses `StringDecoder` so a multi-byte character split across
  two chunks no longer becomes a replacement character.

### Added

- Initial package scaffold: the shared envelope module (bounded
  serialization, status-to-exit-code mapping), an `exec` runner with fixed
  output tails, a `hash` helper, commander error interception (usage errors
  become a JSON `usage_error` result, exit 2), and a working `doctor`
  subcommand. `probe`, `verify`, and `init` exist as stubs returning
  `not_implemented`; later releases fill them in.
