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
structurally (up to the shape's own separator, such as vitest's `>` or
tsc's `(line,col):`), never merely up to the first whitespace, so a path
containing a space is still captured whole. ANSI color codes are stripped
before any of these three detectors matches or parses, since a tool run in
a fully non-interactive environment can still default to colorized output
(only SGR sequences are stripped; none of these three tools' default text
output emits cursor-movement or other non-SGR escape sequences). eslint 10
(a devDependency, used only for this package's own lint check and for the
`eslint` detector's fixtures) requires Node `^20.19.0 || ^22.13.0 ||

> =24`, narrower than the `>=20`this package itself requires; that floor
applies to developing this package, not to a caller running the built CLI.
Whatever the detector, a check that ends`fail`or`error`with zero
parsed failures always gets one synthetic failure entry (naming`timedOut`, or the exit code, plus the output tail) instead of shipping an
empty `failures`list, and an`error`check always reports at least one`summary.errors`; this synthetic entry is added on top of whatever count
the detector already reported, never doubling a count the detector already
got right. Truncation is read from exec.ts's own
`stdoutTruncated`/`stderrTruncated`flags (set when the command's real
output, at either its own 60-line or 6000-character-per-stream bound,
exceeded what the captured tail could keep), never recomputed from the
tail text itself: a captured tail that happens to end with a trailing
newline is not a reliable way to tell a truncated tail from an untruncated
one, since the phantom empty element a trailing newline leaves behind
after splitting on it is not a real line. When either flag is set, a
detector's own issue-row count can undercount the real total; the eslint
detector's own reported total is preferred, when the eslint detector was
the one selected for this check, where one can still be found in the tail
(eslint's`✖ N problems (N errors, M warnings)`line, which survives most
truncation since it is the last thing eslint prints); either way a warning
names the truncation, since the`failures`list itself can still be
missing entries even when the total is trustworthy. A detector's own
warnings, and a log file the run could not write to, are reported in the
top-level`warnings`, each prefixed with the check name.

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

`--expect` names what the mutant SHOULD do to the test, and `killed`
always means "the mutated test's outcome matched `--expect`", `survived`
always means it did not, whichever direction `--expect` names -- neither
word means "the test passed" or "the test failed" on its own, only
relative to what was expected. Under the default `--expect fail` (a real
mutation-testing probe: the mutant should break a suite that actually
covers the mutated code) `killed` means the mutated run's test exited
non-zero and `survived` means it still exited `0`, the usual mutation-
testing sense. Under `--expect pass` (a negative-control probe: this
mutant must NOT break the suite, because it targets dead code, an
equivalent rewrite, or anything else the suite is not supposed to react
to) the two flip: `killed` means the mutated run's test still exited `0`
(the suite tolerated the mutant, as expected) and `survived` means it
exited non-zero (the suite reacted to something it was not supposed to
react to). A `--plan` mutant's own `expect` (or the plan's, or
`--expect` on the command line; see below) decides which of the two
readings its `killed`/`survived` uses, mutant by mutant.

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

`mutant.line`/`before`/`after` (and the one-line
`mutation_probe.mutant` string built from them) only ever name that
FIRST changed line, even when the patch changes several: reading them
alone as the whole mutant is exactly the mistake to avoid, and for some
shapes they are actively misleading -- a pure one-line deletion or
insertion, or a one-hunk change removing or adding more than one line,
shifts every following line up or down by one, so the naive line-by-line
comparison finds its first disagreement on a line the patch never
touched at all. `mutant.diff` covers the rest, attached whenever the
applied change is anything other than exactly one hunk with exactly one
removed and one added line (the only shape `before`/`after` truly
cover, a like-for-like line replacement): `{ text, path, hunkCount,
removed, added, changedLineCount, truncated, hunkTruncated?,
bodyOmitted? }`, a `git diff --no-index --unified=0` body (every hunk's
header and its added/removed lines, no surrounding context) bounded to
100 lines / 3,000 characters, so the result stays one bounded JSON
object, while `hunkCount`, `removed`, `added` and `changedLineCount`
always report the true totals, uncut.

The bound cuts in this order, and says which of them happened:

- whole hunks are dropped from the end first, so the excerpt ends at a
  hunk boundary: `truncated: true`;
- the two `--- `/`+++ ` preamble lines go before any hunk content does,
  once no whole hunk fits beside them (they name only the comparison's
  own scratch copies);
- when the FIRST hunk alone still exceeds the bound, that hunk is cut
  inside itself, at a line boundary, keeping its `@@` header plus the
  whole body lines that fit: `hunkTruncated: true` beside
  `truncated: true`. The bound applies to every hunk, the first one
  included -- a one-hunk change of any size is bounded like any other;
- when not even the header fits, `text` is `""` and `bodyOmitted: true`
  says so, so an empty string is never delivered as if it were an
  excerpt.

`mutant.diff.path` names the WHOLE applied diff, written to the probe's
own log directory (`mutant-diff-<random>/mutant-diff.patch`) before any
bound ran and never bounded itself; it is in the mutant's own `logs`
too. Whatever either bound leaves out of `text`, that file has. If it
could not be written, `path` is absent and a warning names why.

`mutant.diff.text` is the SINGLE carrier of the excerpt: nothing else in
the result repeats it. `mutation_probe.mutant` names the totals
(`"... (first of 4 changed lines across 1 hunk; see mutant.diff
(truncated); full diff at mutant.diff.path)"`) and, when
`removed !== added` (a pure deletion, a pure
insertion, or a mixed edit), drops the `before -> after` pair rather than
present a false one -- unequal counts mean the two do not correspond to
each other one for one (see `MutantComputed.diff`'s own docblock on why
`before`/`after` can name an untouched neighbour in these shapes).
`mutation_probe.verified_applied_via` is a short, bounded descriptor
pointing at `mutant.diff`, never a second copy of the excerpt: `"git
diff --no-index of the before/after scratch copies: 3 hunks, 6 changed
lines (3 removed, 3 added); see mutant.diff (whole); full diff at
mutant.diff.path"`. Both descriptors end on the same clause, built from
the same field, so they can never make different claims about it: it
names which of the four states above the delivered excerpt is in, and
names `mutant.diff.path` as a field rather than pasting the path itself
(a path is unbounded, and a descriptor that grew with it would be the
excerpt paid for twice again). Both are absent for
`-r`/`-M`/`-w` (which only ever change the one line they are given) and
for an ordinary single-hunk, single-line-replacement patch, so every
such result -- and the identity fixture built from one -- stays
byte-identical. When the excerpt itself could not be computed (an
unreadable `git diff`, or its own output too large to read back in
full), `diff` is absent but a warning names why, rather than the gap
staying silent.

Carrying the excerpt once, rather than in both `mutant.diff.text` and
`verified_applied_via`, is what keeps a multi-hunk result from having to
fit inside `verify`/`probe`'s own default 8,000-character envelope
budget TWICE over. It is not, on its own, a guarantee that the excerpt
survives that budget unmodified: a `--plan` batch of several such
excerpts, or a caller-supplied `-m`/`--max-chars` below the default, can
still make the envelope's own generic string reduction cut `diff.text`
further than `computeAppliedDiffExcerpt`'s own bound already did (that
reduction has no notion of a hunk, and would otherwise cut mid-hunk with
no marker to say so, while `truncated` still read the pre-envelope
`false`). Both `probe` and `probe --plan` correct that after the fact:
once `buildEnvelope` has built the envelope, the CLI walks it (`mutant`
for a single probe, every `plan.results[].mutant` for a plan -- an
array, which the envelope's own `keepWhole` cannot protect a nested
value inside) WITH the pre-envelope result beside it, and compares each
delivered `diff.text` against the one the probe actually produced. Only
a text that differs is corrected, and it is corrected by rebuilding the
excerpt from the original under the same bound rule as above, within the
character budget the delivered text already occupied -- never by
repairing the cut string, and never on the strength of a trailing
omission marker alone (a legitimate excerpt can end in that literal, and
emptying it on that evidence is a false truncation of its own). The
delivered excerpt is therefore always a line-prefix of what the probe
produced, ending at a hunk boundary or, when even the first hunk did not
fit, at a line boundary inside it with `hunkTruncated: true`.
`hunkCount`/`removed`/`added`/`changedLineCount` never change: they were
fixed, to the true totals, before either bound ran, and neither does
`path`, whose file has the whole diff regardless.

