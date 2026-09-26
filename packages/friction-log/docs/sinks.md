# Sinks

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

Sink-specific configuration lives in `~/.config/friction-log/config.yml` (override with `FRICTION_LOG_CONFIG=/path` or `--config /path`). CLI overrides via `--sink-opt key=value` (repeatable) win on key collision. Heuristic value coercion: commas split into arrays, `true`/`false`/`null` are literal, integers parse as numbers, prefix `s:` for a literal that would otherwise coerce.

## `markdown-file` (default)

Writes a markdown file under `~/.local/share/friction-log/frictions/` (override with `FRICTION_LOG_MARKDOWN_DIR` or `--sink-target /path/to/dir`). YAML frontmatter with `friction_id`, `captured_at`, `priority`, `labels`, plus tool surface, category, and severity when set. No external dependencies.

## `stdout-json`

Emits a single-line JSON record to stdout and returns. Useful for piping into custom workflows:

```bash
friction-log file 7 --sink stdout-json | jq '.rendered.body'
```

The schema is stable: any future field is additive.

## `github-issues`

Spawns `gh issue create` under the hood, so authentication, retries, and proxy config stay with the `gh` CLI. Required: `repo` (`owner/name`). Optional: `labels`, `assignee`, `milestone`.

```yaml
# config.yml
sinks:
  github-issues:
    repo: your-org/your-repo
    labels: [bug, friction]
    assignee: octocat
```

```bash
friction-log file 7 --sink github-issues
# or override per-call:
friction-log file 7 --sink github-issues --sink-opt repo=other/repo --sink-opt labels=quick-fix
```

## `agent-tasks`

Two modes, both honest about what they do:

- **`mode: rest` (default)**: POSTs to `<apiBase>/api/projects/<id>/tasks` with bearer auth. Requires `apiBase`, `projectId`, and a token from `AGENT_TASKS_TOKEN` env or `token:` in config.
- **`mode: mcp-emit`**: prints the equivalent `mcp__agent-tasks__task_create` invocation JSON to stdout and returns; no network call is made. This is the version of "the MCP path" that an honest standalone Node CLI can actually offer. An agent-harness wrapper can pick the line up and execute it under its own MCP scope.

```yaml
sinks:
  agent-tasks:
    mode: rest
    apiBase: https://agent-tasks.example.com
    projectId: 00000000-0000-0000-0000-000000000000
    # token: # set AGENT_TASKS_TOKEN env var instead in production
```

## `linear`

GraphQL `issueCreate` against `api.linear.app/graphql`. Required: `teamId` and an API key (`LINEAR_API_KEY` env or `apiKey:` in config). Optional: `state` (matched case-insensitively against the team's workflow-state names; one extra query resolves it to a state id) and `assignee`.

```yaml
sinks:
  linear:
    teamId: TEAM-UUID
    state: Backlog
```

> Note: Linear allows duplicate state names across a team's workflow. If two states share a name, the sink picks the first match in the API response and emits no warning. Pass the state's UUID directly via `--sink-opt state=<uuid>` when the name is not unique.
