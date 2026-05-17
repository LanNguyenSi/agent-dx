# friction-log

Capture, query, and infer agent-workflow frictions. SQLite-backed, sink-pluggable, zero-config default.

> Most agent tooling helps a model *write* the code. `friction-log` keeps a structured record of the moments where the agent's tools, MCP verbs, or harness behave unexpectedly, so the friction doesn't evaporate between sessions and the dogfood loop stays honest.

## Status

M1 (this release): `log`, `list`, `file` commands, SQLite storage, `markdown-file` sink, three shipped templates. Auto-capture from transcripts (`scan` / `bilanz`), FTS5 `search`, `digest` aggregations, and additional sinks (`github-issues`, `agent-tasks`, `linear`, `stdout-json`) land in subsequent milestones, see [#followups](#whats-next).

## Try it in 60 seconds

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

## Why this exists

Two recurring patterns in agent-driven development:

1. **Per-friction reflex.** The agent notices a tool acting unexpectedly mid-task, mentally notes it, then moves on. The note evaporates because in-flow bandwidth is too low for context-switching.
2. **End-of-session bilanz.** A retrospective that names tools exercised, frictions observed, and tasks filed. Easy to skip if no tool makes it cheap.

Discipline alone loses to momentum. `friction-log` lowers the cost of both patterns: a one-line `log` for the per-moment capture, a one-command `file` to push the friction into whatever issue tracker the team uses, and (in M2) a passive Stop-hook scan plus `bilanz` so missed frictions still get a second chance at the session boundary.

The data isn't the goal. The goal is the inferences that the data enables once a few weeks accumulate: which tools cause the most friction, which categories recur, how long frictions take to become fixes. Those queries are trivial on SQLite + FTS5, so the schema is the foundation everything else builds on.

## Commands (M1)

| Command | What it does |
|---------|--------------|
| `log` | Manually record a friction with title, tool, category, severity. Returns the new id. |
| `list` | List frictions with filters: `--status`, `--tool`, `--category`, `--source`, `--age 14d`, `--limit`. Use `--json` for piping. |
| `file <id>` | Push a friction through a sink. Default sink is `markdown-file`, default template matches the friction's category and falls back to `workflow-friction`. |

Run any command with `--help` for the full flag list.

## Storage

SQLite under `~/.local/share/friction-log/db.sqlite` (XDG-compliant). Override with `FRICTION_LOG_DB=/path/to/db.sqlite` or `--db /path/to/db.sqlite` per command.

Schema (M1): `sessions`, `frictions` (plus FTS5 virtual table), `tasks` (records what was filed to which sink), `tags`, `schema_version`.

## Sinks

A sink is the thing that receives a rendered friction. v1 ships `markdown-file` only, but the interface is pluggable:

```ts
interface Sink {
  readonly name: string;
  file(friction: Friction, rendered: RenderedTemplate, opts: FileOptions): Promise<FileResult>;
}
```

The default `markdown-file` sink writes a file under `~/.local/share/friction-log/frictions/` (override with `FRICTION_LOG_MARKDOWN_DIR` or `--sink-target /path/to/dir`). The file has YAML frontmatter with `friction_id`, `captured_at`, `priority`, `labels`, plus tool surface, category, and severity when set.

Planned for later milestones: `github-issues` (via `gh` CLI), `agent-tasks` (via MCP), `linear` (via API token), `stdout-json` (for piping).

## Templates

Three generic categories ship with M1:

| Template | When to use |
|----------|-------------|
| `tool-error` | Tool, CLI, or MCP verb behaves differently than its docs claim. |
| `output-overflow` | Tool output overflows the agent's context window or significantly degrades performance. |
| `workflow-friction` | Generic catch-all. Used as the fallback when no category matches. |

Each template is a YAML file under `packages/friction-log/templates/`. Mustache-style `{{var}}` substitution: `id`, `title`, `description`, `tool`, `category`, `severity`, `capturedAt`, `sessionId`, `source`.

The `--template <name>` flag on `file` overrides the auto-selection.

## What's next

| Milestone | Scope |
|-----------|-------|
| M2 | `scan` plus a Claude Code transcript adapter, `bilanz`, Stop-hook integration. |
| M3 | `search` (FTS5), `digest`, `export` (JSON, CSV, Markdown). |
| M4 | Additional sinks: `github-issues`, `agent-tasks`, `linear`, `stdout-json`. |
| M5 | `init` (interactive setup), `import` (markdown-frontmatter), remaining templates. |

## Design notes

Public-tool framing: zero LanNguyenSi-stack assumptions in the core. The default sink is plain markdown files so the tool works without any external infrastructure, and integrations are configurable adapters that load only when used.

Local SQLite, single-user, single-machine. No sync, no server, no cloud. Friction records are personal observation data, the smallest store that lets queries answer questions is the right one.

Deterministic detection only (when M2 lands): regex on tool-call errors, non-zero exits, friction phrases. No LLM API calls in the default Stop-hook so it stays free and fast. An opt-in `--with-llm` flag is on the M2+ roadmap for deeper end-of-week reviews.

## Where this fits

`friction-log` and `slop-detector` are sibling hygiene tools in the agent-dx workshop. `slop-detector` catches prose tells at PR time. `friction-log` catches workflow tells at session time. Both run cheaply, both produce a structured artifact, both compose with whatever issue tracker and review process the team already uses.

## License

MIT. See [LICENSE](../../LICENSE) at the repo root.
