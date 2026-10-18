import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const compact = (text: string) => text.replace(/\s+/g, " ");

/**
 * The implementer and reviewer prompts define their return fields in field
 * notes directly under the YAML structure they belong to. The sentences
 * below are the field semantics that used to sit as rule bullets far above
 * the structure; each must stay in the notes, so a reader finds a field's
 * meaning next to the field.
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
  const { notes } = splitAtFieldNotes("implementer");

  it.each([
    "link each claimed criterion to a result artifact in the implementation summary",
    "Empty `evidence_refs: []` means unresolved",
    "Account for every listed runbook in `runbooks_consulted`",
    "Put every complete-set result in `tests.executed`",
    "A claim with neither is prose, and the reviewer treats it as a finding.",
    "an output missing that field when probes were named is treated as a misfire, not evidence",
    "`file` and `anchor` (a line number or a unique surrounding string) locate the mutant",
    "`reason` is free text, required when `result` is `not_applicable`, empty otherwise",
    "Each item also carries `replayed`: `false` for a probe newly introduced this round.",
    "return `mutation_probes: []` rather than omitting the field",
    "`closed: true` when every site the round found",
    "On the task's first round `kind` is `not_applicable`",
    "report the full sha of every commit you produced on the task branch, in order",
    "Populate a non-empty `commits` field by pasting `git log --reverse --format=%H <base>..HEAD`",
  ])("keeps %s in the notes", (sentence) => {
    expect(notes).toContain(sentence);
  });
});

describe("reviewer prompt: field notes under the output structure", () => {
  const { notes } = splitAtFieldNotes("reviewer");

  it.each([
    "classify every finding by severity (low, medium, high, critical) and category. Recommend a concrete fix per finding.",
    "on a first round every finding is `new` by definition",
    "set `repeated` whenever a finding's defect class matches an earlier round's finding",
    "The orchestrator uses this to detect the review-round escalation budget's trigger.",
    "set `no` only after naming the base build and replaying the same reproduction in `reproduction`",
    "`acceptance_recommendation` is mandatory: always set it in your output; never leave it blank or omit it.",
    "record the method, sample size, and result against the implementer's claim here",
    "Put the independent complete-set outcome in `reproduction.result`",
    "For probes you run, apply the implementer's verdict-copy and manual-derivation rules to your own measurements",
    "Emit `withdrawn: []` when nothing was withdrawn.",
    "Report the method you actually applied in `method_applied`.",
    "emit `runbook_notes: []` when there is none.",
  ])("keeps %s in the notes", (sentence) => {
    expect(notes).toContain(sentence);
  });
});
