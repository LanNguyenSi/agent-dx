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

```bash
npx agent-primitives doctor
```

For a binary that stays on `PATH`, so that a subagent started as an
ordinary child process finds it too:

```bash
npm install -g agent-primitives
agent-primitives doctor
```

To work on the package itself, build it from source:

```bash
git clone https://github.com/LanNguyenSi/agent-dx.git
cd agent-dx/packages/agent-primitives
npm install
npm run build
node dist/cli.js doctor
```

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
- `--json`: a no-op alias for `-f json` (already the default), for the
  common instinct to ask for JSON explicitly. Combined with an explicit
  `-f text` it is `status: "usage_error"`, `reason: "format_conflict"`,
  exit `2`; `-f json --json` is accepted, since the two agree.

An unrecognized option's message names a common alias when it has one
(`--text` -> use `-f text`; `--json` is itself a real global option, so
it never reaches this hint), and an invalid `-f`/`--format` value that
looks like a path adds a hint that `-f` is the global `--format` and
`probe`'s file option is `--file`.

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
warning names how many were skipped. A `git-version` check reads the
installed git against what `probe -i worktree` relies on: it is ok from
git 2.36 on, and below that a warning names what the probe does on that
git (below 2.35 the worktree sync cannot run at all; between 2.35 and
2.36 the worktree listing falls back to its newline-separated form; see
the `probe` section). The `stale-worktree` check reads the same
listing, with the same fallback; when the listing cannot run in any
form, a warning says that a leftover registered worktree cannot be
reported, rather than the check reading as clean. A scratch worktree a
live probe owns (its `owner.json` names an alive pid and is within 24
hours of the clock) is not a leftover: the check stays ok and a hint
names the worktree, the pid, the record, and the bound; past that
bound the worktree is reported as a leftover with the manual command.
The bound cuts both ways: a probe whose own run outlives it, or a clock
that moves by more than it, can have its worktree removed by a
concurrent probe under another lock directory, and that run then ends
with `baseline_failed` rather than a verdict.

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
agent-primitives probe -p mutant.patch -t 'npm test'
agent-primitives verify -c build,typecheck,lint,test
agent-primitives doctor
```

The third form needs neither `--file` nor `-n`. `--file` is derived from
the single path the patch touches (resolved against the containment
root) when the patch touches exactly one. `-n` is not derived at all:
the reported `mutant.line` is the first line at which the patch's
applied result differs from the original, taken from the dry run itself,
so the line number and the `before` content quoted beside it always name
the same line -- whatever the diff's shape (leading context or none, a
removed `---`, an added `++`, a pure deletion, several hunks). Passing
`-n` alongside `-p` neither moves the mutation nor changes what is
reported; when it names a different line than the patch changes, both
numbers appear in a warning.

A patch touching two or more paths without an explicit `--file` is
`status: "usage_error"`, `reason: "patch_file_ambiguous"`, exit `2`,
naming the touched paths in a warning; pass `--file` naming the one to
mutate to resolve it (the extra-path refusal below then applies as it
always has). `-p, --patch` naming a path that cannot be used at all
(missing, not a regular file -- a directory, a FIFO, a socket --
unreadable permissions, or over the 8&nbsp;MiB `PATCH_MAX_BYTES` cap) is
`status: "usage_error"`, `reason: "patch_not_readable"`, exit `2`,
whether or not `--file`/`-n` were also given. A patch that changes no
content at all (a rename-only patch, say) has nothing for a mutation
probe to mutate: its derived `--file` is the rename's destination, which
does not exist yet, so it ends in `reason: "file_not_found"`.

A patch made with `git diff --relative` from a subdirectory records
paths relative to that subdirectory, not the repository root; the
derivation above always resolves the derived `--file` against the
containment root, so a patch made that way ends in
`reason: "file_not_found"` rather than being detected as mis-based.

`file_required` and `line_required` are `reason` values a library
caller of `probe()` can see when it omits `--file`/`-n` for a form that
cannot derive them; the CLI never emits either, since `requireFileAndLine`
(see `cli.ts`) rejects that case before `probe()` is even called.

`-i worktree` is the default: `--file` is mutated in a detached git
worktree, never in the working tree itself. Every git invocation this
mode makes (the worktree add, the tracked-diff capture and apply, the
untracked-file listing, and the worktree removal) runs through an argv
array with no shell involved, the same as `-p`'s patch path: a `--file`,
`--log-dir`, or `--link` value containing `$(...)` or a backtick reaches
`git` as one opaque argument, never as something a shell could expand.

`-i worktree` needs git 2.35 or newer: the sync relies on `git apply
--allow-empty`, which an older git rejects, so the run ends in
`inconclusive`/`worktree_sync_failed`, never a verdict (`-i inplace` has
no such floor). From git 2.36 on, the worktree listing behind the
removal, the leftover recovery, and `doctor` runs as `git worktree list
--porcelain -z`; on an older git it falls back to the newline-separated
`--porcelain` form, and a worktree path containing a newline is then
reported as unparseable rather than misread. `git worktree remove`
itself dates from git 2.17 and `git worktree list --porcelain` from
2.7; 2.20 is the oldest release the fallback listing, the removal, the
leftover recovery, and `doctor`'s report were checked against.
`agent-primitives doctor` reports the installed git against both floors
(see its `git-version` check).

Each run gets its own scratch subdirectory under `--log-dir`
(`<log-dir>/wt-<random>/`), never a fixed name reused across separate
invocations that happen to share `--log-dir`: a fixed name plus a
previous run's leftover content is exactly how a stale diff would get
replayed into a fresh, clean-tree worktree. Before the mutation runs,
the worktree is synced to look like the actual working tree, not just
`HEAD`: uncommitted tracked modifications are captured with `git diff
HEAD --binary --output=<scratch file>` (written by `git` directly to
that file, never through this process's own output capture, so a
binary hunk's bytes are never at risk of UTF-8 decoding) and replayed
with `git -C <worktree> apply --allow-empty` (run unconditionally, even
against an empty diff, so a clean tree exercises the same steps as a
dirty one); the file count in `isolation.syncedTrackedFiles` comes from
a separate `git diff HEAD --numstat -z`, never from scanning the diff's
own text.

Every untracked, non-ignored path (`git ls-files --others
--exclude-standard`) is synced by its own type: a regular file is
copied; a symlink (including a dangling one) is recreated as a symlink
pointing at the same target, never followed; a directory that is itself
a git repository (the only shape `git ls-files` reports a directory
path in at all) is skipped, named in a warning, rather than pulling in
an unrelated checkout; any other entry is skipped, named in a warning
of its own. A path inside `--log-dir` itself (this probe's own scratch
space, including the worktree just created) is never treated as a
source to sync; that is decided by where the entry itself sits, so an
untracked symlink that merely points into `--log-dir` is recreated
like any other symlink. `isolation.syncedUntrackedFiles` counts the
`ls-files` entries this sync acted on, not the number of files that
ended up on disk -- a skipped entry still counts as one. A gitignored
`--file` is therefore never synced either way (not tracked, and
excluded by `--exclude-standard`); probing one under `-i worktree`
fails fast with `reason: "target_not_synced"` rather than a raw file-not-
found further into the run. `--allow-outside` is rejected outright as a
usage error (`reason: "worktree_allow_outside_unsupported"`) when
combined with `-i worktree`: its placement is relative to the
containment root, which has no meaning once re-based onto a worktree
copy. Submodule contents are not synced by any of the above; a
submodule directory is tracked as a gitlink, not walked into.

Every `node_modules` directory or directory symlink (e.g. a hoisted or
workspace-linked install) found in the source tree up to 3 levels deep
(never one nested inside another `node_modules`) is symlinked into the
worktree at the same relative path, alongside every `--link` extra, so
installed dependencies and tool caches are shared rather than
reinstalled per probe. `--pre`/`-t` run with their cwd mapped onto the
worktree at `--cwd`'s own relative offset from the containment root.
Any non-zero exit while syncing, or a genuine filesystem failure while
copying/linking, is `status: "inconclusive"`, `reason:
"worktree_sync_failed"`, exit `2`, never a verdict.

The sync runs under the same abort machinery as `--pre`/`-t`: every git
call it makes is killed on `SIGINT`/`SIGTERM` and waited for before
anything removes the worktree underneath it, and the untracked-file copy
checks the abort between batches rather than running to the end of the
listing. A sync stopped that way is `reason: "aborted"` for a library
caller, never `worktree_sync_failed`; on the CLI the signal handler ends
the process first, so nothing is printed (see the signals section
above). The worktree is removed on normal completion, on any error,
and on `SIGINT`/`SIGTERM`, including a signal that lands while the sync
is still running or while `git worktree add` itself is: whatever is on
disk at the path is deleted, then `git worktree remove --force --force`
runs (with the directory gone git accepts a missing worktree, and the
second `--force` clears the `locked` registration an interrupted add
leaves behind, which a single `--force` refuses and `git worktree
prune` skips), then `git worktree prune`; the outcome is then checked
against `git worktree list` and the disk rather than read off an exit
code, and a removal that did not take keeps the repository-keyed marker
and adds a warning naming the path and the manual command. When
`git worktree list` cannot run in EITHER form (a git that rejects `-z`
and then also fails the newline-separated fallback, or one whose
`worktree list` is broken outright, whatever the option), a third
source stands in before the registry is given up as unknown: every
`<git-common-dir>/worktrees/<id>/gitdir` file is read directly, no
`git worktree list` invocation at all, since `git rev-parse
--git-common-dir` (already relied on to find that directory for the
half-written-entry repair below) still answers when the listing itself
is dead. This source lists LINKED worktrees only -- git's admin
directory carries no entry for the main worktree, so it is never
reported by this form -- and it does not know `locked` or `prunable`
the way `git worktree list` does, so an admin entry a real listing
would have pruned is read the same as a live one, UNLESS its own
target directory no longer exists on disk, in which case it is kept
apart from the paths that do (never folded in as though still
registered): a stale entry naming a worktree `cleanupWorktree` just
removed must read as gone, not as still there. A `gitdir` file written
relative to its own admin entry directory (`worktree.useRelativePaths`,
git &gt;= 2.48) is resolved against that directory -- git's own
semantics for the file, never the calling process's working
directory -- so it is read the same as an absolute one, not treated as
odd. An entry whose `gitdir` file is missing, unreadable, or empty
makes the WHOLE listing not ok rather than being silently dropped from
an otherwise ok one, named by id and reason instead: an ok result from
this source means every admin entry was read to a parse, so an entry's
absence from the paths it lists can be trusted to mean it really is
gone, not merely that this source could not read it. Once this source
can list something (ok), the removal is asserted against it exactly as
it would be against a genuine `git worktree list` -- which also makes
a scratch-shaped worktree this source reports as registered eligible
for removal even when it sits outside the current run's `--log-dir`,
the same as one a real `git worktree list` reported -- `cleanupWorktree`'s
half-written-entry repair (below) having already had its own chance
against the real listing failure first, since that repair fixes git's
own admin state for every future listing on the repository, which a
read-only fallback cannot do. When this source cannot run either
(`git rev-parse` itself
fails, or the repository has no `worktrees/` admin directory to read
at all -- true of a repository that has never had a linked worktree,
and also true right after the LAST linked worktree of a repository is
removed, since `git worktree prune` deletes the now-empty `worktrees/`
directory itself), the registry is unknown rather than "still
registered": the removal is judged by the disk alone (never by
`git worktree remove`'s exit status, which is non-zero for a path git
never registered, the very leftover an add killed early leaves), a
warning reports it as done but unverified, and the marker is cleared,
so a git that cannot list never turns a removal that took into a
`stale_worktree` on every later run. A leftover still on disk after
such an unverified removal keeps the marker and is reported with the
marker file as the escape, not with the manual `git worktree remove`,
which cannot be relied on for a path whose registration is unknown.
The one state git cannot recover from on its own, an entry the add
left half-written (its `commondir` present but still empty, which
makes every `git worktree` command in the repository fail), is cleared
by removing that entry from the repository's `worktrees` administrative
directory, and only when it names the probe's own worktree. That marker
is written before `git worktree add` runs and records the `--log-dir`,
so a `SIGKILL` or a crash at any point from there on leaves it, along
with whatever git had registered by then, and `agent-primitives doctor`
reports the leftover as a `stale-worktree` check naming the path and
the manual command. `doctor` reads git's own `git worktree list` as
well as the marker, so a marker deleted by hand still leaves the
registration reported, and the next `probe -i worktree` run on the same
repository removes every such leftover before it starts (a warning
names `recovered_stale_worktree`), marker or not. Each scratch
directory also carries an `owner.json` recording the pid of the probe
that created it and when: a registered scratch worktree whose owner is
still alive under a record within 24 hours of the clock is a probe in
flight under another `AGENT_PRIMITIVES_LOCK_DIR` (the lock serializes
probes within one lock directory only), which the recovery names in a
warning and leaves alone and `doctor` names in a hint (the pid, the
path, the record, and the bound). A record older than that no longer
vouches for its worktree whatever its pid says, since a probe's
worktree lives for one run and a pid can be recycled: the worktree is
a leftover again, removed by the next run and reported by `doctor`
with the manual command. `doctor`'s own `stale-worktree` check applies
the same 24-hour bound to the repository-keyed worktree MARKER too,
against the marker's own `timestamp` field (written when the marker is
created, never the marker file's mtime): a marker whose pid is still
alive but whose own timestamp is past the bound is treated as stale
regardless, the same as a dead pid, since an alive pid a marker
happens to name proves nothing about whether ITS probe is still
running once its own record is this old. The worktree-marker recovery
`probe -i worktree` itself runs before its own baseline never consults
a marker's pid at all, alive or dead, past the bound or not: the lock
already excludes a second live probe on the same repository under the
same lock directory before that recovery ever runs, so any marker
found there is unfinished work from a run that is definitely over.
Only a path of
the probe's own scratch shape (`<log-dir>/wt-<uuid>/wt`, the uuid in
its 8-4-4-4-12 hex layout) that git reports as a worktree of the
repository, or that sits under the recovering run's own `--log-dir`, is
ever deleted; the `--log-dir` a marker recorded is never the directory
a marker's path is checked against, since a marker that supplied both
the path and the root would certify itself, and a path whose
registration could not be checked is deleted only under the run's own
`--log-dir` as well. A marker naming anything else, or a leftover that
cannot be removed, stops the run with `reason: "stale_worktree"`,
keeps the marker, and names the path and either the manual command or
the marker file to delete. The lock for `worktree`
is keyed on the repository root rather than on `--file` (two probes on
the same repository serialize, which also covers the shared, linked
node_modules caches, and matches `-i inplace`'s own lock key whenever
`--cwd` is inside a repository); the in-flight marker and its automatic
recovery described below apply only to `inplace`, since nothing in the
original tree is ever mutated by a `worktree` probe -- the
repository-keyed lock/marker above is what covers a `worktree` probe's
own leftover-on-crash case instead. Outside a git work tree, `worktree`
falls back to `inplace` with a warning naming the fallback, never an
error.

`-i inplace` backs up the target file before mutating it and restores
from that backup afterward (on normal completion, on any error, and on
`SIGINT`/`SIGTERM`; on a signal the CLI then ends the process, while the
exported `probe()` restores and returns control instead, unless the
caller passes `exitOnSignal: true`).

`--file` is long-only (the global `-f` is `--format`), and every global
option (`-f`, `-C`, `-m`, `-l`) may precede the subcommand. Exactly one
mutant form is required: `-r, --replace` (replace the whole line),
`-M, --match` with `-w, --with` (replace the first occurrence of a
substring on the line), or `-p, --patch` (apply a unified diff via
`git apply`, applied against the worktree for `-i worktree`, against
the working tree itself for `-i inplace`). `--file` and `-n, --line`
are required for `-r` and for `-M`/`-w`, which have nothing to derive
them from; `-p` alone needs neither, as described above.

The dist trap: a project whose test command runs built output
(`dist/`, `lib/`, ...) rather than `--file` itself needs `--pre` to
rebuild before every test invocation, or a real mutant never reaches the
code the test actually runs and is misreported as `survived`:

```bash
agent-primitives probe --file src/foo.js -n 12 -r 'return false;' \
  -t 'npm test' --pre 'npm run build'
