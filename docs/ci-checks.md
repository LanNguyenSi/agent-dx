# CI checks on this repository

CI runs dedicated `placement-guard` and `review-guard` jobs for the
repository, plus an `OKF bundle prose guard` job. All three run
[`slop-detector`](../packages/slop-detector) from a local build against a
specific pack and config:

- `placement-guard` checks the whole repository with the `placement-slop`
  pack: it blocks org-, machine-, or point-in-time-bound evidence (machine
  paths, run ids, counts like "four so far") from landing in instruction
  files.
- `review-guard` checks the whole repository with the `review-slop` pack:
  it blocks run-local review references from landing in reusable content.
- `OKF bundle prose guard` checks
  `packages/orchestrator-workflow/docs/okf` with the `prose-slop` pack: it
  blocks em dashes and hedging openers in that knowledge bundle.

The root [`slop.config.yml`](../slop.config.yml) and
[`slop.bundle.config.yml`](../slop.bundle.config.yml) hold the review
configuration these jobs use, including which paths (the maintained OKF
evidence corpus, deliberate rule fixtures) are kept out of the
reusable-content gate.

See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) for the full
job list, including the build/test/typecheck/lint matrix over the npm
packages and the OKF anchor guard.
