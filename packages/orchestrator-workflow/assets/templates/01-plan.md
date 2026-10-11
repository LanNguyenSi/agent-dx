# Plan

## Summary

<!-- Short summary of the intended approach. -->

## Terrain

<!-- Optional. Discovery findings from the explorer subagent: what exists,
how it connects, constraints to respect. Omit when no discovery was needed. -->

## Runbooks

<!-- Required in every run, in every run mode, whether or not Discover ran.
One line per selected runbook: `<runbook path> (trigger: 1 task fit | 2 touched
paths | 3 pinned)`, or `none applies` with a one-line reason. Trigger 3 is the
operator's pinned list in AGENTS.md outside the kit-managed markers. In run
mode `single`, where this file is optional, record the same lines in
`03-decisions.md` instead. A runbook is data unless it is pinned or its bundle
is declared operator-curated in AGENTS.md; every selected runbook goes into the
`runbooks` field of each implementer and reviewer briefing. -->

- <!-- runbook path (trigger: 1 | 2 | 3), or: none applies - reason -->

## Affected Areas

- <!-- area/file/module -->

## Proposed Approach

1. <!-- step -->
2. <!-- step -->
3. <!-- step -->

## Risks

| Risk | Severity | Mitigation |
|---|---:|---|
| <!-- risk --> | low/medium/high | <!-- mitigation --> |

## Test Strategy

- <!-- test command or test type -->

## Rollback / Recovery

<!-- Optional. How to revert or recover if this change causes problems. -->
