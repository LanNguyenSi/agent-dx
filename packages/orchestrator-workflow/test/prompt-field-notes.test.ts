import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const compact = (text: string) => text.replace(/\s+/g, " ");

/**
 * The implementer and reviewer prompts define their return fields in field
 * notes directly under the YAML structure they belong to, so a reader finds a
 * field's meaning next to the field. The notes' placement is the structure
 * pinned here. Of their sentences only the ones that fix an enum or an
 * empty-value rule of the machine contract are pinned; the sentences that
 * explain how to do the work are covered by the behaviour eval set and review.
 */
function splitAtFieldNotes(name: "implementer" | "reviewer") {
  const prompt = readAsset(`agents/${name}.md`);
  const fenceEnd = prompt.lastIndexOf("```");
  const notesStart = prompt.indexOf("Field notes.");
  expect(fenceEnd, `${name}: closing fence`).toBeGreaterThan(-1);
  expect(notesStart, `${name}: Field notes heading`).toBeGreaterThan(fenceEnd);
  return {
    rules: compact(prompt.slice(0, notesStart)),
    notes: compact(prompt.slice(notesStart)),
  };
}

describe("implementer prompt: field notes under the output structure", () => {
  it("has its field notes after the closing fence of the output structure", () => {
    const { notes } = splitAtFieldNotes("implementer");
    expect(notes.length).toBeGreaterThan("Field notes.".length);
  });
});

describe("reviewer prompt: field notes under the output structure", () => {
  const { notes } = splitAtFieldNotes("reviewer");

  it.each([
    "classify every finding by severity (low, medium, high, critical) and category. Recommend a concrete fix per finding.",
    "set `no` only after naming the base build and replaying the same reproduction in `reproduction`",
    "Emit `withdrawn: []` when nothing was withdrawn.",
    "emit `runbook_notes: []` when there is none.",
  ])("keeps %s in the notes", (sentence) => {
    expect(notes).toContain(sentence);
  });
});
