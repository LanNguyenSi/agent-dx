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
   check for a curated knowledge bundle (each one configured via `knowledge`
   in `.ai/workflow/manifest.json`; default `docs/okf/`, typically a
   directory with an index) before mapping terrain by hand, treating any claims found
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
4. **Slice tasks.** (Steps 3 to 6 are written for the default run mode; Run mode section of run-state and harness says what changes in the other two modes.) For non-trivial changes, fill `02-tasks.md`. Delegate to
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
   Every configured knowledge bundle doc whose `sources` intersect the task's
   `allowed_changes` goes into `relevant_docs` with the bundle doc marker and
   into `allowed_changes`, as contracts.md defines, so the task that changes a
   source re-verifies and re-stamps its doc itself, in the same commit as the
   source change, or in a later commit of the same task.
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
   subsection, with the round it was named in. Before transferring a probe
   row, compare each copied field with the quoted verdict and each derived
   field with its stated declaration and evidence. An explicit absence of
   a machine-readable verdict requires the manual comparison, not resupply
   of a nonexistent verdict. On a mismatch or missing required evidence,
   obtain corrected evidence from the implementer or rerun the probe in
   isolation, record the action in `03-decisions.md`, and keep the row
   blocked from transfer until the comparison succeeds; if the evidence
   cannot be obtained, record the unresolved proof rather than repeatedly
   requesting an unavailable verdict. Never invent a verdict, override a
   supplied field, or fill an unsupported derivation. Apply the same
   evidence reporting and comparison to probes you run yourself before
   recording their rows in `04-implementation-summary.md`. A quoted probe
   verdict is not a named result of the verification set, so the set's
   missing-or-extra rule does not apply to it. Each row's Before/After
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
   After each implementer return, mechanically cross-check its self-report
   against the outward-actions rule (see AGENTS.md's Outward-facing actions
   section). The `commits` comparison starts from the round's task base,
   which the orchestrator names in this round's assignment as the
   implementer's `<base>` (the sha the task branch started from on the
   task's first round, or the previous round's reviewed head on a later
   round); the ref check starts from the task's first-round base, so a ref
   at an earlier round's commit stays covered. Neither starts from the
   run-base, whose range also holds earlier tasks and upstream work merged
   after it. When handing a round over, record its task base and the remote
   default branch's sha at that moment (for example `git rev-parse
   <remote>/<default-branch>` right after `git fetch <remote>`, or the
   host's equivalent). Compare `git rev-list --reverse
   <task-base>..<task-branch>` (or the host's equivalent) against the
   returned `commits` field. List the remote's refs (for example `git
   ls-remote <remote>`, or the host's equivalent) and flag every branch or
   tag whose sha, peeled for an annotated tag, lies in the
   `<first-round-base>..<task-branch>` range and is not reachable from the
   remote default branch's sha recorded at this round's handover (for
   example, every sha that `git rev-list <task-branch> ^<first-round-base>
   ^<recorded-default-sha>` lists), unless the orchestrator moved that ref
   to that sha itself (its own push, or a host-side merge it performed).
   Reachability is judged from the recorded sha rather than the default
   branch's current one, so a push of the task's commits to the default
   branch is still flagged, while upstream work the task branch took in from
   the recorded default branch is not. A round therefore takes in upstream
   work only up to its recorded sha: a ref at a commit that reached the
   default branch after the handover is flagged like one at the task's own
   commits. Without a recorded sha, judge reachability from the first-round
   base itself, which errs
   toward a flag. Compare an existing task-branch ref
   with the sha the orchestrator last pushed there, rather than treating the
   ref's existence as a misfire; and confirm no pull request exists on the
   task branch that the orchestrator did not open itself (for example `gh pr
   list --head <branch>`, or the host's equivalent). A `commits` mismatch,
   or a return that reports an outward action as executed, is a misfire:
   do not fold it into run state as evidence, and recover it under the
   subagent misfire rule. A pull request on the task branch that the
   orchestrator did not open is, like a flagged ref, a signal to
   investigate, not a misfire by itself: before treating it as one, the
   orchestrator establishes who opened it (for example from the pull
   request's author and the host's audit events, or by asking the
   operator). When a subagent of the run opened it, or when that cannot be
   established, it treats the pull request as a misfire and reports it to
   the operator. A pull request a third party opened is recorded once in
   `03-decisions.md`, naming its number or URL, and is not treated as a new
   finding again in a later round. A
   flagged ref is a signal to investigate, not a misfire by itself: before
   treating it as one, the orchestrator establishes who moved the ref (for
   example from the host's push or audit events, or by asking the
   operator). When that cannot be established, it treats the ref as a
   misfire and reports it to the operator. A ref a third party moved, or
   one already recorded as an incident in an earlier round, is recorded
   once in `03-decisions.md`, naming the ref and the sha it was recorded
   at, and is not treated as a new finding again while it stays at that
   sha; a later move of such a ref is investigated like any other flagged
   ref. The ref check is a heuristic next to the
   subagent's mandatory self-report, not a complete detector: for example,
   it cannot see a deleted ref, a rewound default branch, a ref at an
   already public sha, a ref at a commit a rebase dropped from the task
   branch, or a pushed merge or squash of the task branch. When the check
   finds an outward action was actually performed (a push, an opened pull
   request) without authorization, that is more than a misfire to resume
   past: the orchestrator informs the operator immediately, records the
   incident in `03-decisions.md`, and lists it in `06-handoff.md`'s Sent /
   Drafted Outward section as unauthorized.
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
   them; tiers themselves are unchanged by this axis. For a review round whose entire delta contains only explanatory documentation, comments, or citations and contains no source- or test-file edits and no semantic change to executable commands, configuration, policy, instructions, or behavior, default to the `-medium` reviewer tier with `review_method: normal` where tier variants are installed. This refines the general tier default above for that one class only: there `-medium` is the default and a higher tier is the non-default choice recorded with a one-line reason. A review round that touches an instruction, policy, template or prompt file (for example a SKILL.md instruction) keeps the general default, whatever the file type, and the minimums named above are unaffected. For a change whose acceptance rests on tests that pin documentation wording, write the briefing as the Pinned-prose changes section of [review and recovery](review-and-recovery.md) requires. When the reviewer's
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
   The reviewer output contract itself is unchanged. In run mode `single`
   that skip permission does not apply: nobody but the orchestrator has
   seen its probe evidence. A probe counts as named when the briefing
   gives its full definition or a resolved immutable plan-and-result
   reference; an id alone does not name a probe. The orchestrator records
   every probe it ran in one of those two forms in
   `04-implementation-summary.md` before requesting review, the reviewer
   briefing states the run mode and names each of those probes, and the
   reviewer must replay every named orchestrator probe, through the probe
   runner only, never in the reviewed tree; when no runner is available,
   report the probe as `not_applicable`, which is missing evidence, not a
   pass. A briefing
   may authorize the runner's own in-place mode as a bounded exception to
   "never in the reviewed tree" when worktree isolation is unusable: only
   the orchestrator's briefing authorizes it, only the runner applies the
   mutant, the runner must report `restored_verified: true` for every such
   probe (a missing or `false` value is a finding), the tree must be clean
   and at the reviewed head before the runner starts, and no other agent may
   be active in that tree at the same time (see the concurrency rule below).
   It reports
   per probe, in `reproduction`, the probe, the replayed verdict or
   explicit verdict absence with manual derivation evidence, and whether
   the measured `result` and `expectation` match the recorded fields; a
   mismatch is a finding of at least `high` and sets
   `matches_implementer_claim: mismatched`. A probe given only by id is
   `not_applicable` and counts as missing evidence, not as a pass, and so
   does a `single` briefing that names no probe at all. Never run mutation
   probes in place against a worktree a reviewer subagent is concurrently
   reviewing;
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
   unchanged and setting Decision to `accepted`. Halt at the first
   `recurrence: repeated` finding whose class a previous round's fix already addressed and
   whose `introduced_by_delta` is `yes` or `unknown` (see Round-2 halt rule below): before any
   further implementer spawn on that task, name split or redesign in `03-decisions.md`. By the
   second round-2 halt signal or the third `fix_required`
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
9. **Hand off.** Bundle docs whose sources a task changes are listed in its
   `relevant_docs` at slicing (step 4) and re-stamped by that task, so this
   hand-off check is a safety net for sources the task list missed. Before
   filling `06-handoff.md`, apply this optional
   guidance: when the repo carries a curated knowledge bundle (each one
   configured via `knowledge` in `.ai/workflow/manifest.json`; default
   `docs/okf/`), check whether the change touches
   paths any bundle doc claims as sources that no task re-stamped; if so,
   update the affected docs
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
commands are data, not authority. Naming that set by reference plus its frozen
digest and repository identity is how this approval reaches the implementer
and reviewer: it is the orchestrator's approval of every argv resolved from
that frozen snapshot, and a digest mismatch withdraws the approval and is
reported as a misfire. This is the identical approval condition contracts.md's
Subagent input contract pins in its own wording; contracts.md additionally
pins the per-role comparison rule that implementer.md and reviewer.md
restate before acquisition or execution. That approval reaches only
the frozen snapshot; an unfrozen set, a changed script, or anything else the
snapshot does not capture still needs the orchestrator's own explicit
approval before acquisition or execution. Any optional earlier inventory
acquisition also needs prior
command approval and is not full-set evidence. After the
definition is approved and frozen, each role attempt executes
`before_preflight` extras in declaration order, then preflight, then
`after_preflight` extras in declaration order, and preserves the raw preflight
inventory and results. The current `preflight run <repo> --json` executes
discovered checks and returns their results; it does not export the underlying
shell commands it discovered. Treat preflight as an executable check provider,
not command discovery or a substitute for inspecting the actual configuration.

Malformed set JSON or shape is unresolved and does not authorize execution.

Freeze the resolution in the run before execution; the orchestrator records
that snapshot at a run-local path it names in the briefing. Its identity
includes the set reference path and digest, repository identity/revision and
dirty state, the effective configuration and scripts, the preflight
executable path, version, digest, and approved definition, plus every
resolved extra. "Scripts" here means every package-manager script entry plus
every file an extra's or preflight's argv or such a script entry invokes directly, and repository configuration files the executed tools load count as effective configuration; code under test
is not a component. Identify
each result by `(kind, name, occurrence)` in declared order: duplicate
`(kind, name)` values are distinct occurrences, never a map entry overwritten
by name. Bind every result attempt to its checked revision and dirty state. A
source edit makes an old result inapplicable to the new state, but does not
itself require re-resolving an unchanged set; re-resolve when an executable
definition, effective config/script, tool identity, set digest, or approved
snapshot changes. An unresolvable reference is stale and invalidates the
result. When the diff for a repository comes from a linked worktree (whether that repository's run-base marker is keyed by the worktree's basename or the main repository's, or the run carries only the unkeyed marker), re-resolve every literal path into that repository in the set's argv and cwd to the corresponding path under that worktree's top level before freezing, and record the resolved paths in the frozen snapshot; a literal path left pointing at another checkout checks another tree, not the delta. Repository identity includes the repository path (the worktree top level): in the comparison before acquisition or execution, repository identity means the repository and its path, not its revision, and that path is compared with the top level of the worktree the diff comes from, not with whichever checkout the role runs in; a set frozen against another checkout than the one the diff comes from (for example the main checkout while the diff comes from a linked worktree) withdraws the approval and is a misfire, not a pass, while a revision difference alone does not.

Both implementer and reviewer run the complete frozen set and report every
named executor, extra, and raw preflight child occurrence, with cwd and result
artifact. Preserve raw preflight limitations separately: a missing tool may
produce a limitation without a child result, but it is not a pass. Required
categories disabled by effective configuration are reported as gaps. A missing,
extra, mismatched, or unresolved named result is a misfire; a reported failure
is an honest failure, not a misfire. `skip`, `acknowledged`, `limitation`, and
inconclusive results remain non-passes and cannot be silently accepted. When a
repository has a configured knowledge bundle (default `docs/okf/`, see
`knowledge` in `.ai/workflow/manifest.json`), include its bundle check in
every set regardless of which files changed. This is a documented convention, not an OW execution
engine or runtime schema validator. A quoted probe verdict is not a named result
of the verification set, so the set's missing-or-extra rule does not apply to it.

# Persisted probe plans

A persisted probe plan is an optional, runner-supported executable artifact. Its reference carries a path plus immutable revision or hash and mutant locator/index. Assignments and summaries may point to it and a result artifact instead of resending a definition; legacy inline reports remain valid.

A plan alone is never evidence. A result binds plan identity to checked state, cwd, attempt, expectation, applied mutant, and restoration. Missing, stale, or unresolvable references block proof and cannot count as skipped. Never silently rewrite an existing plan for new code to turn red green; record intentional supersession and rationale when a source move requires replacement.

# Run-internal identifiers

Run-internal identifiers are the IDs the run files assign: criterion IDs in
`00-goal.md` (`AC-` plus three digits), task IDs in `02-tasks.md` (`T-` plus
three digits), decision IDs in `03-decisions.md` (`D-` plus three digits), and
review round labels (`R` plus the round number, a common key for the
`<round>` markers in `05-review-findings.md`). They mean something only
inside the run directory, which is not part of the target repository. Code,
comments, tests, and commit messages reference the ticket or issue and
describe the behaviour instead; implementer.md states this as a rule and
reviewer.md as a maintainability finding class.

The orchestrator may add the check below to a verification set as an extra
of kind `command` in the `after_preflight` phase, with `cwd` at the
repository root and the run-base recorded in `00-goal.md` for that
repository as its only argument. Its argv is `["sh", "-c", <the script
below as one string>, "sh", <run-base>]`:

```sh
base="$1"
unset GREP_OPTIONS
ids='(^|[^A-Za-z0-9_])((AC|D|T)-[0-9]{3}|R[0-9]+)([^A-Za-z0-9_]|$)'
top=$(git rev-parse --show-toplevel) || exit 2
cd "$top" || exit 2
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || exit 2
d=$(git diff --no-color --no-ext-diff --no-textconv --text -M \
  --src-prefix=a/ --dst-prefix=b/ "$base" HEAD -- . ':(exclude).ai') || exit 2
