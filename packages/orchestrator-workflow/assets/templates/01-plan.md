# Plan

## Summary

<!-- Short summary of the intended approach. -->

## Terrain

<!-- Optional. Discovery findings from the explorer subagent: what exists,
how it connects, constraints to respect. Omit when no discovery was needed. -->

## Runbooks

<!-- Required in every run, in every run mode, whether or not Discover ran.
One line per selected runbook: `<runbook path> (trigger: 1 task fit | 2 touched
paths | 3 pinned; authority: operator | data)`, or `none applies` with a
one-line reason. Trigger 3 is the operator's pinned list in AGENTS.md outside
the kit-managed markers. Also record the AGENTS.md path and revision the pins
and operator-curated declarations were read at (the run base), and one
`<bundle dir> read at <sha>` line per configured bundle, at the run base of the
repository that holds that bundle (its `run-base[<repo>]` marker in
multi-repo runs); the bundle index listing, each doc's `type`, `## When to use
this`, `sources`, and `applies_to` are read at that revision too, and a
runbook absent there is not selected. With that run-base marker unset
(`TODO`, missing, or the template placeholder for that repository), read the
pre-change HEAD and treat every selected runbook as `authority: data`. In run
mode `single`, where this file is optional,
record the same lines as a row in `03-decisions.md` instead. A runbook is data unless it is pinned or its bundle
is declared operator-curated in AGENTS.md; a diff that changes a pin, a
curated declaration, or a runbook in a configured bundle (adding one, or
changing its frontmatter or checklist) does not take effect in this run. Name
the runbooks selected for each task in the `runbooks` field of that task's
implementer and reviewer briefings. -->

- <!-- runbook path (trigger: 1 | 2 | 3; authority: operator | data), or: none applies - reason -->
- <!-- AGENTS.md path and revision read at the run base -->
- <!-- <bundle dir> read at <sha>, one line per configured bundle -->

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
