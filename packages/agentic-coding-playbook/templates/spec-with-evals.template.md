<!-- Template. Copy into your repo and fill in. Tool-agnostic. -->

# Spec with Evals

> A spec gives direction. Evals give feedback. Gates give confidence.

## Goal

Describe the desired outcome in one or two paragraphs.

## Business context

Why does this change matter? Who is affected? What risk is reduced or what
capability is added?

## Scope

The change may touch:

- ...

## Out of scope

The change must not touch:

- ...

## Risk tier

- Tier: 1 (autonomous) / 2 (assisted) / 3 (prohibited)
- Reason:
- Human owner:
- Required review level: normal / rigorous / explicit approval

(See `./risk-classification.template.md` and
`../references/review-levels-and-implementation-standards.md`.)

## Architecture constraints

- ...

## Security constraints

- ...

## Expected behavior

Describe the behavior in concrete terms.

## Examples

### Example 1

- Given:
- When:
- Then:

## Evals

How will correct behavior be recognized? Each eval is a checkable statement,
not a vague intention.

### Eval 1: <name>

- Given:
- When:
- Then:
- Implementation hint: unit test / integration test / contract test / static
  check / manual verification

## Quality gates

- [ ] Build passes
- [ ] Tests pass
- [ ] Static analysis passes
- [ ] Lint passes
- [ ] Security scan considered if relevant

## Stop conditions

Stop and request human review if:

- Public API changes are required
- Auth, permissions, crypto, secrets, or production config are affected
- A database migration is required
- Existing tests fail for unrelated reasons
- The spec conflicts with existing architecture
- The task requires reading secrets or production data

## Handoff requirements

The implementing agent must report:

- What changed
- Which files changed
- Which evals were added or updated
- Which commands were run
- What failed
- Assumptions
- Remaining risks
