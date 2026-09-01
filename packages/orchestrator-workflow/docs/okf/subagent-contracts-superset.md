---
type: invariant
title: Subagent Contracts and the Slicer-Superset Invariant
description: The five subagent I/O contracts, where they are duplicated, the task-slicer-superset invariant, and the misfire rule that keeps subagent output honest.
tags: [subagent-contracts, slicer-superset, misfire-rule, io-contract-duplication, read-only-roles]
timestamp: 2026-09-01T11:10:19Z
sources:
  - packages/orchestrator-workflow/assets/skill/SKILL.md
  - packages/orchestrator-workflow/assets/agents/explorer.md
  - packages/orchestrator-workflow/assets/agents/task-slicer.md
  - packages/orchestrator-workflow/assets/agents/implementer.md
  - packages/orchestrator-workflow/assets/agents/reviewer.md
  - packages/orchestrator-workflow/assets/agents/advisor.md
  - packages/orchestrator-workflow/src/models.ts
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
---

All `path:line` pointers below are repo-root-relative from the agent-dx root.

## Five roles, two postures

The canonical role list is code, not just prose: `ROLES` at
`packages/orchestrator-workflow/src/models.ts:8#"export const ROLES: Role[] = ["` (`Role` type at `packages/orchestrator-workflow/src/models.ts:1#"export type Role ="`)
= `explorer, task-slicer, implementer, reviewer, advisor` (five since
0.21.0, four before it), narratively mirrored at
`packages/orchestrator-workflow/assets/skill/SKILL.md:28-63#"the [agentic-coding-playbook"` (`## Roles`).
The advisor role is qualitatively different from the other four: it is
escalation-only, spawned only at defined triggers rather than at a fixed
point in every run, and installed only under the `full` profile, never
`minimal` (see [install-fence-mechanics.md](install-fence-mechanics.md) for
the profile-scoping mechanics — `MINIMAL_PROFILE_ROLES`, `src/models.ts:42#"const MINIMAL_PROFILE_ROLES: ReadonlySet<Role> = new"`,
simply does not name it, the same way it never named explorer/task-slicer).

