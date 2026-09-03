# agent-primitives

`agent-primitives` is an agent-first CLI: JSON on stdout by default, one
bounded result object per invocation, and stable exit codes (`0` ok, `1`
finding, `2` cannot conclude, including a usage error). It exists to remove
a few recurring failure classes in agent-driven review and implementation
work: hand-edited mutation probes that forget to restore a file, verify
output that blows past a harness's output cap, and "which binary is even on
PATH" guesswork.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and
tooling for teams shipping with AI agents.

Unlike its sibling packages, `agent-primitives` defaults to JSON output
(`-f, --format text` opts into a human-readable rendering instead), because
its primary caller is another agent, not a terminal.

## Install

This package is not published yet. Build it from source:

```bash
git clone https://github.com/LanNguyenSi/agent-dx.git
cd agent-dx/packages/agent-primitives
npm install
npm run build
node dist/cli.js doctor
```

Once published, the usual `npx agent-primitives doctor` / `npm install -g
agent-primitives` paths will work too.

Requires Node >= 20.

## Global options

Every subcommand accepts:

- `-f, --format <format>` — `json` (default) or `text`.
- `-C, --cwd <dir>` — working directory (defaults to the process cwd).
- `-m, --max-chars <n>` — hard bound on the serialized result (default
  `8000`); when a result would exceed it, fields are trimmed in a fixed
  order and the full result is written to the log directory instead.
- `-l, --log-dir <dir>` — directory for logs and full (untruncated)
  results (defaults to `$AGENT_PRIMITIVES_LOG_DIR`, or a fresh directory
  under the OS temp dir otherwise).

## `doctor`

Checks that a fixed list of required and optional binaries are on `PATH`,
captures each found binary's `--version`, and reports a few environment
checks (an installed `node_modules`, whether the cwd is inside a git work
tree, `BASH_MAX_OUTPUT_LENGTH` if set, and whether a `dist/` directory sits
next to `src/`, which hints that a test suite executing built output may
need a rebuild step first).

```bash
agent-primitives doctor
agent-primitives doctor -r git,node,npm,rg -o ast-grep,jq,yq,fd
```

Exits `1` when a required binary is missing.

## `probe`, `verify`, `init`

Not yet implemented. Each currently returns a JSON result with
`status: "usage_error"` and `reason: "not_implemented"`, exit `2`, rather
than doing nothing silently or claiming success.

## Output shape

Every result carries a common envelope (`tool`, `version`, `command`,
`status`, `durationMs`, `cwd`, `truncated`, `logs`, `warnings`) alongside
subcommand-specific fields. `status` classes into `ok` (exit 0), `finding`
(exit 1), or `cannot-conclude` (exit 2, includes `usage_error`), so a
caller can gate on the exit code alone without parsing the body.
