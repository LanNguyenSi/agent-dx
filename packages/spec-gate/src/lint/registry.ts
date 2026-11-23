/**
 * The rule registry: data, not control flow. A rule is added by adding an
 * entry; the report, the profile and gating logic and the rule table in
 * `docs/lint.md` all read this list.
 *
 * Rules without a `check` are raised by the engine itself: the loader
 * (`file`, `format`), the profile step and the acknowledgement step.
 */
import { markdownCell } from "../formats/markdown.js";
import { FORM_RULES } from "./rules/form.js";
import type { RuleContext, RuleDef } from "./types.js";

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
  },
  {
    id: "profile-mismatch",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary: "`--profile` disagrees with the profile the triage class gives.",
    needs: [],
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
    id: "ack-unused",
    level: "warning",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary: "A valid ack matches no current warning.",
    needs: [],
  },
];

/** Every rule of the engine, in the order they are listed in the docs. */
export const RULES: readonly RuleDef[] = [...ENGINE_RULES, ...FORM_RULES];

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

/** The rules with a check that apply to this run, in registry order. */
export function activeRules(
  rules: readonly RuleDef[],
  ctx: RuleContext,
): RuleDef[] {
  return rules.filter((rule) => {
    if (rule.check === undefined) return false;
    if (!rule.profiles.includes(ctx.profile)) return false;
    if (rule.gated && !gateOpen(ctx)) return false;
    if (rule.needsGit === true && ctx.git === undefined) return false;
    for (const name of rule.needs) {
      if (ctx.inputs[name].state !== "ok") return false;
    }
    for (const name of rule.uses ?? []) {
      if (ctx.inputs[name].state === "failed") return false;
    }
    return true;
  });
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
