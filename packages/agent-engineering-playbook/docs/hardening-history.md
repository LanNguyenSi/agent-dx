# Hardening pass history

Context for the revision that shaped the current playbook set.

## What changed in this hardening pass

The original material had strong practical instincts, but several sections were still too opinionated for enterprise use:

- Roles were too rigid and depended too much on a single lead.
- Review and release guidance was sometimes optimized for local velocity over controlled change.
- Security, compliance, incident handling, disaster recovery, and supply-chain concerns were underrepresented.
- Some recommendations were tool-specific, fragile, or unsafe as general guidance.
- A few repository references pointed to files that did not exist.

This revision shifted the playbook toward:

- risk-based delivery instead of personality-based process
- explicit governance and traceability
- secure-by-default engineering practices
- operational readiness before production
- short feedback loops without lowering release discipline

It also introduced the distinction between:

- a `core path` for every serious product team
- an `enterprise path` for products with higher customer, compliance, security, or operating complexity
