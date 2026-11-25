import { describe, expect, it } from "vitest";
import {
  RULES,
  RULE_ID_RE,
  activeRules,
  lintSpecDir,
  type LintInputs,
  type RuleContext,
  type RuleDef,
} from "../../src/lint/index.js";
import { edited, specDir } from "./helpers.js";

describe("rule registry", () => {
  it("has unique lower-kebab-case ids", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(RULE_ID_RE);
  });

  it("registers the engine, form, content, reference-state and bindings-log rules in the order of the docs", () => {
    expect(RULES.map((r) => r.id)).toEqual([
      "file",
      "format",
      "profile-no-spec",
      "profile-mismatch",
      "profile-default",
      "ack-invalid",
      "rule-skipped",
      "ack-unused",
      "goal-count",
      "ac-coverage",
      "non-goals-empty",
      "df-coverage",
      "tp-covers-unknown",
      "binding-unknown",
      "binding-status",
      "ledger-complete",
      "ledger-target-unknown",
      "ac-source-unknown",
      "owner-none",
      "residual-open",
      "dc-unanswered",
      "dc-self-reported",
      "retired-id-live",
      "prose",
      "question-budget",
      "triage-stale",
      "meta-frontmatter-mismatch",
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "spec-changes-config",
      "static-command-unknown",
      "bindings-log",
    ]);
  });

  it("the engine, form, reference-state and bindings-log rules run in both profiles; so does triage-stale, the rest of the content rules is full only", () => {
    const REFS = new Set([
      "bindings-log",
      "meta-frontmatter-mismatch",
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "spec-changes-config",
      "static-command-unknown",
    ]);
    for (const rule of RULES) {
      const fullOnly =
        RULES.indexOf(rule) >= 11 &&
        rule.id !== "triage-stale" &&
        !REFS.has(rule.id);
      expect(rule.profiles, rule.id).toEqual(
        fullOnly ? ["full"] : ["light", "full"],
      );
    }
    expect(RULES.filter((r) => r.gated).map((r) => r.id)).toEqual([
      "binding-status",
      "residual-open",
      "bindings-log",
    ]);
  });

  it("only warnings can be acknowledged, and ack-unused cannot", () => {
    for (const rule of RULES) {
      if (rule.ackable) expect(rule.level, rule.id).toBe("warning");
    }
    expect(RULES.find((r) => r.id === "profile-default")!.ackable).toBe(true);
    expect(RULES.find((r) => r.id === "ack-unused")!.ackable).toBe(false);
  });

  it("every rule that is raised by a check has one and the rest do not", () => {
    const withCheck = RULES.filter((r) => r.check !== undefined).map(
      (r) => r.id,
    );
    expect(withCheck).toEqual([
      "goal-count",
      "ac-coverage",
      "non-goals-empty",
      "df-coverage",
      "tp-covers-unknown",
      "binding-unknown",
      "binding-status",
      "ledger-complete",
      "ledger-target-unknown",
      "ac-source-unknown",
      "owner-none",
      "residual-open",
      "dc-unanswered",
      "dc-self-reported",
      "retired-id-live",
      "prose",
      "question-budget",
      "triage-stale",
      "meta-frontmatter-mismatch",
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "spec-changes-config",
      "static-command-unknown",
      "bindings-log",
    ]);
  });

  it("exactly the four repository rules and bindings-log need git, and every reference-state rule is an error that cannot be acknowledged", () => {
    expect(RULES.filter((r) => r.needsGit === true).map((r) => r.id)).toEqual([
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "spec-changes-config",
      "static-command-unknown",
      "bindings-log",
    ]);
    const log = RULES.find((r) => r.id === "bindings-log")!;
    expect([log.level, log.ackable, log.gated]).toEqual(["error", false, true]);
    for (const id of [
      "rule-skipped",
      "meta-frontmatter-mismatch",
      "base-commit-not-ancestor",
      "commands-ref-not-ancestor",
      "spec-changes-config",
      "static-command-unknown",
    ]) {
      const rule = RULES.find((r) => r.id === id)!;
      expect(rule.level, id).toBe("error");
      expect(rule.ackable, id).toBe(false);
      expect(rule.gated, id).toBe(false);
    }
  });
});

const absent: LintInputs = {
  spec: { state: "absent" },
  testplan: { state: "absent" },
  bindings: { state: "absent" },
  questions: { state: "absent" },
  triage: { state: "absent" },
  meta: { state: "absent" },
};

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    inputs: absent,
    status: "draft",
    profile: "full",
    mode: "lint",
    ...over,
  };
}

function rule(over: Partial<RuleDef> = {}): RuleDef {
  return {
    id: "test-rule",
    level: "error",
    profiles: ["light", "full"],
    gated: false,
    ackable: false,
    summary: "a test rule",
    needs: [],
    check: () => [{ file: "spec.md", path: "$", message: "x" }],
    ...over,
  };
}

