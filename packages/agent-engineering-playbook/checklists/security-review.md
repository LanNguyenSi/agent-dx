# Checklist: Security Review

## Identity And Access

- [ ] Authentication flow reviewed
- [ ] Authorization model reviewed
- [ ] Privileged actions are logged
- [ ] Shared credentials are not introduced

## Data And Privacy

- [ ] Sensitive data types identified
- [ ] Collection and retention remain justified
- [ ] Data exposure through logs, exports, or telemetry reviewed
- [ ] Tenant isolation or access boundaries reviewed where relevant

## Application Security

- [ ] Input validation and output encoding reviewed
- [ ] Secrets handling reviewed
- [ ] File upload, execution, and deserialization paths reviewed if relevant
- [ ] Abuse prevention or rate limiting reviewed if relevant

## Dependencies And Supply Chain

- [ ] New dependencies were reviewed
- [ ] Dependency and vulnerability scans passed or have approved exceptions
- [ ] Build or deployment changes were reviewed for privilege escalation risk

## AI And Automation

- [ ] Agent permissions remain within approved bounds
- [ ] Sensitive paths received human review
- [ ] Automated actions are attributable and auditable

## Risk Decision

- [ ] Residual risks are documented
- [ ] Required follow-up actions have owners
- [ ] Exception or acceptance was approved where needed
