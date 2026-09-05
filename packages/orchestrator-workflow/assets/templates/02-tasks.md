# Tasks

## Delegated Acceptance Baseline

For a run that explicitly adopted `acceptance-baseline/v1`, each task carries
the relevant frozen records in its own contract. Copy these canonical fields
from `00-goal.md` unchanged; the task list is a lossless superset, not a
second place to revise criteria. This selection must have been recorded in
`00-goal.md` at run creation before slicing and communicated in delegation.
Existing runs keep their recorded original contract: retain original
`acceptance_criteria` strings and omit the introduced `acceptance_baseline`
and `criterion_evidence` fields, keeping existing role output fields. Unknown
provenance is resolved before dependent delegation; missing fields never
select a version. The YAML block below is the v1 shape under this selection.

## Task List

### T-001: <!-- Title -->

**Delegated Acceptance Contract**

```yaml
acceptance_baseline:
  id: "" # copied unchanged from 00-goal.md
  revision: "" # copied unchanged from 00-goal.md
acceptance_criteria:
  - id: "" # copied unchanged
    required: true # copied unchanged
    text: "" # copied unchanged
    verification: "" # copied unchanged
    negative_space: "" # copied unchanged
```

**Goal**

<!-- What this task should achieve. -->

**Relevant Files / Areas**

- <!-- path or area -->

**Relevant Docs**

- <!-- doc, ADR, or run file the task relies on, or none -->

**Acceptance Criteria**

For v1 this is non-normative tracking keyed to the frozen criterion IDs in
the delegated block above; do not rewrite criterion text here. For a recorded
original contract, keep the original checklist semantics.

- [ ] <!-- frozen criterion ID (v1), or original criterion (original contract) -->

**Constraints**

- <!-- constraint -->

**Suggested Tests**

- <!-- test -->

**Allowed Changes**

- <!-- path or area the implementer may change -->

**Forbidden Changes**

- <!-- path, area, or action the implementer must not touch -->

**Dependencies**

- <!-- T-000 or none -->

**Risk**

low | medium | high
