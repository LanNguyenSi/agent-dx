import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLASS_MODELS,
  DEFAULT_MODELS,
  DEFAULT_TIER,
  READ_ONLY_ROLES,
  ROLES,
  ROLE_TIERS,
  TIER_DEFS,
} from "../src/models.js";
import type { Tier } from "../src/models.js";
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

/**
 * 0.13.0 added a placeholder/legend-row rule to SKILL.md's step 7, mirroring
 * the fail-closed comment pinned next to the row itself in
 * 05-review-findings.md (see template-markers.test.ts's "placeholder-row
 * fail-closed convention" describe block). This pins the SKILL.md side of
 * that same rule so a revert of the step-7 sentence fails a test here, not
 * just in the template.
 */
describe("findings-table placeholder-row rule ships in the skill", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("step 7 instructs replacing the placeholder row on findings transfer and deleting it for a zero-findings review", () => {
    expect(skillMd).toContain(
      "Replace the shipped placeholder/legend row with the transferred findings",
    );
    expect(skillMd).toContain("for a genuine zero-findings review");
    expect(skillMd).toContain("delete that row instead of leaving it in place");
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
 * 0.18.0 adds a concrete workaround for the near-instant, no-tool-activity
 * misfire signal, measured across repeated reviewer-subagent incidents where
 * a resume with the assignment explicitly repeated turned a misfired first
 * spawn into a contract-valid review. Pins the resume-over-respawn
 * preference, the repeat-the-assignment mechanic, the respawn fallback
 * condition, and the reviewer/model correlation noted as an open lead
 * rather than a proven cause. A same-day review-fix round then hardened
 * three more things: the "has resolved" claim is now bound to recorded
 * outcomes instead of asserted as a universal rate, the preference is
 * explicitly scoped away from a structurally different mid-run
 * watchdog-stall misfire class where resume did not work, and the
 * parenthetical signal definition itself is pinned.
 */
describe("the misfire rule prefers resume with a repeated assignment for the no-tool-activity signal", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("states the resume-over-respawn preference for this signal", () => {
    expect(skillMd).toContain(
      "For the near-instant, no-tool-activity signal specifically, prefer resume over a fresh respawn",
    );
  });

  it("states the repeat-the-assignment mechanic instead of a generic retry", () => {
    expect(skillMd).toContain(
      "send the same subagent a message that explicitly repeats the original assignment rather than a generic retry",
    );
  });

  it("states why resume beats a fresh respawn for this signal", () => {
    expect(skillMd).toContain(
      "resume keeps the subagent's prior turn in context while a fresh spawn starts cold and risks the same misfire again",
    );
  });

  it("pins the near-instant misfire signal's own parenthetical definition", () => {
    expect(skillMd).toContain(
      "(a return within seconds, zero tool calls, harness or system boilerplate instead of the output contract)",
    );
  });

  it("binds the 'has resolved on first resume' claim to recorded outcomes, not a universal rate", () => {
    expect(skillMd).toContain(
      "whose outcome was recorded (four so far) has resolved on the first resume attempt",
    );
  });

  it("states the respawn fallback is conditional on the resume attempt itself misfiring", () => {
    expect(skillMd).toContain(
      "fall back to a fresh respawn only if the resume attempt itself misfires the same way",
    );
  });

  it("notes the reviewer/model correlation as an open lead, not a confirmed cause", () => {
    expect(skillMd).toContain(
      "So far this signal has only been observed for the reviewer role, the one role whose default model differs from the other roles'",
    );
    expect(skillMd).toContain(
      "treat that correlation as an open lead worth watching as more incidents accumulate, not as a confirmed cause",
    );
  });

  it("the 'default model differs' claim is grounded in DEFAULT_MODELS, not asserted in prose alone", () => {
    const otherRoles = ROLES.filter((role) => role !== "reviewer");
    expect(otherRoles.length).toBeGreaterThan(0);
    for (const role of otherRoles) {
      expect(DEFAULT_MODELS.reviewer).not.toBe(DEFAULT_MODELS[role]);
    }
  });

  it("scopes the resume-over-respawn preference away from the mid-run watchdog-stall misfire class", () => {
    expect(skillMd).toContain(
      "This resume-over-respawn preference does not extend to a structurally different misfire class",
    );
    expect(skillMd).toContain(
      "treat a watchdog stall as outside this preference",
    );
  });

  it("states the watchdog-stall class did not resolve on resume and needed a fresh constrained respawn instead", () => {
    expect(skillMd).toContain(
      "did not resolve on resume in the one measured incident of that class, it stalled a second time, and only a fresh, explicitly constrained respawn produced a contract-valid review",
    );
  });
});

/**
 * 0.18.0 also hardens the installed reviewer prompt itself: force the first
 * turn to be a tool call so a text-only opening turn (harness boilerplate,
 * a restated-instructions preamble) cannot stand in for the review.
 */
describe("the reviewer prompt forces an immediate first tool call", () => {
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));

  it("instructs opening with a tool call before any analysis", () => {
    expect(reviewerMd).toContain(
      "Begin your very first turn with a tool call (read the diff or the changed files) before writing any analysis.",
    );
  });

  it("forbids a text-only opening turn", () => {
    expect(reviewerMd).toContain(
      "Do not open with commentary, a restatement of these instructions, or any other text-only turn.",
    );
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
    expect(
      headingIndex,
      `heading "${heading}" not found`,
    ).toBeGreaterThanOrEqual(0);
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
    const block = yamlBlockAfter(
      taskSlicerRaw,
      "Return exactly this structure",
    );
    for (const field of listShapedTaskFields) {
      expect(
        block,
        `missing "${field}:" (or wrong list shape) in task-slicer.md's output structure`,
      ).toMatch(fieldWithListShape(field));
    }
  });

  it("no field required by the subagent input contract is absent from the slicer output schema", () => {
    const subagentBlock = yamlBlockAfter(
      skillMdRaw,
      "## Subagent input contract",
    );
    const slicerBlock = yamlBlockAfter(
      skillMdRaw,
      "## Task slicer output contract",
    );
    // Derive the required set from the subagent input contract itself so a
    // field added there cannot silently go missing from the slicer output.
    // Delegation mechanics are what the orchestrator supplies when spawning
    // (role, task_id, the context/expected_output wrappers), not per-task
    // planning output the slicer must produce.
    const delegationMechanics = [
      "role",
      "task_id",
      "context",
      "expected_output",
      "format",
    ];
    const topLevel = [...subagentBlock.matchAll(/^(\w+):/gm)].map((m) => m[1]);
    const contextChildren = [...subagentBlock.matchAll(/^ {2}(\w+):/gm)].map(
      (m) => m[1],
    );
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
      expect(
        idx,
        `"${token}" not found in task slicer output contract`,
      ).toBeGreaterThan(cursor);
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

/**
 * 0.14.0 added a reproduction requirement to the reviewer contract: when
 * acceptance rests on empirical or probabilistic evidence, the reviewer must
 * independently reproduce it rather than transcribe the implementer's
 * reported numbers as-is. Motivated by a live incident (agent-dx run
 * 2026-07-18-harness-subprocess-test-deflake): an implementer's "8/8 green"
 * flake-rate claim on a maxWorkers-cap fix was overturned only because the
 * reviewer independently reran the suite and found 2/6 red on an independent
 * sample. Each check pins one load-bearing element (the narrow trigger
 * wording, the deterministic-check exclusion, the reviewer prompt's
 * second-person mirror, and the `reproduction` field shared byte-for-byte by
 * both output-contract copies) so hollowing out the clause or letting the
 * two copies drift apart fails at least one assertion here, the same way
 * the 0.13.0 placeholder-row rule is pinned above.
 */
describe("reproduction requirement ships in the skill and the reviewer prompt", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));

  it("step 7 states the narrow empirical-evidence trigger and the independent-reproduction rule", () => {
    expect(skillMd).toContain(
      'When acceptance rests on empirical or probabilistic evidence (flake rates, benchmarks, "n runs green", performance/timing numbers), the reviewer must',
    );
    expect(skillMd).toContain("independently reproduce it");
    expect(skillMd).toContain("not a re-read of the implementer's log");
  });

  it("step 7 excludes one-shot deterministic checks from the trigger", () => {
    expect(skillMd).toContain(
      "This does not apply to deterministic checks (a single test run, `tsc`, lint): only claims that could vary run to run trigger it.",
    );
  });

  it("the installed reviewer.md prompt carries the same rule in second-person voice", () => {
    expect(reviewerMd).toContain("reproduce it yourself");
    expect(reviewerMd).toContain(
      "Deterministic checks (a single test run, `tsc`, lint) do not trigger this.",
    );
  });

  it("both reviewer output contracts carry an identical reproduction field with all four sub-fields", () => {
    const field =
      'reproduction: method: "" sample_size: "" result: "" matches_implementer_claim: matched | mismatched | not_applicable';
    expect(skillMd).toContain(field);
    expect(reviewerMd).toContain(field);
  });

  it("matches_implementer_claim avoids bare yes/no (YAML 1.1 boolean synonyms)", () => {
    expect(skillMd).not.toMatch(/matches_implementer_claim:\s*yes\s*\|/);
    expect(reviewerMd).not.toMatch(/matches_implementer_claim:\s*yes\s*\|/);
  });

  it("the reproduction field is byte-for-byte identical between SKILL.md and reviewer.md (raw, not line-unwrapped)", () => {
    const extractReproductionBlock = (raw: string): string => {
      const match = raw.match(/^reproduction:\n(?:.+\n)*?```/m);
      expect(match, "reproduction block not found").toBeTruthy();
      return (match as RegExpMatchArray)[0].replace(/\n```$/, "");
    };
    const skillBlock = extractReproductionBlock(readAsset("skill/SKILL.md"));
    const reviewerBlock = extractReproductionBlock(
      readAsset("agents/reviewer.md"),
    );
    // Guard the extraction itself: a regex that silently matched nothing or
    // an empty span would make the equality check below vacuous.
    expect(skillBlock.length).toBeGreaterThan(20);
    expect(skillBlock).toBe(reviewerBlock);
  });
});

/**
 * 0.15.0 added `--profile minimal|full`: under `minimal` only the
 * implementer and reviewer roles are installed as named subagents, so the
 * Roles section's prior unconditional claim ("the explorer, slicer,
 * implementer, and reviewer roles are installed as named subagents") was
 * false for a minimal install. This pins the profile-aware caveat sentence
 * (the fix, reusing the pre-existing Codex "run inline" idiom) so it cannot
 * silently disappear again.
 */
describe("Roles section states which roles a minimal profile omits", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("carries the profile-aware caveat sentence", () => {
    expect(skillMd).toContain(
      "Only the roles this install's profile carries exist as named subagents (see `profile` in `.ai/workflow/manifest.json`); run any missing role inline with the same contract.",
    );
  });
});

