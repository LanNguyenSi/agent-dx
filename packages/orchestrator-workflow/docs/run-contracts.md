# Run contracts: acceptance criteria and decision authority

Reference for the acceptance-criteria contract and the
`03-decisions.md` decision-authority record that the installed run templates
carry. See the [package README](../README.md) for the rest of the run-state
layout.

## Acceptance criteria

There is one acceptance contract. Each task carries `acceptance_criteria` as a
plain list of strings: in the task slicer's output, in `02-tasks.md`, and in the
delegation input the orchestrator sends an implementer or reviewer. The
orchestrator copies them from the task unchanged. Implementers report check
results in `tests.executed` and `summary`, each with a recorded verify envelope
or the exact command plus its exit code; reviewers check those claims against
the envelope or command output. Review findings and orchestrator acceptance
stay separate from the implementer's evidence.

The earlier frozen `acceptance-baseline/v1` contract (a baseline identity with
structured criterion records and per-criterion evidence references) is no longer
supported. Version 0.45.x was the last release that supports it; see the
changelog for how to handle a run that recorded it.

## Decision authority

`03-decisions.md` records decisions with an ID, trigger/evidence, decision,
accountable authority/source, consequences, and an optional superseded
decision. It documents real approval evidence; it does not grant authority.
A reviewer recommendation does not equal orchestrator acceptance, and only
the operator may authorize a critical waiver.
