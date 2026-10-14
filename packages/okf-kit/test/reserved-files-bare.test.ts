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

  it("under v0.2, accepts a bundle-root index.md whose one key is okf_version", () => {
    // The fixture detects itself as v0.2 through the very block under test.
    const ctx = loadFixture("spec-v02");
    expect(ctx.specVersion).toBe("v0.2");
    expect(reservedFilesBareRule.run(ctx)).toEqual([]);
  });

  it("under v0.2, still flags a key next to okf_version and blocks on log.md and a non-root index.md", () => {
    const findings = reservedFilesBareRule.run(
      loadFixture("spec-v02-violations"),
    );
    expect(findings).toHaveLength(3);
    const byFile = Object.fromEntries(findings.map((f) => [f.file, f.message]));
    expect(Object.keys(byFile).sort()).toEqual([
      "index.md",
      "log.md",
      "sub/index.md",
    ]);
    // The root index violated the v0.2-only exception; the other two are
    // reserved files that may never carry a block at all.
    expect(byFile["index.md"]).toContain("exactly one key, `okf_version`");
    expect(byFile["log.md"]).toContain("must not carry a frontmatter block");
    expect(byFile["sub/index.md"]).toContain(
      "must not carry a frontmatter block",
    );
  });

  it("under v0.1, any frontmatter on any reserved file stays a finding, version block included", () => {
    const ctx = loadFixture("spec-v02");
    ctx.specVersion = "v0.1"; // --spec v0.1 override of a detected-v0.2 bundle
    const findings = reservedFilesBareRule.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "error",
      file: "index.md",
    });
    expect(findings[0].message).toContain("must not carry a frontmatter block");
  });
});
