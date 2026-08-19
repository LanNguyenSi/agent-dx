# Changelog

All notable changes to `orchestrator-workflow` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.19.0] - 2026-08-19

### Added

- `init` gains `--tiers`: renders an additional per-role subagent variant
  file for each non-default effort tier, alongside the one default
  (unsuffixed) agent file `--profile` already installs. Off by default, like
  every optional pack in this kit; a plain re-run with no `--tiers` flag
  keeps whatever the previous install had, the same override-vs-persist rule
  already used for `--profile`/`--models`, and there is no interactive
  prompt, tiers is opt-in via the flag only. `models.ts` adds `Tier`
  (`low|medium|high|xhigh`), `ROLE_TIERS` (which tiers each role gets:
  explorer/task-slicer `low,medium,high`; implementer all four;
  reviewer `medium,high,xhigh`), `DEFAULT_TIER` (the tier each role's plain
  file already corresponds to: `medium` for explorer/task-slicer/implementer,
  `high` for reviewer, never rendered as its own variant since that would
  both collide with and duplicate the default file), `TIER_DEFS` (tier ->
  model class + requested effort), and `CLASS_MODELS` (model class -> model
  alias: `small`->`haiku`, `medium`->`sonnet`, `large`->`opus`). The default
  file for every role stays byte-identical to a tiers-off install (still
  `manifest.models[role]`, no `effort:` key) whether or not `--tiers` is
  passed, so the reviewer's `opus` default can never be silently downgraded
  by this feature; a dedicated regression test pins that. Variant files are
  named `<role>-<tier>.md`; with `--profile full` and tiers on, that is 4
  default files plus 9 variants (13 total). Claude Code variants carry
  `model: <class alias>` and `effort: <tier>` frontmatter (plus
  `disallowedTools: Edit, Write, NotebookEdit` for the read-only roles, same
  as the default file). opencode variants key off the resolved model's
  family, not its provider prefix: a Claude-family id (any provider fronting
  a `claude-`-named model, e.g. `anthropic/claude-...`,
  `github-copilot/claude-...`, or the nested
  `openrouter/anthropic/claude-...`) gets `variant: high`/`variant: max` for
  the `high`/`xhigh` tiers only (`low`/`medium` collapse to no effort field,
  a documented opencode `variant:` limitation, not a bug), Ollama or a provider-less
  id gets no effort field, and every other non-Claude-family model gets a plain
  `reasoningEffort: <tier>` line; the variant's `model:` line resolves
  through the same live `opencode models` catalog lookup as the base
  per-role model, keyed by the tier's model class instead of by role. A tier
  whose class model cannot be resolved at all renders no variant file for
  that class, not a file with the `model:` line simply omitted, and the CLI
  warns once per unresolved class on stderr; this guard and its warning
  are opencode-scoped only, since Claude Code variants resolve `model:` from
  a plain alias and need no live catalog lookup. The chosen value is
  recorded in a new `tiers` boolean on
  `.ai/workflow/manifest.json`; a manifest written before tiers existed (no
  `tiers` key) degrades to `false`, the same per-field-degradation style
  already used for a missing `profile` field. Variant files flow through the
  existing `installKitFile` hash ledger, so idempotence, conflict detection,
  and `uninstall` all cover them automatically with no dedicated code.
  Motivated by a harness capability probe (2026-08-19): Claude Code's
  `effort:` subagent frontmatter is wire-verified to reach the model request
  as `output_config.effort`, which is what makes rendering per-tier
  frontmatter variants worth doing at all, but the same probe also found
  that the `CLAUDE_CODE_EFFORT_LEVEL` environment variable always overrides
  frontmatter `effort:` on every installed agent when set, tier variants and
  default files alike; README's new "Effort tiers" section documents that
  override explicitly as a warning, not a footnote. README documents the
  flag, the role/tier table, the tier -> model class/effort table, and the
  opencode provider behavior; `INSTALL-AGENT.md` documents `--tiers` in the
  init question/example and the manifest JSON shape, and states the manual
  fallback path does not render tier variants at all. A new, narrowly scoped
  `docs-consistency.test.ts` check enumerates the README tier table against
  `ROLE_TIERS`/`DEFAULT_TIER` directly, so a role or tier added to either
  without a matching table update fails loudly. Both OKF bundle docs
  touching the installer (`model-preselection.md`,
  `install-fence-mechanics.md`) are re-verified and re-stamped.

## [0.18.0] - 2026-08-18

### Changed

