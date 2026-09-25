---
type: invariant
title: Subagent Contracts and the Slicer-Superset Invariant
description: The five subagent I/O contracts, where they are duplicated, the task-slicer-superset invariant, and the misfire rule that keeps subagent output honest.
tags: [subagent-contracts, slicer-superset, misfire-rule, io-contract-duplication, read-only-roles]
timestamp: 2026-09-25T08:28:29Z
sources:
  - packages/orchestrator-workflow/assets/agents/explorer.md
  - packages/orchestrator-workflow/assets/agents/task-slicer.md
  - packages/orchestrator-workflow/assets/agents/implementer.md
  - packages/orchestrator-workflow/assets/agents/reviewer.md
  - packages/orchestrator-workflow/assets/agents/advisor.md
  - packages/orchestrator-workflow/assets/templates/00-goal.md
  - packages/orchestrator-workflow/assets/templates/02-tasks.md
  - packages/orchestrator-workflow/assets/templates/04-implementation-summary.md
  - packages/orchestrator-workflow/src/models.ts
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/test/acceptance-baseline.test.ts
  - packages/orchestrator-workflow/test/decision-authority.test.ts
  - packages/orchestrator-workflow/test/template-markers.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
  - packages/orchestrator-workflow/assets/skill/references/contracts.md
  - packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md
  - packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md
  - packages/orchestrator-workflow/assets/skill/references/run-state-and-harness.md
  - packages/orchestrator-workflow/README.md
---

All `path:line` pointers below are repo-root-relative from the agent-dx root.

## Five roles, two postures

The canonical role list is code, not just prose: `ROLES` at
`packages/orchestrator-workflow/src/models.ts:8#"export const ROLES: Role[] = ["` (`Role` type at `packages/orchestrator-workflow/src/models.ts:1#"export type Role ="`)
= `explorer, task-slicer, implementer, reviewer, advisor` (five since
0.21.0, four before it), narratively mirrored at
`packages/orchestrator-workflow/assets/skill/references/run-state-and-harness.md:63#"the [agentic-coding-playbook"` (`## Roles`).
The advisor role is qualitatively different from the other four: it is
escalation-only, spawned only at defined triggers rather than at a fixed
point in every run, and installed only under the `full` profile, never
`minimal` (see [install-fence-mechanics.md](install-fence-mechanics.md) for
the profile-scoping mechanics: `MINIMAL_PROFILE_ROLES`, `src/models.ts:42#"const MINIMAL_PROFILE_ROLES: ReadonlySet<Role> = new"`,
simply does not name it, the same way it never named explorer/task-slicer).

