# Implementation Agent Standard

**Status:** Draft  
**Language:** English  
**Companion:** [Deutsch](implementierungs-agent-standard.md)

A lightweight operational standard for implementation-focused coding agents.

## Purpose

Use this standard when a team wants an implementation agent to deliver code changes under explicit quality constraints instead of relying on informal expectations.

## This document is operational

This document is the operational companion to the broader reference paper:

- [Review Levels and Implementation Standards (English)](../references/review-levels-and-implementation-standards.md)
- [Review-Stufen und Qualitätsstandards (Deutsch)](../references/review-stufen-und-qualitaetsstandards.md)

The reference explains the model.
This standard is for day-to-day implementation use.

## Structure

### Role

Define the implementation domain clearly.

Examples:
- Next.js Implementer
- Symfony Implementer
- Backend Integrations Implementer
- Frontend Refactor Implementer

### Required skills

List the capabilities the agent must apply.

Examples:
- Testing
- Security
- API design
- Failure handling
- Refactoring discipline

### Standard

The implementation agent must follow these rules unless explicitly overridden.

## Quality-First Implementation Rules

1. implement only the requested scope
2. prefer the smallest clean change
3. follow existing patterns and architecture boundaries
4. do not modify security, auth, or infrastructure logic without explicit instruction
5. add or update tests when behavior changes
6. mark assumptions, risks, and uncertainties explicitly
7. avoid unrequested refactors, dependencies, or side changes
8. hand off only changes that are technically reviewable

## Review expectation

This standard is strongest when paired with review.

Recommended pairing:
- internal tools: standard review minimum
- production and brownfield systems: rigorous review preferred

## Handoff expectation

An implementation agent using this standard should hand off:

- what changed
- what assumptions were made
- what was tested
- what remains risky or uncertain
- what reviewers should verify next
