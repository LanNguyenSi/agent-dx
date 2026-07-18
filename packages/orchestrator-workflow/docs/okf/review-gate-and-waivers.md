---
type: invariant
title: Review gate and waiver semantics
description: Review is never skipped; the severity ladder, waiver rules, and the Decision-column vocabulary that gate acceptance across policy, skill, and templates.
tags: [review-gate, waivers, severity-ladder, decision-legend, misfire-rule]
timestamp: 2026-07-18T12:00:00Z
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
(`packages/orchestrator-workflow/assets/agents-md-section.md:23-25`). Scaling
delegation lets a trivial change be reviewed by the orchestrator itself
instead of a spawned reviewer subagent, but restates the same floor: "Either
way, review is never skipped" (`agents-md-section.md:41-44`).
`packages/orchestrator-workflow/assets/skill/SKILL.md:18-22` carries the
identical invariant for ceremony-scaling: "Review judgment still applies to
every change; only the size of the apparatus changes."

## Severity ladder and what blocks

Reviewer findings carry `severity: low | medium | high | critical`
(`SKILL.md:238`, reviewer output contract). Only high and critical block
acceptance: "High or critical reviewer findings block final acceptance until
fixed or explicitly waived... the gate applies to every review pass,
including the orchestrator's own review of a trivial change"
(`agents-md-section.md:48-51`). Medium and low are "addressed or consciously
accepted at the orchestrator's judgment" (`agents-md-section.md:59-60`); no
waiver bookkeeping applies to them.

Do not conflate two distinct vocabularies attached to the same review: the
per-finding `Decision` column (below) and the whole-review
`acceptance_recommendation: accept | accept_with_notes | fix_required |
reject` (`SKILL.md:242`; mirrored in the findings template's Acceptance
Recommendation section,
`packages/orchestrator-workflow/assets/templates/05-review-findings.md:26`).
A review can recommend `fix_required` overall while individual low findings
carry Decision `accepted`; the gate only inspects Decision on high/critical
rows.

## Waiver rules

- Critical: "waived by the operator. The orchestrator never waives a
  critical finding on its own" (`agents-md-section.md:53-54`); SKILL.md
  step 8 echoes "critical findings require operator sign-off"
  (`SKILL.md:133-135`).
- High: "waived by the orchestrator with a recorded rationale"
  (`agents-md-section.md:55-56`; `SKILL.md:135-136`).
- Deferring counts as waiving, for both severities: "Deferring such a
  finding counts as a waiver" (`agents-md-section.md:48-49`). SKILL.md makes
  the symmetry explicit: "Deferring a high or critical finding counts as a
  waiver and follows the same rules" (`SKILL.md:136-137`). A deferred
  critical still needs operator sign-off; a deferred high still needs an
  orchestrator-recorded rationale.
- Recorded in
  `packages/orchestrator-workflow/assets/templates/03-decisions.md`, whose
  only structure is a `Date | Decision | Reason | Consequences` table
  (`03-decisions.md:3`); the Reason cell is where the sign-off or rationale
  text lives, there is no separate waiver schema.
- Summarized in `06-handoff.md`'s Accepted Waivers section
  (`agents-md-section.md:57-58`; `SKILL.md:138-139`), instructed to "Mirror
  03-decisions.md"
  (`packages/orchestrator-workflow/assets/templates/06-handoff.md:21`) via a
  `Finding | Severity | Rationale | Approved By` table
  (`06-handoff.md:19-25`).

## The Decision legend in 05-review-findings.md

