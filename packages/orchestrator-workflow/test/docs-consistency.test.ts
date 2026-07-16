import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { READ_ONLY_ROLES, ROLES } from "../src/models.js";
import { readAsset } from "../src/assets.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function readDoc(name: string): string {
  return readFileSync(`${PACKAGE_DIR}/${name}`, "utf8");
}

const sortedRoles = [...ROLES].sort();

/**
 * Guards the enumeration sites that actually drifted when the explorer role
 * was added in 0.4.0. Each check targets the specific list, not the whole
 * document, so a role missing from one enumeration fails even while the role
 * name still appears elsewhere in prose.
 */
describe("docs enumerate every installed role", () => {
  const installAgentMd = readDoc("INSTALL-AGENT.md");
  const readmeMd = readDoc("README.md");
  const agentsMdSection = readAsset("agents-md-section.md");

  it("README model-preselection table has one row per role", () => {
    for (const role of ROLES) {
      expect(readmeMd).toMatch(new RegExp(`^\\| ${role} \\|`, "m"));
    }
  });

  it("INSTALL-AGENT.md write-surface brace lists name every role", () => {
    const braceLists = [...installAgentMd.matchAll(/agents\/\{([^}]+)\}/g)];
    expect(braceLists.length).toBeGreaterThan(0);
    for (const [, list] of braceLists) {
      const listed = list.split(",").map((entry) => entry.trim());
      expect(listed.sort()).toEqual(sortedRoles);
    }
  });

  it("INSTALL-AGENT.md --models example names every role", () => {
    for (const role of ROLES) {
      expect(installAgentMd).toContain(`${role}=<model>`);
    }
  });

  it("INSTALL-AGENT.md manifest example has one models key per role", () => {
    const jsonBlocks = [...installAgentMd.matchAll(/```json\n([\s\S]*?)```/g)];
    const manifestBlock = jsonBlocks
      .map((match) => match[1])
      .find((block) => block.includes('"kit": "orchestrator-workflow"'));
    expect(manifestBlock).toBeDefined();
    const manifest = JSON.parse(manifestBlock as string) as {
      models: Record<string, string>;
    };
    expect(Object.keys(manifest.models).sort()).toEqual(sortedRoles);
  });

  it("agents-md-section per-role model preferences bullet lists every role", () => {
    const match = agentsMdSection.match(
      /Per-role model preferences \(([^)]+)\)/,
    );
    expect(match).toBeTruthy();
    const listed = (match as RegExpMatchArray)[1]
      .split(",")
      .map((entry) => entry.trim().replace(/ /g, "-"));
    expect(listed.sort()).toEqual(sortedRoles);
  });
});

