# Changelog

All notable changes to `orchestrator-workflow` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-07-16

### Added

- `SKILL.md`'s Hand off step (9) gains an optional bundle-upkeep hook,
  symmetric to the 0.8.0 discovery-side rule: when the repo carries a
  curated knowledge bundle (for example a `docs/okf/` directory with an
  index), the orchestrator checks before handoff whether the change touches
  paths any bundle doc claims as sources, and if so either updates the
  affected docs (re-verify and re-stamp) or records a follow-up task, and
  runs the bundle validator when one is available (for example `okf-kit
  check`). The hook is optional guidance, never a gate: repos without a
  bundle are unaffected. `06-handoff.md` gained a matching optional
  "Knowledge Bundle" section so the outcome (updated / not affected /
  follow-up filed) is recorded alongside the rest of the handoff. Motivated
  by the OKF initiative's Phase 3 evidence: four upkeep sweeps on 2026-07-16
  found 48/24/11/8 stale claims accumulated in the four oldest bundles, with
  warn-only drift CI already live in 8 repos — discovery-side consumption
  shipped in 0.8.0 and named this hook as its symmetric, still-missing,
  loop-closer. Docs-consistency tests pin the hook's source-overlap check,
  its two responses, the validator run, and its explicit non-gate
  optionality, plus the handoff template's new section and outcome
  vocabulary.

## [0.11.0] - 2026-07-16

### Added

- `SKILL.md` gains a Subagent misfire rule: a subagent return that does not
  parse against its role's output contract is a misfire, not evidence. A
  near-instant return with no tool activity is a misfire signal rather than
  proof: the orchestrator accepts it only when the output is contract-valid
  and the assignment was answerable from the context supplied with it, so
  legitimately tool-free returns (a slicer answering from provided context)
  are not discarded. On a misfire the
  orchestrator resumes or respawns the subagent, never folds the
  non-contract output into run state, and records the misfire in
  `03-decisions.md`. The rule calls out the review case explicitly, since a
  misfired review is not a review and never satisfies the review gate.
  Motivated by a live incident: a reviewer subagent spawn returned in 5
  seconds with 0 tool uses, handing back harness hook-boilerplate instead of
  the reviewer output contract; a resume produced a correct full review. The
  kit previously said nothing about malformed subagent returns, leaving the
  door open to silently accepting a non-review as a passed review gate.
  Docs-consistency tests pin the rule's detection signals, response, record
  location, and review-gate consequence.

## [0.10.0] - 2026-07-16

### Changed

- The task-slicer output schema is now a lossless superset of the subagent
  input contract: each task carries `constraints`, `suggested_tests`,
  `allowed_changes`, `forbidden_changes`, and `relevant_docs` in addition
  to the existing `id`, `title`, `goal`, `relevant_files`,
  `acceptance_criteria`, `dependencies`, and `risk` — every field the
  subagent input contract requires now has a same-named slicer-output
  counterpart. Previously the slicer output contract in `SKILL.md` and the
  installed `task-slicer.md` prompt omitted
  `constraints`/`allowed_changes`/`forbidden_changes` even though the
  implementer input contract and `implementer.md` treat them as
  load-bearing, forcing the orchestrator to invent them when delegating
  implementation instead of copying them from the slice. `SKILL.md` now
  states this 1:1 mapping explicitly next to the contract. `02-tasks.md`
  gained matching **Relevant Docs** / **Allowed Changes** /
  **Forbidden Changes** sections so its sections map 1:1 to the slicer
  output fields. `task-slicer.md`'s rules frame allowed/forbidden changes
  as scope boundaries for the implementer (which files or areas it may and
  must not touch), not as implementation instructions, keeping the slicer
  a planner. Docs-consistency tests pin both output-contract locations
  (including their field-for-field equivalence), the template sections,
  the prose enumerations, and the mapping sentence; the superset check
  derives the required field set from the subagent input contract itself,
  so a field added there cannot silently go missing from the slicer
  output.

## [0.9.0] - 2026-07-16

### Added

- `00-goal.md` now carries a `<!-- solution-acceptance: run-base = TODO -->`
  marker, following the same pattern as the existing final-status and
  acceptance-recommendation markers. grounding-mcp 0.6.0 reads this marker
  to bind run-completeness precisely to the change under review; a run that
  fills it with a valid sha gets an exact binding, a malformed value blocks
  explicitly (7-40 hex guard), and a run that leaves it as `TODO`
  falls back to the tolerant day-granular date heuristic. `SKILL.md`'s Run
  state section now instructs the orchestrator to replace `TODO` with the
  repo HEAD sha (`git rev-parse HEAD`) when creating the run directory,
  before the first implementation commit, and states the consumer
  semantics: the recorded base must resolve in the repo, be an ancestor of
  HEAD, and not lie behind the merge-base with the remote default branch.
  A template-markers test pins the new marker the same way as the existing
  two.

## [0.8.0] - 2026-07-16

### Added

