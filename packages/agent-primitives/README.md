# agent-primitives

`agent-primitives` is an agent-first CLI: JSON on stdout by default, one
bounded result object per invocation, and stable exit codes (`0` ok, `1`
finding, `2` cannot conclude, including a usage error). It exists to remove
a few recurring failure classes in agent-driven review and implementation
work: hand-edited mutation probes that forget to restore a file, verify
output that blows past a harness's output cap, and "which binary is even on
PATH" guesswork.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and
tooling for teams shipping with AI agents.

Unlike its sibling packages, `agent-primitives` defaults to JSON output
(`-f, --format text` opts into a human-readable rendering instead), because
its primary caller is another agent, not a terminal.

## Install

This package is not published yet. Build it from source:

```bash
git clone https://github.com/LanNguyenSi/agent-dx.git
cd agent-dx/packages/agent-primitives
npm install
npm run build
node dist/cli.js doctor
```

Once published, the usual `npx agent-primitives doctor` / `npm install -g
agent-primitives` paths will work too.

Requires Node >= 20.

## Global options

Every subcommand accepts:

- `-f, --format <format>`: `json` (default) or `text`.
- `-C, --cwd <dir>`: working directory (defaults to the process cwd).
- `-m, --max-chars <n>`: requested bound on the serialized result
  (default `8000`). A result that would exceed it is reduced
  structurally, never by cutting the JSON text: four caps derived from the
  bound (how many characters of a string, how many elements of an array,
  how many keys of an object, and how deep a subtree is kept) are applied
  in one pass over the result, and a bounded search over a single scale
  factor driving all four picks the largest setting that fits. Every
  cut is marked in place with an honest count: a trailing array element,
  a `...` key in an object, a suffix on a string, a placeholder for a
  pruned subtree, each naming how much of the original is missing. Equally
  sized siblings are therefore cut alike, and a large collection is
  trimmed entry by entry rather than deleted whole. An object key is kept
  whole or its entry is dropped; a result keyed by very long strings
  therefore reduces on the key count alone. Depth is part of the
  search as well, so a result too deeply nested to fit at any width comes
  back as a shallower sketch of itself, each pruned subtree naming the
  depth it was cut at, instead of vanishing; when not even the shallowest
  structure fits, a warning says the result was reduced to the fixed
  fields alone and points at the full result on disk. The full untruncated
  result is written to the log directory and its path returned in `logs`.
  The reduction reads no clock and does no work proportional to how far
  over the bound a result is: within one process the same result always
  yields the same envelope, and between processes the only thing that
  differs is the run id in the full-result path. A handful of fixed fields
  (`tool`, `version`, `command`, `status`, `durationMs`, `cwd`,
  `truncated`, `logs`, `warnings`) are held out of the reduction entirely
  and lead the serialized object, so the real bound is `max(-m, size of
  those fixed fields)`, not `-m` unconditionally; when even that cannot be
  honored, a warning names the envelope's true final length instead of
  silently exceeding what was asked for. `-f text` output is bounded the
  same way and never exceeds `-m`: its truncation marker names the full
  length, and below the marker's own size the marker itself is cut short.
- `-l, --log-dir <dir>`: directory for logs and full (untruncated)
  results (defaults to `$AGENT_PRIMITIVES_LOG_DIR`, or a fresh directory
  under the OS temp dir otherwise).

## `doctor`

Checks that a fixed list of required and optional binaries are on `PATH`,
captures each found binary's `--version`, and reports a few environment
checks (an installed `node_modules`, whether the cwd is inside a git work
tree, `BASH_MAX_OUTPUT_LENGTH` if set, and whether a `dist/` directory sits
next to `src/`, which hints that a test suite executing built output may
need a rebuild step first). Version captures share one aggregate deadline
(default 3000ms) across every tool combined; once it is spent, remaining
tools are still checked for presence on `PATH`, but their `--version`
capture is skipped rather than each paying its own timeout, and one
warning names how many were skipped.

```bash
agent-primitives doctor
agent-primitives doctor -r git,node,npm,rg -o ast-grep,jq,yq,fd
```

Exits `1` when a required binary is missing.

## `verify`

