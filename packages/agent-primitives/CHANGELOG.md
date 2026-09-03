# Changelog

All notable changes to `agent-primitives` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `verify` subcommand core: resolves each named check (`-x` override wins,
  else `package.json` `scripts[name]` as `npm run <name> --silent`, else
  `skipped`), runs `build, typecheck, lint, test` by default (or the `-c`
  list, deduplicated preserving the first occurrence, in order), through
  `exec.ts` with a per-check timeout and log file. Every resolved check
  name is validated against a conservative pattern before any command is
  built; an invalid name is `status: "usage_error"`, exit `2`, never run.
  Shell exit `126`/`127` maps to `status: "error"`, never `"fail"`.
  `--fail-fast` stops after the first check that fails or errors; a
  skipped check falls through instead of stopping the run. When every
  requested check resolves to `skipped`, the run is `status: "error"` with
  `reason: "nothing_verified"`, never a silent pass. Detector selection is
  by output shape first, command text only as a tiebreaker among shape
  matches, and only when it names exactly one of them; otherwise the
  generic detector is chosen and a warning lists the shapes seen. v0 wires
  the `generic` detector (parses no failures out of the text itself), with
  the selection seam left open for tool-specific detectors. The failures
  invariant is enforced once, centrally, for every detector and for both
  `fail` and `error` checks: a check with zero parsed failures always gets
  one synthetic failure entry (naming `timedOut`, or the exit code, plus
  output tail) instead of shipping an empty `failures` list, and an
  `error` check always reports at least one `summary.errors`. A detector's
  own warnings, and a log file the run could not write to, are merged into
  the top-level `warnings`, prefixed with the check name. `--max-failures`
  (a positive integer, default 20) caps each check's own `failures` list,
  failures-first; a cut is reported via `truncated: true` and the full,
  uncapped result is written to the log directory.


### Fixed

- **Envelope bound and reduction.** The bound is met by reducing the
  result's structure, never by cutting the serialized JSON text. The
  deep-copied result is walked once per attempt and four caps derived from
  the bound are applied together: the characters kept of a string, the
  elements kept of an array, the keys kept of an object, and the depth
  kept of a subtree. One scale factor drives all four (the three breadth
  caps linearly, the depth cap one level per halving of the scale), and a
  bounded bisection over that factor (a small, fixed number of attempts,
  each linear in the result and each re-derived from the same pristine
  copy, never from the previous attempt's output) takes the largest scale
  whose envelope fits; the floor of the search is the skeleton itself,
  which fits by construction, so the search always has an answer.
  Consequences worth naming: two equally large sibling values are
  cut alike instead of the first one consuming the whole budget; a wide
  collection is trimmed entry by entry instead of being deleted whole; a
  deeply nested result is reduced to a shallower sketch of itself instead
  of being lost whole, because depth now moves with the search rather than
  sitting at a fixed floor above the smallest structure the search can
  reach; the work done no longer depends on how far over the bound a
  result is, and no clock is read at all, so the envelope is a function of
  the result, the bound, and this process's run id (which reaches it
  through the full-result path in `logs`), and the wall-clock work budget
  (`reductionBudgetMs`) is gone with the loop it guarded. When even the
  shallowest structure the search reaches is over the bound, a depth-only
  fallback tries the last few levels explicitly at the narrowest widths
  and keeps the first sketch that fits; when nothing fits at all, a
  warning states that the result was reduced to the fixed fields alone and
  points at the full result on disk, so a caller can tell "the command
  produced no fields" from "the command's fields did not fit". Every cut
  is marked in band with a count taken from the original: a trailing array
  element, a `...` key in an object, a suffix on a string, and a
  placeholder naming the depth a subtree was pruned at, so kept plus
  omitted always accounts for what was there; entries are rebuilt with
  `Object.defineProperty`, so a result carrying an own `__proto__` key
  (from `JSON.parse`) keeps it as an own property and in that arithmetic
  instead of silently reassigning the rebuilt object's prototype. The
  fixed envelope fields are held apart from the payload for the whole
  reduction and lead the serialized object, so the real invariant is
  `serializedLength(envelope) <= max(maxChars, skeletonFloor)`; whenever
  the literal requested `-m`/`maxChars` cannot be honored, a warning names
  the envelope's true final length, solved exactly (the warning's own
  digits are part of the length it reports) instead of approximated by a
  loop that gave up after a fixed number of tries. A field whose value
  JSON omits (`undefined`, a function) is measured as contributing nothing
  instead of throwing mid-reduction and turning the command into `status:
  error`. A result that cannot be copied or serialized at all (a function
  value, a BigInt, a cycle, a graph too deep) yields the skeleton plus a
  warning naming the reason, keeping the command's real status instead of
  reporting `status: error`. `buildEnvelope` deep-copies `extra` before
  any reduction, so the caller's object, and for `doctor` the `-f text`
  rendering built from that same object, is never mutated by a
  shallow-spread aliasing bug. The full untruncated result is written
  under a file name carrying the run's own id, so two invocations sharing
  one log directory no longer overwrite each other's evidence.

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
  its readers before returning rather than after a sleep. A spawned CLI's
  assertions are therefore about this CLI rather than about what the host
  happens to have installed or how fast it happens to be. The claim is
  about that environment and not about the whole suite: the exec tests
  drive commands through the shell and the EPIPE test reaches for `head`,
  so those additionally use POSIX utilities, through `sh` or by absolute
  path, and the shell loops they run are POSIX constructs rather than
  `seq`.