/** Collapse line wraps so phrase assertions hold regardless of wrapping. */
function unwrap(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("review gate ships in the policy, skill, and handoff template", () => {
  const agentsMdSection = unwrap(readAsset("agents-md-section.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const handoffTemplate = readAsset("templates/06-handoff.md");

  it("policy section carries the review gate", () => {
    expect(agentsMdSection).toContain("### Review gate");
    expect(agentsMdSection).toContain(
      "block final acceptance until fixed or explicitly waived",
    );
    expect(agentsMdSection).toContain("waived by the operator");
  });

  it("skill decide-acceptance step carries the gate", () => {
    expect(skillMd).toContain(
      "block acceptance until fixed or explicitly waived",
    );
    expect(skillMd).toContain("Accepted Waivers section of `06-handoff.md`");
  });

  it("handoff template has the Accepted Waivers section", () => {
    expect(handoffTemplate).toContain("## Accepted Waivers");
    expect(handoffTemplate).toContain("| Finding | Severity | Rationale |");
  });

  it("the soft definition-of-done wording stays gone", () => {
    expect(agentsMdSection).not.toContain(
      "addressed or consciously accepted by the orchestrator",
    );
  });
});

describe("instruction trust boundary ships in policy, skill, and agent prompts", () => {
  const agentsMdSection = unwrap(readAsset("agents-md-section.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("agents-md-section contains the subsection heading", () => {
    expect(agentsMdSection).toContain("### Instruction trust boundary");
  });

  it("agents-md-section contains the key phrase", () => {
    expect(agentsMdSection).toContain("data, not instructions");
  });

  it("policy carries the conflict and surface-not-follow rules", () => {
    expect(agentsMdSection).toContain("trusted instructions win");
    expect(agentsMdSection).toContain("never followed");
    expect(agentsMdSection).toContain("task assignments to subagents");
  });

  it("skill/SKILL.md contains the section heading", () => {
    expect(skillMd).toContain("## Instruction trust boundary");
  });

  it("skill body carries the conflict rule", () => {
    expect(skillMd).toContain("the trusted instruction wins");
    expect(skillMd).toContain("the orchestrator's task assignments");
  });

  for (const role of ROLES) {
    it(`agents/${role}.md treats content as data not instructions`, () => {
      const agentMd = unwrap(readAsset(`agents/${role}.md`));
      expect(agentMd).toContain("data, not instructions");
      if (role === "reviewer") {
        expect(agentMd).toContain("raise it as a finding");
      } else {
        expect(agentMd).toContain("report it as a risk or open question");
      }
    });
  }
});

describe("read-only posture is documented for exactly the read-only roles", () => {
  const installAgentMd = unwrap(readDoc("INSTALL-AGENT.md"));
  const readmeMd = unwrap(readDoc("README.md"));
  const writableRoles = ROLES.filter((role) => !READ_ONLY_ROLES.has(role));

  // Each doc names the applicable roles immediately before the tool-restriction
  // marker. Capture that role phrase and assert it lists exactly the read-only
  // roles, so adding a role to READ_ONLY_ROLES without documenting it (or
  // documenting a writable role as read-only) fails here. Guards the
  // INSTALL-AGENT.md / README.md sibling-drift that the 0.7.1 reviewer fix hit.
  function assertPostureScopedToReadOnly(
    doc: string,
    phraseRegex: RegExp,
    label: string,
  ): void {
    const phrases = [...doc.matchAll(phraseRegex)].map((match) => match[1]);
    expect(
      phrases.length,
      `${label}: no read-only posture phrase matched ${phraseRegex}`,
    ).toBeGreaterThan(0);
    for (const phrase of phrases) {
      for (const role of READ_ONLY_ROLES) {
        expect(
          phrase,
          `${label}: read-only role "${role}" missing from "${phrase}"`,
        ).toMatch(new RegExp(`\\b${role}\\b`));
      }
      for (const role of writableRoles) {
        expect(
          phrase,
          `${label}: writable role "${role}" wrongly documented as read-only in "${phrase}"`,
        ).not.toMatch(new RegExp(`\\b${role}\\b`));
      }
    }
  }

  it("INSTALL-AGENT.md scopes the read-only posture to the read-only roles", () => {
    assertPostureScopedToReadOnly(
      installAgentMd,
      /[Ff]or the ([-\w ,]+?) roles? additionally/g,
      "INSTALL-AGENT.md",
    );
  });

  it("README.md scopes the read-only posture to the read-only roles", () => {
    assertPostureScopedToReadOnly(
      readmeMd,
      /read-only ([-\w ,]+?) also gets?/g,
      "README.md",
    );
  });
});

describe("discovery prefers curated knowledge before hand-mapping terrain", () => {
  const explorerMd = unwrap(readAsset("agents/explorer.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("explorer prompt checks for a curated knowledge bundle before mapping terrain by hand", () => {
    expect(explorerMd).toContain("Before mapping terrain by hand");
    expect(explorerMd).toContain("curated knowledge bundle");
    expect(explorerMd).toContain("docs/okf/");
    expect(explorerMd).toContain("leads to verify, not as ground truth");
  });

  it("explorer prompt prefers a connected semantic code-search tool over raw grep", () => {
    expect(explorerMd).toContain("semantic code-search tool is connected");
    expect(explorerMd).toContain("prefer it over raw grep for");
  });

  it("SKILL.md Discover step mentions checking for a curated knowledge bundle", () => {
    expect(skillMd).toContain("**Discover (optional, read-only).**");
    expect(skillMd).toContain("check for a curated knowledge bundle");
    expect(skillMd).toContain("before mapping terrain by hand");
    expect(skillMd).toContain("semantic code-search tool over raw grep");
  });

  it("the guidance stays tool-agnostic: no specific tool name is hardcoded", () => {
    for (const doc of [explorerMd, skillMd]) {
      expect(doc).not.toContain("codebase-oracle");
      expect(doc).not.toContain("oracle_search");
      expect(doc).not.toContain("oracle_query");
    }
  });
});

/**
 * 0.12.0's symmetric counterpart to the 0.8.0 discovery-side rule above:
 * discovery consumes a curated knowledge bundle before mapping terrain by
 * hand, and this hook keeps that bundle current after the change lands.
 * Each check pins one load-bearing element (source-overlap check, the two
 * possible responses, the validator run, and the explicit non-gate
 * optionality) so hollowing out the hook's wording fails at least one
 * assertion.
 */
describe("hand off keeps a curated knowledge bundle current", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const handoffTemplate = readAsset("templates/06-handoff.md");

  it("SKILL.md Hand off step checks for a curated knowledge bundle", () => {
    // Anchored to the hook's own opening phrase: "curated knowledge bundle"
    // and "docs/okf/" also occur in the step-2 discovery rule, so pinning
    // them alone would not detect deletion of the Hand off hook.
    expect(skillMd).toContain(
      "Before filling `06-handoff.md`, apply this optional guidance: when the repo carries a curated knowledge bundle",
    );
  });

  it("the hook performs a source-overlap check", () => {
    expect(skillMd).toContain(
      "whether the change touches paths any bundle doc claims as sources",
    );
  });

  it("the hook names both responses: update the docs or record a follow-up task", () => {
    expect(skillMd).toContain(
      "update the affected docs (re-verify and re-stamp) or record a follow-up task",
    );
  });

  it("the hook runs the bundle validator when one is available, framed as an example", () => {
    expect(skillMd).toContain("run the bundle validator when one is available");
    expect(skillMd).toContain("okf-kit check");
  });

  it("the hook states the non-gate optionality explicitly", () => {
    expect(skillMd).toContain("apply this optional guidance");
    expect(skillMd).toContain("Repos without a bundle are unaffected");
  });

  it("06-handoff.md carries the optional Knowledge Bundle section with the outcome vocabulary", () => {
    expect(handoffTemplate).toContain("## Knowledge Bundle");
    expect(unwrap(handoffTemplate)).toContain(
      "Outcome: updated | not affected | follow-up filed.",
    );
  });

  it("06-handoff.md marks the Knowledge Bundle section as optional and bundle-scoped", () => {
    const start = handoffTemplate.indexOf("## Knowledge Bundle");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = handoffTemplate.indexOf("## Follow-Ups");
    expect(end).toBeGreaterThan(start);
    const section = handoffTemplate.slice(start, end);
    expect(section).toContain("Optional");
    expect(section).toContain("curated knowledge bundle");
  });
});

describe("run-base fill instruction ships in the skill", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("SKILL.md instructs filling the run-base marker at run creation", () => {
    expect(skillMd).toContain("run-base");
    expect(skillMd).toContain("git rev-parse HEAD");
    expect(skillMd).toContain("before the first implementation commit");
  });
});

/**
 * Guards the subagent misfire rule added after a live incident: a reviewer
 * spawn returned in 5s with 0 tool uses, handing back harness boilerplate
 * instead of the reviewer output contract. Each assertion pins one
 * load-bearing element of the rule (detection signals, the resume/respawn
 * response, the 03-decisions.md record, and the review-gate consequence) so
 * deleting or hollowing out the rule paragraph fails at least one check.
 */
describe("subagent misfire rule ships in the skill", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("carries the section heading", () => {
    expect(skillMd).toContain("## Subagent misfire rule");
  });

  it("names both detection signals", () => {
    expect(skillMd).toContain(
      "does not parse against its role's output contract",
    );
    expect(skillMd).toContain("returns near-instantly with no tool activity");
  });

  it("scopes the no-tool-activity signal so valid tool-free returns are not misfires", () => {
    expect(skillMd).toContain("a misfire signal rather than proof");
    expect(skillMd).toContain(
      "only if it is contract-valid and the assignment was answerable from the context supplied with it",
    );
  });

  it("states the resume-or-respawn response and never treats the output as evidence", () => {
    expect(skillMd).toContain("resume or respawn the subagent");
    expect(skillMd).toContain(
      "never fold the non-contract output into run state or count it as a completed step",
    );
  });

  it("requires recording the misfire in 03-decisions.md", () => {
    expect(skillMd).toContain("Record every misfire in `03-decisions.md`");
  });

  it("states the review-gate consequence", () => {
    expect(skillMd).toContain("a misfired review is not a review");
    expect(skillMd).toContain("never satisfies the review gate");
  });
});

