# Post-Incident Review — [Incident Title]

## Metadata

| Field | Value |
|-------|-------|
| Date | YYYY-MM-DD |
| Severity | sev1 / sev2 / sev3 / sev4 |
| Duration | HH:MM (detection to resolution) |
| Incident Commander | [name] |
| Author | [name] |
| Status | draft / reviewed / actions tracked |

## Summary

One paragraph describing what happened, who was affected, and how it was resolved. Write for someone who was not involved.

## Impact

- **Users affected:** [number or scope]
- **Revenue impact:** [if applicable]
- **Data impact:** [loss, corruption, exposure — or none]
- **SLA breach:** yes / no
- **External communication required:** yes / no

## Timeline

All times in UTC.

| Time | Event |
|------|-------|
| HH:MM | [First anomaly detected / alert fired] |
| HH:MM | [Incident acknowledged, severity classified] |
| HH:MM | [Key decision or action taken] |
| HH:MM | [Service restored / mitigation applied] |
| HH:MM | [Confirmed stable, incident closed] |

## Root Cause

Describe the technical root cause. Be specific. "Human error" is not a root cause — describe what system allowed the error to have impact.

## Contributing Factors

What conditions made this incident possible or worse:

- [ ] Missing or insufficient test coverage
- [ ] Inadequate monitoring or alerting
- [ ] Unclear runbook or missing procedure
- [ ] Configuration drift or undocumented change
- [ ] Insufficient review of change
- [ ] Agent-generated code with insufficient validation
- [ ] Missing rollback capability
- [ ] Other: [describe]

## What Went Well

What worked as intended during the response:

-
-

## What Could Be Improved

What did not work well or was missing:

-
-

## Agent Involvement

If the incident involved agent-generated code or agent-assisted operations:

- **Agent identity:** [which agent or tool]
- **What the agent produced:** [code, config, migration, etc.]
- **Review process:** [was it reviewed? by whom?]
- **Prompt or task context:** [what triggered the agent work]
- **Remediation:** [prompt update, permission change, process change]

If no agent involvement, remove this section.

## Corrective Actions

| ID | Action | Owner | Due Date | Status |
|----|--------|-------|----------|--------|
| 1 | [specific, measurable action] | [name] | YYYY-MM-DD | open |
| 2 | | | | |
| 3 | | | | |

### Action Categories

Label each action:

- **prevent:** stop this class of incident from recurring
- **detect:** catch this failure earlier
- **mitigate:** reduce the blast radius if it happens again
- **process:** improve the response workflow

## Systemic Observations

If this incident reveals a pattern (third time this quarter, same class of failure in multiple services, recurring gap in a specific team), note it here. Systemic issues should be escalated beyond the incident team.

## Follow-Up Review

Schedule a follow-up to verify actions are completed:

- **Review date:** YYYY-MM-DD
- **Reviewer:** [name]

## Principles

- This review is blameless. The goal is to improve the system, not assign fault.
- Actions must have owners and deadlines. Unowned actions do not get done.
- The output should change something. If nothing changes, the review was theater.
