/**
 * Shared constants for the run mode pins. They live outside a `*.test.ts`
 * file on purpose: importing a test file from another test file would
 * register its suites a second time.
 *
 * The Run mode section of run-state-and-harness.md is the only normative
 * statement of the run modes. Every other site points to it and must not
 * restate a definition. The constants below are the section's own words;
 * later slices (fence, README, reviewer prompt) bind to these constants
 * instead of defining the mode names a second time.
 */
export const RUN_MODES = ["single", "delegated", "batch"] as const;
export const RUN_MODE_DEFAULT =
  "A missing or unrecognised value means `delegated`.";
export const RUN_MODE_MARKER = "<!-- solution-acceptance: mode = delegated -->";
export const DEFINITION_SINGLE =
  "`single`: one coherent workstream that the orchestrator implements itself, with its own verification set and mutation probes.";
export const DEFINITION_DELEGATED =
  "`delegated`: the orchestrator plans and slices, then assigns one implementer per slice, sequentially.";
export const DEFINITION_BATCH =
  "`batch`: a task slicer plus parallel implementers, each in its own worktree; the orchestrator checks the integration of their results.";
export const SINGLE_MANDATORY_FILES =
  "`single` requires `00-goal.md`, `03-decisions.md`, `04-implementation-summary.md`, `05-review-findings.md`, and `06-handoff.md`; `01-plan.md` and `02-tasks.md` are optional.";
export const ALL_FILES_MODES =
  "`delegated` and `batch` require all seven run files; `batch` additionally fills the Integration section of `04-implementation-summary.md`.";
export const MODE_SWITCH_RULE =
  "A mode switch is a recorded decision: add a D-ID row to `03-decisions.md` and update the marker; never start a new run for it.";
export const REVIEWER_IN_ALL_MODES =
  "The reviewer is mandatory in all three modes";

/**
 * The single-mode replay duty is stated once, in step 7 of
 * evidence-and-probes.md. The reviewer prompt has to carry the duty in its
 * own words because a reviewer runs without the skill loaded; this constant
 * binds the prompt and the contracts pointer to the rule's own wording.
 */
export const SINGLE_REPLAY_RULE = "replay every named orchestrator probe";

/**
 * What "named" means is defined once in step 7; the reviewer prompt repeats
 * it because a reviewer runs without the skill. Every other clause of the
 * rule speaks of named probes only, so a further naming form is added in
 * one place.
 */
export const NAMED_PROBE_FORMS =
  "its full definition or a resolved immutable plan-and-result reference";

/**
 * Issue #339: the reviewer applies a mutant only
 * through the probe runner, in every run mode, and reports `not_applicable`
 * (missing evidence, not a pass) rather than hand-applying one when no
 * runner is available. This constant binds the rule's own wording so every
 * rendered reviewer variant and the run-mode `single` duty stay consistent
 * with it instead of drifting into a conditional "when one is available"
 * framing.
 */
export const RUNNER_ONLY_PROBE_RULE =
  "Apply a mutant only through the probe runner, in every run mode, and rely on its own restoration check; never apply one by hand, and never restore a hand-applied one yourself. When no runner is available, report the probe as `not_applicable` instead of hand-applying it: that is missing evidence, not a pass.";
