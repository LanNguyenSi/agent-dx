import { describe, expect, it } from "vitest";

import { listSkillReferenceNames, readAsset } from "../src/assets.js";

// The persisted probe plan, recovery, fix-regression, pinned-prose and probe
// verdict rules in the references are covered by the behaviour eval set and by
// review, not pinned as sentences. What stays is the routing contract: every
// packaged reference is reachable from the compact entrypoint.
describe("packaged skill references are routed", () => {
  it("routes every packaged reference from the compact entrypoint", () => {
    const core = readAsset("skill/SKILL.md");
    const routed = [...core.matchAll(/\]\(references\/([^\s)]+\.md)\)/g)].map(
      (match) => match[1],
    );
    expect(routed.length).toBeGreaterThan(0);
    expect([...new Set(routed)].sort()).toEqual(listSkillReferenceNames());
    for (const name of routed)
      expect(readAsset(`skill/references/${name}`).trim()).not.toBe("");
  });
});
