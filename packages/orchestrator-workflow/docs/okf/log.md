# Bundle log

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
  review-gate-and-waivers.md's `05-review-findings.md:26` (Acceptance
  Recommendation enum line, should read `:26`) and `27` (the
  acceptance-recommendation marker, should read `:28`), and
  run-state-lifecycle-and-markers.md's matching `27` (marker, `:28`) and
  `23-25` (heading/blank/enum span, `:24-26`) — all four now corrected and
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
  (its `models.ts:28-32` `DEFAULT_MODELS` citation, at minimum, is now
  stale too, having moved to `70-75` by the same Profile-block insertion
  documented above). Neither install-fence-mechanics.md nor
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
  (`test/docs-consistency.test.ts:641-653`); the doc now states the true
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
  every citation into it. `README.md:91-96` (run-state-lifecycle-and-markers.md's
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
  the first time and fixed every resulting warning; full details in the
  agent-dx repo's commit for agent-tasks 1d6e0b3e rather than repeated here,
  to avoid re-introducing the same kind of stale bare line-number citation
  this pass exists to fix. okf-staleness.yml's pin was bumped to okf-kit
  0.5.0 in the same change.
