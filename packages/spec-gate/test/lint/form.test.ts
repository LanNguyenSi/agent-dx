import { describe, expect, it } from "vitest";
import { lintSpecDir, type LintReport } from "../../src/lint/index.js";
import { edited, specDir } from "./helpers.js";

function lint(files: Record<string, string | null>): LintReport {
  const result = lintSpecDir(specDir(files));
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

const ruleIds = (r: LintReport) => r.errors.map((f) => f.rule);

const GOAL_BLOCK =
  "## Goal\n\n- GOAL: Reject a token that was issued before a password change.\n\n";
const NG_BLOCK =
  "## Non-goals\n\n- NG-1: The token format does not change.\n\n";

describe("form rule 1: exactly one GOAL", () => {
  it("passes with one GOAL", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("a missing GOAL is an error naming the section", () => {
    const report = lint({ "spec.md": edited("spec.md", GOAL_BLOCK, "") });
    expect(report.errors).toEqual([
      expect.objectContaining({
        rule: "goal-count",
        file: "spec.md",
        path: "Goal",
        id: "GOAL",
      }),
    ]);
  });

  it("an empty Goal section is also a missing GOAL", () => {
    const text = edited(
      "spec.md",
      "- GOAL: Reject a token that was issued before a password change.\n",
      "",
    );
    expect(ruleIds(lint({ "spec.md": text }))).toEqual(["goal-count"]);
  });
});

describe("form rule 2: every AC is covered by a test-plan row", () => {
  const second = {
    "spec.md": edited(
      "spec.md",
      "\n## Non-goals",
      "- AC-2: A fresh token is accepted.\n  - source: SL-1\n  - owner: alice\n\n## Non-goals",
    ),
  };

  it("passes when the only row covers the only AC", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("reports each uncovered AC with its id, line and path", () => {
    const report = lint(second);
    expect(report.errors).toEqual([
      expect.objectContaining({
        rule: "ac-coverage",
        file: "spec.md",
        path: "AC-2",
        id: "AC-2",
        line: 18,
      }),
    ]);
  });

  it("one row may cover several ACs, and a second row for an AC is not needed", () => {
    const plan = edited(
      "testplan.yaml",
      "covers: [AC-1]",
      "covers: [AC-1, AC-2]",
    );
    expect(ruleIds(lint({ ...second, "testplan.yaml": plan }))).toEqual([]);
  });

  it("a row that covers only a non-goal does not cover an AC", () => {
    const plan = edited("testplan.yaml", "covers: [AC-1]", "covers: [NG-1]");
    expect(ruleIds(lint({ "testplan.yaml": plan }))).toEqual(["ac-coverage"]);
  });

  it("a row may cover a non-goal besides an AC", () => {
    const plan = edited(
      "testplan.yaml",
      "covers: [AC-1]",
      "covers: [AC-1, NG-1]",
    );
    expect(ruleIds(lint({ "testplan.yaml": plan }))).toEqual([]);
  });

  it("a spec with no AC needs no row", () => {
    const text = edited(
      "spec.md",
      "## Acceptance\n\n- AC-1: A token issued before a password change is rejected with HTTP 401.\n  - source: SL-1\n  - owner: alice\n\n",
      "",
    );
    const plan =
      "- id: TP-1\n  covers: [NG-1]\n  kind: manual\n  claim: a check\n  verifier: alice\n  evidence_location: review/x.md\n";
    expect(
      ruleIds(
        lint({
          "spec.md": text.replace("AC-1, NG-1", "NG-1"),
          "testplan.yaml": plan,
          "bindings.yaml": null,
        }),
      ),
    ).toEqual([]);
  });
});

describe("form rule 3: Non-goals is not empty", () => {
  it("passes with a non-goal", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("an absent Non-goals section is an error", () => {
    const text = edited("spec.md", NG_BLOCK, "").replace("AC-1, NG-1", "AC-1");
    const report = lint({ "spec.md": text });
    expect(report.errors).toEqual([
      expect.objectContaining({
        rule: "non-goals-empty",
        file: "spec.md",
        path: "Non-goals",
      }),
    ]);
  });

  it("an empty Non-goals section is an error", () => {
    const text = edited("spec.md", NG_BLOCK, "## Non-goals\n\n").replace(
      "AC-1, NG-1",
      "AC-1",
    );
    expect(ruleIds(lint({ "spec.md": text }))).toEqual(["non-goals-empty"]);
  });

  it("a non-goal needs no test-plan row", () => {
    // The valid spec's only row covers AC-1; NG-1 has none and passes.
    expect(ruleIds(lint({}))).toEqual([]);
  });
});

describe("all three rules together", () => {
  it("report every violation of a spec that has none of the three", () => {
    const text = edited("spec.md", GOAL_BLOCK, "")
      .replace(NG_BLOCK, "")
      .replace("AC-1, NG-1", "AC-1");
    const plan = edited("testplan.yaml", "covers: [AC-1]", "covers: [NG-9]");
    const report = lint({ "spec.md": text, "testplan.yaml": plan });
    expect(ruleIds(report).sort()).toEqual([
      "ac-coverage",
      "goal-count",
      "non-goals-empty",
      "tp-covers-unknown",
    ]);
  });
});
