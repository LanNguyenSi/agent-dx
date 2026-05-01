# agent-dx

**Developer experience tooling for teams shipping with AI agents.** Linters, scaffolds, and playbooks that keep what an agent commits from looking like an agent committed it.

> Most agent tooling helps a model *write* the code. `agent-dx` helps you keep what shipped from looking like an AI wrote it: it lints AI fingerprints out of PRs, scaffolds repos that agents can navigate, and codifies the conventions a human-and-agent team needs to share.

## Try it in 60 seconds

```bash
git clone https://github.com/LanNguyenSi/agent-dx && cd agent-dx
cd packages/slop-detector && npm install && npm run build && cd ../..

# Scan a deliberately-sloppy markdown sample
node packages/slop-detector/dist/cli.js check examples/slop-sample.md --explain
```

`slop-detector` is the headline package: 14 deterministic rules across two packs (`agent-tics`, `prose-slop`) that catch the visible tells of agent-generated content. Configurable per repo via `slop.config.yml`, with per-line escape hatches when a real em-dash or template `<invoke>` block is wanted. The shipped example fires on a curated sample of common AI-tic prose.

## What a run looks like

```
examples/slop-sample.md
  WARN  3:1    prose-slop/hedging-opener     Hedging opener `It is important to note that`
  WARN  3:40   prose-slop/marketing-adjectives  Empty marketing adjective `cutting-edge`
  WARN  3:121  prose-slop/delve-tapestry     LLM idiom `leverage the power of`
  WARN  7:42   prose-slop/delve-tapestry     LLM idiom `delve into`
  WARN  12:42  prose-slop/em-dash            Em-dash in prose
  WARN  15:1   agent-tics/doubled-summary-heading  Second `Summary` heading
  WARN  19:1   agent-tics/placeholder-todo   Unresolved template placeholder
  WARN  21:1   agent-tics/claude-code-footer Auto-appended Claude Code attribution footer
  ... 12 more

1 files scanned, 20 violations (block 0, warn 20, info 0)
```

`--explain` adds a one-line rationale per violation. Promote any rule to `block` per repo via `slop.config.yml`; the two `agent-tics` rules that catch leaked tool-call XML wrappers (`</result>`, `</invoke>`) ship as `block` by default since those are objectively wrong.

## Next steps

| If you want to... | Read |
|------|------|
| Lint AI fingerprints out of a PR or a directory tree | [`packages/slop-detector`](packages/slop-detector) |
| Scaffold a new agent-ready project from a blueprint | [`packages/agent-dev-kit`](packages/agent-dev-kit) |
| Generate / validate `AGENT_ENTRYPOINT.yaml` for a repo | [`packages/agent-entrypoint`](packages/agent-entrypoint) |
| Learn how to design production-ready AI agent systems | [`packages/agent-engineering-playbook`](packages/agent-engineering-playbook) |
| Onboard a team to working with AI in a coding workflow | [`packages/agentic-coding-playbook`](packages/agentic-coding-playbook) |

## Packages

### Linting
| Package | Description |
|---------|-------------|
| [slop-detector](packages/slop-detector) | Configurable AI-slop linter for PRs and committed content. Two regex packs in v0.1 (`agent-tics`, `prose-slop`); AST and UI packs roadmapped. |

### Scaffolding
| Package | Description |
|---------|-------------|
| [agent-dev-kit](packages/agent-dev-kit) | CLI scaffolding tool for AI agent development. Creates the file layout, hooks, and entrypoints that the rest of the stack expects. |
| [agent-entrypoint](packages/agent-entrypoint) | Generate and validate `AGENT_ENTRYPOINT.yaml` for repos: a single declarative file that tells an agent what this repo is and how to enter it. |

### Playbooks
| Package | Description |
|---------|-------------|
| [agent-engineering-playbook](packages/agent-engineering-playbook) | Guide for building production-ready AI agent systems. |
| [agentic-coding-playbook](packages/agentic-coding-playbook) | Practical playbook for teams using AI agents in coding. |

## Why this exists

LLMs leave fingerprints. Some are objectively wrong, like leaked `</result>` artefacts from MCP serialisation. Others are stylistic tics the team has already decided to avoid: em-dashes in prose, `It is important to note` openers, empty marketing adjectives, doubled `## Summary` blocks. None are caught by tests, typecheck, or human reviewers under load. They accumulate.

Concrete data point: when `slop-detector` ran for the first time against the bodies of the 20 most recent merged PRs across LanNguyenSi/, it found 38 real violations (27 em-dashes, 11 auto-appended Claude Code footers) across 13 of the 20 PRs. Zero false positives. Every one of those PRs had been written by an agent, reviewed, and merged before the linter existed. The tool's first run was a quiet receipt.

`agent-dx` is the kit that closes that loop:

- **Lint at commit time**, not at "I noticed three months later". `slop-detector` runs in pre-commit, in CI as a status check, or as `npx slop-detector check` ad-hoc.
- **Scaffold once**, get the conventions for free. `agent-dev-kit` and `agent-entrypoint` shape repos so agents can navigate them without prompting tricks.
- **Codify the conventions** so a new contributor (human or agent) can read them. The two playbooks are the written form of the rules the linter encodes.

## Status

Experimental: functional tools with tests, APIs may evolve at minor-version bumps. Each package has its own README with install + usage; this top-level README is a routing index.

## Where this fits

`agent-dx` contributes the authoring-side tooling to the [Project OS](https://github.com/LanNguyenSi/project-os) human-agent dev lifecycle: scaffolds before code is written, lints before code is committed, playbooks that codify the team's conventions. It sits alongside the rest of the stack:

- [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) plans
- [agent-tasks](https://github.com/LanNguyenSi/agent-tasks) coordinates
- [agent-grounding](https://github.com/LanNguyenSi/agent-grounding) verifies (evidence ledger, claim gate, hypothesis tracker)
- [agent-preflight](https://github.com/LanNguyenSi/agent-preflight) gates pushes
- [harness](https://github.com/LanNguyenSi/harness) declares + enforces the policy boundary that calls into all of the above

[scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) and [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) are standalone tools used by [project-forge](https://github.com/LanNguyenSi/project-forge).
