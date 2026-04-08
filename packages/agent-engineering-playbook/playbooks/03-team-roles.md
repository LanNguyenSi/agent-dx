# 03 - Team Roles

Build clear ownership models for human teams and AI agents without creating single points of failure.

## Why This Chapter Exists

Many AI-assisted teams move fast by centralizing decisions in one strong lead. That can work briefly, but it does not scale well to enterprise products. Enterprise delivery needs:

- explicit ownership
- separation of duties where risk requires it
- review capacity that survives vacations and incidents
- operational accountability after the code is merged

The right model is not "three perfect roles." The right model is a clear decision system.

## Core Rule

Every critical area must have:

- one accountable owner
- at least one competent backup
- a documented escalation path

If your process depends on one reviewer, one deployer, or one agent prompt author, it is fragile.

## Recommended Role Model

Use these responsibilities as a baseline. One person may hold multiple roles on a small team, but the responsibilities must still exist.

### Product Owner

Owns:

- problem definition
- priorities
- release goals
- acceptance criteria

Should not be the only reviewer for technical controls.

### Engineering Lead

Owns:

- technical direction
- architecture decisions
- engineering standards
- delivery risk and tradeoff calls

Should not become the permanent bottleneck for every review and merge.

### Developers

Own:

- implementation
- local verification
- maintaining code health in their areas
- improving tests and docs with the code change

Should be empowered to review each other when standards are clear.

### QA / Test Owner

Owns:

- test strategy execution
- release confidence signals
- defect triage
- regression coverage for critical flows

This can be a dedicated QA function or a rotating engineering responsibility.

### Platform / SRE

Owns:

- CI/CD platform
- runtime configuration
- observability
- incident readiness
- backup and recovery readiness

### Security / Privacy Owner

Owns:

- threat modeling
- secure defaults
- vulnerability handling
- data handling rules
- compliance-related controls

This does not need to be a separate team on day one, but it must not be absent.

### AI Agent Operator

Owns:

- defining agent boundaries
- validating what agents may change autonomously
- ensuring traceability of agent-generated changes
- reducing prompt drift and undocumented tribal behavior

This responsibility usually sits with an engineering lead or staff engineer.

## RACI For Typical Decisions

| Area | Product | Eng Lead | Developer | QA | Platform/SRE | Security |
|------|---------|----------|-----------|----|--------------|----------|
| Scope and priority | A | C | I | I | I | I |
| Architecture | C | A | R | I | C | C |
| Implementation | I | C | A/R | C | I | I |
| Test strategy | C | C | R | A | I | I |
| Production rollout | I | C | I | C | A/R | C |
| Security controls | I | C | R | I | C | A |
| Incident response | I | C | R | I | A | C |

`A` = accountable, `R` = responsible, `C` = consulted, `I` = informed.

## How AI Agents Fit

Treat agents like high-leverage contributors with constrained permissions, not like autonomous owners.

Agents may:

- draft code, tests, docs, and refactors
- summarize architectural options
- generate checklists and migration plans
- assist with repetitive review and compliance checks

Agents should not be the sole authority for:

- production approvals
- incident decisions
- security sign-off
- irreversible data migrations
- changes that bypass required review gates

## Anti-Patterns

### Single Reviewer For Everything

This creates review queues, consistency risk, and organizational fragility.

### Lead As Permanent Firefighter

If the lead plans, reviews, fixes, deploys, and owns incidents, the system is under-instrumented and under-delegated.

### Developers With No Product Context

Strong specs help, but engineers and agents still need outcome context to make safe tradeoffs.

### Agents With Hidden Local Conventions

If correctness depends on unwritten agent habits, the process is not robust enough.

## Scaling Guidance

For a small product team:

- one product owner
- one engineering lead
- two to six developers
- shared QA and platform responsibilities

For a larger product area:

- multiple domain owners
- explicit release management
- security and platform represented in planning
- documented service ownership and on-call coverage

## Exit Criteria

Your role model is ready when:

- every system has an owner
- every critical owner has backup coverage
- production changes have explicit approval rules
- on-call and incident paths are defined
- AI-generated work is reviewable and attributable
