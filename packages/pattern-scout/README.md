# pattern-scout

Federated pattern search for refactor research. One query fans out across the source of [opensrc](https://github.com/vercel-labs/opensrc)-cached exemplar repos and your [codebase-oracle](https://github.com/LanNguyenSi) index, and returns one result set tagged by source.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Why

When you refactor, you want two things side by side: how a well-built library solves a pattern, and where your own code should adopt it. Those answers live in two different tools. `opensrc` fetches third-party package source into a local cache; `codebase-oracle` semantically indexes your own repos. Bridging them by hand means running `opensrc path` and a grep, then a separate oracle query, then merging the results in your head.

`pattern-scout` makes that one call. It queries both corpora in parallel and returns a single array where every hit carries a `kind`: `exemplar` for reference code, `ours` for your repos. No re-indexing, so the exemplar side costs nothing in embeddings.

## How it works

Two sources, queried in parallel:

- **exemplars (opensrc)**: enumerates the opensrc cache with `opensrc list`, then scans each cached repo's source line by line. Lexical: a literal substring of your query, or a regex you pass with `--pattern`.
- **ours (codebase-oracle)**: shells out to `codebase-oracle search`. Semantic: vector similarity over your indexed repos.

The asymmetry is deliberate. The oracle answers a natural-language `query` semantically; the exemplar repos are searched lexically. Pass `query` as a description for the oracle, and `--pattern` as a regex when you want precise control over the exemplar side.

The oracle source is optional. If `codebase-oracle` is not installed or fails, exemplar hits are still returned and the source is reported as unavailable.

## Install

```bash
npm install --save-dev pattern-scout
```

`pattern-scout` invokes the `opensrc` and `codebase-oracle` CLIs as subprocesses. Install [opensrc](https://github.com/vercel-labs/opensrc) for the exemplar side; `codebase-oracle` is optional.

## Quick start

```bash
# fetch the default set of exemplar repos into the opensrc cache
npx pattern-scout setup

# federated search across exemplars and your own repos
npx pattern-scout search "register an MCP tool"

# control the exemplar side with a regex
npx pattern-scout search "stdio transport" --pattern "StdioServerTransport"

# narrow to one repo, raise the per-source cap
npx pattern-scout search "config schema" --repo zod --limit 25

# exemplars only, JSON output for tooling
npx pattern-scout search "retry with backoff" --exemplars-only --format json
```

## Commands

### `pattern-scout search <query>`

| Flag | Description |
| --- | --- |
| `-p, --pattern <regex>` | Regex for the exemplar side. Default: the query as a literal substring. |
| `-k, --limit <n>` | Max results per source. Default: 15. |
| `-r, --repo <name>` | Restrict to repos whose name contains this substring. |
| `-f, --format <fmt>` | `text` (default) or `json`. |
| `-c, --config <file>` | Path to a `pattern-scout.config.json`. |
| `--exemplars-only` | Skip the codebase-oracle source. |

### `pattern-scout setup`

Fetches the default exemplar repos into the opensrc cache, one spec at a time. Accepts `-c, --config <file>`.

## Configuration

All settings are optional; pass a JSON file with `-c`:

```json
{
  "defaultRepos": ["zod", "vercel/turborepo", "crates:clap"],
  "opensrcCommand": "opensrc",
  "oracleCommand": "codebase-oracle",
  "oracleCwd": "/path/to/codebase-oracle"
}
```

- `defaultRepos`: opensrc specs fetched by `setup`. A spec is a bare npm name, a `crates:` / `pypi:` prefix, or `owner/repo` for GitHub.
- `opensrcCommand` / `oracleCommand`: how the CLIs are invoked. The string is split on whitespace, so `"npx codebase-oracle"` or `"node /abs/dist/index.js"` both work.
- `oracleCwd`: working directory for the oracle command. codebase-oracle loads its config (`ORACLE_*` env, scan root) from a `.env` in its working directory, so set this to a codebase-oracle checkout. Without it, the oracle source reports as unavailable and `pattern-scout` returns exemplar hits only.

## MCP server

`pattern-scout` ships a stdio MCP server exposing a `pattern_search` tool, so an agent can run a federated search without shelling out. Register it with Claude Code or the harness:

```json
{
  "mcpServers": {
    "pattern-scout": {
      "command": "npx",
      "args": ["-y", "pattern-scout-mcp"]
    }
  }
}
```

The tool takes `query`, `pattern`, `limit`, `repo`, `exemplarsOnly`, and `configPath`, and returns the same source-tagged summary as the CLI.

## Limitations

- The exemplar side is lexical, not semantic. A `--pattern` regex gives the most control.
- The codebase-oracle side reflects whatever that index already holds; `pattern-scout` does not index anything itself.
- `setup` does not yet have an interactive installer, and exemplar hits are not embedded on the fly. Both are tracked as follow-ups.