Read-only vs. writable is also a code-level set:
`READ_ONLY_ROLES = new Set(["explorer", "reviewer", "advisor"])` at
`packages/orchestrator-workflow/src/models.ts:22#"export const READ_ONLY_ROLES: ReadonlySet<Role> = new"` (advisor added
0.21.0, for the same reason as explorer/reviewer: it reads and recommends
but never edits, per the comment at `packages/orchestrator-workflow/src/models.ts:16-20#"* it reads and recommends but never edits."`). There is no matching
`WRITABLE_ROLES` constant; the writable set is derived as the complement,
exactly as `packages/orchestrator-workflow/test/docs-consistency.test.ts:205#"const writableRoles = ROLES.filter((role) =>"`
computes it: `ROLES.filter((role) => !READ_ONLY_ROLES.has(role))` →
`task-slicer, implementer`. That posture is tool-level only for
Edit/Write/NotebookEdit; Bash mutation is guarded by prompt instruction alone,
which `packages/orchestrator-workflow/test/docs-consistency.test.ts:635-639#"out of this kit's scope"`
pins README.md to state honestly ("guarded by instruction only", "nothing
technically prevents it") rather than claiming full closure — since 0.21.0
the pinned phrase names `explorer, reviewer, and advisor` instead of just
the first two, the same README.md paragraph, no new test needed since the
existing pin checks the phrase's substance, not a hardcoded role list.
Enforcement mechanics for that posture are out of this doc's lane; see
[install-fence-mechanics.md](install-fence-mechanics.md).

Where the harness supports subagent definitions, `SKILL.md` tells the
orchestrator to spawn the installed prompts under
`packages/orchestrator-workflow/assets/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md`
instead of improvising role text
(`packages/orchestrator-workflow/assets/skill/SKILL.md:55-63#"the [agentic-coding-playbook"`). Per-role
default models (`DEFAULT_MODELS`,
`packages/orchestrator-workflow/src/models.ts:80-85#"advisor:"`) are out of this doc's
lane; see [model-preselection.md](model-preselection.md).

## Where each contract lives, and what keeps the copies equal

Every role's output contract is written twice: once in `SKILL.md`'s own
fenced yaml block (the orchestrator's reference copy), once in the role's
installed prompt, in its trailing "Return exactly this structure as your
final output, nothing else" block:

- Explorer: `packages/orchestrator-workflow/assets/skill/SKILL.md:265-286#"risk: low | medium | high"`
  (`## Explorer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/explorer.md:47-69#"recommendation:"`.
- Implementer: `packages/orchestrator-workflow/assets/skill/SKILL.md:313-341#"commits:"`
  vs. `packages/orchestrator-workflow/assets/agents/implementer.md:41-67#"commits:"`.
  Both copies gained a `mutation_probes` field in 0.16.0; see
  [Mutation probes requirement](#mutation-probes-requirement-0160) below.
  Both copies also gained a `commits` field; see
  [Commits field](#commits-field) below.
- Reviewer: `packages/orchestrator-workflow/assets/skill/SKILL.md:358-381#"matches_implementer_claim: matched | mismatched |"`
  vs. `packages/orchestrator-workflow/assets/agents/reviewer.md:65-87#"reproduction:"`. Both
  copies gained a `reproduction` field in 0.14.0; see
  [Reproduction requirement](#reproduction-requirement-0140) below. Both
  also gained a per-finding `recurrence` field; see
  [Recurrence field](#recurrence-field) below.
- Task-slicer:
  `packages/orchestrator-workflow/assets/skill/SKILL.md:394-423#"- T-001"`
  (`## Task slicer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/task-slicer.md:36-64#"open_questions:"`.
- Advisor (since 0.21.0):
  `packages/orchestrator-workflow/assets/skill/SKILL.md:433-451#"would_change_recommendation_if:"`
  (`## Advisor output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/advisor.md:53-71#"open_questions:"`. Direct
  read confirms the two blocks are field-identical (since review round 1,
  `escalation_necessary: warranted | unwarranted`, corrected from a bare
  `yes | no` YAML-1.1-boolean-synonym enum, M4); unlike the explorer pair,
  this pair now has a dedicated automated byte-for-byte drift guard too,
  added in review round 1 (M2) — see below.
- Subagent input contract (the shape the orchestrator sends when delegating,
  not a role's own output) lives only in
  `packages/orchestrator-workflow/assets/skill/SKILL.md:292-310#"format: structured"`; there is no
  installed-prompt counterpart because it is what the orchestrator constructs,
  not what a subagent returns. Its `role:` enum
  (`role: advisor | explorer | implementer | reviewer | task_slicer`) is the
  one place the advisor's role name itself was added to this contract, since
  the orchestrator input contract does not need an advisor-specific field —
  every field it lists (`goal`, `context`, `constraints`,
  `acceptance_criteria`, `allowed_changes`, `forbidden_changes`,
  `expected_output`) applies to an advisor spawn the same way it applies to
  the other four roles.

Direct read on this branch confirms all five output-contract pairs are
field-identical prose. Four of the five pairs now carry a dedicated
automated drift guard (three before review round 1, plus the advisor pair
since M2), which corrects what this doc previously reported here
(that only the task-slicer/subagent-input pair had one): the task-slicer/
subagent-input relationship has the equality-and-superset test suite
documented below; the reviewer pair has had a byte-for-byte `reproduction`
field equality test since 0.14.0
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:917-930#"expect(skillBlock).toBe(reviewerBlock);"`); the
implementer pair gained a byte-for-byte `mutation_probes` field equality
test in 0.16.0
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:992-1004#"expect(skillBlock).toBe(implementerBlock);"`),
reinforced by an exact-sub-field-name pin added in a same-day R2 fix-round
(`test/docs-consistency.test.ts:1047-1051#"expect(implementerMd).toContain(field);"`) that catches a mutant the plain
equality test cannot: renaming a sub-field identically in both copies still
passes the equality check (it only proves the two copies match each other),
but fails the exact-name pin. The explorer pair still has no dedicated
automated drift guard today, protected only by direct read and review. The
advisor pair started the same way — a 0.21.0
`describe("advisor escalation policy ships in the AGENTS.md section and
SKILL.md")` block (`test/docs-consistency.test.ts:2321-2394#"explorer, task-slicer, implementer, reviewer, advisor"`) only pinned
that `SKILL.md` carries an Advisor output contract block with the right
top-level shape, a substring-presence pin, not byte-for-byte equality — but
review round 1 (M2) closed that gap: a dedicated
`describe("advisor output contract is byte-identical between SKILL.md and
advisor.md (review round 1, M2)")` block
(`test/docs-consistency.test.ts:2408-2422#"expect(skillBlock).toBe(advisorBlock);"`) extracts the yaml block from
both raw files and asserts equality, the same pattern the reviewer and
implementer pairs use.

## The core invariant: slicer output is a lossless superset of the subagent input contract

Every field the subagent input contract requires must have a same-named
counterpart in the task-slicer's per-task output, so the orchestrator copies
task fields 1:1 into the implementer contract at delegation time instead of
inventing values. This was not always true:
`packages/orchestrator-workflow/CHANGELOG.md:#[0.10.0]` (0.10.0) records that the
slicer contract previously omitted `constraints`, `allowed_changes`,
`forbidden_changes` even though the implementer input contract already
required them, forcing the orchestrator to fabricate that content when
delegating.

Current per-task slicer shape
(`packages/orchestrator-workflow/assets/skill/SKILL.md:394-423#"- T-001"`): `id, title,
goal, relevant_files, relevant_docs, acceptance_criteria, constraints,
suggested_tests, allowed_changes, forbidden_changes, dependencies, risk`, in
that order. The subagent input contract
(`packages/orchestrator-workflow/assets/skill/SKILL.md:292-310#"format: structured"`) requires:
`role, task_id, goal, context.relevant_files, context.relevant_docs,
constraints, acceptance_criteria, allowed_changes, forbidden_changes,
expected_output.format`. `suggested_tests` is the one slicer field with no
subagent-input counterpart (tests are not part of that contract); it exists
for the `02-tasks.md` template and the step-4 workflow narrative instead. The
copy rule is stated verbatim at
`packages/orchestrator-workflow/assets/skill/SKILL.md:428-431#"inventing new field values."`: "The
orchestrator copies each task's goal, relevant_files, relevant_docs,
acceptance_criteria, constraints, allowed_changes, and forbidden_changes 1:1
into the subagent input contract when delegating implementation, rather than
inventing new field values." This invariant is scoped to the task-slicer and
implementer contracts specifically; the advisor's escalation-only output
contract (added 0.21.0) is not part of this superset relationship, since an
advisor spawn is never assembled from a task-slicer's per-task output the
way an implementer spawn is.

The load-bearing check enforces this, and its assertion pins the wording
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:859-861#"not implementation instructions"`).
The check derives the *required* field set from
the live subagent-input yaml block itself rather than hardcoding it
(`test/docs-consistency.test.ts:716-752#"^ {4}${field}:"`): it regex-extracts top-level fields
plus `context.*` children, subtracts pure delegation mechanics (`role,
task_id, context, expected_output, format`), and asserts every remaining name
appears in the slicer output block, so a field added to the subagent input
contract later cannot silently go undocumented in the slicer output; the test
fails instead. Supporting checks in the same suite: both slicer-output copies
(`SKILL.md` and `task-slicer.md`) carry the same fields in the same order
(`test/docs-consistency.test.ts:756-766#"expect(slicerFields).toEqual(skillFields);"`); the original field order
(`id, title, goal, relevant_files, ... dependencies, risk`) survives around
the newer fields (`test/docs-consistency.test.ts:769-792#"cursor = idx;"`); `02-tasks.md`'s
sections map 1:1 to the fields in order
(`test/docs-consistency.test.ts:801-818#"cursor = idx;"`); and `task-slicer.md` must frame
`allowed_changes`/`forbidden_changes` as scope boundaries for the
implementer, not implementation instructions
(`test/docs-consistency.test.ts:859-861#"not implementation instructions"`, prompt text at
`packages/orchestrator-workflow/assets/agents/task-slicer.md:27-29#"and must not touch — not implementation instructions."`).

## Subagent misfire rule (0.11.0, evidence relocated 0.24.0)

`packages/orchestrator-workflow/assets/skill/SKILL.md:496-506#"with it. Treat a misfire as a failed spawn: resume or"` (`## Subagent
misfire rule`): a subagent return is a misfire, not evidence, when it fails
to parse against its role's output contract. Two detection signals:

1. Contract-parse failure: the output does not parse against the role's
   contract (`SKILL.md:498-499#"against its role's output contract, including an"`). Since a same-day R2 fix-round on 0.16.0
   this signal names an explicit example: an implementer return that omits
   the `mutation_probes` field even though the task assignment named
   mutation probes to run, or that omits the `commits` field even though the
   task assignment asked for a commit (`SKILL.md:501-502#"task assignment asked for a commit. When a subagent returns"`);
   see [Commits field](#commits-field) below for the field itself.
2. Near-instant return with no tool activity (`SKILL.md:503#"with no tool activity, treat that as a misfire signal rather than"`). This is a
   signal, not proof: a legitimately tool-free return (e.g. a slicer
   answering entirely from context already supplied) is not automatically a
   misfire. It is accepted only if it is contract-valid *and* the assignment
   was answerable from the context supplied with it (`SKILL.md:504-506#"with it. Treat a misfire as a failed spawn: resume or"`).

Response: treat a misfire as a failed spawn: resume or respawn the
subagent; never fold the non-contract output into run state or count it as a
completed step (`SKILL.md:507-509#"completed step. For the near-instant, no-tool-activity"`). Since 0.18.0, for the near-instant,
no-tool-activity signal specifically, the rule states a concrete preference
rather than leaving the resume-or-respawn choice open: prefer resume over a
fresh respawn, sending the same subagent a message that explicitly repeats
the original assignment rather than a generic retry, since resume keeps the
subagent's prior turn in context while a fresh spawn starts cold
(`SKILL.md:509-512#"since resume keeps the subagent's prior turn in context"`); fall back to a fresh respawn only if the resume
attempt itself misfires the same way (`SKILL.md:516-517#"the resume attempt itself misfires the same way. This"`). Every incident of
this exact signal whose outcome was recorded has resolved on the first
resume attempt (`SKILL.md:513-516#"resolved on the first resume attempt; fall back to a"`) — a same-day review-fix round (0.18.0)
bound this claim to the recorded count after finding the original wording
asserted a universal resolve rate the record did not support (see
Motivation below). The preference is scoped away from a second,
structurally different misfire class measured separately: a mid-run
watchdog stall did not resolve on resume and needed a fresh, explicitly
constrained respawn instead (`SKILL.md:517-522#"watchdog stall as outside this preference. Record every"`). Record every misfire in
`03-decisions.md` (`SKILL.md:522-523#"This matters most for review: a misfired review is not a"`). Review-gate consequence, stated
explicitly: a misfired review is not a review and never satisfies the review
gate, since review is never skipped (`SKILL.md:523-524#"review and never satisfies the review gate, since"`). Review-gate
severities and waiver mechanics themselves are out of this doc's lane; see
[review-gate-and-waivers.md](review-gate-and-waivers.md).

0.24.0 (placement rule) removed two point-in-time observations from this
rule's prose without changing its mechanics or its detection signals,
response, or exceptions: the incident tally (`(four so far)`) behind the
"has resolved on the first resume attempt" claim, and the whole
reviewer/model-correlation passage that used to follow it ("So far this
signal has only been observed for the reviewer role ...", including the
0.21.0 clause naming the advisor's shared default model and the pointer to
the per-role model preferences). Both were evidence, not rule text, so they
moved to `packages/orchestrator-workflow/CHANGELOG.md`'s `[0.24.0]` entry
(Evidence note) as the durable record: which roles the signal has been
observed for, the recorded incident count, and the separate watchdog-stall
incident's outcome. The watchdog-stall exception itself was reworded the
same way, dropping "in the one measured incident of that class, it stalled
a second time" down to just the outcome (`SKILL.md:519-521#"explicitly constrained respawn produced a"`), since the
incident count is now evidence rather than rule text too. `SKILL.md:114-115#"gate's documentation (grounding-mcp) for the full"`
(the run-state paragraph, out of this section but touched by the same
placement pass) similarly drops a pinned `grounding-mcp 0.6.0` version
number in favor of "the consuming gate's documentation (grounding-mcp)".

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:#[0.11.0]` (0.11.0): a
live incident where a reviewer subagent spawn returned in 5 seconds with 0
tool uses, handing back harness hook-boilerplate instead of the reviewer
output contract; a resume of the same spawn produced a correct full review.
Before 0.11.0 the kit said nothing about malformed returns, leaving room to
silently accept a non-review as a passed review gate. 0.18.0's
resume-over-respawn extension has its own motivation
(`packages/orchestrator-workflow/CHANGELOG.md:#[0.18.0]#"Concrete resume-over-respawn workaround"`, agent-tasks task
a932b12a): two further sessions (2026-07-19, 2026-07-20) reproduced the
identical signal; the 2026-07-19 session's resume outcome was never
recorded, which is exactly the gap this fix-round's claim-binding closes.
0.24.0's own CHANGELOG entry carries the incident tally and the
reviewer/model correlation as a standing evidence note now that neither
lives in kit prose.

`packages/orchestrator-workflow/test/docs-consistency.test.ts:489-523#"never satisfies the review gate"` pins
the 0.11.0 rule clause-by-clause: section heading present, packages/orchestrator-workflow/test/docs-consistency.test.ts:492-493#"## Subagent misfire rule", both
detection signals named verbatim, packages/orchestrator-workflow/test/docs-consistency.test.ts:496-500#"returns near-instantly with no tool activity", the scoping language that
prevents false-positive misfires, packages/orchestrator-workflow/test/docs-consistency.test.ts:503-506#"only if it is contract-valid and the assignment was answerable from the context supplied with it", the resume-or-respawn response
plus the non-evidence rule, packages/orchestrator-workflow/test/docs-consistency.test.ts:510-513#"never fold the non-contract output into run state or count it as a completed step", the `03-decisions.md` record
requirement, packages/orchestrator-workflow/test/docs-consistency.test.ts:517-518#"Record every misfire in", and the review-gate consequence sentence, packages/orchestrator-workflow/test/docs-consistency.test.ts:521-523#"never satisfies the review gate".
`test/docs-consistency.test.ts:543-602#"did not resolve on resume; only a fresh, explicitly"` pins the 0.18.0 extension, this
fix-round's hardening, and the 0.24.0 evidence removal in one `describe`
block: the resume-over-respawn preference, test/docs-consistency.test.ts:546-548#"For the near-instant, no-tool-activity signal specifically, prefer resume over a fresh respawn", the
repeat-the-assignment mechanic, test/docs-consistency.test.ts:552-554#"send the same subagent a message that explicitly repeats the original assignment rather than a generic retry", why resume beats a fresh respawn,
test/docs-consistency.test.ts:558-560#"resume keeps the subagent's prior turn in context while a fresh spawn starts cold and risks the same misfire again", the parenthetical signal definition, test/docs-consistency.test.ts:564-566#"(a return within seconds, zero tool calls, harness or system boilerplate instead of the output contract)", the claim-binding
to recorded outcomes, test/docs-consistency.test.ts:570-572#"whose outcome was recorded has resolved on the first resume attempt", the conditional respawn fallback, test/docs-consistency.test.ts:576-578#"fall back to a fresh respawn only if the resume attempt itself misfires the same way",
a negative-pin test that the incident tally and the model-correlation
passage no longer appear (test/docs-consistency.test.ts:582-588#"see the per-role model preferences", replacing the review-round-1 positive
pins on that passage the 0.24.0 pass removed along with the prose), the
watchdog scope carve-out, test/docs-consistency.test.ts:591-596#"treat a watchdog stall as outside this preference", and its own resolution detail,
test/docs-consistency.test.ts:600-602#"did not resolve on resume; only a fresh, explicitly constrained respawn produced a contract-valid review".

## Reproduction requirement (0.14.0)

`packages/orchestrator-workflow/assets/skill/SKILL.md:213-220#"lint): only claims that could vary run to run trigger"` (step 7,
immediately after the placeholder-row rule): when acceptance rests on
empirical or probabilistic evidence (flake rates, benchmarks, "n runs
green", performance/timing numbers), the reviewer must independently
reproduce it — its own runs or measurements, not a re-read of the
implementer's log — and record method, sample size, and result against the
implementer's claim. The trigger is deliberately narrow: a single
deterministic check (one test run, `tsc`, lint) does not qualify. The
installed `packages/orchestrator-workflow/assets/agents/reviewer.md:56-66#"lint) do not trigger this."`
prompt carries the same rule verbatim (second-person voice). Both output
contracts gained a matching `reproduction` field
(`method, sample_size, result, matches_implementer_claim`,
`SKILL.md:377-381#"matches_implementer_claim: matched | mismatched |"` and `reviewer.md:82-85#"residual_risks:"`); `matches_implementer_claim`
accepts `not_applicable` for reviews where the narrow trigger never fires, so
a reviewer is not forced to fabricate a reproduction record for a
deterministic-only change.

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:#[0.14.0]` (0.14.0): the
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
`packages/orchestrator-workflow/assets/skill/SKILL.md:168-187#"for real, observe the named test fail, restore,"` (step 6, added
in the R2 pass): when a task's acceptance rests on a test that must fail
without the change, the orchestrator names the mutation probes to run in the
task assignment; the implementer reports each one in the output contract's
`mutation_probes` field (apply the mutant for real, observe the named test
fail, restore, re-verify). Step 6 also carries a short
orchestrator-checkable reference to the installed implementer prompt's
claim-only-what-was-measured rule (`SKILL.md:187-190#"unverified. Record meaningful decisions in"`): treat a verification
claim in the implementer's report as unverified unless it is backed by a
check the implementer actually ran. Before this R2 pass step 6 said nothing
about naming probes at all — the field's only trigger lived in the misfire
rule's prose, mirroring the gap the 0.14.0 reproduction trigger closed for
step 7 in the log entry above, but left open here until this pass.

Both output-contract copies carry the field (`mutant, verified_applied_via,
result, restored_verified`, `SKILL.md:330-334#"restored_verified:"` and `implementer.md:56-60#"restored_verified:"`).
A paragraph immediately after `SKILL.md`'s contract block
(`SKILL.md:345-350#"reported'."`) and a matching bullet in the installed prompt
(`implementer.md:16-21#"rather than omitting the field."`) both state the not-applicable signal added in the
R2 pass: when the assignment named no probes, the implementer returns
`mutation_probes: []` rather than omitting the field, so "none asked for" is
distinguishable from "asked for and not reported" — before this pass an
implementer never given probes and one that silently dropped them returned
the identical placeholder block. An output missing the field when probes
*were* named is a misfire (see Subagent misfire rule above), worded
identically in both copies since the R2 pass as "treated as a misfire, not
evidence" (the installed prompt alone previously said "incomplete").

`packages/orchestrator-workflow/test/docs-consistency.test.ts:966-1004#"expect(skillBlock).toBe(implementerBlock);"` pins
the original 0.16.0 shape: the installed prompt's instruction and field
mention, packages/orchestrator-workflow/test/docs-consistency.test.ts:970-974#"an output missing that field when probes were named is treated as a misfire, not evidence", the claim-only-what-was-measured rule, packages/orchestrator-workflow/test/docs-consistency.test.ts:978-982#"never claim a run you did not execute", the
misfire-rule sentence, packages/orchestrator-workflow/test/docs-consistency.test.ts:985-987#"does not parse against its role's output contract, including an implementer return that omits the", and a byte-for-byte cross-copy equality
check on the field block, packages/orchestrator-workflow/test/docs-consistency.test.ts:992-1004#"expect(skillBlock).toBe(implementerBlock);".
`test/docs-consistency.test.ts:1024-1058#"expect(implementerMd).toContain(enumeration);"` pins the R2 additions: step 6's
sentence and its claim-only-what-was-measured reference, test/docs-consistency.test.ts:1028-1033#"apply the mutant for real, observe the named test fail, restore, re-verify", the
not-applicable clause in both copies, test/docs-consistency.test.ts:1041-1044#"expect(implementerMd).toContain(clause);", and two exact-string pins,
test/docs-consistency.test.ts:1047-1051#"expect(implementerMd).toContain(field);", that catch a rename applied identically to both copies — a mutant
the cross-copy equality check above cannot catch on its own, since it only
proves the two copies match each other, not that either still uses the
pinned sub-field names.

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:#[0.16.0]` (0.16.0 plus
its same-day R2 follow-up, agent-tasks task 16637a96): a 16-round dogfood
where two implementer rounds dropped briefed-as-mandatory mutation probes
from their return entirely; review of the resulting change then found the
shipped contract had no trigger the kit itself ever produced and no
not-applicable signal, both closed in the R2 pass documented here.

## Recurrence field

The reviewer output contract gained a per-finding `recurrence: new |
repeated` field, added to both copies identically
(`packages/orchestrator-workflow/assets/skill/SKILL.md:371#"recurrence: new | repeated"` and
`packages/orchestrator-workflow/assets/agents/reviewer.md:81#"recurrence: new | repeated"`, same field, same
line-relative position inside the findings item in both). It classifies
each finding against earlier review rounds on the same task: `new` for a
defect class not previously found there, `repeated` for one that already
appeared; on a task's first round every finding is `new` by definition
(`SKILL.md:391-392#"Review-round escalation budget's trigger."`). The
installed `reviewer.md:30#"classify each finding as"`
prompt instructs the classification directly, gated on the orchestrator
having named the review round number in the briefing (a step 7 addition,
`packages/orchestrator-workflow/assets/skill/SKILL.md:222-225#"trigger (see below) without re-deriving it by hand."`).
This field feeds the review-round escalation budget's trigger; full
treatment of that budget (the second-halt-or-third-round trigger, the
three named escalations, the `03-decisions.md` marker) is out of this
doc's lane; see
[review-gate-and-waivers.md](review-gate-and-waivers.md#review-round-escalation-budget).
No dedicated byte-for-byte drift guard existed for the findings block
before this change (unlike the `reproduction` and `mutation_probes`
fields above); one now does, extracting the `findings:` block from both
raw files the same way.

## Commits field

The implementer output contract gained a `commits` field, added to both
copies identically (`packages/orchestrator-workflow/assets/skill/SKILL.md:341#"commits:"`
and `packages/orchestrator-workflow/assets/agents/implementer.md:67#"commits:"`,
byte-identical block, the same rigor already applied to `mutation_probes`
above). It lists the full sha of every commit the implementer produced on
the task branch, in order (`SKILL.md:353#"produced on the task branch, in the order produced"`
and, worded identically in substance in the installed prompt's rule bullet,
`implementer.md:22#"Report the full sha of every commit you produced"`, with
"in order" carried at `implementer.md:23#"order, in the"`).
When the task produced no commit, the implementer returns `commits: []`
rather than omitting the field, so "did not commit" is distinguishable from
"forgot to report" (`SKILL.md:354-355#"omitting the field, so 'did not commit' is"`);
the field is otherwise mandatory on every return, matching `mutation_probes`
and every other contract field. An output missing the field when the task
assignment asked for a commit is a misfire (see
[Subagent misfire rule](#subagent-misfire-rule-0110-evidence-relocated-0240)
above), worded identically in both copies as "treated as a misfire, not
evidence" (`SKILL.md:502#"task assignment asked for a commit. When a subagent returns"`
and `implementer.md:24#"assignment asked for a commit is treated as a misfire, not"`).

`packages/orchestrator-workflow/test/docs-consistency.test.ts:1074-1120#"expect(implementerMd).toContain(clause);"`
pins the field: the installed prompt's full-sha instruction and field
mention, packages/orchestrator-workflow/test/docs-consistency.test.ts:1078-1084#"an output missing that field when the task assignment asked for a commit is treated as a misfire, not evidence", the misfire-rule sentence, packages/orchestrator-workflow/test/docs-consistency.test.ts:1088-1090#"field even though the task assignment asked for a commit", a dedicated pin
on the "full sha" / "in order" semantics themselves (not only the
surrounding clauses), packages/orchestrator-workflow/test/docs-consistency.test.ts:1094-1097#"in the order produced", a byte-for-byte cross-copy equality check
on the field block, packages/orchestrator-workflow/test/docs-consistency.test.ts:1101-1112#"expect(skillBlock).toBe(implementerBlock);", and the not-applicable `commits: []` clause
in both copies, packages/orchestrator-workflow/test/docs-consistency.test.ts:1115-1118#"expect(implementerMd).toContain(clause);".

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:#[0.27.0]`
(agent-tasks task 2355f144): the implementer output contract had no field
for the commit sha produced; briefs asked for it in prose and implementers
omitted it (twice in one session), forcing the orchestrator to re-derive it
from git. Unlike a prose ask, a contract field is checked by the misfire
rule.

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
