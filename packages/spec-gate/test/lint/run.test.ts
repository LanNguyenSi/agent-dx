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
import {
  SPEC_REL,
  REMOTE_MAIN,
  plainHistory,
  specFiles,
} from "./git-helpers.js";
import { scratch, specDir } from "./helpers.js";

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

describe("lintSpecDir and the spec directory path", () => {
  it("refuses a spec directory that is a symlink before any read, in every spelling", () => {
    const dir = scratch();
    const real = specDir();
    const link = path.join(dir, "spec-link");
    fs.symlinkSync(real, link);
    for (const suffix of ["", "/", "/."]) {
      expect(lintSpecDir(`${link}${suffix}`)).toEqual({
        ok: false,
        message: `${link}${suffix} is a symlink, refusing to read it`,
      });
    }
    expect(lintSpecDir(real)).toMatchObject({ ok: true });
  });

  it("keeps the not-a-directory message for a missing path and a regular file", () => {
    const dir = scratch();
    const missing = path.join(dir, "nope");
    expect(lintSpecDir(missing)).toEqual({
      ok: false,
      message: `${missing} is not a directory`,
    });
    const file = path.join(dir, "file");
    fs.writeFileSync(file, "x");
    expect(lintSpecDir(file)).toEqual({
      ok: false,
      message: `${file} is not a directory`,
    });
  });
});

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

/**
 * The rules the registry itself skips in a plain run: three gated at
 * `draft` (one of them, bindings-log, also needs a repository and runs in
 * both profiles), four reference-state rules that need a repository, and
 * stale-evidence, which needs a repository and runs in the full profile
 * only.
 */
const NEEDS_GIT = new Set([
  "base-commit-not-ancestor",
  "commands-ref-not-ancestor",
  "spec-changes-config",
  "static-command-unknown",
]);
const GATED_IN_BOTH_PROFILES = new Set(["bindings-log"]);
const REGISTRY_SKIPS = new Set([
  "binding-status",
  "residual-open",
  ...GATED_IN_BOTH_PROFILES,
  ...NEEDS_GIT,
  "stale-evidence",
]);

/** Skips of rules other than the ones the registry itself skips in a plain run. */
const otherSkips = (report: LintReport) =>
  report.skipped.filter((s) => !REGISTRY_SKIPS.has(s.rule));

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
    // only the rules that need a repository are left skipped under --final
    expect(final.skipped.map((s) => s.reason)).toEqual([
      "no-git",
      "no-git",
      "no-git",
      "no-git",
      "no-git",
      "no-git",
    ]);
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

  it("no-git: a rule that needs a repository, evaluated once one is given", async () => {
    const git = custom({ needsGit: true });
    const { repo, c1 } = await plainHistory();
    await repo.commit(
      {
        ...specFiles({ base: c1, ref: c1 }),
        [`${SPEC_REL}/acks.yaml`]: ack("custom-rule"),
      },
      "spec",
    );
    const without = lint(repo.spec, [...RULES, git]);
    expect(unused(without)).toEqual([]);
    expect(skippedReason(without, "custom-rule")).toBe("no-git");
    const withGit = lint(repo.spec, [...RULES, git], {
      git: { repo: repo.dir, defaultRef: REMOTE_MAIN },
    });
    expect(withGit.acked.map((f) => f.rule)).toEqual(["custom-rule"]);
    expect(otherSkips(withGit)).toEqual([]);
    expect(withGit.skipped.map((s) => s.reason)).toEqual([
      "gate",
      "gate",
      "gate",
    ]);
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
    expect(skippedReason(report, "triage-stale")).toBe("input-absent");
    for (const s of report.skipped.filter((x) => x.rule !== "triage-stale")) {
      expect(s.reason, s.rule).toBe(
        NEEDS_GIT.has(s.rule)
          ? "no-git"
          : GATED_IN_BOTH_PROFILES.has(s.rule)
            ? "gate"
            : "profile",
      );
    }
  });

  it("a light triage.json skips exactly the full-only rules, each for profile", () => {
    const lightTriage = JSON.stringify({
      single_goal: { value: "yes", evidence: "one goal" },
      code_related: { value: "yes", evidence: "the module" },
      core_is_decision: { value: "no", evidence: "behaviour stated" },
      scope_within_request: { value: "yes", evidence: "the request" },
      multiple_repos: { value: "no", evidence: "one repo" },
      trivial: { value: "yes", evidence: "a copy change" },
      blocking_unknowns: [],
      class: "no-spec-needed",
      rule_version: 1,
    });
    const report = lint(
      specDir({
        "triage.json": lightTriage,
      }),
      RULES,
    );
    expect(report.profile).toBe("light");
    const fullOnly = RULES.filter((r) => !r.profiles.includes("light")).map(
      (r) => r.id,
    );
    // the rules that need a repository and the gated rules of both
    // profiles are not skipped for the profile
    const profileSkips = report.skipped.filter(
      (s) => s.reason !== "no-git" && s.reason !== "gate",
    );
    expect(
      report.skipped.filter((s) => s.reason === "gate").map((s) => s.rule),
    ).toEqual([...GATED_IN_BOTH_PROFILES]);
    expect(profileSkips.every((s) => s.reason === "profile")).toBe(true);
    expect(profileSkips.map((s) => s.rule).sort()).toEqual(
      [...fullOnly].sort(),
    );
    expect(
      report.skipped.filter((s) => s.reason === "no-git").map((s) => s.rule),
    ).toEqual([
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "spec-changes-config",
      "static-command-unknown",
    ]);
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
  it("holds the two status-gated rules and the five rules that need a repository when everything else ran", () => {
    expect(lint(specDir(), RULES).skipped).toEqual([
      { rule: "base-commit-not-ancestor", reason: "no-git" },
      { rule: "binding-status", reason: "gate" },
      { rule: "bindings-log", reason: "gate" },
      { rule: "commands-ref-not-ancestor", reason: "no-git" },
      { rule: "residual-open", reason: "gate" },
      { rule: "spec-changes-config", reason: "no-git" },
      { rule: "stale-evidence", reason: "no-git" },
      { rule: "static-command-unknown", reason: "no-git" },
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
  it("options.git reaches the check of a needsGit rule as resolved full commit ids", async () => {
    const git = custom({
      id: "git-test",
      level: "error",
      ackable: false,
      needsGit: true,
      check: (ctx) => [
        {
          file: "spec.md",
          path: "$",
          message: [
            path.isAbsolute(ctx.git!.repo),
            ctx.git!.reference,
            ctx.git!.diffBase,
            ctx.git!.head,
          ].join(" "),
        },
      ],
    });
    const { repo, c1 } = await plainHistory();
    const head = await repo.commit(specFiles({ base: c1, ref: c1 }), "spec");
    const report = lint(repo.spec, [...RULES, git], {
      git: { repo: repo.dir, defaultRef: REMOTE_MAIN },
    });
    expect(
      report.errors.filter((f) => f.rule === "git-test").map((f) => f.message),
    ).toEqual([`true ${c1} ${c1} ${head}`]);
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
