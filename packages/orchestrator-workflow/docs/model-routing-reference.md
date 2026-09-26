# Model routing reference

The default per-role model table, the full `--routing` JSON shape, the Codex
default routing table, opencode model resolution, and the effort-tiers
mechanics behind the [package README](../README.md)'s Model preselection
section.

## Default model routing

`--models` is the backward-compatible, per-role input for Claude Code and
opencode. It does not configure Codex. Existing manifests that contain only
`models` continue to produce the same Claude Code and opencode defaults:

| Role | Default | Why |
|---|---|---|
| explorer | `sonnet` | read-only terrain mapping is broad reading, not deep reasoning |
| task-slicer | `sonnet` | structured decomposition, no deep reasoning needed |
| implementer | `sonnet` | fast, cheap, good enough for narrow pre-sliced tasks |
| reviewer | `opus` | skeptical review benefits from the strongest model |
| advisor | `opus` | escalations happen precisely when the situation is hard, so it shares the reviewer's strongest-model default |

The orchestrator itself runs on the session's main model. For Codex, start the
orchestrator on `gpt-6-astra` at `high` effort; use `xhigh` for demanding work.
The installer does not mutate global or fleet Codex configuration to enforce
that recommendation.

## Routing JSON shape

Routing is a harness-specific map from role and tier to a complete
`{model, effort}` selection. Pass a JSON file with `--routing`; the CLI deep
merges only the leaves you provide and records the resulting effective map in
`.ai/workflow/manifest.json`. The role's default-tier key configures its
unsuffixed file; another allowed key configures the corresponding
`<role>-<tier>` variant when `--tiers` is enabled. For example:

```json
{
  "codex": {
    "implementer": {
      "medium": { "model": "gpt-5.6-terra", "effort": "medium" },
      "xhigh": { "model": "gpt-6-astra", "effort": "xhigh" }
    }
  }
}
```

An omitted `--routing` preserves the exact persisted map on a re-install.
Changing one leaf leaves the others intact, which makes a previous manifest a
usable rollback record. Model updates are deliberate per role and tier: the
installer never interprets a newer model as automatically better and never
rewrites a preserved choice merely because another model exists.

## Codex defaults

Codex uses native `.codex/agents/*.toml` custom agents. The file shape
follows the
[official Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).
The shipped routing is:

| Role | Tier | Model | Effort |
|---|---|---|---|
| explorer | low | `gpt-5.6-luna` | low |
| explorer | medium (default) | `gpt-5.6-sol` | medium |
| explorer | high | `gpt-5.6-sol` | high |
| task-slicer | low | `gpt-5.6-luna` | low |
| task-slicer | medium (default) | `gpt-5.6-sol` | medium |
| task-slicer | high | `gpt-5.6-sol` | high |
| implementer | low | `gpt-5.6-luna` | low |
| implementer | medium (default) | `gpt-5.6-terra` | medium |
| implementer | high | `gpt-5.6-terra` | high |
| implementer | xhigh | `gpt-6-astra` | xhigh |
| reviewer | medium | `gpt-5.6-terra` | medium |
| reviewer | high (default) | `gpt-6-astra` | high |
| reviewer | xhigh | `gpt-6-astra` | xhigh |
| advisor | high (default) | `gpt-6-astra` | high |
| advisor | xhigh | `gpt-6-astra` | xhigh |

When you have a deterministic Codex model catalog, pass it with
`--codex-catalog <json-file>`. The CLI validates the selected Codex model and
effort pairs before writing. Without a supplied catalog it performs no online
entitlement check; offline or account-specific availability remains unknown.
Use the harness's native capability commands, such as `codex debug models`, to
refresh a catalog before installation when appropriate. A bundled-capability
view describes what the binary knows and does not prove account entitlement.

## opencode model resolution

opencode requires fully-qualified `provider/model-id`
strings (e.g. `github-copilot/claude-sonnet-4.6`). At install time the CLI
runs `opencode models` to fetch the live catalog and auto-detects which
provider to use (the one that offers Claude models). When exactly one such
provider exists the aliases are resolved to the highest-version matching id in
the catalog. When multiple providers offer Claude models the CLI warns and asks
you to pass `--opencode-provider <id>` to disambiguate, or to supply
fully-qualified ids per role via `--models`. If no resolution is possible
(catalog empty, `opencode` binary absent, ambiguous provider) the `model:`
frontmatter line is omitted entirely and the subagent inherits the
session/default model, a safe, portable fallback. Fully-qualified ids in
`--models` always pass through unchanged regardless of the catalog.
Nested-path providers like `openrouter` (whose ids look like
`openrouter/anthropic/claude-...`) are not auto-resolved from aliases and must
be supplied as a fully-qualified `--models` entry, e.g.
`reviewer=openrouter/anthropic/claude-opus-4.8`.

## Effort tiers

`--tiers` renders an additional per-role subagent definition for each
non-default effort tier, alongside the one default (unsuffixed) agent file
`--profile` already installs. Each tier variant is a standalone subagent
definition, not a modification of the default file. Claude Code and opencode
use `<role>.md` / `<role>-<tier>.md`; Codex uses `<role>.toml` /
`<role>-<tier>.toml`.

**Every default file carries its own pinned effort, independent of
`--tiers`.** The harness composers add the role's own default routing
selection to the unsuffixed file. In the legacy Claude/opencode path this is
`TIER_DEFS[DEFAULT_TIER[role]].effort`: `effort: medium` for explorer,
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
`tiers` is opt-in/off via the flags only. Neither Codex nor the other harnesses
get `max` or `ultra` variants from this kit.

```bash
npx orchestrator-workflow init --tiers --yes
```

Turning tiers back off with `--no-tiers` after having them on follows the
same pattern as a `full` to `minimal` profile downgrade: `init` prints a note
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

**Tier to model class to effort.** Each tier resolves to a model class and an
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

Codex variants carry `model` and `model_reasoning_effort` from their exact
routing leaf. The canonical role prompt becomes `developer_instructions`.
Runtime dispatch follows the client's actual capabilities: select the named
installed agent when supported; otherwise, if spawning supports explicit model
and effort, read the installed TOML and pass its selection, developer
instructions, and narrow task contract into a fresh task-local spawn. A
full-history spawn may not permit a model override. If that explicit spawn
cannot accept a sandbox override, explorer and advisor inherit the caller's
sandbox and their prompt is the edit guard. When native spawning is
unavailable, run the same contract inline and sequentially. The orchestrator
alone spawns agents. In particular, it must not choose `implementer-low` when
the task requires a test, typecheck, lint, build, or named mutation probe.

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
