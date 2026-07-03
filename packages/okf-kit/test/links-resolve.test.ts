import { describe, expect, it } from "vitest";
import { linksResolveRule } from "../src/rules/links-resolve.js";
import { loadFixture } from "./helpers.js";

describe("links-resolve", () => {
  it("finds zero violations in valid-bundle, including the cross-directory relative link", () => {
    const ctx = loadFixture("valid-bundle");
    expect(linksResolveRule.run(ctx)).toEqual([]);
  });

  it("flags a link target that does not resolve", () => {
    const findings = linksResolveRule.run(loadFixture("broken-link"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "links-resolve",
      severity: "error",
      file: "doc.md",
    });
  });

  it("resolves a leading-slash target against the bundle root", () => {
    // other.md exists at the bundle root, so /other.md resolves even though
    // it starts with a slash. no-absolute-links.test.ts covers the warning.
    const findings = linksResolveRule.run(loadFixture("absolute-link"));
    expect(findings).toEqual([]);
  });
});
