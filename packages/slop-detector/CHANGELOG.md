# Changelog

All notable changes to `slop-detector` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `placement.instructionGlobs` in the agent-dx root `slop.config.yml` now
  also covers a small, explicit set of package READMEs
  (`packages/okf-kit/README.md`, `packages/agent-dev-kit/README.md`,
  `packages/agent-engineering-playbook/README.md`) and one OKF bundle
  module doc (`packages/orchestrator-workflow/docs/okf/install-fence-mechanics.md`),
  closing a gap the `placement-guard` CI job (`check . --pack
  placement-slop --config slop.config.yml`) had against both location
  kinds (agent-tasks 80e4743d, itself filed from two independent
  mutation-probe findings in agent-tasks batch27: an implementer inserted
  a dated/tallied evidence line into `okf-kit/README.md` and a reviewer
  repeated the same probe across five locations, in both cases with the
  guard staying clean).
  - Each of the four newly covered files was measured clean (0
    pre-existing violations) before being added, so this change is
    corpus-neutral: `check .` at the repo root stays green, 389 files
    scanned.
  - Deliberately **not** covered, decided and measured on the same
    corpus:
    - A blanket `packages/*/README.md` wildcard: measured 50 pre-existing
      violations across 6 files (`slop-detector/README.md`,
      `orchestrator-workflow/README.md`, `mcp-token-audit/README.md`,
      `github-api-tool/README.md`, `git-batch-cli/README.md`,
      `friction-log/README.md`), dominated by the generic `~/`/`/Users/you/`
      "your home directory" install-path idiom in usage examples (a
      different thing from the machine-bound leak `home-path` targets)
      plus `slop-detector/README.md`'s own self-documenting rule-example
      lines. Fixing or allowing 50 findings across 6 unrelated packages'
      docs is a separate, larger piece of work; the file list and count
      above are the starting point for it.
    - A blanket `packages/*/docs/okf/*.md` wildcard on the same bundle:
      measured 14 pre-existing violations across the bundle's other 5
      module docs (`index.md`, `model-preselection.md`,
      `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
      `subagent-contracts-superset.md`): dated re-verification stamps,
      tally phrases, and task ids describing that doc's own verification
      history. Editing bundle document content is out of this change's
      scope; fixing these 14 findings is a follow-up against the bundle
      itself.
    - `packages/orchestrator-workflow/docs/okf/log.md`, the bundle's own
      append-only log: measured 72 pre-existing violations, by design, since
      it is a changelog-shaped narrative document meant to carry dates,
      tallies, and task ids, the same reason `CHANGELOG.md` files are not
      and have never been in `instructionGlobs`. This is a permanent
      exclusion, not a deferral.
    - `CHANGELOG.md` files anywhere in the repo: unchanged, still never
      matched by any `instructionGlobs` entry: this is the pack's
      existing, intentional carve-out for evidence that is supposed to
      live somewhere, and this change does not touch it.
  - Two mutation probes per newly covered location (4 total) confirmed
    the fix: an evidence line (`Verified 2026-08-25, n=3 so far, task
    7357d7fe.`) inserted into each of the four files was invisible to
    `check .` under the pre-change config and blocked under the
    post-change config, in all four files, then reverted.
