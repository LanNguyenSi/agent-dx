import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

// The single-run escalation rule and the escalation budget it belongs to are
// covered by the behaviour eval set and by review, not pinned as sentences.
// The policy section keeps its line-length convention.
describe("policy section formatting", () => {
  const policy = readAsset("agents-md-section.md");

  it("keeps policy lines at 80 columns unless their non-URL text fits", () => {
    for (const [index, line] of policy.split("\n").entries()) {
      const withoutUrls = line.replace(/https?:\/\/[^\s)]+/g, "");
      expect(
        withoutUrls.length,
        `policy line ${index + 1} has over-80 non-URL text`,
      ).toBeLessThanOrEqual(80);
    }
  });
});
