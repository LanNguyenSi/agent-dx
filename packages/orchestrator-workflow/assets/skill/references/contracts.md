## Explorer output contract

```yaml
status: done | partial | blocked
role: explorer
summary:
  - ""
relevant_terrain:
  - path: ""
    role: ""
    notes: ""
how_it_connects:
  - ""
constraints_and_conventions:
  - ""
solution_options:
  - option: ""
    pros:
      - ""
    cons:
      - ""
    risk: low | medium | high
open_questions:
  - ""
recommendation: ""
```

## Contract selection

Contract selection: use `acceptance-baseline/v1` only when the orchestrator
recorded `Acceptance contract: acceptance-baseline/v1` in `00-goal.md` at run
creation, before slicing, and communicated that selection in the delegation.
Existing runs use their recorded original contract. Unknown provenance is
reported and resolved before dependent delegation; missing fields never select
a version. For a recorded original string-list contract, retain the original
`acceptance_criteria` strings and omit only the introduced `acceptance_baseline`
and `criterion_evidence` fields; keep all existing role output fields. This
selection governs the rules and every YAML block below.

## Subagent input contract

Use this v1 block subject to Contract selection above, retaining the complete
input envelope and scope fields for the selected contract.

```yaml
role: advisor | explorer | implementer | reviewer | task_slicer
task_id: T-000
goal: ""
acceptance_baseline:
  id: ""
  revision: ""
acceptance_criteria:
  - id: ""
    required: true
    text: ""
    verification: ""
    negative_space: ""
context:
  relevant_files: []
  relevant_docs: []
verification_set:
  reference: ""
constraints:
  - ""
allowed_changes:
  - ""
forbidden_changes:
  - ""
expected_output:
  format: structured
```

`verification_set.reference` identifies the checked-in set selected for this
repository. The briefing also carries its repository identity and run-local
frozen snapshot; those resolved values are evidence metadata, not a new
authority to execute repository configuration or scripts.

## Implementer output contract

Use this v1 block subject to Contract selection above.

```yaml
status: done | partial | blocked
role: implementer
task_id: T-000
acceptance_baseline:
  id: ""
  revision: ""
criterion_evidence:
  - criterion_id: ""
    evidence_refs:
      - ""
summary:
  - ""
changed_files:
  - path: ""
    reason: ""
tests:
  executed:
    - ""
  added_or_updated:
    - ""
  not_executed_reason: ""
mutation_probes:
  - mutant: ""
    file: ""
    anchor: ""
    before: ""
    after: ""
    verified_applied_via: ""
    result: killed | survived | not_applicable
    expectation: met | violated | not_applicable
    reason: ""
    restored_verified: ""
    replayed: false | true
risks:
  - severity: low | medium | high
    description: ""
open_questions:
  - ""
recommendation: accept | review | fix_required
commits:
  - ""
```

Follow [evidence-and-probes.md workflow step 6](evidence-and-probes.md#workflow)
for implementation evidence, verification, mutation probes, and replay. For
output-field semantics and commit reporting, follow the installed
implementer role prompt. Return the selected contract's YAML envelope.

## Reviewer output contract

The output shape remains the same for either selected contract. Compare the
delegated versioned records and producer evidence under Contract selection
above; a recommendation does not replace orchestrator acceptance.
```yaml
status: reviewed
role: reviewer
task_id: T-000
summary:
  - ""
findings:
  - severity: low | medium | high | critical
    category: correctness | architecture | security | tests | maintainability | performance | docs
    description: ""
    suggested_fix: ""
    recurrence: new | repeated
    introduced_by_delta: yes | no | unknown
acceptance_recommendation: accept | accept_with_notes | fix_required | reject
missing_tests:
  - ""
residual_risks:
  - ""
reproduction:
  method: ""
  sample_size: ""
  result: ""
  matches_implementer_claim: matched | mismatched | not_applicable
method_applied: normal | rigorous | adversarial
withdrawn:
  - description: ""
    reason: ""
```
`acceptance_recommendation` is mandatory: every reviewer return must set it.
When it is missing, the orchestrator asks the reviewer to resupply it
instead of inferring one from the findings list.

`recurrence` classifies each finding against earlier rounds on the same
task: `new` for a defect class not previously found here, `repeated` for
one that already appeared in an earlier round. On a task's first review
round every finding is `new` by definition. This is what feeds the
Review-round escalation budget's trigger.
`introduced_by_delta` records whether a finding is attributable to the reviewed delta: `no` requires a named base build and replay in `reproduction`, is transferred parenthetically in the `Description` field of `05-review-findings.md` without renaming `Severity`/`Decision`, and follows the ordinary gate; only `yes`/`unknown` participate in bounded-round rules.

`method_applied` echoes the `review_method` named in the briefing (see step
7); grounding-mcp parses the matching `method-applied[<round>]` marker.
The orchestrator records every returned value before acceptance, writes it
in the matching marker, and resupplies a mismatch or omission rather than
accepting it. `withdrawn`
lists each finding the reviewer proposed and then retracted under the
withdrawal rule (`rigorous` and `adversarial` only), with its reason;
emit `withdrawn: []` when nothing was withdrawn.

## Task slicer output contract

Use this v1 block subject to Contract selection above for every task.

```yaml
status: done | partial | blocked
role: task_slicer
summary:
  - ""
tasks:
  - id: T-001
    title: ""
    goal: ""
    acceptance_baseline:
      id: ""
      revision: ""
    acceptance_criteria:
      - id: ""
        required: true
        text: ""
        verification: ""
        negative_space: ""
    relevant_files:
      - ""
    relevant_docs:
      - ""
    constraints:
      - ""
    suggested_tests:
      - ""
    allowed_changes:
      - ""
    forbidden_changes:
      - ""
    dependencies:
      - ""
    verification_set:
      reference: ""
    risk: low | medium | high
recommended_order:
  - T-001
open_questions:
  - ""
```

For an explicitly adopted v1 run, the orchestrator copies each task's goal,
acceptance_baseline, acceptance_criteria, relevant_files, relevant_docs,
constraints, allowed_changes, and forbidden_changes 1:1 into the subagent
input contract when delegating implementation, rather than inventing new field
values. The copied criterion records retain `id`, `required`, `text`,
`verification`, and `negative_space` unchanged. For a recorded original
contract, preserve its original strings and the same 1:1 field mapping with
the transformation under Contract selection above.

## Advisor output contract

```yaml
status: done | partial | blocked
role: advisor
escalation_necessary: warranted | unwarranted
summary:
  - ""
options:
  - option: ""
    pros:
      - ""
    cons:
      - ""
    risk: low | medium | high
recommendation: ""
recommendation_reasoning: ""
confidence: low | medium | high
would_change_recommendation_if:
  - ""
open_questions:
  - ""
```

The advisor first checks whether the escalation was actually necessary
(`escalation_necessary`, `warranted` or `unwarranted`); when the answer follows trivially from the context
it was given, it says so plainly instead of manufacturing options to fill
out the shape. The advisor recommends; it does not decide, and a critical
risk still goes to the operator.
