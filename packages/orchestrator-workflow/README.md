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
  explorer maps the terrain first only when the solution is unclear. When
  available, the explorer prefers a repo's curated knowledge bundle (for
  example a `docs/okf/` directory) or a connected semantic code-search tool
  over hand-mapping terrain with grep.
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
npx orchestrator-workflow init --profile minimal --yes
```

**Templates-only mode.** `--harness none` (the literal word `none`, on its
own) installs only `.ai/workflow/**` and `.ai/runs/.gitkeep`: no
`AGENTS.md`, no `CLAUDE.md`, no harness-specific directory, and a manifest
recording `harnesses: []`. Use it for a repo that wants the run-state
templates and the workflow itself, but no per-harness subagent files yet
(e.g. no harness has been chosen, or the files were dropped by hand).
`none` combined with a real harness name (`--harness none,claude`) is
rejected as ambiguous rather than silently picking one. A plain
**non-interactive** re-run (no `--harness` flag) after a templates-only
install stays templates-only, for `init` and `apply` alike, even when
`apply`'s own operator-defaults name a harness or the target has harness
files on disk from something else; add a harness back with an explicit
`--harness <list>` on a later run, the same explicit-flag-wins rule
`--profile`/`--models`/`--tiers` use, applied to the no-harness case. An
**interactive** re-run is different: it still prompts, with nothing forced
pre-selected, instead of silently skipping straight back to templates-only
without asking; deselect every checkbox to stay templates-only.

```bash
npx orchestrator-workflow init --harness none --yes
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
    manifest.json     kit version, chosen harnesses, role profile, per-role models
  runs/               one directory per unit of work, newest = active
AGENTS.md             marker-fenced "Agentic Coding Workflow" policy section
```

The orchestrator writes a `.ai/run` pointer file in every worktree a run
touches (a machine-local absolute path, not written by the installer); add
it to the repository's `.gitignore`.

Per selected harness:

| Harness | Files | Notes |
|---|---|---|
| Claude Code | `.claude/skills/orchestrator-workflow/SKILL.md`, `.claude/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md`, `CLAUDE.md` | Claude Code reads `CLAUDE.md`, not `AGENTS.md`; the installer adds an additive `@AGENTS.md` import. Subagent models go into the `model:` frontmatter; the read-only explorer, reviewer, and advisor also get `disallowedTools: Edit, Write, NotebookEdit`. |
| OpenAI Codex | `.agents/skills/orchestrator-workflow/SKILL.md` | Codex reads `AGENTS.md` natively. There is no standardized project-level subagent definition; the skill instructs running the roles inline with the same contracts. |
| opencode | `.opencode/skills/orchestrator-workflow/SKILL.md`, `.opencode/agents/{explorer,task-slicer,implementer,reviewer,advisor}.md` | opencode reads `AGENTS.md` natively. Subagents get `mode: subagent`; the read-only explorer, reviewer, and advisor also get `permission: edit: deny`. Model resolution is described below. |

**Read-only posture, honestly stated.** For the explorer, reviewer, and
advisor the read-only posture is enforced at the tool level only for the
file-mutation tools (`disallowedTools: Edit, Write, NotebookEdit` on Claude
Code, `permission: edit: deny` on opencode). Bash stays available because
these roles must run tests and linters, so shell-level mutation (`git checkout`,
`git restore`, `git clean`, `git stash`, `git reset`, `sed -i`, redirecting
output into a file) is guarded by instruction only: the agent prompts forbid
it explicitly, but nothing technically prevents it. This residual has bitten in practice (a
reviewer ran `git checkout` and discarded uncommitted work), which is why the
prompts now name the forbidden commands instead of just saying "read-only".
Marker- or verdict-style enforcement of the Bash residual (sandboxing,
PreToolUse hooks) is harness territory and out of this kit's scope.

## Role profile

`--profile` selects which subagent roles get installed (Claude Code and
opencode only; Codex has no per-role files to select from):

| Profile | Roles installed | When to use it |
|---|---|---|
| `full` (default) | explorer, task-slicer, implementer, reviewer, advisor | the full workflow: read-only discovery, task slicing, implementation, review, and escalation to an advisor when needed |
| `minimal` | implementer, reviewer | a small or well-understood repo where discovery, slicing, and escalation add ceremony without payoff |

The reviewer is never omitted from either profile: the Standing Rule "always
review" applies regardless of profile, so `minimal` is the write+check pair,
not "just implementer". There is no per-role checklist; the two profiles are
the only supported shapes.

**Advisor (escalation).** The fifth `full`-profile role, `advisor`, is
read-only and consulted only when the orchestrator hits one of a defined set
of triggers: architectural uncertainty, requirements that contradict each
other, multiple valid solution paths where committing to one is expensive to
reverse, repeated implementation failures on the same task, a review
deadlock, or a high-risk decision. It is not a standard pipeline step; like
tier choice, spawning it is the orchestrator's own judgment call. The advisor
lays out the options with their pros, cons, and risk, and gives a
recommendation — it recommends, never decides, and never writes code; the
orchestrator still decides, and a critical risk still goes to the operator.
`minimal` never installs it, the same as explorer and task-slicer.

```bash
npx orchestrator-workflow init --profile minimal --yes
```

Interactively (no `--yes`), the installer asks one additional question —
which profile to install — defaulting to `full`. `--profile` rejects any
value other than `minimal` or `full` with a clear error instead of silently
falling back to a default.

**Re-runs and profile changes.** A plain re-run (no `--profile` flag) keeps
the profile recorded in `.ai/workflow/manifest.json` from the previous
install, the same override-vs-persist rule already used for `--harness` and
`--models`. Passing `--profile` explicitly always overrides the recorded
value, immediately switching which per-role files the next run installs and
updating the manifest to match. Switching profiles follows the same
precedent already in place for dropping a harness from `--harness` on a
re-run: files for roles no longer in the profile are simply no longer
installed or tracked in the manifest; they are not automatically deleted
from disk. `init` detects a `full` → `minimal` downgrade and prints a note
naming the now-untracked `task-slicer.md` / `explorer.md` / `advisor.md`
agent files and how to remove them. For a fully clean switch, run `orchestrator-workflow
uninstall` first, or remove those files by hand. Uninstalling a `minimal`
install that has never been downgraded from `full` is always clean on its
own: it only ever removes what it actually installed, so there is nothing to
report as missing for the roles that were never written. A `minimal` install
reached via a `full` → `minimal` downgrade is not clean in that sense: the
downgrade's now-untracked `task-slicer.md` / `explorer.md` / `advisor.md`
files are not in the manifest's file ledger, so uninstall leaves them on disk
without reporting them at all.

## Model preselection

Each subagent role gets a model, chosen interactively or via `--models`:

| Role | Default | Why |
|---|---|---|
| explorer | `sonnet` | read-only terrain mapping is broad reading, not deep reasoning |
| task-slicer | `sonnet` | structured decomposition, no deep reasoning needed |
| implementer | `sonnet` | fast, cheap, good enough for narrow pre-sliced tasks |
| reviewer | `opus` | skeptical review benefits from the strongest model |
| advisor | `opus` | escalations happen precisely when the situation is hard, so it shares the reviewer's strongest-model default |

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

## Effort tiers

`--tiers` renders an additional per-role subagent definition for each
non-default effort tier, alongside the one default (unsuffixed) agent file
`--profile` already installs. Each tier variant is a standalone subagent
definition, not a modification of the default file: the default file
(`<role>.md`) stays byte-identical to what a tiers-off install already
produces, and each variant lives next to it as `<role>-<tier>.md`.

**Every default file carries its own pinned effort, independent of
`--tiers`.** Since 0.22.0, `composeClaudeAgent`/`composeOpencodeAgent` add
the role's own `TIER_DEFS[DEFAULT_TIER[role]].effort` to the default
(unsuffixed) file unconditionally: `effort: medium` for explorer,
task-slicer, and implementer; `effort: high` for reviewer and advisor
(opencode: a `variant: high` line when the resolved model is Claude-family,
following the same dispatch rule tier variants use, `reasoningEffort:
medium`/`reasoningEffort: high` for a non-Claude-family provider-qualified
model, nothing for Ollama, a provider-less id, or an unresolved model). This
pin does not depend on `tiers`, so a plain install (no `--tiers`) already
carries it; the flag only controls whether the additional `<role>-<tier>.md`
variant files are also rendered. The motivation: a default spawn used to
silently inherit the orchestrator session's own effort, so a `high`-effort
orchestrator session made every default subagent spawn at `high` too,
regardless of the role's own intended weight; the pin makes each role's
effort deterministic and independent of the caller's session. A `--tiers`-off
install (the default) has no variant files and therefore no in-install
escalation path off a default's pinned effort; run `init --tiers` afterward
if a task ever needs one.

Default off, like every optional pack in this kit: a fresh install renders
no variant files unless asked. `--tiers` turns the feature on for that run,
`--no-tiers` turns it off; a plain re-run with neither flag keeps whatever
the previous install had, the same override-vs-persist rule already used
for `--profile` and `--models`. There is no interactive prompt for it:
`tiers` is opt-in/off via the flags only.

```bash
npx orchestrator-workflow init --tiers --yes
```

Turning tiers back off with `--no-tiers` after having them on follows the
same pattern as a `full` → `minimal` profile downgrade: `init` prints a note
naming the now-untracked `<role>-<tier>.md` variant files and how to remove
them, rather than deleting them or leaving the leftover unexplained.

**Which tiers each role gets.** A role never gets a variant file for its own
default tier: that would collide with, and duplicate, the default file.

| Role | Tiers available | Default tier (no variant file) |
|---|---|---|
| explorer | low, medium, high | medium |
| task-slicer | low, medium, high | medium |
| implementer | low, medium, high, xhigh | medium |
| reviewer | medium, high, xhigh | high |
| advisor | high, xhigh | high |

With `--profile full` and every tier rendered, that is 5 default files plus
10 variant files: 15 files total per harness.

**Tier → model class → effort.** Each tier resolves to a model class and an
effort value:

| Tier | Model class | Model alias | Effort requested |
|---|---|---|---|
| low | small | `haiku` | `low` |
| medium | medium | `sonnet` | `medium` |
| high | medium | `sonnet` | `high` |
| xhigh | large | `opus` | `xhigh` |

Claude Code variants carry both a `model:` line (the class's alias) and an
`effort: <tier>` line in frontmatter. Read-only roles (explorer, reviewer,
advisor) keep `disallowedTools: Edit, Write, NotebookEdit` on their variants
too.

**opencode variants key off the resolved model's family, not its provider
prefix**, since opencode's effort surface is not uniform across model
families:

- **Claude-family models** (any resolved id whose provider is
  `anthropic/`, or whose segment after the provider prefix contains
  `claude-`, which covers `anthropic/claude-...` as well as a Claude model
  fronted by a different provider, e.g. `github-copilot/claude-sonnet-4.6`
  or the nested `openrouter/anthropic/claude-opus-4.8`): only `high` and
  `xhigh` get an effort field, as `variant: high` and `variant: max`
  respectively; `low` and `medium` collapse to no effort field at all,
  since opencode's `variant:` option does not distinguish an effort below
  `high`. This collapse is deliberate and documented, not a bug: a
  `low`/`medium` variant on a Claude-family model still gets its class's
  `model:` line, just no `variant:` line.
- **Ollama, or an id with no provider prefix**: no effort field at all.
  There is no known effort passthrough for Ollama, and an id with no `/`
  resolves to no provider to key the decision on.
- **Every other non-Claude-family model**: a plain `reasoningEffort: <tier>`
  line, `xhigh` included (opencode's built-in OpenAI-style variants
  document an `xhigh` reasoning effort).

The variant's `model:` line is resolved the same way the base per-role model
is (an `opencode models` catalog lookup against the auto-detected or
`--opencode-provider`-specified provider), just keyed by the tier's model
class instead of by role. When that lookup cannot resolve a model for a
class, the CLI warns once on stderr and **no variant file is rendered for
that class at all**, not a file with a missing `model:` line: a variant
with no resolved model would carry neither a `model:` nor an effort line, an
indistinguishable no-op duplicate of the base file with no ledger entry to
compare it against, so `init` skips writing it entirely. This guard and its
warning are opencode-scoped only; Claude Code variants resolve `model:` from
a plain alias (`haiku`/`sonnet`/`opus`) and need no live catalog lookup, so
they are unaffected.

**Warning: `CLAUDE_CODE_EFFORT_LEVEL` overrides every agent's frontmatter
`effort:`, tier variants included.** Claude Code's `effort:` frontmatter
field does work: it reaches the model request as `output_config.effort`.
But when the harness environment sets `CLAUDE_CODE_EFFORT_LEVEL`, that
environment variable wins over the frontmatter `effort:` on every installed
agent, tier variants and default files alike, not just the one this feature
adds. Check for it before relying on a specific tier variant's requested
effort actually taking effect.

The pin is also emitted unconditionally regardless of which model the role
resolves to via `--models`, including a model with no effort support at all
(e.g. `--models reviewer=haiku` still renders `model: haiku` followed by
`effort: high`). On Haiku 4.5, which does not support the `effort`
parameter, the harness ignores the pinned value rather than rejecting it
(anchored by a measurement, see CHANGELOG 0.23.0).

## Operator-level install

Alongside `init`, which installs the kit into one repository from that
repository's own working directory, an operator who maintains many
repositories can set defaults once and project them onto each target
instead of re-answering the same prompts per repo. This layer adds no new
binary: `setup`, `apply`, `doctor`, and `adopt` below are subcommands of the
same `orchestrator-workflow` CLI `init` and `uninstall` already ship as, and
`init`/`uninstall` remain fully supported and unchanged for a
single-repository install.

```bash
orchestrator-workflow setup --yes
orchestrator-workflow apply --target /path/to/repo
```

**`setup`** writes or updates this operator's default install options
(harnesses, profile, models, tiers) as the baseline for future installs; it
touches no repository. A flag always wins; a flag-less re-run keeps the
previously stored values; a first-ever `setup` falls back to `claude` /
`full` / the kit's default models / tiers off. `setup` takes the same
option flags as `init` (`--harness`, `--profile`, `--models`, `--tiers` /
`--no-tiers`, `--opencode-provider`, `--yes`). The defaults live in
`<operator home>/manifest.json`, where the operator home is
`~/.orchestrator-workflow/` unless the `ORCHESTRATOR_WORKFLOW_HOME`
environment variable names a different directory.

**`apply --target <repo>`** projects the operator's install onto a target
repository and registers that target, by its real resolved path, in the
operator manifest. It requires a prior `orchestrator-workflow setup`;
without one it exits `1` with "No operator setup found". Option resolution
follows one precedence order: an
explicit flag wins, then the target's own previously recorded settings,
then the operator's defaults (harnesses fall back one step further, to
what `init` would have auto-detected) -- except a target whose own
manifest recorded a real `harnesses: []` (a deliberate templates-only
install, see "Templates-only mode" above), which stays templates-only on
a flagless run regardless of the operator's defaults or what is on disk.
Pass `--sync` to invert that for
profile, tiers, and models: the operator's defaults then win over whatever
the target already had recorded. A target pinned to a kit version other
than the one being applied is skipped rather than touched (see the pin
rule below). `apply` also takes the same install options as `init` (`--harness`,
`--profile`, `--models`, `--tiers` / `--no-tiers`, `--opencode-provider`,
`--force`, `--yes`), which feed the precedence rule above.

**`doctor [--json] [--prune]`** reports every operator-registered target's
status: `clean`, `divergent` (from the operator defaults), `version-lag`,
`drift` (installed files edited, deleted, or unreadable since install),
`missing`, `no-manifest`, or `unverifiable`. It exits `2` when the operator
manifest is missing or unreadable, or, with `--prune`, when the operator
manifest lock cannot be acquired or the rewrite fails; `1` when any target
is `drift`, `missing`, `no-manifest`, or `unverifiable`; and `0` otherwise.
`--json` prints one JSON object instead
of human output, with one entry per target plus the operator home and
version. `--prune` removes `missing` and `no-manifest` targets from the
registry before reporting (never an `unverifiable` one, since that status
means the check itself was inconclusive, not that the target is confirmed
gone) and rewrites the manifest file in its normalized form.

**`adopt [dir] [--json]`** brings a repository that already has the kit installed,
by hand or by an earlier `init`, under the operator's management without
changing anything in that repository: it registers the repository
verbatim, using the repository's own recorded settings to bootstrap the
operator manifest when none exists yet, records the repository's own
installed version as its baseline, and prints that one target's `doctor`
report. It exits `1` only when the freshly adopted target itself reports
drift, and `2` for a precondition failure (no repo manifest, an unreadable
or foreign manifest, or a lock or write failure).

**The kit-version pin.** A repository's own manifest can additionally
carry an optional `pin`: a kit version that `apply` must match before it
will touch that repository again. `apply` skips (exit `0`) a target pinned
to a different version than the one being applied. `--pin <version>` sets
or replaces the pin and applies regardless of any existing one; `--unpin`
clears it and applies; `--force-pin` advances an existing pin that
differs, but has no effect on a target with no pin recorded (it stays
unpinned). `doctor` reports `version-lag` when the installed version
differs from the running kit version; on a pinned target the pin is
compared against the installed version instead, so a pin equal to the
installed version is `clean` and a pin that no longer matches it is
`version-lag`.

**The registry is implicit**, not a separate command: `apply` and `adopt`
register a target as a side effect of a real run, and `doctor --prune` is
how a registry entry is removed again; there is no bare register or
unregister command. The workspace root of a multi-repo checkout is treated
as an ordinary target, nothing special.

All writes to the operator manifest, by `setup`, `apply`, `doctor --prune`,
and `adopt` alike, go through one advisory lock in the operator home, so
concurrent orchestrator-workflow commands on the same machine cannot
corrupt each other's state.

## Ownership and re-runs

`init` is idempotent: a second run changes nothing. `apply` installs
through that same `runInit` path and is subject to the same
conflict/`--force`/ownership rules; on the repository side it changes
nothing either, but it refreshes this target's entry in the operator
manifest on every run. The rules:

- `AGENTS.md` and `CLAUDE.md` belong to you. The installer only appends its
  fenced section or the import line, and on re-run replaces only the content
  between its own markers. A broken or duplicated marker fence is reported as
  a conflict and left alone.
- Templates, skills, and subagent definitions are kit-owned. The manifest
  records a hash of each file as installed, so a re-run after a kit upgrade
  updates files you never touched and reports files you edited as conflicts
  instead of overwriting them; `--force` overwrites those too.
- `.ai/workflow/manifest.json` is the kit's state file. It records the applied
  version, harnesses, role profile, models, the `--tiers` flag, the optional
  kit-version pin, and file hashes, and is rewritten whenever that state
  changes; do not edit it by hand.

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
