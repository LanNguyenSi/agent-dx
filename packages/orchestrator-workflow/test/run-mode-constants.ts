/**
 * Shared constants for the run mode and reviewer pins. They live outside a
 * `*.test.ts` file on purpose: importing a test file from another test file
 * would register its suites a second time.
 *
 * The run mode marker constants bind the Run mode section of
 * run-state-and-harness.md and the 00-goal.md template to one marker line.
 * The reviewer constants bind the reviewer's read-only rule at reviewer.md.
 */
export const RUN_MODES = ["single", "delegated", "batch"] as const;
export const RUN_MODE_DEFAULT =
  "A missing or unrecognised value means `delegated`.";
export const RUN_MODE_MARKER = "<!-- solution-acceptance: mode = delegated -->";

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

/**
 * Issue #339: a hand-applied mutant carries no verified restoration, so it
 * is a finding regardless of the verdict it happened to produce. Bound
 * separately from RUNNER_ONLY_PROBE_RULE (a different sentence) so an edit
 * that drops this consequence while leaving the rule itself intact is still
 * caught.
 */
export const HAND_APPLIED_MUTANT_IS_A_FINDING =
  "A hand-applied mutant is a finding against the review, whatever its outcome, because it carries no verified restoration.";

/**
 * Issue #339: the bounded in-place exception's own authorization clause
 * (only the orchestrator's briefing authorizes the runner's in-place mode,
 * and only the runner itself, never the reviewer by hand, applies the
 * mutant). Bound to the words common to the reviewer prompt's own bullet
 * and step 7's mirror of it (the two sites use slightly different phrasing
 * around "the runner"), so a weakening edit to either site is caught the
 * same way REVIEWER_DUTY already is.
 */
export const IN_PLACE_AUTHORIZATION_CLAUSE =
  "only the orchestrator's briefing authorizes it, only the runner";

/**
 * Issue #339: the bounded in-place exception's restoration and isolation
 * conditions, common wording between the reviewer prompt's own bullet and
 * step 7's mirror of it: the runner (never the reviewer) must report
 * `restored_verified: true`, the tree must be clean and at the reviewed
 * head, and no other agent may be active in it at the same time.
 */
export const IN_PLACE_RESTORED_VERIFIED_CLAUSE =
  "the runner must report `restored_verified: true` for every such probe (a missing or `false` value is a finding), the tree must be clean and at the reviewed head before the runner starts, and no other agent may be active in that tree at the same time";