/**
 * The read-only posture is tool-level only for Edit/Write/NotebookEdit; Bash
 * mutation is guarded by instruction alone. README must say so honestly
 * instead of implying full closure (the residual bit in practice: a reviewer
 * ran `git checkout` and discarded uncommitted work).
 */
describe("README names the Bash residual honestly", () => {
  it("states instruction-only guarding for Bash without claiming closure", () => {
    const readmeMd = unwrap(readDoc("README.md"));
    expect(readmeMd).toContain("guarded by instruction only");
    expect(readmeMd).toContain("nothing technically prevents it");
    expect(readmeMd).toContain("out of this kit's scope");
  });
});

/**
 * The task-slicer output schema must be a lossless superset of the subagent
 * input contract, so the orchestrator copies task-slicer fields into the
 * implementer contract instead of inventing them. These checks pin the
 * list-shaped task fields in both places that carry the slicer output shape
 * (SKILL.md's contract block and the installed task-slicer.md prompt's
 * output structure), derive the required field set from the subagent input
 * contract itself (so a field added there cannot silently go missing here),
 * pin the 02-tasks.md template sections they map to, and pin the
 * 1:1-mapping sentence. Extraction targets the specific yaml block / task
 * item rather than the whole document, so a field present only in prose
 * elsewhere still fails here.
 */