const ids = (rules: RuleDef[], c: RuleContext) =>
  activeRules(rules, c).map((r) => r.id);

describe("activeRules", () => {
  it("an ungated rule applies whatever the status", () => {
    for (const status of ["draft", "proposed", "superseded", null] as const) {
      expect(ids([rule()], ctx({ status }))).toEqual(["test-rule"]);
    }
  });

  it("a gated rule applies only at status proposed or in a final run", () => {
    const gated = [rule({ gated: true })];
    expect(ids(gated, ctx({ status: "proposed" }))).toEqual(["test-rule"]);
    expect(ids(gated, ctx({ status: "draft" }))).toEqual([]);
    expect(ids(gated, ctx({ status: "superseded" }))).toEqual([]);
    expect(ids(gated, ctx({ status: null }))).toEqual([]);
    expect(ids(gated, ctx({ status: "draft", mode: "final" }))).toEqual([
      "test-rule",
    ]);
    expect(ids(gated, ctx({ status: null, mode: "final" }))).toEqual([
      "test-rule",
    ]);
    expect(ids(gated, ctx({ status: "proposed", mode: "final" }))).toEqual([
      "test-rule",
    ]);
  });

  it("a rule runs only in its profiles", () => {
    const fullOnly = [rule({ profiles: ["full"] })];
    expect(ids(fullOnly, ctx({ profile: "full" }))).toEqual(["test-rule"]);
    expect(ids(fullOnly, ctx({ profile: "light" }))).toEqual([]);
  });

  it("a rule without a check never runs", () => {
    expect(ids([rule({ check: undefined })], ctx())).toEqual([]);
  });

  it("a rule that needs git is skipped without a repository", () => {
    const git = [rule({ needsGit: true })];
    expect(ids(git, ctx())).toEqual([]);
    const inputs = { repo: "r", reference: "a", diffBase: "b", head: "c" };
    expect(ids(git, ctx({ git: inputs }))).toEqual(["test-rule"]);
  });

  it("a rule needs its inputs parsed; an absent or failed one skips it", () => {
    const needs = [rule({ needs: ["bindings"] })];
    const ok = { ...absent, bindings: { state: "ok" as const, value: {} } };
    expect(ids(needs, ctx({ inputs: ok }))).toEqual(["test-rule"]);
    expect(ids(needs, ctx({ inputs: absent }))).toEqual([]);
    expect(
      ids(needs, ctx({ inputs: { ...absent, bindings: { state: "failed" } } })),
    ).toEqual([]);
  });

  it("a rule that only uses an input runs when it is absent, not when it failed", () => {
    const uses = [rule({ uses: ["bindings"] })];
    expect(ids(uses, ctx({ inputs: absent }))).toEqual(["test-rule"]);
    expect(
      ids(uses, ctx({ inputs: { ...absent, bindings: { state: "failed" } } })),
    ).toEqual([]);
  });
});

describe("the engine applies the registry", () => {
  const gatedRule = rule({
    id: "gated-test",
    gated: true,
    check: () => [{ file: "spec.md", path: "$", message: "gated rule ran" }],
  });
  const all = [...RULES, gatedRule];

  function run(files: Record<string, string | null>, final: boolean) {
    const result = lintSpecDir(specDir(files), { final }, all);
    if (!result.ok) throw new Error(result.message);
    return result.report;
  }

  it("a draft spec does not get a gated rule, a proposed one and a final run do", () => {
    const draft = run({}, false);
    expect(draft.status).toBe("draft");
    expect(draft.errors).toEqual([]);

    const proposed = run(
      { "spec.md": edited("spec.md", "status: draft", "status: proposed") },
      false,
    );
    expect(proposed.errors.map((f) => f.rule)).toEqual(["gated-test"]);

    const final = run({}, true);
    expect(final.mode).toBe("final");
    expect(final.status).toBe("draft");
    // the five rules that need a repository did not run: that is a final error
    expect(final.errors.map((f) => f.rule)).toEqual([
      ...Array(5).fill("rule-skipped"),
      "gated-test",
    ]);
  });

  it("the level of a finding is the registered level, not the rule's choice", () => {
    const warn = rule({
      id: "warn-test",
      level: "warning",
      ackable: true,
      check: () => [{ file: "spec.md", path: "$", id: "x", message: "x" }],
    });
    const result = lintSpecDir(specDir(), {}, [...RULES, warn]);
    if (!result.ok) throw new Error(result.message);
    expect(result.report.warnings).toEqual([
      expect.objectContaining({ rule: "warn-test", level: "warning" }),
    ]);
    expect(result.report.errors).toEqual([]);
  });

  it("an ungated rule runs on a draft", () => {
    const result = lintSpecDir(specDir(), {}, [
      ...RULES,
      rule({ id: "plain-test" }),
    ]);
    if (!result.ok) throw new Error(result.message);
    expect(result.report.errors.map((f) => f.rule)).toEqual(["plain-test"]);
  });
});
