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
  review-gate-and-waivers.md's `05-review-findings.md:25` (Acceptance
  Recommendation enum line, should read `:26`) and `:27` (the
  acceptance-recommendation marker, should read `:28`), and
  run-state-lifecycle-and-markers.md's matching `:27` (marker, `:28`) and
  `:23-25` (heading/blank/enum span, `:24-26`) — all four now corrected and
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
  (its `models.ts:27-32` `DEFAULT_MODELS` citation, at minimum, is now
  stale too, having moved to `:70-75` by the same Profile-block insertion
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
