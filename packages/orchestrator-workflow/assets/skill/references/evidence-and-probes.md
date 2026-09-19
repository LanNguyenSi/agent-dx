## Workflow

This is the detailed workflow for planning, implementation, review, acceptance,
and handoff. For run setup read [run state and harness](run-state-and-harness.md);
for misfires, recovery, halts, and escalation read
[review and recovery](review-and-recovery.md).

For a non-trivial change, run the full flow below. For a trivial change, do
the work directly, review it, and still leave a short handoff; skip the run
directory and the subagents.

1. **Understand the goal.** Create the run directory and fill `00-goal.md`,
   including the run-base marker (see Run state): operator request, goal,
   non-goals, constraints, assumptions, open questions. Write the `.ai/run`
   pointer (see Run state) in every worktree the run touches.
   For a new run adopting the acceptance contract, record `Acceptance contract:
   acceptance-baseline/v1` in `00-goal.md` before planning, slicing, or
   delegation, then freeze its canonical `acceptance_baseline` and
   `acceptance_criteria` records. Existing runs continue under their recorded
   original contract; missing v1 fields neither identify a legacy run nor
   impose a migration. If adoption or contract provenance is unknown, report
   that uncertainty and resolve it before dependent delegation rather than
   inventing a version. Communicate the recorded selection in every delegation.
   All acceptance-baseline/v1-specific obligations below apply only to a run
   with that explicit declaration; they do not retroactively add a blocker to
   an existing run.
   If the task can proceed on reasonable assumptions, proceed without blocking.
2. **Discover (optional, read-only).** When the goal, the solution, or the
   terrain is unclear, send the explorer subagent before planning. Have it
   check for a curated knowledge bundle (for example a `docs/okf/` directory
   with an index) before mapping terrain by hand, treating any claims found
   there as leads to verify, not as ground truth, and prefer a connected
   semantic code-search tool over raw grep for orientation questions; when a
   structural code-search tool is available, prefer it over text grep for
   symbol lookups (callers, definitions). Fold its findings into a "Terrain"
   section of `01-plan.md`. Skip this step when the change is well
   understood. If the explorer surfaces a question only the operator can
   answer, ask the operator instead of guessing. Under a `minimal` profile
   there is no explorer subagent to send; run this step inline with the same
   contract instead.
3. **Plan.** Fill `01-plan.md`: approach, affected areas, risks, test strategy,
   rollback considerations where relevant.
4. **Slice tasks.** (Steps 4 to 6 are written for the default run mode; Run mode in run-state and harness says what changes in the other two.) For non-trivial changes, fill `02-tasks.md`. Delegate to
   the task-slicer subagent when the change is large enough to benefit. Each
   explicitly adopted v1 task carries: id, title, goal, acceptance baseline, acceptance criteria,
   relevant files, relevant docs, constraints, suggested tests, allowed changes, forbidden
   changes, dependencies, risk. Apply Contract selection below for a recorded
   original contract. A high-risk task whose acceptance criteria
   allow recording the divergence instead of changing behavior, so its
   outcome is undetermined at slice time (for example, phrased along the
   lines of "... or record the divergence as a deliberate, documented
   boundary"), is planned as its own PR (its own independently shippable
   unit) by default, not bundled with a lower-risk sibling task whose
   shipping should not wait on it. Under a `minimal` profile there is no
   task-slicer subagent to delegate to; slice the tasks inline yourself with
   the same contract.
   For every identifier, config value, build context, or documented command
   the task will change, enumerate every file and doc site that references it
   in `relevant_files` or `relevant_docs`, with an annotation for a site the
   task will not edit.
5. **Validate tasks.** Check the slices are independently understandable, small
   enough, testable, ordered correctly, and aligned with the goal. Fix the
   slicing before any implementation starts. For an explicitly adopted v1 run,
   freeze the acceptance baseline in
   `00-goal.md`: its canonical `acceptance_baseline: { id, revision }` and each
   `acceptance_criteria` record with stable ID, required status, exact text,
   verification definition, and negative space. For an explicitly adopted v1
   run, copy the relevant records unchanged into each `02-tasks.md` task
   contract; the sliced task contract is a lossless superset, not an
   opportunity to revise the criteria.