describe("task slicer output schema is a superset of the implementer input contract", () => {
  const skillMdRaw = readAsset("skill/SKILL.md");
  const taskSlicerRaw = readAsset("agents/task-slicer.md");
  const tasksTemplate = readAsset("templates/02-tasks.md");

  // Every list-shaped field a slicer task carries; suggested_tests has no
  // counterpart in the subagent input contract (tests are not part of that
  // contract) but is required by the 02-tasks.md template and the workflow
  // narrative, so it ships alongside the mirrored fields.
  const listShapedTaskFields = [
    "relevant_files",
    "relevant_docs",
    "acceptance_criteria",
    "constraints",
    "suggested_tests",
    "allowed_changes",
    "forbidden_changes",
  ];

  /** Extracts the first ```yaml fenced block found after `heading` in `doc`. */
  function yamlBlockAfter(doc: string, heading: string): string {
    const headingIndex = doc.indexOf(heading);
    expect(headingIndex, `heading "${heading}" not found`).toBeGreaterThanOrEqual(0);
    const match = doc.slice(headingIndex).match(/```yaml\n([\s\S]*?)```/);
    expect(match, `no yaml block found after "${heading}"`).toBeTruthy();
    return (match as RegExpMatchArray)[1];
  }

  /** A field at task-item indentation, carrying the same `- ""` list shape
   * as the subagent input contract's list fields. */
  function fieldWithListShape(field: string): RegExp {
    return new RegExp(`^ {4}${field}:\\n {6}- ""$`, "m");
  }

  it("SKILL.md's task slicer output contract block carries the list-shaped task fields with the mirrored list shape", () => {
    const block = yamlBlockAfter(skillMdRaw, "## Task slicer output contract");
    for (const field of listShapedTaskFields) {
      expect(
        block,
        `missing "${field}:" (or wrong list shape) in SKILL.md's task slicer output contract`,
      ).toMatch(fieldWithListShape(field));
    }
  });

  it("task-slicer.md's output structure carries the list-shaped task fields with the mirrored list shape", () => {
    const block = yamlBlockAfter(taskSlicerRaw, "Return exactly this structure");
    for (const field of listShapedTaskFields) {
      expect(
        block,
        `missing "${field}:" (or wrong list shape) in task-slicer.md's output structure`,
      ).toMatch(fieldWithListShape(field));
    }
  });

  it("no field required by the subagent input contract is absent from the slicer output schema", () => {
    const subagentBlock = yamlBlockAfter(skillMdRaw, "## Subagent input contract");
    const slicerBlock = yamlBlockAfter(skillMdRaw, "## Task slicer output contract");
    // Derive the required set from the subagent input contract itself so a
    // field added there cannot silently go missing from the slicer output.
    // Delegation mechanics are what the orchestrator supplies when spawning
    // (role, task_id, the context/expected_output wrappers), not per-task
    // planning output the slicer must produce.
    const delegationMechanics = ["role", "task_id", "context", "expected_output", "format"];
    const topLevel = [...subagentBlock.matchAll(/^(\w+):/gm)].map((m) => m[1]);
    const contextChildren = [...subagentBlock.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    const required = [...topLevel, ...contextChildren].filter(
      (field) => !delegationMechanics.includes(field),
    );
    // Guard the extraction itself: these two must be part of the derived set,
    // otherwise the regexes above rotted and the loop below proves nothing.
    expect(required).toContain("relevant_docs");
    expect(required).toContain("goal");
    for (const field of required) {
      expect(
        slicerBlock,
        `subagent input contract requires "${field}" but the slicer output schema does not carry it`,
      ).toMatch(new RegExp(`^ {4}${field}:`, "m"));
    }
  });

  it("both slicer output copies carry the same task fields in the same order", () => {
    const fieldsOf = (block: string) =>
      [...block.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
    const skillFields = fieldsOf(
      yamlBlockAfter(skillMdRaw, "## Task slicer output contract"),
    );
    const slicerFields = fieldsOf(
      yamlBlockAfter(taskSlicerRaw, "Return exactly this structure"),
    );
    expect(skillFields.length).toBeGreaterThan(0);
    expect(slicerFields).toEqual(skillFields);
  });

  it("SKILL.md's task slicer output contract keeps id, title, goal, relevant_files, acceptance_criteria, dependencies, and risk in order around the new fields", () => {
    const block = yamlBlockAfter(skillMdRaw, "## Task slicer output contract");
    const order = [
      "id: T-001",
      "title:",
      "goal:",
      "relevant_files:",
      "relevant_docs:",
      "acceptance_criteria:",
      "constraints:",
      "suggested_tests:",
      "allowed_changes:",
      "forbidden_changes:",
      "dependencies:",
      "risk:",
    ];
    let cursor = -1;
    for (const token of order) {
      const idx = block.indexOf(token);
      expect(idx, `"${token}" not found in task slicer output contract`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("02-tasks.md carries Allowed Changes and Forbidden Changes sections", () => {
    expect(tasksTemplate).toContain("**Allowed Changes**");
    expect(tasksTemplate).toContain("**Forbidden Changes**");
  });

  it("02-tasks.md sections map 1:1 to the slicer output fields, in order", () => {
    const sectionOrder = [
      "**Goal**",
      "**Relevant Files / Areas**",
      "**Relevant Docs**",
      "**Acceptance Criteria**",
      "**Constraints**",
      "**Suggested Tests**",
      "**Allowed Changes**",
      "**Forbidden Changes**",
      "**Dependencies**",
      "**Risk**",
    ];
    let cursor = -1;
    for (const heading of sectionOrder) {
      const idx = tasksTemplate.indexOf(heading);
      expect(idx, `section "${heading}" not found`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("SKILL.md documents the 1:1 field mapping from slicer output into the subagent input contract", () => {
    const unwrapped = unwrap(skillMdRaw);
    expect(unwrapped).toContain(
      "copies each task's goal, relevant_files, relevant_docs, acceptance_criteria, constraints, allowed_changes, and forbidden_changes 1:1 into the subagent input contract",
    );
  });

  it("the step-4 narrative and the task-slicer rule enumerate the contract's per-task field set", () => {
    const enumerationAfter = (doc: string, anchor: string): string => {
      const idx = doc.indexOf(anchor);
      expect(idx, `anchor "${anchor}" not found`).toBeGreaterThanOrEqual(0);
      return doc.slice(idx, doc.indexOf(".", idx));
    };
    const proseFields = [
      "title",
      "goal",
      "relevant files",
      "relevant docs",
      "acceptance",
      "criteria",
      "constraints",
      "suggested tests",
      "allowed",
      "forbidden",
      "changes",
      "dependencies",
      "risk",
    ];
    const step4 = enumerationAfter(unwrap(skillMdRaw), "task carries:");
    const rule = enumerationAfter(unwrap(taskSlicerRaw), "include id, title");
    for (const field of proseFields) {
      expect(step4, `step-4 narrative missing "${field}"`).toContain(field);
      expect(rule, `task-slicer rule missing "${field}"`).toContain(field);
    }
  });

  it("task-slicer.md frames allowed/forbidden changes as scope boundaries, not implementation instructions", () => {
    const unwrapped = unwrap(taskSlicerRaw);
    expect(unwrapped).toContain("scope boundaries for the task");
    expect(unwrapped).toContain("not implementation instructions");
  });
});