SKILL.md step 7 is the transfer instruction: "transfer each finding from the
reviewer output contract into the table's columns as-is, keeping the
Severity and Decision headers unchanged, since those two are what the
orchestrator-workflow completeness reader verifies" (`SKILL.md:117-120`).
Immediately after that quote, SKILL.md step 7 also carries a 0.13.0 addition
on the same table's placeholder/legend row (`SKILL.md:121-124`): replace it
when transferring findings, delete it outright for a genuine zero-findings
review; full treatment (the mixed-state bypass it closes, the mirrored
template comment, the reader's literal match) is out of scope here, see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).
Immediately after the placeholder-row rule, step 7 also carries the 0.14.0
reproduction requirement (`SKILL.md:125-132`); full treatment is out of scope
here, see [Reproduction requirement](#reproduction-requirement-0140) below.
The table header is `Severity | Category | Description | Suggested Fix |
Decision` (`05-review-findings.md:11`). Its Decision legend comment
(`05-review-findings.md:10`) states `RESOLVED_DECISIONS = {accepted,
defer}`: a high/critical finding counts as RESOLVED (gate passes) only when
Decision is `accepted` or `defer`; every other value, `fix`, `reject`,
blank, `open`, `TODO`, "leaves the finding unresolved and ARMS the gate"
until changed. The example row was narrowed to `accepted/defer` in 0.7.4
after a prior `accepted/fix/defer/reject` example misled a run into an
unexpectedly armed gate
(`packages/orchestrator-workflow/CHANGELOG.md:180-194`).

The two column headers are load-bearing for a second, independent reason:
`05-review-findings.md:9` documents them as the anchor the grounding-mcp
completeness reader uses to locate the table at all (a header row whose
cells include both `Severity` and `Decision`, case-insensitive). Renaming or
dropping either header hides the table from the reader regardless of
Decision values; the load-bearing comment (plus a one-sentence transfer
rule in SKILL.md) was added in 0.7.3 after a live run drifted onto an
unparseable `Severity | Finding | Resolution` convention, while the shipped
header itself was already correct (`CHANGELOG.md:196-212`, the
already-correct-header statement at 207-208).

## Fail-closed acceptance markers

Two machine-readable markers sit next to the prose gate: `<!--
solution-acceptance: acceptance-recommendation = TODO -->`
(`05-review-findings.md:28`) and `<!-- solution-acceptance: final-status =
TODO -->` (`06-handoff.md:43`). SKILL.md instructs replacing `TODO` with the
chosen enum value when finalizing each file (`SKILL.md:150-154`). Left as
`TODO`, the harness solution-acceptance gate reads the run as non-accepting.
`packages/orchestrator-workflow/test/template-markers.test.ts:11-44` pins
exactly one marker per template, each defaulting to `TODO`. This is a
different fail-closed design than the run-base marker, which fails open; see
[run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).

## Three surfaces kept in sync

`packages/orchestrator-workflow/test/docs-consistency.test.ts:78-108`
("review gate ships in the policy, skill, and handoff template") pins the
invariant across all three: `agents-md-section.md`'s `### Review gate`
heading plus "block final acceptance until fixed or explicitly waived" and
"waived by the operator" (test lines 83-89); `SKILL.md`'s "block acceptance
until fixed or explicitly waived" and "Accepted Waivers section of
`06-handoff.md`" phrasing (test lines 91-96); `06-handoff.md`'s `##
Accepted Waivers` heading and its `Finding | Severity | Rationale` header
(test lines 98-101). A negative pin (test lines 103-107) guards against a
superseded softer wording, "addressed or consciously accepted by the
orchestrator", reappearing in `agents-md-section.md`. A second suite,
`test/template-markers.test.ts:56-98`, independently pins the
findings-table header convention and the Decision-legend vocabulary above.

## Misfire rule's review-gate consequence (0.11.0)

Added in 0.11.0 after a live incident: a reviewer subagent spawn returned in
5 seconds with 0 tool uses, handing back harness boilerplate instead of the
reviewer output contract (`CHANGELOG.md:94-115`). The Subagent misfire rule
closes with the review-specific consequence: "a misfired review is not a
review and never satisfies the review gate, since review is never skipped"
(`SKILL.md:330-332`), pinned by
`packages/orchestrator-workflow/test/docs-consistency.test.ts:347-350`. Full
misfire mechanics (detection signals, resume-vs-respawn, the
`03-decisions.md` record) are out of scope here; see
[subagent-contracts-superset.md](subagent-contracts-superset.md).

## Reproduction requirement (0.14.0)

A new, narrowly-triggered rule closes a gap the severity ladder and waiver
rules above do not cover: nothing previously required the reviewer to
independently verify an implementer's *empirical* claim (a flake rate, a
benchmark, "n runs green", a timing number) rather than transcribe it into
the findings table as reported. SKILL.md step 7 now states it right after
the placeholder-row rule (`SKILL.md:125-132`): when acceptance rests on such
evidence, the reviewer must reproduce it independently — its own runs or
measurements — and record method, sample size, and result against the
implementer's claim; a single deterministic check (one test run, `tsc`,
lint) does not trigger it. The installed `reviewer.md` prompt carries the
same rule (`reviewer.md:39-44`), and both output contracts gained a matching
`reproduction: {method, sample_size, result, matches_implementer_claim}`
field (`SKILL.md:247-251`, `reviewer.md:64-68`); `matches_implementer_claim`
accepts `not_applicable` so a review that never hits the narrow trigger is
not forced to fabricate a reproduction record.

Motivating incident (`CHANGELOG.md:8-37`): agent-dx run
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

## See also

- [index.md](index.md): bundle entry point.
- [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md):
  marker enum mechanics, fail-open vs fail-closed parsing.
- [subagent-contracts-superset.md](subagent-contracts-superset.md): full
  subagent output contracts and the misfire rule in detail.