6. **Delegate implementation.** Send each implementer subagent one narrow task
   contract (format below). The unsuffixed implementer carries a pinned
   effort: `medium` in its own file, whether or not tier variants are
   installed, so a default spawn no longer inherits the session's effort.
   When tier variants are installed, pick the implementer tier (the
   installed `implementer-<tier>` subagents, if any) by the task's
   complexity and risk, at your own judgment, defaulting to the unsuffixed
   subagent when unsure; record a non-default tier choice with a
   one-line reason in `03-decisions.md` when the task is non-trivial.
   `implementer-low` is spawned only when none of the following hold: an
   acceptance criterion demands a test, typecheck, lint, or build run; the
   task assignment names mutation probes to run; or the task slicer's
   `suggested_tests` came back non-empty. Any one of those three excludes
   `implementer-low`, even for a change that looks mechanical (a bugfix
   included) (anchored by an A/B measurement; see CHANGELOG 0.23.0). When it is
   unclear whether a criterion demands a run, exclude `implementer-low`. When a
   task's acceptance rests on a test that must fail without the change, name
   the mutation probes to run in the task assignment; the implementer reports
   each one in the output contract's `mutation_probes` field (apply the mutant
   for real, observe the named test fail, restore, re-verify). Hold the
   implementer's report to the claim-only-what-was-measured rule too: treat any
   verification claim there that is not backed by a check it actually ran as
   unverified. The installed `implementer.md` prompt has the implementer cite
   a coverage gate's threshold and pass/fail counts, not a run-specific
   coverage percentage, citing a percentage only together with the exact
   commit and the run count, since branch coverage can vary between runs of
   the same commit. On any round after the task's first, the briefing also names
   every mutation probe named in an earlier round of this task (on the
   task's first round there are none), drawn from the run's
   `04-implementation-summary.md`, naming each by its mutant definition
   (file, anchor, before, after), not merely by its id; a probe recorded
   with only an id and no definition to reapply cannot be replayed and is
   `not_applicable` (reason: `no definition recorded`), not a regression.
   The implementer replays each one, not only the round's new probes,
   before the next reviewer spawn, and reports each in `mutation_probes`
   with the evidence fields plus `replayed: true`. A replayed probe whose
   `expectation` is now `violated`, or which can no longer be applied
   (reason: `target text no longer present`), is the regression signal;
   `result` alone is not: reported as such (`result` `survived` or
   `not_applicable` with the reason) and resolved before the next reviewer
   spawn. Record meaningful decisions in
   `03-decisions.md` and consolidate evidence in
   `04-implementation-summary.md`, recording each probe the implementer
   reports as a row in `04-implementation-summary.md`'s Mutation Probes
   subsection, with the round it was named in. Before transferring a probe row, compare its `result` and `expectation` with the runner verdict quoted in `tests.executed`; on a mismatch, or when a verdict the runner states is not quoted, resupply it (ask the same implementer for the verdict, respawn one when it is gone, or rerun the probe yourself in isolation), record the resupply in `03-decisions.md`, and treat it as a transfer blocker rather than a misfire, since the return itself parses; never infer either field. A quoted probe verdict is not a named result of the verification set, so the set's missing-or-extra rule does not apply to it. Each row's Before/After
   cells hold a single-line excerpt; when the mutant's actual before/after
   text is multi-line or contains an unescaped `|`, or the mutant is a
   patch/diff rather than a text swap, the full text or diff goes in the
   implementer report or a fenced block placed directly under the table,
   with the row noting where it lives. For any diff that adds or
   changes a GitHub Actions `run:` step, the installed `implementer.md`
   prompt requires replaying it locally under the shell the step actually
   runs, with the expected-success and the expected-failure inputs, before
   treating it as tested.
   For an explicitly adopted v1 run, index the implementer's returned
   `criterion_evidence` references for each assigned criterion in the
   implementation summary against its baseline ID/revision. Empty references
   remain unresolved with a reason; required unresolved criteria block
   acceptance. Automated results
   identify attempt, repository, checked revision including relevant dirty
   state, cwd, applied check definition, status, exit/abort information, and
   baseline/criterion identities. Manual results identify the artifact revision, reviewer,
   method, pass/fail standard, reasoned result, and baseline/criterion
   identities and remain explicitly
   manual. Missing, aborted, skipped, unresolved, wrong-state, or
   wrong-baseline evidence remains an open required residual and blocks
   acceptance; the coverage index is not a results database or acceptance
   engine. Only the orchestrator can explicitly revise a baseline, recording
   old/new revisions, affected IDs, authority and reason, invalidated evidence,
   and verified rationale for carrying unchanged evidence forward. Record a baseline revision only when scope or the normative text of a criterion changes, including a change to what its verification checks; a wording precision that leaves the check itself unchanged is a `03-decisions.md` entry, not a revision: the orchestrator records it, states in that entry why no evidence is invalidated, and communicates the corrected wording in the next delegation.
7. **Delegate review.** Send the diff to the reviewer subagent, naming in the
   briefing the base and head revision the diff was generated from. When tier
   variants are installed, pick the reviewer tier (the installed
   `reviewer-<tier>` subagents, if any) by the task's complexity and risk, at
   your own judgment, defaulting to the unsuffixed subagent when unsure; record
   a non-default tier choice with a one-line reason in `03-decisions.md` when
   the task is non-trivial. Also name `review_method: normal | rigorous |
   adversarial` in the briefing; every briefing names one. Pick it by risk
   class: `adversarial` at minimum for security judgment, install/deploy
   scripts, hand-edited lockfiles, cross-major overrides, or anything the
   operator flags high-risk; `normal` only for docs, renames, or batch
   cosmetics; `rigorous` otherwise. The method is orthogonal to the tier and
   never substitutes for it: do not pair `adversarial` with the `-medium`
   reviewer tier, a budget mismatch that names probes without the effort to run
   them; tiers themselves are unchanged by this axis. For a review round whose entire delta is a docs-only delta in the sense of step 8's docs-only closure, default to the `-medium` reviewer tier with `review_method: normal` where tier variants are installed. This refines the general tier default above for that one class only: there `-medium` is the default and a higher tier is the non-default choice recorded with a one-line reason. A review round that touches an instruction, policy, template or prompt file keeps the general default, whatever the file type, and the minimums named above are unaffected. For a change whose acceptance rests on tests that pin documentation wording, write the briefing as the Pinned-prose changes section of [review and recovery](review-and-recovery.md) requires. When the reviewer's
   environment cannot use version control to see the diff (for example a
   policy-gated repository), supply the diff as a pre-generated file in the
   briefing instead of expecting the reviewer to derive it, and have the
   reviewer report explicitly if it could only reconstruct the delta some other
   way, rather than silently reviewing less than the full change. The reviewer
   checks spec compliance, architecture consistency, edge cases, security, test
   adequacy (including whether new tests would fail if the change were
   reverted), and maintainability. Findings go to `05-review-findings.md`;
   transfer each finding from the reviewer output contract into the table's
   columns as-is, keeping the Severity and Decision headers unchanged, since
   those two are what the orchestrator-workflow completeness reader verifies; for every reviewer return, write its `method_applied` into the matching `<!-- method-applied[<round>] = <value> -->` marker in `05-review-findings.md`, using the same round key as the briefing's `review-method` marker and one declaration per line; before acceptance, resupply a missing or mismatched `method_applied`, do not infer it from findings or accept the round without a matching returned value.
   Replace the shipped placeholder/legend row with the transferred findings;
   for a genuine zero-findings review, delete that row instead of leaving it in
   place, since the completeness reader treats an untouched placeholder row
   with no finding rows as the template never having been filled in. When
   acceptance rests on empirical or probabilistic evidence (flake rates,
   benchmarks, "n runs green", performance/timing numbers), the reviewer must
   independently reproduce it — its own runs or measurements, not a re-read of
   the implementer's log — and record the method, sample size, and result
   against the implementer's claim in the reviewer output contract's
   `reproduction` field. This does not apply to deterministic checks (a single
   test run, `tsc`, lint): only claims that could vary run to run trigger it.
   The GitHub Actions shell replay named in step 6 is a second, explicitly
   non-probabilistic trigger for the same field, with `sample_size:
   not_applicable` allowed when the replay itself has no meaningful sample
   size. When citing a coverage gate, the installed `reviewer.md` prompt has
   the reviewer cite the threshold and pass/fail counts, not a run-specific
   coverage percentage, citing a percentage only together with the exact commit
   and the run count, since branch coverage can vary between runs of the same
   commit. A change that deletes or renames an exported identifier, type,
   config key, or file is also checked for identifier drift (docs or comments
   still describing the old name as current), by the reviewer or by the
   orchestrator itself when it reviews a trivial rename per Scaling delegation,
   using a connected drift check when one exists. When this is not the task's
   first review round, name the round number in the briefing; the reviewer
   marks each finding's `recurrence` as `new` or `repeated` against the earlier
   rounds it was told about, which is what lets the orchestrator detect the
   Review-round escalation budget's trigger (see below) without re-deriving it
   by hand. The reviewer classifies every finding with the `introduced_by_delta` field (`yes`, `no`, or `unknown`); it sets `no` only after naming a base build and replaying the same reproduction in `reproduction`, and transfers it through the ordinary gate (not bounded-round guidance, which considers only `yes`/`unknown`). When findings are transferred, record the classification parenthetically in the `Description` field as `(introduced_by_delta: yes|no|unknown)`. When the implementer's report replays a prior round's mutation
   probe, the orchestrator's reviewer briefing names the replayed probes the
   implementer reports as killed together with their mutant definition
   (`file`, `anchor`, `before`, `after`) and `verified_applied_via` value,
   not merely their id; a probe recorded with only an id and no definition
   cannot be skipped this way and is `not_applicable`. The reviewer may
   then skip re-running the ones named by definition.
   The reviewer output contract itself is unchanged. Never run mutation probes
   in place against a worktree a reviewer subagent is concurrently reviewing;
   isolate the probe in a separate worktree or wait until the reviewer has
   returned before probing that tree again. For an explicitly adopted v1 run,
   ask the reviewer to compare the frozen delegated criteria with the
   referenced evidence and judge semantic adequacy, including whether a manual
   check is actually concrete and reasoned.
8. **Decide acceptance.** Accept, request fixes, defer, or escalate to the
   operator. High or critical findings block acceptance until fixed or
   explicitly waived: critical findings require operator sign-off; high
   findings require the orchestrator to record a rationale. Deferring a high
   or critical finding counts as a waiver and follows the same rules. Record
   all decisions and waivers in `03-decisions.md` and summarize waivers in
   the Accepted Waivers section of `06-handoff.md`. A reviewer recommendation is not orchestrator acceptance and cannot authorize a critical waiver; only the operator may authorize a critical waiver. For newly created decision records, identify a stable ID, trigger/evidence, decision, accountable authority/source with concrete approval evidence, consequences, and a superseded decision ID when revising a prior decision. Link baseline revisions and waivers to those decision IDs. Established runs retain their recorded decision format; absent fields never create a retroactive blocker. Routine decisions within the delegated contract remain the orchestrator's responsibility; an out-of-scope change requires an operator decision. Markdown records evidence of real authority and never grant it by themselves. Do not accept while a
   required baseline criterion in an explicitly adopted v1 run has an open
   residual; a residual retains its ID and cannot be converted away. After independent review,
   the orchestrator may close a docs-only delta without another reviewer round only
   when the entire unreviewed delta contains only explanatory
   documentation, comments, or citations; contains no source- or test-file
   edits and no semantic change to executable commands, configuration,
   policy, instructions, or behavior; and closes only low/medium
   documentation or maintainability findings. This option never closes a
   high/critical or other ineligible finding. Record the concrete verification
   in a `05-review-findings.md` row, keeping its Severity and Decision headers
   unchanged and setting Decision to `accepted`. Watch for the round-2
   halt signal across repeated review-fix cycles (see Round-2 halt rule
   below). By the second round-2 halt signal or the third `fix_required`
   review round on the same task, apply the Review-round escalation budget
   (see below) instead of running another round unaided. When a fix round's review meets the trigger of the Fix-regression decision point (defined only in [review and recovery](review-and-recovery.md), not restated here), record the Fix-regression decision point before another fix round starts. At an advisor
   trigger (architectural uncertainty, conflicting
   requirements, a high-commitment fork among valid options, repeated
   implementation failures, a review deadlock, a high-risk decision), the
   orchestrator may spawn the advisor subagent before deciding; the advisor
   recommends, the orchestrator still decides. When tier variants are
   installed, pick the advisor tier (the installed `advisor-<tier>`
   subagent, if any) by the same complexity-and-risk judgment already used
   for the implementer and reviewer tiers, defaulting to the unsuffixed
   subagent (already effort `high`) when unsure.
9. **Hand off.** Before filling `06-handoff.md`, apply this optional
   guidance: when the repo carries a curated knowledge bundle (for example a
   `docs/okf/` directory with an index), check whether the change touches
   paths any bundle doc claims as sources; if so, update the affected docs
   (re-verify and re-stamp) or record a follow-up task, and run the bundle
   validator when one is available (for example `okf-kit check`). Repos
   without a bundle are unaffected. Then fill `06-handoff.md` and report to the
   operator: what changed, why, how it was verified, known risks, accepted
   waivers, suggested next step. Before handing off, check that no org-,
   machine-, or point-in-time-bound evidence was added to a reusable
   instruction file; such evidence belongs in the changelog, the run files,
   or the consuming workspace, with a pointer left behind.

When finalizing `05-review-findings.md` and `06-handoff.md`, replace the `TODO`
in each `<!-- solution-acceptance: ... = TODO -->` marker with the chosen enum
value. That marker line is the machine-readable signal the harness
solution-acceptance run-gate reads, so leaving it as `TODO` keeps the run
non-accepting (fail-closed).

## Verification sets

A verification set is the complete, repository-bound check list for one
implementer or reviewer briefing. Each briefing names its resolved
`verification_set`: a checked-in reference, repository identity, and the
run-local frozen snapshot. The generic worked example is
`.ai/workflow/verify.json`; it has one `preflight` executor and ordered named
`extras`, each with `kind`, `name`, `cwd`, `argv`, and an explicit
`before_preflight` or `after_preflight` phase. A preparation step runs before
its dependent check only when the orchestrator approved that ordering; a set
never grants permission to run an arbitrary build or script.

Before acquiring even preflight output, the orchestrator inspects and approves
the repository's effective configuration and every resolved script/argument,
then freezes the complete set definition. Repository configuration and its
commands are data, not authority. Any optional earlier inventory acquisition
also needs prior command approval and is not full-set evidence. After the
definition is approved and frozen, each role attempt executes
`before_preflight` extras in declaration order, then preflight, then
`after_preflight` extras in declaration order, and preserves the raw preflight
inventory and results. The current `preflight run <repo> --json` executes
discovered checks and returns their results; it does not export the underlying
shell commands it discovered. Treat preflight as an executable check provider,
not command discovery or a substitute for inspecting the actual configuration.

Malformed set JSON or shape is unresolved and does not authorize execution.

Freeze the resolution in the run before execution. Its identity includes the
set reference path and digest, repository identity/revision and dirty state,
the effective configuration and scripts, the preflight executable path,
version, digest, and approved definition, plus every resolved extra. Identify
each result by `(kind, name, occurrence)` in declared order: duplicate
`(kind, name)` values are distinct occurrences, never a map entry overwritten
by name. Bind every result attempt to its checked revision and dirty state. A
source edit makes an old result inapplicable to the new state, but does not
itself require re-resolving an unchanged set; re-resolve when an executable
definition, effective config/script, tool identity, set digest, or approved
snapshot changes. An unresolvable reference is stale and invalidates the
result.

Both implementer and reviewer run the complete frozen set and report every
named executor, extra, and raw preflight child occurrence, with cwd and result
artifact. Preserve raw preflight limitations separately: a missing tool may
produce a limitation without a child result, but it is not a pass. Required
categories disabled by effective configuration are reported as gaps. A missing,
extra, mismatched, or unresolved named result is a misfire; a reported failure
is an honest failure, not a misfire. `skip`, `acknowledged`, `limitation`, and
inconclusive results remain non-passes and cannot be silently accepted. When a
repository has `docs/okf/`, include its bundle check in every set regardless of
which files changed. This is a documented convention, not an OW execution
engine or runtime schema validator.

# Persisted probe plans

A persisted probe plan is an optional, runner-supported executable artifact. Its reference carries a path plus immutable revision or hash and mutant locator/index. Assignments and summaries may point to it and a result artifact instead of resending a definition; legacy inline reports remain valid.

A plan alone is never evidence. A result binds plan identity to checked state, cwd, attempt, expectation, applied mutant, and restoration. Missing, stale, or unresolvable references block proof and cannot count as skipped. Never silently rewrite an existing plan for new code to turn red green; record intentional supersession and rationale when a source move requires replacement.
