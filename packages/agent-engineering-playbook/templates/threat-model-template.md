# Threat Model Template

```markdown
# Threat Model: [System Or Change]

## Scope

What is being reviewed and what is out of scope.

## Assets

- Sensitive data
- Privileged functions
- External interfaces

## Trust Boundaries

- User to application
- Service to service
- Internal to third-party

## Entry Points

- APIs
- Admin surfaces
- Background jobs
- File or message ingestion

## Threats And Abuse Cases

| Threat | Entry Point | Impact | Likelihood | Mitigation |
|--------|-------------|--------|------------|------------|
| Example | API | High | Medium | Rate limit + auth |

## Residual Risks

- Risk accepted
- Compensating controls
- Owner
- Review date
```
