/**
 * The form rules: what a spec must have before anything else is worth
 * reading. Pure over the parsed values; a rule that needs a file that did
 * not parse is skipped by the engine before it runs.
 */
import { valueOf } from "../inputs.js";
import type { RuleContext, RuleDef, RuleFinding } from "../types.js";

const SPEC = "spec.md";

/** Exactly one GOAL. A second one is already a format error (duplicate ID). */
export function checkGoalCount(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  if (spec.goal !== null) return [];
  return [
    {
      file: SPEC,
      path: "Goal",
      id: "GOAL",
      message: "spec.md has no GOAL line; exactly one is required",
    },
  ];
}

/**
 * Every AC is covered by a test-plan row. A row may also cover a non-goal;
 * a non-goal needs no row.
 */
export function checkAcCoverage(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const plan = valueOf(ctx.inputs.testplan);
  const covered = new Set(plan.flatMap((row) => row.covers));
  return spec.acceptance
    .filter((ac) => !covered.has(ac.id))
    .map((ac) => ({
      file: SPEC,
      path: ac.id,
      id: ac.id,
      line: ac.line,
      message: `${ac.id} is covered by no test-plan row`,
    }));
}

/** The Non-goals section lists at least one non-goal. */
export function checkNonGoals(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  if (spec.nonGoals.length > 0) return [];
  return [
    {
      file: SPEC,
      path: "Non-goals",
      message: "the Non-goals section is empty; list at least one non-goal",
    },
  ];
}

export const FORM_RULES: readonly RuleDef[] = [
  {
    id: "goal-count",
    level: "error",
    profiles: ["light", "full"],
    gated: false,
    ackable: false,
    summary: "Exactly one GOAL line (form rule 1).",
    needs: ["spec"],
    check: checkGoalCount,
  },
  {
    id: "ac-coverage",
    level: "error",
    profiles: ["light", "full"],
    gated: false,
    ackable: false,
    summary:
      "Every AC is covered by at least one test-plan row; required fields per kind are checked by the format layer (form rule 2).",
    needs: ["spec", "testplan"],
    check: checkAcCoverage,
  },
  {
    id: "non-goals-empty",
    level: "error",
    profiles: ["light", "full"],
    gated: false,
    ackable: false,
    summary:
      "The Non-goals section is not empty; a non-goal needs no test-plan row (form rule 3).",
    needs: ["spec"],
    check: checkNonGoals,
  },
];
