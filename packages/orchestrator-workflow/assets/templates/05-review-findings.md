# Review Findings

## Review Summary

<!-- Short summary. -->

## Findings

<!-- The Severity and Decision column headers below are load-bearing: the orchestrator-workflow completeness reader locates this table by its header row and verifies unresolved findings from those two columns. Do not rename or drop them. -->
<!-- Decision legend: a high/critical finding counts as RESOLVED (the completeness gate passes) only when its Decision is `accepted` (finding addressed or consciously accepted) or `defer` (recorded as a tracked follow-up). Every other value (`fix`, `reject`, blank, `open`, `TODO`) leaves the finding unresolved and ARMS the gate until you change the Decision to `accepted`/`defer` or drop the finding. This mirrors grounding-mcp's RESOLVED_DECISIONS = {accepted, defer}; keep the two in sync. -->
| Severity | Category | Description | Suggested Fix | Decision |
|---|---|---|---|---|
| low/medium/high/critical | correctness/architecture/security/tests/maintainability/performance/docs | <!-- finding --> | <!-- fix --> | accepted/defer |
<!-- This row is the shipped template placeholder, not a finding: the orchestrator-workflow completeness reader fails the completeness gate closed when this exact row survives untouched and no concrete finding row has been added, the same way a `TODO` marker does. During findings transfer (step 7), replace this row with each reviewer finding. For a genuine zero-findings review, delete this row instead — a header row with no data rows is a valid, complete table; leaving this row next to real finding rows is also fine. This mirrors grounding-mcp's placeholder-row detection; keep the two in sync. -->

## Missing Tests

- <!-- missing test -->

## Residual Risks

- <!-- risk -->

## Acceptance Recommendation

accept | accept_with_notes | fix_required | reject

<!-- solution-acceptance: acceptance-recommendation = TODO -->

<!-- Reproduction note: when a finding rests on empirical or probabilistic evidence (flake rates, benchmarks, "n runs green", performance/timing numbers), record the reviewer's independent reproduction (method, sample size, result vs. the implementer's claim) in the reviewer output contract's `reproduction` field (SKILL.md step 7). Deterministic checks (a single test run, tsc, lint) do not require it. -->
