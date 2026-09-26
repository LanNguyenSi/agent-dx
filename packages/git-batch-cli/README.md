# git-batch-cli

CLI for running safe batch operations across all Git repositories directly below a folder.

Part of [`agent-dx`](https://github.com/LanNguyenSi/agent-dx). Source: `packages/git-batch-cli`.

## Overview

`git-batch` scans the current level (or a custom root folder) for direct child folders that contain `.git`, checks each repository's local state, and runs safe batch operations across all of them: status reporting, fetching, and fast-forward-only syncing. It skips dirty repositories by default and never force-pushes or rewrites history, which makes it a fit for a shared multi-repo workspace where several checkouts sit side by side.

## Key features

- `sync`: fetch, detect the protected branch, and `git pull --ff-only` across every repository, skipping dirty ones
- `status`: branch, upstream, ahead/behind distance, and change counters, with `--fetch` for a live refresh
- `--json` and `--strict` on every command, for safe use from agents and CI (deterministic ordering, no prompts)
- `--only` / `--exclude` repository filters (substring or regex)

## Install / quick start

Requires Node.js 20 or later. Not published to npm; link it from a local checkout:

```bash
cd packages/git-batch-cli
npm install
npm link
```

After that, the `git-batch` command is available in your shell.

## Usage

```bash
git-batch sync ~/git
git-batch status ~/git --fetch --json
```

## Documentation

- [Command reference](./docs/commands.md): every subcommand, option, repository filter, branch-detection order, output model, agent/CI usage, and the open roadmap

## Development

```bash
npm test
```

Built and tested as part of the agent-dx monorepo CI matrix in [`.github/workflows/ci.yml`](https://github.com/LanNguyenSi/agent-dx/blob/master/.github/workflows/ci.yml).

## License

MIT. See [LICENSE](./LICENSE).
