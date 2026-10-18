import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import {
  RUN_MODE_DEFAULT,
  RUN_MODE_MARKER,
  RUN_MODES,
} from "./run-mode-constants.js";

const runState = readAsset("skill/references/run-state-and-harness.md");
const goalTemplate = readAsset("templates/00-goal.md");
const summaryTemplate = readAsset("templates/04-implementation-summary.md");
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const HEADING = "## Run mode";

function runModeSection(): string {
  const start = runState.indexOf(`${HEADING}\n`);
  expect(start, `${HEADING} not found`).toBeGreaterThan(-1);
  const next = runState.indexOf("\n## ", start + HEADING.length);
  return unwrap(runState.slice(start, next === -1 ? undefined : next));
}

// The run mode marker is the contract: its line, its closed value set, and its
// fail-open default. The prose that defines each mode and the pointers to it
// are covered by the behaviour eval set and by review, not pinned.
describe("run mode section", () => {
  const section = runModeSection();

  it("is the last section of the reference, so no cited line above it moves", () => {
    const start = runState.indexOf(`${HEADING}\n`);
    expect(runState.indexOf("\n## ", start + HEADING.length)).toBe(-1);
    expect(runState.indexOf("## Harness notes")).toBeLessThan(start);
  });

  it("names the marker, the closed value set, and the fail-open default", () => {
    expect(section).toContain(RUN_MODE_MARKER);
    expect(section).toContain(
      `The value is one of \`${RUN_MODES[0]}\`, \`${RUN_MODES[1]}\`, or \`${RUN_MODES[2]}\`.`,
    );
    expect(section).toContain(RUN_MODE_DEFAULT);
  });
});

describe("run mode in the templates", () => {
  it("the 00-goal.md marker line is the one the section quotes", () => {
    expect(goalTemplate).toContain(`${RUN_MODE_MARKER}\n`);
  });

  it("the 00-goal.md comment names the closed value set and the default", () => {
    expect(goalTemplate).toContain(
      "<!-- Run mode: single | delegated | batch. A missing or unrecognised value means delegated. -->",
    );
  });

  it("04-implementation-summary.md ends with the batch-only Integration section", () => {
    const start = summaryTemplate.indexOf("\n## Integration\n");
    expect(start).toBeGreaterThan(-1);
    expect(summaryTemplate.indexOf("\n## ", start + 1)).toBe(-1);
    expect(unwrap(summaryTemplate.slice(start))).toContain(
      "Batch runs only (run mode `batch`)",
    );
  });
});
