import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { readAsset as readRawAsset } from "../src/assets.js";
import { composeCodexAgent } from "../src/codex.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_TIER, ROLE_TIERS } from "../src/models.js";

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

// Issue #336: a set whose literal repository paths point at the main
// checkout checks another tree than a delta that lives in a linked
// worktree. These two sentences are the rule's own wording; the identity
// rule is shared verbatim by every site that states the comparison rule.
const WORKTREE_RE_RESOLUTION_RULE =
  "When the diff for a repository comes from a linked worktree (whether that repository's run-base marker is keyed by the worktree's basename or the main repository's, or the run carries only the unkeyed marker), re-resolve every literal path into that repository in the set's argv and cwd to the corresponding path under that worktree's top level before freezing, and record the resolved paths in the frozen snapshot; a literal path left pointing at another checkout checks another tree, not the delta.";
const REPOSITORY_PATH_IDENTITY_RULE =
  "Repository identity includes the repository path (the worktree top level): in the comparison before acquisition or execution, repository identity means the repository and its path, not its revision, and that path is compared with the top level of the worktree the diff comes from, not with whichever checkout the role runs in; a set frozen against another checkout than the one the diff comes from (for example the main checkout while the diff comes from a linked worktree) withdraws the approval and is a misfire, not a pass, while a revision difference alone does not.";
