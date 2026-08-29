# Knowledge bundle index

Curated OKF knowledge bundle for the `orchestrator-workflow` package (the
pilot bundle of the agent-dx monorepo; granularity is per-package by the
2026-07-16 decision). These docs capture cross-file semantics and invariants
that no single source file states on its own: how the run-state markers,
subagent contracts, review gate, installer fence, and model preselection
interlock. For feature-level reference, see the package `README.md` and
`INSTALL-AGENT.md` two levels up; these docs deliberately do not duplicate
them.

## Modules

- [Run-state lifecycle and machine-readable markers](run-state-lifecycle-and-markers.md),
  the `.ai/runs/` directory model and the three `solution-acceptance:`
  markers (run-base fails open, acceptance-recommendation and final-status
  fail closed) plus the findings-table header that backs them; since
  0.26.0-unreleased also the per-worktree `.ai/run` pointer and the keyed
  `run-base[<repo-basename>]` marker line for multi-repo runs.
- [Install fence mechanics](install-fence-mechanics.md), the marker-fence,
  hash-ledger, and manifest.json contract that makes `init`/`uninstall`
  idempotent, reversible, and safe against local edits and path traversal.
- [Model preselection](model-preselection.md), how each subagent role's
  model is chosen (defaults, `--models`, interactive prompt), persisted in
  `manifest.json`, composed into Claude/opencode/Codex frontmatter, preserved
  across re-installs, and kept in sync with docs by consistency tests; since
  0.19.0 also covers the opt-in `--tiers` effort-tier subagent variants
  (`<role>-<tier>.md`) rendered alongside each role's base file.
- [Operator install and target registry](operator-install-and-registry.md),
  the operator-level home, its manifest schema and read states, the single
  locked read-modify-write API and its lock semantics, the target registry,
  and the `setup`/`apply`/`doctor`/`adopt` commands built on top of it,
  including the pin rule and how uninstall leaves the registry untouched.

## Invariants

- [Subagent contracts and the slicer-superset invariant](subagent-contracts-superset.md),
  the five role contracts (since 0.21.0's escalation-only advisor role;
  four before it), their read-only/writable split, where each I/O
  contract is duplicated and by which tests, the
  task-slicer-output-is-a-lossless-superset invariant, and the 0.11.0
  subagent misfire rule.
- [Review gate and waiver semantics](review-gate-and-waivers.md), the
  review-never-skipped invariant: severity ladder, critical/high waiver
  rules, the Decision-column legend, and the three synced surfaces (policy,
  skill, templates) that enforce it.

## Maintenance

Each doc's `timestamp` means "last verified against sources", not "created
on". When a change touches a path listed in a doc's `sources:`, re-verify
the doc and re-stamp it (the package's own Hand off step 9 hook describes
exactly this loop), and add a line to [log.md](log.md). The warn-only
`okf-staleness` CI workflow surfaces drift on every PR without blocking.

Log entries record commands, verdicts and deltas (for example "green with
the four new tests"), not suite totals: a total describes exactly one tree
and goes stale on the next rebase or added test; log.md records how
that class recurred on one change. Prefer string-anchored
citations over bare line ranges for the same reason: only anchored
citations are covered by the in-repo docs-consistency guard.
