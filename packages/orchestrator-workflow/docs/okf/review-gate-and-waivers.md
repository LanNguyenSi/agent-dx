---
type: invariant
title: Review gate and waiver semantics
description: Review is never skipped; the severity ladder, waiver rules, and the Decision-column vocabulary that gate acceptance across policy, skill, and templates.
tags: [review-gate, waivers, severity-ladder, decision-legend, misfire-rule]
timestamp: 2026-10-21T06:19:00Z
sources:
  - packages/orchestrator-workflow/assets/agents-md-section.md
  - packages/orchestrator-workflow/assets/agents/reviewer.md
  - packages/orchestrator-workflow/assets/templates/04-implementation-summary.md
  - packages/orchestrator-workflow/assets/templates/03-decisions.md
  - packages/orchestrator-workflow/assets/templates/05-review-findings.md
  - packages/orchestrator-workflow/assets/templates/06-handoff.md
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/test/charter.test.ts
  - packages/orchestrator-workflow/test/template-markers.test.ts
  - packages/orchestrator-workflow/test/decision-authority.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
  - packages/orchestrator-workflow/assets/skill/references/contracts.md
  - packages/orchestrator-workflow/assets/skill/references/delegation-and-tiers.md
  - packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md
  - packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md
  - packages/orchestrator-workflow/assets/skill/references/run-state-and-harness.md
---

# Review gate and waivers

Review is never skipped. Charter rule: "Non-trivial review goes to a separate
reviewer subagent. Review itself is never skipped, in any run mode, not even for docs or
bulk changes"
(`packages/orchestrator-workflow/assets/agents-md-section.md:26#"not even for docs or bulk changes."`). The skill's entrypoint
lets a trivial change be reviewed by the orchestrator itself
instead of a spawned reviewer subagent, but restates the same floor: "review
judgment is never skipped" (`packages/orchestrator-workflow/assets/skill/SKILL.md:17#"and reviewed directly by the orchestrator, but review judgment is never"`).
`packages/orchestrator-workflow/assets/skill/references/run-state-and-harness.md:22#"the apparatus changes. When tier variants are"` carries the
identical invariant for ceremony-scaling: "Review judgment still applies to
every change; only the size of the apparatus changes."

## Severity ladder and what blocks

## Decision authority is separate from a review recommendation

## Delta attribution and bounded review rounds