/**
 * 0.16.0 hardened three contract-compliance gaps measured across a 16-round
 * dogfood: two implementer rounds omitted briefed-as-mandatory mutation
 * probes from their return entirely, one implementer wrote a false
 * "Verified by ..." claim into a source comment for a probe it never
 * measurably ran, and one reviewer omitted the mandatory
 * `acceptance_recommendation` field. This pins the implementer-side fixes:
 * the `mutation_probes` field (byte-identical between SKILL.md's reference
 * copy and the installed implementer.md prompt, the same rigor applied to
 * the 0.14.0 `reproduction` field above), the misfire-rule sentence that
 * treats an omission as a misfire when the assignment named probes, and the
 * claim-only-what-was-measured rule in the installed prompt.
 */
describe("mutation probes requirement ships in the skill and the implementer prompt", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const implementerMd = unwrap(readAsset("agents/implementer.md"));

  it("the installed implementer prompt instructs running and reporting named mutation probes", () => {
    expect(implementerMd).toContain("mutation probes to run");
    expect(implementerMd).toContain("mutation_probes");
    expect(implementerMd).toContain(
      "an output missing that field when probes were named is treated as a misfire, not evidence",
    );
  });

  it("the installed implementer prompt carries the claim-only-what-was-measured rule", () => {
    expect(implementerMd).toContain(
      "for a check you actually ran and measured yourself",
    );
    expect(implementerMd).toContain("never claim a run you did not execute");
  });

  it("the subagent misfire rule treats a missing mutation_probes field, when probes were named, as a misfire", () => {
    expect(skillMd).toContain(
      "does not parse against its role's output contract, including an implementer return that omits the `mutation_probes` field",
    );
    expect(skillMd).toContain("mutation probes to run");
  });

  it("both implementer output contracts carry an identical mutation_probes field (raw, not line-unwrapped)", () => {
    const extractMutationProbesBlock = (raw: string): string => {
      const match = raw.match(/^mutation_probes:\n(?: {2}.+\n)*/m);
      expect(match, "mutation_probes block not found").toBeTruthy();
      return (match as RegExpMatchArray)[0];
    };
    const skillBlock = extractMutationProbesBlock(readAsset("skill/SKILL.md"));
    const implementerBlock = extractMutationProbesBlock(
      readAsset("agents/implementer.md"),
    );
    // Guard the extraction itself, same as the reproduction-field test above.
    expect(skillBlock.length).toBeGreaterThan(20);
    expect(skillBlock).toBe(implementerBlock);
  });
});

