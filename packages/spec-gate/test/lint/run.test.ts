import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RULES,
  lintSpecDir,
  type LintReport,
  type RuleDef,
  type RuleFinding,
} from "../../src/lint/index.js";
import { specDir } from "./helpers.js";

const NO_TRIAGE = { "triage.json": null };
const BOTH: RuleDef["profiles"] = ["light", "full"];

function lint(
  dir: string,
  rules: readonly RuleDef[],
  options: Parameters<typeof lintSpecDir>[1] = {},
): LintReport {
  const result = lintSpecDir(dir, options, rules);
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

/** A rule that always finds one thing; `ackable` rules name their target. */
function custom(over: Partial<RuleDef> = {}): RuleDef {
  const level = over.level ?? "warning";
  return {
    id: "custom-rule",
    level,
    profiles: BOTH,
    gated: false,
    ackable: level === "warning",
    summary: "a test rule",
    needs: [],
    check: () => [
      { file: "spec.md", path: "$", id: "x", message: "found something" },
    ],
    ...over,
  };
}

const ack = (rule: string) =>
  `- rule: ${JSON.stringify(rule)}\n  id: "x"\n  reason: "r"\n`;

describe("the engine stamps the registry fields last", () => {
  it("an error rule that returns level and rule keys still reports an error under its own id", () => {
    const sneaky = custom({
      id: "err-rule",
      level: "error",
      ackable: false,
      check: () =>
        [
          {
            file: "spec.md",
            path: "$",
            message: "m",
            level: "warning",
            rule: "profile-default",
          },
        ] as unknown as RuleFinding[],
    });
    const report = lint(specDir(), [...RULES, sneaky]);
    expect(report.errors.map((f) => [f.rule, f.level])).toEqual([
      ["err-rule", "error"],
    ]);
    expect(report.warnings).toEqual([]);
  });
});

describe("an ackable rule must name its target", () => {
  const noId = custom({
    id: "no-id",
    check: () => [{ file: "spec.md", path: "$", message: "m" }],
  });

  it("a finding without an id is a contract violation and throws", () => {
    expect(() => lint(specDir(), [...RULES, noId])).toThrow(
      /rule no-id is ackable and returned a finding without an id an ack can name/,
    );
  });

  it.each([
    ["empty", ""],
    ["blank", "  "],
    ["multi-line", "AC-1\nAC-2"],
  ])("a finding with an %s id is a contract violation and throws", (_n, id) => {
    const badId = custom({
      id: "bad-id",
      check: () => [{ file: "spec.md", path: "$", id, message: "m" }],
    });
    expect(() => lint(specDir(), [...RULES, badId])).toThrow(
      /rule bad-id is ackable and returned a finding without an id an ack can name/,
    );
  });

  it("a rule that is not ackable needs no id", () => {
    const quiet = custom({ ...noId, id: "no-id-quiet", ackable: false });
    expect(lint(specDir(), [...RULES, quiet]).warnings).toHaveLength(1);
  });
});

/** Skips of rules other than the ones the registry itself gates at `draft`. */
const otherSkips = (report: LintReport) =>
  report.skipped.filter(
    (s) => s.rule !== "binding-status" && s.rule !== "residual-open",
  );

describe("ack-unused only for a rule that was evaluated", () => {
  const unused = (report: LintReport) =>
    report.warnings.filter((f) => f.rule === "ack-unused");
  const skippedReason = (report: LintReport, rule: string) =>
    report.skipped.find((s) => s.rule === rule)?.reason;

  it("a rule that ran and did not fire leaves its ack unused (control)", () => {
    const quiet = custom({ check: () => [] });
    const report = lint(specDir({ "acks.yaml": ack("custom-rule") }), [
      ...RULES,
      quiet,
    ]);
    expect(unused(report)).toHaveLength(1);
    expect(otherSkips(report)).toEqual([]);
  });

  it("a rule that fired is acknowledged and nothing is unused (control)", () => {
    const report = lint(specDir({ "acks.yaml": ack("custom-rule") }), [
      ...RULES,
      custom(),
    ]);
    expect(report.acked.map((f) => f.rule)).toEqual(["custom-rule"]);
    expect(unused(report)).toEqual([]);
  });

  it("profile: a rule outside the active profile", () => {
    const fullOnly = custom({ profiles: ["full"] });
    const report = lint(
      specDir({ ...NO_TRIAGE, "acks.yaml": ack("custom-rule") }),
      [...RULES, fullOnly],
      { profile: "light" },
    );
    expect(unused(report)).toEqual([]);
    expect(skippedReason(report, "custom-rule")).toBe("profile");
  });

  it("gate: a gated rule while the spec is a draft, evaluated under --final", () => {
    const gated = custom({ gated: true });
    const dir = specDir({ "acks.yaml": ack("custom-rule") });
    const draft = lint(dir, [...RULES, gated]);
    expect(unused(draft)).toEqual([]);
    expect(skippedReason(draft, "custom-rule")).toBe("gate");
    const final = lint(dir, [...RULES, gated], { final: true });
    expect(final.acked.map((f) => f.rule)).toEqual(["custom-rule"]);
    expect(final.skipped).toEqual([]);
  });

  it("input-absent: a rule that needs an input that is not there", () => {
    const needs = custom({ needs: ["bindings"] });
    const report = lint(
      specDir({ "bindings.yaml": null, "acks.yaml": ack("custom-rule") }),
      [...RULES, needs],
    );
    expect(unused(report)).toEqual([]);
    expect(skippedReason(report, "custom-rule")).toBe("input-absent");
  });

  it("input-failed: a rule that needs or uses an input that did not parse", () => {
    for (const key of ["needs", "uses"] as const) {
      const rule = custom({ [key]: ["bindings"] });
      const report = lint(
        specDir({
          "bindings.yaml": "{ not: [valid",
          "acks.yaml": ack("custom-rule"),
        }),
        [...RULES, rule],
      );
      expect(
        report.errors.map((f) => f.rule),
        key,
      ).toContain("format");
      expect(unused(report), key).toEqual([]);
      expect(skippedReason(report, "custom-rule"), key).toBe("input-failed");
    }
  });

  it("a rule that only uses an absent input still runs, so its ack can be unused", () => {
    const uses = custom({ uses: ["bindings"], check: () => [] });
    const report = lint(
      specDir({ "bindings.yaml": null, "acks.yaml": ack("custom-rule") }),
      [...RULES, uses],
    );
    expect(unused(report)).toHaveLength(1);
    expect(otherSkips(report)).toEqual([]);
  });

  it("no-git: a rule that needs a repository, evaluated once one is given", () => {
    const git = custom({ needsGit: true });
    const dir = specDir({ "acks.yaml": ack("custom-rule") });
    const without = lint(dir, [...RULES, git]);
    expect(unused(without)).toEqual([]);
    expect(skippedReason(without, "custom-rule")).toBe("no-git");
    const withGit = lint(dir, [...RULES, git], {
      git: { repo: "r", base: "b" },
    });
    expect(withGit.acked.map((f) => f.rule)).toEqual(["custom-rule"]);
    expect(otherSkips(withGit)).toEqual([]);
  });

  it("an engine rule whose input failed: profile-default with an unparsable triage.json", () => {
    const report = lint(
      specDir({
        "triage.json": "{ not json",
        "acks.yaml": `- rule: "profile-default"\n  id: "triage"\n  reason: "r"\n`,
      }),
      RULES,
    );
    expect(report.errors.map((f) => f.rule)).toContain("format");
    expect(unused(report)).toEqual([]);
    expect(skippedReason(report, "profile-default")).toBe("input-failed");
  });

  it("every triage-based engine rule is listed as skipped when triage.json failed", () => {
    const report = lint(specDir({ "triage.json": "{ not json" }), RULES);
    for (const rule of [
      "profile-default",
      "profile-mismatch",
      "profile-no-spec",
    ]) {
      expect(skippedReason(report, rule), rule).toBe("input-failed");
    }
  });

  it("profile-default acknowledged while --profile is given is unused: the rule ran", () => {
    const report = lint(
      specDir({
        ...NO_TRIAGE,
        "acks.yaml": `- rule: "profile-default"\n  id: "triage"\n  reason: "r"\n`,
      }),
      RULES,
      { profile: "light" },
    );
    expect(unused(report)).toHaveLength(1);
    expect(skippedReason(report, "profile-default")).toBeUndefined();
  });

  it("an invalid ack is still reported when its rule was skipped", () => {
    const fullOnly = custom({ profiles: ["full"] });
    const report = lint(
      specDir({
        ...NO_TRIAGE,
        "acks.yaml": ack("custom-rule") + ack("custom-rule"),
      }),
      [...RULES, fullOnly],
      { profile: "light" },
    );
    expect(report.errors.map((f) => f.rule)).toEqual(["ack-invalid"]);
  });
});

describe("the skipped list", () => {
  it("holds exactly the two status-gated rules when everything else ran", () => {
    expect(lint(specDir(), RULES).skipped).toEqual([
      { rule: "binding-status", reason: "gate" },
      { rule: "residual-open", reason: "gate" },
    ]);
  });

  it("names every skipped rule with its reason, sorted by rule id", () => {
    const rules = [
      ...RULES,
      custom({ id: "z-profile", profiles: ["full"] }),
      custom({ id: "a-gate", gated: true }),
      custom({ id: "m-git", needsGit: true }),
      custom({ id: "b-absent", needs: ["bindings"] }),
      custom({ id: "c-failed", needs: ["questions"] }),
    ];
    const report = lint(
      specDir({
        ...NO_TRIAGE,
        "bindings.yaml": null,
        "questions.json": "{ not json",
      }),
      rules,
      { profile: "light" },
    );
    const customIds = new Set(["custom-rule"]);
    for (const id of ["z-profile", "a-gate", "m-git", "b-absent", "c-failed"]) {
      customIds.add(id);
    }
    expect(report.skipped.filter((s) => customIds.has(s.rule))).toEqual([
      { rule: "a-gate", reason: "gate" },
      { rule: "b-absent", reason: "input-absent" },
      { rule: "c-failed", reason: "input-failed" },
      { rule: "m-git", reason: "no-git" },
      { rule: "z-profile", reason: "profile" },
    ]);
    // Every full-profile rule of the registry is skipped for the profile.
    const fullOnly = RULES.filter((r) => !r.profiles.includes("light")).map(
      (r) => r.id,
    );
    for (const id of fullOnly) {
      expect(report.skipped).toContainEqual({ rule: id, reason: "profile" });
    }
  });

  it("the first reason wins: profile before gate before git before inputs; a failed input before an absent one", () => {
    const all = {
      gated: true,
      needsGit: true,
      needs: ["bindings", "questions"] as RuleDef["needs"],
    };
    const dir = specDir({
      ...NO_TRIAGE,
      "bindings.yaml": null,
      "questions.json": "{ not json",
    });
    const reason = (over: Partial<RuleDef>, profile: "light" | "full") =>
      lint(dir, [...RULES, custom({ ...all, ...over })], {
        profile,
      }).skipped.find((s) => s.rule === "custom-rule")?.reason;
    expect(reason({ profiles: ["full"] }, "light")).toBe("profile");
    expect(reason({}, "full")).toBe("gate");
    expect(reason({ gated: false }, "full")).toBe("no-git");
    expect(reason({ gated: false, needsGit: false }, "full")).toBe(
      "input-failed",
    );
  });
});

describe("the engine hands the repository to a rule that needs it", () => {
  it("options.git reaches the check of a needsGit rule", () => {
    const git = custom({
      id: "git-test",
      level: "error",
      ackable: false,
      needsGit: true,
      check: (ctx) => [
        {
          file: "spec.md",
          path: "$",
          message: `${ctx.git!.repo}@${ctx.git!.base}`,
        },
      ],
    });
    const report = lint(specDir(), [...RULES, git], {
      git: { repo: "r", base: "b" },
    });
    expect(report.errors.map((f) => f.message)).toEqual(["r@b"]);
  });
});

describe("an unsafe triage.json", () => {
  it("is one file error and not also the default-profile warning", () => {
    const dir = specDir(NO_TRIAGE);
    fs.symlinkSync(path.join(dir, "spec.md"), path.join(dir, "triage.json"));
    const report = lint(dir, RULES);
    expect(report.errors.map((f) => f.rule)).toEqual(["file"]);
    expect(report.warnings).toEqual([]);
  });
});
