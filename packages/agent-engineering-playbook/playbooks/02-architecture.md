# 02 - Architecture

Architecture should reduce long-term cost of change while making risk visible. It is not a contest to use the most advanced pattern.

## Architecture Principles

- prefer the simplest deployable shape that meets current needs
- make boundaries explicit
- design for operability and failure
- keep security and data handling inside the architecture, not outside it
- evolve with evidence, not fashion

## Start With Context

Before deciding on patterns, define:

- users and external actors
- critical business flows
- upstream and downstream dependencies
- trust boundaries
- data sensitivity
- expected scale and latency constraints

Use a system context diagram and a short written narrative. If the team cannot explain the system simply, it will not operate it simply.

## Default Recommendation: Modular Monolith First

Most products should start with a modular monolith unless there is a concrete reason not to.

Benefits:

- simpler deployment
- easier debugging
- fewer distributed failure modes
- better transactional consistency
- lower coordination cost

Move to multiple services only when:

- scale characteristics are materially different
- organizational ownership requires separation
- compliance or data isolation demands it
- release independence creates clear business value

## Recommended Internal Structure

Organize around domains with clear separation between:

- interface layer
- application or use-case layer
- domain logic
- infrastructure and data access

This does not require heavyweight clean architecture ceremony. It requires disciplined boundaries.

## Architecture Decision Areas

Every serious system should make explicit decisions about:

- service boundaries
- database and consistency model
- API style and contract ownership
- async processing model
- tenancy and isolation model
- identity and authorization approach
- observability strategy
- rollout and migration patterns

These belong in ADRs.

## Data Architecture

Define early:

- system of record for key entities
- data ownership by service or module
- retention and deletion rules
- backup and recovery requirements
- reporting or analytics boundaries

If multiple systems can mutate the same data without a clear source of truth, the architecture is already drifting.

## Integration Architecture

For each external integration, document:

- protocol and authentication method
- failure expectations
- retry and timeout policy
- idempotency approach
- ownership and monitoring

Integrations are often where enterprise products fail in practice.

## API Guidance

Choose REST, GraphQL, RPC, or event-driven contracts based on system needs, not ideology.

Regardless of style, require:

- stable schemas
- clear error contracts
- auth and authorization model
- versioning or deprecation strategy
- contract tests for critical interfaces

## Resilience Patterns

Consider when needed:

- timeouts
- retries with backoff
- circuit breakers
- queues for decoupling
- rate limiting
- bulkheads for failure isolation

Do not add them all by default. Add them where failure modes justify the complexity.

## Security Architecture

Architecture must include:

- trust boundaries
- secret flows
- privilege boundaries
- tenant and data isolation
- auditability requirements

Threat modeling should happen before exposing the system broadly or handling sensitive data.

## Architecture Fitness Checks

Review architecture regularly with these questions:

- Can teams change one area without breaking unrelated areas?
- Can operators see where and why failures happen?
- Are the main data flows and dependencies documented?
- Are we paying complexity for a real need?
- Could this design survive a security review or incident review?

## Exit Criteria

Architecture quality is acceptable when:

- the chosen system shape matches actual needs
- boundaries are documented and enforceable
- failure handling is designed, not accidental
- data and security concerns are built into the design
