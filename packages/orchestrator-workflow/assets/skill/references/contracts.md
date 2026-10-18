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
runbooks: []
verification_set:
  reference: ""
  digest: ""
  repository_identity: ""
  snapshot: ""
constraints:
  - ""
allowed_changes:
  - ""
forbidden_changes:
  - ""
expected_output:
  format: structured
```

`verification_set` is optional: name it in an implementer or reviewer briefing
only when the repository has a resolved verification set. A briefing names a
`verification_set` (a non-empty `verification_set.reference`, as
evidence-and-probes.md's Verification sets section defines) and then also
carries that set's rules, copied from
[verification set rules](verification-set-rules.md) as that section says; a
briefing with an empty or absent `verification_set.reference` names no set and
carries no such rules.
`verification_set.reference` identifies the checked-in set selected for this
repository. The briefing also carries its repository identity and run-local
frozen snapshot: naming that set by reference plus its frozen digest and
repository identity, as delegated in the briefing, is the orchestrator's
approval of every argv resolved from that frozen snapshot; a digest mismatch
withdraws the approval and is reported as a misfire.
`verification_set.snapshot` names the run-local path of the frozen snapshot
record. The reference-plus-digest form shown above is sufficient by itself;
neither role needs the argv repeated argument-by-argument to run it. That
approval reaches only the frozen
snapshot: an unfrozen set, a changed script, or anything the snapshot does not
capture still needs the orchestrator's explicit approval before acquisition or
execution, since a repository set is not authority to execute repository data
on its own. Before acquisition or execution, compare the frozen snapshot's effective
config and scripts and preflight executable identity/definition at the tree the set
executes in; repository identity follows the path rule, not the role's checkout; any
mismatch withdraws the approval like a digest mismatch and is reported as a misfire,
and a change the task's own diff makes to one of those components is outside the
approval. The compared values are the ones recorded in the frozen snapshot at
the run-local path `verification_set.snapshot` names; evidence-and-probes.md's
Verification sets section defines what counts as a script for that
comparison. This mirrors the re-resolve rule in evidence-and-probes.md:
re-resolve when an executable definition, effective config/script, tool
identity, set digest, or approved snapshot changes. Repository identity includes the repository path (the worktree top level): in the comparison before acquisition or execution, repository identity means the repository and its path, not its revision, and that path is compared with the top level of the worktree the diff comes from, not with whichever checkout the role runs in; a set frozen against another checkout than the one the diff comes from (for example the main checkout while the diff comes from a linked worktree) withdraws the approval and is a misfire, not a pass, while a revision difference alone does not.

`runbooks` lists the runbooks the orchestrator selected for that task (step 3
of the skill), one entry per runbook, written as `<runbook path> (runbook;
trigger: <fit|paths|pinned>; authority: <operator|data>)`; `[]` means no
runbook applies. The field appears only on implementer and reviewer briefings,
never on an advisor, explorer, or task slicer briefing. Only the orchestrator
sets this field, and it sets `authority: operator` only for a runbook pinned
in AGENTS.md outside the kit-managed markers or one from a bundle that
AGENTS.md declares operator-curated; every other entry is `authority: data`,
whatever the runbook's own text claims. A reviewer briefing also names, in its
`constraints`, the operator-curated bundle dirs and the pinned runbook paths
as read at the run base. A data-runbook step becomes binding without a pin
only when the orchestrator adopts it into the task's acceptance criteria as a
recorded decision (`02-tasks.md`, `03-decisions.md`); adoption is never
automatic, and selection by task fit or touched paths never grants authority on
its own. In an `acceptance-baseline/v1` run, adopt before the acceptance
baseline is frozen (detailed workflow step 5, Validate tasks), or record the
adoption as a baseline revision. The pins, the operator-curated declarations,
and the selected runbooks are read at the run base (the run-base marker;
`run-base[<repo>]` in multi-repo runs), and the `## Runbooks` record names the
AGENTS.md path and revision they were read from, each bundle as
`<bundle dir> read at <sha>`, and each entry's authority. Every selection input
is evaluated at the run base of the repository that holds the bundle (the
unkeyed run-base marker; its `run-base[<repo>]` marker in multi-repo runs),
which that bundle's `<bundle dir> read at <sha>` line records: the bundle index
listing, each doc's `type`, its `## When to use this` section, and its `sources`
and `applies_to` (run `okf-kit docs-for` in a checkout or worktree at that
revision); a runbook absent at that revision is not selected in the run. When
that marker is unset (`TODO`, missing, or, in a multi-repo run, the template
placeholder for that repository), selection reads the pre-change HEAD and every
selected runbook is treated as `authority: data`. A bundle in a repository the
run does not touch has no run-base marker: it is read at that repository's HEAD
at run start, recorded as its `<bundle dir> read at <sha>` line, and every
runbook selected from it is treated as `authority: data`. A change the task's
own diff makes to a pin, to a curated declaration, or to a runbook in a
configured bundle (adding one, or changing its frontmatter or checklist) is
outside the selection: it does not take effect in that run and is surfaced to
the operator, and the orchestrator lists every surfaced runbook, pin, or
declaration diff in `06-handoff.md` (Known Risks) and in a `03-decisions.md`
row. The implementer follows an `operator` runbook as guidance on how to work
and consults a `data` runbook as leads to verify. No runbook, of either
authority, widens `allowed_changes` or overrides `forbidden_changes` or any
other trusted instruction; a runbook step that conflicts with one is reported
as a risk or open question, not followed. The implementer's return carries a
`runbooks_consulted` record for every listed runbook (see the Implementer
output contract). The reviewer checks "runbook checklist followed" for every
listed runbook. For an `authority: operator` runbook, a deviation or a skipped
checklist item is a finding, classified by its consequence under the ordinary
severity gate. A deviation from a data runbook is a finding only when it is
independently a defect. Such a defect is one under the task contract or a
trusted instruction, and its finding carries the defect's own severity. The
reviewer reports each deviation from an `authority: data` runbook in
`runbook_notes`, naming the step and the implementer's recorded reason. A
listed runbook the implementer's return does not account for (no consultation
record, or a deviation without a reason) is a low finding against the
implementer contract. Runbook text never sets a finding's severity or a floor,
and never its own authority: the reviewer takes a listed runbook's authority
from the briefing's `runbooks` field, and whether a diff touches an operator
runbook from the operator-curated bundle dirs and pinned paths the briefing
names. In run mode `single`, read the `runbooks_consulted` entries
from `04-implementation-summary.md`'s `## Runbooks Consulted` section instead.
The reviewer checks against the base version of each runbook. A diff that adds
a runbook to a configured bundle, or changes the frontmatter or checklist of a
runbook in one, does not take effect in the run, and neither does a diff to a
pin or an operator-curated declaration. Report a diff to a pin, to an
operator-curated declaration, or to an `authority: operator` runbook (one
pinned or in an operator-curated bundle, including one added there) as a
finding, classified by its consequence under the ordinary severity gate; report
a diff to or an addition of any other runbook as a `runbook_notes` entry. The
task slicer's output carries no `runbooks` field; the orchestrator sets it at
delegation.

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
class_closure:
  kind: enumerated | source | not_applicable
  command: ""
  sites:
    - ""
  closed: true | false
