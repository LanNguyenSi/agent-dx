import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

// Knowledge bundle docs travel with the task that changes their sources
// (agent-dx issue #353, tracker task 7049ee8d): the slicer lists them in
// `relevant_docs` with one marker, the implementer reads them first and
// re-stamps them in the same task, the reviewer verifies the re-stamp, and
// the hand-off bundle check is only a safety net.

const contracts = readAsset("skill/references/contracts.md");
const evidenceAndProbes = readAsset("skill/references/evidence-and-probes.md");
const skillMd = readAsset("skill/SKILL.md");
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

const MARKER = "(knowledge bundle; sources:";
const RESTAMP_TIMING =
  "in the same commit as the source change, or in a later commit of the same task";

describe("contracts.md defines the bundle doc entry in relevant_docs", () => {
  it("lists intersecting bundle docs in relevant_docs with the marker", () => {
    pin(
      contracts,
      "Knowledge bundle docs in `relevant_docs`: for each configured knowledge bundle (`knowledge` in `.ai/workflow/manifest.json`; default `docs/okf/`), every bundle doc whose `sources` intersect the task's `allowed_changes` is listed in `relevant_docs` with the bundle doc marker, written as `<doc path> (knowledge bundle; sources: <intersecting sources>)`.",
    );
  });

  it("makes the marker the one annotation the other roles key on", () => {
    pin(
      contracts,
      "The marker is the one annotation that identifies a bundle doc entry; the task slicer writes it, and the implementer and reviewer recognize bundle docs by it.",
    );
  });

  it("defines when a source intersects the allowed changes", () => {
    pin(
      contracts,
      "A source intersects when it names a path the task may change, a directory containing one, or a path inside a directory the task may change.",
    );
  });

  it("names a bundle tool as an example and the frontmatter as the fallback", () => {
    pin(
      contracts,
      "Compute the intersection with a bundle tool when one is available (for example `okf-kit docs-for <bundle dir> <path>... --repo-root <repo root>`), or read each bundle doc's `sources` frontmatter.",
    );
  });

  it("puts each listed doc in allowed_changes so it can be re-stamped", () => {
    pin(
      contracts,
      "Each such doc is also listed in `allowed_changes`, so the implementer can re-stamp it.",
    );
  });

  it("reuses relevant_docs instead of adding a contract field", () => {
    pin(
      contracts,
      "This reuses `relevant_docs`; the contract shape is unchanged.",
    );
  });
});

describe("the task slicer adds intersecting bundle docs at slicing", () => {
  it("task-slicer.md adds the docs with the marker and to allowed_changes", () => {
    pin(
      taskSlicerMd,
      "For each configured knowledge bundle, add every bundle doc whose `sources` intersect the task's `allowed_changes` to `relevant_docs` with the bundle doc marker `<doc path> (knowledge bundle; sources: <intersecting sources>)`, and list the doc in `allowed_changes` so the implementer can re-stamp it.",
    );
  });

  it("task-slicer.md computes the intersection tool-agnostically", () => {
    pin(
      taskSlicerMd,
      "Compute the intersection with a bundle tool when one is available (for example `okf-kit docs-for`), or read each bundle doc's `sources` frontmatter; contracts.md defines the marker and the intersection.",
    );
  });

  it("the Slice tasks step carries the same rule", () => {
    pin(
      evidenceAndProbes,
      "Every configured knowledge bundle doc whose `sources` intersect the task's `allowed_changes` goes into `relevant_docs` with the bundle doc marker and into `allowed_changes`, as contracts.md defines, so the task that changes a source re-verifies and re-stamps its doc itself, in the same commit as the source change, or in a later commit of the same task.",
    );
  });

  it("SKILL.md's Plan and slice step names the marker", () => {
    pin(
      skillMd,
      "List each configured knowledge bundle doc whose sources intersect a task's allowed changes in its `relevant_docs` with the bundle doc marker.",
    );
  });

  it("02-tasks.md's Relevant Docs list shows the marker", () => {
    pin(
      tasksTemplate,
      "<!-- each knowledge bundle doc whose sources intersect the allowed changes, marked `<doc path> (knowledge bundle; sources: <intersecting sources>)` (contracts.md defines the marker) -->",
    );
  });
});