```

`agent-primitives doctor` reports a `dist/` directory sitting next to
`src/` as a hint that a probe on that project may need `--pre`.

`-i inplace` mutates the working tree directly and restores it from a
backup afterward (on normal completion, on any error, and on
`SIGINT`/`SIGTERM`, as the signals section above describes); because
`SIGKILL` cannot be trapped, a probe killed outright while `-i inplace`
is running can leave the mutation in place, which is why `worktree` is
the default rather than `inplace`: a `worktree` probe killed the same
way leaves the original tree untouched. The in-flight marker and its
hash-verified recovery described above apply to `-i inplace`; a
`worktree` probe's leftover is covered by the repository-keyed marker,
git's own registry, and `doctor` as described in this section.

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
anything else. Whatever child was in flight (a `--pre`, a `-t`, the
`git apply` of a `-p` mutant, or one of the git calls the `worktree`
sync makes) is killed with `SIGKILL` on its whole
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
dry run. `-p` touching two or more paths with no explicit `--file` to
say which one is the target is `status: "usage_error"`,
`reason: "patch_file_ambiguous"`, exit `2`. `-p, --patch` naming a path
that cannot be used (missing, not a regular file -- a directory, a
FIFO, a socket -- unreadable permissions, or larger than the 8&nbsp;MiB
`PATCH_MAX_BYTES` cap) is `status: "usage_error"`,
`reason: "patch_not_readable"`, exit `2`, decided once up front from the
path's metadata alone (a `stat` for the kind of file and its size, an
access check for the permissions; nothing in this process ever opens the
patch, so a FIFO cannot block it and a large file is never loaded) and
before the containment check, the lock, the in-flight marker or any
worktree, so a refusal leaves nothing behind and applies the same
whether `--file` was given explicitly or is derived from the patch.

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

Installs this package's own skill document into a harness's skill
directory, so an agent working in the target repository is told when to
reach for `probe`, `verify`, and `doctor` (see `assets/skill/SKILL.md`).

```bash
agent-primitives init
agent-primitives init -H claude,codex -t /path/to/some/repo
agent-primitives init -H all --force
```

- `-H, --harness <list>`: comma-separated `claude`, `codex`, `opencode`,
  or the single value `all` (default: `claude`). Writes to
  `<target>/.claude/skills/agent-primitives/SKILL.md`,
  `<target>/.agents/skills/agent-primitives/SKILL.md`, and
  `<target>/.opencode/skills/agent-primitives/SKILL.md` respectively.
  `init` never writes anywhere under `.claude/agents/`: that directory
  belongs to a different installer (orchestrator-workflow) and carries
  its own role prompts and manifest hashes.
- `-t, --target-dir <dir>`: the directory the harness-specific paths
  above are resolved under (defaults to `-C`/`--cwd`, itself defaulting
  to the process cwd). Any missing directory on the way to the target
  (`-t` itself included, and the harness's own skill subdirectory on a
  first run) is created rather than treated as an error.
- `--force`: overwrite a conflicting existing file instead of reporting
  it as `conflicted`.

Semantics mirror a standard kit installer's write-if-new-or-unedited
convention: a target that does not exist yet, or exists with
byte-identical content, is written (or reported `unchanged`) with no
further action, exit `0`. A target that exists with different content
is reported `conflicted`, exit `1`, and left untouched, unless `--force`
is given, in which case it is overwritten and reported `written`, exit
`0`. Every requested harness's target is validated against
`--target-dir` before anything is written: containment, a symlink, a
directory or another entry that is not a regular file already sitting
at the target file path, and, under `--force`, write access to a target
whose content differs from the skill being installed are all checked up
front, so a condition of that kind on one harness (for example a
pre-existing symlink, or `.claude` itself pointing outside
`--target-dir`) refuses the whole invocation, exit `2`, with nothing
written for any harness. Write access is checked only where a write is
actually due: a read-only target that already holds exactly this skill
needs no write and is reported `unchanged`, exit `0`, under `--force`
as well, and the other requested harnesses are installed alongside it.
A condition that only shows up during the write itself, such as a
symlink planted in the gap between validation and the write, can still
leave a prefix of the requested harnesses written; the envelope's own
`targets` field then lists whatever was written or found unchanged
before the failure. A symlink at the target file path itself is
refused the same way, whether it dangles, resolves inside or outside
`--target-dir`, and whether or not `--force` is given: a target is
never written through a symlink. This containment guarantee is about
symbolic links specifically; a hard link at the target path is
indistinguishable from a plain regular file and is written through like
one. An entry that is neither a regular file nor a directory (a FIFO, a
socket, a device node) is refused by its type instead of being read or
written, so a FIFO at the target path cannot block the run. `-t` naming
a file instead of a directory, a directory sitting at the target file
path, an entry there that is not a regular file, an existing target
that is not writable, a symlink at the target file path, a resolved
target that escapes `--target-dir`, and a platform whose `fs.constants`
offers no usable `O_NOFOLLOW` for the write's symlink guard are each
reported as `status: "usage_error"`, exit `2`, with a `reason` naming
which one it was (`target_not_a_directory`,
`target_path_is_a_directory`, `target_not_a_regular_file`,
`target_not_readable`, `target_not_writable`, `target_write_failed`,
`target_is_a_symlink`, `target_escapes_directory`, `platform_unsupported`)
instead of a raw
filesystem error message. `target_not_readable` covers both permission
denials while reading and read failures that have no portable errno mapping,
so even an oversized target retains an `init`-specific envelope. Before
reporting an existing file `unchanged`, `init` re-stats and re-reads it; a
target removed or rewritten after validation is therefore written again or
reported conflicted rather than accepted from stale data. Writes account for
the byte count returned by each filesystem call and continue after a short
write; a zero-progress write is `target_write_failed`, never an unbounded
loop. An absent final path is claimed with `O_EXCL`; if another process creates
it first, `init` revalidates and applies the normal unchanged/conflict rules
instead of truncating it. Truncation remains limited to an explicitly forced
replacement of a differing regular file. The platform check is scoped to
`init` and runs when `init` is called, so `probe`, `verify`, and `doctor` stay
usable on such a platform.

Output beside the envelope: `status` (`written`, `unchanged`, or
`conflicted`, the worst outcome across every requested harness) and
`targets: [{ harness, path, status }]`, one entry per requested harness.
A usage-error envelope from a filesystem condition at the target also
carries `targets`, naming whatever harness or harnesses were already
installed before the error (empty when the error was caught by
validation before any write).

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