const packageDir = fileURLToPath(new URL("..", import.meta.url));
// Moved from README.md to docs/verification-sets.md (README-restructure
// round 2); the only fenced JSON block in that file is the worked example,
// so no heading anchor is needed to disambiguate it from another table.
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
      expect(role).toContain(
        "each configured knowledge bundle (`knowledge` in\n  `.ai/workflow/manifest.json`; default `docs/okf/`)",
      );
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

  it("names verification_set.snapshot as the run-local path of the frozen snapshot record (issue #335)", () => {
    const contracts = readRawAsset("skill/references/contracts.md");
    const snapshotField =
      "`verification_set.snapshot` names the run-local path of the frozen snapshot record.";
    expect(compact(contracts)).toContain(compact(snapshotField));
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
      "Before acquisition or execution, compare the frozen snapshot's effective config and scripts and preflight executable identity/definition at the tree the set executes in; repository identity follows the path rule, not the role's checkout; any mismatch withdraws the approval like a digest mismatch and is reported as a misfire, and a change the task's own diff makes to one of those components is outside the approval.";
    for (const doc of [implementer, reviewer, contracts]) {
      expect(compact(doc)).toContain(compact(comparisonRule));
    }
  });

  it("pins the snapshot-comparand clause naming verification_set.snapshot and the scripts-definition pointer, with identical wording across implementer.md, reviewer.md, and contracts.md (issue #335)", () => {
    const implementer = readRawAsset("agents/implementer.md");
    const reviewer = readRawAsset("agents/reviewer.md");
    const contracts = readRawAsset("skill/references/contracts.md");
    const comparandClause =
      "The compared values are the ones recorded in the frozen snapshot at the run-local path `verification_set.snapshot` names; evidence-and-probes.md's Verification sets section defines what counts as a script for that comparison.";
    for (const doc of [implementer, reviewer, contracts]) {
      expect(compact(doc)).toContain(compact(comparandClause));
    }
  });

  it("identifies the approved set via the frozen snapshot and binds each result to the checked revision and dirty state, in implementer.md and reviewer.md (issue #335)", () => {
    const reviewer = readRawAsset("agents/reviewer.md");
    const bindingClause =
      "Use the frozen run-local snapshot (set path/digest, repository identity/revision and dirty state, effective config/scripts, and preflight executable identity/definition) to identify the approved set behind every reported result, and bind each result to the revision and dirty state actually checked; a revision or dirty-state difference from the snapshot alone does not withdraw the approval.";
    expect(compact(reviewer)).toContain(compact(bindingClause));
    expect(compact(readRawAsset("agents/implementer.md"))).toContain(
      compact(bindingClause),
    );
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
        "This is the identical approval condition contracts.md's Subagent input contract pins in its own wording; contracts.md additionally pins the per-role comparison rule that implementer.md and reviewer.md restate before acquisition or execution.",
      ),
    );
    expect(compact(evidenceAndProbes)).toContain(
      compact(
        "That approval reaches only the frozen snapshot; an unfrozen set, a changed script, or anything else the snapshot does not capture still needs the orchestrator's own explicit approval before acquisition or execution.",
      ),
    );
  });

  it("records the frozen snapshot at a run-local path the briefing names, and defines what counts as a script (issue #335)", () => {
    const evidenceAndProbes = readRawAsset(
      "skill/references/evidence-and-probes.md",
    );
    expect(compact(evidenceAndProbes)).toContain(
      compact(
        "Freeze the resolution in the run before execution; the orchestrator records that snapshot at a run-local path it names in the briefing.",
      ),
    );
    expect(compact(evidenceAndProbes)).toContain(
      compact(
        "\"Scripts\" here means every package-manager script entry plus every file an extra's or preflight's argv or such a script entry invokes directly, and repository configuration files the executed tools load count as effective configuration; code under test is not a component.",
      ),
    );
  });

  it("requires re-resolving literal repository paths to a linked worktree before freezing and recording them in the snapshot (issue #336)", () => {
    const evidenceAndProbes = readRawAsset(
      "skill/references/evidence-and-probes.md",
    );
    const section = compact(
      evidenceAndProbes.slice(
        evidenceAndProbes.indexOf("## Verification sets"),
        evidenceAndProbes.indexOf("# Persisted probe plans"),
      ),
    );
    expect(section).toContain(compact(WORKTREE_RE_RESOLUTION_RULE));
  });

  it("states the repository-path identity rule with identical wording in implementer.md, reviewer.md, contracts.md, and the Verification sets section (issue #336)", () => {
    const evidenceAndProbes = readRawAsset(
      "skill/references/evidence-and-probes.md",
    );
    const section = evidenceAndProbes.slice(
      evidenceAndProbes.indexOf("## Verification sets"),
      evidenceAndProbes.indexOf("# Persisted probe plans"),
    );
    for (const doc of [
      readRawAsset("agents/implementer.md"),
      readRawAsset("agents/reviewer.md"),
      readRawAsset("skill/references/contracts.md"),
      section,
    ]) {
      expect(compact(doc)).toContain(compact(REPOSITORY_PATH_IDENTITY_RULE));
    }
  });

  it("carries the repository-path identity rule into every rendered implementer and reviewer variant of every harness (issue #336)", () => {
    for (const role of ["implementer", "reviewer"] as const) {
      const codexBodies = [
        parse(composeCodexAgent(role, { model: "gpt-6-astra", effort: "high" }))
          .developer_instructions,
        ...ROLE_TIERS[role].map(
          (tier) =>
            parse(
              composeCodexAgent(
                role,
                { model: "gpt-6-astra", effort: tier },
                tier,
              ),
            ).developer_instructions,
        ),
      ];
      for (const body of codexBodies) {
        expect(compact(String(body))).toContain(REPOSITORY_PATH_IDENTITY_RULE);
      }
    }
    const target = mkdtempSync(join(tmpdir(), "ow-worktree-identity-"));
    try {
      runInit({
        targetDir: target,
        harnesses: ["claude", "opencode"],
        models: { ...DEFAULT_MODELS },
        opencodeModels: { reviewer: "anthropic/claude-opus-4-8" },
        opencodeClassModels: {
          small: "anthropic/claude-haiku-4-5",
          medium: "anthropic/claude-sonnet-4-6",
          large: "anthropic/claude-opus-4-8",
        },
        tiers: true,
      });
      for (const harness of [".claude", ".opencode"]) {
        for (const role of ["implementer", "reviewer"] as const) {
          for (const tier of ROLE_TIERS[role]) {
            const suffix = tier === DEFAULT_TIER[role] ? "" : `-${tier}`;
            const rendered = compact(
              readFileSync(
                join(target, harness, "agents", `${role}${suffix}.md`),
                "utf8",
              ),
            );
            expect(rendered, `${harness}/${role}${suffix}.md`).toContain(
              REPOSITORY_PATH_IDENTITY_RULE,
            );
          }
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