/**
 * R2 fix-round on the same 0.16.0 mutation-probes contract (agent-tasks
 * 16637a96): the field shipped with no trigger the kit itself ever
 * produces (SKILL.md step 6 said nothing about naming probes, unlike the
 * reviewer-facing reproduction trigger step 7 gained in 0.14.0) and no
 * not-applicable signal (an implementer never given probes returned the
 * same placeholder block as one that silently dropped them). This pins
 * step 6's assignment-time instruction, its orchestrator-checkable
 * reference to the claim-only-what-was-measured rule, the `mutation_probes:
 * []` not-applicable clause added to both the SKILL.md reference paragraph
 * and the installed implementer.md prompt, and exact-name pins on the
 * shared field block and its prose enumeration. The exact-name pins matter
 * because the cross-copy equality check above only proves the two copies
 * match each other: renaming a sub-field identically in both copies passes
 * that check but must fail here.
 */
describe("mutation probe naming and not-applicable signal ship in step 6 and both contract copies", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const implementerMd = unwrap(readAsset("agents/implementer.md"));

  it("step 6 instructs naming mutation probes in the task assignment when acceptance rests on a must-fail-without-the-change test", () => {
    expect(skillMd).toContain(
      "When a task's acceptance rests on a test that must fail without the change, name the mutation probes to run in the task assignment",
    );
    expect(skillMd).toContain(
      "apply the mutant for real, observe the named test fail, restore, re-verify",
    );
  });

  it("step 6 carries an orchestrator-checkable reference to the claim-only-what-was-measured rule", () => {
    expect(skillMd).toContain("claim-only-what-was-measured");
  });

  it("both copies carry the not-applicable mutation_probes: [] clause", () => {
    const clause = "`mutation_probes: []` rather than omitting the field";
    expect(skillMd).toContain(clause);
    expect(implementerMd).toContain(clause);
  });

  it("both copies pin the mutation_probes field block by its exact sub-field names, not just cross-copy equality", () => {
    const field =
      'mutation_probes: - mutant: "" verified_applied_via: "" result: "" restored_verified: ""';
    expect(skillMd).toContain(field);
    expect(implementerMd).toContain(field);
  });

  it("both copies pin the field enumeration in prose", () => {
    const enumeration =
      "(mutant, verified_applied_via, result, restored_verified)";
    expect(skillMd).toContain(enumeration);
    expect(implementerMd).toContain(enumeration);
  });
});

