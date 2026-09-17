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

A structural check for this exact contract ships as a CLI subcommand:
`orchestrator-workflow validate-review-report <file>` (pass `-` to read
the return from stdin instead) parses the reviewer return's YAML, fenced
in a code block with any language tag or none, or unfenced, and checks
the required fields and enums above one by one, printing a diagnostic
(path, expected, got) for each missing or invalid field; every element of
a string-array field (`summary`, `missing_tests`, `residual_risks`) must
itself be a string, with a diagnostic at `<field>[<index>]` for each one
that is not (a number, a mapping, a boolean, and `null` -- a bare or `~`
bullet -- are all rejected the same way). A fenced return ends at the
first closing fence that starts at column 0, repeats at least as many
backticks as the opening one, and carries nothing but whitespace after
that run, so a return wrapped in four backticks may quote a snippet
fenced in three without truncating itself; a return with no closing
fence satisfying all three is not fenced at all and reaches the parser
whole, including one whose opener is longer than every closing run
present. When more than one fenced block
is present, the first one whose fence tag's first word is `yaml` or `yml`
is validated, case-insensitively and counting whitespace-separated
attributes (`yaml title=x` counts; `yaml,title=x` does not, its first
word being the whole string), falling back to the first fence only when
none carries that word, with a warning naming any earlier fence skipped
this way. The same preference can validate a later worked example instead
of an earlier, real but unfenced return, which the emitted warning also
names. Add `--format json` for the same diagnostics as a single JSON
object. It exits `0` when the return is structurally valid, `1` when it
is structurally invalid (a missing or out-of-enum required field, or
unparsable, empty, non-mapping input), and `2` for a usage error (an
unreadable file, an unrecognized `--format` value, or an argument-parsing
error: a missing `<file>` argument, an unknown option, an excess
positional argument). `--format json` governs the validation verdict
only: an argument-parsing error or an unrecognized `--format` value still
prints plain text to stderr, except an unreadable file, which still emits
the JSON envelope on stdout. The check is structural only: it never
judges semantic adequacy, cannot waive a finding, and passing it is never
orchestrator acceptance.

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