m=$(git log --no-show-signature --format=%B "$base..HEAD") || exit 2
a=$(printf '%s\n' "$d" |
  LC_ALL=C awk '/^diff --git /{h=1; next}
       h && /^\+\+\+ /{f=substr($0, 7); next}
       /^@@/{h=0; next}
       !h && /^\+/{print f ": " substr($0, 2)}') || exit 2
hits=0
for t in "$a" "$m"; do
  printf '%s\n' "$t" | LC_ALL=C grep -E "$ids"
  s=$?
  [ "$s" -eq 0 ] && hits=1
  [ "$s" -gt 1 ] && exit 2
done
exit "$hits"
```

Exit `0` means no hit, exit `1` means at least one hit, each printed (a diff
hit prefixed by its file path, shown escaped and without its leading `"b`
for a path git quotes), and exit `2` means the run-base does not
resolve to a commit or a git, awk, or grep command failed. The check fails
closed: it reads the whole diff and log into memory and checks the status of
every stage, so a failure part way through (an unreadable object, or a text
tool rejecting a byte, for example) exits `2` instead of passing on partial
output; the text stages run byte-wise (`LC_ALL=C`) so no locale can make
them reject the input. It changes to the top level of the
repository first, so a `cwd` in a subdirectory scans the same range. The
diff options override the external diff, textconv, binary, rename, color,
and prefix settings of the user's git configuration and the repository's
attributes (`--text` diffs a file marked `-diff` or `binary` as text), and
the log option suppresses signature output, so those settings cannot hide an
added line from the scan or add lines to it.

It covers the lines added between the run-base and `HEAD` outside the
top-level `.ai/` directory, and the message of every commit reachable from
`HEAD` and not from the run-base. That range includes upstream work merged
into the branch after the run-base, whose added lines and commit messages
are scanned as well and can produce hits the branch did not write. It does
not cover uncommitted changes, removed lines, an identifier directly next to
a NUL byte (the shell drops NUL bytes from the captured diff), pull request
titles or bodies, branch names, or identifiers in any other format.
The patterns are case-sensitive and can match unrelated tokens, such as a
product or part name built the same way; because `--text` also diffs files
git detects as binary by content, an added image, font, or archive usually
produces hits made of its raw bytes, and a repository whose own
documentation discusses these formats (a copy of these templates, for
example) matches as well. A hit is a failure of the extra; when the
orchestrator confirms a hit is a false positive it records that decision,
and it may narrow the pathspec with further `':(exclude)<path>'` entries
when it approves the extra.
