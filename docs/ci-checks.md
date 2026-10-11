# CI checks on this repository

CI runs the following jobs. Each builds
[`slop-detector`](../packages/slop-detector) from this checkout and runs it
against one pack and config:

- `placement-guard` checks the whole repository with the `placement-slop`
  pack: it blocks org-, machine-, or point-in-time-bound evidence (machine
  paths, run ids, counts like "four so far") from landing in instruction
  files.
- `placement guard via composite action` runs the same check through the
  repository's own composite action
  (`packages/slop-detector/action`, see the package README), as a dogfood
  of the action; it must agree with `placement-guard`.
- `review-guard` checks the whole repository with the `review-slop` pack:
  it blocks run-local review references from landing in reusable content.
- `workflow-guard` checks the repository's workflow files and composite
  action metadata with the `workflow-slop` pack: it blocks `run:` expression injection, workflow
  files that do not parse, reintroduced Node-20 action majors, and a
  missing or unrecognized npm-audit gate. It is a security control rather
  than a doc-hygiene lint, so it reports under its own status check. See
  [workflow-slop](../packages/slop-detector/docs/workflow-slop.md).
- `OKF bundle prose guard` checks
  `packages/orchestrator-workflow/docs/okf` with the `prose-slop` pack: it
  blocks em dashes and hedging openers in that knowledge bundle.

The root [`slop.config.yml`](../slop.config.yml) holds the placement and
review configuration, including which paths (the maintained OKF evidence
corpus, deliberate rule fixtures) are kept out of the reusable-content gate
(`review.allowPaths`).
[`slop.bundle.config.yml`](../slop.bundle.config.yml) raises the em-dash and
hedging-opener rules to block for the bundle prose guard.

See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) for the full
job list, including the build/test/typecheck/lint matrix over the npm
packages and the OKF anchor guard.

## Using these checks in another repository

Another repository can run the `workflow-slop` pack through this
repository's reusable workflow `.github/workflows/workflow-guard.yml`,
pinned to a full commit SHA in `uses:`, or run any pack inside its own job
with the composite action `packages/slop-detector/action`. See
[Use from another repo](../packages/slop-detector/docs/workflow-slop.md#use-from-another-repo)
and the [slop-detector README](../packages/slop-detector/README.md).
