# Changelog

All notable changes to `agent-primitives` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial package scaffold: the shared envelope module (bounded
  serialization, status-to-exit-code mapping), an `exec` runner with fixed
  output tails, a `hash` helper, commander error interception (usage errors
  become a JSON `usage_error` result, exit 2), and a working `doctor`
  subcommand. `probe`, `verify`, and `init` exist as stubs returning
  `not_implemented`; later releases fill them in.
