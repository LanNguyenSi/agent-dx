# Goal

<!-- solution-acceptance: run-base = TODO -->
<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->

## Acceptance Baseline

For a newly created run that adopts this contract, record this declaration
before planning, slicing, or delegation:

Acceptance contract: acceptance-baseline/v1

Then freeze the actual delegation input in this canonical shape:

```yaml
acceptance_baseline:
  id: "" # e.g. acceptance-baseline
  revision: "" # e.g. r1
acceptance_criteria:
  - id: "" # e.g. AC-001
    required: true
    text: "" # frozen normative text
    verification: "" # exact command + expected outcome, or reviewer role + concrete artifact + pass/fail standard
    negative_space: "" # what this criterion does not establish
```

The orchestrator freezes these records before delegation. An implementer must
not change a criterion or its normative verification command. A baseline
revision records the old and new revisions, affected IDs, decision authority
and reason, invalidated evidence, and any verified rationale for carrying
unchanged evidence forward. Scope changes beyond the request need an operator
decision; invalidated evidence is rerun before acceptance.

This contract applies only to runs that explicitly record the declaration
above. Existing runs continue under their recorded original contract: missing
v1 fields neither identify a legacy run nor block it, and uncertain adoption
or provenance is reported rather than inferred.

## Operator Request

<!-- Original user/operator request. -->

## Goal

<!-- What should be achieved? -->

## Non-Goals

<!-- What is explicitly out of scope? -->

## Constraints

<!-- Technical, architectural, security, time, style, or process constraints. -->

## Assumptions

<!-- Assumptions the orchestrator is making to avoid unnecessary blocking. -->

## Open Questions

<!-- Only include questions that truly block progress. -->
