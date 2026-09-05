# Implementation Summary

## Status

not_started | in_progress | done | partial | blocked

## Completed Tasks

- <!-- T-001 -->

## Changed Files

| File | Reason |
|---|---|
| <!-- path --> | <!-- reason --> |

## Acceptance-Baseline Coverage

The Acceptance-Baseline Coverage and Open Required Residuals sections apply
only to a run that recorded `Acceptance contract: acceptance-baseline/v1` in
`00-goal.md` at creation before slicing. Existing runs retain their recorded
original summary contract. Unknown provenance is resolved before dependent
delegation; missing fields never select a version or require migration.

This table indexes the implementer's returned `criterion_evidence` references
against the frozen `acceptance_baseline` and assigned criteria. Empty
`evidence_refs: []` stays unresolved, with its reason in risks/open questions.
This table indexes result artifacts; it is not a results database and does not
itself accept work. A required criterion with missing, aborted, skipped,
unresolved, wrong-state, or wrong-baseline evidence remains an open residual
and blocks acceptance.

| Criterion ID | Baseline ID / revision | Evidence reference | Result |
|---|---|---|---|
| <!-- AC-001 --> | <!-- acceptance-baseline / r1 --> | <!-- relative result artifact reference --> | <!-- pass/fail/manual/residual --> |

An automated result artifact identifies its attempt, repository, checked
revision including relevant dirty-state identity, cwd, applied check definition,
status, exit or abort information, and baseline/criterion identities. A manual reference
identifies the artifact revision, reviewer, method, pass/fail standard, and
reasoned result and baseline/criterion identities; it remains explicitly manual. Coverage never turns a reviewer
recommendation or accepted risk into automated verification.

Each reference resolves relative to the directory containing this summary
file, with a precise artifact or fragment locator when needed. It must identify the
same baseline and criterion as the frozen delegated record; a copied label or
an optional row cannot stand in for a required criterion.

## Open Required Residuals

| Criterion ID | Why evidence is not decisive | Acceptance effect |
|---|---|---|
| <!-- AC-001 --> | <!-- missing/aborted/skipped/unresolved/wrong state or baseline --> | blocks acceptance |

## Test Evidence

### Executed

- <!-- command/result -->

### Added or Updated

- <!-- test file -->

### Not Executed

<!-- Explain why, if applicable. -->

### Mutation Probes

| Round | Mutant | Verified Applied Via | Result | Restored Verified | Replayed |
|---|---|---|---|---|---|
| <!-- round --> | <!-- mutant --> | <!-- verified_applied_via --> | <!-- result --> | <!-- restored_verified --> | <!-- replayed --> |

## Risks / Notes

- <!-- note -->
