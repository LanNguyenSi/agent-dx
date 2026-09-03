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
- `verify` gains three output-shape detectors, registered as
  `DEFAULT_DETECTORS` (the default when a caller passes none): `vitest`
  (the `Tests` summary line, parsed segment-wise so any combination of
  `failed`/`passed`/`expected fail`/`skipped`/`todo` vitest prints is
  read correctly, including an all-failing, all-skipped, or `it.fails`
  run, `expected fail` folded into `summary.passed`; ` FAIL  file > name`
  blocks with the assertion on the following line, or ` FAIL  file [
  file ]` with no name for a file that fails to collect; and the `No
  test files found` / `Tests  no tests` cases), `tsc` (`file(line,col):
  error TSnnnn: message`, identically whether or not `--pretty false` was
  passed; `summary.errors` counts the diagnostics), and `eslint`'s
  stylish formatter (a file header line, structurally matched so a path
  containing a space is still recognized; `line:col  severity  message[
  rule]` rows, the rule id optional so a rule-less row such as a
  `Parsing error: ...` is still a failure; `error` rows populate
  `failures`, `warning` rows count into `summary.warnings` alone and
  never become a failure). Every file-path capture across the three
  detectors is structural (up to the shape's own separator), never
  `\S+`. No reporter flags are injected; a check whose output carries
  more than one of these shapes at once (e.g. a `pretest` build followed
  by `vitest`) is ambiguous and falls back to `generic`, listing the
  shapes seen, the same as any other ambiguous selection. All three strip
  ANSI SGR color codes before matching or parsing, since a tool can
  default to colorized output even outside a real terminal (the Node
  floor eslint needs to develop against is documented once, in the
  package README's `verify` section). Truncation is read from exec.ts's
  own `stdoutTruncated`/`stderrTruncated` flags, never recomputed from
  the tail text itself (a tail that happens to end with a trailing
  newline is not a reliable way to tell a truncated tail from an
  untruncated one). When either flag is set, eslint's own reported total
  is preferred, only when the eslint detector was selected for that
  check, where one survives in the tail (eslint's `✖ N problems` line);
  either way a warning names the truncation, since the `failures` list
  itself can still be missing entries even when a trustworthy total was
  found. The failures invariant only adds its synthetic entry's count on
  top of a detector-reported 0, never doubling an already-correct count.
  Captured real-tool-output fixtures and one live integration test per
  tool (run through this package's own installed devDependency) live
  under `test/fixtures/`.

### Fixed

- **`probe -i worktree` on an older git, and across lock directories.** The
  worktree listing behind the removal's assertion, the leftover recovery,
  and `doctor` no longer requires `git worktree list --porcelain -z`: when
  git rejects `-z` (a release older than 2.36), the newline-separated
  `--porcelain` form runs instead and is parsed against the fixed attribute
  order, so a worktree path containing a newline is reported as unparseable
  rather than misread, a block that ends after its `worktree` line alone
  (the shape such a path takes when its newline reads as a block boundary)
  refused with the rest instead of registering a phantom path. A listing
  that cannot run in any form is an unknown registry, never "still
  registered": the removal is then judged by the disk alone (never by `git
  worktree remove`'s exit status, which is non-zero for a path git never
  registered, so a marker naming such a path is recovered instead of
  stopping every later run), reported as done but unverified in a warning,
  and the marker is cleared, so a git that cannot list no longer turns a
  removal that took into a `stale_worktree` on every later run; a leftover
  still on disk after an unverified removal is reported with the marker file
  as the escape, since the manual `git worktree remove` cannot be relied on
  when the registration is unknown; the recovery and `doctor` say in a
  warning that a leftover registration could not be checked for. The
  worktree sync's own floor is git 2.35 (`git apply --allow-empty`); both
  floors are documented in the README, and `doctor` gained a `git-version`
  check that reads the installed git against them and warns below 2.36. Each
  scratch directory now carries an `owner.json` with the creating probe's
  pid and a timestamp, written before the add runs: the recovery and
  `doctor` skip a registered or marker-named scratch worktree whose owner is
  still alive under a record within 24 hours of the clock, the recovery
  naming it as a live probe under another `AGENT_PRIMITIVES_LOCK_DIR` in a
  warning and `doctor` in a hint (the pid, the path, the record, and the
  bound) rather than removing it (the lock serializes probes within one lock
  directory only), and the removal gate refuses such a path outright; a
  record past that bound no longer vouches for its worktree whatever its pid
  says, so the worktree is a leftover again, removed by the next run and
  reported by `doctor` with the manual command. A path git does not report
  is now checked against the recovering run's own `--log-dir`, never against
  the log dir a marker recorded, so a marker cannot certify its own
  containment; the scratch-shape check pins the uuid's 8-4-4-4-12 hex layout
  instead of any 36 characters of the class.

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
  longer becomes a replacement character. A run that settles on the
  stream flush grace rather than on `close` (something the command left
  behind is still holding the stdio pipes) reports
  `outputMayBeIncomplete: true`, so output dropped at that moment is
  stated instead of silently missing; `probe` and `verify` both surface
  it as a warning.

- **`probe`: patches are applied without a shell.** All three `git apply`
  invocations (the `--numstat` path check, the dry run, and the real
  apply) run through a small argv-array runner instead of being built as
  `sh -c` strings. A `-p` path is caller-supplied, and `sh` expands
  `$(...)` and backticks inside double quotes, so no quoting of such a
  path into a shell string is safe. The `--numstat` check also reads the
  command's whole output rather than a tail, and refuses a listing that
  did not fit instead of checking the patch's paths against a fragment.

- **`probe`: an interrupted run is `inconclusive`/`aborted`.** In both the
  baseline and the mutant phase, a run stopped by `SIGINT`/`SIGTERM` or
  by a caller's abort classifies as `status: "inconclusive"`,
  `reason: "aborted"`, never `killed`/`survived` and never a plain
  `baseline_failed`: the interrupted test child exits non-zero, which
  under `--expect fail` is indistinguishable from a mutant the suite
  caught.

- **CLI signal handling.** `SIGINT`/`SIGTERM` are handled for every
  subcommand: the in-flight command is aborted (which `SIGKILL`s its whole
  process group), the CLI waits for that run to settle, and the process
  then exits `130`/`143`, instead of a Ctrl-C ending the CLI and orphaning
  the worker its check had spawned. `verify()` gains an optional `signal`
  threaded to `exec.ts`. `probe` owns the two signals for the duration of
  its call, since it also has a mutated file to restore before the process
  may end.

- **The emergency restore is the last write to the target.** On
  `SIGINT`/`SIGTERM`, `probe` no longer sends `SIGTERM` and exits: it
  `SIGKILL`s the in-flight child's whole process group outright, waits
  (bounded) for that run to settle, and only then restores, verifies the
  restore by hash, removes the marker and releases the lock. A test
  command that traps `SIGTERM` used to sit out the grace period, outlive
  the exit (the escalation timer died with the process that scheduled it),
  and write over the restored file; the same held for a descendant that
  put itself out of the group's reach. Both are covered by tests that let
  such a writer run and assert the target's content afterwards.
  `ExecOptions.signal` and the new `RunArgvOptions.signal` both kill with
  `SIGKILL` and no grace for this reason; the timeout path still sends
  `SIGTERM` first.

- **The emergency restore waits for true stdio closure, not just for the
  run's own promise to settle.** `exec`'s flush-grace shortcut lets that
  promise resolve while a descendant that left the process group still
  holds the command's stdio open, and `probe`'s signal handler used to
  await that same promise: a write landing after the shortcut but before
  the descendant actually closed its pipes could land after the restore,
  with the marker already gone. The handler now waits, bounded, for the
  pipes to genuinely close (`exec` and `runArgv` both expose this: an
  additive `stdioClosed` field on their result, and `exec` also takes an
  `onStdioClosed` callback fired exactly on that closure, independent of
  when its own promise settles). When the bound expires with the pipes
  still open, the target is still restored, but the marker and its
  backup are deliberately kept rather than removed: `doctor` reports the
  marker as stale, and the next `probe` on that target recovers from the
  hash-verified backup the same way it already does for any other
  in-flight marker, including when the target already matches the
  marker's own pre-mutation hash. Also fixed: the signal handler's own
  restore-then-exit no longer races the normal control flow's return.
  Every point where the normal flow detects that a run it started was
  aborted now checks whether the handler has already taken over; if so,
  it defers to the handler's own outcome instead of restoring a second
  time, and in the CLI it never returns at all, so the handler's own
  exit is always what ends the process. Before this, an aborted run
  could resolve fast enough that the CLI printed an inconclusive/aborted
  envelope and exited `2` instead of ending with `130`/`143` and no
  output, depending on how long the killed command took to actually die.

- **`probe`: every `git apply` is abortable and bounded by `--timeout`.**
  The path check, the dry run, and the real apply now take the probe's
  own signal, so an interrupted apply is killed rather than left to land
  on the target after the restore has already put the original back (with
  the marker gone). `--timeout` bounds them too; with no `--timeout` they
  keep the fixed ten-second bound they always had. An apply killed by that
  bound reports `reason: "git_apply_timeout"`, and one killed by the
  signal reports `reason: "aborted"`, instead of both being reported as a
  patch that failed to parse or to apply.

- **`verify`: an aborted run says so.** `options.signal` now stops the
  run instead of only killing the current command: the check that was
  running is reported as `status: "error"` with a failure naming the
  abort (never the failures invariant's synthesized `exit code null`
  entry), no further check is started, the ones that never ran are named
  in a warning, and the result carries `reason: "aborted"`.

- **`probe`: the lock is keyed on the repository.** An `inplace` probe
  mutates the one working tree that every probe in that repository builds
  and tests in, so two probes on different files in one repository are
  not independent; the second is now refused with
  `reason: "probe_in_progress"` the way a second probe on the same file
  always was. Outside a repository the target path remains the lock's
  identity. Markers stay keyed per target file.

- **`doctor`: the stale-marker hint applies probe's own recovery rule.**
  It hashes the recorded backup and compares the target before pointing
  at automatic recovery, instead of splitting on whether the backup file
  still exists. A marker whose backup no longer matches the pre-mutation
  hash it records, or whose target has moved on from the state it
  describes, is one the next probe refuses, and doctor now names the
  marker file and the manual delete for it rather than promising a
  recovery that will fail.

- **Tests.** The `O_EXCL` backup-name claim in `isolation.ts` is pinned
  through an injected `open`, which makes the name appear exactly in the
  window between choosing it and opening it: the session claims the next
  name and the other session's backup is left intact. `exec`'s
  flush-grace settle path is pinned by a command whose descendant puts
  itself in a process group of its own and holds the stdio pipes, and the
  library-mode signal path (including `exitOnSignal`'s default) by a
  spawned library caller that is sent `SIGTERM` mid-probe. Every CLI test
  spawns through one shared helper that hands
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

- `probe`: restore now runs in the pipeline's
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

- `probe`: the target is backed up (and the backup verified against its
  pre-mutation hash) immediately, before the baseline ever runs, instead
  of afterward; a target rewritten by the baseline itself (a formatter
  or codegen step) is caught by a post-baseline re-hash and reported as
  `inconclusive`/`target_changed_during_baseline` before any mutation or
  marker exists, leaving the target exactly as the baseline left it. A
  missing `--file` is `usage_error`/`file_not_found` (naming the path)
  instead of an uncaught filesystem error surfacing under an unknown
  command. `mutant_not_applicable` always carries a one-line reason
  (line out of range, substring not found, an identical replacement, or
  why a patch did not apply) and always returns its dry-run log paths,
  including the baseline's own `--pre` log; the mutant-phase `pre_failed`
  path now also reports `mutation_probe` with its real
  `restored_verified`. The `SIGINT`/`SIGTERM` handler now kills the
  in-flight `--pre`/`-t` child (via a new, additive `signal` option on
  `execCommand`) before restoring, instead of leaving it running after
  the process exits; the `finally` backstop's warning names the error
  that actually triggered it. The in-flight backup's name is now claimed
  atomically (`O_EXCL`) instead of via a check-then-copy that could race
  two sessions in the same log dir. The lock directory check now
  validates every level it had to create (not just the leaf) for
  ownership and permissive mode, since a level above the leaf sits
  directly under a shared, world-writable `/tmp`. `doctor`'s stale-marker
  hint, and the marker-recovery path itself, only promise auto-recovery
  when the backup still exists; when it is gone, both name the marker
  file for a manual delete instead. The baseline phase now reports its
  own `timedOut`, so a killed baseline is distinguishable from one that
  genuinely failed.
- `probe`: stale-marker recovery now hashes the recorded backup and
  requires it to match the marker's own pre-mutation hash BEFORE copying
  anything over the target. A corrupt, truncated, or foreign backup was
  previously written over the target first and only found out afterward,
  destroying the only remaining copy of the mutated file while reporting
  `stale_probe_marker` as though nothing had been touched; the refusal now
  names both the backup and the marker file and leaves the target alone.
  A failing baseline that also rewrote the target keeps its backup (named
  in a warning) instead of discarding the only copy of the pre-baseline
  content silently. A post-apply hash mismatch is
  `inconclusive`/`apply_hash_mismatch` carrying `mutation_probe` with its
  real `restored_verified`, instead of throwing out of `probe()` and
  surfacing as `status: "error"` under an unknown command. A `-p` patch
  that touches a second path is now diagnosed by `git apply --numstat`
  before the scratch dry run, so a patch modifying another file that
  exists in the repository is reported as touching paths other than
  `--file` rather than as a patch that did not apply. The exported
  `probe()` no longer ends the host process on `SIGINT`/`SIGTERM` unless
  the caller opts in with `exitOnSignal` (the CLI does); the emergency
  restore and lock release happen either way.

- `exec`: commands run in a process group of their own (`detached`), and
  both `--timeout` and `options.signal` signal that whole group (the
  timeout with `SIGTERM` then `SIGKILL` after a grace; the abort path with
  `SIGKILL`, see the entry above). A worker the command spawned no longer
  survives the kill while holding the run's stdout and stderr open, which
  stretched a bounded run to the descendant's own lifetime and left a
  process writing to a probe's target during the restore. Settling is
  driven by the command's own `exit` plus a bounded flush grace rather
  than unconditionally by `close`, so a descendant in a process group of
  its own cannot hold the call open either. `ExecResult` is unchanged
  apart from the additive `aborted`.

- `doctor`: the stale-probe-marker check resolves both the current
  repository's containment root and the marker's target path before
  comparing them, so a symlinked ancestor (`/tmp` against `/private/tmp`,
  a symlinked checkout) no longer reports "no stale probe markers" while
  one is sitting there.

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

- `probe` subcommand (`inplace` isolation): the full mutation-probe
  pipeline (lock, containment, stale-marker recovery, baseline, apply,
  `--pre`/test, restore, hash verification, classify) for all three
  mutant forms (`-r, --replace`, `-M, --match` with `-w, --with`,
  `-p, --patch` via `git apply`). A per-target lock (`src/lock.ts`,
  `O_EXCL`, stale-pid reclaim) outside the repository serializes
  concurrent probes on the same file; an in-flight marker written before
  mutation lets the next invocation recover automatically from a
  `SIGKILL`/crash mid-mutation, or refuse with `stale_probe_marker`
  naming the backup path when it cannot prove that recovery is safe.
  Restore runs on normal completion, on any thrown error, and on
  `SIGINT`/`SIGTERM`; a failed restore is terminal (`restore_failed`,
  exit 2, never a `killed`/`survived` verdict). `doctor`'s `checks`
  gained a `stale-probe-marker` entry for the current repository.

- `probe`'s `worktree` isolation (now the default `-i`): the mutation
  runs inside a detached git worktree, never the working tree itself.
  Every git invocation this mode makes runs through an argv array with
  no shell involved (the same runner `-p, --patch` already used), so a
  `--file`, `--log-dir`, or `--link` value reaches `git` as one opaque
  argument regardless of its characters. Each run gets its own scratch
  subdirectory under `--log-dir` (`<log-dir>/wt-<random>/`), never a
  fixed name reused across invocations that happen to share `--log-dir`.
  The worktree is synced to the actual working tree state, not just
  `HEAD`: tracked modifications are captured with `git diff HEAD
  --binary --output=<scratch file>` (written by git directly to that
  file, never through this process's own output capture) and replayed
  with `git -C <worktree> apply --allow-empty` -- run unconditionally,
  even against an empty diff, so a clean tree and a dirty one exercise
  the same steps; the file count reported in `isolation.syncedTrackedFiles`
  comes from a separate `git diff HEAD --numstat -z`, never from the
  diff's own text. Every untracked, non-ignored path (`git ls-files
  --others --exclude-standard`) is synced by its own type: a regular
  file is copied, a symlink (dangling or not) is recreated as a
  symlink, a directory that is itself a git repository is skipped with
  a warning, any other entry is skipped with a warning naming it, and
  a path inside `--log-dir` itself is never treated as a source (decided
  by where the entry itself sits, so an untracked symlink that merely
  points into `--log-dir` is recreated like any other symlink).
  `isolation.syncedUntrackedFiles` counts the `ls-files` entries acted
  on, not the files that ended up on disk. A gitignored `--file` is
  never synced by either sync step, and probing one under `worktree`
  fails fast with `reason: "target_not_synced"`. `--allow-outside`
  combined with `-i worktree` is a usage error
  (`worktree_allow_outside_unsupported`) rather than a raw path or hash
  failure. Every `node_modules` directory or directory symlink (a
  hoisted or workspace-linked install included) up to 3 levels deep
  (never one nested inside another) is symlinked into the worktree at
  the same relative path, alongside every `--link` extra, reported in
  `isolation.linked`. Any non-zero exit while syncing, or a genuine
  filesystem failure while copying/linking, is
  `inconclusive`/`worktree_sync_failed`, exit 2, never a verdict. The
  whole sync runs under the probe's own abort signal and in-flight
  accounting: every git call it makes is killed when `SIGINT`/`SIGTERM`
  arrives and is waited for before anything removes the worktree
  underneath it, and the untracked-file copy checks the same abort
  between batches instead of running to the end of the listing. A sync
  stopped that way reports `inconclusive`/`aborted`, never
  `worktree_sync_failed`: it is a run that was stopped, not a sync that
  failed (on the CLI the signal handler ends the process first, so the
  result is what a library caller sees). The
  lock and the leftover-worktree marker are keyed on the repository
  root instead of `--file` (two probes on one repository serialize,
  covering the shared, linked node_modules caches, and matching
  `inplace`'s own key whenever `--cwd` is inside a repository); the
  file-keyed in-flight marker from `inplace` is not written at all for
  `worktree`, since nothing in the original tree is ever mutated -- the
  original target's hash is still checked before and after, and a
  mismatch is reported as `worktree_original_tree_modified` rather than
  silently trusted. The worktree is removed on normal completion, on
  any thrown error, and on `SIGINT`/`SIGTERM` (the signal handler and
  the pipeline's own cleanup share one in-flight promise, so neither
  can let the process exit while the other's removal is still running),
  including a signal that lands while the worktree is still being
  synced or while `git worktree add` itself is running: whatever is on
  disk at the path is deleted, then `git worktree remove --force
  --force` runs (with the directory gone git accepts a missing
  worktree, and the second `--force` clears the `locked` registration
  an interrupted add leaves behind, which a single `--force` refuses
  and `git worktree prune` skips), then `git worktree prune`, with the
  outcome asserted against `git worktree list` and the disk rather than
  inferred from an exit code; a removal that did not take keeps the
  repository-keyed marker and adds a warning naming the path and the
  manual command. The one state git cannot recover from on its own, an
  entry the add left half-written (its `commondir` still empty, which
  makes every `git worktree` command in the repository fail), is
  cleared by removing that entry from the repository's `worktrees`
  administrative directory, only when it names the probe's own
  worktree. The marker is written before the add runs and records
  the `--log-dir`, so a `SIGKILL` or a crash at any point from there on
  leaves it, along with whatever git had registered by then; `doctor`
  reports a leftover from the marker and from `git worktree list` (a
  marker deleted by hand still leaves the registration reported), and
  the next `worktree` probe on that repository removes every leftover
  of the probe's own scratch shape before it starts, marker or not.
  Only a path of that shape (`<log-dir>/wt-<uuid>/wt`) that git reports
  as a worktree of the repository, or that sits under the recovering
  run's own `--log-dir`, is ever deleted; a marker naming anything else,
  or a leftover that cannot be removed, stops the run with
  `inconclusive`/`stale_worktree`, keeps the marker, and names the path
  and either the manual command or the marker file to delete. Outside a
  git work tree, `worktree` falls back to `inplace` with a warning
  naming the fallback. `doctor` gained a `stale-worktree` check
  reporting a leftover worktree for the current repository, from the
  marker and from `git worktree list`, naming the manual `git worktree
  remove --force --force` command. Submodule contents are not synced by
  either sync step; a submodule directory is tracked as a gitlink, not
  walked into.

- Initial package scaffold: the shared envelope module (bounded
  serialization, status-to-exit-code mapping), an `exec` runner with fixed
  output tails, a `hash` helper, commander error interception (usage errors
  become a JSON `usage_error` result, exit 2), and a working `doctor`
  subcommand. `probe`, `verify`, and `init` exist as stubs returning
  `not_implemented`; later releases fill them in.
