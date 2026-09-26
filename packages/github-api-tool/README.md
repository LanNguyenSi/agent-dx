# GitHub API Tool

A command-line interface for GitHub API operations, designed for AI agents.

> **Internal tool, not published to npm.** This CLI is used from source within this repo (`private: true`). Build and run it from the repo (`npm run build`) rather than installing from npm.

## Overview

`github` wraps Octokit behind a scriptable CLI: issue and pull-request management, repository info, and a cross-repo standup digest, all with a `--json` mode for programmatic use and automatic retry with exponential backoff on transient failures.

## Key features

- Issue management: create, list, assign, comment, close
- Pull request operations: list, comment, review, merge
- Repository info: commits, contributors, repository details
- Cross-repo standup digest for daily or async updates
- `--json` output on the issue, PR, repo, standup, bug-report, and coverage-check commands for programmatic use
- Automatic retry with exponential backoff on 5xx/429 responses

## Install / quick start

```bash
npm install
npm run build
npm link  # make the 'github' command globally available
```

Set a GitHub Personal Access Token, either way:

```bash
github config set-token <your-github-pat>
# or
export GITHUB_TOKEN=<your-github-pat>
```

Required token scopes: `repo` (issues, PRs, commits) and `read:org` (contributors).

## Usage

```bash
github issue list --repo owner/repo --state open --json
```

See [Command reference](./docs/commands.md) for every command, the agent-integration pattern, the source layout, and error handling.

## Documentation

- [Command reference](./docs/commands.md): issue, PR, repository, standup, bug-report, and coverage-check commands, JSON mode, agent integration, source layout, error handling
- [SKILL.md](./SKILL.md): agent skill documentation
- [ENGINEERING.md](./ENGINEERING.md): engineering standards this package follows

## Development

```bash
npm run build
npm run watch   # auto-rebuild on changes
npm test
node dist/index.js --help
```

## License

MIT
