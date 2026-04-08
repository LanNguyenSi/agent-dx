# 06 - Testing Strategy

Testing should provide release confidence proportional to the risk of the change.

## Testing Objectives

The testing strategy should answer:

- what could break
- how likely it is to break
- how expensive it would be if it did
- what evidence is required before shipping

Coverage alone is not the strategy.

## Testing Is Part Of Evaluation

Testing is one part of evaluation, not the whole of it.

Before shipping agent-assisted changes, evaluation may also include:

- review quality
- interface compatibility
- documentation impact
- rollback readiness
- operational verification

Tests validate product behavior. Evaluation validates broader delivery confidence.

## Risk-Based Test Planning

Classify changes roughly as:

- low risk: isolated UI copy, internal docs, small refactors with strong test coverage
- medium risk: business logic changes, API behavior changes, new integrations
- high risk: auth, payments, data migrations, tenant isolation, security-sensitive flows

The higher the risk, the stronger the required evidence.

## Test Layers

### Unit Tests

Use for:

- pure domain logic
- validation rules
- parsing and transformation code
- utility functions that contain business meaning

Goal:

- fast feedback
- precise failure localization

### Integration Tests

Use for:

- API plus database behavior
- service interactions
- background job behavior
- cache, queue, or storage integration

Goal:

- validate components working together

### Contract Tests

Use for:

- service-to-service APIs
- third-party integrations
- event schemas

Goal:

- detect interface drift early

### End-To-End Tests

Use for:

- critical user journeys
- high-value business flows
- production-like release smoke coverage

Goal:

- prove the system works from the outside, not to cover every edge case

### Non-Functional Testing

Include when risk requires it:

- performance and load testing
- accessibility testing
- security testing
- resilience or chaos-style exercises

## Suggested Default Mix

For most products:

- many unit tests on domain behavior
- targeted integration tests on core flows
- a small set of stable E2E tests on critical journeys
- contract tests for important interfaces

Avoid both extremes:

- too many brittle E2E tests
- an all-unit-test strategy that never exercises real integration points

## What Must Be Tested Before Merge

At minimum:

- changed business logic
- changed interfaces
- error handling for the changed path
- regression risk for the affected feature

For high-risk changes, add:

- negative-path testing
- access control tests
- migration verification
- observability verification where new signals were added

## Environments And Test Data

Good test strategy also defines:

- where integration tests run
- how test data is created and cleaned up
- how production-like sensitive scenarios are simulated safely
- how flakiness is identified and managed

If a test requires manual environment folklore to pass, it is not a reliable control.

## Release-Time Verification

Add smoke tests after deployment for:

- health endpoints
- login or auth path
- one critical read path
- one critical write path where safe

This is part of the testing strategy, not an operations add-on.

## Anti-Patterns

- 100 percent coverage as a goal in itself
- testing only happy paths
- letting flaky tests stay flaky
- skipping tests because "the agent generated it"
- relying on manual browser checks as the main regression strategy

## Exit Criteria

The testing strategy is sound when:

- required test evidence scales with risk
- critical paths have stable automated coverage
- integrations are exercised realistically
- release verification includes post-deploy smoke checks
