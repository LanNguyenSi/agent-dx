# Checklist: Pre-Production

## Release And Ownership

- [ ] Service owner identified
- [ ] On-call or support path defined
- [ ] Release owner identified
- [ ] Rollback plan documented
- [ ] Incident command path defined

## Build And Deploy

- [ ] Deployment is automated and repeatable
- [ ] Immutable artifact or equivalent release package is produced
- [ ] Staging or equivalent validation environment exists
- [ ] Smoke checks are defined

## Data And Recovery

- [ ] Migrations reviewed and tested
- [ ] Backup strategy documented
- [ ] Restore procedure documented
- [ ] Restore testing cadence defined

## Security

- [ ] Secrets are managed outside source control
- [ ] Access is least privilege and reviewable
- [ ] Dependency and vulnerability review completed
- [ ] TLS and network exposure reviewed
- [ ] Threat model exists for high-risk capabilities
- [ ] Access review cadence is defined

## Observability

- [ ] Health and readiness checks exist
- [ ] Structured logs exist
- [ ] Critical metrics and alerts exist
- [ ] Dashboards cover key user journeys

## Product Verification

- [ ] Critical user paths pass in pre-production
- [ ] Error handling is verified
- [ ] Performance is acceptable for expected load
- [ ] Accessibility and compliance expectations are met where required
- [ ] Runbooks exist for rollback and top incident scenarios
