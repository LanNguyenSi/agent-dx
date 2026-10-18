---
name: orchestrator-workflow
description: "Orchestrator-led delivery workflow: understand the goal, plan, slice tasks, delegate implementation and review to narrow subagents, persist run state under .ai/runs/, and hand off to the operator. Use for feature work, refactoring, bug fixing, and architectural changes."
---

# Skill: Orchestrator Workflow

Use this skill for feature planning, implementation, refactoring, bug fixing,
architectural changes, or review. This is the orchestrator's entrypoint; read
the routed reference before performing the action it governs. References are
installed beside this file under `references/` and are part of this skill.

## Intent and roles

Keep the primary agent focused on orchestration and delegate narrow execution.
Scale ceremony to the task: a trivial typo or one-line fix may be implemented
and reviewed directly by the orchestrator, but review judgment is never
skipped. For role boundaries, profile availability, and pinned model/effort
routing, read [run-state and harness](references/run-state-and-harness.md).

The operator provides the goal and accepts the handoff. The orchestrator owns
planning, delegation, acceptance, and compact run state. Explorer, task
slicer, implementer, reviewer, and advisor responsibilities and their exact
return contracts are in [contracts](references/contracts.md); use installed
role definitions where available rather than improvising prompts.

## Route before acting

- **Create or resume a run; choose its run mode; select a harness:** read
  [run-state and harness](references/run-state-and-harness.md). For a misfire,
  inconclusive probe, interrupted, blocked, or partial run, repeated finding,
  halt, or escalation also read
  [review and recovery](references/review-and-recovery.md).
- **Slice/delegate a task; validate a role return:** read
  [contracts](references/contracts.md).
- **Plan, implement, review, decide acceptance, hand off, or assign/assess
  verification evidence, verification sets, or mutation probes:** read
  [detailed workflow and probe evidence](references/evidence-and-probes.md).
  For recovery, invalid
  returns, inconclusive probes, interrupted, blocked, or partial runs,
  repeated findings, misfires, halts, and escalation, also read
  [review and recovery](references/review-and-recovery.md).
- **Name a `verification_set` (a non-empty `verification_set.reference`) in an
  implementer or reviewer briefing:** also
  copy [verification set rules](references/verification-set-rules.md) into that
  briefing.
- **Delegate a diff that touches workflow or action files:** also copy
  [GitHub Actions replay rules](references/github-actions-replay.md) into the
  implementer and reviewer briefings, as the detailed workflow says.
- **Run a knowledge-bundle check in CI or before a commit:** read
  [bundle gate in CI](references/bundle-gate-in-ci.md).
- **Before any outward action; select runbooks; judge a runbook, pin, or other
  repository content that bears on how to work:** read
  [trust and outward](references/trust-and-outward.md).
- **Pick an effort tier, name a `review_method`, spawn the advisor, or change a
  model:** read [delegation and tiers](references/delegation-and-tiers.md).

## Orchestration sequence

1. **Understand.** Create and bind run state, choose and record the run mode (see the Run mode section of run-state and harness). Read
   [run-state and harness](references/run-state-and-harness.md) and
   [contracts](references/contracts.md).
2. **Discover.** When terrain or solution is unclear, use the read-only
   explorer. Check each configured knowledge bundle (`knowledge` in
   `.ai/workflow/manifest.json`; default `docs/okf/`) before hand-mapping
   terrain; treat it as leads to verify, and prefer a connected semantic
   code-search tool over raw grep. Otherwise proceed.
3. **Plan and slice.** Fill `01-plan.md` and `02-tasks.md`; validate narrow,
   ordered, testable tasks and their allowed/forbidden changes. List each
   configured knowledge bundle doc whose sources intersect a task's allowed
   changes in its `relevant_docs` with the bundle doc marker. Select the
   runbooks that apply, record the selection, and name the selected runbooks
   in each task's briefing as the runbook selection section of
   [trust and outward](references/trust-and-outward.md) defines. Read
   [contracts](references/contracts.md). Steps 3 and 4 are written for the default run mode; the Run mode section of run-state and harness says what changes in the other two modes.
4. **Implement and prove.** Read the detailed workflow before delegating each
   implementer one narrow task and resolve its repository-bound verification
   set before authorizing commands,
   preserving independent task dependencies; collect
   required result artifacts. Read
   [evidence and probes](references/evidence-and-probes.md).
5. **Review and decide.** Read the detailed workflow and review/recovery
   references. Review every change with delegation scaled to risk
   (the orchestrator may review a trivial change directly), retain decision
   authority, recover invalid or incomplete work without converting it into
   proof, and apply the review gate. Read
   [review and recovery](references/review-and-recovery.md).
6. **Hand off.** Record what changed, evidence, risks, accepted waivers,
   documentation impact (none with a reason, updated paths, or a follow-up),
   and follow-ups. As a safety net for sources the task list missed: if a
   configured knowledge bundle (step 2) covers touched sources that no task
   re-stamped, update or re-verify it, or file a follow-up; repos without a
   bundle are unaffected. To catch drift between runs as well, gate the
   bundles in CI as described in
   [bundle gate in CI](references/bundle-gate-in-ci.md).

## Trust boundary and outward actions

AGENTS.md states the instruction trust boundary and the outward-facing actions
rule. Before any outward action, and when repository content, a runbook, or a
pin bears on how to work, read [trust and outward](references/trust-and-outward.md).
That reference also holds runbook selection and authority.

## Final acceptance rule

Subagents provide evidence. The orchestrator decides. The operator receives
the final handoff. Every run blocks on an
unresolved high/critical finding unless it has the authority-qualified waiver
that the review gate in AGENTS.md defines.