/**
 * 0.16.0's third contract-compliance fix from the same dogfood: a reviewer
 * return omitted the mandatory `acceptance_recommendation` field, so the
 * orchestrator had to guess a verdict instead of asking the reviewer to
 * resupply it. Pins the mandatory rule in both the installed reviewer.md
 * prompt and SKILL.md's reference copy, plus SKILL.md's orchestrator-facing
 * ask-back response.
 */
describe("acceptance_recommendation mandatory rule ships in the skill and the reviewer prompt", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));

  it("the installed reviewer prompt marks acceptance_recommendation mandatory", () => {
    expect(reviewerMd).toContain(
      "`acceptance_recommendation` is mandatory: always set it in your output",
    );
  });

  it("SKILL.md marks the field mandatory and states the orchestrator's ask-back response", () => {
    expect(skillMd).toContain(
      "`acceptance_recommendation` is mandatory: every reviewer return must set it.",
    );
    expect(skillMd).toContain(
      "the orchestrator asks the reviewer to resupply it instead of inferring one from the findings list",
    );
  });
});

/**
 * 0.17.0 anchors a live review-fix-run lesson: a high-risk task whose
 * acceptance criteria allow recording a divergence instead of changing
 * behavior (its outcome undetermined at slice time) defaults to its own PR,
 * instead of being bundled with a lower-risk sibling task whose shipping
 * should not wait on it. Before this describe block existed, reverting the
 * SKILL.md step 4 and task-slicer.md prose additions alone left the full
 * suite green, so nothing pinned either copy. Pins the property-first
 * trigger phrasing, the retained quoted example, and the its-own-PR default
 * in both the SKILL.md reference copy and the installed task-slicer.md
 * prompt.
 */
