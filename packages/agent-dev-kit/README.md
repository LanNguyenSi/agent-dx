# Agent Dev Kit

CLI scaffolding tool for AI agent projects with optional Memory and Skills support.

## Overview

`agent-dev-kit` generates a runnable agent project skeleton (TypeScript or JavaScript) with a passing default test, optional feature modules, and `.ai/` context files for humans and agents to keep in sync as the project grows.

## Install / quick start

Not published to npm; run it from a local build of this monorepo:

```bash
git clone https://github.com/LanNguyenSi/agent-dx
cd agent-dx/packages/agent-dev-kit && npm install && npm run build && npm link
cd /path/to/your/workspace
agent-dev create my-agent --features=memory,skills
```

`create` writes the project into the current directory, so run it outside the agent-dx clone.

## Usage

The package's bin name is `agent-dev` (`npm link` from the package directory puts it on `PATH`); the examples below assume that. Without linking, run `node <path-to-agent-dx>/packages/agent-dev-kit/dist/cli.js <command>` instead.

```bash
agent-dev create my-agent --features=memory,skills
```

`create <name>` options:

- `-f, --features <list>`: `memory`, `skills`. Without it, `create` prompts for features and an agent description; pass `--features` for non-interactive use.
- `--no-typescript`: generate JavaScript instead of TypeScript.
- `--no-git`: skip `git init`, `git add .` and the initial commit.
- `--no-install`: skip `npm install` in the new project.

`create` writes to `./<name>` in the current directory and stops if that directory exists and is not empty.

This creates a project with:

- `.ai/` context files: `AGENTS.md`, `ARCHITECTURE.md`, `TASKS.md`, `DECISIONS.md`
- `src/index.ts` or `src/index.js` as the runtime entrypoint
- `src/index.test.ts` or `src/index.test.js` as a passing default test
- `src/memory/` with a local stub store when `memory` is enabled
- `src/skills/` with a loader, example skill and `SKILL.md` when `skills` is enabled

Other commands:

```bash
agent-dev add-feature memory
agent-dev add-feature skills
agent-dev generate-skill release-notes --description "Generate release notes from changelog entries"
```

Run `add-feature` and `generate-skill` from the root of a project created by `agent-dev create`. `generate-skill` needs the `skills` feature (add it with `agent-dev add-feature skills`); it writes `src/skills/<slug>.(ts|js)` and `src/skills/<slug>/SKILL.md`, keeps files that already exist, and registers the skill in the loader.

Available feature flags: `memory`, `skills`. Flags are parsed strictly: `memory, skills` works, an unknown feature name (including a previously removed `triologue` feature) fails fast with an error.

## Key features

- `npm test` passes immediately in the generated project via a bundled Vitest smoke test
- TypeScript projects include `build`, `dev`, `start` and `test` scripts; JavaScript projects include `dev`, `start` and `test`
- `.env.example` sets `AGENT_NAME` (read by the generated agent) and `NODE_ENV`, plus `MEMORY_BACKEND=local` with the memory feature as a placeholder; the generated memory store is always the local in-process store
- Git initialization skips the first commit cleanly when `user.name` or `user.email` is missing

## Development

```bash
npm install
npm run format:check
npm run typecheck
npm run typecheck:test
npm run build
npm test
bash scripts/smoke-scaffold.sh   # scaffold into a temp dir and check the generated files (needs the build)
```

## License

MIT
