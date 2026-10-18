import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readAsset as readRawAsset } from "../src/assets.js";

// Verification sets are pinned as a contract: the worked example in
// docs/verification-sets.md parses, and the verification_set shape is the same
// in the subagent input contract and the task slicer output copies. The
// sentences that describe how a role executes and reports a set are covered by
// the behaviour eval set and by review, not pinned here. What is pinned is how
// the rules reach a briefing: they live in one reference, the orchestrator
// copies it only into a briefing that names a set, the reviewer flags a
// briefing that names a set without them, and the knowledge-bundle check
// obligation stays in both role prompts because it applies to every briefing.

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

  const unwrap = (text: string) => text.replace(/\s+/g, " ");

  it("ships the role-side rules as one skill reference that applies only to a briefing naming a set", () => {
    const rules = unwrap(
      readRawAsset("skill/references/verification-set-rules.md"),
    );
    expect(rules).toContain(
      "These rules apply only to a briefing that names a `verification_set`.",
    );
    for (const rule of [
      "Approval:",
      "Comparison:",
      "Path rule:",
      "Snapshot:",
      "Reporting:",
      "Outcomes:",
    ]) {
      expect(rules).toContain(`- ${rule}`);
    }
  });

  it("states the inclusion rule once, in evidence-and-probes.md: copy the reference only into a briefing that names a set", () => {
    const rule = unwrap(
      "Copy that reference, unedited and with its heading, into a briefing only when the briefing names a `verification_set`, after the briefing's YAML block; leave it out of every briefing that does not name a `verification_set`.",
    );
    const evidence = unwrap(
      readRawAsset("skill/references/evidence-and-probes.md"),
    );
    expect(evidence.split(rule)).toHaveLength(2);
    for (const other of ["skill/SKILL.md", "skill/references/contracts.md"]) {
      expect(unwrap(readRawAsset(other))).not.toContain(rule);
    }
  });

  it("has the reviewer flag a briefing that names a verification_set without carrying its rules", () => {
    expect(unwrap(readRawAsset("agents/reviewer.md"))).toContain(
      "- Verification set: when the briefing names a `verification_set`, it must also carry that set's rules, which you follow; a briefing that names a set without its rules is a finding.",
    );
  });

  it("has the implementer follow the rules a briefing carries with its verification_set", () => {
    expect(unwrap(readRawAsset("agents/implementer.md"))).toContain(
      "- When your briefing names a `verification_set`, it also carries that set's rules: follow them, and report a named set that arrives without them as an open question instead of running it.",
    );
  });

  it("keeps the knowledge-bundle check obligation in both role prompts as its own bullet", () => {
    expect(unwrap(readRawAsset("agents/implementer.md"))).toContain(
      "- Always include the bundle check for each configured knowledge bundle (`knowledge` in `.ai/workflow/manifest.json`; default `docs/okf/`), even for unrelated edits.",
    );
    expect(unwrap(readRawAsset("agents/reviewer.md"))).toContain(
      "- Bundle check: require the bundle check for each configured knowledge bundle (`knowledge` in `.ai/workflow/manifest.json`; default `docs/okf/`), regardless of edit scope.",
    );
  });

  it("keeps verification-set rule text out of both role prompts", () => {
    for (const role of ["agents/implementer.md", "agents/reviewer.md"]) {
      const prompt = readRawAsset(role);
      expect(prompt.match(/`verification_set`/g)).toHaveLength(1);
      expect(prompt).not.toContain("frozen snapshot");
      expect(prompt).not.toContain("(kind, name, occurrence)");
    }
  });
});
