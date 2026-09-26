# Non-JS test runners

How `verify`, `probe`, and `drift` behave with PHP (PHPUnit, PHPStan, PHP_CodeSniffer) and other non-Node test runners. Part of the [agent-primitives](../README.md) CLI.

`verify`, `probe`, and `drift` were built against Node tooling first,
but nothing in any of the three assumes JavaScript: a PHP repository
using PHPUnit, PHPStan, and PHP_CodeSniffer works the same way, with
three things worth naming explicitly.

**The exit-code assumption.** `verify`'s `classifyStatus` reads
`pass`/`fail` from the command's own exit code (`0` is `pass`,
`126`/`127` are infra `error` exit codes, anything else non-zero is `fail`), and
`probe`'s `survived`/`killed` verdict is built on the same exit code
too. PHPUnit and PHPStan follow this convention directly (PHPUnit exits
non-zero on any failure or error; PHPStan exits `1` when it finds
errors). PHPCS's own mapping, measured against real captures (see
`test/fixtures/README.md`), is `0` clean, `1` when it finds only
warnings, `2` when it finds any errors (fixable or not), `3` on a
processing error (e.g. a `--standard` naming no sniffs at all) -- so a
warnings-only PHPCS run reads as `fail` under this rule's plain
"anything non-zero is fail", the same as an errors run, even though
PHPCS itself distinguishes the two by exit code. PHPUnit has a
zero-exit hole of its own: a run whose only outcome is a PHPUnit-level
warning (`No tests found in class "X".`) exits `0` under 9.6 even though
nothing ran, which is why the zero-tests guard below, and not the exit
code, is what catches that shape. No wrapper is needed to make a
`composer.json` `scripts` entry (or an `-x` override) work with any of
the three commands as-is. The PHPUnit-specific corollary lives in
`probe`'s zero-tests guard, below.