- The explorer role prompt and the skill's Discover step now tell discovery
  to check for a curated knowledge bundle (for example a `docs/okf/`
  directory with an `index.md`) before mapping terrain by hand, reading the
  relevant docs it points to and treating their claims as leads to verify,
  not as ground truth. Both locations also prefer a connected semantic
  code-search tool over raw grep for orientation questions. Wording
  is deliberately tool-agnostic: OKF/`docs/okf/` is named only as an
  example, and semantic search is phrased generically with no dependency on
  a specific MCP tool. Docs-consistency tests pin both locations, including
  a negative pin that no specific tool name is hardcoded.

## [0.7.4] - 2026-07-05

### Changed

- `05-review-findings.md` Decision legend now matches the grounding-mcp
  completeness reader's resolved vocabulary. The example row previously
  invited `accepted/fix/defer/reject`, but the reader's
  `RESOLVED_DECISIONS = {accepted, defer}` treats a high/critical finding
  marked `fix` or `reject` as unresolved, so the gate arms (fail-closed but
  surprising). The example is narrowed to `accepted/defer` and a Decision
  legend comment now spells out that every other value (`fix`, `reject`,
  blank, `open`, `TODO`) arms the completeness gate until resolved. Docs
  only, no runtime behavior change; a template-vocabulary test pins the
  reconciliation. Reader left untouched (its fail-closed design is
  deliberate); this is the single-repo path (a).

## [0.7.3] - 2026-07-05

### Fixed

- `05-review-findings.md` now carries a load-bearing comment above the
  findings table naming the Severity and Decision columns: grounding-mcp's
  orchestrator-workflow completeness reader (0.6.0) locates the table by a
  header row whose cells include both, and fails closed with an explicit
  "not in the expected table format" blocker when a run drifts onto a
  Decision-less convention (a live run had used
  `| Severity | Finding | Resolution |`, which the reader cannot verify).
  The shipped header itself was already correct
  (`| Severity | Category | Description | Suggested Fix | Decision |`); this
  adds the comment plus a one-sentence rule in `SKILL.md`'s review step
  telling the orchestrator to transfer reviewer findings into the table
  as-is, keeping those two headers, and a test pinning the header row so
  the convention cannot silently drift again.

## [0.7.2] - 2026-07-02

### Security

- The read-only explorer and reviewer prompts now carry an explicit Bash
  no-mutation guard: Bash is for tests, linters, and read-only inspection
  only; `git checkout` / `git restore` / `git clean` / `git stash` /
  `git reset`, `sed -i`, and redirecting output into a file are named as
  forbidden, and a
  wrong-looking working tree must be reported (finding / risk) instead of
  "fixed". Background: 0.7.1 made both roles tool-level read-only for
  Edit/Write/NotebookEdit, but Bash necessarily stays available, and exactly
  this residual bit in practice (a reviewer ran `git checkout` and discarded
  uncommitted work). The guard is instruction-level; tests pin its presence
  in the installed output for both harness targets.
- README now states the posture honestly: tool-level for the edit tools,
  instruction-level for Bash, with marker/verdict-style enforcement named as
  harness territory outside this kit's scope. A docs-consistency test pins
  the wording.

## [0.7.1] - 2026-06-24

### Security

- The installed `reviewer` subagent now carries the same read-only tool posture
  as the explorer: `disallowedTools: Edit, Write, NotebookEdit` (Claude Code) and
  `permission: edit: deny` (opencode). Previously only the explorer was
  tool-restricted and the reviewer was restrained by prose alone ("Do not rewrite
  the change yourself"), so a misled or prompt-injected reviewer could edit files
  through the edit tools. The reviewer's job is to judge work without changing it,
  so it is now installed read-only on both harnesses, matching the explorer.
  (Bash is intentionally not restricted by this posture on either read-only role,
  unchanged from before.)

## [0.7.0] - 2026-06-22

### Added

- Machine-readable solution-acceptance status markers in the run templates:
  `06-handoff.md` carries a `<!-- solution-acceptance: final-status = TODO -->`
  line and `05-review-findings.md` carries a
  `<!-- solution-acceptance: acceptance-recommendation = TODO -->` line. The
  orchestrator replaces the `TODO` sentinel with the chosen enum value when
  finalizing the handoff/review. This is the run-gate contract the harness
  solution-acceptance gate reads, so a freshly-copied run is non-accepting by
  construction (fail-closed). SKILL.md documents the finalization step.

## [0.6.0]

### Changed

- Portable opencode model resolution (#62).

## [0.5.0]

### Added

- Instruction trust boundary for the workflow, policy, and agent prompts (#55).

## [0.4.0]

### Added

- Read-only explorer/discovery role (#52).

## [0.3.0]

### Added

- Proportionality rule for delegation (#51).

## [0.2.0]

### Added

- Target-directory transparency and an `uninstall` command (#50).

## [0.1.0]

### Added

- Initial `orchestrator-workflow` package: `.ai/` run state, an `AGENTS.md`
  policy section, and per-harness subagent definitions (#47).
