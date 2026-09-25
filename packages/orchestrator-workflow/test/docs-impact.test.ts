import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

/**
 * Human-facing documentation is a checklist item of every run: the handoff
 * template states the documentation impact, and the reviewer flags a
 * user-visible or architectural change that updates no human-facing
 * documentation and gives no reason or follow-up (issue #355).
 */
describe("documentation impact in the definition of done", () => {
  const handoffTemplate = readAsset("templates/06-handoff.md");
  const reviewer = readAsset("agents/reviewer.md");
  const flatReviewer = reviewer.replace(/\s+/g, " ");

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

  it("reviewer.md names the trigger, the documentation check and the fallback sources", () => {
    expect(flatReviewer).toContain(
      "when the change is user-visible (a command, output, configuration, or documented behaviour) or architectural, check whether the diff updates the affected human-facing documentation (README, ADRs, architecture docs, end-user docs).",
    );
    expect(flatReviewer).toContain(
      "neither the briefing, the implementer's report, nor the run's `Documentation Impact` line in `06-handoff.md` gives a reason or a follow-up, that is a medium finding;",
    );
  });

  it("reviewer.md flags a missing or unexplained filled handoff line and exempts docs-only changes", () => {
    expect(flatReviewer).toContain(
      "once the handoff is filled, so is a missing `Documentation Impact` line or a `none` without a reason for such a change.",
    );
    expect(flatReviewer).toContain("A docs-only change is exempt.");
  });
});
