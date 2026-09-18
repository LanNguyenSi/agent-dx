## Subagent misfire rule

For normal review, waiver authority, decisions, and acceptance, read the
[detailed workflow and probe evidence](evidence-and-probes.md) first.

A subagent return is a misfire, not evidence, when its output does not parse
against its role's output contract, including an implementer return that
omits the `mutation_probes` field even though the task assignment named
mutation probes to run, or that omits the `commits` field even though the
task assignment asked for a commit. When a subagent returns near-instantly
with no tool activity, treat that as a misfire signal rather than proof:
check the output against the contract with extra suspicion, and accept it
only if it is contract-valid and the assignment was answerable from the
context supplied with it. Treat a misfire as a failed spawn: resume or
respawn the subagent,
and never fold the non-contract output into run state or count it as a
completed step. For the near-instant, no-tool-activity signal specifically,
prefer resume over a fresh respawn: send the same subagent a message that
explicitly repeats the original assignment rather than a generic retry,
since resume keeps the subagent's prior turn in context while a fresh spawn
starts cold and risks the same misfire again. Every incident of this exact
signal (a return within seconds, zero tool calls, harness or system
boilerplate instead of the output contract) whose outcome was recorded has
resolved on the first resume attempt; fall back to a fresh respawn only if
the resume attempt itself misfires the same way. This resume-over-respawn
preference does not extend to a structurally different misfire class: a
mid-run watchdog stall (the subagent goes idle partway through a run rather
than returning near-instantly) did not resolve on resume; only a fresh,
explicitly constrained respawn produced a contract-valid review; treat a
watchdog stall as outside this preference. Record every misfire in
`03-decisions.md`. This matters most for review: a misfired review is not a
review and never satisfies the review gate, since review is never skipped.

## Round-2 halt rule

The signal: a review round finds a new defect of the same class a previous
round's fix already addressed, so the class has recurred once after being
fixed, and the next fix would again be case-by-case enumeration (boundary
tokens, spellings, and similar one-off patches). Apply this signal only to `introduced_by_delta: yes`/`unknown`; `no` continues through the ordinary finding gate. Stop the first time this
signal fires: the recurrence is already the class's second occurrence, so
do not wait for a third one before stopping. Name the structural cause in
one sentence, and decide to split or redesign rather than keep accreting
cases. Ship the healthy half on its own verification, and refile the
removed half as its own task carrying the measurement history that led to
the split. Acceptance criteria that cannot be satisfied this way go to the
operator as a merge-hold (hold the change unmerged and hand the decision to
the operator).

## Review-round escalation budget

The Round-2 halt rule above stops the first time a defect class recurs
within one task. This rule puts a budget on the whole task, across halts
and across repeated review rounds, so effort does not keep accumulating
unaided: by the second round-2 halt signal on the same task, or by the
third `fix_required` review round on the same task, whichever comes
first, choose one of three escalations instead of running another round
the same way. A negative round has an `acceptance_recommendation` of
`fix_required` or `reject`; a misfired review is not a round (see Subagent
misfire rule). A negative round counts only with at least one introduced_by_delta yes/unknown finding; no stays ordinary gate. The escalation is chosen in addition to the halt rule's
split-or-redesign response, not instead of it.

- **Tier or model escalation**: raise the implementer to at least
  `-xhigh` where that variant is installed, or to the strongest model
  available in this environment. When it already runs at both, this
  option is exhausted; under a `full` profile the choice falls to the
  advisor spawn or the merge-hold, under a `minimal` profile (no advisor
  subagent to spawn) it falls straight to the merge-hold.
- **Advisor spawn** (where the advisor is installed, `full` profile):
  send the advisor subagent the question "redesign, split, or hold?" and
  weigh its recommendation before deciding.
- **Merge-hold**: hold the change unmerged and hand the decision to the
  operator.

Judgment governs which of the three to pick; only that one is chosen and
recorded is mandatory. Add a row (task, choice, reason) to
`03-decisions.md`'s Review-round escalation table, the record of the
decision, and set the `review-round-escalation` marker to the most recent
choice (a reader shortcut derived from that table, one of `n/a |
tier_escalation | advisor | merge_hold`). Escalating does not replace a
review round: whichever option is chosen, the next attempt still goes
through the reviewer subagent in full; this budget forces a change in
approach, not a shortcut past the review gate. Anchored by a measurement;
see the entry for this rule in the orchestrator-workflow CHANGELOG.

