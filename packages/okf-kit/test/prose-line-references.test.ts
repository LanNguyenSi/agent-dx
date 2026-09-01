import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
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
const BINDER_ROOT = path.join(FIXTURES_DIR, "prose-line-references-binder");
const RANGES_ROOT = path.join(FIXTURES_DIR, "prose-line-references-ranges");
const RESERVED_ROOT = path.join(FIXTURES_DIR, "prose-line-references-reserved");
const MENTIONS_ROOT = path.join(FIXTURES_DIR, "prose-line-references-mentions");
const ZERO_ROOT = path.join(FIXTURES_DIR, "prose-line-references-zero");
const HYPHENWORD_ROOT = path.join(
  FIXTURES_DIR,
  "prose-line-references-hyphenword",
);
const HEADING_COMMENT_ROOT = path.join(
  FIXTURES_DIR,
  "prose-line-references-heading-comment",
);

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

function loadBinder() {
  return loadFixture("prose-line-references-binder/docs/okf", BINDER_ROOT);
}

function loadRanges() {
  return loadFixture("prose-line-references-ranges/docs/okf", RANGES_ROOT);
}

function loadReserved() {
  return loadFixture("prose-line-references-reserved/docs/okf", RESERVED_ROOT);
}

function loadMentions() {
  return loadFixture("prose-line-references-mentions/docs/okf", MENTIONS_ROOT);
}

function loadZero() {
  return loadFixture("prose-line-references-zero/docs/okf", ZERO_ROOT);
}

function loadHyphenWord() {
  return loadFixture(
    "prose-line-references-hyphenword/docs/okf",
    HYPHENWORD_ROOT,
  );
}

