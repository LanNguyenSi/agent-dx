import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import {
  ALL_FILES_MODES,
  DEFINITION_BATCH,
  DEFINITION_DELEGATED,
  DEFINITION_SINGLE,
  MODE_SWITCH_RULE,
  REVIEWER_IN_ALL_MODES,
  RUN_MODE_DEFAULT,
  RUN_MODE_MARKER,
  RUN_MODES,
  SINGLE_MANDATORY_FILES,
} from "./run-mode-constants.js";

const runState = readAsset("skill/references/run-state-and-harness.md");
const skillMd = readAsset("skill/SKILL.md");
const goalTemplate = readAsset("templates/00-goal.md");
const summaryTemplate = readAsset("templates/04-implementation-summary.md");
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const HEADING = "## Run mode";

const DEFINITIONS = [DEFINITION_SINGLE, DEFINITION_DELEGATED, DEFINITION_BATCH];

function runModeSection(): string {
  const start = runState.indexOf(`${HEADING}\n`);
  expect(start, `${HEADING} not found`).toBeGreaterThan(-1);
  const next = runState.indexOf("\n## ", start + HEADING.length);
  return unwrap(runState.slice(start, next === -1 ? undefined : next));
}

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

  it.each(DEFINITIONS)("defines the mode: %s", (definition) => {
    expect(section).toContain(definition);
  });

  it("keeps delegated as the default flow with one implementer per slice and all seven run files", () => {
    expect(DEFINITION_DELEGATED).toContain("one implementer per slice");
    expect(section).toContain(
      `${DEFINITION_DELEGATED} This is the default and the flow the rest of this skill describes.`,
    );
    expect(section).toContain(ALL_FILES_MODES);
  });

  it("lists the mandatory run files of a single run", () => {
    expect(section).toContain(SINGLE_MANDATORY_FILES);
  });

  it("makes a mode switch a recorded decision, never a new run", () => {
    expect(section).toContain(MODE_SWITCH_RULE);
  });

  it("keeps the reviewer mandatory in every mode", () => {
    expect(section).toContain(
      `${REVIEWER_IN_ALL_MODES}: the mode decides who implements, never whether an independent review happens.`,
    );
  });

  it("separates the run mode from the neighbouring mode-shaped settings", () => {
    expect(section).toContain(
      "It is unrelated to the `mode` key in opencode agent frontmatter, to the install `profile`, and to a briefing's `review_method`.",
    );
  });

  it("argues the selection from the shape of the work, not from a harness property", () => {
    expect(section).toContain("Choose by the shape of the work");
    for (const word of ["compaction", "context window", "long session"]) {
      expect(section.toLowerCase()).not.toContain(word);
    }
  });
});

// Issue #339: names the roles that write into the run's `evidence/`
// subdirectory (the orchestrator, the implementer, and the reviewer) and
// states that the explorer and the advisor, being read-only, never do,
// closing a gap where the paragraph previously said only "Any role writes
// into it".
describe("evidence/ write-boundary roles", () => {
  const flat = unwrap(runState);

  it("names the orchestrator, the implementer, and the reviewer as the roles that write into evidence/", () => {
    expect(flat).toContain(
      "The orchestrator, the implementer, and the reviewer write into it",
    );
  });

  it("states that the explorer and the advisor never write into evidence/ or anywhere else", () => {
    expect(flat).toContain(
      "The explorer and the advisor are read-only roles and never write into it, or anywhere else.",
    );
  });
});

describe("run mode pointer sites", () => {
  const outsideSection = unwrap(
    runState.slice(0, runState.indexOf(`${HEADING}\n`)),
  );
  const skill = unwrap(skillMd);
  const probes = unwrap(readAsset("skill/references/evidence-and-probes.md"));

  it("the reference's Intent points to the section", () => {
    expect(outsideSection).toContain(
      "Who implements non-trivial work depends on the run mode (see Run mode, the last section).",
    );
  });

  it("SKILL.md routes to the section from the route list and from step 1", () => {
    expect(skill).toContain(
      "**Create or resume a run; choose its run mode; select a harness:**",
    );
    expect(skill).toContain(
      "choose and record the run mode (see the Run mode section of run-state and harness)",
    );
  });

  it("the sequence steps written for the default mode say so and point to the section", () => {
    expect(skill).toContain(
      "Steps 3 and 4 are written for the default run mode; the Run mode section of run-state and harness says what changes in the other two modes.",
    );
    expect(probes).toContain(
      "(Steps 3 to 6 are written for the default run mode; Run mode section of run-state and harness says what changes in the other two modes.)",
    );
  });

  it("no pointer site restates a mode definition or the file lists", () => {
    const restatable = [
      ...DEFINITIONS,
      SINGLE_MANDATORY_FILES,
      ALL_FILES_MODES,
      MODE_SWITCH_RULE,
    ];
    for (const text of restatable) {
      expect(outsideSection).not.toContain(text);
      expect(skill).not.toContain(text);
      expect(probes).not.toContain(text);
    }
    // A reworded restatement would slip past the byte pins above; the mode
    // names themselves must not appear as defined terms outside the section.
    for (const site of [outsideSection, skill, probes]) {
      for (const mode of RUN_MODES) {
        expect(site).not.toMatch(new RegExp(`\`${mode}\`\\s*[:=]`));
      }
    }
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
