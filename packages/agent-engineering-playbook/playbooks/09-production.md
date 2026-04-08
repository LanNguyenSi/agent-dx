# 09 - Production Readiness

Production readiness means the system can be deployed, observed, operated, and recovered under realistic conditions.

## When To Apply

This chapter becomes mandatory in `Phase 2 - Production`.

Use parts of it earlier if:

- a first live release is near
- support expectations already exist
- the system has meaningful user or business impact

## Production Baseline

Before a service is considered production-ready, define:

- service owner
- runtime topology
- dependencies
- SLOs or clear service expectations
- incident path
- rollback strategy
- backup and restore expectations

If these are unclear, the product is not ready regardless of code quality.

## Environment Strategy

Recommended minimum:

- local development
- CI test environment
- staging or pre-production environment for release validation
- production

The higher the risk, the closer staging should resemble production.

## Deployment Principles

- automate deployment steps
- prefer immutable artifacts
- make deployments repeatable
- keep configuration externalized
- choose a rollout strategy proportional to risk

Possible rollout patterns:

- rolling deployment
- blue/green deployment
- canary rollout
- feature-flagged release

No single proxy, cloud, or container stack is universally correct. Standardize per organization, not per personal preference.

## Database Change Discipline

Schema changes deserve the same rigor as code:

- review migrations
- test them on realistic data
- ensure backward compatibility when rolling deployments are possible
- define rollback or forward-fix strategy before release
- verify backup freshness before high-risk changes

Never normalize unsafe shortcuts such as bypassing migration tooling without a documented reason and compensating controls.

## Secrets And Access

Production secrets should:

- come from a managed secret store or equivalent controlled mechanism
- be rotated on a defined schedule or after exposure
- never be shared through chat or committed to source control
- be scoped by environment and privilege

Production access should be limited, logged, and reviewable.

## Observability

Minimum production signals:

- health and readiness checks
- structured application logs
- request, job, or workflow metrics
- alerting tied to user-impacting failures
- dashboards for the critical path

Add tracing when requests cross service boundaries or debugging latency is otherwise difficult.

## Reliability And Recovery

You need more than backups. You need recovery confidence.

Define:

- backup cadence
- restore test cadence
- RPO and RTO targets
- failover expectations
- operator runbooks for common incidents

Backups that are never restore-tested are assumptions, not safeguards.

## Security In Production

Production readiness includes:

- vulnerability management for runtime dependencies
- network exposure review
- TLS and certificate lifecycle management
- audit logging where required
- rate limiting and abuse controls where relevant

## Release Verification

After deployment:

- run smoke checks
- verify dashboards and alerts are healthy
- inspect error and latency signals
- confirm critical user journeys still work
- keep the owner available through the initial watch period for risky releases

## Rollback Expectations

A rollback plan must state:

- what artifact or config will be restored
- what data changes are reversible and what are not
- who can execute the rollback
- how the team will verify recovery

"Redeploy something older" is not a plan unless the exact artifact and procedure are known.

## Exit Criteria

Production readiness is credible when:

- release steps are automated and rehearsed
- observability covers the critical path
- operators know what to do when things break
- recovery procedures are documented and exercised
