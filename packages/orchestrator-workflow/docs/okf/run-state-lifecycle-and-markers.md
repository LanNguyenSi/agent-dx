---
type: module
title: Run-state lifecycle and machine-readable markers
description: The .ai/runs/ directory model plus the solution-acceptance marker family (run-base, acceptance-recommendation, final-status) and findings-table header, which carry opposite fail postures despite one shared comment prefix.
tags: [run-lifecycle, solution-acceptance-markers, fail-open-fail-closed, findings-table, knowledge-bundle-handoff]
timestamp: 2026-07-16T12:03:30Z
sources:
  - packages/orchestrator-workflow/assets/templates/00-goal.md
  - packages/orchestrator-workflow/assets/templates/05-review-findings.md
  - packages/orchestrator-workflow/assets/templates/06-handoff.md
  - packages/orchestrator-workflow/assets/skill/SKILL.md
  - packages/orchestrator-workflow/test/template-markers.test.ts
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
  - packages/orchestrator-workflow/README.md
  - packages/orchestrator-workflow/INSTALL-AGENT.md
---

# Run-state lifecycle and machine-readable markers

One unit of work lives in `.ai/runs/YYYY-MM-DD-<slug>/`, seven files
`00-goal.md` through `06-handoff.md` (packages/orchestrator-workflow/assets/skill/SKILL.md:52-63).
The orchestrator creates it by copying `.ai/workflow/templates/`
(SKILL.md:65-66; packages/orchestrator-workflow/README.md:91-95;
packages/orchestrator-workflow/INSTALL-AGENT.md:41-42,98-100). The newest run
directory is the active one; older directories are the auditable history and
must not be edited (SKILL.md:66-67, "Do not edit past runs"). Three of the
seven files carry a `<!-- solution-acceptance: <key> = <value> -->`
HTML-comment marker, all sharing one comment prefix but split across two
opposite fail postures. This doc covers those markers and the
findings-table header that backs one of them; the review-gate rules that
decide *which* value goes into the markers live in
[review-gate-and-waivers.md](review-gate-and-waivers.md), and the subagent
YAML contracts referenced below live in
[subagent-contracts-superset.md](subagent-contracts-superset.md).

## The run-base marker: change-binding, fails OPEN

`00-goal.md` ships with `<!-- solution-acceptance: run-base = TODO -->`
(packages/orchestrator-workflow/assets/templates/00-goal.md:3, pinned
byte-exact by packages/orchestrator-workflow/test/template-markers.test.ts:39-43).
At run creation the orchestrator replaces `TODO` with the pre-change repo
HEAD (`git rev-parse HEAD`), recorded before the run's first implementation
commit (SKILL.md:69-71). Despite sharing the `solution-acceptance:` prefix
with the two verdict markers below, run-base is not a verdict: it is a
change-binding signal for run-completeness readers, and it fails **open**
(SKILL.md:73-76). Left as `TODO` it does not block anything, the reader
just falls back to a tolerant day-granular date heuristic. When filled, the
recorded sha must resolve in the repo, be an ancestor of HEAD, and must not
lie behind the fork point of the change (the merge-base with the remote
default branch) (SKILL.md:76-78). The in-repo changelog entry adds the
consumer's malformed-value behavior: a valid sha gets an exact binding, a
malformed value blocks explicitly via a 7-40 hex guard, and only a bare
`TODO` falls back to the date heuristic (packages/orchestrator-workflow/CHANGELOG.md:88-96,
"grounding-mcp 0.6.0 reads this marker"; SKILL.md:79 points to "the
grounding-mcp 0.6.0 docs for the full consumer semantics", so external
reader internals are not verified from this repo). Introduced in 0.9.0
(CHANGELOG.md:84-101). Pinned by template-markers.test.ts:19,33-37 (exactly
one `run-base` marker, defaulting to `TODO`) and :39-43 (the literal line,
wrapper included).

## The verdict markers: acceptance signals, fail CLOSED

`05-review-findings.md` and `06-handoff.md` each carry one verdict marker,
opposite in posture to run-base:

- `05-review-findings.md:27`: `<!-- solution-acceptance: acceptance-recommendation = TODO -->`,
  filled from the Acceptance Recommendation enum `accept | accept_with_notes
  | fix_required | reject` (packages/orchestrator-workflow/assets/templates/05-review-findings.md:23-25).
- `06-handoff.md:43`: `<!-- solution-acceptance: final-status = TODO -->`,
  filled from the Final Status enum `accepted | accepted_with_notes |
  needs_followup | blocked` (packages/orchestrator-workflow/assets/templates/06-handoff.md:39-41).

SKILL.md's closing instruction: "replace the `TODO` in each
`<!-- solution-acceptance: ... = TODO -->` marker with the chosen enum
value. That marker line is the machine-readable signal the harness
solution-acceptance run-gate reads, so leaving it as `TODO` keeps the run
non-accepting (fail-closed)" (SKILL.md:138-142). A freshly-copied run is
therefore non-accepting by construction; this contract shipped in 0.7.0
(CHANGELOG.md:186-198). Consumer is "the harness solution-acceptance
run-gate" per SKILL.md:141; this doc cites that in-repo statement only, it
does not assert the external gate's internals. Pinned by
template-markers.test.ts:16-18 (regexes) and :21-31 (one marker per
template, default `TODO`).

