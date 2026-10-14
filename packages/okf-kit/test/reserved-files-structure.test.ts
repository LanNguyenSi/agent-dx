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
    // line in index.md) as real content. The rule's own fence scanner closes
    // a fence only on a run of the same character as the opener.
    expect(
      reservedFilesStructureRule.run(
        loadFixture("reserved-structure-fence-marker"),
      ),
    ).toEqual([]);
  });

  it("fences: a ``` bash opener with an info string is a real fence (log.md)", () => {
    // CommonMark allows an info string with spaces (```` ``` bash ````); the
    // scanner must open a fence here, or the closing ``` would read as a new
    // opener and flip the fence state of the rest of the file. Exactly one
    // finding: line 7 (extra text after the date); line 4 is fence content.
    const log =
      "## 2026-01-02\n\n``` bash\n## not a heading\n```\n\n## 2026-01-01 bad\n";
    const findings = reservedFilesStructureRule.run(
      inlineBundle({ "log.md": log }, "v0.2"),
    );
    expect(findings).toHaveLength(1);
    expect(lines(findings)).toEqual([7]);
    expect(findings[0].message).toContain("`## 2026-01-01 bad`");
  });

  it("fences: a ``` indented by four spaces is not a fence, by three it is (log.md)", () => {
    // Four leading spaces make an indented code block line, not a fence
    // opener, so the heading below it is still read and reported.
    const fourSpaces = "## 2026-01-01\n\n    ```\n## 2026-01-01 bad\n";
    const four = reservedFilesStructureRule.run(
      inlineBundle({ "log.md": fourSpaces }, "v0.2"),
    );
    expect(lines(four)).toEqual([4]);
    // Three leading spaces still open a fence, so the heading is content.
    const threeSpaces = "## 2026-01-01\n\n   ```\n## 2026-01-01 bad\n";
    expect(
      reservedFilesStructureRule.run(
        inlineBundle({ "log.md": threeSpaces }, "v0.2"),
      ),
    ).toEqual([]);
  });

  it("fences: a ```ts title fence with attributes is a real fence (index.md)", () => {
    const index = [
      "# Bundle index",
      "",
      '```ts title="x"',
      "free prose inside the fence",
      "- plain bullet inside the fence",
      "```",
      "",
      "- [Concept A](concept-a.md)",
      "",
    ].join("\n");
    expect(
      reservedFilesStructureRule.run(inlineBundle({ "index.md": index })),
    ).toEqual([]);
  });

  it("fences: a 4-backtick fence is closed only by a run of 4, not by 3", () => {
    const log = [
      "## 2026-01-01",
      "",
      "````",
      "```",
      "## 2026-01-01 bad",
      "````",
      "",
    ].join("\n");
    expect(
      reservedFilesStructureRule.run(inlineBundle({ "log.md": log }, "v0.2")),
    ).toEqual([]);
  });

  it("fences: a ~~~ fence is closed only by ~~~, not by ```", () => {
    const log = [
      "## 2026-01-01",
      "",
      "~~~",
      "```",
      "## 2026-01-01 bad",
      "~~~",
      "",
    ].join("\n");
    expect(
      reservedFilesStructureRule.run(inlineBundle({ "log.md": log }, "v0.2")),
    ).toEqual([]);
  });

  it("fences: a ``` bash line inside an open ``` fence does not close it", () => {
    // A closing fence never carries an info string, so the ```` ``` bash ````
    // line is fence content and the heading-shaped line after it too.
    const log = [
      "## 2026-01-01",
      "",
      "```",
      "``` bash",
      "## 2026-01-01 bad",
      "```",
      "",
    ].join("\n");
    expect(
      reservedFilesStructureRule.run(inlineBundle({ "log.md": log }, "v0.2")),
    ).toEqual([]);
  });

  it("fences: a backtick line with a backtick in its info string is not an opener", () => {
    // `` ``` info ` with a backtick ``` `` is not a fence under CommonMark, so
    // the heading line after it is real content and must be reported.
    const log = [
      "## 2026-01-02",
      "",
      "``` info ` with a backtick ```",
      "## 2026-01-01 bad",
      "",
    ].join("\n");
    const findings = reservedFilesStructureRule.run(
      inlineBundle({ "log.md": log }, "v0.2"),
    );
    expect(findings).toHaveLength(1);
    expect(lines(findings)).toEqual([4]);
  });

  it("fences: an unclosed fence runs to the end of the file", () => {
    const log = ["## 2026-01-01", "", "``` bash", "## 2026-01-01 bad"].join(
      "\n",
    );
    expect(
      reservedFilesStructureRule.run(inlineBundle({ "log.md": log }, "v0.2")),
    ).toEqual([]);
  });

  it("fences: a fence directly after a list item or prose closes the block", () => {
    // A link entry followed with no blank line by a fence: without the fence
    // check the list walk continues into the fence and reports the plain-text
    // bullet inside it as free prose.
    const afterItem = [
      "# Bundle index",
      "",
      "- [Concept A](concept-a.md)",
      "```",
      "- plain bullet inside the fence",
      "```",
      "",
    ].join("\n");
    expect(
      reservedFilesStructureRule.run(inlineBundle({ "index.md": afterItem })),
    ).toEqual([]);

    // Same for a prose paragraph: the paragraph is one warning at its own
    // line, and the prose line inside the fence adds no second finding.
    const afterProse = [
      "# Bundle index",
      "",
      "A prose paragraph running straight into a fence.",
      "```",
      "plain prose inside the fence",
      "```",
      "",
    ].join("\n");
    const findings = reservedFilesStructureRule.run(
      inlineBundle({ "index.md": afterProse }),
    );
    expect(findings).toHaveLength(1);
    expect(lines(findings)).toEqual([3]);
  });
});