- Extends the Subagent misfire rule (`SKILL.md`) and hardens the installed
  reviewer prompt, both docs/prompt-only, after two further sessions
  (2026-07-19, 2026-07-20) reproduced the same near-instant, no-tool-activity
  reviewer misfire the rule was originally written for in 0.11.0: a
  first-spawn reviewer returned within seconds, zero tool calls, harness or
  system boilerplate instead of the output contract. In the 2026-07-20
  session, a resume on the same subagent with the assignment explicitly
  repeated produced a full, contract-valid review; the 2026-07-19 session's
  resume outcome was not recorded. Explorer and implementer first spawns
  never misfired in either session.
  - **Concrete resume-over-respawn workaround.** The rule previously said
    only "resume or respawn," leaving the choice and the resume mechanics
    unstated. It now names, for this specific signal, resume over a fresh
    respawn as the preferred response, states the mechanic (repeat the
    original assignment explicitly, not a generic retry, since resume keeps
    the subagent's prior context while a fresh spawn starts cold), and
    scopes the fallback to a fresh respawn to the case where the resume
    attempt itself misfires the same way. This preference is scoped to the
    near-instant, no-tool-activity signal; a structurally different misfire
    class, a mid-run watchdog stall, is out of scope for it: the one
    measured incident of that class did not resolve on resume (it stalled a
    second time) and only a fresh, explicitly constrained respawn produced a
    contract-valid review.
  - **Model correlation flagged as an open lead.** A structural comparison
    of the four installed agent prompts (`explorer.md`, `implementer.md`,
    `reviewer.md`, `task-slicer.md`, checking each one's frontmatter, line
    count, and its `models.ts` default-model entry) found this signal has so
    far only been observed for the reviewer role. Tool posture does not
    explain it: the explorer role carries the identical read-only
    restriction and has not shown the signal. The reviewer role is the only
    one of the four whose default model (`opus`) differs from the other
    three's default (`sonnet`); `SKILL.md` now names that correlation
    explicitly as an open lead to keep watching as more incidents
    accumulate, not as a confirmed root cause: a deterministic repro of a
    harness-level subagent-spawn race is not achievable in a docs/
    prompt-only package (there is no runtime code here that spawns
    subagents), so this remains an observation, not a fix at the harness
    layer.
  - **Reviewer prompt hardening.** `reviewer.md` now instructs the reviewer
    to begin its very first turn with a tool call before writing any
    analysis, and forbids a text-only opening turn (harness boilerplate, a
    restated-instructions preamble). This does not address a harness-level
    spawn race directly, but removes one plausible contributing factor (the
    prompt not forcing an immediate tool call) at no cost.
  - **Observation task, not closed.** Whether the hardened prompt plus the
    documented workaround measurably reduces the recurrence rate can only be
    judged by watching subsequent sessions for the same signal; this is
    recorded as an open observation, not claimed as verified here. Observable:
    first-spawn reviewer misfires of this exact signal, counted per session
    and recorded as they occur via the friction-log and run notes; review the
    accumulated count after roughly five more sessions.

  Motivated by agent-tasks task a932b12a.

  Review-fix follow-up (same task, same day): review found the claim "every
  incident of this exact signal has resolved on the first resume attempt"
  overstated the record: only four resume outcomes for this signal are
  actually recorded (three on 2026-07-16, one on 2026-07-20); the
  2026-07-19 session above never had a resume outcome recorded at all. This
  entry's intro paragraph and `SKILL.md` now bind that claim to recorded
  outcomes ("four so far") instead of a universal resolve rate, and no
  longer attribute a resume success to the 2026-07-19 session specifically.
  `SKILL.md` also gained the watchdog-stall scope carve-out folded into the
  workaround bullet above, so the resume-over-respawn preference is not
  read as covering every misfire. The docs/okf bundle
  (`subagent-contracts-superset.md`, `review-gate-and-waivers.md`,
  `run-state-lifecycle-and-markers.md`) had landed the feature commit above
  with no bundle update at all, repeating the 0.16.0/0.17.0 gap; this pass
  closes it (see `docs/okf/log.md` for the re-verification detail).

## [0.17.0] - 2026-08-18

### Changed

- Anchors three process lessons from a live review-fix run in the kit
  procedures (`SKILL.md` plus the installed `task-slicer.md` and
  `reviewer.md` prompts), each docs/prompt-only:
  - **Round-2 halt criterion.** Step 8 (Decide acceptance), detailed in a new
    Round-2 halt rule section, now names a stop signal for a repeating
    review-fix cycle: a review round finds a new defect of the same class
    the previous round's fix addressed, so the class has recurred once after
    being fixed, and the next fix would again be case-by-case enumeration
    (boundary tokens, spellings, and similar one-off patches). Stop the
    first time this signal fires: the recurrence is already the class's
    second occurrence, so do not wait for a third one before stopping. Name
    the structural cause in one sentence, and split or redesign instead of
    continuing: ship the healthy half on its own verification and refile the
    removed half as its own task carrying the measurement history that led
    to the split. Failing acceptance criteria go to the operator as a
    merge-hold (hold the change unmerged and hand the decision to the
    operator).
  - **Split-by-default for documented-divergence sub-tasks.** Step 4 (Slice
    tasks) and the task-slicer prompt now default a high-risk sub-task whose
    acceptance criteria allow recording the divergence instead of changing
    behavior, so its outcome is undetermined at slice time (for example,
    phrased along the lines of "... or record the divergence as a
    deliberate, documented boundary"), to its own PR (its own independently
    shippable unit), instead of bundling it with a lower-risk sibling task
    whose shipping should not wait on it.
  - **Diff-as-file reviewer briefing.** Step 7 (Delegate review) and the
    reviewer prompt now cover the case where the reviewer's environment
    cannot use version control to see the diff (for example a policy-gated
    repository): the orchestrator supplies the diff as a pre-generated file
    in the briefing instead of expecting the reviewer to derive it, and the
    reviewer explicitly reports when it could only reconstruct the delta
    some other way instead of silently reviewing less than the full change.

  Motivated by agent-tasks task 66c548ad.

## [0.16.0] - 2026-08-18

### Changed

- Hardens three subagent output-contract gaps measured across a 16-round
  dogfood run: two separate implementer rounds omitted briefed-as-mandatory
  mutation probes from their return entirely (a human had to rerun them);
  one implementer committed a false "Verified by ..." claim into a source
  comment for a probe it never measurably ran; one reviewer omitted the
  mandatory `acceptance_recommendation` field. Three changes, each docs/
  prompt-only:
  - Implementer output contract gains a `mutation_probes` field (`mutant,
    verified_applied_via, result, restored_verified`), mirrored
    byte-identically in `SKILL.md`'s reference copy and the installed
    `assets/agents/implementer.md` prompt. The Subagent misfire rule now
    states explicitly that an implementer return omitting this field, when
    the task assignment named mutation probes to run, is a misfire like any
    other: resume or respawn, never fold into run state.
  - The installed implementer prompt gains a claim-only-what-was-measured
    rule: a verification claim (for example "Verified by ...") in a code
    comment, commit message, or the implementer's own report is only for a
    check the implementer actually ran and measured itself.
  - Reviewer contract marks `acceptance_recommendation` as a hard-mandatory
    field in both the installed `assets/agents/reviewer.md` prompt and
    `SKILL.md`'s reference copy; `SKILL.md` adds that when the field is
    missing, the orchestrator asks the reviewer to resupply it rather than
    inferring a recommendation from the findings list.

  Motivated by agent-tasks task 16637a96.

  Review-fix follow-up (same task): `mutation_probes` shipped with no
  trigger the kit itself ever produced (SKILL.md step 6 said nothing about
  naming probes) and no not-applicable signal (an implementer never given
  probes returned the same placeholder block as one that silently dropped
  them). Step 6 now instructs the orchestrator to name the mutation probes
  to run in the task assignment whenever acceptance rests on a test that
  must fail without the change, and carries a short reference to the
  claim-only-what-was-measured rule. Both `mutation_probes` rule-text
  copies (`SKILL.md`'s reference paragraph and the installed
  `implementer.md` prompt) gained a not-applicable clause: when the
  assignment names no probes, the implementer returns `mutation_probes: []`
  rather than omitting the field, so "none asked for" is distinguishable
  from "asked for and not reported". The installed prompt's wording for a
  missing field changed from "incomplete" to "treated as a misfire, not
  evidence", matching the Subagent misfire rule's own language; that rule's
  paragraph also had an uneven line-wrap seam (left by the original 0.16.0
  edit) rewrapped.

## [0.15.0] - 2026-08-17

### Added

- `init` gains `--profile minimal|full`: `full` (the default) installs every
  subagent role, byte-identical to pre-0.15.0 behavior when the flag is
  omitted or passed explicitly as `full`; `minimal` installs only
  `implementer` and `reviewer` (`task-slicer` and `explorer` are omitted).
  The reviewer is never omittable under either profile (Standing Rule:
  always review), so `minimal` is the write+check pair, not "just
  implementer". `rolesForProfile` selects the installed role set for both
  the Claude Code and opencode per-role agent files; Codex has no per-role
  files, so the profile choice does not change what it gets. The chosen
  profile is recorded in a new `profile` field on
  `.ai/workflow/manifest.json`. A plain re-run with no `--profile` flag
  keeps the previously installed profile, the same override-vs-persist rule
  already used for `--harness`/`--models`; an explicit `--profile` always
  overrides. A manifest written before profiles existed (no `profile` key)
  degrades to `full`, not `minimal`, since that install always put down
  every role; a CLI-path test spawns `init` against a hand-written
  pre-profile manifest and asserts all four agent files are (re)installed,
  closing a gap where a naive fallback could silently narrow an existing
  install. A `full` -> `minimal` downgrade prints a note naming the
  now-untracked `task-slicer.md`/`explorer.md` agent files and how to
  remove them (`orchestrator-workflow uninstall` first, or by hand);
  `uninstall` needs no other change since it only ever iterates
  `manifest.files`, so the leftover files are simply absent from its
  removal loop and it still completes without error afterward. `SKILL.md`
  and the installed `AGENTS.md` policy section now state, at every role
  paragraph that names the explorer/task-slicer subagents, that only the
  roles the profile carries exist as named subagents and any missing role
  is run inline with the same contract, reusing the existing Codex
  "run roles inline" idiom; a docs-consistency test pins the sentence.
  README documents the flag, the single interactive profile question, and
  scopes its "uninstalling a minimal install is always clean on its own"
  claim to installs that were never downgraded from `full`, since a
  downgrade's untracked leftover files are exactly the case that claim
  doesn't cover. Both OKF bundle docs touching the installer
  (`install-fence-mechanics.md`, `model-preselection.md`) are re-verified
  and re-stamped against the file:line locations this feature shifted.
  Also drops an unused `ROLES` import left over in `cli.ts` after
  `promptModels` switched to an explicit `roles` parameter.

## [0.14.0] - 2026-07-18

### Changed

- Reviewer contract now requires independent reproduction when acceptance
  rests on empirical or probabilistic evidence: flake rates, benchmarks, "n
  runs green", or performance/timing numbers. The reviewer must rerun the
  measurement itself, not re-read the implementer's log, and record method,
  sample size, and result against the implementer's claim in a new
  `reproduction` field (`method, sample_size, result,
  matches_implementer_claim`) added to the Reviewer output contract in
  `SKILL.md` step 7 and to the installed `assets/agents/reviewer.md` prompt
  body (shared, byte-identical, by the Claude Code and opencode reviewer
  subagents). `matches_implementer_claim` uses `matched | mismatched |
  not_applicable` rather than `yes | no | not_applicable`: bare `yes`/`no`
  are YAML 1.1 boolean synonyms, and picking unambiguous tokens up front
  costs nothing even though this field is prose a human reads, not a
  machine-parsed value. The trigger is deliberately narrow: a single deterministic
  check (one test run, `tsc`, lint) does not qualify, only claims that could
  vary run to run. `05-review-findings.md` gains a short trailing comment
  pointing reviewers at the rule; the findings-table placeholder row itself
  is untouched. Motivated by a live incident (agent-dx run
  2026-07-18-harness-subprocess-test-deflake): an implementer's "8/8 green"
  flake-rate claim on a maxWorkers-cap fix was overturned only because the
  reviewer independently reran the suite and found 2/6 red on an independent
  6-run sample (flake rate ~1/3, matching the pre-fix baseline) — nothing in
  the prior contract required that rerun. Docs-only change: no runtime
  behavior in this package depends on the new field, it is a reporting
  contract the orchestrator and operator read. Motivated by agent-tasks task
  0018d61c.

## [0.13.0] - 2026-07-18

### Changed

- `05-review-findings.md`'s findings-table placeholder/legend row
  (`| low/medium/high/critical | ... | accepted/defer |`) now carries a
  comment stating its fail-closed semantics: replace this row when
  transferring reviewer findings (step 7), or delete it outright for a
  genuine zero-findings review (a header row with no data rows is valid; a
  leftover legend row next to real finding rows is also fine). `SKILL.md`'s
  step 7 gains a matching one-sentence rule. This is the contract half of a
  fix for a mixed-state bypass in grounding-mcp's orchestrator-workflow
  completeness reader: the reader identifies a real finding row by its
  Severity cell carrying a single concrete value, so the shipped slash-list
  legend row was never counted as a finding — a run that filled the
  `acceptance-recommendation` marker with `accept` but left this row
  byte-for-byte as shipped read as `complete: true` with zero findings,
  indistinguishable from a genuine zero-findings review. The runtime half
  (the reader treating a survived, unaccompanied placeholder row as an
  explicit format blocker instead of silently reporting zero findings) is a
  lockstep sibling change in grounding-mcp's own release, outside this
  package. In this package the change is docs/template/test-only: no
  runtime behavior changes here, the completeness reader itself is not part
  of this package, and the fail-closed enforcement only takes effect once
  grounding-mcp ships its lockstep sibling change (agent-tasks task
  8f173547); do not tag/publish this 0.13.0 release before that change ships
  (release ordering). A template-markers test pins the placeholder row's
  literal wording (mutation-checked, matching the reader's literal match) and
  that the replace/delete rule is documented next to it. Motivated by
  agent-tasks task fa0eca65.

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
