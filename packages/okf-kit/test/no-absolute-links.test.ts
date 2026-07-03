import { describe, expect, it } from "vitest";
import { noAbsoluteLinksRule } from "../src/rules/no-absolute-links.js";
import { loadFixture } from "./helpers.js";

describe("no-absolute-links", () => {
  it("finds zero violations in valid-bundle", () => {
    const ctx = loadFixture("valid-bundle");
    expect(noAbsoluteLinksRule.run(ctx)).toEqual([]);
  });

  it("warns on a leading-slash link target even though it resolves", () => {
    const findings = noAbsoluteLinksRule.run(loadFixture("absolute-link"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "no-absolute-links",
      severity: "warning",
      file: "doc.md",
    });
  });
});