`verify`'s own opt-in escape from this exit-code assumption, per check,
is `--pass-regex name=regex` (see [verify.md](verify.md)'s `--pass-regex` option): a
green PHPUnit 9.6 suite that exits non-zero purely over a deprecation
notice is exactly the shape it exists for, mirroring the escape `probe`
already had via its own `--pass-regex`/`passWhen.regex`.

**The zero-tests guard now knows PHPUnit.** The same
`no_tests_executed` refusal `probe` already applies to vitest's
all-skipped/no-test-files shapes and node `--test`'s zero-count summary
now also recognizes PHPUnit's own `No tests executed!` line and any run
whose executed count is zero: the stated total less every tally category
that did not execute (Skipped and Incomplete always; plain `Warnings`
too under PHPUnit 9, read off the run's own version banner -- see
[verify.md](verify.md)'s "Three more default candidates cover PHP"
passage), which covers an all-skipped
run, a PHPUnit 9 warnings-only run, and a stated `OK (0 tests, 0
assertions)` (defensive -- not observed from a real capture; PHPUnit
9.6.36 prints `No tests executed!` for an empty suite instead). A red
run that is ALSO all-skipped/incomplete does not confuse this guard,
since it never relies on `passed`/`failed`/`errors` alone; an all-risky
run is deliberately not flagged, since a risky test did run, and neither
is a PHPUnit 10/11 warnings-only run, since the version-aware reading
also counts that as executed. A baseline (or mutant run) that exits `0`
with nothing actually executed is `status: "inconclusive"`, `reason:
"no_tests_executed"`, never read as a real pass, exactly like the
vitest/node cases documented in [probe.md](probe.md).

**The zero-tests reading is three-valued**: `phpunitZeroTestsVerdict`
returns `"zero"` (nothing executed), `"not_zero"` (no evidence that
nothing executed), or `"ambiguous"` (the question cannot be answered
from this output at all). `"zero"` is only ever taken from something
PHPUnit itself stated -- its own `No tests executed!` line, or a tally
whose executed count derives to zero without depending on a version the
output does not state -- never from an absence in the output.

`"ambiguous"` has two causes. First, a missing result report: the output
carries PHPUnit's version banner but no summary line, no `N / M (P%)`
progress counter and no post-run `Time: <t>, Memory: <m>` line, the
shape a mid-suite `exit()`/`die()` leaves behind (see below). Second, a
missing version: the output states no PHPUnit version banner AND its
tally carries a version-dependent count that decides the question -- a
long green PHPUnit 11 run ending in `Tests: 15, Assertions: 15,
Warnings: 15.` whose banner fell out of the kept tail executed nothing
when read as a 9 and ran and passed all 15 when read as a 10+, and the
output itself does not say which. Where the two readings agree (a
nonzero `Warnings` count alongside other, version-independent executed
tests) the verdict is that agreed value, not `"ambiguous"`: the count is
unreadable, the zero-tests question is not.

The two callers collapse that third value in opposite directions, on
purpose. `verify` warns `no_tests_executed:` only for `"zero"` and emits
a distinct `zero_tests_ambiguous:` warning for `"ambiguous"`, so it
never asserts a hollow pass it cannot actually read; both texts carry
the reading's own reason (for the missing-version cause: the unreadable
count, both readings' executed totals, and which of the two the summary
printed beside it carries). `probe` refuses on anything but
`"not_zero"`: it cannot warn and carry on the way `verify` can, and
scoring such a run would compare a mutant whose executed count cannot be
read against the baseline as if it had run and passed, reporting
`survived`. A refusal costs a probe result; the other collapse buys a
verdict with a false one. That refusal reports its own dedicated
`zero_tests_ambiguous` reason (additive to `RefusalReason`, see the
[refusal reason shape](probe.md#refusal-reason-shape) table), never
`no_tests_executed`, which stays for what it always meant: PHPUnit
itself stating that nothing ran. Naming the two apart matters precisely
because `zero_tests_ambiguous` does NOT claim the run executed nothing
-- the run may in fact have executed everything under a PHPUnit 10+
reading, and an unreadable-result run may well have executed and passed
a test before it was killed -- it claims only that the question cannot
be answered from this output. The two ambiguous causes above (a missing
result report, and a missing version banner) are not split further from
each other: both map to this one reason (that finer split is out of
scope for this change), with a `warnings` entry naming the detector that
fired (`phpunit`) alongside it, the same way every other zero-tests
refusal's warning does.

**An `exit()`/`die()` call mid-suite is read as an UNREADABLE result,
not as zero tests.** A test method that calls `exit()`/`die()` (or is
otherwise killed -- a fatal signal, a segfault) terminates the PHP
process itself before PHPUnit prints any result report at all: no `OK
(`, no marker, no tally, no `No tests executed!`, just PHPUnit's own
version banner and however many progress characters printed before the
kill (captured real on both majors: `phpunit-exit-mid-suite.txt` under
PHPUnit 11.5.56 and `phpunit-exit-mid-suite-9.txt` under 9.6.36, exit
`0`, one `.` and nothing else; see `test/fixtures/README.md`). This
detector's own `matches()` recognizes PHPUnit's version banner on its
own, so the shape reaches this detector instead of falling to `generic`,
and `phpunitZeroTestsVerdict` reports it as `"ambiguous"`: nothing in
such an output says how many tests ran, and that single progress dot in
the captured fixture is one test that genuinely ran and passed before
the kill, so a zero-tests claim about it would be false rather than
merely unproven. Both the `probe` zero-tests guard above and the
`verify` warning below pick the shape up automatically, since both are
built on that same function; in `probe`, a mutant run whose own output
collapses to it reports `mutation_probe.result: "not_run"` with
`reason: "zero_tests_ambiguous"` when `phpunitZeroTestsVerdict` read the
mutant's own output as `"ambiguous"` (this exact unreadable-result
shape, or a missing-version-banner tally disagreement -- the same two
causes the baseline-phase reason collapses, see
`ZeroTestsEvidence.ambiguous` in `zero-tests.ts`), and `reason:
"no_tests_executed"` when it read `"zero"` instead (PHPUnit's own stated
`No tests executed!`, or a derived executed count of zero) -- never
`"killed"` either way, since neither outcome is evidence the test
discriminates the mutant. Unlike the baseline-stage refusal above, this
mutant-phase `reason` is a plain string, not `RefusalReason` (a mutant
has already been applied by then, so `mutant`/`mutation_probe` are
unconditionally present regardless of which string it names): the split
mirrors the baseline phase's own `no_tests_executed`/`zero_tests_ambiguous`
distinction exactly, closing the residual left open when that baseline
split first shipped (this file's CHANGELOG has the detail).

A COMPLETED run whose result report is merely suppressed is excluded by
its own completion evidence: PHPUnit 10 and up accept `--no-results`,
and a green two-test suite run that way prints its banner, its `..  2 /
2 (100%)` progress counter and its post-run `Time: 00:00.007, Memory:
8.00 MB` line before stopping, exit `0` (captured real:
`phpunit-no-results-green.txt`; PHPUnit 9.6.36 rejects the flag outright
with `Unknown option "--no-results"`, exit `1`, so the shape is 10+
only). Requiring both of those to be ABSENT is what separates a
suppressed report from a missing one -- without it, such a green run was
read as a killed one, `verify` claimed `no_tests_executed` about it, and
`probe` refused every baseline of a project that runs PHPUnit that way.
The counter is read as evidence of completion only and never as a count:
the same flag on a RED suite prints the identical `2 / 2 (100%)` tail
with `.F` progress characters (`phpunit-no-results-red.txt`, exit `1`),
so it counts tests PHPUnit reached, not tests that passed.

**`verify`'s summary now carries that same count too, named
`attempted`.** For a suppressed-report run (or any other phpunit output
whose real tally cannot be derived at all -- no `OK (`, no `Tests: N,
Assertions: M` line), `Summary.attempted` holds the LAST `N / M (P%)`
row's own `N`: the same "tests reached", never "tests passed", reading
the completion check above already uses, pinned against the real
`phpunit-no-results-green.txt`/`phpunit-no-results-red.txt` captures
(both report `attempted: 2`, whether the two tests passed or one
failed). `passed`/`failed`/`skipped`/`errors`/`warnings` themselves stay
at the same all-`0` fallback `No tests executed!` already used before
this field existed -- `attempted` is additive, never folded into any of
them -- and the field is absent whenever the real tally COULD be
derived (then the counter, even if also present, says nothing
`attempted` would add) and absent whenever no counter is in the output
either (the unreadable-result and `--list-tests` shapes below, which
still carry no completion evidence of any kind).

Two limits. First, the banner
is the selection signal, so a banner-only output (`phpunit --version`)
selects this detector and reads `"ambiguous"`, and with two banners in
one capture the first one wins the version read for the tally
categories. Second, inherited from `exec.ts`'s
own bounded tail (60 lines / 6000 characters, kept from the END of a
truncated capture): a suite large enough to push even the version banner
itself -- PHPUnit's very first line -- out of that tail before the
`exit()`/`die()` kill falls to `generic`, since none of `matches()`'s
checks fire on a banner-less tail; only `probe`'s byte-identical generic
fallback catches a MUTANT that changes such a large, front-truncated
run's shape, never a baseline that already was that shape. A
`--list-tests` listing (banner plus `Available tests:` and the test
names; 9.6 prints `Available test(s):`) has no completion evidence
either and is reported as unreadable too: over-caution rather than a
correct description, and the fail-safe direction for both callers.

The counter pattern used to be anchored at the end of a line only, not
to a progress row, so any line that merely ENDED in the `N / M (P%)`
shape (a failure message or a PHP fatal-error line reporting some
unrelated fraction, say) was read as completion evidence it never was.
It is now anchored to the WHOLE line, from its very start: a genuine
progress row is nothing but zero or more marker characters, then
horizontal padding, then the counter, so requiring the line to start
that way (`^[.FEWIRSDN]*[ \t]*(\d+) \/ (\d+) \([ \t]*\d+%\)[ \t]*$`) is
what tells a real row apart from a line that merely ends in the same
shape, pinned by a synthetic test (`test/verify.test.ts`; no real
capture needs more than 63 tests to exercise the row wrap this anchor
still accepts). The marker prefix is a closed alphabet, `.FEWIRSDN`.
Measured in this suite's captures: `.`, `F` and `W` under PHPUnit 9.6.36
and 11.5.56, `E`, `I`, `R` and `S` under 9.6.36, `D` (deprecation) and
`N` (notice) under 11.5.56
(`phpunit-warnings-deprecations-notices-executed.txt`'s `WDN ... 3 / 3
(100%)` row). It is closed on purpose: an open letter class would also
accept a line made of one ordinary word and the counter (`Aborted 5 / 9
( 55%)`) as completion evidence. A word made only of marker letters
(`FEW 3 / 3 (100%)`) still matches, since by shape and alphabet it is a
real row: the pattern is not proof of origin. A marker the alphabet
does not know
leaves its row unrecognized, so the run reads as not completed (for
`probe`, a refusal) rather than as a false pass, and a test over every
captured phpunit fixture fails as soon as a capture with an unknown
marker is added, so the alphabet cannot go stale unnoticed. The
padding on both sides of the counter is horizontal only (`[ \t]*`,
never `\s`, which also matches a newline and let a marker line and the
counter line below it bleed together into one match under the `m`
flag): pinned by a synthetic test asserting the matched text stays on
the counter's own line, since a bare `.test()` cannot tell a same-line
match from a two-line one when the counter line alone, with no leading
markers, is already a valid match by itself.

**`verify` now warns on a hollow phpunit pass, too.** Before this, only
`probe`'s zero-tests guard (via `phpunitZeroTestsVerdict`) caught a
warnings-only, all-skipped, or empty/filtered PHPUnit run; a plain
`verify` call read the same run as an ordinary `pass` with nothing to
say about it. `verify` now pushes a `no_tests_executed:` detector
warning onto any phpunit check whose own status is `pass` while
PHPUnit's own output states that it executed nothing -- carrying the
reading's own reason clause, so the text says which of the two origins
it came from (the explicit `No tests executed!` line, or the tally
derivation) instead of naming a tally line the explicit case does not
have -- reusing `phpunitZeroTestsVerdict` rather than re-deriving it,
and only for a `phpunit`-selected check: a non-`phpunit` detector
selection never gets this warning, however its own output reads. The
check's `status` itself is NOT changed to anything else: the status
stays the verdict (`pass`), same as every other check here, and this
warning is only the signal that the pass is hollow, for a caller that
wants to notice; the warning's own wording names the status rather than
an exit code, since `--pass-regex` can decide `pass` on a non-zero exit.
A caller that must actually refuse a hollow pass, not merely be warned
about it, still wants `probe`'s own zero-tests guard (or `--pass-regex`
naming a real summary line), not this warning.

**The pass predicate** (`--pass-regex`/`passWhen.regex`) is implemented on
both `probe` and `verify`; each documents its own option in its own
section (`probe`'s own in [probe.md](probe.md); `verify`'s own is the paragraph
right above naming `--pass-regex`, not this one). A composer
`vendor-dir`/`bin-dir` link rule remains its own pending task (issue
#225 part 2). For every
check without a predicate, `verify`'s status classification, and
`probe`'s own baseline verdict, still read the plain exit code exactly
as described above (the phpunit/phpstan/phpcs detectors parse output
and never look at the exit code; only the `generic` fallback does);
`--pass-regex`, on either command, is the opt-in way out of that
reading for a check/baseline whose exit code is not trustworthy on its
own.

**Python bytecode cache.** CPython trusts a `__pycache__/*.pyc` without
recompiling whenever its stored header's `(mtime, size)` matches the
source file's own `(mtime, size)` -- nothing about the source's actual
content is ever compared. `probe` writes both a mutant's apply and its
restore with a fresh timestamp (there is no code path that deliberately
preserves the original mtime; a restore is a plain `fs.copyFileSync`,
and Node's `copyFileSync` does not copy the source's mtime onto the
destination -- verified directly, not inferred, by writing a file with a
synthetic old mtime, copying it, and reading the copy's own mtime back:
it lands at the time of the copy, not the time the backup was taken).
Restore is therefore "touch on restore", not "preserve the original
mtime": a deliberate simplicity choice (a plain copy is easy to reason
about and to mutation-probe on its own, see the restore-guarantee
invariant documented on `InplaceSession.restore` in `isolation.ts`), not
one made for cache correctness. Its consequence for cache validation is
that a restored file's own mtime is never guaranteed to differ from (or
agree with) any cache entry already sitting next to it; CPython's stored
mtime is whole SECONDS besides, so an apply, its test run, and a restore
that all land inside the same wall-clock second (the ordinary case for a
fast suite) can leave a same-length mutant's replacement content behind
an unchanged `(mtime, size)` pair regardless of what the restore's own
mtime policy is. Two directions follow: a mutant run can execute STALE
(pre-mutation) bytecode still cached from before the mutant was applied,
reporting `survived` for a mutant the source really would fail; and once
restored, a bystander run (the regression suite itself, a follow-up CI
step, a developer re-running the suite by hand) can execute MUTANT
bytecode a probe's own mutant run left behind, reporting a
genuinely-passing restored file as red.

`probe` closes both directions by ONE mechanism: every `--pre`/test-command
invocation of a run with at least one Python (`.py`) target gets its own
brand-new, previously-unused cache directory via `PYTHONPYCACHEPREFIX`,
set automatically (never left to the caller to remember) and never
reused across invocations -- not between the baseline and a mutant's own
run, and not between two mutants of the same plan. A fresh, empty
directory has nothing cached in it yet, so CPython recompiles
unconditionally every time, regardless of what mtime/size coincidence
would otherwise apply; this also means an existing cache (from a
developer's own prior run, or CI's, wherever this host's `python3` puts
it: a co-located `__pycache__` on most hosts, a redirected directory
where `python3` sets `sys.pycache_prefix`) is never read
OR written by `probe` itself, so it is never at risk of being shadowed
by mutant bytecode in the first place. The two mechanisms not chosen,
and why: (a) invalidating the affected `__pycache__` entries after apply
and after restore was rejected because it requires enumerating every
cache entry a change could affect (package-relative caches, a
`sys.path` this process does not control, a `PYTHONPYCACHEPREFIX` the
caller may already have set) and staying correct as CPython's own cache
layout evolves, where isolating the location sidesteps the enumeration
question entirely; (c) refusing with exit 2 whenever a Python target is
involved was rejected because the isolation mechanism can actually
guarantee correctness in the ordinary case (unlike, say, a
signal-interrupted restore, which genuinely cannot always be verified),
so refusing unconditionally would trade a real, working fix for a
weaker one out of unnecessary caution. `(c)` is still what `probe`
falls back to on the one genuine failure mode isolation itself has:
if creating this run's isolation directory fails (an unwritable or full
log directory), `probe` refuses rather than silently falling back to
the ambient, potentially-stale cache -- reported as `reason:
"pycache_isolation_failed"`, `exit 2`, the one new named reason this
change adds to the refusal contract; the JSON envelope's field set, the
default isolation mode, and every other exit code are unchanged. Applies
to CPython only: any other language's own compile/bytecode cache
(Ruby's YJIT, a JVM language's class cache, and so on) is a known,
named limit of this release, not addressed here. `PYTHONPYCACHEPREFIX`
itself requires CPython 3.8 or newer; on an older interpreter the
variable is silently ignored (not detected, not refused), so the
isolation mechanism this section describes has no effect there -- a
known, named limit alongside the other-languages one above, not
otherwise mitigated.

The chosen mechanism has one cost of its own, not shared by (a) or (c):
the test command's own process runs under a bytecode-cache location it
would never see outside `probe`. A test suite that itself asserts on
`__pycache__`'s placement, or reads `sys.pycache_prefix`/
`PYTHONPYCACHEPREFIX` and expects a particular value or absence, behaves
differently under `probe` than it would standalone -- and the one
failure mode that follows is a RED BASELINE (`reason:
"baseline_failed"`, no verdict at all), never a wrong verdict: the
mechanism does not silently mis-report `killed`/`survived`, it makes the
baseline itself fail before any mutant is even applied. Because that
failure can otherwise look like an unrelated test bug, every run with a
Python target pushes one `warnings` entry naming the injected
`PYTHONPYCACHEPREFIX` variable up front (see
[output-shape.md](output-shape.md) for where `warnings` lands in the
envelope), so a red baseline on such a run
is diagnosable from the envelope alone.

A caller's own `--env PYTHONPYCACHEPREFIX=...` names a specific, shared
cache location the caller controls (to inspect what got compiled,
say), rather than an ordinary override this mechanism should just fold
in: merging this package's own per-invocation directory on top of it, as
every other `--env` override normally would be, would silently discard
the caller's value and make the envelope's `test.env` (which echoes
`--env` verbatim) misreport what the child process actually saw.
`probe` instead honours it: a `--env PYTHONPYCACHEPREFIX=...` given by
the caller SKIPS this run's own per-invocation isolation entirely (the
baseline and every mutant's own run all share that one caller-named
directory instead), with a `warnings` entry naming the hazard and the
caller's own value -- reintroducing the same `(mtime, size)` shadowing
hazard this mechanism otherwise closes, unless the caller manages that
shared directory themselves (clearing it between runs, for instance).
Every other `--env` override reaches the child unaffected either way.

`doctor` surfaces the same condition before a probe run, rather than
only after a wrong verdict: `agent-primitives doctor --target
<path>[,<path>...]` reports a `python-bytecode-cache` check, always
`ok: true` (informational, never a hazard the operator must act on), for
every `.py` path among the given targets. When `python3` is on `PATH`,
the check resolves each target's REAL cache path the same way CPython's
own import machinery would (`importlib.util.cache_from_source`), so a
host whose `python3` redirects `sys.pycache_prefix` elsewhere by default
(macOS's own system `python3` does) is still checked accurately, rather
than assumed to be a co-located `__pycache__`; when `python3` is not on
`PATH`, the check falls back to that co-located guess and names the
fallback in its own detail. It falls back the same way, and names the
targets it fell back for, in the two narrower cases: a `python3` that
was asked and did not come back with a path for one target (a non-zero
exit, no output, its own timeout), and a target whose turn came after
`doctor`'s aggregate spawn deadline was already spent, where `python3`
is never asked at all. Both paths through the check report one spelling
of the directory the targets sit in, the real one with every symlink
resolved: it is the directory the interpreter's own imports of those
files use (a relative source path resolves against `os.getcwd()`, which
is always real), so a `-C` (or a library caller's `cwd`) that reaches
the targets through a symlink is still checked accurately. Either way it names the RESOLUTION (that
`probe` isolates its own runs against exactly this target automatically)
rather than telling the operator to act -- it exists so the condition is
visible up front, and so an operator running the target's own test
command directly (outside `probe`) knows that cache still applies to
that separate run. The check is omitted entirely (not reported at all)
when no `--target` is given, or when none of the given targets are `.py`
files.