## Fix-regression decision point

The signal: the review of a fix round (any implementation round after the
task's first) reports at least one `high` or `critical` finding that the
previous round's review did not report, with `introduced_by_delta: yes`, so
the fix itself broke something. Read the qualifier off the findings of the
two reviews, not off `recurrence`: a `recurrence: repeated` finding that
the previous round's review did not report still triggers it. `unknown` and
`no` do not trigger this decision point: `no` continues through the
ordinary finding gate, and `unknown` keeps its existing treatment under the
Round-2 halt rule and the escalation budget. The signal needs no
recurrence: it fires even when the new finding's defect class has not
appeared on this task before, which is what separates it from the Round-2
halt rule above.

Before another fix round starts, name in one sentence why the fix could
introduce the defect (the structural cause, or the statement that there is
none), and record one of four outcomes as a decision in `03-decisions.md`:
continue with the stated reason, redesign, split, or hold (a merge-hold to
the operator). Spawning the advisor for this decision is optional.

This is a decision point, not a halt: continuing is a valid outcome, it is
not a round-2 halt signal, and it does not count toward the Review-round
escalation budget (the negative round itself still counts there as
before). It never replaces a review round. When the same review also fires
the Round-2 halt signal, the halt rule governs and this record is folded
into its split-or-redesign decision. Anchored by an observed run; see the
entry for this rule in the orchestrator-workflow CHANGELOG.

## Pinned-prose changes

This applies to a change whose acceptance rests on tests that pin
documentation wording (a rule text asserted by string match). A prose
mutant survives exactly when its bytes sit in no assertion, so a surviving
mutant alone says nothing about quality, and review rounds that hunt for
the next unpinned sentence do not converge. For such a change:

- Name one normative site per rule when slicing; every other site that
  states the rule is a copy.
- List the load-bearing claims of the normative site in the acceptance
  criterion, and pin each one as the whole sentence or clause that carries
  it. That list is the pin obligation. Every normative sentence the change
  adds or alters at that site is a claim; one left off the list is named
  in the criterion with the reason it is not load-bearing.
- Bound the reviewer's prose mutant space to that list in the briefing. A
  survivor outside the list is a scope note in the reviewer's
  `residual_risks`, not a finding, unless the reviewer shows that the
  unlisted sentence is load-bearing.
- Bind each copy to the normative site through one shared test constant,
  and let a pointer point without restating the rule.
- Cap test-adequacy review rounds on the change at two. A test-adequacy
  review round is one whose only unresolved findings are `tests` findings
  about pin gaps on the pinned prose; a round with any other unresolved
  finding is an ordinary round outside the cap. Pin gaps that remain
  become accepted notes or a follow-up.

Semantic findings are exempt from the bound and from the cap: two sites
stating different rules, a contradiction with another rule, and a false
claim are defects at whatever severity they deserve. The cap changes
neither the Round-2 halt rule, the Review-round escalation budget nor the
Fix-regression decision point: a capped round still counts as a negative
round where it is one. The review gate is unchanged: a high or critical
finding of any category still blocks and is never capped away, and
accepting one follows the waiver rules. Anchored by an observed run; see
the entry for this rule in the orchestrator-workflow CHANGELOG.

## Final acceptance rule

Subagents provide evidence. The orchestrator decides. The operator receives
the final handoff.

# Recovery cursor

Persist a recovery cursor in the existing run state (normally the task row or a `03-decisions.md` entry): failed step, evidence owner, next action, prerequisite, and resume point. On invalid/missing agent return, inconclusive/not-run probe, interrupted/blocked/partial run, or repeated finding, restore the applicable state before rerunning; verify revision and stale evidence. A cursor is not a new mandatory file and partial work is not proof.

Recovery retains existing authority and halt qualifiers: a critical waiver remains operator-only; a high waiver requires orchestrator rationale; the round-2 signal remains limited to a fixed defect class, introduced-by-delta yes/unknown, and case-enumeration recurrence. Do not require probes for all findings.

Only the operator may authorize a critical waiver.
Do not broaden this into a halt on any repeated finding.
