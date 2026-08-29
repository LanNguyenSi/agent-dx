---
type: module
title: Run-state lifecycle and machine-readable markers
description: The .ai/runs/ directory model plus the solution-acceptance marker family (run-base, acceptance-recommendation, final-status), the per-worktree .ai/run pointer and keyed run-base[<repo-basename>] marker for multi-repo runs, the findings-table header and placeholder-row convention, and why 02-tasks.md sits outside the completeness check.
tags: [run-lifecycle, solution-acceptance-markers, fail-open-fail-closed, findings-table, knowledge-bundle-handoff, multi-repo-run-pointer]
timestamp: 2026-08-29T05:01:54Z
sources:
  - packages/orchestrator-workflow/assets/templates/00-goal.md
  - packages/orchestrator-workflow/assets/templates/02-tasks.md
  - packages/orchestrator-workflow/assets/templates/05-review-findings.md
  - packages/orchestrator-workflow/assets/templates/06-handoff.md
  - packages/orchestrator-workflow/assets/skill/SKILL.md
  - packages/orchestrator-workflow/assets/agents-md-section.md
  - packages/orchestrator-workflow/test/template-markers.test.ts
  - packages/orchestrator-workflow/test/docs-consistency.test.ts
  - packages/orchestrator-workflow/CHANGELOG.md
  - packages/orchestrator-workflow/README.md
  - packages/orchestrator-workflow/INSTALL-AGENT.md
---

# Run-state lifecycle and machine-readable markers

