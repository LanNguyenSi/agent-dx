---
type: invariant
title: Review gate and waiver semantics
description: Review is never skipped; the severity ladder, waiver rules, and the Decision-column vocabulary that gate acceptance across policy, skill, and templates.
tags: [review-gate, waivers, severity-ladder, decision-legend, misfire-rule]
timestamp: 2026-08-30T09:30:00Z
sources:
  - packages/orchestrator-workflow/assets/agents-md-section.md
  - packages/orchestrator-workflow/assets/skill/SKILL.md
  - packages/orchestrator-workflow/assets/templates/03-decisions.md
  - packages/orchestrator-workflow/assets/templates/05-review-findings.md
  - packages/orchestrator-workflow/assets/templates/06-handoff.md
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/test/template-markers.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
---

# Review gate and waivers

Review is never skipped. Core rule: "Non-trivial review goes to a separate
reviewer subagent... Review itself is never skipped, not even for docs or
batch changes"
(`packages/orchestrator-workflow/assets/agents-md-section.md:26-28#"changes."`). Scaling
delegation lets a trivial change be reviewed by the orchestrator itself
instead of a spawned reviewer subagent, but restates the same floor: "Either
way, review is never skipped" (`agents-md-section.md:48-51#"way, review is never skipped."`).
`packages/orchestrator-workflow/assets/skill/SKILL.md:18-22#"the apparatus changes. When tier variants are"` carries the
identical invariant for ceremony-scaling: "Review judgment still applies to
every change; only the size of the apparatus changes."

## Severity ladder and what blocks

Reviewer findings carry `severity: low | medium | high | critical`
(`SKILL.md:359#"severity: low | medium | high | critical"`, reviewer output contract). Only high and critical block
acceptance: "High or critical reviewer findings block final acceptance until
fixed or explicitly waived... the gate applies to every review pass,
including the orchestrator's own review of a trivial change"
(`agents-md-section.md:93-96#"trivial change."`). Medium and low are "addressed or consciously
accepted at the orchestrator's judgment" (`agents-md-section.md:104-105#"orchestrator's judgment."`); no
waiver bookkeeping applies to them.

