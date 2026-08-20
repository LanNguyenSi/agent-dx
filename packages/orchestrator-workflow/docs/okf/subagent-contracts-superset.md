---
type: invariant
title: Subagent Contracts and the Slicer-Superset Invariant
description: The four subagent I/O contracts, where they are duplicated, the task-slicer-superset invariant, and the misfire rule that keeps subagent output honest.
tags: [subagent-contracts, slicer-superset, misfire-rule, io-contract-duplication, read-only-roles]
timestamp: 2026-08-20T23:59:00Z
sources:
  - packages/orchestrator-workflow/assets/skill/SKILL.md
  - packages/orchestrator-workflow/assets/agents/explorer.md
  - packages/orchestrator-workflow/assets/agents/task-slicer.md
  - packages/orchestrator-workflow/assets/agents/implementer.md
  - packages/orchestrator-workflow/assets/agents/reviewer.md
  - packages/orchestrator-workflow/src/models.ts
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
---

All `path:line` pointers below are repo-root-relative from the agent-dx root.

## Four roles, two postures

The canonical role list is code, not just prose: `ROLES` at
`packages/orchestrator-workflow/src/models.ts:3-8` = `explorer, task-slicer,
implementer, reviewer`, narratively mirrored at
`packages/orchestrator-workflow/assets/skill/SKILL.md:24-52` (`## Roles`).

