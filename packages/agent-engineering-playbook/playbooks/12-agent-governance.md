# 12 - Agent Governance

AI agents are force multipliers, but force without governance creates risk at scale. This chapter defines the controls that keep agent-assisted delivery fast, auditable, and safe.

## When To Apply

Start with lightweight boundaries as soon as agents contribute to code that reaches production. Formalize governance when:

- multiple agents operate in the same codebase
- agents interact with production systems (deploys, databases, APIs)
- compliance or audit obligations require attribution of changes
- agent-generated output is reviewed less rigorously than human output

## Governance Lens: Spec, Context, Eval

Agent governance works best when it is operational instead of abstract:

- spec-driven governance: agents should act on explicit task definitions, not vague intent
- context-driven governance: project context should be versioned and reviewed because it shapes agent behavior
- eval-driven governance: agent usefulness and safety should be measured through review quality, test evidence, and release outcomes

## Permission Model

Define what agents are allowed to do. A simple three-tier model:

### Tier 1 — Autonomous

Agent may act without human confirmation:

- read code and documentation
- generate drafts (code, tests, docs, refactors)
- run local tests and linters
- suggest architectural options

### Tier 2 — Assisted

Agent may act, but a human must review before the result takes effect:

- create commits and pull requests
- modify CI/CD configuration
- change database schemas or migrations
- update security-sensitive code (auth, crypto, access control)
- modify `.ai/` context files

### Tier 3 — Prohibited

Agent must not act, even with review:

- approve its own pull requests
- deploy to production without human sign-off
- delete production data or backups
- disable security controls, monitoring, or alerts
- create or modify access credentials autonomously
- bypass required review gates (`--no-verify`, force-push to main)

### Implementing Permissions

Permissions should be enforced structurally, not just by convention:

- CI checks that reject PRs authored and approved by the same agent identity
- branch protection rules that require human reviewers
- deploy pipelines gated on human approval for production targets
- file-level CODEOWNERS that require human review for sensitive paths

## Audit Trail

Every agent action that modifies the system should be traceable.

### Minimum Requirements

- agent-generated commits must include attribution (e.g., `Co-Authored-By` trailer)
- PR descriptions must disclose agent involvement and scope
- deploy logs must record whether the change was agent-assisted
- session logs should capture the prompt or task that triggered agent work

### What To Log

| Event | Required Fields |
|-------|----------------|
| Code generation | agent identity, task reference, files changed, reviewer |
| PR creation | agent identity, branch, human reviewer, merge timestamp |
| Deploy trigger | who initiated, agent involvement, environment, rollback plan |
| Config change | agent identity, what changed, approval chain |
| Data access | agent identity, scope, purpose, timestamp |

### Retention

Audit logs for agent actions should follow the same retention policy as human change logs. For enterprise environments, retain for the duration required by your compliance framework.

## Prompt Management

Prompts are the source code of agent behavior. Treat them accordingly.

### Versioning

- store system prompts and agent instructions in version control
- use the `.ai/` directory for project-specific agent context
- tag prompt versions alongside application releases
- review prompt changes with the same rigor as code changes

### Drift Prevention

Prompt drift occurs when agent behavior changes without deliberate decision. Prevent it by:

- defining canonical prompts in versioned files, not ad-hoc chat
- reviewing `.ai/` files in pull requests like any other code
- periodically validating that agent output still matches team expectations
- documenting prompt changes in ADRs when they affect architecture or workflow

## Agent Review Standards

Agent-generated code must meet the same quality bar as human code. Additional review considerations:

### What Reviewers Should Check

- correctness of the implementation, not just plausibility
- whether the agent introduced unnecessary complexity or over-engineering
- whether security boundaries are respected (no hardcoded secrets, no disabled checks)
- whether tests actually verify behavior or just assert the happy path
- whether the change matches the stated task scope (agents sometimes drift)

### Red Flags In Agent Output

- large changes with vague commit messages
- disabled linting rules or test suites
- new dependencies without justification
- code patterns inconsistent with the existing codebase
- security-sensitive changes buried in large refactors

## Multi-Agent Coordination

When multiple agents operate in the same codebase:

- assign agents to non-overlapping areas to reduce merge conflicts
- use task management (`.ai/TASKS.md`) to coordinate work allocation
- define a clear priority model when agent outputs conflict
- ensure each agent reads the same `.ai/` context to prevent divergent assumptions
- designate a human coordinator who resolves cross-agent conflicts

## Incident Response With Agents

When an incident involves agent-generated code:

- identify which agent produced the change and what prompt triggered it
- treat the root cause analysis the same as for human-authored code
- determine whether the failure was in the prompt, the agent behavior, or the review process
- update agent permissions or prompts as a corrective action if needed
- do not blame the agent; fix the system that allowed the failure to reach production

## Metrics

Track agent governance health:

- percentage of agent-generated PRs with human review before merge
- agent-generated change failure rate vs. human change failure rate
- time from agent PR creation to human review
- number of agent permission violations caught by CI
- prompt version currency (are agents using current context?)

## Anti-Patterns

### Agent As Rubber Stamp

Routing agent output through review without actually reading it. If review quality drops because "the agent wrote it," the governance model has failed.

### Permission Creep

Gradually allowing agents to do more without updating the permission model. Every expansion should be a deliberate decision.

### Invisible Agent Work

Agent contributions that are not attributed or logged. If you cannot tell which changes were agent-assisted after the fact, your audit trail is broken.

### Prompt As Tribal Knowledge

System prompts that live only in individual chat sessions or local configs. If the prompt is not in version control, it is not governed.

## Exit Criteria

Agent governance is credible when:

- agent permissions are documented and structurally enforced
- every agent-generated change is attributable and reviewable
- prompts are versioned and reviewed like code
- agent-generated code passes the same quality gates as human code
- incident investigations can trace agent involvement end-to-end
