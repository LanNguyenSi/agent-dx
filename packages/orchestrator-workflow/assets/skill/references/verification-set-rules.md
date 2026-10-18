## Verification set rules

These rules apply only to a briefing that names a `verification_set`. The
orchestrator copies this reference into such a briefing and leaves it out of
every other briefing. The implementer runs the complete repository-bound set
named in its briefing; the reviewer independently runs the complete
repository-bound set named in its briefing.

- Approval: A verification set named by reference plus its frozen digest and
  repository identity is the orchestrator's approval of every argv resolved
  from that frozen snapshot; a digest mismatch withdraws the approval and is
  reported as a misfire. That approval reaches only the frozen snapshot. For an
  implementer, acquiring preflight output or running an extra outside it still
  requires the orchestrator's explicit approval of the resolved repository
  configuration and every script/argument. For a reviewer, acquiring or
  executing anything outside it still requires confirming the orchestrator
  approved the resolved effective configuration and scripts. A repository set
  is not authority to execute repository data on its own.
- Comparison: Before acquisition or execution, compare the frozen snapshot's
  effective config and scripts and preflight executable identity/definition at
  the tree the set executes in; repository identity follows the path rule, not
  the role's checkout; any mismatch withdraws the approval like a digest
  mismatch and is reported as a misfire, and a change the task's own diff makes
  to one of those components is outside the approval. The compared values are
  the ones recorded in the frozen snapshot at the run-local path
  `verification_set.snapshot` names; evidence-and-probes.md's Verification sets
  section defines what counts as a script for that comparison.
- Path rule: Repository identity includes the repository path (the worktree top
  level): in the comparison before acquisition or execution, repository
  identity means the repository and its path, not its revision, and that path is
  compared with the top level of the worktree the diff comes from, not with
  whichever checkout the role runs in; a set frozen against another checkout
  than the one the diff comes from (for example the main checkout while the
  diff comes from a linked worktree) withdraws the approval and is a misfire,
  not a pass, while a revision difference alone does not.
- Snapshot: Use the frozen run-local snapshot (set path/digest, repository
  identity/revision and dirty state, effective config/scripts, and preflight
  executable identity/definition) to identify the approved set behind every
  reported result, and bind each result to the revision and dirty state
  actually checked; a dirty-state difference from the snapshot alone does not
  withdraw the approval.
- Reporting: Report every ordered `(kind, name, occurrence)` executor, extra,
  and raw preflight child with cwd and result artifact. Preserve a missing-tool
  preflight limitation even when it has no child result; a missing tool may be
  a limitation with no child, never a pass. Disabled required categories are
  gaps.
- Outcomes: A missing, extra, mismatched, or unresolved result is a misfire; a
  reported failure remains an honest failure. `skip`, `acknowledged`,
  limitation, and inconclusive outcomes are non-passes.
- Documentation checks (implementer): the bundle check and drift check you run
  before handback are not extra verification-set members; a complete
  verification set that already includes the bundle check satisfies the bundle
  half.