describe("split-by-default rule for documented-divergence sub-tasks ships in the skill and the task-slicer prompt", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const taskSlicerMd = unwrap(readAsset("agents/task-slicer.md"));

  it("SKILL.md step 4 carries the property-first trigger and its retained example phrasing", () => {
    expect(skillMd).toContain(
      "whose acceptance criteria allow recording the divergence instead of changing behavior, so its outcome is undetermined at slice time",
    );
    expect(skillMd).toContain(
      '"... or record the divergence as a deliberate, documented boundary"',
    );
  });

  it("SKILL.md step 4 defaults the task to its own PR instead of bundling", () => {
    expect(skillMd).toContain(
      "is planned as its own PR (its own independently shippable unit) by default, not bundled with a lower-risk sibling task",
    );
  });

  it("the installed task-slicer.md prompt carries the same trigger and default", () => {
    expect(taskSlicerMd).toContain(
      "whose acceptance criteria allow recording the divergence instead of changing behavior, so its outcome is undetermined at slice time",
    );
    expect(taskSlicerMd).toContain(
      '"... or record the divergence as a deliberate, documented boundary"',
    );
    expect(taskSlicerMd).toContain(
      "is planned as its own PR (its own independently shippable unit) by default, not bundled with a lower-risk sibling task",
    );
  });
});

/**
 * 0.17.0 also anchors the diff-as-file reviewer briefing lesson: when the
 * reviewer's environment cannot use version control to see the diff, the
 * orchestrator supplies it as a pre-generated file instead of expecting the
 * reviewer to derive it, and the reviewer explicitly reports when it could
 * only reconstruct the delta some other way, instead of silently reviewing
 * less than the full change. A same-day fix-round added the provenance
 * anchor: the briefing names the base/head revision the diff was generated
 * from, and the reviewer states the base/head pair it reviewed in its
 * report. Pins both the fallback rule and the provenance anchor in the
 * SKILL.md reference copy and the installed reviewer.md prompt.
 */
describe("diff-as-file reviewer briefing ships in the skill and the reviewer prompt", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));

  it("SKILL.md step 7 covers the policy-gated fallback and the explicit-report clause", () => {
    expect(skillMd).toContain(
      "supply the diff as a pre-generated file in the briefing instead of expecting the reviewer to derive it",
    );
    expect(skillMd).toContain(
      "have the reviewer report explicitly if it could only reconstruct the delta some other way, rather than silently reviewing less than the full change",
    );
  });

  it("SKILL.md step 7 names the base/head revision provenance anchor", () => {
    expect(skillMd).toContain(
      "naming in the briefing the base and head revision the diff was generated from",
    );
  });

  it("the installed reviewer.md prompt carries the same fallback and explicit-report clause", () => {
    expect(reviewerMd).toContain(
      "review the diff file the orchestrator supplied in the briefing instead",
    );
    expect(reviewerMd).toContain(
      "say so explicitly in your report rather than silently reviewing less than the full change",
    );
  });

  it("reviewer.md states the base/head revision provenance anchor", () => {
    expect(reviewerMd).toContain(
      "State the base and head revision you reviewed in your report",
    );
  });
});

