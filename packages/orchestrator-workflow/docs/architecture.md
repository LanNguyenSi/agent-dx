# Architecture: why this shape

The orchestrator/subagent loop `orchestrator-workflow` installs, and the
reasoning behind it. See the [package README](../README.md) for installation
and day-to-day usage.

The diagram shows the operator, the orchestrator, the run directory it keeps
state in, and the five subagent roles of the default `full` profile with the
model each one gets by default on Claude Code and opencode.

```mermaid
flowchart TD
  OP["Operator"]
  EXP["explorer, sonnet<br/>optional, read-only<br/>terrain map"]
  ADV["advisor, opus<br/>optional, read-only<br/>recommends, never decides"]
  ORC["Orchestrator<br/>session model<br/>plans, validates slices,<br/>decides acceptance"]
  RUN[(".ai/runs/YYYY-MM-DD-slug/<br/>00-goal ... 06-handoff<br/>state in files, not chat")]
  TS["task-slicer, sonnet<br/>small, testable slices"]
  IMP["implementer, sonnet<br/>one narrow task, plus tests"]
  REV["reviewer, opus<br/>skeptical, severity-rated<br/>findings, no rewrites"]

  OP -->|goal| ORC
  ORC -->|handoff| OP
  EXP <-.->|"goal, solution or<br/>terrain unclear"| ORC
  ADV <-.->|"escalation only"| ORC
  ORC <--> RUN
  ORC <-->|"contract / YAML evidence"| TS
  ORC <-->|"contract / YAML evidence"| IMP
  ORC <-->|"contract / YAML evidence"| REV
```

The `minimal` profile installs only the implementer and the reviewer. The
advisor is consulted only at escalation triggers and returns a recommendation;
the orchestrator still decides (see
[Role profile reference](role-profile-reference.md)). The model names shown
are the Claude Code and opencode defaults; Codex routes the same roles through
the table in [Model routing reference](model-routing-reference.md#codex-defaults).

Two effects fall out of this shape:

- **Token efficiency.** The orchestrator's context stays small: subagents
  receive narrow task contracts instead of the whole conversation, return
  structured YAML evidence instead of transcripts, and durable state lives
  in run files that survive context compaction. The cheap models do the
  volume work; the strongest model is spent only on orchestration decisions
  and the skeptical review. The ceremony scales to the task: a trivial change
  is done directly, the full flow is for non-trivial work, and a read-only
  explorer maps the terrain first only when the solution is unclear. When
  available, the explorer prefers each of a repo's configured knowledge
  bundles (`knowledge` in `.ai/workflow/manifest.json`; default `docs/okf/`)
  or a connected semantic code-search tool over hand-mapping terrain with
  grep.
- **Quality through structure.** Writing and reviewing are separated by
  role and model, task slices are validated before any implementation
  starts, acceptance is decided on evidence (tests executed, findings
  addressed), and every run leaves an auditable trail in `.ai/runs/`.
