# 10 - Security And Governance

Enterprise products need more than secure coding advice. They need clear control ownership, reviewable access, and explicit risk decisions.

## When To Apply

This chapter is part of the `enterprise path`.

Treat it as mandatory in `Phase 3 - Enterprise` and pull it forward earlier when:

- sensitive data is involved
- customer security reviews begin
- privileged production access must be auditable
- AI agent permissions touch sensitive systems

## Objectives

This chapter defines the baseline for:

- security ownership
- access governance
- threat modeling
- supply-chain hygiene
- privacy and data handling controls
- risk acceptance and exception handling

## Core Artifacts

For enterprise-path work, keep these artifacts current:

- service ownership record
- data classification matrix
- access review plan and evidence
- exception register
- compliance mapping for required frameworks or customer controls

Templates:

- [templates/service-ownership-template.md](../templates/service-ownership-template.md)
- [templates/data-classification-matrix.md](../templates/data-classification-matrix.md)
- [templates/access-review-template.md](../templates/access-review-template.md)
- [templates/exception-register-template.md](../templates/exception-register-template.md)
- [templates/compliance-mapping-template.md](../templates/compliance-mapping-template.md)

## Ownership Model

Every product should identify:

- security owner
- privacy or data governance owner when applicable
- approver for production access
- approver for high-risk architectural exceptions
- incident commander role for security events

Small teams may combine these roles, but the decisions still need named owners.

## Threat Modeling

Do threat modeling before:

- launching a new external product
- adding sensitive data classes
- exposing admin capabilities
- integrating payments, identity, or third-party write access
- enabling agent autonomy on production-adjacent systems

At minimum, capture:

- assets and trust boundaries
- entry points
- threat actors
- abuse cases
- likely failure paths
- mitigations and residual risks

Use [templates/threat-model-template.md](../templates/threat-model-template.md).

## Identity And Access Management

Baseline IAM rules:

- least privilege by default
- separate human and machine identities
- production access is time-bound or tightly controlled
- privileged actions are logged
- shared credentials are prohibited
- access reviews happen on a schedule

For AI-assisted development, also define:

- what tools agents may call
- what environments agents may influence
- whether agents can open, merge, or deploy changes

## Secrets And Key Management

Require:

- managed secret storage or equivalent central control
- scoped credentials per environment
- rotation policy
- break-glass procedure for credential exposure
- audit trail for secret access where available

## Secure Development Controls

The secure development baseline should include:

- branch protection
- dependency review and update cadence
- secret scanning
- vulnerability scanning
- secure defaults in new services
- code owner review on sensitive paths

Examples of sensitive paths:

- authentication and authorization
- billing and payments
- data export or deletion
- infrastructure and deployment definitions
- agent permission boundaries

## Supply Chain Controls

Software supply chain risk is part of product risk.

Define expectations for:

- approved dependency sources
- lockfile usage
- artifact provenance where supported
- container base image review
- dependency freshness and end-of-life review
- third-party service risk awareness

Avoid adding unreviewed packages or actions just because they speed up development.

## Privacy And Data Governance

If the system handles user or enterprise data, define:

- data classes
- collection purpose
- retention and deletion rules
- export and subject-rights handling where applicable
- data minimization rules
- cross-border data transfer assumptions

Privacy obligations should influence architecture and logging design, not just policy documents.

## Risk Acceptance And Exceptions

Not every control can be met immediately. That is normal. Hidden exceptions are not.

Every exception should record:

- the unmet control
- business reason
- blast radius
- compensating controls
- owner
- expiry or review date

An exception without an owner or expiry is just unmanaged risk.

## Security Review Triggers

Require an explicit security review when changes touch:

- auth or permission models
- tenant isolation
- public APIs
- sensitive data storage
- secrets handling
- file upload or execution paths
- agent permissions that affect code, infra, or data

Use [checklists/security-review.md](../checklists/security-review.md).

## Auditability

Enterprise systems often need to answer later:

- who changed access
- who approved a risky deployment
- who accessed sensitive data
- which agent or engineer changed what
- what was known and accepted at the time

If those answers cannot be reconstructed, governance is weak even if the implementation is good.

## Exit Criteria

Security and governance maturity is acceptable when:

- ownership is explicit
- access is controlled and reviewable
- major threats have been modeled
- exceptions are documented and time-bound
- the team can explain how risky changes are approved and audited
