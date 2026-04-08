# 01 - Project Setup

Project setup determines how much chaos you buy later. Enterprise-grade delivery starts before the first feature branch.

## Objectives

The setup phase should produce:

- a shared understanding of the problem
- explicit constraints and success measures
- a baseline architecture and delivery model
- initial controls for security, testing, documentation, and release

## Step 1: Define The Product Frame

Write a short project charter that covers:

- problem statement
- target users and stakeholders
- business goals
- out-of-scope items
- success criteria

Success criteria should include functional outcomes and operational expectations.

Examples:

- checkout completion rate
- response time targets
- uptime target
- recovery expectations
- compliance obligations

## Step 2: Identify Constraints Early

Document constraints before selecting tools:

- regulatory and privacy requirements
- budget and staffing limits
- integration dependencies
- required delivery dates
- data residency or tenant isolation needs

Teams that skip this often pick a stack first and spend months working around it.

## Step 3: Define Non-Functional Requirements

Capture the baseline expectations for:

- availability
- performance
- security
- scalability
- observability
- maintainability

These do not need to be perfect on day one, but they must be explicit.

## Step 4: Choose A Delivery Model

Decide how changes will move through the system:

- branch strategy
- review requirements
- CI baseline
- release strategy
- environment model
- incident and rollback ownership

This is part of product setup, not something to improvise later.

## Step 5: Select The Initial Architecture

Pick the smallest architecture that meets current requirements.

Common default:

- modular monolith
- relational database if transactions matter
- background job runner for async work
- object storage for files
- one deployment unit unless scale or risk justifies more

Choose technologies based on:

- team capability
- ecosystem maturity
- hiring and maintenance cost
- operational fit

Avoid hard-coding the playbook to one frontend, backend, proxy, or hosting preference.

## Step 6: Establish Repository Standards

At minimum, initialize:

- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.gitignore`
- lockfile
- scripts for build, test, lint, and local startup
- code formatting and lint rules
- branch protection in the remote repository

If you use AI collaboration docs such as `.ai/`, treat them as additive context, not as a replacement for standard engineering artifacts.

## Step 7: Create Initial Architecture Records

Before implementation, create:

- system context summary
- service and dependency inventory
- first ADRs for major technology and topology choices
- data classification notes for sensitive domains

## Step 8: Prepare The Security Baseline

Set the default controls now:

- secret handling approach
- access model for environments and repos
- dependency update policy
- vulnerability triage owner
- audit and logging expectations

At minimum, ensure secrets are not stored in source control and access is least privilege by default.

## Step 9: Prepare The Testing Baseline

Define which checks are required before merge:

- type checks
- lint
- unit tests
- integration tests where needed
- build verification

For higher-risk systems, include:

- contract tests
- security scanning
- accessibility checks
- performance smoke tests

## Step 10: Define Release Readiness From Day One

Before shipping the first feature, know:

- how deployments happen
- how to roll back
- how to verify health
- who is paged if it breaks
- where runbooks and dashboards live

If you cannot answer these questions early, the project is accumulating operational debt immediately.

## Setup Deliverables

By the end of setup, you should have:

- project charter
- initial ADR set
- repository standards in place
- CI baseline
- environment plan
- security and documentation owners
- first backlog with acceptance criteria

## Exit Criteria

Setup is complete when:

- goals and constraints are explicit
- the delivery model is defined
- the repository enforces baseline quality controls
- the team knows how code reaches production safely
