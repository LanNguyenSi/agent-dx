# Changelog

All notable changes to `orchestrator-workflow` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2] - 2026-07-02

### Security

- The read-only explorer and reviewer prompts now carry an explicit Bash
  no-mutation guard: Bash is for tests, linters, and read-only inspection
  only; `git checkout` / `git restore` / `git clean` / `git stash`, `sed -i`,
  and redirecting output into a file are named as forbidden, and a
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
