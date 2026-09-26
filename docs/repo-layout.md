# Repo layout and package status

`agent-dx` is a folder of independent packages, not an npm workspaces, pnpm,
or lerna monorepo. There is no root `package.json`, no workspace manifest,
and no shared root `node_modules`. Each package under `packages/` carries
its own `package.json`, install, build, test, and version, so the install
pattern is the same for every local-build package:

```bash
cd packages/<name> && npm install && npm run build
```

If you only care about one package, work in its directory; nothing at the
root needs to be set up first.

## Package status

- `orchestrator-workflow` and `okf-kit` are published to npm with tagged
  releases.
- `agent-primitives` is published to npm.
- `slop-detector` is deliberately unpublished: the bare `slop-detector` name
  on npm belongs to an unrelated third-party package. It runs from a local
  build (see the root README's Quick start) and ships an MCP server
  alongside the CLI.
- `agent-dev-kit`, `friction-log`, `git-batch-cli`, and `mcp-token-audit` are
  functional CLIs, not yet published to npm.
- `github-api-tool` is marked private in its own `package.json`.
- `agent-engineering-playbook` and `agentic-coding-playbook` are
  documentation packages, not code: they have no `package.json`.

Each package has its own version, README, and CI. APIs may evolve at
minor-version bumps; this workshop as a whole is experimental.
