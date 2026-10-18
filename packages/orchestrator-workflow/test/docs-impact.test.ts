import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

/**
 * Human-facing documentation is a checklist item of every run: the handoff
 * template states the documentation impact in one of three forms. The template
 * line is the contract the orchestrator fills; the reviewer's check and the
 * hand-off steps that mention it are covered by the behaviour eval set and by
 * review, not pinned as sentences.
 */
describe("documentation impact in the definition of done", () => {
  const handoffTemplate = readAsset("templates/06-handoff.md");
  it("06-handoff.md carries the Documentation Impact section before Follow-Ups", () => {
    const start = handoffTemplate.indexOf("## Documentation Impact");
    expect(start).toBeGreaterThan(-1);
    expect(handoffTemplate.indexOf("## Follow-Ups")).toBeGreaterThan(start);
  });

  it("06-handoff.md's Documentation Impact line offers exactly the three forms", () => {
    const lines = handoffTemplate.split("\n");
    const heading = lines.indexOf("## Documentation Impact");
    const followUps = lines.indexOf("## Follow-Ups");
    const section = lines.slice(heading, followUps);
    expect(section).toContain(
      "- <!-- none (<reason>) | updated: <paths> | follow-up: <task> -->",
    );
  });
});
