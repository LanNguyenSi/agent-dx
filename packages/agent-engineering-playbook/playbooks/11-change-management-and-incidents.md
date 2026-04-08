# 11 - Change Management And Incidents

Enterprise products need disciplined change handling and credible incident response long before they become large.

## When To Apply

Use lightweight parts of this chapter as soon as the product is user-facing.

Treat it as mandatory in:

- `Phase 2 - Production` for incident roles, runbooks, and release communication
- `Phase 3 - Enterprise` for formal change classes, stronger approvals, and after-action discipline

## Objectives

This chapter covers:

- change classification
- release approval expectations
- operational communication
- incident response roles
- post-incident learning

## Change Classification

Classify changes so the process matches the risk.

Suggested model:

- `standard`: repeatable low-risk changes with known procedure
- `normal`: most product changes requiring review and validation
- `high-risk`: changes with significant blast radius, sensitive data impact, or difficult rollback
- `emergency`: urgent changes to restore service or reduce active risk

The goal is not bureaucracy. The goal is to avoid treating all changes as equally safe.

## Approval Expectations

For each change class, define:

- who approves implementation
- who approves release
- what evidence is required
- whether a release window is needed
- what communication is required

High-risk and emergency changes should have explicit after-action review even if speed was necessary.

## Release Communication

Teams should know before risky releases:

- what is changing
- who owns the watch period
- what dashboards matter
- what rollback trigger is agreed
- who must be informed if it fails

Silence is not a communication strategy.

## Incident Severity Model

Use a shared severity scale, for example:

- `sev1`: critical outage, major security event, or data loss with broad impact
- `sev2`: major degradation or high-value capability impaired
- `sev3`: contained issue with workaround
- `sev4`: minor issue with low business impact

Severity should influence escalation, communications, and decision speed.

## Incident Roles

Every incident process should define:

- incident commander
- communications owner
- technical lead
- scribe or timeline owner
- business decision-maker if customer impact is significant

One person can fill multiple roles on a small team, but the roles should still be explicit.

## Response Workflow

Minimum workflow:

1. Detect and acknowledge.
2. Classify severity.
3. Stabilize or contain.
4. Communicate status and next steps.
5. Recover service.
6. Confirm system health.
7. Run a blameless post-incident review.

## Runbooks

Maintain runbooks for:

- deployment rollback
- certificate or secret rotation
- database recovery
- dependency or third-party outage response
- access revocation
- high-error-rate or latency incidents

Use [templates/runbook-template.md](../templates/runbook-template.md).

## Emergency Changes

Emergency changes are allowed only to reduce active impact. They still need:

- named owner
- minimal viable review
- logged reasoning
- post-change validation
- retrospective within a defined time window

Emergency is not a shortcut for poor planning.

## Post-Incident Review

A useful post-incident review covers:

- what happened
- customer and business impact
- timeline of decisions
- contributing technical and process factors
- what controls failed or were missing
- corrective and preventive actions with owners

The output should change the system, not just archive the pain.

Use [templates/postmortem-template.md](../templates/postmortem-template.md) to structure the review. The template includes sections for blameless root cause analysis, corrective actions with owners, systemic observations, and agent involvement where applicable.

For incidents involving agent-generated code, see also [12 - Agent Governance](12-agent-governance.md) for agent-specific investigation and remediation guidance.

## Metrics

Track a small set of useful indicators:

- change failure rate
- mean time to detect
- mean time to restore
- repeat incident rate
- percentage of emergency changes

If emergency work is common, the engineering system is unstable.

## Exit Criteria

Change and incident discipline is credible when:

- riskier changes receive stronger control
- incidents have explicit roles and clear communications
- emergency changes are rare and reviewable
- post-incident actions are tracked to completion
