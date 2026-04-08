# Checklist: Phase Assessment

Use this before applying the playbook mechanically.

## Product State

- [ ] The project is still exploratory with low blast radius
- [ ] A first production release is expected soon
- [ ] Live users already depend on the system
- [ ] Outages or data mistakes would have meaningful business impact

## Data And Trust

- [ ] Real customer or partner data is involved
- [ ] Sensitive personal, financial, or internal business data is involved
- [ ] Customers or stakeholders require auditability or security evidence

## Operating Complexity

- [ ] Multiple teams or domains will touch the product
- [ ] Privileged admin workflows or production access exist
- [ ] Rollback, support, or incident handling is already necessary
- [ ] AI agents can affect sensitive code, infrastructure, or release flows

## Result

Choose the highest phase that honestly matches the checked items:

- Mostly exploratory, low-risk checks only: `Phase 0 - Exploration`
- Shipping toward first real release: `Phase 1 - Product Build`
- Live system with operational consequences: `Phase 2 - Production`
- Sensitive, audited, enterprise, or high-trust context: `Phase 3 - Enterprise`

Then apply guidance from [playbooks/00-adoption-paths.md](../playbooks/00-adoption-paths.md).
