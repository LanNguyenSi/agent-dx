import { describe, expect, it } from "vitest";
import { reservedFilesBareRule } from "../src/rules/reserved-files-bare.js";
import { loadFixture } from "./helpers.js";

describe("reserved-files-bare", () => {
  it("finds zero violations in valid-bundle", () => {
    const ctx = loadFixture("valid-bundle");
    expect(reservedFilesBareRule.run(ctx)).toEqual([]);
  });

  it("flags a reserved file that carries a frontmatter block", () => {
    const findings = reservedFilesBareRule.run(
      loadFixture("frontmatter-on-reserved"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "reserved-files-bare",
      severity: "error",
      file: "index.md",
    });
  });
});
