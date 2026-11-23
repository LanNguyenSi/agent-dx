import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  lintSpecDir,
  resolveProfile,
  type Profile,
} from "../../src/lint/index.js";
import { edited, specDir } from "./helpers.js";

function readTriage(dir: string): string {
  return fs.readFileSync(path.join(dir, "triage.json"), "utf8");
}

const TRIAGE = (cls: string | null, overrides: Record<string, string> = {}) => {
  const field = (value: string) => ({ value, evidence: "a note" });
  const doc: Record<string, unknown> = {
    single_goal: field(overrides["single_goal"] ?? "yes"),
    code_related: field(overrides["code_related"] ?? "yes"),
    core_is_decision: field(overrides["core_is_decision"] ?? "no"),
    scope_within_request: field(overrides["scope_within_request"] ?? "yes"),
    multiple_repos: field(overrides["multiple_repos"] ?? "no"),
    trivial: field(overrides["trivial"] ?? "no"),
    blocking_unknowns: [],
  };
  if (cls !== null) {
    doc["class"] = cls;
    doc["rule_version"] = 1;
  }
  return JSON.stringify(doc);
};

function run(files: Record<string, string | null>, profile?: Profile) {
  const result = lintSpecDir(specDir(files), profile ? { profile } : {});
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

const rules = (report: ReturnType<typeof run>) => [
  ...report.errors.map((f) => f.rule),
  ...report.warnings.map((f) => f.rule),
];

describe("profile selection, which input wins", () => {
  it("triage only: the triage profile, source triage, no finding", () => {
    const full = run({ "triage.json": TRIAGE("actionable") });
    expect([full.profile, full.profile_source, rules(full)]).toEqual([
      "full",
      "triage",
      [],
    ]);
    const light = run({ "triage.json": TRIAGE("no-spec-needed") });
    expect([light.profile, light.profile_source, rules(light)]).toEqual([
      "light",
      "triage",
      [],
    ]);
  });

  it("triage with no stored class derives the class in memory", () => {
    const light = run({ "triage.json": TRIAGE(null, { trivial: "yes" }) });
    expect([light.profile, light.profile_source]).toEqual(["light", "triage"]);
    const full = run({ "triage.json": TRIAGE(null) });
    expect([full.profile, full.profile_source]).toEqual(["full", "triage"]);
  });

  it("never writes triage.json", () => {
    const dir = specDir({ "triage.json": TRIAGE(null, { trivial: "yes" }) });
    const before = readTriage(dir);
    lintSpecDir(dir);
    expect(readTriage(dir)).toBe(before);
  });

  it("flag only: the flag, source flag, no finding", () => {
    for (const flag of ["light", "full"] as const) {
      const report = run({ "triage.json": null }, flag);
      expect([report.profile, report.profile_source, rules(report)]).toEqual([
        flag,
        "flag",
        [],
      ]);
    }
  });

  it("both equal: source triage, no finding", () => {
    const report = run({ "triage.json": TRIAGE("no-spec-needed") }, "light");
    expect([report.profile, report.profile_source, rules(report)]).toEqual([
      "light",
      "triage",
      [],
    ]);
  });

  it("both different: triage wins and profile-mismatch is an error", () => {
    const report = run({ "triage.json": TRIAGE("actionable") }, "light");
    expect([report.profile, report.profile_source]).toEqual(["full", "triage"]);
    expect(report.errors).toEqual([
      expect.objectContaining({
        rule: "profile-mismatch",
        file: "triage.json",
        path: "class",
      }),
    ]);
    expect(report.ok).toBe(false);
    const other = run({ "triage.json": TRIAGE("no-spec-needed") }, "full");
    expect([other.profile, other.profile_source, rules(other)]).toEqual([
      "light",
      "triage",
      ["profile-mismatch"],
    ]);
  });

  it("neither: full, source default, and the profile-default warning for triage", () => {
    const report = run({ "triage.json": null });
    expect([report.profile, report.profile_source]).toEqual([
      "full",
      "default",
    ]);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        rule: "profile-default",
        id: "triage",
        file: "triage.json",
      }),
    ]);
    expect(report.ok).toBe(true);
  });

  it("a class with no profile: profile-no-spec, the run falls back to the flag or full, no default warning", () => {
    for (const cls of ["unsuitable", "decision", "split", "clarify"]) {
      const report = run({ "triage.json": TRIAGE(cls) });
      expect(
        [report.profile, report.profile_source, rules(report)],
        cls,
      ).toEqual(["full", "default", ["profile-no-spec"]]);
      expect(report.ok).toBe(false);
    }
    const flagged = run({ "triage.json": TRIAGE("split") }, "light");
    expect([flagged.profile, flagged.profile_source, rules(flagged)]).toEqual([
      "light",
      "flag",
      ["profile-no-spec"],
    ]);
  });

  it("a derived class with no profile is also profile-no-spec", () => {
    const report = run({ "triage.json": TRIAGE(null, { code_related: "no" }) });
    expect(rules(report)).toEqual(["profile-no-spec"]);
  });

  it("an unparsable triage.json: a format error, the flag or full, no default warning", () => {
    const none = run({ "triage.json": "{ nope" });
    expect([none.profile, none.profile_source, rules(none)]).toEqual([
      "full",
      "default",
      ["format"],
    ]);
    const flagged = run({ "triage.json": "{ nope" }, "light");
    expect([flagged.profile, flagged.profile_source, rules(flagged)]).toEqual([
      "light",
      "flag",
      ["format"],
    ]);
  });
});

describe("the profile decides which rules run", () => {
  it("light and full both run the form rules", () => {
    const broken = {
      "spec.md": edited(
        "spec.md",
        "## Non-goals\n\n- NG-1: The token format does not change.\n\n",
        "",
      ),
    };
    for (const flag of ["light", "full"] as const) {
      const report = run({ ...broken, "triage.json": null }, flag);
      expect(rules(report)).toContain("non-goals-empty");
    }
  });
});

describe("resolveProfile", () => {
  it("is pure over the parsed triage and the flag", () => {
    expect(resolveProfile({ state: "absent" }, "light")).toEqual({
      profile: "light",
      source: "flag",
      findings: [],
    });
    expect(resolveProfile({ state: "failed" }, undefined)).toEqual({
      profile: "full",
      source: "default",
      findings: [],
    });
  });
});
