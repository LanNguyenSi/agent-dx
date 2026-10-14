import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { generatedShapeRule } from "../src/rules/generated-shape.js";
import type { BundleContext, SpecVersion } from "../src/types.js";
import { writeDoc } from "./git-helpers.js";
import { loadFixture } from "./helpers.js";

function runFixture(
  name: string,
  spec?: SpecVersion,
): ReturnType<typeof generatedShapeRule.run> {
  const ctx = loadFixture(name);
  if (spec !== undefined) ctx.specVersion = spec;
  return generatedShapeRule.run(ctx);
}

describe("generated-shape", () => {
  it("reports the malformed generated.by, the designator-less generated.at and the divergent stamp pair, once each, and nothing for the clean doc", () => {
    const findings = runFixture("spec-v02-generated");
    expect(findings).toHaveLength(3);
    const byFile = new Map(findings.map((f) => [f.file, f]));
    expect([...byFile.keys()].sort()).toEqual([
      "doc-both.md",
      "doc-by.md",
      "doc-offset.md",
    ]);
    expect(byFile.get("doc-clean.md")).toBeUndefined();

    expect(byFile.get("doc-by.md")).toMatchObject({
      ruleId: "generated-shape",
      severity: "warning",
    });
    expect(byFile.get("doc-by.md")?.message).toContain("generated.by `bot`");

    expect(byFile.get("doc-offset.md")).toMatchObject({
      ruleId: "generated-shape",
      severity: "error",
    });
    expect(byFile.get("doc-offset.md")?.message).toContain(
      "generated.at `2026-01-05T00:00:00`",
    );

    expect(byFile.get("doc-both.md")).toMatchObject({
      ruleId: "generated-shape",
      severity: "warning",
    });
    expect(byFile.get("doc-both.md")?.message).toContain(
      "`2026-01-05T00:00:00Z` and timestamp `2026-01-02T00:00:00Z`",
    );
  });

  it("the v0.2 offset requirement does not fire on a v0.1 bundle", () => {
    const findings = runFixture("spec-v02-generated", "v0.1");
    expect(findings.map((f) => f.file).sort()).toEqual([
      "doc-both.md",
      "doc-by.md",
    ]);
  });

  describe("generated.by shapes", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-genshape-"));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function runWithBy(by: unknown, spec: SpecVersion = "v0.2"): number {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-genshape-"));
      fs.writeFileSync(path.join(dir, "index.md"), "# Index\n");
      writeDoc(dir, "doc.md", {
        type: "concept",
        generated: { by, at: "2026-01-05T00:00:00Z" },
      });
      const ctx: BundleContext = loadBundle(dir);
      ctx.specVersion = spec;
      return generatedShapeRule.run(ctx).length;
    }

    it("accepts the three spec shapes", () => {
      expect(runWithBy("okf-kit/0.19.0")).toBe(0);
      expect(runWithBy("human:alice")).toBe(0);
      expect(runWithBy("process:daily-digest")).toBe(0);
    });

    it("warns for anything else, including a non-string or empty value", () => {
      expect(runWithBy("bot")).toBe(1);
      expect(runWithBy("")).toBe(1);
      expect(runWithBy(42)).toBe(1);
    });

    it("flags a malformed generated.by under v0.1 too (only a v0.2 bundle would ever carry the key)", () => {
      expect(runWithBy("bot", "v0.1")).toBe(1);
    });

    it("both keys naming the SAME instant is a redundant mid-migration stamp, not a divergence", () => {
      fs.writeFileSync(path.join(dir, "index.md"), "# Index\n");
      writeDoc(dir, "doc.md", {
        type: "concept",
        timestamp: "2026-01-05T00:00:00Z",
        generated: { by: "okf-kit/0.19.0", at: "2026-01-05T00:00:00Z" },
      });
      expect(generatedShapeRule.run(loadBundle(dir))).toEqual([]);
    });

    it("skips reserved files (their block is reserved-files-bare's finding already) and docs without frontmatter", () => {
      fs.writeFileSync(
        path.join(dir, "log.md"),
        [
          "---",
          "generated:",
          "  by: bot",
          "  at: 2026-01-05T00:00:00",
          "---",
          "",
          "# Log",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "plain.md"), "# No frontmatter\n");
      const ctx: BundleContext = loadBundle(dir);
      ctx.specVersion = "v0.2";
      expect(generatedShapeRule.run(ctx)).toEqual([]);
    });
  });
});
