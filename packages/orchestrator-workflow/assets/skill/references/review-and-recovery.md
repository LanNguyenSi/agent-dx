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

## Final acceptance rule

Subagents provide evidence. The orchestrator decides. The operator receives
the final handoff.

# Recovery cursor

Persist a recovery cursor in the existing run state (normally the task row or a `03-decisions.md` entry): failed step, evidence owner, next action, prerequisite, and resume point. On invalid/missing agent return, inconclusive/not-run probe, interrupted/blocked/partial run, or repeated finding, restore the applicable state before rerunning; verify revision and stale evidence. A cursor is not a new mandatory file and partial work is not proof.

Recovery retains existing authority and halt qualifiers: a critical waiver remains operator-only; a high waiver requires orchestrator rationale; the round-2 signal remains limited to a fixed defect class, introduced-by-delta yes/unknown, and case-enumeration recurrence. Do not require probes for all findings.

Only the operator may authorize a critical waiver.
Do not broaden this into a halt on any repeated finding.
