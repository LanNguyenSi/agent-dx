# Static Analysis for Agentic Development

**Status:** Draft — proposed classification and evaluation method.

This reference explores how to select and interpret static analysis in an
agentic workflow. It does not disable or reclassify any existing required check.
Changes to enforcement need the project's normal policy decision and review.

Read alongside [Quality Assurance](../playbooks/07-quality-assurance.md),
[Agent-Oriented Design Principles](agent-oriented-design-principles.md), and the
[Verification Handoff Contract](verification-handoff.md).

## What An Analyzer Actually Checks

Static analysis inspects source code or a derived representation without running
the application on concrete inputs. An analyzer may combine several techniques:

| Technique | Representation or question | Example finding |
| --- | --- | --- |
| Text, token, or syntax-tree rules | Does this construct match a rule? | A prohibited API call or naming violation. |
| Type analysis | Do values and operations satisfy the type system? | An incompatible argument or possible null access. |
| Control-flow analysis | Which execution paths might exist? | Unreachable code or a missing return path. |
| Data-flow and taint analysis | Where can values or untrusted data propagate? | External input reaching a sensitive operation without a modeled safeguard. |
| Symbolic execution or abstract interpretation | What can happen for symbolic inputs or approximated program states? | A potential invalid resource use or division by zero. |
| Dependency and metric analysis | Which structural relationships or counts exist? | Forbidden imports, cycles, duplication, or complexity above a threshold. |

The technique alone does not determine severity. A syntax rule can enforce an
important boundary; a sophisticated analysis can produce a low-confidence
finding. For concrete examples, see
[ESLint's rule API](https://eslint.org/docs/latest/extend/custom-rules),
[CodeQL's data-flow documentation](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/),
and the [Clang Static Analyzer](https://clang.llvm.org/docs/ClangStaticAnalyzer.html).

## Working Thesis

Static analysis can provide repeatable feedback independent of an agent's claim
that its work is correct. Its value depends on the property checked, coverage,
signal quality, and cost of responding. A higher volume of automated edits makes
those properties worth evaluating explicitly; it does not prove that every
traditional rule should become stricter or disappear.

## Classify Individual Rules Before Choosing Enforcement

The following is a proposal for designing or revising a policy, not permission
to reinterpret a failing check during a task.

| Rule class | Proposed treatment | Functional justification | Counterexample or limit |
| --- | --- | --- | --- |
| Concrete defects and credible unsafe paths | Candidate for blocking, with severity and confidence considered. | Prevent known classes of incorrect or unsafe behavior. | An approximated path may be infeasible; investigate rather than blindly rewrite. |
| Explicit architecture or safety invariants | Candidate for blocking where the invariant is approved and the check covers it. | Prevent forbidden coupling or boundary violations. | A generic ban on all cycles may lack a relevant project requirement. |
| Complexity, size, duplication, and naming heuristics | Investigation signal unless a justified policy makes them mandatory. | Locate areas worth closer examination. | Splitting a function to satisfy a threshold may increase navigation and leave behavior equally difficult to reason about. |
| Layout and formatting | Deterministic automatic normalization where safe. | Reduce noisy diffs and inconsistent edits at low cost. | A formatter is not a correctness check; semantic changes need separate verification. |

The same category can contain different rules. A name may be cosmetic, or it may
be part of a framework's discovery contract. Duplicate mechanics may be harmless,
while duplicate authorization policy can drift. Classify the actual property
and consequence, not the tool or rule label.

## Hypotheses To Test

### Concrete Diagnostics Can Shorten Repair Loops

**Hypothesis:** A stable rule identifier, exact location, explanation of the
violated property, and relevant path or counterexample help agents repair errors
more reliably than a generic quality score.

**Counterexample:** A misleading diagnostic or wrong library model can send an
agent through repeated repairs to correct code. A suggested fix may silence the
rule without fixing the underlying defect.

**Validation:** Compare accepted fixes against independent behavioral checks,
false-positive investigations, new regressions, and repair iterations. Count
suppression or rule weakening separately from a successful repair.

### Human Readability Metrics Need Agent-Specific Validation

**Hypothesis:** A threshold calibrated around human comprehension need not predict
agent change reliability. For example, Sonar describes
[Cognitive Complexity](https://www.sonarsource.com/resources/cognitive-complexity/)
as a measure of method understandability; this does not establish an agent
performance threshold.

**Counterexample:** Nesting and complicated state transitions may impede both
humans and agents. Removing the metric without examining outcomes may discard a
useful warning.

**Validation:** Compare representative agent changes above and below a threshold,
and compare deliberate refactors with their starting versions. Control for task
difficulty and evaluate regressions, context needed, and repair cost. Correlation
alone does not show that forcing the score down improves outcomes.

### Automatic Formatting Can Avoid Unproductive Agent Work

**Hypothesis:** A consistent formatter reduces layout-only reasoning and review
work while preserving useful diffs.

**Counterexample:** Broad formatting churn can obscure a small behavioral change;
format-sensitive content may require special handling.

**Validation:** Track layout-only repair rounds and diff noise, and verify that
the configured transformation preserves the intended behavior. Keep formatting
scope proportional to the task.

## Know The Evidence Boundary

A clean analysis result establishes only what the tool checked under its
configuration and modeling assumptions. It is not proof of full correctness,
security, or coverage. Dynamic loading, external libraries, type escapes, and
incomplete models can leave gaps; conservative approximations can cause false
positives. Type systems also differ in their guarantees; see TypeScript's
[documented soundness limits](https://www.typescriptlang.org/docs/handbook/type-compatibility#a-note-on-soundness).

Keep static analysis alongside behavior tests, contract checks, operational
observation, and review appropriate to the risk. No combination guarantees that
an omitted requirement will be discovered.

Record the tool and rule configuration, analyzed scope, checked revision and
relevant dirty state, diagnostics, suppressions, exclusions, and execution
status. Distinguish a completed clean check from a crash, timeout, missing tool,
skipped check, or waiver. A waiver is an authorized exception, not a pass.

## Adopt A Rule With A Reason

When proposing a new rule or a change to its severity, document:

1. The property protected and the consequence of violating it.
2. The scope, analysis limitations, and expected false-positive cases.
3. Whether it blocks, informs investigation, or performs a safe automatic fix.
4. How a repair is verified beyond making the diagnostic disappear.
5. Who owns exceptions and how the rule's usefulness will be reassessed.

Pilot uncertain rules as signals where existing policy permits. Promote or
retire them based on observed defects prevented, repair regressions, missed
defects, and investigation cost. Keep experiment details outside reusable rules
and avoid replacing one blanket quality score with an unvalidated agent score.

Agents should not weaken checks, add suppressions, or alter the acceptance
criteria merely to complete their own task. Follow the existing exception and
review process; this draft creates no new authority to waive a gate.
