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