Both descriptor strings are rebuilt from the corrected field, so
`mutation_probe.mutant` and `mutation_probe.verified_applied_via` state
the excerpt's delivered state rather than the state it had before the
envelope ran. A descriptor the envelope's own string cap had already cut
is re-capped rather than restored -- restoring it would put back the
characters the reduction removed to meet the bound -- so at a tight
enough `-m` a descriptor can end in the reduction's own omission marker,
carrying no claim about the excerpt at all; what it can never carry is a
stale one.

At a budget tight enough that the whole `diff` object cannot fit at all
(alongside everything else in the result), the generic reduction may
still drop it entirely (a dropped key, or a depth-pruned placeholder)
the same way it would any other oversized field. Nothing is put back
there either, but the descriptors stop pointing at a field that is not
in the result: they say the excerpt was omitted from this envelope and
point at `logs` instead -- the top-level `logs`, specifically: a
protected field the reduction never cuts, which carries the full,
unreduced result's own path whenever anything was cut at all. In
`probe --plan`, a plan entry's OWN `plan.results[i].logs` is a
different field and is capped like any other value on that entry; the
route to the full diff there is the top-level `result-full-<run-id>.json`
the top-level `logs` names instead.

Library callers composing their own envelope get the same correction:
`reconcileEnvelopeDiffTruncation(envelope, { mutant })` for a single
probe result, or `{ planResults }` for a plan's `results` array, both
exported from the package root alongside the `MutantDiffField` type.

When restating a plan's descriptors and excerpts pushes the WHOLE
envelope back over `-m`/`--max-chars` (the correction restores content
`buildEnvelope`'s own generic reduction had cut, which can grow the
result even though no excerpt is longer than it was delivered at), the
excerpts are shrunk again, one mutant at a time, LARGEST CURRENT EXCERPT
FIRST: each is binary-searched down to the largest size that still fits
the whole envelope before the next one is touched at all, rather than
spreading a uniform cut across every mutant in the plan or shrinking
them in whatever order `plan.results` happens to list them; two
excerpts of equal current length keep their `plan.results` order (the
sort is stable). A mutant
whose excerpt already fits is left alone for as long as the ones ahead
of it in size can absorb the deficit on their own; once there is
nothing left here to shrink and the envelope still exceeds `-m`, a
warning names the true final length, the same wording `buildEnvelope`'s
own overrun warning uses.

This re-measure runs even for a mutant whose `diff` was dropped entirely
(no excerpt left to shrink, so nothing is pushed into the shrink search
above): a dropped `diff` with no `path` rewrites its descriptors to the
longer "omitted from this envelope" clause, and that rewrite alone can
push the envelope back over `-m` with no target to shrink it back down.
The re-measure and overrun warning still run in that shape too, rather
than being skipped because there was nothing to shrink. This is
reachable for an envelope a library caller composes itself, or one
handed in from a prior, harsher reduction pass whose `mutant.diff` is
already gone while both descriptors are still pristine (`src/probe/mutant.ts`,
`rewriteProbeDescriptors`, its `wasIntact` check); a sweep of `probe`'s
own single-pass reduction across a range of `-m` values did not produce
this shape (see `test/mutant.test.ts`, the `reconcileEnvelopeDiffTruncation`
describe block's case-3 fixtures) -- do not read this paragraph as a
claim about `probe`/`probe --plan` CLI output.

The same overrun warning is kept honest on the SHRINK side too, not
only the grow side above: when a correction re-cuts an excerpt to a
hunk boundary and that lands shorter than `buildEnvelope`'s own generic
mid-hunk cut, an envelope that was already over `-m` before the
correction ran can end up smaller without the shrink search above ever
running (the shrunk result already sits at or under the envelope's
pre-correction size). A prior "could not be met" warning is still
reconciled against the envelope's TRUE final length in that shape: kept
and restated if the envelope is still over `-m`, or dropped once the
shrink brought it back within bound -- but only a warning about THIS
`-m`: a prior warning that names a DIFFERENT, harsher bound from an
earlier, stricter reduction pass is left untouched either way, since it
remains true regardless of what this correction's own `-m` is (at most
one "could not be met" warning is kept PER bound, not one overall).
Reachability is the same as the case-3 shape above -- a warning next to
a `diff.path`-bearing excerpt is not something `probe`'s own
single-pass reduction produces either (below its skeleton floor the
reduction drops `mutant`, and `diff` with it, before ever appending a
warning; at or above it, the reduction always fits `-m` on its own and
appends none), so this too is reachable only for a library caller's own
composed envelope, or one handed in from a prior, harsher reduction
pass. See the CHANGELOG for the measured shrink/grow numbers this
closes against.

