import path from "node:path";
import { describe, expect, it } from "vitest";
import { proseLineReferencesRule } from "../src/rules/prose-line-references.js";
import type { Finding } from "../src/types.js";
import { FIXTURES_DIR, loadFixture } from "./helpers.js";

/**
 * Exercises `proseLineReferencesRule` directly against `BundleContext`s
 * (mirroring citations-resolve.test.ts's own pattern), plus the CLI wiring
 * in prose-line-references-cli.test.ts. Fixture roots double as the "repo
 * root" for file-mention resolution, same convention citations-resolve's
 * own tests use.
 */

const MAIN_ROOT = path.join(FIXTURES_DIR, "prose-line-references-main");
const AMBIGUOUS_ROOT = path.join(
  FIXTURES_DIR,
  "prose-line-references-ambiguous",
);
const NEGATIVE_ROOT = path.join(FIXTURES_DIR, "prose-line-references-negative");
const JSON_EXT_ROOT = path.join(FIXTURES_DIR, "prose-line-references-json-ext");

function loadMain() {
  return loadFixture("prose-line-references-main/docs/okf", MAIN_ROOT);
}

function loadAmbiguous() {
  return loadFixture(
    "prose-line-references-ambiguous/docs/okf",
    AMBIGUOUS_ROOT,
  );
}

function loadNegative() {
  return loadFixture("prose-line-references-negative/docs/okf", NEGATIVE_ROOT);
}

function loadJsonExt() {
  return loadFixture("prose-line-references-json-ext/docs/okf", JSON_EXT_ROOT);
}

function findingsFor(reason: string, findings: Finding[]): Finding[] {
  return findings.filter((f) => f.message.includes(`[${reason}]`));
}

describe("prose-line-references", () => {
  it("returns nothing at all when ctx.proseLineReferences is not set (opt-in gate)", () => {
    const ctx = loadMain();
    expect(proseLineReferencesRule.run(ctx)).toEqual([]);
  });

  it("emits a bundle-level notice, not a crash, when repoRoot is absent", () => {
    const ctx = loadFixture("prose-line-references-main/docs/okf");
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("not inside a git work tree");
  });

  it("a correct in-bounds reference produces no finding", () => {
    const ctx = loadMain();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    expect(findings.some((f) => f.message.startsWith("`lines 1-3`"))).toBe(
      false,
    );
  });

  it("a reference exceeding the file length is reported out-of-bounds, naming the doc line and bound file", () => {
    const ctx = loadMain();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    const hit = findings.find((f) => f.message.startsWith("`lines 40-45`"));
    expect(hit).toBeDefined();
    expect(hit?.message).toMatch(/\(doc line \d+\)/);
    expect(hit?.message).toContain("bound to `src/target.ts`");
    expect(hit?.message).toContain("[out-of-bounds]");
    expect(hit?.severity).toBe("warning");
  });

  it("a reference landing on a blank line is reported blank-start-line", () => {
    const ctx = loadMain();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    const hit = findings.find((f) => f.message.startsWith("`line 4`"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("bound to `src/target.ts`");
    expect(hit?.message).toContain("[blank-start-line]");
    expect(hit?.severity).toBe("warning");
  });

  it("a reference with no nearby file mention is reported unresolvable", () => {
    const ctx = loadMain();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    const hit = findings.find((f) => f.message.startsWith("`lines 10-12`"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("[unresolvable]");
    expect(hit?.severity).toBe("notice");
  });

  it("a bare file mention resolving to two same-named files is reported ambiguous, naming both candidates", () => {
    const ctx = loadAmbiguous();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    const hit = findings.find((f) => f.message.startsWith("`lines 5-6`"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("[ambiguous]");
    expect(hit?.severity).toBe("notice");
    expect(hit?.detail).toContain("pkgA/note.md");
    expect(hit?.detail).toContain("pkgB/note.md");
  });

  it("strict mode flags every extracted reference, including the correct one, in addition to any base finding", () => {
    const ctx = loadMain();
    ctx.proseLineReferences = { strict: true };
    const findings = proseLineReferencesRule.run(ctx);
    const notAnchored = findingsFor(
      "prose-line-reference-not-anchored",
      findings,
    );
    // One per extracted reference: lines 1-3, lines 40-45, line 4, lines 10-12.
    expect(notAnchored).toHaveLength(4);
    expect(notAnchored.some((f) => f.message.startsWith("`lines 1-3`"))).toBe(
      true,
    );
    expect(
      notAnchored.every((f) =>
        f.message.includes(
          "lift into a backtick anchored citation or de-precise to a symbol name",
        ),
      ),
    ).toBe(true);
    // A drifted reference gets both its base finding and the strict finding.
    expect(findingsFor("out-of-bounds", findings)).toHaveLength(1);
  });

  it("a reference inside a fenced code block, an inline code span, a URL with a port, a timestamp, and a version string produce no findings", () => {
    const ctx = loadNegative();
    ctx.proseLineReferences = { strict: true };
    const findings = proseLineReferencesRule.run(ctx);
    expect(findings).toEqual([]);
  });

  // Regression: FILE_MENTION_RE's extension alternation (ts|js|mjs|md|yml|
  // yaml|json) lists "js" before "json", and "js" is a strict prefix of
  // "json". Without a trailing (?!\w) forcing the regex engine to reject a
  // truncated match, a real `config.json` mention would silently resolve
  // (or fail to resolve) as `config.js` instead -- CITATION_RE does not
  // have this problem because its own mandatory trailing `:` forces
  // backtracking past the short alternative, but FILE_MENTION_RE has
  // nothing after the extension group to force that on its own.
  it("a `.json` file mention resolves to the real .json file, not truncated to .js", () => {
    const ctx = loadJsonExt();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    expect(findings).toEqual([]);
  });
});
