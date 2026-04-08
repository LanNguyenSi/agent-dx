# 04 - Design Principles

Good enterprise products do not emerge from style preferences. They emerge from design choices that reduce risk, preserve changeability, and make failure visible.

## Primary Principles

### Design For Change

Assume requirements, traffic patterns, and integrations will change. Favor designs that localize impact and keep changes reversible.

Signals:

- small interfaces
- explicit dependencies
- versioned contracts
- isolated domains and modules

### Secure By Default

The safe path must be the normal path.

Examples:

- least-privilege permissions
- deny-by-default authorization rules
- secure headers and input validation
- secrets from managed stores, not source control

### Simplicity Before Cleverness

Use the simplest design that satisfies current risk and scale. Enterprise systems fail from accidental complexity more often than from insufficient abstraction.

### Explicit Tradeoffs

Every meaningful design choice should answer:

- what problem is being solved
- what alternatives were considered
- what risks are accepted
- how the choice can be revisited later

That belongs in ADRs, not in someone's memory.

### Make Failure Containable

Failures should be isolated, observable, and recoverable.

Design for:

- timeouts
- retries with idempotency
- partial failure handling
- graceful degradation
- rollback or forward-fix options

### Build In Operability

If a system cannot be understood in production, it is not well designed.

Minimum expectations:

- structured logs
- metrics for critical flows
- traces for distributed paths
- health and readiness endpoints
- dashboards and runbooks for common failures

### Protect Data Intentionally

Data handling rules are design decisions.

Define:

- data classification
- retention periods
- deletion and archival strategy
- tenant isolation approach
- encryption requirements at rest and in transit

### Preserve Compatibility

For APIs, events, schemas, and config:

- prefer additive changes
- version breaking changes
- document deprecations
- define migration and rollback steps before rollout

## Practical Heuristics

### Start With A Written Problem Statement

A spec is useful, but it should describe outcomes, constraints, assumptions, and risk. A list of files to edit is not enough.

### Read Existing Code Before Extending It

Consistency reduces bugs, but inherited patterns should still be challenged when they are weak.

### Separate Decision Layers

- UI concerns stay out of domain logic.
- Domain rules stay out of controllers and handlers.
- Infrastructure concerns stay behind interfaces where useful.

### Prefer Boring Technology On Critical Paths

Innovation is fine. Novelty on the critical path needs explicit justification.

### Design For Automation

If review, testing, release, or rollback cannot be automated, the design is creating operational cost.

## Common Design Smells

- authentication and authorization mixed ad hoc into handlers
- hidden coupling through shared tables, environment variables, or mutable globals
- APIs that return inconsistent shapes and error contracts
- business rules duplicated across UI, API, and jobs
- no idempotency for externally triggered writes
- no strategy for rate limiting, abuse prevention, or backpressure

## Review Questions

- What breaks if this dependency is slow or unavailable?
- What is the blast radius if this change is wrong?
- Can this be tested without full-system setup?
- Can operators detect and recover from failure quickly?
- Is sensitive data exposed anywhere it should not be?

## Exit Criteria

Design quality is acceptable when:

- the design can be explained with clear boundaries
- major risks are documented, not implied
- the safe behavior is the default behavior
- failure handling is intentional
- the system remains operable after the change ships

### SVGs/Glyphs over Emojis in UI

**Rule:** Use SVG icons or icon libraries (Lucide, Heroicons, Phosphor) instead of emoji characters in production UI.

**Why:**
- Emojis render differently across OS and browsers (Apple vs Google vs Windows)
- SVGs are scalable, styleable with CSS, and consistent
- Emoji-heavy UI looks casual/demo-ish; SVGs signal production-ready quality
- Easier to maintain (size, color, hover states via CSS)

**Exceptions:**
- Chat messages / user-generated content → emojis are fine
- Marketing copy / social posts → emojis are fine
- Internal tooling / debug dashboards → emojis acceptable

**Example:** telerithm.cloud landing page SVG-Umstellung → DevReview 8.2 → 9.8/10.

> "SVGs oder Glyphs anstatt Emojis → wirkt professioneller" — Lan
