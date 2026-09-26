# orchestrator-workflow

Installs an orchestrator-led agent workflow into any repository: one `.ai/`
directory for run state, one marker-fenced policy section in `AGENTS.md`, and
subagent definitions with preselected models for the harnesses you actually
use (Claude Code, OpenAI Codex, opencode).

The workflow itself: the primary agent acts as the orchestrator. It owns goal,
plan, task validation, acceptance, and the operator handoff. Review is always delegated to narrow subagents, and by default so is
implementation (see [Run modes](#run-modes)); the subagents return structured YAML
evidence. Every unit of work leaves an auditable run directory behind.

Every unit of work runs under a frozen `00-goal.md` acceptance-baseline
contract and an authority-tracking `03-decisions.md`; see
[Run contracts](docs/run-contracts.md) for both. The orchestrator's own
context stays small by design: subagents get narrow task contracts and
return structured YAML evidence, not transcripts, while durable state lives
in run files under `.ai/runs/`; see
[Architecture: why this shape](docs/architecture.md) for the loop diagram
and the reasoning behind it.

## Install

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
verification set for an implementer or reviewer briefing: one preflight
executor plus ordered extras (build, package tests, a knowledge-bundle
check). The workflow itself never executes or validates this file; the
orchestrator approves the resolved config and records every result. See
[Verification sets](docs/verification-sets.md) for the worked JSON example.

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
entries, for a repo whose knowledge bundle is not at the default location (a
workspace-level bundle with sources in a sub-repo, a bundle elsewhere, or
several bundles); `doctor` reports an invalid or missing entry. When
`knowledge` in `.ai/workflow/manifest.json` is absent or an empty list, the
default `docs/okf/` applies. See
[Install reference](docs/install-reference.md) for the field's exact path
rules and validation behavior.

Per selected harness, the installer writes the compact `SKILL.md` entrypoint,
its `references/` files, and one subagent definition per role
(`.claude/agents/`, `.codex/agents/`, or `.opencode/agents/`). Each harness's
read-only posture (explorer, reviewer, and advisor) is tool-level where the
harness supports it and instruction-only for shell-level mutation otherwise.
See [Harnesses](docs/harnesses.md) for the exact per-harness file list and
the honest read-only-posture writeup, including the reviewer's own narrower
write boundary.

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

**Re-runs and profile changes.** A plain re-run (no `--profile` flag) keeps
the profile recorded in `.ai/workflow/manifest.json`; passing `--profile`
explicitly always overrides it, and a `full` to `minimal` downgrade leaves
the now-untracked role files on disk with a printed note (run
`orchestrator-workflow uninstall` first for a fully clean switch). See
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

## okf-kit version pin

`test/docs-consistency.test.ts` pins the `okf-kit@<version>` this repo's own
`.github/workflows/` install against the sibling `packages/okf-kit`
package's version, so a release of `okf-kit` must bump those pins in the
same commit as the version cut; see `CONTRIBUTING.md`'s "Releasing okf-kit"
section (repo root) for the order.

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
- [Curated knowledge bundle](docs/okf/index.md): the OKF-format reference docs for this package's own contracts and mechanics (the default location named by `knowledge` in `.ai/workflow/manifest.json`).
- [agentic-coding-playbook](../agentic-coding-playbook): the extended role prompts and organizational guidance this kit's skill references.

## Development

This package lives in the [agent-dx](https://github.com/LanNguyenSi/agent-dx)
monorepo. `npm test` (vitest) and `npm run typecheck` run from
`packages/orchestrator-workflow`; see the repository root's
`CONTRIBUTING.md` for the full contributor workflow, including the
"Releasing okf-kit" order referenced above.

## License

MIT.
