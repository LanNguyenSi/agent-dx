---
type: invariant
title: Subagent Contracts and the Slicer-Superset Invariant
description: The four subagent I/O contracts, where they are duplicated, the task-slicer-superset invariant, and the misfire rule that keeps subagent output honest.
tags: [subagent-contracts, slicer-superset, misfire-rule, io-contract-duplication, read-only-roles]
timestamp: 2026-07-18T12:00:00Z
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
`packages/orchestrator-workflow/assets/skill/SKILL.md:24-42` (`## Roles`).

Read-only vs. writable is also a code-level set:
`READ_ONLY_ROLES = new Set(["explorer", "reviewer"])` at
`packages/orchestrator-workflow/src/models.ts:14-17`. There is no matching
`WRITABLE_ROLES` constant; the writable set is derived as the complement,
exactly as `packages/orchestrator-workflow/test/docs-consistency.test.ts:153`
computes it: `ROLES.filter((role) => !READ_ONLY_ROLES.has(role))` →
`task-slicer, implementer`. That posture is tool-level only for
Edit/Write/NotebookEdit; Bash mutation is guarded by prompt instruction alone,
which `packages/orchestrator-workflow/test/docs-consistency.test.ts:359-366`
pins README.md to state honestly ("guarded by instruction only", "nothing
technically prevents it") rather than claiming full closure. Enforcement
mechanics for that posture are out of this doc's lane; see
[install-fence-mechanics.md](install-fence-mechanics.md).

Where the harness supports subagent definitions, `SKILL.md` tells the
orchestrator to spawn the installed prompts under
`packages/orchestrator-workflow/assets/agents/{explorer,task-slicer,implementer,reviewer}.md`
instead of improvising role text
(`packages/orchestrator-workflow/assets/skill/SKILL.md:44-48`). Per-role
default models (`DEFAULT_MODELS`,
`packages/orchestrator-workflow/src/models.ts:27-32`) are out of this doc's
lane; see [model-preselection.md](model-preselection.md).

## Where each contract lives, and what keeps the copies equal

Every role's output contract is written twice: once in `SKILL.md`'s own
fenced yaml block (the orchestrator's reference copy), once in the role's
installed prompt, in its trailing "Return exactly this structure as your
final output, nothing else" block:

- Explorer: `packages/orchestrator-workflow/assets/skill/SKILL.md:158-181`
  (`## Explorer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/explorer.md:47-70`.
- Implementer: `packages/orchestrator-workflow/assets/skill/SKILL.md:206-227`
  vs. `packages/orchestrator-workflow/assets/agents/implementer.md:27-48`.
- Reviewer: `packages/orchestrator-workflow/assets/skill/SKILL.md:231-252`
  vs. `packages/orchestrator-workflow/assets/agents/reviewer.md:48-69`. Both
  copies gained a `reproduction` field in 0.14.0; see
  [Reproduction requirement](#reproduction-requirement-0140) below.
- Task-slicer:
  `packages/orchestrator-workflow/assets/skill/SKILL.md:256-286`
  (`## Task slicer output contract`) vs.
  `packages/orchestrator-workflow/assets/agents/task-slicer.md:30-60`.
- Subagent input contract (the shape the orchestrator sends when delegating,
  not a role's own output) lives only in
  `packages/orchestrator-workflow/assets/skill/SKILL.md:185-202`; there is no
  installed-prompt counterpart because it is what the orchestrator constructs,
  not what a subagent returns.

Direct read on this branch confirms all four output-contract pairs are
field-identical prose. Only the task-slicer/subagent-input relationship has a
dedicated equality-and-superset test suite; the other three pairs are
duplicated the same way but have no equivalent automated drift guard today.

## The core invariant: slicer output is a lossless superset of the subagent input contract

Every field the subagent input contract requires must have a same-named
counterpart in the task-slicer's per-task output, so the orchestrator copies
task fields 1:1 into the implementer contract at delegation time instead of
inventing values. This was not always true:
`packages/orchestrator-workflow/CHANGELOG.md:117-144` (0.10.0) records that the
slicer contract previously omitted `constraints`, `allowed_changes`,
`forbidden_changes` even though the implementer input contract already
required them, forcing the orchestrator to fabricate that content when
delegating.

Current per-task slicer shape
(`packages/orchestrator-workflow/assets/skill/SKILL.md:256-286`): `id, title,
goal, relevant_files, relevant_docs, acceptance_criteria, constraints,
suggested_tests, allowed_changes, forbidden_changes, dependencies, risk`, in
that order. The subagent input contract
(`packages/orchestrator-workflow/assets/skill/SKILL.md:185-202`) requires:
`role, task_id, goal, context.relevant_files, context.relevant_docs,
constraints, acceptance_criteria, allowed_changes, forbidden_changes,
expected_output.format`. `suggested_tests` is the one slicer field with no
subagent-input counterpart (tests are not part of that contract); it exists
for the `02-tasks.md` template and the step-4 workflow narrative instead. The
copy rule is stated verbatim at
`packages/orchestrator-workflow/assets/skill/SKILL.md:288-291`: "The
orchestrator copies each task's goal, relevant_files, relevant_docs,
acceptance_criteria, constraints, allowed_changes, and forbidden_changes 1:1
into the subagent input contract when delegating implementation, rather than
inventing new field values."

`packages/orchestrator-workflow/test/docs-consistency.test.ts:381-565`
enforces this. The load-bearing check derives the *required* field set from
the live subagent-input yaml block itself rather than hardcoding it
(`test/docs-consistency.test.ts:435-459`): it regex-extracts top-level fields
plus `context.*` children, subtracts pure delegation mechanics (`role,
task_id, context, expected_output, format`), and asserts every remaining name
appears in the slicer output block, so a field added to the subagent input
contract later cannot silently go undocumented in the slicer output; the test
fails instead. Supporting checks in the same suite: both slicer-output copies
(`SKILL.md` and `task-slicer.md`) carry the same fields in the same order
(`test/docs-consistency.test.ts:461-472`); the original field order
(`id, title, goal, relevant_files, ... dependencies, risk`) survives around
the newer fields (`test/docs-consistency.test.ts:474-496`); `02-tasks.md`'s
sections map 1:1 to the fields in order
(`test/docs-consistency.test.ts:498-522`); and `task-slicer.md` must frame
`allowed_changes`/`forbidden_changes` as scope boundaries for the
implementer, not implementation instructions
(`test/docs-consistency.test.ts:560-564`, prompt text at
`packages/orchestrator-workflow/assets/agents/task-slicer.md:21-23`).

## Subagent misfire rule (0.11.0)

`packages/orchestrator-workflow/assets/skill/SKILL.md:321-332` (`## Subagent
misfire rule`): a subagent return is a misfire, not evidence, when it fails
to parse against its role's output contract. Two detection signals:

1. Contract-parse failure: the output does not parse against the role's
   contract (`SKILL.md:323-324`).
2. Near-instant return with no tool activity (`SKILL.md:324-325`). This is a
   signal, not proof: a legitimately tool-free return (e.g. a slicer
   answering entirely from context already supplied) is not automatically a
   misfire. It is accepted only if it is contract-valid *and* the assignment
   was answerable from the context supplied with it (`SKILL.md:325-328`).

Response: treat a misfire as a failed spawn: resume or respawn the
subagent; never fold the non-contract output into run state or count it as a
completed step (`SKILL.md:328-330`). Record every misfire in
`03-decisions.md` (`SKILL.md:330`). Review-gate consequence, stated
explicitly: a misfired review is not a review and never satisfies the review
gate, since review is never skipped (`SKILL.md:330-332`). Review-gate
severities and waiver mechanics themselves are out of this doc's lane; see
[review-gate-and-waivers.md](review-gate-and-waivers.md).

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:94-115` (0.11.0): a
live incident where a reviewer subagent spawn returned in 5 seconds with 0
tool uses, handing back harness hook-boilerplate instead of the reviewer
output contract; a resume of the same spawn produced a correct full review.
Before 0.11.0 the kit said nothing about malformed returns, leaving room to
silently accept a non-review as a passed review gate.

`packages/orchestrator-workflow/test/docs-consistency.test.ts:315-351` pins
the rule clause-by-clause: section heading present (315-320), both detection
signals named verbatim (322-327), the scoping language that prevents
false-positive misfires (329-334), the resume-or-respawn response plus the
non-evidence rule (336-341), the `03-decisions.md` record requirement
(343-345), and the review-gate consequence sentence (347-350).

## Reproduction requirement (0.14.0)

`packages/orchestrator-workflow/assets/skill/SKILL.md:125-132` (step 7,
immediately after the placeholder-row rule): when acceptance rests on
empirical or probabilistic evidence (flake rates, benchmarks, "n runs
green", performance/timing numbers), the reviewer must independently
reproduce it — its own runs or measurements, not a re-read of the
implementer's log — and record method, sample size, and result against the
implementer's claim. The trigger is deliberately narrow: a single
deterministic check (one test run, `tsc`, lint) does not qualify. The
installed `packages/orchestrator-workflow/assets/agents/reviewer.md:39-44`
prompt carries the same rule verbatim (second-person voice). Both output
contracts gained a matching `reproduction` field
(`method, sample_size, result, matches_implementer_claim`,
`SKILL.md:247-251` and `reviewer.md:64-68`); `matches_implementer_claim`
accepts `not_applicable` for reviews where the narrow trigger never fires, so
a reviewer is not forced to fabricate a reproduction record for a
deterministic-only change.

Motivation, `packages/orchestrator-workflow/CHANGELOG.md:8-37` (0.14.0): the
agent-dx run `2026-07-18-harness-subprocess-test-deflake` accepted an
implementer's "8/8 green" flake-rate claim on a `maxWorkers` cap fix, then
the reviewer independently reran the full suite and found 2/6 red on an
independent 6-run sample (flake rate ~1/3, matching the pre-fix baseline) —
nothing in the prior contract had required that rerun, so the first pass
would have accepted the implementer's number as reported. This clause is a
docs/prompt-only change: no runtime code in this package depends on the new
field.

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