- `probe` round-2 review hardening: restore now runs in the pipeline's
  own `finally` as a backstop, so a thrown error mid-mutation (not just
  a normal return) still restores and hash-verifies the target before
  re-throwing; `--pre`/`-t` run in the invocation cwd instead of the
  containment root, so a probe from a subdirectory of a monorepo sees
  the same cwd its test command normally would; a non-zero `--pre` exit
  in either the baseline or the mutant run is `inconclusive`/
  `pre_failed`, never a verdict; a marker found under the lock is always
  treated as an unfinished probe regardless of its recorded pid (the
  lock already excludes a second live probe, and pids recycle);
  `--file`/`--link` are resolved with `realpath` before both the
  containment check and the lock/marker key, so an in-repo symlink to an
  outside file can no longer bypass containment; a `-p` patch that
  touches any path other than `--file` (checked via `git apply
  --numstat` after the dry run) is `mutant_not_applicable` instead of
  silently mutating extra files with nothing to restore them; the lock
  directory is uid-scoped (`agent-primitives-<uid>/locks`) and created
  `0700`, and one that exists but is not owned by (or writable by) the
  current user is `inconclusive`/`lock_unavailable` instead of a raw
  filesystem error; `mutation_probe.result` now stays within
  `killed`/`survived`/`inconclusive` (the detail moved to `reason`); the
  baseline, test, and dry-run exec log paths are folded into the
  envelope's `logs`; a whole-line `-r, --replace` mutation preserves the
  target line's own CRLF terminator instead of silently downgrading that
  one line to LF; and `-p` combined with `--allow-outside` is now a
  usage error instead of a scratch-dir path that always fails.

### Added

- `probe` subcommand (`inplace` isolation only; `-i worktree` still
  returns `not_implemented`, a later release flips the default): the full
  mutation-probe pipeline (lock, containment, stale-marker recovery,
  baseline, apply, `--pre`/test, restore, hash verification, classify)
  for all three mutant forms (`-r, --replace`, `-M, --match` with
  `-w, --with`, `-p, --patch` via `git apply`). A per-target lock
  (`src/lock.ts`, `O_EXCL`, stale-pid reclaim) outside the repository
  serializes concurrent probes on the same file; an in-flight marker
  written before mutation lets the next invocation recover automatically
  from a `SIGKILL`/crash mid-mutation, or refuse with
  `stale_probe_marker` naming the backup path when it cannot prove that
  recovery is safe. Restore runs on normal completion, on any thrown
  error, and on `SIGINT`/`SIGTERM`; a failed restore is terminal
  (`restore_failed`, exit 2, never a `killed`/`survived` verdict).
  `doctor`'s `checks` gained a `stale-probe-marker` entry for the current
  repository.

- Initial package scaffold: the shared envelope module (bounded
  serialization, status-to-exit-code mapping), an `exec` runner with fixed
  output tails, a `hash` helper, commander error interception (usage errors
  become a JSON `usage_error` result, exit 2), and a working `doctor`
  subcommand. `probe`, `verify`, and `init` exist as stubs returning
  `not_implemented`; later releases fill them in.
