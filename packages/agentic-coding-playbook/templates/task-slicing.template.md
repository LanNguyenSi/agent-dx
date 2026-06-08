<!-- Template. Copy into your repo and fill in. Tool-agnostic. -->

# Task Slicing Plan

Turn one larger spec into small, safe, independently reviewable tasks.

## Source spec

- Spec file:
- Related issue:
- Human owner:

## Slicing principles

- Prefer small diffs
- Prefer tests before implementation when behavior is known
- Keep discovery separate from implementation
- Avoid speculative refactoring
- Make dependencies explicit
- Make each task independently reviewable where possible

## Tasks

### Task 1: <short imperative title>

- **Goal:**
- **Scope:**
- **Out of scope:**
- **Implementation notes:**
- **Evals:**
- **Risk:** Low / Medium / High
- **Dependencies:** None / Task N
- **Agent prompt:**

  ```text
  Implement only this task.
  Do not solve later tasks.
  Do not perform unrelated refactoring.
  Run the listed evals and report results.
  ```

## Recommended execution order

1. ...

## Parallelizable tasks

- ...

## Stop conditions

- unclear interface ownership
- failing existing tests unrelated to the task
- missing dependency
- contradictory specs
- security-sensitive behavior not specified
