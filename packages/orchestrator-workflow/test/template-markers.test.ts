import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

/**
 * The run templates carry a machine-readable solution-acceptance marker that a
 * downstream run-gate reads instead of parsing prose. These checks pin the
 * marker shape (exactly one per template) and the shipped fail-closed default
 * (`TODO`, which is not a valid enum value) so the contract cannot drift.
 */
describe("solution-acceptance markers in run templates", () => {
  const handoffTemplate = readAsset("templates/06-handoff.md");
  const reviewTemplate = readAsset("templates/05-review-findings.md");

  const finalStatusRe = /solution-acceptance:\s*final-status\s*=\s*(\S+)/g;
  const recommendationRe =
    /solution-acceptance:\s*acceptance-recommendation\s*=\s*(\S+)/g;

  it("06-handoff.md has exactly one final-status marker, defaulting to TODO", () => {
    const matches = [...handoffTemplate.matchAll(finalStatusRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("TODO");
  });

  it("05-review-findings.md has exactly one acceptance-recommendation marker, defaulting to TODO", () => {
    const matches = [...reviewTemplate.matchAll(recommendationRe)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("TODO");
  });
});

/**
 * The grounding-mcp orchestrator-workflow completeness reader locates the
 * findings table by its header row (a table row whose cells include both
 * `Severity` and `Decision`, case-insensitive) rather than by heading text,
 * and yields an explicit blocker when a findings section has content but no
 * such header row anywhere in the file. This pins the shipped header row so
 * the template cannot silently drift onto a convention (e.g. a
 * Decision-less `| Severity | Finding | Resolution |` table) the reader
 * cannot verify.
 */
describe("05-review-findings.md findings-table header convention", () => {
  const reviewTemplate = readAsset("templates/05-review-findings.md");

  it("carries a header row with both Severity and Decision columns", () => {
    const headerRow = reviewTemplate
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("|") && /severity/i.test(line));
    expect(headerRow).toBeDefined();
    const cells = (headerRow ?? "")
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().toLowerCase());
    expect(cells).toContain("severity");
    expect(cells).toContain("decision");
  });

  it("documents the header as load-bearing above the table", () => {
    expect(reviewTemplate).toMatch(/<!--[^>]*load-bearing[^>]*-->/i);
  });

  it("invites only the reader's resolved Decision vocabulary in the example row", () => {
    // grounding-mcp's completeness reader treats a high/critical finding as
    // resolved ONLY when its Decision is `accepted` or `defer` (RESOLVED_DECISIONS).
    // The example row must not offer arming values (fix/reject) as if they were
    // resolutions, or an operator following the template hits a surprising gate.
    const exampleRow = reviewTemplate
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("|") && /low\/medium\/high\/critical/i.test(line));
    expect(exampleRow).toBeDefined();
    const cells = (exampleRow ?? "").split("|").slice(1, -1).map((cell) => cell.trim());
    const decisionCell = cells[cells.length - 1];
    const tokens = decisionCell.split("/").map((token) => token.trim()).filter(Boolean);
    // Mutation-check: re-adding fix/reject to the example cell fails this.
    expect(tokens).toEqual(["accepted", "defer"]);
  });

  it("documents that non-resolved Decision values arm the completeness gate", () => {
    // The legend must name the arming behavior so the narrowed example reads as
    // "these resolve; others arm", not "these are the only legal values".
    expect(reviewTemplate).toMatch(/RESOLVED_DECISIONS\s*=\s*\{\s*accepted\s*,\s*defer\s*\}/);
    expect(reviewTemplate).toMatch(/arms? the (?:completeness )?gate/i);
  });
});
