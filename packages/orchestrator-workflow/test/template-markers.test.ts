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
