# orchestrator-workflow

Installs an orchestrator-led agent workflow into any repository: one `.ai/`
directory for run state, one marker-fenced policy section in `AGENTS.md`,
and per-role subagent definitions with preselected models for the harnesses
you actually use (Claude Code, OpenAI Codex, opencode).

The primary agent acts as the orchestrator: it owns goal, plan, task
validation, acceptance, and the operator handoff. Review is always
delegated to narrow subagents, and by default so is implementation (see
[Run modes](#run-modes)); subagents return structured YAML evidence, not
transcripts, and every unit of work leaves an auditable run directory
behind. See [Architecture: why this shape](docs/architecture.md) for the
loop diagram and the reasoning, and [Run contracts](docs/run-contracts.md)
for the optional frozen acceptance-baseline contract and the
decision-authority record every run keeps.

## Key features

- Orchestrator-led workflow: one agent plans and decides; narrow subagents implement and review.
- Per-harness subagent definitions with preselected, pinned per-role models and effort (Claude Code, Codex, opencode).
- An auditable `.ai/runs/` directory per unit of work, with an optional frozen acceptance-baseline contract.
- Agent-led or manual CLI install, both idempotent and conflict-safe on re-run.
- Operator-level install for projecting routing and profile defaults onto many repositories.
- A `validate-review-report` CLI to structurally check reviewer YAML returns.

## Install

Requires Node.js >= 20.

### Recommended: agent-led installation

Give a coding agent this line:

```text
Follow the install instructions at https://raw.githubusercontent.com/LanNguyenSi/agent-dx/master/packages/orchestrator-workflow/INSTALL-AGENT.md
```

The agent inspects installed harnesses, reusable preferences, authorization,
and available model capabilities. It presents the exact CLI invocation and
routing diff, asks only about unresolved material decisions, applies the
authorized change, and verifies the supported dispatch path. Existing routing
is preserved unless you explicitly change it, and a newer model is never an
automatic upgrade. [INSTALL-AGENT.md](INSTALL-AGENT.md) makes the write surface
and fallback behavior auditable. The link tracks `master`; pin it to a commit
SHA for a stable audit.

The compact skill entrypoint and its routed references form one installed
bundle; see [Install reference](docs/install-reference.md) for what the
reinstall conflict check does.

### Manual and advanced CLI installation

```bash
npx orchestrator-workflow init
```

Run it at the root of the target repository: **without a directory argument,
files are created in the current working directory.** The CLI prints the
resolved target (`Installing into ...`) before it writes anything and warns
when the target is not a git repository root; pass `init <dir>` to install
into a different directory. The installer is interactive by default: it
locates existing harness configs (`.claude/`, `CLAUDE.md`, `.opencode/`,
`opencode.json`, `.agents/`, `.codex/`) and preselects what it found. For a
guided install, use the agent-led path above: the agent inspects the repository
and available harness capabilities, prepares the exact CLI invocation and
routing diff, and asks only about choices or authority it cannot infer safely.

Non-interactive:

```bash
npx orchestrator-workflow init --yes
npx orchestrator-workflow init --harness claude,codex,opencode --models "implementer=sonnet,reviewer=opus" --yes
npx orchestrator-workflow init --harness codex --routing ./routing.json --codex-catalog ./codex-models.json --tiers --yes
npx orchestrator-workflow init --profile minimal --yes
```

**Templates-only mode.** `--harness none` (the literal word `none`, on its
own) installs only `.ai/workflow/**` and `.ai/runs/.gitkeep`: no
`AGENTS.md`, no `CLAUDE.md`, no harness-specific directory, and a manifest
recording `harnesses: []`. `none` combined with a real harness name
(`--harness none,claude`) is rejected as ambiguous rather than silently
picking one.

```bash
npx orchestrator-workflow init --harness none --yes
```

See [Install reference](docs/install-reference.md) for the exact re-run
rules (a plain non-interactive re-run stays templates-only; an interactive
one still prompts).

## Verification sets

A repository may check in `.ai/workflow/verify.json` to name the complete
verification set (a preflight executor plus ordered extras) for an
implementer or reviewer briefing; the workflow itself never executes or
validates this file, only the orchestrator does, recording every result.
See [Verification sets](docs/verification-sets.md) for the worked JSON
example.

## What gets installed

```text
.ai/
  workflow/
    templates/        00-goal.md ... 06-handoff.md (canonical run templates)
    manifest.json     kit version, harnesses, profile, legacy models, exact routing
  runs/               one directory per unit of work, newest = active
AGENTS.md             marker-fenced "Agentic Coding Workflow" policy section
```

The orchestrator writes a `.ai/run` pointer file in every worktree a run
touches (a machine-local absolute path, not written by the installer); add
it to the repository's `.gitignore`.

`manifest.json` may also carry a `knowledge` list of `{ path, repoRoot }`
entries for a repo whose bundle is not at the default location; when
`knowledge` in `.ai/workflow/manifest.json` is absent or an empty list, the
default `docs/okf/` applies. See
[Install reference](docs/install-reference.md) for the field's exact path
rules and validation behavior.

Per selected harness, the installer writes the compact `SKILL.md` entrypoint,
its `references/` files, and one subagent definition per role
(`.claude/agents/`, `.codex/agents/`, or `.opencode/agents/`). Each harness's
read-only posture (explorer, reviewer, and advisor) is tool-level where the
harness supports it. Codex's reviewer inherits the caller's sandbox instead
(its prompt prohibits source edits, so temporary/build checks stay
possible), and wherever a sandbox is writable, shell-level mutation is
guarded by instruction only, not enforced. See [Harnesses](docs/harnesses.md)
for the exact per-harness file list and the honest read-only-posture
writeup, including the reviewer's own narrower write boundary.

## Role profile

`--profile` selects which subagent roles get installed for Claude Code, Codex,
and opencode:

| Profile | Roles installed | When to use it |
|---|---|---|
| `full` (default) | explorer, task-slicer, implementer, reviewer, advisor | the full workflow: read-only discovery, task slicing, implementation, review, and escalation to an advisor when needed |
| `minimal` | implementer, reviewer | a small or well-understood repo where discovery, slicing, and escalation add ceremony without payoff |

The reviewer is never omitted from either profile: the Standing Rule "always
review" applies regardless of profile, so `minimal` is the write+check pair,
not "just implementer". There is no per-role checklist; the two profiles are
the only supported shapes.

**Advisor (escalation).** The fifth `full`-profile role, `advisor`, is
read-only and consulted only at defined escalation triggers (architectural
uncertainty, a review deadlock, a high-risk decision, and similar); it
recommends, never decides. `minimal` never installs it, the same as explorer
and task-slicer. See [Role profile reference](docs/role-profile-reference.md)
for the full trigger list.

```bash
npx orchestrator-workflow init --profile minimal --yes
```

Interactively (no `--yes`), the installer asks one additional question —
which profile to install — defaulting to `full`. `--profile` rejects any
value other than `minimal` or `full` with a clear error instead of silently
falling back to a default.

**Re-runs and profile changes.** A plain re-run keeps the recorded profile;
`--profile` explicitly overrides it, and a `full` to `minimal` downgrade
leaves the now-untracked role files on disk with a printed note. See
[Role profile reference](docs/role-profile-reference.md) for the exact
override and uninstall-cleanliness rules.

## Model preselection

Routing is a harness-specific map from role and tier to a complete
`{model, effort}` selection, set with `--routing <json-file>` and deep-merged
into `.ai/workflow/manifest.json`; `--models` is the backward-compatible,
per-role input for Claude Code and opencode only (never Codex). Every
installed agent file carries its own pinned effort regardless of `--tiers`;
`--tiers` additionally renders one `<role>-<tier>.md`/`.toml` variant file
per non-default tier. See [Model routing reference](docs/model-routing-reference.md)
for the default-model table, the `--routing` JSON shape, the Codex default
routing table, opencode model resolution, and the full effort-tiers
mechanics (including the `CLAUDE_CODE_EFFORT_LEVEL` environment override).

### Effort tiers

The per-role default effort (`medium` for explorer, task-slicer, and
implementer; `high` for reviewer and advisor) is pinned in each agent file
on Claude Code and Codex; on opencode it depends on the resolved model.
See [Model routing reference: Effort tiers](docs/model-routing-reference.md#effort-tiers)
for the full role/tier table, the per-harness frontmatter shape, and the
tier variants `--tiers` renders.

## Run modes

Every run records a mode in `00-goal.md`: `single`, `delegated`, or `batch`.
`delegated` is the default and the flow this README describes. In `single`
the orchestrator implements one coherent workstream itself; `batch` runs
implementers in parallel worktrees. The reviewer is mandatory in all three modes.
The definitions, the rule for choosing a mode, and the run files each mode
requires are stated once, in the Run mode section of the installed skill
reference
[`run-state-and-harness.md`](assets/skill/references/run-state-and-harness.md).

## Operator-level install

An operator who maintains many repositories can set defaults once with
`setup` and project them onto each target with `apply --target <repo>`,
instead of re-answering the same `init` prompts per repo; `doctor` reports
each registered target's status and `adopt` brings an already-installed
repository under management without changing it. `init`/`uninstall` remain
fully supported and unchanged for a single-repository install. See
[Operator-level install](docs/operator-install.md) for the full command
reference (every flag, the `--sync` precedence inversion, the kit-version
pin, and the registry/locking model).

## Ownership and re-runs

`init` is idempotent: a second run changes nothing. `AGENTS.md`/`CLAUDE.md`
belong to you (the installer only touches its own fenced section or import
line); templates, skills, and subagent definitions are kit-owned and
conflict-checked by file hash; `.ai/workflow/manifest.json` is the kit's
state file. `apply` installs through the same path and is subject to the
same rules, refreshing this target's entry in the operator manifest on
every run. See [Install reference](docs/install-reference.md) for the
exact per-file ownership rules.

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

## Reviewer-report validation

```bash
orchestrator-workflow validate-review-report path/to/return.yaml
```

Checks a reviewer return's YAML against the reviewer output contract's
required fields and enums, structurally only (it never judges semantic
adequacy or waives a finding). See
[`validate-review-report` CLI reference](docs/validate-review-report.md) for
every flag, exit code, and fence-detection edge case.

## Documentation

- [Architecture: why this shape](docs/architecture.md): the orchestrator/subagent loop diagram and rationale.
- [Run contracts](docs/run-contracts.md): the acceptance-baseline contract and `03-decisions.md`'s decision-authority rules.
- [Install reference](docs/install-reference.md): the agent-led install's conflict check, templates-only re-run rules, and the `knowledge` manifest field.
- [Harnesses](docs/harnesses.md): the per-harness installed-file list and the honest read-only-posture writeup.
- [Verification sets](docs/verification-sets.md): the worked `.ai/workflow/verify.json` JSON example.
- [Role profile reference](docs/role-profile-reference.md): the advisor's escalation triggers and profile/tier re-run behavior.
- [Model routing reference](docs/model-routing-reference.md): the default-model table, the `--routing` JSON shape, the Codex default routing table, opencode model resolution, and the effort-tiers mechanics.
- [Operator-level install](docs/operator-install.md): the full `setup`/`apply`/`doctor`/`adopt` command reference.
- [`validate-review-report` CLI reference](docs/validate-review-report.md): every flag, exit code, and fence-detection edge case.
- [Curated knowledge bundle](docs/okf/index.md): the OKF-format reference docs for this package's own contracts and mechanics, at `docs/okf/`, the default location a repository falls back to when `knowledge` in `.ai/workflow/manifest.json` is unset.
- [agentic-coding-playbook](../agentic-coding-playbook): the extended role prompts and organizational guidance this kit's skill references.

## Development

This package lives in the [agent-dx](https://github.com/LanNguyenSi/agent-dx)
monorepo, alongside the sibling agentic-coding-playbook package (see
Documentation above). `npm test` (vitest) and `npm run typecheck` run from
`packages/orchestrator-workflow`; see the repository root's
`CONTRIBUTING.md` for the full contributor workflow, including the
"Releasing okf-kit" order (`test/docs-consistency.test.ts` pins the
`okf-kit@<version>` this repo's CI installs against the sibling
`packages/okf-kit` package's version).

## License

MIT.