/**
 * 0.17.0's third anchored lesson: a named "Round-2 halt rule" section closes
 * a repeating review-fix cycle instead of letting it keep accreting one-off
 * case patches (boundary tokens, spellings). The rule makes its own
 * occurrence count explicit: the recurrence that trips the signal IS the
 * defect class's second occurrence, so the orchestrator stops the first
 * time the signal fires rather than waiting for a third occurrence, a
 * fix-round clarification of the shipped wording ("stop at the second such
 * occurrence"), which read ambiguously with the round count.
 */
describe("round-2 halt rule ships in the skill", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("carries the section heading and step 8's reference to it", () => {
    expect(skillMd).toContain("## Round-2 halt rule");
    expect(skillMd).toContain(
      "Watch for the round-2 halt signal across repeated review-fix cycles (see Round-2 halt rule below)",
    );
  });

  it("states the halt trigger and the unambiguous occurrence count", () => {
    expect(skillMd).toContain(
      "a review round finds a new defect of the same class a previous round's fix already addressed, so the class has recurred once after being fixed",
    );
    expect(skillMd).toContain(
      "Stop the first time this signal fires: the recurrence is already the class's second occurrence, so do not wait for a third one before stopping",
    );
  });

  it("instructs naming the structural cause and splitting or redesigning", () => {
    expect(skillMd).toContain("Name the structural cause in one sentence");
    expect(skillMd).toContain(
      "decide to split or redesign rather than keep accreting cases",
    );
  });

  it("states the ship-the-healthy-half and refile-the-removed-half response", () => {
    expect(skillMd).toContain("Ship the healthy half on its own verification");
    expect(skillMd).toContain(
      "refile the removed half as its own task carrying the measurement history that led to the split",
    );
  });

  it("escalates unsatisfiable acceptance criteria to the operator as a glossed merge-hold", () => {
    expect(skillMd).toContain(
      "go to the operator as a merge-hold (hold the change unmerged and hand the decision to the operator)",
    );
  });
});

/**
 * 0.19.0 adds `--tiers`: `models.ts` gains `ROLE_TIERS` (which effort tiers
 * each role gets a variant file for) and `DEFAULT_TIER` (the tier a role's
 * plain, unsuffixed file already corresponds to, so no variant is ever
 * rendered for it). README's new "Effort tiers" section carries a table of
 * that same data for humans; nothing previously guarded the two staying in
 * sync. This pins the table against `ROLE_TIERS`/`DEFAULT_TIER` directly
 * (not a hardcoded expected string), so a tier added to or removed from
 * either source without a matching table edit fails here, the same
 * source-of-truth discipline as the model-preselection enumeration guards
 * above. The table is located by its own header text and sliced off at the
 * next blank line, so a row belonging to the unrelated model-preselection
 * table (which also has an `explorer`/`task-slicer`/`implementer`/`reviewer`
 * first column, higher up in the same file) is never accidentally matched.
 */
describe("README tier table enumerates ROLE_TIERS and DEFAULT_TIER exactly", () => {
  const readmeMd = readDoc("README.md");

  /** The tier table's own markdown block, isolated from the unrelated
   * model-preselection table earlier in the file (same first column). */
  function tierTableSection(): string {
    const headerIdx = readmeMd.indexOf(
      "| Role | Tiers available | Default tier",
    );
    expect(
      headerIdx,
      "README tier table header not found",
    ).toBeGreaterThanOrEqual(0);
    const afterHeader = readmeMd.slice(headerIdx);
    const endIdx = afterHeader.indexOf("\n\n");
    expect(
      endIdx,
      "README tier table did not terminate before a blank line",
    ).toBeGreaterThan(0);
    return afterHeader.slice(0, endIdx);
  }

  function tierTableRow(role: (typeof ROLES)[number]): {
    tiers: string[];
    defaultTier: string;
  } {
    const match = tierTableSection().match(
      new RegExp(`^\\| ${role} \\| ([^|]+) \\| ([^|]+) \\|$`, "m"),
    );
    expect(match, `README tier table row for "${role}" not found`).toBeTruthy();
    const [, tiersCell, defaultTierCell] = match as RegExpMatchArray;
    return {
      tiers: tiersCell.split(",").map((tier) => tier.trim()),
      defaultTier: defaultTierCell.trim(),
    };
  }

  for (const role of ROLES) {
    it(`lists exactly ROLE_TIERS["${role}"], in order, in the Tiers available column`, () => {
      expect(tierTableRow(role).tiers).toEqual(ROLE_TIERS[role]);
    });

    it(`lists DEFAULT_TIER["${role}"] in the Default tier column`, () => {
      expect(tierTableRow(role).defaultTier).toBe(DEFAULT_TIER[role]);
    });
  }

  it("has exactly one row per role, no extra or missing rows", () => {
    // Excludes the header row itself ("Role") and the markdown table's
    // separator row ("---"), which the row shape also matches.
    const dataRows = [
      ...tierTableSection().matchAll(/^\| ([\w-]+) \| [^|]+ \| [^|]+ \|$/gm),
    ]
      .map((m) => m[1])
      .filter((cell) => cell !== "Role" && !/^-+$/.test(cell));
    expect(dataRows.sort()).toEqual([...ROLES].sort());
  });
});

