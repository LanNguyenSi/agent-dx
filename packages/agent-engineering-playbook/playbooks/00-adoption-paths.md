# 00 - Adoption Paths

This playbook tells an engineer or agent how much of the repository to apply at a given stage. The goal is proportional rigor: enough control for the current phase, without pretending early projects need full enterprise ceremony.

If an agent needs structured input instead of prose, use [models/adoption-model.json](../models/adoption-model.json).

## The Two Paths

### Core Path

Use this for nearly every serious product effort.

It covers:

- project framing
- architecture basics
- team ownership
- design discipline
- development workflow
- testing
- quality gates
- documentation
- production readiness

Core path means "build something that can survive production," not "build a toy quickly."

### Enterprise Path

Add this when the product has higher consequences or external obligations.

It adds:

- security governance
- access review and auditability
- threat modeling
- exception handling
- change classification
- formal incident discipline
- stronger release approvals

Enterprise path is an extension of the core path, not a replacement for it.

## Project Phases

### Phase 0: Exploration

Typical conditions:

- still validating the problem
- no real customer data
- low blast radius
- fast iteration matters more than scale

Use:

- minimal parts of [01-project-setup.md](01-project-setup.md)
- essential architecture notes from [02-architecture.md](02-architecture.md)
- basic design discipline from [04-design-principles.md](04-design-principles.md)
- lightweight tasking and docs from [08-documentation.md](08-documentation.md)

Do not skip:

- basic ownership
- secret hygiene
- source control hygiene

Usually defer:

- formal security review
- full incident process
- enterprise change approval

### Phase 1: Product Build

Typical conditions:

- active implementation toward first usable release
- real feature work underway
- early users or internal stakeholders
- production is plausible in the near term

Use the core path as default:

- [01-project-setup.md](01-project-setup.md)
- [02-architecture.md](02-architecture.md)
- [03-team-roles.md](03-team-roles.md)
- [04-design-principles.md](04-design-principles.md)
- [05-development-workflow.md](05-development-workflow.md)
- [06-testing-strategy.md](06-testing-strategy.md)
- [07-quality-assurance.md](07-quality-assurance.md)
- [08-documentation.md](08-documentation.md)

Start preparing:

- [09-production.md](09-production.md)
- selected parts of [11-change-management-and-incidents.md](11-change-management-and-incidents.md) if the system is user-facing

### Phase 2: Production

Typical conditions:

- live users depend on the system
- outages matter
- rollbacks and observability are necessary
- support or on-call expectations begin

Mandatory:

- full core path
- [09-production.md](09-production.md)
- operational parts of [11-change-management-and-incidents.md](11-change-management-and-incidents.md)

Add enterprise controls selectively when:

- sensitive data is handled
- admin or privileged capabilities exist
- external customer commitments increase

### Phase 3: Enterprise / Regulated / High-Trust

Typical conditions:

- enterprise customers or procurement reviews
- sensitive personal, financial, or business-critical data
- auditability requirements
- multiple teams or services
- stronger contractual or regulatory pressure

Mandatory:

- full core path
- [10-security-and-governance.md](10-security-and-governance.md)
- [11-change-management-and-incidents.md](11-change-management-and-incidents.md)
- [checklists/security-review.md](../checklists/security-review.md)
- threat models and runbooks for critical areas

## Decision Triggers

Move from core-only toward enterprise path when one or more of these are true:

- the system stores sensitive customer or company data
- production access must be controlled and auditable
- customers ask about security reviews, incident handling, or certifications
- multiple teams need shared governance
- downtime or data mistakes have material commercial impact
- AI agents can influence production-adjacent code, infrastructure, or workflows

## How An Agent Should Decide

When receiving a project, an agent should ask:

1. Is this still exploratory, or is production expected soon?
2. Are real users or customer data involved?
3. What is the blast radius of failure?
4. Are there external trust or audit requirements?
5. Are multiple teams, services, or privileged workflows involved?

Then apply:

- the smallest phase that honestly fits today
- the next phase's preparatory controls if production is near
- the enterprise path immediately if triggers are already present

## Minimum Rules For Every Phase

Never drop these, even in early work:

- use version control
- keep secrets out of source control
- define who owns the work
- write enough documentation to avoid hidden tribal knowledge
- review important changes before shipping

## Anti-Patterns

- applying enterprise ceremony to a throwaway spike
- treating a production system like an experiment
- waiting for the first customer security questionnaire before adding governance
- assuming agents will infer risk correctly without explicit phase guidance

## Exit Criteria

This adoption model is working when:

- teams can explain why a control is required now or deferred
- agents can choose a path without guessing blindly
- the process grows with risk instead of lagging behind it
