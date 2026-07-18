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
