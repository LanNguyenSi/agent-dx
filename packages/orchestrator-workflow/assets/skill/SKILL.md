---
name: orchestrator-workflow
description: "Orchestrator-led delivery workflow: understand the goal, plan, slice tasks, delegate implementation and review to narrow subagents, persist run state under .ai/runs/, and hand off to the operator. Use for feature work, refactoring, bug fixing, and architectural changes."
---

# Skill: Orchestrator Workflow

Use this skill when the operator asks for feature planning, implementation,
refactoring, bug fixing, architectural changes, or review.

## Intent

Keep the main agent focused on orchestration while delegating narrow execution
tasks to specialized subagents. The goal is to improve quality, reduce
context-window pressure, and keep the operator informed through structured
handoffs.

Scale the ceremony to the task. The workflow below is the default for
non-trivial work; a trivial change (a typo, a one-line fix) may be done
directly by the orchestrator and reviewed by it, without slicing or spawning
subagents. Review judgment still applies to every change; only the size of
the apparatus changes.

## Roles

- **Operator**: the human requester. Provides goal and constraints, approves or
  redirects when needed, receives the final handoff.
- **Orchestrator**: the primary agent (you). Understands the goal, plans,
  validates task slices, assigns implementation and review, decides acceptance,
  reports back. The orchestrator must not become a passive transcript
  collector; it maintains compact run state.
- **Task slicer** (optional): breaks a large change into small, testable tasks
  with dependencies and risk markers.
- **Implementer**: implements exactly one narrow task, touches only relevant
  files, adds or updates tests, returns structured evidence.
- **Reviewer**: skeptical technical review against goal, spec, architecture,
  tests, security, and edge cases. Classifies severity, recommends fixes,
  avoids unsolicited rewrites.

Where the harness supports subagent definitions, the slicer, implementer, and
reviewer roles are installed as named subagents (Claude Code:
`.claude/agents/`, opencode: `.opencode/agents/`) with preselected models.
Spawn those instead of improvising role prompts. Extended role prompts live in
the [agentic-coding-playbook skills](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/agentic-coding-playbook/skills).

## Run state

All state for one unit of work lives in a run directory:

```text
.ai/runs/YYYY-MM-DD-<slug>/
  00-goal.md
  01-plan.md
  02-tasks.md
  03-decisions.md
  04-implementation-summary.md
  05-review-findings.md
  06-handoff.md
```

Create it at the start of a run by copying `.ai/workflow/templates/` and fill
the files as the run progresses. The newest run directory is the active one;
older directories are the auditable history. Do not edit past runs.

## Workflow

For a non-trivial change, run the full flow below. For a trivial change, do
the work directly, review it, and still leave a short handoff; skip the run
directory and the subagents.

1. **Understand the goal.** Create the run directory and fill `00-goal.md`:
   operator request, goal, non-goals, constraints, assumptions, open questions.
   If the task can proceed on reasonable assumptions, proceed without blocking.
2. **Plan.** Fill `01-plan.md`: approach, affected areas, risks, test strategy,
   rollback considerations where relevant.
3. **Slice tasks.** For non-trivial changes, fill `02-tasks.md`. Delegate to
   the task-slicer subagent when the change is large enough to benefit. Each
   task carries: id, goal, relevant files, acceptance criteria, constraints,
   suggested tests, dependencies, risk.
4. **Validate tasks.** Check the slices are independently understandable, small
   enough, testable, ordered correctly, and aligned with the goal. Fix the
   slicing before any implementation starts.
5. **Delegate implementation.** Send each implementer subagent one narrow task
   contract (format below). Record meaningful decisions in `03-decisions.md`
   and consolidate evidence in `04-implementation-summary.md`.
6. **Delegate review.** Send the diff to the reviewer subagent. The reviewer
   checks spec compliance, architecture consistency, edge cases, security,
   test adequacy (including whether new tests would fail if the change were
   reverted), and maintainability. Findings go to `05-review-findings.md`.
7. **Decide acceptance.** Accept, request fixes, defer a known issue, or
   escalate to the operator. Record the decision in `03-decisions.md`.
8. **Hand off.** Fill `06-handoff.md` and report to the operator: what changed,
   why, how it was verified, known risks, suggested next step.

## Subagent input contract

```yaml
role: implementer | reviewer | task_slicer
task_id: T-000
goal: ""
context:
  relevant_files: []
  relevant_docs: []
constraints:
  - ""
acceptance_criteria:
  - ""
allowed_changes:
  - ""
forbidden_changes:
  - ""
expected_output:
  format: structured
```

## Implementer output contract

```yaml
status: done | partial | blocked
role: implementer
task_id: T-000
summary:
  - ""
changed_files:
  - path: ""
    reason: ""
tests:
  executed:
    - ""
  added_or_updated:
    - ""
  not_executed_reason: ""
risks:
  - severity: low | medium | high
    description: ""
open_questions:
  - ""
recommendation: accept | review | fix_required
```

## Reviewer output contract

```yaml
status: reviewed
role: reviewer
task_id: T-000
summary:
  - ""
findings:
  - severity: low | medium | high | critical
    category: correctness | architecture | security | tests | maintainability | performance | docs
    description: ""
    suggested_fix: ""
acceptance_recommendation: accept | accept_with_notes | fix_required | reject
missing_tests:
  - ""
residual_risks:
  - ""
```

## Task slicer output contract

```yaml
status: done | partial | blocked
role: task_slicer
summary:
  - ""
tasks:
  - id: T-001
    title: ""
    goal: ""
    relevant_files:
      - ""
    acceptance_criteria:
      - ""
    dependencies:
      - ""
    risk: low | medium | high
recommended_order:
  - T-001
open_questions:
  - ""
```

## Context budget rules

- Prefer file summaries over full file dumps.
- Prefer diffs over complete rewritten files when reviewing.
- Prefer task-local context over repository-wide context.
- Persist decisions and state in run files.
- Do not include private reasoning transcripts in handoffs.
- Do not let subagents spawn other subagents.

## Harness notes

- **Claude Code**: spawn the installed `.claude/agents/` subagents
  (task-slicer, implementer, reviewer) via the native subagent mechanism.
- **opencode**: invoke the installed `.opencode/agents/` subagents
  (`mode: subagent`).
- **OpenAI Codex**: there is no standardized project-level subagent definition
  to install. Run the roles inline and sequentially with the same contracts,
  and still produce the same run files.

## Final acceptance rule

Subagents provide evidence. The orchestrator decides. The operator receives
the final handoff.
