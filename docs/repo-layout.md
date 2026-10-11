# Repo layout and package status

`agent-dx` is a folder of independent packages, not an npm workspaces, pnpm,
or lerna monorepo. There is no root `package.json`, no workspace manifest,
and no shared root `node_modules`. Each package under `packages/` carries
its own `package.json`, install, build, test, and version, so the install
pattern is the same for every local-build package:

```bash
cd packages/<name> && npm install && npm run build
```

`git-batch-cli` is plain JavaScript and has no build step: run `npm install && npm link` in its directory instead.

If you only care about one package, work in its directory; nothing at the
root needs to be set up first.

## Package status

- `orchestrator-workflow` and `okf-kit` are published to npm with tagged
  releases.
- `agent-primitives` and `friction-log` are published to npm.
- `slop-detector` is deliberately unpublished: the bare `slop-detector` name
  on npm belongs to an unrelated third-party package. It runs from a local
  build (see the root README's Quick start and Usage) and ships an MCP server
  alongside the CLI.
- `agent-dev-kit`, `git-batch-cli`, and `mcp-token-audit` are
  functional CLIs, not yet published to npm.
- `github-api-tool` is marked private in its own `package.json`.
- `agent-engineering-playbook` and `agentic-coding-playbook` are
  documentation packages, not code: they have no `package.json`.

Each package has its own version, README, and CI. APIs may evolve at
minor-version bumps; this workshop as a whole is experimental.

## Playbook site

`site/` is the one directory outside `packages/` with its own `package.json`.
It is private, not a package, and builds a static
[VitePress](https://vitepress.dev) site from the Markdown of
`agent-engineering-playbook` and `agentic-coding-playbook`, which stay where
they are and remain the source. The sidebar is generated from the file tree
with titles from each file's first H1, directory links land on the folder's
README, and the build fails on a relative link whose target inside the
repository does not exist (Markdown pages, folders, and other files alike).

```bash
cd site && npm ci && npm run build   # output in site/.vitepress/dist
cd site && npm run dev               # local preview with search
```

`.github/workflows/pages.yml` builds the site on pull requests that touch
`site/` or the two playbooks, and deploys it to GitHub Pages on pushes to
`master` or a manual run on `master`.
