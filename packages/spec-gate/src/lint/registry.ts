/**
 * The rule registry: data, not control flow. A rule is added by adding an
 * entry; the report, the profile and gating logic and the rule table in
 * `docs/lint.md` all read this list.
 *
 * Rules without a `check` are raised by the engine itself: the loader
 * (`file`, `format`), the profile step and the acknowledgement step.
 */
import { markdownCell } from "../formats/markdown.js";
import { CONTENT_RULES } from "./rules/content.js";
import { FORM_RULES } from "./rules/form.js";
import { BINDINGS_LOG_RULES } from "./rules/bindings-log.js";
import { REF_RULES } from "./rules/refs.js";
import type { RuleContext, RuleDef, SkipReason, SkippedRule } from "./types.js";

export const RULE_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const BOTH: RuleDef["profiles"] = ["light", "full"];

const ENGINE_RULES: readonly RuleDef[] = [
  {
    id: "file",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary:
      "A required file is missing, or a file is a link, not a regular file, over the size limit, not UTF-8 or unreadable.",
    needs: [],
  },
  {
    id: "format",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary: "A file does not parse; carries the format error's code and path.",
    needs: [],
  },
  {
    id: "profile-no-spec",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary:
      "The triage class leads to no spec (unsuitable, decision, split, clarify).",
    needs: [],
    uses: ["triage"],
  },
  {
    id: "profile-mismatch",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary: "`--profile` disagrees with the profile the triage class gives.",
    needs: [],
    uses: ["triage"],
  },
  {
    id: "profile-default",
    level: "warning",
    profiles: BOTH,
    gated: false,
    ackable: true,
    summary:
      "No `triage.json` and no `--profile`: the full profile is used. Acknowledge with id `triage`.",
    needs: [],
    uses: ["triage"],
  },
  {
    id: "ack-invalid",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary:
      "An ack names an unknown rule, an error rule or a rule that cannot be acknowledged, or repeats an earlier ack.",
    needs: [],
  },
  {
    id: "rule-skipped",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary:
      "Under --final, an error rule was skipped with reason no-git or input-absent: one error per rule, id the skipped rule's id, code the reason; a final run that did not look is not a pass.",
    needs: [],
  },
  {
    id: "ack-unused",
    level: "warning",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary:
      "A valid ack for a rule that ran in this run matches no current warning.",
    needs: [],
  },
];

/** Every rule of the engine, in the order they are listed in the docs. */
export const RULES: readonly RuleDef[] = [
  ...ENGINE_RULES,
  ...FORM_RULES,
  ...CONTENT_RULES,
  ...REF_RULES,
  ...BINDINGS_LOG_RULES,
];

export function findRule(
  rules: readonly RuleDef[],
  id: string,
): RuleDef | undefined {
  return rules.find((rule) => rule.id === id);
}

/** Whether the status gate lets a gated rule run. */
export function gateOpen(ctx: Pick<RuleContext, "status" | "mode">): boolean {
  return ctx.status === "proposed" || ctx.mode === "final";
}

/**
 * Why `rule` is not evaluated in this run, or `null` when it is. The first
 * matching reason wins, in this order: the profile, the status gate, a
 * missing repository, then the inputs (a failed one before an absent one).
 */
export function skipReason(rule: RuleDef, ctx: RuleContext): SkipReason | null {
  if (!rule.profiles.includes(ctx.profile)) return "profile";
  if (rule.gated && !gateOpen(ctx)) return "gate";
  if (rule.needsGit === true && ctx.git === undefined) return "no-git";
  const needed = rule.needs.map((name) => ctx.inputs[name].state);
  const used = (rule.uses ?? []).map((name) => ctx.inputs[name].state);
  if ([...needed, ...used].includes("failed")) return "input-failed";
  if (needed.includes("absent")) return "input-absent";
  return null;
}

/**
 * Splits the registry for one run: the rules that were evaluated and the
 * rules that were skipped with their reason (the report sorts them). A rule
 * without a `check` is evaluated by the engine itself, so it counts as
 * evaluated unless one of the reasons above applies to it.
 */
export function planRules(
  rules: readonly RuleDef[],
  ctx: RuleContext,
): { evaluated: RuleDef[]; skipped: SkippedRule[] } {
  const evaluated: RuleDef[] = [];
  const skipped: SkippedRule[] = [];
  for (const rule of rules) {
    const reason = skipReason(rule, ctx);
    if (reason === null) evaluated.push(rule);
    else skipped.push({ rule: rule.id, reason });
  }
  return { evaluated, skipped };
}

/** The rules with a check that apply to this run, in registry order. */
export function activeRules(
  rules: readonly RuleDef[],
  ctx: RuleContext,
): RuleDef[] {
  return planRules(rules, ctx).evaluated.filter(
    (rule) => rule.check !== undefined,
  );
}

/** The rule table embedded in `docs/lint.md`. */
export function renderRuleTable(rules: readonly RuleDef[] = RULES): string {
  const rows = [
    "| Rule | Level | Profiles | Gated | Ackable | Checks |",
    "|---|---|---|---|---|---|",
  ];
  for (const rule of rules) {
    rows.push(
      `| \`${rule.id}\` | ${rule.level} | ${rule.profiles.join(", ")} | ${
        rule.gated ? "yes" : "no"
      } | ${rule.ackable ? "yes" : "no"} | ${markdownCell(rule.summary)} |`,
    );
  }
  return rows.join("\n");
}
