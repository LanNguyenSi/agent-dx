# Agent Dev Kit

CLI scaffolding tool for AI agent projects with optional Memory, Triologue and Skills support.

## What It Generates

`agent-dev create my-agent --features=memory,triologue,skills` creates a project with:

- `.ai/` context files for architecture, tasks and decisions
- `src/index.ts` or `src/index.js` as the runtime entrypoint
- `src/index.test.ts` or `src/index.test.js` as a passing default test
- `src/memory/` with a local stub store when `memory` is enabled
- `src/skills/` with a loader, example skill and `SKILL.md` when `skills` is enabled
- Triologue bootstrap code in the main entrypoint when `triologue` is enabled

## Usage

```bash
agent-dev create my-agent --features=memory,skills
```

Weitere Commands:

```bash
agent-dev add-feature memory
agent-dev add-feature triologue
agent-dev add-feature skills
agent-dev generate-skill release-notes --description "Generate release notes from changelog entries"
```

Available feature flags:

- `memory`
- `triologue`
- `skills`

Flags are parsed strictly. Inputs like `memory, skills` work, unknown feature names fail fast with a clear error.

## Generated Project Defaults

- `npm test` passes immediately via a bundled Vitest smoke test
- TypeScript projects include `build`, `dev`, `start` and `test` scripts
- JavaScript projects include `dev`, `start` and `test` scripts
- `.env.example` only contains variables that the generated scaffold actually uses
- Git initialization skips the first commit cleanly when `user.name` or `user.email` is missing

## Development

```bash
npm install
npm run format:check
npm run build
npm test
```

## Backlog

Implemented task records remain in [tasks/README.md](./tasks/README.md).
