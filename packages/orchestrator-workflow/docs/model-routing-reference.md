# Model routing reference

The full `--routing` JSON shape and the Codex default routing table behind
the [package README](../README.md)'s Model preselection section.

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
