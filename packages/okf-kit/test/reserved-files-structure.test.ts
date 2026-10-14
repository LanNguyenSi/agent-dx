import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/bundle.js";
import { reservedFilesStructureRule } from "../src/rules/reserved-files-structure.js";
import type {
  BundleContext,
  BundleDoc,
  Finding,
  SpecVersion,
} from "../src/types.js";
import { loadFixture } from "./helpers.js";

function findingsFor(findings: Finding[], file: string): Finding[] {
  return findings.filter((f) => f.file === file);
}

function lines(findings: Finding[]): number[] {
  return findings.map((f) => Number(/line (\d+)/.exec(f.message)?.[1] ?? -1));
}

// An in-memory bundle, for inputs a fixture file on disk cannot carry
// faithfully (CRLF endings survive neither a checkout-time normalization nor
// a re-saving editor). Frontmatter parsing mirrors `loadBundle`.
function inlineBundle(
  raws: Record<string, string>,
  specVersion: SpecVersion = "v0.1",
): BundleContext {
  const docs: BundleDoc[] = Object.entries(raws).map(([relPath, raw]) => {
    const basename = relPath.slice(relPath.lastIndexOf("/") + 1);
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      relPath,
      basename,
      isReserved: basename === "index.md" || basename === "log.md",
      raw,
      frontmatter,
      body,
    };
  });
  return { bundleDir: "inline", docs, specVersion };
}

