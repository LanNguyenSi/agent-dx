import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

/**
 * Human-facing documentation is a checklist item of every run: the handoff
 * template states the documentation impact, and the reviewer flags a
 * user-visible or architectural change whose handoff says `none` without a
 * reason (issue #355).
 */
describe("documentation impact in the definition of done", () => {
  const handoffTemplate = readAsset("templates/06-handoff.md");
  const reviewer = readAsset("agents/reviewer.md");

  it("06-handoff.md carries the Documentation Impact section with its three forms", () => {
    const start = handoffTemplate.indexOf("## Documentation Impact");
    expect(start).toBeGreaterThan(-1);
    const end = handoffTemplate.indexOf("## Follow-Ups");
    expect(end).toBeGreaterThan(start);
    const section = handoffTemplate.slice(start, end);
    expect(section).toContain("none (<reason>)");
    expect(section).toContain("updated: <paths>");
    expect(section).toContain("follow-up: <task>");
  });

  it("reviewer.md flags an unexplained none as a medium finding", () => {
    const flat = reviewer.replace(/\s+/g, " ");
    expect(flat).toContain(
      "`none` without a reason, while no human-facing documentation was updated, is a medium finding.",
    );
    expect(flat).toContain("A docs-only change is exempt.");
  });
});
