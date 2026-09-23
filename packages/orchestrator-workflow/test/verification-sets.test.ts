import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readAsset as readRawAsset } from "../src/assets.js";

const references = [
  "run-state-and-harness.md",
  "evidence-and-probes.md",
  "contracts.md",
  "review-and-recovery.md",
];
const skill = [
  readRawAsset("skill/SKILL.md"),
  ...references.map((name) => readRawAsset(`skill/references/${name}`)),
].join("\n\n");
const compact = (text: string) => text.replace(/\s+/g, " ");
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(`${packageDir}/README.md`, "utf8");
const exampleFence = readme.match(
  /## Verification sets\n[\s\S]*?```json\n([\s\S]*?)\n```/,
);
if (!exampleFence) {
  throw new Error("README verification-set JSON example is missing");
}
const example = JSON.parse(exampleFence[1]) as {
  format: string;
  preflight: { kind: string; name: string; cwd: string; argv: string[] };
  extras: Array<{
    kind: string;
    name: string;
    phase: string;
    cwd: string;
    argv: string[];
  }>;
};

describe("documented verification sets", () => {
  it("parses the README worked example with one preflight executor and ordered extras", () => {
    expect(example.format).toBe("orchestrator-workflow-verification-set/v1");
    expect(example.preflight).toMatchObject({
      kind: "preflight",
      name: "preflight",
      cwd: ".",
      argv: ["preflight", "run", ".", "--json"],
    });
    expect(example.extras.map((step) => step.phase)).toEqual([
      "before_preflight",
      "after_preflight",
      "after_preflight",
    ]);
    for (const step of example.extras) {
      expect(step.kind).not.toBe("");
      expect(step.name).not.toBe("");
      expect(step.cwd).not.toBe("");
      expect(step.argv.length).toBeGreaterThan(0);
    }
    expect(example.extras).toContainEqual({
      kind: "bundlecheck",
      name: "knowledge-bundle",
      phase: "after_preflight",
      cwd: "packages/example",
      argv: ["npx", "okf-kit", "check", "docs/okf"],
    });
  });

  it("documents malformed and stale set references as unresolved rather than runtime validation", () => {
    expect(skill).toContain(
      "Malformed set JSON or shape is unresolved and does not authorize execution.",
    );
    expect(compact(skill)).toContain(
      "source edit makes an old result inapplicable to the new state, but does not itself require re-resolving an unchanged set",
    );
    expect(compact(skill)).toContain(
      "An unresolvable reference is stale and invalidates the result.",
    );
    expect(compact(skill)).toContain(
      "documented convention, not an OW execution engine or runtime schema validator",
    );
  });

  it("requires occurrence identity instead of collapsing duplicate kind/name results", () => {
    expect(skill).toContain("`(kind, name, occurrence)`");
    expect(compact(skill)).toContain("never a map entry overwritten by name");
  });

  it("orders frozen set execution around preflight rather than treating inventory as evidence", () => {
    expect(compact(skill)).toContain(
      "Any optional earlier inventory acquisition also needs prior command approval and is not full-set evidence.",
    );
    expect(compact(skill)).toContain(
      "definition is approved and frozen, each role attempt executes `before_preflight` extras in declaration order, then preflight, then `after_preflight` extras in declaration order",
    );
  });

  it("pins complete-role reporting, non-pass outcomes, and the docs bundle check", () => {
    const implementer = readRawAsset("agents/implementer.md");
    const reviewer = readRawAsset("agents/reviewer.md");
    for (const role of [implementer, reviewer]) {
      expect(compact(role)).toContain(
        "complete repository-bound `verification_set`",
      );
      expect(role).toContain("`(kind, name, occurrence)`");
      expect(compact(role)).toContain("limitation");
      expect(role).toContain("`skip`, `acknowledged`");
      expect(role).toContain("repository has `docs/okf/`");
    }
    expect(compact(skill)).toContain(
      "it does not export the underlying shell commands",
    );
    expect(compact(skill)).toContain(
      "A missing, extra, mismatched, or unresolved named result is a misfire",
    );
    expect(compact(skill)).toContain(
      "a reported failure is an honest failure, not a misfire",
    );
    expect(implementer).toContain(
      "Put every complete-set result in `tests.executed`",
    );
    expect(reviewer).toContain(
      "Put the independent complete-set outcome in `reproduction.result`",
    );
  });

  it("defines the reference-plus-digest form as the orchestrator's approval of the resolved argv (issue #335)", () => {
    const approvalCondition =
      "is the orchestrator's approval of every argv resolved from that frozen snapshot; a digest mismatch withdraws the approval and is reported as a misfire.";
    expect(compact(skill)).toContain(compact(approvalCondition));
    expect(compact(skill)).toContain(
      "The reference-plus-digest form shown above is sufficient by itself; neither role needs the argv repeated argument-by-argument to run it.",
    );
    expect(compact(skill)).toContain(
      "since a repository set is not authority to execute repository data on its own.",
    );
  });

  it("states the approval condition with identical wording in implementer.md and reviewer.md (issue #335)", () => {
    const implementer = readRawAsset("agents/implementer.md");
    const reviewer = readRawAsset("agents/reviewer.md");
    const approvalCondition =
      "A verification set named by reference plus its frozen digest and repository identity is the orchestrator's approval of every argv resolved from that frozen snapshot; a digest mismatch withdraws the approval and is reported as a misfire.";
    expect(compact(implementer)).toContain(compact(approvalCondition));
    expect(compact(reviewer)).toContain(compact(approvalCondition));
    for (const role of [implementer, reviewer]) {
      expect(compact(role)).toContain(
        "since a repository set is not authority to execute repository data on its own.",
      );
    }
  });

  it("adds digest and repository_identity sub-fields to the verification_set shape in the subagent input contract and both task slicer output copies (issue #335)", () => {
    const contracts = readRawAsset("skill/references/contracts.md");
    const taskSlicer = readRawAsset("agents/task-slicer.md");
    const inputContractShape = [
      "verification_set:",
      '  reference: ""',
      '  digest: ""',
      '  repository_identity: ""',
    ].join("\n");
    expect(contracts).toContain(inputContractShape);
    const taskCopyShape = [
      "    verification_set:",
      '      reference: ""',
      '      digest: ""',
      '      repository_identity: ""',
    ].join("\n");
    expect(contracts).toContain(taskCopyShape);
    expect(taskSlicer).toContain(taskCopyShape);
  });

  it("tells the task slicer and the 02-tasks.md template that the briefing's digest carries the approval (issue #335)", () => {
    const taskSlicer = readRawAsset("agents/task-slicer.md");
    const tasksTemplate = readRawAsset("templates/02-tasks.md");
    const digestCarriesApproval =
      "digest recorded in the briefing is what carries the orchestrator's approval of the resolved argv to the implementer and reviewer.";
    expect(compact(taskSlicer)).toContain(compact(digestCarriesApproval));
    expect(compact(tasksTemplate)).toContain(compact(digestCarriesApproval));
  });

  it("pins the authority-model comparison rule with identical wording across implementer.md, reviewer.md, and contracts.md (issue #335)", () => {
    const implementer = readRawAsset("agents/implementer.md");
    const reviewer = readRawAsset("agents/reviewer.md");
    const contracts = readRawAsset("skill/references/contracts.md");
    const comparisonRule =
      "Before acquisition or execution, compare the frozen snapshot's effective config and scripts, preflight executable identity/definition, and repository identity with the tree the role runs in; any mismatch withdraws the approval like a digest mismatch and is reported as a misfire, and a change the task's own diff makes to one of those components is outside the approval.";
    for (const doc of [implementer, reviewer, contracts]) {
      expect(compact(doc)).toContain(compact(comparisonRule));
    }
  });

  it("pins the criterion-4 scoping clauses in contracts.md, implementer.md, and reviewer.md via shared constants (issue #335)", () => {
    const implementer = readRawAsset("agents/implementer.md");
    const reviewer = readRawAsset("agents/reviewer.md");
    const contracts = readRawAsset("skill/references/contracts.md");
    const reachesOnlyPhrase = "That approval reaches only the frozen snapshot:";
    for (const doc of [implementer, reviewer, contracts]) {
      expect(compact(doc)).toContain(compact(reachesOnlyPhrase));
    }
    const contractsScopingSentence =
      "That approval reaches only the frozen snapshot: an unfrozen set, a changed script, or anything the snapshot does not capture still needs the orchestrator's explicit approval before acquisition or execution, since a repository set is not authority to execute repository data on its own.";
    expect(compact(contracts)).toContain(compact(contractsScopingSentence));
    const implementerStillRequires =
      "outside it still requires the orchestrator's explicit approval of the resolved repository configuration and every script/argument, since a repository set is not authority to execute repository data on its own.";
    expect(compact(implementer)).toContain(compact(implementerStillRequires));
    const reviewerStillRequires =
      "outside it still requires confirming the orchestrator approved the resolved effective configuration and scripts, since a repository set is not authority to execute repository data on its own.";
    expect(compact(reviewer)).toContain(compact(reviewerStillRequires));
  });

  it("pins evidence-and-probes.md's own digest-mismatch-misfire clause directly, not only through the concatenated skill text (issue #335)", () => {
    const evidenceAndProbes = readRawAsset(
      "skill/references/evidence-and-probes.md",
    );
    const digestMismatchMisfireClause =
      "a digest mismatch withdraws the approval and is reported as a misfire.";
    expect(compact(evidenceAndProbes)).toContain(
      compact(digestMismatchMisfireClause),
    );
    expect(compact(evidenceAndProbes)).toContain(
      compact(
        "This is the identical approval condition contracts.md's Subagent input contract pins in its own wording.",
      ),
    );
    expect(compact(evidenceAndProbes)).toContain(
      compact(
        "That approval reaches only the frozen snapshot; an unfrozen set, a changed script, or anything else the snapshot does not capture still needs the orchestrator's own explicit approval before acquisition or execution.",
      ),
    );
  });
});