Runs a fixed set of named checks (`build`, `typecheck`, `lint`, `test` by
default) and reports a compact, bounded summary instead of raw tool output.

```bash
agent-primitives verify
agent-primitives verify -c typecheck,test
agent-primitives verify -x lint='eslint . --format stylish' --fail-fast
```

- `-c, --checks <list>`: comma-separated check names, in run order
  (default `build,typecheck,lint,test`, deduplicated preserving the first
  occurrence; build before typecheck, matching the CI convention of
  building before typechecking against built output).
- `-x, --exec <name=command>`: override a check's command (repeatable; a
  name that is not in the run list is still run, appended in the order
  given). Its value executes as a shell command; never fill it from
  untrusted text (repository content, issue or PR text, or any other
  content that did not come from the trusted caller).
- `--fail-fast`: stop after the first check that fails or errors; a
  skipped check falls through instead of stopping the run; the next
  check's command is never invoked once a real failure or error stops it.
- `--timeout <s>`: per-check timeout in seconds (no timeout by default).
- `--max-failures <n>`: caps each check's own `failures` list, a positive
  integer, default `20`; a cut sets `truncated: true` and writes the full,
  uncapped result to the log directory.

Every resolved check name, from `-c` and from `-x` alike, is validated
against a conservative pattern (letters, digits, `_`, `.`, `:`, `-`) before
any command is built; a name outside that pattern is `status:
"usage_error"`, exit `2`, and is never run.