function loadHeadingComment() {
  return loadFixture(
    "prose-line-references-heading-comment/docs/okf",
    HEADING_COMMENT_ROOT,
  );
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

  // -- binding-rule discrimination (nearest-in-sentence vs. paragraph
  // fallback vs. a mutant that always picks the first mention in the
  // paragraph) ----------------------------------------------------------

  describe("binding rule", () => {
    it("binds to the nearest file mention in the same sentence, not the first mention in the paragraph (mutation probe A)", () => {
      const ctx = loadBinder();
      ctx.proseLineReferences = { strict: true };
      const findings = proseLineReferencesRule.run(ctx);
      // "`src/fileA.ts` sets the const. `src/fileB.ts` defines a helper.
      // This function documented in `src/fileC.ts` reads it on line 1." --
      // the nearest-in-sentence mention for this `line 1` is `src/fileC.ts`,
      // not `src/fileA.ts` (the first mention in the paragraph). Swapping
      // nearest-in-sentence binding for first-in-paragraph binding would
      // bind this reference to `src/fileA.ts` instead, and every other
      // fixture in this file would still pass.
      const notAnchored = findingsFor(
        "prose-line-reference-not-anchored",
        findings,
      );
      expect(
        notAnchored.filter((f) =>
          f.message.includes("bound to `src/fileC.ts`"),
        ),
      ).toHaveLength(1);
      expect(
        notAnchored.some((f) => f.message.includes("bound to `src/fileA.ts`")),
      ).toBe(false);
    });

    it("binds to a following in-sentence mention when no preceding mention exists in the sentence", () => {
      const ctx = loadBinder();
      ctx.proseLineReferences = { strict: true };
      const findings = proseLineReferencesRule.run(ctx);
      const hit = findingsFor(
        "prose-line-reference-not-anchored",
        findings,
      ).find((f) => f.message.startsWith("`line 2`"));
      expect(hit).toBeDefined();
      expect(hit?.message).toContain("bound to `src/fileD.ts`");
    });

    it("falls back to the nearest preceding mention in the paragraph when the sentence has no mention at all", () => {
      const ctx = loadBinder();
      ctx.proseLineReferences = { strict: true };
      const findings = proseLineReferencesRule.run(ctx);
      const hits = findingsFor(
        "prose-line-reference-not-anchored",
        findings,
      ).filter((f) => f.message.includes("bound to `src/fileE.ts`"));
      expect(hits).toHaveLength(1);
    });

    it("an 'e.g.'/'i.e.'/'vs.' abbreviation's period does not end the sentence", () => {
      const ctx = loadBinder();
      ctx.proseLineReferences = { strict: true };
      const findings = proseLineReferencesRule.run(ctx);
      const notAnchored = findingsFor(
        "prose-line-reference-not-anchored",
        findings,
      );
      expect(
        notAnchored.some((f) => f.message.includes("bound to `src/eg.ts`")),
      ).toBe(true);
      expect(
        notAnchored.some((f) => f.message.includes("bound to `src/ie.ts`")),
      ).toBe(true);
      expect(
        notAnchored.some((f) => f.message.includes("bound to `src/vsold.ts`")),
      ).toBe(true);
    });

    it("a sentence ending in a backtick-wrapped path followed by a period is recognised as a sentence boundary", () => {
      const ctx = loadBinder();
      ctx.proseLineReferences = { strict: true };
      const findings = proseLineReferencesRule.run(ctx);
      const notAnchored = findingsFor(
        "prose-line-reference-not-anchored",
        findings,
      );
      expect(
        notAnchored.some((f) => f.message.includes("bound to `src/parser.ts`")),
      ).toBe(true);
    });

    it("a file-mention token with a leading `/` or a `..` segment is skipped, never bound to", () => {
      const ctx = loadMentions();
      ctx.proseLineReferences = { strict: false };
      const findings = proseLineReferencesRule.run(ctx);
      const abs = findings.find((f) => f.message.startsWith("`lines 5-6`"));
      const rel = findings.find((f) => f.message.startsWith("`lines 7-8`"));
      expect(abs).toBeDefined();
      expect(abs?.message).toContain(
        "no file mention could be bound to this prose line reference",
      );
      expect(abs?.message).toContain("[unresolvable]");
      expect(rel).toBeDefined();
      expect(rel?.message).toContain(
        "no file mention could be bound to this prose line reference",
      );
      expect(rel?.message).toContain("[unresolvable]");
    });

    // -- unreadable target ------------------------------------------------

    const isUnsupportedForChmod =
      process.platform === "win32" || process.getuid?.() === 0;

    it.skipIf(isUnsupportedForChmod)(
      "an unreadable bound target folds into unresolvable, not a thrown error",
      () => {
        const tmpRoot = fs.mkdtempSync(
          path.join(os.tmpdir(), "okf-prose-line-references-unreadable-"),
        );
        const targetPath = path.join(tmpRoot, "src/secret.ts");
        try {
          fs.mkdirSync(path.join(tmpRoot, "docs/okf"), { recursive: true });
          fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
          fs.writeFileSync(targetPath, "export const a = 1;\n");
          fs.chmodSync(targetPath, 0o000);
          fs.writeFileSync(
            path.join(tmpRoot, "docs/okf/doc.md"),
            [
              "---",
              "type: reference",
              "title: Unreadable-target fixture",
              "---",
              "",
              "Prose reference into a file this process cannot read: `src/secret.ts` line 1.",
              "",
            ].join("\n"),
          );

          const ctx = loadBundle(path.join(tmpRoot, "docs/okf"), tmpRoot);
          ctx.proseLineReferences = { strict: false };
          const findings = proseLineReferencesRule.run(ctx);
          const hit = findings.find((f) => f.message.startsWith("`line 1`"));
          expect(hit).toBeDefined();
          expect(hit?.severity).toBe("notice");
          expect(hit?.message).toContain("[unresolvable]");
          expect(hit?.message).toContain(
            "bound target `src/secret.ts` exists but could not be read",
          );
        } finally {
          fs.chmodSync(targetPath, 0o644); // restore so rmSync can clean up
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      },
    );
  });

  // -- range-form grammar (en-dash, em-dash, "to", inverted range) -------

  describe("range forms", () => {
    it("an en-dash range is extracted with its full end line, not just the start (mutation probe B)", () => {
      const ctx = loadRanges();
      ctx.proseLineReferences = { strict: false };
      const findings = proseLineReferencesRule.run(ctx);
      const hit = findings.find((f) => f.message.startsWith("`lines 2–99`"));
      expect(hit).toBeDefined();
      expect(hit?.message).toContain("(normalized `lines 2-99`)");
      expect(hit?.message).toContain("[out-of-bounds]");
      expect(hit?.message).toContain(
        "citation exceeds file length (10 line(s))",
      );
      expect(hit?.severity).toBe("warning");
    });

    it("an em-dash range is extracted with its full end line, not just the start (mutation probe B)", () => {
      const ctx = loadRanges();
      ctx.proseLineReferences = { strict: false };
      const findings = proseLineReferencesRule.run(ctx);
      const hit = findings.find((f) => f.message.startsWith("`lines 2—99`"));
      expect(hit).toBeDefined();
      expect(hit?.message).toContain("(normalized `lines 2-99`)");
      expect(hit?.message).toContain("[out-of-bounds]");
      expect(hit?.message).toContain(
        "citation exceeds file length (10 line(s))",
      );
      expect(hit?.severity).toBe("warning");
    });

    it("a 'lines N to M' range is extracted with its full end line, not just the start (mutation probe B)", () => {
      const ctx = loadRanges();
      ctx.proseLineReferences = { strict: false };
      const findings = proseLineReferencesRule.run(ctx);
      const hit = findings.find((f) => f.message.startsWith("`lines 2 to 99`"));
      expect(hit).toBeDefined();
      expect(hit?.message).toContain("(normalized `lines 2-99`)");
      expect(hit?.message).toContain("[out-of-bounds]");
      expect(hit?.message).toContain(
        "citation exceeds file length (10 line(s))",
      );
      expect(hit?.severity).toBe("warning");
    });

    it("an inverted range (end before start) is reported out-of-bounds even though both bounds are in-range (mutation probe C)", () => {
      const ctx = loadRanges();
      ctx.proseLineReferences = { strict: false };
      const findings = proseLineReferencesRule.run(ctx);
      const hit = findings.find((f) => f.message.startsWith("`lines 8-4`"));
      expect(hit).toBeDefined();
      expect(hit?.message).not.toContain("normalized");
      expect(hit?.message).toContain("[out-of-bounds]");
      expect(hit?.message).toContain("range end (4) is before its start (8)");
      expect(hit?.severity).toBe("warning");
    });
  });

  // -- reserved citing docs -----------------------------------------------

  it("a reserved citing doc (index.md) is skipped entirely, even with a drifted prose reference (mutation probe D)", () => {
    const ctx = loadReserved();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    expect(findings).toEqual([]);
  });

  // -- `line 0` -------------------------------------------------------------

  it("`line 0` is reported out-of-bounds, not blank-start-line (avoids indexing lines[-1])", () => {
    const ctx = loadZero();
    ctx.proseLineReferences = { strict: false };
    const findings = proseLineReferencesRule.run(ctx);
    const hit = findings.find((f) => f.message.startsWith("`line 0`"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("[out-of-bounds]");
    expect(hit?.message).not.toContain("[blank-start-line]");
    expect(hit?.message).toContain("start line (0) is not a valid line number");
    expect(hit?.severity).toBe("warning");
  });

  // -- hyphen-prefixed word boundary ---------------------------------------

  it("a hyphen-joined word ('in-line', 'multi-line', 'command-line') is not extracted, but a plain 'line N' still is", () => {
    const ctx = loadHyphenWord();
    ctx.proseLineReferences = { strict: true };
    const findings = proseLineReferencesRule.run(ctx);
    const notAnchored = findingsFor(
      "prose-line-reference-not-anchored",
      findings,
    );
    expect(notAnchored).toHaveLength(1);
    expect(notAnchored[0].message.startsWith("`line 1`")).toBe(true);
    expect(findings.some((f) => f.message.includes("999"))).toBe(false);
  });

  // -- ATX headings and HTML comments --------------------------------------

  it("an ATX heading's own 'Line N' is not extracted, nor is a line reference inside an HTML comment", () => {
    const ctx = loadHeadingComment();
    ctx.proseLineReferences = { strict: true };
    const findings = proseLineReferencesRule.run(ctx);
    const notAnchored = findingsFor(
      "prose-line-reference-not-anchored",
      findings,
    );
    expect(notAnchored).toHaveLength(2);
    expect(notAnchored.some((f) => f.message.startsWith("`line 1`"))).toBe(
      true,
    );
    expect(notAnchored.some((f) => f.message.startsWith("`line 2`"))).toBe(
      true,
    );
    expect(findings.some((f) => f.message.includes("Line 3"))).toBe(false);
    expect(findings.some((f) => f.message.includes("`line 5`"))).toBe(false);
  });
});
