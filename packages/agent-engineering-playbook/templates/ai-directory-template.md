# `.ai/` Directory Template

Use this template to bootstrap the `.ai/` directory for a new project. Copy the files below into your project root as `.ai/AGENTS.md`, `.ai/ARCHITECTURE.md`, `.ai/TASKS.md`, and `.ai/DECISIONS.md`.

---

## `.ai/AGENTS.md`

```markdown
# Agents

## Team

| Role | Name | Scope | Permissions |
|------|------|-------|-------------|
| Engineering Lead | [name] | architecture, review, release | full |
| AI Agent | [agent name] | implementation, tests, docs | tier-2 (commit, PR — no deploy) |
| AI Agent | [agent name] | refactoring, migrations | tier-2 |

## Workflow

1. Tasks are defined in `.ai/TASKS.md` with clear acceptance criteria.
2. Agents pick up tasks and create feature branches.
3. All agent work requires human review before merge.
4. Agents must not modify files outside their assigned scope without approval.

## Code Standards

- [language] with [framework]
- formatting: [tool] (enforced by CI)
- test coverage: [minimum threshold]
- commit messages: conventional commits
- PR attribution: include `Co-Authored-By` for agent contributions

## What Agents Must Not Do

- deploy to production
- modify CI/CD pipelines without review
- change security-sensitive code (auth, crypto) without explicit task assignment
- approve their own PRs
- skip linting or test runs
```

---

## `.ai/ARCHITECTURE.md`

```markdown
# Architecture

## Overview

[One paragraph: what the system does, who it serves, and why it exists.]

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | [e.g., Next.js, React, Tailwind] |
| Backend | [e.g., Node.js, Express, Prisma] |
| Database | [e.g., PostgreSQL, Redis] |
| Infrastructure | [e.g., Docker, Traefik, VPS] |
| CI/CD | [e.g., GitHub Actions] |

## Structure

```
project/
├── frontend/        # [brief description]
├── backend/         # [brief description]
├── database/        # migrations, seeds
├── .ai/             # agent context (this directory)
└── docs/            # human documentation
```

## Key Patterns

- [e.g., modular monolith with clear service boundaries]
- [e.g., server-side rendering with client hydration]
- [e.g., event-driven communication between services]

## Data Flow

[Brief description of how data moves through the system.]

## Deployment

- environment: [production URL, staging URL]
- deploy method: [e.g., Docker Compose on VPS, Kubernetes, serverless]
- secrets: [where they live, how they are managed]

## Constraints

- [e.g., must run on a single VPS with 4GB RAM]
- [e.g., no external SaaS dependencies for core functionality]
- [e.g., GDPR compliance required for user data]
```

---

## `.ai/TASKS.md`

```markdown
# Tasks

## Current Sprint

| ID | Task | Priority | Status | Assignee |
|----|------|----------|--------|----------|
| T-001 | [task description] | high | in-progress | [agent/human] |
| T-002 | [task description] | medium | open | unassigned |
| T-003 | [task description] | low | open | unassigned |

## Completed

| ID | Task | Completed | Notes |
|----|------|-----------|-------|
| T-000 | [task description] | YYYY-MM-DD | [brief outcome] |

## Backlog

- [future task idea]
- [future task idea]

## Rules

- each task must have clear acceptance criteria before work begins
- agents should update status when starting and completing tasks
- blocked tasks must note what they are waiting for
```

---

## `.ai/DECISIONS.md`

```markdown
# Decisions

Architecture and engineering decisions that shape how agents should work in this project.

## Active Decisions

### D-001: [Decision Title]

- **Date:** YYYY-MM-DD
- **Status:** accepted
- **Context:** [why this decision was needed]
- **Decision:** [what was decided]
- **Consequences:** [what this means for implementation]
- **Agent impact:** [how this affects what agents should or should not do]

### D-002: [Decision Title]

- **Date:** YYYY-MM-DD
- **Status:** accepted
- **Context:**
- **Decision:**
- **Consequences:**
- **Agent impact:**

## Superseded

| ID | Title | Superseded By | Date |
|----|-------|---------------|------|
```

---

## Usage Notes

- Keep all `.ai/` files concise. Agents share context window with the code they are working on.
- Update `.ai/TASKS.md` frequently — it is the primary coordination mechanism.
- Update `.ai/ARCHITECTURE.md` when the stack, structure, or deployment model changes.
- Update `.ai/DECISIONS.md` when new decisions affect how agents should work.
- `.ai/` complements standard docs (README, CONTRIBUTING, ADRs). It does not replace them.
- Review `.ai/` changes in PRs with the same rigor as code changes.
