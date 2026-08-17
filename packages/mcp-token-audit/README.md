# mcp-token-audit

Ranks tool calls in Claude Code transcripts by approximate token cost, per tool name, with an `mcp__*` share of the total.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Why

MCP tool responses land straight in the model's context. A verbose tool (a list endpoint that returns full objects instead of summaries, a search that echoes back the whole query) can dominate a session's token budget without anyone noticing, because the cost is spread across many small calls instead of one visible spike.

`mcp-token-audit` scans Claude Code transcript JSONL files (`~/.claude/projects/*/*.jsonl`), pairs every `tool_use` block with its `tool_result` by id, and aggregates an approximate input/output character count per tool name. It is meant as a before/after baseline: run it, change an MCP server's response shape, run it again, diff the two rankings.

## Install

Not published to npm, run it from a local build of this monorepo:

```bash
git clone https://github.com/LanNguyenSi/agent-dx
cd agent-dx
cd packages/mcp-token-audit && npm install && npm run build && cd ../..

# alias the local CLI for this shell; the examples below use the bare `mcp-token-audit` command
alias mcp-token-audit="node $PWD/packages/mcp-token-audit/dist/cli.js"
```

Without the alias, invoke the built CLI directly: `node packages/mcp-token-audit/dist/cli.js`.

## Quick start

```bash
# scan every ~/.claude/projects/* directory (the default when no path is given)
mcp-token-audit

# scan specific project directories only
mcp-token-audit ~/.claude/projects/-Users-me-git-my-repo

# only include transcripts modified in the last 3 days
mcp-token-audit --days 3

# machine-readable output for scripting a before/after diff
mcp-token-audit --json ~/.claude/projects/-Users-me-git-my-repo > before.json
```

Sample text output:

```
tool                            calls  ~tok_in  ~tok_out  ~tok/call
Bash                              918   112490    176873       315
Agent                             121   125264     35800      1331
mcp__agent-tasks__project_tasks    31      498     71133      2311
mcp__agent-tasks__task_create      40    23377      2038       635

total: 1234 calls, ~412490 tok in, ~512873 tok out, ~925363 tok
mcp__*: 71 calls, ~97046 tok (10.5% of total)
skipped 2 malformed line(s)
5 transcript file(s) scanned
```

## How it works

- **Discovery.** With no `<projectDir...>` arguments, every directory directly under `~/.claude/projects/` is scanned (each one holds one Claude Code project's transcripts). Pass one or more directories to scan a subset instead. `--days N` restricts this to `*.jsonl` files whose mtime is within the last `N` days.
- **Parsing.** Each transcript is JSONL, one entry per line. Lines that fail to `JSON.parse` are skipped and counted, not fatal, so a mid-session crash or a truncated write doesn't make the rest of the file unusable.
- **Pairing.** Within each entry's `message.content[]` array, a `tool_use` block (`{ id, name, input }`) is matched to its `tool_result` block (`{ tool_use_id, content }`) by id. A `tool_use` with no matching `tool_result` still counts as a call, with zero output.
- **Token approximation.** `~tok_in` is `JSON.stringify(tool_use.input).length / 4`, `~tok_out` is the stringified `tool_result.content` length / 4, both rounded to the nearest integer. This is a rough heuristic (~4 characters per token for English text), not a real tokenizer call: good for relative before/after comparisons of payload size, not for billing or exact context accounting.
- **MCP share.** A tool counts toward the `mcp__*` subtotal when its name starts with the `mcp__` prefix Claude Code uses for MCP-server tools (e.g. `mcp__agent-tasks__task_create`). Built-in tools (`Bash`, `Read`, `Edit`, `Agent`, ...) do not.
- **Ranking.** Tools are sorted descending by total tokens (`~tok_in + ~tok_out`) summed across all scanned files.

## Output

| Column | Meaning |
|---|---|
| `tool` | Tool name as it appears in the transcript (`Bash`, `mcp__<server>__<tool>`, ...) |
| `calls` | Number of `tool_use` blocks for this tool across all scanned files |
| `~tok_in` | Approximate tokens sent to the tool (its `input`, summed) |
| `~tok_out` | Approximate tokens returned by the tool (its `tool_result.content`, summed) |
| `~tok/call` | `(~tok_in + ~tok_out) / calls`, rounded |

`--json` emits the same numbers as a `{ filesScanned, skippedLines, tools[], totals, mcp }` object instead of a text table.

## Limitations

No live API calls (this reads local transcript files only), no dollar-cost conversion, no dashboard. The `chars/4` approximation will drift from a real tokenizer, especially for code, JSON payloads, and non-English text; treat the numbers as directionally useful, not exact.

## CI

Built and tested as part of the agent-dx monorepo CI matrix in [`.github/workflows/ci.yml`](https://github.com/LanNguyenSi/agent-dx/blob/master/.github/workflows/ci.yml): `npm run typecheck`, `npm run build`, `npm test`.
