# Enterprise Agentic Coding Playbook
**Executive Version**

*Lan Nguyen Si | March 2026*
*Based on the [Agent Engineering Playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)*

---

## About the Author

**Lan Nguyen Si** is a software developer focused on GovTech and open source. He builds tools at the intersection of AI-assisted software development and structured governance, including [project-forge](https://github.com/LanNguyenSi/project-forge), [depsight](https://github.com/LanNguyenSi/depsight), and the [Agent Engineering Playbook](https://github.com/LanNguyenSi/agent-engineering-playbook).

This playbook came from practice: real projects, real agents, real mistakes. This document itself was developed in dialogue between human and AI.

---

## The Core Thesis

The competitive edge in software development is shifting. Not: who has the best developers? But: who has the best system of agents, humans, and structural guardrails?

Better agents alone do not solve the problem. Better-designed decision systems do.

```
Agents may optimize.
Humans must be accountable.
Systems must enforce.
```

This division is not a preference. It is a structural necessity:

- Agents make mistakes from context gaps, not from carelessness.
- Humans make mistakes from time pressure, not from bad intent.
- Systems do not make mistakes from forgetting, if they are configured correctly.

Discipline does not scale. Systems do.

---

## Where Does Your Organization Stand?

Honest assessment before anything else:

| Situation | Phase |
|-----------|-------|
| No CI/CD, no branch protection, no gates | Phase 0: Exploration |
| CI/CD in place, setting up first gates | Phase 1: Product Build |
| Live system with real users | Phase 2: Production |
| Compliance, audit, enterprise requirements | Phase 3: Enterprise |

The model adapts to the phase. Phase 0 does not need full governance. Phase 3 requires it.

---

## The Model: Three Roles, Clear Boundaries

| Role | Responsibility | Delegable to AI? |
|------|---------------|-----------------|
| Product Owner | Goals, priorities, requirements | No |
| Tech Lead / Architect | Design decisions, risk assessment | Proposals yes, decisions no |
| Developer | Implementation, tests, review approval | Execution yes, approval no |
| AI Agent | Generate, analyze, synthesize | Within defined boundaries |
| Release Manager | Deployment approval, rollback | No |

Every critical function needs a human owner and a backup. Processes that depend on a single person or agent are fragile.

In smaller teams, multiple roles may fall to one person. The responsibilities must still remain visible.

---

## The Tier Model: What Agents May Do

### Tier 1: Autonomous
Agent acts independently, without prior review, as long as no production effect occurs:
- Read, analyze, and summarize code and documentation
- Generate drafts: code, tests, documentation, refactoring
- Run local tests and linters
- Propose architecture options
- Draft tickets and descriptions

### Tier 2: Assisted
Agent acts, human reviews before it takes effect:
- Create commits and pull requests
- Modify CI/CD configuration
- Prepare database schemas and migrations
- Edit security-sensitive code (auth, crypto, access control)
- Integrate features into legacy code

### Tier 3: Prohibited
Not permitted even with subsequent review:
- Approve its own pull requests
- Deploy to production without explicit human sign-off
- Delete production data or backups
- Disable security controls or monitoring
- Autonomously create or modify access credentials
- Bypass required review gates

---

## When to Use AI: Primary Candidates, Review Required, Never

### High-Leverage Automation
These tasks are prime candidates for AI-assistance:

- Boilerplate and repetitive structures
- Unit tests for clearly specified functions
- Deriving documentation from existing code
- First-pass code review drafts
- Analyzing dependency updates and preparing upgrade PRs

### AI May (with Review)

| Task | What the Human Checks |
|------|----------------------|
| Propose architecture options | Human makes the decision |
| Analyze complex bugs | Validate root cause |
| Refactor within defined boundaries | No unintended side effects |
| Draft communications | Human sends, not agent |

### AI Never (without explicit human sign-off anchored in the system)

| What | Clarification |
|------|--------------|
| Read or write production data | Local dev: Tier 1. Staging: Tier 2. Production: Tier 3. |
| Rotate or generate credentials | Tier 3 in all environments |
| Read secrets from .env or secret stores | Only via defined injection, never directly |
| External API calls with write access | Tier 2 with approval gate, Tier 3 in production without sign-off |
| Respond to customers autonomously | Legal accountability stays with humans |
| Approve offers or contracts | Business accountability stays with humans |

---

## Greenfield vs. Brownfield

### Greenfield
Set up the gates from the start, not later:

```
Enforced from day one:
  No merge without green CI
  No direct push to main
  At least 1 human review per PR
  No deployment without sign-off
```

### Brownfield: The Ratchet Principle
Existing codebases cannot be overwritten with new standards. The approach:

```
1. Capture baseline
   AI analyzes: error count, coverage, CI fail rate, open CVEs
   Human evaluates and prioritizes

2. Set gates at baseline
   Currently 120 TypeScript errors: gate allows maximum 120
   Never increase, but reduce incrementally

3. Improve incrementally
   One category per sprint
   AI proposes fixes, human reviews

4. Lock in the new threshold
   120 -> 80 -> 40 -> 0
   System enforces the current threshold
```

Special care in brownfield: migrations, auth logic, and API-breaking changes always treated as Tier 2 or 3, regardless of codebase maturity.

---

## What Systems Must Enforce

### Minimum Setup for Every Project

```yaml
Branch Protection (main, release/*):
  Required CI checks: build, test, lint, typecheck
  Required reviews: at least 1 human
  No force push, no direct push

Deployment:
  Only after green CI run
  Only after human sign-off
  Audit log for every deployment
```

### Maturity Stages

| Stage | When | What is Enforced |
|-------|------|-----------------|
| Base | Day 1 | Build green, 1 review, no direct push |
| Standard | 4 weeks | + Tests green, lint clean |
| Mature | 3 months | + Coverage minimum, security scan |
| Enterprise | Customer projects | + Performance budget, compliance gate |

---

## Audit Trail

Every agent action that modifies the system must be traceable:

| Event | Required Fields |
|-------|----------------|
| Code generation | Agent identity, task, files changed, reviewer |
| PR creation | Agent identity, human reviewer, merge timestamp |
| Deployment | Who triggered it, agent involvement, environment, rollback plan |

In practice: agent commits include a `Co-Authored-By` trailer. PR descriptions disclose AI involvement. Deploy logs record whether the change was agent-assisted.

---

## Three Questions Before Every Agent Task

1. **Is the result reversible** if it is wrong?
2. **Does a human carry accountability** for the result?
3. **Is there a system** that prevents the result from reaching production unchecked?

All three yes: agent can proceed.
One no: clarify the system or accountability first.

---

## Getting Started

**Week 1:** Phase assessment. Where does the organization honestly stand?

**Week 2:** Enable branch protection. Set ratchet to current baseline.

**Month 1:** Document the tier model in writing. Activate the first high-leverage automation.

**Month 3:** First complete project with agent + human + system. Measure outcomes.

**Month 6:** Retrospective. What did the system let through that it should not have?

---

## From Practice: What Taught Us These Lessons

These examples come from real work with AI agents. Not thought experiments.

---

### Example 1: Discipline Does Not Scale

**Situation:** Two agents developing in parallel on a product. No shared rules.

**What happened:** One agent built a new page with its own layout instead of the established `PageShell` component, hardcoded strings instead of localization, and registered the nav link in the wrong component. Three separate fixes were needed, three separate deployments.

**What a system would have prevented:** An automated check for missing i18n keys, a PR template explicitly asking about `PageShell` usage, and a checklist that must be completed before merge.

**Lesson:** CONTRIBUTING.md was created reactively, not proactively. The playbook principle: ways of working belong in the first commits of a project, not in the fixes that follow.

---

### Example 2: Human-in-the-Middle in Practice

**Situation:** An agent needs to execute a Jira action classified as "medium risk."

**What was built:** The connector proxy returns HTTP 202 instead of executing immediately. An `ApprovalRequest` record is created. The agent waits. The human decides via an approval page in the dashboard. Only then does the agent execute the action, with a full audit trail.

**What this shows:** Human-in-the-middle is not a bottleneck for speed. It is a structured handoff point. The agent keeps working, the human decides when it matters.

**Lesson:** The first draft of the approval flow expected the user to approve via `curl`. That is not a workflow for humans. The right question is always: how does the user do this without a terminal?

---

### Example 3: Ways of Working Need System Backing

**Situation:** After several inconsistent PRs, CONTRIBUTING.md is created with clear rules: always use PageShell, always use t(), register nav in AppShell, use primitives, follow PR checklist.

**What does not work:** Having the document. It is not read automatically. Not by humans. Not by agents.

**What would work:** A PR template that embeds the checklist directly. An automated check for missing strings in both language files. A lint rule that verifies PageShell import.

**Lesson:** A ruleset without system backing is a wish list. Only when the system blocks the merge until the checklist is complete are the rules actually followed.

---

## Further Reading

- **[Agent Engineering Playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)**: full technical reference with checklists and templates
- **[project-forge](https://github.com/LanNguyenSi/project-forge)**: greenfield scaffolding with built-in gates
- **[depsight](https://github.com/LanNguyenSi/depsight)**: security and dependency health for brownfield

---

Organizations do not scale agents by giving them more freedom. They scale agents by designing accountability and system boundaries clearly.

*Feedback and contributions welcome. An extended reference version with templates, CI snippets, and concrete policies is in progress.*

**Author:** Lan Nguyen Si
**License:** CC BY 4.0
**Status:** v0.1 | March 2026
