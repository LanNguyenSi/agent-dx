# Agent-Oriented Design Principles

**Status:** Draft — working hypotheses, not a validated ranking of design rules.

This reference explores how design choices might change when agents perform
most implementation and maintenance. It proposes decision criteria for
experimentation; it does not replace existing standards, review requirements,
security controls, or release gates.

Read alongside [Design Principles](../playbooks/04-design-principles.md),
[Architecture](../playbooks/02-architecture.md), and
[Static Analysis for Agentic Development](static-analysis-for-agentic-development.md).

## Working Thesis

Evaluate implementation structure primarily by its contribution to reliable,
economical construction, verification, operation, and change. Code style and
elegance have value when they support those outcomes. Human readability remains
useful for review, diagnosis, ownership, and recovery; agents also need to
discover and interpret the code.

This thesis concerns implementation aesthetics. Product usability,
accessibility, visual quality, and brand requirements remain legitimate user
outcomes, even when no human routinely reads the implementation.

Passing today's tests is not the whole objective. Include security, operational
failure, future change, and the cost of detecting mistakes. A familiar pattern
can help an agent navigate; an unfamiliar but compact solution can make that
harder. Neither brevity nor an established pattern proves quality by itself.

## Compare The Context Needed For A Change

For a representative task, ask:

- Which contracts, assumptions, files, and dependencies must be understood?
- Can the relevant behavior be understood together, or does it require repeated
  navigation through forwarding layers and hidden configuration?
- Which unrelated consumers might be affected?
- Can correctness and failure handling be checked locally?
- What evidence would expose a wrong implementation?

File count and token consumption are diagnostic signals, not universal limits.
A shared abstraction can reduce the context needed by hiding details behind a
reliable contract. Inlining everything can destroy that benefit.

## DRY: Distinguish Shared Knowledge From Similar Code

**Hypothesis:** Tolerating some repeated mechanics can reduce coupling and
navigation compared with an abstraction introduced only to remove similar text.

**Decision:** Ask whether the copies express the same rule and must evolve
together. Centralize authoritative business knowledge or derive its copies from
one source. Keep independently changing behavior separate even when its current
syntax looks alike. If duplication is retained, consider how drift will be
detected and whether the maintenance cost is acceptable.

**Counterexample:** Two loops over unrelated collections need not share a
generic framework. Invoice rounding used by checkout and billing does need a
consistent rule. Cheap edits do not make it safe to forget one implementation.

**Validation:** Compare representative changes for missed update sites,
regressions in unrelated consumers, context required, and repair effort. The
hypothesis weakens if a shared helper consistently improves these outcomes.

## YAGNI: Charge Speculation For Its Future Cost

**Hypothesis:** Avoiding unsupported features and extension points becomes more
valuable when generation is cheap but every added state still needs verification
and maintenance.

**Decision:** Implement current requirements and known constraints. Before adding
an optional provider, plugin system, or configuration axis, identify its present
consumer or the costly-to-reverse decision that justifies preparation.

**Counterexample:** One current integration rarely justifies a universal
integration platform. An already required data-retention boundary or a difficult
migration may justify early design work. YAGNI does not excuse omitted failure
handling, security requirements, or foreseeable operational needs.

**Validation:** Compare unused capabilities, verification surface, change cost,
and later rework. Evidence that minimal versions repeatedly force expensive
migrations would limit the hypothesis for that class of decisions.

## KISS: Minimize Reasoning Burden, Not Just Lines

**Hypothesis:** Explicit control flow, few special cases, and discoverable
dependencies improve agent change reliability more consistently than short code
or very small functions alone.

**Decision:** Prefer a design whose state transitions, side effects, and contracts
can be followed and tested. Extract when doing so isolates meaningful behavior
or a stable boundary; keep steps together when extraction only adds navigation.

**Counterexample:** A sequence of small forwarding functions can obscure one
simple operation. Conversely, a long function mixing authorization, persistence,
and retries can require too many assumptions at once. A well-tested library can
be simpler to consume than a local reimplementation of its internals.

**Validation:** Compare defect rate, diagnosis effort, independent acceptance
results, and context used for equivalent changes. Reject a simplification that
saves tokens while increasing mistakes or weakening the checks.

## SOLID: Evaluate Each Principle Separately

These are proposed interpretations for agent-oriented work, not evidence that
the principles have a particular performance ranking.

| Principle | Functional value to preserve | Application to question | Counterexample or boundary |
| --- | --- | --- | --- |
| Single Responsibility | Keep behavior that changes for the same reason cohesive; separate independently changing responsibilities. | A class or file for every tiny operation. | Combining unrelated policy and transport concerns saves files but couples their changes. |
| Open/Closed | Stable extension contracts protect existing consumers. | Predicting extension axes before a real requirement exists. | A public plugin interface needs compatibility; a private helper can often be changed directly. |
| Liskov Substitution | Implementations promised as substitutes must preserve the behavioral contract, including errors and side effects. | Treating matching method signatures as proof of substitutability. | An adapter that rejects inputs accepted by the contract is not an equivalent replacement. |
| Interface Segregation | Consumers depend on capabilities they actually need, limiting coupling and relevant context. | Many tiny interfaces without distinct consumer needs. | A read-only consumer should not need a write-capable contract; one cohesive consumer may need several related methods. |
| Dependency Inversion | Keep policy independent of volatile mechanisms through meaningful contracts. | An interface, factory, and container entry for every concrete class. | Isolating a remote payment service supports controlled failure tests; wrapping a stable local value object may add only indirection. |

**Validation:** Compare designs on consumer breakage, change propagation,
contract violations, isolation of tests, and navigation effort. For Liskov
substitution, test the promised behavior across implementations rather than
measuring whether fewer interfaces make the code look simpler. Preserve a
boundary when its protection outweighs its indirection cost.

## Evaluate Before Promoting A Hypothesis To A Rule

Use representative tasks on comparable starting snapshots. Record model and
harness versions, available context and tools, task requirements, and check
configuration in the experiment record. Keep unrelated conditions stable and
repeat trials to expose variability; vary execution order where it can affect
results.

Judge outputs against acceptance criteria defined before implementation, with
evaluation protected from unilateral changes by the implementing agent. Measure
correctness and regressions first, then context consumption, tool calls, elapsed
time, cost, and human intervention. An evaluator can also be wrong: investigate
disagreements and gaps rather than treating another agent's approval as proof.

Record counterexamples as well as successes. A result for one model, task family,
or repository does not establish a universal style rule. Keep measurements and
incident histories in experiment records; reusable guidance should state the
bounded conclusion and link to supporting evidence when it exists.

## Review Prompt

For a proposed abstraction, duplication, or refactor, explain:

1. Which current requirement or invariant does it serve?
2. How does it change the context and dependencies needed for future edits?
3. What functional or operational regression could it introduce?
4. How will its benefit and its failure modes be checked?

If the only benefit is a preferred appearance of the implementation, treat it as
a style preference when evaluating the proposal. Existing enforced conventions
still apply until their owner deliberately changes them; this draft is not an
exception mechanism.
