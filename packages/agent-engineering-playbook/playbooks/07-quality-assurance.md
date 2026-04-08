# 07 - Quality Assurance

Quality assurance is the system of controls that turns engineering intent into release confidence.

## Quality Gates

### Gate 1: Ready To Build

- scope is understood
- risk is classified
- acceptance criteria are testable
- dependencies and constraints are known

### Gate 2: Ready For Review

- code compiles
- relevant tests pass locally or in CI
- documentation and migrations are included
- operational impact is described

### Gate 3: Ready To Merge

- reviewers approved
- CI passed
- security and dependency checks passed or have approved exceptions
- rollback or mitigation is defined for risky changes

### Gate 4: Ready To Release

- deployment plan is clear
- monitoring exists for the affected path
- on-call or support owner knows about the change
- runbooks are updated if behavior changed

### Gate 5: Verified In Production

- deployment completed successfully
- smoke checks passed
- no unexpected error spike
- business-critical flow still works

## What QA Must Cover

Quality is broader than "does it work."

Evaluate:

- functional correctness
- resilience under failure
- usability and accessibility
- security and abuse resistance
- performance and capacity impact
- documentation and support readiness

## Automation Baseline

Every mature product should automate as much of this as possible:

- linting and formatting
- type checking
- unit and integration tests
- dependency vulnerability scanning
- secret scanning
- build and packaging verification
- release smoke checks

Add more based on risk:

- contract tests
- visual regression
- load testing
- DAST or API security scans
- infrastructure policy checks

## Defect Triage

Use a simple severity model:

- `sev1`: critical outage, data loss, security breach, or regulatory exposure
- `sev2`: major function degraded, high-impact user issue
- `sev3`: contained defect with workaround
- `sev4`: low-impact defect or cosmetic issue

Severity must influence release decisions. A team that treats every bug equally usually ships risk blindly.

## Evidence Over Confidence

Enterprise quality decisions should rely on artifacts:

- test results
- scan results
- dashboards
- migration plans
- incident or rollback notes

Subjective review scores are optional at best. They are not a control.

## Common Failure Modes

- testing only the happy path
- relying on manual verification for every release
- shipping without observability for new behavior
- allowing "temporary" exceptions with no expiry
- treating post-merge fixes as normal for risky issues

## Exit Criteria

The QA system is credible when:

- release confidence comes from evidence
- quality gates are visible and repeatable
- exceptions are explicit and time-bound
- production verification is part of the release, not an afterthought
