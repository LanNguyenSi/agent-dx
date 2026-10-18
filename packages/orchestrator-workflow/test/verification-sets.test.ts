import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readAsset as readRawAsset } from "../src/assets.js";

// Verification sets are pinned as a contract: the worked example in
// docs/verification-sets.md parses, and the verification_set shape is the same
// in the subagent input contract and the task slicer output copies. The
// sentences that describe how a role executes and reports a set are covered by
// the behaviour eval set and by review, not pinned here.

const packageDir = fileURLToPath(new URL("..", import.meta.url));
// Moved from README.md to docs/verification-sets.md; the only fenced JSON
// block in that file is the worked example, so no heading anchor is needed
// to disambiguate it from another table.
const verificationSetsDoc = readFileSync(
  `${packageDir}/docs/verification-sets.md`,
  "utf8",
);
const exampleFence = verificationSetsDoc.match(/```json\n([\s\S]*?)\n```/);
if (!exampleFence) {
  throw new Error(
    "docs/verification-sets.md verification-set JSON example is missing",
  );
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
  it("parses the docs/verification-sets.md worked example with one preflight executor and ordered extras", () => {
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

  it("adds digest, repository_identity, and snapshot sub-fields to the verification_set shape in the subagent input contract and both task slicer output copies (issue #335)", () => {
    const contracts = readRawAsset("skill/references/contracts.md");
    const taskSlicer = readRawAsset("agents/task-slicer.md");
    const inputContractShape = [
      "verification_set:",
      '  reference: ""',
      '  digest: ""',
      '  repository_identity: ""',
      '  snapshot: ""',
    ].join("\n");
    expect(contracts).toContain(inputContractShape);
    const taskCopyShape = [
      "    verification_set:",
      '      reference: ""',
      '      digest: ""',
      '      repository_identity: ""',
      '      snapshot: ""',
    ].join("\n");
    expect(contracts).toContain(taskCopyShape);
    expect(taskSlicer).toContain(taskCopyShape);
  });
});