The probe pins its own content-writing git commands with `-c
core.autocrlf=false` and `-c apply.whitespace=nowarn`: the patch dry
run, the real patch apply, the worktree checkout, and the tracked-diff
apply. A machine's global `core.autocrlf` or `apply.whitespace` setting
therefore cannot rewrite content while the probe is checking, applying,
or syncing a mutation. The `mutant.diff` excerpt's own `git diff
--no-index` read is pinned the same way (`-c core.autocrlf=false -c
diff.noprefix=false --no-ext-diff --no-textconv`), so neither a global
`diff.external` nor a `core.attributesFile`-assigned
`diff.<driver>.textconv` can silently swallow or fabricate it.

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
The add that checks out the worktree and the apply that replays the
tracked diff also use the content-write pins above; the capture and
listing calls do not alter checkout content.

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
git 2.48 or newer) is resolved against that directory -- git's own
semantics for the file, never the calling process's working
directory -- so it is read the same as an absolute one, not treated as
odd. An entry whose `gitdir` file is missing, unreadable, or empty
makes the WHOLE listing not ok rather than being silently dropped from
an otherwise ok one, named by id and reason instead: an ok result from
this source means every admin entry was read to a parse, so an entry's
absence from the paths it lists can be trusted to mean it really is
gone, not merely that this source could not read it. The cost of that
all-or-nothing rule: a single unreadable admin entry makes the whole
fallback registry unusable for that repository, so a leftover outside
this run's `--log-dir` is refused rather than removed and a leftover
the registry would otherwise have named is not recovered either; a
manual `git worktree prune` or repair of the unreadable entry restores
it. An entry whose `gitdir` content does not end in `/.git` counts as
unreadable here even though git's own reader would still resolve it
(git writes `<worktree>/.git` itself; only a hand-written entry takes
another shape): the fallback errs toward "unverified", never toward
guessing a worktree path. Once this source
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

`--env NAME=VALUE` (repeatable) sets an environment variable for both
`--pre` and `-t`, in both the baseline and the mutant run (they share one
merged environment, `process.env` plus every `--env` given): the
alternative -- smuggling `HOME=<dir> npx vitest ...` into `-t` itself,
needed whenever the suite under test requires an isolated environment
variable the caller cannot otherwise set for a plain shell command --
is no longer necessary. Every override actually given is echoed back at the run level (`env`) and
under the mutant's `test.env` in the result, so the isolation a caller
asked for is visible in the report rather than only inferable from the
command string. `probe`'s result is routinely pasted into PRs and task
trackers, so a value whose NAME looks like a credential (`TOKEN`,
`SECRET`, `PASSWORD`, `CREDENTIAL` anywhere, case-insensitive, or a name
ending `_KEY`) is redacted to `"<redacted>"` in both echoes before that
happens; every other name's value is echoed verbatim. That name check is
the only guard here: `--env` still passes the real value to the child
process either way, and a credential under a name it does not recognize
is echoed in the clear -- do not pass one through `--env` under a name
this pattern would miss. No `=` at all, or an empty name before it, is a
usage error rather than a silently dropped variable. Not available under
`--plan`: combined with `--plan` it is refused outright as a usage
error, the same way every other single-mutant-only option is.

A baseline that exits `0` but never actually ran a test is never read as
a real pass: both the baseline (before any mutant is even applied) and,
past that, the mutant run itself are checked for known zero-tests
evidence -- vitest's own "No test files found" (no matching file at all)
or a `Tests` summary with nothing `passed` and nothing `failed` (an
all-skipped/all-todo run, the shape a `-t`/name filter that matches no
test inside files vitest still loaded produces), and node's built-in
`--test` runner's own zero-count summary line. Either hit is
`status: "inconclusive"`, `reason: "no_tests_executed"`, exit `2`,
`mutation_probe.result: "not_run"` -- never `"killed"`/`"survived"`, a
verdict that measured nothing. **Both detectors, and the generic
fallback, `--require-baseline-evidence`, and `--pass-regex`, all
described below, only ever see each side's CAPTURED output tail** (the
same 60-line/6000-character bound every exec result reports as
`stdoutTruncated`/`stderrTruncated`), never a command's full, untruncated
output; a summary line, a `--require-baseline-evidence` pattern, or a
`--pass-regex` pattern that scrolled out of the tail reads as a plain
miss, not "not present at all" -- see the truncation paragraph below for
how that is surfaced.

For a test runner neither built-in detector recognizes, a mutant run
whose own verdict rests on a PASS -- exit code `0` by default, or
`--pass-regex`'s own match when that flag is given (a `survived` verdict
under the default `--expect fail`, or a `killed` one under `--expect
pass`: the same silent-pass evidence, just certifying the opposite
verdict) -- additionally falls back to comparing its own output
against the baseline's: byte-identical stdout/stderr on both sides, with
no summary line either detector recognizes on either side either, is
read as "this ran the same nothing twice" rather than a real verdict. A
`survived`/`killed` verdict resting on a FAILING verdict already
carries a real signal (the run itself disagreed with the baseline)
this output-only heuristic has no business second-guessing, whichever
direction `--expect` points. The fallback is further scoped to only when
there is some real output to compare (two empty tails are common and
legitimate -- many hand-rolled test scripts print nothing on a pass,
relying on the exit code alone -- and carry no discriminating signal
either way, so empty output on both sides never triggers it), when
NEITHER side's captured tail was truncated (a byte-identical comparison
of two truncated tails proves nothing about the untruncated output), and
unless a given `--require-baseline-evidence` matched the baseline (see
next). `--pass-regex` does NOT exclude this fallback: a runner whose
custom "pass" text (`--pass-regex` matches it on both runs) is really a
zero-tests-shaped false positive -- a quiet suite that never executed
anything, worded to look like a green summary -- is exactly the shape
this fallback still has to catch, the same as it does for the exit-code
default.

A test command that prints nothing at all on either run is protected by
neither mechanism -- no regex can match empty output, and there is
nothing to compare -- so a genuinely silent suite must be made to print
some real, discriminating evidence (even just an "N tests ran" line)
before either one can protect it.

`--require-baseline-evidence <regex>` is the opt-in safety net for a
suite neither built-in detector recognizes at all: when given, the
baseline's own stdout+stderr (concatenated) must match the pattern
before this run may go on to apply a mutant, whatever the exit code and
the zero-tests detectors said. A miss is
`status: "inconclusive"`, `reason: "baseline_evidence_not_matched"`,
exit `2`, `mutation_probe.result: "not_run"`; when either side of the
baseline's own captured tail was truncated, the warning names which
side, since a pattern that matched output outside the captured tail
would otherwise read as a plain, unexplained miss. The pattern is a bare
JS `RegExp` source with no flags syntax (fold `i`/`m`/`s` into the
pattern itself, e.g. `(?i)` is not supported); an unparseable one is a
usage error before the run ever starts. Unlike `--pass-regex`, this
option's compiled pattern stays flagless (no `m`): `^`/`$` anchor to the
WHOLE combined stdout+stderr buffer, not to each line, so a pattern
copied from a `--pass-regex` recipe (`^OK \(` matching a summary line
that is not the buffer's very first line) silently misses here and
reads as a plain `baseline_evidence_not_matched` -- prefer an unanchored
pattern (drop the leading `^`) for this option instead. Available under `--plan`: a plan
runs every mutant against ONE shared baseline, so there is no
two-sources conflict for this flag to referee (unlike `--env`, which
stays refused there); like `--link` and `--allow-outside` there is no
plan-file key for it, so it is command-line only, and it gates the
plan's own baseline the same way it gates a single probe's -- a miss is
the plan's own top-level `status: "inconclusive"`, `reason:
"baseline_evidence_not_matched"`, before any mutant of the plan is
reached. Once given AND matched against the
baseline, it is also the escape hatch for the generic fallback above: a
quiet, deterministic runner with real, non-empty, non-summary output on
both runs (`node --test --test-reporter=dot`'s bare `..`, for example)
is exactly what this flag exists to vouch for, so a genuine `survived`
of such a runner is reported as `survived`, not second-guessed by the
fallback -- without the flag, the SAME command reads `inconclusive`/
`no_tests_executed` by design (no way to tell "ran nothing" from "ran
the same thing twice" without the caller's own evidence).

`--pass-regex <regex>` (plan files: `passWhen: { "regex": "<pattern>" }`,
the same thing) is an opt-in success PREDICATE, not another gate: once
given, it REPLACES the exit code as the verdict for both the baseline
and every mutant run -- "test passed" is the regex matching that run's
own combined stdout+stderr, "test failed" is the regex absent, whatever
the exit code says. It exists for a runner whose exit code alone cannot
be trusted at all, the motivating case a shell-out gate cannot fix:
phpunit 9.6 exits `1` on a fully green suite because of deprecation
notices, so every probe against it reports `baseline_failed` without
this flag, and a `sh -c '... | grep -q "^OK ("'` wrapper "fixes" the
baseline only by losing the mutant run's own exit-code signal (a crash
and a genuinely failing test then look identical). With `--pass-regex
'^OK \('` against that same suite: the baseline passes despite its
exit `1` (a `warnings` entry names the exit code, so the override is
visible rather than silently swallowed), and a mutant that flips the
runner's own output to `FAILURES!` is killed, exactly as it would be
under the exit-code default. The pattern is a bare JS `RegExp` source
with no flags syntax to write yourself: JS `RegExp` has no inline-flag
form at all, so there is nothing to "fold `i`/`s` into the pattern"
with beyond hand-rolling the equivalent -- a case-insensitive match
becomes a character class (`[oO][kK]` rather than `(?i)ok`), and
Node 23+ additionally supports scoped inline modifier groups
(`(?i:ok)`) for a runtime guaranteed to be at least that version. An
unparseable pattern (on the command line, or in a plan file's
`passWhen.regex`) is a usage error before any run starts. Unlike
`--require-baseline-evidence`, the compiled pattern always carries the
`m` flag: `^`/`$` anchor to each LINE of the combined stdout+stderr
buffer, not only to the buffer's very first/last character, so a real
runner that prints something ahead of its own summary line (phpunit's
own version banner, before the green `OK (...)` line the README's own
recipe above matches) still matches. `(?m)` is NOT a redundant-but-
harmless no-op here: it is not valid JS `RegExp` source at all (there
is no inline-flag syntax to parse it as), so it is rejected as a usage
error like any other unparseable pattern -- the `m` flag is simply
never needed, since it is already always on. Given on both the command
line and inside a `--plan` file at once, the command-line value wins,
the same precedence `-i`/`--expect`/`--timeout` follow against their own
plan-file counterparts. A miss -- the pattern given but absent from a
run's own combined output -- gets its own `warnings` entry naming the
pattern and the log path (and, when either side of that run's own
captured tail was truncated, the same truncation caveat
`--require-baseline-evidence`'s own miss carries), on the baseline path
and on every mutant run alike.

`--pass-regex` is independent of `--require-baseline-evidence`: the two
answer different questions and may be given together, one without the
other, or neither. `--require-baseline-evidence` stays a GATE on the
baseline only ("may this run go on to apply a mutant at all", checked
once, before the first mutant) and never touches a mutant's own verdict;
`--pass-regex` decides the VERDICT itself, for the baseline and for
every mutant run alike. Given together, the evidence regex is checked
first (a miss still refuses `baseline_evidence_not_matched` before any
mutant runs, whatever `--pass-regex` would have said), and once it
matches, `--pass-regex` -- not the exit code -- decides the baseline's
(and then each mutant's) own pass/fail. Given only
`--require-baseline-evidence`, verdicts are still read from the exit
code exactly as before this option existed; given only `--pass-regex`,
there is no evidence gate to satisfy at all, and the regex alone
decides every verdict; given neither, behavior is entirely unchanged.

A test command's own output can go silent in a way no exit code
distinguishes from a real failure: a mutant run that crashes SILENTLY
(a segfault, an uncaught exception before the runner's own reporter ever
printed anything) produces no output at all on either stream, and
`--pass-regex` cannot match empty output any more than a real failure's
non-matching output -- both read as "failed", and (under the default
`--expect fail`) as `killed`. The two are NOT the same finding, and the
envelope keeps a SILENT crash distinguishable: `test.exitCode` is never
dropped from the result just because `--pass-regex` is in charge of the
verdict (a crash's unusual exit code, e.g. `2`, differs from whatever
exit code a real failing run of that same command uses), and a mutant
run with `--pass-regex` set that produced no output on EITHER stream at
all gets its own `warnings` entry naming the crash outright, distinct
from the plain "matched despite a non-zero exit code" warning above and
from the plain "did not match" miss warning above. A caller that cares
checks `test.exitCode` together with empty
`test.stdoutTail`/`test.stderrTail` to tell a SILENT crash apart from a
run that printed real (non-matching) output. This only ever catches a
crash that produced no output at all: an uncaught exception that prints
its own stack trace to stderr before the process exits (an ordinary
`throw`, not a segfault) exits non-zero with real, non-empty output,
gets the same plain "did not match" miss warning a genuine test failure
would, and is `killed` (under `--expect fail`) with an envelope
indistinguishable from a real failure of that same command -- nothing in
this package tells the two apart; a caller who needs to must read the
log itself.

`--pass-regex` is a PREDICATE over output, not a process-health check: a
runner that prints its full green summary and then crashes during its
own teardown (after the reporter already wrote `OK (...)`) is read as a
pass, exactly as a naive `grep` wrapper would read it -- there is no way
for an output-only predicate to see past a crash that happens after the
evidence it looks for was already printed.

Both detectors understand only each runner's DEFAULT text reporters:
`node --test` with `--test-reporter=dot` (or any reporter besides the
default `spec`/`tap` shapes), and vitest's own `--reporter=json` output,
are invisible to them (neither carries the `tests <n>`/`Tests <n>
passed` text either detector matches on) -- a `-t`/`--test-name-pattern`
filter matching nothing under one of those reporters reads `survived`,
not `no_tests_executed`. Node's `--test-name-pattern` matching no test
name is a second, reporter-independent gap: the file itself still counts
as "a test" in node's own summary (`tests 1`), so the zero-count check
never fires for a name-filter miss even under the default reporter.
`--require-baseline-evidence` is the remedy for all three: vitest's
`--reporter=json` `numTotalTests` is not recognized; use
`--require-baseline-evidence` for a JSON-reporter run.

With no `--timeout` given and a test command that looks like a whole test
suite rather than one targeted file -- `npm test`, `npm run test`/`npm
run test:<anything>`, `yarn test`, `pnpm test` (each with nothing after
it but flags, a bare `--` argument separator judged the same way as any
other token: it is flag-shaped in its own right (it starts with `-`), so
it never by itself disqualifies a command from looking full-suite, and
whatever follows it is judged by this exact same rule, token by token --
there is no separate stripping step anywhere in this matcher, so `npm
test -- --coverage` is still full-suite while `npm test --
test/x.test.ts`, a real file forwarded through it, is not), or
`vitest run` (bare, through `npx` or not) with nothing after it but
flags, `-t <pattern>` and a forwarded `--` included by the same rule, so
`npx vitest run -- --coverage` also counts as full-suite -- `probe`
prints one line to stderr
before the baseline starts, naming that the baseline and the mutant run
the command serially with no time bound and that `--timeout` caps each
run: worth knowing before a probe over, say, `npx vitest run --coverage`
sits for minutes running the whole suite twice. A targeted command such
as `vitest run test/x.test.ts` (a file argument after `run`) or
`npm test -- test/x.test.ts` prints nothing; passing `--timeout` also
suppresses it, whatever the command looks like. The stderr line is
never part of the JSON envelope.

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

### Result shape

The single source of truth for a consumer of `probe`'s JSON: every field
beside the common envelope (`tool`, `version`, `command`, `status`,
`durationMs`, `cwd`, `truncated`, `logs`, `warnings`; see
[Output shape](#output-shape)), what type it is, and when it is present.
Update this table in the same change as any change to the shape it
describes.

This table describes the single-mutant form (no `--plan`) after option
parsing has succeeded. Two narrower envelopes sit outside it: a
**top-level usage error** -- thrown by commander's own option parsing, or
by a check this CLI runs before `probe()`/`probePlan()` is ever called
(`-t/--test is required`, `--json` conflicting with `-f text`, a `--plan`
file that cannot be read or parsed) -- reports `command: "unknown"` and
carries only `reason` and `message` from the rows below: no `mutant`,
`mutation_probe`, `baseline`, `test`, `env`, `isolation` or
`totalDurationMs`, because none of them were ever computed. A **`--plan`**
run replaces `mutant`/`mutation_probe`/`test`/`env`/`totalDurationMs` at
the top level with its own `plan: { baseline, results, summary }`; see
[`--plan`](#--plan-several-mutants-one-baseline) below for that shape and
for where its status/reason semantics differ from the single-mutant form
(a failing baseline, for one, is never remapped to a literal
`status: "baseline_failed"` there).

The `aborted` rows anywhere below describe `probe()`'s own result as a
library caller sees it (`exitOnSignal: false`, `probe()`'s own default):
a SIGINT/SIGTERM lands, the in-flight run is stopped and restored, and
the call returns this envelope like any other refusal. Under the CLI,
`exitOnSignal` is `true` (`src/cli.ts`, the single-mutant `probe({ ... })`
call the CLI's own probe action makes): there, the same signal instead ends
the process with its own conventional exit code once the restore has
settled, and prints no envelope at all -- an `aborted` row is reachable
from a library caller, never from the CLI's own JSON output. A consumer
that only needs to know whether THIS run ever got as far as computing a
mutant, without keying off which particular refusal reason fired, reads
`result.mutation_probe?.result`: it is always the string `"not_run"`
once this run's dry run had already computed the one mutant it would
have applied, and `undefined` on every refusal from before that point
(see the [refusal reason shape](#refusal-reason-shape) table below for
exactly which `reason` is which).

| Field | Type | Present | Notes |
| --- | --- | --- | --- |
| `status` | string | always | `"killed"`, `"survived"`, `"inconclusive"`, `"usage_error"`, or `"baseline_failed"`. The last is the CLI envelope's own literal status for a failing baseline (the library's `probe()` itself still returns `status: "inconclusive"`, `reason: "baseline_failed"`; the CLI remaps it so a consumer does not also have to read `reason` to tell a failing baseline apart from every other inconclusive outcome). Same exit-code class either way (`cannot-conclude`, exit `2`), so a caller gating on the exit code alone sees no difference. |
| `reason` | string | whenever `status` is not a clean verdict | machine-readable cause, e.g. `"baseline_failed"`, `"pre_failed"`, `"restore_failed"`, `"aborted"`, `"target_changed_during_baseline"`, `"mutant_not_applicable"` |
| `message` | string | top-level usage error only (see above) | the human-readable message commander (or this CLI's own pre-`probe()` check) produced; `reason` is still present alongside it, so a consumer can key off `reason` without also reading `message` |
| `mutant` | `{ file, line, before, after, form, diff? }` | once the mutant has been computed AND this refusal reports it | present for `killed`, `survived`, and every mutant-phase inconclusive reason (`apply_hash_mismatch`, mutant-phase `pre_failed`/`aborted`, `restore_failed`, `worktree_original_tree_modified`, `timeout`); for a refusal from before any mutant run (reported before or during the run's own setup), see the [refusal reason shape](#refusal-reason-shape) table below -- it is present for exactly six of those reasons (`aborted`, `pre_failed`, `baseline_failed`, `target_changed_during_baseline`, `no_tests_executed`, `baseline_evidence_not_matched`, all past the dry run that computes the one mutant this run would apply) and absent for every other one. `diff` only for a `-p/--patch` mutant whose change is not fully shown by `before`/`after` alone (see above). A `mutation_probe.result` of `"not_run"` also reaches a `survived`-shaped mutant run whose classify step itself found zero-tests evidence (mutant-side, or the generic byte-identical fallback): there `mutant`/`mutation_probe` are present as usual for a mutant-phase outcome, `status`/`reason` are `"inconclusive"`/`"no_tests_executed"` in place of `"survived"`, and `mutation_probe.result` is forced to `"not_run"` even though the commands did run -- see the zero-tests paragraph above. |
| `mutation_probe` | `{ mutant, verified_applied_via, result, restored_verified, reason? }` | once the mutant has been computed | present for every reason `mutant` covers above (the same six setup-phase refusals, plus every mutant-phase outcome): `result` is always a string once this object is present, so a consumer reading `mutation_probe.result` does not have to shape-sniff `status` first; `"not_run"` for the six setup-phase refusals (`aborted`, `pre_failed`, `baseline_failed`, `target_changed_during_baseline`, `no_tests_executed`, `baseline_evidence_not_matched`), `reason` naming which, and for the mutant-phase zero-tests override described just above. ABSENT for every other setup-phase refusal (see the table below), none of which ever computed a mutant. Paste straight into an implementer's `mutation_probes` output field. |
| `baseline` | `{ exitCode, durationMs, logPath, timedOut }` | once the baseline has run | absent for `mutant_not_applicable` and any earlier refusal, and for the baseline-phase `pre_failed`/`aborted` (the baseline itself never ran: the `--pre` ahead of it did); `exitCode` is unchanged by `--pass-regex` -- it is always the baseline's real exit code, kept as data even once the regex, not this field, decides `status`/`reason` (see `--pass-regex` above) |
| `test` | `{ command, exitCode, durationMs, timedOut, stdoutTail, stderrTail, logPath, env? }` | once the mutant run has happened | `env` only when at least one `--env NAME=VALUE` was given: the overrides this run applied, redacted (see `env` below); `exitCode` is likewise unchanged by `--pass-regex` -- the field that distinguishes a mutant run that crashed (no output on either stream) from a genuine test failure once the regex is what decides `killed`/`survived` |
| `env` | `Record<string, string>` | whenever at least one `--env NAME=VALUE` was given | echoed once at the run level, independent of which phase actually ran: present on every status including `baseline_failed` and the other baseline-phase refusals, none of which reach a `test` phase to carry their own `test.env`. Both `env` and `test.env` redact a value whose NAME carries `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`/`CREDENTIALS`, or `KEY` as its own `_`-delimited segment (case-insensitive; the segment must sit at the start or end of the name, or between two underscores), replacing it with the literal string `"<redacted>"` and keeping the name visible: `API_TOKEN`, `TOKEN`, `MY_SECRET_VALUE` redact, but `TOKENIZER_MODEL` and `KEYBOARD` do not (the recognized word is a substring of a longer segment, not a segment of its own). Every other value is echoed verbatim (never the whole merged environment). This redaction covers only these two echoes (`env` and `test.env`); it does not, and cannot, redact a secret the test command itself prints -- that value appears verbatim wherever the command's own output does (`test.stdoutTail`/`test.stderrTail` above, and the exec log `test.logPath` links to), the same as it would running that command directly. `--env` is not wired into `--plan` (combining the two is a usage error). |
| `isolation` | `{ mode, path, linked, syncedTrackedFiles, syncedUntrackedFiles }` | always, for this envelope (see the top-level-usage-error carve-out above, which has no `isolation` at all) | `path` is the worktree directory for `worktree`, `null` for `inplace`; `linked` lists the absolute source-tree paths symlinked in; `syncedTrackedFiles`/`syncedUntrackedFiles` are counts, `0` for both on a clean tree and for every `inplace` run |
| `totalDurationMs` | number | always, for this envelope (see the top-level-usage-error carve-out above, and `--plan`, whose own envelope carries no `totalDurationMs` at all) | wall-clock time of the whole `probe()` call, every branch (a normal return, a refusal before any mutant ran, or the emergency-restore path); the same field name and meaning `verify`'s own result carries |

#### Refusal reason shape

Every `reason` `openRunSetup` (`src/probe/setup.ts`) itself can return for
a single-mutant run -- a status short of `killed`/`survived`, reported
before or during the run's shared setup, past option parsing -- and
whether `mutant`/`mutation_probe` are present for it. `src/probe/session.ts`'s
`REFUSAL_RESULT_SHAPE` constant is this table's single source of truth in
code (typed `Record<RefusalReason, ...>`, so a reason with no entry there
fails to compile); `test/probe-refusal-contract.test.ts` provokes every
row below through `probe()` itself and asserts the presence matches
exactly, in both directions, so this table cannot drift from what
`REFUSAL_RESULT_SHAPE` itself declares, and every reason below is
provoked at the table-named site the row below describes. Five more
`usage_error` reasons fire earlier, in `probe()`'s own option-shape
checks (`src/probe/index.ts`), before `openRunSetup` is ever called:
`--patch` combined with `--allow-outside` outside its supported shape
(`patch_allow_outside_unsupported`), an unreadable `--patch` file
(`patch_not_readable`), a `--patch` whose touched paths cannot pick a
single `--file` for it (`patch_file_ambiguous`), a missing `--file`
(`file_required`), and a missing `-n`/`--line` (`line_required`). They
sit outside this table entirely, reporting neither `mutant` nor
`mutation_probe`, the same as the top-level usage error carve-out
above.

| `reason` | `mutant` | `mutation_probe` | When it fires |
| --- | --- | --- | --- |
| `worktree_allow_outside_unsupported` | absent | absent | `--allow-outside` combined with `--isolation worktree`; refused before containment is even checked |
| `file_outside_root` | absent | absent | `--file` (or a `--link`) resolves outside the containment root |
| `probe_in_progress` | absent | absent | the repository- or file-scoped lock is already held by another run |
| `lock_unavailable` | absent | absent | the lock directory itself could not be acquired (an unwritable lock dir, an ancestor owned by another user) |
| `stale_probe_marker` | absent | absent | a previous run's in-flight marker was found and could not be safely recovered |
| `file_not_found` | absent | absent | `--file` does not exist |
| `stale_worktree` | absent | absent | a leftover worktree-mode marker names a directory this run cannot safely reclaim |
| `worktree_sync_failed` | absent | absent | syncing the `-i worktree` copy (the tracked-diff apply, or an untracked-file copy) failed |
| `target_not_synced` | absent | absent | `--file` is gitignored, so `-i worktree` never synced a copy of it to mutate |
| `backup_verification_failed` | absent | absent | the pre-mutation backup does not hash-match the target right after it was taken |
| `mutant_not_applicable` | absent | absent | the dry run (before the baseline) found the mutant does not apply -- the string is not on the line, the patch does not apply cleanly, etc. |
| `git_apply_timeout` | absent | absent | the dry run's own `git apply` hit its bound and was killed |
| `aborted` | present | present | a SIGINT/SIGTERM landed during the baseline phase (its `--pre`, or the baseline test itself); see the `exitOnSignal` note above for why this is a library-caller-only row |
| `pre_failed` | present | present | `--pre` exited non-zero during the baseline phase |
| `baseline_failed` | present | present | the baseline test itself exited non-zero (or timed out), or `--pass-regex` was given and its pattern did not match the baseline's own output |
| `target_changed_during_baseline` | present | present | the baseline run rewrote the target (a formatter, a codegen step) before any mutation |
| `no_tests_executed` | present | present | the baseline's own output shows a known test runner (vitest, node's built-in `--test`) executed nothing, whatever its exit code -- see the zero-tests paragraph above |
| `baseline_evidence_not_matched` | present | present | `--require-baseline-evidence <regex>` was given and did not match the baseline's own output |

The six `present` rows are exactly the refusals that fire past the dry
run: `openRunSetup` computes the one mutant this run would apply (the
`beforeBaseline` hook) BEFORE the baseline runs, so every refusal from
that point on already has it to report; every `absent` row above fires
strictly before that point, with no mutant to report yet. `mutant_not_applicable`
and `git_apply_timeout` are two-site reasons: this table names only their
setup-phase occurrence, the dry run above. The same two reason strings
can also be reported later, past the baseline, when the REAL apply (not
the dry run) fails during the mutant phase itself -- there `mutant` and
`mutation_probe` are unconditionally present, the same as every other
mutant-phase outcome (`apply_hash_mismatch`, `restore_failed`,
`worktree_original_tree_modified`, `timeout`, and the mutant phase's own
`pre_failed`/`aborted`), because a real apply was already attempted
against the real target by then; this table's `absent` row for each of
those two names only the earlier, setup-phase site.

`aborted` is itself a three-site reason, the mirror image of
`mutant_not_applicable`/`git_apply_timeout` above: this table's `present`
row names only the baseline-phase pair (an aborted `--pre` or an aborted
baseline test, both past the dry run, both with a mutant already
computed to report). Two earlier sites report the same `"aborted"`
string with neither field, the same as every `absent` row above, because
both fire before `beforeBaseline` ever runs: the dry run's own abort
(`src/probe/step.ts`, `prepareMutant`'s `computeMutant` call) and, for
`-i worktree`, the worktree sync's own abort (`src/probe/isolation.ts`'s
`abortedResult` helper, surfaced through `session.ts` to `setup.ts`'s
`openRunSetup`, which hardcodes `reportsMutant: false` for this one site
rather than trusting `REFUSAL_RESULT_SHAPE.aborted`, precisely because
that table's `true` is right only for the baseline-phase pair). A
consumer keying off `reason === "aborted"` alone cannot tell these three
sites apart; `mutant`/`mutation_probe`'s presence does that instead.

The `file` part of `mutation_probe.mutant`/`verified_applied_via` (the
`<file>:<line>` header both descriptors start with) is capped at 200
characters, in the same truncation-marker wording the envelope's own
string cap uses: a kept prefix followed by `...(N more characters
omitted)`, `N` the true number of characters left out. A target
resolved through a very long `-C`/`cwd` or a deep temp/log directory
would otherwise paste its whole absolute path into both descriptors
uncapped, unlike the excerpt beside it. An ordinary path, including
every path in this document's examples, is unaffected.

### `--plan`: several mutants, one baseline

`--plan <path>` takes a JSON file naming one test command and a list of
mutants, and runs them against ONE baseline instead of one baseline per
mutant. Each mutant is applied (its applied content verified by hash),
tested, and restored (the restore verified by hash) before the next one
is applied; nothing runs in parallel.

```bash
agent-primitives probe --plan mutants.json
```

This illustrates the plan file's shape only; every path and line below
is a placeholder, not a real one, and the file is not runnable as-is.

```json
{
  "test": "npm test",
  "pre": "npm run build",
  "isolation": "worktree",
  "expect": "fail",
  "timeout": 900,
  "passWhen": { "regex": "^OK \\(" },
  "mutants": [
    { "file": "src/example.ts", "line": 42, "replace": "  return true;" },
    { "file": "src/example-two.ts", "line": 44, "match": "n > 0", "with": "n >= 0" },
    {
      "file": "src/example-three.ts",
      "patch": "mutants/example-three.patch",
      "expect": "pass"
    }
  ]
}
```

Every key except `test` and `mutants` is optional; `timeout` is in
seconds, the same unit `--timeout` takes; `passWhen: { "regex":
"<pattern>" }` is the plan-file equivalent of `--pass-regex <regex>` (see
its own section above), and a command-line `--pass-regex` given
alongside a plan wins over this key when both are given. Each mutant needs `file` and
exactly one form: `replace` (with `line`), `match` together with `with`
(with `line`), or `patch` (whose line comes from the diff, as with `-p`).
Unlike the single-probe `-p`, a plan mutant's `file` is never derived
from the patch: every path in the plan is known before the run starts, so
the containment check below can cover all of them up front. Paths in a
plan file (`file`, `patch`) are resolved against the invocation cwd
(`-C/--cwd`). An unknown key, a missing `test`, an empty `mutants`, a
mutant with two forms or none, or a `replace`/`match` mutant without a
`line` is `status: "usage_error"`, `reason: "plan_invalid"` (or
`"plan_empty"`), exit `2`, naming the offending path inside the plan
(`plan.mutants[2].patch`). A plan file that cannot be used at all
(missing, not a regular file, unreadable, or over the 1&nbsp;MiB cap) is
`reason: "plan_not_readable"`, decided from the file's metadata alone,
the same way `-p` is checked. All of that, plus the containment check
(`reason: "file_outside_root"` for a plan, a `usage_error` rather than
the single probe's `inconclusive`), runs BEFORE the lock, the in-flight
marker, the baseline or any worktree, so a plan that cannot run leaves
nothing behind.

`--plan` is mutually exclusive with `--file`, `-n`, `-r`, `-M`, `-w`,
`-p`, `-t`, `--pre` and `--env`: the plan file supplies all of those, and a
command line naming one beside `--plan` is a `usage_error` naming the
conflicting option. The run-shaping options are accepted instead of
refused, under one rule: a value given on the command line wins over the
plan file's own value, which wins over the CLI default. That covers the
three a plan file can set -- `-i` (`isolation`), `--expect` (`expect`)
and `--timeout` (`timeout`); a mutant's own `expect` wins over both,
since it is the only one of them that is per mutant rather than per run.
`--link` and `--allow-outside` have no plan key at all (`plan.link` is a
`plan_invalid` refusal naming the unknown key), so for a plan they are
command-line only and there is nothing for them to override.
`--require-baseline-evidence` is the same shape: no plan key, command-line
only, and (unlike `--env`) not refused under `--plan` -- see its own
paragraph above. `--pass-regex` is different again: it DOES have a plan
key (`passWhen.regex`), so it follows the `-i`/`--expect`/`--timeout`
precedence instead -- a command-line `--pass-regex` wins over the plan
file's own `passWhen.regex` when both are given -- rather than being
command-line only; see its own paragraph above for what it does once
resolved.

Output: the envelope carries `plan: { baseline, results, summary }`
instead of the single probe's top-level `mutant`/`mutation_probe`/`test`.
`baseline` is the one baseline phase every mutant was measured against.
`results` has one entry per plan mutant, in plan order, carrying `index`,
`file`, `expect`, `status` (`killed`, `survived`, `inconclusive` or
`not_run`), `reason` (when there is one), that mutant's own `warnings`
and `logs`, and -- for a mutant that was actually applied -- `mutant`,
`mutation_probe` (the same four fields to paste into a
`mutation_probes` report) and `test`. `summary` counts
`total`/`killed`/`survived`/`inconclusive`/`not_run`.

A failing baseline is one difference from the single-mutant form worth
naming explicitly: the single probe's CLI envelope remaps it to a
literal `status: "baseline_failed"` (see the [result shape
table](#result-shape) above), but a plan's own envelope does not --
it stays `status: "inconclusive"`, `reason: "baseline_failed"`, the
library's own pair, unremapped. The plan's top-level envelope also
carries no `totalDurationMs` at all (the single-mutant form's own
`totalDurationMs` row does not apply here).

A plan of more than a handful of mutants does not fit the default
`-m 8000`: the envelope is reduced to that bound like any other (past
about eight mutants `truncated` is `true`, entries lose their `test`
phase and the tail of `results` is replaced by an omitted-items marker),
so for a plan that size either raise `-m` or read the full, unreduced
result at the `result-full-<run-id>.json` path the envelope's `logs`
names. `summary` is held out of that reduction, so its counts cover
every mutant of the plan, including the entries the envelope no longer
shows -- unless the result is cut back to the fixed fields (`truncated`
plus a warning naming that outcome), which drops `summary` along with
everything else rather than showing it past the bound.

Exit codes stay `0` ok, `1` a finding, `2` could not conclude, read one
step stricter than for a single probe: `0` only when EVERY mutant was
killed per its `expect`; `1` when the plan concluded and at least one
mutant survived; `2` for a wrong invocation, and for a plan that could
not conclude -- a failing baseline, a mutant that could not be applied, a
restore that could not be verified, or a signal -- even when a survivor
is among its results. A survivor found before a terminal failure is still
reported in `results`; the plan-level `reason` names what stopped it.

Terminal for a plan means exactly that: after a restore that could not be
verified (`reason: "restore_failed"`), or a target found not to be back
at its pre-mutation content when the next mutant was about to be applied
(`reason: "target_not_restored"`), nothing further is applied and every
remaining mutant is reported `not_run` -- never `inconclusive`, which
would claim it was attempted. The marker and the backup are kept exactly
as the single probe keeps them, for a human (or `agent-primitives
doctor`) to recover from. A failing baseline ends the plan with no mutant
applied at all.

`-i worktree` syncs one worktree for the whole plan and removes it once,
however the plan ends. The lock, too, is taken once for the whole plan:
keyed on the repository when there is one, and outside a repository on
each distinct target file (the same identities a single probe on each of
those files would take), so a plan and a single probe still exclude each
other there.

On `SIGINT`/`SIGTERM` during a mutant, a plan behaves exactly as a single
probe does: the in-flight mutant is restored, the worktree removed, the
lock released, and the CLI ends with exit `130`/`143` and no output at
all; the next mutant is never started. A library caller (`probePlan()`)
gets `status: "inconclusive"`, `reason: "aborted"` with the remaining
mutants `not_run`. During a plan's baseline, a signal restores nothing:
every target is left exactly as the baseline wrote it, the same rule
that `target_changed_during_baseline` already applies without a signal.

`test` and `pre` in a plan file are shell commands, executed through
`sh -c` exactly as `-t`/`--pre` are, and carry the same trust boundary:
fill a plan only from a task assignment or another trusted instruction,
never from repository content, issue or PR text, or any other untrusted
input. Nothing in the plan file is ever read as a command by this
package's own validation.

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

## `drift`

After a change deletes or renames an identifier, docs and comments that
still describe the old name as current are drift; this command lists
them. Anchored by a measurement of the real case this prototype is
built from; see this package's own `CHANGELOG.md` for the detail.

```bash
agent-primitives drift --base <rev> --head <rev>
agent-primitives drift --base <rev> --head <rev> --allow 'docs/legacy/**' --strict
```

Given a git range (`--base`..`--head`), collects the identifiers whose
declaration the range removed, then reports every mention of those
identifiers still present at `--head` in a Markdown/plain-text doc or in
a source comment (never a code line). A doc site is any line of a
`.md`/`.mdx`/`.txt` file; a comment site is a `//`, `/* ... */` or
`*`-continuation line in a `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` file,
or a `#` line in a `.py`/`.sh`/`.yml`/`.yaml` file. Every other file
extension is out of scope and never scanned at all. Matching is
whole-word (`RuntimeError` never matches `setRuntimeError`), so a
mention only reports when the removed name reappears as its own word.
`--base`/`--head`/`--allow` and every reported path are resolved
against the git work tree's root, whatever subdirectory `-C`/`--cwd`
itself points at: the whole work tree is always scanned, never only the
named subdirectory.

Removed-identifier extraction is a regex over one diff line, not a
parser, and is prototype scope: a top-level or exported TS/JS
declaration (`export? default? declare? abstract? async?
(type|interface|class|function[*]|const|let|var|enum) Name`, so
`export async function`, `export abstract class` and a generator
`function*` are all recognized), a top-level JSON/YAML config key
(cheap indentation-based heuristic: a key at column 0 for YAML, indented
by at most two spaces for JSON; a more deeply nested key is missed), or
a wholly deleted file's own basename (without extension) - only when
the file's extension is one of the source extensions above AND the
basename itself looks like an identifier (at least 4 characters, and
containing an uppercase letter, a hyphen, or an underscore); a deleted
file whose basename does not clear that bar (`docs/setup.md`,
`logo.png`, `src/index.ts`) contributes nothing and is named instead in
a warning, so an all-lowercase, no-separator basename like `index` or
`setup` never floods the report with every ordinary prose mention of
that word. An identifier declared on both a removed and an added line
anywhere in the same diff is treated as MOVED, never as removed, on the
reading that the same declaration reappearing means it moved rather
than disappeared; a deleted file whose basename reappears as a newly
added file's basename is treated the same way. This is name-only and
can both over- and under-forgive: an unrelated declaration of the same
name added elsewhere in the diff is forgiven too.

A site is allowlisted by default (reported separately, in
`allowlisted`, and excluded from `sites` and from the exit code) when
any of: it matches an `--allow <glob>` (repeatable; `**` crosses path
segments, `*` stays within one); it sits in a released CHANGELOG
section (a `## [x.y.z]` or `## x.y.z` heading; `## [Unreleased]` is
never a released section, so a site under it is still reported); its
path is under `docs/**/migration*` or it sits under a Markdown heading
whose text contains "migration" (a heading inside a fenced ``` or ~~~
code block is never counted as document structure); or a small,
documented historical-phrase word list (`former`, `formerly`, `used
to`, `no longer`, `removed`, `renamed`, `replaced`, `dropped`,
`deleted`, `previously`, `was `) has a match within a bounded span
around the identifier's own mention on the line - up to about 60
characters before it (cut short at the nearest preceding `. `/`; `
sentence boundary) and about 20 characters after - rather than anywhere
on the whole line, so an unrelated historical phrase far away on a long
line never suppresses a present-tense mention. `--strict` also adds
every allowlisted site into `sites` (flagged with `allowlisted: true`
and its `allowlistReason`), so a site this command would otherwise
suppress by default counts toward the exit code too; `allowlisted`
itself always carries every allowlisted site regardless of `--strict`.

Envelope fields: `removed_identifiers` (`name`, `kind`
`declaration`/`config_key`/`file`, `file`, `line`), `sites` and
`allowlisted` (`path`, `line`, `identifier`, `kind` `doc`/`comment`,
`text` - the matched line, trimmed, capped at 300 characters with a
trailing `...` marker when longer - and on an allowlisted entry
`allowlisted: true` plus `allowlistReason`), and `counts` (`removed`,
`sites`, `allowlisted`), which is always reported whole even when
`sites`/`allowlisted` themselves are cut under `--max-chars` reduction.
`status` reuses the package's own verify-shaped values rather than
inventing new ones: `ok` (no site reported, exit `0`), `fail` (at least
one site reported, exit `1`), `usage_error` (`cwd` outside a git work
tree, `--base`/`--head` not a real revision, or `git diff` itself
failed, exit `2`).

Known limits, on top of the ones named above: only tracked content at
`--head` is ever scanned (`git grep` on that revision), so an untracked
file is never a site; a removed-identifier declaration split across
more than one line, or a name bound by destructuring, is missed; a
deleted file's basename that is short or all-lowercase-with-no-
separator (`db`, `api`) is never reported even when it is a real
identifier elsewhere; no cross-repo scanning. The historical-phrase
window's converse failure mode: a legitimate historical mention more
than about 60 characters before the identifier's own mention (or behind
a `. `/`; ` sentence boundary within that lookback), or more than about
20 characters after it, is still reported rather than allowlisted; use
`--allow` or reword the mention to bring it inside the window.

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
