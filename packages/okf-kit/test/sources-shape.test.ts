import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourcesShapeRule } from "../src/rules/sources-shape.js";
import { FIXTURES_DIR, loadFixture } from "./helpers.js";

describe("sources-shape", () => {
  it("finds zero violations in valid-bundle", () => {
    const ctx = loadFixture("valid-bundle");
    expect(sourcesShapeRule.run(ctx)).toEqual([]);
  });

  it("flags sources that are not a non-empty array of strings", () => {
    const findings = sourcesShapeRule.run(loadFixture("bad-sources-shape"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-shape",
      severity: "error",
      file: "doc.md",
    });
  });

  it("skips path existence checks when --repo-root is not given", () => {
    const findings = sourcesShapeRule.run(loadFixture("missing-source-path"));
    expect(findings).toEqual([]);
  });

  it("flags a source path missing under --repo-root", () => {
    const repoRoot = path.join(FIXTURES_DIR, "missing-source-path");
    const findings = sourcesShapeRule.run(
      loadFixture("missing-source-path", repoRoot),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-shape",
      severity: "error",
      file: "doc.md",
    });
  });
});
