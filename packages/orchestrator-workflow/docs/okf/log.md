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