Check resolution, per name: an `-x` override wins; otherwise a matching
`package.json` `scripts[name]` runs as `npm run <name> --silent`; a name
with neither resolves to `status: "skipped"`. When the resolved check list
is empty (e.g. `-c ''`), or every requested check resolves to `skipped`,
the run is `status: "error"` with `reason: "nothing_verified"`, exit `2`,
and a warning, never a silent pass. A shell exit of `126` (not executable)
or `127` (not found) is `status: "error"`, never `"fail"`: it means the
check itself could not run, not that it ran and found a problem; the same
is true when the exec layer itself fails to even start a check at all
(e.g. an unwritable log directory): that check is `status: "error"` with
a synthetic failure naming the error, and the run continues. Every
check's output is run through a detector: candidate detectors are
consulted first by output shape, and the fallback detector (`generic` by
default) is used whenever none, or more than one, of them matches; command
text is only ever a tiebreaker among two or more matching candidates,
matched on whole-token boundaries, and only when it names exactly one of
them, otherwise the fallback is chosen and a warning lists the candidate
shapes seen. The default candidates parse `vitest` (the `Tests` summary
line, parsed segment-wise: whichever of `failed`/`passed`/`expected
fail`/`skipped`/`todo` vitest included, in any combination, e.g. `Tests  N
failed | M passed (T)`, `Tests  N passed (N)`, or `Tests  N skipped (N)`;
`expected fail` (an `it.fails` test that failed as expected, i.e. still a
pass) is folded into `summary.passed`, and `skipped`/`todo` both count
into `summary.skipped`; the ` FAIL  file > name` block with its assertion
on the next line, or ` FAIL  file [ file ]` with no name for a file that
failed to collect (a broken import); the `No test files found` case; and
the `Tests  no tests` case a failed collection also prints; this detector
does not parse vitest's separate `Type Errors`, `Errors`, or `Leaks`
summary lines, so a run whose only failure signal is one of those is left
to the failures invariant below instead of adding to `summary`), `tsc`
(`file(line,col): error TSnnnn: message`, identically whether or not
`--pretty false` was passed explicitly, since a non-interactive `tsc`
never colorizes on its own either way; `summary.errors` counts the
diagnostics), and `eslint`'s stylish formatter (a file header line, then
`line:col  severity  message[  rule]`; `error` rows populate `failures`,
with the rule id appended to the message when the row carries one, and
omitted for a rule-less row such as a `Parsing error: ...`; `warning` rows
count into `summary.warnings` alone and never become a failure, even on a
zero-exit check). No reporter flags are injected: whichever of these three
shapes a check's own script happens to print is parsed as-is; a check that
emits more than one shape at once (a `pretest` build followed by `vitest`,
say) is ambiguous and falls back to `generic`, same as any other ambiguous
case. Every file-path capture across the three detectors is matched
structurally (up to the shape's own separator, such as vitest's ` > ` or
tsc's `(line,col):`), never merely up to the first whitespace, so a path
containing a space is still captured whole. ANSI color codes are stripped
before any of these three detectors matches or parses, since a tool run in
a fully non-interactive environment can still default to colorized output
(only SGR sequences are stripped; none of these three tools' default text
output emits cursor-movement or other non-SGR escape sequences). eslint 10
(a devDependency, used only for this package's own lint check and for the
`eslint` detector's fixtures) requires Node `^20.19.0 || ^22.13.0 ||
>=24`, narrower than the `>=20` this package itself requires; that floor
applies to developing this package, not to a caller running the built CLI.
Whatever the detector, a check that ends `fail` or `error` with zero
parsed failures always gets one synthetic failure entry (naming
`timedOut`, or the exit code, plus the output tail) instead of shipping an
empty `failures` list, and an `error` check always reports at least one
`summary.errors`; this synthetic entry is added on top of whatever count
the detector already reported, never doubling a count the detector already
got right. Truncation is read from exec.ts's own
`stdoutTruncated`/`stderrTruncated` flags (set when the command's real
output, at either its own 60-line or 6000-character-per-stream bound,
exceeded what the captured tail could keep), never recomputed from the
tail text itself: a captured tail that happens to end with a trailing
newline is not a reliable way to tell a truncated tail from an untruncated
one, since the phantom empty element a trailing newline leaves behind
after splitting on it is not a real line. When either flag is set, a
detector's own issue-row count can undercount the real total; the eslint
detector's own reported total is preferred, when the eslint detector was
the one selected for this check, where one can still be found in the tail
(eslint's `✖ N problems (N errors, M warnings)` line, which survives most
truncation since it is the last thing eslint prints); either way a warning
names the truncation, since the `failures` list itself can still be
missing entries even when the total is trustworthy. A detector's own
warnings, and a log file the run could not write to, are reported in the
top-level `warnings`, each prefixed with the check name.

Overall `status` is `error` if any check errored, else `fail` if any check
failed, else `pass`; `error` wins over `fail`. Exit code follows `status`
the same way every other subcommand's does.

`SIGINT` and `SIGTERM` are handled for every subcommand: the CLI kills
the command it is running with `SIGKILL` on that command's whole process
group, waits for that run to settle (so whatever the killed command had
in flight has landed), and then exits `130` or `143`. There is no
`SIGTERM` grace on this path, because a command that traps `SIGTERM`
would sit the grace out and the escalation that would eventually reach it
dies with the process that is exiting. Each command runs in a process
group of its own, so a terminal's Ctrl-C reaches the CLI alone; without
this a check's own worker would outlive the Ctrl-C that ended the CLI.
`probe` owns the two signals for as long as it runs, since it also has a
mutated file to restore and a lock to release before the process may end.

The exported `verify()` reports a run stopped that way rather than
guessing at it: the check that was running becomes `status: "error"` with
a failure naming the abort (never a synthesized `exit code null`
finding), every check queued behind it is left unstarted and named in a
warning, and the result carries `reason: "aborted"`. The CLI prints none
of that on a signal (see below).

## `probe`

Runs one mutation probe: mutate a line (or apply a patch), confirm the
unmutated test passes first (the baseline; there is no `--no-baseline`,
because a probe whose test was never shown to pass unmutated is not a
probe), run the test against the mutant, restore the file, and classify
the result.

```bash
agent-primitives probe --file src/foo.js -n 12 -r 'return false;' \
  -t 'npm test'
agent-primitives probe --file src/foo.js -n 12 -M 'n > 0' -w 'n >= 0' \
  -t 'npm test' -i inplace
agent-primitives probe --file src/foo.js -n 1 -p mutant.patch -t 'npm test'
```

`-i worktree` is the default: `--file` is mutated in a detached git
worktree (`git worktree add --detach` under `--log-dir`), never in the
working tree itself. Before the mutation runs, the worktree is synced to
look like the actual working tree, not just `HEAD`: uncommitted tracked
modifications are captured with `git diff HEAD --binary` (written to
`<log-dir>/tracked.diff`) and replayed with `git -C <worktree> apply
--allow-empty` (run unconditionally, even against an empty diff, so a
clean tree exercises the same two exec calls as a dirty one), and every
untracked, non-ignored file (`git ls-files --others --exclude-standard`)
is copied to the same relative path -- including an untracked target or
test file, which would otherwise be invisible to the probe and produce a
false `survived`. Every `node_modules` directory found in the source tree
up to 3 levels deep (never one nested inside another `node_modules`) is
symlinked into the worktree at the same relative path, alongside every
`--link` extra, so installed dependencies and tool caches are shared
rather than reinstalled per probe. `--pre`/`-t` run with their cwd mapped
onto the worktree at `--cwd`'s own relative offset from the containment
root. Any non-zero exit while syncing (the worktree add, the tracked-diff
apply, or the untracked-file listing) or a filesystem failure while
copying/linking is `status: "inconclusive"`, `reason:
"worktree_sync_failed"`, exit `2`, never a verdict. The worktree is
removed (`git worktree remove --force` then `git worktree prune`) on
normal completion, on any error, and on `SIGINT`/`SIGTERM`; a `SIGKILL`
(or a crash) leaves it registered, and the next `probe -i worktree` run on
the same repository recovers it automatically (a warning names
`recovered_stale_worktree`), or `agent-primitives doctor` reports it as a
`stale-worktree` check naming the leftover path and the manual `git
worktree remove`/`prune` command. The lock for `worktree` is keyed on the
repository root rather than on `--file` (two probes on the same
repository serialize, which also covers the shared, linked node_modules
caches); the in-flight marker and its automatic recovery described below
apply only to `inplace`, since nothing in the original tree is ever
mutated by a `worktree` probe -- the repository-keyed lock/marker above
is what covers a `worktree` probe's own leftover-on-crash case instead.
Outside a git work tree, `worktree` falls back to `inplace` with a
warning naming the fallback, never an error.

`-i inplace` backs up the target file before mutating it and restores
from that backup afterward (on normal completion, on any error, and on
`SIGINT`/`SIGTERM`; on a signal the CLI then ends the process, while the
exported `probe()` restores and returns control instead, unless the
caller passes `exitOnSignal: true`).

`--file` is long-only (the global `-f` is `--format`). Exactly one mutant
form is required: `-r, --replace` (replace the whole line), `-M, --match`
with `-w, --with` (replace the first occurrence of a substring on the
line), or `-p, --patch` (apply a unified diff via `git apply`, applied
against the worktree for `-i worktree`, against the working tree itself
for `-i inplace`).

`-t` and `--pre` are shell commands, executed through `sh -c` as given,
so neither may be filled from untrusted text (an issue body, a model's
output, a file in the tree under test); `-p`'s patch path is not, and is
handed to `git apply` as one element of an argv array with no shell
involved, so a path containing `$(...)` or a backtick is a path and
nothing else.

`--file` and every `--link` entry must resolve inside the git work-tree
root (or inside the cwd when not in a repo), unless `--allow-outside` is
passed; otherwise the result is `status: "inconclusive"`,
`reason: "file_outside_root"`, exit `2`.

`--pre <command>` runs (e.g. a rebuild) before each test invocation, in
both the baseline and mutant runs, and in the invocation cwd (not the
containment root, so a probe run from a subdirectory of a monorepo sees
the same cwd its test command normally would): needed whenever the test
executes built output (`dist/`) rather than the source file being
mutated, otherwise the mutant never reaches the test and the probe
reports a false `survived`. A non-zero `--pre` exit in either run is
`status: "inconclusive"`, `reason: "pre_failed"`, exit `2`, never a
verdict. `--timeout <seconds>` bounds every `--pre`/`-t` invocation (both
the baseline and the mutant run); a run that hits it is killed and
reported as `timedOut: true` on that run's own phase (`baseline` or
`test`), so a killed baseline is distinguishable from one that genuinely
failed. It also bounds every `git apply` the `-p` form runs (the path
check, the dry run, and the real apply); with no `--timeout` those keep a
fixed ten-second bound of their own, so an apply that hangs cannot leave
the probe sitting under an in-flight marker forever. An apply killed by
that bound is `status: "inconclusive"`, `reason: "git_apply_timeout"`,
exit `2`, kept apart from `mutant_not_applicable`, which means the patch
itself did not apply.

Every `--pre`/`-t` invocation runs in a process group of its own, and the
timeout, `SIGINT`, and `SIGTERM` all signal that whole group: the timeout
sends `SIGTERM` and escalates to `SIGKILL` after a short grace, while a
signal sends `SIGKILL` outright. A worker the command spawned
therefore dies with it instead of outliving the run while still holding
its stdout and stderr, which is what would otherwise stretch a bounded
run to the descendant's own lifetime and leave a process writing to the
target while the restore is happening. What that does not cover is a
descendant that puts itself in a process group of its own: it is out of
reach of the group signal, and the run then settles a short grace after
the command's own process exits rather than waiting on the pipes. A run
that settles that way may be missing whatever was still in flight on
those pipes, and both `probe` and `verify` say so in a warning instead of
presenting the captured tail as the whole output. On the signal path
specifically, the restore paragraph below does not stop at this flush
grace: it waits further, and bounded, for the pipes to actually close
before treating the restore as final.

A probe stopped by `SIGINT`/`SIGTERM` restores the target before it does
anything else. Whatever child was in flight (a `--pre`, a `-t`, or the
`git apply` of a `-p` mutant) is killed with `SIGKILL` on its whole
process group; the handler then waits, bounded, for that child's stdio
to truly close, not merely for the run's own promise to settle (which
the flush grace above can do early), and only then copies the backup
back and hash-verifies it. The restore is therefore the last write to
the target for every process still in the command's own process group,
including one that traps `SIGTERM` and an interrupted `git apply`. A
descendant that left the group is covered too, for as long as it holds
the command's stdio open: the same bounded wait applies to it. One that
both leaves the group and detaches its own stdio, or that writes after
the bound expires, is beyond what this wait can cover. In that bounded
case the target is still restored, but the marker (and its backup) are
kept rather than removed, even though the restore itself already
landed: a write that lands later would otherwise leave no trail, so the
marker stays, `doctor` reports it, and the next `probe` on that target
recovers from the hash-verified backup the same way it already does for
any other in-flight marker.

What the caller sees splits by caller. The exported `probe()` (or a
library caller's own abort) returns `status: "inconclusive"`,
`reason: "aborted"` in either phase, never a `killed`/`survived` verdict:
the interrupted test child exits non-zero, which under `--expect fail`
would otherwise read exactly like a mutant the suite caught. A baseline
stopped the same way is `aborted` rather than `baseline_failed`, for the
same reason: nothing was learned about the test, the run was stopped. The
CLI never prints that envelope: on a signal it restores, releases the
lock, and exits `130` or `143` with no output, because a signal is the
operator saying stop rather than asking for a result.

Probes are serialized against each other by a lock file outside the
repository (`$AGENT_PRIMITIVES_LOCK_DIR` or
`<tmpdir>/agent-primitives-<uid>/locks/`, created `0700` and owned by the
current user), keyed on the repository's work-tree root: an `inplace`
probe mutates the one working tree that every probe in that repository
builds and tests in, so two of them are not independent even when their
target files differ. Outside a repository there is no shared tree, and
the lock is keyed on the target file itself. A second probe started while
one is running is refused rather than queued: `status: "inconclusive"`,
`reason: "probe_in_progress"`, exit `2`. A lock directory this process
cannot trust (wrong owner, unwritable, or a created level owned by
another user) gets `reason: "lock_unavailable"`, exit `2`, instead of a
raw filesystem error. If a probe is killed outright (`SIGKILL` or a
crash) mid-mutation, it leaves an in-flight marker behind; the next
probe on that same target recovers automatically (restores from the
recorded backup, verifies by hash, adds a `recovered_stale_probe`
warning) when it can prove two things: that the file is still in the
exact mutated state the marker describes, and that the recorded backup
still hashes to the pre-mutation content the marker recorded. That second
check happens before any copy, because the copy is destructive: a backup
that no longer matches would otherwise be written over the target,
destroying the only remaining copy of the mutated file. When either proof
fails, the probe refuses with `reason: "stale_probe_marker"`, leaves the
target exactly as it found it, and names the backup path for a human to
inspect. The backup lives under the probe's own `--log-dir` (a per-run
scratch directory, not something a crash is guaranteed to have left
behind); when it is gone, automatic recovery is not possible and the
warning says so and names the marker file itself instead -- delete that
file to clear it manually. `agent-primitives doctor` also reports any
such marker left for the current repository, and applies the same two
proofs before it says anything about automatic recovery: it hashes the
recorded backup and compares the target, points at re-running `probe`
only for a marker the next probe would really recover, and names the
marker file and the manual delete for every other one; it compares the
marker's target against
the current repository with both paths fully resolved, so a symlinked
ancestor cannot hide a marker that is really there.

The target file is backed up immediately, before the baseline ever runs,
and the backup is verified against the file's pre-mutation hash; a backup
that does not match is `status: "inconclusive"`,
`reason: "backup_verification_failed"`, exit `2`, before anything is
mutated. If the baseline itself fails and also rewrote the target, the
backup is kept rather than discarded, and a warning names it: it holds
the only remaining copy of the target's pre-baseline content. After
the baseline passes, the target is re-hashed; if it no longer matches
(a formatter or codegen step run as part of the baseline rewrote it),
the probe aborts with `status: "inconclusive"`,
`reason: "target_changed_during_baseline"`, exit `2`, before any
mutation or marker is created, and leaves the target exactly as the
baseline run wrote it (never restored, since that write was not this
probe's own).

A failed restore (the backup or the target became unwritable) is
terminal: `status: "inconclusive"`, `reason: "restore_failed"`, exit `2`,
never a `killed`/`survived` verdict, with a warning naming the absolute
backup path; the in-flight marker is left in place on a failed restore
(deliberately, for the same manual recovery described above) and removed
only once a restore is hash-verified.

A mutant whose applied content does not hash to what the dry run
predicted is `status: "inconclusive"`, `reason: "apply_hash_mismatch"`,
exit `2`, carrying `mutation_probe` with its real `restored_verified`:
the mutation is undone and the restore verified first, and the mismatch
is reported as a verdict the caller can read rather than raised as an
error.

`--file` naming a path that does not exist is `status: "usage_error"`,
`reason: "file_not_found"`, exit `2`, with the resolved path in a
warning. `-p, --patch` combined with `--allow-outside` is rejected
outright as `status: "usage_error"`,
`reason: "patch_allow_outside_unsupported"`, exit `2`: a patch's own
relative paths could otherwise escape the scratch directory used for its
dry run.

Output beside the envelope: `status` (`killed`, `survived`, or
`inconclusive`), `reason` (when inconclusive), `mutant: { file, line,
before, after, form }`, `mutation_probe: { mutant, verified_applied_via,
result, restored_verified }` (paste straight into an implementer's
`mutation_probes` output field), `baseline: { exitCode, durationMs,
logPath, timedOut }`, `test: { command, exitCode, durationMs, timedOut,
stdoutTail, stderrTail, logPath }`, `isolation: { mode, path, linked,
syncedTrackedFiles, syncedUntrackedFiles }` (`path` is the worktree
directory for `worktree`, `null` for `inplace`; `linked` lists the
absolute source-tree paths symlinked in; `syncedTrackedFiles` and
`syncedUntrackedFiles` are counts, `0` for both on a clean tree and for
every `inplace` run).

## `init`

Not yet implemented. It currently returns a JSON result with
`status: "usage_error"` and `reason: "not_implemented"`, exit `2`, rather
than doing nothing silently or claiming success.

## Output shape

Every result carries a common envelope (`tool`, `version`, `command`,
`status`, `durationMs`, `cwd`, `truncated`, `logs`, `warnings`) first, in
that order, followed by the subcommand-specific fields. `status` classes
into `ok` (exit 0), `finding` (exit 1), or `cannot-conclude` (exit 2,
includes `usage_error`), so a caller can gate on the exit code alone
without parsing the body.

The same machinery is importable for callers building their own bounded
output: `buildEnvelope` produces the whole envelope, and `applyCaps`
applies the four structural caps (`CapLimits`) to a plain object in one
pass, returning a new structure with every cut marked in place.
