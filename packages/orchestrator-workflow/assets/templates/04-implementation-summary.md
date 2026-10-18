# Implementation Summary

## Status

not_started | in_progress | done | partial | blocked

## Completed Tasks

- <!-- T-001 -->

## Changed Files

| File | Reason |
|---|---|
| <!-- path --> | <!-- reason --> |

## Test Evidence

### Verification Set

Record the frozen set reference (path plus digest), repository identity,
effective configuration/scripts, preflight executable identity/definition, and
every ordered `(kind, name, occurrence)` result with cwd and artifact. A
missing-tool preflight limitation may have no raw child result, but is never a
pass; disabled required categories are gaps. Missing, extra, mismatched, or
unresolved results are misfires. Failures, skips, acknowledgements,
limitations, and inconclusive outcomes remain explicit non-passes.

| Set reference / digest | Repository identity                    | Result identity                   | Cwd          | Result artifact / status            |
| ---------------------- | -------------------------------------- | --------------------------------- | ------------ | ----------------------------------- |
| <!-- path / digest --> | <!-- repo / revision / dirty state --> | <!-- kind / name / occurrence --> | <!-- cwd --> | <!-- artifact / non-pass reason --> |

### Executed

- <!-- command/result -->

### Added or Updated

- <!-- test file -->

### Not Executed

<!-- Explain why, if applicable. -->

### Mutation Probes

Before/After cells hold a single-line excerpt. When the mutant's actual
before/after text is multi-line or contains an unescaped `|`, or the mutant
is a patch/diff rather than a text swap, put the full text or diff in the
implementer report or a fenced block directly under the table, and note
where it lives in the row's own cell.

| Round | Mutant | File | Anchor | Before | After | Verified Applied Via | Result | Expectation | Reason | Restored Verified | Replayed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| <!-- round --> | <!-- mutant --> | <!-- file --> | <!-- anchor --> | <!-- before --> | <!-- after --> | <!-- verified_applied_via --> | <!-- result --> | <!-- expectation --> | <!-- reason --> | <!-- restored_verified --> | <!-- replayed --> |

### Class Closure

One row per fix round (any round after the task's first) that fixed a review
finding: the defect class it closed, the search command run to enumerate other
sites of that class (blank when `Closure Kind` is not `enumerated`), the sites
the search found (blank when `Closure Kind` is not `enumerated`), and the
closure kind (`enumerated | source`) the implementer reported in
`class_closure`; `not_applicable` never appears in this table, since a row
exists only for a round that fixed a finding, never for the task's first round.
An unclosed site of the row's class is named in Risks / Notes with the reason.

| Round | Class | Enumeration Command | Sites | Closure Kind |
|---|---|---|---|---|
| <!-- round --> | <!-- class --> | <!-- enumeration_command --> | <!-- sites --> | <!-- closure_kind --> |

### Optional Probe Plan and Result Index

An optional runner-supported probe plan may be referenced here by relative
path, immutable revision/hash, and mutant locator/index. It helps later
assignments locate an unchanged definition but is never evidence by itself.
Each result reference binds that plan to checked state, cwd, attempt,
expectation, applied mutant, and restoration. Missing, stale, or unresolved
references block the relevant proof rather than count as skipped. Preserve the
legacy table above; when a source move requires a replacement plan, record its
intentional supersession and rationale in `03-decisions.md`.

| Plan reference | Immutable revision/hash | Mutant locator/index | Result reference |
|---|---|---|---|
| <!-- relative plan path --> | <!-- immutable id --> | <!-- locator --> | <!-- relative result artifact --> |

## Runbooks Consulted

<!-- Run mode `single` only, where the orchestrator is also the implementer:
one entry per runbook the run's selection row in `03-decisions.md` lists, with
the fields of the implementer's `runbooks_consulted` return: its path, the
checklist steps followed, and each deviation with the step and the reason.
Other run modes leave this section as is; each implementer's return carries
the record there. -->

- <!-- runbook path; steps followed; deviations (step: reason), or none -->

## Risks / Notes

- <!-- note -->

## Integration

<!-- Batch runs only (run mode `batch`); leave as is otherwise. Per merged
slice: branch or worktree, merge order, conflicts and how they were resolved,
and the verification set outcome on the integrated tree. -->