Every reviewer finding records `introduced_by_delta: yes | no | unknown`.
A `no` attribution needs a named base build and a replay of the same
reproduction. It remains a finding under the ordinary gate and is recorded
parenthetically in the `Description` field without renaming the load-bearing
`Severity` or `Decision` headers (packages/orchestrator-workflow/assets/templates/05-review-findings.md:16#"| Severity | Category | Description | Suggested Fix | Decision |").
Only `yes` and `unknown` findings feed the bounded round-2 halt and escalation
rules; this prevents a reproduced pre-existing issue from consuming the
delta's bounded-review budget. Attribution is the second of the halt's two
clauses, and both sites carrying the halt state both: step 8 halts "at the
first `recurrence: repeated` finding whose class a previous round's fix already addressed and whose `introduced_by_delta` is `yes` or `unknown`"
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:336#"Halt at the first"`),
and the Round-2 halt rule's own cross-reference to step 8 states the
identical scope, both clauses
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:58#"Step 8 of the detailed workflow states the operational"`),
and no test pins the two sites against each other; review covers the
wording.
Full field-shape treatment of the implementer-side `class_closure` field
that produces `recurrence: repeated`'s class match is out of this doc's
lane; see
[subagent-contracts-superset.md](subagent-contracts-superset.md#class-closure-field).

A reviewer supplies findings and `acceptance_recommendation`; the
orchestrator decides acceptance after applying the review gate. The new
reviewer rule makes the boundary explicit: a reviewer recommendation cannot
become orchestrator acceptance or authorize a critical waiver; only the
operator may authorize that waiver
(`packages/orchestrator-workflow/assets/agents/reviewer.md:145#"A reviewer recommendation is not orchestrator acceptance"`). This is a
human/process authority rule, not a Markdown authorization mechanism.

For newly created records, `03-decisions.md` records each decision with a
stable ID, trigger/evidence, decision, accountable authority/source,
consequences, and a supersession reference
(`03-decisions.md:5#"| ID | Date | Trigger / Evidence |"`). Established runs
retain their recorded decision format, and an absent new field does not become
a retroactive acceptance blocker. Every
accepted waiver links to the applicable decision
ID. The source cell records concrete approval evidence; a bare role label,
reviewer recommendation, or illustrative fixture is not proof
of an operator approval. Routine in-scope decisions remain with the
orchestrator, while an out-of-scope change and a critical waiver require an
operator decision.

Reviewer findings carry `severity: low | medium | high | critical`
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:236#"severity: low | medium | high | critical"`, reviewer output contract). Only high and critical block
acceptance: "High or critical reviewer findings block final acceptance until
fixed or explicitly waived... the gate applies to every review pass,
including the orchestrator's own review of a trivial change"
(`agents-md-section.md:33#"trivial change."`). Medium and low are "addressed or consciously
accepted at the orchestrator's judgment" (`agents-md-section.md:42#"orchestrator's judgment."`); no
waiver bookkeeping applies to them.

Do not conflate two distinct vocabularies attached to the same review: the
per-finding `Decision` column (below) and the whole-review
`acceptance_recommendation: accept | accept_with_notes | fix_required |
reject` (`packages/orchestrator-workflow/assets/skill/references/contracts.md:242#"acceptance_recommendation: accept | accept_with_notes |"`; mirrored in the findings template's Acceptance
Recommendation section,
`packages/orchestrator-workflow/assets/templates/05-review-findings.md:32#"accept | accept_with_notes | fix_required | reject"`).
A review can recommend `fix_required` overall while individual low findings
carry Decision `accepted`; the gate only inspects Decision on high/critical
rows. Since 0.16.0 the field is hard-mandatory, not just conventionally
expected: "`acceptance_recommendation` is mandatory: every reviewer return
must set it. When it is missing, the orchestrator asks the reviewer to
resupply it instead of inferring one from the findings list"
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:259-261#"instead of inferring one from the findings list."`; the installed `reviewer.md:310#"leave it blank or omit it."` prompt carries the mirrored
second-person rule). Full treatment is out of scope here; see
[Acceptance-recommendation mandatory rule](#acceptance-recommendation-mandatory-rule-0160)
below.

## Waiver rules

- Critical: "waived by the operator. The orchestrator never waives a
  critical finding on its own" (`agents-md-section.md:36#"never waives a critical finding on its own."`); the
  detailed workflow's step 8 no longer restates it, and adds only that "A
  reviewer recommendation is not orchestrator acceptance and cannot authorize a
  critical waiver" (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:323#"A reviewer recommendation is not orchestrator acceptance and cannot"`).
- High: "waived by the orchestrator with a recorded rationale"
  (`agents-md-section.md:38#"rationale."`).
- Deferring counts as waiving, for both severities: "Deferring such a
  finding counts as a waiver" (`agents-md-section.md:31#"explicitly waived. Deferring such a finding counts as a waiver, and the gate"`),
  which covers both severities. A deferred
  critical still needs operator sign-off; a deferred high still needs an
  orchestrator-recorded rationale.
- Recorded in
  `packages/orchestrator-workflow/assets/templates/03-decisions.md`, whose
  decision table has seven columns: `ID`, `Date`, `Trigger / Evidence`,
  `Decision`, `Authority / Source`, `Consequences`, and `Supersedes`
  (`03-decisions.md:5#"| ID | Date | Trigger / Evidence |"`). The Authority /
  Source cell records the sign-off or rationale, and `Supersedes` links a
  revision to its prior decision. Its separate Review-round escalation table
  (`03-decisions.md:16#"## Review-round escalation"`) remains unchanged; there
  is no additional waiver schema.
- Summarized in `06-handoff.md`'s Accepted Waivers section
  (`agents-md-section.md:40#"the Accepted Waivers section of"`), instructed to "Mirror
  03-decisions.md"
  (`packages/orchestrator-workflow/assets/templates/06-handoff.md:21#"<!-- Waived high/critical reviewer findings, or none. Mirror 03-decisions.md. -->"`) via a
  `Finding | Severity | Rationale | Approved By` table
  (`06-handoff.md:19-25#"| <!-- finding --> | high/critical | <!-- rationale --> | operator/orchestrator |"`).

## Docs-only closing delta

After an independent review, the orchestrator may close a later docs-only
delta without another reviewer round only when the *entire* unreviewed delta is
explanatory documentation, comments, or citations. It excludes source- and
test-file edits and semantic changes to executable commands, configuration,
policy, instructions, or behavior; it applies only to low/medium
documentation or maintainability findings and never to high/critical or any
other ineligible finding (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:174#"ineligible finding, and records the concrete verification in a"`). This is a closing
option after review, not an exception to the review requirement or the waiver
rules above.

For an eligible closure, record the concrete verification in a
`05-review-findings.md` row without changing its Severity or Decision headers,
and set the row's Decision to `accepted`
(`review-and-recovery.md:176#"and Decision"`; `05-review-findings.md:16#"| Severity | Category | Description | Suggested Fix | Decision |"`).
No reader or template schema changes: the existing Decision legend and all
high/critical waiver and escalation rules continue to apply. The rule moved
out of the always-loaded charter into the review and recovery reference, which
is now its one site; the charter only points to it
(`agents-md-section.md:44#"The docs-only closure rule and the escalation budget are in the skill's"`), and step 8 of
the detailed workflow does the same. It is
pinned as sentences at that site only, in
`test/docs-consistency.test.ts:3090#"safety core: the docs-only closing delta stays narrowly bounded at the review and recovery reference"`.

A second closing option sits in the same section, with its own conditions
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:180#"A second closing option covers a medium finding in the category"`).
After independent review, the orchestrator may close a *medium* finding in the
category the reviewer reported (`docs` or `tests`) without another reviewer
round when the task's entire unreviewed delta consists of fixes of two classes:
only explanatory text, or tests added or existing tests tightened with no
assertion removed or loosened and no test deleted or skipped
(`review-and-recovery.md:192#"The second class adds tests or"`).
Text that a tool consumes as data or configuration counts as configuration,
not explanatory text: comment directives (lint, type-check, coverage,
formatter, or test-environment directives, shebangs, build tags), document
frontmatter such as a bundle's `sources:` list, and any part of a
documentation or instruction file that a test or tool reads as data (markers,
pinned sentences), so a documentation file that a test reads as data is
configuration and closes under neither option
(`review-and-recovery.md:186#"semantics. Text that a tool consumes as data or configuration counts as"`).
Citations, anchored ones included, stay explanatory text, so a citation fix
stays closable under either option on a task outside the `adversarial` class;
on an `adversarial`-class task only test-only fixes close, and a citation fix,
being documentation, keeps the reviewer round
(`review-and-recovery.md:191#"pinned sentences). Citations, anchored ones included, stay explanatory text."`;
`review-and-recovery.md:235#"the classes listed in the"`).
The definition governs the first option too: what counts as explanatory text
there is limited by it
(`review-and-recovery.md:176#"What counts as explanatory text for this option is"`).
The test class is bounded line by line, not by who reads a change: it closes a
fix only when the fix changes existing test files exclusively and every line
it adds, changes, or removes is part of an assertion added inside an existing
test case or part of a new test case added to an existing test file, the new
test case being the call or declaration that defines it and its body, so a new
`it(...)` in an existing file, or a new Go `func TestX` in an existing
`_test.go` file, can close a finding
(`review-and-recovery.md:194#"This test class closes a fix only when the fix changes existing test files"`).
An added assertion leaves every existing assertion in place, and rewriting an
existing test's expected value counts as loosening, so a changed expected
value keeps the round
(`review-and-recovery.md:199#"An added assertion leaves every existing assertion in place: none is removed,"`).
One fix may combine several new test cases and added assertions, and a new
`describe` block whose body holds nothing but new test cases counts as part of
them, as do the blank lines that separate a new test case from its neighbours
(`review-and-recovery.md:202#"One fix may add several new test cases and add assertions next to them; a"`).
Everything else keeps the reviewer round: a new file of any kind (test file,
helper, fixture, snapshot, golden file), a helper, fixture, snapshot, golden
file, or allowlist or exemption entry added or changed anywhere but inside a
new test case, an import, a module mock such as `vi.mock` wherever it is
written (the runner hoists it to module level), any other line outside a test
case (a hook such as `beforeEach` or a Go `TestMain`, module-level or
init-time code such as a Go `func init()`), and a configuration change
(`review-and-recovery.md:206#"Anything else keeps the reviewer round: a new file of any kind (a test file,"`).
An orchestrator decides eligibility from the diff alone, with no search for
readers: a new fixture file, a new helper, a new allowlist entry, or a new
import keeps the round whatever reads it. The boundary is lexical, so state
that a new test case leaves behind when it runs (an unrestored spy, an
environment variable it sets) is not judged by this rule; that residual is
accepted, and the probe requirement below still asks each new test case to
discriminate.
This rule replaces an earlier dependent-test exception, so neither
dependent-test evidence nor a search for readers is asked for.
Adding `.only` or a condition that narrows a test counts as loosening
without exception
(`review-and-recovery.md:215#"a condition that narrows a test counts as loosening without"`).
Unlike the first option it may touch test files, which is why the bound and
the probe requirement below exist: a test change can hide a behaviour change.
A fix that changes code, configuration, or instruction semantics keeps the
reviewer round
(`review-and-recovery.md:216#"exception. A fix that changes code, configuration, or instruction semantics"`).
The halt exclusion reads the reviewer's markers, not the orchestrator's
judgement: a finding marked `recurrence: repeated` with `introduced_by_delta`
`yes` or `unknown`, and any fix on a task whose Review-round escalation budget
has fired, are not eligible, so those rules govern
(`review-and-recovery.md:220#"fired, is not eligible for this option: those rules govern and the next"`),
and high and critical findings stay blocking under both options
(`review-and-recovery.md:222#"High and critical findings stay blocking: neither closing option closes one,"`).
The closure is recorded in the same `05-review-findings.md` row, Decision
`accepted`, with the finding, the fix commit, the test run as the package's
full test command (plus the type-check when a test or source file was touched)
with its exit code, a killed mutation probe for each added assertion and each
new test case, and the bundle check result where the repository has a
knowledge bundle
(`review-and-recovery.md:227#"was touched) with its exit code, a killed mutation probe for each added"`;
`review-and-recovery.md:228#"bundle check result where the"`). It is
not a review round, so it counts toward neither the test-adequacy cap, the
Round-2 halt rule, the Review-round escalation budget nor the Fix-regression
decision point
(`review-and-recovery.md:229#"closure is not a review round: it"`).
On a task of the `adversarial` class the first option is not available and the
second closes a finding only when the fix changes test files exclusively
(`review-and-recovery.md:235#"the classes listed in the"`).
A task is of that class when its delta falls in a class the `adversarial` row
lists or when any round of the task was given the `adversarial` class, so a
docs-only fix on such a task does not qualify, and any fix other than one
confined to test files goes through a reviewer round; on such a task the test
class is the same line-level rule as under the second option, so a new or
changed helper, fixture, snapshot, or golden file, an import, or any other
line outside a test case keeps the round there too
(`review-and-recovery.md:240#"when its delta falls in a class that row lists or"`;
`review-and-recovery.md:241#"when any round of the task was given the"`;
`review-and-recovery.md:246#"such a task goes through a reviewer round. On such a task the test class is"`).
The clauses are pinned as whole sentences
in `test/docs-consistency.test.ts:9800#"safety core: the docs-or-test medium closing option stays bounded at the review and recovery reference"`, and
their single site in `test/charter.test.ts:188#"sits only in review-and-recovery.md"`.

## The Decision legend in 05-review-findings.md

detailed workflow reference is the transfer instruction: "transfer each finding from the
reviewer output contract into the table's columns as-is, keeping the
Severity and Decision headers unchanged, since those two are what the
orchestrator-workflow completeness reader verifies" (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:254#"those two are what the orchestrator-workflow completeness reader verifies; for every"`).
Immediately after that quote, detailed workflow reference also carries a 0.13.0 addition
on the same table's placeholder/legend row (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:258#"rows as the template never having been filled in. When"`): replace it
when transferring findings, delete it outright for a genuine zero-findings
review; full treatment (the mixed-state bypass it closes, the mirrored
template comment, the reader's literal match) is out of scope here, see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).
Immediately after the placeholder-row rule, step 7 also carries the 0.14.0
reproduction requirement (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:265#"lint): only claims that could vary run to run trigger"`); full treatment is out of scope
here, see [Reproduction requirement](#reproduction-requirement-0140) below.
The table header is `Severity | Category | Description | Suggested Fix |
Decision` (`05-review-findings.md:16#"| Severity | Category | Description | Suggested Fix | Decision |"`). Its Decision legend comment
(`05-review-findings.md:15#"<!-- Decision legend: a high/critical finding counts as RESOLVED (the completeness gate passes) only when its Decision is"`) states `RESOLVED_DECISIONS = {accepted,
defer}`: a high/critical finding counts as RESOLVED (gate passes) only when
Decision is `accepted` or `defer`; every other value, `fix`, `reject`,
blank, `open`, `TODO`, "leaves the finding unresolved and ARMS the gate"
until changed. The example row was narrowed to `accepted/defer` in 0.7.4
after a prior `accepted/fix/defer/reject` example misled a run into an
unexpectedly armed gate
(`packages/orchestrator-workflow/CHANGELOG.md:#[0.7.4]`).

The two column headers are load-bearing for a second, independent reason:
`05-review-findings.md:14#"<!-- The Severity and Decision column headers below are load-bearing: the orchestrator-workflow completeness reader locates this table by its header row and verifies unresolved findings from those two columns. Do not rename or drop them. -->"` documents them as the anchor the grounding-mcp
completeness reader uses to locate the table at all (a header row whose
cells include both `Severity` and `Decision`, case-insensitive). Renaming or
dropping either header hides the table from the reader regardless of
Decision values; the load-bearing comment (plus a one-sentence transfer
rule in SKILL.md) was added in 0.7.3 after a live run drifted onto an
unparseable `Severity | Finding | Resolution` convention, while the shipped
header itself was already correct (`CHANGELOG.md:#[0.7.3]`, the
already-correct-header statement within that entry).

## Fail-closed acceptance markers

Two machine-readable markers sit next to the prose gate: `<!--
solution-acceptance: acceptance-recommendation = TODO -->`
(`05-review-findings.md:34#"<!-- solution-acceptance: acceptance-recommendation = TODO -->"`) and `<!-- solution-acceptance: final-status =
TODO -->` (`06-handoff.md:63#"<!-- solution-acceptance: final-status = TODO -->"`). SKILL.md instructs replacing `TODO` with the
chosen enum value when finalizing each file (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:368#"non-accepting (fail-closed)."`). Left as
`TODO`, the harness solution-acceptance gate reads the run as non-accepting.
`packages/orchestrator-workflow/test/template-markers.test.ts:57#"<!-- solution-acceptance: run-base = TODO -->"` pins
exactly one marker per template, each defaulting to `TODO`. This is a
different fail-closed design than the run-base marker, which fails open; see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).

## The gate is pinned at one site

`packages/orchestrator-workflow/test/docs-consistency.test.ts:186#"safety core: the review gate is pinned at the charter"`
pins the gate as sentences at one normative site, `agents-md-section.md` (the charter): the
`### Review gate` heading with "High or critical reviewer findings block
final acceptance until fixed or explicitly waived", the whole sentence that
deferring counts as a waiver and the gate applies to every review pass
(including the orchestrator's own review of a trivial change), the sentence
that leaves medium and low findings addressed or consciously accepted at the
orchestrator's judgment, the sentence that only the
operator waives a critical finding, the sentence that the orchestrator waives
a high finding only with a recorded rationale, and the sentence that records
every waiver in `03-decisions.md` and the handoff (test lines 190-222).
`test/charter.test.ts` rejects an exact second copy of any charter
sentence of 8 or more words in `SKILL.md` or a reference, so the gate has one
site rather than verbatim copies. Two pieces stay pinned beyond the charter because they are not
prose rules: `06-handoff.md`'s `## Accepted Waivers` heading and its `Finding
| Severity | Rationale` header, a template the orchestrator fills (test lines
224-227), and a negative pin against a superseded softer wording, "addressed
or consciously accepted by the orchestrator", reappearing in
`agents-md-section.md` (test lines 229-233). A second suite,
`test/template-markers.test.ts:266#"expect(reviewTemplate).toMatch(/arms? the"`, independently pins the
findings-table header convention and the Decision-legend vocabulary above.

## Misfire rule's review-gate consequence (0.11.0)

Added in 0.11.0 after a live incident: a reviewer subagent spawn returned in
5 seconds with 0 tool uses, handing back harness boilerplate instead of the
reviewer output contract (`CHANGELOG.md:#[0.11.0]`). The Subagent misfire rule
states the review-specific consequence: "a misfired review is not a
review and never satisfies the review gate, since review is never skipped"
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:38#"review and never satisfies the review gate, since"`), not pinned by any test. Since
0.18.0 the rule also names resume over a fresh respawn as the preferred
response for the near-instant, no-tool-activity signal specifically (scoped
away from a separately measured mid-run watchdog-stall class where resume
did not work). Full misfire mechanics (detection signals, the
resume-over-respawn preference and its scope, the `03-decisions.md` record)
are out of scope here; see
[subagent-contracts-superset.md](subagent-contracts-superset.md).

## Reproduction requirement (0.14.0)

A new, narrowly-triggered rule closes a gap the severity ladder and waiver
rules above do not cover: nothing previously required the reviewer to
independently verify an implementer's *empirical* claim (a flake rate, a
benchmark, "n runs green", a timing number) rather than transcribe it into
the findings table as reported. detailed workflow reference now states it right after
the placeholder-row rule (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:265#"lint): only claims that could vary run to run trigger"`): when acceptance rests on such
evidence, the reviewer must reproduce it independently (its own runs or
measurements) and record method, sample size, and result against the
implementer's claim; a single deterministic check (one test run, `tsc`,
lint) does not trigger it. The installed `reviewer.md` prompt carries the
same rule (`reviewer.md:212#"lint) do not trigger this."`), and both output contracts gained a matching
`reproduction: {method, sample_size, result, matches_implementer_claim}`
field (`packages/orchestrator-workflow/assets/skill/references/contracts.md:251#"matches_implementer_claim: matched | mismatched |"`, `reviewer.md:276#"residual_risks:"`); `matches_implementer_claim`
accepts `not_applicable` so a review that never hits the narrow trigger is
not forced to fabricate a reproduction record.

Motivating incident (`CHANGELOG.md:#[0.14.0]`): agent-dx run
`2026-07-18-harness-subprocess-test-deflake`, reviewer pass 1. The
implementer's evidence read "8/8" full-suite runs green for a `maxWorkers`
concurrency cap; the reviewer reran the suite independently (6 sequential
runs) and got 2/6 red with the same failure signatures, a ~1/3 flake rate
matching the pre-fix baseline: the fix did not work, and nothing in the
review contract at the time had required that independent rerun before
transcribing the implementer's number as an accepted finding. Full
role-contract duplication mechanics (where the SKILL.md/reviewer.md copies
live, the misfire rule) are out of scope here; see
[subagent-contracts-superset.md](subagent-contracts-superset.md).

## Acceptance-recommendation mandatory rule (0.16.0)

0.16.0 hardened a gap adjacent to the severity ladder above: nothing
previously forced a reviewer return to set `acceptance_recommendation` at
all, so the orchestrator could be left inferring a verdict from the findings
list alone. The field is now hard-mandatory in both output-contract copies:
`packages/orchestrator-workflow/assets/skill/references/contracts.md:259-261#"instead of inferring one from the findings list."` states it and adds the orchestrator's response when it is
missing: ask the reviewer to resupply it, rather than infer one from the
findings, and the installed `reviewer.md:310#"leave it blank or omit it."` prompt carries the mirrored
second-person rule ("always set it in your output; never leave it blank or
omit it"). This is distinct from the per-finding `Decision` column and the
severity ladder above: a reviewer could previously satisfy every other part
of the contract and still omit the one field that carries its overall
verdict. 8ab22cb0 adds a mechanical, structure-only check for this same
requirement: the `validate-review-report` CLI subcommand documented at
`packages/orchestrator-workflow/assets/skill/references/contracts.md:263#"A structural check for this exact contract ships as a CLI subcommand:"`
parses a reviewer return and reports a missing or invalid
`acceptance_recommendation` (or any other required field) as a diagnostic,
but never judges semantic adequacy or substitutes for this rule's
orchestrator-side ask-back response.

Motivated by the same 16-round dogfood as the mutation-probes hardening in
[subagent-contracts-superset.md](subagent-contracts-superset.md#mutation-probes-requirement-0160)
(`CHANGELOG.md:#[0.16.0]#"as a hard-mandatory"`, agent-tasks task 16637a96): one reviewer round in
that dogfood omitted `acceptance_recommendation` entirely.
The mandatory rule is pinned in the installed reviewer prompt only
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:969#"is mandatory: always set it in your output"`);
`SKILL.md`'s ask-back sentence carries no sentence pin.

## Review-round escalation budget

The Round-2 halt rule (full treatment out of scope here; see
[subagent-contracts-superset.md](subagent-contracts-superset.md)) stops a
single defect-class recurrence within one task, but nothing previously
forced a choice once that stopping, or `fix_required` review rounds, kept
recurring on the same task. This budget applies in addition to the halt
rule's split-or-redesign response, not instead of it:
`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:64#"## Review-round escalation budget"` triggers "by the second
round-2 halt signal on the same task, or by the third `fix_required`
review round on the same task, whichever comes first", at which point the
orchestrator picks one of three named escalations
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:77#"**Tier or model escalation**"`,
`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:86#"**Advisor spawn**"`, `packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:89#"**Merge-hold**"`: raise
the implementer to at least `-xhigh` where installed or to the strongest
available model, an advisor spawn asked "redesign, split, or hold?", or an
operator merge-hold). A negative round has an `acceptance_recommendation` of
`fix_required` or `reject`; a misfired review is not a round. A negative round counts only with at least one introduced_by_delta yes/unknown finding; no stays ordinary gate. Which of the three is picked is judgment; that one
is picked and recorded is not
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:92#"Judgment governs which of the three to pick; only that one is chosen and"`).
The charter no longer carries the rule or a short form of it; it only points
to the reference
(`agents-md-section.md:44#"The docs-only closure rule and the escalation budget are in the skill's"`),
so the budget has this one site.

The `single` branch is defined in the normative tier-or-model option
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:77#"**Tier or model escalation**"`).

The choice is recorded in `03-decisions.md`'s new named section
(`03-decisions.md:16#"## Review-round escalation"`), a one-row-per-task
table (`03-decisions.md:20#"| Task | Choice | Reason |"`) whose
`Choice` column is the enum `n/a | tier_escalation | advisor |
merge_hold`, because one run carries multiple tasks and each can trigger
the budget independently. A `review-round-escalation` marker defaulting
to `n/a` is kept alongside the table as a reader shortcut to the most
recent choice
(`03-decisions.md:26#"<!-- review-round-escalation: choice = n/a -->"`).
Unlike the two `solution-acceptance:` verdict markers in
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md),
whose `TODO` default is a fail-closed sentinel that blocks acceptance
until replaced, this marker's `n/a` default is a valid enum member, not a
sentinel: it is deliberately fail-open, because most runs never trigger
the budget at all, and a future reader must not read a marker still
showing `n/a` as "escalation was needed but not recorded" -- it means the
budget was never hit. This marker is a documented convention only: no
reader in this package or in grounding-mcp parses it today (see the
CHANGELOG's `[0.30.0]` entry). Escalating never substitutes for a
review round: whichever option is chosen, the next attempt still goes
through the reviewer subagent in full, the same review-never-skipped
floor stated at the top of this doc.

The reviewer output contract also gained a per-finding `recurrence: new |
repeated` field so the orchestrator can read the trigger off the
reviewer's own return; full field-duplication mechanics are out of scope
here, see
[subagent-contracts-superset.md](subagent-contracts-superset.md#recurrence-field).

## Fix-regression decision point

The halt rule and the budget both need something to repeat (a defect
class, or negative rounds). A third, earlier rule covers a fix round whose
review shows that the fix itself broke something, without any repetition
yet (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:103#"## Fix-regression decision point"`):
the trigger, in the review of a fix round, is at least one `high` or
`critical` finding that the previous round's review did not report, with
`introduced_by_delta: yes`
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:106#"reports at least one"`);
the qualifier is read off the findings of the two reviews, not off
`recurrence`, so a `recurrence: repeated` finding the previous round did
not report still triggers it. `unknown` and `no` do not trigger it;
`unknown` keeps its treatment under the halt rule and the budget, which
both act on it. Before another fix round the
orchestrator names in one sentence why the fix could introduce the defect
(the structural cause, or the statement that there is none) and records one of
four outcomes in `03-decisions.md`: continue with the stated reason,
redesign, split, or hold
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:120#"record one of four outcomes as a decision in"`);
an advisor spawn is optional. It is a decision point and not a halt
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:124#"This is a decision point, not a halt"`):
continuing is a valid outcome, it is no round-2 halt signal, it adds
nothing to the budget's count, and it never replaces a review round; when
the same review also fires the Round-2 halt signal, the halt rule governs.
Step 8 of the workflow points to it without restating the trigger
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:342#"record the Fix-regression decision point"`).
The rule lives only in the skill references; `agents-md-section.md` does
not carry it, so it needs no AGENTS.md re-install and reaches an existing
install with the next kit re-install. No test pins the section's clauses;
`test/probe-plans-recovery.test.ts` only checks that every packaged reference
is routed from the entrypoint.

## Ceremony rules: review method by risk class, pinned prose

Two rules scale ceremony without touching the gate above.

Review method and tier by risk class (`packages/orchestrator-workflow/assets/skill/references/delegation-and-tiers.md:44#"### Review method and reviewer tier by risk class"`):
the section maps a change class to a method and a reviewer tier in three rows and is
the one place that does so. `adversarial` on the unsuffixed reviewer or
`reviewer-xhigh` covers security judgment, sandbox or isolation code, installers
and install or deploy scripts, hand-edited lockfiles, cross-major overrides, a
change to the safety rules the repository declares as its core, and anything the
operator flags high-risk (`packages/orchestrator-workflow/assets/skill/references/delegation-and-tiers.md:51#"on the unsuffixed reviewer (high) or"`).
`rigorous` on `reviewer-medium` covers all other code changes, tests and
behaviour-changing configuration included, and all other changes to instruction,
prompt, template, or policy files. `normal` on `reviewer-medium` covers a delta
that "contains only explanatory documentation, comments, or citations and contains no source- or test-file edits and no semantic change to executable commands, configuration, policy, instructions, or behavior",
and a delta that touches an instruction, policy, template, or prompt file is never docs-only for this mapping
(`packages/orchestrator-workflow/assets/skill/references/delegation-and-tiers.md:59#"a delta that contains only explanatory"`).
The rules under the rows: the tier a row names is the class default (a higher tier is the recorded non-default choice, a lower one is never chosen), and for the `adversarial` row, which names two tiers, the unsuffixed reviewer is the default and `reviewer-xhigh` the higher, recorded choice
(`packages/orchestrator-workflow/assets/skill/references/delegation-and-tiers.md:72#"tiers: the unsuffixed reviewer (high) is that row's default, and"`), a delta spanning classes takes its highest class and a
doubt goes up, fix and delta rounds keep the task's class, the operator flag only
raises, the closing options in `review-and-recovery.md` are not review rounds and are
governed there, and the safety core is the one each repository declares, the kit's installed
trust boundary, outward-action, review-gate, and reviewer read-only rules included.
The charter states none of this; it sits in `delegation-and-tiers.md`, and step 7
of the detailed workflow points there.

Pinned-prose changes (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:132#"## Pinned-prose changes"`)
cover a change to documentation wording that a test pins or could pin. The
section is installed into every consumer repository, so it states the pin
model generically: tests pin the machine contract (return field names, enums
and mandatory-field rules, template markers, and the headings a reader
consumes) and the safety rules the repository itself declares as its core,
each as whole sentences at exactly one normative site, and pin no other
prose. It names no rule of this package; this package's own four safety rules
are listed in the header comment above the safety-core tests of
`test/docs-consistency.test.ts` and in the CHANGELOG. The reason given for the
bound is that
"A prose mutant survives exactly when its bytes sit in no assertion"
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:136#"when its bytes sit in no assertion, so for prose outside the pinned set a"`),
so rounds that hunt for the next unpinned sentence do not converge. The
briefing's claim list is the contract plus the declared safety core, and it
bounds the reviewer's prose mutant space; a survivor outside the list is a
scope note in `residual_risks`, not a finding, unless the reviewer shows the
sentence is load-bearing. The cap stays: "Cap test-adequacy review rounds on
the change at two."
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:151#"Cap test-adequacy review rounds on the change at two."`),
where a test-adequacy round returns only `tests` findings of severity `low`
or `medium` about pin gaps, and a round returning any other finding is an
ordinary round outside the cap. Semantic findings are exempt from the bound
and the cap, and the cap changes neither the Round-2 halt rule, the
Review-round escalation budget, nor the Fix-regression decision point: a
test-adequacy round still counts as a negative round where it is one. The
review gate is unchanged. Step 7 of the workflow points to the section
without restating it. No test pins the section's clauses.

## See also

- [index.md](index.md): bundle entry point.
- [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md):
  marker enum mechanics, fail-open vs fail-closed parsing.
- [subagent-contracts-superset.md](subagent-contracts-superset.md): full
  subagent output contracts and the misfire rule in detail, including the
  [review-method axis](subagent-contracts-superset.md#review-method-axis-method_applied-and-withdrawn)
  (`review_method`/`method_applied`/`withdrawn`) briefed alongside the
  tier in step 7.
