# 05 - Development Workflow

The workflow must produce change that is small, reviewable, testable, auditable, and safe to release.

## Objectives

A good workflow:

- keeps mainline healthy
- gives reviewers enough context to evaluate risk
- makes rollback possible
- provides traceability from requirement to production change

## Workflow Lens: Spec, Context, Eval

Every change should pass through three lenses:

1. Spec-driven: the objective, scope, risk, acceptance criteria, and dependencies are explicit before implementation starts.
2. Context-driven: the change is implemented with enough architectural, operational, security, and domain context to avoid shallow or locally optimized decisions.
3. Eval-driven: the change is judged by evidence through tests, review findings, documentation updates, rollout readiness, and reversibility.

## Recommended Delivery Model

Default to trunk-based development with short-lived branches unless your regulatory context requires heavier release branching.

Baseline rules:

1. `main` or `trunk` is always releasable.
2. Branches are short-lived and scoped to one coherent change.
3. No direct pushes to the protected branch.
4. CI gates must pass before merge.
5. Production releases require a known owner and rollback path.

## Change Lifecycle

### 1. Intake

Every change starts with:

- business objective
- scope
- risk classification
- acceptance criteria
- affected systems and dependencies

### 2. Ready For Implementation

Before coding starts:

- unclear requirements are resolved
- architecture impact is understood
- security and data concerns are identified
- test approach is agreed
- rollout plan is known for risky changes

### 3. Implementation

Developers and agents should:

- keep diffs small
- update tests and docs with the change
- avoid bundling unrelated work
- preserve backward compatibility unless explicitly approved otherwise

### 4. Pull Request

A PR should state:

- what changed
- why the change exists
- risk level
- how it was tested
- rollout or migration notes

### 5. Review

Review is a gate, not a ceremony.

Required checks:

- correctness
- security implications
- test adequacy
- operational impact
- documentation impact

Do not replace review quality with subjective numeric scoring.

### 6. Merge

Merge only when:

- required reviewers approved
- CI passed
- blocking comments are resolved
- migrations and rollout steps are documented

### 7. Release

Choose release strategy based on risk:

- direct release for low-risk internal changes
- feature flags for partially ready behavior
- canary or phased rollout for medium to high risk
- scheduled release window for high-blast-radius changes

## Branch Strategy

Example naming:

- `feat/user-bulk-invite`
- `fix/payment-timeout-retry`
- `docs/release-runbook`

Avoid long-lived feature branches where possible. They hide integration risk and increase merge pain.

## Required Controls

### Branch Protection

- required status checks
- at least one reviewer
- code owner review for sensitive areas
- no force push to protected branches

### CI Baseline

- dependency install with lockfile
- lint and static analysis
- unit and integration tests
- build verification
- security scans appropriate to the stack

### Change Evidence

Capture enough information to answer later:

- who requested the change
- who reviewed it
- what was tested
- when it was deployed
- how rollback would work

## When To Block A Merge

Do not merge-and-fix later for:

- security issues
- data integrity risk
- broken or missing migrations
- missing rollback for risky changes
- failing CI
- unreviewed agent-generated code in sensitive areas

Post-merge follow-up is acceptable only for low-risk cleanup that does not change correctness or safety.

## AI Agent Rules In The Workflow

If agents create or modify code:

- the PR must disclose that agent assistance was used
- humans remain accountable for review and release
- generated code must meet the same standards as handwritten code
- prompts and context should be stable enough to reproduce important changes

## Metrics That Matter

Track metrics that improve delivery, not vanity metrics:

- lead time for change
- deployment frequency
- change failure rate
- mean time to restore service
- escaped defect rate
- flaky test rate

## Exit Criteria

Your workflow is ready when:

- every merge is traceable
- risky changes have explicit rollout planning
- protected branches cannot be bypassed casually
- review capacity does not depend on one person