Read-only vs. writable is also a code-level set:
`READ_ONLY_ROLES = new Set(["explorer", "reviewer"])` at
`packages/orchestrator-workflow/src/models.ts:14-17`. There is no matching
`WRITABLE_ROLES` constant; the writable set is derived as the complement,
exactly as `packages/orchestrator-workflow/test/docs-consistency.test.ts:182`
computes it: `ROLES.filter((role) => !READ_ONLY_ROLES.has(role))` →
`task-slicer, implementer`. That posture is tool-level only for
Edit/Write/NotebookEdit; Bash mutation is guarded by prompt instruction alone,
which `packages/orchestrator-workflow/test/docs-consistency.test.ts:495-502`
pins README.md to state honestly ("guarded by instruction only", "nothing
technically prevents it") rather than claiming full closure. Enforcement
mechanics for that posture are out of this doc's lane; see
[install-fence-mechanics.md](install-fence-mechanics.md).

Where the harness supports subagent definitions, `SKILL.md` tells the
orchestrator to spawn the installed prompts under
`packages/orchestrator-workflow/assets/agents/{explorer,task-slicer,implementer,reviewer}.md`
instead of improvising role text
(`packages/orchestrator-workflow/assets/skill/SKILL.md:44-50`). Per-role
default models (`DEFAULT_MODELS`,
`packages/orchestrator-workflow/src/models.ts:70-75`) are out of this doc's
lane; see [model-preselection.md](model-preselection.md).

## Where each contract lives, and what keeps the copies equal

Every role's output contract is written twice: once in `SKILL.md`'s own
fenced yaml block (the orchestrator's reference copy), once in the role's
installed prompt, in its trailing "Return exactly this structure as your
final output, nothing else" block:

- Explorer: `packages/orchestrator-workflow/assets/skill/SKILL.md:193-218`
  (`## Explorer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/explorer.md:47-70`.
- Implementer: `packages/orchestrator-workflow/assets/skill/SKILL.md:243-269`
  vs. `packages/orchestrator-workflow/assets/agents/implementer.md:36-62`.
  Both copies gained a `mutation_probes` field in 0.16.0; see
  [Mutation probes requirement](#mutation-probes-requirement-0160) below.
- Reviewer: `packages/orchestrator-workflow/assets/skill/SKILL.md:280-301`
  vs. `packages/orchestrator-workflow/assets/agents/reviewer.md:60-81`. Both
  copies gained a `reproduction` field in 0.14.0; see
  [Reproduction requirement](#reproduction-requirement-0140) below.
- Task-slicer:
  `packages/orchestrator-workflow/assets/skill/SKILL.md:309-339`
  (`## Task slicer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/task-slicer.md:36-66`.
- Subagent input contract (the shape the orchestrator sends when delegating,
  not a role's own output) lives only in
  `packages/orchestrator-workflow/assets/skill/SKILL.md:222-239`; there is no
  installed-prompt counterpart because it is what the orchestrator constructs,
  not what a subagent returns.

Direct read on this branch confirms all four output-contract pairs are
field-identical prose. Three of the four pairs now carry a dedicated
automated drift guard, which corrects what this doc previously reported here
(that only the task-slicer/subagent-input pair had one): the task-slicer/
subagent-input relationship has the equality-and-superset test suite
documented below; the reviewer pair has had a byte-for-byte `reproduction`
field equality test since 0.14.0
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:778-792`); the
implementer pair gained a byte-for-byte `mutation_probes` field equality
test in 0.16.0
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:853-866`),
reinforced by an exact-sub-field-name pin added in a same-day R2 fix-round
(`test/docs-consistency.test.ts:908-913`) that catches a mutant the plain
equality test cannot: renaming a sub-field identically in both copies still
passes the equality check (it only proves the two copies match each other),
but fails the exact-name pin. Only the explorer pair still has no dedicated
automated drift guard today; it is protected only by direct read and review.

## The core invariant: slicer output is a lossless superset of the subagent input contract

Every field the subagent input contract requires must have a same-named
counterpart in the task-slicer's per-task output, so the orchestrator copies
task fields 1:1 into the implementer contract at delegation time instead of
inventing values. This was not always true:
`packages/orchestrator-workflow/CHANGELOG.md:412-439` (0.10.0) records that the
slicer contract previously omitted `constraints`, `allowed_changes`,
`forbidden_changes` even though the implementer input contract already
required them, forcing the orchestrator to fabricate that content when
delegating.

Current per-task slicer shape
(`packages/orchestrator-workflow/assets/skill/SKILL.md:309-339`): `id, title,
goal, relevant_files, relevant_docs, acceptance_criteria, constraints,
suggested_tests, allowed_changes, forbidden_changes, dependencies, risk`, in
that order. The subagent input contract
(`packages/orchestrator-workflow/assets/skill/SKILL.md:222-239`) requires:
`role, task_id, goal, context.relevant_files, context.relevant_docs,
constraints, acceptance_criteria, allowed_changes, forbidden_changes,
expected_output.format`. `suggested_tests` is the one slicer field with no
subagent-input counterpart (tests are not part of that contract); it exists
for the `02-tasks.md` template and the step-4 workflow narrative instead. The
copy rule is stated verbatim at
`packages/orchestrator-workflow/assets/skill/SKILL.md:341-344`: "The
orchestrator copies each task's goal, relevant_files, relevant_docs,
acceptance_criteria, constraints, allowed_changes, and forbidden_changes 1:1
into the subagent input contract when delegating implementation, rather than
inventing new field values."

`packages/orchestrator-workflow/test/docs-consistency.test.ts:517-723`
enforces this. The load-bearing check derives the *required* field set from
the live subagent-input yaml block itself rather than hardcoding it
(`test/docs-consistency.test.ts:577-615`): it regex-extracts top-level fields
plus `context.*` children, subtracts pure delegation mechanics (`role,
task_id, context, expected_output, format`), and asserts every remaining name
appears in the slicer output block, so a field added to the subagent input
contract later cannot silently go undocumented in the slicer output; the test
fails instead. Supporting checks in the same suite: both slicer-output copies
(`SKILL.md` and `task-slicer.md`) carry the same fields in the same order
(`test/docs-consistency.test.ts:617-628`); the original field order
(`id, title, goal, relevant_files, ... dependencies, risk`) survives around
the newer fields (`test/docs-consistency.test.ts:630-655`); `02-tasks.md`'s
sections map 1:1 to the fields in order
(`test/docs-consistency.test.ts:662-681`); and `task-slicer.md` must frame
`allowed_changes`/`forbidden_changes` as scope boundaries for the
implementer, not implementation instructions
(`test/docs-consistency.test.ts:719-723`, prompt text at
`packages/orchestrator-workflow/assets/agents/task-slicer.md:27-29`).

## Subagent misfire rule (0.11.0)

`packages/orchestrator-workflow/assets/skill/SKILL.md:376-389` (`## Subagent
misfire rule`): a subagent return is a misfire, not evidence, when it fails
to parse against its role's output contract. Two detection signals:

1. Contract-parse failure: the output does not parse against the role's
   contract (`SKILL.md:378-381`). Since a same-day R2 fix-round on 0.16.0
   this signal names an explicit example: an implementer return that omits
   the `mutation_probes` field even though the task assignment named
   mutation probes to run (`SKILL.md:379-381`).
2. Near-instant return with no tool activity (`SKILL.md:381-382`). This is a
   signal, not proof: a legitimately tool-free return (e.g. a slicer
   answering entirely from context already supplied) is not automatically a
   misfire. It is accepted only if it is contract-valid *and* the assignment
   was answerable from the context supplied with it (`SKILL.md:382-385`).

Response: treat a misfire as a failed spawn: resume or respawn the
subagent; never fold the non-contract output into run state or count it as a
completed step (`SKILL.md:385-387`). Since 0.18.0, for the near-instant,
no-tool-activity signal specifically, the rule states a concrete preference
rather than leaving the resume-or-respawn choice open: prefer resume over a
fresh respawn, sending the same subagent a message that explicitly repeats
the original assignment rather than a generic retry, since resume keeps the
subagent's prior turn in context while a fresh spawn starts cold
(`SKILL.md:387-390`); fall back to a fresh respawn only if the resume
attempt itself misfires the same way (`SKILL.md:394-395`). Every incident of
this exact signal whose outcome was recorded (four so far: three on
2026-07-16, one on 2026-07-20) has resolved on the first resume attempt
(`SKILL.md:391-394`) — a same-day review-fix round bound this claim to the
recorded count after finding the original wording asserted a universal
resolve rate the record did not support (see Motivation below). The
preference is scoped away from a second, structurally different misfire
class measured separately: a mid-run watchdog stall did not resolve on
resume (it stalled a second time) and needed a fresh, explicitly
constrained respawn instead (`SKILL.md:399-405`). Record every misfire in
`03-decisions.md` (`SKILL.md:405-406`). Review-gate consequence, stated
explicitly: a misfired review is not a review and never satisfies the review
gate, since review is never skipped (`SKILL.md:406-407`). Review-gate
severities and waiver mechanics themselves are out of this doc's lane; see
[review-gate-and-waivers.md](review-gate-and-waivers.md).

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:389-410` (0.11.0): a
live incident where a reviewer subagent spawn returned in 5 seconds with 0
tool uses, handing back harness hook-boilerplate instead of the reviewer
output contract; a resume of the same spawn produced a correct full review.
Before 0.11.0 the kit said nothing about malformed returns, leaving room to
silently accept a non-review as a passed review gate. 0.18.0's
resume-over-respawn extension has its own motivation
(`packages/orchestrator-workflow/CHANGELOG.md:103-112`, agent-tasks task
a932b12a): two further sessions (2026-07-19, 2026-07-20) reproduced the
identical signal; the 2026-07-19 session's resume outcome was never
recorded, which is exactly the gap this fix-round's claim-binding closes.

`packages/orchestrator-workflow/test/docs-consistency.test.ts:344-380` pins
the 0.11.0 rule clause-by-clause: section heading present (347-349), both
detection signals named verbatim (351-356), the scoping language that
prevents false-positive misfires (358-363), the resume-or-respawn response
plus the non-evidence rule (365-370), the `03-decisions.md` record
requirement (372-374), and the review-gate consequence sentence (376-379).
`test/docs-consistency.test.ts:396-466` pins the 0.18.0 extension and this
fix-round's hardening in one `describe` block: the resume-over-respawn
preference (399-403), the repeat-the-assignment mechanic (405-409), why
resume beats a fresh respawn (411-415), the parenthetical signal definition
(417-421), the claim-binding to recorded outcomes (423-427), the
conditional respawn fallback (429-433), the model-correlation note as an
open lead (435-442), a derived assertion against `DEFAULT_MODELS` itself
rather than prose alone (444-450), and the watchdog-stall scope carve-out
plus its own resolution detail (452-465).

## Reproduction requirement (0.14.0)

`packages/orchestrator-workflow/assets/skill/SKILL.md:160-167` (step 7,
immediately after the placeholder-row rule): when acceptance rests on
empirical or probabilistic evidence (flake rates, benchmarks, "n runs
green", performance/timing numbers), the reviewer must independently
reproduce it — its own runs or measurements, not a re-read of the
implementer's log — and record method, sample size, and result against the
implementer's claim. The trigger is deliberately narrow: a single
deterministic check (one test run, `tsc`, lint) does not qualify. The
installed `packages/orchestrator-workflow/assets/agents/reviewer.md:51-56`
prompt carries the same rule verbatim (second-person voice). Both output
contracts gained a matching `reproduction` field
(`method, sample_size, result, matches_implementer_claim`,
`SKILL.md:296-300` and `reviewer.md:76-80`); `matches_implementer_claim`
accepts `not_applicable` for reviews where the narrow trigger never fires, so
a reviewer is not forced to fabricate a reproduction record for a
deterministic-only change.

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:303-332` (0.14.0): the
agent-dx run `2026-07-18-harness-subprocess-test-deflake` accepted an
implementer's "8/8 green" flake-rate claim on a `maxWorkers` cap fix, then
the reviewer independently reran the suite and found 2/6 red on an
independent 6-run sample (flake rate ~1/3, matching the pre-fix baseline) —
nothing in the prior contract had required that rerun, so the first pass
would have accepted the implementer's number as reported. This clause is a
docs/prompt-only change: no runtime code in this package depends on the new
field.

## Mutation probes requirement (0.16.0)

Shipped in 0.16.0 and hardened the same day in an R2 fix-round after review
caught two gaps (see Motivation below).
`packages/orchestrator-workflow/assets/skill/SKILL.md:124-138` (step 6, added
in the R2 pass): when a task's acceptance rests on a test that must fail
without the change, the orchestrator names the mutation probes to run in the
task assignment; the implementer reports each one in the output contract's
`mutation_probes` field (apply the mutant for real, observe the named test
fail, restore, re-verify). Step 6 also carries a short
orchestrator-checkable reference to the installed implementer prompt's
claim-only-what-was-measured rule (`SKILL.md:134-136`): treat a verification
claim in the implementer's report as unverified unless it is backed by a
check the implementer actually ran. Before this R2 pass step 6 said nothing
about naming probes at all — the field's only trigger lived in the misfire
rule's prose, mirroring the gap the 0.14.0 reproduction trigger closed for
step 7 in the log entry above, but left open here until this pass.

Both output-contract copies carry the field (`mutant, verified_applied_via,
result, restored_verified`, `SKILL.md:258-262` and `implementer.md:51-55`).
A paragraph immediately after `SKILL.md`'s contract block
(`SKILL.md:271-276`) and a matching bullet in the installed prompt
(`implementer.md:16-21`) both state the not-applicable signal added in the
R2 pass: when the assignment named no probes, the implementer returns
`mutation_probes: []` rather than omitting the field, so "none asked for" is
distinguishable from "asked for and not reported" — before this pass an
implementer never given probes and one that silently dropped them returned
the identical placeholder block. An output missing the field when probes
*were* named is a misfire (see Subagent misfire rule above), worded
identically in both copies since the R2 pass as "treated as a misfire, not
evidence" (the installed prompt alone previously said "incomplete").

`packages/orchestrator-workflow/test/docs-consistency.test.ts:827-867` pins
the original 0.16.0 shape: the installed prompt's instruction and field
mention (831-837), the claim-only-what-was-measured rule (839-844), the
misfire-rule sentence (846-851), and a byte-for-byte cross-copy equality
check on the field block (853-866).
`test/docs-consistency.test.ts:885-921` pins the R2 additions: step 6's
sentence and its claim-only-what-was-measured reference (889-900), the
not-applicable clause in both copies (902-906), and two exact-string pins
(908-920) that catch a rename applied identically to both copies — a mutant
the cross-copy equality check above cannot catch on its own, since it only
proves the two copies match each other, not that either still uses the
pinned sub-field names.

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:212-258` (0.16.0 plus
its same-day R2 follow-up, agent-tasks task 16637a96): a 16-round dogfood
where two implementer rounds dropped briefed-as-mandatory mutation probes
from their return entirely; review of the resulting change then found the
shipped contract had no trigger the kit itself ever produced and no
not-applicable signal, both closed in the R2 pass documented here.

## Cross-links

- Run-state markers (run-base, acceptance markers) these subagent outputs
  feed: [run-state-lifecycle-and-markers.md](run-state-lifecycle-and-markers.md).
- Review-gate severities, waivers, Accepted Waivers handoff section:
  [review-gate-and-waivers.md](review-gate-and-waivers.md).
- Tool-level read-only enforcement and the Bash residual:
  [install-fence-mechanics.md](install-fence-mechanics.md).
- Per-role default models and `--models` overrides:
  [model-preselection.md](model-preselection.md).
- Bundle index: [index.md](index.md). Bundle change log: [log.md](log.md).
