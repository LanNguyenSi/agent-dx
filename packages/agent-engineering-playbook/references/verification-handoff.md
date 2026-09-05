# Verification Handoff Contract

This reference separates evidence production from readiness decisions. It is a
design for callers, runners, and reviewers; it does not require a new workflow
stage or change an installed gate.

## Responsibilities

| Concern | Caller / transport | Check producer | Readiness authority | Reviewer / claimant |
| --- | --- | --- | --- | --- |
| Start, poll, and exit | Starts work, retains the complete handle, polls until terminal, and reports the terminal state. | Reports its documented terminal semantics. | Does not infer execution from transport. | Does not call unobserved work evidence. |
| Execute and parse checks | Selects an approved producer and gives it the effective context. | Runs checks and returns structured outcomes, logs, and parsing errors. | Folds only complete, understood outcomes under its policy. | Distinguishes observations, hypotheses, and claims. |
| Readiness | Presents evidence; it does not self-authorize. | Supplies results, including waived or skipped checks and their reasons. | Makes the final ready/block decision and signs it where its policy requires. | Reviews the evidence and any empirical claim independently. |

Transport completion is not check success: awaiting a shell call only means the
caller received its result. Success requires the producer's documented terminal
condition, including its exit-code meaning. For example, a producer may use a
nonzero exit for findings; that is a completed, failed assessment rather than a
transport error. Silence on stdout never establishes success.

The caller retains the whole returned handle, not just a display token. A
`running` response must contain a handle and be polled until a terminal
response; a synchronous terminal response is valid without one. A timeout,
lost handle, malformed or missing output, and an unknown/error terminal state
block dependent action. Terminal success and terminal nonzero failure are
distinct. The handoff must show required coverage and every per-check pass,
failure, skip, or waiver, including an acknowledged reason for any waived or
skipped requirement.

## Evidence lifecycle

1. Start a producer with an identified repository, working directory, command,
   configuration, required coverage, and a bounded attempt identifier.
2. Preserve the invocation handle and its terminal response, including output
   location, parser warnings, limitations, and raw-detail/log paths.
3. Normalize the producer's own semantics into `pass`, `fail`, `skipped`, or
   `error`; retain the original exit code and timeout state. Do not collapse a
   nonzero finding into an infrastructure error, or an error into a pass.
4. Give the readiness authority the normalized result. It may sign a verdict
   only from the evidence its policy recognizes. Informational diagnostics do
   not gain authority merely by being displayed beside a verdict.
5. State conclusions at the supported level: a failed attempt is evidence of
   failure or incompleteness, not proof of a root cause or flakiness.

## Future reuse design (not a cache proposal)

Reusing a prior result would require a separately designed, trusted record. A
match must cover all of the following:

- producer identity and provenance, including the trusted producer/version;
- full effective command, configuration, and required check coverage;
- repository identity and the code snapshot, including index, dirty state, and
  relevant untracked inputs. A commit identifier alone is insufficient;
- relevant tool, runtime, and environment fingerprints, without recording
  secrets;
- complete terminal result, per-check status, waivers/skips, warnings, and
  retained diagnostic locations; and
- stability checks before and after consumption, so a changing checkout cannot
  create a time-of-check/time-of-use (TOCTOU) gap.

Any unknown field, mismatch, incomplete result, or failed stability check means
run again. Retries append an attempt history; they do not overwrite earlier
attempts. An independent reviewer reproducing a probabilistic or empirical
claim always runs independently and is never deduplicated. These requirements
govern authorization to reuse prior work. Returning fresh diagnostics from the
same current run is different: it has no reuse decision and needs none of this
cache identity.

## Proportional grounding practice

These are proposed practices, not changes to mandatory instructions or security
gates.

| Situation | Proportionate response | Claim boundary |
| --- | --- | --- |
| A known stale anchor with a deterministic correction | Correct it and run the relevant deterministic check. | Report the observed correction and result. |
| One unexplained timeout | Retain the failed attempt and label its cause unknown; one diagnostic rerun may gather information. | A single rerun does not prove flakiness. |
| Recurrence, competing hypotheses, or security diagnostics | Record hypotheses, observations, and discriminating checks in a structured investigation. | Keep alternatives open until evidence rejects them. |

Security controls remain in force throughout; investigation does not waive a
security gate.

For example, if a test passes alone but stalls in the full suite, retain the
attempt and investigate competing hypotheses: order-dependent shared state,
stale build or configuration inputs, and a resource or process leak. Compare
the effective context, rebuild when that comparison warrants it, then use
order/isolation checks and resource/process observations that discriminate among
the hypotheses. This is an illustrative investigation, not an assumed cause.

## Acceptance matrix for a future implementation

| Case | Required behavior | First slice? |
| --- | --- | --- |
| Producer runs longer than 30 seconds | Keep and poll the handle until a documented terminal state; never infer success from elapsed time. | Future caller/transport work |
| Start returns `running` without a handle | Treat as unknown/error and block dependent action; a synchronous terminal response is valid without a handle. | Future caller/transport work |
| Producer exits nonzero before a dependent action | Preserve output and normalize it as the producer specifies; block the dependent action when it is a failed or unknown result. | First slice only for existing preflight output |
| JSON is malformed or missing | Expose an explicit unavailable/parse diagnostic; do not fabricate a successful result. | First slice |
| Reuse candidate fully matches | Reuse only after provenance, context, completeness, and before/after stability checks all match. | Future reuse work |
| Reuse candidate is stale or in the wrong context | Rerun and append the new attempt. | Future reuse work |
| Timeout followed by retry | Preserve both attempts and their terminal states; do not overwrite history or call the retry proof of flakiness. | Future caller/reuse work |

The immediate slice is intentionally smaller: it passes through diagnostics
from an already-run producer alongside an unchanged readiness verdict. It does
not add a runner, wrapper, cache, transport protocol, external result ingestion,
cross-run reuse, or automatic waiver policy.
