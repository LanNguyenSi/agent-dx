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
  explorer maps the terrain first only when the solution is unclear.
- **Quality through structure.** Writing and reviewing are separated by
  role and model, task slices are validated before any implementation
  starts, acceptance is decided on evidence (tests executed, findings
  addressed), and every run leaves an auditable trail in `.ai/runs/`.

## Install

```bash
npx orchestrator-workflow init
```

Run it at the root of the target repository: **without a directory argument,
files are created in the current working directory.** The CLI prints the
resolved target (`Installing into ...`) before it writes anything and warns
when the target is not a git repository root; pass `init <dir>` to install
into a different directory. The installer is interactive by default: it
locates existing harness configs (`.claude/`, `CLAUDE.md`, `.opencode/`,
`opencode.json`, `.agents/`, `.codex/`), preselects what it found, and asks
which model each subagent role should use.

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
| Claude Code | `.claude/skills/orchestrator-workflow/SKILL.md`, `.claude/agents/{explorer,task-slicer,implementer,reviewer}.md`, `CLAUDE.md` | Claude Code reads `CLAUDE.md`, not `AGENTS.md`; the installer adds an additive `@AGENTS.md` import. Subagent models go into the `model:` frontmatter; the read-only explorer also gets `disallowedTools: Edit, Write, NotebookEdit`. |
| OpenAI Codex | `.agents/skills/orchestrator-workflow/SKILL.md` | Codex reads `AGENTS.md` natively. There is no standardized project-level subagent definition; the skill instructs running the roles inline with the same contracts. |
| opencode | `.opencode/skills/orchestrator-workflow/SKILL.md`, `.opencode/agents/{explorer,task-slicer,implementer,reviewer}.md` | opencode reads `AGENTS.md` natively. Subagents get `mode: subagent`; the explorer also gets `permission: edit: deny`. Model resolution is described below. |

## Model preselection

Each subagent role gets a model, chosen interactively or via `--models`:

| Role | Default | Why |
|---|---|---|
| explorer | `sonnet` | read-only terrain mapping is broad reading, not deep reasoning |
| task-slicer | `sonnet` | structured decomposition, no deep reasoning needed |
| implementer | `sonnet` | fast, cheap, good enough for narrow pre-sliced tasks |
| reviewer | `opus` | skeptical review benefits from the strongest model |

The orchestrator itself runs on the session's main model; use the strongest
reasoning model available. The chosen mapping is recorded in
`.ai/workflow/manifest.json` and reused as the default on later re-runs.

**opencode model resolution.** opencode requires fully-qualified `provider/model-id`
strings (e.g. `github-copilot/claude-sonnet-4.6`). At install time the CLI
runs `opencode models` to fetch the live catalog and auto-detects which
provider to use (the one that offers Claude models). When exactly one such
provider exists the aliases are resolved to the highest-version matching id in
the catalog. When multiple providers offer Claude models the CLI warns and asks
you to pass `--opencode-provider <id>` to disambiguate, or to supply
fully-qualified ids per role via `--models`. If no resolution is possible
(catalog empty, `opencode` binary absent, ambiguous provider) the `model:`
frontmatter line is omitted entirely and the subagent inherits the
session/default model — a safe, portable fallback. Fully-qualified ids in
`--models` always pass through unchanged regardless of the catalog.
Nested-path providers like `openrouter` (whose ids look like
`openrouter/anthropic/claude-...`) are not auto-resolved from aliases and must
be supplied as a fully-qualified `--models` entry, e.g.
`reviewer=openrouter/anthropic/claude-opus-4.8`.

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

## Uninstall

```bash
npx orchestrator-workflow uninstall
```

Removes exactly what `init` created, driven by the manifest's file hashes:
unedited kit files are deleted, locally edited ones are kept and reported
(`--force` removes those too). The AGENTS.md section and the CLAUDE.md
import line are taken out; either file is deleted only when nothing but
init's own boilerplate remains. Kit directories are pruned only when empty,
and run history under `.ai/runs/` is always kept. Interactive runs ask for
confirmation; non-interactive runs require `--yes`.

## Relation to agentic-coding-playbook

This kit ships the orchestration layer: who coordinates whom, where state
lives, and the I/O contracts between roles. The extended role prompts and the
organizational guidance (when to use agents at all, review depth, risk tiers)
live in the sibling package
[agentic-coding-playbook](../agentic-coding-playbook), which the skill
references.
