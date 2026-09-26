# Run contracts: acceptance baseline and decision authority

Reference for the `00-goal.md` acceptance-baseline contract and the
`03-decisions.md` decision-authority record that the installed run templates
carry. See the [package README](../README.md) for the rest of the run-state
layout.

## Acceptance-baseline adoption

New runs that need a frozen acceptance contract explicitly record
`Acceptance contract: acceptance-baseline/v1` in `00-goal.md` before planning,
slicing, or delegation. The same file then carries the canonical
`acceptance_baseline` identity and full `acceptance_criteria` records; each
delegated task receives its relevant records unchanged. Existing runs remain
under their recorded contract: missing v1 fields neither trigger migration nor
license a guess about a run's provenance. Communicate the recorded selection
in delegation and resolve unknown provenance before dependent work. A recorded
original string-list contract keeps its original criterion strings and omits
only the added baseline and criterion-evidence fields.

For v1, implementers return `acceptance_baseline: { id, revision }` and one
`criterion_evidence` entry per assigned criterion, with `criterion_id` and
`evidence_refs`. References resolve from the owning run directory and point
to producer artifacts with the checked state and result metadata.
`04-implementation-summary.md` indexes those references; empty references
remain unresolved, and required unresolved criteria block acceptance. Manual
evidence stays explicitly manual. Review findings and orchestrator acceptance
remain separate from this coverage index.

## Decision authority

`03-decisions.md` records decisions with an ID, trigger/evidence, decision,
accountable authority/source, consequences, and an optional superseded
decision. It documents real approval evidence; it does not grant authority.
A reviewer recommendation does not equal orchestrator acceptance, and only
the operator may authorize a critical waiver.
