# friction-log

Capture, query, and infer agent-workflow frictions. SQLite-backed, sink-pluggable, zero-config default.

> Most agent tooling helps a model *write* the code. `friction-log` keeps a structured record of the moments where the agent's tools, MCP verbs, or harness behave unexpectedly, so the friction doesn't evaporate between sessions and the dogfood loop stays honest.

## Status

M3 (this release): turns the accumulated data into queries. `search` exposes the FTS5 virtual table that has existed since M1, `digest` aggregates frictions by tool / category / severity / source with open-vs-filed ratios and a time-to-triage proxy, `export` ships JSON / CSV / Markdown, and a cheap auto-link for `recurrence_of_id` makes "this happened again" visible without manual cross-referencing. Schema v2 adds a CHECK constraint on `severity` so the programmatic API matches the CLI's validation. Additional sinks (`github-issues`, `agent-tasks`, `linear`, `stdout-json`) still land in M4, see [#followups](#whats-next).

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

## Commands

| Command | What it does |
|---------|--------------|
| `log` | Manually record a friction with title, tool, category, severity. Returns the new id. Optional `--recurrence-of <id>` to explicitly mark a duplicate; otherwise auto-links on matching (tool, title) against an open root, see [recurrence semantics](#recurrence_of_id-semantics). |
| `list` | List frictions with filters: `--status`, `--tool`, `--category`, `--source`, `--age 14d`, `--limit`. Use `--json` for piping. |
| `search <query>` | FTS5 MATCH over title and description, plus the same structured filters as `list`. Use `--json` for piping. Accepts the full [FTS5 query syntax](https://sqlite.org/fts5.html#full_text_query_syntax). |
| `digest --group-by <field>` | Aggregations over frictions: total, open / filed / resolved / wontfix counts, open percentage, recurrence count, and average hours from `captured_at` to the first `tasks.created_at` (time-to-triage proxy). `--group-by tool|category|severity|source`. Optional `--last <span>` window. |
| `export --format <json\|csv\|md>` | Render frictions for offline analysis or hand-off. Same filter combinators as `list`, plus `--query <text>` for an FTS pre-filter. `--out <path>` writes to a file, otherwise stdout. |
| `file <id>` | Push a friction through a sink. Default sink is `markdown-file`, default template matches the friction's category and falls back to `workflow-friction`. |
| `scan` | Parse a transcript and extract candidate frictions (tool-call errors, non-zero Bash exits, friction phrases). Flags: `--transcript <path>`, `--session <id>`, `--adapter claude-code`, `--silent`, `--stdin-payload`. Idempotent on re-run. |
| `bilanz` | Print a session-boundary summary: tools exercised, frictions noticed, tasks filed, plus a highlighted list of open frictions that have not been filed yet. `--session <id>` defaults to the most recent session. |
| `rm <id>` | Delete a friction and any task rows pointing at it from the local store. |
| `update <id> --status <state>` | Change a friction's status. Useful when the agent-tasks or github-issues sinks land in M4 and you want to retroactively mark older rows. |

Run any command with `--help` for the full flag list.

## Auto-capture via Claude Code Stop-hook

To run `friction-log scan` automatically at the end of every Claude Code session, add this entry to your `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "friction-log scan --silent --stdin-payload"
          }
        ]
      }
    ]
  }
}
```

The hook passes a JSON payload to stdin with `session_id` and `transcript_path`. `--stdin-payload` reads it and feeds the scan. `--silent` keeps the hook non-blocking: if anything fails, the error goes to stderr and exit is always 0 so the session shutdown is never delayed.

After the hook is wired, run `friction-log bilanz` whenever you want a summary of the most recent session.

## Manually scanning a past session

```bash
friction-log scan \
  --transcript ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl

friction-log bilanz --session <sessionId>
```

Re-running `scan` against the same transcript is idempotent, so it is safe to run on every project sync.

## Storage

SQLite under `~/.local/share/friction-log/db.sqlite` (XDG-compliant). Override with `FRICTION_LOG_DB=/path/to/db.sqlite` or `--db /path/to/db.sqlite` per command.

Schema (M1): `sessions`, `frictions` (plus FTS5 virtual table), `tasks` (records what was filed to which sink), `tags`, `schema_version`.

Schema v2 (M3): adds `CHECK(severity IN ('low','medium','high','critical') OR severity IS NULL)` to `frictions`. On upgrade the migration normalizes any rogue severity values to `NULL` before swapping the table in, so existing rows survive. The FTS5 virtual table and triggers are recreated against the new physical table.

### `recurrence_of_id` semantics

When `log` (or `scan`) inserts a new friction without an explicit `--recurrence-of` flag, the database looks for an existing friction that is:

1. `status = 'open'`,
2. itself a root (`recurrence_of_id IS NULL`),
3. with the same `tool_surface`,
4. and the same `title` (exact match).

The oldest such match becomes the new friction's `recurrence_of_id`. The chain therefore always points one level deep, at the root; downstream queries can `GROUP BY coalesce(recurrence_of_id, id)` to fold recurrences into their root for free.

This is the cheap, deterministic rule, deliberately small enough to predict by eye. A future milestone may add fuzzier matching (template-aware, vector-based) behind an opt-in flag, but the cheap rule is the default so the database remains explainable from a glance at the source.

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
| M4 | Additional sinks: `github-issues`, `agent-tasks`, `linear`, `stdout-json`. |
| M5 | `init` (interactive setup), `import` (markdown-frontmatter), remaining templates. |

## Design notes

Public-tool framing: zero LanNguyenSi-stack assumptions in the core. The default sink is plain markdown files so the tool works without any external infrastructure, and integrations are configurable adapters that load only when used.

Local SQLite, single-user, single-machine. No sync, no server, no cloud. Friction records are personal observation data, the smallest store that lets queries answer questions is the right one.

Deterministic detection only: regex on tool-call errors, non-zero exits, friction phrases. No LLM API calls in the default Stop-hook so it stays free and fast. An opt-in `--with-llm` flag for deeper end-of-week reviews is on the M5+ roadmap.

## Where this fits

`friction-log` and `slop-detector` are sibling hygiene tools in the agent-dx workshop. `slop-detector` catches prose tells at PR time. `friction-log` catches workflow tells at session time. Both run cheaply, both produce a structured artifact, both compose with whatever issue tracker and review process the team already uses.

## License

MIT. See [LICENSE](../../LICENSE) at the repo root.
