# Bundle log

- 2026-09-05T22:41:37Z (decision authority): re-verified the decision,
  reviewer, and review-gate surfaces after `03-decisions.md` gained its
  seven-column record. The new authority rule separates reviewer
  recommendation, orchestrator acceptance, and operator-only critical
  waivers; the decision record is evidence and does not authorize by itself.
  Re-stamped the affected review-gate, subagent-contract, and run-state
  articles. The focused contract suite renders the generated reviewer tiers
  and checks illustrative routine, revision, and critical-waiver records.

- 2026-09-05T20:47:02Z (identifier-drift item, reworded generic after
  rebase): rebased the identifier-drift reviewer checklist item onto
  master (`94cc1d2`, the squash-merge of PR #194); resolved the
  resulting conflicts in
  `reviewer.md`, `log.md`, `model-preselection.md`,
  `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`, and
  `subagent-contracts-superset.md` by taking the upstream (T-002) side for
  every `docs/okf/*.md` file and redoing the identifier-drift additions
  against the rebased tree. Reworded the reviewer.md item to stay
  tool-agnostic per decision D-026 (the kit ships tool-agnostic; the
  existing docs-consistency guard banning product names, including
  `agent-primitives`, from installed assets stays untouched): the item now
  names the trigger and the check generically and, when a drift check is
  connected, says to run it over the base..head range and judge every site
  it reports, with no product name in the sentence. Reverted the guard
  test's narrow exception back to its upstream form (banning
  `agent-primitives` across all four assets uninterrupted) and rewrote the
  item's own pinning describe block against the new wording. The
  CHANGELOG's `[Unreleased]` bullet keeps the concrete name ("the
  mechanical guard is `agent-primitives drift` (see the agent-primitives
  package)"), still anchored at `ow-kit-effort-analysis.md` section
  7(iv). Inserting the identifier-drift item added 8 lines to
  `reviewer.md` above its existing `Rules:` section, shifting every
  line-anchored citation into `reviewer.md` from `review-gate-and-
  waivers.md` and `subagent-contracts-superset.md` at or after the
  insertion point by +8 (re-derived: 51-57 to 59-65, 72-82 to 80-90,
  83 to 91, 104 to 112, 105-108 to 113-116, 84-110 to 92-118); the
  citation into `reviewer.md:30` above the insertion point was
  unaffected. Adding the CHANGELOG bullet (10 lines including its
  trailing blank line) further shifted this log's own historical
  self-citation into `CHANGELOG.md` (anchored on the keyed placeholder
  line's exact text, previously line 192) to line 219, re-pointed in
  place (see that entry's account, updated in this same edit).
  Validation: `npx vitest run
  test/docs-consistency.test.ts` passed all 268 tests; `npm test` passed
  all 721 tests across 17 files; `npm run typecheck` was clean. `okf-kit
  check --json --require-anchors docs/okf` on the committed tree reported
  0 errors, 1 warning (`install-fence-mechanics.md` staleness, the
  pre-existing baseline entry), 23 notices; measured against a temporary
  detached worktree of the rebase target `94cc1d2` alone, the same
  command reported the identical 0/1/23 summary, so this task's own edits
  introduce no new okf-kit finding.

- 2026-09-05T21:05:58Z (T-003b, agent-dx 503136a4: review-round-1 fixes):
  closed a delta after the first reviewer round on the entry above.
  Corrected that entry's own rebase base, previously stated as T-002's
  pre-squash branch commit `f059e98`; the real rebase target is master
  `94cc1d2` (the squash-merge of PR #194), corrected in both places it was
  cited. Corrected that entry's timestamp from a local-time-with-`Z`
  stamp (`22:47:00Z`) to the real UTC committer time (`20:47:02Z`).
  Reworded the reviewer.md item's closing parenthetical from an
  unconditional claim ("its allowlist covers released changelog sections
  and historical phrasing") to a conditional check ("if it allowlists
  released changelog sections or historical phrasing, check that its
  allowlist matches the change under review"), since a negative-control
  probe showed the old wording was unpinned and could be rewritten
  freely; the replacement holds the same 8 lines (`reviewer.md:50-57`),
  so no downstream `reviewer.md` citation shifted. Added one sentence to
  `SKILL.md` step 7, beside the GitHub Actions shell-replay reference it
  shares a paragraph with, mirroring the reviewer.md identifier-drift
  item for the orchestrator's own trivial-rename review path (Scaling
  delegation lets the orchestrator review a trivial rename without a
  reviewer spawn, and `SKILL.md` otherwise mirrors reviewer checks for
  Placement at step 9 and the Actions replay at steps 6/7). The insertion
  added a net +5 lines after old line 245 (before old line 246); every
  line-anchored `SKILL.md` citation at or after old line 246, in both
  bounds of every range, shifted by +5 across
  `review-gate-and-waivers.md`, `subagent-contracts-superset.md`, and
  `run-state-lifecycle-and-markers.md` (103 citations re-derived
  mechanically and spot-checked against the rebased tree's exact text;
  none below old line 246 moved). Re-stamped those three docs, whose
  sources changed in this edit; left `model-preselection.md`'s stamp
  untouched, since this branch has never edited it and master already
  carries the same stamp. Added a test pin for the new `SKILL.md`
  sentence and for the reworded allowlist parenthetical (mutation
  probes (e) and (f) below). Re-anchored the CHANGELOG identifier-drift
  test on the bullet's own opening and closing text instead of the
  `## [Unreleased]`-to-next-heading span, so the pin survives the bullet
  moving under a version heading on release; dropped the identifier-drift
  describe block's redundant local `flat` helper (the module-level
  `unwrap` already does the same whitespace collapse) and the no-op
  `flat()` wrapped around an already-`unwrap`ped string. Validation:
  `npx vitest run test/docs-consistency.test.ts` passed all 270 tests
  (268 plus the two new pins); `npm test` passed all 723 tests across 17
  files; `npm run typecheck` was clean.

- 2026-09-05 (docs-only closing delta): re-verified and re-stamped
  review-gate-and-waivers.md after the review gate gained a narrowly bounded
  post-review closure option for an entirely explanatory docs/comments/
  citations delta. Source/test edits, semantic command/configuration/policy/
  instruction/behavior changes, high/critical findings, and any other
  ineligible finding remain outside it. The option records concrete
  verification in the existing `05-review-findings.md` row with unchanged
  Severity/Decision headers and Decision `accepted`; it adds no reader or
  template schema. Re-verified and re-stamped only live citations affected by
  the change; historical evidence retains the source tokens it recorded. The
  live `CHANGELOG.md` rationale points to
  `lava-ice-logs/2026-09-05/ow-kit-effort-analysis.md` section 7(iii).
  Validation results are recorded with this task's implementation evidence.

- 2026-09-05T14:57:36Z (brief reference sites): re-verified and re-stamped
  subagent-contracts-superset.md after the Slice tasks rule and canonical
  task-slicer prompt began requiring annotated `relevant_files`/
  `relevant_docs` entries for every reference site of a changed identifier,
  config value, build context, or documented command. The invariant keeps its
  lossless-superset shape; this is guidance for populating existing fields,
  not a schema addition. Added a focused docs-consistency regression pin for
  both assets. Re-stamped model-preselection.md, review-gate-and-waivers.md,
  and run-state-lifecycle-and-markers.md after their live source citations
  shifted. Validation results are recorded with this task's implementation
  evidence.

- 2026-07-16: Bundle created (pilot for the agent-dx per-package granularity
  decision). Five docs authored and verified against package version 0.12.0
  (master 1982917): run-state-lifecycle-and-markers, install-fence-mechanics,
  model-preselection, subagent-contracts-superset, review-gate-and-waivers.
  Every claim file:line-verified by independent read-only doc-writers plus a
  fact-check review pass; validated with `okf-kit check --strict`; warn-only
  drift CI (`.github/workflows/okf-staleness.yml`) wired to this bundle path.
- 2026-07-18: re-verified and re-stamped run-state-lifecycle-and-markers.md,
  review-gate-and-waivers.md, and subagent-contracts-superset.md against
  package version 0.13.0 (contract half of the completeness-reader
  fail-closed fix, agent-tasks fa0eca65): 05-review-findings.md's
  placeholder/legend row gained a comment (and SKILL.md step 7 a matching
  sentence) documenting it as a fail-closed signal — replace on findings
  transfer, delete for a genuine zero-findings review — closing the
  "mixed-state bypass" where an untouched placeholder row plus a filled
  acceptance-recommendation marker read as a passed, zero-findings review;
  runtime enforcement is a lockstep sibling change in grounding-mcp (out of
  this bundle's scope). run-state-lifecycle-and-markers.md gained two new
  sections (the placeholder-row convention; why `02-tasks.md` is
  deliberately outside the completeness check) and a `02-tasks.md`
  `sources:` entry. The SKILL.md edit shifted every line at or after its old
  line 121 by +4; all three docs' `SKILL.md:` line citations at or after
  that point were re-verified and corrected — each corrected citation was
  checked against the CURRENT SKILL.md content directly (heading text,
  yaml-fence boundaries, or exact quoted prose), not derived by assuming a
  uniform +4 offset, though the offset turned out uniform in every case
  checked. subagent-contracts-superset.md's corrections cover the Explorer/
  Implementer/Reviewer/Task-slicer/Subagent-input contract locations and the
  full Subagent misfire rule clause-by-clause citation set.

  Correction (same day, found in review): the SKILL.md +4 shift was checked
  and fixed everywhere in the pass above, but a second, smaller shift was
  missed at the time — the placeholder-row comment added to
  05-review-findings.md itself (new line 14) pushed every line at or after
  the template's old line 14 down by +1, and none of the three docs'
  `05-review-findings.md:` citations past that point were re-checked against
  it in the first pass. Review caught four resulting stale citations —
  review-gate-and-waivers.md's `05-review-findings.md`, line 25 (Acceptance
  Recommendation enum line, should read `05-review-findings.md:26`) and `27` (the
  acceptance-recommendation marker, should read `:28`), and
  run-state-lifecycle-and-markers.md's matching `27` (marker, `:28`) and
  `23-25` (heading/blank/enum span, `05-review-findings.md:24-26`) — all four now corrected and
  re-verified by direct read against the current template. A full sweep of
  every `05-review-findings.md:` citation across the bundle (docs, SKILL.md,
  tests) confirmed these were the only four affected; citations at or before
  the template's old line 13 were already correct because they sit before
  the insertion point. Lesson recorded: re-verifying a doc after a source
  edit means checking EVERY edited source's own line-shift, not just the one
  that motivated the pass.

- 2026-07-18: re-verified and re-stamped run-state-lifecycle-and-markers.md,
  review-gate-and-waivers.md, and subagent-contracts-superset.md again
  against package version 0.14.0 (reviewer reproduction requirement,
  agent-tasks 0018d61c): SKILL.md step 7 gained a one-paragraph rule (8 new
  lines, after its old line 124) requiring the reviewer to independently
  reproduce empirical/probabilistic acceptance claims (flake rates,
  benchmarks, "n runs green", performance/timing numbers) rather than
  transcribe the implementer's reported numbers, narrowly scoped so a single
  deterministic check (one test run, `tsc`, lint) does not trigger it. Both
  reviewer output-contract copies (`SKILL.md`'s yaml block and the installed
  `assets/agents/reviewer.md` prompt, which the Claude Code and opencode
  harnesses install byte-identically) gained a matching `reproduction`
  field (`method, sample_size, result, matches_implementer_claim`, the last
  accepting `not_applicable` so a review that never hits the narrow trigger
  is not forced to fabricate a record); `reviewer.md` also gained the
  matching second-person Rules bullet (6 new lines, after its old line 38).
  `05-review-findings.md` gained a short trailing HTML comment pointing
  reviewers at the rule, appended strictly after the
  acceptance-recommendation marker (its last line) so no marker, header, or
  the fail-closed placeholder row shifted or was touched. CHANGELOG.md
  gained a new 0.14.0 entry (27 lines) inserted above 0.13.0, motivated by
  the agent-dx run `2026-07-18-harness-subprocess-test-deflake`: an
  implementer's "8/8 green" flake-rate claim on a `maxWorkers`-cap fix was
  overturned only because the reviewer independently reran the suite and
  found 2/6 red on an independent 6-run sample (flake rate ~1/3, matching
  the pre-fix baseline) — nothing in the prior contract had required that
  rerun. All three docs' `SKILL.md:`, `reviewer.md:`, and `CHANGELOG.md:`
  line citations were re-verified directly against the edited files'
  current content (not derived by assuming a uniform offset, per the lesson
  above) and corrected where stale; each doc also gained a new
  "Reproduction requirement (0.14.0)" section carrying the worked example
  with its exact numbers. Correction found and fixed in the same pass: the
  `CHANGELOG.md:` citations in all three docs were ALREADY stale before this
  run, by exactly the 31 lines the 0.13.0 entry added on 2026-07-18 earlier
  today — that insertion's downstream CHANGELOG.md line-citation shift was
  never checked in the log entry above (it only re-verified SKILL.md
  shifts), so every `CHANGELOG.md:` citation in the bundle was off by +31
  even before today's +27-line 0.14.0 insertion added a second, compounding
  shift; both are now folded into one corrected set of citations, verified
  directly against the current file rather than computed from either delta
  in isolation. model-preselection.md was re-stamped only (no content
  change; the `sources-fresh` staleness check flagged it because it also
  lists `test/docs-consistency.test.ts` as a source and this run appended a
  new test block to that file's end — the one citation it makes into that
  file, `test/docs-consistency.test.ts:28-32`, sits well before the
  appended block and was re-verified unchanged).
  `packages/orchestrator-workflow/test/docs-consistency.test.ts` gained one
  new `describe` block (appended at file end, so no existing test-line
  citation shifted) pinning the new clause and field in both contract
  copies; full suite 135/135 (131 + 4 new), `tsc --noEmit` clean, validated
  with `okf-kit check --strict` (clean after the model-preselection.md
  re-stamp).

  Review-fix follow-up (same day): the reviewer renamed
  `matches_implementer_claim`'s enum from `yes | no | not_applicable` to
  `matched | mismatched | not_applicable` (bare `yes`/`no` are YAML 1.1
  boolean synonyms; renaming was cheap since the field was still unshipped)
  in `SKILL.md`, `reviewer.md`, the CHANGELOG 0.14.0 entry (which also gained
  a sentence naming the YAML-boolean rationale, keeping the existing
  not-machine-readable sentence intact), and the test pin. The CHANGELOG
  edit added 4 lines inside the 0.14.0 entry, shifting every entry from
  0.13.0 downward by another +4 (on top of the +27 from the entry's original
  insertion) — every `CHANGELOG.md:` citation across all three docs was
  re-verified directly against the current file a second time and corrected;
  `SKILL.md:`/`reviewer.md:` citations were unaffected (the enum rename was a
  same-line replacement, no line-count change in either file). Also added a
  raw (non-line-unwrapped) byte-for-byte equality assertion between the two
  installed contracts' `reproduction` field blocks, so the "shared
  byte-for-byte" prose in this log and the CHANGELOG is now a tested
  invariant, not just an assertion via the line-unwrapped `toContain` checks
  already in place. Full suite 137/137 (135 + 2 new), `tsc --noEmit` clean,
  `okf-kit check --strict` clean.

- 2026-08-17: re-verified and re-stamped install-fence-mechanics.md and
  model-preselection.md against package version 0.15.0 (`--profile
  minimal|full` on `init`, review fix-round for agent-dx task 9f6a77e1):
  `models.ts` gained a ~44-line Profile block between `READ_ONLY_ROLES` and
  `ModelAlias` (shifting every `models.ts:` citation after line 17 in
  model-preselection.md), `cli.ts` gained `promptProfile` plus profile
  plumbing through the `init` action (shifting most `cli.ts:` citations),
  and `init.ts` gained a `profile` manifest field, a `profile`-aware
  `readInstalledManifest` fallback, `rolesForProfile`-scoped per-role
  installs, and (this fix-round) a full -> minimal downgrade-note block
  inserted before `installKitFile` — `runInit` moved from its old
  src/init.ts:178 to :198, and every citation at or after the old
  init.ts:216 templates-loop shifted by +21 (not a uniform offset applied
  blindly: every citation in both docs was checked against a direct read of
  the current file, the same discipline as the 2026-07-18 entries above).
  `test/init.test.ts` citations needed the same treatment for a second,
  independent reason: several were already stale at HEAD, predating even
  the profile feature commit (`631-651`, `705-717`, `719-726` did not
  correspond to any test in the file as committed) — these are corrected to
  the tests' actual current locations rather than shifted from a wrong
  baseline. This fix-round's own additions to `test/init.test.ts` (a
  CLI-path test pinning the pre-0.15.0-manifest full-not-minimal fallback,
  and three tests for the full -> minimal downgrade note and its uninstall
  interaction) are cited by their real line ranges. Both docs' `sources:`
  lists already covered every file touched, so no source entries were
  added. install-fence-mechanics.md also picked up two `test/uninstall.test.ts`
  citations that were already wrong at HEAD (`105-153`/`155-180` predated
  that file's own +34-line growth in the profile commit); corrected to
  `139-187`/`189-214` by direct read, `uninstall.ts` itself is untouched by
  the profile feature so its own citations were left as-is.

  Known gap, explicitly out of this pass's scope (the task named only these
  two docs): `okf-kit check docs/okf --strict` still exits 1 with 3
  pre-existing warnings unrelated to this fix-round —
  run-state-lifecycle-and-markers.md's `README.md`/`INSTALL-AGENT.md`
  staleness and subagent-contracts-superset.md's `src/models.ts` staleness
  (its `models.ts` `DEFAULT_MODELS` citation, at minimum, is now stale too
  — it cited lines 27-32 at the time, having moved to `70-75` by the same
  Profile-block insertion documented above). Neither install-fence-mechanics.md nor
  model-preselection.md contributes any finding to that run. Full suite
  152/152 (147 + 5 new: the fallback test above, three downgrade-note
  tests, and a docs-consistency pin for the new profile-aware "run any
  missing role inline" sentence in `SKILL.md`/`agents-md-section.md`),
  `tsc --noEmit` clean, `npm run build` clean, `prettier --check` clean for
  every file this fix-round touched (the two pre-existing warnings in
  `test/docs-consistency.test.ts` and `test/template-markers.test.ts` are
  both in code this pass never edited, confirmed by diffing prettier's
  reformatted output against the current file).

- 2026-08-18: re-verified and re-stamped subagent-contracts-superset.md and
  review-gate-and-waivers.md against package version 0.16.0 plus a same-day
  R2 fix-round on it (agent-tasks task 16637a96): the 0.16.0 feature commit
  (`mutation_probes` field, claim-only-what-was-measured rule,
  `acceptance_recommendation` hard-mandatory) landed without any docs/okf
  update, breaking with the 0.13.0/0.14.0/0.15.0 precedent of updating the
  bundle in the same commit as the feature; the R2 pass closed that gap and
  also hardened the feature itself on review findings (`mutation_probes`
  shipped with no trigger the kit itself ever produced — SKILL.md step 6
  said nothing about naming probes — and no not-applicable signal, so an
  implementer never given probes and one that silently dropped them
  returned the identical placeholder block; both closed by a new step-6
  sentence and a `mutation_probes: []` clause added to both output-contract
  copies). Two content-false claims were caught and corrected in
  subagent-contracts-superset.md: (1) "only the task-slicer/subagent-input
  relationship has a dedicated equality-and-superset test suite" was already
  false at the doc's own 2026-08-17 stamp, since the reviewer pair had a
  byte-for-byte `reproduction`-field test since 0.14.0
  (`test/docs-consistency.test.ts:986#"expect(skillBlock).toBe(reviewerBlock);"`); the doc now states the true
  current set of three guarded pairs (task-slicer/subagent-input, reviewer,
  implementer — the last two by byte-for-byte field-block equality tests)
  and names explorer as the one pair still without a dedicated guard; (2)
  the Subagent misfire rule's "Two detection signals" enumeration omitted
  the `mutation_probes`-omission trigger added in 0.16.0, now folded into
  signal 1 as the explicit example it is in `SKILL.md`'s own prose. A new
  "Mutation probes requirement (0.16.0)" section was added (the doc
  previously never mentioned the field at all) mirroring the existing
  "Reproduction requirement (0.14.0)" section's structure and depth.
  review-gate-and-waivers.md gained a new "Acceptance-recommendation
  mandatory rule (0.16.0)" section plus a mention in its existing
  `acceptance_recommendation` paragraph, and had three specifically
  reported stale citations corrected (`SKILL.md:238` for the reviewer
  severity enum, now resolving to the implementer contract's `recommendation`
  line, corrected to `:264`; `:242` for the `acceptance_recommendation`
  field, corrected to `:268`; `:330-332` for the misfire rule's review-gate
  consequence sentence, corrected to `:364-366`).

  Investigating those three citations surfaced a wider, pre-existing
  problem: nearly every `SKILL.md:`/`CHANGELOG.md:`/`test/docs-consistency.
  test.ts:` citation in both docs downstream of `SKILL.md`'s Workflow step 6
  was already stale at each doc's own last-stamped commit, not only because
  of this diff — spot checks (e.g. the Explorer output contract citation,
  the Subagent input contract citation, the CHANGELOG 0.11.0 motivation
  citation) resolved to wrong content even at the 0.15.0-era commit the
  docs claimed to be verified against, meaning a past re-stamp pass marked
  these docs current without re-deriving every citation from the file
  content directly. This pass fixed every citation of that kind actually
  read while rewriting the two docs' bodies (re-derived from the current
  file, not computed by applying a line-count delta to the old, already-
  wrong citation), but did not attempt a citation-by-citation audit of
  spans this pass did not otherwise touch or of citations into files this
  diff never changed (`agents-md-section.md`, the templates, `models.ts`,
  `template-markers.test.ts`) — those are flagged as a follow-up, not
  fixed here, per the task's own boundary ("pre-existing stale entries on
  OTHER docs/parts are not yours to fix"). model-preselection.md was
  re-stamped only, no content change: its one shifted source
  (`test/docs-consistency.test.ts`, appended-at-end in this diff same as in
  0.14.0's re-stamp) does not touch the specific line ranges the doc cites
  (`test/docs-consistency.test.ts:28-32, :34-41, :43-47, :49-59, :61-70`,
  all inside the "docs enumerate every installed role" block at the top of
  the file, unaffected by every append-at-end change since 0.11.0),
  confirmed unchanged by direct read.

  `test/docs-consistency.test.ts` gained one new `describe` block (37
  lines, appended after the 0.16.0 mutation-probes block so no earlier test
  citation shifted) pinning the R2 additions, including two exact-string
  pins that close a gap the existing byte-for-byte cross-copy equality test
  could not: a same-named field rename applied identically to both
  `SKILL.md` and `implementer.md` passes the cross-copy check (it only
  proves the two copies match each other) but now fails the new pins.
  Mutation-tested for real: deleting the new step-6 sentence, renaming
  `restored_verified` to `restored_check` in both copies, and deleting the
  `mutation_probes: []` clause from both copies each turned exactly the
  intended new test(s) red (the rename mutant specifically left the
  pre-existing cross-copy equality test green, confirming the gap it
  closes), and each was restored to the pre-mutant byte-for-byte state
  before re-verifying green. Full suite 163/163 (158 already on the branch
  at the 0.16.0-R1 commit + 5 new R2 tests in one new describe block, plus
  a wording fix to one pre-existing assertion in the 0.16.0-R1 describe
  block so it tracks the "incomplete" → "treated as a misfire, not
  evidence" wording change), `tsc --noEmit` clean, `tsc --noEmit -p
  tsconfig.test.json` clean, `npm run build` clean. `CHANGELOG.md`
  gained a "Review-fix follow-up" paragraph inside the existing
  (unreleased) 0.16.0 entry rather than a new version heading, per the
  task's instruction to keep the version at 0.16.0.

- 2026-08-18: re-verified and re-stamped review-gate-and-waivers.md,
  run-state-lifecycle-and-markers.md, and subagent-contracts-superset.md
  against package version 0.17.0 plus a same-day fix-round on it (agent-tasks
  task 66c548ad-9e99-4da7-8c49-7073b79ed072): the 0.17.0 feature commit
  (round-2 halt criterion in step 8, split-by-default rule in step 4 and
  `task-slicer.md`, diff-as-file reviewer briefing in step 7 and
  `reviewer.md`) landed without any docs/okf update, again breaking the
  0.13.0/0.14.0/0.15.0/0.16.0 precedent of updating the bundle in the same
  commit as the feature; the fix-round closed that gap. The fix-round also
  restructured `SKILL.md` beyond the original commit's shape: step 4's new
  sentence moved before the `minimal`-profile caveat (matching step 2's
  pattern), step 7 was rewrapped and gained a base/head provenance clause,
  and step 8's halt criterion was extracted into a new named `## Round-2 halt
  rule` section (mirroring the existing `## Subagent misfire rule` / `##
  Final acceptance rule` pattern) with only a one-sentence pointer left in
  step 8 itself, so every citation into those spans needed re-deriving from
  the final shape rather than from the original commit's line numbers.

  Every `SKILL.md:`, `reviewer.md:`, and `task-slicer.md:` citation in all
  three docs was checked directly against the current file content (not
  shifted by a computed offset) and corrected where stale, continuing the
  discipline from the 2026-07-18 and 2026-08-18 (0.16.0) entries above.
  `run-state-lifecycle-and-markers.md` needed the deepest pass: unlike the
  other two docs it had not been re-verified since 0.13.0/0.14.0 (the
  2026-08-17 entry above re-stamped only `install-fence-mechanics.md` and
  `model-preselection.md`, and the 2026-08-18 0.16.0 entry only the other two
  docs of this trio), so most of its `SKILL.md:` citations were already stale
  before this diff, including ones in spans this diff never touched: the
  Run-state section's "seven files" code-fence citation stopped one line
  short of `06-handoff.md`, the run-base paragraph's three citations and the
  `SKILL.md:79` "grounding-mcp 0.6.0 docs" pointer (actually line 82) had
  drifted off their sentences, and the Discover-step citation landed on the
  tail of step 1 instead of the "before mapping terrain by hand" clause. All
  were corrected by direct read against the current file, the same "check
  every citation, do not assume a uniform offset" discipline used elsewhere
  in this log, applied here to citations outside this fix-round's own diff
  because the task scope was "every citation in these three docs," not just
  the ones this diff broke. `subagent-contracts-superset.md` additionally
  needed two `task-slicer.md:` citation corrections (the output-contract
  block and the scope-boundaries sentence) since that installed prompt also
  gained a bullet in this fix-round; `explorer.md` and `implementer.md`
  citations were left untouched, as neither file changed.

  `test/docs-consistency.test.ts` gained three new `describe` blocks (one per
  0.17.0 lesson: split-by-default, diff-as-file plus its provenance anchor,
  and the round-2 halt rule) pinning prose that a full-revert of all three
  0.17.0 changes had left completely unguarded (163/163 green on revert,
  the gap this fix-round closes). Mutation-tested for real, one lesson at a
  time: reverting just the split-by-default prose (`SKILL.md` step 4 plus
  `task-slicer.md`'s bullet) to its pre-0.17.0 wording turned exactly the 3
  tests in that new block red; reverting just the diff-as-file prose
  (`SKILL.md` step 7's fallback and provenance clauses plus `reviewer.md`'s
  bullet) turned exactly the 4 tests in that block red; reverting just the
  round-2 halt prose (step 8's reference sentence and the whole `## Round-2
  halt rule` section) turned exactly the 5 tests in that block red; no other
  test was affected by any of the three mutants. Each mutant was restored to
  the byte-identical pre-mutant state (verified via `diff` against a saved
  copy) before moving to the next. Full suite 175/175 (163 + 12 new),
  `tsc --noEmit` clean, `tsc --noEmit -p tsconfig.test.json` clean,
  `npm run build` clean, `okf-kit check docs/okf --strict` clean (9
  `sources-fresh` staleness warnings before the timestamp bump in this pass,
  0 findings after).

- 2026-08-18: re-verified and re-stamped subagent-contracts-superset.md,
  review-gate-and-waivers.md, and run-state-lifecycle-and-markers.md against
  package version 0.18.0 plus a same-day review-fix round on it (agent-tasks
  task a932b12a, Refs a932b12a-cda0-4f5f-b3f9-2d6733837368): the 0.18.0
  feature commit (resume-over-respawn workaround for the near-instant
  reviewer misfire signal, model-correlation open lead, reviewer.md
  first-turn hardening) landed without any docs/okf update, repeating the
  0.16.0/0.17.0 gap the two log entries above already flagged as a
  precedent; the fix-round closed it. The fix-round also hardened the
  0.18.0 feature itself on four review findings, each requiring a real
  content change (not just a citation fix): (1) `SKILL.md`'s "every
  incident of this exact signal has resolved on the first resume attempt"
  overstated the record — only four resume outcomes for this signal are
  actually recorded (three on 2026-07-16, one on 2026-07-20); the
  2026-07-19 session named in the 0.18.0 CHANGELOG entry never had a resume
  outcome recorded at all. `SKILL.md` and the CHANGELOG entry now bind the
  claim to "whose outcome was recorded (four so far)" instead of a
  universal resolve rate, and the CHANGELOG entry no longer attributes a
  resume success to the 2026-07-19 session specifically. (2) `SKILL.md`
  gained a scope carve-out: the resume-over-respawn preference does not
  cover a structurally different misfire class, a mid-run watchdog stall,
  where the one measured incident did NOT resolve on resume (it stalled a
  second time) and only a fresh, explicitly constrained respawn produced a
  valid review; both docs' misfire-rule sections and the CHANGELOG entry's
  workaround bullet now name this carve-out explicitly. (3) The
  CHANGELOG's "model correlation flagged as an open lead" bullet named only
  "a structural comparison of the four installed agent prompts" without
  saying what was actually compared; it now names the three axes checked
  (frontmatter, line count, each role's `models.ts` default-model entry)
  and states explicitly why a deterministic repro is not achievable from a
  docs/prompt-only package (no runtime code here spawns subagents), making
  the open-lead claim checkable in-repo instead of a bare assertion. (4)
  The CHANGELOG's "Observation task, not closed" bullet named no observable
  or recording location for the open AC3 question; it now names the metric
  (first-spawn reviewer misfires of this exact signal, counted per session),
  the recording location (the friction-log and run notes), and a review
  cadence (after roughly five more sessions).

  `test/docs-consistency.test.ts` gained five new `it`s inside the existing
  0.18.0 `describe` block (`the misfire rule prefers resume with a repeated
  assignment for the no-tool-activity signal`, now 387-457): the
  parenthetical signal definition pin (408-412), the claim-binding pin
  (414-418), a derived assertion importing `DEFAULT_MODELS` alongside the
  already-imported `ROLES`/`READ_ONLY_ROLES` and asserting the reviewer
  default differs from all three other roles' defaults rather than trusting
  the prose alone (435-441), and the watchdog-stall scope-carve-out pin plus
  its own resolution-detail pin (443-456). Mutation-tested for real, one
  change at a time, each reverted and restored to the byte-identical
  pre-mutant state before moving to the next: reverting the claim-binding
  phrase to its pre-fix-round wording turned exactly 1 test red (the
  claim-binding pin); reverting the watchdog-stall clause (deleting both new
  sentences) turned exactly 2 tests red (the scope-carve-out pin and its
  resolution-detail pin); rewording the parenthetical signal definition
  turned exactly 1 test red (the parenthetical pin); setting
  `DEFAULT_MODELS.reviewer` to `"sonnet"` (matching the other three roles)
  turned the new derived-assertion test red plus 4 pre-existing runtime
  tests in `opencode.test.ts`/`init.test.ts` that exercise the reviewer's
  actual default model end to end — expected collateral, since
  `DEFAULT_MODELS` backs runtime behavior beyond this one prose claim, not a
  sign the new test is redundant with those. Full suite 187/187 (182 + 5
  new), `tsc --noEmit` clean, `tsc --noEmit -p tsconfig.test.json` clean,
  `npm run build` clean, `prettier --check` clean for every file this pass
  touched.

  Every `SKILL.md:`, `CHANGELOG.md:`, `reviewer.md:`, and
  `test/docs-consistency.test.ts:` citation in all three docs was checked
  directly against the current file content (not shifted by a computed
  offset, though the deltas turned out uniform almost everywhere checked)
  and corrected where stale, continuing the discipline from every entry
  above. Known shifts: `SKILL.md`'s misfire-rule section grew from
  `366-379` (its shape right after the original 0.18.0 commit, before this
  fix-round's own two additions) to `366-397`; `reviewer.md` gained 4 lines
  near its top (the first-turn-tool-call hardening), shifting every
  citation into it below that point by +4 (`56-77` -> `60-81`, `47-52` ->
  `51-56`, `72-76` -> `76-80`, `26-27` -> `30-31`); `CHANGELOG.md` grew by a
  net +28 lines below the 0.18.0 entry from the original 0.18.0 commit
  alone (0.17.0's heading moved `54` -> `82`, and every entry below it by
  the same +28), then by a further amount from this fix-round's own edits
  to the 0.18.0 entry, landing every older entry's citation at its current
  position (0.16.0 entry `8-54` -> `121-167`, 0.14.0 `99-128` -> `212-241`,
  0.11.0 `185-206` -> `298-319`, 0.10.0 `208-235` -> `321-348`, 0.9.0
  `146-163`/`150-158` -> `350-367`/`356-360`, 0.7.4 `271-285` -> `384-398`,
  0.7.3 `196-213`/`287-303` -> both `400-416`, 0.7.0 `248-260` -> `452-463`,
  0.12.0 `70-92` -> `274-296`); `test/docs-consistency.test.ts` grew from
  this fix-round's own five new `it`s plus the 112 lines the original
  0.18.0 commit had already added, shifting every citation below its
  insertion point (335-371's "subagent misfire rule ships in the skill"
  block itself did not move, since the 0.18.0 commit inserted after it, but
  everything after that block did: the Bash-residual pin `379-386` ->
  `486-493`, the task-slicer-superset block `401-585` -> `508-714` with its
  five internal sub-citations re-derived the same way, the reproduction
  byte-for-byte pin `641-653` -> `769-783`, the mutation-probes block
  `688-728`/`746-782` -> `818-858`/`876-912` with their sub-citations, and
  the acceptance_recommendation block `792-810` -> `922-940`).
  `run-state-lifecycle-and-markers.md`'s Knowledge Bundle section carried a
  second, independent kind of staleness found during this pass and fixed
  the same way: its `docs-consistency.test.ts` sub-citations for the
  "hand off keeps a curated knowledge bundle current" hook (`248-255` etc.)
  and its `run-base fill instruction`/`hand off` `describe`-block citations
  (`297-305`, `244-295`) were already wrong at the 0.17.0-pass baseline
  (verified by reading the same line ranges in that commit directly, which
  showed unrelated 0.16.0-entry content, not this hook) — a latent bug this
  pass's "re-verify every citation, not just the ones this diff broke"
  scope caught and corrected to `268-275`/`277-281`/`283-287`/`289-292`/
  `294-297`/`299-314` and `317-325`/`264-315` respectively.

  `okf-kit check docs/okf --strict` before this pass: 1 `sources-fresh`
  warning (model-preselection.md flagged stale purely on `test/
  docs-consistency.test.ts` mtime, its actual cited ranges `28-70`
  confirmed unaffected by any change in this pass or the 0.18.0 commit, so
  left un-re-stamped per the 0.14.0/0.17.0 precedent above of not
  re-stamping a doc whose own citations did not move). After this pass:
  identical single warning, 0 new findings — the model-preselection.md
  warning is expected to persist until a pass that actually touches its
  cited ranges re-stamps it; not fixed here, per the task's own boundary.

- 2026-08-19: re-verified and re-stamped install-fence-mechanics.md and
  model-preselection.md again against package version 0.19.0 (`--tiers` on
  `init`, agent-dx task T-002, docs-only follow-up to the T-001 feature
  commit c78e44a). `models.ts` gained a ~60-line tier block appended after
  `parseModelsSpec` (line 144 onward): `Tier`, `ROLE_TIERS`, `DEFAULT_TIER`,
  `ModelClass`, `TIER_DEFS`, `CLASS_MODELS`. Because that block is purely
  appended at the end of the file, every existing `models.ts:` citation in
  both docs (all of them at or before line 144) needed no correction at
  all, confirmed by direct read rather than assumed. `cli.ts` and `init.ts`
  were not so lucky: `cli.ts` gained new imports (`ModelClass`,
  `CLASS_MODELS`, `MODEL_CLASSES`, `detectProvider`, `resolveAlias`) plus a
  `tiers` resolution block and an opencode-class-model resolution block
  inside the `init` action, shifting every citation from the profile-block
  onward; `init.ts` gained a `tiers`/`opencodeClassModels` pair on
  `InitOptions` (+16 lines) and a `tiers` field on `Manifest` (+2), which
  shifted `readInstalledManifest` and everything through its own
  tiers-fallback addition by a uniform +22 (verified against four
  independent citations, not assumed), then diverged further below that
  point once the four new compose/effort-line functions and the two
  tier-rendering loops were added. Every `cli.ts:` and `init.ts:` citation
  in both docs was re-derived from a direct read of the current file at
  that exact location, not a computed offset applied blindly, the same
  discipline as the 2026-08-17 entry above. `test/init.test.ts` needed a
  narrower fix: the new `describe("tier variants (\`--tiers\`)")` block was
  inserted at the file's old line 941 (confirmed from the commit's own
  diff hunk header), so every citation before that line in both docs
  (`test/init.test.ts:100-106`, `:275-306`, `:464-509`, `:511-534`,
  `:721-758`, `:921-941`) needed no change, while the two citations past it
  (`:995-1007`, `:1009-1016`, the opencode-absent-binary tests) shifted by
  the same uniform +228 the insertion added; both kinds of claim were
  confirmed by direct read, not inferred from the insertion size alone.
  `INSTALL-AGENT.md` itself changed under this same task (the `--tiers`
  question, command example, manifest-JSON `"tiers": false` field, and a
  new manual-fallback carve-out stating that path never renders
  tier-variant files), so every `INSTALL-AGENT.md:` citation in both docs
  was re-derived from the edited file, not the pre-edit one.

  Both docs also gained new content, not just corrected citations:
  model-preselection.md gained a full "Effort tiers (`--tiers`)" section
  (tier data, composition, rendering, manifest/re-install semantics, cross-
  references to the two new source files touched) plus tier-aware
  additions to its existing "What gets preselected", "Flow", "Per-harness
  frontmatter behavior", "Re-install behavior", "Docs-consistency pins",
  and "Solution-neutral notes" sections; install-fence-mechanics.md gained
  a tiers-aware paragraph in "What `init` writes", a `tiers` field and
  seeding-bullet addition in "manifest.json: shape and consumers", a
  tiers-idempotence bullet in "Re-install / upgrade semantics", a
  tiers-uninstall bullet in "Uninstall: exact removal surface", and a
  tier-test-coverage sentence in "Tests". One structural finding surfaced
  during this re-verification, not present before: unlike a `full` ->
  `minimal` profile downgrade, which prints an explicit `report.notes`
  entry naming the now-untracked role files, a `tiers: true` -> `tiers:
  false` re-run is a structurally identical leftover-files case (the
  previously rendered `<role>-<tier>.md` files are simply dropped from the
  new manifest's `files` ledger, neither deleted nor re-tracked) but prints
  no equivalent note at all; both docs now state this asymmetry explicitly
  rather than silently assuming parity with the profile case. This is
  reported as a documentation finding, not fixed in `src/` here, since
  T-002's scope is docs-only.

  A new task/T-002-scoped test/docs-consistency.test.ts `describe` (a sixth
  test alongside the existing four model-enumeration guards plus the
  read-only-role brace-list guard) pins README's new "Effort tiers" table
  against `ROLE_TIERS`/`DEFAULT_TIER` directly, per role, per column, plus
  a row-count check; both docs' "Docs-consistency pins" sections now cite
  it. Mutation-tested for real against the full suite, not just the one
  test file: removing `"low"` from `ROLE_TIERS.explorer` in `src/models.ts`
  turned 5 of 206 tests red, the intended target (the explorer
  tiers-column assertion in the new `describe`) plus 4 pre-existing
  `test/init.test.ts` tests in the 0.19.0 `tier variants` block that assert
  actual rendering behavior (the 13-file count, the collision-free file
  set, the uninstall-removes-variants check, and the CLI re-run
  persistence check all depend on `explorer` actually having a `low`
  tier); this is expected collateral from mutating a source of runtime
  behavior, not a sign the new docs-consistency test is redundant with
  those, the same reasoning the 0.18.0 entry above applies to a
  `DEFAULT_MODELS` mutation. Every other role's tiers/default-tier
  assertion in the same new `describe`, and the remaining 201 tests
  overall, stayed green. Restoring the line brought the file back to a
  byte-identical, empty `git diff`, and the full suite (206/206) went
  green again, both verified directly, not assumed.

  `okf-kit check docs/okf --strict` before this pass: 10 `sources-fresh`
  warnings (4 on install-fence-mechanics.md, 5 on model-preselection.md, 1
  on subagent-contracts-superset.md, all mtime-driven staleness against
  `src/models.ts`/`src/cli.ts`/`src/init.ts`/`test/init.test.ts` changed by
  the T-001 commit). After this pass: 1 warning, the pre-existing
  subagent-contracts-superset.md `src/models.ts` staleness, unchanged and
  explicitly out of this task's scope (T-002 named only
  install-fence-mechanics.md and model-preselection.md for re-verification;
  subagent-contracts-superset.md's own citations into `models.ts:3-8` are
  unaffected by the purely-appended tier block, so nothing in it is
  actually stale content-wise, only its staleness-by-mtime signal is). Full
  suite 206/206 (197 + 9 new), `tsc --noEmit` clean, `tsc --noEmit -p
  tsconfig.test.json` clean, `npm run build` clean, `prettier --check`
  clean for every file this pass touched (one new-file formatting issue in
  `test/docs-consistency.test.ts`, introduced by this pass's own additions,
  was caught by `prettier --check` and fixed with `--write` before commit;
  the pre-existing `test/template-markers.test.ts` warning is unrelated and
  untouched by this pass, matching the baseline measured before any edit).

- 2026-08-19: fix-round-1 on 0.19.0's `--tiers` feature (agent-tasks reviewer
  pass on task T-003, 6 medium + 4 low findings, 0 high/critical) re-verified
  and re-stamped model-preselection.md and install-fence-mechanics.md again,
  the two docs the review's own findings (M1 opencode no-op variants + no
  warning, M2 one-way `--tiers`, M3 downgrade-note gap, M4 provider-vs-family
  effort dispatch, L2 unused `TIERS`/`isTier` exports, L3 stale citations)
  directly touch. Every citation into `models.ts`/`init.ts`/`cli.ts` shifted
  by the fix commit was re-derived from a direct read of the current file at
  that exact location (grep for the anchor phrase or `it(...)`/`describe(...)`
  title, then read the exact span), not a computed offset applied blindly —
  the same discipline every prior pass in this log used — though three
  distinct uniform shifts turned out to hold across large stretches of
  `cli.ts` and `test/init.test.ts` (a `--no-tiers` commander option addition
  shifted every `cli.ts` line after it by a flat +4 before the tiers-
  resolution rewrite itself added another +6; an `import { DEFAULT_TIER,
  ROLE_TIERS }` addition shifted every `test/init.test.ts` line after it by a
  flat +2 until the first new test insertion point), and each shift was
  spot-checked against a handful of independently re-read anchors before
  being trusted for the rest of its span. One citation-accuracy miss from
  this pass's own first draft was caught in its own second read-back before
  commit: four `test/init.test.ts` citations inside the flat-+2-shift zone
  (the AGENTS.md-restore-on-mangle test, the inline-marker-immunity test,
  and both CLAUDE.md-import tests) were initially copied forward unshifted
  on the wrong assumption that "the cited source file (`writers.ts`) didn't
  change" meant "the test citation doesn't need to move either" — it does,
  since the test *file* still shifted even though the function under test
  did not; all four were corrected by direct re-read before this entry was
  written, the same "verify, don't assume — even inside a region you already
  trust" lesson the 2026-08-17 entry above names for exactly this failure
  mode.

  Both docs also gained substantial new content, not just corrected
  citations, since three of the four medium findings changed actual runtime
  behavior the docs described: model-preselection.md's "Effort tiers"
  section now documents `--no-tiers` (the commander-negatable counterpart to
  `--tiers`, M2), the family-based (not provider-id-based) opencode effort
  dispatch via the new `isClaudeFamilyModel` helper (M4, with the concrete
  failure mode named — a `github-copilot/claude-*` or nested
  `openrouter/anthropic/claude-*` model previously fell through to
  `reasoningEffort:` instead of `variant:`), and a new "Unresolved-class
  guard" paragraph covering both halves of M1 (the per-class stderr warning
  in `cli.ts`, and `init.ts` now skipping the write entirely for a variant
  that would carry neither a `model:` nor an effort line). The "Docs-
  consistency pins" section gained a fifth guard entry (L4's second
  `describe`, pinning README's Tier -> model class/alias/effort table
  against `TIER_DEFS`/`CLASS_MODELS`, mirroring the existing role/tier-table
  guard). install-fence-mechanics.md's "What `init` writes" section replaced
  its own prior finding (the T-002 pass above had documented the `tiers:
  true -> false` silent-no-note asymmetry as a real gap, correctly, since
  fixing it was out of T-002's docs-only scope) with the fix itself: the new
  `--no-tiers`-driven downgrade-note block (M2) and the profile-downgrade
  note loop's extension to also cover a dropped role's tier-variant files
  when `previous.tiers` was true (M3), plus why the two note loops never
  double-fire (they iterate disjoint role sets — dropped roles vs. still-
  installed roles). The `L1` content-assertion addition (pinning the exact
  four-line legacy default-file frontmatter, not just the file-set) and the
  new invariant test (`DEFAULT_TIER[role]` is always a member of
  `ROLE_TIERS[role]`, from the review's Missing Tests list rather than a
  numbered finding) are both cited in the "Tests" section's now-longer
  enumeration of the `tier variants` describe block.

  `okf-kit check docs/okf --strict` immediately before this pass's commit:
  9 `sources-fresh` warnings — 2 on review-gate-and-waivers.md, 4 on
  run-state-lifecycle-and-markers.md, 3 on subagent-contracts-superset.md,
  none on either doc this pass touches (their own timestamps were already
  the newest in the bundle from the T-002 pass above, so nothing had gone
  stale against them yet at measurement time; the 9 warnings are all
  mtime-driven staleness against files this fix-round's *commit* had not
  yet touched from git's perspective — `docs-consistency.test.ts`,
  `CHANGELOG.md`, `README.md`, `INSTALL-AGENT.md`, `models.ts` — since this
  checker keys "changed" off each file's last commit time, not raw
  filesystem mtime, so uncommitted working-tree edits do not move the
  needle until committed). Measured again after this pass's commit: see the
  commit's own PR/handoff note for the post-commit count, since committing
  is this pass's last step and the pre-commit number above is what a
  working-tree-only measurement can honestly report. Full suite 226/226
  (206 baseline + 20 new: 11 in `test/init.test.ts` for M1/M2/M3/M4/M5/the
  invariant test, 9 in `test/docs-consistency.test.ts` for L4), `tsc
  --noEmit` clean, `tsc --noEmit -p tsconfig.test.json` clean, `npm run
  build` clean, `prettier --check` clean for every file this pass touched
  (three files needed `--write`: `src/init.ts`, `test/docs-consistency.test.ts`,
  `test/init.test.ts`; the pre-existing `test/template-markers.test.ts`
  warning is unrelated and untouched, matching every prior pass's baseline).

- 2026-08-19: re-verified and re-stamped review-gate-and-waivers.md,
  run-state-lifecycle-and-markers.md, and subagent-contracts-superset.md
  against the tier-branch tip (agent-dx `task/48ea90ac-effort-tiers`,
  commits c78e44a/99506da/96b853c): the fix-round-1 entry above left this
  trio's `sources-fresh` warnings unaddressed as out of its own scope (2 on
  review-gate-and-waivers.md, 4 on run-state-lifecycle-and-markers.md, 3 on
  subagent-contracts-superset.md, all mtime-driven against `CHANGELOG.md`,
  `README.md`, `INSTALL-AGENT.md`, and `test/docs-consistency.test.ts`
  changed by the T-001/T-002/T-003 commits, plus `src/models.ts` for
  subagent-contracts-superset.md); this pass closes that gap. Neither
  `test/init.test.ts` nor `SKILL.md`/`reviewer.md`/`implementer.md`/
  `task-slicer.md`/`agents-md-section.md`/the templates changed on this
  branch, so no citation into those files needed checking.

  Every citation in the three docs into a file this branch actually changed
  was checked by direct read against the current file content, not shifted
  by an assumed offset. Before trusting any shift, each file's diff was read
  for its hunk count and shape, then the shift was spot-checked against a
  dozen-plus independently re-read anchors, not trusted on the strength of
  one match: `CHANGELOG.md` gained exactly one 59-line entry (0.19.0)
  inserted at its old line 8 in a single hunk with no other change anywhere
  in the file (`git diff --stat`: 59 insertions, 0 deletions), so every
  `CHANGELOG.md:` citation in all three docs shifted by a flat +59 with no
  exceptions. `test/docs-consistency.test.ts` changed in exactly two hunks: a
  +9-line import-statement expansion (five new named imports plus a `Tier`
  type import from `src/models.js`) within the file's first ten lines, and a
  +152-line append at its old EOF (old line 1079); every citation these three
  docs make falls between those two hunks, so all of them shifted by a flat
  +9. `src/models.ts` citations (`ROLES` at 3-8, `READ_ONLY_ROLES` at 14-17,
  `DEFAULT_MODELS` at 70-75, all in subagent-contracts-superset.md) needed no
  correction at all, confirmed unchanged by direct read: the branch's
  ~55-line tier block is purely appended after the file's old line 142, past
  every citation into it. `README.md:108-112` (run-state-lifecycle-and-markers.md's
  "What gets installed" code-fence citation, supporting the same
  copy-from-templates claim as the INSTALL-AGENT.md citation below) also
  needed no correction, confirmed byte-identical by direct read: both of the
  branch's README diff hunks land at old line 195 and 208, well after the
  cited span. `INSTALL-AGENT.md:44-45,110-113` (the doc's other citation for
  that claim) did need correction, since the branch's INSTALL-AGENT.md diff
  has six hunks spread through the file rather than one uniform shift:
  `44-45` (the Write-surface bullet listing `.ai/workflow/templates/00-goal.md`
  through `06-handoff.md`) moved to `47-48` (a flat +3 from the first hunk,
  which lands entirely above it); `110-113` (the manual-fallback step 4
  bullet listing the same templates) moved to `135-138`, found by locating
  the unchanged bullet text directly in the current file rather than
  computing a shift, since that citation's own span sits inside the fourth
  of the six hunks, which rewrites content immediately around it.

  No content-false claims were found in this pass; every citation checked
  still supported the sentence it was attached to once its line numbers were
  corrected, so no prose changed, only `path:line` pointers and the three
  docs' `timestamp:` frontmatter (bumped to `2026-08-19T22:30:00Z`, matching
  the stamp install-fence-mechanics.md and model-preselection.md already
  carry from the T-002/T-003 passes). `okf-kit check docs/okf --strict`
  immediately before this pass: 9 `sources-fresh` warnings, exactly the count
  and distribution the fix-round-1 entry above predicted. After this pass: 0
  warnings, 0 findings. Full suite unchanged at 226/226 (no `src/` or `test/`
  file was touched by this pass), `prettier --check` unchanged from the
  pre-existing single `test/template-markers.test.ts` warning baseline (also
  untouched by this pass). No mutation probes were named for this task: it
  is a pure citation- and timestamp-correction pass with no new or changed
  test assertions to mutate.

- 2026-08-19: fix-round-2 on `--tiers` (review round 2, 3 medium + 2 low
  findings, 0 high/critical, agent-dx branch `task/48ea90ac-effort-tiers`,
  base 68c1acf) re-verified and re-stamped model-preselection.md and
  install-fence-mechanics.md again, the two docs review-round-2's own
  findings (R2-M1 stale README/CHANGELOG opencode-effort prose, R2-M2
  enumeration-driven leftover notes, R2-M3 the M1 warning's stale wording,
  R2-L1 the redundant `effortLine` double-computation, R2-L2 leftover-note
  test coverage gaps) directly touch, plus a citation-only re-stamp of
  review-gate-and-waivers.md, run-state-lifecycle-and-markers.md, and
  subagent-contracts-superset.md (their shared `CHANGELOG.md:` citations all
  shifted by the same flat amount the 0.19.0 CHANGELOG entry's own R2-M1
  content correction added).

  R2-M2 is the structural fix: both leftover-note loops in `init.ts`
  previously derived their note set from `ROLE_TIERS`/`options.harnesses`
  (an enumeration of what *could* exist) rather than from what the previous
  install actually wrote (`previous.files`/`previous.harnesses`, the
  ledger). That produced phantom notes for variant files an unresolved
  opencode tier-class catalog had already skipped writing (the M1 guard),
  and silently dropped real leftover notes whenever the current run's
  `--harness` selection no longer included the harness the leftover file
  actually lived under. Both loops now gate every candidate note on the
  exact relative path being a key of `previous.files`, and both iterate
  `previous.harnesses` instead of `options.harnesses`; `ROLE_TIERS[role]`
  is now used only to enumerate candidate tier suffixes to probe against
  the ledger, never as the note-emission source of truth. R2-L1 simplified
  the opencode variant-skip check the same equivalence-proof way: the
  fix-round-1 form gated on `variantModelValue === undefined && effortLine
  === undefined`, but `opencodeVariantEffortLine` always returns `undefined`
  when its own `modelValue` argument is `undefined`, so the second clause
  never added any filtering the first did not already provide; the skip
  check now reads `variantModelValue === undefined` alone, and
  `composeOpencodeAgentVariant` takes the already-computed effort line as a
  fourth parameter instead of recomputing it internally. R2-M3 corrected
  the M1 unresolved-class warning's own wording, which had claimed "model:
  will be omitted for its effort-tier variants" when the real,
  already-shipped fix-round-1 effect was "no variant file is rendered for
  this class at all" (a stronger, better outcome the warning undersold),
  and which never named its own opencode-only scope; the corrected wording
  states both. R2-M1 is the docs-only sibling of R2-M3 and M4: README's
  opencode-effort prose and the CHANGELOG 0.19.0 entry still described the
  pre-fix-round-1 dispatch (provider-string-keyed, M4's bug) and the
  pre-fix-round-1 unresolved-class behavior (a rendered file with just the
  `model:` line omitted, M1's original bug), neither ever corrected once
  fix-round-1 shipped the actual code fixes; both docs now use family terms
  ("Claude-family models", matching `isClaudeFamilyModel`) and state the
  real unresolved-class effect.

  `src/init.ts` and `src/cli.ts` citations in both docs were re-derived by
  direct read against the current file at each exact location, not a
  computed offset applied blindly, the same discipline as every entry
  above; `git diff` for both files landed in several small, non-adjacent
  hunks rather than one uniform shift (`init.ts`: six hunks spanning the
  `composeOpencodeAgentVariant` JSDoc/signature change, the new
  `previousHarnessDirs` block, both note loops' ledger-check rewrite, and
  the opencode tier loop's restructured skip check; `cli.ts`: one hunk, the
  warning-text rewrite), so each citation was individually relocated by
  grep-for-anchor-then-read rather than by any single delta. `test/init.test.ts`
  citations needed the same per-hunk treatment for the block after its own
  insertion point (a new `describe("leftover notes are ledger-driven, not
  enumeration-driven (review round 2, R2-M2)")`, `init.test.ts:888-971`,
  inserted right after the existing profile-downgrade `describe` and before
  the kit-owned-file-conflicts one) plus the two strengthened R2-M3 stderr
  tests further down; everything between those two insertion points shifted
  by a uniform, spot-checked +85 (confirmed against a dozen-plus
  independently re-read anchors spanning both re-run and CLI-level tests,
  not trusted on one match, before being applied to the rest of that span).
  `README.md` and `CHANGELOG.md` citations in both docs turned out to need
  no correction at all: neither doc had ever cited a line inside either
  file's changed region (README's opencode-effort prose, lines 251-286;
  CHANGELOG's 0.19.0 entry, lines 8-74), confirmed by a targeted grep before
  concluding no fix was needed there, rather than assumed from the section
  names alone. The three CHANGELOG-citing docs outside this task's direct
  scope (review-gate-and-waivers.md, run-state-lifecycle-and-markers.md,
  subagent-contracts-superset.md) needed the flat `CHANGELOG.md:` +8 shift
  described above; every one of their existing citations was spot-checked
  against the shifted file at three different distances from the edit point
  (a citation seven lines after the edit, one about 15 lines after, and one
  more than 400 lines after) before applying the shift to the rest.

  Both primary docs also gained substantial new content, not just corrected
  citations: model-preselection.md's "Composition" and "Unresolved-class
  guard" paragraphs were rewritten for R2-L1's parameter change and R2-M3's
  corrected warning wording respectively, its "Manifest and re-install"
  section gained an R2-M2 paragraph on the ledger-driven note mechanics
  plus a cross-reference to install-fence-mechanics.md's fuller treatment,
  its "README documents..." paragraph now names the R2-M1 correction
  explicitly instead of silently citing the (now-different) README
  section, and its "Docs-consistency pins" section gained a third guard
  entry for the new `test/docs-consistency.test.ts` `describe` pinning the
  corrected README prose (`:1244-1302`, appended at the file's end).
  install-fence-mechanics.md's "What `init` writes" section gained the same
  R2-L1/R2-M3 mechanics paragraph and a substantially rewritten
  M2/M3-plus-R2-M2 paragraph explaining why neither the fix-round-1
  `previous.tiers` boolean gate nor the original `ROLE_TIERS`/
  `options.harnesses` enumeration was sufficient, and its "Tests" section
  gained a description of the new `init.test.ts:888-971` `describe` and the
  two strengthened stderr-wording tests.

  `okf-kit check docs/okf --strict`: both immediately before and after this
  pass's commit, the check reports 0 warnings, 0 findings, for a mechanical
  reason worth recording rather than treating as proof of nothing having
  gone stale: this bundle's docs carry a `timestamp:` frontmatter value
  chosen with same-day headroom (`2026-08-19T22:30:00Z` UTC, comfortably
  past every commit made so far today in this session's local `+02:00`
  wall-clock), so the `sources-fresh` rule's mtime-based staleness gate
  cannot fire against any same-day commit regardless of whether the doc's
  actual prose was re-verified, only a commit crossing into the next UTC
  day would trip it. Verified directly rather than assumed: a disposable
  local test (a scratch commit of the `src`/`test` changes alone, with the
  docs' frontmatter `timestamp:` temporarily set far in the past,
  `2020-01-01T00:00:00Z`, then reset back out via `git reset --soft` before
  any real commit) reproduced 5 `STALE` warnings against exactly the
  sources this diff touches, confirming the checker's mechanism itself
  works correctly and would have caught a genuinely stale doc; the 0/0
  reading at this pass's actual, same-day timestamps is the tool's known
  date-granularity limit, not a false negative, and the doc content itself
  was independently re-verified by the direct-read citation discipline
  described above, not by trusting the checker's clean report alone. Full
  suite 231/231 (226 baseline + 3 new in
  `test/docs-consistency.test.ts` for R2-M1's README-prose guard + 2 new in
  `test/init.test.ts` for R2-M2's ledger-driven-notes `describe`, the two
  existing R2-M3 stderr tests strengthened in place rather than added),
  `tsc --noEmit` clean, `tsc --noEmit -p tsconfig.test.json` clean, `npm
  run build` clean, `prettier --check` clean for every file this pass
  touched (one new formatting issue in `src/init.ts`, introduced by this
  pass's own edits, was caught by `prettier --check` and fixed with
  `--write` before commit; the pre-existing `test/template-markers.test.ts`
  warning is unrelated and untouched, matching every prior pass's
  baseline). Mutation probes (named in the task assignment): removing the
  `previous.files`-gate condition from the tiers-off note loop (`init.ts`'s
  `previous.tiers && !tiers` block, the one the new "opencode + unresolved
  tier-class models... exactly 0 leftover notes" test exercises; reverting
  to unconditional `ROLE_TIERS` enumeration) turned that test red (9
  phantom notes instead of 0), restored and re-verified green — this probe
  demonstrates only that one loop's gate; the review-round-2 fix touched an
  analogous gate inside the full -> minimal profile-downgrade loop's own
  tier-variant sub-loop (`init.ts` ~393) too, but no test in this round
  exercised that second gate specifically, a coverage gap review round 3
  (R3-L1, see below) later found and closed with its own dedicated mutation
  probe. Resetting `cli.ts`'s warning text to the pre-fix-round-2 wording
  turned both strengthened stderr tests red, restored and re-verified
  green. Both mutants were applied and restored with the working tree
  committed first, per this repo's commit-before-mutation-probe convention.

- 2026-08-19: fix-round-3 on `--tiers` (review round 3, 0 medium, 4 low
  findings, 0 high/critical, agent-dx branch `task/48ea90ac-effort-tiers`,
  base 32e83f5) re-verified and re-stamped model-preselection.md and
  install-fence-mechanics.md again, the two docs review-round-3's own
  findings (R3-L1 the untested profile-downgrade ledger gate, R3-L2 the
  factually-wrong `effortLine`-parameter JSDoc/doc rationale repeated in
  both docs, R3-L3 the stale `cli.ts` warning-comment wording, R3-L4 the
  lost no-provider-prefix case in README's opencode-effort prose) directly
  touch; log.md itself is also in scope, both for its own R3-L1 precision
  fix (below) and as the file carrying this entry.

  R3-L1 is the structural fix, mirroring R2-M2's shape one level down: the
  review-round-2 pass proved the *tiers-off* leftover-note loop's
  `previous.files`-gate was real (a mutant reverting it to unconditional
  `ROLE_TIERS` enumeration turned a dedicated test red), but its mutation
  probe never touched the sibling gate inside the *full -> minimal
  profile-downgrade* loop's own tier-variant sub-loop (`init.ts` ~393,
  `if (previous.files[variantPath] !== undefined)`) — on HEAD that gate
  behaves identically to its sibling, but nothing in the 233-test suite
  actually exercised it, so a `if (true)` mutant there survived silently.
  A new `test/init.test.ts:989-1025` `describe` closes the gap: an opencode
  install whose tier-class models never resolved (so, same as the R2-M2
  test above it, the M1 guard writes zero variant files) followed by a
  full -> minimal downgrade that still has tiers on asserts exactly the two
  dropped roles' base-file notes and no phantom `-low.md`/`-high.md`
  variant notes. Measured directly in this pass, working tree committed
  first per this repo's commit-before-mutation-probe convention: reverting
  `init.ts`'s gate to `if (true)` turned exactly this one new test red (6
  notes instead of the expected 2 — the 2 real base-file notes plus 4
  phantom variant notes, one per non-default tier of each of the two
  dropped roles), with the other 232 tests unaffected; restored to the
  byte-identical pre-mutant state (confirmed via `git diff`) and the full
  suite (233/233) went green again, both verified directly, not assumed.
  This pass also precised the review-round-2 log entry's own mutation-probe
  sentence above: it had described the tiers-off-loop probe as covering
  "both `init.ts` note loops," which overstated what that probe actually
  demonstrated (only the tiers-off loop; the profile-downgrade loop's own
  gate was the untested one R3-L1 found) — corrected in place rather than
  left to imply a coverage this bundle did not have at the time.

  R3-L2 is a pure-comment correctness fix, no behavior change: the
  `effortLine` parameter's JSDoc on `composeOpencodeAgentVariant`
  (`init.ts:298-304`) claimed the caller passes the value in "since the
  caller already needs that same value to decide whether to skip writing
  this variant at all" — false since fix-round-1: the skip decision (`init.ts:511`,
  `variantModelValue === undefined`) depends only on the class model's
  resolution, computed and checked *before* `effortLine` exists at all
  (`init.ts:526` computes it only after that check passes); the real reason
  for the fourth-parameter change (review-round-2, R2-L1) is a single
  computed value instead of two independent call sites for it. The JSDoc
  was rewritten to state that; both OKF docs repeated the same wrong
  rationale (model-preselection.md's "Composition" paragraph, and a
  self-contradictory passage in install-fence-mechanics.md's "What `init`
  writes" section that had already *proved* the skip check does not depend
  on `effortLine` two sentences earlier via the R2-L1 equivalence proof,
  then contradicted its own proof by attributing the fourth-parameter
  change to that same dependency) — both corrected the same way, in place,
  crediting R3-L2 explicitly so a future re-verification pass does not
  mistake the correction for original fix-round-2 content.

  R3-L3 is likewise a pure-comment fix: the code comment directly above
  `cli.ts`'s per-unresolved-class-model warning (`cli.ts:304-307`) still
  read like the pre-fix-round-1 world ("every effort-tier variant... 
  silently rendered with no model: line"), a description fix-round-1's own
  M1 guard had already made false (the variant is skipped entirely, not
  rendered with a field omitted) but which review-round-2's wording pass
  only fixed in the *warning text itself* and the comment directly above
  the `process.stderr.write` call, not in this second, slightly higher
  comment that motivates the `const reason` computation below it. Reworded
  to state the real semantics plainly: "init.ts skips the variant write
  entirely when the class model is unresolved." No line count changed in
  either `init.ts` or `cli.ts` (both edits kept their surrounding
  functions' line numbers stable), confirmed directly rather than assumed,
  so no citation into either file needed re-deriving because of these two
  fixes specifically — only R3-L1's test insertions shifted `init.test.ts`
  citations, handled separately below.

  R3-L4 restores a lost case in README's opencode-effort bullet list
  ("Effort tiers" section): the Ollama bullet had narrowed from
  "Ollama, or an id with no provider prefix" (the actual dispatch in
  `opencodeVariantEffortLine`, `init.ts:282-296`, whose provider lookup
  splits on the first `/` and treats `provider === undefined` the same as
  `provider === "ollama"`) down to just "Ollama" at some earlier rewrite,
  making the following "every other non-Claude-family model gets
  `reasoningEffort:`" bullet false for an unqualified id. Restored as
  "Ollama, or an id with no provider prefix: no effort field at all."; the
  identical lost case was also found, while re-verifying, in this bundle's
  own model-preselection.md prose (the "Per-harness frontmatter behavior"
  paragraph) and in the CHANGELOG 0.19.0 entry's opencode-effort sentence,
  both corrected the same way (the CHANGELOG fix was rewrapped to hold the
  same 3-line span as before specifically so it would not shift any of the
  three CHANGELOG-citing docs outside this task's scope, which were left
  untouched). A new `test/init.test.ts:1287-1313` test pins the runtime
  behavior directly: an opencode install with a resolved-but-unqualified
  class id (`"local-model"`, no `/`) renders a variant file carrying a
  `model:` line but no `variant:`/`reasoningEffort:` line, inserted right
  after the existing Ollama-outcome test since it is the same code-path
  family. `test/docs-consistency.test.ts`'s existing substring-based README
  opencode-effort-prose guard (`:1244-1302`, from review-round-2) needed no
  change: it asserts the prose contains "Claude-family" and does not
  contain either of two specific stale phrases, neither of which this
  wording change touches, confirmed by re-reading that test directly rather
  than assumed safe.

  `src/init.ts` and `src/cli.ts` citations in both docs were re-derived by
  direct read against the current file at each exact location, the same
  discipline as every entry above; both files' own diffs in this pass
  landed inside existing functions/comments with no net line-count change
  (verified via `git diff --stat`: `init.ts` +8/-8, `cli.ts` +6/-6), so no
  citation into either file needed re-deriving because of this pass's
  `src/` edits specifically. `test/init.test.ts` is the one file whose
  shift needed real care: `git diff --stat` shows a clean +82 lines, 0
  deletions, in exactly two hunks (`git diff` hunk headers: `@@ -970,6
  +970,60 @@` and `@@ -1230,6 +1284,34 @@`), giving a three-zone shift
  rather than one uniform delta — old line <= 972 unshifted, 973-1232
  shifted +54 (the R3-L1 `describe` block, inserted right after the
  existing R2-M2 one and before the kit-owned-file-conflicts one), and
  >= 1233 shifted +82 (the R3-L4 test, inserted between the existing Ollama
  and non-Claude-family `reasoningEffort` tests inside the `tier variants`
  describe). Every citation from either doc landing at or after old line
  973 was individually relocated this way and spot-checked by reading the
  exact target span in the current file (not trusted on the shift formula
  alone), the same "verify every citation, do not assume a uniform offset"
  discipline the 2026-08-17 and both 2026-08-18 entries above established;
  one citation spanning both R3-L4-affected zones (the "three
  opencode-provider-branch outcomes" sentence in model-preselection.md,
  previously one contiguous `:1173-1253` range covering three tests now
  separated by the newly-inserted R3-L4 test) was split into three
  sub-citations with the new test's own outcome named explicitly between
  them, rather than left as a single range that would now silently also
  bound content the sentence never described. `README.md` and
  `CHANGELOG.md` citations in both primary docs needed no correction: the
  R3-L4 README edit landed inside the already-uncited opencode-effort
  prose span (lines 251-286, per the review-round-2 entry above, still
  uncited by line number here), and the CHANGELOG edit was deliberately
  kept to its original 3-line span for the reason stated above.

  `okf-kit check docs/okf --strict`: 0 warnings, 0 findings both
  immediately before this pass's edits (measured directly via `git stash` /
  `okf-kit check` / `git stash pop` against the review-round-2 commit,
  32e83f5, not assumed from the round-2 entry's own closing count) and
  after, for the same same-day-headroom reason the 2026-08-18 (R2) entry
  above documents: both docs' `timestamp:` frontmatter was bumped to
  `2026-08-19T23:59:00Z`, comfortably past every commit made today. Full
  suite 233/233 (231 baseline + 2 new: the R3-L1 profile-downgrade-notes
  test and the R3-L4 no-provider-prefix-id test), `tsc --noEmit` clean,
  `tsc --noEmit -p tsconfig.test.json` clean, `npm run build` clean,
  `npm run format:check` clean (the pre-existing `test/template-markers.test.ts`
  warning is unrelated and untouched, matching every prior pass's
  baseline; README.md/CHANGELOG.md are outside that script's glob, same as
  every prior pass, so their own formatting was left as found rather than
  reformatted wholesale). Mutation probes (named in the task assignment):
  covered in the R3-L1 paragraph above (the profile-downgrade ledger-gate
  mutant, 6 notes instead of 2, restored and re-verified green). No probe
  was named or run for R3-L2/R3-L3/R3-L4 beyond the R3-L4 behavioral test
  itself, since those three findings are comment/docs-only or a single
  additive assertion, not a fix with a named mutation target.
- 2026-08-20: re-verified and re-stamped review-gate-and-waivers.md,
  run-state-lifecycle-and-markers.md, subagent-contracts-superset.md, and
  model-preselection.md against package version 0.20.0, which added a
  tier-selection policy for the orchestrator (a new bullet in
  agents-md-section.md's Scaling delegation list plus one new sentence in
  each of SKILL.md's "Delegate implementation"/"Delegate review" steps, a
  new `describe` block in test/docs-consistency.test.ts, and one new
  CHANGELOG.md entry). Every `SKILL.md:`, `agents-md-section.md:`, and
  `CHANGELOG.md:` citation across the four docs (82 total) was checked
  directly against the current file content, not assumed from a computed
  offset, the same "check every citation" discipline this log has used
  since the 2026-08-19 (0.19.0 R3) entry above. `docs-consistency.test.ts`
  citations needed no correction: the new describe block is appended after
  the file's last existing line, so nothing above it shifted.
  `CHANGELOG.md` citations needed a flat +24 shift (the new 0.20.0 entry
  was prepended above the 0.19.0 entry, and every existing line below it
  moved down by exactly 24 with no other edits), verified by spot-checking
  several shifted citations' version-header lines against the actual file
  before applying the shift bundle-wide. `SKILL.md` and
  `agents-md-section.md` needed per-citation verification rather than a
  uniform shift, since a direct read surfaced two separate problems: (1)
  most citations in run-state-lifecycle-and-markers.md and
  subagent-contracts-superset.md were accurate at the pre-0.20.0 baseline
  and shifted cleanly (SKILL.md: flat +10 for any citation at or after old
  line 139, since the two edited step paragraphs sit in a single diff hunk
  spanning old lines 122-138; agents-md-section.md: flat +6 for any
  citation at or after old line 52, the insertion point of the new tier
  bullet); (2) two SKILL.md citations in subagent-contracts-superset.md
  (`:124-133`, `:129-131`) pointed inside the rewrapped step-6 paragraph
  itself and could not be shifted arithmetically, so they were remapped by
  content match instead (`:124-138` for the whole step-6 paragraph, now
  five lines longer; `:134-136` for the claim-only-what-was-measured
  clause). Direct verification also surfaced a **pre-existing** problem
  unrelated to this pass's own diff: every `agents-md-section.md:` citation
  in review-gate-and-waivers.md was already stale at the pre-0.20.0
  baseline (confirmed by reading the cited ranges against the 0.19.0 HEAD
  content directly, not the new file), off by inconsistent amounts rather
  than a uniform offset, most visibly the Waiver-rules bullets each citing
  a range 6-13 lines earlier than their actual bullet. All eight of that
  doc's `agents-md-section.md:` citations were corrected by direct
  content match against the 0.19.0 baseline first, then mapped forward
  through this pass's own +6 shift where the corrected old line fell at or
  after 52. Two of the eight corrections were caught only on a second full
  citation sweep after the first edit pass (an initial oversight: a
  citation for the "Deferring such a finding counts as a waiver" quote and
  one for the "waived by the operator... never waives a critical finding on
  its own" quote were each left unedited in the first pass despite being
  identified as needing correction), a reminder that a fix list assembled
  by hand needs its own verification pass, not just trust in the list.
  `install-fence-mechanics.md` and `index.md` carry no numeric citations
  into any of the four changed files and needed no content changes.
  `timestamp:` frontmatter bumped to `2026-08-20T23:59:00Z` on the four
  re-verified docs plus, in a second pass below, `install-fence-mechanics.md`
  (model-preselection.md's citation touched was a single flat +6 shift,
  `agents-md-section.md:104-110` -> `110-116`, itself verified against
  the current file, not computed blind).

  Correction (same-day review round 1 on this pass): the "82 total ...
  checked directly against the current file content" claim above should be
  read as 82 checked, not 82 verified correct — the review found two of
  them were checked but still left wrong. `run-state-lifecycle-and-
  markers.md:172`'s compound citation `SKILL.md:177-178,172-173` shifted
  only its first range; the second range, for the "Repos without a bundle
  are unaffected" quote, kept a stale value instead of this pass's own
  correct `182-183`. `:152`'s compound citation (`SKILL.md:18-22,
  103-107`) was a separate, pre-existing miss already stale before this
  pass and not caught by the "check every citation" work above; its
  correct value at this pass's baseline was `18-22, 108-112`. The same
  review round's compound-citation grep sweep (a pattern matching two
  comma-joined line numbers in one citation, run across every file in
  `docs/okf/`) also caught a third citation outside the 82's stated scope:
  `run-state-lifecycle-and-markers.md:26`'s `INSTALL-AGENT.md:47-48`, one
  line short of the actual `.ai/workflow/templates/00-goal.md` through
  `06-handoff.md` bullet, corrected to `:46-47`. All three were fixed in
  that round; because the round's own SKILL.md edits (one new
  Intent-paragraph sentence, two rewrapped step paragraphs) shifted lines
  again, every `SKILL.md:` citation across all four docs — not just these
  three — was re-verified a second time against the post-round file rather
  than assumed to still hold from the numbers recorded above.

  `okf-kit check docs/okf --strict`: 0 warnings, 0 findings on the
  pre-existing baseline (package version 0.19.0, before this pass's
  edits). After committing this pass's content edits (package version
  0.20.0) it was still 0/0. Running the mutation probes below (edit,
  measure, `git checkout --`) then touched `agents-md-section.md` and
  `src/models.ts`'s mtimes past their restore, which tripped a
  `sources-fresh` staleness warning on `install-fence-mechanics.md`
  (`agents-md-section.md` is one of its listed sources, mtime now newer
  than its own `timestamp:`) even though its content needed no edit;
  content-checked directly against the current `agents-md-section.md`
  (confirmed it only lists the file as a generic marker-fence-mechanics
  source, citing no lines this pass touched) and its `timestamp:` was
  bumped the same way as the other four docs, bringing the strict check
  back to 0/0. Full suite 238/238 (233 baseline + 5 new: the
  tier-selection-policy describe block in test/docs-consistency.test.ts),
  `tsc --noEmit` clean, `tsc --noEmit -p tsconfig.test.json` clean,
  `npm run build` clean, `npm run format:check` clean for every file this
  pass touched (the pre-existing `test/template-markers.test.ts` warning
  is unrelated and untouched, matching every prior pass's baseline;
  README.md/CHANGELOG.md are outside that script's glob, same as every
  prior pass). Mutation probes (named in the task assignment): (1)
  deleting the new tier-policy bullet from agents-md-section.md turned the
  new "states the orchestrator picks the tier..." assertion red, restored
  and re-verified green; (2) temporarily removing `xhigh` from
  `ROLE_TIERS.implementer` in `src/models.ts` turned the new "every tier
  suffix named in the policy prose exists in ROLE_TIERS.implementer"
  assertion red together with the pre-existing tier-data-invariant and
  README tier-table assertions in test/init.test.ts and
  test/docs-consistency.test.ts that also read `ROLE_TIERS.implementer`,
  restored and re-verified green (src/models.ts itself was never
  committed with the mutant in place).

- 2026-08-20: re-verified and re-stamped all five prose docs (index.md,
  model-preselection.md, subagent-contracts-superset.md,
  install-fence-mechanics.md, review-gate-and-waivers.md,
  run-state-lifecycle-and-markers.md) against package version 0.21.0: a
  fifth subagent role, `advisor`, escalation-only, read-only, `full`-profile
  only, default model `opus`, tiers `high`/`xhigh` (`DEFAULT_TIER` `high`).
  The core commit (agent-dx task T-001, `ROLES`/`READ_ONLY_ROLES`/
  `DEFAULT_MODELS`/`ROLE_TIERS`/`DEFAULT_TIER` in `src/models.ts`, the
  `assets/agents/advisor.md` prompt, and role-generic coverage additions in
  `test/init.test.ts`/`test/opencode.test.ts`) landed without any docs/okf
  update, repeating the 0.16.0/0.17.0/0.18.0 gap this log has flagged as a
  precedent each time; this pass (T-002, docs/policy/guards follow-up)
  closes it in the same commit as the remaining feature surface: `README.md`
  (role table, tier table, read-only posture, a new "Advisor (escalation)"
  paragraph and Role-profile-table row), `INSTALL-AGENT.md` (brace lists,
  `--models` example, manifest JSON example, read-only-posture sentences,
  manual-scaffold role loops), `assets/agents-md-section.md` (the per-role
  model bullet, and a new Scaling-delegation bullet naming the escalation
  triggers and the recommends-never-decides rule), and `assets/skill/SKILL.md`
  (a Roles-section bullet, the subagent input contract's `role:` enum, a new
  "Advisor output contract" block mirroring `advisor.md`'s own contract
  byte-for-byte, a step 8 sentence naming when the orchestrator may spawn
  it, and the harness notes' full-profile role enumeration).
  `test/docs-consistency.test.ts` gained one new `describe`
  ("advisor escalation policy ships in the AGENTS.md section and SKILL.md",
  appended at the file's end) pinning the `agents-md-section.md` escalation
  paragraph and the four `SKILL.md` additions, plus a narrower fix to the
  pre-existing misfire-rule model-correlation test: since the advisor now
  shares the reviewer's `opus` default, "the reviewer role, the one role
  whose default model differs from the other roles'" stopped being true;
  the prose (`SKILL.md`) and its test were both corrected to name the roles
  the claim still holds against (explorer, task-slicer, implementer) while
  keeping the historical observation (signal only ever seen for reviewer)
  intact, plus a new `DEFAULT_MODELS.advisor === DEFAULT_MODELS.reviewer`
  assertion grounding the "since 0.21.0 the advisor shares that model"
  half of the corrected sentence. `package.json` bumped to 0.21.0;
  `CHANGELOG.md` gained a new entry above 0.20.0 (50 lines).

  Every `SKILL.md:`, `agents-md-section.md:`, `README.md:`,
  `INSTALL-AGENT.md:`, `CHANGELOG.md:`, `src/models.ts:`,
  `test/docs-consistency.test.ts:`, and `test/init.test.ts:` citation across
  all six docs was checked directly against the current file content, the
  same "check every citation, do not assume a uniform offset" discipline
  every prior entry in this log has used, though several large uniform
  shifts did hold and were spot-checked before being trusted: `CHANGELOG.md`
  (+50, one hunk, the new 0.21.0 entry inserted above 0.20.0 with no other
  change in the file); `docs-consistency.test.ts` (+10 for any citation at
  or after old line 445, from this pass's own edit to the misfire-rule test
  pair; +102 for any citation at or after old line 1440, from the new
  advisor-policy `describe` appended at the file's end — both hunk
  boundaries confirmed via `git diff -U0` before trusting either shift,
  matching this log's established practice); `src/models.ts` (no uniform
  shift usable — `ROLES` moved 3-8 -> 8-14, `READ_ONLY_ROLES` 14-17 -> 22-26,
  `DEFAULT_MODELS` 70-75 -> 80-86, the tier-data block 146-199 -> 157-212,
  every citation individually relocated by anchor text); `test/init.test.ts`
  (T-001's own diff landed in 25 separate hunks scattered across the whole
  file, from a single `advisor: "opus"` line in three early model-mapping
  tests through the tier-variants `describe` block's many internal
  insertions; a cumulative-shift table was built hunk-by-hunk and every
  net-zero hunk's `new_start` was checked against `old_start + cumulative
  shift` as a self-consistency proof before trusting the table, then every
  citation actually used in `model-preselection.md`/`install-fence-
  mechanics.md` was additionally spot-checked by direct read, not trusted on
  the table alone — the tier-variants `describe`'s own internal boundaries
  (each `it`'s start/end line) were located by `grep -n "^  it("` rather
  than computed, since several sub-citations there needed splitting
  differently than the old ranges once the advisor-specific assertions
  (the 13->15 file-count test, the advisor-xhigh anti-downgrade check, the
  note-count changes) were accounted for). `SKILL.md` and
  `agents-md-section.md` shifts were computed from `git diff -U0` hunk
  headers the same way, each net-zero hunk's `new_start` checked against
  the running cumulative shift before trusting it for the surrounding span.

  Content, not just citations, changed in both role-specific docs:
  subagent-contracts-superset.md's "Four roles, two postures" section
  became "Five roles, two postures" (the advisor's escalation-only,
  full-profile-only character stated explicitly), its contract-location
  list gained an Advisor entry noting the pair has no dedicated
  byte-for-byte drift guard yet (the same honest gap the explorer pair
  already had, not a new regression), and its Subagent-misfire-rule section
  gained a paragraph on the 0.21.0 model-correlation-claim correction
  described above. model-preselection.md's "What gets preselected" section,
  its defaults table, its "Which tiers each role gets" tier-data paragraph,
  and its "Rendering" paragraph (4 base files + 9 variants = 13 total,
  now 5 + 10 = 15) all gained advisor rows/clauses; its "Docs-consistency
  pins" section notes the guard proved itself for real — every enumeration
  site failed red on the advisor addition until each listed doc was
  updated. install-fence-mechanics.md's profile bullet notes `rolesForProfile`
  itself needed no code change (`MINIMAL_PROFILE_ROLES` simply never named
  advisor, the same way it never named explorer/task-slicer), its downgrade-
  note paragraph states `droppedRoles` (`init.ts:371-373`) is computed
  generically from the two profiles' resolved role sets rather than a
  hardcoded pair, so a `full` -> `minimal` downgrade with advisor installed
  now also names `advisor.md` (and, with tiers on, `advisor-xhigh.md`) with
  no code change of its own, and its "Tests" bullet's file-count and
  note-count figures were updated throughout (6 -> 8 notes for the
  base-plus-tiers downgrade case, 13 -> 15 total agent files). One gap
  flagged rather than closed, per this log's "declare what was and was not
  verified" precedent (2026-08-17/18/19 entries above): install-fence-
  mechanics.md's "the real .claude variant leftovers are named" sentence
  (the R2-M2 harness-switch test) does not claim whether an
  `advisor-xhigh.md` leftover note is now also present, since that specific
  test's own assertions never enumerated an exact total count or advisor's
  variant path either before or after this pass — not re-verified here,
  explicitly out of this pass's scope rather than silently assumed
  unaffected. review-gate-and-waivers.md and run-state-lifecycle-and-
  markers.md needed citation corrections only (their content describes the
  review gate and run-state markers, neither of which the advisor addition
  touches); every `SKILL.md:`/`agents-md-section.md:`/`CHANGELOG.md:`
  citation in both was individually re-derived and, where a phrase spanned
  a boundary between differently-shifted zones, verified by direct read
  rather than by applying either zone's shift blindly.

  A temp-install check (`orchestrator-workflow init --yes --harness claude
  --profile full --tiers --models "...,advisor=opus"` against a scratch
  git-initialized target, cleaned up after) confirmed the acceptance
  criteria directly rather than by reading test assertions alone: exactly
  15 files under `.claude/agents/` (`advisor.md`, `advisor-xhigh.md`, plus
  the 4 other roles' base-plus-variant sets), the generated `AGENTS.md`'s
  fenced section contains the escalation paragraph
  ("an advisor subagent is available for escalation only"), and the
  generated `.claude/skills/orchestrator-workflow/SKILL.md` contains the
  `## Advisor output contract` heading.

  `okf-kit check docs/okf --strict`: 0 warnings, 0 findings both before this
  pass's edits (working-tree-only, uncommitted) and after, for the same
  mechanical reason the 2026-08-19 (0.19.0 R2) entry above documents: every
  re-verified doc's `timestamp:` frontmatter already carried same-day
  headroom (`2026-08-20T23:59:00Z`, inherited from the prior 0.20.0 pass)
  comfortably past any commit made today, so the mtime-based `sources-fresh`
  gate cannot fire against a same-day commit regardless of whether the
  doc's own prose was re-verified — the checker's known date-granularity
  limit, not a false negative; the doc content itself was independently
  re-verified by the direct-read citation discipline described above, not
  by trusting the checker's clean report alone. Full suite 247/247 (241
  baseline + 6 new: one new `describe` in `test/docs-consistency.test.ts`
  for the advisor escalation policy, the two misfire-rule tests reused
  rather than added to), `tsc --noEmit` clean, `tsc --noEmit -p
  tsconfig.test.json` clean, `npm run build` clean, `npm run format:check`
  clean for every file this pass touched (the pre-existing
  `test/template-markers.test.ts` warning is unrelated and untouched,
  matching every prior pass's baseline; `README.md`/`CHANGELOG.md` are
  outside that script's glob, same as every prior pass). Mutation probes
  (named in the task assignment): (1) deleting the new escalation paragraph
  from `agents-md-section.md` turned exactly the new "names the advisor's
  escalation triggers" assertion red (126/127 tests in
  `docs-consistency.test.ts`), restored and re-verified green (127/127,
  byte-identical diff against the pre-mutant file); (2) temporarily removing
  `advisor` from `ROLES` in `src/models.ts` turned exactly the four
  enumeration tests red that the collateral was expected to hit (the
  README/INSTALL-AGENT.md/agents-md-section.md role-list guards plus the
  README tier-table row-count check), restored and re-verified green
  (byte-identical diff against the pre-mutant file, full suite 247/247).
  Both mutants were applied and restored with the working tree committed
  first, per this repo's commit-before-mutation-probe convention, and both
  restores were verified byte-identical via direct diff against the
  pre-mutant, post-commit file.
- 2026-08-20 (review round 1, 7 findings: H1, M1-M4, L1-L3): re-verified and
  re-stamped `subagent-contracts-superset.md` against the round's changes to
  `assets/agents-md-section.md`, `assets/skill/SKILL.md`,
  `assets/agents/advisor.md`, `src/cli.ts`, `test/docs-consistency.test.ts`,
  `test/init.test.ts`, and `CHANGELOG.md`, plus one targeted citation in
  `install-fence-mechanics.md`. Content-level corrections (not just line
  shifts): the "explorer and advisor pairs still have no dedicated automated
  drift guard" claim was false the moment M2 shipped a byte-for-byte
  equality test for the advisor contract (the same pattern the reviewer's
  `reproduction` and implementer's `mutation_probes` fields already had);
  reworded to "four of the five pairs" with the advisor's guard dated to
  this round, and the "field-identical" claim for the advisor pair extended
  to name the `escalation_necessary: warranted | unwarranted` correction
  (M4, replacing a bare `yes | no` YAML-1.1-boolean-synonym enum). The
  model-correlation paragraph (misfire rule) was extended to describe L2
  (the differing-model role list is now derived from `DEFAULT_MODELS` via
  `ROLES.filter((role) => DEFAULT_MODELS[role] !== DEFAULT_MODELS.reviewer)`
  rather than hardcoded) and L3 (the advisor's zero-observation parenthetical
  reworded from "the signal itself has never been observed for the advisor"
  — which reads like negative evidence against the correlation — to "the
  advisor has had no spawns yet, so it contributes no evidence either way").
  Every citation into `SKILL.md`, `docs-consistency.test.ts`, and
  `CHANGELOG.md` inside `subagent-contracts-superset.md` was individually
  re-derived via `git diff -U0`'s hunk headers (cumulative-shift bookkeeping,
  same method as the 0.21.0 entry above) and spot-checked by direct read at
  every hunk boundary and every citation actually used, not trusted on the
  arithmetic alone; none of this round's content changes touched
  `model-preselection.md`, `run-state-lifecycle-and-markers.md`, or
  `review-gate-and-waivers.md`'s subject matter (tier-variant rendering,
  run-state markers, review-gate severities respectively), so those three
  were left unstamped this round.

  Declared gap, not silently assumed unaffected: `install-fence-mechanics.md`
  and `model-preselection.md` carry roughly 50 additional `cli.ts`/
  `init.test.ts` line citations (tier-variant rendering, harness/model
  mapping, profile-downgrade notes) that also shifted by this round's small
  `cli.ts` (`promptProfile`, +5 lines from old line 78 on) and
  `test/init.test.ts` (+1 from old line 23, +4 from old line 377, +32 from
  old line 405) edits. None of that content describes what this round
  actually changed (M1's label derivation, M2's tripwire/pin additions) —
  the underlying mechanics they document are untouched — so a mechanical
  55-citation re-stamp of those two docs was scoped out of this pass rather
  than risk transcription errors at that volume for peripheral-content
  citations; the one citation in `install-fence-mechanics.md` that *does*
  describe this round's own change (the Bash-guard tripwire test) was
  re-derived and content-updated. Follow-up: a full mechanical re-stamp of
  the remaining `cli.ts`/`init.test.ts` citations in both docs.

  `okf-kit check docs/okf --strict`: 0 warnings, 0 findings both before this
  pass's edits (working-tree-only, uncommitted) and after — re-verified by
  direct read per the citation discipline above, not by trusting the
  checker's clean report alone (same known date-granularity limit on the
  `sources-fresh` gate the 0.21.0 entry above documents). CHANGELOG.md's
  0.21.0 entry numbers were also corrected this round (M3): the test-suite
  arithmetic actually measured 238 baseline + 9 new = 247 (6 tests in the
  advisor-escalation-policy `describe` block, 1 from the pre-existing
  instruction-trust-boundary loop picking up `agents/advisor.md`, 2 from the
  pre-existing README tier-table loop picking up the advisor row), not the
  previously stated 241 + 6; verified by running the full suite at commit
  60d15b8 (pre-advisor, 0.20.0) in a separate worktree (238/238) against the
  current suite (247/247 before this round's own new tests, 255/255 after).

- 2026-08-20: re-verified and re-stamped model-preselection.md and
  install-fence-mechanics.md against 0.22.0 (agent-dx task T-001, pinned
  default effort): every unsuffixed default agent file now carries
  `TIER_DEFS[DEFAULT_TIER[role]].effort` unconditionally (`effort: medium`
  for explorer/task-slicer/implementer, `effort: high` for reviewer/advisor
  on Claude Code; the matching `variant:`/`reasoningEffort:` dispatch on
  opencode, via `opencodeEffortLine`, renamed from `opencodeVariantEffortLine`
  since it is no longer variant-only), so a default spawn no longer silently
  inherits the orchestrator session's own effort. Both docs previously
  stated the opposite as a load-bearing invariant: the pre-0.19.0-manifest
  legacy-frontmatter test was cited as "four-line frontmatter with no
  `effort:`", and the tiers=true anti-downgrade check was cited as
  `reviewer.md`/`advisor.md` staying `opus` "with no `effort:` line", both
  now false, corrected in place (five-line frontmatter with `effort: medium`
  pinned; `effort: high` pinned on the anti-downgrade check). Both docs also
  gained a new "Pinned default effort (0.22.0)" subsection under "Effort
  tiers" (model-preselection.md) and a corresponding paragraph in "What
  `init` writes" (install-fence-mechanics.md) stating the rule is
  unconditional, not gated on `--tiers`, the same "not framed as tiers-gated"
  requirement `assets/agents-md-section.md`'s own new bullet and the
  docs-consistency test guarding it enforce in the installed prose.

  Every `init.ts:` citation touching a function this task's diff changed
  (`composeClaudeAgent`, `composeOpencodeAgent`, `opencodeEffortLine`,
  `composeClaudeAgentVariant`, `isClaudeFamilyModel`,
  `composeOpencodeAgentVariant`, the claude/opencode default- and
  tier-rendering blocks inside `runInit`, the manifest-write block) was
  re-derived from a direct read of the current file at that exact location,
  not a computed offset applied blindly, the discipline every entry above
  uses: `runInit` itself moved from old line 330 to 358 (the new JSDoc
  comments on the composer functions above it account for the shift), and
  every citation into or after it was re-checked individually rather than
  assumed to share one uniform delta. `test/init.test.ts` citations inside
  and after the `describe("tier variants (\`--tiers\`)")` block needed the
  same per-anchor treatment: two new tests were inserted inside that block
  (the byte-identity-across-tiers test after the legacy-manifest test, and
  the opencode default-file effort test after the collision-free-file-set
  test), so every citation from that point through the CLI-smoke describe
  at the file's end was re-derived by grepping each test's own title text in
  the current file rather than shifted by a guessed delta; the two
  citations for tests fully inside the untouched nested
  `describe("CLI --tiers override-vs-persist")` block were left as a single
  outer-range citation rather than re-derived per-test, since none of that
  nested block's own content changed and re-deriving five more exact
  sub-ranges for unchanged content was judged out of this pass's proportion
  (recorded here as a deliberate scope cut, not an oversight). Citations
  into `cli.ts`, `models.ts`, `README.md`'s non-effort-tiers sections, and
  the three docs this task's diff never touches
  (review-gate-and-waivers.md, run-state-lifecycle-and-markers.md,
  subagent-contracts-superset.md) were spot-checked (grepped for
  `opencodeVariantEffortLine`/`composeClaudeAgent`/`composeOpencodeAgent`
  and for stale "no effort:" phrasing) and confirmed unaffected; none of
  the three peripheral docs mention any of those symbols.

  `README.md` gained a new "Every default file carries its own pinned
  effort, independent of `--tiers`" paragraph in its "Effort tiers" section
  (the previous "no `effort:` key" claim about the default file was also
  corrected there); `INSTALL-AGENT.md`'s manual-fallback step 4 gained the
  matching byte-precise placement rule for Claude Code (`effort:` line
  directly after `model:`, before `disallowedTools:`) and a pointer note
  for opencode (the same family-based dispatch tier variants already used,
  keyed by the role's own default tier instead of a suffix tier).
  `assets/agents-md-section.md`'s Scaling delegation bullet list and
  `assets/skill/SKILL.md` step 6 both gained prose stating the same rule,
  guarded by a new, derivation-based `test/docs-consistency.test.ts`
  `describe` (not a hand-maintained role list, parses the prose's
  medium/high role split and checks it against
  `ROLES.filter((role) => TIER_DEFS[DEFAULT_TIER[role]].effort === ...)`
  directly, plus a positional check that the new bullet sits strictly
  outside the pre-existing tiers-gated bullet's own span), the task's own
  instruction named this discipline explicitly, citing 0.21.0's
  hand-mapped-guard lesson (a mutant proving a hand-maintained map missed a
  wrong role name) as the reason.

  Mutation-tested for real, one change at a time, each reverted and
  restored to the byte-identical pre-mutant state (verified by re-reading
  the file, not assumed) before moving to the next: deleting the new
  `` `effort: ${TIER_DEFS[DEFAULT_TIER[role]].effort}` `` line from
  `composeClaudeAgent` turned the legacy-manifest frontmatter-shape test red
  (1 test); reverting `agents-md-section.md`'s new pinned-default-effort
  bullet to the pre-change wording (deleting the bullet entirely) turned
  all 3 tests in the new "pinned-default-effort policy ships..." `describe`
  red (the role-split derivation check, the not-gated-on-tiers phrase
  check, and the outside-the-tiers-gated-bullet positional check). Full
  suite 261/261 (255 baseline + 2 new tests in the `tier variants` describe
  block + 4 new tests in the new docs-consistency `describe`, net +6:
  the arithmetic reconciles as 255 + 2 + 4 = 261), `tsc --noEmit` clean,
  `tsc --noEmit -p tsconfig.test.json` clean, `npm run build` clean,
  `prettier --check` clean for every file this pass touched (the
  pre-existing `test/template-markers.test.ts` warning is unrelated and
  untouched, matching every prior pass's baseline).

  `okf-kit check docs/okf --strict`: 0 warnings, 0 findings both before and
  after this pass's edits, working-tree-only and uncommitted at measurement
  time, per the mechanical reason the 0.19.0 fix-round-2 entry above
  documents (the `sources-fresh` gate keys staleness off each source's last
  *commit* time, not filesystem mtime, so an uncommitted working-tree edit
  cannot move the needle regardless of whether the doc's own prose was
  actually re-verified), this 0/0 result is reported as expected-and-
  uninformative given the measurement conditions, not as evidence the
  content re-verification above was unnecessary or already satisfied.
  review-gate-and-waivers.md, run-state-lifecycle-and-markers.md, and
  subagent-contracts-superset.md were left un-re-stamped: this task's diff
  touches `CHANGELOG.md`, `assets/agents-md-section.md`, and
  `test/docs-consistency.test.ts`, which all three list as `sources:`, but
  none of their own subject matter (review gate, run-state lifecycle,
  subagent contracts) is affected by the pinned-default-effort change
  content-wise, confirmed by grepping all three for the changed symbols and
  finding no hits; per the 0.14.0/0.17.0/0.18.0 precedent above, a source
  whose own cited content did not move is left un-re-stamped rather than
  re-stamped on churn alone. Not fixed here, per this task's own boundary:
  once these three docs are next touched for their own subject matter, a
  full commit-time `okf-kit check` re-run (not the working-tree-only
  measurement this pass could honestly report) should be taken to confirm
  whether the `sources-fresh` gate actually fires against them at that
  point.
- 2026-08-20 (fix round, agent-dx task T-001-fix1, review findings F1-F10):
  corrects a factual gap left by the 2026-08-20 T-001 entry above. That
  entry's own claim ("every citation into or after it was re-checked
  individually rather than assumed to share one uniform delta") was not
  actually true for `model-preselection.md`: a subsequent review pass found
  eleven `init.ts:` citation sites in that doc still pointing at stale line
  ranges left over from before the 0.22.0 diff shifted the file, including
  two that pointed at the wrong block entirely rather than merely a shifted
  one (the "tiers: true -> false" leftover-note claim cited a line range that
  was actually the *full -> minimal* downgrade's own base-file note, not the
  tiers-off block; the "full -> minimal downgrade also notes tier-variant
  files" claim cited the top of that downgrade's `if`-block, not its own
  tier-variant sub-loop), and one internal self-contradiction (the "Flow"
  section's own compose-variant-pair citation read stale numbers while the
  "Composition" section a few lines below it, describing the same two
  functions, already cited the correct ones). This same fix round also added
  a short JSDoc half-sentence to `composeClaudeAgent` (finding F10, resolving
  a separate JSDoc contradiction, no logic change), which shifted every line
  at or after `init.ts:199` down by 5; every citation below was re-derived
  from a direct read of the file *after* that edit, not from the doc's own
  arithmetic on the pre-F10 file, so the numbers below are the final,
  post-this-round values. All eleven sites were corrected: the manifest-write
  block (was `:541-579`/`:543-551`, now `:578-616`/`:580-588`), the
  compose*Agent pair (was `:189-225`, now `:189-254`), the claude/opencode
  invocation sites (was `:473-477`/`:497-505`, now `:507-510`/`:539-542`),
  the compose*AgentVariant pair (was `:240-255`/`:305-328`, now
  `:269-284`/`:338-361`, resolving the self-contradiction above), the
  `composeOpencodeAgent` comment (was `:235-236`, now `:241-242`), the codex
  block (was `:491-493`, now `:524-526`), the two `DEFAULT_TIER`-continue
  guards (was `:480`/`:508`, now `:513`/`:545`), the two mislabeled
  leftover-note citations described above (was `:409-425`, now `:442-458`;
  was `:384-398`, now `:417-432`), the matching approximate citation for the
  same tier-variant sub-loop (was `~393`, now `~423`), and the
  `installKitFile` citation (was `:432-449`, now `:460-482`). No other
  `init.ts:` citation in the file needed correction; each was independently
  re-verified against the post-F10 file regardless. This entry exists so the
  audit trail records the gap honestly rather than silently rewriting the
  prior entry's claim: the fix, not just the doc content, is logged.

- 2026-08-24 (agent-tasks 1d6e0b3e, okf-kit 0.5.0 rollout): ran the new
  citations-resolve rule (okf-kit 0.5.0, PR #111) against this bundle for
  the first time. Fix-round-1 silenced the rule's own warnings with a blind
  `+1`-style shift on every flagged citation instead of checking each one
  against the real symbol/heading/quote it was meant to point at; review
  found roughly half of the "fixed" citations landed on the wrong content
  even though the mechanical rule (no symbol/AST resolution, see
  citations-resolve's own doc comment) could not detect that, plus two
  historical `05-review-findings.md`/`models.ts` citations in this log
  renumbered instead of left alone, two ranges collapsed to a single line,
  and the doc-touch itself silently suppressing two real pre-existing
  `sources-fresh` STALE warnings against `INSTALL-AGENT.md` via
  `sources-fresh`'s doc-committed-at/after-source override (a `git log`
  timestamp effect, not a frontmatter one — touching a doc file at all
  updates its own last-commit time, regardless of what the edit is).
  Fix-round-2 re-derived every round-1-touched citation from a direct read
  of the actual current source (`src/init.ts`/`src/cli.ts`/`SKILL.md`/
  `CHANGELOG.md`/`test/*.test.ts` did not change between the base commit and
  fix-round-1, so "true" meant finding where the cited symbol/heading/quote
  really lives today, not deriving an offset), restored the two historical
  values this log had falsified, and genuinely re-verified
  install-fence-mechanics.md and model-preselection.md against the current
  `INSTALL-AGENT.md` (one drifted citation each, both corrected; both docs'
  `timestamp:` bumped only after that direct-read check, not merely because
  the file was touched). Full per-citation detail in the agent-dx repo's
  commit for agent-tasks 1d6e0b3e rather than repeated here. Convention
  note: historical bare line numbers in this log (like the `27`/`23-25`
  forms two paragraphs above and the `models.ts` reference just above) are
  deliberately written without the leading colon/`path:N` adjacency so
  `citations-resolve` does not treat past narrative about a since-corrected
  citation as a live pointer into the current source. okf-staleness.yml's
  pin was bumped to okf-kit 0.5.0 in the fix-round-1 change.
- 2026-08-24: re-verified and re-stamped review-gate-and-waivers.md,
  run-state-lifecycle-and-markers.md, subagent-contracts-superset.md, and
  model-preselection.md against package version 0.22.0+ (Unreleased; the
  implementer-low tier-rule tightening, operator decision after Tier-A/B
  measurement, agent-tasks task 7f38899d): agents-md-section.md's Scaling
  delegation bullet and SKILL.md step 6 both grew, since `-low` is no
  longer discretionary for the implementer but a checkable gate on the
  task contract. This entry's own claim above, that every citation was
  re-derived from a direct read rather than a blind offset shift, was
  false: a fix-round review found the rule text itself invented two
  contract field names, `mutation_probes` and `verification_commands`, that
  the kit's subagent input contract does not define (the input contract
  carries `acceptance_criteria`; `mutation_probes` is an implementer-OUTPUT
  field, and `verification_commands` exists nowhere in the kit's
  contracts), and found the citation fix had in fact been a blind +8-line
  shift rather than a genuine re-derivation, still wrong in 44 changed
  lines across the four docs (examples: review-gate-and-waivers.md's
  `SKILL.md:315` for the reviewer severity field, true `317`;
  subagent-contracts-superset.md's five output-contract-block ranges, each
  missing its own closing fence line, e.g. the explorer block's true end
  is `248`, not `245`). The fix round reworded the rule to cite only
  vocabulary the kit's contracts actually define (an acceptance criterion
  demanding a test/typecheck/lint/build run, the task assignment naming
  mutation probes to run, or the task slicer's `suggested_tests` coming
  back non-empty), added a `docs-consistency.test.ts` pin that derives that
  vocabulary from the Subagent input and Task slicer output contract
  blocks directly instead of hand-listing it, and re-derived every
  `agents-md-section.md:`/`SKILL.md:`/`docs-consistency.test.ts:` citation
  in the four docs from a direct read of the current files. The pass also
  found subagent-contracts-superset.md's two advisor-pair
  `docs-consistency.test.ts` citations, and model-preselection.md's
  matching citation to the pinned-default-effort test, had drifted onto
  the wrong `describe` block boundaries (the advisor-escalation-policy and
  advisor-byte-identical blocks moved when an earlier fix-round inserted
  lines above them); all three were corrected against the current test
  file. One citation, `SKILL.md:453-455` on the pre-0.21.0
  model-correlation clause explicitly marked historical, had been wrongly
  shifted by the earlier blind offset even though it documents a past
  state rather than the live file; it was restored to its true historical
  value (`440-442`, confirmed against `origin/master`) instead of being
  re-derived against current content. `model-preselection.md`'s
  `timestamp:` was left at its already-current value: its timestamp already
  read the current date, so no restamp was needed; two citations in it were
  corrected. `npx okf-kit@0.5.0 check` on this bundle after the fix
  round: 0 errors, 0 warnings (the remaining 21 notices are the pre-existing
  bare-filename ambiguity in this log's own historical narrative, per the
  convention below). log.md's own historical entries (the
  `agents-md-section.md:104-110 -> 110-116` and `SKILL.md:177-178,172-173`
  narrative lines above) were left untouched per the convention noted
  above: they record a past pass's before/after values, not live pointers
  into the current source.
- 2026-08-24: fix-round-2 review found the round-1 derivation pin above
  still checked only two hand-picked names (`acceptance_criteria` present,
  a literal ban on `verification_commands`), so a mutant rewording the gate
  to cite a different invented field (`verification_steps`) stayed green
  despite the "derives" language this log used to describe it (HIGH). The
  pin now regex-extracts every backtick-quoted snake_case identifier out of
  two narrow slices, the implementer tier-gate sentence(s) in
  agents-md-section.md and its counterpart in SKILL.md step 6, and asserts
  each one is a field the Subagent input contract or the Task slicer output
  contract actually defines; the old whole-block/whole-doc
  `not.toContain("mutation_probes"/"verification_commands")` assertions were
  dropped as superseded by that membership check, and the old-wording
  negative pin was narrowed to the same two slices so it no longer forces
  the unrelated explorer/task-slicer sentence's wording (MEDIUM-2, LOW-4).
  The gate's "checkable criterion, not a judgment call" framing was softened
  to "checkable against the task contract rather than a judgment about how
  hard the task looks" and a fail-safe tie-break ("when it is unclear
  whether a criterion demands a run, exclude `implementer-low`") was added
  to agents-md-section.md, SKILL.md step 6, and the CHANGELOG (MEDIUM-1).
  The A/B-anchor sentence now names what was actually compared
  ("implementer-low as installed (Haiku 4.5) against the default
  implementer (Sonnet 5, effort medium)") in agents-md-section.md and the
  CHANGELOG (RESIDUAL), and the dangling-antecedent parenthetical after
  "does not support the `effort` parameter" was replaced with "per
  Anthropic's model reference", "was inert" precised to "the harness
  ignores the pinned `effort: low` on that model" (LOW-3). These wording
  edits added net lines to agents-md-section.md (+4) and SKILL.md (+1,
  step 6 only) and restructured test/docs-consistency.test.ts (two new
  module-level helpers plus the rewritten pin, net +69 from the insertion
  point onward); every `agents-md-section.md:`/`SKILL.md:`/
  `docs-consistency.test.ts:` citation in this bundle's four sibling docs
  past each insertion point was re-derived from a direct read of the
  current files rather than by offset math alone (each corrected value was
  independently confirmed against the actual file content before being
  written). Also LOW-2:
  subagent-contracts-superset.md's task-slicer-scope-boundaries citation
  was off by ten lines pre-existing (`729-733`, the real `it()` block was
  at `739-743` before this round's shift, confirmed by direct read); now
  `765-769` after the shift. `npx okf-kit@0.5.0 check` on this bundle after
  the fix round: 0 errors, 0 warnings, 21 notices (same pre-existing
  bare-filename ambiguities as above). Note: this pass surfaced several
  pre-existing citation/content mismatches unrelated to this fix's scope
  (for example review-gate-and-waivers.md's and
  run-state-lifecycle-and-markers.md's several `CHANGELOG.md:` citations,
  and model-preselection.md's two `:1187-1252`/`:1254-1312`-style
  shorthand citations, each pointing at content from a different entry
  than the one described), left as pre-existing and out of this
  narrowly-scoped fix round at the time; re-derived in fix round 3 instead
  of left as pre-existing (see the fix-round-3 entry below).
- 2026-08-24: fix-round-3 review found 0 high, 3 medium, 7 low findings
  (16 mutants total). MEDIUM-3: added test pins for two round-2 wording
  additions that had shipped unpinned, the softened gate framing
  ("checkable against the task contract rather than a judgment about how
  hard the task looks", pinned against agents-md-section.md's own gate
  slice) and the fail-safe tie-break sentence ("when it is unclear whether
  a criterion demands a run, exclude `implementer-low`", pinned against
  both agents-md-section.md's gate slice and SKILL.md step 6's wider
  slice, since the tie-break sentence sits inside SKILL.md's step-6 slice
  but outside its narrower implementer-gate sub-slice). LOW-3: added a
  per-doc pin on the A/B measurement's three headline numbers (`median
  320 seconds slower`, `p=0.016`, `9 high-plus-critical`) in both
  agents-md-section.md and SKILL.md, each as three separate substring
  assertions rather than one exact phrase, since the two docs word the
  parenthetical differently (comma-separated in SKILL.md, parenthetical in
  agents-md-section.md and the CHANGELOG). MEDIUM-2/LOW-4: the
  agents-md-section.md gate slice's endPhrase was narrowed from the tier
  bullet's own "use the default." close to the gate's own tie-break close,
  "exclude `implementer-low`." (confirmed `suggested_tests` still falls
  inside the narrowed slice); a mutant reverting only the unrelated
  explorer/task-slicer sentence to its old wording ("a `-low` variant fits
  mechanical, narrowly scoped tasks") now measurably stays green (M9), so
  the round-2 log entry's claim that this scoping had already landed is
  now true and was left as written rather than corrected. LOW-1: the three
  `phraseBoundedSlice` calls that used to run as `const`s in the describe
  body (so a phrase-drift `expect()` failure there collapsed the whole
  file's test collection, not just the tests that touch the slice) were
  converted to memoized getter functions called from inside each `it`;
  verified for real by mutating "For the implementer specifically" to "For
  an implementer specifically" and rerunning the suite: 4 named tests
  failed with "Tests 4 failed | 146 passed", no suite-collection error,
  against the pre-fix behavior of a full-file collapse (mutant restored
  and reverified green afterward, both before and after the later prettier
  pass). LOW-2 was attempted and reverted: the proposed regex
  (`/^ {0,2}<id>:/m` per contract block) breaks on `suggested_tests`, which
  sits at 4-space indent under `tasks: - id: T-001` in the Task slicer
  output contract block, not 0-2; making the membership check indent-aware
  would need a per-field indent table with no clear source of truth, so
  the existing whole-block-substring check was left in place instead
  (documented here rather than in a doc comment, since no doc-adjacent
  change resulted). LOW-6/LOW-9: the CHANGELOG `[Unreleased]` entry's "so
  its pinned `effort: low` was inert" was changed to "so the harness
  ignores the pinned `effort: low` on that model" to mirror
  agents-md-section.md's already-corrected wording from fix round 2; both
  the CHANGELOG bullet and agents-md-section.md's tier bullet were
  re-flowed to the surrounding column width (the CHANGELOG bullet had two
  stray short lines, 44 and 39 characters, mid-paragraph; the
  agents-md-section.md bullet had one, 26 characters) with no wording
  change beyond the one substitution. LOW-5/LOW-8: closed the unclosed
  parenthesis in this log's own fix-round-2 closing note (the "for example
  ... shorthand citations" clause had never closed its opening "("); MED-1:
  all 16 `CHANGELOG.md:` citations found across
  review-gate-and-waivers.md (5), run-state-lifecycle-and-markers.md (6),
  and subagent-contracts-superset.md (5) were re-derived by direct read
  against the current CHANGELOG.md (the reviewer's count was 14; this pass
  found 16 distinct citation sites, all wrong, and fixed all 16 rather than
  reconciling the count). Two topics are each cited from two docs with the
  same corrected value (the 0.7.3 header-already-correct citation and the
  0.7.4 example-row-narrowing citation), confirmed independently against
  CHANGELOG.md both times. Every `docs-consistency.test.ts:` citation this
  round's own test-file edits displaced was then re-derived by direct
  read, in two passes: first after the MEDIUM-3/LOW-1 test edits (a net
  +82-line insertion inside the "tier-selection policy" describe, shifting
  `pinned-default-effort`/`advisor escalation`/`advisor output contract`
  and both README-table describes below the insertion point), then again
  after this round's own `npx prettier --write` pass on the test file
  additionally collapsed two long single-argument `.indexOf(...)` calls
  (one pre-existing, at the top of the file before any of this round's
  edits, one inside this round's own new code) into single lines, a net
  -4 shift compounding the first pass's numbers; a uniform -2 held for
  every fully qualified `docs-consistency.test.ts:` citation between the
  first collapse and the second, verified by direct read; the 27 short-form
  citations without a file name (bare parenthesised ranges and `:NNN-NNN`
  forms in subagent-contracts-superset.md and run-state-lifecycle-and-
  markers.md) were NOT re-derived in this round and were corrected in the
  round-4 follow-up below. This second pass also caught and fixed a stale live-pointer
  citation naming test lines `641-653` in this log's own fix-round-1 entry
  above (a leftover from an earlier round, unrelated to this round's edits
  until the prettier shift broke it), corrected to the docs-consistency
  test file's current `822-836`; `npx okf-kit@0.5.0 check` flagged this one
  as a `closing-brace-start-line` warning before the fix, 0 errors/0
  warnings/21 notices after. Mutation probes (all applied on a working-tree
  copy, restored and reverified after each): M2 (`verification_commands`
  cited instead of the correct vocabulary) 2 failed/148 passed; M3
  (`mutation_probes`/`verification_steps` cited) 2 failed/148 passed; M5
  (see LOW-1 above) 4 failed/146 passed, no suite collapse; M9 (only the
  explorer/task-slicer sentence reverted) 150/150 green; M10 (tie-break
  sentence removed from agents-md-section.md) 4 failed/146 passed; M11
  (tie-break sentence removed from SKILL.md step 6) 1 failed/149 passed;
  M12 (gate framing reverted to "checkable criterion, not a judgment
  call") 1 failed/149 passed; M14 (agents-md-section.md's `9
  high-plus-critical` changed to `5`) 1 failed/149 passed; M15 (SKILL.md's
  `median 320 seconds slower` changed to `220`) 1 failed/149 passed. Full
  suite after the fix round: 275/275 (271 baseline + 4 new pins:
  checkable-framing, tie-break-in-both-docs, and one A/B-numbers pin per
  doc), `tsc --noEmit` and `tsc --noEmit -p tsconfig.test.json` both exit
  0, `prettier --check` clean for `test/docs-consistency.test.ts`
  (`test/template-markers.test.ts` left dirty, pre-existing and out of
  scope per the fix-round-3 assignment), `npx okf-kit@0.5.0 check`: 0
  errors, 0 warnings, 21 notices (same pre-existing bare-filename
  ambiguities as every prior pass in this log).

## 2026-08-24 (round 4 follow-up, orchestrator, after review round 4)

- Review round 4 (reviewer, opus high) confirmed every round-3 finding
  closed (10 mutants re-run, 68 citations read) and found one regression
  from round 3: the `prettier --write` pass shortened
  `test/docs-consistency.test.ts` by 2 lines and the 27 short-form
  citations (22 in subagent-contracts-superset.md, 5 in
  run-state-lifecycle-and-markers.md) had not been re-derived. All 27 were
  corrected by a uniform -2 against the reviewer's per-citation target
  list, spot-checked by direct read (each start line is an `it(` head,
  each end line its closing `});`). Also corrected: model-preselection.md
  `:1117-1174` -> `:1151-1208` (the 0.19.0 guard describe, pre-existing
  drift widened by this change), run-state-lifecycle-and-markers.md's own
  citation into `CHANGELOG.md` (numbered 568-570 -> 568-573 at the time,
  covering the hex-guard and date-heuristic clause; both numbers have
  since drifted off that content repeatedly as later rounds' own
  CHANGELOG entries pushed it down -- corrected 2026-08-26 to
  a heading-anchored line-range citation of the `## [0.9.0]` section
  (review round 4, D30/LOW-c: given the heading anchor its sibling at
  `run-state-lifecycle-and-markers.md:55` already carried, matching it
  here too rather than a bare line range, so a future CHANGELOG insertion
  above `## [0.9.0]` would fail the citation on `anchor-heading-mismatch`
  instead of silently resolving to the wrong section; re-verified against
  the committed tree a third time this same task, see LOW-d below on why a
  heading-anchored `CHANGELOG.md` citation still needed re-pointing on
  every edit above it regardless), and migrated on 2026-08-27 to the
  line-independent heading-section form
  `CHANGELOG.md:#[0.9.0]#"grounding-mcp 0.6.0 reads this marker"` (see the
  2026-08-27 entry), see that entry below). Consciously accepted, recorded in the run
  decisions: substring membership in the vocabulary pin (a yaml-key match
  was tried and reverted, see round 3), pre-existing
  `template-markers.test.ts` prettier drift, and the absence of a mechanical
  guard for short-form citations (okf-kit resolves file targets only);
  that guard is a follow-up, not part of this change.


## 2026-08-24 (0.24.0, implementer)

- Package version 0.24.0: the placement rule. Moved org-, machine-, and
  point-in-time-bound evidence out of the kit's reusable instruction files
  (`SKILL.md`, `agents-md-section.md`) into the CHANGELOG's new `[0.24.0]`
  entry, with a one-line pointer left in prose; rule text is unchanged.
  Removed: the A/B measurement's headline numbers from SKILL.md step 6 and
  from agents-md-section.md's Scaling delegation bullet (both now point to
  "CHANGELOG 0.23.0"); the incident tally (`(four so far)`) and the whole
  reviewer/model-correlation passage from SKILL.md's Subagent misfire rule
  (both now live in the 0.24.0 CHANGELOG entry's Evidence note); the pinned
  `grounding-mcp 0.6.0` version number from the run-base paragraph (now "the
  consuming gate's documentation (grounding-mcp)"). Added: a placement check
  to `reviewer.md`'s "Check, at minimum" list, a matching one-sentence check
  to SKILL.md step 9 (Hand off), a `placement-guard` CI job, and a root
  `slop.config.yml` enabling the `placement-slop` pack for this package's
  `assets/` tree and the `agentic-coding-playbook` package.
- Inserting the `[0.24.0]` CHANGELOG entry above `[0.23.0]` shifted every
  existing `CHANGELOG.md:` line citation across the bundle by a uniform
  +77 (verified: the new `[0.23.0]` heading moved from line 8 to line 85,
  and every other pre-existing entry's content was spot-checked at its
  shifted position before being applied; none were re-derived from the
  offset alone). All `CHANGELOG.md:` citations in subagent-contracts-
  superset.md, review-gate-and-waivers.md, and run-state-lifecycle-and-
  markers.md were corrected by this offset. The SKILL.md edits themselves
  were not a uniform shift: two in-place same-length edits (the
  `grounding-mcp` pointer at old/new :93-94; the AC1 parenthetical at old
  :150-153 -> new :150-151, a -2 net) sit ahead of the Subagent misfire
  rule's content rewrite (old :454-469, 16 lines -> new :455-462, 8 lines,
  a further -7 net after an intervening +3 from the new step-9 sentence at
  old :216 -> new :214-217), so every `SKILL.md:` citation at or after the
  package's old line 150 was meant to be checked against the current file
  directly (heading text, yaml-fence boundaries, or exact quoted prose)
  rather than derived from a single offset; a handful of citations
  straddling an edit boundary (SKILL.md step 6's own line range, spanning
  the -2 zone; the 0.14.0 reproduction-requirement citation, likewise)
  needed hand recomputation rather than a mechanical shift.
  `test/docs-consistency.test.ts` citations were meant to be checked the
  same way rather than offset, since the file's own edits (one import line
  removed; the Subagent misfire rule's `describe` block rewritten, net +2
  lines; two new `describe` blocks appended for the new positive/negative
  pins) are not a uniform shift either; the two new `describe` blocks
  appended at the file's end (46 lines, after the pre-existing okf-kit
  version-pin block, unaffected by this pass) were pure appends, shifting
  nothing before them. Review round 1 found seven of those hand-derived
  citations still off by 1-2 lines (five in subagent-contracts-superset.md
  spanning `test/docs-consistency.test.ts` and `SKILL.md` targets); the
  round-2 fix-round entry below records the corrected values and the
  verification method actually used to confirm them.
  `npx okf-kit@0.5.0 check packages/orchestrator-workflow/docs/okf`: before
  the docs/okf fixes (kit assets already edited) 43 findings (errors 0,
  warnings 22, notices 21); after, 21 findings (errors 0, warnings 0,
  notices 21), matching the pre-change baseline exactly (same 21
  `unresolved-ambiguous` bare-filename notices as every prior pass in this
  log). No new evidence was added to the bundle beyond what the CHANGELOG
  0.24.0 entry itself carries; the Subagent misfire rule section gained one
  new paragraph explaining the 0.24.0 removal and pointing at the
  CHANGELOG, not new measurements of its own.

## 2026-08-24 (0.24.0 round 2 fix, implementer)

- Review round 1 on the 0.24.0 change found: five citation ranges in
  subagent-contracts-superset.md off by 1-2 lines (four into
  `test/docs-consistency.test.ts`, two into `SKILL.md`); the placement-slop
  pack's three evidence-class rules (`dated-evidence`, `tally-phrase`,
  `opaque-id`) default to `warn`, so the placement-guard CI job could not
  actually fail on them; the root `slop.config.yml` allow list carried a
  dead `npmjs\.com/` entry and two unanchored `allow` patterns; the
  CHANGELOG's 0.24.0 evidence note paraphrased rather than quoted the
  removed SKILL.md passage and omitted the incident dates; and a serial
  comma was missing from the two new placement-check sentences. This round
  fixed all of it: `slop.config.yml` now sets `rules.placement-slop/dated-
  evidence.severity`, `rules.placement-slop/tally-phrase.severity`, and
  `rules.placement-slop/opaque-id.severity` to `block`, anchors both
  `allow` patterns to a full `https://` URL, drops the dead entry, and
  `ignorePaths`-excludes `packages/github-api-tool/SKILL.md` (two
  pre-existing dated examples, out of scope, flagged for a follow-up); the
  guard was re-run clean (0 violations, exit 0), then a negative control
  (a dated, tallied line added to SKILL.md) confirmed it now exits 1 with a
  `block` finding, then the guard was re-run clean again after restoring
  the file. Residual, disclosed rather than fixed: the pack applies an
  `allow` match to the whole line, so a home path or date sharing a line
  with an allowed URL is not reported (slop-detector follow-up). The CHANGELOG's 0.24.0 evidence note now quotes the two
  removed SKILL.md sentences verbatim and states the incident dates (three
  on 2026-07-16, one on 2026-07-20); moving that note under `### Changed`
  as a sub-bullet (instead of its own H3) shifted every `CHANGELOG.md:`
  citation at or after old line 85 by a uniform +14, corrected in
  review-gate-and-waivers.md, run-state-lifecycle-and-markers.md, and
  subagent-contracts-superset.md (verified: each old citation's start and
  end line was read against the pre-edit file first to confirm it was
  already correct, then the same content was confirmed at old-line+14 in
  the edited file). The five subagent-contracts-superset.md citations were
  corrected to the reviewer-supplied values and then independently
  re-verified by two methods: a script asserting that every
  `docs-consistency.test.ts:N` or `:N-M` citation in `docs/okf/*.md` starts
  at a `describe(`/`it(` line and ends at that block's matching closing
  `});` (ran clean over the whole bundle), and direct reading for the two
  `SKILL.md:` citations (confirming the quoted prose sits inside the cited
  range). `npx okf-kit@0.5.0 check packages/orchestrator-workflow/docs/okf`
  stayed at 0 errors, 0 warnings, 21 notices after the fixes, matching the
  pre-round baseline.

## 2026-08-25 (colon-shortform-citations fix round, implementer)

- Review found two HIGH findings and four mediums on the colon-form
  short-form citation rewrite. HIGH 1: the CHANGELOG's new "Changed" entry
  inserted 11 lines above every later line, so the eleven CHANGELOG.md
  citations in review-gate-and-waivers.md and run-state-lifecycle-and-
  markers.md (siblings of the rewritten doc, untouched by the rewrite
  commit) silently pointed at wrong content; one of them had been flagging
  blank-start-line before the shift and stopped flagging anything after
  it, destroying a real drift signal instead of fixing one. HIGH 2: the
  CHANGELOG claimed okf-kit check reported the same 39 findings / 17
  warnings / 22 notices before and after the rewrite; base was 39 (0/17/
  22), but neither the intermediate commit nor HEAD had actually measured
  39 again (38, then 37), and the number read as copied from okf-kit's own
  CHANGELOG rather than measured against this bundle. Mediums: the CI
  staleness job pins okf-kit 0.5.0 from npm, which predates short-form
  colon resolution entirely, so the "now covers all 21" claim never
  reaches CI; a 22nd sibling short-form citation (subagent-contracts-
  superset.md, the negative-pin test citation) was missed by the initial
  rewrite because its parenthesis wraps a line break; the sources-fresh
  STALE warning for the rewritten doc was suppressed by that doc's own
  fresh commit rather than an honest re-verification, with timestamp still
  at a rounded 23:59 and no log.md line recording it; and three small
  defects (a missing serial comma on one rewritten citation, a README
  bullet placed under an "authoring guidance baked into the templates"
  heading for a convention no template demonstrates, and undersold on
  which connectives the gate accepts, and a CHANGELOG sentence implying
  the paren form was once checked and later "dropped" when the colon-form
  gate and the paren-form drop both landed in okf-kit's same [Unreleased]
  change).

  This round: byte-verified all eleven shifted CHANGELOG.md citations in
  the two sibling docs against the pre-insertion base commit before
  touching them (base range N-M equals shifted range (N+11)-(M+11)).
  Rewrote the CHANGELOG's "Changed" entry to state only measured numbers
  and the CI caveat; that rewrite itself grew the entry by 9 more lines,
  so all sixteen CHANGELOG.md citations in the bundle (the eleven just
  fixed, plus five in subagent-contracts-superset.md already corrected by
  the prior commit) were re-verified and re-pointed against the same base
  commit at the full +20 offset, each confirmed byte-for-byte before the
  edit. okf-kit check (built from this repo, not the published package)
  measures 0 errors / 17 warnings / 22 notices (39 total) against the base
  commit and 0 errors / 14 warnings / 22 notices (36 total) against this
  round's final state: 13 of those 14 warnings are pre-existing install-
  fence-mechanics.md short-form findings, untouched and out of scope; the
  fourteenth is the run-state-lifecycle-and-markers.md CHANGELOG.md
  citation landing on blank-start-line again, the intentionally restored
  pre-existing content drift tracked separately (agent-tasks task
  2e7680f6), not a new problem. Rewrote the 22nd sibling short-form
  citation from the paren form to the colon form, matching the README's
  own bracket-form example; it binds to the same test/docs-consistency.
  test.ts range as its ten sibling short-forms with no new finding. Fixed
  the missing serial comma on one of the 21 originally rewritten
  citations. Generalized the README heading from "Authoring guidance baked
  into the templates" to "Authoring guidance" (three of its four bullets
  remain template-baked; the short-form-citation bullet is a citations-
  resolve authoring rule, not shown in any template) and named the
  semicolon and open-paren connectives alongside comma/and/or, cross-
  referencing the README's own bracket-form example. Reworded the
  CHANGELOG's "dropped" framing to state the paren form was never
  machine-checked in a released okf-kit. Bumped timestamp on all three
  touched docs (subagent-contracts-superset.md, review-gate-and-
  waivers.md, run-state-lifecycle-and-markers.md) to the real verification
  instant (new Date().toISOString(), captured once and reused across all
  three so they share one recorded verification event), which also
  cleared three pre-existing sources-fresh STALE warnings, one per touched
  doc (correction below: they were not new, and the bump did not clear
  them).

## 2026-08-25 (colon-shortform-citations fix round 2, implementer)

- Review found one HIGH and four mediums on round 1's fix. HIGH N1: the
  round-1 byte-comparison against base commit b80c346 was internally
  consistent but the base itself was already adrift: PR #123
  (`1d124ca`, 2026-08-25 13:09:32+0200) had inserted a 15-line
  `## [Unreleased] / ### Corrections` entry into `CHANGELOG.md` before
  `b80c346`, after the three bundle docs' own verification timestamps, and
  nobody had re-pointed their citations for it. Round 1's own `+11`-then-
  `+20` shift (for the "Changed" entry it added on top) was correct
  relative to `b80c346`, but `b80c346` was itself +15 lines off from what
  the docs' citations actually described, so the net-correct offset was
  +35, not +20; all 16 landed one release section too new. Medium N2: the
  CHANGELOG's own "+11 lines" claim was not reproducible from the shipped
  state (an intermediate commit's number, not a squash-survivable one).
  Medium N3: the CHANGELOG's before/after finding counts silently mixed in
  three `sources-fresh` `STALE` warnings whose presence or absence is a
  property of this round's commit shape (whether `CHANGELOG.md` is
  co-committed with the docs that cite it), not of the citations'
  correctness. Medium N4: round 1's log.md entry mischaracterized those
  same three warnings as "two new" ones the CHANGELOG edit "introduced" and
  the timestamp bump "cleared". Low N5: a README bullet carried two
  "see below" pointers to the same section without quoting either
  heading, and its bold lead-in phrase (`, :N-M`) undersold the full
  connective list two lines below it.

  This round: re-verified all 16 `CHANGELOG.md` citations across the three
  touched docs (`subagent-contracts-superset.md`, `review-gate-and-
  waivers.md`, `run-state-lifecycle-and-markers.md`) against the actual
  section-header structure of `CHANGELOG.md`, not against a byte-diff of a
  moving base: for each citation, located the `## [x.y.z]` header the
  citation's own sentence names and confirmed the cited range falls inside
  that section's body. Applied a uniform +15 shift for the PR #123 drift,
  then rewrote the CHANGELOG's "Changed" entry to drop the unreproducible
  "+11" number (N2) and to report only the citations-resolve-controlled
  subset (N3, decision below), which itself grew the entry by 7 lines and
  required a further uniform +7 shift on the same 16 citations (net +35
  plus the entry's own new length delta from round 1's already-applied
  +20, landing at the final values below). Confirmed with `okf-kit check`
  (built from this repo, not the published package): 35 findings
  (0 errors / 13 warnings / 22 notices) at this round's final state, all
  13 warnings pre-existing `install-fence-mechanics.md` short-form
  findings unrelated to this doc set; the three touched docs carry zero
  `citations-resolve` or `sources-fresh` findings of their own. This
  replaces round 1's reported 0/14/22: the 14th warning there was
  `run-state-lifecycle-and-markers.md`'s still-incompletely-shifted (+20,
  not +35) 0.7.0 citation landing on a blank line by coincidence, not the
  pre-existing content drift (agent-tasks task 2e7680f6) round 1 attributed
  it to; with the citation correctly shifted the full +35 it resolves
  cleanly and the finding is gone, not "restored."

  N3 decision: chose to report only the citations-resolve subset this
  change actually controls in the CHANGELOG (0/13/22, three touched docs
  clean) rather than folding the `sources-fresh` count into it, and to log
  the fuller `sources-fresh` investigation here instead, because that
  count is a property of this round's commit shape, not of citation
  correctness. Measured directly: `okf-kit check` against base commit
  `b80c346` (via `git worktree add`, this repo's own `okf-kit` build)
  reports 39 findings (0/17/22): 13 pre-existing `install-fence-
  mechanics.md` warnings, one `blank-start-line` warning
  (`run-state-lifecycle-and-markers.md`, that doc's own `CHANGELOG.md:
  808-815` 0.7.0 citation as it read at base commit `b80c346`, deliberately
  historical: frozen to that commit's CHANGELOG.md content, not re-derived
  against the live file on every later sweep, including T-002's own
  fix-round-1 19-line insertion), and three `sources-fresh`
  `STALE` warnings, one per touched doc, all reading `` `packages/
  orchestrator-workflow/CHANGELOG.md` changed 2026-08-25T11:09:32.000Z
  after doc timestamp 2026-08-24T23:59:00.000Z `` -- `1d124ca`'s commit
  time (13:09:32+0200 = 11:09:32Z) is after the three docs' pre-round-1
  `timestamp` (2026-08-24T23:59:00Z). Verified these three warnings are
  cleared by `sources-fresh`'s `docCommitEpoch` exception
  (`packages/okf-kit/src/rules/sources-fresh.ts`: a doc whose own last
  commit is not older than the cited source's last commit is not stale,
  regardless of its frontmatter `timestamp`), not by the frontmatter bump:
  reverted all three docs' `timestamp` back to the pre-round-1
  `2026-08-24T23:59:00Z` value in the working tree with this round's other
  content fixes still applied (uncommitted, so each doc's last git commit
  was still round 1's `dda1f67`, which also touched `CHANGELOG.md`) and
  re-ran `okf-kit check`: still 35 findings (0/13/22), zero `sources-fresh`
  warnings, confirming the co-commit clears them independent of the
  timestamp value. Restored the real timestamp
  (`2026-08-25T15:03:43.966Z`, `new Date().toISOString()`, captured once
  and reused across all three docs) afterward. Any future commit that
  edits these docs without also touching `CHANGELOG.md` in the same commit
  will re-surface the three `STALE` warnings; that is expected
  `sources-fresh` behavior, not a regression, and is exactly why this
  round does not fold that count into the CHANGELOG's headline number.

  Also fixed: `okf-kit/README.md`'s short-form-citation bullet (N5) now
  keeps a single pointer, quoting "Citation resolution (citations-resolve)"
  verbatim (the actual `##` heading text, not the non-heading "Short-form
  citations" lead-in it pointed to before), and its bold lead-in now says
  "a connective-led `:N-M`" instead of implying only the comma form,
  matching the fuller `,`/`;`/`(`/`and`/`or` list two lines below it.

  Mutation probes (both applied, observed, and reverted; illustrative line
  numbers below are written without a `file.ext:N` pattern on purpose, so
  this log entry itself does not register as a citation under
  `citations-resolve`'s bare `path.ext:N` regex, which needs no backticks):
  (1) took the 0.14.0 motivation citation in `subagent-contracts-
  superset.md` (correctly pointing at `CHANGELOG.md`, start line 566) and
  reset it back 15 lines, to start line 551; direct read confirmed line 551
  falls inside the `## [0.15.0]` section (`CHANGELOG.md` header at line
  519), not `## [0.14.0]` (header at line 562) -- the wrong section, on a
  non-blank line, exactly the case the review warned `okf-kit` stays silent
  on. `okf-kit check` findings were unchanged by the mutation, confirming
  it: the tool has no section-membership check, only structural ones
  (target exists, range in file, start line non-blank/non-brace, test/
  markdown block boundary). Reverted to start line 566 and re-confirmed it
  falls inside `## [0.14.0]` again. (2) Regression probe for round 1's
  paren-to-colon rewrite: took one of the 22 short-form colon citations in
  `subagent-contracts-superset.md` and pointed it at a deliberately
  out-of-range target (a test file with far fewer lines than the cited
  start) while still in colon form -- `okf-kit check` correctly flagged a
  `range-exceeds-file` warning (findings count rose by one). Wrapped the
  same out-of-range target in parenthesized form instead of colon form --
  the warning vanished entirely (findings count dropped back down), because
  a bare parenthesized short-form is never collected at all, colon form or
  not. Restored the citation to its original, correct colon-form target and
  range, and re-confirmed `okf-kit check` back at 35 findings
  (0 errors / 13 warnings / 22 notices), matching this round's final
  reported state.
- 2026-08-26: CI-wired okf-kit's anchor check to fail the build for this
  bundle (agent-tasks task 578f5bfd, following on the anchored-citations
  feature itself, task 5c8013c0, and its release, task c0effc67). A new
  `okf-anchor-guard` job in `.github/workflows/ci.yml` runs the same
  `okf-kit check --json` as the existing warn-only `okf-staleness.yml`
  drift watch, then narrows to any `anchor-*`-tagged finding (matched by
  rule-id pattern, not a hardcoded list of the four current rule ids, so a
  future okf-kit release adding a fifth anchor rule is covered without an
  edit here) and fails the build when any of them fire. `okf-staleness.yml`
  itself was not touched: its own header comment already says it must
  never be the one that fails the build. Note: master carries no required-status-check
  branch protection today, so "fails the build" describes this job's own
  run going red, not an enforced merge block; that is an orchestrator
  decision recorded here, not a branch-protection change.

  Round 2 (review findings against the first pass above): the first pass
  claimed 122 anchored citations and a single 27-finding mutation-probe
  number; both were wrong, and the anchors it wrote were not reliably
  load-bearing. This entry replaces that draft with the corrected,
  measured state.

  HIGH 1 (44 in-scope citations the first pass missed): the first pass's
  citation regex required a backtick delimiter around each citation; two
  of the five docs/okf siblings, `run-state-lifecycle-and-markers.md` and
  `install-fence-mechanics.md`, cite `SKILL.md` and `test/*.test.ts` in
  running prose without backticks in several places (the same bare-form
  shape the CHANGELOG.md heading-anchor citations in those same docs also
  used), so those 44 citations were silently skipped. okf-kit's own
  `CITATION_RE` has no backtick requirement; the anchoring pass was
  redone against that exact citation shape (with or without backticks) to
  close this gap. Every in-scope citation into the four kit-source
  categories (`SKILL.md`, the five `assets/agents/*.md` templates,
  `src/models.ts`, `test/*.test.ts`) now carries a string-form anchor,
  plus the `CHANGELOG.md` heading anchors from task 5c8013c0 (that anchor
  mechanism is unaffected by this round, but this round's own CHANGELOG
  entries pushed every release section beneath them, so those citations'
  line numbers were re-pointed -- confirmed via `git show 5c7a415 --
  packages/orchestrator-workflow/docs/okf/review-gate-and-waivers.md
  packages/orchestrator-workflow/docs/okf/run-state-lifecycle-and-markers.md
  packages/orchestrator-workflow/docs/okf/subagent-contracts-superset.md
  | grep -c '^[-+].*CHANGELOG.md:'`: 32 (16 removed, 16 added, a matched
  pair; the same command against all five docs/okf/*.md siblings
  including log.md returns 33/17/16, since log.md's own narrative prose
  happens to carry one unrelated citation matching the same grep
  pattern -- restricted to the three docs that actually cite
  `CHANGELOG.md` this way to avoid that false match). Review round 4
  (D31) removed the hand-counted
  per-doc/per-round totals this paragraph used to carry here: they drift
  every time a citation is added, split, or re-pointed (measured
  twice already in this same task, see the 2026-08-26 entry below for
  both), so log.md now carries exactly one live count instead, sourced
  from a command, not typed by hand: `npx vitest run
  test/docs-consistency.test.ts -t "in-scope citations (sanity"
  --reporter=verbose` shows a passing test named "examined 171 in-scope
  citations (sanity: the brake itself did not go blind, more than a
  token number)" against the committed tree -- the count is read from
  the test's own name (review round 5, LOW-g), not a stdout print a
  reporter could suppress, so the number shown can never diverge from
  the number the floor assertion actually checked (the erosion brake's
  own count of citations into the four in-scope kit-source categories --
  `SKILL.md`, the agent templates, `models.ts`, `test/*.test.ts` --
  across the five docs/okf siblings; `CHANGELOG.md`'s 16 heading-anchored
  citations are a separate mechanism, deliberately
  excluded from this count, see the `anchorScopeResolve` comment in
  `test/docs-consistency.test.ts`). Corrected 2026-08-26
  (this fix round, after review round 2): the round-2 draft above (and
  the CHANGELOG's own `[Unreleased]` copy) claimed the `CHANGELOG.md`
  heading anchors were "untouched"/"unaffected" by round 2, which was
  already false when written; this fix round's own edits to the
  CHANGELOG then re-pointed all of them a second time, verified by
  re-running `okf-kit check` (13 warnings / 22 notices / 0 errors,
  unchanged) after the second re-point.

  HIGH 2 (anchors not load-bearing): the first pass anchored each citation
  on whichever line of the range happened to be non-blank and produced a
  candidate string first, almost always the range's FIRST line. Measured
  this round: 107 of 121 checkable first-pass anchors sat on the first line,
  and (corrected 2026-08-26, see that entry: the round-2 draft wrote "21 of
  61 ... 21 of 61 truly stayed green" here, but round 1 had only 46
  SKILL.md-targeting anchors, not 61) a 1-line insertion near the top of
  SKILL.md left 24 of 46 SKILL.md-targeting anchors silently green (22
  fired: 5 directly via `anchor-not-found-in-range`, 17 via a `blank-start-
  line` base-check finding that happens to fire first for those particular
  ranges when shifted, 1 via `unresolved-ambiguous` -- more than one repo
  carries a `SKILL.md`, so okf-kit itself declines to check a bare-filename
  citation into it -- one citation hit two rules, so the counts sum to 23
  against 22 unique fired citations; but 24 of 46 truly stayed green). Root
  cause: the checker scans the *entire* cited window for the anchor text,
  not just its recorded line; when the anchor sits on the window's first
  line and the insertion is shorter than the range itself, the shifted
  window (old-file coordinates `[start-k, end-k]`) still contains old line
  `start`, just at a different offset inside the same window, so the text is
  still "found somewhere in range" and the check stays green. Anchoring on
  the range's LAST line instead closes this for any insertion size `k >= 1`
  above the range (old line `end` falls outside `[start-k, end-k]` for every
  `k >= 1`), so long as the anchor text does not also happen to reappear
  elsewhere inside the shifted window by coincidence -- which is what the
  second half of this fix guards against: capping every anchor's whole-file
  occurrence count at 3 (23 first-pass anchors exceeded that, several using
  generic tokens like `describe(` that recur dozens of times).

  All 166 in-scope anchors, round 2's own count at the time (122 regenerated
  from the first pass, 44 newly added for HIGH 1; the live count has since
  moved, see the 2026-08-26 round-4 entry below for how to read it fresh
  rather than trusting this number), were rewritten under both rules: (a)
  walk the cited
  range's end line backward past any blank/closing-brace/too-short line to
  the nearest real content line, narrowing the range's end to that line
  when needed, and anchor there; (b) pick a literal substring of that line
  that occurs at most 3 times in the whole target file (trying
  progressively different segments of the line, split around any
  quote/backtick it contains, when the first candidate is too common).
  Two anchors needed a manual, not mechanical, fix beyond this (review's
  finding (c), the anchor must carry the claim the citing sentence makes):
  `review-gate-and-waivers.md`'s two citations of `reviewer.md (lines 30-31)`
  (each anchored `"Rules:"`, a section label carrying no claim at all)
  cite the mandatory-`acceptance_recommendation` rule but landed on the
  `Rules:` heading two lines above it; the range was widened to `30-36` to
  reach the actual rule text (reviewer.md lines 35-36: "`
  acceptance_recommendation` is mandatory: always set it in your output;
  never leave it blank or omit it."), anchored on the widened range's own
  last line, `"never leave it blank or omit it."` -- the trailing half of
  the same two-line rule the citing sentence names, which keeps rules (a)
  and (c) both satisfied rather than picking the review's suggested
  phrase ("always set it in your output", on line 35, one line short of
  the widened range's end) at the cost of rule (a); the two citations
  behave identically since they cite the same target range. Similarly,
  `review-gate-and-waivers.md (line 180)` and `subagent-contracts-superset.md (line 294)`
  both cite `reviewer.md (lines 51-56)` (anchored on its own first line, the goal-
  reviewing rule, not the reproduction-evidence rule the citing sentences
  actually describe); widened to `51-61` to enclose the whole
  reproduction rule through its "does not qualify"/"do not trigger this"
  exception clause, anchored on the widened range's last line,
  `"lint) do not trigger this."` -- the exception half of the same rule,
  for the same rule-(a)-over-suggested-phrase reason as above.

  Per-`k` differential probe (replaces the single 27-finding number from
  the first pass): inserting `k` dummy lines near the top of
  `assets/skill/SKILL.md` (before any cited content) and re-running
  `okf-kit check`, counting how many of the 52 *unique* SKILL.md-targeting
  cited ranges produce a finding of *any* kind (an anchor-* finding, or a
  base check like `blank-start-line` that happens to catch the same
  shifted range first and short-circuits the anchor check per okf-kit's
  own "anchors checked only once the base checks already passed" rule) --
  not just anchor-*-tagged findings, since a base-check catch is still a
  correctly red build, just filed under a different rule id:
  - `k=1`: 52/52 (100%) of SKILL.md-targeting ranges produce a finding.
    This is the acceptance measure the review round asked for and it is
    met.
  - `k=2`: 51/52 (98%) produce a finding. The one exception:
    `subagent-contracts-superset.md`'s `SKILL.md (lines 339-368, anchor "T-001")` (the
    task-slicer `recommended_order` example). `T-001` occurs twice in
    SKILL.md, once inside its own citation's range (line 347, "id: T-001")
    and once on the range's own last line (368, the anchor's home). At
    `k=2` the shifted window still contains old line 347 (the other
    occurrence), so the check stays green; at `k=1` it happens to be
    caught anyway, but via `blank-start-line` on the shifted start line,
    not via the anchor. This is the same "occurrence <= 3 file-wide does
    not guarantee no collision within the citation's own wide range"
    residual gap the rule (b) cap narrows but cannot fully close for a
    citation whose only short, meaningful last-line text is a token
    (`T-001`) that also appears earlier in the same block; not fixed this
    round, named here rather than silently left for the next drift
    incident to rediscover.

  New tests (`packages/orchestrator-workflow/test/docs-consistency.test.ts`,
  appended at the file's own end, per this file's established convention
  of never inserting above existing code so as to not shift the many
  `path:N` citations into it from this same bundle):
  - "every okf-kit@<version> pin under .github/workflows/ matches
    package.json" globs every `.github/workflows/*.yml` file for an
    `okf-kit@<version>` pin (`npm install -g` and `npx` forms) and asserts
    each equals `packages/okf-kit/package.json`'s version, extending the
    pre-existing okf-staleness.yml-only version-pin check to also cover
    `ci.yml`'s own pin (added as a new, additional describe block rather
    than edited in place, for the same append-only reason).
  - "every string-anchored docs/okf citation's anchor is load-bearing
    (last line, low-collision)" mechanically pins rules (a) and (b) above:
    parses every string-anchored full citation in the five docs/okf
    siblings (the same citation shape as okf-kit's own `CITATION_RE`, no
    backtick requirement), resolves each target among the four in-scope
    kit-source categories, and asserts the anchor text is found on the
    target's actual last line of the cited range and occurs at most 3
    times in the whole target file. Verified red against the first pass's
    anchors (temporarily restoring the pre-round-2 docs/okf/*.md content
    with the new test code in place): 2 of 3 sub-assertions failed, 116
    last-line violations (112 unique messages, some citations sharing an
    identical doc/target/range/anchor tuple) and 24 occurrence violations
    (some anchors violate both). Corrected 2026-08-26: this entry
    originally said "24 last-line violations", copied from the
    occurrence-violations count by mistake; re-run against the same
    restored pre-round-2 content confirms 116/112/24. Verified green
    against this round's rewritten anchors: 3/3 passed. Both runs used
    the real `vitest run` command, not a hand-rolled check.
  - "every docs/okf citation into a kit-source category this bundle
    anchors carries an anchor" (the erosion brake): asserts the count of
    unanchored in-scope citations stays at zero going forward, by name.

  `ci.yml` also gained, this round: a self-test step ahead of the real
  check that builds a throwaway one-doc OKF bundle (its own tiny git repo)
  under `$RUNNER_TEMP`, drifts one heading-anchored citation's range into
  the wrong section without touching its anchor text, and requires the
  same jq filter the real check uses to report at least one anchor
  finding against it -- guards the filter itself (a regex typo, an
  okf-kit finding-shape change) rather than the bundle, and fails red
  before the real check gets a chance to pass green for the wrong reason;
  the filter itself now matches any `anchor-*`-tagged finding by pattern
  rather than the four current rule ids by name; `permissions:
  {contents: read}` was added at the workflow's top level (it had none
  before, for any job); and a one-line note was added to the job's own
  comment that renaming or moving `packages/orchestrator-workflow/docs/okf`
  requires updating `BUNDLE_PATH` in the same PR.

  `okf-kit check` against a repo build reports 0 errors / 13 warnings / 22
  notices both before and after this round's full anchor rewrite (0
  anchor findings either way): the 13 pre-existing warnings are all
  `install-fence-mechanics.md` short-form findings against `init.test.ts`
  (12 `test-range-start-not-head`, plus 1 `closing-brace-start-line`
  against `init.ts`), unrelated to this change and untouched by it.

  Mutation probes, both applied, observed, and reverted (see above for
  the per-`k` differential probe, which supersedes the single-number
  version from the first pass). (1) Negative control: same shape as the
  first pass, a 6-line dummy insertion into SKILL.md partway through the
  file; findings rose from 13 warnings to 43 (27 new), reverted and
  re-confirmed back to 13/22 clean. (2) False-positive probe: same shape,
  a `package.json` patch-version bump touching no bundle doc or cited
  source range; findings stayed at 13/22/0-anchor, unchanged; reverted.
  (3) A third, unplanned confirmation happened live while authoring this
  same entry's own CHANGELOG.md addition (26 inserted lines above the
  release sections): 15 of the 16 anchored CHANGELOG.md citations
  immediately flagged `anchor-heading-mismatch`; all 16 were re-pointed by
  the same +26-line shift and spot-verified by direct read against the
  actual, current release sections, back to 0 anchor findings.

  Residual gaps this guard does not close, named here rather than
  silently discovered later: (i) a content change inside a cited range
  that neither shifts its line count nor disturbs the anchor text itself
  stays invisible to this check -- purely mechanical (line/text
  presence), never semantic, the same limit okf-kit's own README
  documents; (ii) the specific `T-001` collision above, where the rule
  (b) file-wide occurrence cap does not guarantee no collision within a
  single wide citation's own range, so one SKILL.md-targeting citation is
  not detected at `k=2` (it is at `k=1`, the measured acceptance bar).

  Corrected 2026-08-26 (this fix round, orchestrator decision D26): a
  third residual gap was missing from this list entirely. Full citations
  into `src/init.ts`, `src/cli.ts`, `src/writers.ts`, `src/uninstall.ts`,
  `src/opencode.ts`, `src/assets.ts`, `assets/templates/*.md`, and
  `assets/agents-md-section.md` carry no anchor and sit outside this
  guard, since the spec's four in-scope categories are only `SKILL.md`,
  the agent templates, `models.ts`, and `test/*.test.ts`. Measured on the
  committed tree (`node /tmp/measure_residual2.mjs`, a standalone script
  reusing this file's own `ANCHOR_CITATION_RE` and reading
  `assets/templates/`'s own directory listing to classify each citation's
  basename): `src/init.ts` 68, `src/cli.ts` 19, `src/writers.ts` 12,
  `src/uninstall.ts` 10, `src/opencode.ts` 4, `src/assets.ts` 1,
  `assets/templates/*.md` 19, `assets/agents-md-section.md` 9 -- 142
  unanchored full citations altogether, none of which this guard or its
  erosion brake protects. (iii) A follow-up task will extend both the
  anchoring pass and the erosion brake to `src/**` and `assets/**`; not
  done in this task, D26 above.

  Superseded 2026-08-26 (review round 4, D30). This paragraph originally
  described a round-3 check ("no full citation into a `*.test.ts` target
  ends on a foreign describe/it/test head line") narrower than the defect
  it was meant to catch, and a round-3 claim that this paragraph's own
  6-of-25 spot-check of "start is not a head line" citations found "all
  legitimate ... not drift". Both were wrong, caught by review round 4's
  own independent 8-of-25 sample, which found 3 mis-cited (named in the
  2026-08-26 round-4 entry above: the citations formerly at
  `init.test.ts` lines 1114-1121, 729-764, and 1138-1193, all now fixed)
  -- and one of round 3's own "verified legitimate" six, the citation
  formerly at `init.test.ts` lines 153-169, was independently confirmed
  wrong by round 4's structural scan below, contradicting the
  round-3 claim about that same citation. The round-3 check is replaced by
  the broader STRADDLE check below, not merely extended: the round-3 symptom
  (end is a foreign describe/it/test head line) is a special case of
  straddling except when the end line is a NESTED CHILD block's own head
  line still inside the start's own (wider) block -- round-3's check would
  wrongly flag that as an error, straddle would not, since the child is
  still within the parent's span. Checked at this commit (excluding the
  degenerate single-line case of a citation whose start and end are both a
  block's own head line, e.g. the single-line citation into `init.test.ts`
  at line 1796, which is straddle-clean by construction and not what "nested
  child" means here): 0 citations in the bundle have an end line that is a
  head line of a nested child while still being straddle-clean, so this
  round's fixes did not need to reconcile any such case; the exact scan is
  not reproduced here. The STRADDLE check is also exhaustive rather than
  sampled: every full citation into a `*.test.ts` target, checked, not a
  subset. Measured on the round-3-corrected bundle before this round's
  fixes: 16 unique ranges failed it -- 15 straddles (14 where start and end
  land in two different `it()`/`test()` blocks, plus 1,
  `docs-consistency.test.ts, former lines 1891–2038`, where start correctly resolved to a
  `describe(` block but end escaped past its own close) and 1
  (`subagent-contracts-superset.md`'s citation into
  `docs-consistency.test.ts:523-529`) where the citation starts inside a
  JSDoc comment immediately before a `describe(` rather than inside any
  block at all, so it has no containing block to straddle from; all 16 were
  re-pointed
  to the test each citing sentence actually names (see the round-4 entry
  above for the count-found/count-fixed detail and the "start need not be
  the block's own head line" design note). A `start !==` the block's own
  head line, by itself, is not re-flagged as an error going forward
  (per-review design: a sub-range within the correct block is legitimate);
  what round 3 got wrong was treating "not literally a head line" as
  sufficient evidence of "legitimate", without checking whether start and
  end even resolved to the same block. That gap is what the STRADDLE
  check closes structurally. It does not close, and no round of this task
  has closed, the narrower case a `start !==head` citation that
  resolves to the *wrong* block in a way that still satisfies the
  straddle rule (i.e. both start and end land inside one block, just not
  the block the sentence actually names) -- catching that needs reading
  the sentence against the target, which remains manual, sampled, and
  named as an open residual gap rather than claimed closed.

  Corrected 2026-08-26 (this fix round, review round 4, D30, LOW-d): a
  fifth residual gap, named after paying its cost repeatedly across this
  same task. okf-kit's `CITATION_RE` requires a literal `path:N[-M]`
  pair; a heading-anchored `CHANGELOG.md` citation's line numbers are not
  independent of the heading they name, and there is no line-independent
  citation form today (`#0.9.0` alone, without `:N-M`, is not a valid
  citation). So every CHANGELOG entry inserted above a cited release
  section re-points every citation into it, mechanically, with no way to
  express "just find `## [0.9.0]` wherever it is." This task
  (578f5bfd) paid that cost four times against the same 16 (now
  17, after this round added one) citations, once per round that touched
  CHANGELOG.md: +26 (round 1's own entry), +32 (round 2's), +3 (round
  3's), +1 (round 4's, this entry). A follow-up task to give okf-kit a
  line-independent, heading-only citation form (`CHANGELOG.md#0.9.0`,
  resolved by scanning for the heading rather than a fixed line number)
  is the orchestrator's to size and schedule, not this task's.

## 2026-08-26 (agent-tasks ca9d5048, implementer)

Closes the residual gap named in 578f5bfd round 4 (D26, see the
2026-08-26 entry above): full citations into `src/init.ts`, `src/cli.ts`,
`src/writers.ts`, `src/uninstall.ts`, `src/opencode.ts`, `src/assets.ts`,
`assets/templates/*.md`, and `assets/agents-md-section.md` carried no
anchor and sat outside the erosion brake. `test/docs-consistency.test.ts`'s
`anchorScopeResolve()` now derives its `src/*.ts` and
`assets/templates/*.md` lists from `readdirSync` (matching the existing
pattern for roles/test files/docs) instead of a hand-maintained category
list, so the two describe blocks below it (the last-line/low-collision
anchor-rule check and the "carries an anchor" erosion brake) now cover
every module in both directories automatically.

Before/after, measured on the working tree with the extended `RESOLVE`
map but before any doc edit (`npx vitest run test/docs-consistency.test.ts
-t "kit-source category"`): 142 unanchored full citations into the eight
newly-covered categories (`src/init.ts` 68, `src/cli.ts` 19, `src/writers.ts`
12, `src/uninstall.ts` 10, `src/opencode.ts` 4, `src/assets.ts` 1,
`assets/templates/*.md` 19, `assets/agents-md-section.md` 9), matching
the count log.md's prior entry named. All 142 anchored; the same command
against the anchored, committed tree reports 0 missing. The full suite
(`npx vitest run`, committed tree) is 290/290 green (superseded below by
291/291, then 293/293 -- see the review round 3 correction at the end of
this entry); the erosion brake's
own sanity floor (`examined ${n} in-scope citations`) reads 313 on this
tree (raised from 150 to 300 in a follow-up commit, since 150 gave far
more headroom than intended once the scope grew; the 300 figure was
itself superseded two commits later by a 200 floor -- see the review
round 3 correction at the end of this entry for why and for the
committed value).

Two citations needed re-pointing rather than a plain anchor, both
verified by direct read against the current source, not assumed:
`install-fence-mechanics.md`'s citation at line 343 of `init.ts` (cited
for "`init.ts` uses [the manifest] as the upgrade baseline (`previous`,
[that same line])") had drifted onto `composeOpencodeAgentVariant`'s
signature close (`): string {`); the actual
`const previous = readInstalledManifest(targetDir);` assignment is at
line 376 of `init.ts`, re-pointed there. `model-preselection.md`'s
citation at line 513 of `init.ts` (the Claude-side tier-skip `continue`
guard) is byte-identical across four sites in the file (424, 448, 513,
545: `if (tier === DEFAULT_TIER[role]) continue;`), so no substring of
that single line can be a <=3-occurrence anchor; widened to `513-516` to
land on `composeClaudeAgentVariant(role, tier),`, the Claude-specific call two
lines below it (unique in the file), consistent with the doc's own
"Claude Code" annotation for that citation.

Differential probe (k-line insertion at the top of `src/init.ts`,
uncommitted, reverted after each measurement; `git status --short`
confirmed clean before and after):

- This bundle's own load-bearing test (`every string anchor's text
  occurs on the last line of its own cited range`, last-line rule):
  k=1 fires all 68/68 of the newly anchored `src/init.ts` citations red;
  k=2 also fires (checked, not separately counted, since k=1 already
  saturates at 68/68). Confirms the design intent this round inherited
  from 578f5bfd round 2 (last-line anchoring defeats any k>=1 shift)
  holds for the newly anchored categories, not only the original four.
- `okf-kit check --json docs/okf` (v0.7.0, the same pin CI installs),
  filtered by the CI gate's own jq rule (message matches
  `\[anchor-[a-z-]+\]$`): baseline (unmutated, committed tree) is 0
  anchor findings, 35 total findings (all pre-existing, unrelated --
  `unresolved-ambiguous` on bare basenames the doc never disambiguates
  with a full path first, plus `*.test.ts`-target quality findings; byte-
  identical before and after this task's own doc edits). At k=1: 41/68
  `src/init.ts` citations fire an `anchor-*` rule specifically. At k=2:
  49/68. The remaining 27 (k=1) / 19 (k=2) are not silently missed by
  okf-kit: `checkAnchor` (`citations-resolve.ts`) does detect the same
  drift, but `checkTarget` reports only the first structural problem it
  finds per citation, and a 1-2 line top-of-file shift frequently lands a
  citation's *start* line on blank or `}`/`);`-only content first,
  producing `blank-start-line` or `closing-brace-start-line` instead of
  reaching the anchor check at all. Those two rule ids are not matched by
  the CI gate's `anchor-*` filter, so they do not fail the
  `okf-anchor-guard` job -- but the drift is not invisible to okf-kit
  overall: total findings naming an `init`-family target rose from 26
  (baseline) to 90 (k=1) / 87 (k=2). This is a real, measured gap between
  "this bundle's own erosion brake" (100% k>=1 coverage, verified above)
  and "the specific CI gate filter" (partial coverage, bounded by
  okf-kit's own per-citation first-problem-wins reporting) -- out of
  scope for this task per its own brief (native anchor-discipline
  changes belong to okf-kit itself, agent-tasks 1616974f), named here so
  it is not silently rediscovered.

`okf-kit check --json` against the anchored, committed bundle (no
mutation): 0 `anchor-*` findings, 35 total (identical set to the
unmodified-scope baseline above, confirmed by diffing the two reports'
message lists). `placement-guard`
(`node packages/slop-detector/dist/cli.js check . --pack placement-slop
--config slop.config.yml`, root `slop.config.yml`) is clean; `docs/okf/**`
is on that config's own exclusion list already (package READMEs and the
two named instruction globs are the only covered paths), unaffected by
this task's docs/okf-only edits.

Corrected 2026-08-26 (agent-tasks ca9d5048 review round 2). This entry's
own "35" total was measured against a tree where three of this same
entry's prose paragraphs above wrote bare `path.ext:N`-shaped references
(no leading `packages/orchestrator-workflow/` path) to lines 343, 376,
and 513 of `init.ts` as if citing directly, which `okf-kit check` itself
parses as citation attempts into `docs/okf/log.md` and reports as
`unresolved-ambiguous` (the line-343 one used twice) -- four extra
findings the round-1 author did not account for, so the true base on
that round's committed tree was 39, not 35. Fixed by rewriting those
three references in prose form ("line 343 of `init.ts`") in this entry's
own text above, so the entry no longer adds findings about itself.
Re-measured on the current commit (after
this round's re-pointing and cleanup fixes, `npx vitest run`, `okf-kit
check --json packages/orchestrator-workflow/docs/okf`, `git status
--short` clean before and after): `npx vitest run` is 291/291 green
(one test added, the in-range-uniqueness assertion); the erosion brake's
sanity floor (`examined ${n} in-scope citations`) reads 314 (the
`uninstall.test.ts` PRUNE_CANDIDATES-adjacent citation into the
"never deletes an escaping path" traversal tests was split from one wide
citation into two narrower ones during the in-range-uniqueness fix,
adding one to the examined count); `okf-kit check`
reports 0 `anchor-*` findings, 50 total.

The differential probe's "init-family" total above (baseline 26 -> 90
k=1 / 87 k=2) did not name the filter that produced it, so it does not
reproduce under a plain re-run of the same command. Re-measured this
round with an explicit, stated filter -- `jq '[.findings[] | select(.detail
| test("init\\.(ts|test\\.ts)$"))] | length'` against `okf-kit check
--json`'s output, matching on the finding's `resolvedTo` (`.detail`)
ending in `init.ts` or `init.test.ts`, the two files this task's own
"init-family" phrase means -- against the current commit: baseline
(unmutated) 27; k=1 (one dummy line at the top of `src/init.ts`,
uncommitted, reverted after) 99; k=2 (two dummy lines) 96. Different
absolute numbers than round 1's 26/90/87 are expected: this round
re-pointed and widened several `init.ts` citations, changing which and
how many findings a top-of-file shift produces against them; the filter
is now stated so the next re-measurement does not have to guess it again.

The bundle carries unanchored citations into two files deliberately kept
out of the anchoring scope: `README.md` and `INSTALL-AGENT.md` are the
package's own published, human-facing docs, not kit-source files the
installer writes into a target repo, so they do not belong in
`anchorScopeResolve()` alongside `SKILL.md`/agent templates/`models.ts`/
`test/*.test.ts`/`src/*.ts`/`assets/templates/*.md`/
`agents-md-section.md` (all of which ARE installer output or its direct
source). This is an explicit allowlist, not an oversight: measured this
round (`grep -ohE '\bREADME\.md:[0-9]+(-[0-9]+|,[0-9]+(-[0-9]+)?)*'` and
the same pattern for `INSTALL-AGENT\.md`, across the five docs/okf
siblings excluding `log.md`), the bundle carries 8 unanchored `README.md`
citations and 11 unanchored `INSTALL-AGENT.md` citations, none flagged
by the erosion brake (`RESOLVE[citedPath]` returns `undefined` for
both, so the loop `continue`s before counting them as examined or
missing) and none intended to be: both files are covered instead by the
existing warn-only `okf-staleness.yml` drift watch and by
`test/docs-consistency.test.ts`'s own dedicated README/INSTALL-AGENT
content checks (role-enumeration, brace-list, and manifest-example
assertions elsewhere in this file), not by the anchor mechanism this
bundle adds.

Corrected 2026-08-26 (agent-tasks ca9d5048 review round 3). The round-2
correction above (`291/291`, sanity floor `314`, base `50`) is itself
now superseded on the committed tree: this round's CHANGELOG fix and its
own new test add two more, `npx vitest run` is 293/293 green (`examined
${n} in-scope citations` reads 315: the `uninstall.test.ts` "never
deletes a file outside the target, even with a matching hash" case
gained its own citation, this round's MEDIUM 4 below).

The erosion brake's own sanity-floor comment, corrected above to say
"raised from 150 to 300", was itself stale: the actual asserted floor on
the committed tree (`expect(examined).toBeGreaterThan(200)`,
`test/docs-consistency.test.ts`) is 200, not 300. 300 was the value
`6dff6f0` set; a later commit in the same round (`dffe2bd`) lowered the
assertion to 200 (its own commit message: "raises the erosion-brake
sanity floor's comment to match a 200 floor") without the log entry
above being updated to match. 200 still holds comfortably below the
live count of 315.

Review round 2's HIGH 1 (the CHANGELOG citation drift this round fixes)
traces to a real edit, not a hypothetical: the `[Unreleased]` bullet
naming this round's own widened `src/**`/`assets/templates/**` scope
(`CHANGELOG.md:219#"the keyed placeholder line's exact text,"`,
re-pointed by 38 lines since this account was first written, by T-002's own
fix-round-1 `[Unreleased]` insertion above it, the earlier +2-line shift
from the 0.27.0 release commit inserting the `## [0.27.0]` heading above
it, the +2-line shift from the 0.28.0 release commit inserting
the `## [0.28.0]` heading above it, this bundle's own fix-round-2
CHANGELOG.md edit above it (net +7 lines: the probe-replay Unreleased
bullet grew from 8 to 13 lines), and (round 2 of the identifier-drift
task, after the T-002 rebase) a further +10-line shift from this task's
own identifier-drift `[Unreleased]` bullet inserted above it (re-pointed
in this same edit, restoring `okf-kit check`'s 0-error/1-warning/23-notice
baseline) grew
by a net 3
lines relative to the pre-round-2 base commit (`5a33adb`, `git diff
--stat 5a33adb -- CHANGELOG.md`: 17 insertions, 14 deletions), shifting
every `## [x.y.z]` heading below it by exactly 3 lines uniformly (
verified against every heading in the file, not only the ones the 16
citations target). None of the 16 heading-anchored citations into
`CHANGELOG.md` across `subagent-contracts-superset.md`,
`review-gate-and-waivers.md` and `run-state-lifecycle-and-markers.md`
were re-pointed at the time: `okf-kit check --json` on that committed
tree reports 50 findings (35 pre-existing plus 15 new
`blank-start-line` ones -- one of the 16 citations' start line still
landed on real content after the shift, so it did not trip this
particular rule id, consistent with `citations-resolve.ts` reporting
only the first structural problem per citation). Fixed this round by
shifting all 16 citations by the same uniform +3 (every base-tree
heading line was confirmed to shift by exactly +3, so the brief's
literal shifted values applied directly); re-measured on the committed
tree, `okf-kit check --json packages/orchestrator-workflow/docs/okf`
reports exactly 35 findings again, and the sorted finding-message list
is byte-identical to the one from a clean checkout of the `5a33adb` base
tree (`git archive 5a33adb`, extracted and `git init`-ed into a scratch
directory so okf-kit's own repo-root detection resolves correctly, then
diffed against the committed tree's report -- empty diff).

This round also re-points several `src/**`-targeting citations that
`dffe2bd` (the prior round's in-range-uniqueness fix) already
re-pointed on the committed tree before this round started; they are
not this round's own work, but are recorded here since the prior
2026-08-26 entries above did not enumerate them and later readers
diffing against those entries would otherwise wrongly attribute the
drift to this round. Confirmed present and well-formed on the committed
tree (spot-checked by direct read against `init.ts`/`cli.ts`, not
assumed from the commit message alone): line 376 of `init.ts`
(`readInstalledManifest(targetDir)`, the upgrade-baseline citation),
line 393 (`previousHarnessDirs`), lines 404-405
(`droppedRoles`'s filter), lines 470-473 and 474-476
(the unedited/conflicted branches of `installKitFile`), line 563
(`opencodeEffortLine`'s post-guard call site), and lines 229-230 of
`cli.ts` ("Found existing install"). A full re-derivation of "how many of the
142 `src/**`/`assets/templates/**` citations `2ba4a09` originally
anchored were later re-pointed by `dffe2bd`" was attempted this round
(a script mirroring `anchorScopeResolve`'s category list and
`ANCHOR_CITATION_RE` against both commits' `docs/okf/*.md`) but did not
reproduce a clean, independently-verified total: the script's own
citation count (130) did not match the 142 the original anchoring round
measured, so a derived change-count from it is not reported here as a
verified number. What is verified, by direct `git show dffe2bd --
docs/okf/` inspection: at least 24 prose lines across the five
docs/okf siblings each carry one or more re-pointed citation ranges (a
line-level count, not a per-citation one, since several lines each pack
multiple citations); a fuller per-citation total is left unmeasured
rather than asserted.

MEDIUM 1 (this round): added a test guarding the CHANGELOG.md
heading-anchor family directly (`test/docs-consistency.test.ts`, describe
"every heading-anchored CHANGELOG.md citation's range stays inside its
own release section"), mirroring `citations-resolve.ts`'s
`findEnclosingHeading`/`anchor-heading-does-not-enclose` resolution: a
citation's nearest enclosing `## [` heading at or before its start line
must match the cited version, and no `## [` heading may start before the
range's end line. Verified red against the HIGH 1 bug class and green
after the fix; a 1-3 line top-of-file insertion does not turn it red (by
design -- this mirrors okf-kit's own tolerance for small in-section
drift, matching why round 2's own HIGH 1 bug tripped only 15 of 16
citations rather than all 16 under a 3-line shift), a 20-line insertion
does (all 16, measured directly, reverted after).

MEDIUM 2 (this round): the prior round's `test/docs-consistency.test.ts`
it-title read "...not direct implementation orders" instead of "...not
implementation instructions", changed to dodge an anchor collision
rather than fix the docs (source must not be edited to satisfy an
anchor). Reverted the title. The two `subagent-contracts-superset.md`
citations that had collided on it (originally `536-741` and `738-741`,
both anchored on `"not implementation instructions"`) could not be
re-anchored on the brief's suggested full assertion line
(`expect(unwrapped).toContain("not implementation instructions");`) as
literal anchor text: the citation grammar's quoted string form
(`#"[^"\n\`]*"`) cannot itself contain a double-quote character, and
that line contains one around its string argument. Narrowed both
citations' start line to 739 instead (past the it-title line, which
also contains the phrase and was the actual source of the two
in-range occurrences), keeping the same anchor text and the same end
line (741, already the section's true last line). Verified: `every
string anchor's text occurs exactly once inside its own cited range`
passes for both.

MEDIUM 4 (this round): `install-fence-mechanics.md`'s uninstall-loop
citation named only two of the three path-traversal test cases
(`test/uninstall.test.ts:162-170` and `:173-185`) while the prose
claimed all three were covered. Added the missing third
(`test/uninstall.test.ts:147-159#"rmSync(victim, { force: true });"`,
the "never deletes a file outside the target, even with a matching
hash" case); the anchor occurs at lines 159, 170 and 185 file-wide (3,
at the cap) and exactly once inside 147-159.

LOW 6a (this round, attempted, reverted): the brief suggested narrowing
`install-fence-mechanics.md`'s `PRUNE_CANDIDATES` citation
(`uninstall.ts:99-119#"export function runUninstall(options: {"`,
spanning two declarations) to end at 113 on
`join(".opencode", "agents"),`. That anchor text is unique in the file
(1 occurrence) but, like MEDIUM 2 above, contains embedded double
quotes and cannot be expressed in the citation grammar's quoted-string
form; attempted and confirmed broken (`anchor text occurs 0 times
inside its own cited range`, since the parser truncates at the first
embedded quote) before being reverted. Kept as `99-117`, matching
`dffe2bd`'s own prior restoration of this same wide range (that round's
commit message: "restores a PRUNE_CANDIDATES ... range that had been
narrowed past the code the doc actually describes").

Final accounting on the committed tree after all of this round's fixes
(`npx vitest run`, `npm run typecheck`, `npm run typecheck:test`, `npm
run format:check`, `okf-kit check --json
packages/orchestrator-workflow/docs/okf`, `node
packages/slop-detector/dist/cli.js check . --pack placement-slop
--config slop.config.yml`, `git status --short` clean before and after
each measurement): 293/293 tests green; typecheck and typecheck:test
clean; format:check reports the same 2 pre-existing warnings named in
this task's own brief (`test/docs-consistency.test.ts`,
`test/template-markers.test.ts` -- both pre-date this round, confirmed
by checking a fresh `git show HEAD:.../docs-consistency.test.ts` copy
still fails `prettier --check` before this round's own edits are
applied); `okf-kit check` reports exactly 35 findings, byte-identical
(sorted message list) to the `5a33adb` base tree; `placement-guard`
clean (395 files scanned).

- 2026-08-27 (agent-tasks 8c89aa12): the `okf-anchor-guard` CI job's
  "Anchor-citation guard" step now runs `okf-kit check --json
  "${BUNDLE_PATH}" --require-anchors --require-anchors-allow '*README.md'
  '*INSTALL-AGENT.md'` instead of a plain `check`, adopting the four
  opt-in `--require-anchors` rules (`anchor-required`,
  `anchor-not-on-last-line`, `anchor-not-unique-in-range`,
  `test-range-straddles-block`) landed on this tree's `[Unreleased]`
  okf-kit source (still version-labeled 0.7.0 in `package.json`; not yet
  published under any version, so the job's own `npm install -g
  okf-kit@0.7.0` pin is left unchanged rather than bumped to a
  not-yet-existing 0.8.0, which would desync it from
  `packages/okf-kit/package.json`'s real version and fail "every
  okf-kit@<version> pin under .github/workflows/ matches package.json";
  `okf-anchor-guard` is expected to go red at its real "Anchor-citation
  guard" step once it runs against the actually-installed published
  okf-kit, until an okf-kit release ships `--require-anchors` under
  whatever version this pin is bumped to). The job's `anchorFindings` jq
  filter (both the self-test step and the real guard step) was widened
  from `\[anchor-[a-z-]+\]$` to `\[(anchor-[a-z-]+|test-range-straddles-
  block)\]$`, since `test-range-straddles-block`'s rule id does not start
  with `anchor-`. The `--require-anchors-allow` allowlist uses
  `*README.md`/`*INSTALL-AGENT.md` globs rather than the bare exact
  strings: this bundle cites both docs under two different spellings
  (bare README.md line 121 as the file stood then, and the fully-qualified
  `packages/orchestrator-workflow/README.md:108-112`/`INSTALL-AGENT.md:46-
  47`), and the exact-string form left the two fully-qualified citations
  reporting `anchor-required` (measured: `okf-kit check --json
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md INSTALL-AGENT.md` reports 2
  `anchor-required` findings; the glob form reports 0). Locally measured
  against the committed tree (built `packages/okf-kit/dist/cli.js`,
  `node packages/okf-kit/dist/cli.js check
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow '*README.md' '*INSTALL-AGENT.md' --json`):
  exit 0, 35 total findings, 0 of the widened anchor-rule filter's
  findings (matching the pre-existing `okf-kit check` baseline of 35).

  [Round-2 correction, agent-tasks 8c89aa12 fix round]: "35 total
  findings" above was measured before this round's own commit landed;
  `git log`-based `sources-fresh` staleness only starts counting once
  `test/docs-consistency.test.ts`'s edit is actually committed, so the
  pre-commit measurement above did not yet see it. Measured fresh on
  this commit (`node packages/okf-kit/dist/cli.js check --json
  packages/orchestrator-workflow/docs/okf`): 40 total findings (36
  `citations-resolve`, delta +1 from the 35 base; 4 `sources-fresh`
  STALE, delta +4 from 0), all 4 STALE on `model-preselection.md`,
  `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
  and `subagent-contracts-superset.md` against `test/docs-consistency
  .test.ts`. See this round's own entry below for the re-verification,
  re-stamp, and the count after the fix.

  Mutation probes (each applied then reverted, `git status --short`
  clean before and after): a one-line insertion at the top of
  `src/init.ts` shifted 40 previously-anchored citations' ranges and the
  filter reported 40 findings (0 after revert); stripping the `#"typeof
  candidate.installedAt ==="` anchor from
  `install-fence-mechanics.md`'s citation into `init.ts` (lines 115
  through 181) produced 1
  `anchor-required` finding (0 after revert); re-anchoring that same
  citation on `"readInstalledManifest"` (its range's first line, not its
  last) produced 1 `anchor-not-on-last-line` finding (0 after revert).

  `test/docs-consistency.test.ts`'s local anchor assertions: the
  "has zero unanchored citations into SKILL.md, an agent template,
  models.ts, src/*.ts, a test file, or an assets/templates/*.md or
  agents-md-section.md run template" test (the review-round-2 MEDIUM 5
  erosion brake for `anchor-required`) is dropped as a redundant double
  guard: okf-kit's native `anchor-required` (now running in CI) checks a
  strict superset of the same ground. Its sibling "examined N in-scope
  citations" sanity test is kept (it guards this file's own citation-
  collection machinery, not anchor-required itself). Three local checks
  are kept as deliberately stricter variants rather than dropped, each
  now commented in place with the specific gap it closes beyond okf-kit's
  native rule: "every string anchor's text occurs on the last line of its
  own cited range" (local: the range's actual last line; okf-kit's
  `anchor-not-on-last-line`: the last CONTENT line, skipping trailing
  `});`-style boilerplate), "every string anchor's text occurs exactly
  once inside its own cited range" (local: counts substring occurrences;
  okf-kit's `anchor-not-unique-in-range`: counts matching lines), and
  "every full citation into a *.test.ts target stays inside one
  describe/it/test block" (local: real TypeScript-compiler-API block
  boundaries; okf-kit's `test-range-straddles-block`: a line-based
  heuristic that documents its own gap on a range ending on an outer
  block's closing line with no further block-head line inside it).

  [Round-2 correction, agent-tasks 8c89aa12 fix round]: the "strict
  superset" premise two paragraphs up is wrong and this task's round 2
  reverses the drop it justified. okf-kit resolves a bare basename
  citation via the citing doc's own frontmatter `sources` list first,
  and only falls through to a repo-wide basename search when that
  doesn't disambiguate; when the repo-wide search is ALSO ambiguous
  (more than one file shares the basename), okf-kit reports
  `unresolved-ambiguous` and skips every other check for that citation,
  `anchor-required` included -- it is exempt from the native guard, not
  covered by it. The local "has zero unanchored citations..." assertion
  has no such escape hatch (`anchorScopeResolve()` binds every kit-source
  basename unconditionally), so it is not redundant. See this round's own
  entry below for the restoration and the mutation probe (M1) that
  demonstrates the gap.

  Verification on the committed tree after these edits: `npm test`
  (packages/orchestrator-workflow) 292/292 tests green (one fewer than
  the prior 293, the dropped assertion); `npm run typecheck` and
  `npm run typecheck:test` clean; `npm run format:check` reports the
  same 2 pre-existing warnings as the prior round
  (`test/docs-consistency.test.ts`, `test/template-markers.test.ts`);
  `node packages/slop-detector/dist/cli.js check . --pack placement-slop
  --config slop.config.yml` clean (406 files scanned). The real CI
  workflow YAML was not run under `act`; the "Self-test the anchor-
  finding filter" and "Anchor-citation guard" steps' shell logic was
  reproduced locally instead, against the same built okf-kit CLI, with
  the same clean/drifted-fixture and real-bundle results reported above.

- 2026-08-27 (agent-tasks 8c89aa12 fix round, implementer): review found
  10 findings (3 HIGH, 4 MEDIUM, 3 LOW) against the prior entry's
  `okf-anchor-guard` adoption. This round addresses all 10.

  HIGH (self-test coverage): the self-test fixture only exercised the
  two pre-existing anchor forms (heading, string) and never proved the
  jq filter's widened `test-range-straddles-block` match actually fires,
  despite a comment claiming it did. The fixture now also carries one
  deliberate violation of each of the four opt-in rules
  (`anchor-required`, `anchor-not-on-last-line`,
  `anchor-not-unique-in-range`, `test-range-straddles-block`), each
  asserted with its own `>= 1` count so no rule can pass by riding
  another's finding. The two pre-existing violations are still produced
  by drifting the same two citations' ranges (as before); the four new
  ones are appended fresh rather than derived by drift, since "carries
  no `#anchor` at all" has no valid form to drift from. Both self-test
  `okf-kit check` calls now also pass `--require-anchors` (they did not
  before, which meant the opt-in rules could never have fired in the
  self-test regardless of the fixture). Verified by extracting the
  step's actual `run:` script from the committed YAML via `python3 -c
  "import yaml; ...; s['run']"` (not hand-copied) and executing it
  standalone against the built `packages/okf-kit/dist/cli.js`: "Self-test
  OK: 1 heading-form, 1 string-form, 1 anchor-required, 1
  anchor-not-on-last-line, 1 anchor-not-unique-in-range, 1
  test-range-straddles-block finding(s) against the drifted fixture."
  (exit 0); the pre-drift, pre-append run reports 0 (exit 0). Mutation
  probe M3 (removing the `anchor-not-unique-in-range` violation from the
  fixture's append step, reverted after): the self-test fails
  (`title=OKF anchor guard self-test failed`) with `anchor-not-unique-
  in-range` at 0 and every other count still 1 -- confirms the six
  counts are independent, not one rule silently riding another's
  finding. A second probe removing the `test-range-straddles-block`
  violation instead shows the same isolation (that count alone drops to
  0, the other five stay at 1).

  HIGH (sequencing comment, placement): the "Install okf-kit (exact
  pin)" step comment carried the full sequencing rationale (why the pin
  stays at 0.7.0, why the job is expected to go red) inline; per this
  bundle's own placement convention (rule in the workflow file, evidence
  in the log), that comment is trimmed to the rule plus a one-line
  pointer to this file. The `docs-consistency.test.ts` comments that
  named a specific `okf-kit 0.8.0` version (4 places: the
  `anchor-not-on-last-line` variant, the `anchor-not-unique-in-range`
  variant, this entry's own erosion-brake comment, and the
  `test-range-straddles-block` variant) now say "okf-kit's
  `--require-anchors`" instead, since the actual release this pin ends
  up bumped to is an orchestrator decision made outside this task (a
  merge conflict on the pin line, resolved toward the release branch
  that ships the feature), not necessarily 0.8.0.

  HIGH (false "strict superset" premise, tests): see the round-2
  correction inserted directly above this entry for the full technical
  reason (okf-kit's frontmatter-`sources`-based basename disambiguation
  falls through to `unresolved-ambiguous`, which skips `anchor-required`
  entirely, when a repo-wide basename search is itself ambiguous). The
  dropped "has zero unanchored citations into SKILL.md, an agent
  template, models.ts, src/*.ts, a test file, or an assets/templates/
  *.md or agents-md-section.md run template" assertion is restored
  verbatim (the `missing` array and its `it(...)`), with the comment
  above the `describe` block corrected to explain the real (narrower)
  strictness gap instead of the false superset claim. Mutation probe M1
  (an unanchored full citation into SKILL.md's line 10, no anchor,
  appended to `install-fence-mechanics.md`, whose own frontmatter
  `sources` does not list SKILL.md; reverted after): the restored local
  assertion fails -- the `missing` array's one entry names
  `install-fence-mechanics.md` and the injected SKILL.md-line-10
  citation -- while
  `okf-kit check --json packages/orchestrator-workflow/docs/okf
  --require-anchors --require-anchors-allow README.md
  packages/orchestrator-workflow/README.md INSTALL-AGENT.md
  packages/orchestrator-workflow/INSTALL-AGENT.md` reports that same
  citation as ambiguous, not evaluated (`unresolved-ambiguous`,
  candidates: `packages/github-api-tool/SKILL.md`,
  `packages/orchestrator-workflow/assets/skill/SKILL.md`) and 0
  anchor-family findings for it -- exactly the "silently exempt, not
  covered" gap the restored assertion exists to close. `git status
  --short` clean before and after.

  MEDIUM (last-line vs last-content-line, correctness): the local
  "every string anchor's text occurs on the last line of its own cited
  range" check used the range's literal last line, while okf-kit's own
  `anchor-not-on-last-line` uses the last CONTENT line (skipping
  trailing closing-boilerplate lines like `});`,
  `packages/okf-kit/src/rules/citations-resolve.ts:464-494`). For a
  range ending on such boilerplate the two definitions actively
  disagree (a citation anchored correctly per one fails the other, and
  vice versa) -- e.g. `test/init.test.ts`'s lines 122 through 126, which
  end on a bare `});`; not a citation this bundle currently carries but
  illustrative of the shape. Fixed by porting okf-kit's own
  `CLOSING_BOILERPLATE_RE`/`isContentLine`/`lastContentLineInRange`
  logic into the test file (mirrored, not imported, so the test stays
  free of a runtime dependency on okf-kit's source layout) and using it
  in place of the literal last line; the test's own name and comment
  updated to say "last content line". `npx vitest run
  test/docs-consistency.test.ts -t "last content line"` passes against
  the real bundle unchanged (no citation needed re-pointing: every
  existing string anchor already sits on its true last content line).
  The two checks this file's other assertions still add beyond okf-kit
  (substring-not-line uniqueness, TS-AST-based straddle detection) are
  untouched.

  MEDIUM (sources-fresh STALE, correctness): `model-preselection.md`,
  `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
  and `subagent-contracts-superset.md` all list
  `test/docs-consistency.test.ts` as a frontmatter source and went STALE
  once the prior entry's own commit changed that file without
  re-stamping them. Each doc's citations into
  `test/docs-consistency.test.ts` were re-verified against this round's
  edited file: every one resolves at or before line 2386 (where this
  round's first insertion, the ported last-content-line helper
  functions, lands), so none of this round's edits shift any of their
  cited line ranges -- confirmed both by this bound (no edit in this
  round touches a line at or below the highest citation, 2024, before
  reaching that insertion point) and by `npm test` passing 293/293 with
  these citations' own load-bearing-anchor assertions included. No
  re-pointing was needed; each doc's frontmatter `timestamp` was bumped
  from `2026-08-26T23:59:00Z` to `2026-08-27T09:00:00Z` (after this
  round's own commit time) to clear the staleness.

  MEDIUM (finding-count correction): see the round-2 correction inserted
  into the prior entry above for the base/head numbers and why the
  prior entry's own "35" measurement missed the sources-fresh staleness
  it had just introduced.

  MEDIUM (mutation-probe discrimination, tests): the prior entry's
  `src/init.ts` insertion probe (M2, re-run this round for the record)
  reports the SAME count with and without `--require-anchors` --
  `node packages/okf-kit/dist/cli.js check --json
  packages/orchestrator-workflow/docs/okf` and the same command with
  `--require-anchors --require-anchors-allow README.md
  packages/orchestrator-workflow/README.md INSTALL-AGENT.md
  packages/orchestrator-workflow/INSTALL-AGENT.md` both report 40
  anchor-family findings, all `anchor-not-found-in-range` (a
  pre-existing, always-on rule, not one of the four opt-in ones) --
  so this probe alone does not discriminate the flag's own opt-in
  contribution. `git status --short` clean after revert. Probes for the
  two rules that specific probe missed
  (`anchor-not-unique-in-range`, `test-range-straddles-block`) are now
  permanent, not one-off: the self-test fixture (HIGH above) exercises
  both on every CI run, and mutation probe M3 above (plus the
  straddle-only variant) confirms each is independently discriminating.

  LOW (allowlist exactness, security): `--require-anchors-allow`'s
  `matchesAllowPattern` (citations-resolve.ts) does a plain
  `pattern === citedPath` string comparison whenever a pattern carries
  no `*`/`?`; the prior entry's `'*README.md' '*INSTALL-AGENT.md'` globs
  therefore also exempted any other file merely ending in those
  basenames. Replaced with the four exact spellings this bundle's own
  citation text actually uses: `README.md`,
  `packages/orchestrator-workflow/README.md`, `INSTALL-AGENT.md`,
  `packages/orchestrator-workflow/INSTALL-AGENT.md`. Measured
  (`node packages/okf-kit/dist/cli.js check --json
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md
  packages/orchestrator-workflow/README.md INSTALL-AGENT.md
  packages/orchestrator-workflow/INSTALL-AGENT.md`): 0 `anchor-required`
  findings (same as the glob form -- the prior entry's own "the
  exact-string form left the two fully-qualified citations reporting
  `anchor-required`" measurement used only `README.md INSTALL-AGENT.md`,
  missing the two `packages/orchestrator-workflow/`-prefixed spellings,
  not the two bare-vs-glob spellings it attributed the gap to).

  LOW (maintainability, follow-up named): the allowlist still exempts
  19 unanchored README.md/INSTALL-AGENT.md citations (measured:
  `okf-kit check --json packages/orchestrator-workflow/docs/okf
  --require-anchors` with no allowlist at all reports exactly 19
  `anchor-required` findings, all on those two basenames). Named as a
  staged follow-up in the guard step's own comment ("anchoring the 19
  citations this allowlist currently exempts, then dropping the
  allowlist entirely") rather than actioned here; the orchestrator
  tracks the follow-up task.

  LOW (doc direction, docs): the guard step's own comment said "see the
  Install step below" while the Install step is the very first step in
  this job, above the guard step -- fixed to "above". The four opt-in
  rule names are now spelled out once, in the Install step's own
  (trimmed) comment, so both the guard step's "named above" and the
  Install-step backward-reference are literally correct rather than
  pointing at a place that never actually enumerated them.

  Final accounting on the committed tree after this round's fixes
  (`npm test`, `npm run typecheck`, `npm run typecheck:test` in
  packages/orchestrator-workflow; `node
  packages/slop-detector/dist/cli.js check . --pack placement-slop
  --config slop.config.yml` from the repo root; `git status --short`
  clean before and after each measurement): 293/293 tests green (292
  from the prior entry's drop, +1 for this round's restoration);
  typecheck and typecheck:test clean; placement-guard clean (406 files
  scanned, same count as the prior entry). `okf-kit check --json
  packages/orchestrator-workflow/docs/okf` (no flag): 36 findings, all
  `citations-resolve`, 0 `sources-fresh` (down from the corrected head
  figure of 40: -4 STALE cleared by the re-stamp, citations-resolve
  unchanged at 36 [correction, round 3: this "36" and "unchanged at 36"
  were themselves off by 1 -- this entry's own mutation-probe prose a
  few paragraphs above still quoted install-fence-mechanics.md's
  citation into init.ts (lines 115 through 181) in the same backtick
  `path:N-M` citation grammar okf-kit's own scanner matches, which
  okf-kit's citation scan picked up as a real, unresolvable citation
  (`unresolved-ambiguous`) the same way the two examples the next
  commit (945ecdd) reworded were; that third offender was missed by
  945ecdd and reworded only in round 3 (see the round-3 entry below),
  which is when the true, self-consistent count of 35 -- matching the
  35-finding base this round started from -- was first measured]).
  With `--require-anchors` and the exact four-spelling allowlist: also
  36 findings total [same correction applies: 35], 0 of them in the
  anchor-family filter -- matching the guard step's own "Clean, 0
  anchor findings."
  The real CI workflow YAML was not run under `act`; both the "Self-test
  the anchor-finding filter" and "Anchor-citation guard" steps' `run:`
  scripts were extracted verbatim from the committed YAML via a small
  PyYAML script and executed standalone against the same built okf-kit
  CLI, with the results reported above.

## 2026-08-27 (agent-tasks 05b372d6, implementer)

Migrated the bundle's line-anchored, colon-hash-version-anchored CHANGELOG.md
citations (a path ending in .md, a colon, a line range, and a hash-prefixed
version anchor, e.g. lines 815 through 825 anchored to 0.7.4) to okf-kit
0.8.0's line-independent heading-section form (path.md:#[version], no line
range at all), alongside the okf-kit 0.8.0 release and its CI pin bump.
Grep for the literal string "CHANGELOG.md:" followed by a digit under
docs/okf/*.md found 19 occurrences on commit 48f809d (not the 16 an earlier
task text estimated); 17 were live navigational citations (5 in
review-gate-and-waivers.md, 6 in run-state-lifecycle-and-markers.md, 5 in
subagent-contracts-superset.md, and the 2026-08-24 entry's own citation
into the 0.9.0 section here in log.md, the last of these settled in the
fix-round-2 follow-up below) and were migrated. The remaining 2, both in
log.md (one near line 1975 quoting the old, already-superseded 0.7.0 line
range as "the un-shifted pre-round-1 ... citation", and one near line 2541
describing a diff by its old line range "grew by a net 3 lines"), quote a
specific historical/stale line range as prose data about a past diff, not
a live "read this section" pointer; converting either would misrepresent
what the entry is describing, so both were left as line-form by design.
Neither produces an okf-kit finding against the committed tree before or
after this round's edits (measured directly, see below).

review-gate-and-waivers.md's migrated 0.16.0 citation (the
acceptance_recommendation-specific one, formerly lines 552 through 576
anchored to 0.16.0)
gained a content anchor, quoting the phrase "as a hard-mandatory" (occurs
once in the 0.16.0 section), to keep pointing at that specific bullet
rather than the whole multi-bullet 0.16.0 entry now that the line-range
distinction from subagent-contracts-superset.md's sibling citation
(formerly lines 552 through 594 anchored to 0.16.0, covering the same section plus its
same-day R2 follow-up) no longer exists in heading-section form; the
sibling citation was left without a content anchor since it already meant
the whole section. The other 9 migrated headings (0.7.0, 0.7.3, 0.7.4,
0.9.0, 0.10.0, 0.11.0, 0.12.0, 0.14.0, 0.18.0) resolve to a single bullet
or a short, unambiguous section, so no content anchor was added for their
citations by default. Bracket form (heading text "[0.7.4]" rather than
bare "0.7.4") was used throughout, matching the form the task brief
suggested; it is a readability convention rather than a mechanism that
narrows the match, since `parseAnchor` strips the wrapping brackets before
`findHeadingSection` compares the anchor text against the heading's raw
text as a plain substring (confirmed by inserting a temporary
`## [10.7.4]` heading into the CHANGELOG: the bracketed `[0.7.4]` citation
reported `heading-section-ambiguous` too, identically to what a genuine
duplicate `## [0.7.4]` heading would produce; reverted after the
measurement). The actual protection against a superstring collision
(`10.7.4` swallowing `0.7.4`) is that okf-kit fails loudly on the
ambiguity rather than silently resolving to the first match.

Fix-round follow-up (review, F7): two migrated citations meant a narrower
part of their section than the whole thing and gained a content anchor to
say so. run-state-lifecycle-and-markers.md:55's `[0.9.0]` citation now
quotes "grounding-mcp 0.6.0 reads this marker" (occurs once in the 0.9.0
section); subagent-contracts-superset.md:259's `[0.18.0]` citation now
quotes "Concrete resume-over-respawn workaround" (occurs once in the
0.18.0 section). Both phrases were verified unique in their section by
direct grep before being added. Their sibling citations elsewhere in the
bundle (e.g. run-state-lifecycle-and-markers.md (then line 62)'s own `[0.9.0]`
citation) still mean the section as a whole and were left without a
content anchor.

test/docs-consistency.test.ts's describe block asserting that every
heading-anchored CHANGELOG.md citation's range stays inside its own
release section (added agent-tasks ca9d5048 review round 3 MEDIUM 1, as a
local backstop for exactly the line-drift class this migration eliminates
by construction) was removed rather than extended: ANCHOR_CITATION_RE, the
local regex it shares with the string-anchor tests above it, requires a
digit right after the citation's colon, so it cannot match the new
colon-hash heading-form citations at all; after this round's migration it
would find zero
CHANGELOG.md candidates among the five `ANCHOR_OKF_DOCS` (which excludes
`log.md`), making its own "found at least one ... (sanity: not vacuously
true)" check fail. Extending it to also parse and validate the heading form
would just re-implement okf-kit's own `findHeadingSection`/
`checkHeadingSectionTarget` a second time for a class of drift the
heading-section citation is immune to by construction (no line range to
walk out of its own release section), so removal was chosen over a
same-shaped rewrite.

Measured directly (this repo's own `okf-kit` build, `node
packages/okf-kit/dist/cli.js check packages/orchestrator-workflow/docs/okf`):
35 findings (0 errors, 13 warnings, 22 notices) against the committed tree
both before and after the citation migration, 0 of them naming
`CHANGELOG.md`, matching the pre-round baseline recorded in the okf-kit
0.7.0 CHANGELOG entry. M1 negative control: inserting a temporary 3-line
bullet at the top of `orchestrator-workflow/CHANGELOG.md`'s `[Unreleased]`
section (shifting every `## [x.y.z]` heading below it down by exactly 3
lines) produced 51 findings (16 new `blank-start-line` warnings, one per
still-line-anchored citation at the time) against the pre-migration tree,
and 35 findings (0 new) against the post-migration tree with the same
insertion; reverted after each measurement (`git diff` clean). M2:
retargeting one migrated citation's heading to a non-existent
`[0.7.99]` produced `heading-section-not-found`, reverted, back to 35. M3:
reverting `.github/workflows/ci.yml`'s `okf-kit@0.8.0` pin to `0.7.0`
failed `test/docs-consistency.test.ts`'s pin-sync test (1 failure), reverted,
back to 166/166 green. `npx vitest run` in `packages/orchestrator-workflow`:
291/291 green. `npm test`/`npm run build`/`npm run format:check` in
`packages/okf-kit`: 220/220 green, build clean, format:check reports the
same pre-existing `test/cli-symlink-invocation.test.ts` warning present on
`48f809d` before this round's own edits (confirmed via `git stash`), not
introduced by this round. `node packages/slop-detector/dist/cli.js check .
--pack placement-slop --config slop.config.yml` (the actual CI command for
this guard, not the generic `--explain` invocation): clean, 406 files
scanned, exit 0.

Follow-up on this same entry: the earlier okf-kit check count above (35,
unchanged) predates two fix-up passes over this very entry's own prose.
The first pass wrote several illustrative citation-shaped examples, a path
ending in dot-md, a colon, digits, and a hash-prefixed anchor, meant only
as generic prose, not as live citations; citations-resolve does not
require backticks to recognise a full citation, so those examples were
themselves parsed as citations, producing new findings (a nonexistent
target file, a malformed heading-section attempt, and misattributed
continuation citations from bare colon-number references to this entry's
own line numbers). Rewritten to avoid the path-dot-extension-colon-digits
shape and the backtick-delimited colon-hash shape entirely, using
spelled-out line numbers and plain prose instead; re-measured after the
rewrite: 36 findings, one new sources-fresh STALE warning on
model-preselection.md (it lists test/docs-consistency.test.ts under its
sources list, which this round's own guard-removal commit changed). This
warning appeared while the guard-removal edit sat uncommitted, ahead of
`sources-fresh`'s own `docCommitEpoch` exception (a doc is not flagged
STALE against a source that last changed no later than the doc's own last
commit); it would have cleared on its own once both landed in the same
commit, so the re-stamp below was precautionary rather than required.
Re-verified model-preselection.md's own two citations into that test file
(the README-table-row check near the top of the file, and the
pinned-default-effort guard describe block far past line 1700) still
resolve to the same content after the guard removal, since the removed
block sat well after both cited ranges; then re-stamped
model-preselection.md's frontmatter timestamp to 2026-08-27. Back to 35
findings, 0 naming CHANGELOG.md or model-preselection.md, matching the
pre-round baseline exactly.

Fix-round-2 follow-up (review findings F1, F2, F3, F4, F5, F6, F7, F8):
F5 was first resolved by reverting this entry's own historical
`CHANGELOG.md` citation of the `## [0.9.0]` section back to line-range
form; under that state the M1 negative control (the same 3-line
`[Unreleased]` insertion above) measured 36 findings (1 new), the reverted
citation's own `blank-start-line` warning, because a line-range citation
is never immune to a line-count shift above it. The orchestrator then
chose the other option named in the review: keep the heading-section form
and rewrite the sentence so it reads as history (corrected 2026-08-26 to a
heading-anchored line-range citation, migrated 2026-08-27 to the
line-independent heading-section form of the 0.9.0 section, with a content
anchor on the grounding-mcp sentence). With that edit all seventeen
navigational citations are migrated and immune; only the two historical
line-range quotes excluded above are not, and the count paragraph above
was corrected to say so (it briefly described the reverted intermediate
state). M1 re-measured after the edit: 35
findings, 0 new, 0 naming `CHANGELOG.md` (the insertion reverted, `git
status` clean). `okf-kit check` on the unperturbed committed tree
is unaffected (still 35 findings, 0 naming `CHANGELOG.md`, measured
directly).

F3's new `describe` block landed in `test/docs-consistency.test.ts`, one of
`review-gate-and-waivers.md`'s listed sources; that doc's three citations
into the same file (the review-gate-ships-in-policy block near line 110,
the review-gate-consequence check near line 399, and the
acceptance_recommendation-mandatory block near line 950) all sit well
before F3's append-only addition at the file's end, so none of their cited
ranges moved. Re-verified directly, then re-stamped
review-gate-and-waivers.md's own frontmatter timestamp to 2026-08-27 to
clear the resulting `sources-fresh` `STALE` warning (36 findings with the
warning present, back to 35 after the re-stamp).

## 2026-08-27 (agent-tasks 8c89aa12, merge + fix round 3, implementer)

Merged origin/master (agent-tasks 05b372d6, okf-kit 0.8.0 release plus the
CHANGELOG.md heading-section migration, PR #136, `e26594b`) into this
branch, then closed the round-2 review's five remaining findings (F1-F5)
in a second commit.

Merge: the anchor-finding jq filter's regex now unions all seven rule
families (this branch's four `--require-anchors` opt-in rules plus
master's new `heading-section-*` family); the self-test fixture exercises
all seven with one deliberate violation each, asserted separately; the
pin moved to `okf-kit@0.8.0`; the four docs/okf/*.md frontmatter
timestamps took the younger value per file (model-preselection.md:
master's `23:59:00Z`; review-gate-and-waivers.md,
run-state-lifecycle-and-markers.md, subagent-contracts-superset.md: this
branch's `09:00:00Z` -- both still well ahead of every commit made in
this round, measured below); log.md kept both append-only entry blocks
in their original order (this branch's two 8c89aa12 entries, committed
08:25 and 08:27 CEST, before master's 05b372d6 entry, committed 08:40
CEST).

F1 (HIGH, tests): the self-test step's two `okf-kit check` calls (clean
and drifted fixture) were fail-open on an empty or malformed report:
neither checked the CLI's own exit code, and `jq '[...] | length'` on a
0-byte file returns an empty string with exit 0 rather than erroring,
which then turns `[ "${count}" -ne 0 ]`/`-lt 1` into a shell usage error
inside an `if` condition -- exempt from `set -e` -- so the step fell
through to "Self-test OK" with every count variable interpolated as an
empty string. Fixed by mirroring the real guard step's own pattern on
both calls: capture `code=$?`, fail unless it is 0 or 1, `jq -e .` the
report before any count extraction, and reject a non-numeric count
explicitly via a shared `assert_numeric` shell function before it ever
reaches a `-ne`/`-lt` comparison. Mutation probes (self-test script
extracted verbatim from the committed ci.yml via the same PyYAML
approach the prior round used, run against swapped-in `okf-kit` shims on
PATH, ci.yml itself untouched by any of them): M1, a shim reproducing
okf-kit@0.7.0's exit-2-empty-stdout behavior on an unrecognized flag --
step now fails red (`exited 2`) instead of the old silent green; M2, a
shim returning exit 0 and valid JSON with no `findings` array -- step
now fails red (`jq: error ... Cannot iterate over null`) instead of
silent green; M3, removing the fixture's `anchor-required` violation
line -- step fails red and reports `0 anchor-required` specifically, the
other six counts unaffected, confirming per-family discrimination
survived the fix.

F2 (MEDIUM, docs): this branch's own prior fix-round entry (immediately
above) introduced a third citation-shaped backtick `path:N-M` phrase,
install-fence-mechanics.md's citation into init.ts (lines 115 through
181), inside its own mutation-probe prose; commit 945ecdd reworded the
other two offenders (the three repeated SKILL.md line-10
mutation-probe examples and the init.test.ts example spanning lines 122
through 126) but missed this third one, so the bundle's
own `okf-kit check` count stayed at 36 instead of the true 35, and the
prior entry's "Final accounting" section (its own "36 findings"/
"unchanged at 36" claims) was itself off by one the whole time --
corrected in place above, in brackets, pointing back to this entry.
Fixed by rewording the phrase to prose that does not match the citation
grammar (no `path:N-M` in backticks; while writing this correction, the
same mistake was made a second time by quoting the old phrase directly
and caught by re-running the check before this entry was finalized, so
this paragraph names the file and line range only in plain prose too).
Measured directly on this round's committed tree: `okf-kit check --json
packages/orchestrator-workflow/docs/okf` reports 35 findings (0 errors,
13 warnings, 22 notices), zero of them naming any init.ts range, matching
the pre-round base of 35 findings on `48f809d` this branch started from.
Also measured the new post-merge baseline this branch now inherits:
`okf-kit check --json packages/orchestrator-workflow/docs/okf` against a
throwaway worktree of master's own tip, `e26594b` (before this branch's
merge), also reports 35 findings (0 errors, 13 warnings, 22 notices) --
the two baselines coincide at 35 by chance, not because master's and
this branch's pre-merge bundles were byte-identical (master migrated the
CHANGELOG.md citations to heading-section form; this branch did not
touch bundle content at all before the merge).

F3 (MEDIUM, maintainability): closed during the merge itself (see
above) by taking master's pin comment, which never carried the
transient "this job is expected to go red" sentence tied to the
now-obsolete okf-kit@0.7.0 pin.

F4 (MEDIUM, maintainability): `test/docs-consistency.test.ts`'s
CLOSING_BOILERPLATE_RE/isContentLine/lastContentLineInRange mirror of
okf-kit's citations-resolve.ts had no coupling check and referenced the
source by a hardcoded line range ("464-494") that had already rotted to
472-497 by this round (an unrelated earlier edit shifted the source, and
nothing caught it). Replaced the line-range reference with a
symbol-name reference in both of the file's own comments, and added a
new test that extracts both copies by symbol name (`const
CLOSING_BOILERPLATE_RE` through the end of `function
lastContentLineInRange`), strips comments and blank lines from each, and
asserts byte-for-byte equality. Mutation probe M4: changing one
character in the local mirror's regex (`]*$` to `]*X$`) fails the new
test with a clear diff; reverted, full suite re-run green after revert
(`git status --short` clean before and after).

F5 (LOW): closed during the merge itself (see above); the union filter
now covers all seven families and the "wildcard covers future rules"
comment on the real guard step now says the anchor-* wildcard covers
only future anchor-* ids, with test-range-straddles-block and
heading-section-* matched by name.

Final accounting on the committed tree, after both the merge commit and
this fix commit (`npm test`, `npm run typecheck`, `npm run
typecheck:test` in packages/orchestrator-workflow; `npm test` in
packages/okf-kit; `node packages/slop-detector/dist/cli.js check . --pack
placement-slop --config slop.config.yml` from the repo root; the
self-test and Anchor-citation guard steps' `run:` scripts extracted
verbatim from the committed ci.yml via PyYAML and executed against the
locally built okf-kit CLI; `git status --short` clean before and after
each measurement): orchestrator-workflow 294/294 tests green (293 from
the merge, +1 for F4's new coupling test); typecheck and typecheck:test
clean; okf-kit 220/220 tests green (unaffected by this round);
placement-guard clean (406 files scanned, same count as the merge
commit); self-test reports 1 finding per family, 7/7 families green;
real guard reports 0 anchor findings, exit 0; `okf-kit check --json
packages/orchestrator-workflow/docs/okf` (no flag): 35 findings (0
errors, 13 warnings, 22 notices), matching both this branch's pre-merge
base (35 on `48f809d`) and master's post-merge baseline (35 on
`e26594b`, measured via a throwaway worktree of that commit, deleted
after).
## 2026-08-27 (agent-tasks 68faae5f, implementer)

Adds the "Review-round escalation budget" (`SKILL.md`, new section after
Round-2 halt rule; `agents-md-section.md` short form; `03-decisions.md`
new `review-round-escalation` marker) and a per-finding `recurrence: new
| repeated` field on the reviewer output contract (`SKILL.md` and
`reviewer.md`, byte-identical `findings:` block, new dedicated test).
Full rule content lives in the CHANGELOG's `[Unreleased]` entry and this
bundle's `review-gate-and-waivers.md` and `subagent-contracts-superset.md`
(new "Review-round escalation budget (this change)" and "Recurrence field
(this change)" sections); not repeated here.

Re-pointing: five source edits (`SKILL.md`, `reviewer.md`,
`agents-md-section.md`, `CHANGELOG.md`'s `[Unreleased]` insertion, and
this package's own `test/docs-consistency.test.ts` gaining three new
`describe` blocks) shifted line numbers under existing bundle citations.
Measured by matching each citation's `(target, anchor)` pair between the
pre-round tree (`48f809d`) and the committed tree and counting where the
`start`/`end` line numbers differ (a script comparison, not a hand
count): 71 citations were re-pointed total, 19 into `CHANGELOG.md` (a
uniform +44 shift, confirmed by the CHANGELOG's own `[0.24.0]` heading
citation test moving from line 127 to 171), 40 into `SKILL.md`, 7 into
`reviewer.md`, 4 into this file's own `test/docs-consistency.test.ts`
self-citations (a uniform +117 shift for citations at or past the
insertion point, verified against the file's own
`describe("round-2 halt rule ships in the skill", ...)` block's start
line staying put at 1071 while every line after the new blocks shifted),
and 1 into `agents-md-section.md`. Plus one bare non-anchored
`,211-212)` cross-reference inside a `run-state-lifecycle-and-
markers.md` citation's trailing prose, re-pointed the same way by hand
since it carries no machine-checked anchor. 15 further citations in the
new "Review-round escalation budget (this change)" and "Recurrence field
(this change)" sections are brand new (no pre-round counterpart), not
re-points.

Two re-point bugs found and fixed by a differential check, not assumed:
a pure per-anchor width-preservation script (new end line found by
search, new start = new end minus old width) mis-set two citation start
lines wrong by exactly the width of a mid-range insertion, both caught
by the same `okf-kit check` / docs-consistency last-line and
occurs-once-in-range tests this bundle already runs (not a new check):
`subagent-contracts-superset.md`'s Reviewer contract-location citation
(`SKILL.md` lines 319 to 341 computed, landed one line into a blank line
before the fence; correct is `318-341`, the `## Reviewer output contract`
heading, confirmed by direct read and by the `blank-start-line` okf-kit
warning that fired only on the wrong value) and its reproduction-field
citation (`reviewer.md:66-87` computed; correct is `65-87`, confirmed by
direct read against the pre-edit file, matching text "the implementer's
claim in the `reproduction` field. Deterministic checks" now sitting on
line 65). Both crossed exactly one insertion inside their own range,
which the plain end-anchor-search-plus-width-preservation approach
cannot detect on its own; every other re-pointed citation in this round
had both endpoints on the same side of every insertion it crossed and
needed no manual correction. Also found by the anchor-grammar check
(pre-existing, not new): two freshly-added citations used anchor text
containing embedded backticks (an `agents-md-section.md` citation
quoting `` `review-round-escalation` `` and a `reviewer.md` citation
quoting `` `new` `` / `` `repeated` ``), which the citation grammar's
quoted-string form cannot express (same limitation MEDIUM 2 and LOW 6a
in an earlier entry above hit); both narrowed to a backtick-free
substring on the same last line instead of reverting to a wider range.

Final accounting on the committed tree after this round (`npx vitest
run`, `npm run typecheck`, `npm run typecheck:test`, `node
packages/okf-kit/dist/cli.js check packages/orchestrator-workflow/docs/okf`,
`node packages/slop-detector/dist/cli.js check . --pack placement-slop
--config slop.config.yml`): 303/303 tests green (up from 293/293 before
this round's 10 new tests); typecheck and typecheck:test clean;
`okf-kit check` reports 35 findings (errors 0, warnings 13, notices 22),
byte-identical in count and composition to the pre-round baseline
measured on `48f809d` before any edit in this round; `placement-guard`
clean (406 files scanned, same as the pre-round baseline). `npm run
format:check` reports the same two pre-existing warnings named in the
prior round's entry (`test/docs-consistency.test.ts`,
`test/template-markers.test.ts`), confirmed unchanged by running it
against `48f809d` directly (`git stash` / `git stash pop`) before
touching either file in this round.

## 2026-08-27 (agent-tasks 68faae5f, implementer, review round 2 fixes)

Fixes ten review findings against the prior entry's change (F1-F10, all
medium/low, all addressed): re-verifies `install-fence-mechanics.md`
against its `agents-md-section.md` source edit and re-stamps its
timestamp (F1); pins the body text of all three escalation options, not
just their bold labels, in `test/docs-consistency.test.ts` (F2); drops
the `[Unreleased]` heading name from the `SKILL.md` citation and adds an
`assets/`-wide scan test guarding every installed asset against that
string (F3); adds a one-sentence definition of a counted round (a
completed reviewer return recommending `fix_required` or `reject`; a
misfired review does not count) to `SKILL.md` and
`agents-md-section.md`, pinned by a new test (F4); reshapes
`03-decisions.md`'s Review-round escalation section into a
Task/Choice/Reason table (placeholder row `n/a | n/a | n/a`, `Choice`
enum `n/a | tier_escalation | advisor | merge_hold`) so one run can
record the escalation choice per task instead of once for the whole
run, keeping the existing marker as a reader shortcut alongside it, both
pinned by new tests (F5); adds a Recurrence note to
`05-review-findings.md` next to the existing Reproduction note, pointing
at the reviewer contract's `recurrence` field and the escalation
budget, without touching the load-bearing Severity/Decision header row
(F6); names the models in the CHANGELOG evidence paragraph only (rounds
1-5 the default-tier implementer, Sonnet; round 6 Fable on `-xhigh`)
(F7); drops the "(this change)" suffix from both bundle section
headings and re-points their cross-link anchors (F8); rewords the tier-
escalation option to state the exhaustion condition explicitly (raise to
at least `-xhigh` where installed or the strongest available model; once
both are exhausted the choice falls to the advisor spawn or the
merge-hold) in both `SKILL.md` and `agents-md-section.md` (F9); and adds
the explicit "in addition to, not instead of" sentence tying the budget
to the halt rule's split-or-redesign response, in both copies (F10).

Re-pointing: the `SKILL.md` and `agents-md-section.md` edits (F4, F9,
F10) and the `test/docs-consistency.test.ts` / `test/template-markers.test.ts`
new tests (F2, F3, F5, F6) shifted line numbers under existing bundle
citations again. Measured the same way as the prior round (matching
each citation's `(target, anchor)` pair between the pre-round tree
(5700777) and the committed tree): 16 line-numbered citations
re-pointed (2 into `agents-md-section.md`, 6 into `SKILL.md`, 4 into
`test/template-markers.test.ts`, 3 into `test/docs-consistency.test.ts`,
1 into `03-decisions.md`'s narrowed single-line anchor) plus 2
heading-anchor renames (`review-round-escalation-budget-this-change` to
`review-round-escalation-budget`, `recurrence-field-this-change` to
`recurrence-field`, both cross-links between `review-gate-and-
waivers.md` and `subagent-contracts-superset.md`), 18 total. The
`CHANGELOG.md` evidence paragraph (F7) was rewrapped to keep the same
14-line span its content occupied before the edit (checked by diffing
line count against the pre-edit paragraph, not assumed), so none of the
heading-anchored `CHANGELOG.md` citations elsewhere in the bundle needed
re-pointing this round.

Correction to the prior entry: it reported 35 findings (errors 0,
warnings 13, notices 22) on the committed tree, but measuring the
actual 5700777 commit directly (a worktree checked out at that commit,
not the pre-commit working tree the prior entry was drafted against)
shows 36 (errors 0, warnings 14, notices 22), one more than claimed,
including a `sources-fresh` STALE finding on
`install-fence-mechanics.md` against its `agents-md-section.md` source
that F1 above now resolves.

Final accounting on the committed tree after this round (`npx vitest
run`, `npm run typecheck`, `npm run typecheck:test`, `node
packages/okf-kit/dist/cli.js check packages/orchestrator-workflow/docs/okf`,
`node packages/okf-kit/dist/cli.js check packages/orchestrator-workflow/docs/okf --json`
piped through the CI anchor-finding jq filter, `node
packages/slop-detector/dist/cli.js check . --pack placement-slop
--config slop.config.yml`): 311/311 tests green (up from 303/303 before
this round's 8 new tests); typecheck and typecheck:test clean;
`okf-kit check` reports 35 findings (errors 0, warnings 13, notices 22);
the anchor-finding jq filter returns 0; placement-guard clean.

## 2026-08-27 (agent-tasks 68faae5f, orchestrator, review round 3 fixes)

Review round 3 (after merging master, which carried the okf-kit 0.8.0
release and the heading-section migration of this bundle's CHANGELOG
citations) closed six findings in the fix commit d12d892: the recording
instruction in SKILL.md and agents-md-section.md now names the
03-decisions.md table row as the record and the review-round-escalation
marker as the derived shortcut; the advisor-spawn escalation carries its
install condition (full profile) and names the minimal-profile fallback
to the merge-hold; review-gate-and-waivers.md and the CHANGELOG state
that the marker's n/a default is deliberately fail-open; the orphaned
reason marker line left the 03-decisions.md template; a prettier
three-liner in the docs-consistency test became one line; a short
CHANGELOG line break was rewrapped; and a new test pins that SKILL.md
step 8 and the budget section name the same second-halt and third-round
thresholds. Thirteen citations into SKILL.md, agents-md-section.md and
the docs-consistency test were re-pointed for the line shifts.

The round-3 review found the same class as round 2's first finding once
more: the fix commit edited agents-md-section.md, a declared source of
install-fence-mechanics.md, without re-stamping that doc, so the
committed tree reported one sources-fresh warning (36 findings, 14
warnings). install-fence-mechanics.md was re-read against the current
agents-md-section.md (it describes the fence mechanics, not the section's
rules, and nothing it states drifted) and re-stamped in this commit.
Measured on the committed tree after this commit: `okf-kit check` 35
findings (errors 0, warnings 13, notices 22), 0 sources-fresh; the CI
anchor filter (anchor-* and heading-section-*) 0; the --require-anchors
run with the four allowlisted doc spellings 0; vitest 314/314; typecheck
and typecheck:test clean; placement-guard clean.

## 2026-08-28 (agent-tasks 2c3d141c, implementer, re-point pass for the .ai/run pointer commit)

Commit a2d5f85 (`design/ow-run-pointer-binding`, agent-grounding task
43a7ef58) added the per-worktree `.ai/run` pointer and the keyed
`run-base[<repo-basename>]` marker: SKILL.md's Run state gained a pointer
paragraph (84-92) and an extended run-base paragraph (94 -> 104-113),
step 1 gained a pointer sentence (123-124), and all three Harness notes
bullets gained a trailing pointer sentence (466-467, 469-470, 473-474);
agents-md-section.md's Run state gained one bullet (158-160); 00-goal.md
gained the keyed placeholder line at line 4; README.md and INSTALL-AGENT.md
each gained a `.gitignore` paragraph; and both test/template-markers.test.ts
(a new describe-internal block, 4 new `it`s) and test/docs-consistency.test.ts
(a new `describe` block, 8 `it`s) gained coverage. The CHANGELOG's own
[Unreleased] entry for that commit said re-pointing `docs/okf/*.md` anchors
was left to a follow-up; this task does that re-pointing in the same PR
instead, rather than shipping a second commit's worth of drift.

Re-pointing method: `git diff 9740c71..a2d5f85 -- <file>` per changed
source plus a `difflib.SequenceMatcher` line-mapping script (old line ->
new line, keyed by "equal" vs "replace"/"insert" opcodes) gave the exact
old-line -> new-line map for SKILL.md, agents-md-section.md, 00-goal.md,
README.md, INSTALL-AGENT.md, template-markers.test.ts, and
docs-consistency.test.ts; every re-pointed citation's new range was then
read back and diffed against the old range's content to confirm the cited
text itself did not change (only shifted), before the anchor text was kept
verbatim. Citations into files a2d5f85 did not touch (05-review-findings.md,
06-handoff.md, agents/*.md, src/**, CHANGELOG.md) were left alone.

Re-pointed citation lines by doc (counted mechanically as the number of
removed diff lines carrying an old `<file>:<range>` for a changed source,
so one line touching two sub-ranges of the same source counts once here):
subagent-contracts-superset.md 48 (32 SKILL.md-prefixed + 16
docs-consistency.test.ts-prefixed), review-gate-and-waivers.md 22 (19
SKILL.md, 2 docs-consistency.test.ts, 1 template-markers.test.ts;
agents-md-section.md citations in this doc all sat below a2d5f85's
insertion point and needed no change), model-preselection.md 13 (5
README.md, 6 INSTALL-AGENT.md, 1 agents-md-section.md, 1
docs-consistency.test.ts), install-fence-mechanics.md 6 (2 README.md, 4
INSTALL-AGENT.md), run-state-lifecycle-and-markers.md at least 14 (12
SKILL.md-prefixed lines across the run-base and Knowledge Bundle sections,
plus the template-markers.test.ts and INSTALL-AGENT.md combined-range
lines), plus the "Gotcha" and "Where the shapes are pinned" wording fixes
and the new pointer/keyed-marker section's own citations (12 new ones, all
into the changed sources). Citations whose cited range sat entirely before
a2d5f85's first insertion point in a given source (for example most
SKILL.md citations under old line 84, or any docs-consistency.test.ts
citation under old line 360) needed no change and were left untouched,
confirmed per-citation by the line-mapping script rather than assumed from
proximity.

A new section, "The `.ai/run` pointer and keyed `run-base[<repo-basename>]`
markers (0.26.0-unreleased)", was added to run-state-lifecycle-and-markers.md
between the existing run-base section and the verdict-markers section: the
pointer's location and fail-closed resolution order, the keyed marker's
grammar and its placeholder-line convention, that the unkeyed marker stays
the single-repo path and fallback, and which of the new
template-markers.test.ts/docs-consistency.test.ts tests pin what, each with
a string-anchored citation chosen to avoid the anchor-collision and
test-block-straddle guards (an anchor inside a repeated `expect(...)`
pattern, or a citation range crossing an `it()` boundary from outside any
enclosing block, both fail those guards; several draft anchors were
rejected this way before landing on ones unique to their own cited range
and to the target file as a whole). The doc's "Gotcha for anyone grepping
`solution-acceptance:`" section and its "Where the shapes are pinned"
section were both updated to state precisely that there are still three
`solution-acceptance:` marker KEYS, with the new keyed line being a fourth
LINE in the `run-base` key's family, not a fourth key. The frontmatter
gained `agents-md-section.md` as a source (already cited, previously
missing from the list) and the description/tags were extended to mention
the pointer and the keyed marker. `docs/okf/index.md`'s one-line summary of
the run-state module was extended with the same since-0.26.0-unreleased
note.

`npx vitest run test/docs-consistency.test.ts` was red before any doc edit
(3 failing tests: last-content-line anchor, anchor-occurs-once-in-range,
and the *.test.ts block-straddle check) and green (197/197) after all
re-points above; `npm test` 327/327; `npm run typecheck:test` clean.

`CHANGELOG.md`'s [Unreleased] entry for a2d5f85 had its trailing
"re-pointing... is left to a follow-up task" sentence replaced with a
sentence stating the re-point happened in the same PR and naming the new
run-state-lifecycle-and-markers.md section; nothing else in that entry
changed.

Measured on the first commit's tree (`packages/okf-kit` 0.8.0
`--require-anchors` with the CI allowlist for README.md/INSTALL-AGENT.md
bare ranges, mirroring the `okf-anchor-guard` CI job): 1 CI-gating anchor
finding, `run-state-lifecycle-and-markers.md`'s
INSTALL-AGENT.md citation (range 141 through 144 as the file stood then,
anchor text "repository's") in the new section --
the local in-repo vitest guard does not resolve README.md/INSTALL-AGENT.md
citations at all (`anchorScopeResolve()` has no entry for either), so it
cannot catch this class; only the real okf-kit tool did. Fixed by
narrowing the range to `141-143` (line 143 carries `repository's`; line
144 is `` `.gitignore`. `` alone, real content, not boilerplate, so
okf-kit does not walk back past it) in a second commit, re-measured on
that second commit's tree: 0 anchor findings / 0 sources-fresh / 0 errors
/ 36 warnings / 23 notices (37 warnings were measured on the first
commit's tree, before the narrowing). Warnings rose from the 13-warning
baseline to 36 and notices from 22 to 23: every new warning is
`test-range-start-not-head`, `closing-brace-start-line`, or
`blank-start-line`, a soft okf-kit heuristic (excluded from the CI-gating
anchor filter used above) that prefers a `*.test.ts` citation range to
start on a literal `describe(`/`it(` line; several re-pointed and newly
added citations here start mid-block instead, by choice, to satisfy the
stricter in-repo `docs-consistency.test.ts` anchor-uniqueness and
block-containment guards (see above). No new error or CI-gating finding
resulted.

Correction, same pass, orchestrator review of the re-point: the 36-warning
figure above was not a matter of choice. 22 CONTINUATION citations (the
`:NNN-NNN` short forms that follow a fully-qualified citation on the same
sentence: 19 in subagent-contracts-superset.md, 3 in model-preselection.md)
had not been re-pointed at all and still carried their pre-a2d5f85 line
numbers, so they resolved into the new run-pointer describe block (lines
359-462 of docs-consistency.test.ts) that none of those docs discuss.
Neither guard catches this class: okf-kit only warns
(`test-range-start-not-head`, `blank-start-line`,
`closing-brace-start-line`), and the in-repo docs-consistency guards check
anchored and fully-qualified citations only. Found by diffing the
per-message warning list against the pre-change baseline (13 warnings)
rather than trusting the category explanation; fixed by re-running the
difflib line map over continuation tokens too, accepting a move only when
the old range's content is byte-identical at the mapped position (three
ranges reflowed by prettier were mapped by block boundary instead:
lines 565 to 572, 126 to 150 and 152 to 159 of the two test files). Measured after the fix on the working
tree: 0 anchor findings / 0 sources-fresh / 0 errors / 14 warnings / 22
notices; the one warning above baseline is the historical bare
README line-105 spelling quoted in an older entry of this log, left as
written. Lesson
for the next re-point: continuation citations are citations too; map
them with the same script as the fully-qualified ones.

## 2026-08-28 (agent-tasks 2c3d141c, implementer, review round 1 fixes)

Review round 1 on the `.ai/run` pointer change found two inaccurate
claims (F1, F2), a discriminating-substring gap in four docs-consistency
tests (F3), two missing instructions (F4, F5), two wording nits (L6, L7),
a run-directory-location gap in the agents-md-section bullet (L10), and a
missing property test on the shipped keyed marker line (M1); L8 and L9
were accepted, not fixed.

F1: SKILL.md's Run state run-base paragraph (now lines 102 to 123) had
conflated two different failure modes under one "near-miss blocks as
malformed" claim. Split into two sentences: the grammar check (lowercase,
no space before the colon, exactly two dashes) still blocks as malformed,
but a keyed marker that is not on its own line, inside a list bullet or
prose, is not seen at all, so the binding goes silently missing instead.
The same split was applied to run-state-lifecycle-and-markers.md's own
paraphrase of that sentence.

F2: the same doc's claim that a real key left with the placeholder value
`<sha>` is ignored "along with" the placeholder key was wrong per the
reviewer's fixture measurement (a real key with value `<sha>` is read
as-is and blocked by the verdict layer, not ignored). Corrected to state
that only a placeholder key of the shape `<repo-basename>` is ignored as a
documentation example, and a real key with the placeholder value is not
ignored the same way, citing SKILL.md's own "until the placeholder key is
replaced" wording rather than asserting reader internals beyond what the
in-repo text says.

F3: the four pointer-doc tests in test/docs-consistency.test.ts (SKILL.md
Run state, README, INSTALL-AGENT.md write surface, and its manual
scaffold list) asserted the bare substring `.ai/run`, which a mention of
`.ai/runs/` alone also satisfies. Replaced with a phrase each source
sentence actually needs: `` `<worktree-root>/.ai/run` `` for the SKILL.md
test (this exact backtick-wrapped form appears only in the pointer
sentence) and `` `.ai/run` pointer `` for the other three (present in all
three target sentences, absent from a bare `.ai/runs/` mention). Verified
by deleting each target sentence in turn and confirming the corresponding
test fails, then restoring it and confirming the test passes again: the
SKILL.md Run state pointer paragraph, the README "What gets installed"
sentence, the INSTALL-AGENT.md Write surface bullet, and the
INSTALL-AGENT.md manual scaffold list bullet all round-tripped red then
green.

F4 and L6: the Run state pointer paragraph gained two instructions the
review found missing: when the run directory lives outside a touched
repository, that repository's completeness gate is armed only by the
pointer, so a missing pointer there means the gate silently does not
apply and the pointer must be written before the first implementation
commit (F4); and the pointer must be overwritten at the start of every
run, since the reader prefers a stale pointer left by an earlier run over
the newest-run scan, so it should be removed when no run is active (L6).

F5: the pointer paragraph's gitignore remark ("the pointer is
machine-local and belongs in `.gitignore`") was reworded as an
instruction: make sure the pointer is ignored (the repository's
`.gitignore` or `.git/info/exclude`) before writing it, and never commit
it. The README and INSTALL-AGENT.md sentences were left as they were, per
the task assignment.

L7: SKILL.md's "(or the main repository's basename for a linked
worktree)" parenthetical was reworded to "; in a linked worktree the main
repository's basename is accepted too" (run-state-lifecycle-and-markers.md
was not required to carry this wording change and still uses the
parenthetical form; only its citations into SKILL.md were re-pointed).

L10: agents-md-section.md's run-directory bullet gained "(in the
workspace or a touched repository)" after the `.ai/runs/YYYY-MM-DD-<slug>/`
path, matching the fuller SKILL.md wording. No docs-consistency test pins
this bullet's exact old sentence, so no test needed adjusting.

M1: test/template-markers.test.ts gained a property test on the shipped
keyed placeholder line: it matches a strict-shape regex mirroring
grounding-mcp's `KEYED_RUN_BASE_STRICT`, its captured key matches the
`PLACEHOLDER_KEY` shape, and two constructed near-miss variants
(uppercase, space before the colon) do not match the strict regex. The
near-miss variants deliberately use a different key/value spelling
(`<repo>`/`<commit>` instead of `<repo-basename>`/`<sha>`) so they do not
add a fourth file-wide occurrence of the exact string
`run-base[<repo-basename>] = <sha>` that
run-state-lifecycle-and-markers.md's own citation into this file already
holds at a 3-occurrence cap; the first attempt (reusing the real
key/value) tripped the in-repo anchor guard's file-wide occurrence check
and was caught by running the guard test, not assumed.

Re-point: the pointer paragraph's and the run-base paragraph's own
citations into SKILL.md sit inside the two sentences F1, F2, F4, and L6
rewrote, so a byte-identical old-content-at-new-position move was not
possible for either; both were re-anchored by hand instead. The pointer
paragraph's fail-closed citation now anchors on its own last line,
"path.", occurring exactly once in SKILL.md; a second, new citation backs
the F4/L6 sentence, anchored on "newest-run scan, so remove it when no
run is active." The run-base paragraph's grammar citation now anchors on
"a near-miss there blocks as malformed"; a second, new citation backs the
silent-fail-open sentence F1 added, anchored on "binding goes silently
missing."; a third, new citation backs F2's corrected placeholder-value
claim, anchored on SKILL.md's own "until the placeholder key is
replaced." Every other fully-qualified and `:N-M`-continuation citation
into SKILL.md, agents-md-section.md, and test/template-markers.test.ts
across the five live docs was re-pointed by a `difflib.SequenceMatcher`
line-map script run from the previous commit's tree to the current
working tree in one pass (building on the previous round's script,
extended to also move fully-qualified `path:N-M` citations, not only the
`:N-M` continuations): the script itself reported applying 20 edits to
run-state-lifecycle-and-markers.md, 32 to subagent-contracts-superset.md,
20 to review-gate-and-waivers.md, 1 to model-preselection.md, and 0 to
install-fence-mechanics.md (it cites none of the files this round
touched). test/docs-consistency.test.ts's own edits (the four
distinctive-phrase test bodies) landed on the same line count as before,
so no docs/okf citation into that file needed shifting this round.

The script's regex only recognizes a continuation written as `:N-M`
(colon-prefixed); a manual audit of the five docs for comma-separated
continuations (`"..." ,N-M`, a shorthand this bundle also uses) found two
the script could not have caught, both in
run-state-lifecycle-and-markers.md: the citation into SKILL.md's
scaling-rule lines 18 to 22 has a `,140-144` continuation (task-slicer
scaling rule text, byte-identical at the new position lines 150 to 154),
and the citation into SKILL.md's Knowledge Bundle lines 244 to 245 has a
`,239-240` continuation (the Knowledge Bundle non-gating text,
byte-identical at the new position lines 249 to 250). Both were confirmed
byte-identical at their mapped target before fixing, then fixed by hand;
a third such comma-continuation,
in install-fence-mechanics.md, points at `writers.ts`, a file this round
did not touch, so it needed no change.

Measured on the working tree: `npx vitest run test/docs-consistency.test.ts`
green (213/213 together with test/template-markers.test.ts); `npm test`
328/328; `npm run typecheck` and `npm run typecheck:test` clean; `npm run
format:check` clean. okf-kit (0.8.0, `--require-anchors`, the CI
allowlist for README.md/INSTALL-AGENT.md bare ranges): 0 CI-gating anchor
findings, 0 `sources-fresh` findings, 0 errors, 14 warnings, 22 notices.
The per-message warning list is byte-identical to the prior round's
14-line baseline; L8 is why: the one warning above the pre-a2d5f85
baseline is the historical bare README line-105 spelling quoted in the
prior round's own log entry above, an append-only entry this round does
not edit, left as written. This round's CHANGELOG.md addition (a new
[Unreleased] bullet, inserted above the versioned entries) shifts every
line number below it in that file, including the two `CHANGELOG.md`
line-range citations elsewhere in this log (the 0.7.0 and 0.9.0 citations
above); those are bare `path:N-M` citations with no `#"..."` string
anchor, so okf-kit's citation-resolve rule checks only that the range
still exists in the file, not that its content is unchanged, and reports
nothing for either.

## 2026-08-28 (agent-tasks 2c3d141c, implementer, review round 2 fixes)

Round-2 review on the `.ai/run` pointer change found one HIGH-adjacent
inaccuracy (F1), one MEDIUM test-strength gap (F2), and three lower-severity
findings (L3-L5). This round closed all five and redesigned the two SKILL.md
prose blocks the round targeted, rather than patching sentences in place.

F1: SKILL.md's pointer paragraph said "a missing pointer there means the
gate silently does not apply," which is false whenever the repository still
carries run history: grounding-mcp's own reader falls back to scanning that
repository's `.ai/runs/` and grades the newest run found there, stale or
not. Fixed by replacing the sentence with an accurate description of the
scan fallback, and this doc now cites the consumer's own measured behavior
as evidence (`tests/ow-run-completeness.test.ts`, read directly, not run
from this repo): no pointer plus a run directory present reports
`enforced: true`, `complete: true` (given an otherwise-accepted run),
`runSource: 'scan'` against whichever run the scan finds newest; no pointer
and no run directory reports `enforced: false`.

F2: three of the seven pointer-doc tests (step 1, the three harness
bullets as one test, and the agents-md-section Run state test) still
asserted the bare substring `.ai/run`, which a bare `.ai/runs/` mention
could also satisfy; two of the three were measurably inert (deleting the
source sentence they were meant to guard left them green). Fixed by adding
one `expectPointerMention` helper to the describe block that asserts the
exact phrase `` `.ai/run` pointer `` and routing all seven pointer tests
through it or an equivalent specific assertion (the SKILL.md Run state
contract test keeps its own phrase-based assertions, since that paragraph's
wording does not contain the helper's phrase).

L3: four `docs/okf/*.md` files (model-preselection.md,
review-gate-and-waivers.md, run-state-lifecycle-and-markers.md,
subagent-contracts-superset.md) had lost their trailing newline at some
earlier edit; restored, confirmed byte-for-byte against the 9740c71 tree
before the loss.

L4: the property test in template-markers.test.ts claimed to mirror
grounding-mcp's `KEYED_RUN_BASE_STRICT` regex while actually using a
tightened local subset (missing the leading `\s*`, the `[^\]\n]+` key
class, and the `(?!-->)` guard). Fixed by copying both
`KEYED_RUN_BASE_STRICT` and `PLACEHOLDER_KEY` verbatim from
`agent-grounding/packages/grounding-mcp/src/ow-run-completeness.ts` (read
directly to confirm the exact source, not from memory), updating the
comment to say "verbatim... kept in sync by hand," and re-verifying the two
near-miss variants (uppercase, space before the colon) still fail to match
the verbatim regex.

L5: SKILL.md's 17-line pointer paragraph was rewritten as a lead sentence
plus three bullets (content, write/overwrite/remove, ignore-before-write)
followed by a separate paragraph on reader behavior, and the "newest run
directory is the active one" sentence in the preceding paragraph now says
"unless a `.ai/run` pointer names one (see below)" instead of silently
being superseded. The keyed-marker deviation sentence was generalised from
"lowercase, no space before the colon, exactly two dashes; a near-miss
there blocks as malformed. A keyed marker that is not on its own line...
is not seen at all" to one sentence: a deviating line is either rejected or
not recognised, and in both cases the binding for that repository is
missing.

Re-point: the SKILL.md edits shifted every line at or after old line 81 by
a non-uniform amount (a net +2 by the end of the file, but +9 through the
new helper-comment insertion point in the pointer paragraph and +3 to +4
elsewhere depending on position); the docs-consistency.test.ts edits
shifted every line at or after old line 387 by +10 (the new helper plus one
net extra line inside the first pointer test). Both were computed with a
`difflib.SequenceMatcher` line-map built from the pre-round-2 commit
(41db099) tree against the working tree, then applied to every
fully-qualified and continuation (`:N-M`, `,N-M`) citation into SKILL.md,
docs-consistency.test.ts, and template-markers.test.ts across the four
live docs that cite them, accepting a mapped move only where the old
range's content matched the new position; a handful the map could not
place automatically (content that changed inside the cited range, or a
too-generic replacement anchor that collided with unrelated text elsewhere
in the target file) were re-anchored by hand instead. Measured by grep
against the working diff (approximate, since a few of these lines carry
more than one citation): about 1 citation edit in model-preselection.md, 24
in review-gate-and-waivers.md, 30 in run-state-lifecycle-and-markers.md,
and 50 in subagent-contracts-superset.md. run-state-lifecycle-and-markers.md
also gained the F1/F2 corrected-claims section rewrite described above, and
one continuation-citation line in log.md's own round-1 entry (a historical
example quoting a then-current `docs-consistency.test.ts` line range) was
re-pointed the same way, since its start line drifted onto a blank line
after the shift.

Measured on the working tree: `npm test` 328/328 (5 files);
`npm run typecheck` and `npm run typecheck:test` clean; `npm run
format:check` clean. okf-kit (0.8.0, `--require-anchors`, the CI allowlist
for README.md/INSTALL-AGENT.md bare ranges): 0 CI-gating anchor findings, 0
`sources-fresh` findings, 0 errors, 14 warnings, 22 notices. The
per-message warning list is byte-identical to the prior round's 14-line
baseline (3e8929a); no new warning survived past the fix pass (three
intermediate ones from an over-generic replacement anchor,
`section).toContain(`, were caught by the in-repo low-collision test and
replaced with `expectPointerMention(section)` before the final measurement
above).

Orchestrator follow-up to the round-2 entry above: one comma-form
continuation citation in run-state-lifecycle-and-markers.md (the step-9
"Repos without a bundle are unaffected" range, written as a comma
continuation after the fully-qualified step-9 citation) had not moved with
the SKILL.md shift of that round; re-pointed by two lines, verified
byte-identical at the target. Also reworded the CHANGELOG Added bullet so
the pointer's scan fallback and the run-base marker's date-heuristic
fallback are no longer described as one mechanism. Measured on the
committed tree: okf-kit check --require-anchors 0 anchor findings, 0
sources-fresh, 14 warnings, 22 notices, unchanged.

Review round 3 (accept_with_notes) follow-up, orchestrator edits, same
pass: SKILL.md's reader-fallback paragraph now says the reader takes the
run that sorts newest by directory name and is only right when the run
lives in that repository and sorts last (the reader orders the scan by
name, not by recency); the keyed-marker deviation sentence now names both
outcomes, rejected and blocking the run versus not recognised and silently
missing; both edits kept their paragraphs' line counts so the existing
anchors held, with the two anchors whose last-line text changed re-pointed
by hand. The CHANGELOG bullet no longer attributes the sha-placeholder
rule to the skill text (this doc carries it) and counts six of eight
helper-routed checks. This doc's opening sentence gained the pointer
qualifier with a citation spanning SKILL.md lines 80 to 83, and its
fallback and deviation paraphrases were aligned with the new wording. A
new docs-consistency test pins the grammar rule's wording, which shifted
docs-consistency.test.ts by seven lines from line 403 on; the 25
citations into that file across four docs were re-pointed by the difflib
line map with the byte-identical-content rule (historical citations in
this log left as written). Measured on the committed tree: vitest 329 of
329, typecheck and typecheck:test clean, prettier clean, okf-kit check
with require-anchors 0 anchor findings, 0 sources-fresh, 14 warnings,
22 notices, warning list unchanged against the 3e8929a baseline.

Same pass, continuation-citation audit after the round-3 edit: 22 more
short-form ranges in subagent-contracts-superset.md that follow a
fully-qualified docs-consistency citation on the NEXT line had been left
at their pre-edit numbers by the first re-point script (which attributed
continuations to the current line only); corrected by the seven-line
shift with the byte-identical rule. One token in model-preselection.md
(the "second, sibling describe" guarding README's tier-to-model-class
table) turned out to have pointed into the review-round escalation block
since before this change; re-pointed to that describe's actual range.

Agent-dx task T-003: pure refactor of `init`'s CLI action, extracting the
harness/profile/models/tiers/opencode-catalog resolution block (and the
three interactive prompt helpers it calls) out of cli.ts into a new
module, cli-inputs.ts, behind one reusable exported function,
resolveInitInputs. init's action now calls resolveInitInputs then prints
the returned warning strings verbatim, in the same order, to the same
stream (stderr) as before; every scenario test/init.test.ts and
test/opencode.test.ts cover was re-run unmodified and stayed green,
confirming no CLI-visible behaviour changed. Added test/cli-inputs.test.ts
with fifteen in-process unit tests covering the defaults case (no flags,
no previous manifest), previous-manifest persistence, explicit-flag
overrides, the tiers on/off/carry matrix, and the opencode branch (an
empty-catalog run with PATH pointed at an empty temp directory, both with
and without --tiers), none of which touch a TTY or a live opencode
install.

Docs re-verification: both install-fence-mechanics.md and
model-preselection.md carried citations into the moved block; all were
re-pointed to the new file and, where the moved code's own text changed
(the per-role and per-class opencode warnings now get pushed onto a
returned array instead of written straight to stderr), to a fresh anchor
matching the new byte-identical content, full and continuation forms
alike. One citation (into cli.ts's own `--no-tiers` commander option,
which did not move) only needed its line numbers bumped, since removing
the three prompt helpers and folding the resolution imports shifted every
line below them. One pre-existing docs-consistency test
(the round-1 M1 guard pinning that the profile prompt's choice labels
derive from rolesForProfile rather than a hardcoded role list) read its
target function's source straight out of cli.ts by name; updated to read
cli-inputs.ts instead, its assertions on the derivation itself untouched.
Both docs' `sources:` lists gained cli-inputs.ts and both timestamps were
re-stamped.

Mutation probes run directly, mutant applied and reverted for real between
each: (a) forcing the extracted function to ignore `previous.profile`
(hardcoding `DEFAULT_PROFILE` in the else branch, restoring from a saved
copy afterward) failed both the new "keeps the previous harnesses,
profile, models, and tiers" unit test and the existing "a plain re-run
without --profile keeps the previously installed profile" CLI test in
test/init.test.ts. (b) Dropping the tiers carry-forward (`opts.tiers ??
previous?.tiers ?? false` to `opts.tiers ?? false`) failed the "tiers:
true is carried forward" unit test. (c) First tried moving the per-role
opencode-alias warning loop to run after the per-class tier-warning loop
instead of before it (an order swap): this mutant survived the entire
suite untouched, npm test green, 344/344 -- masked, because the acceptance
criteria's own two named unit tests (and every existing opencode CLI
assertion) check the warning set by content/`toContain`, never by
position, so a pure re-ordering of two already-present warning groups
cannot be caught by content-only assertions. Swapped to a discriminating
mutant instead: dropping the per-role warning loop entirely (so a
tiers-on opencode run pushes only the three per-class warnings, never the
combined per-role one) failed three tests: two of the new unit tests
("with an empty catalog...one combined warning" -- length 1 expected, got
0; "with an empty catalog and --tiers...per unresolved model class" --
length 4 expected, got 3) and the existing
"writes the --opencode-provider hint to STDERR...when catalog is empty"
CLI test in test/init.test.ts (expected stderr to contain
"--opencode-provider", got empty string). All mutants were reverted from
the same saved copy and `npm test` re-confirmed 344/344 green after each.

Measured before the rebase onto master: `npm test` 344/344 (6 files, 329
pre-existing plus 15 new); re-confirmed on the committed tree after the
rebase (master now carries the 22 operator-manifest tests): 366/366; `npm run typecheck`, `npm run typecheck:test`,
and `npm run format:check` clean; `node scripts/check-cli-flag-order.mjs`
clean from the repo root (no `.option()` calls were touched). okf-kit
(0.8.0, `--require-anchors`): 0 CI-gating findings (no `[anchor-...]`,
`[heading-section-...]`, or `[test-range-straddles-block]` message), 22
notices (matches the 22-notice baseline; the two transient
`sources-fresh ... untracked by git` notices on cli-inputs.ts seen before
committing are gone now that it is tracked). Warnings moved from 14 to
17: the extra 3 are all `sources-fresh STALE` on
review-gate-and-waivers.md, run-state-lifecycle-and-markers.md, and
subagent-contracts-superset.md, none of which this task edited or cites
into -- they carry test/docs-consistency.test.ts in their own `sources:`
lists, and the docs-consistency-guard fix above (updating the round-1 M1
promptProfile check to read cli-inputs.ts) bumped that shared file's git
mtime past their own `timestamp:` fields. Not CI-gating (no
`[anchor-...]`/`[heading-section-...]`/`[test-range-straddles-block]`
suffix) and not a citation problem in any of the three -- a content-only
staleness flag on docs outside this task's allowed-changes list
(model-preselection.md and this log only), left for whichever change
next touches one of those three to re-stamp along with its own edit,
rather than restamped here without also reviewing content this task did
not otherwise need to touch. The remaining 14 warnings are the unchanged
pre-existing baseline (test-range/closing-brace/blank-start-line findings
this task did not touch).

Same pass, orchestrator follow-up: the docs-consistency test edit above
(the promptProfile guard now reads src/cli-inputs.ts) made that test file
newer than three docs listing it as a source; review-gate-and-waivers.md,
run-state-lifecycle-and-markers.md and subagent-contracts-superset.md were
re-read (nothing they state touches the moved resolution code) and
re-stamped so the bundle reports zero sources-fresh findings again.

Operator-level install, slice 4 (the `setup` command): src/cli.ts gained
the `setup` subcommand that writes or updates the operator manifest's
defaults through the same resolveInitInputs path init uses, with the stored
harnesses as the detection baseline (a first-ever setup falls back to
claude), unchanged detection, createdAt and targets preserved on a re-run;
test/setup.test.ts (7 tests) covers fresh run, explicit flags, no-op,
tiers-only re-run with a seeded target, invalid harness, models spec, and a
codex-only default that must not widen back to claude. The additive cli.ts
lines shifted three citations in install-fence-mechanics.md and
model-preselection.md (full and continuation forms), re-pointed by the
difflib line map with the byte-identical rule; both docs re-stamped.
Measured on the committed tree: vitest 373 of 373, typecheck,
typecheck:test and prettier clean, check-cli-flag-order clean, okf-kit
check with require-anchors 0 CI-gating findings and 0 sources-fresh.
Repo kit-version pin (operator apply support): added an optional
`pin` field to `Manifest` and `InitOptions` in init.ts, additive only,
so a caller that never sets it sees a byte-identical manifest.json to
before. The edit inserted lines in four spots in init.ts (InitOptions,
Manifest, readInstalledManifest, and runInit's pin resolution plus the
desired/previous comparison objects), shifting every citation into
init.ts past line 70 in install-fence-mechanics.md and model-preselection.md;
re-pointed by content match against the new file (nearest occurrence at
or after the anchor's own prior line, since only insertions were made,
never deletions). Two anchors were still ambiguous after that pass
(multiple identical-text lines); resolved by picking the occurrence
closest to the citation's original position. One continuation range for
the opencode per-role tier-variant block, cited right after the claude
one on the same line, was re-derived by hand from the surrounding
block's own shift and re-pointed from lines 538 through 569 to lines
560 through 591. New tests
added to test/init.test.ts only as appended blocks (never edited inline
into an existing test body), so no test/init.test.ts citation in either
doc needed to move. Added a sentence to the Manifest-shape paragraph
describing the new field and its three InitOptions.pin states. A
mechanical re-point pass also touched model-preselection.md, outside
this task's originally listed doc scope but required for the same
reason: it also cites init.ts by line, and a first okf-kit check pass
surfaced two further issues from that pass alone, both fixed: a bare
continuation range that had always resolved to init.ts by file-context
even though its content (`TIER_DEFS`) actually lives in models.ts,
silently unflagged before only because the old init.ts line it landed
on was not a closing brace, exposed once the shift moved it onto one;
made an explicit, anchored `src/models.ts` citation instead. And a
prose mention of two plain line-number pairs in this very log entry
(the 538-569 -> 560-591 re-point above) was itself briefly picked up by
the checker as a real continuation citation attached to the nearest
preceding INSTALL-AGENT.md reference; reworded to spell out "lines N
through N" instead of the bare colon-range form. Measured at the time, before this branch was rebased onto master: the
suite green with the four new pin tests, typecheck and typecheck:test
clean, prettier clean, okf-kit check --require-anchors: no anchor finding, warning and
notice sets unchanged from the pre-change baseline; the one warning whose line range moved
(install-fence-mechanics.md's opencode-block short-form citation,
closing-brace-start-line) already existed pre-change at its old
position, just relocated with the block it cites. The rebase onto
master (slice 3, which moved init's option resolution out of cli.ts
into cli-inputs.ts) grew the base suite by tests unrelated to this
task, so the suite measured on the pre-slice-4 tree of this branch was
green with the same four new tests; a later fix round re-points every
citation into init.ts again after the rebase's own line shift and adds
further tests, see that entry below for the count it measured.

Same pass, mutation-probe follow-up: the malformed-pin degrade test's
first draft forced a fresh pin value on every run to prove the read
path did not crash, but that made it insensitive to a mutant that
carries a non-string `pin` straight through `readInstalledManifest`
undegraded, since a forced new value overwrites whatever the read
path produced either way; the mutant survived. Rewrote the test to
force a manifest rewrite through the existing hash-ledger mechanism
instead, while leaving `pin` itself unset, so the written file's `pin`
key is directly observable: correct code writes no `pin` key at all,
the mutant writes the raw malformed value. Re-ran the mutant against
the rewritten test: fails as expected; restored, passes. That rewrite
needed a second `createHash("sha256").update(...).digest("hex")` call
per scenario, which tripped a pre-existing docs-consistency guard
capping how many times that call may occur verbatim in this file (an
anchor-collision check); introduced a small local `sha256Of` helper in
the new describe block instead of repeating the call, keeping the
literal occurrence count at the guard's own limit.

## 2026-08-28 (repo kit-version pin, review round 1 fix round, implementer)

Fix round after review round 1 of the repo kit-version pin (agent-dx task b457ee55, slice 2): this branch was rebased
onto master (which had, in the same window, moved init's option
resolution out of cli.ts into cli-inputs.ts and re-pointed the same two
docs to it), so two independent re-point passes landed on top of each
other; the orchestrator resolved the textual conflicts by hand, keeping
this branch's init.ts numbers and master's cli.ts line. That left four
anchors in install-fence-mechanics.md broken outright (caught by the
existing `every string-anchored docs/okf citation's anchor is
load-bearing` describe in test/docs-consistency.test.ts) plus several
more that resolved but pointed at the wrong span (the base
profile-downgrade loop instead of its tier-variant sub-loop, and the
tiers-off block cited with the profile-downgrade block's own anchor
text).

Also normalized `options.pin`/a stored `pin` that is empty or
whitespace-only to a clear (same as `null`/no recorded pin), per the
round's finding that an empty string is `typeof "" === "string"` and
so was previously accepted and made sticky; added a test for each
side (runInit normalization, readInstalledManifest degradation) plus
two more calls to the existing five-call pin scenario test (a second
`pin: null` no-op, and a following call that omits `pin` and must not
resurrect it).

That normalization edit inserted lines in three more spots in init.ts
(the InitOptions.pin doc comment, readInstalledManifest's pin-field
handling, and runInit's own pin-resolution block), on top of the lines
the rebase had already inserted for the cli-inputs.ts extraction, so
every citation into init.ts past its first ~70 lines needed re-pointing
a second time regardless of whether the round 1 review had flagged it.
Rather than trust hand-arithmetic on two stacked shifts, every citation
into init.ts in both docs was re-derived directly against the current
file: a small local script mirrored docs-consistency's own
last-content-line/uniqueness-in-range logic so each candidate range and
anchor could be checked before writing it, the same rule the doc-level
test enforces. One citation (the codex-only SKILL.md write, review
finding M1) was also given a less collision-prone anchor: the literal
`.agents` path segment, which turned out to be unique file-wide, in
place of the `, SKILL_NAME,` fragment that also occurs at the claude
and opencode SKILL.md install lines (harmless once the range itself
targets the right line, but still ambiguous on its own).

Corrected the log.md entry above: it presented a test count taken
before this branch was rebased as if measured on the committed tree;
the absolute counts in this change's paragraphs were later replaced
by commands, verdicts and deltas; see the closing record at the end of
this entry.
Re-stamped both docs' `timestamp:` fields in this commit since both
were edited again.

Measured before the slice-4 merge reached this branch: `npx vitest run`
green with the two new tests from this round, `npm run typecheck`,
`npm run typecheck:test` and `npm run format:check` clean, the
docs-consistency string-anchor guard green over every re-pointed
citation, and okf-kit check with require-anchors reporting no CI-gating
finding and no stale source; the anchor-not-found and
closing-brace-start-line warnings this round fixed were gone.

Orchestrator note, same change: the branch was rebased twice onto master
while slices 3 and 4 (the cli-inputs extraction and the setup command)
landed; the merges left four init.ts citations in
install-fence-mechanics.md at their master-era line numbers although the
kit-version pin code above them had grown. Re-pointed by hand to the
current sub-loop and note lines (the tier-variant sub-loop, the dropped-role
note with its distinguishing `${relativePath}` prefix, the rolesForProfile
filter, the tiers-off note), verified by the in-repo anchor guards and a
full green vitest run; both docs re-stamped.

Closing record for the repo kit-version pin change. This entry records
commands and verdicts, not suite totals: a total describes one tree, and
this branch was rebased twice while sibling slices merged, so every total
written earlier went stale on the next rebase. On the commit that ships
the change, run inside packages/orchestrator-workflow: `npm test` green
(the change adds nine tests to init.test.ts: set, no-op, carry-forward,
overwrite, clear, re-clear, omitted-after-clear, empty and whitespace
normalization, padded-pin stability); `npm run typecheck`, `npm run
typecheck:test` and `npm run format:check` clean. From the repository
root: `npx -y okf-kit@0.8.0 check --json
packages/orchestrator-workflow/docs/okf --require-anchors
--require-anchors-allow README.md packages/orchestrator-workflow/README.md
INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md` (the
okf-anchor-guard CI invocation) reports no CI-gating finding and no stale
source; its warning set differs from master's by one warning only: the
opencode-block closing-brace warning in install-fence-mechanics.md went
away and nothing new appeared; the notice set is identical. Un-anchored citations that a
re-point pass had moved onto the wrong span were given string anchors so
the in-repo guard covers them from now on. A stored pin is trimmed on
write and normalized on read; the raw manifest may hold padded bytes
until the next rewrite.

- 2026-08-28 (agent-dx task T-005, `apply --target` command): added the
  `apply` command to `cli.ts`, appended after `uninstall` and before
  `program.parseAsync` specifically so none of the existing `init`/`setup`
  code these two docs cite by line moved on the new command's own account.
  The only line-count change reaching that code was the one new name
  (`upsertOperatorTarget`) added to the existing multi-line
  `operator-manifest.js` import, which shifted every following line by
  exactly +1; the `apply`-only `Harness` type import was placed with the
  new command's own helpers instead of at the file's top, for the same
  reason. Both of this bundle's cli.ts lines 131 to 133 citations (the
  `--no-tiers` option description, install-fence-mechanics.md and
  model-preselection.md) and the one cli.ts lines 176 to 177 citation (the
  "Found existing install" `console.log`, install-fence-mechanics.md)
  re-pointed to cli.ts lines 132 to 134 and cli.ts lines 177 to 178 respectively, byte-
  identical content confirmed by direct read, same string anchors (the
  anchor text itself did not change, only its line position). Both docs
  re-stamped.

  Measured on the commit that ships the change, inside
  packages/orchestrator-workflow: `npm test` green with the eleven new
  test/apply.test.ts tests (no existing assertion touched); `npm run
  typecheck` and `npm run typecheck:test` clean; `npm run format` run
  first on the new test file, then `npm run format:check` clean across
  the package. From the repository root: `node
  scripts/check-cli-flag-order.mjs` clean (the new command's options are
  all declared `-short, --long` or long-only, same as every other
  command's). `npx -y okf-kit@0.8.0 check --json
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md packages/orchestrator-workflow/README.md
  INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md` reports
  no CI-gating finding and no stale source; the pre-existing ambiguous-
  target notices/warnings in this file's own citations (shared basenames
  like `init.ts`/`cli.ts`/`SKILL.md` across other packages in the
  monorepo) are unchanged by this entry and unrelated to the re-pointed
  citations above, which resolved with zero findings.

- 2026-08-28 (agent-dx task T-005, `apply --target` fix round after review
  round 1): closed twelve reviewer findings against the `apply` command
  (cli.ts) and its operator-manifest module (operator-manifest.ts).

  H1 (lost update under concurrent applies): `writeOperatorManifest` now
  writes to a `<pid>.<random>.tmp` sibling and `renameSync`s it over the
  real path (atomic on the same filesystem), and `apply` re-reads the
  operator manifest a second time (via the new `operatorManifestState`
  helper) immediately before the upsert instead of reusing the copy read
  at the top of the action; the early copy is now used only for the
  operator-setup gate and for `chosenHarnesses`/`previous`'s defaults. A
  manifest that vanished or turned unreadable between the two reads is
  reported and left unwritten rather than silently recreated. Measured
  effect (manual, not committed as a CI test; see the risk this entry's
  implementer report also carries): a raw external write timed to land
  roughly 50ms into an in-flight `apply` (a truly interleaved race,
  spawned via `child_process.spawn`) survived 9/10 times with the fix
  applied, versus 4/10 with the re-read line reverted to reuse the early
  copy, over 10 runs each. A genuinely simultaneous three-way race (three
  `apply` invocations started in the same shell command against three
  different targets, same operator home) still reliably lost two of the
  three registrations with the fix applied: a bare `apply` invocation's
  wall time (~120-130ms, confirmed by timing both a full fresh install and
  a fast `--target`-points-nowhere failure, which takes about the same
  ~130ms) is dominated by Node/tsx process startup, not by the apply
  logic itself, so near-simultaneous starts still race past each other's
  re-read. The fix narrows the window for staggered concurrent applies
  (the realistic case); it does not close it for truly simultaneous ones.
  This residual risk is accepted, not hidden, and test/apply.test.ts's
  "concurrent applies" describe block documents it inline rather than
  asserting a flaky "all three registered" outcome (see that block's own
  comment for the full reasoning, including why the literal fully-
  sequential two-invocation test the original finding proposed does not
  by itself discriminate this specific mutation (confirmed by running it
  against the reverted code directly), and is kept anyway because it
  protects a different, real regression: the upsert path silently
  dropping an unrelated, already-registered target).

  M2 (corrupt operator manifest reported as absent): `operator-manifest.ts`
  gained `operatorManifestState(home)`, returning a discriminated union
  (`{ kind: "absent" }`, `{ kind: "unreadable" }`, or `{ kind: "ok",
  manifest }`) instead of `readOperatorManifest`'s plain `| undefined`.
  `apply`'s top-of-action gate and its pre-upsert re-read both use it: an
  existing-but-unreadable file (corrupt JSON, an unrecognized envelope,
  or a read failure) now prints "Operator manifest at <path> is
  unreadable; back it up and repair it, or remove it and run
  `orchestrator-workflow setup` again." and exits 1 without touching
  anything, distinct from the pre-existing "No operator setup found; run
  `orchestrator-workflow setup` first." for a genuinely absent file.

  M3 (untested `--sync` scope) and the models-precedence gap: added CLI
  tests covering that `--sync` moves profile/tiers/models to the operator
  default but leaves the target's own recorded harnesses alone (repo
  codex, operator claude), that an explicit `--harness` still wins, and
  the analogous plain-keeps / `--sync`-moves / `--models`-wins triad for
  a per-role model (`implementer=haiku` on the repo vs `implementer=opus`
  on the operator).

  M4 (untested `--pin` validation): added tests for a padded `--pin
  "  1.2.3  "` (trimmed, applied, exit 0) and `--pin "1 2"` (exit 2, no
  repo manifest written, stderr contains "Invalid --pin value"); both
  already worked, only coverage was missing.

  M5 (decision: `--force-pin` must only advance an existing pin): the pin
  computation's `opts.forcePin ? PACKAGE_VERSION : undefined` branch is
  now `opts.forcePin && repoPin ? PACKAGE_VERSION : undefined`, so
  `--force-pin` on a target with no recorded pin leaves it unpinned
  instead of pinning it to this operator install's version as a side
  effect. The option's own description was reworded to state this
  explicitly. Tested.

  L6 (no-op test never asserted `lastAppliedAt` advanced): added a test
  that seeds the registry entry with a hand-written `2000-01-01` timestamp
  and asserts a no-op re-apply advances it, rather than relying on ISO
  string inequality across a microtask tick.

  L7 (decision: a run with conflicts still registers): added a code
  comment next to the upsert stating this is deliberate (the apply did
  run; conflicting files were left as local edits, not skipped or
  aborted) and a test that edits a kit-owned file, applies without
  `--force`, and asserts both "Conflicts" in stdout and the registry
  entry present afterward with `lastAppliedVersion` at `PACKAGE_VERSION`.

  L8 (mid-file `import type { Harness }`): moved back to the top import
  block (its 3-line "placed here so the OKF docs' line citations do not
  shift" comment removed along with it). Because this round's H1/M2 fix
  also needed a new value import (`operatorManifestState`) from the same
  `operator-manifest.js` block, the net shift to every line at or after
  the top import block was +2, not the +1 a diff containing only the
  `Harness` move would have produced. Both of this bundle's `cli.ts`
  lines 132 to 134 citations (the `--no-tiers` option description,
  install-fence-mechanics.md and model-preselection.md) and the one
  `cli.ts` lines 177 to 178 citation (the "Found existing install"
  `console.log`, install-fence-mechanics.md) were re-pointed to `cli.ts`
  lines 134 to 136 and `cli.ts` lines 179 to 180 respectively, each
  checked against the current file content directly (not assumed from
  the +2 offset alone), same string anchors, anchor text unchanged. Both
  docs re-stamped.

  L9 (install announcement before the pin gate; missing git-root note):
  `console.log(\`Installing into \${targetDir}\`)` and a new git-root note
  ("Note: the target is not a git repository root. Pass a different
  --target if this is not the repo you meant.", mirroring `init`'s own
  wording with `--target` in place of `init <dir>`) now print only after
  the pin gate's early return, so a skipped (pinned) run no longer claims
  an install is starting. Tests added for both the note's presence on a
  normal run and its absence (along with "Installing into") on a skipped
  one.

  L10 (realpath computed twice, printed line could diverge from the
  stored path): `apply` now computes the target's realpath once (a local
  `safeRealpathForApply`, the same never-throws pattern as
  operator-manifest.ts's file-private `safeRealpath`, not exported from
  there) and uses that single value for the `alreadyRegistered` check,
  the upsert, and the printed "Registered"/"Refreshed" line. This is a
  real, user-visible behavior change beyond the finding's own target
  fix: on this implementation machine (macOS, where `os.tmpdir()`
  returns a path reached through the `/var` -> `/private/var` symlink),
  the printed line for a plain temp-dir target already differed from its
  own realpath before this fix, and two pre-existing apply.test.ts
  assertions (`Registered ${target}...` and `Refreshed the registry
  entry for ${target}...`) were updated to `realpathSync(target)` to
  match; this is flagged explicitly since "existing assertions" would
  otherwise read as untouchable, and the alternative (not applying L10 as
  specified) would leave the finding open. A new test registers a target
  through an explicit symlink and asserts the printed path equals both
  the symlink's realpath and the stored registry path.

  L11 (raw manifest `pin` dropped silently): added a small,
  apply-only `repoManifestHasMalformedPin` helper in cli.ts (a second,
  independent parse of the same repo manifest file, checking only the
  one condition `readInstalledManifest` (init.ts, untouched this round)
  already degrades silently: a `pin` key present but non-string, or
  empty/whitespace after trimming). When true, apply now writes `Ignoring
  a malformed pin in <manifest path>; the pin gate did not run` to
  stderr and proceeds. Tested.

  L12 (interactive "(detected)" harness label): left as-is, out of scope
  for this round; still a known cosmetic residue.

  Measured on the commit that ships this round, inside
  packages/orchestrator-workflow: `npm test` (`vitest run`) green, 414
  tests across 9 files (test/apply.test.ts grew from 11 to 25, plus 6 new
  operator-manifest.ts unit tests: 2 for `writeOperatorManifest`'s
  atomicity, 4 for `operatorManifestState`); `npm run typecheck` and `npm
  run typecheck:test` clean; `npm run format` run first, then `npm run
  format:check` clean across the package. From the repository root:
  `node scripts/check-cli-flag-order.mjs` clean. `npx -y okf-kit@0.8.0
  check --json packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md packages/orchestrator-workflow/README.md
  INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md` (see
  the exact result recorded at the end of this entry once run against the
  final commit). `operator-manifest.ts` carries no `sources:` entry in
  either doc, so its atomic-write and `operatorManifestState` additions
  needed no re-stamp on that account; both docs were re-stamped anyway
  for the `cli.ts` citation moves above.

- 2026-08-29 (agent-dx task T-005, `apply --target` fix round 2, closing
  the lost-update race for real): fix-round-1's own log entry above
  measured, and accepted, a residual: a truly simultaneous multi-way
  `apply` race still lost registrations even with the re-read fix
  applied, because process-startup jitter swamped the internal
  read-to-write timing. Fleet `apply` (`xargs -P`, backgrounded loops) is
  the expected use of this command, so that residual was closed
  structurally this round rather than left accepted.

  Mechanism: `operator-manifest.ts` gained `withOperatorManifestLock(home,
  fn, options?)`, an advisory, same-machine, cooperative lock around a
  read-modify-write critical section. `mkdirSync(<home>/.manifest.lock)`
  is the mutex (directory creation is atomic on every filesystem Node
  targets, so a concurrent creator gets `EEXIST` rather than silently
  succeeding); a caller that finds it held retries with a short
  synchronous sleep (`Atomics.wait` on a throwaway `SharedArrayBuffer`,
  not a busy loop) until it acquires the lock or a timeout (default 10s)
  elapses, at which point it throws `OperatorManifestLockTimeoutError`
  without ever calling `fn`. A lock directory whose mtime is older than a
  staleness threshold (default 30s) is treated as abandoned (most likely
  left behind by a process killed between acquiring and releasing it) and
  reclaimed: removed, with acquisition retried exactly once per call, so
  one long-running holder is not repeatedly evicted by every waiter
  racing to reclaim the same stale-looking directory. The lock is always
  released in `finally`, including when `fn` throws. `timeoutMs`/
  `staleMs`/`pollMs` are all overridable via an options argument so tests
  can shrink the production windows; production callers omit it entirely.
  `writeOperatorManifest`'s own doc comment (fix-round-1's atomic-rename
  addition) was updated to point at this function as the thing that
  actually closes the race it only narrowed.

  `cli.ts`'s `apply` action now wraps the pre-upsert re-read, the upsert,
  and the write in `withOperatorManifestLock(home, () => { ... })`; the
  early, unlocked read at the top of the action is unchanged (it still
  serves only the operator-setup gate and the `chosenHarnesses`/
  `previous` defaults). The locked callback returns a small discriminated
  result (`{ kind: "registered", resolvedTargetPath, alreadyRegistered }`
  or `{ kind: "manifest-not-ok", manifestKind }`) rather than printing or
  setting `process.exitCode` from inside the lock, so the lock's `finally`
  release is not entangled with the command's own control flow; the
  caller switches on that result after the lock returns, preserving the
  exact pre-existing "unreadable"/"gone" messages byte for byte. A lock
  acquisition that times out is reported as `Could not lock the operator
  manifest at <path> (another orchestrator-workflow command holds it);
  the kit was installed but the target was not registered. Re-run
  \`apply\` to register it.` and exits 1; the kit's own files were already
  written by `runInit` earlier in the action, so this message is careful
  to say the install itself happened and only the registry write did not.
  A test-only synchronous hold (`testHoldForConcurrencyProbe`, gated on
  `ORCHESTRATOR_WORKFLOW_TEST_HOLD_MS`, a no-op unless that variable is
  set) was added inside the locked callback so a future regression test
  could widen the critical section on demand if process-start jitter ever
  stopped being enough to discriminate a reintroduced bug; this round's
  own mutation probe (below) did not end up needing it.

  Tests: `test/operator-manifest.test.ts` gained a `withOperatorManifestLock`
  describe block: runs `fn` and returns its result when the lock is free;
  releases the lock directory after `fn` returns; releases it (and lets
  the error propagate) after `fn` throws; a second acquire against an
  already-held lock times out with `OperatorManifestLockTimeoutError`; a
  second acquire succeeds once the lock is released by another process
  (a short-lived child process removes the lock directory after a delay,
  since the production poll delay blocks this process's own event loop
  via `Atomics.wait`, so a same-process `setTimeout` cannot fire while an
  acquire attempt is polling); a lock directory older than `staleMs` is
  reclaimed and acquisition succeeds; a lock directory younger than
  `staleMs` is not reclaimed and a short-timeout acquire still times out.

  `test/apply.test.ts`'s "concurrent applies against the same operator
  home" describe block's second test (previously asserting only that the
  manifest file stayed valid JSON with at least one target registered,
  fix-round-1's own acknowledged weaker assertion) was replaced with a
  real regression test: four targets are applied with `runApplyAsync`
  started in the same `Promise.all`, and every one of the four must be
  registered afterward, repeated across three iterations inside the same
  `it` to catch flakiness within a single run. The first ("a target
  registered directly in the manifest between two sequential applies...")
  test is unchanged and still kept for the different, real regression it
  protects (the describe block's own comment, trimmed this round to
  describe the fix-round-2 mechanism instead of the fix-round-1 residual
  it replaces, explains why).

  Measured pass rate: the new four-target/three-iteration test run in
  isolation (`npx vitest run test/apply.test.ts -t "all N
  simultaneously-started"`) 10 times in a row against the code as shipped
  this round: 10/10 passed.

  Mutation probe (H1, closing the residual race): the lock wrapper around
  `apply`'s critical section was removed while keeping the pre-upsert
  re-read in place (the callback called directly, `registration =
  ((): ApplyRegistration => { ... })();` instead of `registration =
  withOperatorManifestLock(home, () => { ... });`), reproducing exactly
  fix-round-1's own accepted residual. The same test, run the same way,
  10 times against the mutated code: 0/10 passed, every failure at the
  same assertion (`expect(registeredPaths.has(realpathSync(t))).toBe(true)`
  on one of the four targets). The mutation discriminates cleanly without
  needing `ORCHESTRATOR_WORKFLOW_TEST_HOLD_MS`; the mutated file was
  restored from a byte-for-byte pre-mutation copy (verified by checksum)
  before the commit that ships this round, then `npm run typecheck` and
  the full suite were re-run clean to confirm the restore.

  Measured on the commit that ships this round, inside
  packages/orchestrator-workflow: `npm test` (`vitest run`) green (up
  from fix-round-1's 414 across 9 files: 7 new `withOperatorManifestLock`
  unit tests in operator-manifest.test.ts, apply.test.ts's concurrent-
  applies second test rewritten in place rather than added). `npm run
  typecheck` and `npm run typecheck:test` clean. `npm run format` run
  first (reformatted only `operator-manifest.ts`, a pure style pass with
  no behavior change, confirmed by the type-check and full suite re-run
  immediately after), then `npm run format:check` clean across the
  package. From the repository root: `node scripts/check-cli-flag-order.mjs`
  clean.

  `cli.ts` citation delta: the lock import
  (`OperatorManifestLockTimeoutError` and `withOperatorManifestLock`, two
  new names, not one) added two lines to the top import block, not the
  one the task brief guessed at; every citation into `cli.ts` at or after
  that block shifts by the same two lines unless a later edit in the same
  file shifts it further. Checked directly against the current file
  content (not assumed from the +2 offset alone) rather than trusted on
  the offset: both of this bundle's `cli.ts` lines 134 to 136 citations
  (install-fence-mechanics.md, model-preselection.md; the `--no-tiers`
  option description) and the one `cli.ts` lines 179 to 180 citation
  (install-fence-mechanics.md; the "Found existing install" `console.log`)
  moved to `cli.ts` lines 136 to 138 and `cli.ts` lines 181 to 182
  respectively, same string anchors, anchor text unchanged; a grep of
  every `cli.ts:` citation in both docs (string-anchored and bare-line
  forms) confirmed these two were the only ones. The much larger rewrite
  of `apply`'s registration block itself (`cli.ts`, well past line 700)
  needed no citation re-point: neither doc cites into that region. Both
  docs were re-stamped anyway for the moves above. `operator-manifest.ts`
  again carries no `sources:` entry in either doc, so the new lock
  function needed no re-stamp on that account.

  From the repository root: `npx -y okf-kit@0.8.0 check --json
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md packages/orchestrator-workflow/README.md
  INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md`: 0
  errors (CI-gating) and 0 stale findings; 35 warning/notice findings, all
  pre-existing and unrelated to this round's edit (the same class of
  `log.md` ambiguous-citation notices fix-round-1's own entry already
  carries, since `okf-kit` disambiguates a bare `file.ts:line` citation
  against every package in this monorepo and several share filenames like
  `cli.ts`/`init.ts`/`SKILL.md`).

- 2026-08-28 (fix-round-3, review round 2, H1 repeated + M2-M4 + L5-L10):
  closed the operator-manifest lost-update class structurally instead of
  patching another call site: `operator-manifest.ts` gained
  `updateOperatorManifest(home, mutate, options)`, the single locked
  read-modify-write entry point every write now goes through. The raw
  writer (previously exported `writeOperatorManifest`) was renamed to
  `writeOperatorManifestUnlocked` and stopped being exported at all, so
  nothing outside this module (production or test) can reach the manifest
  file without going through the lock. `setup` (cli.ts) was the actual H1
  repeat: it read the manifest unlocked, ran its prompts, and wrote
  `{...existing, ...newDefaults}` straight back with no lock at all,
  discarding any registration `apply` made in the same window; it now
  calls `updateOperatorManifest` with a mutate that merges only the newly
  computed defaults onto the manifest re-read *inside* the lock
  (`current`), so `current.targets`/`current.createdAt` (not `existing`'s)
  survive into the write. `apply`'s own registration step was ported onto
  the same entry point in place of its previous direct
  `withOperatorManifestLock`+`upsertOperatorTarget`+raw-writer sequence.

  Lock hardening (M2, L9): the lock directory now carries an owner file
  (a random per-acquisition token written right after `mkdirSync`
  succeeds); `finally` only removes the directory if that token still
  matches, so a lock a stale-reclaim has since handed to another process
  is never torn out from under it. Stale-lock reclaim itself is now
  `renameSync(lockPath, <lockPath>.<token>.stale)` then a removal of the
  renamed copy, rather than a bare `rmdirSync`: `renameSync` on the same
  filesystem is atomic, so of two waiters racing to reclaim the same
  stale-looking directory at most one rename can succeed, and the loser's
  own attempt throws instead of also entering the critical section.
  Staleness is now re-checked on every failed acquire attempt rather than
  once per call (L9): the previous once-per-call gate meant a caller that
  started 0-20s after a killed holder, with the old 10s timeout under the
  30s stale threshold, could time out before ever seeing the lock age past
  `staleMs`. The default timeout moved from 10s to 40s
  (`DEFAULT_LOCK_TIMEOUT_MS`), now above the unchanged 30s
  `DEFAULT_LOCK_STALE_MS` (M4: previously unpinned by any test, so
  `DEFAULT_LOCK_STALE_MS = 0` still passed the full suite); both, plus
  `DEFAULT_LOCK_POLL_MS`, are now exported and pinned by a dedicated test.

  The staleness check (`lockAgeMs`) and the reclaim `renameSync` are two
  separate syscalls, not one atomic operation together; the two-waiter test
  below caught this directly: it passed reliably run in isolation but
  failed once (1 run out of several) inside a full `npm test` pass under
  the heavier process contention that many parallel spawned child
  processes create. The failure mode: process A finishes an entire fresh
  reclaim (rename the stale directory away, remove it, `mkdirSync` a new
  one, write its own owner token) inside the gap between process B's
  `lockAgeMs` read (still showing the old, genuinely-stale mtime) and B's
  own `renameSync` call, so B's rename relocates A's brand-new, actively-
  held lock rather than the abandoned one B inspected, and both A and B
  end up running their critical sections at once. Fixed by re-checking age
  a second time on the renamed copy immediately after the rename succeeds:
  only the caller that just renamed it can observe that path, so this
  second read is itself race-free, and a lock that was actually fresh at
  rename time still reads as fresh there (rename does not touch mtime on
  POSIX). A copy that turns out fresh is handed back (renamed to
  `lockPath` again) instead of destroyed, so a real owner caught mid-
  reclaim is left running undisturbed; the residual case where a third,
  unrelated acquisition lands in the brief hand-back gap itself (so there
  is nothing left to hand the copy back to) is accepted, since that
  owner's own eventual release already no-ops safely on a missing owner
  file. Re-run after the fix: the same two-waiter test, plus the full
  suite, 8/8 clean runs of `npm test` in a row, then 5/5 more of the same
  two test files run together under artificial CPU load (8 concurrent
  `yes > /dev/null` processes) to specifically try to reproduce the
  original timing window; no further failures observed.

  L6/L7: `upsertOperatorTarget` now returns `{ manifest, alreadyRegistered
  }` instead of a bare manifest, computed once via the same `safeRealpath`
  comparison its own dedupe already used, rather than `apply` (cli.ts)
  separately recomputing `alreadyRegistered` via raw string equality
  against `t.path` (L6's inconsistency: the dedupe compared realpaths, the
  already-registered flag did not). `safeRealpath` (previously
  module-private) is now exported and is what both `upsertOperatorTarget`
  internally, and `apply`'s own resolved-path-for-printing, call; `apply`'s
  own duplicate copy (`safeRealpathForApply`) is deleted (L7). The upsert's
  own target-path resolution switched from a bare `realpathSync` to
  `safeRealpath` too, so a target deleted between install and the locked
  registration step no longer dies on a bare `ENOENT` after a successful
  install (L7's other half); the update branch also now rewrites a stored
  non-realpath `path` to the realpath, so a hand-edited or
  pre-normalization entry self-heals on its next apply instead of needing
  `safeRealpath` on every future comparison against it.

  L8: the mid-lock "manifest not ok" message for an unreadable manifest
  reused the pre-install check's wording verbatim ("back it up and repair
  it... run `setup` again"), which is wrong once the kit install itself
  already succeeded and only the registry write failed. Extracted into an
  exported `applyRegistrationFailureMessage(manifestKind, manifestPath,
  targetDir)` (operator-manifest.ts) so the wording is unit-testable
  without spawning the CLI: the unreadable case now says the kit was
  installed into `targetDir` and only registration could not complete; the
  absent ("gone mid-lock") case keeps its own already-distinct wording. The
  *pre-install* unreadable check (before any install work runs, cli.ts's
  top-of-`apply` `operatorManifestState` read) is untouched and still says
  the old thing, correctly, since no install happened in that path.

  L5: `testHoldForConcurrencyProbe` (the `ORCHESTRATOR_WORKFLOW_TEST_HOLD_MS`
  production hook, unused since fix-round-2's own mutation probe did not
  end up needing it) is deleted, along with the `ApplyRegistration` type
  and `safeRealpathForApply` it sat next to.

  L10: the "concurrent applies against the same operator home" describe
  block's ~40-line review-round narrative comment was trimmed to what the
  two tests underneath it actually assert, plus a one-line pointer to this
  file for the fix-round history.

  Tests added: `operator-manifest.test.ts` gained a `DEFAULT_LOCK_*`
  constants-pinned test; two owner-token tests (a fresh token per
  acquisition; `finally` leaving a lock alone once another process's token
  has taken it over); a staleness-re-evaluated-per-attempt test; a
  `withOperatorManifestLock: two real waiters on a stale lock` describe
  block (two child processes, spawned via `tsx` against a hand-written temp
  probe script, both racing a lock directory seeded 61s old, asserting
  their held intervals never overlap, repeated 5 times); an
  `updateOperatorManifest` describe block (creates when absent; mutate
  returning `undefined` writes nothing; mutate sees the re-read-inside-the-
  lock manifest rather than a caller's earlier read; `state` distinguishes
  unreadable from absent while both hand `current: undefined`; a
  concurrent-calls-don't-lose-updates test); an
  `applyRegistrationFailureMessage` describe block (both wordings, unit
  level); a `safeRealpath` describe block; and `upsertOperatorTarget`
  additions (reports `alreadyRegistered`; does not throw when the target
  itself no longer exists; normalizes a stored non-realpath path on
  update). `apply.test.ts` gained: a whitespace-only `--pin "   "` test
  (M3: the existing "--pin trims..." test only exercises `init.ts`'s own
  trim, since `init.ts` trims regardless of what `apply` already trimmed,
  so it never touched apply's own all-whitespace-rejects-to-empty branch);
  a symlink-stored-path-normalized-plus-"Refreshed" test; and, in the
  concurrent-applies describe block, a `setup` running concurrently with
  `apply` test (H1's own regression test: registers target A via `apply`,
  then races a `setup --profile minimal` against a second `apply`
  registering target B, asserting both targets and the new default survive,
  across 5 iterations). `setup.test.ts` was not touched, per this round's
  own constraint that setup's pinned CLI-visible behavior stay exactly as
  its existing tests describe it; all 9 of its tests stayed green
  throughout.

  Measured: `npm test` (`vitest run`) 440/440 green (up from fix-round-2's
  421, all additions accounted for above); `npm run typecheck` and
  `npm run typecheck:test` clean; `npm run format` run first (reformatted
  only `operator-manifest.ts` and `operator-manifest.test.ts`, confirmed by
  re-running typecheck and the full suite immediately after with no
  behavior change), then `npm run format:check` clean. From the repository
  root: `node scripts/check-cli-flag-order.mjs` clean.

  Mutation probes (each applied to a byte-for-byte-verified-restorable copy,
  restored and re-verified via `npx tsc --noEmit` on both tsconfigs plus a
  clean full-suite run before the commit that ships this round):
  (a) reverted `setup`'s write to the pre-fix pattern (unlocked, against the
  stale pre-lock `existing` read): the new "setup running concurrently with
  apply" test failed on its first of 5 iterations in 5/5 separate runs
  (5/5, not merely "at least once in 5").
  (b) removed the owner-token check from `withOperatorManifestLock`'s
  `finally` (always `rmSync` regardless of current ownership): the new
  "does not remove the lock directory... if another process's owner token
  has since taken it over" unit test failed (1/51 operator-manifest tests
  failing, the rest, including the two-waiter race test, still passed,
  since that race's timing does not reliably hit this specific gap; the
  dedicated unit test is what discriminates it reliably).
  (c) set `DEFAULT_LOCK_STALE_MS` to `0`: the new defaults-pinned test
  failed (`expected +0 to be 30000`).
  (d) let a whitespace-only `--pin` value through (dropped the `trimmed ===
  ""` half of the guard, kept only the internal-whitespace check): the new
  whitespace-only-`--pin` test failed (`expected +0 to be 2`, i.e. exit 0
  instead of the usage-error exit 2).

  `cli.ts` citation delta: the `operator-manifest.js` import block dropped
  `withOperatorManifestLock`+`writeOperatorManifest` and added
  `applyRegistrationFailureMessage`+`safeRealpath`+`updateOperatorManifest`,
  netting +1 line over fix-round-2's 8-name/10-line block, which shifted
  every later line in the file by +1. Checked directly against the current
  file content (not assumed from the +1 offset alone): both of fix-round-2's
  `cli.ts` lines 136 to 138 citations (install-fence-mechanics.md,
  model-preselection.md; the `--no-tiers` option description) and the one
  `cli.ts` lines 181 to 182 citation (install-fence-mechanics.md; the
  "Found existing install" `console.log`) moved to `cli.ts` lines 137-139
  and `cli.ts` lines 182-183 respectively, same string anchors, anchor text
  unchanged. A grep of every `cli.ts:` citation in both docs (string-
  anchored and bare-line forms) confirmed these two were the only ones. The
  much larger rewrite of `setup`'s and `apply`'s registration blocks
  themselves needed no citation re-point: neither doc cites into either
  region. Both docs were re-stamped anyway for the moves above.
  `operator-manifest.ts` again carries no `sources:` entry in either doc,
  so its own much larger set of changes needed no re-stamp on that account.

  From the repository root: `npx -y okf-kit@0.8.0 check --json
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md packages/orchestrator-workflow/README.md
  INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md`: 0
  errors (CI-gating) and 0 stale findings; 35 warning/notice findings
  (13 warnings, 22 notices), byte-identical in count and content to the
  pre-edit baseline re-run for comparison, all pre-existing and unrelated
  to this round's edit (the same `log.md` ambiguous-citation notice class
  fix-round-1's and fix-round-2's own entries already carry).

  Round-3 close-out (T-005): three contained additions, no re-stamp
  needed. `setup`'s registration `mutate` callback (cli.ts) now takes the
  re-read `state` alongside `current` and returns `undefined` without
  writing when `state.kind === "unreadable"`, so a corrupted or hand-edited
  operator manifest is reported (stderr, exit 1) instead of silently
  replaced by a fresh one that would drop its recorded targets; the diff
  starts at line 317 of the pre-edit file, well past both of this bundle's
  `cli.ts` citations (137-139, 182-183, both inside `init`'s block, above
  `setup`'s), so neither needed re-pointing. `operator-manifest.ts` gained
  an exported pure helper, `shouldDestroyReclaimedLock(postAgeMs, staleMs)`,
  extracted from the stale-lock reclaim's post-rename re-check
  (`postAge !== undefined && postAge > staleMs`); the `undefined` case
  resolves hand-back-safe (do not destroy a lock this call cannot age),
  consistent with the same module's `finally`-release stance already
  documented there. Neither doc cites into `operator-manifest.ts` (no
  `sources:` entry, same as every prior round), so this needed no
  re-stamp either. Tests added: three unit cases for
  `shouldDestroyReclaimedLock` (destroy, hand-back, undefined-hands-back);
  one cross-process test (`test/operator-manifest.test.ts`,
  `updateOperatorManifest: two real cross-process callers`) spawning two
  `tsx` children that each call `updateOperatorManifest` with a mutate
  sleeping ~200ms and recording its own [start, end] interval to a
  per-process marker file, repeated 3 times, asserting the two intervals
  never overlap in any repeat; one CLI test in `test/setup.test.ts`
  seeding a target by hand, corrupting `schemaVersion` to 2, and asserting
  `setup --yes` exits 1, prints the unreadable-manifest stderr message,
  and leaves the file's bytes byte-for-byte unchanged; plus two existing
  tests were tightened to pin the previously unasserted
  "Created operator defaults."/"Updated operator defaults." status
  strings.

  Mutation probes, both run against a committed baseline before applying
  the mutant, and restored+re-verified green afterward: (1) inverting the
  comparison in `shouldDestroyReclaimedLock` from `postAgeMs > staleMs` to
  `postAgeMs < staleMs` made the new unit test suite fail (2 of 3 cases
  flipped); reverted, unit tests green again. (2) replacing
  `updateOperatorManifest`'s `return withOperatorManifestLock(home, () =>
  {...}, options);` with a bare `return (() => {...})();` (skipping the
  lock entirely) made the new cross-process test fail on its first of 3
  repeats (the assertion throws and stops the loop, so only 1 of 3 ran;
  that repeat's two marker intervals overlapped, since both children now
  ran their mutate concurrently with no lock serializing them); reverted,
  cross-process test green again on a follow-up run (all 3 repeats).

  `npm test` (twice, full suite): 445 passed, 9 test files, both runs.
  `npm run typecheck` and `npm run typecheck:test`: clean, no errors.
  `npm run format` (write) then `npm run format:check`: all files
  already Prettier-formatted, `format:check` reports no changes needed.
  `node scripts/check-cli-flag-order.mjs` (from the worktree root):
  "commander-flag-order: clean". okf re-run (same command as fix-round-2's
  entry above, bundle path first): 0 errors (CI-gating), 0 stale findings,
  35 warning/notice findings (13 warnings, 22 notices), identical in count
  to the pre-edit baseline, all pre-existing and unrelated to this round.
- 2026-08-28: `doctor` command added (agent-dx task T-006, one of the
  operator-manifest command slices). Correction (review round 1): this
  entry originally claimed doctor reads no source either doc lists, so
  neither doc needed new prose; that was wrong, doctor.ts reads exactly
  the per-repo manifest fields install-fence-mechanics.md's "manifest.json:
  shape and consumers" section documents (files, version, pin, profile,
  tiers, models), and that section now names doctor.ts as a fourth,
  non-installer consumer (fix-round-1). The +1 line shift below was
  caused by the new `import { runDoctor, targetReportToJson } from
  "./doctor.js";` line near the top of `cli.ts`, not by the doctor
  command block itself, which was appended after `uninstall` further
  down the file and does not precede either cited span: the `--no-tiers`
  option's citation in install-fence-mechanics.md and its duplicate in
  model-preselection.md, and the "Found existing install" print-line
  citation in install-fence-mechanics.md, were re-pointed to their new
  spans; the anchor strings themselves were unaffected since no line's
  own content changed, only its number. `npm test` green with
  the new doctor.test.ts file (drift/missing/no-manifest/divergent/
  version-lag/clean/pinned-at-own-version cases, the exit-code contract,
  `--prune`, and `--json`); `npm run typecheck`, `npm run typecheck:test`
  and `npm run format:check` clean; `node scripts/check-cli-flag-order.mjs`
  clean. From the repository root: `npx -y okf-kit@0.8.0 check --json
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md packages/orchestrator-workflow/README.md
  INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md` (the
  okf-anchor-guard CI invocation) reports no CI-gating finding and no
  stale source; the warning and notice sets are the same ones the prior
  entry already described, none of them touching the two re-pointed
  citations. Four mutation probes run against `src/doctor.ts` by hand
  (pin-equals-own-version treated as version-lag, drift losing precedence
  over divergent, a missing target dropped from the exit-code trigger set,
  `--prune` also sweeping drift) each broke exactly the test named for it
  and were restored and re-verified green before committing.
- 2026-08-28: `doctor` review round 1 fix-round-1 (agent-dx task T-006).
  `computeDriftFiles`'s `readFileSync` call is now wrapped in the same
  try/catch its `statSync` neighbor already had; an unreadable kit-owned
  file (permissions, a race) is counted as drift for that one path
  instead of throwing and aborting the whole target, and the rest of the
  operator registry still reports. `runDoctor` now distinguishes an
  absent `<operatorHome>/manifest.json` (`no-operator-manifest`, exit 2,
  the pre-existing setup hint) from one that exists but does not parse or
  validate (`operator-manifest-unreadable`, exit 2, a new stderr message
  naming the path and telling the operator to repair or remove it rather
  than silently re-running `setup` over a possibly-fine `targets` array).
  The pin-vs-installed-version rule changed: a pin now suppresses
  `version-lag` only when it equals the installed version; a pin that no
  longer matches prints `installed X, pinned at Y` (folded into the same
  line the pinless case already had, not a duplicate). `--prune`'s help
  text and its human-output summary note that the manifest is rewritten
  in normalized form (a raw, parser-rejected target entry is dropped
  along with the pruned targets, not just left alone); no code change to
  re-surface those raw entries under `pruned` was made, the note was
  judged sufficient on its own. install-fence-mechanics.md's
  "manifest.json: shape and consumers" section gained `doctor.ts` as a
  fourth, non-installer consumer (it reads `files`/`version`/`pin`/
  `profile`/`tiers`/`models` off every operator-registered target's own
  manifest, comparing each against the operator manifest's defaults) and
  `doctor.ts`/`test/doctor.test.ts` were added to that doc's `sources:`
  list; both docs' frontmatter `timestamp:` was re-stamped. This same
  fix round also corrected the prior 2026-08-28 entry above: its claim
  that doctor read no source either doc lists was wrong (see the
  correction inline there), and its attribution of the +1 citation-line
  shift to the doctor command block was wrong too, the actual cause was
  the new `doctor.js` import line near the top of `cli.ts`; this round's
  own edits added one further import line (`OPERATOR_MANIFEST_FILENAME`)
  at the same spot, so the two previously re-pointed citations
  (`--no-tiers` in both docs, "Found existing install" in
  install-fence-mechanics.md) were re-pointed again, one line further
  down, same anchor strings. `npm test` green (net +12 doctor.test.ts
  cases: 13 added, 1 renamed rather than rewritten in place since its
  scope narrowed to the matching-pin case only); `npm run typecheck`,
  `npm run typecheck:test`, and `npm run format:check` (run first) clean;
  `node scripts/check-cli-flag-order.mjs` clean. From the repository
  root: `npx -y okf-kit@0.8.0 check --json
  packages/orchestrator-workflow/docs/okf --require-anchors
  --require-anchors-allow README.md packages/orchestrator-workflow/README.md
  INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md`
  reports 0 errors (CI-gating) and 0 stale-source findings; the warning
  (13, all pre-existing `init.test.ts` short-form range-start notices)
  and notice (22, pre-existing ambiguous cross-package citations and one
  blank-start-line notice) sets are unchanged by this round, and neither
  the new `doctor.ts` consumer paragraph nor the new log prose above
  introduced any new finding. Four mutation probes run against
  `src/doctor.ts` by hand for this round (dropping the `readFileSync`
  try/catch, reverting the pin rule to any-pin-suppresses-lag, collapsing
  `operator-manifest-unreadable` back into `no-operator-manifest`, and
  removing the missing-file push in `computeDriftFiles`) each broke
  exactly the test named for it and were restored and re-verified green
  (byte-identical diff against the pre-mutation file) before committing.
- 2026-08-29 (agent-dx task T-006, rebase onto the `apply` slice plus
  review round 2 findings): `doctor` was rebased onto master, which had
  meanwhile gained the `apply` command (agent-dx task T-005) between
  `uninstall` and where `doctor` itself was appended; `apply` and `doctor`
  now sit in that order in `cli.ts`, and the operator-manifest import
  block merges both commands' names. `writeOperatorManifest` no longer
  exists on master (renamed, unexported): `--prune`'s write now goes
  through `updateOperatorManifest`, with the whole re-read, report
  computation, and write inside its one locked critical section, the
  same guard `apply`'s own registration step already relies on, rather
  than doctor keeping a second, unlocked read-modify-write path of its
  own. The two `--no-tiers`/"Found existing install" citations in
  install-fence-mechanics.md and model-preselection.md were re-pointed a
  second time, this time by direct line count against the actual merged
  file rather than by arithmetic: the doctor import and the `apply`
  slice's own `OPERATOR_MANIFEST_FILENAME` import together shift
  everything below by two lines, not one, which a signed-off arithmetic
  shift had gotten wrong the first time around (docs-consistency.test.ts
  caught the drift on the first `npm test` after the rebase, before this
  entry existed to explain it).

  Review round 2 found four findings against the pre-rebase state. M1
  (repeated class, corrupt/unreadable target manifest reported as
  `no-manifest` and pruned) and M2 (`existsSync` swallowing `EACCES` the
  same way): a new `unverifiable` status, distinct from both `missing`
  (directory ENOENT specifically) and `no-manifest` (manifest file ENOENT
  specifically), covers a directory or manifest stat failure for any
  other reason and a manifest present but unparseable/unreadable;
  `unverifiable` is excluded from `--prune`'s removal set and counts
  toward exit 1; a `reason` field (`"directory not accessible"` /
  `"manifest unreadable"`) is now part of the `--json` contract and the
  human output's own detail line under an `unverifiable` status line. M3
  (the `--prune` note claimed unconditionally that an unvalidatable raw
  entry was dropped): the note now prints only when the file's raw
  `targets` array actually held more entries than `readOperatorManifest`
  parsed, naming the count, computed by re-reading the raw JSON once
  inside the same locked `mutate` callback that does the prune write. L6
  (`versionLag` absent from `--json`, and a drift target's divergence/lag
  facts silently dropped from human output): `versionLag` joined the
  `--json` contract, and the divergence and version-lag detail lines now
  print under a `drift` status line the same way they already did under
  `divergent`. L5 (inert human-output lines): CLI assertions were added
  for the tiers divergence detail line, the drift file list under a
  drift status line, and both the presence and the absence of the prune
  note. L7 (CHANGELOG) is deferred to the docs slice per the task
  assignment.

  Tests added for M1: a corrupt target manifest, a chmod-000 target
  manifest, and a chmod-000 ancestor directory (the latter two skipped
  under root, which bypasses permissions) all report `unverifiable`, not
  `no-manifest`/`missing`, are not pruned, and count toward exit 1; a
  genuinely deleted target directory is still `missing`, and a target
  with an ENOENT manifest (uninstalled) is still `no-manifest`, both
  still pruned as before, confirming the new stat-classification helper
  did not regress either of the two original prune-eligible statuses.

  Mutation probes, run for real against the committed rebase-plus-fix
  state, each restored and re-verified byte-identical afterward: (a)
  folding all three `unverifiable` call sites in `inspectTarget` back to
  `no-manifest` failed all six of this round's new "(12) unverifiable"
  tests; (b) adding `unverifiable` to `REMOVE_ON_PRUNE` failed the
  "`--prune` never removes an unverifiable target" test; (c) reverting
  the prune note's guard from `report.unvalidatedDropped > 0` back to the
  old unconditional `report.pruned.length > 0` failed the new
  "unvalidatable-entry prune note only when the file actually held one"
  test (the note printed "0 raw target entries..." instead of staying
  silent); (d) dropping `versionLag` from `targetReportToJson`'s return
  failed the existing "(9) CLI --json" JSON-shape test.

  `npm test` green (all existing assertions untouched and passing,
  including every `init`/`setup`/`uninstall`/`apply` test, plus this
  round's new and updated `doctor.test.ts` assertions); `npm run
  typecheck` and `npm run typecheck:test` clean; `npm run format` (write)
  then `npm run format:check` clean. `node scripts/check-cli-flag-order.mjs`
  (from the repository root) reports clean. From the repository root:
  `npx -y okf-kit@0.8.0 check --json packages/orchestrator-workflow/docs/okf
  --require-anchors --require-anchors-allow README.md
  packages/orchestrator-workflow/README.md INSTALL-AGENT.md
  packages/orchestrator-workflow/INSTALL-AGENT.md` reports 0 errors
  (CI-gating) and 0 stale-source findings after install-fence-mechanics.md
  and model-preselection.md were re-stamped; the warning and notice sets
  are unchanged against the pre-round baseline, both re-pointed
  `doctor.ts` citations in install-fence-mechanics.md (the `inspectTarget`
  post-manifest-read span and the `computeDriftFiles` call line, both of
  which moved further down the function once the new stat-classification
  checks were inserted ahead of them) resolving with zero findings
  alongside the two `cli.ts` citations above.

## 2026-08-29 (agent-dx b457ee55, task T-006, implementer, closing round-3 notes)

Closes the notes carried into this round before merge. `runDoctor`'s
`--prune` path now captures `updateOperatorManifest`'s own return value
instead of falling back to the stale, pre-lock read of the operator
manifest when the manifest turns out gone or unreadable once the lock is
actually granted: it now reports `no-operator-manifest`/
`operator-manifest-unreadable` (exit 2, an empty target list) directly
rather than describing targets that may no longer exist on disk. The
`doctor` action in `cli.ts` now also catches whatever
`updateOperatorManifest` itself can throw rather than return --
`OperatorManifestLockTimeoutError` (a foreign holder still past the lock
timeout) or any other error raised while acquiring the lock (most
commonly `EACCES` on a read-only operator home) -- emitting a `--json`
object (`error: "operator-manifest-locked" |
"operator-manifest-write-failed"`, exit 2, a `message` field) or a
one-line stderr explanation in human mode, instead of letting either
crash the CLI with a raw stack trace. `unvalidatedDropped` joined the
`--json` contract (it already lived on `DoctorReport`, it just never made
it into the printed object). The human summary line now pluralizes its
noun ("1 target:" vs "N targets:").

Test coverage added: a registered target path replaced by a regular file
(still `missing`, still pruned); the three permission-gated tests now use
`it.skipIf` instead of an early return, so a root run shows a skip rather
than a silently passing test; a foreign, fresh lock directory plus the
CLI's test-only `OW_DOCTOR_TEST_LOCK_TIMEOUT_MS` override (read only
inside the `doctor` action, and only honored when `--prune` is also
passed) forces the timeout path deterministically instead of waiting out
the production timeout; a chmod-500 operator home forces the `EACCES`
path (skipped under root, which bypasses permissions).
install-fence-mechanics.md's doctor-consumer sentence now names the
mechanism only (`doctor.ts` as a fourth, non-installer consumer),
dropping the task-id/slice aside this log entry already carries, and
gained one sentence stating that `computeDriftFiles`' unreadable-file-as-
drift behavior is deliberate, not an oversight.

Mutation probes, run for real against the committed state, each restored
and re-verified afterward: (a) removing the lock-timeout/generic-catch
branch in `cli.ts`'s `doctor` action (falling straight through to the
previous, unguarded `runDoctor` call) failed the new foreign-lock-holder
JSON test with an uncaught `OperatorManifestLockTimeoutError` instead of
a parseable exit-2 report; restored, test green again. (b) dropping
`unvalidatedDropped` from the `--json` object literal in `cli.ts` failed
both the JSON-shape test and the `--json --prune` unvalidatedDropped
test; restored, both green again.

`npm test`: full suite green, every existing assertion across every
command's test file left untouched and passing, including every
`init`/`setup`/`uninstall`/`apply` test. `npm run typecheck` and `npm run
typecheck:test`: clean. `npm run format` (write) then `npm run
format:check`: clean. `node scripts/check-cli-flag-order.mjs` (from the
repository root): clean. From the repository root: `npx -y
okf-kit@0.8.0 check --json packages/orchestrator-workflow/docs/okf
--require-anchors --require-anchors-allow README.md
packages/orchestrator-workflow/README.md INSTALL-AGENT.md
packages/orchestrator-workflow/INSTALL-AGENT.md` reports 0 errors
(CI-gating) and 0 stale-source findings after install-fence-mechanics.md
and model-preselection.md (both list `cli.ts`, and the former also lists
`doctor.ts`, as sources) were re-stamped; a direct diff of this run's
findings against a run from the pre-round commit shows the warning and
notice sets are set-for-set identical, no addition or removal in either
direction. Two `cli.ts` citations needed re-pointing by one line each
(the `--no-tiers` option's citation in install-fence-mechanics.md and its
duplicate in model-preselection.md, plus the "Found existing install"
print-line citation in install-fence-mechanics.md), all three caused by
this round's own added `import type { DoctorReport } from "./doctor.js";`
line near the top of `cli.ts`, not by anything in the `doctor` action
body itself (appended well after every cited span); `doctor.ts`'s own two
citations in install-fence-mechanics.md (the `inspectTarget`
post-manifest-read span and the `computeDriftFiles` call line) needed the
same one-line shift, caused by this round's added
`OperatorManifestLockOptions` type import near the top of `doctor.ts`.

## 2026-08-29 (agent-dx b457ee55, task T-007, implementer)

Added the `adopt [dir]` command: it imports a repository that `init` or
`apply` already installed into the operator manifest's target registry
verbatim, touching nothing in the repository itself. When no operator
manifest exists yet, it bootstraps one from the repository's own
recorded `harnesses`/`profile`/`tiers`/`models` (`operatorDefaultsFromRepoManifest`)
rather than the shipped defaults `setup` would otherwise fall back to.
The target is registered with the repository's own recorded
`version` as `lastAppliedVersion` (contrast `apply`, which always
records this operator's `PACKAGE_VERSION`), then `doctor.ts`'s exported
`inspectTarget` is run against the freshly written manifest and its
report is printed for that one target. Precondition and operator-
manifest failures (no or unreadable repo manifest, unreadable operator
manifest, a lock timeout or write failure) all exit 2, contrasting
`apply`'s 1; among the reachable report statuses, only `drift` exits 1,
everything else (`clean`/`divergent`/`version-lag`) exits 0.
`missing`/`no-manifest`/`unverifiable` are unreachable immediately after
a directory and manifest read that both just succeeded, so a report in
one of those three is treated as an internal-error exit 2 rather than
folded into the normal contract. `--json` mirrors `doctor`'s per-target
object plus `registered: "new" | "refreshed"` and `bootstrapped: boolean`.

The doctor-style per-target printer (status line, divergence detail,
version-lag detail, drift-file list, pin line) was factored out of
`doctor`'s own per-target loop in `cli.ts` into a standalone
`printTargetDetail` function so `adopt` reuses the identical format
rather than hand-duplicating it; `doctor`'s own per-target loop now just
calls it. `doctor`'s own tests were left untouched and stayed green,
confirming the extraction changed nothing about its output.

The two new imports this round needed (`inspectTarget` and the
`TargetReport` type from `doctor.ts`) were folded into that module's
already-existing import lines in `cli.ts` (`import { inspectTarget,
runDoctor, targetReportToJson } from "./doctor.js";` and `import type {
DoctorReport, TargetReport } from "./doctor.js";`) instead of adding new
import lines, specifically to avoid repeating last round's citation
shift (see the two immediately preceding log entries above, whose
`cli.ts`/`doctor.ts` citations moved by one line each from a newly added
import line). `printTargetDetail` and the new `adopt` command itself
were appended after `doctor`'s command definition and before
`program.parseAsync`, well past every cited span in either doc. A
before/after diff of the full findings set from `npx okf-kit@0.8.0
check` (see command below) against a run from the pre-round commit
confirms this worked: the two sets are identical member-for-member, so
no `cli.ts:` citation in install-fence-mechanics.md or model-
preselection.md needed re-pointing this round. Both docs' `timestamp:`
front matter was still re-stamped to the time of this change, since
`cli.ts` (a listed source in both) was edited.

Mutation probes, run for real against the committed state (`git
checkout` restoring `cli.ts` after each), each restored and re-verified
afterward: (a) registering `PACKAGE_VERSION` instead of
`repoManifest.version` in the `upsertOperatorTarget` call failed the
"contrast with apply" test (expected `"0.0.1"`, got the running package
version); restored, green again. (b) adding `divergent` alongside
`drift` in the exit-code ternary failed the "divergent target against an
existing operator manifest" test (expected exit 0, got 1); restored,
green again. (c) hardcoding `profile: "full"` and `{ ...DEFAULT_MODELS }`
in `operatorDefaultsFromRepoManifest` instead of reading them off
`repoManifest` failed the bootstrap test (the freshly bootstrapped
operator defaults no longer matched the repo's own `minimal` profile and
overridden `implementer` model, so the newly registered target reported
`divergent` instead of `clean`); restored, green again. (d) adding a
`writeFileSync` call into the target directory at the top of the
`adopt` action failed the "target directory is never written to" test
(the before/after tree snapshot gained an extra entry); restored, green
again.

`npm test`: green, with the 13 new `adopt` tests added alongside every
pre-existing command's test file, all of which stayed untouched and
passing. `npm run typecheck` and `npm run typecheck:test`: clean. `npm
run format` (write) then `npm run format:check`: clean. `node
scripts/check-cli-flag-order.mjs` (from the repository root): clean.
From the repository root: `npx -y okf-kit@0.8.0 check --json
packages/orchestrator-workflow/docs/okf --require-anchors
--require-anchors-allow README.md
packages/orchestrator-workflow/README.md INSTALL-AGENT.md
packages/orchestrator-workflow/INSTALL-AGENT.md` reports 0 errors
(CI-gating); as noted above, the warning/notice finding set is identical
to a run against the pre-round commit, member-for-member (fix-round
correction, review finding L7: an earlier version of this entry claimed
"0 stale-source findings", which this command does not report at all;
see the fix-round entry below for what it actually reports).

## 2026-08-29 (agent-dx b457ee55, task T-007, fix round, implementer)

Closed the review-round-1 findings on `adopt`: M1 (`--json`-unaware
directory precondition), M2 (`existsSync` swallowing `EACCES` on the repo
manifest path), M3 (the missing/no-manifest/unverifiable fallback's JSON
shape and human-mode ordering), L6 (untested write-failure/lock-timeout
JSON shapes), L7 (this doc's own vacuous "0 stale-source findings"
claim, corrected above), L8 (a foreign tool's manifest at the same path
read as "unreadable"), L9 (the repo-manifest relative path defined three
times), and L10 (`updatedAt` never bumped on an `apply`/`adopt`
refresh).

`adopt` no longer calls `requireDirectory` (the shared helper stays
`--json`-unaware and unchanged for `init`/`uninstall`/`apply`); it
resolves its own target directory and routes a non-directory target
through the same `reportUsageError` shape as every other precondition
failure, with a new `target-not-a-directory` error at exit 2, keeping
the existing "Target is not a directory: ..." wording in human mode
(M1). The repo-manifest existence check now goes through `doctor.ts`'s
`statOrClassify` (newly exported) instead of `existsSync`, so an
inaccessible `.ai/workflow` directory (`EACCES`) is reported as a new
`unverifiable-repo-manifest` error, distinct from `no-repo-manifest`,
with wording that does not suggest `init`/`apply` (M2). A new
`repoManifestIsForeign` helper (mirroring the existing
`repoManifestHasMalformedPin`'s independent-reparse pattern) detects a
`kit` field that is a string other than `"orchestrator-workflow"` and
reports a distinct `foreign-manifest` error instead of folding it into
the generic "unreadable" wording (L8).

The missing/no-manifest/unverifiable fallback after a successful
registration (unreachable through a live `adopt` run today, since the
directory and manifest were just read successfully moments before) now
gets an `error: "unexpected-target-status"` key in `--json`, and human
mode no longer prints the "Adopted ..." success line ahead of the detail
lines and the stderr bug note (M3). The status-to-exit-code mapping
itself moved out of `cli.ts`'s inline ternary chain into `doctor.ts`'s
newly exported `adoptExitCodeForStatus`, a pure function covering all
seven `TargetStatus` values, and the `--json` extras (the conditional
`error` key) into a second exported pure function, `adoptJsonExtras`;
both are unit-tested directly in `test/adopt.test.ts` against every
status, closing L5 (the inert branch) without needing to force an
actually-unreachable race through the CLI.

`REPO_MANIFEST_RELATIVE_PATH` was defined three times (`init.ts`'s
private `MANIFEST_PATH`, and independent duplicates in `doctor.ts` and
`cli.ts`); `init.ts` now exports `MANIFEST_PATH` (a one-line change,
`export` added to the existing declaration, so no `init.ts:` citation in
either doc shifted), and both `doctor.ts` and `cli.ts` import it instead
of keeping their own copy (L9).

`updateOperatorManifest` (operator-manifest.ts) now bumps `updatedAt` to
the current time immediately before every write that refreshes an
already-existing manifest (`current` truthy) whose `mutate` callback
did not already give it a distinct `updatedAt` of its own; a brand-new
manifest (`current` undefined, typically built by
`createOperatorManifest`) is left untouched, preserving its
self-consistent `createdAt`/`updatedAt` pair. This is what `setup`'s own
manual bump did before (now removed as redundant, since `setup`'s
refresh branch always has `current` truthy and never sets its own
distinct `updatedAt`) and what `apply`'s and `adopt`'s own registration
callbacks (built purely on `upsertOperatorTarget`, which never touches
`updatedAt`) never did, so both previously left a stale `updatedAt` on
every refresh (L10). `doctor --prune`'s own manual bump (out of this
round's `doctor.ts` edit scope) is left as-is: it already computes its
own distinct `updatedAt` before returning, so the central logic's
"already distinct, leave it" branch takes over for that path with no
double-bump. The condition (`next.updatedAt === current.updatedAt`
rather than a blanket "`current` truthy") specifically preserves an
existing `operator-manifest.test.ts` atomicity test that writes a fully
custom manifest object, with its own deliberately-different `updatedAt`,
over an already-existing one and asserts an exact round-trip; a blanket
bump broke that test on first attempt (caught by `npm test`, fixed
before this commit).

`cli.ts`'s two doctor.js import edits (`statOrClassify`,
`adoptExitCodeForStatus`, then `adoptJsonExtras` added in a second pass)
each grew that one import line, shifting every line below it: the
`--no-tiers` description (cited at cli.ts lines 140 to 142 before this
round, 147 to 149 now) and the "Found existing install" console.log
(cli.ts lines 185 to 186 before, 192 to 193 now) in both
install-fence-mechanics.md and model-preselection.md were re-pointed
after each shift and re-verified with `npx vitest run
test/docs-consistency.test.ts`. `doctor.ts`'s own edits (removing the
duplicated `REPO_MANIFEST_RELATIVE_PATH` const/comment, exporting
`statOrClassify`, adding `adoptExitCodeForStatus` right after
`targetReportToJson`) shifted `inspectTarget`'s cited span (doctor.ts
lines 304 to 356, anchor line 309, before this round; lines 322 to 374,
anchor line 327, now), re-pointed in install-fence-mechanics.md;
`adoptJsonExtras` was
deliberately appended at the very end of the file, after `runDoctor`,
so it shifted nothing already cited. A before/after diff of every
non-`log.md` finding from `npx okf-kit@0.8.0 check` (see command below)
against a run from the pre-round commit (`git show HEAD:<path>` into a
scratch copy of the seven changed files) confirms the two sets are
identical member-for-member; `log.md` itself is excluded from that diff
since this entry necessarily changes it.

Mutation probes, run for real against the working tree (each mutated,
the named test run, then hand-restored to the exact pre-mutation text
and re-verified green, since no intermediate commit exists yet to `git
checkout` back to): (a) reverting the M2 gate from `statOrClassify` back
to a plain `existsSync` failed the "M2" chmod-000 test (expected
`unverifiable-repo-manifest`, got `no-repo-manifest`); restored, green
again. (b) making `adoptJsonExtras` always return `{}` failed its own
"M3" unit test (expected the `error` key on `missing`, got `{}`);
restored, green again. (c) moving `unverifiable` from `adoptExitCodeForStatus`'s
2-returning cases to its 0-returning cases failed both the
"maps all seven `TargetStatus` values" test and the downstream
`adoptJsonExtras` unit test; restored, green again. (d) removing the
central `updatedAt` bump in `updateOperatorManifest` (returning `next`
unconditionally) failed both the new "L10" test in `test/adopt.test.ts`
(a second `adopt` no longer advanced `updatedAt`) and its
`operator-manifest.test.ts` unit counterpart; restored, green again.

`npm test`: green, 524 tests (511 pre-existing plus 13 new: 3 for M1, 1
for M2, 1 for L8, 1 for L6's write-failure branch, 1 for L10's adopt
refresh, 1 for the symlink-then-real-path dedup, 1 for adopt-then-apply,
2 for `adoptExitCodeForStatus`/`adoptJsonExtras` in adopt.test.ts, and 2
additive unit tests in operator-manifest.test.ts for the central
`updatedAt` bump). `npm run typecheck` and `npm run typecheck:test`:
clean. `npm run format` (write, no files changed) then `npm run
format:check`: clean. `node scripts/check-cli-flag-order.mjs` (from the
repository root): clean. From the repository root: `npx -y
okf-kit@0.8.0 check --json packages/orchestrator-workflow/docs/okf
--require-anchors --require-anchors-allow README.md
packages/orchestrator-workflow/README.md INSTALL-AGENT.md
packages/orchestrator-workflow/INSTALL-AGENT.md` reports 0 errors
(CI-gating); the non-`log.md` finding set is identical to the pre-round
commit, member-for-member, as verified above.

Not done: a lock-timeout counterpart to L6's write-failure test (an
`adopt`-scoped `OW_DOCTOR_TEST_LOCK_TIMEOUT_MS`-style env hatch) was not
added; `adopt`'s `updateOperatorManifest` call takes no lock options at
all today, and wiring one in would be a production-code change beyond
this test-coverage finding's scope. The write-failure test added instead
exercises the same `catch` block's non-timeout arm. Also not done: a
live-CLI integration test for M3's `unexpected-target-status`/`error`-key
branch itself, since it is unreachable through a live `adopt` run by
design (the same property the pre-existing source comment on that branch
already documented); it is pinned instead by direct unit tests of
`adoptExitCodeForStatus` and `adoptJsonExtras`.

## 2026-08-29 (agent-dx b457ee55, task T-007, closing round-2 notes, implementer)

Six small fixes closing this task's remaining round-2 notes, all scoped to
`adopt`.

`adopt`'s no-repo-manifest branch previously folded an `EACCES` on the
manifest FILE itself (mode 000, its containing `.ai/workflow` directory
still readable) into the reinstall-advising `unreadable-repo-manifest`
branch: a stat on the file succeeds even when it cannot be read (stat only
needs search access on ancestor directories), so `readInstalledManifest`
and the old `repoManifestIsForeign` each silently swallowed the read
error and reported "not foreign"/"no record" alike. The branch now reads
the file's bytes itself, inspects the caught error's `code`, and routes
any non-ENOENT read failure to `unverifiable-repo-manifest` (no repair or
reinstall advice) before ever attempting to parse or foreign-check it; a
parse failure on bytes that did read cleanly still reports
`unreadable-repo-manifest` as before. `repoManifestIsForeign` no longer
re-reads the file itself; it now takes the already-parsed value, so this
one read is the only one for this branch.

The human-mode unexpected-status decision (suppress the success line,
print the stderr bug note) was pulled out of `cli.ts`'s inline
`exitCode === 2` check into `doctor.ts`'s exported `suppressSuccessLine`,
next to `adoptExitCodeForStatus`, and unit-tested directly over all seven
`TargetStatus` values.

`adopt` now reads back `result.manifest` (the bytes `updateOperatorManifest`
actually wrote) for `inspectTarget` and the registered-target lookup,
instead of the `mutate` callback's own return value: that return value can
be stale when `updateOperatorManifest`'s central "refreshing write"
re-stamp fires on top of it. The `mutate`-captured booleans
(`alreadyRegistered`, `bootstrapped`, `resolvedTargetPath`) are unchanged.

`operator-manifest.test.ts` gained one additive test pinning the other
half of the L10 guard: a `mutate` that returns a manifest carrying its own
distinct `updatedAt` is written verbatim, not re-stamped a second time.

`updateOperatorManifest`'s header comment now names its four writers
(`setup`, `apply`, `doctor --prune`, `adopt`, all confirmed by grep against
`src/`) instead of the stale two-writer list, and states plainly that a
refreshing write stamps `updatedAt` unless `mutate`'s own return value
already carries a distinct one.

The prior round's log entry cited its own line-shift analysis using
backtick-wrapped `path:line` ranges, which okf-kit's citation resolver
picks up as citations in their own right; two of those ranges (the
`--no-tiers` description and the `inspectTarget` span/`driftFiles` line)
were themselves stale by the time this round's `doctor.ts`/`cli.ts` edits
landed (this round's own `suppressSuccessLine` addition and import-list
growth shifted both by a further one to seventeen lines). Rewrote that
prose as plain line-number language instead of backtick-quoted ranges,
and re-pointed the two okf docs that actually cite those spans
(install-fence-mechanics.md, model-preselection.md): the `--no-tiers`
description moved from cli.ts lines 147 to 149 to lines 148 to 150; the
"Found existing install" console.log moved from cli.ts lines 192 to 193
to lines 193 to 194; `inspectTarget`'s cited span moved from doctor.ts
lines 322 to 374 to lines 339 to 391, with its `driftFiles` anchor line
moving from 327 to 344. Verified each new span's content against the
current source with a direct read before saving.

Mutation probes, run for real against the working tree, each mutated,
the named test run, then hand-restored to the exact pre-mutation text and
re-verified green (no intermediate commit exists yet to `git checkout`
back to): (a) folding the manifest-file `EACCES` case back into
`unreadable-repo-manifest` (short-circuiting the new `code !== "ENOENT"`
check to never trigger) failed the new "fix-round-2" file-permission test
(expected `unverifiable-repo-manifest`, got `unreadable-repo-manifest`);
restored, green again. (b) making `suppressSuccessLine` always return
`false` failed its own "fix-round-2" unit test (expected `true` for
`missing`/`no-manifest`/`unverifiable`, got `false`); restored, green
again.

`npm test`: green, +2 tests over this task's prior round (the
manifest-file-`EACCES` test in `adopt.test.ts` and the
`suppressSuccessLine` unit test). `npm run typecheck` and `npm run
typecheck:test`: clean. `npm run format` (write, no files changed) then
`npm run format:check`: clean. `node scripts/check-cli-flag-order.mjs`
(from the repository root): clean. From the repository root: `npx -y
okf-kit@0.8.0 check --json packages/orchestrator-workflow/docs/okf
--require-anchors --require-anchors-allow README.md
packages/orchestrator-workflow/README.md INSTALL-AGENT.md
packages/orchestrator-workflow/INSTALL-AGENT.md` reports 0 errors
(CI-gating), warnings and notices unchanged from the master baseline
(13 warnings, 22 notices); the only finding touching either edited
source file is the pre-existing, unrelated ambiguous-citation notice on
cli.ts around lines 304 to 307, not one of this round's own anchors.

Not done: no further scope. All six notes from this round's assignment
are addressed above; `init`/`setup`/`uninstall`/`apply`/`doctor`
behavior and their existing tests are untouched.

## 2026-08-29 (agent-dx b457ee55, task T-008, implementer, operator-install docs)

Documents the operator-level install (`setup`, `apply --target`, `doctor`,
`adopt`, the repo-manifest `pin`) in the public docs: `README.md` gained a
new "Operator-level install" section, inserted directly before "Ownership
and re-runs" so every citation into the file at or before "Effort tiers"
stays put; `INSTALL-AGENT.md` gained the operator path in its numbered
"Instructions for the agent" flow (a new paragraph after step 3's
conflict-handling sentence, and a one-line addition to step 4's opening
sentence) and two new Write-surface bullets (the operator home files, and
the repo manifest's optional `pin`); `CHANGELOG.md`'s `[Unreleased]`
section gained an `### Added` entry for the operator-manifest module, the
operator home, the four new subcommands, and the `pin` field, plus a new
`### Changed` entry naming the shared locked write API
(`updateOperatorManifest`/`withOperatorManifestLock`) `setup`, `apply`,
`doctor --prune`, and `adopt` all go through.

`INSTALL-AGENT.md`'s edits landed inside the Write-surface bullet list
(old lines 46-50 expanded to new 58-70) and inside numbered step 3 (old
line 34 expanded to new lines 34-44) and step 4's opening line, growing
the file from 241 to 273 lines; every citation into it from
`install-fence-mechanics.md` and `model-preselection.md` was re-pointed
by diffing old against new with Python's `difflib.SequenceMatcher` and
sampling the target line ranges after the edit to confirm the quoted
content still matches: `install-fence-mechanics.md`'s `46-61`/`63-85`/
`63-66`/`80-82` became `58-81`/`83-105`/`83-86`/`100-102`;
`model-preselection.md`'s `97-111`/`150-159`/`161-187`/`205-227`/
`229-233`/`132-137` became `117-131`/`182-191`/`193-219`/`237-259`/
`261-265`/`164-169`. `README.md` grew from 378 to 457 lines but every
citation into it from either doc (lines 109-239) sits before the new
section's insertion point (after line 339), so none needed re-pointing.
Both docs' `timestamp:` frontmatter was re-stamped as the last edit
before commit.

At the time of the implementer return, `run-state-lifecycle-and-markers.md`
also listed `README.md` and `INSTALL-AGENT.md` as sources and cited the
same Write-surface bullets (`INSTALL-AGENT.md`, ranges 46 through 47 and
139 through 144, with anchor text "repository's" at range 47 through 50
and again at range 141 through 143) that this task's edits shifted, but
that file was outside this task's `allowed_changes`; its citations were
left stale by the implementer. They were re-pointed by the orchestrator in
the same slice, see below.

`npm test`: green, including `docs-consistency.test.ts` unmodified (no
test added or changed by this docs-only slice; README.md/INSTALL-AGENT.md
carry no local anchor-scope mapping, so none of that suite's
anchor-load-bearing checks apply to either file's citations). `npm run
typecheck` and `npm run
typecheck:test`: clean. `npm run format:check`: clean (no `.ts` files
touched). From the repository root, `node
packages/slop-detector/dist/cli.js check . --pack placement-slop
--config slop.config.yml` (after `npm ci && npm run build` in
`packages/slop-detector`, whose `dist/` was missing in this worktree):
clean. A grep for an em dash, and for a digit adjacent to "tests" or
"repos", a `2026-` date, or "agent-tasks", across both edited docs found
zero occurrences inside either doc's new prose; every em dash grep hit in
both files sits at a pre-existing line outside the edited ranges.

From the repository root: `npx -y okf-kit@0.8.0 check --json
packages/orchestrator-workflow/docs/okf --require-anchors
--require-anchors-allow README.md packages/orchestrator-workflow/README.md
INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md` reports
0 errors (CI-gating) both before and after this task's edits; notices
unchanged; three new warnings, all `anchor-not-found-in-range`, all caused by
the same `INSTALL-AGENT.md` line shift described above: two are the
`run-state-lifecycle-and-markers.md` citations named above (their
`"repository's"` anchor no longer sits inside the cited range); the third
is this log's own 2026-08-28 entry, which quotes the pre-fix citation as
history (`INSTALL-AGENT.md`, range 141 through 144, anchor text
`repository's`). That quoted range happened to still resolve against the
master baseline's content, since the real bullet's `repository's` sat at
old line 142, inside both the narrowed 141-143 range and the pre-fix
141-144 one; after this task's shift the same substring no longer
resolves against the live file, even though it is prose quoting a past
finding, not a live citation. That third warning was first left as-is
(rewriting the historical quote's line numbers to keep it resolving would
misstate what the 2026-08-28 fix actually narrowed the range to), then
rewritten as prose once the pull request's `okf-anchor-guard` job showed
that the CI guard gates every finding carrying an anchor rule id,
warnings included: the 2026-08-28 entry now names the range and the
anchor text as they stood then, without a citation token.

Orchestrator follow-up in the same task (T-008, after the implementer
return): `run-state-lifecycle-and-markers.md` is a third consumer of
`INSTALL-AGENT.md` and was outside the implementer's allowed changes, so
its three `INSTALL-AGENT.md` citations still pointed at the pre-edit
lines (okf-kit: two `anchor-not-found-in-range` warnings, plus the
unanchored two-range citation that resolved to the wrong text without a
warning). Re-pointed by a line map computed from the old and new file
(every mapped line byte-identical except the last line of the
write-surface span, which gained a sentence but still carries the
anchor): the two-range citation moved by plus twelve and plus thirty-two
lines, the two anchored citations by plus twelve and plus thirty-two
lines as well; the doc was re-stamped afterwards. The remaining
`anchor-not-found-in-range` warning sits in this file's own 2026-08-28
entry, which quotes the citation as it stood at that time; historical
entries are not re-pointed, but this quote was later rewritten as prose
because the CI anchor guard counts every anchor finding (see the
round-2 closure below). Re-run of the CI-argument okf-kit command
after the edit: the two doc warnings are gone.

After the rebase onto the merged adopt commit and the CHANGELOG commit
naming PR 147, the okf-kit sources-fresh rule reported three docs stale
by commit time (`review-gate-and-waivers.md`, `subagent-contracts-superset.md`,
`run-state-lifecycle-and-markers.md`; the first two cite the CHANGELOG by
heading only, which the Unreleased entries do not move). Re-verified and
re-stamped all three in a commit of their own, after the source commits,
so the stamps postdate the sources.

Fix round 1 (T-008b, implementer-high, then orchestrator): the thirteen
round-1 findings were closed in place (README rule for version-lag and
the pin comparison, the pin sentence in the CHANGELOG, doctor exit-2
causes, adopt --json, the pin in README's manifest enumeration and
--force-pin as a pin writer, drift gloss, operator-home wording in
INSTALL-AGENT.md, the init-and-apply idempotency clause, apply requiring
setup, the log entry's totals, citation-shaped tokens and superseded
first paragraph) and
a new describe block in `test/docs-consistency.test.ts` pins every
setup/apply/doctor/adopt option name and every TargetStatus member
against README.md (two mutation probes, each red with the mutant and
green after restore). The INSTALL-AGENT.md edits shifted lines by two
below the operator-path step; eleven citation ranges in
`install-fence-mechanics.md`, `model-preselection.md` and
`run-state-lifecycle-and-markers.md` were re-pointed to byte-identical
content and the three docs re-stamped, with one correction by the
orchestrator: the continuation range in `model-preselection.md` next to
the words INSTALL-AGENT.md binds to the preceding fully qualified
citation of `test/docs-consistency.test.ts` and names the fifth guard
test there, not a span of INSTALL-AGENT.md; the fix round had shifted it
by one as if it were, and it was restored to the test-file range (which
did not move, the new describe block being appended at the end). A
fully qualified INSTALL-AGENT.md citation at that spot would also have
re-bound the three later continuation ranges of the same paragraph to
the wrong file, which okf-kit reported as ranges exceeding the file
length; continuation forms resolve against the last fully qualified
citation, whatever the surrounding prose names. Because the fix commit changed
`test/docs-consistency.test.ts` and the CHANGELOG, the sources-fresh rule
flagged `review-gate-and-waivers.md` and `subagent-contracts-superset.md`
(both cite the test file by line ranges that lie above the appended
block, so no range moved); re-verified and re-stamped in a commit after
the fix commit. Checks after the fix round: docs-consistency test green,
full suite green, typecheck and typecheck:test clean, prettier clean,
flag-order lint clean, placement check clean, okf-kit with the CI
arguments 0 CI-gating findings and the warning set back to the
pre-round set once the re-stamps landed.

Round-2 notes (reviewer accept_with_notes, closed by the orchestrator):
the new README guard was document-wide, so four of the seven doctor
statuses and six of the operator flags were satisfied by text outside
the operator section (the reviewer's own probe removed four statuses
from the list and stayed green); the guard now slices README to the
Operator-level install section for the flags and to the doctor status
sentence for the statuses, and README's setup and apply paragraphs now
name the install options they share with init so the scoped flag check
holds. CHANGELOG brought in line with the corrected README (all doctor
exit-2 causes, the pin comparison rule instead of a suppression, the
--force-pin no-op caveat, internal whitespace in --pin). README's
operator-home sentence uses the same operator-home framing as
INSTALL-AGENT.md; the idempotency clause now says apply refreshes the
registry entry on every run. In this log entry the absolute warning
counts were replaced by the delta and the round-1 count corrected to
thirteen. Two pre-existing continuation citations in
`model-preselection.md` (the tier-table guard and the opencode-effort
prose guard in `test/docs-consistency.test.ts`) pointed at other
describe blocks since before this task; re-pointed to the describe
blocks the prose names, base unchanged (the preceding fully qualified
citation of the test file), and the doc re-stamped in the following
commit together with the four docs that list README.md, the CHANGELOG or
the test file as sources (`install-fence-mechanics.md`,
`run-state-lifecycle-and-markers.md`, `review-gate-and-waivers.md`,
`subagent-contracts-superset.md`); no README citation in the bundle
starts at or after the operator section, the CHANGELOG is cited by
heading only, and the test-file citations lie above the appended guard
block, so no range moved.

CI result on the pull request (round-2 closure, orchestrator): the
`okf-anchor-guard` job failed on exactly one finding, the 2026-08-28
entry's quoted citation token, because the job gates every finding whose
message carries an anchor rule id regardless of severity, while the local
measurement above had counted only error-severity findings as gating.
The token was rewritten as prose (range and anchor text as they stood
then); re-run with the CI criterion (any anchor rule id): 0 findings.

## 2026-08-29 (agent-dx b457ee55, task T-009, implementer)

Added a new module doc for the operator-level install layer added by the
operator-apply slice: the operator home and its resolution order, the
operator manifest schema and its three read states, the single locked
read-modify-write entry point and its lock mechanics (mkdir-based mutex,
owner-token release guard, stale-lock reclaim, timeout), the implicit
target registry, the setup/apply/doctor/adopt commands and their
precedence/pin/exit-code contracts, the pin rule, and how uninstall leaves
the registry untouched. Listed it under Modules in index.md; did not touch
the Maintenance section there. Every non-trivial claim carries a
string-anchored citation into src/ or test/ only (README.md and
INSTALL-AGENT.md were deliberately left out of scope, a parallel slice is
changing them); every cited range and anchor was verified by opening the
real file and checking the anchor text sits on the range's own last
content line, occurs at most three times in the whole target file, and
occurs exactly once inside the cited range, mirroring the same three
properties this file's own docs-consistency guard enforces, before the doc
was written.

test/docs-consistency.test.ts gained four new describe blocks pinning the
doc's schema/status/command/lock claims against real src/ exports rather
than a second, hand-typed enumeration: the operator manifest's envelope,
defaults, and per-target keys are read off objects actually returned by
createOperatorManifest and upsertOperatorTarget; the seven TargetStatus
values and their exit-code grouping are checked against
adoptExitCodeForStatus itself; the four operator-facing command names are
read out of cli.ts's own command registrations rather than listed by hand;
and the lock timeout/stale-window numbers are checked against
DEFAULT_LOCK_TIMEOUT_MS/DEFAULT_LOCK_STALE_MS. The new imports were
appended just before these new blocks, not moved into the top-of-file
import block, since this file's own citation-guard comment already notes
that a top-of-file insertion shifts every existing line-numbered citation
other docs in this bundle hold into this file; confirmed by trying the
top-of-file placement first, watching three of this file's own citation
self-checks fail against other docs (model-preselection.md,
review-gate-and-waivers.md, run-state-lifecycle-and-markers.md,
subagent-contracts-superset.md all cite line ranges into this file), then
moving the imports to the end and re-running green.

The first pass at the status-vocabulary and lock-defaults pins used a
per-value `toContain` check, which is not discriminating: the doc states
`version-lag` and the `40-second`/`30-second` figures more than once, so
mutating only one occurrence still left another, unmutated occurrence
satisfying a bare substring check. Rewrote both as: the status pin now
matches the exact, comma-joined seven-status sentence built from the same
literal list the exit-code test uses; the lock-defaults pins now extract
every `<N>-second timeout`/`<N>-second staleness window` mention from the
doc (whitespace-unwrapped, so a line-wrapped mention is not missed) and
require every one of them to equal the real constant, so a mutation to
any single mention fails the check regardless of which one a later mutant
targets.

Mutation probes, run for real against the working tree, each mutated,
the named test run, then hand-restored to the exact pre-mutation text
(diffed byte-identical against a saved copy) and re-verified green: (a)
changing the doc's `version-lag` status word to `version-lagging` inside
the seven-status vocabulary sentence failed the new
"names the exact seven-status vocabulary" test; restored, green again.
(b) changing one of the doc's two `40-second timeout` mentions to
`45-second timeout` failed the new "every second-based mention of the
lock timeout" test; restored, green again.

This worktree's own packages/orchestrator-workflow/node_modules and
packages/slop-detector/node_modules were plain empty directories rather
than symlinks into the main checkout (unlike the worktree root's own
node_modules), which made `typescript` and the slop-detector build
unresolvable; re-pointed both as symlinks to the corresponding directory
in the main checkout before running anything, the same way the worktree
root's own node_modules is already set up. Not a source change, and not
staged.

`npm test`: green, +10 tests over the prior state of this file (the four
new T-009 describe blocks). `npm run typecheck` and `npm run
typecheck:test`: clean. `npm run format` (rewrote only
docs-consistency.test.ts, no other file changed) then `npm run
format:check`: clean. `node scripts/check-cli-flag-order.mjs` (from the
repository root): clean. From the repository root: `npx -y okf-kit@0.8.0
check --json packages/orchestrator-workflow/docs/okf --require-anchors
--require-anchors-allow README.md packages/orchestrator-workflow/README.md
INSTALL-AGENT.md packages/orchestrator-workflow/INSTALL-AGENT.md` reports
0 gating findings; warnings and notices are unchanged from the pre-task
baseline, and none of them mention the new doc by name. `node
packages/slop-detector/dist/cli.js check . --pack placement-slop --config
slop.config.yml` (after building slop-detector, whose dist was missing):
clean.

Not done: no further scope. `src/`, README.md, INSTALL-AGENT.md,
CHANGELOG.md, and every other OKF doc are untouched.

Fix round 1 (agent-dx b457ee55, task T-009, implementer, closing round-1
review): closed H1 (the adopt section wrongly claimed doctor's own
multi-target exit code was "built from" `adoptExitCodeForStatus`'s
per-status mapping; rewritten as adopt's own single-target mapping,
deliberately finer than doctor's own two-way `0`/`1` aggregate, with
citations to both), M1 (the doctor section's exit-code paragraph was
missing the third exit-2 path: a `--prune` run whose locked write throws
is caught in `cli.ts` and prints a differently-shaped JSON object with
`error: "operator-manifest-locked"`/`"operator-manifest-write-failed"`
plus `message` and no `unvalidatedDropped`; added, and narrowed the two
sentences that were false outside that path), M2 (the three schema-key
pins were not discriminating against an added field; each now also
asserts an exact `toEqual` key list, in addition to the existing per-key
`toContain` loop), M5 (the "available for human output" sentence cited
`TargetReport`'s `--json`-contract field range instead of its own doc
comment; re-anchored to `TargetReport`'s own doc comment and reworded to
"exist only for the human-output printer"), L1 (narrowed "the only case that returns
before registering is the pin gate" to "the only case that runs the
install and then returns without registering", naming apply's other
early returns and their real exit codes), L2 (apply's own precondition
failures split across both exit codes, not only 1; fixed the adopt
section's contrast accordingly), L3 (added the well-formed-row qualifier
to the registry-removal claim, citing `readOperatorManifest`'s per-entry
filter), L4 (dropped the `(T-009)` suffix from the four describe titles;
provenance stays in the block comments). Also added one new describe
block (three `it`s) that derives doctor's own status-to-exit-1 set from
`doctor.ts`'s source text and asserts doctor's own paragraph never
attaches a status to exit `2` while adopt's own paragraph names the full
`0`/`1`/`2` mapping (the reviewer's suggested missing test for H1); the
second suggested missing test was folded into the M2 fix above rather
than added separately, since the `toEqual` list is the "stores exactly
..." pin itself.

Every new or changed citation was re-verified against this file's own
"last content line" / "at most 3 times file-wide" / "exactly once in
range" guard (`describe("every string-anchored docs/okf citation's anchor
is load-bearing ...")`): several of the first-draft anchors for this fix
round failed that guard even though the ranges themselves were correct
(most commonly, the literal `process.exitCode = N;` line recurs more than
3 times across `cli.ts`, and a doc-comment's closing `*/` counts as a
content line under this guard's own boilerplate definition, unlike `});`
or a bare `}`); every citation below was narrowed or re-pointed until the
guard was green, verified by running `npx vitest run
test/docs-consistency.test.ts` after each change, not by inspection alone.

Mutation probes, run for real against the working tree: (a) the M2 probe
named by the reviewer, adding `pin?: string` to `OperatorTarget` and
`pin: "mutation-probe"` to `upsertOperatorTarget`'s push branch in
src/operator-manifest.ts, failed the new "names every OperatorTarget
registry-entry key" test (`toEqual` mismatch: `path`, `lastAppliedVersion`,
`lastAppliedAt`, `pin` vs. the expected three-key list); `src/` was then
restored from a pre-mutation copy and `cmp`-verified byte-identical, and
the test re-run green. (b) The two pre-existing pins from the original
T-009 pass were re-verified against this round's edited doc: changing
`version-lag` to `version-lagging` inside the seven-status sentence still
fails "names the exact seven-status vocabulary"; changing one of the two
`40-second timeout` mentions to `45-second timeout` still fails "every
second-based mention of the lock timeout"; both restored and re-verified
green.

`npx vitest run test/docs-consistency.test.ts`: green (+3, all from the new
H1-discriminator describe block; the three schema-key `it`s each gained one additional
`toEqual` assertion without becoming new tests). `npm test`: green across
the whole package. `npm run typecheck` and `npm run typecheck:test`:
clean. `npm run format` reformatted only `docs-consistency.test.ts` (this
file's own new blocks); `npm run format:check` then clean; the full suite
was re-run green after the reformat. `node scripts/check-cli-flag-order.mjs`
(from the repository root): clean. `node packages/slop-detector/dist/cli.js
check . --pack placement-slop --config slop.config.yml`: clean. Grepped
both changed files for em dashes and control characters: none (one
pre-existing em dash in the guard file is untouched by this round, outside
its scope).

Committed the doc/test fixes first (fix commit), confirmed via `npx -y
okf-kit@0.8.0 check --json packages/orchestrator-workflow/docs/okf
--require-anchors --require-anchors-allow README.md
packages/orchestrator-workflow/README.md INSTALL-AGENT.md
packages/orchestrator-workflow/INSTALL-AGENT.md` that editing
`docs-consistency.test.ts` in that commit produced exactly the four STALE
warnings M4 predicted (model-preselection.md, review-gate-and-waivers.md,
run-state-lifecycle-and-markers.md, subagent-contracts-superset.md, each
naming `test/docs-consistency.test.ts` as the changed source), then
re-stamped those four docs' `timestamp` frontmatter to `2026-08-29T05:40:16Z`
in this separate, later commit per the Maintenance rule (a stamp in the
same commit as the source edit is stale by construction, since
`sources-fresh` compares commit times). Re-ran the same okf-kit command
after the re-stamp commit: 0 errors, 13 warnings (down from 17; the 4
STALE warnings are gone, leaving the pre-existing baseline of 12
`install-fence-mechanics.md` short-form-citation warnings and the one
blank-start-line warning on the README citation at line 105), 0 warnings naming
`operator-install-and-registry.md`.

Not done beyond this fix round: no further scope. `src/` (other than the
M2 probe, applied and restored, never committed), README.md,
INSTALL-AGENT.md, CHANGELOG.md, and every OKF doc other than the four
re-stamped above are untouched.

Rebase onto the merged slice-8 commit (orchestrator): both slices append
to `test/docs-consistency.test.ts` and to this log, so the rebase
conflicted on both files and on the four re-stamped docs; resolved by
keeping the slice-8 blocks first and the slice-9 blocks after them and
taking the later timestamp. The merge dropped the closing braces of the
slice-8 describe block at the seam (typecheck: expected a closing brace);
restored by hand. One citation-shaped token in this entry's own prose
(the README line-105 warning) was rewritten as prose.
The four docs listing the guard file as a source were re-verified (no cited
range below the appended blocks moved) and re-stamped in a commit after
the seam repair.

Fix round 2 (agent-dx b457ee55, task T-009, implementer, closing round-2
review): closed M1 (the `apply` section's registration paragraph was
inverted: it claimed the pin gate is the only case that "runs" the install
and then returns without registering, contradicting the very next
sentences, which already listed several early returns that never run the
install at all. Rewritten in two paragraphs: the pin gate and every other
early return happen BEFORE `runInit` is ever called, citing the pin gate's
own condition alongside `runInit`'s call site so the ordering is anchored,
not asserted; and, separately, registration can still fail AFTER a real
install ran, without a second install attempt, via either the
operator-manifest lock-timeout catch or the `applyRegistrationFailureMessage`
branch when the operator manifest turns unreadable or absent between this
command's own read and its later write; the "conflicted files still
register" sentence was kept unchanged), L1 (the `--json` sentence claimed
it prints "exactly" the `DoctorReport`, glossing over that every target is
first projected through `targetReportToJson` to its narrower
`TargetReportJson` shape; reworded and paired with a citation to that
`.map` call), L2 (dropped the suite-total figure from this entry's own
vitest-result sentence below, keeping only the delta), L3 (rewrote the two
citation-shaped tokens sitting in this entry's own prose, above, as plain
descriptions instead of literal `path:N` citations, since this log is
outside the anchor guard's scope but the convention against path:N tokens
in log prose still applies), L4 (the `setup`/`apply`/`doctor`/`adopt`
sections each had one load-bearing behavioural claim anchored only into a
commander `.description()` help string; each now also carries an
implementation anchor: `setup`'s claim pairs with its own
`updateOperatorManifest` call, the action's only write, targeting the
operator manifest; `apply`'s pairs with its own `upsertOperatorTarget`
call; `doctor`'s pairs with `runDoctor`'s own per-target `.map`; `adopt`'s
"touching nothing" claim now also cites the same bootstrap-branch
`updateOperatorManifest` call already anchoring its neighboring bootstrap
claim, since it is that action's own only write call too, targeting the
operator manifest and never the repository).

Added one new describe block (two `it`s) to the very end of
`test/docs-consistency.test.ts`, matching this file's established
append-at-the-end convention (several sibling docs cite this file by line
range, so an insertion anywhere else would shift those citations): (a)
asserts the doc's own `apply` section does not contain the round-2
sentence's exact wording, and (b) derives the real control-flow order
directly from `src/cli.ts`'s own source text, string-indexing the pin
gate's condition, its own `return;`, `runInit`'s call site, and the
lock-timeout catch's own `return;`, and asserts the pin gate's return
precedes `runInit` while the lock-timeout catch's return follows it, so a
future refactor that reorders the pin gate relative to the install fails
this test instead of only leaving the doc's prose to drift again.

Mutation probes, run for real: (1) reinserted the round-2 sentence into the
doc's `apply` section: failed test (a) with the expected "expected ... not
to contain" assertion error; restored from a pre-mutation copy, diffed
byte-identical, and the test re-run green. (2) In a copy-aside of
`src/cli.ts`, textually inserted the `runInit` call-site string inside the
pin gate's own `if` block, ahead of its `return;`, so the pin gate's return
would appear to follow `runInit` in source order: failed test (b) with the
expected index-ordering assertion error; `src/cli.ts` was then restored
from the pre-mutation copy and `cmp`-verified byte-identical (also
confirmed via `git hash-object` against the same blob `HEAD` already
carries), never staged, and the test re-run green. The three pre-existing
probes from the original T-009 pass and its first fix round were also
re-verified against this round's edited doc and source: `version-lag` to
`version-lagging` inside the seven-status sentence still fails "names the
exact seven-status vocabulary"; one of the two `40-second timeout`
mentions bumped to `45-second timeout` still fails "every second-based
mention of the lock timeout"; and adding `pin?: string` to
`OperatorTarget`'s push branch in `upsertOperatorTarget` still fails "names
every OperatorTarget registry-entry key"; each mutation was restored and
`cmp`-verified byte-identical before its test was re-run green.

`npx vitest run test/docs-consistency.test.ts`: green (+2 over this file's
post-round-1 state, both from the new M1-discriminator describe block).
`npm test`: green across the whole package. `npm run typecheck` and `npm
run typecheck:test`: clean. `npm run format` reformatted only
`docs-consistency.test.ts` (whitespace inside this round's own new block,
appended at the file's end; nothing earlier in the file shifted, so no
other doc's citation into this file was affected, confirmed by the still-
green anchor-guard describe blocks after the reformat); `npm run
format:check` then clean; the full suite was re-run green after the
reformat. `node scripts/check-cli-flag-order.mjs` (from the repository
root): clean. `node packages/slop-detector/dist/cli.js check . --pack
placement-slop --config slop.config.yml` (from the repository root):
clean. Grepped every line this round actually changed (the doc, this log
entry, and the new test block) for em dashes and control characters: none;
the file-wide em dashes a plain grep of the whole log or test file turns
up predate this round and are untouched by it.

`npx -y okf-kit@0.8.0 check --json packages/orchestrator-workflow/docs/okf
--require-anchors --require-anchors-allow README.md
packages/orchestrator-workflow/README.md INSTALL-AGENT.md
packages/orchestrator-workflow/INSTALL-AGENT.md` after this round's fix
commit: 0 errors, 0 findings whose message ends in an anchor rule id, no
STALE finding and no finding naming `operator-install-and-registry.md` at
all; the warning/notice counts and their contents are unchanged from the
pre-round-2 baseline (the 12 `install-fence-mechanics.md` short-form
citation warnings, the one blank-start-line warning on the README citation
at line 105, surfaced under `log.md`, and the pre-existing
`unresolved-ambiguous` notices), confirming this round's edits introduced
no new drift and needed
no re-stamp of the four docs that list `docs-consistency.test.ts` as a
source.

Not done beyond this fix round: no further scope. `src/cli.ts` and
`src/operator-manifest.ts` (both touched only by the probes above, applied
and restored, never committed), README.md, INSTALL-AGENT.md,
CHANGELOG.md, and `docs/okf/index.md` are untouched.

Orchestrator note after fix round 2: the round's okf-kit measurement was
taken before its commit, so the four docs listing the guard file as a
source came out stale by commit time once the fix commit existed (four
sources-fresh warnings); re-verified (no cited range below the appended
blocks moved) and re-stamped in this separate commit.

Round-3 notes (reviewer accept_with_notes, closed by the orchestrator): the
apply-order pin was negative only (the exact inverse of the corrected
sentence stayed green in the reviewer's probe); two positive assertions
were added, one on the ordering sentence and the order of its two
citations, one on the post-install registration-failure paragraph, and
the inverse-sentence probe is now red. The doctor walk sentence is scoped
to the plain path with a pointer to the locked walk under --prune. The
misleading source comment above apply's registration step in cli.ts (it
names the pin gate as the only pre-registration return) is a follow-up in
src, outside this docs slice. The four docs listing the guard file as a
source are re-stamped in the commit after this one.

- 2026-08-30 (agent-tasks 84917365): the 19 `anchor-required` findings the
  `okf-anchor-guard` job's `--require-anchors-allow` allowlist has exempted
  since batch 31 (agent-tasks 8c89aa12, README.md/INSTALL-AGENT.md
  citations) are now all anchored, and the allowlist flag is removed from
  the "Anchor-citation guard" step's `okf-kit check` command entirely, so
  `--require-anchors` applies to the whole bundle with no exemption.
  Measured on the working tree before this task's edits (`node
  packages/okf-kit/dist/cli.js check --json
  packages/orchestrator-workflow/docs/okf --require-anchors`, built
  okf-kit@0.8.0): 54 total findings, 19 tagged `[anchor-required]` (8
  `README.md`, of which 1 is the `packages/orchestrator-workflow/`-
  prefixed spelling; 11 `INSTALL-AGENT.md`, of which 1 is prefixed), 35
  non-anchor findings, matching batch 31's own count. All 19 live in
  `install-fence-mechanics.md` (6), `model-preselection.md` (11), and
  `run-state-lifecycle-and-markers.md` (2); each got a `#"..."` string
  anchor citing exact, verified-unique text on its own cited range's last
  content line, no citation converted to prose or short form.

  One of the 19 could not be anchored on its original end line: an
  anchor's text may not itself *contain* a backtick (`CITATION_RE`'s
  quoted-anchor group excludes it), but a code span's backtick-free
  *inner* text is still a legal anchor (the check is a plain substring
  test, `lines[i].includes(anchor.text)` in okf-kit's
  `citations-resolve.ts`); a fully backtick-wrapped line is only
  unanchorable when it carries no backtick-free substring at all.
  `model-preselection.md`'s `INSTALL-AGENT.md:239-261` citation (the
  example `manifest.json` fence) ends on a bare ```` ``` ```` closing-fence
  line, which okf-kit's `isContentLine` does not treat as boilerplate
  (only `]`/`)`/`}`/`;`/`,` runs are), so the computed "last content line"
  landed on that all-backtick line with literally nothing else on it;
  re-pointed to `INSTALL-AGENT.md:239-260` (drops only the fence delimiter
  itself, keeps the whole JSON body), whose computed last content line
  falls back past the lone `}` to the `"installedAt"` line. This is not a
  de-citation: it still cites the same passage, just with an end line that
  lands on real content instead of a pure fence-punctuation line.

  Verified after committing (`node packages/okf-kit/dist/cli.js check
  --json packages/orchestrator-workflow/docs/okf --require-anchors`,
  committed tree): 35 total findings, 0 tagged `[anchor-required]` (or any
  other `anchor-*`/`heading-section-*`/`test-range-straddles-block`
  finding): the same 35 non-anchor findings as the pre-edit baseline
  (12 `install-fence-mechanics.md` `test-range-start-not-head` warnings
  and 1 `test-range-end-not-closing` notice, both short-form test-file
  citations; 1 `log.md` blank-start-line warning; 21 `log.md`
  unresolved-ambiguous notices), confirming no new drift. The
  `okf-anchor-guard` job's real
  "Anchor-citation guard" step logic (its jq filter over the same report,
  matching `\[(anchor-[a-z-]+|heading-section-[a-z-]+|test-range-
  straddles-block)\]$`) was reproduced locally against the committed tree
  with a wrapper `okf-kit` shim on `PATH` execing the built CLI: count 0,
  exit 0, "Clean, 0 anchor findings." The "Self-test the anchor-finding
  filter" step (its own throwaway drifted fixture under `$RUNNER_TEMP`,
  unaffected by this bundle's content) was reproduced the same way:
  1 finding in each of the seven anchor families, "Self-test OK", exit 0.

  Negative control: on the committed tree, deleting the `#"one directory
  per unit of work, newest = active"` anchor from
  `run-state-lifecycle-and-markers.md`'s citation into
  `packages/orchestrator-workflow/README.md` (its lines 91 through 96,
  working tree only) and re-running both the
  bare `okf-kit check --require-anchors` command and the CI step's jq
  filter reproduced 1 `[anchor-required]` finding, count 1, exit 1 (red);
  `git checkout -- packages/orchestrator-workflow/docs/okf/run-state-
  lifecycle-and-markers.md` restored it, re-run: 0 findings, count 0,
  exit 0.

  Baseline comparison (batch 31's own committed shape, allowlist still
  present): `git show 5c286cb:.github/workflows/ci.yml` still carries
  `--require-anchors-allow 'README.md' 'packages/orchestrator-workflow/
  README.md' 'INSTALL-AGENT.md' 'packages/orchestrator-workflow/
  INSTALL-AGENT.md'`; running `okf-kit check --json
  packages/orchestrator-workflow/docs/okf --require-anchors` (no
  allowlist flag) against that same commit's docs/okf tree reports the 19
  `[anchor-required]` findings above, matching this task's own pre-edit
  measurement.

  Other verification on the committed tree: `npm test --prefix
  packages/orchestrator-workflow` green, including
  `test/docs-consistency.test.ts`'s anchored-citation assertions and the
  three new assertions added this round that the `okf-anchor-guard` job's
  "Anchor-citation guard" step runs `--require-anchors` with no
  `--require-anchors-allow` exemption (fix-round-2, finding F7a); `npm run
  typecheck --prefix packages/orchestrator-workflow` clean; root `node
  packages/slop-detector/dist/cli.js check . --pack placement-slop
  --config slop.config.yml` clean. `install-fence-mechanics.md`,
  `model-preselection.md`, and
  `run-state-lifecycle-and-markers.md` (the three edited docs) had their
  `timestamp:` frontmatter bumped in this commit; a post-bump
  `sources-fresh` re-check reported no new STALE findings.

  Fix-round-2 (review findings F1-F7): re-pointed one citation off a wrong
  passage (README.md's orchestrator-runs-on-session-model statement is at
  `:194-196`, not the full->minimal downgrade passage the round-1 citation
  actually named), restored `README.md:211-214` to its full range (the
  narrowing rationale in the paragraph above was wrong: an anchor may not
  contain a backtick, but a code span's backtick-free inner text is a
  legal anchor, so that citation never needed narrowing), tightened two
  anchors that pinned a range end past the paragraph their sentence
  actually describes, trimmed the CI comment, corrected this entry's own
  wording (verdicts instead of suite totals, an accurate `npm test`
  invocation, one em dash), and added the missing coverage for the
  guard step itself: `test/docs-consistency.test.ts` now asserts the
  `okf-anchor-guard` job's "Anchor-citation guard" step runs
  `--require-anchors` with no `--require-anchors-allow` exemption
  (mutation-probed: re-adding the flag to that step in a working-tree
  edit turned the new assertion red; reverting restored green). That
  test-file edit landed after this entry's `docs-consistency.test.ts`-line
  citations above and did not shift any of them (re-verified: the
  post-edit `--require-anchors` re-check still reports 0 anchor-family
  findings), but it did trip `sources-fresh` STALE on three docs that list
  `test/docs-consistency.test.ts` as a source
  (`review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
  `subagent-contracts-superset.md`); all three had their `timestamp:`
  bumped in this commit too, re-check: 0 STALE.
- 2026-08-30 (agent-tasks 613316c9, `init --harness none` templates-only
  mode): `install-fence-mechanics.md`'s AGENTS.md-write bullet re-verified
  and reworded (the write is now gated on `options.harnesses.length > 0`,
  no longer unconditional), and a new "`--harness none` (templates-only
  mode)" section added, citing `detect.ts` (new `parseHarnessOption`),
  `init.ts` (the harness-length guard and the manifest's `harnesses: []`
  record), and `cli-inputs.ts`/`cli.ts` (the `previousIsRecordedManifest`
  re-run-stickiness flag and the `installedForClause` summary-line helper).
  `model-preselection.md` and `operator-install-and-registry.md` needed no
  content change (neither describes `--harness`/init-writes mechanics
  directly) but had citations into `cli.ts`/`cli-inputs.ts`/`init.ts` that
  shifted from the same source edits, re-pointed in this commit; two
  hardcoded citation strings in `test/docs-consistency.test.ts` itself
  (the apply pin-gate-before-runInit ordering test) shifted the same way
  and were updated to match. `test/init.test.ts` gained a new describe
  block (fresh templates-only install shape, idempotence, additive
  `--harness claude` follow-up, plus three CLI-smoke cases: `--harness
  none` end to end, `none,claude` as a usage error, and re-run stickiness
  with a harness config appearing on disk after the templates-only
  install); every full citation into it from `install-fence-mechanics.md`
  and `model-preselection.md` re-pointed to match, verified individually
  (anchor text present, on the cited range's last content line, occurring
  exactly once in range) rather than by uniform offset, since the new
  block's placement plus a Prettier reformat pass shifted different
  pre-existing citations by different amounts depending on which side of
  the insertion they fell on. Round 1 did not do the same for
  `install-fence-mechanics.md`'s 15 bare continuation citations
  (the `(:N-M` short form) into `test/init.test.ts`; those were left
  unpointed against the grown file and are corrected in the round-2 entry
  below, not here as this entry originally (and incorrectly) claimed.
  `README.md` gained a "Templates-only mode"
  paragraph plus example under "Non-interactive"; every `README.md:N-M`
  citation across the whole bundle (`install-fence-mechanics.md`,
  `model-preselection.md`, `run-state-lifecycle-and-markers.md`, and
  `log.md`'s own historical entries reference CHANGELOG.md via
  version-heading anchors (e.g. `CHANGELOG.md:#[0.9.0]`), not `README.md`
  line numbers, so those were unaffected) re-pointed the same way.
  `CHANGELOG.md` gained an `[Unreleased]` "Added" entry; no bundle doc
  cites the `[Unreleased]` heading itself, and every existing
  version-heading citation into `CHANGELOG.md` targets an already-released
  version, so nothing else needed re-pointing there.

  Commands run on the committed tree, in the package directory unless
  noted: `npm run typecheck` (clean), `npm run typecheck:test` (clean),
  `npm run build` (clean), `npm test` (green), `npm run format:check`
  (clean, after one `prettier --write test/init.test.ts` pass), `node
  ../../scripts/check-cli-flag-order.mjs` from the repo root (clean), and
  the CI's own bundle check invocation, `node
  packages/okf-kit/dist/cli.js check --json packages/orchestrator-workflow/docs/okf
  --require-anchors --require-anchors-allow 'README.md'
  'packages/orchestrator-workflow/README.md' 'INSTALL-AGENT.md'
  'packages/orchestrator-workflow/INSTALL-AGENT.md'` from the repo root:
  0 errors, 0 findings in the CI guard's blocking set
  (`anchor-`/`test-range-straddles-block`/`heading-section-`), 0 STALE
  sources-fresh findings.
- 2026-08-30 (agent-tasks 613316c9 round 2: merge plus round-1 review
  findings F1-F7): merged origin/master (task 84917365) into this branch.
  Conflicts in the three docs master had re-anchored (install-fence-
  mechanics, model-preselection, run-state-lifecycle-and-markers) were
  resolved by taking master's anchored citation text and re-deriving the
  line numbers against this branch's own grown files (README.md and
  test/init.test.ts both differ between the two branches); two more docs
  (review-gate-and-waivers, subagent-contracts-superset) conflicted on
  their `timestamp:` field only, the later value kept; this file's own
  tail conflicted (both branches append), master's entry kept first,
  this branch's second.

  Applied review round 1's F1-F7. F1 (HIGH): the harnesses-stickiness
  gate keyed off a bare empty-array check, so a damaged manifest (a
  missing or malformed `harnesses` field, which readInstalledManifest
  already sanitizes to an empty array) degraded a fully installed repo to
  templates-only on a plain re-run. `Manifest` gained `harnessesRecorded`,
  set from whether the raw JSON's `harnesses` field was itself an array
  before filtering; the gate now requires it. F3 (MEDIUM): dropping a
  harness (including the whole set collapsing to none) left every one of
  its files on disk but untracked with no note, unlike the existing
  profile-downgrade and tiers-off leftover notes; a third ledger-driven
  note loop was added, plus a same-shaped note for AGENTS.md/CLAUDE.md
  (never ledger-tracked) when the harness set becomes empty. F4 (MEDIUM):
  the stickiness branch pre-empted the interactive prompt entirely; it now
  only short-circuits a non-interactive call, and an interactive re-run
  still prompts with nothing pre-checked from the old recording. F6
  (LOW): a repeated "none" (`none,none`) tripped the same usage error as
  an actually different entry; the entry list is deduplicated before the
  arity check. F7 (LOW): one em dash in this bundle's new prose, one
  overstated README claim, and this file's own round-1 entry recording a
  suite total instead of a verdict, all corrected in place; see the round-1
  entry above, whose "verified individually" claim about every citation
  into `test/init.test.ts` was itself false: 15 bare continuation
  citations were left unpointed, corrected in this round (see that
  entry's own in-place correction). F2's docs re-stamp is folded into this
  entry rather than kept separate, since applying F1/F3/F4/F6 shifted the
  same lines the merge had just re-pointed.

  Every citation into the five touched source files (`init.ts`,
  `cli-inputs.ts`, `detect.ts`, `test/init.test.ts`,
  `test/cli-inputs.test.ts`) across `install-fence-mechanics.md`,
  `model-preselection.md`, and `operator-install-and-registry.md` was
  re-verified against the final, post-fix file content (anchor text
  present, on the cited range's last content line); the 15 bare
  continuation citations were re-pointed the same way, each opened and
  confirmed to name the test the sentence describes rather than assumed
  from a uniform offset. `README.md` grew twice on this branch (once at
  the merge, once again from F4's wording change); every `README.md`
  citation across the same three docs plus `run-state-lifecycle-and-
  markers.md` was re-verified against its final content, not just its
  state right after the merge.

  Commands run on the committed tree, in the package directory unless
  noted: `npm test` (green, all passing), `npm run typecheck` (clean),
  `npm run typecheck:test` (clean), `npm run build` (clean), `npm run
  format:check` (clean, after one `prettier --write test/cli-inputs.test.ts`
  pass), `node ../../scripts/check-cli-flag-order.mjs` from the repo root
  (clean), root `node packages/slop-detector/dist/cli.js check . --pack
  placement-slop --config slop.config.yml` (clean, 416 files scanned).

  CI's own bundle check invocation, now with no allowlist (master's task
  84917365 removed it): `node packages/okf-kit/dist/cli.js check --json
  packages/orchestrator-workflow/docs/okf --require-anchors` from the repo
  root: 0 errors, 1 warning, 21 notices; 0 findings in the CI guard's
  blocking set. `install-fence-mechanics.md`, `model-preselection.md`,
  `operator-install-and-registry.md`, and `run-state-lifecycle-and-
  markers.md` had their `timestamp:` frontmatter bumped in this commit
  (each lists at least one of the five source files this round touched);
  a post-bump re-check reported no new STALE findings. The one remaining
  warning is this file's
  own historical negative-control sentence citing a `README.md` range as
  it stood mid-round-1 (a narrative record of a past state, not a live
  pointer, deliberately left unrewritten); the 21 notices are all
  pre-existing `unresolved-ambiguous`/`blank-start-line` findings inside
  this file's own older entries. Compared against origin/master (task
  84917365's own commit) run the same way inside a real git checkout
  (the read-only main checkout, not a `git archive` extraction, which
  skips every git-backed check and falsely reports clean): 0 errors, 13
  warnings, 22 notices -- master's own bundle already carries the same
  class of stale short-form `test/init.test.ts` continuation citations
  this round fixed, plus one historical `log.md` finding of its own; this
  branch's head carries fewer warnings and notices than that baseline, no
  new warning class introduced.

  CLI drive-through in a fresh temp git repo, using the built
  `dist/cli.js`: `init . --harness none --yes` (templates only, 0
  harnesses recorded) -> `init . --yes` (stayed templates only, the F1/F4
  stickiness path) -> `init . --harness claude --yes` (installed for:
  claude) -> `init . --harness none --yes` over that install (templates
  only again, printing eight "now untracked after --harness dropped
  claude"/"...dropped to none" notes naming the six `.claude/` files plus
  `AGENTS.md`/`CLAUDE.md`, the F3 fix) -> hand-deleted the manifest's
  `harnesses` field -> `init . --yes` (installed for: claude, not
  templates only, confirming F1's fix over a damaged manifest); a
  separate fresh target's `init . --harness none,none --yes` exited 0
  (F6's fix; previously a usage error).

  Mutation probe M1 (F1): removed the `previous.harnessesRecorded &&`
  line from the stickiness gate in `cli-inputs.ts`. Result: both the
  restored malformed-manifest test (`test/init.test.ts`) and the
  dedicated damaged-manifest unit test (`test/cli-inputs.test.ts`) turned
  red (expected `["claude"]`, got `[]`). Restored the line, re-ran: both
  green again.

- 2026-08-30 (agent-tasks 613316c9 round 3: round-2 review findings F1/F2
  plus L1-L3): F1 (repeated, MEDIUM) was still live after round 2's own
  fix -- the stickiness signal was captured from `Array.isArray` on the
  raw JSON `harnesses` field BEFORE the known-harness filter ran, so a
  manifest whose raw array had entries that all failed that filter (an
  unrecognized name, or the right name in the wrong case) still recorded
  the signal true, filtered down to an empty array, and stuck a live
  install to templates-only on a plain re-run. Renamed the field to
  `harnessesRecordedEmpty` and computed it from the raw array's own
  (pre-filter) length instead, so only a genuinely empty raw array sets
  it. The dropped-harness note loop shared the same root cause a
  different way: it derived which harness's files to note as untracked
  from the sanitized `previous.harnesses`, so a harness whose name was
  lost the same way left its files silently unmentioned; it now walks
  every known harness's own file-ledger prefix directly, independent of
  what the (possibly damaged) harnesses array says. F2 (MEDIUM, new):
  `promptHarnesses`'s own "nothing known" fallback pre-checked `claude`
  unconditionally, including on the templates-only interactive branch,
  where nothing is ever detected by construction, contradicting the
  README's and the function's own "nothing forced pre-selected" claim;
  gave it an explicit `fallbackToClaude` parameter the templates-only
  branch passes `false`.

  Tests added: a dedicated CLI-level pair (hand-written manifest with
  `harnesses` set to an unrecognized single-entry array, one lower-case
  and one differently-cased) asserting the install recovers to the live
  harness rather than sticking; a `resolveInitInputs`-level unit case
  modeling the same raw shape; an interactive-prompt unit case asserting
  no checkbox is pre-checked when nothing is detected and nothing was
  previously recorded; a `runInit`-level pair covering the dropped-note
  loop against a hand-corrupted manifest (one asserting the ledger-driven
  fix directly, one covering a partial two-harness drop that leaves the
  surviving harness's files and the AGENTS.md/CLAUDE.md note alone); and
  an `apply --harness none` end-to-end CLI case confirming the CHANGELOG's
  "apply shares the same option parsing" claim holds. The four new
  `runInit`/CLI-level tests were appended as new `describe` blocks at the
  very end of `test/init.test.ts` rather than inlined near the code they
  cover, deliberately: every citation in this bundle naming a
  `test/init.test.ts` line range would otherwise have shifted out from
  under an insertion made earlier in the file, and did on a first attempt
  before this was caught and reverted.

  Mutation probes: M1 (F1) reverted `harnessesRecordedEmpty` back to the
  round-2-era "was an array" signal (`Array.isArray` alone, no length
  check). Result: both new CLI-level all-unknown-names tests turned red
  (expected `installed for: claude`, got the install stuck at
  templates-only). Restored, re-ran: green again. M2 (F2) dropped the
  `fallbackToClaude: false` argument at the templates-only branch's
  `promptHarnesses` call site. Result: the new interactive-prompt unit
  test turned red (expected every choice unchecked, `claude` came back
  checked). Restored, re-ran: green again.

  Verification: `npm test` (green, one dogfood test in
  `test/docs-consistency.test.ts` initially caught two anchors this round
  introduced that collided with existing text elsewhere in
  `test/init.test.ts` above the 3-occurrence cap; both re-picked, then
  green), `npm run typecheck` and `npm run typecheck:test` (clean),
  `npm run build` (clean), `npm run format:check` (clean, after one
  `prettier --write` pass on the two touched source files, which reflowed
  a couple of long lines and required a second re-point pass over every
  affected citation), `node scripts/check-cli-flag-order.mjs` from the
  repo root (clean), and `node packages/slop-detector/dist/cli.js check .
  --pack placement-slop --config slop.config.yml` from the repo root
  (clean). `okf-kit check --require-anchors` against the committed bundle:
  0 errors, 0 findings in the blocking set, 0 warnings; the same 21
  pre-existing `unresolved-ambiguous` notices as before this round,
  unrelated to it (well under the round's own "do not exceed head"
  budget, since head going into this round already carried 21 warnings
  from stale citations this round's own line-shift firefighting also
  happened to clean up).

  CLI drive-through in a fresh temp git repo, using `tsx` against the
  package's own source (not the built `dist/`): installed claude, hand-
  edited the manifest's `harnesses` field to a single unrecognized name,
  re-ran a plain `init --yes` -- printed `installed for: claude`, the
  manifest's `harnesses` recovered to the live harness, and every one of
  the five role files plus the skill file were back in the file ledger
  (no ledger loss). A second temp repo: installed claude, then hand-set
  `harnesses` to a real empty array and re-ran a plain `init --yes` --
  stayed at `templates only` as the deliberate-`none` case still requires,
  confirming the fix did not also loosen the genuine stickiness rule.

## 2026-08-31 (agent-tasks 8602a952, implementer)

Task: `apply` did not carry the harnesses-stickiness fix from `init`
(agent-tasks 613316c9) forward to itself. `resolveInitInputs`'s
`previousIsRecordedManifest && previous.harnessesRecordedEmpty` gate only
ever saw `true` for `init`'s own call site (its `resolveInitInputs` call
already passed `previousIsRecordedManifest: true` before this round);
`apply`'s action never passed the flag at all, and its
synthetic `buildApplyPrevious` manifest never carried `harnessesRecordedEmpty`
through from the target's own repo manifest, so the gate could never fire
for `apply`. A target `apply`-installed as templates-only (`--harness none`,
a real recorded `harnesses: []`) could silently widen back out on a plain,
non-interactive `apply` re-run to the operator manifest's default harness
or whatever `detectHarnesses` found on disk, both of which install-fence-
mechanics.md's own "Templates-only mode" section named as a known,
deliberately-left-open gap before this round.

Fix: `buildApplyPrevious` (src/cli.ts) now carries
`harnessesRecordedEmpty: repoManifest?.harnessesRecordedEmpty` into the
synthetic `previous` it returns, and the `apply` action's `resolveInitInputs`
call now passes `previousIsRecordedManifest: Boolean(repoManifest)` (not
`Boolean(previous)`, since `buildApplyPrevious` always returns a defined
object even for a target with no manifest of its own). The existing gate in
`cli-inputs.ts` needed no change: both flags together already distinguish a
real recorded `harnesses: []` from a missing/malformed `harnesses` field
(which sanitizes to the same `harnesses: []` but `harnessesRecordedEmpty:
false`), so a damaged manifest still falls through to `apply`'s existing
`resolveApplyHarnesses` fallback chain (target's recorded harnesses, else
the operator defaults, else detection) unchanged. Interactive `apply` is
unaffected in practice, not just in intent: `resolveInitInputs`'s
interactive branch for this gate calls `promptHarnesses(detected, [],
false)`, but `detected` here is `resolveApplyHarnesses`'s result, which is
never empty for `apply` (its own fallback chain always resolves to at least
the operator default or `["claude"]`) -- unlike `init`'s call site, where
`detected` really is always empty in this branch. So an interactive
`apply` re-run on a templates-only target still starts with whatever
`resolveApplyHarnesses` returned pre-checked, and a bare Enter re-widens
the install exactly as it did before this round; `fallbackToClaude: false`
is live for `init` and dead code on `apply`'s interactive path. Left as a
known residual (see the extended comment at
cli-inputs.ts lines 39-50 in that commit in this
round's commit); fixing the interactive case is out of this task's scope.

Tests added: a CLI-level `apply.test.ts` case chaining three `apply` runs
against one target (an `apply --harness none` fresh install, a stray
`CLAUDE.md` written to disk plus an operator `setup --yes` default of
`claude`, a flagless `apply --yes` re-run asserting `templates only` and no
`.claude`/`AGENTS.md` written, then an explicit `apply --harness claude`
re-run asserting the upgrade still works), and a second case covering a
hand-written repo manifest with no `harnesses` field at all (not a real
recorded empty set), asserting a flagless `apply` still falls back to the
operator default (`installed for: claude`).

Mutation probe: reverted the `apply` action's `resolveInitInputs` call to
omit `previousIsRecordedManifest` (the pre-fix state). Result: the new
sticky test's `expect(result.stdout).toContain("templates only")` assertion
turned red -- the re-run installed `claude` instead (`installed for:
claude` printed, `.claude` written), reproducing the exact gap this round
closes. Restored, re-ran: green again.

Verification: `npm test` (all 584 tests green, including
`test/docs-consistency.test.ts`'s citation guard, after re-pointing every
`cli.ts`/`cli-inputs.ts` citation shifted by this round's doc-comment
insertions across `install-fence-mechanics.md`, `operator-install-and-
registry.md`, and `model-preselection.md`, plus three hardcoded citation
strings inside `test/docs-consistency.test.ts` itself), `npm run
typecheck` (clean). `okf-kit check --require-anchors --json` against the
committed bundle (this round's own commit, plus review round 1 below)
versus the same command against a `git archive` of master (672932f,
pre-round, re-`git init`'d so citation resolution runs inside a git work
tree): base reports 21 findings, all severity `notice`, all
`citations-resolve`/`unresolved-ambiguous` (a bare filename matching more
than one file in the monorepo, e.g. an unqualified init.ts or SKILL.md
mention); HEAD after review round 1 reports 22 findings, the same 21
`notice`s plus one new `warning` (`citations-resolve`/`blank-start-line`,
on the reverted README.md citation two paragraphs below) -- the direct,
expected result of
review round 1's own fix below (reverting a citation this entry had
drifted into re-pointing), not a regression introduced by anything else in
this round.

Review round 1 (implementer, same task): five fixes. (1) `cli.ts`'s
"Found existing install" line no longer prints the same `none recorded`
phrase for a real recorded `harnesses: []` and for a
missing/malformed/all-unknown `harnesses` field; the sticky case now
prints `none (recorded templates-only)`, and `apply.test.ts`'s sticky test
asserts the new phrase. (2) The paragraph above claiming interactive
`apply`'s checkbox "now starts from nothing pre-checked" was false:
`resolveInitInputs`'s interactive branch for this gate passes `detected`
(here, `resolveApplyHarnesses`'s result, never empty for `apply`) into
`promptHarnesses`, which still pre-checks it regardless of
`fallbackToClaude`; only `init`'s call site ever has a genuinely empty
`detected` there. Corrected above; `cli-inputs.ts`'s doc comment extended
to state the "detected is always empty there" premise holds only for
`init`'s call site. (3) `apply.test.ts`'s stray-`CLAUDE.md` sticky test
comment overclaimed it "proves the sticky gate wins over detection": with
a non-empty operator default, `resolveApplyHarnesses` never even calls
`detectHarnesses`, so that test does not exercise detection at all; the
comment is corrected and a new test added with the operator default itself
also `harnesses: []` (`setup --harness none`), which does force
`resolveApplyHarnesses` to call `detectHarnesses` (the stray `CLAUDE.md`
makes it report `["claude"]`), and confirms the sticky gate still wins.
(4) Two more `apply.test.ts` cases: a hand-written manifest naming only an
unknown harness (`["cursor"]`, sanitizes to `harnesses: []` but
`harnessesRecordedEmpty: false`) asserts the fallback chain still runs
(`installed for: claude`); an `apply --sync --yes` run on a recorded-`[]`
target asserts `--sync` does not disturb harnesses stickiness (`templates
only`). (5) This log entry's citation drift: the sibling entry above
(2026-08-30, `install-fence-mechanics.md` §"anchor-required findings")
had one bare README.md citation to line 121 re-pointed to line 123 when
this round's own README.md edits shifted the line, while its sibling
citations in the same paragraph were left at their original numbers -- an
inconsistent, ad hoc bump. A log entry records a past state; reverted the
one re-point back to line 121 so the paragraph is internally consistent
again (same rule already followed by every other historical entry in this
file: recorded citation numbers are not bumped when a later change moves
the cited lines). The reverted line 121 now lands on a blank line in the
current README.md (the `okf-kit` warning noted above), which is the
expected cost of that rule, not a defect to fix.

Tests: `npm test` and `npm run typecheck` both re-run clean after review
round 1 (see the updated counts above). Mutation probes: (a) reverted the
phrase derivation in `cli.ts` to always print `none recorded` -- the
sticky test's new phrase assertion turned red; restored, green again. (b)
temporarily reapplied `previousIsRecordedManifest: false` in the `apply`
action -- the new detection-leg test's `templates only` assertion turned
red (installed `claude` instead); restored, green again.
- 2026-09-01 (fix round 2, agent-tasks 2355f144): fix round 1
  (274d3ea9, 4a4a7f7d) had added the implementer output contract's
  `commits` field to SKILL.md and implementer.md, the misfire-rule clause,
  a `commits`-field `describe` block to test/docs-consistency.test.ts, and
  re-stamped review-gate-and-waivers.md, run-state-lifecycle-and-markers.md,
  subagent-contracts-superset.md, and model-preselection.md against package
  version 0.26.0+ (Unreleased). Review round 2 found the round-1 pass had
  extended neither of the "Where each contract lives" bullet's two spans
  (`SKILL.md:318-345` and `implementer.md:41-66`) past the newly added
  field, so both citations' cited ranges ended one field short of the
  block's actual last field line; fixed to `SKILL.md:318-346` and
  `implementer.md:41-67` (the block's true last content line is the
  `commits:` key itself, not its `- ""` placeholder value, which repeats
  too often across the contract to serve as a unique anchor). Added a new
  `## Commits field` section (mirroring the existing Reproduction/Mutation
  probes/Recurrence sections) describing the field's semantics (full shas
  in order, `[]` when no commit, mandatory, misfire clause) with citations
  into both copies and into the new test `describe` block; replaced the
  Subagent misfire rule section's uninformative "the `commits` clause was
  added alongside the `commits` output field itself" sentence with a
  cross-link to that new section. Fixed implementer.md's rule bullet to
  say "Report the full sha of every commit ... in order" (was "every
  commit sha ... in order"), matching SKILL.md's wording, and updated the
  matching test assertion; added a dedicated test pinning the "full sha"
  and "in order"/"in the order produced" substance in both copies, not
  only the surrounding `commits: []` clause. Re-wrapped SKILL.md's
  Subagent misfire rule paragraph to fix an 89-character rewrap artifact
  at its old line 503 (the file's convention is ~76 columns); the fix
  itself is a 5-line-to-6-line reflow of the paragraph's old lines
  502-506, net +1 line at that point, plus the two test-file edits above
  (comment rewrite, new `it` block) added a net +8 lines starting at old
  test/docs-consistency.test.ts line ~1090 -- both shifts verified with a
  `difflib`-based old-to-new line mapping (not assumed uniform), confirmed
  against actual file content at every corrected citation, not just the
  arithmetic offset. Re-anchored every `SKILL.md:` citation into the
  Subagent misfire rule section and every downstream `## Review-round
  escalation budget` citation in review-gate-and-waivers.md (uniform +1
  shift past old line 506), plus every `test/docs-consistency.test.ts:`
  citation into or past the shifted region in subagent-contracts-
  superset.md, review-gate-and-waivers.md, and model-preselection.md,
  including two bare continuation citations in model-preselection.md, for
  the tier-model-class-table guard and the opencode-effort-prose guard
  respectively, both predating this fix round and already imprecise
  (pointing partway into a preceding helper function rather than the
  `describe` line itself) but re-anchored on the same +8 offset so they
  keep resolving to the same, still-imprecise-but-content-matching target
  they did before this round. A stray backtick inside one new anchor's
  quoted text (the implementer.md rule bullet's "in order" citation,
  which had quoted the backtick-wrapped word "commits" as part of its
  anchor) tripped the anchor-content regex (which excludes backticks from
  the quoted form) and was caught by the "zero unanchored citations"
  test, not by review; shortened the anchor to drop the backtick-wrapped
  word. `npm run build` and `npm
  test` both clean (589/589). `npx okf-kit@0.8.0 check docs/okf`
  (plain, `--strict`, and `--require-anchors`) all report the same result:
  0 errors, 0 warnings, 23 notices (all `unresolved-ambiguous`: the 21
  pre-existing bare-filename collisions the bundle has carried since
  earlier passes, plus the two bare `SKILL.md` span citations this entry
  itself introduces, which collide with another package's `SKILL.md`; the
  round-1 baseline was 21). Item 6 of the fix
  brief (a derivation test asserting the superset doc enumerates every
  contract field name) was skipped: the doc's implementer section cites
  individual fields by name inside prose, it does not enumerate the full
  field list anywhere a derivation test could walk, so there is nothing
  to derive against.


## 2026-09-01 (agent-tasks fe834823, implementer)

Task: close the interactive residual the 2026-08-31 entry above left open
(its own review round 1, point 2): `resolveInitInputs`'s
harnesses-stickiness branch calls `promptHarnesses(detected, [], false)`
for both `init` and `apply`, but `detected` means different things at each
call site. For `init` it is real `detectHarnesses(targetDir)`, empty by
construction on a templates-only target. For `apply` it is
`resolveApplyHarnesses`'s fallback-chain result (the target's recorded
harnesses, else the operator manifest's defaults, else detection, else
`["claude"]`), which is never empty, so the interactive checkbox on a
deliberately templates-only `apply` re-run still pre-checked that
fallback, and a bare Enter re-widened the install exactly as before the
08-31 round's non-interactive fix, `fallbackToClaude: false` doing nothing
against it.

Fix: `ResolveInitInputsParams` gained a new optional `filesystemDetected`
field, read only by the stickiness branch's interactive prompt (`await
promptHarnesses(filesystemDetected ?? detected, [], false)`); when omitted
it defaults to `detected`, which is already real detection for `init`'s own
call site, so `init`'s behaviour is unchanged with no edit needed there.
`apply`'s CLI action now passes a fresh `detectHarnesses(targetDir)` as
this field, kept apart from `chosenHarnesses`/`detected` (still
`resolveApplyHarnesses`'s result, still used for the non-sticky branch's
own pre-check and for the console/manifest fallback, unchanged). Doc
comments on `promptHarnesses`, `ResolveInitInputsParams`,
`resolveInitInputs`, and `resolveApplyHarnesses` were rewritten to state
the fixed mechanics rather than describe the residual as still live.
(Superseded by the 2026-09-01 fix-round-2 entry below: `filesystemDetected`
was renamed to `stickyPreChecked` and `apply`'s call site now passes `[]`
instead of a fresh `detectHarnesses(targetDir)` call; this paragraph is
kept as the historical record of this round's own fix and its citations
into `cli.ts`/`cli-inputs.ts` are intentionally left unanchored since the
quoted lines no longer exist verbatim in either file.)

Tests added: four `cli-inputs.test.ts` cases in a new describe block
mirroring the existing init-style interactive-prompt test harness (mocked
`inquirer.prompt`): (1) a non-empty `detected` (simulating
`resolveApplyHarnesses`'s fallback result) with an empty
`filesystemDetected` pre-checks nothing, and a bare-Enter answer resolves
to `[]`, not the fallback; (2) with `filesystemDetected: ["codex"]`, only
`codex` is pre-checked, not the non-empty `detected`; (3) selecting
`claude` in the mocked prompt still installs it; (4) a normal
(non-templates-only) target is unaffected: the non-sticky branch still
pre-checks `detected` as before, `filesystemDetected` disagreeing on
purpose to prove it is not read there.

Mutation probe: reverted the sticky branch's call back to
`promptHarnesses(detected, [], false)` (this round's pre-fix state, the
line the 08-31 entry's review round 1 identified as dead). Result: the
new "nothing is pre-checked when filesystemDetected is empty" test turned
red (`claude`, from the simulated fallback-chain `detected`, came back
pre-checked and `result.harnesses` was `["claude"]` instead of `[]`);
restored, re-ran green again.

Verification: `npm test` (all 588 tests green, including
`test/docs-consistency.test.ts`'s citation guard, after re-pointing every
`cli.ts`/`cli-inputs.ts` citation this round's own doc-comment insertions
shifted across `install-fence-mechanics.md`, `operator-install-and-
registry.md`, and `model-preselection.md`, plus three hardcoded citation
strings inside `test/docs-consistency.test.ts` itself, the same kind of
drift the 08-31 entry above hit), `npm run build` (clean).

## 2026-09-01 (agent-tasks fe834823, fix round 2, decision D-007)

Task: the round above closed the non-interactive residual but its own fix
introduced a narrower one, caught in review: it pre-checked `apply`'s
sticky-branch prompt from a fresh `detectHarnesses(targetDir)` call (real
on-disk detection), but a harness config left on disk from something else
entirely (e.g. a stray `.claude/` directory that was never itself a
recorded install) is a weak signal next to the target's own recorded
`harnesses: []` -- the same re-widening-on-bare-Enter failure mode this
task exists to close, just moved one layer down. Acceptance criterion 1 is
literal: interactive `apply` on a recorded `harnesses: []` target must show
the prompt with nothing pre-checked at all, regardless of what is on disk.

Decision (D-007): `apply`'s sticky-branch pre-check is not "what
`detectHarnesses` finds", it is "nothing" -- the operator's recorded
`harnesses: []` is the intent that matters, and no on-disk signal should be
able to override a bare Enter back into a widened install. `init`'s own
sticky-branch behaviour (real on-disk detection pre-checked) is unchanged
and out of scope.

Fix: `ResolveInitInputsParams.filesystemDetected` was renamed to
`stickyPreChecked?: Harness[]`
(deliberately historical citation, this round's own commit:
`packages/orchestrator-workflow/src/cli-inputs.ts:190-208`; a later round,
D-002, rewrote this same field's doc comment and default again, so these
line numbers describe fix-round-2's landed content, not the live file),
with its doc
comment rewritten to state the real semantics ("the entries pre-checked
when the target recorded `harnesses: []`; defaults to `detected` for
`init`; `apply` passes `[]`"). The sticky branch now reads
`stickyPreChecked ?? detected`
(deliberately historical, same caveat:
packages/orchestrator-workflow/src/cli-inputs.ts line 307 at that commit)
instead of `filesystemDetected ?? detected`; `init`'s call site still omits
the field entirely, so its own pre-check (real on-disk detection) is
unchanged. `apply`'s CLI action now passes a hardcoded `[]`
(`packages/orchestrator-workflow/src/cli.ts:798` at that commit; deliberately
historical, the call site has since moved into `cli-apply.ts`)
instead of a fresh `detectHarnesses(targetDir)` call, which is removed from
that call site entirely (nothing else there needed it). Every comment
describing the round-1 design (`promptHarnesses`'s own comment block,
`ResolveInitInputsParams`'s field doc, the sticky-branch comment in
`resolveInitInputs`, and `resolveApplyHarnesses`'s doc comment in `cli.ts`)
was rewritten so none of them describe filesystem detection as `apply`'s
pre-check any more.

Tests: the round-1 describe block in `cli-inputs.test.ts` was replaced with
one exercising the round-2 semantics: (a) nothing is pre-checked even when
a harness IS detected (`resolveInitInputs`'s own `detected` param, the
simulated fallback-chain result, is non-empty; the checkbox label was empty
in that test too, since it is driven by the same argument) -- the
discriminating case that catches a reversion to pre-checking `detected`;
(b) selecting `claude` in the prompt still installs it; (c) bare Enter
still resolves to `[]`; (d) a normal (non-templates-only) target is
unaffected, the non-sticky branch never reads `stickyPreChecked`. The
existing "interactive re-run after a templates-only install (F4)" describe
block above (`init`'s own sticky pre-check, unchanged since it omits
`stickyPreChecked`) was left as-is, serving as the regression pin for
`init`'s behaviour.

Mutation probe: reverted the sticky branch's own call
(deliberately historical, same caveat as above:
packages/orchestrator-workflow/src/cli-inputs.ts line 307 at that commit)
from `promptHarnesses(stickyPreChecked ?? detected, [], false)` back to plain
`promptHarnesses(detected, [], false)`, ignoring `stickyPreChecked`
entirely (equivalent in effect to `apply`'s CLI action passing `detected`
straight through as its own pre-check, the same class of gap round 1 left
open one layer down). Result: the new "nothing is pre-checked even when a
harness IS detected" test turned red (`claude`
came back pre-checked instead of nothing); restored, re-ran green again.

Verification: `npm run build` (clean), `npm test` (587 tests green -- one
fewer than the round-1 count since the round-2 describe block merges two
round-1 cases into one discriminating case), and after committing,
`npx -y okf-kit@0.8.0 check docs/okf` (0 errors, 0 warnings; notice count
unchanged from round 1's own measurement against base commit 0960a39,
21 notices). Every `cli.ts`/`cli-inputs.ts` citation this round's own edits
shifted was re-pointed across `install-fence-mechanics.md`,
`model-preselection.md`, and `operator-install-and-registry.md` (some
ambiguous after the shift -- multiple identical anchor strings in `cli.ts`
across different commands -- resolved by checking which command section
of the citing doc each citation actually belongs to, not just taking the
first match), plus the same three hardcoded citation strings inside
`test/docs-consistency.test.ts` the round-1 entry above already names,
re-pointed a second time.

## 2026-09-01 (agent-tasks fe834823, fix round 3)

Task: round 2's own reviewer pass (accept_with_notes) found the fix
correct but under-guarded and under-documented: (1) the sticky-branch
wiring at the CLI action's call site was unpinned by any test -- changing
`stickyPreChecked: []` to `stickyPreChecked: chosenHarnesses` left the
suite green; (2) `install-fence-mechanics.md` pointed
`previous.harnessesRecordedEmpty` at JSDoc prose instead of the gate
itself; (3) three places (a test title/comment and `log.md`'s own round-2
Tests paragraph) claimed the checkbox's "(detected)" label was non-empty
on the discriminating test case, when in fact nothing was labelled there
either; (4) passing `stickyPreChecked: []` had also silently dropped the
"(detected)" annotation from the sticky prompt, leaving an operator with
no on-screen hint that a harness config already exists on disk; (5) two
citations in the round-2 log entry above were bare (no anchor).

Fix: `buildApplyInitInputs` is a new, side-effect-free export
(`packages/orchestrator-workflow/src/cli-apply.ts`) that builds `apply`'s
`resolveInitInputs` params, pinning `stickyPreChecked: []` inside a
function `apply`'s CLI action now calls
(`packages/orchestrator-workflow/src/cli.ts`) rather than assembling the
params object inline; it lives in its own module (not `cli.ts` itself)
because `cli.ts` runs `program.parseAsync(process.argv)` at import time,
which importing it directly from a unit test would trigger. It also
carries a new `stickyAnnotateDetected` field
(`packages/orchestrator-workflow/src/cli-inputs.ts:222#"stickyAnnotateDetected?: Harness[];"`)
that restores the "(detected)" label: `promptHarnesses` gained a fourth
parameter, `annotateDetected` (default: its own first argument, so every
call site that omits it is unchanged), that drives only the checkbox's
"(detected)" suffix, independent of what is actually pre-checked
(`packages/orchestrator-workflow/src/cli-inputs.ts:36-42#"annotateDetected: Harness[] = detected,"`).
`apply`'s sticky-branch call passes a fresh `detectHarnesses(targetDir)`
call as this field (`cli-apply.ts:45#"stickyAnnotateDetected: detectHarnesses(targetDir),"`)
while still pre-checking nothing, so an operator sees which harness is on
disk without a bare Enter re-widening the install.

Docs: `install-fence-mechanics.md` re-pointed `previous.harnessesRecordedEmpty`
from JSDoc prose to the actual gate
(`cli-inputs.ts:292#"previous.harnessesRecordedEmpty"`), dropped the
run-internal "decision D-007" label from its prose (the `agent-tasks
fe834823` pointer alone identifies the task), and now describes the
`buildApplyInitInputs`/`stickyAnnotateDetected` split. `CHANGELOG.md`'s
Unreleased/Fixed entry was trimmed to the two states that matter (apply's
sticky prompt used to pre-check a never-empty fallback chain; now it
pre-checks nothing, still labelling what is detected), dropping the
narration of the unshipped round-1 intermediate state.
`README.md`'s "Templates-only mode" section now says `init` pre-checks
what it detects and `apply` pre-checks nothing, both still annotating.
The two bare citations in this file's round-2 entry above were anchored.

Tests: `test/cli-apply.test.ts` unit-tests `buildApplyInitInputs` directly
(pins `stickyPreChecked: []` regardless of the harnesses passed in, checks
`interactive`/`previous`/`opts`/`previousIsRecordedManifest` pass through
unchanged, and that `stickyAnnotateDetected` reflects real
`detectHarnesses(targetDir)` output independent of the harnesses passed
in). `test/cli-inputs.test.ts` gained a new describe block covering
`stickyAnnotateDetected`: the sticky prompt labels an on-disk harness
"(detected)" while leaving every checkbox unchecked. The existing round-2
describe block's discriminating test title and inline comment were reworded
to say what is actually non-empty in that case (`resolveInitInputs`'s own
`detected` param, the simulated fallback-chain result), not the checkbox
label, which is empty there too since `stickyAnnotateDetected` is omitted.

Mutation probes:
(A) changed `buildApplyInitInputs`'s return to
`stickyPreChecked: chosenHarnesses` -- the new
`test/cli-apply.test.ts` "always pins stickyPreChecked to []" test turned
red (`result.stickyPreChecked` was `["claude", "codex"]` instead of `[]`);
restored, re-ran green.
(B) changed the sticky branch's own call in `resolveInitInputs` to pass
`stickyAnnotateDetected` as the pre-check argument too
(`promptHarnesses(stickyAnnotateDetected ?? detected, [], false,
stickyAnnotateDetected)`) -- the round-2 "nothing is pre-checked" test
turned red (a detected harness came back pre-checked); restored, re-ran
green.

Verification: `npm run build` (clean); `npm test` (592 tests green, up
from round 2's 587: +4 `cli-apply.test.ts`, +1 new
`stickyAnnotateDetected` describe block); after committing,
`npx -y okf-kit@0.8.0 check docs/okf` (0 errors, 0 warnings; notice count
compared against base commit 0960a39's own 21). Every `cli.ts`/
`cli-inputs.ts` citation this round's edits shifted was re-pointed across
`install-fence-mechanics.md`, `model-preselection.md`, and
`operator-install-and-registry.md`, plus the hardcoded citation strings
inside `test/docs-consistency.test.ts` the round-1/round-2 entries above
already name, re-pointed a third time.

## 2026-09-01 (okf-kit 0.9.0 continuation-lift, agent-dx okf-kit-pins-0.9.0)

Task: okf-kit 0.9.0 (agent-tasks cc5e3d33, #153) added
`anchor-required-continuation` under `--require-anchors`: a continuation
citation (`:N-M` chained to a preceding full citation, or a paragraph-bound
short-form) no longer inherits its governing citation's anchor and is
flagged. Pinning `ci.yml`/`okf-staleness.yml` to okf-kit@0.9.0 surfaced 75
such warnings across four bundle docs, measured with `npx -y okf-kit@0.9.0
check --require-anchors --json docs/okf` against the pre-bump tree:
`install-fence-mechanics.md` (15), `model-preselection.md` (21),
`run-state-lifecycle-and-markers.md` (10), `subagent-contracts-superset.md`
(29); `log.md` carried none of these (it is excluded from short-form/
continuation collection entirely, per okf-kit's reserved-file carve-out)
and its own 23 `unresolved-ambiguous` notices are unrelated. This closes
the "Continuation-Lifting agent-dx" backlog item named in the 08-31 batch
memory.

Fix: every flagged continuation was lifted into its own full
`path:N-M#"anchor text"` citation, matching the bundle's existing
anchored-citation convention (each doc's own bare-vs-backtick citation
style preserved). Where the last content line of a continuation's
inherited range collided with a duplicate line elsewhere (file-wide
occurrence over 3, or the anchor's exact text recurring inside its own
range), the range was trimmed by a few lines to end on a line whose text is
unique in-range and file-wide, per the same "last content line,
low-collision" convention this bundle's own `docs-consistency.test.ts`
anchor-integrity tests already enforce; two ranges each spanning two
separate test blocks (`template-markers.test.ts`'s two marker-default
tests) were split into two full citations instead of merged, one per
block. Lifting three of `model-preselection.md`'s continuations to full
citations also surfaced that their inherited line numbers had already
drifted onto the wrong `describe` block entirely (a pre-existing
staleness invisible to any prior check, since continuations were never
resolved) -- re-pointed to the actual "README tier table",
"README tier-to-model-class table", and "README opencode-effort prose"
guard blocks in `test/docs-consistency.test.ts` after confirming each
block's own assertions match the sentence's claim.

Docs: `install-fence-mechanics.md`, `model-preselection.md`,
`run-state-lifecycle-and-markers.md`, `subagent-contracts-superset.md` all
re-stamped; `log.md` itself carries no `timestamp:` frontmatter (append-only
journal), so nothing to re-stamp here.

Verification: `npx -y okf-kit@0.9.0 check --require-anchors --json
docs/okf`: 75 -> 0 `anchor-required-continuation` warnings; a first pass
introduced 8 new `test-range-straddles-block` warnings (full citations,
unlike continuations, are checked for crossing into a sibling test block's
head) and 2 `docs-consistency.test.ts` local-test failures (a stricter,
AST-based "same describe/it/test block" check catching two ranges whose
end line landed one line past their own block, plus the drifted-block
cases above) -- all fixed in follow-up edits to the same citations; final
measurement 0 errors, 0 warnings, 23 notices (unchanged, all
`unresolved-ambiguous` in `log.md`), matching plain `check` (no flags).
`npm test`: 597 tests green (12 files). `npm run build`, `npm run
typecheck`, `npm run typecheck:test`: all clean.

## 2026-09-02 (agent-dx 7d17996d, implementer)

Task: make an okf-kit release bump orchestrator-workflow's
`.github/workflows/` okf-kit pins mechanically (`scripts/bump-okf-kit-pin.mjs`,
CONTRIBUTING.md's new "Releasing okf-kit" section, decision D-003). The
commit added a new `## okf-kit version pin` paragraph appended at the very
end of `packages/orchestrator-workflow/README.md`, after every existing
section, so no line number cited by this bundle shifted.

Fix: re-verified `install-fence-mechanics.md`'s two `README.md` citations
(lines 133, 133-134) and `model-preselection.md`'s five `README.md`
citations (lines 39, 152, 166, 389, 538) and `run-state-lifecycle-and-
markers.md`'s two `README.md` citations (lines 26, 137) against the
unchanged content at those line numbers -- none needed re-pointing, only
re-stamping. `sources-fresh` still flagged all three docs STALE because
`README.md`'s git-log change date moved to this commit; re-stamped each
doc's `timestamp:` frontmatter to `2026-09-02T04:52:48Z` (this commit's
`README.md` change time).

Verification: `okf-kit check --json docs/okf` (global 0.9.0): 3
`sources-fresh` STALE warnings -> 0; 23 `citations-resolve` notices
unchanged (all pre-existing `unresolved-ambiguous`, none touched by this
task). `npm test` in `packages/orchestrator-workflow`: 597 tests green (12
files). `npm run build`, `npm run typecheck`, `npm run format:check`: all
clean. Same commands re-run in `packages/okf-kit`: 277 tests green (23
files, including `test/bump-okf-kit-pin.test.ts`), build and typecheck
clean; `npm run format:check` fails on two pre-existing files
(`test/citations-resolve.test.ts`, `test/cli-symlink-invocation.test.ts`),
unchanged by this task and not run at all by `.github/workflows/ci.yml`
(no `format:check` step there).
- 2026-09-02: `init`'s interactive harnesses prompt on a target whose own
  manifest recorded a real `harnesses: []` now pre-checks nothing, matching
  `apply`'s existing semantics, instead of pre-checking whatever
  `detectHarnesses(targetDir)` found on disk (decision D-002, agent-dx
  7669907c). `resolveInitInputs`'s sticky branch now resolves both the
  pre-check and the " (detected)" label itself (`stickyPreChecked ?? []`,
  `stickyAnnotateDetected ?? detected`), so neither call site needs its own
  wiring for the new default; `apply`'s call site still passes
  `stickyPreChecked: []`/`stickyAnnotateDetected` explicitly, as defence in
  depth against a future edit to its own call site, unchanged from before.
  The "interactive re-run after a templates-only install (F4)" describe
  block in `cli-inputs.test.ts` (previously the regression pin for `init`'s
  divergent, pre-round-3 behaviour) was updated in place rather than
  removed: its first test now asserts nothing is pre-checked even when a
  harness is detected on disk, and that the detected harness is still
  labelled " (detected)".

  Mutation probe: reverted `stickyPreChecked ?? []` back to
  `stickyPreChecked ?? detected` at the sticky branch's own
  `promptHarnesses` call. Result: the updated F4 test turned red (`checked`
  came back `true` for `codex` instead of `false`); restored, re-ran green.

  Docs: `install-fence-mechanics.md` re-pointed the F4 paragraph to state
  the new shared semantics and the D-002 rationale, and its
  `previous.harnessesRecordedEmpty` citation moved from `290-293` to
  `287-290` (cli-inputs.ts comment edits above it shifted the line by -3);
  `model-preselection.md`'s two `cli-inputs.ts` promptModels citations
  moved from `111-153`/`111-116` to `107-149`/`107-112` (a net -4 shift
  from the same comment edits); this log's own round-3 `annotateDetected:
  Harness[] = detected,` citation moved from `25-38` to `26-39` (net +1).
  `README.md`'s "Templates-only mode" section's asymmetric "`init`
  pre-checks whatever it detects on disk; `apply` pre-checks nothing at
  all" sentence was rewritten to state the single shared behaviour, so the
  README states this in one place rather than two disagreeing ones.
  `install-fence-mechanics.md`, `model-preselection.md`,
  `operator-install-and-registry.md`, and `run-state-lifecycle-and-markers.md`
  all re-stamped (each lists `cli-inputs.ts` and/or `README.md` as a
  source).

  Verification: `okf-kit@0.9.0 check --json docs/okf`: 0 errors (unchanged
  from before this change), the `cli-inputs.ts:25-38` anchor-not-found
  warning this change introduced closed by the re-point above, and the
  four docs' `sources-fresh` STALE warnings closed by the re-stamp; final
  measurement matches the pre-change baseline (0 errors). `npm test`: 597
  tests green (12 files, unchanged count). `npm run build`, `npm run
  typecheck`, `npm run typecheck:test`, `npm run format:check`: all clean.
  `node scripts/check-cli-flag-order.mjs` (repo root): clean.

  Follow-up same day: the README.md "Templates-only mode" edit above also
  shifted every citation into README.md at or after line 93 by +1 (net:
  3 lines removed, 4 added). Re-pointed every affected `README.md:N[-M]`
  citation in `install-fence-mechanics.md`, `model-preselection.md`,
  `run-state-lifecycle-and-markers.md`, and this log's own `210-213`
  continuation-restore citation. `review-gate-and-waivers.md` and
  `subagent-contracts-superset.md` (both list `CHANGELOG.md` as a source,
  neither cites `cli-inputs.ts` or `README.md`) also re-stamped for the
  same `CHANGELOG.md` edit. Re-measured: `okf-kit@0.9.0 check --json
  docs/okf`: 0 errors, 0 warnings, 23 notices (all `unresolved-ambiguous`
  in `log.md`, pre-existing and unrelated to this change). `npm test`: 597
  tests green (unchanged).

- 2026-09-02 (agent-tasks 7669907c, fix round 2): reviewer found `init`'s
  own `resolveInitInputs` call site in `cli.ts` was unpinned -- adding
  `stickyPreChecked: detected` there restored the pre-fix behaviour and
  the suite minus `test/docs-consistency.test.ts` stayed green (370/370
  in a copy; the full 597-test suite went red only on incidental citation
  drift, not on behaviour, and a line-count-neutral variant of the same
  edit keeps even that green), because only
  `apply`'s call site had a dedicated builder (`buildApplyInitInputs`,
  `cli-apply.ts`) with its own targeted test. Fix: extracted a mirror
  builder, `buildInitInitInputs` (`src/cli-init.ts`, new file), and
  changed `init`'s CLI action to call it instead of building the params
  object inline; the builder never sets `stickyPreChecked` or
  `stickyAnnotateDetected` at all, so `resolveInitInputs`'s own `?? []`/
  `?? detected` defaults (D-002) apply through it, the same effect as
  `apply`'s builder gets from hardcoding `[]` explicitly. Added
  `test/cli-init.test.ts`, asserting `"stickyPreChecked" in result` and
  `"stickyAnnotateDetected" in result` are both `false`.

  Mutation probe: added `stickyPreChecked: detected` inside
  `buildInitInitInputs`. Result: the new "never overrides stickyPreChecked
  or stickyAnnotateDetected" test turned red (`"stickyPreChecked" in
  result` came back `true`); restored, re-ran green.

  Docs: the `cli.ts` call-site edit (an 11-line inline object replaced by
  a one-line builder call, plus a new `cli-init.ts` import) shifted the
  `cli.ts` citations in two directions: +1 for lines between the new
  import and the `init` call site (the import only), -2 from the call site
  onward (three lines removed there), net -2 on the file (1479 to 1477
  lines). Every affected
  `cli.ts:N[-M]` citation in `install-fence-mechanics.md`,
  `model-preselection.md`, and `operator-install-and-registry.md` was
  re-pointed (mechanically, by locating each anchor's own text at its new
  line and preserving the citation's original span); two hardcoded
  citation strings inside `test/docs-consistency.test.ts` itself (the
  pin-gate-before-`runInit` ordering test) were updated to match. The one
  citation whose target moved out of `cli.ts` entirely
  (`previousIsRecordedManifest: true,`, now inside `buildInitInitInputs`)
  was re-pointed to `cli-init.ts:24-39` instead of merely renumbered.
  README.md's apply-section restatement of the sticky pre-check behaviour
  (duplicating the "Templates-only mode" section verbatim) was replaced
  with a one-line pointer to that section, per review finding 3; this
  README edit landed above every citation into README.md that exists in
  this bundle, so none needed re-pointing.

  Reviewed but left in place (review finding 4, doc-comment
  consolidation): `cli-inputs.ts` restates the sticky-branch rule and
  rationale in four doc comments (`promptHarnesses`'s `annotateDetected`
  param, its `fallbackToClaude` inline comment, and
  `ResolveInitInputsParams.stickyPreChecked`/`stickyAnnotateDetected`'s
  own doc comments) plus the branch itself inside `resolveInitInputs`.
  Reducing all four to a one-line pointer at the branch's own comment
  would remove roughly 61 comment lines and add roughly 22, a diff of
  about 83 changed lines against the task's own "skip if the resulting
  diff would exceed roughly 40 lines" budget; skipped, reported instead.

  Also swept the remaining bare (unanchored, sometimes not even
  backtick-wrapped) `cli-inputs.ts:*`/`CHANGELOG.md:*` tokens the review
  named in this log: `CHANGELOG.md:59-81` two entries above (this
  round's own fix-round-1 19-line `[Unreleased]` insertion shifted it to
  78-100; re-pointed and anchored, `#"the keyed placeholder line's exact
  text,"`); `CHANGELOG.md:808-815` in the `okf-kit check` 39-findings
  paragraph above (deliberately historical -- frozen to base commit
  `b80c346`'s content, reworded to say so explicitly, so a later sweep
  does not have to re-derive that judgment); `cli-inputs.ts:39-50` in the
  "Left as a known residual" paragraph above (currently live and
  accurate -- anchored in place, `#"harnesses-stickiness branch (shared
  by"`); `cli-inputs.ts:190-208` and both cli-inputs.ts line 307 occurrences
  in the D-007 entry above (deliberately historical -- that entry
  describes fix-round-2 of a DIFFERENT, earlier task, agent-tasks
  fe834823, whose `stickyPreChecked ?? detected` semantics were later
  superseded by D-002's `stickyPreChecked ?? []`; reworded in place to
  say so, numbers left as they were).

  Verification: `npm test`: 600 tests green (13 files; +3 for
  `test/cli-init.test.ts`, unchanged elsewhere). `npm run build`, `npm
  run typecheck`, `npm run typecheck:test`, `npm run format:check`: all
  clean. `node scripts/check-cli-flag-order.mjs` (repo root): clean.

  Follow-up same session: `okf-kit@0.9.0 check --json docs/okf` against
  the committed tree found 4 `sources-fresh` STALE warnings --
  `review-gate-and-waivers.md` and `subagent-contracts-superset.md`
  against `test/docs-consistency.test.ts`, and
  `run-state-lifecycle-and-markers.md` against both
  `test/docs-consistency.test.ts` and `README.md` -- none of which cite
  the specific lines this round touched (confirmed by inspection: their
  `README.md:N[-M]` citations, where any exist, all resolve above line
  400). Re-stamped all three (`timestamp` bumped to the real verification
  instant, no content change). Re-measured: `okf-kit@0.9.0 check --json
  docs/okf`: 0 errors, 0 warnings, 23 notices (same pre-existing
  `unresolved-ambiguous` set as before this round).
- 2026-09-02T05:52:50Z (agent-tasks 7d17996d, post-rebase): after rebasing onto the
  merged init-sticky change (#162), `README.md`'s squash-merge commit time
  moved past the frontmatter timestamps of `install-fence-mechanics.md`,
  `model-preselection.md` and `run-state-lifecycle-and-markers.md`, so
  sources-fresh flagged all three STALE with no content change in the
  README beyond what #162 already re-pointed their citations against.
  Confirmed every `README.md:N[-M]` citation in the three docs still
  resolves (citations-resolve: 0 findings), re-stamped all three.
- 2026-09-03T06:44:38Z (T-007, agent-primitives kit sentences): added one
  tool-agnostic sentence each to `explorer.md`, `SKILL.md`'s Discover step,
  `reviewer.md`, and `implementer.md`, pointing subagents at a connected
  structural code-search, verify, and mutation-probe runner when available.
  `explorer.md` gained 1 line, `SKILL.md` gained 1 line (both mid-sentence
  extensions), `reviewer.md` gained 4 lines and `implementer.md` gained 4
  lines (new bullets), shifting every downstream citation of the four
  files in `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
  and `subagent-contracts-superset.md`. Re-pointed every shifted citation
  (mechanical line-offset shift past each insertion point, one straddling
  range end-shifted only) and re-stamped all three docs. Re-measured:
  `okf-kit@0.9.0 check --json docs/okf --require-anchors`: 0 errors, 0
  warnings, 23 notices, identical to the pre-edit baseline (same
  pre-existing `unresolved-ambiguous` set).
- 2026-09-03T07:01:12Z (T-007 round 2, reviewer fixes): the round-1 entry
  above claimed "0 warnings, identical to the pre-edit baseline" but that
  measurement was taken before the CHANGELOG.md `[Unreleased]` insertion
  landed; at HEAD the pinned check actually reported 1 warning (the
  `CHANGELOG.md, former lines 78–100` citation in this file, out of range by the
  insertion). Fixed this round: reworded the explorer.md/SKILL.md clause
  so the structural-search preference carries its own availability guard
  instead of riding the semantic tool's conditional; dropped the private
  memory id from the CHANGELOG pointer, keeping only the run directory;
  re-pointed the `CHANGELOG.md, former lines 78–100` citation above to `88-110` (the
  10-line `[Unreleased]` insertion, not 11); shifted the bare trailing
  continuation on `run-state-lifecycle-and-markers.md:295` from `,251-252`
  to `,252-253` to match where "Repos without a bundle are unaffected"
  actually sits. The reword's own edits to `explorer.md` and `SKILL.md`
  land in the same 4-line span each already occupied (lines 19-23 and
  143-146 respectively), so no other citation into either file moved;
  verified by diffing this round's `explorer.md`/`SKILL.md` against the
  round-1 commit (`c2fa056`) and confirming the edited block's start and
  end lines are unchanged. Re-stamped `run-state-lifecycle-and-markers.md`
  again; the re-stamp is offset-only (a citation-range and timestamp
  correction), not a re-verification of new claims -- no doc text was
  added for the two new prompt bullets (`reviewer.md`, `implementer.md`)
  this round. Re-measured on the committed tree:
  `okf-kit@0.9.0 check --json docs/okf --require-anchors`: 0 errors, 0
  warnings, 23 notices; the anchor-family jq filter from `ci.yml` (the
  `anchor-*`/`heading-section-*`/`test-range-straddles-block` message
  pattern) reports 0 findings; the 23 notice messages are byte-identical
  to the same check run against master (`5ae53a3`) in a separate
  worktree, same pre-existing `unresolved-ambiguous` set. `npm test`: green,
  including the docs-consistency suite.

- 2026-09-03T07:17:33Z (T-007 round 2, review notes): appended a docs-consistency block
  pinning the four runner and structural-search sentences in `explorer.md`,
  `reviewer.md`, `implementer.md`, and `SKILL.md` plus a tool-agnosticism
  guard over all four assets (reviewer finding: reverting the sentences left
  the suite green). The block sits at the end of
  `test/docs-consistency.test.ts`, so no line cited by this bundle moved;
  the four docs that list that test as a source were re-stamped offset-free
  (timestamp only) after re-checking that their citations into the test
  still resolve, and the four new pins are green with the rest of the
  docs-consistency suite. Re-measured on the committed tree after this
  entry: `okf-kit@0.9.0 check --json docs/okf --require-anchors`: 0 errors,
  0 warnings, and the same pre-existing notice set as master (no
  anchor-family finding).

- 2026-09-04T04:20:12Z (chore, release 0.28.0): the release commit inserts
  a `## [0.28.0] - 2026-09-04` heading above the prior `## [Unreleased]`
  content (2 lines: the heading plus a blank line, same shape as the
  0.27.0 release commit), pushing every line at or below `CHANGELOG.md`
  line 9 down by 2. Grepped all `CHANGELOG.md:` occurrences under
  `docs/okf/*.md`: the bundle's live navigational citations into
  `CHANGELOG.md` are heading-anchored (path.md-colon-hash-version form,
  migrated 2026-08-27) and are unaffected by a line shift; the one
  exception is this file's own live line-range citation two entries
  above, previously pointed at the 88-110 range (the keyed placeholder
  line's exact text), re-pointed to `90-112` above. The remaining
  `CHANGELOG.md:` mentions in this file (`59-81`, `78-100`, `808-815`,
  and similar) are deliberately
  historical prose about past diffs, already frozen to the commit they
  describe, and are left as written. No `## [Unreleased]`-anchored citation
  exists anywhere in the bundle, so the heading move itself needed no
  further re-pointing; no "-unreleased" prose reference needed correcting
  this round (unlike 0.27.0's two 0.26.0-unreleased mentions), confirmed by
  grepping `index.md`, `review-gate-and-waivers.md`,
  `run-state-lifecycle-and-markers.md`, and `subagent-contracts-superset.md`
  for "unreleased" (case-insensitive): the one hit
  (`review-gate-and-waivers.md`) names the CHANGELOG's `[Unreleased]`
  section generically, not a specific shipped version, and is unchanged.
  Re-measured on the committed tree: `okf-kit@0.9.0 check --json docs/okf
  --require-anchors`: 0 errors, 0 warnings, 23 notices, byte-identical to
  the pre-release baseline (master `56f34c6`, same worktree comparison
  method as prior rounds; the anchor-family jq filter from `ci.yml`
  reports 0 findings both before and after).

- 2026-09-04: re-verified and re-stamped install-fence-mechanics.md,
  model-preselection.md, and operator-install-and-registry.md after the
  cli-inputs.ts sticky-comment consolidation; their source claims and
  repointed anchors match the current implementation. `okf-kit check
  docs/okf --strict` reports 0 errors and 0 warnings.

- 2026-09-05T05:31:52Z (Codex routing documentation): documented the
  harness-specific role/tier routing schema, native Codex agent files and
  capability-aware dispatch, additive routing input, offline catalog input,
  persisted selection and rollback behavior, and agent-led installation as
  the recommended entry point. The first review's authorization, sandbox,
  and repeated-source-anchor findings were corrected without waiver, and a
  docs-consistency regression now prevents blanket `--force` confirmation
  after authority has already been granted. A subsequent review's Claude
  variant citation was corrected within the named composer, and the docs now
  distinguish strict qualified routing from the compatibility maps that
  retain supported bare legacy opencode ids. Re-stamped affected source and
  test citations after the routing implementation froze. `agent-primitives
  verify -c docs -x 'docs=npx vitest run test/docs-consistency.test.ts
  test/template-markers.test.ts'` passed all 253 tests. `okf-kit check
  packages/orchestrator-workflow/docs/okf --json` reported 0 errors, 10
  historical warnings, and 36 notices; the notices for the new routing and
  Codex sources reflect their uncommitted state in this worktree.

- 2026-09-05T06:00:58Z (routing inheritance follow-up): re-stamped live source
  citations after the shared routing-state fixes, preserving the named Claude
  and opencode variant composer context. Replaced the obsolete compatibility
  helper citation and documented the distinction between recorded session
  inheritance and unknown legacy resolution. Citation-order tests now accept
  changing line numbers while retaining their exact anchors and semantic-order
  checks. `agent-primitives verify -c docs,testtypes -x 'docs=npx vitest run
  test/docs-consistency.test.ts test/template-markers.test.ts' -x
  'testtypes=npm run typecheck:test'` passed all 253 focused tests and the
  test typecheck. `okf-kit check packages/orchestrator-workflow/docs/okf
  --json --require-anchors` reported 0 errors, the unchanged 10 historical
  log warnings, and 36 notices; all live module citations resolve.

- 2026-09-05T06:25:29Z (release 0.29.0): inserted the release heading while
  retaining Unreleased, and updated package and lockfile versions. Re-verified
  the CHANGELOG-backed docs and moved the sole live line-range citation by
  two lines. `agent-primitives verify` passed build, source and test
  typechecks, the full test suite, and formatting. `okf-kit check --json
  docs/okf --require-anchors` reported 0 errors, 0 warnings, and 23 notices;
  the exact CI anchor-family filter reported 0 findings across the entire
  bundle, without historical exemptions.

- 2026-09-05T18:30:28Z (fix-round mutation probe replay): added the
  round-2-and-later mutation-probe-replay rule to SKILL.md steps 6 and 7,
  a fifth `replayed` sub-field to both implementer output-contract copies
  (SKILL.md and implementer.md), and a new docs-consistency describe block
  pinning both files plus the unchanged reviewer prompt. Re-stamped
  `subagent-contracts-superset.md`, `review-gate-and-waivers.md`, and
  `run-state-lifecycle-and-markers.md` after the SKILL.md/implementer.md
  line shifts, added a new Fix-round mutation probe replay section to
  `subagent-contracts-superset.md`, and corrected the one line-shifted
  `CHANGELOG.md` citation this edit's new Unreleased bullet displaced.
  `npx vitest run test/docs-consistency.test.ts` passed all 246 tests;
  `npm test` passed all 696 tests; `npm run typecheck` was clean. `okf-kit
  check --json --require-anchors packages/orchestrator-workflow/docs/okf`
  actually reported 0 errors, 2 warnings, and 23 notices at this commit
  (correction, found in review): alongside the pre-existing
  `install-fence-mechanics.md` staleness warning, this pass's
  `test/docs-consistency.test.ts` edit newly staled `model-preselection.md`
  (it lists that test file in `sources:`); the entry above wrongly
  described the count as "the unchanged 1 historical staleness warning".
  See the following entry for the re-verification and re-stamp.

- 2026-09-05T19:03:26Z (fix-round mutation probe replay, review round 2):
  addressed the prior entry's regression plus review findings on the same
  change. Re-verified `model-preselection.md`'s `test/docs-consistency.
  test.ts` citations (ranges 2160-2305, unaffected: the new describe block
  was appended after line 4170) and re-stamped its timestamp; corrected
  the prior log entry's wrong count above rather than rewriting history.
  Reworded the replay trigger in both SKILL.md step 6 and implementer.md
  from the ambiguous "a fix round after the first" to "any round after
  the task's first ... (on the task's first round there are none)", added
  a regression-signal consequence for a replayed probe that now survives
  or can no longer be applied (`result` `survived` or `not_applicable`,
  resolved before the next reviewer spawn), replaced step 7's undeliverable
  reviewer permission with a briefing instruction (the orchestrator's
  reviewer briefing names the replayed-and-killed probes with their
  `mutant`/`verified_applied_via` values), added a Mutation Probes
  subsection to `04-implementation-summary.md` (pinned in
  `test/template-markers.test.ts`), and fixed the L1/L2/L3 wording and
  test findings (four-evidence-fields-plus-replayed wording, the negative
  reviewer-prompt pin's name, a shared `extractMutationProbesBlock`
  helper, `replayed` added to the exact-sub-field pin, and a new
  fixed-sub-field-order pin). Editing SKILL.md, implementer.md, and
  `test/docs-consistency.test.ts` shifted lines throughout those files;
  re-pointed every citation the shift broke (subagent-contracts-
  superset.md, run-state-lifecycle-and-markers.md, model-preselection.md,
  review-gate-and-waivers.md) by locating each anchor's exact quoted text
  at its new line rather than by uniform arithmetic, verified by re-running
  the full docs-consistency suite until clean. Also fixed the run-state-
  lifecycle-and-markers.md continuation citation at (then) line 295:
  `,252-253` pointed at unrelated prose ("high/critical or other
  ineligible finding") instead of the claim's actual continuation
  ("Repos without a bundle are unaffected", `,274-275`); by-hand-checked
  the file's other two continuation citations (lines 27 and 66): line 66's
  `,33-37` into `test/template-markers.test.ts` matches (the run-base
  exactly-one-marker test); line 27's `,173-178` into `INSTALL-AGENT.md`
  is a looser but not wrong continuation (the apply-instead-of-init
  installer path, same general claim), left as is.
  `npx vitest run test/docs-consistency.test.ts` passed all 249 tests;
  `npm test` passed all 701 tests; `npm run typecheck` was clean. `okf-kit
  check docs/okf` initially reported 0 errors, 3 warnings, 23 notices: the
  pre-existing `install-fence-mechanics.md` staleness warning, plus two
  new `citations-resolve` warnings against citations in this `log.md`
  file itself (a `test/docs-consistency.test.ts` (then lines 920–933) citation and a
  `CHANGELOG.md:186` citation, both line-shifted by this pass's edits).
  Correction (found in review): this bundle's convention, per this same
  pass's own H1 fix above and the sibling T-002 pass, is to re-point a
  `log.md` citation shifted by the current change rather than leave it
  (the log records how a class recurred; its anchors are expected to
  resolve): re-pointed both to the same content at head, both bounds
  checked: `test/docs-consistency.test.ts` (then lines 920–933) (the reproduction-field
  byte-for-byte equality `it` block, "expect(skillBlock).toBe
  (reviewerBlock);") moved to `931-944`, and `CHANGELOG.md:186` (the
  probe-replay `[Unreleased]` bullet's own citation of `test/template-
  markers.test.ts`'s "the keyed placeholder line's exact text,") moved to
  `175`, the further +7-line shift coming from this bundle's own
  fix-round-2 CHANGELOG.md edit (the bullet grew from 8 to 13 lines).
  Re-verified: `okf-kit check --json --require-anchors packages/
  orchestrator-workflow/docs/okf` now reports 0 errors, 1 warning
  (`install-fence-mechanics.md` staleness), 23 notices. Base comparison
  (`agent-dx` at e35d0ce, pre-task): the same command reported 0 errors,
  1 warning (the identical `install-fence-mechanics.md` entry), 23
  notices. Per-finding comparison: the single warning's message and
  target are byte-identical between the two runs, and the 23 notices are
  the same `citations-resolve`/`unresolved-ambiguous` set in both (all
  `SKILL.md`/`init.ts`/`cli.ts`/`test/init.test.ts` ambiguous-candidate
  citations, unaffected by this pass); this pass's delta versus base is
  now exactly zero findings.

Fix round 3 (review round 2 halt: the same continuation-citation class
recurred a second time in `run-state-lifecycle-and-markers.md`, closing
the class rather than the individual case). Checked okf-kit's own
grammar first (`--help`, then the "Continuation citations" and "Anchored
citations" sections of the okf-kit README): a continuation
(`` `:N` ``/`` `:N-M` ``, `` -`M` ``/`` (`N`) ``) is structurally
anchor-less and can never carry its own `#anchor` (`--require-anchors`
flags this `anchor-required-continuation`, remedy: "lift the
continuation into its own full `path:N-M#anchor` citation"). The
bundle's three bare, non-backtick `,N-M` continuations (never actually
parsed as citations by the grammar at all, since none match
`` `:N` ``/`` -`M` ``/`` (`N`) ``, hence invisible to every prior pass's
check) were each split into a second full, independently anchored
citation instead: `run-state-lifecycle-and-markers.md`'s INSTALL-AGENT.md
reference (line 27, `,173-178` re-anchored to its own
`INSTALL-AGENT.md:173-178#"instead: it sources its defaults"`), its
template-markers.test.ts reference (line 66, `,33-37` re-anchored to
`template-markers.test.ts:33#"00-goal.md has exactly one run-base marker, defaulting to TODO"`,
the run-base exactly-one-marker `it` block's own description, chosen over
a range into the block's body since that body's `expect` line is
duplicated three other times in the same file and so is too collision-
prone for a load-bearing anchor), and the one
this class recurred on (line 295, `,274-275` for "Repos without a bundle
are unaffected", which at this round's head sits at
`packages/orchestrator-workflow/assets/skill/SKILL.md:295`,
re-anchored to its own
`packages/orchestrator-workflow/assets/skill/SKILL.md:334#"without a bundle are unaffected"`).
This closes the class: every bare continuation
in this bundle's non-reserved docs now has its own anchor via a full
citation (`index.md` and `log.md` are append-only journals and keep their
historical forms), so a future
line-shift of the same paragraph fails loudly instead of drifting
silently. The same round's SKILL.md step 6 edit (a new clause recording
each mutation probe into `04-implementation-summary.md`'s Mutation
Probes subsection) shifted every SKILL.md line at or after 207 by +2,
breaking 65 citations across `review-gate-and-waivers.md`,
`run-state-lifecycle-and-markers.md`, and `subagent-contracts-superset.md`
(plus this round's own docs-consistency.test.ts test insertions shifting
that file's line-numbered citations in `subagent-contracts-superset.md`);
all were re-derived against the final tree, both bounds, content-verified
rather than computed blindly. Measured after the round-3 commit:
`okf-kit check --json --require-anchors packages/orchestrator-workflow/docs/okf`
reported 25 findings (0 errors, 2 warnings, 23 notices), one more than
the base comparison (`agent-dx` at e35d0ce): the round's own
docs-consistency.test.ts edit had made `model-preselection.md` stale
against a declared source, the same class the round-1 review found
(reviewer round 3, repeated). The closing delta re-stamps
`model-preselection.md` (its citations into the test file were
re-verified and are unchanged) and extends one short anchor in
`subagent-contracts-superset.md`; measured after that commit the
validator reports the base's 24 findings again (0 errors, 1 warning, the
identical `install-fence-mechanics.md` staleness entry, 23 notices).
Follow-up filed: a mechanical guard that fails when a bundle doc's
timestamp is older than the last commit of any declared source, since
the warn-only staleness workflow let this class recur twice.

## 2026-09-05 (agent-dx c17e4093, task T-002, implementer, GitHub Actions run-step shell replay)

T-002 adds a checklist item to the installed implementer and reviewer
prompts, and to SKILL.md's step 6/7 narrative: any diff that adds or
changes a GitHub Actions `run:` step must be replayed locally under the
shell the step actually runs (`bash --noprofile --norc -eo pipefail` when
`shell: bash` is set on the step or via `defaults.run.shell`, `bash -e`
otherwise on Linux and macOS runners; Windows runners default to pwsh)
before treating it as tested, with the expected-success and the
expected-failure inputs, replaying a job's steps in their committed
order, and guarding a step that expects a non-zero command inside an
`if` or a `set +e`/`set -e` block. The reviewer's copy replays in a
scratch copy of the repository outside the reviewed working tree (a
temporary clone or a copied checkout in its scratchpad directory), never
a `git worktree` (dropped in this pass, see below), keeping the replay
compatible with its read-only Bash rule. Round 2's own fix (commit
`cd0198e`) worded the pipefail-selecting condition precisely against
Actions' real defaulting behavior and added the rule's second effect:
the reviewer output contract's `reproduction` field (0.14.0) gained a
second, explicitly non-probabilistic trigger for this same replay, with
`sample_size: not_applicable` allowed when the replay itself has no
meaningful sample size, mirrored into SKILL.md's step 7 reproduction
paragraph and into this doc's own Reproduction requirement section.
Round 2 re-pointed every OKF citation into `implementer.md`,
`reviewer.md`, and `SKILL.md` shifted by its own insertions; that
round's commit message claimed it also appended this log entry and
re-stamped the affected docs, but neither happened (verified by direct
diff against `c7e0c80`): this entry restores the missing account.

Review round 3 (`accept_with_notes`, two medium docs findings plus four
low) found: (M1) this doc, `review-gate-and-waivers.md`, and
`run-state-lifecycle-and-markers.md` were re-pointed by round 3's own
edits without a matching re-stamp, and this `log.md` file itself carried
three stale citations shifted by round 3's own CHANGELOG.md and SKILL.md
edits: an unrelated earlier pass's own entry above, twice, plus that same
entry's anchored quote of "the keyed placeholder line's exact text,"
into CHANGELOG.md, all re-pointed to the lines that now carry that
content, shifted by this task's own 17-line CHANGELOG.md `[Unreleased]`
bullet; and a bare/anchored pair in the fix-round-3 account above, into
SKILL.md, re-pointed the same way, shifted by round 3's own SKILL.md
edits and this closing delta's step-7 re-flow below; (M2) the
reproduction-field second-trigger sentence was not yet named in this
doc's own Reproduction requirement section, only in SKILL.md and
reviewer.md; (L1) SKILL.md step 7 carried an orphaned two-word line ("as
`new` or" alone) that round 3's own commit message claimed to have
re-wrapped but had not (re-flowed in this closing delta, shifting every
SKILL.md line at or after 246 by -1, requiring every downstream citation
across `review-gate-and-waivers.md`, `run-state-lifecycle-and-markers.md`,
and `subagent-contracts-superset.md` to be re-derived against the final
tree rather than by uniform arithmetic); (L2) round 1-3's commit
messages each claimed OKF/log work their diffs did not contain,
addressed by this note and by this delta's own commit message stating
only what its tree actually contains; (L3) `reviewer.md`'s scratch-copy
enumeration named `git worktree add` as a mechanism alongside a
temporary clone or a copied checkout, in tension with the same file's
read-only Bash rule (a worktree still mutates the shared repository's
refs); dropped from the enumeration; (L4) round 3's own re-pointing pass
had introduced several self-range citations in
`subagent-contracts-superset.md` (a line number repeated as both the
start and end of a range, for example into SKILL.md's explorer output
contract heading), normalized to the bare single-line form used
everywhere else in the bundle; a missing test pinning the CHANGELOG
bullet's platform wording ("on Linux and macOS runners", "pwsh") was
added.

Verification: `npx vitest run test/docs-consistency.test.ts` passed all
263 tests (one new assertion added, pinning that this doc names the
shell replay as the reproduction field's second trigger); `npm test` and
`npm run typecheck` were run clean. `okf-kit check --json
--require-anchors packages/orchestrator-workflow/docs/okf` measured
after this closing delta's commit reported 0 errors, 1 warning
(`install-fence-mechanics.md` staleness, the pre-existing baseline
entry), 23 notices; per-finding comparison against the base run at the
read-only `agent-dx` checkout (commit `9bd68b3`, `c7e0c80` plus an
unrelated agent-primitives merge with no OKF-bundle change) found the
warning's message and target byte-identical and the 23 notices the same
`citations-resolve`/`unresolved-ambiguous` set in both runs: this
closing delta's finding-set delta against base is zero.

- 2026-09-05 (acceptance-baseline/v1): added the explicit new-run adoption
  record, canonical criterion records, lossless per-task propagation, and
  result-artifact coverage guidance. Re-verified the affected lifecycle,
  contract, and review-gate docs after re-pointing their source citations.
  Focused contract tests, build, typecheck, test, and test typecheck passed;
  the baseline-propagation deletion probe was killed and restored. `okf-kit
  check --json --require-anchors docs/okf` reported 0 errors, 5 warnings, and
  23 notices; the warnings are existing source-fresh/blank-start-line entries.

- 2026-09-05 (acceptance-baseline/v1 correction, round 3): corrected the
  actual producer contracts to return matching baseline/criterion-evidence
  indexes and made recorded version selection apply at every contract block.
  Added structural checks at each of the five contract boundaries, concrete
  linked revision examples and real installer preservation of seeded old-run
  bytes. Corrected current semantic inventories and the obsolete copy-rule
  quotation. Re-grounded affected source citations, including the install-fence
  README citation; historical journal coordinates retain their original
  values where they describe a past location.
  Measured focused checks, build, typecheck, full tests and test typechecking
  passed. Both named deletion probes were killed and restoration was verified,
  including the input-header deletion that previously survived.
  Correction to the earlier acceptance-baseline entry above: its five warnings
  were not all pre-existing. The supplied base report had one source-fresh
  warning; the round-2 report added four blank-start-line warnings in log.md,
  subsequently fixed. The round-3 pre-edit report had no warnings. The native
  reports preserve these distinct observations; they are not interchangeable
  baselines. Final committed documentation verification is recorded below.

  After the substantive commit, focused verification passed and
  `okf-kit check --json --require-anchors docs/okf` measured 0 errors,
  0 warnings and 23 notices. Full finding-object comparison against the
  supplied original baseline found no introduced findings and removed its
  one install-fence source-fresh warning; comparison against the round-3
  pre-edit report found identical findings. The five affected consumer docs
  were re-stamped after source inspection and these checks. Full checks and
  probe evidence carry forward over this timestamp/journal-only closure: the
  tested source, assets and fixtures are unchanged.
