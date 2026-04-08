# Case Study: Event Booking System

Full-stack event management platform built in one day by a human-AI team.

## Numbers

- **13 tasks** completed in a single day
- **Average review score:** 9.5/10
- **Team:** 1 human (product owner), 1 AI lead (planning, review, deploy), 1 AI developer (implementation)
- **Stack:** Next.js, TypeScript, Prisma, PostgreSQL, Tailwind CSS, Docker, Traefik

## What Was Built

Booking platform with: event CRUD, public booking with confirmation codes, waitlist with auto-promotion, email notifications, CSV export, analytics dashboard, multi-admin roles, German localization, Markdown descriptions, Open Graph tags, search and filters.

## How It Worked

### Task-Based Development

The lead created 13 self-contained task files in a `tasks/` directory. Each file contained: problem, solution, files to modify, and implementation notes. The developer read one task, implemented it on a branch, opened a PR, and waited for review before starting the next.

### Review Pipeline

Every PR was reviewed with a 1-10 score across consistency, correctness, safety, and completeness. Post-merge fixes were used for minor issues (faster than sending the PR back). Four PRs scored 10/10, the lowest was 8.5/10.

### Real Bugs Caught in Review

- **Inconsistent naming:** `localStorage.getItem('adminToken')` vs `admin_token` used everywhere else. Caught in review, fixed post-merge.
- **Stale branch:** Developer branched before a previous PR was merged, losing a component. Resolved by rebasing on main.
- **Prisma build failure:** Schema change required `prisma generate` in both Docker build stages. Debugged and documented as a production pattern.
- **Tailwind v4 syntax:** Old `@tailwind` directives don't work in v4. Required `@import "tailwindcss"`. Hit twice across projects.

### Deployment

Deployed on a VPS with Traefik reverse proxy. Multi-stage Dockerfile. Automatic SSL via Let's Encrypt. Each merged PR was built and deployed within minutes.

## Lessons Applied From the Playbook

| Playbook | Applied Pattern |
|----------|----------------|
| 03 Team Roles | Clear lead/developer split, human sets priorities |
| 04 Design Principles | Spec first, convention over configuration |
| 05 Workflow | Task files, branch-per-task, review scoring |
| 07 Quality | Post-merge fixes for minor issues, TypeScript strict |
| 09 Production | Docker multi-stage, Traefik, force-dynamic for DB pages |

## What Would Change With Enterprise Path

If this product handled sensitive data or had compliance requirements:

- Formal change classification for each task (standard vs high-risk)
- Security review before deploying auth and booking systems
- Access review for admin roles
- Incident runbook before going live
- Data classification for booking PII (names, emails)

The core delivery speed would remain. The additional controls would add roughly one day of preparation.

## Links

- [Live](https://termine.lan-nguyen-si.de)
- [Repository](https://github.com/LanNguyenSi/event-booking-system)
