# friction-log

Capture, query, and infer agent-workflow frictions. SQLite-backed, sink-pluggable, zero-config default.

> Most agent tooling helps a model *write* the code. `friction-log` keeps a structured record of the moments where the agent's tools, MCP verbs, or harness behave unexpectedly, so the friction doesn't evaporate between sessions and the dogfood loop stays honest.

## Status

M5 (this release): completes the v1 surface. `init` writes a YAML config and optionally installs the Claude Code Stop-hook in one command (with a `--yes` non-interactive mode for scripted bootstrap). `import --format markdown-frontmatter <dir>` bulk-loads existing markdown notes into the database, idempotent on re-run via a content-hash dedup. Four new templates round out the v1 set (`tool-missing-capability`, `auth-expiry`, `schema-drift`, `doc-gap`), all auto-picked by matching the friction's `category`.

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
| `init` | One-command setup: detects the local environment (Claude Code dir, `gh` CLI, Linear key, agent-tasks token), suggests a default sink, writes `~/.config/friction-log/config.yml`, and (when Claude Code is present) offers to install the Stop-hook. Non-interactive: `init --sink <name> --yes`. Idempotent. |
| `import <path>` | Bulk-ingest frictions from a directory of markdown files. `--format markdown-frontmatter` (the only format in M5) parses YAML frontmatter, falls back to the first `# H1` for the title, preserves unknown frontmatter keys as `key:value` tags, and dedupes on a content hash so re-running the same import is a no-op. |
| `log` | Manually record a friction with title, tool, category, severity. Returns the new id. Optional `--recurrence-of <id>` to explicitly mark a duplicate; otherwise auto-links on matching (tool, title) against an open root, see [recurrence semantics](#recurrence_of_id-semantics). |
| `list` | List frictions with filters: `--status`, `--tool`, `--category`, `--source`, `--age 14d`, `--limit`. Use `--json` for piping. |
| `search <query>` | FTS5 MATCH over title and description, plus the same structured filters as `list`. Use `--json` for piping. Accepts the full [FTS5 query syntax](https://sqlite.org/fts5.html#full_text_query_syntax). |
| `digest --group-by <field>` | Aggregations over frictions: total, open / filed / resolved / wontfix counts, open percentage, recurrence count, and average hours from `captured_at` to the first `tasks.created_at` (time-to-triage proxy). `--group-by tool|category|severity|source`. Optional `--last <span>` window. |
| `export --format <json\|csv\|md>` | Render frictions for offline analysis or hand-off. Same filter combinators as `list`, plus `--query <text>` for an FTS pre-filter. `--out <path>` writes to a file, otherwise stdout. |
| `file <id>` | Push a friction through a sink. Default sink is `markdown-file`, default template matches the friction's category and falls back to `workflow-friction`. |
| `scan` | Parse a transcript and extract candidate frictions (tool-call errors, non-zero Bash exits, friction phrases). Flags: `--transcript <path>`, `--session <id>`, `--adapter claude-code`, `--silent`, `--stdin-payload`. Idempotent on re-run. |
| `bilanz` | Print a session-boundary summary: tools exercised, frictions noticed, tasks filed, plus a highlighted list of open frictions that have not been filed yet. `--session <id>` defaults to the most recent session. |
| `rm <id>` | Delete a friction and any task rows pointing at it from the local store. |
| `update <id> --status <state>` | Change a friction's status. |

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

A sink is the thing that receives a rendered friction. Five sinks ship, all behind a lazy-loaded registry (the Linear API client and the agent-tasks REST helper only get imported when those sinks are actually picked):

```ts
interface Sink {
  readonly name: string;
  file(friction: Friction, rendered: RenderedTemplate, opts: FileOptions): Promise<FileResult>;
}

interface FileOptions {
  sinkTarget?: string;                   // markdown-file legacy shortcut
  sinkOpts?: Record<string, unknown>;    // merged config-file defaults + CLI overrides
}
```

Sink-specific configuration lives in `$XDG_CONFIG_HOME/friction-log/config.yml` (override with `FRICTION_LOG_CONFIG=/path` or `--config /path`). CLI overrides via `--sink-opt key=value` (repeatable) win on key collision. Heuristic value coercion: commas split into arrays, `true`/`false`/`null` are literal, integers parse as numbers, prefix `s:` for a literal that would otherwise coerce.

### `markdown-file` (default)

Writes a markdown file under `~/.local/share/friction-log/frictions/` (override with `FRICTION_LOG_MARKDOWN_DIR` or `--sink-target /path/to/dir`). YAML frontmatter with `friction_id`, `captured_at`, `priority`, `labels`, plus tool surface, category, and severity when set. No external dependencies.

### `stdout-json`

Emits a single-line JSON record to stdout and returns. Useful for piping into custom workflows:

```bash
friction-log file 7 --sink stdout-json | jq '.rendered.body'
```

The schema is stable: any future field is additive.

### `github-issues`

Spawns `gh issue create` under the hood, so authentication, retries, and proxy config stay with the `gh` CLI. Required: `repo` (`owner/name`). Optional: `labels`, `assignee`, `milestone`.

```yaml
# config.yml
sinks:
  github-issues:
    repo: LanNguyenSi/agent-dx
    labels: [bug, friction]
    assignee: lavaclawdbot
```

```bash
friction-log file 7 --sink github-issues
# or override per-call:
friction-log file 7 --sink github-issues --sink-opt repo=other/repo --sink-opt labels=quick-fix
```

### `agent-tasks`

Two modes, both honest about what they do:

- **`mode: rest` (default)**: POSTs to `<apiBase>/api/projects/<id>/tasks` with bearer auth. Requires `apiBase`, `projectId`, and a token from `AGENT_TASKS_TOKEN` env or `token:` in config.
- **`mode: mcp-emit`**: prints the equivalent `mcp__agent-tasks__task_create` invocation JSON to stdout and returns; no network call is made. This is the version of "the MCP path" that an honest standalone Node CLI can actually offer. An agent-harness wrapper can pick the line up and execute it under its own MCP scope.

```yaml
sinks:
  agent-tasks:
    mode: rest
    apiBase: https://agent-tasks.opentriologue.ai
    projectId: 8238805d-8185-4ad8-9f2b-36677ac4521d
    # token: # set AGENT_TASKS_TOKEN env var instead in production
```

### `linear`

GraphQL `issueCreate` against `api.linear.app/graphql`. Required: `teamId` and an API key (`LINEAR_API_KEY` env or `apiKey:` in config). Optional: `state` (matched case-insensitively against the team's workflow-state names; one extra query resolves it to a state id) and `assignee`.

```yaml
sinks:
  linear:
    teamId: TEAM-UUID
    state: Backlog
```

> Note: Linear allows duplicate state names across a team's workflow. If two states share a name, the sink picks the first match in the API response and emits no warning. Pass the state's UUID directly via `--sink-opt state=<uuid>` when the name is not unique.

## ADR: FileOptions widening

The pre-M4 `FileOptions { sinkTarget?: string }` was too narrow for sinks that need a project id, an api base, a team id, etc. Three options were considered (per the M4 task description):

- **A. Discriminated union per sink.** Strictest, but every sink change becomes a type bump in `types.ts`; doesn't compose with config files cleanly.
- **B. Open `Record<string, unknown>` bag validated per sink.** Flexible, forward-compatible CLI, but loses the type-level guarantee that a given key exists.
- **C. Drop CLI options entirely, read everything from `config.yml`.** Simplest CLI, but blocks one-off `--sink-opt repo=other/repo` overrides that are convenient when scripting.

**Shipped: B with a config-file layer.** Each sink reads `opts.sinkOpts`, which is the merge of the per-sink section in `config.yml` and any `--sink-opt key=value` CLI overrides (CLI wins on collision). Each sink validates the keys it cares about and surfaces missing-required-key with a single-line error pointing at both the config path and the equivalent `--sink-opt` flag. Unknown keys pass through untouched so a forward-compatible CLI does not fail against an older sink build. The C option (drop CLI options entirely) was rejected because `--sink-opt repo=other/repo` overrides are convenient when scripting one-off file calls.

## Templates

Seven categories ship in v1:

| Template | When to use |
|----------|-------------|
| `tool-error` | Tool, CLI, or MCP verb behaves differently than its docs claim. |
| `output-overflow` | Tool output overflows the agent's context window or significantly degrades performance. |
| `workflow-friction` | Generic catch-all. Used as the fallback when no category matches. |
| `tool-missing-capability` | Tool lacks a capability the workflow needs; not a defect, a gap. |
| `auth-expiry` | Token, JWT, session, or OAuth refresh lifecycle issue. |
| `schema-drift` | Tool schema contradicts the workflow's expected contract. |
| `doc-gap` | Tool behavior contradicts its documentation; usually a one-line doc PR upstream. |

Each template is a YAML file under `packages/friction-log/templates/`. Mustache-style `{{var}}` substitution: `id`, `title`, `description`, `tool`, `category`, `severity`, `capturedAt`, `sessionId`, `source`.

The `--template <name>` flag on `file` overrides the auto-selection.

## What's next

The v1 surface is complete. Future ideas (no scheduled milestone): web dashboard, vector-based recurrence detection, additional import formats (github-issues, agent-tasks backfill), `digest --with-llm` for end-of-week reviews.

## Design notes

Public-tool framing: zero LanNguyenSi-stack assumptions in the core. The default sink is plain markdown files so the tool works without any external infrastructure, and integrations are configurable adapters that load only when used.

Local SQLite, single-user, single-machine. No sync, no server, no cloud. Friction records are personal observation data, the smallest store that lets queries answer questions is the right one.

Deterministic detection only: regex on tool-call errors, non-zero exits, friction phrases. No LLM API calls in the default Stop-hook so it stays free and fast. An opt-in `--with-llm` flag for deeper end-of-week reviews is on the M5+ roadmap.

## Where this fits

`friction-log` and `slop-detector` are sibling hygiene tools in the agent-dx workshop. `slop-detector` catches prose tells at PR time. `friction-log` catches workflow tells at session time. Both run cheaply, both produce a structured artifact, both compose with whatever issue tracker and review process the team already uses.

## License

MIT. See [LICENSE](../../LICENSE) at the repo root.
