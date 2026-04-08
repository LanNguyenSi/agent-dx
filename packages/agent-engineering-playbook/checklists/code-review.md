# Checklist: Code Review

## Correctness

- [ ] Change solves the stated problem
- [ ] Acceptance criteria are met
- [ ] Edge cases and error paths were considered

## Safety

- [ ] Authentication and authorization are correct
- [ ] No secrets or sensitive data were introduced
- [ ] Data integrity and migration impact were reviewed
- [ ] Rollback or mitigation is clear for risky changes
- [ ] Security review was performed for sensitive changes

## Engineering Quality

- [ ] Code follows existing standards or intentionally improves them
- [ ] Tests are adequate for the risk of the change
- [ ] CI passed
- [ ] Logging, metrics, or alerts were updated if behavior changed

## Operational Impact

- [ ] Deployment steps are documented if needed
- [ ] Runbooks or docs were updated if needed
- [ ] Backward compatibility concerns were addressed
- [ ] Dependencies and interfaces were reviewed for breakage risk
- [ ] Change classification matches the actual release risk

## AI-Assisted Changes

- [ ] Agent-generated code was reviewed with the same rigor as human-written code
- [ ] Hidden assumptions or undocumented conventions were removed
