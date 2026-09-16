import { describe, it, expect } from "vitest";
import { allPacks } from "../src/packs/registry.js";

// These counts are documented in prose in two places: the repo root
// README.md ("eight rule packs") and this package's own rule-pack table
// (README.md). The assertions below fail if a rule is added or removed
// without the docs being updated, so the numbers cannot silently drift from
// the registry.
const expectedRuleCounts: Record<string, number> = {
  "agent-tics": 7,
  "prose-slop": 7,
  "comment-slop": 5,
  "code-slop": 9,
  "ui-slop": 6,
  "placement-slop": 5,
  "workflow-slop": 5,
  "review-slop": 3,
};

describe("rule registry counts (doc-drift guard)", () => {
  it("each pack registers the documented number of rules", () => {
    const actual = Object.fromEntries(
      allPacks.map((p) => [p.id, p.rules.length]),
    );
    expect(actual).toEqual(expectedRuleCounts);
  });

  it("the eight packs total 47 rules", () => {
    const total = allPacks.reduce((sum, p) => sum + p.rules.length, 0);
    expect(total).toBe(47);
  });

  it("registers placement-slop and lists its five rule ids", () => {
    const pack = allPacks.find((p) => p.id === "placement-slop");
    expect(pack).toBeDefined();
    expect(pack!.rules.map((r) => r.id).sort()).toEqual(
      [
        "placement-slop/dated-evidence",
        "placement-slop/home-path",
        "placement-slop/opaque-id",
        "placement-slop/org-marker",
        "placement-slop/tally-phrase",
      ].sort(),
    );
    expect(pack!.rules.every((r) => r.pack === "placement-slop")).toBe(true);
  });

  it("registers workflow-slop and lists its five rule ids", () => {
    const pack = allPacks.find((p) => p.id === "workflow-slop");
    expect(pack).toBeDefined();
    expect(pack!.rules.map((r) => r.id).sort()).toEqual(
      [
        "workflow-slop/audit-gate-missing",
        "workflow-slop/audit-gate-shape",
        "workflow-slop/node20-action-major",
        "workflow-slop/run-expression",
        "workflow-slop/unparseable-workflow",
      ].sort(),
    );
    expect(pack!.rules.every((r) => r.pack === "workflow-slop")).toBe(true);
  });

  it("registers review-slop and lists its three rule ids", () => {
    const pack = allPacks.find((p) => p.id === "review-slop");
    expect(pack).toBeDefined();
    expect(pack!.rules.map((r) => r.id).sort()).toEqual(
      [
        "review-slop/finding-id",
        "review-slop/handoff-phrase",
        "review-slop/round-reference",
      ].sort(),
    );
    expect(pack!.rules.every((r) => r.pack === "review-slop")).toBe(true);
  });
});
