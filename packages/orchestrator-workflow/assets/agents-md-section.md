<!-- orchestrator-workflow:begin -->
## Agentic Coding Workflow

This repository uses an orchestrator-led agent workflow, installed and updated by
[orchestrator-workflow](https://github.com/LanNguyenSi/agent-dx/tree/master/packages/orchestrator-workflow).

The primary agent acts as the orchestrator. It owns the goal, planning, task
validation, delegation, final acceptance, and the operator handoff. Non-trivial
implementation and review are delegated to narrow subagents. The full procedure
and the subagent I/O contracts live in the `orchestrator-workflow` skill.

### Core rules

- Only the orchestrator spawns or coordinates subagents. Subagents never spawn
  further subagents.
- When the goal, the solution, or the terrain is unclear, the orchestrator may
  send a read-only explorer subagent to map the terrain before planning. The
  explorer reads and reports; it never changes files.
- The orchestrator plans features itself. It may delegate task slicing, but it
  validates the sliced tasks before implementation starts.
- Non-trivial implementation goes to narrow implementer subagents, one task
  per subagent.
- Non-trivial review goes to a separate reviewer subagent (see Scaling
  delegation). Review itself is never skipped, not even for docs or batch
  changes.
- Final acceptance and the final answer to the operator stay with the
  orchestrator.

### Scaling delegation

The orchestrator matches the ceremony to the task; the full flow is a
default, not a ritual.

- A trivial change (a typo, a one-line fix, a rename) may be implemented by
  the orchestrator directly, without discovery, slicing, or an implementer
  subagent.
- Discovery (the read-only explorer) is for unfamiliar terrain or an unclear
  solution; skip it when the change is well understood.
- Slicing and implementer subagents are for non-trivial work: multiple files,
  real logic, or anything that benefits from decomposition or a fresh context.
- Review judgment applies to every change. For a trivial change the
  orchestrator may review it itself; reserve the reviewer subagent for
  changes whose risk or size warrants an independent skeptical pass. Either
  way, review is never skipped.

### Context discipline

- Prefer task-local context over repository-wide context.
- Pass only relevant files, constraints, and acceptance criteria to subagents.
- Subagents return structured summaries, never long reasoning transcripts.
- The orchestrator summarizes subagent outputs before adding them to its own
  context.
- Persist decisions and state in run files instead of relying on chat history.

### Run state

Workflow state lives under `.ai/`:

- `.ai/workflow/templates/` holds the canonical file templates
  (`00-goal.md` through `06-handoff.md`).
- Each unit of work gets a run directory `.ai/runs/YYYY-MM-DD-<slug>/`,
  created by copying the templates. The newest run directory is the active
  one; older ones are the auditable history.
- `.ai/workflow/manifest.json` records the installed kit version, the chosen
  harnesses, and the per-role model preferences.

### Models

- The orchestrator runs on the session's main model. Use the strongest
  reasoning model available.
- Per-role model preferences (explorer, task slicer, implementer, reviewer) are
  recorded in `.ai/workflow/manifest.json` and, where the harness supports
  per-agent models, in the subagent definitions themselves.

### Definition of done

A task is done only when:

- the requested change is implemented and the acceptance criteria are
  satisfied,
- relevant tests were added or updated where appropriate, and existing tests
  were executed or the gap is documented with a reason,
- the reviewer findings were addressed or consciously accepted by the
  orchestrator,
- the operator handoff describes what changed, how it was verified, and what
  remains open.
<!-- orchestrator-workflow:end -->