describe("reserved-files-structure", () => {
  it("finds nothing in a bundle whose reserved-file bodies conform", () => {
    expect(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-conformant"),
      ),
    ).toEqual([]);
  });

  it("log.md: one finding per non-ISO date heading, with its line", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-log-bad-dates"),
      ),
      "log.md",
    );
    // line 1: extra text after the date; line 5: non-date level-2 heading;
    // line 9: a bare date at the wrong heading level; line 13: an impossible
    // calendar date. The conformant `## 2026-01-01` (line 17) is not reported.
    expect(lines(findings)).toEqual([1, 5, 9, 13]);
    expect(findings.every((f) => f.ruleId === "reserved-files-structure")).toBe(
      true,
    );
    expect(findings[0].message).toContain("2026-10-03 (mcp-server 0.16.0)");
    expect(findings[2].message).toContain("level 3");
  });

  it("log.md: bad-date findings are errors under v0.2 and warnings under v0.1", () => {
    const ctx = loadFixture("reserved-structure-log-bad-dates");
    ctx.specVersion = "v0.2";
    const asV02 = findingsFor(reservedFilesStructureRule.run(ctx), "log.md");
    expect(asV02.length).toBeGreaterThan(0);
    expect(asV02.every((f) => f.severity === "error")).toBe(true);

    ctx.specVersion = "v0.1";
    const asV01 = findingsFor(reservedFilesStructureRule.run(ctx), "log.md");
    expect(asV01.map((f) => f.message)).toEqual(asV02.map((f) => f.message));
    expect(asV01.every((f) => f.severity === "warning")).toBe(true);
  });

  it("log.md: a date heading not older than the previous one is named with its line", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-log-order"),
      ),
      "log.md",
    );
    // oldest-first order (line 1) then a newer date (line 5), then the same
    // date twice (line 9): both later headings are reported, naming the
    // offending heading, and the first heading is never reported.
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.message.includes("`## 2026-10-03`"))).toBe(
      true,
    );
    expect(lines(findings)).toEqual([5, 9]);
  });

  it("index.md: a free prose paragraph is one warning naming its line", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-index-prose"),
      ),
      "index.md",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(lines(findings)).toEqual([3]);
  });

  it("index.md: a plain-text list item is free prose at its own line, top level and nested", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-index-plain-bullets"),
      ),
      "index.md",
    );
    // line 4: the plain-text bullet nested under the link entry; line 5: the
    // plain-text top-level bullet. The two link entries around them are not
    // reported, and each warning names its OWN line (not the block's start).
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
    expect(lines(findings)).toEqual([4, 5]);
  });

  it("index.md: a prose paragraph followed directly by a plain-text bullet gives two findings", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-index-prose-then-bullet"),
      ),
      "index.md",
    );
    // The bullet on line 5 is NOT swallowed as a continuation of the
    // paragraph that starts on line 3: the paragraph closes at the bullet,
    // and the bullet is then judged on its own as a non-link list item.
    expect(findings).toHaveLength(2);
    expect(lines(findings)).toEqual([3, 5]);
  });

  it("frontmatter shifts every finding to its line in the RAW file, index.md and log.md alike", () => {
    // v0.2 fixture: the root index.md's `okf_version` block is legal and
    // shifts the body down; the log.md frontmatter block is not legal under
    // any version (reserved-files-bare reports it), but this rule must still
    // point its findings at the real file lines rather than body lines.
    const findings = reservedFilesStructureRule.run(
      loadFixture("reserved-structure-frontmatter"),
    );
    const indexFindings = findingsFor(findings, "index.md");
    expect(indexFindings).toHaveLength(1);
    expect(lines(indexFindings)).toEqual([5]);
    const logFindings = findingsFor(findings, "log.md");
    expect(logFindings).toHaveLength(1);
    expect(logFindings[0].severity).toBe("error");
    expect(logFindings[0].message).toContain(
      "`## 2026-10-05 (extra text after the date)` (line 5)",
    );
  });

  it("log.md: a bullet-only log gives exactly one file-level finding, severity by version", () => {
    const ctx = loadFixture("reserved-structure-log-bullets-only");
    ctx.specVersion = "v0.2";
    const asV02 = findingsFor(reservedFilesStructureRule.run(ctx), "log.md");
    expect(asV02).toHaveLength(1);
    expect(asV02[0].severity).toBe("error");
    expect(asV02[0].message).toContain("no `## YYYY-MM-DD` date headings");

    ctx.specVersion = "v0.1";
    const asV01 = findingsFor(reservedFilesStructureRule.run(ctx), "log.md");
    expect(asV01).toHaveLength(1);
    expect(asV01[0].severity).toBe("warning");
    expect(asV01[0].message).toBe(asV02[0].message);
  });

  it("log.md: an HTML comment contributes no heading and keeps the other line numbers", () => {
    const findings = findingsFor(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-log-comments"),
      ),
      "log.md",
    );
    // The `## 2026-10-04 (template)` inside the multi-line comment (line 6)
    // is not a heading; the heading after the comment (line 10) keeps its
    // real line number through the masking.
    expect(findings).toHaveLength(1);
    expect(lines(findings)).toEqual([10]);
    expect(findings[0].message).toContain("`## not a date after the comment`");
  });

  it("log.md: CRLF endings keep heading detection clean and line numbers right", () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const good =
      "## 2026-02-01\n\nnewest entry\n\n## 2026-01-15\n\nolder entry\n";
    expect(
      reservedFilesStructureRule.run(
        inlineBundle({ "log.md": crlf(good) }, "v0.2"),
      ),
    ).toEqual([]);

    const bad = "# Log\n\n## 2026-02-30\n\nFebruary never has 30 days\n";
    const findings = reservedFilesStructureRule.run(
      inlineBundle({ "log.md": crlf(bad) }, "v0.2"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(lines(findings)).toEqual([3]);
  });

  it("fences: a ~~~ line inside a ``` block stays content and never closes the fence", () => {
    // The old per-rule toggle closed the ``` block on the ~~~ line, which
    // then exposed the heading-shaped line in log.md (and the prose-shaped
    // line in index.md) as real content. One shared fence state machine
    // (citations-resolve's `scanFenceLines`) closes a fence only on the
    // marker that opened it.
    expect(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-fence-marker"),
      ),
    ).toEqual([]);
  });
});