describe("the implementer reads and re-stamps listed bundle docs", () => {
  it("reads marked docs first, as leads to verify", () => {
    pin(
      implementerMd,
      "Read every `relevant_docs` entry carrying the bundle doc marker `(knowledge bundle; sources: ...)` first, before mapping the code by hand, as leads to verify, not as ground truth.",
    );
  });

  it("re-verifies and re-stamps a doc whose source the task changes, in the same task", () => {
    pin(
      implementerMd,
      "When the task changes a source such a doc names, re-verify the doc's claims against the changed code and re-stamp it in the same commit as the source change, or in a later commit of the same task, so the re-stamp lands at or after the last source commit; never leave it for the hand-off.",
    );
  });

  it("reports a doc outside allowed_changes instead of editing it", () => {
    pin(
      implementerMd,
      "If the doc is outside your allowed_changes, report that as an open question instead of editing it.",
    );
  });
});

describe("the reviewer verifies the re-stamp and spot-checks a claim", () => {
  it("verifies the re-stamp and spot-checks one claim per touched doc", () => {
    pin(
      reviewerMd,
      "Knowledge bundle docs: for every `relevant_docs` entry carrying the bundle doc marker `(knowledge bundle; sources: ...)` whose source the diff changes, verify the doc was re-stamped in the same commit as the source change, or in a later commit of the same task (the bundle validator, for example `okf-kit check`, reports no stale-source finding for it), and spot-check one claim per touched bundle doc against the changed code.",
    );
  });

  it("makes a missing re-stamp or a contradicted claim a finding", () => {
    pin(
      reviewerMd,
      "A missing re-stamp or a claim the code contradicts is a finding.",
    );
  });
});

describe("the hand-off bundle check is a safety net", () => {
  it("evidence-and-probes.md's Hand off step frames the check as a safety net", () => {
    pin(
      evidenceAndProbes,
      "Bundle docs whose sources a task changes are listed in its `relevant_docs` at slicing (step 4) and re-stamped by that task, so this hand-off check is a safety net for sources the task list missed.",
    );
  });

  it("the hand-off overlap check covers only sources no task re-stamped", () => {
    pin(
      evidenceAndProbes,
      "check whether the change touches paths any bundle doc claims as sources that no task re-stamped;",
    );
  });

  it("SKILL.md's Hand off step is the same safety net", () => {
    pin(
      skillMd,
      "As a safety net for sources the task list missed: if a configured knowledge bundle (step 2) covers touched sources that no task re-stamped, update or re-verify it, or file a follow-up;",
    );
  });
});

describe("every role site agrees on the marker and the re-stamp timing", () => {
  it("each site names the one marker", () => {
    for (const [name, doc] of [
      ["contracts.md", contracts],
      ["task-slicer.md", taskSlicerMd],
      ["implementer.md", implementerMd],
      ["reviewer.md", reviewerMd],
      ["02-tasks.md", tasksTemplate],
    ] as const) {
      expect(unwrap(doc), name).toContain(MARKER);
    }
  });

  it("each re-stamp site names the same timing", () => {
    for (const [name, doc] of [
      ["implementer.md", implementerMd],
      ["reviewer.md", reviewerMd],
      ["evidence-and-probes.md", evidenceAndProbes],
    ] as const) {
      expect(unwrap(doc), name).toContain(RESTAMP_TIMING);
    }
  });

  it("no role contract adds a separate knowledge-docs field", () => {
    for (const doc of [contracts, taskSlicerMd, implementerMd, reviewerMd]) {
      expect(doc).not.toMatch(/knowledge_docs/);
    }
  });
});
