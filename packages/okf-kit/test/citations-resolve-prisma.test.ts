import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { citationsResolveRule } from "../src/rules/citations-resolve.js";
import type { Finding } from "../src/types.js";
import { FIXTURES_DIR, loadFixture } from "./helpers.js";

/**
 * `.prisma` targets in `citations-resolve`: the recognised-citation extension
 * list (CITATION_RE, see src/rules/citations-resolve.ts) grew a `.prisma`
 * entry after a review found a `schema.prisma:999` citation past the last
 * line passing the check while the identical out-of-range citation into a
 * `.ts` file was flagged. The fixture bundles the shapes once per extension
 * so the `.ts` control sits next to the `.prisma` case it mirrors.
 */

const PRISMA_ROOT = path.join(FIXTURES_DIR, "citations-resolve-prisma");

function loadPrisma() {
  return loadFixture("citations-resolve-prisma/docs/okf", PRISMA_ROOT);
}

/** A finding's message always starts with `` `<citation>`: `` (see pushDrift/pushAmbiguous). */
function findingFor(
  findings: Finding[],
  citation: string,
): Finding | undefined {
  const prefix = `\`${citation}\`: `;
  return findings.find((f) => f.message.startsWith(prefix));
}

describe("citations-resolve .prisma targets", () => {
  it("a .prisma citation past the end of file is flagged range-exceeds-file", () => {
    const findings = citationsResolveRule.run(loadPrisma());
    const f = findingFor(findings, "prisma/schema.prisma:999");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("control: a .ts citation past the end of file is flagged range-exceeds-file", () => {
    const findings = citationsResolveRule.run(loadPrisma());
    const f = findingFor(findings, "src/target.ts:999");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[range-exceeds-file]");
  });

  it("an in-range .prisma citation on real content produces no finding", () => {
    const findings = citationsResolveRule.run(loadPrisma());
    expect(findingFor(findings, "prisma/schema.prisma:7")).toBeUndefined();
  });

  it("a .prisma citation landing on a lone closing brace is flagged closing-brace-start-line", () => {
    const findings = citationsResolveRule.run(loadPrisma());
    const f = findingFor(findings, "prisma/schema.prisma:10");
    expect(f).toBeDefined();
    expect(f?.message).toContain("[closing-brace-start-line]");
  });

  it("a v0.2 footnote into the same lone closing brace gets the same closing-brace-start-line verdict as the inline citation above", () => {
    // Mirror of the inline `prisma/schema.prisma:10` case, reached through the
    // OKF v0.2 footnote path (the footnote's `sources` entry names the file,
    // its DEFINITION text names the line) rather than prose. Both routes run
    // the identical checkTarget start-line checks, so the verdict must match.
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-kit-prisma-footnote-"),
    );
    try {
      fs.mkdirSync(path.join(tmpRoot, "prisma"), { recursive: true });
      fs.copyFileSync(
        path.join(
          FIXTURES_DIR,
          "citations-resolve-prisma",
          "prisma",
          "schema.prisma",
        ),
        path.join(tmpRoot, "prisma", "schema.prisma"),
      );
      fs.mkdirSync(path.join(tmpRoot, "docs"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "docs", "index.md"),
        '---\nokf_version: "0.2"\n---\n\n# Index\n',
      );
      fs.writeFileSync(
        path.join(tmpRoot, "docs", "doc.md"),
        [
          "---",
          "type: reference",
          "sources:",
          "  - id: post",
          "    resource: prisma/schema.prisma",
          "---",
          "",
          "The Post model closes here.[^post]",
          "",
          "[^post]: Post model, `L10`.",
          "",
        ].join("\n"),
      );
      const ctx = loadBundle(path.join(tmpRoot, "docs"), tmpRoot);
      ctx.specVersion = "v0.2";
      const findings = citationsResolveRule.run(ctx);
      const f = findingFor(
        findings,
        "prisma/schema.prisma:10 (footnote [^post])",
      );
      expect(f).toBeDefined();
      expect(f?.message).toContain("[closing-brace-start-line]");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
