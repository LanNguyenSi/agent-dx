# orchestrator-workflow

Installs an orchestrator-led agent workflow into any repository: one `.ai/`
directory for run state, one marker-fenced policy section in `AGENTS.md`, and
subagent definitions with preselected models for the harnesses you actually
use (Claude Code, OpenAI Codex, opencode).

The workflow itself: the primary agent acts as the orchestrator. It owns goal,
plan, task validation, acceptance, and the operator handoff. Implementation
and review are delegated to narrow subagents that return structured YAML
evidence. Every unit of work leaves an auditable run directory behind.

## Why this shape

```text
              Operator
          goal |    ^ handoff: what changed, how verified,
               v    | what remains open
          Orchestrator  . . . . . . .  .ai/runs/<date>-<slug>/
          session model                  00-goal      04-impl-summary
          plans, validates slices,       01-plan      05-review-findings
          decides acceptance             02-tasks     06-handoff
               |                         03-decisions
    narrow     |     ^ structured        (state lives in files,
    contracts  v     | YAML evidence      not in chat history)
      +--------------+--------------+
      |              |              |
  task-slicer    implementer    reviewer
    sonnet         sonnet         opus
  small testable one narrow     skeptical, severity-rated
  slices         task + tests   findings, no rewrites
```

Two effects fall out of this shape:

- **Token efficiency.** The orchestrator's context stays small: subagents
  receive narrow task contracts instead of the whole conversation, return
  structured YAML evidence instead of transcripts, and durable state lives
  in run files that survive context compaction. The cheap models do the
  volume work; the strongest model is spent only on orchestration decisions
  and the skeptical review.
- **Quality through structure.** Writing and reviewing are separated by
  role and model, task slices are validated before any implementation
  starts, acceptance is decided on evidence (tests executed, findings
  addressed), and every run leaves an auditable trail in `.ai/runs/`.

## Install

```bash
npx orchestrator-workflow init
```

Run it at the root of the target repository. The installer is interactive by
default: it locates existing harness configs (`.claude/`, `CLAUDE.md`,
`.opencode/`, `opencode.json`, `.agents/`, `.codex/`), preselects what it
found, and asks which model each subagent role should use.

Non-interactive:

```bash
npx orchestrator-workflow init --yes
npx orchestrator-workflow init --harness claude,codex,opencode --models "implementer=sonnet,reviewer=opus" --yes
```

To let a coding agent do the install, give it this single line:

```text
Follow the install instructions at https://raw.githubusercontent.com/LanNguyenSi/agent-dx/master/packages/orchestrator-workflow/INSTALL-AGENT.md
```

The agent then asks you the harness and model questions in chat and runs the
non-interactive CLI (manual scaffolding where npx is unavailable).
[INSTALL-AGENT.md](INSTALL-AGENT.md) documents, step by step, what the
linked instructions make the agent do and which files it may touch, so the
prompt can be audited before delegating. The link tracks `master`; pin it
to a commit SHA for a stable audit.

## What gets installed

```text
.ai/
  workflow/
    templates/        00-goal.md ... 06-handoff.md (canonical run templates)
    manifest.json     kit version, chosen harnesses, per-role models
  runs/               one directory per unit of work, newest = active
AGENTS.md             marker-fenced "Agentic Coding Workflow" policy section
```

Per selected harness:

| Harness | Files | Notes |
|---|---|---|
| Claude Code | `.claude/skills/orchestrator-workflow/SKILL.md`, `.claude/agents/{task-slicer,implementer,reviewer}.md`, `CLAUDE.md` | Claude Code reads `CLAUDE.md`, not `AGENTS.md`; the installer adds an additive `@AGENTS.md` import. Subagent models go into the `model:` frontmatter. |
| OpenAI Codex | `.agents/skills/orchestrator-workflow/SKILL.md` | Codex reads `AGENTS.md` natively. There is no standardized project-level subagent definition; the skill instructs running the roles inline with the same contracts. |
| opencode | `.opencode/agents/{task-slicer,implementer,reviewer}.md` | opencode reads `AGENTS.md` natively and cross-discovers `.claude/skills/`. Subagents get `mode: subagent` plus a fully qualified `provider/model-id`. |

## Model preselection

Each subagent role gets a model, chosen interactively or via `--models`:

| Role | Default | Why |
|---|---|---|
| task-slicer | `sonnet` | structured decomposition, no deep reasoning needed |
| implementer | `sonnet` | fast, cheap, good enough for narrow pre-sliced tasks |
| reviewer | `opus` | skeptical review benefits from the strongest model |

The orchestrator itself runs on the session's main model; use the strongest
reasoning model available. Aliases (`sonnet`, `opus`, `haiku`) map to fully
qualified ids for opencode (for example `anthropic/claude-opus-4-8`). Custom
ids pass through as given for Claude Code; for opencode, a bare id without a
provider prefix gets `anthropic/` prepended. The chosen mapping is recorded
in `.ai/workflow/manifest.json` and reused as the default on later re-runs.

## Ownership and re-runs

`init` is idempotent: a second run changes nothing. The rules:

- `AGENTS.md` and `CLAUDE.md` belong to you. The installer only appends its
  fenced section or the import line, and on re-run replaces only the content
  between its own markers. A broken or duplicated marker fence is reported as
  a conflict and left alone.
- Templates, skills, and subagent definitions are kit-owned. The manifest
  records a hash of each file as installed, so a re-run after a kit upgrade
  updates files you never touched and reports files you edited as conflicts
  instead of overwriting them; `--force` overwrites those too.
- `.ai/workflow/manifest.json` is the kit's state file. It records the applied
  version, harnesses, models, and file hashes, and is rewritten whenever that
  state changes; do not edit it by hand.

## Relation to agentic-coding-playbook

This kit ships the orchestration layer: who coordinates whom, where state
lives, and the I/O contracts between roles. The extended role prompts and the
organizational guidance (when to use agents at all, review depth, risk tiers)
live in the sibling package
[agentic-coding-playbook](../agentic-coding-playbook), which the skill
references.
