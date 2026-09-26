# friction-log

Capture, query, and infer agent-workflow frictions. SQLite-backed, sink-pluggable, zero-config default.

> Most agent tooling helps a model *write* the code. `friction-log` keeps a structured record of the moments where the agent's tools, MCP verbs, or harness behave unexpectedly, so the friction doesn't evaporate between sessions and the dogfood loop stays honest.

## Overview

Two recurring patterns in agent-driven development go unaddressed by most tooling: the per-friction reflex (the agent notices a tool acting unexpectedly mid-task, mentally notes it, then moves on and the note evaporates) and the end-of-session bilanz (a retrospective naming tools exercised, frictions observed, tasks filed, easy to skip if nothing makes it cheap). `friction-log` lowers the cost of both: a one-line `log` for the per-moment capture, a one-command `file` to push the friction into whatever issue tracker the team uses, and a passive Stop-hook scan plus `bilanz` so missed frictions still get a second chance at the session boundary. The data isn't the goal; the goal is the inferences a few weeks of accumulated data enable (which tools cause the most friction, which categories recur, how long frictions take to become fixes), which is why the schema (SQLite + FTS5) is the foundation everything else builds on.

**Status:** M5 (this release) completes the v1 surface. `init` writes a YAML config and optionally installs the Claude Code Stop-hook in one command (with a `--yes` non-interactive mode for scripted bootstrap). `import --format markdown-frontmatter <dir>` bulk-loads existing markdown notes into the database, idempotent on re-run via a content-hash dedup. Four templates round out the v1 set (`tool-missing-capability`, `auth-expiry`, `schema-drift`, `doc-gap`), all auto-picked by matching the friction's `category`.

## Key features

- One-command `init`: detects the local environment and writes config, optionally installing the Claude Code Stop-hook
- Structured `log`, `list`, `search` (FTS5), `export`, and `digest` (aggregations) over a local SQLite store
- Five pluggable filing sinks: `markdown-file` (default, zero-dependency), `stdout-json`, `github-issues`, `agent-tasks`, `linear`
- Idempotent `scan` of Claude Code transcripts and `import` of existing markdown notes, both content-hash deduped
- Optional multi-machine `sync-export`: deterministic, config-gated JSON file dump with read-only peer merge into `digest`
- Auto-linked recurrence detection on repeated (tool, title) matches

## Install / quick start

Not published to npm; run it from a local build of this monorepo (Node.js 20 or later):

```bash
git clone https://github.com/LanNguyenSi/agent-dx && cd agent-dx
cd packages/friction-log && npm install && npm run build && cd ../..

# Log a friction you noticed
node packages/friction-log/dist/cli.js log \
  --title "tasks_list returns 149kB blob" \
  --tool "mcp:agent-tasks/tasks_list" \
  --category output-overflow \
  --severity high

# See it in the local database
node packages/friction-log/dist/cli.js list

# Render and file it via the default markdown sink
node packages/friction-log/dist/cli.js file 1
```

A markdown record lands under `~/.local/share/friction-log/frictions/` with full frontmatter, ready to commit, paste into a chat, or pipe into another tool.

## Usage

Wire automatic capture into every Claude Code session with a Stop-hook, then review with `bilanz`:

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "friction-log scan --silent --stdin-payload" }]
      }
    ]
  }
}
```

```bash
friction-log bilanz
```

See [Command reference](./docs/commands.md) for every subcommand and flag, including manual transcript scanning.

## Documentation

- [Command reference](./docs/commands.md): full subcommand table, Stop-hook wiring, manual scan, templates
- [Sinks](./docs/sinks.md): configuration for `markdown-file`, `stdout-json`, `github-issues`, `agent-tasks`, `linear`
- [Sync-export](./docs/sync-export.md): optional multi-machine file merge, format, and write-through semantics
- [Storage](./docs/storage.md): SQLite schema and `recurrence_of_id` matching rule
- [Design notes](./docs/design.md): ADR for the sink options bag, roadmap, and how this relates to `slop-detector`

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

MIT. See [LICENSE](./LICENSE).
