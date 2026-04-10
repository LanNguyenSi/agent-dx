# Review Levels and Implementation Standards

This paper explains two related ideas that strongly affect real-world outcomes in agentic coding:

1. the difference between no review, normal review, and rigorous review
2. the need for explicit implementation standards for coding agents

It is meant as a reference companion to the Agentic Coding Playbook.

## Why this matters

Strong teams do not get reliable outcomes from model choice alone.
They get reliable outcomes from the combination of:

- agent capability
- review depth
- implementation standards

In practice, the difference between agentic coding with no review, with review, and with rigorous review is often larger than the difference between the models themselves.

## 1. No review

The agent ships an answer and nobody seriously checks it.

### Typical characteristics

- fast and impressive
- often locally plausible, but globally inconsistent
- hidden errors stay undetected
- assumptions, side effects, and edge cases are rarely examined well

### Typical outcomes

- the happy path works, but real operating conditions do not
- existing architecture is violated unintentionally
- naming, boundaries, ownership, and security become inconsistent
- tests may exist, but validate too little or the wrong thing

### Best use

- prototyping
- ideation
- disposable experiments

### Risk

- brownfield systems
- production systems
- security-sensitive systems

## 2. With review

An agent produces a result and a human or second agent reviews it afterward.

### Typical characteristics

- obvious mistakes are reduced significantly
- readability and gross architecture violations are easier to catch
- misunderstandings of the task are often detected in time

### What usually improves

- compile and syntax issues
- simple logic mistakes
- poor naming
- duplicate logic
- missing baseline tests
- obvious validation and security issues

### Remaining weakness

Review often stays shallow and becomes:

> looks okay

Deeper system failures, hidden assumptions, and integration mistakes can still pass through.

### Result

- much better than no review
- often enough for many internal tools
- not automatically production-ready

## 3. With rigorous review

Rigorous review does not just inspect code. It tests the truth of the change.

### Questions rigorous review asks

- does the implementation match the spec?
- does it respect architecture rules?
- does it satisfy security expectations?
- does it survive real edge cases?
- does it work operationally, including deployment, observability, and ownership?

### Typical components

- code review
- spec review
- test review
- counterexamples and failure-mode analysis
- architecture and security checks
- realistic or near-real validation

### What improves

- false assumptions become visible
- “works on my machine” solutions get exposed
- hallucinated APIs, contracts, or library behavior get caught
- brownfield damage is reduced significantly
- the result becomes more maintainable and accountable

### Tradeoff

- slower
- more expensive in the moment
- often dramatically cheaper over system lifetime

## The deeper pattern

A useful simplification is:

- **no review** → the agent optimizes for a plausible answer
- **with review** → the system optimizes for a reviewable answer
- **with rigorous review** → the system optimizes for a responsible change

That is a major difference.

## Teams need more than prompts

Strong teams need not only capable agents, but a clear quality model for implementation.

A durable model has three parts:

## 1. Role

Examples:

- Symfony Implementer
- Next.js Implementer
- Backend Integrations Implementer

Role defines the primary responsibility of the agent.

## 2. Skill

Examples:

- Clean Code
- Testing
- Security
- Refactoring Discipline
- API Design
- Failure Handling

Skill defines what the agent is expected to be particularly reliable at.

## 3. Standard

Examples:

- Quality-First Implementation Rules
- Safe Change Rules
- Brownfield Change Discipline

Standard defines how the agent is allowed to implement changes and what quality bar applies.

## Why this model is stronger

`Role + Skill + Standard` is more useful than simply saying:

> you are a senior engineer

Because it separates:

- what the agent is responsible for
- what capabilities it should apply
- what quality rules constrain implementation

That separation makes implementation agents much more reliable in real teams.

## Example: Quality-First Implementation Rules

1. implement only the requested scope
2. prefer the smallest clean change
3. follow existing patterns and architecture boundaries
4. do not change security, auth, or infrastructure logic without explicit instruction
5. add or update tests when behavior changes
6. mark assumptions, risks, and uncertainties explicitly
7. do not introduce unrequested refactors, dependencies, or side changes
8. deliver only results that can be technically verified

## Practical conclusion

Agentic coding maturity is not determined by model quality alone.
It depends on:

- the review level in use
- the implementation standard in force
- the roles, skills, and boundaries assigned to the agent

In other words, real maturity comes from the combination of:

- **agent**
- **review**
- **standard**

## Short version

**No review:** fast, but fragile.

**With review:** useful, but still shallow.

**With rigorous review:** slower, but responsible.

For implementation agents:

**Quality before speed. Precision before breadth. Respect for the existing system before optimization impulse.**
