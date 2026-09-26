# Agent Engineering Playbook

Pragmatic guidance for building AI-assisted software that can survive enterprise expectations: security reviews, auditability, reliability, change control, and production operations.

## Overview

This is a working playbook for teams building production systems with human engineers and AI agents. It does not assume that speed alone is success: delivery, safety, operability, and maintainability are treated as first-class concerns. The material is organized into thirteen playbooks (adoption paths through agent governance), plus checklists, templates, and a machine-readable adoption model, split into a `core path` for any product expected to reach production quality and an `enterprise path` for higher customer, compliance, security, or organizational complexity.

## Key features

- Thirteen playbooks: adoption paths, project setup, architecture, team roles, design principles, development workflow, testing, quality assurance, documentation, production readiness, security and governance, change management and incidents, agent governance
- Checklists for phase assessment, project start, code review, pre-production, and security review
- Fourteen templates: task, PR, ADR, README, SECURITY, threat model, runbook, service ownership, data classification, access review, exception register, compliance mapping, postmortem, AI directory
- A machine-readable adoption model (`models/adoption-model.json`) for agents that need a structured version of the core/enterprise decision
- Vendor-neutral: no assumed stack, cloud, proxy, framework, or AI workflow

## How to use it

For a new initiative:

1. Start with [Adoption Paths](playbooks/00-adoption-paths.md).
2. Run the [Phase Assessment Checklist](checklists/phase-assessment.md).
3. Run the [Project Start Checklist](checklists/project-start.md).
4. Write a project charter, architecture context, and initial ADRs.
5. Choose the smallest architecture and delivery model that satisfies current risk.
6. Define security ownership, change controls, and incident expectations.
7. Set release gates before feature work begins.

For an existing product:

1. Start with [Adoption Paths](playbooks/00-adoption-paths.md).
2. Run the [Phase Assessment Checklist](checklists/phase-assessment.md).
3. Run the [Pre-Production Checklist](checklists/pre-production.md).
4. Run the [Security Review Checklist](checklists/security-review.md) when sensitive paths or enterprise obligations apply.
5. Compare current process against [Development Workflow](playbooks/05-development-workflow.md), [Quality Assurance](playbooks/07-quality-assurance.md), and [Security and Governance](playbooks/10-security-and-governance.md).
6. Close missing controls in testing, observability, documentation, rollout strategy, access governance, and incident readiness.

## Core principles

- Start with clear outcomes, constraints, and operating assumptions.
- Prefer simple architectures until complexity is justified by scale or risk.
- Keep changes small, testable, and reversible.
- Require evidence for shipping: tests, review, observability, and rollback.
- Treat documentation, runbooks, and decision records as part of the product.
- Use AI agents as force multipliers, not as substitutes for ownership and controls.
- Make access, change approval, and incident response explicit before scale forces them.

This maps to a spec-driven / context-driven / eval-driven model: specs guide the task, context guides the decision, evals guide delivery confidence.

## Documentation

- **Playbooks:** [00 Adoption Paths](playbooks/00-adoption-paths.md), [01 Project Setup](playbooks/01-project-setup.md), [02 Architecture](playbooks/02-architecture.md), [03 Team Roles](playbooks/03-team-roles.md), [04 Design Principles](playbooks/04-design-principles.md), [05 Development Workflow](playbooks/05-development-workflow.md), [06 Testing Strategy](playbooks/06-testing-strategy.md), [07 Quality Assurance](playbooks/07-quality-assurance.md), [08 Documentation](playbooks/08-documentation.md), [09 Production Readiness](playbooks/09-production.md), [10 Security and Governance](playbooks/10-security-and-governance.md), [11 Change Management and Incidents](playbooks/11-change-management-and-incidents.md), [12 Agent Governance](playbooks/12-agent-governance.md)
- **Checklists:** [phase-assessment](checklists/phase-assessment.md), [project-start](checklists/project-start.md), [code-review](checklists/code-review.md), [pre-production](checklists/pre-production.md), [security-review](checklists/security-review.md)
- **Templates:** see the [templates/](templates/) directory (task, PR, ADR, README, SECURITY, threat model, runbook, service ownership, data classification, access review, exception register, compliance mapping, postmortem, AI directory)
- **Verification references:** [Verification handoff contract](references/verification-handoff.md), [First implementation slice](references/verification-handoff-first-slice.md)
- **Case studies:** [Event booking system](case-studies/event-booking-system.md)
- **Machine-readable model:** [models/adoption-model.json](models/adoption-model.json)
- [Hardening pass history](docs/hardening-history.md): what the last major revision changed and why
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md)

## Intended audience

- Engineering leads establishing delivery standards
- Staff and senior engineers designing architecture and release controls
- Product teams working with AI agents in the development loop
- Founders and CTOs moving from prototype behavior to production discipline
- AI agents that need to adapt process rigor to project phase instead of applying every control immediately

## Scope and non-goals

This repository is intentionally vendor-neutral. It may mention specific tools, but it does not assume a single stack, cloud, proxy, framework, or AI workflow. It is not a certification framework, a substitute for legal, privacy, or security specialists, a substitute for formal compliance programs where they are required, or a promise that every team needs heavyweight process from day one. The goal is proportional rigor: enough control for the risk profile you actually have.

## Contributing

Use [CONTRIBUTING.md](CONTRIBUTING.md). Proposed changes should explain what weakness in the current guidance is being addressed, what operational or engineering problem the revision prevents, and what tradeoff the new guidance introduces.

## License

MIT
