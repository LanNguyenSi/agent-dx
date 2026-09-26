# agent-dx

A monorepo workshop for agent-development tooling, built while shipping AI-agent coding workflows in practice.

## Overview

`agent-dx` collects the CLIs, linters, and playbooks used to build and review AI-agent coding workflows across this workshop and its sibling repos. It is a folder of independent packages, not an npm workspaces, pnpm, or lerna monorepo: there is no root `package.json` and no shared root `node_modules`. Three packages ship on npm today: orchestrator-workflow, okf-kit, and agent-primitives. The rest are working tools or documentation packages. See [Repo layout and package status](docs/repo-layout.md) for how the packages relate to each other.

## Packages

| Package | What it does | npm |
|---------|--------------|-----|
| [orchestrator-workflow](packages/orchestrator-workflow) | Installer for an orchestrator-led agent workflow: `.ai/` run state, an `AGENTS.md` policy section, and subagent definitions with preselected models for Claude Code, Codex, and opencode. | published |
| [okf-kit](packages/okf-kit) | CLI that validates OKF v0.1 knowledge bundles: frontmatter shape, reserved files, link resolution, absolute-link warnings, `sources` shape. | published |
| [agent-primitives](packages/agent-primitives) | Agent-first CLI: bounded JSON envelopes, a mutation-probe runner, a verify runner, and a PATH doctor, plus an `init` command that installs its own skill document into a harness's skill directory. | published |
| [slop-detector](packages/slop-detector) | AI-slop linter for PRs: catches leaked tool-call XML, doubled Summary headings, hedging openers, marketing adjectives, and other agent-generated tells across eight rule packs. | not published (name taken by an unrelated package; run from a local build) |
| [agent-dev-kit](packages/agent-dev-kit) | CLI scaffolding for AI agent projects: file layout, hooks, entrypoints. | not published |
| [friction-log](packages/friction-log) | Capture, query, and infer agent-workflow frictions. SQLite-backed, sink-pluggable, zero-config default. | not published |
| [git-batch-cli](packages/git-batch-cli) | Run safe batch git operations across all repos under a folder: sync, status, dirty checks, fetch, with `--strict` for automation. | not published |
| [mcp-token-audit](packages/mcp-token-audit) | Ranks tool calls in Claude Code transcripts by approximate token cost per tool name, with an `mcp__*` share of the total. | not published |
| [github-api-tool](packages/github-api-tool) | TypeScript CLI for GitHub API operations (issues, PRs, commits, standup digests), JSON output for agents calling via `exec`. | private |
| [agent-engineering-playbook](packages/agent-engineering-playbook) | Guide for building production-ready AI agent systems. | doc package |
| [agentic-coding-playbook](packages/agentic-coding-playbook) | Practical playbook for teams using AI agents in coding. | doc package |

## Quick start

Requires Node.js >= 20 (CI runs on Node 22).

Try one of the published CLIs directly:

```bash
npx orchestrator-workflow init
npx okf-kit check path/to/bundle
```

For any other package, clone the repo, then build that one package locally:

```bash
git clone https://github.com/LanNguyenSi/agent-dx
cd agent-dx/packages/<name>
npm install
npm run build
```

## Usage

Example: run the AI-slop linter against a Markdown file from a local build.

```bash
cd packages/slop-detector && npm install && npm run build && cd ../..
node packages/slop-detector/dist/cli.js check examples/slop-sample.md --explain
```

## Documentation

- [Repo layout and package status](docs/repo-layout.md): why this is not a workspace monorepo, and which packages are published, private, or doc-only.
- [Where this fits](docs/ecosystem.md): how `slop-detector` and this workshop relate to the sibling Project OS repos.
- [CI checks on this repository](docs/ci-checks.md): what `placement-guard`, `review-guard`, and the OKF bundle prose guard enforce.
- `slop-detector` overview and quick start: [packages/slop-detector/README.md](packages/slop-detector/README.md); full pack reference and the scan pipeline: [packages/slop-detector/docs/rule-packs.md](packages/slop-detector/docs/rule-packs.md) and [packages/slop-detector/docs/integration.md](packages/slop-detector/docs/integration.md).
- Each package's own README covers its full install, usage, and API.

## Development and contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for issue and PR conventions, the dev setup per package (`npm install`, `npm run build`, `npm test`), and the release process.

## License

MIT, see [LICENSE](LICENSE). Experimental: each package has its own version and CI, and APIs may evolve at minor-version bumps.
