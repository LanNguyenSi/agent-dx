# agent-entrypoint 🧊

> CLI to generate and validate `AGENT_ENTRYPOINT.yaml` — machine-readable project orientation files for AI agents.

Built by Ice. Based on [lan-tools spec #7](https://github.com/LanNguyenSi/lava-ice-logs/blob/master/lan-tools/07-agent-entrypoint-manifest.md).

## The Problem

Repos are navigable for humans, but not for agents. Agents waste time figuring out:
- Which files actually matter
- What the components do
- What to check first
- What not to assume

## The Solution

A small YAML file at the repo root that tells any agent exactly where to start.

```yaml
project: clawd-monitor
primary_docs:
  - README.md
  - docs/architecture.md
components:
  - name: clawd-monitor
    role: monitor ui
  - name: clawd-monitor-agent
    role: local host agent
first_checks:
  - verify agent process is running
  - verify token matches
do_not_assume:
  - architecture issue
  - token mismatch
authoritative_sources:
  - README.md
  - systemd service file
```

## Install

```bash
git clone https://github.com/LanNguyenSi/agent-entrypoint
cd agent-entrypoint
npm install && npm run build
# Optional: link globally
npm link
```

## Usage

```bash
# Generate AGENT_ENTRYPOINT.yaml for current repo
agent-entrypoint generate

# Generate for a specific repo
agent-entrypoint generate --dir /path/to/repo --project my-project

# Overwrite existing
agent-entrypoint generate --force

# Validate the file
agent-entrypoint validate

# Show it nicely formatted
agent-entrypoint show
```

## Commands

| Command | Description |
|---------|-------------|
| `generate` | Auto-detect and generate `AGENT_ENTRYPOINT.yaml` |
| `validate` | Check file exists, is valid YAML, required fields present, docs exist |
| `show` | Pretty-print the manifest |

## Rules (from spec)

- Lives in the repo root
- Always read first by any agent
- Kept deliberately short
- Must describe operational reality, not wishful architecture
