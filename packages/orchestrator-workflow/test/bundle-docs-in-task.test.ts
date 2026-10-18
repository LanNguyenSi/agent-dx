import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

// Knowledge bundle docs travel with the task that changes their sources: the
// task slicer lists them in `relevant_docs` with one marker that the other
// roles key on. The marker's definition is the contract, pinned at its one
// site, contracts.md. The sentences that tell each role what to do with a
// listed doc are covered by the behaviour eval set and by review.

const contracts = readAsset("skill/references/contracts.md");
const taskSlicerMd = readAsset("agents/task-slicer.md");
const implementerMd = readAsset("agents/implementer.md");
const reviewerMd = readAsset("agents/reviewer.md");
const tasksTemplate = readAsset("templates/02-tasks.md");

// Collapse line wraps and indentation so a pin matches a whole sentence
// regardless of where the asset wraps it.
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const pin = (doc: string, sentence: string) => {
  expect(unwrap(doc)).toContain(sentence);
};

describe("contracts.md defines the bundle doc entry in relevant_docs", () => {
  it("lists intersecting bundle docs in relevant_docs with the marker", () => {
    pin(
      contracts,
      "Knowledge bundle docs in `relevant_docs`: for each configured knowledge bundle (`knowledge` in `.ai/workflow/manifest.json`; default `docs/okf/`), every bundle doc whose `sources` intersect the task's `allowed_changes` is listed in `relevant_docs` with the bundle doc marker, written as `<doc path> (knowledge bundle; sources: <intersecting sources>)`.",
    );
  });
});

describe("no role contract adds a separate knowledge-docs field", () => {
  it("keeps the bundle doc entry inside relevant_docs", () => {
    for (const doc of [contracts, taskSlicerMd, implementerMd, reviewerMd]) {
      expect(doc).not.toMatch(/knowledge_docs/);
    }
  });
});

// The marker literal is shared between its producer (the task slicer and the
// 02-tasks.md template) and its consumers (implementer, reviewer), and
// contracts.md defines it. Only the literal is pinned here, not the prose
// around it.
const MARKER_LITERAL = "(knowledge bundle; sources:";

describe("every site that names the bundle doc marker carries the identical literal", () => {
  it.each([
    ["contracts.md", contracts],
    ["task-slicer.md", taskSlicerMd],
    ["implementer.md", implementerMd],
    ["reviewer.md", reviewerMd],
    ["02-tasks.md", tasksTemplate],
  ])("%s carries the marker literal", (_name, doc) => {
    expect(unwrap(doc)).toContain(MARKER_LITERAL);
  });
});