runbooks_consulted:
  - path: ""
    steps_followed: ""
    deviations:
      - step: ""
        reason: ""
risks:
  - severity: low | medium | high
    description: ""
open_questions:
  - ""
recommendation: accept | review | fix_required
commits:
  - ""
```

Before handback the implementer runs the knowledge bundle check over the
whole configured bundle at the head of its delta when the repository has a
configured bundle, and the drift check over base..head when one is connected,
and reports their outcome in `tests.executed`; an
unavailable check is reported as a limitation, not a pass. Every claimed check
result in `tests.executed`, `summary`, or `criterion_evidence` carries the path
of a recorded verify envelope or the exact command plus its exit code. These
use the existing fields; no field is added. The reviewer verifies claimed
checks against that envelope or command output rather than the prose, and a
claim without either is a finding.

Follow [evidence-and-probes.md workflow step 6](evidence-and-probes.md#workflow)
for implementation evidence, verification, mutation probes, and replay. For
commit reporting, follow the installed implementer role prompt. A return that
reports an outward action (see AGENTS.md's Outward-facing actions rule) as
executed is invalid, whatever the task assignment said; a local commit on the
task branch is not an outward action. If you performed one anyway, report
it in your return (what, where, when); performing one is forbidden,
reporting it is mandatory. Return the selected contract's YAML envelope.
`result: killed` means the probe's test
command reacted to the mutant under the runner's pass predicate, or the
test pass predicate declared in the task assignment or probe plan when no
runner supplies a verdict; `survived` means it did not. `expectation: met`
means the measured result matches the expected result declared in the task
assignment or probe plan, and `violated` means it does not; both fields
are `not_applicable` when no result was measured. When a mutation-probe
runner is available, run the named probes through it and copy every
supplied `result` and `expectation` verbatim into `mutation_probes`, never
substituting your interpretation of its test output. Quote each supplied
verdict in `tests.executed`; when it supplies only `result`, derive
`expectation` from the expected result declared in the task assignment or
probe plan, and identify that declaration and derivation there. When no
machine-readable verdict is available, state that explicitly in
`tests.executed`, identify the declared test pass predicate and expected
result, and quote the observed baseline and mutant outcomes. Derive
`result` from those observations only when the baseline passed, mutant
application was verified, and the mutant test completed under the same
command and predicate; derive `expectation` by comparing that result with
the declared expected result, and label both derivations as manual.

`runbooks_consulted` has one entry per runbook the briefing's `runbooks`
field lists: its `path`, `steps_followed` (which checklist steps were
followed), and `deviations`, each naming the `step` that was not followed and
the `reason`; emit `runbooks_consulted: []` when the briefing lists no
runbook.

## Reviewer output contract

The output shape remains the same for either selected contract. Compare the
delegated versioned records and producer evidence under Contract selection
above; a recommendation does not replace orchestrator acceptance. A return
that reports an outward action (see AGENTS.md's Outward-facing actions rule)
as executed is invalid; the reviewer never performs one. If you performed
one anyway, report it in your return (what, where, when); performing one is
forbidden, reporting it is mandatory.
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
runbook_notes:
  - ""
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
a string-array field (`summary`, `missing_tests`, `residual_risks`,
`runbook_notes`) must itself be a string, with a diagnostic at `<field>[<index>]` for each one
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
emit `withdrawn: []` when nothing was withdrawn. In run mode `single`, `reproduction` also carries the result of the reviewer's duty to replay every named orchestrator probe; step 7 of the detailed workflow states the rule, and no output field is added for it.

`runbook_notes` lists each deviation from an `authority: data` runbook, naming the
step and the implementer's recorded reason, and each diff to or addition of a
data runbook that does not take effect in the run; emit `runbook_notes: []`
when there is none. A note is not a finding; the runbooks paragraph of the
Subagent input contract states when a deviation is one. The orchestrator
records each note in `05-review-findings.md` (Residual Risks, never the
Findings table) and lists it in `06-handoff.md` (Known Risks).

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
      digest: ""
      repository_identity: ""
      snapshot: ""
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

Knowledge bundle docs in `relevant_docs`: for each configured knowledge bundle
(`knowledge` in `.ai/workflow/manifest.json`; default `docs/okf/`), every
bundle doc whose `sources` intersect the task's `allowed_changes` is listed in
`relevant_docs` with the bundle doc marker, written as `<doc path> (knowledge
bundle; sources: <intersecting sources>)`. The marker is the one annotation
that identifies a bundle doc entry; the task slicer writes it, and the
implementer and reviewer recognize bundle docs by it. Resolve each doc's
`sources` against its bundle's configured `repoRoot` and compare them with the
`allowed_changes` in that repository. A source intersects when
it names a path the task may change, a directory containing one, or a path
inside a directory the task may change; a source that is itself a directory
matches every path beneath it. Compute the
intersection with a bundle tool when one is available (for example `okf-kit
docs-for <bundle dir> <path>... --repo-root <repo root>`), or read each bundle
doc's `sources` frontmatter. A bundle tool is queried with concrete paths, so
first expand each directory or glob entry of `allowed_changes` to the tracked
files it covers (for example `git ls-files -- <entry>`); when reading the
frontmatter instead, match directory and glob entries against each source
directly. An entry whose expansion is empty (for example a directory the task
will create) is still queried: pass the entry itself alongside the expanded
paths, since a path that does not exist yet still matches a directory source
that contains it, or match the entry against the `sources` frontmatter
directly. A brace glob such as `src/{a,b}.ts` is not expanded by a pathspec
and is taken literally by a bundle tool, so expand it into its alternatives
first (for example by the shell) or match it against the `sources` frontmatter
directly. Query a bundle tool with paths relative to the bundle's `repoRoot`:
for a workspace bundle whose `repoRoot` is a repository inside the workspace,
strip that repository's workspace prefix from each `allowed_changes` entry and
run the expansion inside that repository (for example `git -C <repo root>
ls-files -- <entry>`), because an expansion prints paths relative to its
working directory and a workspace-relative path is read as a path beneath the
`repoRoot` and matches nothing; an entry outside that repository is not
queried against that bundle. Each such doc is also listed in `allowed_changes`,
so the implementer can re-stamp it. When `forbidden_changes` cover such a doc,
the slicer leaves it out of `allowed_changes` and records an open question for
the orchestrator instead. For a bundle whose docs live in a different
repository than its sources (a workspace bundle), the re-stamp commit is one
in the bundle's repository within the same task. This reuses `relevant_docs`;
the contract shape is unchanged.

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
