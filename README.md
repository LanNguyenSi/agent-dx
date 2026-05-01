# Agent DX

**Developer Experience · Playbooks and tooling for teams building with AI agents.** Ship agent systems the way you'd ship any production software, with scaffolds, entrypoints, and playbooks that keep humans and agents in sync.

## Role in the Project OS pipeline

Agent DX is the onboarding and day-to-day surface of the [Project OS](https://github.com/LanNguyenSi/project-os) pipeline. It sits alongside [agent-tasks](https://github.com/LanNguyenSi/agent-tasks) (work coordination), [agent-preflight](https://github.com/LanNguyenSi/agent-preflight) (pre-merge gates), and [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) (planning); Agent DX is where engineers pick up the conventions, scaffolds, and entrypoints the rest of the pipeline expects.

## Packages

| Package | Description |
|---------|-------------|
| [agent-dev-kit](packages/agent-dev-kit) | CLI scaffolding tool for AI agent development |
| [agent-entrypoint](packages/agent-entrypoint) | Generate and validate AGENT_ENTRYPOINT.yaml for repos |
| [slop-detector](packages/slop-detector) | Configurable AI-slop linter for PRs and committed content |
| [agent-engineering-playbook](packages/agent-engineering-playbook) | Guide for building production-ready AI agent systems |
| [agentic-coding-playbook](packages/agentic-coding-playbook) | Practical playbook for teams using AI agents in coding |

## Note

[scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) and [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) are standalone tools in the [Project OS](https://github.com/LanNguyenSi/project-os) pipeline; they have runtime dependencies and are used by [project-forge](https://github.com/LanNguyenSi/project-forge).