Do not conflate two distinct vocabularies attached to the same review: the
per-finding `Decision` column (below) and the whole-review
`acceptance_recommendation: accept | accept_with_notes | fix_required |
reject` (`SKILL.md:364#"acceptance_recommendation: accept | accept_with_notes |"`; mirrored in the findings template's Acceptance
Recommendation section,
`packages/orchestrator-workflow/assets/templates/05-review-findings.md:26#"accept | accept_with_notes | fix_required | reject"`).
A review can recommend `fix_required` overall while individual low findings
carry Decision `accepted`; the gate only inspects Decision on high/critical
rows. Since 0.16.0 the field is hard-mandatory, not just conventionally
expected: "`acceptance_recommendation` is mandatory: every reviewer return
must set it. When it is missing, the orchestrator asks the reviewer to
resupply it instead of inferring one from the findings list" (`SKILL.md:
355-357`; the installed `reviewer.md:35-41#"never leave it blank or omit it."` prompt carries the mirrored
second-person rule). Full treatment is out of scope here; see
[Acceptance-recommendation mandatory rule](#acceptance-recommendation-mandatory-rule-0160)
below.

## Waiver rules

- Critical: "waived by the operator. The orchestrator never waives a
  critical finding on its own" (`agents-md-section.md:98-99#"never waives a critical finding on its own."`); SKILL.md
  step 8 echoes "critical findings require operator sign-off"
  (`SKILL.md:228#"explicitly waived: critical findings require operator"`).
- High: "waived by the orchestrator with a recorded rationale"
  (`agents-md-section.md:100-101#"rationale."`; `SKILL.md:228-229#"findings require the orchestrator to record a"`).
- Deferring counts as waiving, for both severities: "Deferring such a
  finding counts as a waiver" (`agents-md-section.md:94#"explicitly waived. Deferring such a finding counts as a waiver, and the gate"`). SKILL.md makes
  the symmetry explicit: "Deferring a high or critical finding counts as a
  waiver and follows the same rules" (`SKILL.md:229-230#"or critical finding counts as a waiver and follows the"`). A deferred
  critical still needs operator sign-off; a deferred high still needs an
  orchestrator-recorded rationale.
- Recorded in
  `packages/orchestrator-workflow/assets/templates/03-decisions.md`, whose
  only structure is a `Date | Decision | Reason | Consequences` table
  (`03-decisions.md:3#"| Date | Decision | Reason | Consequences |"`); the Reason cell is where the sign-off or rationale
  text lives, there is no separate waiver schema.
- Summarized in `06-handoff.md`'s Accepted Waivers section
  (`agents-md-section.md:102-103#"the Accepted Waivers section of"`; `SKILL.md:231-232#"the Accepted Waivers section of"`), instructed to "Mirror
  03-decisions.md"
  (`packages/orchestrator-workflow/assets/templates/06-handoff.md:21#"<!-- Waived high/critical reviewer findings, or none. Mirror 03-decisions.md. -->"`) via a
  `Finding | Severity | Rationale | Approved By` table
  (`06-handoff.md:19-25#"| <!-- finding --> | high/critical | <!-- rationale --> | operator/orchestrator |"`).

## The Decision legend in 05-review-findings.md

SKILL.md step 7 is the transfer instruction: "transfer each finding from the
reviewer output contract into the table's columns as-is, keeping the
Severity and Decision headers unchanged, since those two are what the
orchestrator-workflow completeness reader verifies" (`SKILL.md:206-209#"orchestrator-workflow completeness reader verifies."`).
Immediately after that quote, SKILL.md step 7 also carries a 0.13.0 addition
on the same table's placeholder/legend row (`SKILL.md:209-213#"rows as the template never having been filled in. When"`): replace it
when transferring findings, delete it outright for a genuine zero-findings
review; full treatment (the mixed-state bypass it closes, the mirrored
template comment, the reader's literal match) is out of scope here, see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).
Immediately after the placeholder-row rule, step 7 also carries the 0.14.0
reproduction requirement (`SKILL.md:213-220#"lint): only claims that could vary run to run trigger"`); full treatment is out of scope
here, see [Reproduction requirement](#reproduction-requirement-0140) below.
The table header is `Severity | Category | Description | Suggested Fix |
Decision` (`05-review-findings.md:11#"| Severity | Category | Description | Suggested Fix | Decision |"`). Its Decision legend comment
(`05-review-findings.md:10#"<!-- Decision legend: a high/critical finding counts as RESOLVED (the completeness gate passes) only when its Decision is"`) states `RESOLVED_DECISIONS = {accepted,
defer}`: a high/critical finding counts as RESOLVED (gate passes) only when
Decision is `accepted` or `defer`; every other value, `fix`, `reject`,
blank, `open`, `TODO`, "leaves the finding unresolved and ARMS the gate"
until changed. The example row was narrowed to `accepted/defer` in 0.7.4
after a prior `accepted/fix/defer/reject` example misled a run into an
unexpectedly armed gate
(`packages/orchestrator-workflow/CHANGELOG.md:#[0.7.4]`).

The two column headers are load-bearing for a second, independent reason:
`05-review-findings.md:9#"<!-- The Severity and Decision column headers below are load-bearing: the orchestrator-workflow completeness reader locates this table by its header row and verifies unresolved findings from those two columns. Do not rename or drop them. -->"` documents them as the anchor the grounding-mcp
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
(`05-review-findings.md:28#"<!-- solution-acceptance: acceptance-recommendation = TODO -->"`) and `<!-- solution-acceptance: final-status =
TODO -->` (`06-handoff.md:43#"<!-- solution-acceptance: final-status = TODO -->"`). SKILL.md instructs replacing `TODO` with the
chosen enum value when finalizing each file (`SKILL.md:259-263#"non-accepting (fail-closed)."`). Left as
`TODO`, the harness solution-acceptance gate reads the run as non-accepting.
`packages/orchestrator-workflow/test/template-markers.test.ts:11-41#"<!-- solution-acceptance: run-base = TODO -->"` pins
exactly one marker per template, each defaulting to `TODO`. This is a
different fail-closed design than the run-base marker, which fails open; see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).

## Three surfaces kept in sync

`packages/orchestrator-workflow/test/docs-consistency.test.ts:110-137#"addressed or consciously accepted by the orchestrator"`
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
`test/template-markers.test.ts:141-193#"expect(reviewTemplate).toMatch(/arms? the"`, independently pins the
findings-table header convention and the Decision-legend vocabulary above.

## Misfire rule's review-gate consequence (0.11.0)

Added in 0.11.0 after a live incident: a reviewer subagent spawn returned in
5 seconds with 0 tool uses, handing back harness boilerplate instead of the
reviewer output contract (`CHANGELOG.md:#[0.11.0]`). The Subagent misfire rule
closes with the review-specific consequence: "a misfired review is not a
review and never satisfies the review gate, since review is never skipped"
(`SKILL.md:513-514#"review and never satisfies the review gate, since"`), pinned by
`packages/orchestrator-workflow/test/docs-consistency.test.ts:521-523#"never satisfies the review gate"`. Since
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
the findings table as reported. SKILL.md step 7 now states it right after
the placeholder-row rule (`SKILL.md:213-220#"lint): only claims that could vary run to run trigger"`): when acceptance rests on such
evidence, the reviewer must reproduce it independently — its own runs or
measurements — and record method, sample size, and result against the
implementer's claim; a single deterministic check (one test run, `tsc`,
lint) does not trigger it. The installed `reviewer.md` prompt carries the
same rule (`reviewer.md:56-66#"lint) do not trigger this."`), and both output contracts gained a matching
`reproduction: {method, sample_size, result, matches_implementer_claim}`
field (`SKILL.md:369-373#"matches_implementer_claim: matched | mismatched |"`, `reviewer.md:82-85#"residual_risks:"`); `matches_implementer_claim`
accepts `not_applicable` so a review that never hits the narrow trigger is
not forced to fabricate a reproduction record.

Motivating incident (`CHANGELOG.md:#[0.14.0]`): agent-dx run
`2026-07-18-harness-subprocess-test-deflake`, reviewer pass 1. The
implementer's evidence read "8/8" full-suite runs green for a `maxWorkers`
concurrency cap; the reviewer reran the suite independently (6 sequential
runs) and got 2/6 red with the same failure signatures, a ~1/3 flake rate
matching the pre-fix baseline — the fix did not work, and nothing in the
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
`SKILL.md:376-378#"instead of inferring one from the findings list."` states it and adds the orchestrator's response when it is
missing — ask the reviewer to resupply it, rather than infer one from the
findings — and the installed `reviewer.md:35-41#"never leave it blank or omit it."` prompt carries the mirrored
second-person rule ("always set it in your output; never leave it blank or
omit it"). This is distinct from the per-finding `Decision` column and the
severity ladder above: a reviewer could previously satisfy every other part
of the contract and still omit the one field that carries its overall
verdict.

Motivated by the same 16-round dogfood as the mutation-probes hardening in
[subagent-contracts-superset.md](subagent-contracts-superset.md#mutation-probes-requirement-0160)
(`CHANGELOG.md:#[0.16.0]#"as a hard-mandatory"`, agent-tasks task 16637a96): one reviewer round in
that dogfood omitted `acceptance_recommendation` entirely.
`packages/orchestrator-workflow/test/docs-consistency.test.ts:1070-1085#"the orchestrator asks the reviewer to resupply it"` pins
the rule in both the installed prompt and `SKILL.md`'s reference copy.

## Review-round escalation budget

The Round-2 halt rule (full treatment out of scope here; see
[subagent-contracts-superset.md](subagent-contracts-superset.md)) stops a
single defect-class recurrence within one task, but nothing previously
forced a choice once that stopping, or `fix_required` review rounds, kept
recurring on the same task. This budget applies in addition to the halt
rule's split-or-redesign response, not instead of it:
`SKILL.md:531#"## Review-round escalation budget"` triggers "by the second
round-2 halt signal on the same task, or by the third `fix_required`
review round on the same task, whichever comes first", at which point the
orchestrator picks one of three named escalations
(`SKILL.md:546#"**Tier or model escalation**"`,
`SKILL.md:552#"**Advisor spawn**"`, `SKILL.md:555#"**Merge-hold**"`: raise
the implementer to at least `-xhigh` where installed or to the strongest
available model, an advisor spawn asked "redesign, split, or hold?", or an
operator merge-hold). A counted round is a completed reviewer return whose
`acceptance_recommendation` is `fix_required` or `reject`; a misfired
review is not a round. Which of the three is picked is judgment; that one
is picked and recorded is not
(`SKILL.md:558#"Judgment governs which of the three to pick; only that one is chosen and"`).
`agents-md-section.md:106-120#"rule's split-or-redesign response, not instead of it."`
carries the same rule in short form for repos without the full skill text
loaded.

The choice is recorded in `03-decisions.md`'s new named section
(`03-decisions.md:7#"## Review-round escalation"`), a one-row-per-task
table (`03-decisions.md:11#"| Task | Choice | Reason |"`) whose
`Choice` column is the enum `n/a | tier_escalation | advisor |
merge_hold`, because one run carries multiple tasks and each can trigger
the budget independently. A `review-round-escalation` marker defaulting
to `n/a` is kept alongside the table as a reader shortcut to the most
recent choice
(`03-decisions.md:17#"<!-- review-round-escalation: choice = n/a -->"`).
Unlike the two `solution-acceptance:` verdict markers in
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md),
whose `TODO` default is a fail-closed sentinel that blocks acceptance
until replaced, this marker's `n/a` default is a valid enum member, not a
sentinel: it is deliberately fail-open, because most runs never trigger
the budget at all, and a future reader must not read a marker still
showing `n/a` as "escalation was needed but not recorded" -- it means the
budget was never hit. This marker is a documented convention only: no
reader in this package or in grounding-mcp parses it today (see the
CHANGELOG's `[Unreleased]` entry). Escalating never substitutes for a
review round: whichever option is chosen, the next attempt still goes
through the reviewer subagent in full, the same review-never-skipped
floor stated at the top of this doc.

The reviewer output contract also gained a per-finding `recurrence: new |
repeated` field so the orchestrator can read the trigger off the
reviewer's own return; full field-duplication mechanics are out of scope
here, see
[subagent-contracts-superset.md](subagent-contracts-superset.md#recurrence-field).

## See also

- [index.md](index.md): bundle entry point.
- [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md):
  marker enum mechanics, fail-open vs fail-closed parsing.
- [subagent-contracts-superset.md](subagent-contracts-superset.md): full
  subagent output contracts and the misfire rule in detail.
