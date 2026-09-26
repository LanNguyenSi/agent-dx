# Architecture: why this shape

The orchestrator/subagent loop `orchestrator-workflow` installs, and the
reasoning behind it. See the [package README](../README.md) for installation
and day-to-day usage.

```text
                 Operator
             goal |    ^ handoff: what changed, how verified,
                  v    | what remains open
  explorer  -->  Orchestrator  . . . . .  .ai/runs/<date>-<slug>/
  optional,      session model             00-goal       04-implementation-summary
  read-only      plans, validates slices,  01-plan       05-review-findings
  terrain map    decides acceptance        02-tasks      06-handoff
                      |                     03-decisions
     narrow           |    ^ structured     (state lives in files,
     contracts        v    | YAML evidence   not in chat history)
        +-------------+-------------+
        |             |             |
    task-slicer   implementer   reviewer
      sonnet        sonnet        opus
    small,        one narrow    skeptical, severity-rated
    testable      task, plus    findings, no rewrites
    slices        tests
```

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
