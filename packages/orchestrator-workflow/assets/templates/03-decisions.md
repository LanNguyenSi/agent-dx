# Decisions

<!-- For newly created decision records, this table is descriptive evidence, not an authorization mechanism. Record the real accountable source and its concrete approval evidence; a role label or this Markdown alone does not grant authority. Established runs retain their recorded decision format. -->

| ID | Date | Trigger / Evidence | Decision | Authority / Source | Consequences | Supersedes |
|---|---|---|---|---|---|---|
| D-001 | YYYY-MM-DD | <!-- trigger and evidence --> | <!-- decision --> | <!-- accountable source and approval evidence --> | <!-- consequences --> | <!-- prior D-ID, or blank for first decision --> |

<!-- Baseline revisions and accepted waivers link to their D-ID. A revision's
Supersedes cell names the prior decision it replaces. Routine in-scope
orchestrator decisions, operator-approved scope changes, and operator-only
critical waivers remain distinct. -->

<!-- Run mode `single`: record the run's runbook selection here as one decision row (runbook paths with trigger 1 task fit / 2 touched paths / 3 pinned and each entry's authority, the AGENTS.md path and revision read at the run base, or "no runbook applies" with a one-line reason), since 01-plan.md is optional in that mode. Other modes record it in 01-plan.md's Runbooks section. An orchestrator decision that adopts a data-runbook step into a task's acceptance criteria is recorded here too. In an `acceptance-baseline/v1` run, adopt before the baseline is frozen (step 5), or record the adoption as a baseline revision. A surfaced runbook, pin, or declaration diff gets a row here too. -->

## Review-round escalation

<!-- One row per task that triggers the Review-round escalation budget in SKILL.md: the second round-2 halt signal or the third negative round on that task. A negative round counts only with at least one introduced_by_delta yes/unknown finding; no stays ordinary gate. A run carries multiple tasks, so this table can carry multiple rows. Leave the single placeholder row as n/a when no task in this run has triggered the budget. -->

| Task | Choice | Reason |
|---|---|---|
| n/a | n/a | n/a |

<!-- Choice is one of: n/a | tier_escalation | advisor | merge_hold -->

<!-- review-round-escalation: choice = n/a -->
<!-- Reader marker: the most recent choice recorded in this run's table above, kept for readers that scan for a single marker rather than the table. One of: n/a | tier_escalation | advisor | merge_hold -->