Read-only vs. writable is also a code-level set:
`READ_ONLY_ROLES = new Set(["explorer", "reviewer", "advisor"])` at
`packages/orchestrator-workflow/src/models.ts:22#"export const READ_ONLY_ROLES: ReadonlySet<Role> = new"` (advisor added
0.21.0, for the same reason as explorer/reviewer: it reads and recommends
but never edits, per the comment at `packages/orchestrator-workflow/src/models.ts:16-20#"* it reads and recommends but never edits."`). There is no matching
`WRITABLE_ROLES` constant; the writable set is derived as the complement,
exactly as `packages/orchestrator-workflow/test/docs-consistency.test.ts:262#"const writableRoles = ROLES.filter((role) =>"`
computes it: `ROLES.filter((role) => !READ_ONLY_ROLES.has(role))` →
`task-slicer, implementer`. That posture is tool-level only for
Edit/Write/NotebookEdit; Bash mutation is guarded by prompt instruction alone,
which `packages/orchestrator-workflow/test/docs-consistency.test.ts:699#"out of this kit's scope"`
pins README.md to state honestly ("guarded by instruction only", "nothing
technically prevents it") rather than claiming full closure: since 0.21.0
the pinned phrase names `explorer, reviewer, and advisor` instead of just
the first two, the same README.md paragraph, no new test needed since the
existing pin checks the phrase's substance, not a hardcoded role list.
Enforcement mechanics for that posture are out of this doc's lane; see
[install-fence-mechanics.md](install-fence-mechanics.md).

Where the harness supports subagent definitions, `SKILL.md` tells the
orchestrator to spawn the installed prompts under
`packages/orchestrator-workflow/assets/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md`
instead of improvising role text
(`packages/orchestrator-workflow/assets/skill/references/run-state-and-harness.md:63#"the [agentic-coding-playbook"`). Per-role
default models (`DEFAULT_MODELS`,
`packages/orchestrator-workflow/src/models.ts:80-85#"advisor:"`) are out of this doc's
lane; see [model-preselection.md](model-preselection.md).

## Repository-bound verification sets

Every implementer and reviewer briefing names one repository-bound
`verification_set`. It identifies the checked-in set and its immutable resolved
identity; the role runs every named result in the complete set, including the
required bundle check for repositories with `docs/okf/`. A missing named check
is a misfire, not a pass; skipped, waived, or inconclusive results remain
non-passing evidence. The README's worked `.ai/workflow/verify.json` example
defines ordered extras around a truthful preflight JSON acquisition: that JSON
reports results, never discovered shell commands.

Naming a set by reference plus its frozen digest and repository identity, as
delegated in the briefing, is the orchestrator's approval of every argv
resolved from that frozen snapshot; a digest mismatch withdraws the approval
and is reported as a misfire
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:79#"is the orchestrator's"`).
The `verification_set` shape in the subagent input contract and both
task-slicer output copies now carries `digest`, `repository_identity`, and
`snapshot` sub-fields alongside `reference` for this reason, `snapshot`
naming the run-local path of the frozen snapshot record
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:82#"names the run-local path of the frozen snapshot"`).
That approval reaches only
the frozen snapshot: before acquisition or execution, implementer.md, reviewer.md,
and contracts.md state, in identical wording, that the role compares the frozen
snapshot's effective config and scripts and preflight executable
identity/definition at the tree the set executes in, deferring repository identity
to the path rule rather than the role's checkout; any mismatch withdraws the
approval like a digest mismatch and is reported as a misfire, and a change the
task's own diff makes to one of those components is outside the approval
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:91#"executes in; repository identity follows the path rule, not the role's checkout; any"`).
The compared values are the ones recorded in that snapshot; evidence-and-
probes.md's Verification sets section defines what counts as a script for
the comparison
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:94#"The compared values are the ones recorded in the frozen snapshot at"`). For that comparison the repository identity is the repository and its path, compared with the top level of the worktree the diff comes from rather than the checkout the role runs in, so a set frozen against another checkout withdraws the approval while a revision difference alone does not (`packages/orchestrator-workflow/assets/skill/references/contracts.md:99#"Repository identity includes the repository path (the worktree top level)"`); when the diff comes from a linked worktree, literal paths in the set are re-resolved under that worktree before freezing (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:412#"When the diff for a repository comes from a linked worktree"`).

## Where each contract lives, and what keeps the copies equal

Every role's output contract is written twice: once in `SKILL.md`'s own
fenced yaml block (the orchestrator's reference copy), once in the role's
installed prompt, in its trailing "Return exactly this structure" block.
The implementer and slicer blocks explicitly select the recorded contract:
v1 uses the shown nested fields; a recorded original string-list contract
retains its strings and omits only the added baseline/evidence-index fields.
Existing role output fields remain. Unknown provenance is resolved before
dependent delegation; absent fields never select a version. Contract sites:
for the original mutation-probe requirement, see Mutation probes requirement
(0.16.0) below.

The reviewer’s recommendation remains input to, rather than a substitute for,
orchestrator acceptance. Its prompt states that neither that recommendation
nor the orchestrator can authorize a critical waiver; only an operator can
(`packages/orchestrator-workflow/assets/agents/reviewer.md:158#"A reviewer recommendation is not orchestrator acceptance"`). The generated
Claude Code, Codex, and opencode reviewer variants all derive from this same
asset body; `decision-authority.test.ts` renders and checks each installed
reviewer tier. The rule preserves the existing requirement that every change
receives review judgment, including the orchestrator's self-review of a
trivial change.

- Explorer: `packages/orchestrator-workflow/assets/skill/references/contracts.md:1#"## Explorer output contract"`
  (`## Explorer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/explorer.md:54-76#"recommendation:"`.
- Implementer: `packages/orchestrator-workflow/assets/skill/references/contracts.md:101#"## Implementer output contract"`
  vs. `packages/orchestrator-workflow/assets/agents/implementer.md:248#"role: implementer"`.
  Both copies gained a `mutation_probes` field in 0.16.0; see
  [Mutation probes requirement](#mutation-probes-requirement-0160) below.
  Both copies also gained a `commits` field; see
  [Commits field](#commits-field) below.
- Reviewer: `packages/orchestrator-workflow/assets/skill/references/contracts.md:184#"## Reviewer output contract"`
  vs. `packages/orchestrator-workflow/assets/agents/reviewer.md:287#"role: reviewer"`. Both
  copies gained a `reproduction` field in 0.14.0; see
  [Reproduction requirement](#reproduction-requirement-0140) below. Both
  also gained a per-finding `recurrence` field; see
  [Recurrence field](#recurrence-field) below.
- Task-slicer:
  `packages/orchestrator-workflow/assets/skill/references/contracts.md:278#"## Task slicer output contract"`
  (`## Task slicer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/task-slicer.md:74#"role: task_slicer"`.
- Advisor (since 0.21.0):
  `packages/orchestrator-workflow/assets/skill/references/contracts.md:353#"would_change_recommendation_if:"`
  (`## Advisor output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/advisor.md:58-76#"open_questions:"`. Direct
  read confirms the two blocks are field-identical (since review round 1,
  `escalation_necessary: warranted | unwarranted`, corrected from a bare
  `yes | no` YAML-1.1-boolean-synonym enum, M4); unlike the explorer pair,
  this pair now has a dedicated automated byte-for-byte drift guard too,
  added in review round 1 (M2); see below.
- Subagent input contract (the shape the orchestrator sends when delegating,
  not a role's own output) lives only in
  `packages/orchestrator-workflow/assets/skill/references/contracts.md:40#"## Subagent input contract"`; there is no
  installed-prompt counterpart because it is what the orchestrator constructs,
  not what a subagent returns. Its `role:` enum
  (`role: advisor | explorer | implementer | reviewer | task_slicer`) is the
  one place the advisor's role name itself was added to this contract, since
  the orchestrator input contract does not need an advisor-specific field:
  every field it lists (`goal`, `context`, `constraints`,
  `acceptance_baseline`, `acceptance_criteria`, `allowed_changes`, `forbidden_changes`,
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
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:1035#"expect(skillBlock).toBe(reviewerBlock);"`); the
implementer pair gained a byte-for-byte `mutation_probes` field equality
test in 0.16.0
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:1104#"expect(skillBlock).toBe(implementerBlock);"`),
reinforced by an exact-sub-field-name pin added in a same-day R2 fix-round
(`test/docs-consistency.test.ts:1151#"expect(implementerMd).toContain(field);"`) that catches a mutant the plain
equality test cannot: renaming a sub-field identically in both copies still
passes the equality check (it only proves the two copies match each other),
but fails the exact-name pin. The explorer pair still has no dedicated
automated drift guard today, protected only by direct read and review. The
advisor pair started the same way: a 0.21.0
`describe("advisor escalation policy ships in the AGENTS.md section and
SKILL.md")` block (`test/docs-consistency.test.ts:2782#"explorer, task-slicer, implementer, reviewer, advisor"`) only pinned
that `SKILL.md` carries an Advisor output contract block with the right
top-level shape, a substring-presence pin, not byte-for-byte equality, but
review round 1 (M2) closed that gap: a dedicated
`describe("advisor output contract is byte-identical between SKILL.md and
advisor.md (review round 1, M2)")` block
(`test/docs-consistency.test.ts:2810#"expect(skillBlock).toBe(advisorBlock);"`) extracts the yaml block from
both raw files and asserts equality, the same pattern the reviewer and
implementer pairs use.

## The core invariant: slicer output is a lossless superset of the subagent input contract

For an explicitly adopted `acceptance-baseline/v1` run, the subagent input and
each task-slicer output carry the same nested `acceptance_baseline` identity
and full `acceptance_criteria` records (`id`, `required`, `text`,
`verification`, `negative_space`). A task's copied record is the delegated
contract, rather than a detached checklist or a string-only summary. The
implementer receives those records 1:1 and cannot revise them; the reviewer
compares evidence against the same baseline identity. The creation-time
selection is communicated in delegation; the original-contract transformation
applies to every actual block and exact-output instruction.

Both implementer output blocks carry `acceptance_baseline: { id, revision }`
and `criterion_evidence: [{ criterion_id, evidence_refs }]`. Every assigned
criterion gets one entry. References resolve from the directory containing
the owning `04-implementation-summary.md`, with a precise artifact/fragment
locator where needed. Empty references stay unresolved, explained through
existing risks/open questions; required unresolved criteria block acceptance.
The summary indexes returned references against the baseline. Producer
artifacts retain execution/state/result metadata or explicit manual review
metadata, rather than duplicating it in the return index.

Every field the subagent input contract requires must have a same-named
counterpart in the task-slicer's per-task output, so the orchestrator copies
task fields 1:1 into the implementer contract at delegation time instead of
inventing values. This was not always true:
`packages/orchestrator-workflow/CHANGELOG.md:#[0.10.0]` (0.10.0) records that the
slicer contract previously omitted `constraints`, `allowed_changes`,
`forbidden_changes` even though the implementer input contract already
required them, forcing the orchestrator to fabricate that content when
delegating.

Current v1 per-task slicer shape
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:278#"## Task slicer output contract"`): `id, title,
goal, acceptance_baseline, acceptance_criteria, relevant_files, relevant_docs,
constraints, suggested_tests, allowed_changes, forbidden_changes, dependencies,
verification_set, risk`, in that order. The v1 subagent input contract
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:40#"## Subagent input contract"`) requires
`role, task_id, goal, acceptance_baseline, acceptance_criteria,
context.relevant_files, context.relevant_docs, verification_set, constraints, allowed_changes,
forbidden_changes, expected_output.format`. The slicer also supplies planning
fields such as title, suggested tests, dependencies and risk. Under the copy
rule at `packages/orchestrator-workflow/assets/skill/references/contracts.md:329#"rather than inventing new field"`, the
orchestrator copies goal, baseline identity, assigned criterion records,
relevant files/docs and all scope constraints 1:1 into the input; for the
recorded original contract, the same mapping preserves its criterion strings
and omits only the introduced fields. This invariant is scoped to the task-slicer and
implementer contracts specifically; the advisor's escalation-only output
contract (added 0.21.0) is not part of this superset relationship, since an
advisor spawn is never assembled from a task-slicer's per-task output the
way an implementer spawn is.

The Slice tasks guidance requires the brief to enumerate every file and doc
site that references an identifier, config value, build context, or documented
command the task will change, including a brief annotation for a referenced
site outside the edit set. It uses the existing `relevant_files` and
`relevant_docs` lists rather than adding a duplicate schema field
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:61#"task will not edit."`;
`packages/orchestrator-workflow/assets/agents/task-slicer.md:59#"will not edit."`).
The focused regression pin checks each canonical asset for the changed-value
categories, both existing fields, every reference site, and the annotation
requirement (`packages/orchestrator-workflow/test/docs-consistency.test.ts:4862#"requires reference sites to be annotated in the existing task fields"`).

The scope-boundary wording is pinned independently
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:966#"not implementation instructions"`).
The check derives the *required* field set from
the live subagent-input yaml block itself rather than hardcoding it
(`test/docs-consistency.test.ts:855#"^ {4}${field}:"`): it regex-extracts top-level fields
across the whole input, including scope fields after `context`, plus only
immediate `context.*` children; it subtracts the explicit envelope (`role,
task_id, context, expected_output`), and asserts every remaining name
appears in the slicer output block, so a field added to the subagent input
contract later cannot silently go undocumented in the slicer output; the test
fails instead. Supporting checks in the same suite: both slicer-output copies
(`SKILL.md` and `task-slicer.md`) carry the same fields in the same order
(`test/docs-consistency.test.ts:869#"expect(slicerFields).toEqual(skillFields);"`); the original field order
(`id, title, goal, relevant_files, ... dependencies, risk`) survives around
the newer fields (`test/docs-consistency.test.ts:897#"cursor = idx;"`); `02-tasks.md`'s
sections retain the existing scope fields, with a v1 contract block and a
non-normative criterion-ID checklist
(`test/docs-consistency.test.ts:923#"cursor = idx;"`;
`test/acceptance-baseline.test.ts:272-278#"else assertCriteriaShape(block);"`;
`test/acceptance-baseline.test.ts:404-409#"original contract, keep the original checklist semantics"`); and `task-slicer.md` must frame
`allowed_changes`/`forbidden_changes` as scope boundaries for the
implementer, not implementation instructions
(`test/docs-consistency.test.ts:963#"not implementation instructions"`, prompt text at
`packages/orchestrator-workflow/assets/agents/task-slicer.md:45#"and must not touch — not implementation instructions."`).

The focused acceptance-baseline tests identify the actual baseline, input,
assignment and producer fences by name and nesting, independently assert
mandatory fields at each boundary, and only then compare the mirrored blocks.
The fifth boundary covers coverage/residual tables and the reviewer comparison.
Deleted-field variants exercise the structural assertions; linked examples
check exact assigned records, producer metadata, concrete manual evidence and
revision carry-forward. Installer tests seed old run files, invoke `runInit`
and compare the seeded bytes unchanged, separately from prompt-applicability
checks. Generated role blocks are inspected in every supported harness/tier;
Codex bodies are decoded from TOML before assertions.

## Subagent misfire rule (0.11.0, evidence relocated 0.24.0)

`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:23#"context supplied with it. Treat a misfire as a failed spawn: resume or"` (`## Subagent
misfire rule`): a subagent return is a misfire, not evidence, when it fails
to parse against its role's output contract. Two detection signals:

1. Contract-parse failure: the output does not parse against the role's
   contract (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:7#"against its role's output contract, including an"`). Since a same-day R2 fix-round on 0.16.0
   this signal names an explicit example: an implementer return that omits
   the `mutation_probes` field even though the task assignment named
   mutation probes to run, or that omits the `commits` field even though the
   task assignment asked for a commit (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:10#"task assignment asked for a commit, or that omits"`);
   see [Commits field](#commits-field) below for the field itself.
2. Near-instant return with no tool activity (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:20#"with no tool activity, treat that as a misfire signal rather than"`). This is a
   signal, not proof: a legitimately tool-free return (e.g. a slicer
   answering entirely from context already supplied) is not automatically a
   misfire. It is accepted only if it is contract-valid *and* the assignment
   was answerable from the context supplied with it (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:23#"with it. Treat a misfire as a failed spawn: resume or"`).

Response: treat a misfire as a failed spawn: resume or respawn the
subagent; never fold the non-contract output into run state or count it as a
completed step (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:26#"completed step. For the near-instant, no-tool-activity"`). Since 0.18.0, for the near-instant,
no-tool-activity signal specifically, the rule states a concrete preference
rather than leaving the resume-or-respawn choice open: prefer resume over a
fresh respawn, sending the same subagent a message that explicitly repeats
the original assignment rather than a generic retry, since resume keeps the
subagent's prior turn in context while a fresh spawn starts cold
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:29#"since resume keeps the subagent's prior turn in context"`); fall back to a fresh respawn only if the resume
attempt itself misfires the same way (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:34#"the resume attempt itself misfires the same way. This"`). Every incident of
this exact signal whose outcome was recorded has resolved on the first
resume attempt (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:33#"resolved on the first resume attempt; fall back to a"`); a same-day review-fix round (0.18.0)
bound this claim to the recorded count after finding the original wording
asserted a universal resolve rate the record did not support (see
Motivation below). The preference is scoped away from a second,
structurally different misfire class measured separately: a mid-run
watchdog stall did not resolve on resume and needed a fresh, explicitly
constrained respawn instead (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:39#"watchdog stall as outside this preference. Record every"`). Record every misfire in
`03-decisions.md` (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:40#"This matters most for review: a misfired review is not a"`). Review-gate consequence, stated
explicitly: a misfired review is not a review and never satisfies the review
gate, since review is never skipped (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:41#"review and never satisfies the review gate, since"`). Review-gate
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
a second time" down to just the outcome (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:38#"explicitly constrained respawn produced a"`), since the
incident count is now evidence rather than rule text too. `packages/orchestrator-workflow/assets/skill/references/run-state-and-harness.md:125#"gate's documentation (grounding-mcp) for the full"`
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

`packages/orchestrator-workflow/test/docs-consistency.test.ts:580#"never satisfies the review gate"` pins
the 0.11.0 rule clause-by-clause: section heading present, packages/orchestrator-workflow/test/docs-consistency.test.ts:550#"## Subagent misfire rule", both
detection signals named verbatim, packages/orchestrator-workflow/test/docs-consistency.test.ts:557#"returns near-instantly with no tool activity", the scoping language that
prevents false-positive misfires, packages/orchestrator-workflow/test/docs-consistency.test.ts:563#"only if it is contract-valid and the assignment was answerable from the context supplied with it", the resume-or-respawn response
plus the non-evidence rule, packages/orchestrator-workflow/test/docs-consistency.test.ts:570#"never fold the non-contract output into run state or count it as a completed step", the `03-decisions.md` record
requirement, packages/orchestrator-workflow/test/docs-consistency.test.ts:575#"Record every misfire in", and the review-gate consequence sentence, packages/orchestrator-workflow/test/docs-consistency.test.ts:580#"never satisfies the review gate".
`test/docs-consistency.test.ts:659#"did not resolve on resume; only a fresh, explicitly"` pins the 0.18.0 extension, this
fix-round's hardening, and the 0.24.0 evidence removal in one `describe`
block: the resume-over-respawn preference, test/docs-consistency.test.ts:605#"For the near-instant, no-tool-activity signal specifically, prefer resume over a fresh respawn", the
repeat-the-assignment mechanic, test/docs-consistency.test.ts:611#"send the same subagent a message that explicitly repeats the original assignment rather than a generic retry", why resume beats a fresh respawn,
test/docs-consistency.test.ts:617#"resume keeps the subagent's prior turn in context while a fresh spawn starts cold and risks the same misfire again", the parenthetical signal definition, test/docs-consistency.test.ts:623#"(a return within seconds, zero tool calls, harness or system boilerplate instead of the output contract)", the claim-binding
to recorded outcomes, test/docs-consistency.test.ts:629#"whose outcome was recorded has resolved on the first resume attempt", the conditional respawn fallback, test/docs-consistency.test.ts:635#"fall back to a fresh respawn only if the resume attempt itself misfires the same way",
a negative-pin test that the incident tally and the model-correlation
passage no longer appear (test/docs-consistency.test.ts:645#"see the per-role model preferences", replacing the review-round-1 positive
pins on that passage the 0.24.0 pass removed along with the prose), the
watchdog scope carve-out, test/docs-consistency.test.ts:653#"treat a watchdog stall as outside this preference", and its own resolution detail,
test/docs-consistency.test.ts:659#"did not resolve on resume; only a fresh, explicitly constrained respawn produced a contract-valid review".

## Reproduction requirement (0.14.0)

`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:247-248#"only claims that could vary run to run trigger it."` (detailed workflow,
immediately after the placeholder-row rule): when acceptance rests on
empirical or probabilistic evidence (flake rates, benchmarks, "n runs
green", performance/timing numbers), the reviewer must independently
reproduce it (its own runs or measurements, not a re-read of the
implementer's log) and record method, sample size, and result against the
implementer's claim. The trigger is deliberately narrow: a single
deterministic check (one test run, `tsc`, lint) does not qualify. The GitHub
Actions run-step shell replay named in both installed prompts (see CHANGELOG's
`[0.30.0]` entry) is a second, explicitly non-probabilistic trigger for the
same field: `sample_size: not_applicable` is allowed when the replay itself has
no meaningful sample size
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:249#"The GitHub Actions shell replay named in step 6 is a second, explicitly"`;
`packages/orchestrator-workflow/assets/agents/reviewer.md:228#"shell replay above is a second, explicitly non-probabilistic trigger for"`). The
installed `packages/orchestrator-workflow/assets/agents/reviewer.md:227#"lint) do not trigger this."`
prompt carries the same rule verbatim (second-person voice). Both output
contracts gained a matching `reproduction` field
(`method, sample_size, result, matches_implementer_claim`,
`packages/orchestrator-workflow/assets/skill/references/contracts.md:215#"matches_implementer_claim: matched | mismatched |"` and `reviewer.md:301#"residual_risks:"`); `matches_implementer_claim`
accepts `not_applicable` for reviews where the narrow trigger never fires, so
a reviewer is not forced to fabricate a reproduction record for a
deterministic-only change.

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:#[0.14.0]` (0.14.0): the
agent-dx run `2026-07-18-harness-subprocess-test-deflake` accepted an
implementer's "8/8 green" flake-rate claim on a `maxWorkers` cap fix, then
the reviewer independently reran the suite and found 2/6 red on an
independent 6-run sample (flake rate ~1/3, matching the pre-fix baseline):
nothing in the prior contract had required that rerun, so the first pass
would have accepted the implementer's number as reported. This clause is a
docs/prompt-only change: no runtime code in this package depends on the new
field.

## Mutation probes requirement (0.16.0)

Shipped in 0.16.0 and hardened the same day in an R2 fix-round after review
caught two gaps (see Motivation below).
`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:91#"for real, observe the named test fail, restore, re-verify). Hold the"` (detailed workflow step 6, added
in the R2 pass): when a task's acceptance rests on a test that must fail
without the change, the orchestrator names the mutation probes to run in the
task assignment; the implementer reports each one in the output contract's
`mutation_probes` field (apply the mutant for real, observe the named test
fail, restore, re-verify). Step 6 also carries a short
orchestrator-checkable reference to the installed implementer prompt's
claim-only-what-was-measured rule (`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:93#"not backed by a check it actually ran as"`): treat a verification
claim in the implementer's report as unverified unless it is backed by a
check the implementer actually ran. Before this R2 pass step 6 said nothing
about naming probes at all: the field's only trigger lived in the misfire
rule's prose, mirroring the gap the 0.14.0 reproduction trigger closed for
step 7 in the log entry above, but left open here until this pass.

Both output-contract copies carry the field (`mutant, verified_applied_via,
result, restored_verified`, `packages/orchestrator-workflow/assets/skill/references/contracts.md:137#"restored_verified:"` and `implementer.md:278#"restored_verified:"`)
at 0.16.0 (later grown to eleven sub-fields; see Mutation probe definition
fields and expectation split below).
The installed prompt's matching bullet
(`implementer.md:102#"rather than omitting the field."`) states the not-applicable signal added in the
R2 pass: when the assignment named no probes, the implementer returns
`mutation_probes: []` rather than omitting the field, so "none asked for" is
distinguishable from "asked for and not reported": before this pass an
implementer never given probes and one that silently dropped them returned
the identical placeholder block. An output missing the field when probes
*were* named is a misfire (see Subagent misfire rule above), worded
identically in both copies since the R2 pass as "treated as a misfire, not
evidence" (the installed prompt alone previously said "incomplete").

`packages/orchestrator-workflow/test/docs-consistency.test.ts:1104#"expect(skillBlock).toBe(implementerBlock);"` pins
the original 0.16.0 shape: the installed prompt's instruction and field
mention, packages/orchestrator-workflow/test/docs-consistency.test.ts:1079#"an output missing that field when probes were named is treated as a misfire, not evidence", the claim-only-what-was-measured rule, packages/orchestrator-workflow/test/docs-consistency.test.ts:1087#"never claim a run you did not execute", the
misfire-rule sentence, packages/orchestrator-workflow/test/docs-consistency.test.ts:1092#"does not parse against its role's output contract, including an implementer return that omits the", and a byte-for-byte cross-copy equality
check on the field block, packages/orchestrator-workflow/test/docs-consistency.test.ts:1104#"expect(skillBlock).toBe(implementerBlock);".
`test/docs-consistency.test.ts:1185#"expect(implementerMd).toContain(enumeration);"` pins the R2 additions: step 6's
sentence and its claim-only-what-was-measured reference, test/docs-consistency.test.ts:1133#"apply the mutant for real, observe the named test fail, restore, re-verify" (the `it` block that follows it pins the claim-only-what-was-measured reference; the rule name recurs too often in that file to anchor a citation on it), the
not-applicable clause in both copies, test/docs-consistency.test.ts:1144#"expect(implementerMd).toContain(clause);", and two exact-string pins,
test/docs-consistency.test.ts:1151#"expect(implementerMd).toContain(field);", that catch a rename applied identically to both copies -- a mutant
the cross-copy equality check above cannot catch on its own, since it only
proves the two copies match each other, not that either still uses the
pinned sub-field names.

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:#[0.16.0]` (0.16.0 plus
its same-day R2 follow-up, agent-tasks task 16637a96): a 16-round dogfood
where two implementer rounds dropped briefed-as-mandatory mutation probes
from their return entirely; review of the resulting change then found the
shipped contract had no trigger the kit itself ever produced and no
not-applicable signal, both closed in the R2 pass documented here.

## Fix-round mutation probe replay

Added after 0.29.0, tightened in review round 2: on any round after the
task's first (the trigger names the condition directly, not an ordinal,
since "the first fix round" and "the first review round" read
differently), the orchestrator's briefing also names every mutation probe
named in an earlier round of this task, sourced from the run's
`04-implementation-summary.md` (on the task's first round there are none
to name), and the implementer replays each one, not only the round's new
probes, before the next reviewer spawn
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:112#"spawn. Record meaningful decisions in"`,
step 6). The installed prompt carries the same rule as its own bullet
(`packages/orchestrator-workflow/assets/agents/implementer.md:105#"On any round after the task's first, the assignment also names"`).
A replayed probe whose mutant now survives or can no longer be applied was,
at this point, the regression signal: both copies said so and required it
resolved before the next reviewer spawn, not merely reported. Tightened by
task 06330af2 (see Mutation probe definition fields and expectation split
below): once a routine negative-control probe could legitimately report
`result: survived`, `result` alone stopped being sufficient -- today both
copies instead key the regression signal off `expectation`
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:107#"A replayed probe whose"`
and
`packages/orchestrator-workflow/assets/agents/implementer.md:114#"A replayed probe whose"`).

Both output-contract copies gained a fifth `mutation_probes` sub-field,
`replayed: false | true` (new probe: `false`; a prior round's probe
replayed this round: `true`), added identically
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:138#"replayed: false | true"`
and
`packages/orchestrator-workflow/assets/agents/implementer.md:279#"replayed: false | true"`),
the same byte-for-byte-block rigor already applied to the `mutation_probes`
and `commits` fields above. Step 7 no longer grants the reviewer a
skip permission directly (the reviewer never reads SKILL.md, so that
permission had no delivery path); instead the orchestrator's reviewer
briefing names the replayed probes the implementer reports as killed. At
this point that meant naming them together with their `mutant` and
`verified_applied_via` values; task 06330af2 (see Mutation probe
definition fields and expectation split below) tightened this to their
mutant definition (`file`, `anchor`, `before`, `after`) and
`verified_applied_via` value, not merely their id, since an id alone
cannot be skipped by this rule. Either way the reviewer may then skip
re-running the ones so named, without changing the reviewer output
contract itself
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:267#"implementer reports as killed together with their mutant definition"`);
`assets/agents/reviewer.md` itself is untouched by this change.

`packages/orchestrator-workflow/test/docs-consistency.test.ts:4962#"On any round after the task's first, the briefing also names"` pins step 6's
instruction, `test/docs-consistency.test.ts:4974#"or which can no longer be applied (reason:"`
pins the regression-signal consequence, and the implementer prompt's
matching rules
(`test/docs-consistency.test.ts:4980#"On any round after the task's first, the assignment also names"`,
`test/docs-consistency.test.ts:4992#"resolve it before the next reviewer spawn"`). A byte-for-byte
cross-copy equality check on the `mutation_probes` block including the new
sub-field (`test/docs-consistency.test.ts:5032#"replayed: false | true"`), the step 7 reviewer-briefing
sentence (`test/docs-consistency.test.ts:5038#"the orchestrator's reviewer briefing names the replayed probes"`), and a
negative pin scoped to `reviewer.md`'s output-contract yaml block, that it
gains no `replayed` field, sliced from the output-contract heading rather
than the first yaml fence in the file so an earlier decoy fence cannot be
mistaken for it
(`test/docs-consistency.test.ts:5079#"outputContractBlock).not.toContain"`). A further pin locks the eleven
`mutation_probes` sub-fields to their fixed order in both copies (grown
from five at this rule's own introduction to ten, then to eleven, under
task 06330af2, see Mutation probe definition fields and expectation
split below)
(`test/docs-consistency.test.ts:5082#"both copies' mutation_probes block has exactly the eleven sub-fields in a fixed order"`).

Motivation: `lava-ice-logs/2026-09-05/ow-kit-effort-analysis.md` section
7(ii) found fix-round regressions from a prior round's own fix that a
mechanical replay of every earlier round's mutation probes, run before
the next reviewer spawn, would have caught without spending a reviewer
round on it; see `packages/orchestrator-workflow/CHANGELOG.md`'s
`[0.30.0]` entry for the pointer.

## Recurrence field

The reviewer output contract gained a per-finding `recurrence: new |
repeated` field, added to both copies identically
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:204#"recurrence: new | repeated"` and
`packages/orchestrator-workflow/assets/agents/reviewer.md:296#"recurrence: new | repeated"`, same field, same
line-relative position inside the findings item in both). It classifies
each finding against earlier review rounds on the same task: `new` for a
defect class not previously found there, `repeated` for one that already
appeared; on a task's first round every finding is `new` by definition
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:266#"Review-round escalation budget's trigger."`). The
installed `reviewer.md:114#"classify each finding as"`
prompt instructs the classification directly, gated on the orchestrator
having named the review round number in the briefing (a step 7 addition,
`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:264#"Review-round escalation budget's trigger (see below) without re-deriving it"`).
This field feeds the review-round escalation budget's trigger; full
treatment of that budget (the second-halt-or-third-round trigger, the
three named escalations, the `03-decisions.md` marker) is out of this
doc's lane; see
[review-gate-and-waivers.md](review-gate-and-waivers.md#review-round-escalation-budget).
No dedicated byte-for-byte drift guard existed for the findings block
before this change (unlike the `reproduction` and `mutation_probes`
fields above); one now does, extracting the `findings:` block from both
raw files the same way.

## Mutation probe definition fields and expectation split

Task 06330af2 grew both `mutation_probes` output-contract copies from the
five sub-fields they carried at the fix-round replay rule's own
introduction (`mutant, verified_applied_via, result, restored_verified,
replayed`, see above) to ten, then, in this same task's review round 3,
to eleven. `file` and `anchor` (a line number or a unique surrounding
string) locate the mutant; `before` and `after` are the exact text
swapped there, so a later round can mechanically reapply the same edit
instead of only reading a prose description
(`packages/orchestrator-workflow/assets/agents/implementer.md:85#"anchor, before, after, verified_applied_via, result, expectation,"`).
`expectation: met | violated | not_applicable` records whether a measured
`result` (`killed` or `survived`) matched what the probe was expected to
do; it is `not_applicable` otherwise, for example when the mutant could
not be applied and no `result` was measured at all
(`implementer.md:94#"otherwise (for example when the mutant"`).
A routine negative-control probe reports `result: survived, expectation:
met`, which is not a regression.

Review round 3 added the eleventh sub-field, `reason`: free text,
required exactly when `result` is `not_applicable`, empty otherwise
(`implementer.md:96#"text, required when"`).
Before this round the two `not_applicable` verdicts were distinguished
only by prose parenthetical, with no field a misfire check could look
for. `reason` carries one of two canonical strings that distinguish a
non-regression from a regression: `no definition recorded` (a
prior-round probe recorded with only an id, no definition to reapply,
not itself a regression) and `target text no longer present` (a replayed
probe whose mutant can no longer be applied, the regression signal)
(`implementer.md:100#"(a replayed probe whose mutant can no longer be"`).

By-definition replay and reviewer-skip rules (the rules themselves live
in [Fix-round mutation probe replay](#fix-round-mutation-probe-replay)
above; this is only the field-shape half of that story): the fix-round
replay rule names a prior round's probe to replay by its mutant
definition (`file`, `anchor`, `before`, `after`), not merely by its id,
since an id alone cannot be reapplied. Step 7's reviewer-briefing skip
permission was tightened the same way in this task: it names the
replayed-and-killed probes by their mutant definition and
`verified_applied_via` value rather than only their id, since an id
alone cannot be skipped by this rule either
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:266#"the orchestrator's reviewer briefing names the replayed probes the"`). Run mode `single` inverts this permission: the orchestrator is then the author of the probes, so the same step defines once what a named probe is (its full definition or a resolved immutable plan-and-result reference, never an id alone), requires the reviewer to replay every named orchestrator probe, and to report, in the existing `reproduction` field, whether each replayed verdict matches the recorded one, a mismatch also setting `matches_implementer_claim: mismatched` (packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:273#"that skip permission does not apply"). The reviewer prompt carries the duty in its own words, because a reviewer runs without the skill, applies it under any `review_method` (its `normal` row lists the replay among the obligations no method suspends), and keeps it inert unless the briefing names the mode (packages/orchestrator-workflow/assets/agents/reviewer.md:281#"Without that mode line in the briefing this obligation"); `contracts.md` only points to the step and adds no output field (packages/orchestrator-workflow/assets/skill/references/contracts.md:276#"no output field is added for it"). `test/single-probe-replay.test.ts` binds the prompt and the pointer to the rule's wording through one constant and checks every rendered reviewer variant.

The pins that hold them: an exact sub-field-name pin independent of the
byte-for-byte cross-copy equality check
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:1147#"each copy pins the mutation_probes field block by its exact sub-field names and result enum, not just cross-copy equality"`),
a pin on the field enumeration in prose
(`test/docs-consistency.test.ts:1181#"the installed prompt pins the field enumeration in prose"`),
a dedicated pin on the `reason` requiredness rule
(`test/docs-consistency.test.ts:1196#"is required exactly when result is not_applicable, empty otherwise"`),
a fixed-order pin locking all eleven sub-fields to their exact order in
both copies
(`test/docs-consistency.test.ts:5082#"both copies' mutation_probes block has exactly the eleven sub-fields in a fixed order"`),
and a template agreement pin that derives the
`04-implementation-summary.md` Mutation Probes table's columns and the
`mutation_probes` contract's sub-field list programmatically and asserts
they agree, so the new `reason` column and sub-field cannot drift apart
(`packages/orchestrator-workflow/test/template-markers.test.ts:419#"the template's Mutation Probes columns and the mutation_probes contract's sub-field list agree"`).

## Class closure field

A fix round used to close only the reported instance of a defect class,
not the class itself, so the next review round routinely found the same
class recurring at a different site (see CHANGELOG's entry for this rule
for the batch counts). On any round after a task's first, the installed
implementer prompt requires enumerating the defect's class before
returning: run a search command for the pattern the finding's fix
addresses and list every hit, or state a source-level closure and say why
in `summary`
(`packages/orchestrator-workflow/assets/agents/implementer.md:120#"On any round after the task's first, when the round fixes a review"`).
The result is reported in the implementer output contract's
`class_closure` field, added to both copies identically
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:139#"class_closure:"`
and `packages/orchestrator-workflow/assets/agents/implementer.md:280#"class_closure:"`,
byte-identical block, sitting after `mutation_probes` and before `risks`
in both, the same rigor already applied to `mutation_probes` and
`commits` above): `kind: enumerated | source | not_applicable`
(`not_applicable` only on the task's first round, when there is no review
finding yet to fix), the search `command` that produced the hit list
(empty when `kind` is not `enumerated`), the `sites` list of every hit
found (empty when `kind` is not `enumerated`), and `closed: true | false`,
`true` when every found site is fixed this round, `false` when one is
not, with the unclosed site named in `risks` with the reason
(`packages/orchestrator-workflow/assets/agents/implementer.md:131#"when every site the round found (by search or by source-level"`).
The round also runs one mutation probe per review finding it fixed, in
addition to any probe the assignment names
(`implementer.md:134#"Run one mutation probe per"`).

An output missing the field on any round after the task's first is a
misfire (see
[Subagent misfire rule](#subagent-misfire-rule-0110-evidence-relocated-0240)
above), named in the misfire rule the same way it already names
`mutation_probes` and `commits`
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:10#"asked for a commit, or that omits the"`).

The reviewer prompt carries an independent, matching obligation for round
N+1: run its own class-enumeration search rather than trust the
implementer's report, and compare its own hits against the implementer's
`class_closure.sites` list or `source` closure reason; a site the
reviewer's search finds that the implementer's report omits is itself a
finding, classified under the ordinary severity gate by the underlying
defect's own severity rather than a fixed floor
(`packages/orchestrator-workflow/assets/agents/reviewer.md:124#"a site your search finds that the implementer's report omits"`).
In run mode `single`, where there is no separate implementer report, the
reviewer compares its search against the Class Closure row of
`04-implementation-summary.md` plus its Risks / Notes section instead
(`reviewer.md:127#"there is no separate implementer"`).
Class match, not site match, decides `recurrence: repeated`: the reviewer
sets it whenever a finding's defect class matches an earlier round's
finding, even at a site the earlier round never touched
(`reviewer.md:116#"Class match, not site match, decides this"`).

Step 8 of the detailed workflow halts at the first `recurrence: repeated`
finding whose class a previous round's fix already addressed and whose
`introduced_by_delta` is `yes` or `unknown`, before any further implementer
spawn, and names split or redesign in `03-decisions.md`
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:323#"Halt at the first"`);
the Round-2 halt rule's own cross-reference to step 8 states the identical
scope
(`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:56#"Step 8 of the detailed workflow states the operational"`),
both sites pinned through one shared test constant so dropping either
clause at either site fails on its own
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:1420#"built from one shared constant"`).
Full treatment of the Round-2 halt rule and the escalation budget it
feeds is out of this doc's lane; see
[review-gate-and-waivers.md](review-gate-and-waivers.md#review-round-escalation-budget).

`assets/templates/04-implementation-summary.md` gains a Class Closure
row per fix round: the defect class, the enumeration command and the
sites (both blank when `Closure Kind` is not `enumerated`), and the
closure kind, `enumerated | source` -- `not_applicable` never appears in
this table, since a row exists only for a round that fixed a finding,
never for the task's first round
(`packages/orchestrator-workflow/assets/templates/04-implementation-summary.md:102#"never appears"`).

The pins that hold them: an exact sub-field-name pin independent of the
byte-for-byte cross-copy equality check
(`packages/orchestrator-workflow/test/docs-consistency.test.ts:1350#"each copy pins the class_closure field block by its exact sub-field names, not just cross-copy equality"`),
a fixed-order pin locking all four sub-fields to their exact order in
both copies
(`test/docs-consistency.test.ts:1367#"both copies' class_closure block has exactly the four sub-fields in a fixed order"`),
and a template-agreement style check on the 04 template's own Class
Closure section prose
(`packages/orchestrator-workflow/test/template-markers.test.ts:505#"states the closure-kind enum (no not_applicable, since a row exists only for a fix round)"`).

Motivation: two observed batches where a fix round closed only the
reported instance and the class recurred at a new site in a later review
round; the counts live in the CHANGELOG entry for this rule, not here
(`packages/orchestrator-workflow/CHANGELOG.md:#[0.39.0]`).

## Commits field

The implementer output contract gained a `commits` field, added to both
copies identically (`packages/orchestrator-workflow/assets/skill/references/contracts.md:151#"commits:"`
and `packages/orchestrator-workflow/assets/agents/implementer.md:248#"role: implementer"`,
byte-identical block, the same rigor already applied to `mutation_probes`
above). It lists the full sha of every commit the implementer produced on
the task branch, in order (worded in substance in the installed prompt's rule bullet,
`implementer.md:195#"Report the full sha of every commit you produced"`, with
"in order" carried at `implementer.md:196#"order, in the"`).
When the task produced no commit, the implementer returns `commits: []`
rather than omitting the field, so "did not commit" is distinguishable from
"forgot to report" (`implementer.md:198#"evidence. When the task produced no commit, return"`);
the field is otherwise mandatory on every return, matching `mutation_probes`
and every other contract field. An output missing the field when the task
assignment asked for a commit is a misfire (see
[Subagent misfire rule](#subagent-misfire-rule-0110-evidence-relocated-0240)
above), worded identically in both copies as "treated as a misfire, not
evidence" (`packages/orchestrator-workflow/assets/skill/references/review-and-recovery.md:10#"task assignment asked for a commit, or that omits"`
and `implementer.md:197#"assignment asked for a commit is treated as a misfire, not"`).

`packages/orchestrator-workflow/test/docs-consistency.test.ts:1260#"expect(implementerMd).toContain(clause);"`
pins the field: the installed prompt's full-sha instruction and field
mention, packages/orchestrator-workflow/test/docs-consistency.test.ts:1226#"an output missing that field when the task assignment asked for a commit is treated as a misfire, not evidence", the misfire-rule sentence, packages/orchestrator-workflow/test/docs-consistency.test.ts:1232#"field even though the task assignment asked for a commit", a dedicated pin
on the "full sha" / "in order" semantics themselves (not only the
surrounding clauses), with the installed prompt's in-order semantics cited above, a byte-for-byte cross-copy equality check
on the field block, packages/orchestrator-workflow/test/docs-consistency.test.ts:1255#"expect(skillBlock).toBe(implementerBlock);", and the not-applicable
`commits: []` clause, now pinned in the installed prompt alone: the contract-reduction refactor
(`packages/orchestrator-workflow/CHANGELOG.md:#[0.35.0]`) routed the skill copy's duplicate prose to that prompt (and its evidence and probe half to the evidence-and-probes reference, workflow step 6)
instead of repeating the clause there, packages/orchestrator-workflow/test/docs-consistency.test.ts:1260#"expect(implementerMd).toContain(clause);".

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:#[0.27.0]`
(agent-tasks task 2355f144): the implementer output contract had no field
for the commit sha produced; briefs asked for it in prose and implementers
omitted it (twice in one session), forcing the orchestrator to re-derive it
from git. Unlike a prose ask, a contract field is checked by the misfire
rule.

The installed prompt also gained a rule bullet next to the commit-reporting
ones above: before committing, run `slop-detector`'s `review-slop` pack
over every changed file and the commit message and fix every block-level
finding first
(`packages/orchestrator-workflow/assets/agents/implementer.md:203#"Before committing, when slop-detector is available run"`),
worded the same "misfire, not evidence" way as the `commits` field rule
just above it (see [Subagent misfire rule](#subagent-misfire-rule-0110-evidence-relocated-0240)).
Reworded to name a `check` invocation that takes one-or-more paths
(`<changed file> [<changed file> ...]`) rather than a single
`<changed files>` placeholder the CLI silently only scanned the first of,
to lead with the PATH-installed form rather than a repository-vendored
path, and to state that only exit `0` or `1` is a result while exit `2`
is a usage error rather than a clean check.

## Review-method axis: method_applied and withdrawn

Added after 0.31.0 (pandora task 226c532c): a briefing-time
`review_method: normal | rigorous | adversarial` parameter, orthogonal to
the effort tier, and two matching reviewer output-contract fields,
`method_applied` and `withdrawn`, added to both copies identically
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:216#"method_applied: normal | rigorous | adversarial"`
and
`packages/orchestrator-workflow/assets/agents/reviewer.md:308#"method_applied: normal | rigorous | adversarial"`,
same field, same line-relative position right after
`matches_implementer_claim`, the same byte-for-byte-block rigor already
applied to `reproduction` and the findings block above). The three
methods are obligation sets, not personas, defined in a table installed
only in `reviewer.md` (SKILL.md carries the selection rule in prose, not
a duplicate table): `normal` reads the diff and spec and runs the
declared tests once, adding nothing beyond the obligations the Check
list and the Rules below it already state and suspending none of them:
the empirical-reproduction rule, the GitHub Actions shell replay rule, and the probe replay of a run mode `single` briefing
apply under every method
(`packages/orchestrator-workflow/assets/agents/reviewer.md:33#"adds nothing beyond the obligations already stated in the Check list"`);
`rigorous` is the default when a briefing names none
(`packages/orchestrator-workflow/assets/agents/reviewer.md:26#"in every briefing; treat an unnamed method as"`)
and adds an independent extract, a base-attribution control, and the
pre-existing mandatory `reproduction`/`matches_implementer_claim`
requirement; `adversarial` adds one discriminating probe or negative
control per acceptance criterion, an active search of the neighbouring
scenario space, an attempt to break the claimed invariant, and a list of
failed break attempts. detailed workflow reference states the selection rule by risk
class (`adversarial` at minimum for security judgment, install/deploy
scripts, hand-edited lockfiles, cross-major overrides, or anything the
operator flags high-risk; `normal` only for docs, renames, or batch
cosmetics; `rigorous` otherwise) and forbids pairing `adversarial` with
the `-medium` reviewer tier as a budget mismatch that names probes
without the effort to run them
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:224-225#"reviewer tier, a budget mismatch that names probes without the effort to run"`);
tiers themselves are unchanged by this axis.

`rigorous` and `adversarial` carry a withdrawal rule: a finding that does
not reproduce on a second attempt with a corrected harness is withdrawn
in the same round, not carried into the next one, and reported under
`withdrawn` with the reason, so the method cannot buy false positives
(`packages/orchestrator-workflow/assets/agents/reviewer.md:37#"Withdrawal rule ("`).
Emit `withdrawn: []` when nothing was withdrawn, the same
not-omitted-vs-empty distinction already applied to `mutation_probes`
and `commits` above
(`packages/orchestrator-workflow/assets/agents/reviewer.md:41#"when nothing was withdrawn. Report the method you actually"`
and
`packages/orchestrator-workflow/assets/skill/references/contracts.md:276#"when nothing was withdrawn."`).

The grounding-mcp completeness reader enforces the per-round pairing in
`assets/templates/05-review-findings.md`: a declared `review-method` must
have an equal-or-stronger matching `method-applied` value. The explicit
marker is preferred; the immediately following `Method:` line is a
constrained fallback only when it names one declaration per line, rather
than sharing a summary across multiple declarations. A value on that
fallback line is followed solely by end-of-sentence punctuation or by one
balanced, non-nested parenthetical aside; another clause or a nested aside
is malformed. The orchestrator writes every returned `method_applied` into
the matching marker and resupplies an omission or mismatch before
acceptance, as required by detailed workflow reference; reader enforcement does not
authorize inference from findings or from a findings-table decision; the
check is per round and does not infer a return from a finding's free prose.
A missing return remains a blocker until the reviewer resupplies it.

`packages/orchestrator-workflow/test/docs-consistency.test.ts:1858#"both copies carry the method_applied field with the three-method enum"`
pins the field in both copies,
`test/docs-consistency.test.ts:1864#"both copies carry the withdrawn field with its description/reason sub-fields"`
pins the `withdrawn` sub-fields, a byte-for-byte cross-copy equality
check on the combined block
(`test/docs-consistency.test.ts:1870#"the method_applied/withdrawn block is byte-for-byte identical between SKILL.md and reviewer.md"`),
the reviewer.md unnamed-method default
(`test/docs-consistency.test.ts:1882#"reviewer.md states rigorous as the default when the briefing names no method"`),
and the detailed workflow reference selection-rule sentence including the
never-`adversarial`-on-`-medium` constraint
(`test/docs-consistency.test.ts:1887#"detailed workflow reference states the review-method selection rule by risk class, including the never-adversarial-on-medium constraint"`).

Motivation and the anchoring dogfood evidence live in
`CHANGELOG.md:#[0.32.0]#"A review-method axis, orthogonal to the effort tier"`,
not here.

## Probe verdict fields: legend, copy rule, cross-check

The implementer prompt is the normative site for what `result` and
`expectation` mean and where their values come from
(`packages/orchestrator-workflow/assets/agents/implementer.md:156#"reacted to the mutant under the runner's pass predicate"`):
"`result: killed` means the probe's test command reacted to the mutant
under the runner's pass predicate, or the test pass predicate declared in
the task assignment or probe plan when no runner supplies a verdict;
`survived` means it did not. `expectation: met` means the measured result
matches the expected result declared in the task assignment or probe plan,
and `violated` means it does not; both fields are `not_applicable` when no
result was measured."
"When a mutation-probe runner is available, run the named probes through
it and copy every supplied `result` and `expectation` verbatim into
`mutation_probes`, never substituting your interpretation of its test
output."
"Quote each supplied verdict in `tests.executed`; when it supplies only
`result`, derive `expectation` from the expected result declared in the
task assignment or probe plan, and identify that declaration and
derivation there."
"When no machine-readable verdict is available, state that explicitly in
`tests.executed`, identify the declared test pass predicate and expected
result, and quote the observed baseline and mutant outcomes."
"Derive `result` from those observations only when the baseline passed,
mutant application was verified, and the mutant test completed under the
same command and predicate; derive `expectation` by comparing that result
with the declared expected result, and label both derivations as manual."
`contracts.md` carries those five claims for the orchestrator
(`packages/orchestrator-workflow/assets/skill/references/contracts.md:164#"reacted to the mutant under the runner's pass predicate"`).
The orchestrator's transfer rules are in step 6
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:117#"row, compare each copied field with the quoted verdict and each derived"`):
"Before transferring a probe row, compare each copied field with the
quoted verdict and each derived field with its stated declaration and
evidence. An explicit absence of a machine-readable verdict requires the
manual comparison, not resupply of a nonexistent verdict."
"On a mismatch or missing required evidence, obtain corrected evidence
from the implementer or rerun the probe in isolation, record the action in
`03-decisions.md`, and keep the row blocked from transfer until the
comparison succeeds; if the evidence cannot be obtained, record the
unresolved proof rather than repeatedly requesting an unavailable verdict.
Never invent a verdict, override a supplied field, or fill an unsupported
derivation."
"Apply the same evidence reporting and comparison to probes you run
yourself before recording their rows in `04-implementation-summary.md`."
"A quoted probe verdict is not a named result of the verification set, so
the set's missing-or-extra rule does not apply to it."
The reviewer prompt applies the same rules to its own measurements
(`packages/orchestrator-workflow/assets/agents/reviewer.md:243#"probes you run, apply the implementer's verdict-copy"`):
"For probes you run, apply the implementer's verdict-copy and
manual-derivation rules to your own measurements, reporting the quoted
verdict or explicit verdict absence and derivation evidence in
`reproduction` and carrying the same reported values into any associated
finding."
The single-mode replay rule carries the corresponding measured fields
(`packages/orchestrator-workflow/assets/skill/references/evidence-and-probes.md:292#"the probe, the replayed verdict or"`):
"It reports per probe, in `reproduction`, the probe, the replayed verdict
or explicit verdict absence with manual derivation evidence, and whether
the measured `result` and `expectation` match the recorded fields; a
mismatch is a finding of at least `high` and sets
`matches_implementer_claim: mismatched`."
The contract shape, the enums and the eleven sub-fields are unchanged, and no
tool is named. `reason` keeps its meaning (required only for
`not_applicable`). Pinned by `test/probe-plans-recovery.test.ts`, which binds
all eleven clauses across the prompt, contracts, workflow, CHANGELOG and this
section, while `test/init.test.ts` renders the legend into each implementer
tier and Codex developer instructions.

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
