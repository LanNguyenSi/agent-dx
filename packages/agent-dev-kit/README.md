# Agent Dev Kit

CLI scaffolding tool for AI agent projects with optional Memory, Triologue and Skills support.

## Overview

`agent-dev-kit` generates a runnable agent project skeleton (TypeScript or JavaScript) with a passing default test, optional feature modules, and `.ai/` context files for humans and agents to keep in sync as the project grows.

## Install / quick start

Not published to npm; run it from a local build of this monorepo:

```bash
git clone https://github.com/LanNguyenSi/agent-dx
cd agent-dx/packages/agent-dev-kit && npm install && npm run build
node dist/cli.js create my-agent --features=memory,skills
```

## Usage

The package's bin name is `agent-dev` (`npm link` from the package directory puts it on `PATH`); the examples below assume that. Without linking, run `node dist/cli.js <command>` instead.

```bash
agent-dev create my-agent --features=memory,triologue,skills
```

This creates a project with:

- `.ai/` context files for architecture, tasks and decisions
- `src/index.ts` or `src/index.js` as the runtime entrypoint
- `src/index.test.ts` or `src/index.test.js` as a passing default test
- `src/memory/` with a local stub store when `memory` is enabled
- `src/skills/` with a loader, example skill and `SKILL.md` when `skills` is enabled
- Triologue bootstrap code in the main entrypoint when `triologue` is enabled

Other commands:

```bash
agent-dev add-feature memory
agent-dev add-feature triologue
agent-dev add-feature skills
agent-dev generate-skill release-notes --description "Generate release notes from changelog entries"
```

Available feature flags: `memory`, `triologue`, `skills`. Flags are parsed strictly: `memory, skills` works, an unknown feature name fails fast with an error.

## Key features

- `npm test` passes immediately in the generated project via a bundled Vitest smoke test
- TypeScript projects include `build`, `dev`, `start` and `test` scripts; JavaScript projects include `dev`, `start` and `test`
- `.env.example` only contains variables the generated scaffold actually uses
- Git initialization skips the first commit cleanly when `user.name` or `user.email` is missing

## Documentation

- [tasks/README.md](./tasks/README.md): implemented task backlog

## Development

```bash
npm install
npm run format:check
npm run build
npm test
```

## License

MIT
