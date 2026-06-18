import { describe, it, expect } from "vitest";
import { allPacks } from "../src/packs/registry.js";

// These counts are documented in prose in the root README.md ("Thirty-four
// deterministic rules across five packs") and in this package's rule-pack
// table. The assertions below fail if a rule is added or removed without the
// docs being updated, so the numbers cannot silently drift from the registry.
const expectedRuleCounts: Record<string, number> = {
  "agent-tics": 7,
  "prose-slop": 7,
  "comment-slop": 5,
  "code-slop": 9,
  "ui-slop": 6,
};

describe("rule registry counts (doc-drift guard)", () => {
  it("each pack registers the documented number of rules", () => {
    const actual = Object.fromEntries(
      allPacks.map((p) => [p.id, p.rules.length]),
    );
    expect(actual).toEqual(expectedRuleCounts);
  });

  it("the five packs total 34 rules", () => {
    const total = allPacks.reduce((sum, p) => sum + p.rules.length, 0);
    expect(total).toBe(34);
  });
});
