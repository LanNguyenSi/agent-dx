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
  review-gate-and-waivers.md's `05-review-findings.md`, line 25 (Acceptance
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
  (`test/docs-consistency.test.ts:822-836`); the doc now states the true
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
  `SKILL.md:310` for the reviewer severity field, true `317`;
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
  file. One citation, `SKILL.md:448-450` on the pre-0.21.0
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
  (`run-state-lifecycle-and-markers.md`, the un-shifted pre-round-1
  `CHANGELOG.md:808-815` 0.7.0 citation), and three `sources-fresh`
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
  `docs-consistency.test.ts:1891-2038`, where start correctly resolved to a
  `describe(` block but end escaped past its own close) and 1
  (`subagent-contracts-superset.md`'s citation into
  `docs-consistency.test.ts:513-519`) where the citation starts inside a
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
(`packages/orchestrator-workflow/CHANGELOG.md:57-79`) grew by a net 3
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
(`uninstall.ts:99-117#"export function runUninstall(options: {"`,
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
  (bare `README.md:105` and the fully-qualified
  `packages/orchestrator-workflow/README.md:91-96`/`INSTALL-AGENT.md:46-
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
bundle (e.g. run-state-lifecycle-and-markers.md:62's own `[0.9.0]`
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

Measured on the committed tree after this commit (`packages/okf-kit`
0.8.0 `--require-anchors` with the CI allowlist for README.md/
INSTALL-AGENT.md bare ranges, mirroring the `okf-anchor-guard` CI job):
anchor findings 0, sources-fresh 0, errors 0. Baseline on the committed
tree immediately before this task (parent commit a2d5f85, before any doc
edit) was also anchor 0 / sources-fresh 0 / errors 0 / warnings 13 /
notices 22 (that baseline predates the re-point and does not reflect the
tests that were red at the time; okf-kit's own check does not run the
in-repo vitest guards). Post-commit totals and any warnings/notices delta
are recorded in the operator handoff for this task.
