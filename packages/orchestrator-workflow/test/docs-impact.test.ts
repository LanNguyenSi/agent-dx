import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

/**
 * Human-facing documentation is a checklist item of every run: the handoff
 * template states the documentation impact, and the reviewer flags a
 * user-visible or architectural change that updates no human-facing
 * documentation and gives no reason or follow-up (issue #355). The hand-off
 * steps in SKILL.md and evidence-and-probes.md name documentation impact
 * among what the orchestrator records and reports.
 */
describe("documentation impact in the definition of done", () => {
  const handoffTemplate = readAsset("templates/06-handoff.md");
  const reviewer = readAsset("agents/reviewer.md");
  const flatReviewer = reviewer.replace(/\s+/g, " ");

  // The body of one numbered "Hand off" step, up to the next blank line,
  // whitespace-flattened so a rewrap does not break the pin.
  const handOffStep = (text: string, marker: string): string => {
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf("\n\n", start);
    return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
  };

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

  it("the Hand off steps list documentation impact among what is recorded and reported", () => {
    const probesStep = handOffStep(
      readAsset("skill/references/evidence-and-probes.md"),
      "9. **Hand off.**",
    );
    expect(probesStep).toContain(
      "report to the operator: what changed, why, how it was verified, known risks, accepted waivers, documentation impact (none with a reason, updated paths, or a follow-up), suggested next step.",
    );
    const skillStep = handOffStep(
      readAsset("skill/SKILL.md"),
      "6. **Hand off.**",
    );
    expect(skillStep).toContain(
      "Record what changed, evidence, risks, accepted waivers, documentation impact (none with a reason, updated paths, or a follow-up), and follow-ups.",
    );
  });
});