## The findings-table Severity/Decision header: the machine-read surface behind acceptance-recommendation

The `## Findings` table in `05-review-findings.md` is itself a read
surface, not just prose backing the acceptance-recommendation marker. A
load-bearing comment above the table states: "grounding-mcp's
orchestrator-workflow completeness reader locates this table by its header
row and verifies unresolved findings from those two columns [Severity,
Decision]. Do not rename or drop them"
(05-review-findings.md:9). This was a reactive fix (0.7.3,
CHANGELOG.md:134-151): a live run had drifted onto
`| Severity | Finding | Resolution |` (no Decision column), and the reader
failed closed with an explicit "not in the expected table format" blocker
rather than silently passing. The Decision legend defines
`RESOLVED_DECISIONS = {accepted, defer}`: a high/critical finding counts as
resolved only when its Decision is `accepted` or `defer`; every other value
(`fix`, `reject`, blank, `open`, `TODO`) leaves it unresolved and **arms**
the completeness gate (05-review-findings.md:10). The template's example row
was deliberately narrowed to `accepted/defer` only (0.7.4,
CHANGELOG.md:118-133) so the template itself never invites `fix`/`reject`
as if they were resolutions. Pinned by template-markers.test.ts:59-70
(header row carries both `severity` and `decision` cells), :72-74 (the
load-bearing comment exists), :76-90 (example row's Decision cell is
exactly `accepted/defer`, mutation-checked), and :92-97 (the
`RESOLVED_DECISIONS = {accepted, defer}` string and "arms the ... gate"
wording are both present verbatim).

## The Knowledge Bundle handoff section (0.12.0): the loop-closer

`06-handoff.md` gained an optional `## Knowledge Bundle` section
(06-handoff.md:27-33): "only applies when the repo carries a curated
knowledge bundle (for example a `docs/okf/` directory)... Outcome: updated |
not affected | follow-up filed." SKILL.md's step 9 (Hand off) instructs
applying this guidance before filling the file: check whether the change
touched any path a bundle doc claims as a `sources:` entry, and if so either
update the affected docs (re-verify and re-stamp) or record a follow-up
task, running the bundle validator when one is available (for example
`okf-kit check`) (SKILL.md:128-134). It is explicitly non-gating: "apply
this optional guidance" and "Repos without a bundle are unaffected"
(SKILL.md:128,134). This is the symmetric counterpart to the 0.8.0
discovery-side rule (the Discover step already checks `docs/okf/` before
hand-mapping terrain, SKILL.md:91-96); the 0.12.0 changelog entry names it
the loop-closer and cites the motivating evidence: four upkeep sweeps on
2026-07-16 found 48/24/11/8 stale claims across the four oldest bundles
(CHANGELOG.md:8-30). Pinned by
docs-consistency.test.ts:248-255 (the hook's opening phrase, anchored so a
deletion is detected even though "curated knowledge bundle" and
"docs/okf/" also occur in the Discover-step test), :257-261 (source-overlap
check phrase), :263-267 (both responses named), :269-272 (validator-run
phrase, `okf-kit check` framed as an example), :274-277 (non-gate
optionality phrase), and :279-294 (the template section, its outcome
vocabulary, and that it is marked Optional and bundle-scoped).

## Where the shapes are pinned, and what belongs to sibling docs

Two test files carry this doc's guarantees:
`packages/orchestrator-workflow/test/template-markers.test.ts` pins the
three markers (regex + count + default value + byte-exact line for
run-base) and the findings-table header/legend/example-row triad above.
`packages/orchestrator-workflow/test/docs-consistency.test.ts` is broader
(role enumeration, review-gate wording, instruction trust boundary,
subagent misfire rule, task-slicer/subagent-contract field superset); only
its `run-base fill instruction ships in the skill`
(docs-consistency.test.ts:297-305) and
`hand off keeps a curated knowledge bundle current`
(docs-consistency.test.ts:244-295) `describe` blocks are this doc's topic.
The review-gate decision procedure that produces the values written into
`acceptance-recommendation`/`final-status` (severities, waiver rules, who
signs off) is out of scope here; see
[review-gate-and-waivers.md](review-gate-and-waivers.md). The
explorer/implementer/reviewer/task-slicer YAML contracts referenced by
SKILL.md's Workflow steps are out of scope here too; see
[subagent-contracts-superset.md](subagent-contracts-superset.md).

## Gotcha for anyone grepping `solution-acceptance:`

All three markers share one comment grammar,
`<!-- solution-acceptance: <key> = <value> -->`, but a naive grep for the
prefix mixes a fail-open change-binding marker (`run-base`) with two
fail-closed acceptance verdicts (`acceptance-recommendation`,
`final-status`). Treating all three as "the acceptance gate" is wrong:
leaving `run-base` as `TODO` is harmless (day-granular fallback), leaving
either verdict marker as `TODO` keeps the run non-accepting. The three are
distinguished only by the `<key>` token and by which of `00-goal.md`,
`05-review-findings.md`, `06-handoff.md` they live in.
