# `verify`

Runs a fixed set of named checks (`build`, `typecheck`, `lint`, `test` by
default) and reports a compact, bounded summary instead of raw tool output.
Part of the [agent-primitives](../README.md) CLI.

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
- `--pass-regex <name=regex>`: opt-in per-check success predicate
  (repeatable, parsed the same way as `-x name=command`: split on the
  first `=` only, so a pattern containing `=` is preserved intact; a
  later `--pass-regex` for the same check name replaces an earlier one,
  the same last-wins rule `-x` itself already follows). Compiled through
  the same shared `compilePassRegex` (always the `m` flag, so `^`/`$`
  anchor to each line of the check's combined stdout+stderr, not only to
  the buffer's first/last character) `probe`'s own `--pass-regex`/
  `passWhen.regex` already use. Once a check's name has an entry here, a
  match against that check's combined stdout+stderr decides `status:
  "pass"`/`"fail"` in place of its exit code, whatever that exit code is
  -- for a test runner whose exit code alone is not trustworthy (PHPUnit
  9.6 exiting non-zero on a green suite purely over deprecation notices
  is the motivating case): a match on a non-zero exit is a `pass`, with a
  warning naming the exit code (a shell's own 128+N signal-kill band gets
  its own wording -- "the suite may have been cut short" -- rather than
  reading like deprecation noise); no match on exit `0` is a `fail`, with
  a warning naming the pattern, and a truncated output tail on that miss
  is called out too, since the pattern may simply have matched whatever
  fell outside it. `exitCode` itself is still reported in the check's
  result as data either way, and the result names the pattern that was
  applied (`passRegex`), so a reader can tell an opt-in verdict from a
  plain exit-code one apart from the warning. A check with no
  `--pass-regex` entry is entirely unaffected: its verdict, and its
  result shape, are byte-identical to before this option existed. A
  predicate-decided `pass` still reports the detector's own parsed
  `summary`/`failures` as data (unlike a predicate-decided `fail`, which
  gets no synthetic failure entry either): when that parse still shows a
  nonzero `summary.failed` or a nonempty `failures` list -- a pattern
  that matched a banner line ahead of a genuinely red summary is the
  motivating shape -- a warning names the detector and how many failures
  it parsed, since the verdict itself stays `pass` (the predicate, not
  the detector, decides once configured) but a reader should know the
  pattern may be too loose. Exit `126`/`127`, a per-check timeout, and a
  check killed by an abort are never reclassified by a predicate -- those
  shapes answer nothing about pass/fail either way, predicate or not --
  and each now warns that the predicate was never consulted, the same as
  a requested-but-`skipped` check already does, rather than dropping the
  predicate silently; naming a REQUESTED check that nonetheless resolves
  to `skipped` (no matching `package.json` script and no `-x` for it) is
  not an error, but a warning names the pattern that was never
  consulted, since a predicate on a check that never runs at all is
  otherwise a silent no-op. Naming a check here that is neither
  requested (`-c`/the default list) nor `-x`-overridden at all is
  `status: "usage_error"`, exit `2`, rather than a silent no-op: the
  predicate would never be consulted. An empty pattern (e.g. a stray
  trailing `=` in `--pass-regex name=`) is rejected as a usage error too,
  since `new RegExp("", "m")` matches any output and would silently turn
  the check into an unconditional pass. No config-file
  (`.agent-primitives.json`) home for this predicate yet.

Every resolved check name, from `-c` and from `-x` alike, is validated
against a conservative pattern (letters, digits, `_`, `.`, `:`, `-`) before
any command is built; a name outside that pattern is `status:
"usage_error"`, exit `2`, and is never run.

Check resolution, per name: an `-x` override wins; otherwise a matching
`package.json` `scripts[name]` runs as `npm run <name> --silent`; a requested
name with neither is recorded as `status: "skipped", reason: "no_script"`,
with a warning naming the missing script. It is an explicit non-pass: the
overall result is `status: "error"`, exit `2`, even when other requested
checks pass. Supply the command deliberately with `-x name=command` when
that is intended. When the resolved check list is empty (e.g. `-c ''`), or
every requested check resolves to `skipped`, the run also carries
`reason: "nothing_verified"`. A shell exit of `126` (not executable)
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
zero-exit check). Three more default candidates cover PHP: `phpunit`
(`OK (N tests, M assertions)`; `FAILURES!`/`ERRORS!`/`WARNINGS!`/`OK,
but incomplete, skipped, or risky tests!` plus a `Tests: N, Assertions:
M, ...` tally line whose named counts -- `Errors`, `Failures`,
`Warnings`, `Skipped`, `Incomplete`, `Risky`, and, under PHPUnit 11, the
two-word `PHPUnit Deprecations`/`PHPUnit Warnings`/`PHPUnit Notices` (a
meta issue about the test suite's own use of a deprecated PHPUnit
feature, not about the code under test) or the plain single-word
`Deprecations`/`Notices` -- are read by name, not position, since
PHPUnit's own field order changes with which marker fired; and `No
tests executed!`; a PHP-level deprecation notice on an otherwise green
run is reported as a detector warning, not a failure. The counts are
derived by spending the run's own stated total, one category at a time:
Skipped and Incomplete never execute, Failures, Errors and Risky always
do (a risky test ran, it just asserted nothing), so `passed` is what
remains of the executed count after failures and errors, never a
negative number and never more than the run itself reported. `Warnings`
is version-dependent, read off PHPUnit's own version banner: under
PHPUnit 9 it does not execute either (PHPUnit counts a warning such as
`No tests found in class "X".` as a whole synthetic test that never ran
a body), but under PHPUnit 10/11 the same plain `Warnings: N` token
counts N tests that DID run and raised a PHP-level warning during their
own execution, so it executes there, folded into `passed` the same way
`Risky` is (captured real, PHPUnit 11.5.56: a single test raising
`E_USER_WARNING`, `Tests: 1, Assertions: 1, Warnings: 1.`, exit `0`,
derives `passed: 1`, not `passed: 0`, and names the count in a
`phpunit_warnings:` detector warning, since `summary.warnings` stays `0`
there). A prerelease banner (`PHPUnit 11.0.0-RC1`) is read at its own
major too. Output whose banner is not present at all (front-truncated
away) keeps the PHPUnit 9 reading for the summary, as the fail-safe
default, but is NOT read as a verdict about whether anything ran: see
[probe.md](probe.md)'s zero-tests reading.
`Deprecations`/`Notices` and their two-word `PHPUnit `-prefixed
counterparts are read (so a two-word one no longer breaks the whole
tally line's match) but deliberately spent nowhere on any PHPUnit
version: they are raised inside a test that genuinely ran, so treating
them as not-executed would wrongly shrink a real `passed` count. A
numbered `N) Class::method` entry becomes a `failures` entry only under
an error or failure section header, or under PHPUnit 11's own `There was
1 PHPUnit error:` section kind (a suite-level failure such as an invalid
data provider, counted under the tally's `Errors:` the same as an
ordinary error), since a risky or incomplete entry carries the same
header shape), `phpstan` (` [OK] No errors`, or a per-file table closed by
` [ERROR] Found N errors`, `summary.errors` preferring that stated
total over the row count), and `phpcs` (one `FOUND N ERRORS ...
AFFECTING M LINES` summary PER FILE, summed across every file rather
than read from the first alone, over one `<line> | ERROR | message` row
per finding; a clean run prints nothing at all, so there is no "no
errors" shape for this one to match, same as the tsc/eslint detectors'
own clean captures). Each `phpunit` entry's own `file:line` locator line
(set off by a blank line above it in PHPUnit's default reporter) is
matched against the RAW line, never a trimmed one, both for the blank
check and for the locator regex itself: so an indented diff row that
merely looks like `word:digits` once trimmed (a `sebastian/diff`
context/added/removed row always carries a leading space, `-` or `+`)
is never mistaken for it, and a one-space "blank" row (the same
`sebastian/diff` shape for an unchanged blank line) never wrongly
blank-gates the very next unindented row into being misread as the
locator either. An uncaught exception's multi-frame trace prints one
`file:line` per frame back to back with no blank line between them, and
only the first (innermost, throw-site) frame becomes `file`/`line` --
the same convention every single-frame capture already follows -- with
the remaining CONSECUTIVE frames (no blank line, no other text, between
them) consumed and dropped rather than folded into `message`; a LATER
locator-shaped line that is not consecutive with that captured frame,
such as a chained exception's own PHPUnit 9.6 `Caused by` block, is
folded into `message` like any other text instead of being consumed.
All three target each tool's own DEFAULT non-colorized text
output; a non-default format (PHPUnit's JUnit XML, PHPCS's
`--error-format=raw`, or forced ANSI colors on any of the three) is out
of scope and falls to `generic`. PHPUnit's `--testdox` and `--teamcity`
reporters are the measured exception: both still print the run's marker
line and its `Tests: N, Assertions: M, ...` tally unchanged, so
`phpunit` is still selected and every summary count is right under them;
what they drop is the numbered `N) Class::method` entries, so `failures`
comes back empty. See [non-js-test-runners.md](non-js-test-runners.md)
for the exit-code assumption these three inherit like every other
check here.
No reporter flags are injected: whichever of these shapes a check's own
script happens to print is parsed as-is; a check that emits more than
one shape at once (a `pretest` build followed by `vitest`, say) is
ambiguous and falls back to `generic`, same as any other ambiguous
case. Every file-path capture across these detectors is matched
structurally (up to the shape's own separator, such as vitest's `>` or
tsc's `(line,col):`), never merely up to the first whitespace, so a path
containing a space is still captured whole. ANSI color codes are stripped
before any of the vitest/tsc/eslint detectors matches or parses, since a
tool run in a fully non-interactive environment can still default to
colorized output (only SGR sequences are stripped; none of these three
tools' default text output emits cursor-movement or other non-SGR
escape sequences). eslint 10
(a devDependency, used only for this package's own lint check and for the
`eslint` detector's fixtures) requires Node `^20.19.0 || ^22.13.0 || >=24`,
narrower than the `>=20` this package itself requires; that floor
applies to developing this package, not to a caller running the built CLI.
Whatever the detector, a check that ends `fail` or `error` with zero
parsed failures always gets one synthetic failure entry (naming `timedOut`, or the exit code, plus the output tail) instead of shipping an
empty `failures` list, and an `error` check always reports at least one `summary.errors`; this synthetic entry is added on top of whatever count
the detector already reported, never doubling a count the detector already
got right. This synthetic entry, and the invariant that produces it, are
skipped entirely for a check whose `--pass-regex` predicate decided
`pass`: its `summary` and `failures` come straight from the detector's
own parse (e.g. PHPUnit's `OK (N tests, M assertions)` line gives
`summary.passed = N`, `summary.failed = 0`, `failures = []`), never
padded with a synthetic entry the predicate has already overruled. The
entry is still added when the predicate decided `fail` and the detector
itself parsed zero failures, the same as for a plain exit-code `fail`.
Truncation is read from exec.ts's own
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

Overall `status` is `error` if any check errored or was unresolved, else
`fail` if any check failed, else `pass`; `error` wins over `fail`. Exit code follows `status`
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
of that on a signal (see [probe.md](probe.md)'s signal handling).

