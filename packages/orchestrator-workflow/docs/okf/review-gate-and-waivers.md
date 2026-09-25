---
type: invariant
title: Review gate and waiver semantics
description: Review is never skipped; the severity ladder, waiver rules, and the Decision-column vocabulary that gate acceptance across policy, skill, and templates.
tags: [review-gate, waivers, severity-ladder, decision-legend, misfire-rule]
timestamp: 2026-09-25T11:46:54Z
sources:
  - packages/orchestrator-workflow/assets/agents-md-section.md
  - packages/orchestrator-workflow/assets/agents/reviewer.md
  - packages/orchestrator-workflow/assets/templates/04-implementation-summary.md
  - packages/orchestrator-workflow/assets/templates/03-decisions.md
  - packages/orchestrator-workflow/assets/templates/05-review-findings.md
  - packages/orchestrator-workflow/assets/templates/06-handoff.md
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/test/template-markers.test.ts
  - packages/orchestrator-workflow/test/decision-authority.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
  - packages/orchestrator-workflow/assets/skill/references/contracts.md
  - packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md
  - packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md
  - packages/orchestrator-workflow/assets/skill/references/run-state-and-harness.md
---

# Review gate and waivers

Review is never skipped. Core rule: "Non-trivial review goes to a separate
reviewer subagent... Review itself is never skipped, in any run mode, not even for docs or
bulk changes"
(`packages/orchestrator-workflow/assets/agents-md-section.md:34#"changes."`). Scaling
delegation lets a trivial change be reviewed by the orchestrator itself
instead of a spawned reviewer subagent, but restates the same floor: "Either
way, review is never skipped" (`agents-md-section.md:58#"way, review is never skipped."`).
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
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:328#"Halt at the first"`),
and the Round-2 halt rule's own cross-reference to step 8 states the
identical scope, both clauses
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:56#"Step 8 of the detailed workflow states the operational"`),
both built from one shared test constant so dropping either clause at
either site fails that site's own test
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:1420#"built from one shared constant"`).
Full field-shape treatment of the implementer-side `class_closure` field
that produces `recurrence: repeated`'s class match is out of this doc's
lane; see
[subagent-contracts-superset.md](subagent-contracts-superset.md#class-closure-field).

A reviewer supplies findings and `acceptance_recommendation`; the
orchestrator decides acceptance after applying the review gate. The new
reviewer rule makes the boundary explicit: a reviewer recommendation cannot
become orchestrator acceptance or authorize a critical waiver; only the
operator may authorize that waiver
(`packages/orchestrator-workflow/assets/agents/reviewer.md:165#"A reviewer recommendation is not orchestrator acceptance"`). This is a
human/process authority rule, not a Markdown authorization mechanism.

For newly created records, `03-decisions.md` records each decision with a
stable ID, trigger/evidence, decision, accountable authority/source,
consequences, and a supersession reference
(`03-decisions.md:5#"| ID | Date | Trigger / Evidence |"`). Established runs
retain their recorded decision format, and an absent new field does not become
a retroactive acceptance blocker. A
baseline revision and every accepted waiver link to the applicable decision
ID. The source cell records concrete approval evidence; a bare role label,
coverage fact, reviewer recommendation, or illustrative fixture is not proof
of an operator approval. Routine in-scope decisions remain with the
orchestrator, while an out-of-scope change and a critical waiver require an
operator decision.

For a run that explicitly adopts `acceptance-baseline/v1`, an open residual
for a required baseline criterion blocks acceptance separately from this
review-findings severity gate. A reviewer recommendation or a coverage label
does not close that residual; the reviewer compares the returned baseline and
`criterion_evidence` index with the frozen delegated records. Each assigned
criterion has one entry; empty references remain unresolved with a reason in
risks/open questions. The coverage table resolves those references from the
owning run directory and checks the producer artifact's actual baseline,
criterion and checked state. Manual results retain their artifact revision,
reviewer, method and reasoned result. Existing runs remain governed by their
recorded original contract, so absent v1 fields do not retroactively block
them. Unknown provenance is resolved before dependent delegation; missing
fields never choose the contract.

Reviewer findings carry `severity: low | medium | high | critical`
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:200#"severity: low | medium | high | critical"`, reviewer output contract). Only high and critical block
acceptance: "High or critical reviewer findings block final acceptance until
fixed or explicitly waived... the gate applies to every review pass,
including the orchestrator's own review of a trivial change"
(`agents-md-section.md:112#"trivial change."`). Medium and low are "addressed or consciously
accepted at the orchestrator's judgment" (`agents-md-section.md:121#"orchestrator's judgment."`); no
waiver bookkeeping applies to them.

Do not conflate two distinct vocabularies attached to the same review: the
per-finding `Decision` column (below) and the whole-review
`acceptance_recommendation: accept | accept_with_notes | fix_required |
reject` (`packages/orchestrator-workflow/assets/skill/references/contracts.md:206#"acceptance_recommendation: accept | accept_with_notes |"`; mirrored in the findings template's Acceptance
Recommendation section,
`packages/orchestrator-workflow/assets/templates/05-review-findings.md:32#"accept | accept_with_notes | fix_required | reject"`).
A review can recommend `fix_required` overall while individual low findings
carry Decision `accepted`; the gate only inspects Decision on high/critical
rows. Since 0.16.0 the field is hard-mandatory, not just conventionally
expected: "`acceptance_recommendation` is mandatory: every reviewer return
must set it. When it is missing, the orchestrator asks the reviewer to
resupply it instead of inferring one from the findings list"
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:221-223#"instead of inferring one from the findings list."`; the installed `reviewer.md:184#"never leave it blank or omit it."` prompt carries the mirrored
second-person rule). Full treatment is out of scope here; see
[Acceptance-recommendation mandatory rule](#acceptance-recommendation-mandatory-rule-0160)
below.

## Waiver rules

- Critical: "waived by the operator. The orchestrator never waives a
  critical finding on its own" (`agents-md-section.md:115#"never waives a critical finding on its own."`); SKILL.md
  step 8 echoes "critical findings require operator sign-off"
  (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:313#"explicitly waived: critical findings require operator"`).
- High: "waived by the orchestrator with a recorded rationale"
  (`agents-md-section.md:117#"rationale."`; `packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:314#"findings require the orchestrator to record a"`).
- Deferring counts as waiving, for both severities: "Deferring such a
  finding counts as a waiver" (`agents-md-section.md:110#"explicitly waived. Deferring such a finding counts as a waiver, and the gate"`). SKILL.md makes
  the symmetry explicit: "Deferring a high or critical finding counts as a
  waiver and follows the same rules" (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:315#"or critical finding counts as a waiver and follows the"`). A deferred
  critical still needs operator sign-off; a deferred high still needs an
  orchestrator-recorded rationale.
- Recorded in
  `packages/orchestrator-workflow/assets/templates/03-decisions.md`, whose
  decision table has seven columns: `ID`, `Date`, `Trigger / Evidence`,
  `Decision`, `Authority / Source`, `Consequences`, and `Supersedes`
  (`03-decisions.md:5#"| ID | Date | Trigger / Evidence |"`). The Authority /
  Source cell records the sign-off or rationale, and `Supersedes` links a
  revision to its prior decision. Its separate Review-round escalation table
  (`03-decisions.md:14#"## Review-round escalation"`) remains unchanged; there
  is no additional waiver schema.
- Summarized in `06-handoff.md`'s Accepted Waivers section
  (`agents-md-section.md:119#"the Accepted Waivers section of"`; `packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:317#"the Accepted Waivers section of"`), instructed to "Mirror
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
other ineligible finding (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:326#"high/critical or other ineligible finding."`;
`agents-md-section.md:130#"row with its Severity and Decision headers unchanged and Decision"`). This is a closing
option after review, not an exception to the review requirement or the waiver
rules above.

For an eligible closure, record the concrete verification in a
`05-review-findings.md` row without changing its Severity or Decision headers,
and set the row's Decision to `accepted`
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:328#"unchanged and setting Decision to"`; `05-review-findings.md:16#"| Severity | Category | Description | Suggested Fix | Decision |"`).
No reader or template schema changes: the existing Decision legend and all
high/critical waiver and escalation rules continue to apply. The policy is
pinned in `test/docs-consistency.test.ts:4887#"docs-only closing deltas stay narrowly bounded"`.

## The Decision legend in 05-review-findings.md

detailed workflow reference is the transfer instruction: "transfer each finding from the
reviewer output contract into the table's columns as-is, keeping the
Severity and Decision headers unchanged, since those two are what the
orchestrator-workflow completeness reader verifies" (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:242#"those two are what the orchestrator-workflow completeness reader verifies; for every"`).
Immediately after that quote, detailed workflow reference also carries a 0.13.0 addition
on the same table's placeholder/legend row (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:246#"rows as the template never having been filled in. When"`): replace it
when transferring findings, delete it outright for a genuine zero-findings
review; full treatment (the mixed-state bypass it closes, the mirrored
template comment, the reader's literal match) is out of scope here, see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).
Immediately after the placeholder-row rule, step 7 also carries the 0.14.0
reproduction requirement (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:253#"lint): only claims that could vary run to run trigger"`); full treatment is out of scope
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
chosen enum value when finalizing each file (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:366#"non-accepting (fail-closed)."`). Left as
`TODO`, the harness solution-acceptance gate reads the run as non-accepting.
`packages/orchestrator-workflow/test/template-markers.test.ts:57#"<!-- solution-acceptance: run-base = TODO -->"` pins
exactly one marker per template, each defaulting to `TODO`. This is a
different fail-closed design than the run-base marker, which fails open; see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).

## Three surfaces kept in sync

`packages/orchestrator-workflow/test/docs-consistency.test.ts:194#"addressed or consciously accepted by the orchestrator"`
("review gate ships in the policy, skill, and handoff template") pins the
invariant across all three: `agents-md-section.md`'s `### Review gate`
heading plus "block final acceptance until fixed or explicitly waived" and
"waived by the operator" (test lines 117-123); `SKILL.md`'s "block acceptance
until fixed or explicitly waived" and "Accepted Waivers section of
`06-handoff.md`" phrasing (test lines 125-130); `06-handoff.md`'s `##
Accepted Waivers` heading and its `Finding | Severity | Rationale` header
(test lines 132-135). A negative pin (test lines 137-141) guards against a
superseded softer wording, "addressed or consciously accepted by the
orchestrator", reappearing in `agents-md-section.md`. A second suite,
`test/template-markers.test.ts:266#"expect(reviewTemplate).toMatch(/arms? the"`, independently pins the
findings-table header convention and the Decision-legend vocabulary above.

## Misfire rule's review-gate consequence (0.11.0)

Added in 0.11.0 after a live incident: a reviewer subagent spawn returned in
5 seconds with 0 tool uses, handing back harness boilerplate instead of the
reviewer output contract (`CHANGELOG.md:#[0.11.0]`). The Subagent misfire rule
closes with the review-specific consequence: "a misfired review is not a
review and never satisfies the review gate, since review is never skipped"
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:41#"review and never satisfies the review gate, since"`), pinned by
`packages/orchestrator-workflow/test/docs-consistency.test.ts:580#"never satisfies the review gate"`. Since
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
the placeholder-row rule (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:253#"lint): only claims that could vary run to run trigger"`): when acceptance rests on such
evidence, the reviewer must reproduce it independently (its own runs or
measurements) and record method, sample size, and result against the
implementer's claim; a single deterministic check (one test run, `tsc`,
lint) does not trigger it. The installed `reviewer.md` prompt carries the
same rule (`reviewer.md:234#"lint) do not trigger this."`), and both output contracts gained a matching
`reproduction: {method, sample_size, result, matches_implementer_claim}`
field (`packages/orchestrator-workflow/assets/skill/references/contracts.md:215#"matches_implementer_claim: matched | mismatched |"`, `reviewer.md:308#"residual_risks:"`); `matches_implementer_claim`
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
`packages/orchestrator-workflow/assets/skill/references/contracts.md:221-223#"instead of inferring one from the findings list."` states it and adds the orchestrator's response when it is
missing: ask the reviewer to resupply it, rather than infer one from the
findings, and the installed `reviewer.md:184#"never leave it blank or omit it."` prompt carries the mirrored
second-person rule ("always set it in your output; never leave it blank or
omit it"). This is distinct from the per-finding `Decision` column and the
severity ladder above: a reviewer could previously satisfy every other part
of the contract and still omit the one field that carries its overall
verdict. 8ab22cb0 adds a mechanical, structure-only check for this same
requirement: the `validate-review-report` CLI subcommand documented at
`packages/orchestrator-workflow/assets/skill/references/contracts.md:225#"A structural check for this exact contract ships as a CLI subcommand:"`
parses a reviewer return and reports a missing or invalid
`acceptance_recommendation` (or any other required field) as a diagnostic,
but never judges semantic adequacy or substitutes for this rule's
orchestrator-side ask-back response.

Motivated by the same 16-round dogfood as the mutation-probes hardening in
[subagent-contracts-superset.md](subagent-contracts-superset.md#mutation-probes-requirement-0160)
(`CHANGELOG.md:#[0.16.0]#"as a hard-mandatory"`, agent-tasks task 16637a96): one reviewer round in
that dogfood omitted `acceptance_recommendation` entirely.
`packages/orchestrator-workflow/test/docs-consistency.test.ts:1469#"the orchestrator asks the reviewer to resupply it"` pins
the rule in both the installed prompt and `SKILL.md`'s reference copy.

## Review-round escalation budget

The Round-2 halt rule (full treatment out of scope here; see
[subagent-contracts-superset.md](subagent-contracts-superset.md)) stops a
single defect-class recurrence within one task, but nothing previously
forced a choice once that stopping, or `fix_required` review rounds, kept
recurring on the same task. This budget applies in addition to the halt
rule's split-or-redesign response, not instead of it:
`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:62#"## Review-round escalation budget"` triggers "by the second
round-2 halt signal on the same task, or by the third `fix_required`
review round on the same task, whichever comes first", at which point the
orchestrator picks one of three named escalations
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:75#"**Tier or model escalation**"`,
`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:84#"**Advisor spawn**"`, `packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:87#"**Merge-hold**"`: raise
the implementer to at least `-xhigh` where installed or to the strongest
available model, an advisor spawn asked "redesign, split, or hold?", or an
operator merge-hold). A negative round has an `acceptance_recommendation` of
`fix_required` or `reject`; a misfired review is not a round. A negative round counts only with at least one introduced_by_delta yes/unknown finding; no stays ordinary gate. Which of the three is picked is judgment; that one
is picked and recorded is not
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:90#"Judgment governs which of the three to pick; only that one is chosen and"`).
`agents-md-section.md:150#"rule's split-or-redesign response, not instead of it."`
carries the same rule in short form for repos without the full skill text
loaded.

The `single` branch is defined in the normative tier-or-model option
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:75#"**Tier or model escalation**"`); the policy fence carries only its bound clause.

The choice is recorded in `03-decisions.md`'s new named section
(`03-decisions.md:14#"## Review-round escalation"`), a one-row-per-task
table (`03-decisions.md:18#"| Task | Choice | Reason |"`) whose
`Choice` column is the enum `n/a | tier_escalation | advisor |
merge_hold`, because one run carries multiple tasks and each can trigger
the budget independently. A `review-round-escalation` marker defaulting
to `n/a` is kept alongside the table as a reader shortcut to the most
recent choice
(`03-decisions.md:24#"<!-- review-round-escalation: choice = n/a -->"`).
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
yet (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:101#"## Fix-regression decision point"`):
the trigger, in the review of a fix round, is at least one `high` or
`critical` finding that the previous round's review did not report, with
`introduced_by_delta: yes`
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:104#"reports at least one"`);
the qualifier is read off the findings of the two reviews, not off
`recurrence`, so a `recurrence: repeated` finding the previous round did
not report still triggers it. `unknown` and `no` do not trigger it;
`unknown` keeps its treatment under the halt rule and the budget, which
both act on it. Before another fix round the
orchestrator names in one sentence why the fix could introduce the defect
(the structural cause, or the statement that there is none) and records one of
four outcomes in `03-decisions.md`: continue with the stated reason,
redesign, split, or hold
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:118#"record one of four outcomes as a decision in"`);
an advisor spawn is optional. It is a decision point and not a halt
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:122#"This is a decision point, not a halt"`):
continuing is a valid outcome, it is no round-2 halt signal, it adds
nothing to the budget's count, and it never replaces a review round; when
the same review also fires the Round-2 halt signal, the halt rule governs.
Step 8 of the workflow points to it without restating the trigger
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:334#"record the Fix-regression decision point"`).
The rule lives only in the skill references; `agents-md-section.md` does
not carry it, so it needs no AGENTS.md re-install and reaches an existing
install with the next kit re-install. Pinned by
`test/probe-plans-recovery.test.ts`.

## Ceremony rules: baseline revisions, docs-only review default, pinned prose

Three rules scale ceremony without touching the gate above.

Baseline revisions (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:160#"Record a baseline revision only when"`):
"Record a baseline revision only when scope or the normative text of a criterion changes, including a change to what its verification checks; a wording precision that leaves the check itself unchanged is a `03-decisions.md` entry, not a revision";
the orchestrator records that entry, states in it why no evidence is
invalidated, and communicates the corrected wording in the next delegation.
Who may revise a baseline and what a revision records is unchanged.

Docs-only review default (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:231#"For a review round whose entire delta contains only explanatory documentation"`):
"For a review round whose entire delta contains only explanatory documentation, comments, or citations and contains no source- or test-file edits and no semantic change to executable commands, configuration, policy, instructions, or behavior, default to the `-medium` reviewer tier with `review_method: normal` where tier variants are installed".
The sentence declares itself a refinement of the general tier default for
that one class. "A review round that touches an instruction, policy, template
or prompt file (for example a SKILL.md instruction) keeps the general default,
whatever the file type, and the minimums named above are unaffected."
`agents-md-section.md` still states only the general default and does not point
to this refinement.

Pinned-prose changes (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:130#"## Pinned-prose changes"`)
cover a change whose acceptance rests on tests that pin documentation
wording. The reason given is that
"A prose mutant survives exactly when its bytes sit in no assertion"
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:134#"mutant survives exactly when its bytes sit in no assertion"`),
so rounds that hunt for the next unpinned sentence do not converge. The
section asks for one normative site per rule, a claim list in the acceptance
criterion as the pin obligation: "Every normative sentence the change adds or
alters at that site is pinned; one left unpinned is named in the criterion with
the reason it is not load-bearing." A briefing bounds the reviewer's prose
mutant space to that list, and "When the briefing bounds the prose mutant space
to a claim list, respect that bound and put scope notes in `residual_risks`,
unless an unlisted sentence is shown to be load-bearing." Copies are bound by
one shared test constant, and
"Cap test-adequacy review rounds on the change at two."
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:151#"Cap test-adequacy review rounds on the change at two."`).
"A test-adequacy review round is one whose returned findings are all `tests`
findings of severity `low` or `medium` about pin gaps on the pinned prose; a
round returning any other finding is an ordinary round outside the cap." "The
cap changes neither the Round-2 halt rule, the Review-round escalation budget
nor the Fix-regression decision point: a test-adequacy review round still
counts as a negative round where it is one." It exempts semantic findings from
bound and cap and leaves the review gate as it is. Step 7 of the workflow
points to the section without restating it. Pinned by
`test/probe-plans-recovery.test.ts`, which asserts the quoted clauses against
the references and this section. The CHANGELOG's 0.37.0 entry that first
shipped these rules stays as released and is not part of that pin; the
0.39.0 entry summarizes the docs-only and pinned-prose tightening without
repeating it verbatim.

## See also

- [index.md](index.md): bundle entry point.
- [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md):
  marker enum mechanics, fail-open vs fail-closed parsing.
- [subagent-contracts-superset.md](subagent-contracts-superset.md): full
  subagent output contracts and the misfire rule in detail, including the
  [review-method axis](subagent-contracts-superset.md#review-method-axis-method_applied-and-withdrawn)
  (`review_method`/`method_applied`/`withdrawn`) briefed alongside the
  tier in step 7.