/**
 * L4 (review round 1 on 0.19.0): the "Effort tiers" section carries a
 * second table, Tier -> model class -> model alias -> requested effort
 * (`TIER_DEFS`/`CLASS_MODELS` in `src/models.ts`), that the tier-table guard
 * above does not touch (it only pins the Role/Tiers-available/Default-tier
 * table). Nothing previously guarded this second table against drifting
 * from its source maps, so this mirrors the same source-of-truth discipline
 * for it: located by its own header text and sliced off at the next blank
 * line, so it is never confused with either of the two other same-shaped
 * tables earlier in the file.
 */
describe("README tier-to-model-class table enumerates TIER_DEFS and CLASS_MODELS exactly", () => {
  const readmeMd = readDoc("README.md");
  const tiersInOrder = Object.keys(TIER_DEFS) as Tier[];

  function tierModelClassTableSection(): string {
    const headerIdx = readmeMd.indexOf(
      "| Tier | Model class | Model alias | Effort requested |",
    );
    expect(
      headerIdx,
      "README tier-to-model-class table header not found",
    ).toBeGreaterThanOrEqual(0);
    const afterHeader = readmeMd.slice(headerIdx);
    const endIdx = afterHeader.indexOf("\n\n");
    expect(
      endIdx,
      "README tier-to-model-class table did not terminate before a blank line",
    ).toBeGreaterThan(0);
    return afterHeader.slice(0, endIdx);
  }

  function tierModelClassRow(tier: Tier): {
    modelClass: string;
    alias: string;
    effort: string;
  } {
    const match = tierModelClassTableSection().match(
      new RegExp(`^\\| ${tier} \\| ([^|]+) \\| ([^|]+) \\| ([^|]+) \\|$`, "m"),
    );
    expect(
      match,
      `README tier-to-model-class row for "${tier}" not found`,
    ).toBeTruthy();
    const [, modelClassCell, aliasCell, effortCell] = match as RegExpMatchArray;
    return {
      modelClass: modelClassCell.trim(),
      alias: aliasCell.replace(/`/g, "").trim(),
      effort: effortCell.replace(/`/g, "").trim(),
    };
  }

  for (const tier of tiersInOrder) {
    const def = TIER_DEFS[tier];

    it(`lists TIER_DEFS["${tier}"]'s model class and effort in the "${tier}" row`, () => {
      const row = tierModelClassRow(tier);
      expect(row.modelClass).toBe(def.modelClass);
      expect(row.effort).toBe(def.effort);
    });

    it(`lists CLASS_MODELS["${def.modelClass}"] as the "${tier}" row's model alias`, () => {
      expect(tierModelClassRow(tier).alias).toBe(CLASS_MODELS[def.modelClass]);
    });
  }

  it("has exactly one row per tier, no extra or missing rows", () => {
    const dataRows = [
      ...tierModelClassTableSection().matchAll(
        /^\| ([\w-]+) \| [^|]+ \| [^|]+ \| [^|]+ \|$/gm,
      ),
    ]
      .map((m) => m[1])
      .filter((cell) => cell !== "Tier" && !/^-+$/.test(cell));
    expect(dataRows.sort()).toEqual([...tiersInOrder].sort());
  });
});
