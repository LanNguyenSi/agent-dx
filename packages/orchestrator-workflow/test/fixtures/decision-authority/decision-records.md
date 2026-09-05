# Decisions (illustrative; not authorization evidence)

| ID | Date | Trigger / Evidence | Decision | Authority / Source | Consequences | Supersedes |
|---|---|---|---|---|---|---|
| D-001 | 2026-01-01 | Delegated contract fixes baseline-demo r1. | Establish baseline-demo r1. | Orchestrator; delegated contract authorizes this routine decision. | Continue the task under r1. | |
| D-002 | 2026-01-02 | Operator approval recorded in [scope request](scope-request.md). | Revise baseline-demo from r1 to r2 for P2-AC2. | Operator approval in scope request; orchestrator records the revision. | Invalidate P2-AC2 evidence and rerun it. | D-001 |
| D-003 | 2026-01-03 | Critical finding CRIT-001 and [waiver record](critical-waiver.md). | Waive the critical finding for this delivery. | Operator approval in critical-waiver.md. | Record the accepted waiver in the handoff. | |
