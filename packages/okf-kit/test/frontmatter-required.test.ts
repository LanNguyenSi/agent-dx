import { describe, expect, it } from "vitest";
import { frontmatterRequiredRule } from "../src/rules/frontmatter-required.js";
import { loadFixture } from "./helpers.js";

describe("frontmatter-required", () => {
  it("finds zero violations in valid-bundle", () => {
    const ctx = loadFixture("valid-bundle");
    expect(frontmatterRequiredRule.run(ctx)).toEqual([]);
  });

  it("flags a missing frontmatter block", () => {
    const findings = frontmatterRequiredRule.run(
      loadFixture("missing-frontmatter"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "frontmatter-required",
      severity: "error",
      file: "doc.md",
    });
  });

  it("flags unparseable YAML in the frontmatter block", () => {
    const findings = frontmatterRequiredRule.run(loadFixture("malformed-yaml"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "frontmatter-required",
      severity: "error",
      file: "doc.md",
    });
  });

  it("flags an empty `type` value", () => {
    const findings = frontmatterRequiredRule.run(loadFixture("empty-type"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "frontmatter-required",
      severity: "error",
      file: "doc.md",
    });
  });
});
