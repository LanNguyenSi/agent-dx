import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import { MODE_SWITCH_RULE } from "./run-mode-constants.js";

export const SINGLE_ESCALATION_SHARED_CLAUSE =
  "In `single`, tier/model escalation requires a recorded switch to `delegated`.";
export const SINGLE_ESCALATION_NORMATIVE_RULE =
  "In `single`, tier/model escalation requires a recorded switch to `delegated`. Apply the Run mode switch procedure before assigning the next attempt to an implementer raised according to this tier/model escalation option.";

const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();
const ruleSection = (text: string) => {
  const heading = "## Review-round escalation budget\n";
  const start = text.indexOf(heading);
  expect(start, "review-round escalation budget is present").toBeGreaterThan(
    -1,
  );
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next === -1 ? undefined : next);
};
const tierOrModelOption = (text: string) => {
  const start = text.indexOf("- **Tier or model escalation**:");
  expect(start, "tier-or-model option is present").toBeGreaterThan(-1);
  const next = text.indexOf("\n- **", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
};
const occurrences = (text: string, needle: string) =>
  text.split(needle).length - 1;

describe("single-run tier/model escalation", () => {
  const recovery = readAsset("skill/references/review-and-recovery.md");
  const policy = readAsset("agents-md-section.md");
  const section = unwrap(ruleSection(recovery));
  const option = unwrap(tierOrModelOption(recovery));

  it("states the complete rule once in its normative section", () => {
    expect(option).toContain(SINGLE_ESCALATION_NORMATIVE_RULE);
    expect(option).toContain(SINGLE_ESCALATION_SHARED_CLAUSE);
    expect(occurrences(section, SINGLE_ESCALATION_SHARED_CLAUSE)).toBe(1);
  });

  it("binds only the shared clause into the policy section", () => {
    expect(occurrences(policy, SINGLE_ESCALATION_SHARED_CLAUSE)).toBe(1);
    expect(policy).not.toContain(
      "Apply the Run mode switch procedure before assigning the next attempt",
    );
    expect(unwrap(policy)).not.toContain(SINGLE_ESCALATION_NORMATIVE_RULE);
  });

  it("keeps policy lines at 80 columns unless their non-URL text fits", () => {
    for (const [index, line] of policy.split("\n").entries()) {
      const withoutUrls = line.replace(/https?:\/\/[^\s)]+/g, "");
      expect(
        withoutUrls.length,
        `policy line ${index + 1} has over-80 non-URL text`,
      ).toBeLessThanOrEqual(80);
    }
  });

  it("preserves the escalation and review controls around the new rule", () => {
    expect(section).toContain(
      "by the second round-2 halt signal on the same task, or by the third `fix_required` review round on the same task, whichever comes first",
    );
    expect(section).toContain("option is exhausted");
    expect(section).toContain(
      "under a `full` profile the choice falls to the advisor spawn or the merge-hold",
    );
    expect(section).toContain(
      "under a `minimal` profile (no advisor subagent to spawn) it falls straight to the merge-hold",
    );
    expect(section).toContain(
      "the next attempt still goes through the reviewer subagent in full",
    );
    expect(
      unwrap(
        readFileSync(
          "assets/skill/references/run-state-and-harness.md",
          "utf8",
        ),
      ),
    ).toContain(unwrap(MODE_SWITCH_RULE));
  });
});
