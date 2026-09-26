# Command reference

Reference for every `friction-log` subcommand and its main flags. Run any command with `--help` for the complete flag list.

| Command | What it does |
|---------|--------------|
| `init` | One-command setup: detects the local environment (Claude Code dir, `gh` CLI, Linear key, agent-tasks token), suggests a default sink, writes `~/.config/friction-log/config.yml`, and (when Claude Code is present) offers to install the Stop-hook. Non-interactive: `init --sink <name> --yes`. Idempotent. |
| `import <path>` | Bulk-ingest frictions from a directory of markdown files. `--format markdown-frontmatter` (the only format in M5) parses YAML frontmatter, falls back to the first `# H1` for the title, preserves unknown frontmatter keys as `key:value` tags, and dedupes on a content hash so re-running the same import is a no-op. |
| `log` | Manually record a friction with title, tool, category, severity. Returns the new id. Optional `--recurrence-of <id>` to explicitly mark a duplicate; otherwise auto-links on matching (tool, title) against an open root, see [recurrence semantics](./storage.md#recurrence_of_id-semantics). |
| `list` | List frictions with filters: `--status`, `--tool`, `--category`, `--source`, `--age 14d`, `--limit`. Use `--json` for piping. |
| `search <query>` | FTS5 MATCH over title and description, plus the same structured filters as `list`. Use `--json` for piping. Accepts the full [FTS5 query syntax](https://sqlite.org/fts5.html#full_text_query_syntax). |
| `digest --group-by <field>` | Aggregations over frictions: total, open / filed / resolved / wontfix counts, open percentage, recurrence count, and average hours from `captured_at` to the first `tasks.created_at` (time-to-triage proxy). `--group-by tool\|category\|severity\|source`. Optional `--last <span>` window. `--include-peers` additionally renders one read-only section per `sync_export.peer_paths` entry; see [Sync-export](./sync-export.md). |
| `export --format <json\|csv\|md>` | Render frictions for offline analysis or hand-off. Same filter combinators as `list`, plus `--query <text>` for an FTS pre-filter. `--out <path>` writes to a file, otherwise stdout. |
| `sync-export` | Write every friction as deterministic, origin-tagged JSON to the configured `sync_export.path`. No-op error unless `sync_export` is configured; see [Sync-export](./sync-export.md). |
| `file <id>` | Push a friction through a sink. Default sink is `markdown-file`, default template matches the friction's category and falls back to `workflow-friction`. See [Sinks](./sinks.md). |
| `scan` | Parse a transcript and extract candidate frictions (tool-call errors, non-zero Bash exits, friction phrases). Flags: `--transcript <path>`, `--session <id>`, `--adapter claude-code`, `--silent`, `--stdin-payload`. Idempotent on re-run. |
| `bilanz` | Print a session-boundary summary: tools exercised, frictions noticed, tasks filed, plus a highlighted list of open frictions that have not been filed yet. `--session <id>` defaults to the most recent session. |
| `rm <id>` | Delete a friction and any task rows pointing at it from the local store. |
| `update <id> --status <state>` | Change a friction's status. |

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
