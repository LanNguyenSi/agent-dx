# Changelog

All notable changes to `agent-primitives` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Round-1 review hardening: the envelope hard bound never cuts the fixed
  fields (`tool`, `version`, `command`, `status`, `durationMs`, `cwd`,
  `truncated`, `warnings`, `logs`), clamping to a skeleton floor with a
  warning instead when `-m` is set below it; `buildEnvelope`'s base
  fields now win over a colliding `extra` key instead of the reverse;
  stdout is written and drained (via the write callback, with an EPIPE
  guard) before the process exits, instead of exiting right after
  `write()` returns, which could truncate output larger than the pipe
  buffer; `doctor`'s `-r`/`-o` entries are rejected as a usage error when
  they are not a plain binary name (blocks `../` traversal into an
  arbitrary `--version` execution); an unwritable log directory now
  pushes a warning instead of failing silently; a non-commander,
  non-usage-error thrown during a command now reports `status: "error"`
  instead of being folded into `usage_error`; `-f text` is now a single
  shared renderer with a pretty-JSON fallback for commands without one,
  bounded by `-m`; `-C` at a missing or non-directory path is now a
  usage error; a `--version` capture that times out is recorded as
  `versionCheck: "timed_out"` with a warning rather than read as silent,
  empty output; `exec`'s stdout/stderr decoding uses `StringDecoder` so a
  multi-byte character split across two chunks no longer becomes a
  replacement character.

### Added

- Initial package scaffold: the shared envelope module (bounded
  serialization, status-to-exit-code mapping), an `exec` runner with fixed
  output tails, a `hash` helper, commander error interception (usage errors
  become a JSON `usage_error` result, exit 2), and a working `doctor`
  subcommand. `probe`, `verify`, and `init` exist as stubs returning
  `not_implemented`; later releases fill them in.