One unit of work lives in `.ai/runs/YYYY-MM-DD-<slug>/`, seven files
`00-goal.md` through `06-handoff.md` (packages/orchestrator-workflow/assets/skill/SKILL.md:65-76#"05-review-findings.md").
The orchestrator creates it by copying `.ai/workflow/templates/`
(SKILL.md:80-81#"the files as the run progresses. The newest run"; packages/orchestrator-workflow/README.md:91-96;
packages/orchestrator-workflow/INSTALL-AGENT.md:59-60,173-178). The newest run
directory is the active one unless a `.ai/run` pointer names one
(SKILL.md:80-83#"older directories are the auditable history. Do not", see the pointer section below); older
directories are the auditable history and
must not be edited (SKILL.md:83#"older directories are the auditable history. Do not", "Do not edit past runs"). Three of the
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
(packages/orchestrator-workflow/assets/templates/00-goal.md:3#"<!-- solution-acceptance: run-base = TODO -->", pinned
byte-exact by packages/orchestrator-workflow/test/template-markers.test.ts:39-41#"<!-- solution-acceptance: run-base = TODO -->").
At run creation the orchestrator replaces `TODO` with the pre-change repo
HEAD (`git rev-parse HEAD`), recorded before the run's first implementation
commit (SKILL.md:107-108#"recorded before the first implementation commit of the"). Despite sharing the `solution-acceptance:` prefix
with the two verdict markers below, run-base is not a verdict: it is a
change-binding signal for run-completeness readers, and it fails **open**
(SKILL.md:110-111#"it does not block anything, the reader just falls back"). Left as `TODO` it does not block anything, the reader
just falls back to a tolerant day-granular date heuristic. When filled, the
recorded sha must resolve in the repo, be an ancestor of HEAD, and must not
lie behind the fork point of the change (the merge-base with the remote
default branch) (SKILL.md:112-114#"change (the merge-base with the remote default branch);"). The in-repo changelog entry adds the
consumer's malformed-value behavior: a valid sha gets an exact binding, a
malformed value blocks explicitly via a 7-40 hex guard, and only a bare
`TODO` falls back to the date heuristic
(`packages/orchestrator-workflow/CHANGELOG.md:#[0.9.0]#"grounding-mcp 0.6.0 reads this marker"`;
SKILL.md:115#"gate's documentation (grounding-mcp) for the full" points to "the
consuming gate's documentation (grounding-mcp) for the full consumer
semantics" (0.24.0 placement pass dropped the pinned `0.6.0` version
number from this pointer; the CHANGELOG's 0.9.0 entry above still carries
the version-specific historical claim), so external reader internals are
not verified from this repo). Introduced in 0.9.0
(`CHANGELOG.md:#[0.9.0]`). Pinned by template-markers.test.ts:19#"const runBaseRe = /solution-acceptance:\s*run-base\s*=\s",33-37 (exactly
one `run-base` marker, defaulting to `TODO`) and :39-43 (the literal line,
wrapper included).

## The `.ai/run` pointer and keyed `run-base[<repo-basename>]` markers (0.26.0-unreleased, round 2)

The run directory may live in the orchestrator's own workspace or in one of
the repositories the run touches; either is fine. For every repository or
worktree a run touches, the orchestrator binds it to the run with a pointer
file, `<worktree-root>/.ai/run`: a plain text file whose first non-empty
line is the absolute path of the run directory, machine-local, and it
belongs in `.gitignore`
(SKILL.md:89-96#"absolute path."). Write it before the first implementation
commit, overwrite it at the start of every later run, and remove it when no
run is active, since a pointer left behind keeps binding that worktree to
the old run (SKILL.md:85-103#"document, not the kit's.").

The run-completeness reader resolves the run through the pointer first. When
no pointer file exists, it falls back to that repository's own `.ai/runs/`
and takes the run there that sorts newest by directory name; a broken
pointer (one whose target does not resolve) is rejected outright rather
than falling back
(SKILL.md:98-103#"document, not the kit's."). The scan fallback is only
right when the run actually lives in that repository and sorts last: the
consumer's own test suite (agent-grounding, packages/grounding-mcp,
`tests/ow-run-completeness.test.ts`) measures this directly. With no pointer
and a run directory present under `.ai/runs/`, the reader reports
`enforced: true`, `complete: true` (given an otherwise-accepted run) and
`runSource: 'scan'` against whichever run the scan finds newest, stale or
not; a repository with no pointer and no run directory at all reports
`enforced: false`. As with the run-base section above, this doc cites only
the in-repo statement of the pointer contract, not grounding-mcp's own
implementation of the reader; the scan-fallback and enforced/complete/
runSource values above are read off that consumer's own tests, not measured
by this repo's suite.

Step 1 of the Workflow carries the matching instruction to write the pointer
in every worktree the run touches
(SKILL.md:135-136#"in every worktree the run touches."), and each of the
three per-harness bullets under Harness notes repeats that the pointer rule
applies unchanged regardless of harness (SKILL.md:474-479#"applies unchanged.";
SKILL.md:480-482#"applies unchanged."; SKILL.md:483-486#"applies unchanged.").
The policy section installed into `AGENTS.md` carries the same two facts in
one bullet: every touched worktree gets the pointer, and `00-goal.md` gets
one keyed `run-base[<repo-basename>]` marker per repository for a multi-repo
run (packages/orchestrator-workflow/assets/agents-md-section.md:159-161#"marker per repository for multi-repo runs").

For a run that touches more than one repository, the orchestrator records
one keyed marker per repository on its own line beside the unkeyed one,
exact form `<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->`,
where `<repo-basename>` is the worktree directory's basename (or the main
repository's basename for a linked worktree) and the value is that
repository's pre-change HEAD. Write the marker exactly in that form, on its
own line: a deviating line is either rejected (it blocks the run) or not
recognised at all (the binding for that repository is silently missing)
(SKILL.md:122-125#"for that repository is silently missing)."). The consumer's own tests
measure both halves of that generalisation: a rejected line is `malformed`
(uppercase field name, whitespace before the colon, and extra dashes in the
comment opener are each their own malformed-blocker test), and a marker
placed inside a list bullet is not recognised at all, so the run reads as
markerless rather than blocked. `00-goal.md` ships the keyed line as a
placeholder example directly below the unkeyed run-base marker
(packages/orchestrator-workflow/assets/templates/00-goal.md:4#"<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->"),
and readers ignore a placeholder key of the literal shape `<repo-basename>`
as a documentation example, until the placeholder key is actually replaced
(SKILL.md:122#"until the placeholder key is replaced"). A real key left with
the placeholder value `<sha>` is not ignored the same way: the value is
read as-is and the verdict layer blocks it, since `<sha>` is not a commit
sha. Unlike the pointer, this marker line is written into a
tracked run file, not gitignored: the README and the manual-install doc both
note the pointer is machine-local and add it to `.gitignore`
(packages/orchestrator-workflow/README.md:100-102#"it to the repository's";
packages/orchestrator-workflow/INSTALL-AGENT.md:60-63#"repository's";
packages/orchestrator-workflow/INSTALL-AGENT.md:175-177#"repository's").

The template-markers.test.ts property test that checks the shipped keyed
line against the consumer's shape no longer mirrors a tightened subset of
grounding-mcp's `KEYED_RUN_BASE_STRICT` and `PLACEHOLDER_KEY`: it now
carries both regexes verbatim, kept in sync by hand
(template-markers.test.ts:98-101#"PLACEHOLDER_KEY = /^<[^>]*>$/;").

The unkeyed `run-base` marker described in the section above is unchanged by
any of this: it remains the single-repo path, and it is also the fallback a
reader uses when a run never grew a second repository, so a plain
single-repo run carries only the one marker it always carried.

Two describe blocks pin the shipped shapes. In
`template-markers.test.ts`, one test pins the keyed placeholder line
byte-exactly
(template-markers.test.ts:55-59#"<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->"),
a second pins that it is a standalone whole-line comment, not embedded in
prose (template-markers.test.ts:61-70#"trimmed.endsWith("), a third pins
that it sits directly below the unkeyed marker
(template-markers.test.ts:72-81#"run-base[<repo-basename>] = <sha>"), and a
fourth pins that the existing unkeyed-marker regex still matches exactly
once, i.e. the keyed line's bracket does not get mistaken for the unkeyed
one (template-markers.test.ts:83-84#"goalTemplate.matchAll(runBaseRe)"). In
`docs-consistency.test.ts`, one new `describe` block pins that each doc that
instructs writing the pointer or the keyed marker actually says so. Six of
the seven checks (all but the SKILL.md Run state contract check itself)
route through one `expectPointerMention` helper that asserts the exact
phrase "`.ai/run` pointer" rather than the bare, incident-prone substring
`.ai/run`
(docs-consistency.test.ts:381-388#"expect(slice).toContain("):
SKILL.md Run state documents the `.ai/run` contract with its own specific
phrases (docs-consistency.test.ts:390-397#"make sure it is ignored") and
carries the keyed example verbatim
(docs-consistency.test.ts:399-401#"run-base[<repo-basename>] = <sha>");
step 1 mentions the pointer via the helper
(docs-consistency.test.ts:410-417#"expectPointerMention(step1)"); each of
the three harness bullets mentions it via the helper, in a loop
(docs-consistency.test.ts:419-438#"expectPointerMention(bullet)"); the
policy-section bullet carries both facts
(docs-consistency.test.ts:440-448#"run-base[<repo-basename>]"); and the
README and both INSTALL-AGENT.md write-surface listings mention the pointer
via the helper and `.gitignore` by substring
(docs-consistency.test.ts:450-456#"expectPointerMention(section)";
docs-consistency.test.ts:460-466#"expectPointerMention(section)";
docs-consistency.test.ts:470-476#"expectPointerMention(section)").

## The verdict markers: acceptance signals, fail CLOSED

`05-review-findings.md` and `06-handoff.md` each carry one verdict marker,
opposite in posture to run-base:

- `05-review-findings.md:28#"<!-- solution-acceptance: acceptance-recommendation = TODO -->"`: `<!-- solution-acceptance: acceptance-recommendation = TODO -->`,
  filled from the Acceptance Recommendation enum `accept | accept_with_notes
  | fix_required | reject` (packages/orchestrator-workflow/assets/templates/05-review-findings.md:24-26#"accept | accept_with_notes | fix_required | reject").
- `06-handoff.md:43#"<!-- solution-acceptance: final-status = TODO -->"`: `<!-- solution-acceptance: final-status = TODO -->`,
  filled from the Final Status enum `accepted | accepted_with_notes |
  needs_followup | blocked` (packages/orchestrator-workflow/assets/templates/06-handoff.md:39-41#"accepted | accepted_with_notes | needs_followup | blocked").

SKILL.md's closing instruction: "replace the `TODO` in each
`<!-- solution-acceptance: ... = TODO -->` marker with the chosen enum
value. That marker line is the machine-readable signal the harness
solution-acceptance run-gate reads, so leaving it as `TODO` keeps the run
non-accepting (fail-closed)" (SKILL.md:259-263#"non-accepting (fail-closed)."). A freshly-copied run is
therefore non-accepting by construction; this contract shipped in 0.7.0
(`CHANGELOG.md:#[0.7.0]`). Consumer is "the harness solution-acceptance
run-gate" per SKILL.md:260-261#"value. That marker line is the machine-readable signal"; this doc cites that in-repo statement only, it
does not assert the external gate's internals. Pinned by
template-markers.test.ts:16-18#"/solution-acceptance:\s*acceptance-recommendation\s*=\s*" (regexes) and :21-31 (one marker per
template, default `TODO`).

## The findings-table Severity/Decision header: the machine-read surface behind acceptance-recommendation

The `## Findings` table in `05-review-findings.md` is itself a read
surface, not just prose backing the acceptance-recommendation marker. A
load-bearing comment above the table declares the Severity and Decision
headers load-bearing: "the orchestrator-workflow completeness reader
locates this table by its header row and verifies unresolved findings from
those two columns. Do not rename or drop them."
(05-review-findings.md:9#"<!-- The Severity and Decision column headers below are load-bearing: the orchestrator-workflow completeness reader locates this table by its header row and verifies unresolved findings from those two columns. Do not rename or drop them. -->"; line 10 and the 0.7.3 changelog entry attribute
that reader to grounding-mcp). This was a reactive fix (0.7.3,
`CHANGELOG.md:#[0.7.3]`): a live run had drifted onto
`| Severity | Finding | Resolution |` (no Decision column), and the reader
failed closed with an explicit "not in the expected table format" blocker
rather than silently passing. The Decision legend defines
`RESOLVED_DECISIONS = {accepted, defer}`: a high/critical finding counts as
resolved only when its Decision is `accepted` or `defer`; every other value
(`fix`, `reject`, blank, `open`, `TODO`) leaves it unresolved and **arms**
the completeness gate (05-review-findings.md:10#"<!-- Decision legend: a high/critical finding counts as RESOLVED (the completeness gate passes) only when its Decision is"). The template's example row
was deliberately narrowed to `accepted/defer` only (0.7.4,
`CHANGELOG.md:#[0.7.4]`) so the template itself never invites `fix`/`reject`
as if they were resolutions. Pinned by template-markers.test.ts:144-154#"decision"
(header row carries both `severity` and `decision` cells), :157-159 (the
load-bearing comment exists), :161-185 (example row's Decision cell is
exactly `accepted/defer`, mutation-checked), and :187-194 (the
`RESOLVED_DECISIONS = {accepted, defer}` string and "arms the ... gate"
wording are both present verbatim).

## The findings-table placeholder row (0.13.0): closing the mixed-state bypass

The example/legend row itself (05-review-findings.md:13#"| low/medium/high/critical | correctness/architecture/security/tests/maintainability/performance/docs | <!-- finding --> | <!-- fix --> | accepted/defer |",
`| low/medium/high/critical | ... | accepted/defer |`) is the shipped
template's untouched-state signature, and prior to 0.13.0 the contract said
nothing about what to do with it. grounding-mcp's completeness reader
identifies a real finding row by its SEVERITY cell carrying a single
concrete value, so the slash-list legend row is (by design) never counted as
a finding — a run that fills the acceptance-recommendation marker with
`accept` but leaves this row byte-for-byte as shipped therefore reads as
`complete: true` with zero findings, indistinguishable from a genuine
zero-findings review (the "mixed-state bypass"). 0.13.0 documents the fix's
contract half in this repo: a comment directly below the placeholder row
(05-review-findings.md:14#"marker does. During findings transfer (step 7), replace this row with each reviewer finding. For a genuine zero-findings review, delete this row instead — a header row with no data rows is a valid, complete table; leaving this row next to real finding rows is also fine. This mirrors grounding-mcp's placeholder-row detection; keep the two in sync. -->") states the rule the orchestrator must follow —
replace the row when transferring findings, or delete it outright for a
genuine zero-findings review (a header row with no data rows is valid;
leaving the legend row next to real finding rows is also fine) — and
SKILL.md's step 7 carries the same one-sentence rule
(SKILL.md:209-213#"rows as the template never having been filled in. When"). The runtime half (grounding-mcp's reader treating a
survived, unaccompanied placeholder row as an explicit format blocker,
instead of silently reporting zero findings) is a lockstep sibling change in
the grounding-mcp repo, out of scope for this bundle; this doc, like the
run-base section above, cites only the in-repo contract and the reader's
externally-documented matching rule, not that repo's implementation.
Pinned by template-markers.test.ts's "placeholder-row fail-closed
convention" describe block: one test pins the row's literal wording
(mutation-checked, matching the reader's literal match), a second pins that
the replace/delete rule is documented next to the row.

## Why 02-tasks.md is not part of the completeness check

The completeness reader reads exactly three run files —
`00-goal.md` (run-base only), `05-review-findings.md`, and
`06-handoff.md` — and never opens `02-tasks.md`. This is deliberate, not an
oversight to fix later: `02-tasks.md` records a planning artifact (the task
slices an orchestrator produced before implementation), not an acceptance
signal like a review recommendation or a final status. SKILL.md's own
scaling rule allows slicing to be skipped entirely for a small or
well-understood change (SKILL.md:18-22#"the apparatus changes. When tier variants are", 150-154: task slicing is "for
non-trivial changes"; a trivial change may skip the run directory
altogether). Folding `02-tasks.md` into the completeness check would force
every legitimately slim run — one that correctly skipped slicing — to
either fabricate a tasks file or fail a gate that was never meant to judge
planning artifacts, a false positive the reader's file selection avoids by
construction.

## The Knowledge Bundle handoff section (0.12.0): the loop-closer

`06-handoff.md` gained an optional `## Knowledge Bundle` section
(06-handoff.md:27-33#"- <!-- outcome and brief note, or omit this section when the repo carries no bundle -->"): "only applies when the repo carries a curated
knowledge bundle (for example a `docs/okf/` directory)... Outcome: updated |
not affected | follow-up filed." SKILL.md's step 9 (Hand off) instructs
applying this guidance before filling the file: check whether the change
touched any path a bundle doc claims as a `sources:` entry, and if so either
update the affected docs (re-verify and re-stamp) or record a follow-up
task, running the bundle validator when one is available (for example
`okf-kit check`) (SKILL.md:246-251#"validator when one is available (for example"). It is explicitly non-gating: "apply
this optional guidance" and "Repos without a bundle are unaffected"
(SKILL.md:246-247#"guidance: when the repo carries a curated knowledge",251-252). Since 0.24.0 (placement rule) step 9 also
carries a one-sentence placement check for the orchestrator: before handing
off, check that no org-, machine- or point-in-time-bound evidence was added
to a reusable instruction file (SKILL.md:254-257#"or the consuming workspace, with a pointer left behind."); the fix is to move the
evidence to the changelog, the run files, or the consuming workspace, with a
pointer left behind. `reviewer.md`'s "Check, at minimum" list carries a
matching check for the same thing on the implementer side of a run. This is
the symmetric counterpart to the 0.8.0
discovery-side rule (the Discover step already checks `docs/okf/` before
hand-mapping terrain, SKILL.md:140-141#"with an index) before mapping terrain by hand, treating"); the 0.12.0 changelog entry names it
the loop-closer and cites the motivating evidence: four upkeep sweeps on
2026-07-16 found 48/24/11/8 stale claims across the four oldest bundles
(`CHANGELOG.md:#[0.12.0]`). Pinned by
docs-consistency.test.ts:300-305#"apply this optional guidance: when the repo carries a" (the hook's opening phrase, anchored so a
deletion is detected even though "curated knowledge bundle" and
"docs/okf/" also occur in the Discover-step test), :309-313 (source-overlap
check phrase), :315-319 (both responses named), :321-324 (validator-run
phrase, `okf-kit check` framed as an example), :326-329 (non-gate
optionality phrase), and :331-346 (the template section, its outcome
vocabulary, and that it is marked Optional and bundle-scoped).

## Where the shapes are pinned, and what belongs to sibling docs

Two test files carry this doc's guarantees:
`packages/orchestrator-workflow/test/template-markers.test.ts` pins the
three markers (regex + count + default value + byte-exact line for
run-base), the keyed `run-base[<repo-basename>]` placeholder line that
ships as a fourth line in `00-goal.md` beside the unkeyed run-base marker
(still one `run-base` key; the keyed line adds a per-repository variant, not
a fourth key), the findings-table header/legend/example-row triad above, and
(0.13.0) the placeholder-row fail-closed convention (literal row wording,
mutation-checked; the replace/delete rule documented next to it).
`02-tasks.md` carries no marker or pinned shape of its own — it is a
`sources:` entry here only because the "why it's excluded from the
completeness check" section above cites it, not because this doc pins
anything inside it.
`packages/orchestrator-workflow/test/docs-consistency.test.ts` is broader
(role enumeration, review-gate wording, instruction trust boundary,
subagent misfire rule, task-slicer/subagent-contract field superset); only
its `run-base fill instruction ships in the skill`
(docs-consistency.test.ts:349-355#"before the first implementation commit") and
`hand off keeps a curated knowledge bundle current`
(docs-consistency.test.ts:296-344#"Optional") `describe` blocks are this doc's topic.
The review-gate decision procedure that produces the values written into
`acceptance-recommendation`/`final-status` (severities, waiver rules, who
signs off) is out of scope here; see
[review-gate-and-waivers.md](review-gate-and-waivers.md). The
explorer/implementer/reviewer/task-slicer/advisor YAML contracts referenced
by SKILL.md's Workflow steps are out of scope here too; see
[subagent-contracts-superset.md](subagent-contracts-superset.md).

## Gotcha for anyone grepping `solution-acceptance:`

All three marker keys share one comment grammar,
`<!-- solution-acceptance: <key> = <value> -->`, but a naive grep for the
prefix mixes a fail-open change-binding marker (`run-base`) with two
fail-closed acceptance verdicts (`acceptance-recommendation`,
`final-status`). Treating all three as "the acceptance gate" is wrong:
leaving `run-base` as `TODO` is harmless (day-granular fallback), leaving
either verdict marker as `TODO` keeps the run non-accepting. The three keys
are distinguished only by the `<key>` token and by which of `00-goal.md`,
`05-review-findings.md`, `06-handoff.md` they live in. A grep for the prefix
in `00-goal.md` on a multi-repo run also turns up a fourth line, the keyed
`run-base[<repo-basename>]` marker: same `run-base` key family, same
fail-open posture, one line per repository instead of one line total; see
the keyed-marker section above.

## Note: 05-review-findings.md's 0.14.0 trailing comment is not a marker

`05-review-findings.md` gained a trailing HTML comment in 0.14.0 pointing
reviewers at the new reviewer-contract reproduction requirement, appended
after the acceptance-recommendation marker so no marker, header, or
placeholder-row line shifted. It carries no `solution-acceptance:` prefix
and no enum, so none of the marker/table mechanics in this doc changed; the
requirement itself is out of scope here — see
[review-gate-and-waivers.md](review-gate-and-waivers.md) and
[subagent-contracts-superset.md](subagent-contracts-superset.md).
