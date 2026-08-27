import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLASS_MODELS,
  DEFAULT_TIER,
  READ_ONLY_ROLES,
  ROLES,
  ROLE_TIERS,
  TIER_DEFS,
} from "../src/models.js";
import type { Role, Tier } from "../src/models.js";
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

/**
 * Slices `source` from the first occurrence of `startPhrase` through the
 * end of the first occurrence of `endPhrase` that follows it (inclusive of
 * `endPhrase` itself). Used to bound a derivation to exactly the sentence(s)
 * that state a rule, rather than a whole doc or a whole bullet, so a check
 * built on the slice cannot be satisfied by unrelated text elsewhere.
 */
function phraseBoundedSlice(
  source: string,
  startPhrase: string,
  endPhrase: string,
): string {
  const start = source.indexOf(startPhrase);
  expect(start, `"${startPhrase}" not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endPhrase, start);
  expect(end, `"${endPhrase}" not found after start`).toBeGreaterThan(start);
  return source.slice(start, end + endPhrase.length);
}

/** Backtick-quoted lowercase identifiers containing at least one underscore. */
function backtickSnakeCaseIdentifiers(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+)`/g)].map((m) => m[1]);
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
 * preference, the repeat-the-assignment mechanic, and the respawn fallback
 * condition. A same-day review-fix round then hardened two more things: the
 * "has resolved" claim is bound to recorded outcomes instead of asserted as
 * a universal rate, and the preference is explicitly scoped away from a
 * structurally different mid-run watchdog-stall misfire class where resume
 * did not work; the parenthetical signal definition itself is pinned too.
 * 0.24.0 (placement rule) removes the incident tally and the reviewer/model
 * correlation passage from this rule; both were point-in-time evidence, now
 * recorded in the CHANGELOG instead of kit prose, so the tests that pinned
 * that passage are removed here along with it.
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

  it("binds the 'has resolved on first resume' claim to recorded outcomes", () => {
    expect(skillMd).toContain(
      "whose outcome was recorded has resolved on the first resume attempt",
    );
  });

  it("states the respawn fallback is conditional on the resume attempt itself misfiring", () => {
    expect(skillMd).toContain(
      "fall back to a fresh respawn only if the resume attempt itself misfires the same way",
    );
  });

  it("no longer carries the incident tally or the reviewer/model correlation passage (0.24.0 placement rule)", () => {
    expect(skillMd).not.toContain("(four so far)");
    expect(skillMd).not.toContain(
      "So far this signal has only been observed",
    );
    expect(skillMd).not.toContain(
      "since 0.21.0 the advisor shares the reviewer's default model too",
    );
    expect(skillMd).not.toContain("see the per-role model preferences");
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
      "did not resolve on resume; only a fresh, explicitly constrained respawn produced a contract-valid review",
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
 * The Round-2 halt rule above stops a single task's defect-class recurrence
 * but never forced a choice once that stopping kept happening on the same
 * task, or once fix_required review rounds kept piling up. This pins the
 * "Review-round escalation budget" that closes that gap: the trigger (the
 * second round-2 halt signal or the third fix_required round), the three
 * named escalations, the mandatory-choice-not-mandatory-pick framing, the
 * 03-decisions.md marker both SKILL.md and agents-md-section.md name, and
 * the guard that escalating never substitutes for a review round.
 */
describe("review-round escalation budget ships in the skill and the AGENTS.md section", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const agentsMdSection = unwrap(readAsset("agents-md-section.md"));

  it("SKILL.md carries the section heading and step 8's trigger reference", () => {
    expect(skillMd).toContain("## Review-round escalation budget");
    expect(skillMd).toContain(
      "By the second round-2 halt signal or the third `fix_required` review round on the same task, apply the Review-round escalation budget",
    );
  });

  it("SKILL.md states the trigger and all three named escalations", () => {
    expect(skillMd).toContain(
      "by the second round-2 halt signal on the same task, or by the third `fix_required` review round on the same task, whichever comes first, choose one of three escalations",
    );
    expect(skillMd).toContain("**Tier or model escalation**");
    expect(skillMd).toContain("**Advisor spawn**");
    expect(skillMd).toContain("**Merge-hold**");
  });

  it("SKILL.md pins each escalation option's body, not just its bold label (a body rewritten into its opposite must fail this)", () => {
    expect(skillMd).toContain(
      "raise the implementer to at least `-xhigh` where that variant is installed, or to the strongest model available in this environment. When it already runs at both, this option is exhausted and the choice falls to the advisor spawn or the merge-hold.",
    );
    expect(skillMd).toContain(
      '"redesign, split, or hold?" and weigh its recommendation before deciding.',
    );
    expect(skillMd).toContain(
      "hold the change unmerged and hand the decision to the operator.",
    );
  });

  it("SKILL.md states the choice is mandatory but which one is judgment, and that escalating never replaces a review round", () => {
    expect(skillMd).toContain(
      "Judgment governs which of the three to pick; only that one is chosen and recorded is mandatory.",
    );
    expect(skillMd).toContain(
      "Escalating does not replace a review round",
    );
  });

  it("SKILL.md and agents-md-section.md both name the 03-decisions.md marker by name", () => {
    expect(skillMd).toContain("`review-round-escalation` marker");
    expect(agentsMdSection).toContain("`review-round-escalation` marker");
  });

  it("agents-md-section.md's Review gate section carries the budget rule in short form", () => {
    expect(agentsMdSection).toContain(
      "Review-round escalation budget: by the second round-2 halt signal on a task, or its third `fix_required` review round, whichever comes first,",
    );
    expect(agentsMdSection).toContain(
      "Escalating never substitutes for a review round",
    );
  });

  it("SKILL.md and agents-md-section.md both define what counts as a round (a misfired review is not one)", () => {
    expect(skillMd).toContain(
      "A counted round is a completed reviewer return whose `acceptance_recommendation` is `fix_required` or `reject`; a misfired review is not a round",
    );
    expect(agentsMdSection).toContain(
      "A counted round is a completed reviewer return recommending `fix_required` or `reject`; a misfired review is not a round.",
    );
  });

  it("SKILL.md and agents-md-section.md both state the escalation is additional to, not a substitute for, the halt rule's response", () => {
    expect(skillMd).toContain(
      "The escalation is chosen in addition to the halt rule's split-or-redesign response, not instead of it.",
    );
    expect(agentsMdSection).toContain(
      "Escalating never substitutes for a review round and comes in addition to the halt rule's split-or-redesign response, not instead of it.",
    );
  });

  it("SKILL.md does not cite the CHANGELOG's [Unreleased] heading by name (assets are installed verbatim and outlive the heading)", () => {
    expect(skillMd).toContain(
      "Anchored by a measurement; see the entry for this rule in the orchestrator-workflow CHANGELOG.",
    );
    expect(skillMd).not.toContain("[Unreleased]");
  });
});

/**
 * Installed assets are copied verbatim into a consuming repo and can outlive
 * a release; a literal `[Unreleased]` heading reference in one goes stale
 * the moment the referenced entry ships under a version number. Guards the
 * whole assets/ tree, not just SKILL.md, so a future asset can't reintroduce
 * the same staleness. Mutation probe: insert the literal string into any
 * file under assets/ and this test goes red.
 */
describe("no installed asset cites the CHANGELOG's [Unreleased] heading by name", () => {
  it("scans every file under assets/ for a literal [Unreleased] reference", () => {
    const assetsDir = `${PACKAGE_DIR}/assets`;
    const entries = readdirSync(assetsDir, {
      recursive: true,
      withFileTypes: true,
    });
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = `${entry.parentPath ?? entry.path}/${entry.name}`;
      const contents = readFileSync(full, "utf8");
      if (contents.includes("[Unreleased]")) {
        offenders.push(full.replace(`${assetsDir}/`, ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * AC2's marker check: 03-decisions.md carries the named
 * `review-round-escalation` marker so an orchestrator or reader can find
 * where the escalation choice is recorded, and both SKILL.md and
 * agents-md-section.md name that exact marker (checked above). Wiring a
 * machine reader to this marker is a follow-up, not part of this change
 * (see the CHANGELOG's `[Unreleased]` entry); this test only pins the
 * template's own named place existing.
 */
describe("03-decisions.md template carries the review-round-escalation marker", () => {
  const decisionsTemplate = readAsset("templates/03-decisions.md");

  it("has the Review-round escalation section and marker, defaulting to n/a", () => {
    expect(decisionsTemplate).toContain("## Review-round escalation");
    expect(decisionsTemplate).toContain(
      "<!-- review-round-escalation: choice = n/a -->",
    );
  });

  it("carries a Task/Choice/Reason table so one run can record the choice per task, not just once for the whole run", () => {
    expect(decisionsTemplate).toContain("| Task | Choice | Reason |");
    expect(decisionsTemplate).toContain("| n/a | n/a | n/a |");
  });

  it("pins the Choice column's enum values (a changed enum value must fail this)", () => {
    expect(decisionsTemplate).toContain(
      "<!-- Choice is one of: n/a | tier_escalation | advisor | merge_hold -->",
    );
  });
});

/**
 * The reviewer output contract gained a per-finding `recurrence` field so
 * the orchestrator can detect the review-round escalation budget's trigger
 * from the reviewer's own return instead of re-deriving it by hand. Pins
 * the field in both output-contract copies (byte-identical, the same
 * rigor applied to `reproduction` and `mutation_probes` above) and the
 * installed reviewer.md prompt's classification instruction.
 */
describe("reviewer finding recurrence field ships in both output contracts and the installed prompt", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));

  it("both copies carry the recurrence field on the findings item", () => {
    const field = "recurrence: new | repeated";
    expect(skillMd).toContain(field);
    expect(reviewerMd).toContain(field);
  });

  it("the installed reviewer.md prompt instructs classifying each finding's recurrence", () => {
    expect(reviewerMd).toContain(
      "classify each finding as `new` or `repeated` against the",
    );
  });

  it("SKILL.md step 7 has the orchestrator name the review round so the reviewer can classify recurrence", () => {
    expect(skillMd).toContain(
      "When this is not the task's first review round, name the round number in the briefing;",
    );
  });

  it("the findings block is byte-for-byte identical between SKILL.md and reviewer.md (raw, not line-unwrapped)", () => {
    const extractFindingsBlock = (raw: string): string => {
      const match = raw.match(/^findings:\n(?: {2}.+\n)*/m);
      expect(match, "findings block not found").toBeTruthy();
      return (match as RegExpMatchArray)[0];
    };
    const skillBlock = extractFindingsBlock(readAsset("skill/SKILL.md"));
    const reviewerBlock = extractFindingsBlock(readAsset("agents/reviewer.md"));
    expect(skillBlock.length).toBeGreaterThan(20);
    expect(skillBlock).toBe(reviewerBlock);
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

/**
 * Review round 2 (R2-M1): before this fix, README's opencode-effort prose
 * (and the CHANGELOG 0.19.0 entry) still described the pre-fix-round-1
 * dispatch (keyed on the literal provider id `anthropic/...`, review finding
 * M4's bug) and the pre-fix-round-1 unresolved-class behavior (a rendered
 * file with the `model:` line merely omitted, rather than the file being
 * skipped entirely, review finding M1's fix). This site-specific guard pins
 * the corrected README prose directly, isolating the opencode-effort section
 * from the rest of the "Effort tiers" section the same way the two table
 * guards above isolate their own tables, so a regression back to the stale
 * provider-scoped wording fails here rather than silently reappearing.
 */
describe("README opencode-effort prose uses family terms, not the stale provider-scoped claim (review round 2, R2-M1)", () => {
  const readmeMd = readDoc("README.md");

  /** The opencode-effort prose block, isolated from the rest of the
   * "Effort tiers" section by its own opening bold lead-in and the next
   * bold lead-in ("Warning: `CLAUDE_CODE_EFFORT_LEVEL`...") that follows it,
   * so a phrase elsewhere in the section can never accidentally satisfy (or
   * fail) these assertions. */
  function opencodeEffortSection(): string {
    const startIdx = readmeMd.indexOf(
      "**opencode variants key off the resolved model's family",
    );
    expect(
      startIdx,
      "README opencode-effort prose lead-in not found",
    ).toBeGreaterThanOrEqual(0);
    const endIdx = readmeMd.indexOf(
      "**Warning: `CLAUDE_CODE_EFFORT_LEVEL`",
      startIdx,
    );
    expect(
      endIdx,
      "README opencode-effort prose did not terminate before the CLAUDE_CODE_EFFORT_LEVEL warning",
    ).toBeGreaterThan(startIdx);
    return readmeMd.slice(startIdx, endIdx);
  }

  it("carries the family-based framing, not the old provider-dependent one", () => {
    expect(opencodeEffortSection()).toContain("Claude-family");
    expect(opencodeEffortSection()).not.toContain("provider-dependent");
  });

  it("does not describe dispatch as scoped to `anthropic/` model ids", () => {
    // The pre-fix-round-1 (M4) claim: dispatch keyed on the literal
    // `anthropic/...` provider prefix rather than the model's family. A
    // Claude-family model fronted by a different provider (e.g.
    // `github-copilot/claude-sonnet-4.6`) must be documented as still
    // getting the `variant:` rule, which this exact scope phrase denies.
    expect(opencodeEffortSection()).not.toContain("`anthropic/...` model ids");
  });

  it("states the real M1 effect (no variant file at all) instead of the pre-fix 'model: will be omitted' claim", () => {
    const section = opencodeEffortSection();
    expect(section).toContain("no variant file is rendered for");
    expect(section).not.toContain("model: will be omitted");
  });
});

/**
 * 0.20.0 adds a tier-selection policy for the orchestrator: 0.19.0 shipped
 * the `--tiers` rendering mechanics but no guidance on when to spawn which
 * tier. The operator framing was explicit: discretion by complexity and
 * risk, no rigid assignment table, no ritual. This pins the policy in
 * agents-md-section.md's Scaling delegation bullet list and in both
 * SKILL.md "Delegate implementation"/"Delegate review" steps.
 *
 * Review round 1 (M1) found the original prose over-generalized: it named
 * `-low`/`-high`/`-xhigh` as if every role got every tier, when in fact
 * `-xhigh` exists only for the implementer and the reviewer, and the
 * reviewer's own downshift is `-medium` (its default already sits at
 * `high`, so it has no `-low` variant). The bullet now carries a
 * qualifying sentence naming that explicitly. The anti-drift check below
 * was rebuilt to match: instead of checking every named suffix against
 * `ROLE_TIERS.implementer` alone (which would have let a `-medium` claim
 * about the reviewer pass even if `ROLE_TIERS.reviewer` never carried
 * `medium`), it maps each suffix to the specific role(s) the prose claims
 * it for and checks membership against that role's own `ROLE_TIERS` entry,
 * and that the suffix is not that role's own `DEFAULT_TIER` (a tier a role
 * defaults to never gets a suffixed variant file). The suffix-set check
 * itself is a non-vacuity floor plus a minimum-membership check
 * (`arrayContaining`), not a byte-exact `toEqual` pin: an exact pin blocked
 * this fix round's own legitimate `-medium` addition (review round 1
 * finding L2).
 */
describe("tier-selection policy ships in the AGENTS.md section and both SKILL.md delegate steps", () => {
  const agentsMdSection = unwrap(readAsset("agents-md-section.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("agents-md-section states the orchestrator picks the tier at its own judgment, gated on manifest tiers: true", () => {
    expect(agentsMdSection).toContain(
      "When tier variants are installed (manifest `tiers: true`), the orchestrator picks the effort tier per task by complexity and risk, at its own judgment.",
    );
    expect(agentsMdSection).toContain(
      "Tier choice is a conscious decision, not a ritual; when unsure, use the default.",
    );
  });

  it("agents-md-section carries no rigid tier-assignment table", () => {
    // The policy is discretionary by design; a markdown table row (two or
    // more "|" cell separators on one line) mapping tasks to tiers would
    // reintroduce the rigid mapping the operator framing explicitly rejected.
    const scalingIdx = agentsMdSection.indexOf("### Scaling delegation");
    const reviewGateIdx = agentsMdSection.indexOf("### Review gate");
    expect(scalingIdx).toBeGreaterThanOrEqual(0);
    expect(reviewGateIdx).toBeGreaterThan(scalingIdx);
    expect(agentsMdSection.slice(scalingIdx, reviewGateIdx)).not.toMatch(
      /\|[^|\n]+\|[^|\n]+\|/,
    );
  });

  it("the suffixes named in the policy prose are non-vacuous (low, high, xhigh, medium all appear)", () => {
    const bulletIdx = agentsMdSection.indexOf(
      "When tier variants are installed",
    );
    expect(bulletIdx, "tier-policy bullet not found").toBeGreaterThanOrEqual(0);
    const bulletEnd = agentsMdSection.indexOf("use the default.", bulletIdx);
    expect(
      bulletEnd,
      "tier-policy bullet did not terminate at the expected closing phrase",
    ).toBeGreaterThan(bulletIdx);
    const bullet = agentsMdSection.slice(bulletIdx, bulletEnd);
    const rawSuffixes = [...bullet.matchAll(/`-(\w+)`/g)].map(
      (m) => m[1] as Tier,
    );
    // Guard the extraction itself: if this drops to 0, the checks below
    // would vacuously pass without checking anything.
    expect(rawSuffixes.length).toBeGreaterThan(0);
    const suffixes = [...new Set(rawSuffixes)];
    // Minimum-membership floor, not a byte-exact pin, so a future
    // legitimate addition does not need to touch this test to stay green.
    expect(suffixes).toEqual(
      expect.arrayContaining(["low", "high", "xhigh", "medium"]),
    );
  });

  /**
   * Review round 1 (H1, round-2-halt structural fix): a hand-maintained map
   * (`TIER_SUFFIX_ROLE_CLAIMS`) used to check role-suffix membership. A
   * mutant proved this cannot catch every drift: swapping the role named in
   * the `-xhigh` exclusivity sentence for a wrong one (e.g. naming the
   * explorer instead of the advisor) left the map untouched and the suite
   * green, and the 0.21.0 release itself shipped with a since-corrected
   * prose sentence the map never caught either. The fix below parses the
   * roles the prose actually claims directly out of
   * agents-md-section.md and asserts each parsed set against the
   * equivalent set derived live from `ROLE_TIERS`/`DEFAULT_TIER`, so a
   * future role addition to xhigh support, or any wrong role name in the
   * prose, fails here without a parallel hand-edit to a map that can drift
   * from the constants it exists to mirror. A role's "downshift" is the
   * tier immediately below its `DEFAULT_TIER` in its own `ROLE_TIERS`
   * list, or none when `DEFAULT_TIER` is already that role's first tier.
   */
  function downshiftTier(role: Role): Tier | undefined {
    const tiers = ROLE_TIERS[role];
    const idx = tiers.indexOf(DEFAULT_TIER[role]);
    expect(
      idx,
      `DEFAULT_TIER.${role} not found in ROLE_TIERS.${role}`,
    ).toBeGreaterThanOrEqual(0);
    return idx > 0 ? tiers[idx - 1] : undefined;
  }

  function parseRoleList(raw: string): Role[] {
    return raw
      .replace(/,?\s*and\s+/g, ", ")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^the\s+/, "")) as Role[];
  }

  it("the -xhigh exclusivity sentence names exactly the roles derived from ROLE_TIERS/DEFAULT_TIER (structural)", () => {
    const match = agentsMdSection.match(/`-xhigh` exists only for ([^.]+)\./);
    expect(match, "xhigh-exclusivity sentence not found").toBeTruthy();
    const parsedRoles = parseRoleList((match as RegExpMatchArray)[1]);
    expect(parsedRoles.length).toBeGreaterThan(0);
    for (const role of parsedRoles) {
      expect(
        (ROLES as string[]).includes(role),
        `"${role}" parsed from the prose is not a known role`,
      ).toBe(true);
    }
    const derivedRoles = ROLES.filter(
      (role) =>
        ROLE_TIERS[role].includes("xhigh") && DEFAULT_TIER[role] !== "xhigh",
    );
    expect(new Set(parsedRoles)).toEqual(new Set(derivedRoles));
  });

  it("the reviewer's downshift sentence names the tier derived from its own ROLE_TIERS/DEFAULT_TIER (structural)", () => {
    const match = agentsMdSection.match(/The reviewer's downshift is `-(\w+)`/);
    expect(match, "reviewer downshift sentence not found").toBeTruthy();
    const claimed = (match as RegExpMatchArray)[1] as Tier;
    expect(claimed).toBe(downshiftTier("reviewer"));
  });

  it("the advisor's no-downshift sentence is true against its own ROLE_TIERS/DEFAULT_TIER (structural)", () => {
    expect(agentsMdSection).toContain("The advisor has no downshift at all");
    expect(downshiftTier("advisor")).toBeUndefined();
  });

  it('SKILL.md step 8 "Decide acceptance" carries the discretionary advisor-tier rule', () => {
    const start = skillMd.indexOf("**Decide acceptance.**");
    const handOffIdx = skillMd.indexOf("**Hand off.**");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(handOffIdx).toBeGreaterThan(start);
    const step = skillMd.slice(start, handOffIdx);
    expect(step).toContain(
      "pick the advisor tier (the installed `advisor-<tier>` subagent, if any) by the same complexity-and-risk judgment already used for the implementer and reviewer tiers",
    );
  });

  it('SKILL.md step 6 "Delegate implementation" carries the discretionary tier rule and the decision-log clause', () => {
    const start = skillMd.indexOf("**Delegate implementation.**");
    const end = skillMd.indexOf("**Delegate review.**");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step = skillMd.slice(start, end);
    expect(step).toContain(
      "pick the implementer tier (the installed `implementer-<tier>` subagents, if any) by the task's complexity and risk, at your own judgment, defaulting to the unsuffixed subagent when unsure",
    );
    expect(step).toContain(
      "record a non-default tier choice with a one-line reason in `03-decisions.md` when the task is non-trivial",
    );
  });

  it('SKILL.md step 7 "Delegate review" carries the discretionary tier rule and the decision-log clause', () => {
    const start = skillMd.indexOf("**Delegate review.**");
    const end = skillMd.indexOf("**Decide acceptance.**");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step = skillMd.slice(start, end);
    expect(step).toContain(
      "pick the reviewer tier (the installed `reviewer-<tier>` subagents, if any) by the task's complexity and risk, at your own judgment, defaulting to the unsuffixed subagent when unsure",
    );
    expect(step).toContain(
      "record a non-default tier choice with a one-line reason in `03-decisions.md` when the task is non-trivial",
    );
  });

  /**
   * 2026-08-24 (operator decision after Tier-A/B measurement, agent-tasks
   * task 7f38899d): the old `-low` guidance ("fits mechanical, narrowly
   * scoped tasks") was discretionary and, for the implementer specifically,
   * proved wrong in a blinded A/B (n=8): implementer-low reached accept a
   * median 320s slower (p=0.016), with 9 high-plus-critical review findings
   * against 1 and 8 fix rounds against 1. A first fix round worded the gate
   * around `mutation_probes` and `verification_commands` fields the kit's
   * subagent input contract does not define (fix1 review, HIGH-1): the
   * subagent input contract (SKILL.md's "Subagent input contract" block)
   * carries `acceptance_criteria`, not `mutation_probes`/
   * `verification_commands`, and the task slicer's output contract carries
   * `suggested_tests`. The rule now names only that existing vocabulary:
   * an acceptance criterion demanding a test/typecheck/lint/build run, the
   * task assignment naming mutation probes to run (a phrase step 6 already
   * used for the implementer's own mutation_probes output field), or the
   * task slicer's `suggested_tests` coming back non-empty. These checks pin
   * the corrected wording in both docs and guard against the old sentence,
   * or the invented field names, resurfacing for the implementer.
   */
  it("agents-md-section states the implementer-low gate using only existing contract vocabulary (no test/typecheck/lint/build AC, no mutation probes named, no suggested_tests)", () => {
    expect(agentsMdSection).toContain(
      "`-low` is spawned only when none of the following hold: an acceptance criterion demands a test, typecheck, lint, or build run; the task assignment names mutation probes to run; or the task slicer's `suggested_tests` came back non-empty",
    );
    expect(agentsMdSection).toContain(
      "any one of those three excludes `implementer-low`, and the task runs on the unsuffixed implementer or higher",
    );
  });

  it("SKILL.md step 6 carries the same implementer-low gate", () => {
    const start = skillMd.indexOf("**Delegate implementation.**");
    const end = skillMd.indexOf("**Delegate review.**");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step = skillMd.slice(start, end);
    expect(step).toContain(
      "`implementer-low` is spawned only when none of the following hold: an acceptance criterion demands a test, typecheck, lint, or build run; the task assignment names mutation probes to run; or the task slicer's `suggested_tests` came back non-empty",
    );
    expect(step).toContain(
      "Any one of those three excludes `implementer-low`, even for a change that looks mechanical",
    );
  });

  /**
   * The implementer-low gate sentence(s) in each doc, sliced narrowly so a
   * check built on them cannot be satisfied by unrelated prose elsewhere in
   * the doc: agents-md-section.md's slice runs from "For the implementer
   * specifically" through the gate's own tie-break close, "exclude
   * `implementer-low`." (fix-round-3, MEDIUM-2/LOW-4: narrowed from the
   * tier bullet's own "use the default." close, which pulled in the
   * unrelated explorer/task-slicer sentence, the `-xhigh` sentence, the
   * reviewer-downshift and advisor sentences, and the closing tier-choice
   * sentence, so a mutant touching only those was never actually scoped out
   * on purpose). SKILL.md step 6's slice runs from "`implementer-low` is
   * spawned only" through that sentence's own "came back non-empty." close
   * (step 6's later mutation-probe-reporting sentence, which also mentions
   * `mutation_probes`, sits outside this slice on purpose: it is a
   * reporting instruction, not part of the tier-gate rule). The fail-safe
   * tie-break sentence itself ("when it is unclear ... exclude
   * `implementer-low`") sits inside agents-md-section.md's slice but
   * outside SKILL.md's narrower `skillImplementerGateSlice`, so the tests
   * below that pin it use the wider `skillStep6Slice` for SKILL.md instead.
   *
   * Each slice is computed lazily, memoized behind a getter called from
   * inside each `it` rather than at describe-body evaluation time
   * (fix-round-3, LOW-1): a `phraseBoundedSlice` failure used to throw
   * while the test file was still being collected, which vitest reports as
   * a whole-file collection error (every test in this file failing, not
   * just the ones that touch this slice); the getters confine a
   * phrase-drift failure to the named tests that actually call them.
   */
  let agentsImplementerGateSliceCache: string | undefined;
  function agentsImplementerGateSlice(): string {
    if (agentsImplementerGateSliceCache === undefined) {
      agentsImplementerGateSliceCache = phraseBoundedSlice(
        agentsMdSection,
        "For the implementer specifically",
        "exclude `implementer-low`.",
      );
    }
    return agentsImplementerGateSliceCache;
  }
  let skillStep6SliceCache: string | undefined;
  function skillStep6Slice(): string {
    if (skillStep6SliceCache === undefined) {
      skillStep6SliceCache = phraseBoundedSlice(
        skillMd,
        "**Delegate implementation.**",
        "**Delegate review.**",
      );
    }
    return skillStep6SliceCache;
  }
  let skillImplementerGateSliceCache: string | undefined;
  function skillImplementerGateSlice(): string {
    if (skillImplementerGateSliceCache === undefined) {
      skillImplementerGateSliceCache = phraseBoundedSlice(
        skillStep6Slice(),
        "`implementer-low` is spawned only",
        "came back non-empty.",
      );
    }
    return skillImplementerGateSliceCache;
  }

  it("the implementer-low gate slice in each doc no longer carries the old discretionary '-low' guidance", () => {
    expect(agentsImplementerGateSlice()).not.toContain(
      "fits mechanical, narrowly scoped tasks",
    );
    expect(skillImplementerGateSlice()).not.toContain(
      "fits mechanical, narrowly scoped tasks",
    );
  });

  /**
   * fix-round-3 (MEDIUM-3): fix-round-2 softened the gate's framing from
   * "checkable criterion, not a judgment call" to "checkable against the
   * task contract rather than a judgment about how hard the task looks",
   * but nothing pinned the new wording, so a mutant reverting it to the old
   * phrase stayed green.
   */
  it("agents-md-section frames the gate as checkable against the task contract, not a judgment about how hard the task looks", () => {
    expect(agentsImplementerGateSlice()).toContain(
      "checkable against the task contract rather than a judgment about how hard the task looks",
    );
  });

  /**
   * fix-round-3 (MEDIUM-2/LOW-4): fix-round-2 added a fail-safe tie-break
   * ("when it is unclear whether a criterion demands a run, exclude
   * `implementer-low`") to both agents-md-section.md and SKILL.md step 6,
   * but nothing pinned it, so a mutant dropping the sentence from either
   * doc stayed green.
   */
  it("both docs carry the fail-safe tie-break: when unclear, exclude implementer-low", () => {
    expect(agentsImplementerGateSlice()).toContain(
      "when it is unclear whether a criterion demands a run, exclude `implementer-low`",
    );
    expect(skillStep6Slice()).toContain(
      "When it is unclear whether a criterion demands a run, exclude `implementer-low`",
    );
  });

  /**
   * 0.24.0 (placement rule): the A/B measurement's headline numbers (n=8,
   * the median slowdown, its p-value, the high-plus-critical finding count,
   * the task id) are point-in-time evidence and moved out of both docs into
   * the CHANGELOG 0.23.0 entry; each doc keeps a one-line pointer instead.
   * These checks pin the pointer and guard against the raw numbers
   * resurfacing in kit prose.
   */
  it("agents-md-section points to the CHANGELOG instead of stating the A/B measurement's headline numbers", () => {
    expect(agentsMdSection).toContain(
      "This rule is anchored by an A/B measurement; the data and the model caveat are recorded in the orchestrator-workflow CHANGELOG (0.23.0).",
    );
    expect(agentsMdSection).not.toContain("median 320 seconds slower");
    expect(agentsMdSection).not.toContain("p=0.016");
    expect(agentsMdSection).not.toContain("9 high-plus-critical");
    expect(agentsMdSection).not.toContain("7f38899d");
  });

  it("SKILL.md points to the CHANGELOG instead of stating the A/B measurement's headline numbers", () => {
    expect(skillMd).toContain(
      "(anchored by an A/B measurement; see CHANGELOG 0.23.0)",
    );
    expect(skillMd).not.toContain("median 320 seconds slower");
    expect(skillMd).not.toContain("p=0.016");
    expect(skillMd).not.toContain("9 high-plus-critical");
    expect(skillMd).not.toContain("7f38899d");
  });

  /**
   * HIGH-2 fix (fix-round-2 review): the fix-round-1 pin below this comment
   * used to only check two hand-picked field names (that
   * `acceptance_criteria` is present, and a literal ban on the string
   * "verification_commands") without deriving anything from the gate's own
   * wording, so a mutant that reworded the gate to cite a different
   * invented field (for example `verification_steps`) stayed green. This
   * pin instead regex-extracts every backtick-quoted snake_case identifier
   * (a lowercase word containing at least one underscore) out of the two
   * gate slices above, then asserts each one is a field either the
   * Subagent input contract or the Task slicer output contract actually
   * defines (both blocks read raw, not unwrapped, so the yaml field names
   * are read verbatim). A gate that cites any field neither contract block
   * defines - the old invented `verification_commands`, a new invented name
   * like `verification_steps`, or an implementer-OUTPUT-only field like
   * `mutation_probes` that neither the input nor the slicer contract
   * carries - fails this pin without needing a hand-picked literal ban for
   * every possible invented name.
   */
  it("every backtick-quoted snake_case identifier the implementer-low gate cites (in either doc) is a field the subagent input or task slicer output contract actually defines", () => {
    const skillMdRaw = readAsset("skill/SKILL.md");
    const inputContractStart = skillMdRaw.indexOf("## Subagent input contract");
    const inputContractEnd = skillMdRaw.indexOf(
      "## Implementer output contract",
      inputContractStart,
    );
    expect(inputContractStart).toBeGreaterThanOrEqual(0);
    expect(inputContractEnd).toBeGreaterThan(inputContractStart);
    const inputContractBlock = skillMdRaw.slice(
      inputContractStart,
      inputContractEnd,
    );

    const slicerContractStart = skillMdRaw.indexOf(
      "## Task slicer output contract",
    );
    const slicerContractEnd = skillMdRaw.indexOf(
      "## Advisor output contract",
      slicerContractStart,
    );
    expect(slicerContractStart).toBeGreaterThanOrEqual(0);
    expect(slicerContractEnd).toBeGreaterThan(slicerContractStart);
    const slicerContractBlock = skillMdRaw.slice(
      slicerContractStart,
      slicerContractEnd,
    );

    // Sanity: the field names the gate cites really live in these blocks.
    expect(inputContractBlock).toContain("acceptance_criteria");
    expect(slicerContractBlock).toContain("suggested_tests");

    const cited = new Set([
      ...backtickSnakeCaseIdentifiers(agentsImplementerGateSlice()),
      ...backtickSnakeCaseIdentifiers(skillImplementerGateSlice()),
    ]);
    // Guard the extraction itself: if this drops to 0, the membership check
    // below would vacuously pass without checking anything.
    expect(cited.size).toBeGreaterThan(0);
    for (const identifier of cited) {
      expect(
        inputContractBlock.includes(identifier) ||
          slicerContractBlock.includes(identifier),
        `\`${identifier}\` is cited by the implementer-low gate but is not a field either the Subagent input contract or the Task slicer output contract defines`,
      ).toBe(true);
    }
  });
});

/**
 * 0.22.0 pins every unsuffixed default subagent's effort in its own file
 * (`TIER_DEFS[DEFAULT_TIER[role]].effort`, applied unconditionally by
 * `composeClaudeAgent`/`composeOpencodeAgent` regardless of the `tiers`
 * flag), so a default spawn no longer silently inherits the orchestrator
 * session's effort. agents-md-section.md's Scaling delegation bullet list
 * states this as its own bullet, deliberately NOT nested inside the
 * tiers-gated "When tier variants are installed..." bullet, so it cannot be
 * misread as a `--tiers`-only behavior. The role/effort split named in the
 * prose is parsed out and checked against `DEFAULT_TIER`/`TIER_DEFS`
 * directly (not a hand-maintained role list), the same
 * derive-from-source-of-truth discipline the tier-suffix guards above use,
 * so a future role addition or a wrong effort claim fails here rather than
 * silently drifting.
 */
describe("pinned-default-effort policy ships in the AGENTS.md section and is not framed as tiers-gated", () => {
  const agentsMdSectionRaw = readAsset("agents-md-section.md");
  const agentsMdSection = unwrap(agentsMdSectionRaw);
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  function parseRoleList(raw: string): Role[] {
    return raw
      .replace(/,?\s*and\s+/g, ", ")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^the\s+/, "")) as Role[];
  }

  function pinnedEffortBullet(): string {
    const idx = agentsMdSection.indexOf(
      "Every unsuffixed default subagent carries its own pinned default effort",
    );
    expect(
      idx,
      "pinned-default-effort bullet not found",
    ).toBeGreaterThanOrEqual(0);
    // agentsMdSection is line-unwrapped (all whitespace collapsed to single
    // spaces), so a "\n- " bullet-boundary search does not work here; bound
    // the end at the next bullet's own known lead-in phrase instead.
    const end = agentsMdSection.indexOf(
      "Under the `full` profile, an advisor subagent is available",
      idx,
    );
    expect(
      end,
      "pinned-default-effort bullet did not terminate before the next bullet",
    ).toBeGreaterThan(idx);
    return agentsMdSection.slice(idx, end);
  }

  it("names exactly the medium-tier and high-tier roles derived from DEFAULT_TIER/TIER_DEFS (structural)", () => {
    const bullet = pinnedEffortBullet();
    const match = bullet.match(/medium for ([^;]+); high for ([^.]+)\./);
    expect(
      match,
      "medium/high role split not found in the bullet",
    ).toBeTruthy();
    const [, mediumRaw, highRaw] = match as RegExpMatchArray;
    const parsedMedium = parseRoleList(mediumRaw);
    const parsedHigh = parseRoleList(highRaw);
    expect(parsedMedium.length).toBeGreaterThan(0);
    expect(parsedHigh.length).toBeGreaterThan(0);
    for (const role of [...parsedMedium, ...parsedHigh]) {
      expect(
        (ROLES as string[]).includes(role),
        `"${role}" parsed from the prose is not a known role`,
      ).toBe(true);
    }
    const derivedMedium = ROLES.filter(
      (role) => TIER_DEFS[DEFAULT_TIER[role]].effort === "medium",
    );
    const derivedHigh = ROLES.filter(
      (role) => TIER_DEFS[DEFAULT_TIER[role]].effort === "high",
    );
    expect(new Set(parsedMedium)).toEqual(new Set(derivedMedium));
    expect(new Set(parsedHigh)).toEqual(new Set(derivedHigh));
    // Every role in ROLES falls into exactly one of the two buckets: guards
    // against a future tier whose effort is neither "medium" nor "high"
    // going undocumented by this bullet's two-bucket phrasing.
    expect(parsedMedium.length + parsedHigh.length).toBe(ROLES.length);
  });

  it("states the pin is not gated on --tiers", () => {
    const bullet = pinnedEffortBullet();
    expect(bullet).toContain("not inherited from the orchestrator session");
    expect(bullet).toContain("whether or not tier variants are installed");
    expect(bullet).toContain("not gated on `--tiers`");
  });

  it("the pinned-default-effort statement starts its own bullet in the raw (non-unwrapped) source, not appended to the end of the tiers-gated bullet", () => {
    // The whitespace-collapsed `agentsMdSection` string used elsewhere in
    // this describe block cannot distinguish "own bullet" from "appended to
    // the end of the tiers-gated bullet's text": both collapse to the same
    // space-joined string. Assert against the raw, un-unwrapped asset text
    // instead, requiring a "\n- " (or file-start "- ") bullet boundary
    // directly before the statement.
    expect(
      /^- Every unsuffixed default subagent carries its own pinned default effort/m.test(
        agentsMdSectionRaw,
      ),
      'pinned-default-effort statement must begin its own bullet line (start with "- "), not be appended inside another bullet\'s text',
    ).toBe(true);
  });

  it("the pinned-default-effort bullet sits outside the tiers-gated bullet's own span", () => {
    // The tiers-gated bullet ends at its own "use the default." phrase (see
    // the describe block above); the pinned-default-effort bullet must start
    // strictly after that point, so a reader (or a future edit) cannot fold
    // it back inside the "When tier variants are installed..." conditional.
    const tiersGatedEnd = agentsMdSection.indexOf(
      "use the default.",
      agentsMdSection.indexOf("When tier variants are installed"),
    );
    expect(tiersGatedEnd).toBeGreaterThan(0);
    const pinnedIdx = agentsMdSection.indexOf(
      "Every unsuffixed default subagent carries its own pinned default effort",
    );
    expect(pinnedIdx).toBeGreaterThan(tiersGatedEnd);
  });

  it('SKILL.md step 6 "Delegate implementation" names the implementer default\'s pinned effort, derived from TIER_DEFS/DEFAULT_TIER', () => {
    const start = skillMd.indexOf("**Delegate implementation.**");
    const end = skillMd.indexOf("**Delegate review.**");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step = skillMd.slice(start, end);
    const match = step.match(
      /carries a pinned effort: `(\w+)` in its own file, whether or not tier variants are installed/,
    );
    expect(
      match,
      "pinned-default-effort sentence not found in step 6",
    ).toBeTruthy();
    const claimed = (match as RegExpMatchArray)[1];
    expect(claimed).toBe(TIER_DEFS[DEFAULT_TIER.implementer].effort);
  });

  it('SKILL.md step 6\'s pinned-default-effort sentence sits outside the "When tier variants are installed..." clause, so it also holds for a tiers-off install', () => {
    // Mirrors the agents-md-section.md positional test above: the pinned-
    // effort statement must not be readable as scoped to the tiers-on
    // conditional it happens to sit next to in prose.
    const start = skillMd.indexOf("**Delegate implementation.**");
    const end = skillMd.indexOf("**Delegate review.**");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const step = skillMd.slice(start, end);
    const tiersGatedStart = step.indexOf("When tier variants are installed");
    expect(tiersGatedStart).toBeGreaterThanOrEqual(0);
    const tiersGatedEnd = step.indexOf("is non-trivial.", tiersGatedStart);
    expect(tiersGatedEnd).toBeGreaterThan(tiersGatedStart);
    const pinnedIdx = step.indexOf(
      "carries a pinned effort: `medium` in its own file",
    );
    expect(
      pinnedIdx,
      "pinned-default-effort sentence not found",
    ).toBeGreaterThanOrEqual(0);
    expect(
      pinnedIdx < tiersGatedStart || pinnedIdx >= tiersGatedEnd,
      "pinned-default-effort sentence must not sit inside the tiers-gated clause's own span",
    ).toBe(true);
  });
});

/**
 * 0.21.0 adds the advisor role: a fifth, read-only, `full`-profile-only
 * subagent consulted only at defined escalation triggers (architectural
 * uncertainty, conflicting requirements, a high-commitment fork among valid
 * options, repeated implementation failures, a review deadlock, a high-risk
 * decision). It recommends; the orchestrator still decides. This pins the
 * escalation policy paragraph in agents-md-section.md's Scaling delegation
 * bullet list (the one site with no other guard: none of the enumeration
 * tests above would catch its deletion, since it is prose describing when to
 * spawn the role, not a list the enumeration checks scan), plus the four
 * SKILL.md additions: the Roles-section bullet, the new Advisor output
 * contract block, step 8's advisor-trigger sentence, and the harness notes'
 * full-profile role enumeration.
 */
describe("advisor escalation policy ships in the AGENTS.md section and SKILL.md", () => {
  const agentsMdSection = unwrap(readAsset("agents-md-section.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("agents-md-section.md's Scaling delegation bullet list names the advisor's escalation triggers and the recommends-never-decides rule", () => {
    const scalingIdx = agentsMdSection.indexOf("### Scaling delegation");
    const reviewGateIdx = agentsMdSection.indexOf("### Review gate");
    expect(scalingIdx).toBeGreaterThanOrEqual(0);
    expect(reviewGateIdx).toBeGreaterThan(scalingIdx);
    const scalingSection = agentsMdSection.slice(scalingIdx, reviewGateIdx);
    expect(scalingSection).toContain(
      "an advisor subagent is available for escalation only",
    );
    expect(scalingSection).toContain(
      "architectural uncertainty, requirements that contradict each other, multiple valid solution paths where committing to one is expensive to reverse, repeated implementation failures on the same task, a review deadlock, or a high-risk decision",
    );
    expect(scalingSection).toContain(
      "The orchestrator spawns it only at one of these triggers, never as a standard pipeline step",
    );
    expect(scalingSection).toContain(
      "the orchestrator still decides, and a critical risk still goes to the operator",
    );
  });

  it("SKILL.md's Roles section carries the Advisor bullet, scoped to full profile, read-only, escalation-only", () => {
    const rolesIdx = skillMd.indexOf("## Roles");
    const runStateIdx = skillMd.indexOf("## Run state");
    expect(rolesIdx).toBeGreaterThanOrEqual(0);
    expect(runStateIdx).toBeGreaterThan(rolesIdx);
    const rolesSection = skillMd.slice(rolesIdx, runStateIdx);
    expect(rolesSection).toContain(
      "**Advisor** (optional, read-only, `full` profile only)",
    );
    expect(rolesSection).toContain(
      "never decides and never writes code. Not a standard pipeline step",
    );
  });

  it("SKILL.md carries a dedicated Advisor output contract block with the escalation-necessity check documented", () => {
    expect(skillMd).toContain("## Advisor output contract");
    const field =
      "status: done | partial | blocked role: advisor escalation_necessary: warranted | unwarranted";
    expect(skillMd).toContain(field);
    expect(skillMd).toContain(
      "The advisor first checks whether the escalation was actually necessary",
    );
    expect(skillMd).toContain(
      "it does not decide, and a critical risk still goes to the operator",
    );
  });

  it("the subagent input contract's role enum includes advisor", () => {
    expect(skillMd).toContain(
      "role: advisor | explorer | implementer | reviewer | task_slicer",
    );
  });

  it("step 8 (Decide acceptance) names the advisor triggers and that the orchestrator may spawn it before deciding", () => {
    const start = skillMd.indexOf("**Decide acceptance.**");
    const handOffIdx = skillMd.indexOf("**Hand off.**");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(handOffIdx).toBeGreaterThan(start);
    const step = skillMd.slice(start, handOffIdx);
    expect(step).toContain(
      "At an advisor trigger (architectural uncertainty, conflicting requirements, a high-commitment fork among valid options, repeated implementation failures, a review deadlock, a high-risk decision), the orchestrator may spawn the advisor subagent before deciding",
    );
    expect(step).toContain(
      "the advisor recommends, the orchestrator still decides",
    );
  });

  it("the harness notes name advisor among the full-profile Claude Code roles", () => {
    expect(skillMd).toContain(
      "explorer, task-slicer, implementer, reviewer, advisor under `full`; implementer and reviewer only under `minimal`",
    );
  });
});

/**
 * Review round 1 (M2): the advisor's yaml output-contract block (SKILL.md's
 * reference copy vs. advisor.md's own final-output block) had no
 * byte-for-byte drift guard, the same gap the reviewer's `reproduction`
 * field (0.14.0) and `mutation_probes` field (0.16.0) closed for their own
 * roles. This pins it the same way: extract the yaml block from both raw
 * files (not line-unwrapped, so a wrapping difference would also be
 * caught) and assert they are identical.
 */
describe("advisor output contract is byte-identical between SKILL.md and advisor.md (review round 1, M2)", () => {
  it("the advisor output contract yaml block is byte-for-byte identical (raw, not line-unwrapped)", () => {
    const extractBlock = (raw: string): string => {
      const match = raw.match(
        /^status: done \| partial \| blocked\nrole: advisor\n(?:.+\n)*?```/m,
      );
      expect(match, "advisor output contract block not found").toBeTruthy();
      return (match as RegExpMatchArray)[0].replace(/\n```$/, "");
    };
    const skillBlock = extractBlock(readAsset("skill/SKILL.md"));
    const advisorBlock = extractBlock(readAsset("agents/advisor.md"));
    // Guard the extraction itself: an empty or near-empty match would make
    // the equality check below vacuous.
    expect(skillBlock.length).toBeGreaterThan(20);
    expect(skillBlock).toBe(advisorBlock);
  });
});

/**
 * Review round 1 (M1): cli.ts's interactive --profile prompt hardcoded its
 * choice labels' role lists ("full — explorer, task-slicer, implementer,
 * reviewer (default)"), the one enumeration site outside the doc-guards
 * above; it went stale the moment the advisor role shipped (0.21.0) since
 * nothing forced it to track rolesForProfile. The fix derives both labels
 * from rolesForProfile at call time; this pins that derivation in the
 * source itself so a future hardcoded regression is caught even though the
 * interactive prompt is not exercised by the non-interactive CLI tests
 * (--yes skips it).
 */
describe("cli.ts's --profile prompt labels are derived from rolesForProfile, not hardcoded (review round 1, M1)", () => {
  const cliSrc = readDoc("src/cli.ts");

  it("promptProfile derives both choice labels from rolesForProfile instead of a literal role list", () => {
    const start = cliSrc.indexOf("async function promptProfile");
    const end = cliSrc.indexOf("const program = new Command();");
    expect(start, "promptProfile not found").toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const fn = cliSrc.slice(start, end);
    expect(fn).toContain('rolesForProfile("full").join(", ")');
    expect(fn).toContain('rolesForProfile("minimal").join(", ")');
    // Anti-drift: no literal comma-joined role list survives inside the
    // choice labels themselves (the old hardcoded "explorer, task-slicer,
    // implementer, reviewer" string that went stale on the advisor's
    // arrival).
    expect(fn).not.toMatch(/name:\s*`?"?full.*explorer.*task-slicer/);
  });
});

/**
 * Review round 1 (M4, optional): `matches_implementer_claim` was already
 * pinned against bare yes/no (YAML 1.1 boolean synonyms) above; this scans
 * every output-contract field in SKILL.md for the same antipattern so a
 * future field (like the advisor's own `escalation_necessary`, corrected to
 * `warranted | unwarranted` this round) cannot reintroduce it unnoticed.
 */
describe("no output-contract field in SKILL.md uses a bare yes/no enum (review round 1, M4)", () => {
  it("scans SKILL.md for any field using a bare yes | no enum", () => {
    const skillMd = readAsset("skill/SKILL.md");
    expect(skillMd).not.toMatch(/:\s*yes\s*\|\s*no\b/);
  });
});

/**
 * agent-tasks 1d6e0b3e fix-round-2: the okf-kit version this repo's own
 * `.github/workflows/okf-staleness.yml` pins (via `npm install -g
 * okf-kit@<version>`) and the version `packages/okf-kit/README.md`'s own
 * "Pin the version" CI example pins (via `npx okf-kit@<version> check
 * path/to/bundle`) must both track `packages/okf-kit/package.json`'s actual
 * published version, derived rather than hardcoded, so a version bump in
 * one place cannot silently leave the workflow or the README's own example
 * pointing at a stale okf-kit release.
 */
describe("okf-kit version pin stays in sync across the workflow, its README, and package.json", () => {
  // Local to this describe block (not hoisted to the top of the file)
  // deliberately: this file is itself cited by many `path:N` line numbers
  // across the docs/okf bundle, so a helper added above existing code would
  // shift every citation after it, exactly the class of bug this fix-round
  // exists to correct. Appending only at the end of the file keeps every
  // pre-existing citation's line number intact.
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");

  const okfKitPackageJson = JSON.parse(
    readRepoFile("packages/okf-kit/package.json"),
  ) as { version: string };
  const version = okfKitPackageJson.version;

  it("okf-staleness.yml installs the same okf-kit version as package.json", () => {
    const workflow = readRepoFile(".github/workflows/okf-staleness.yml");
    const match = workflow.match(/npm install -g okf-kit@([\w.-]+)/);
    expect(
      match,
      "okf-kit install line not found in okf-staleness.yml",
    ).not.toBeNull();
    expect(match?.[1]).toBe(version);
  });

  it("okf-kit's own README npx example pins the same version as package.json", () => {
    const readme = readRepoFile("packages/okf-kit/README.md");
    const match = readme.match(/npx okf-kit@([\w.-]+) check path\/to\/bundle/);
    expect(
      match,
      "npx okf-kit@<version> example not found in README.md",
    ).not.toBeNull();
    expect(match?.[1]).toBe(version);
  });
});

/**
 * 0.24.0 adds a generic placement check: the reviewer looks for org-,
 * machine-, or point-in-time-bound evidence leaking into a reusable
 * instruction file, and the orchestrator's hand-off step carries the same
 * check before filling 06-handoff.md. Both are new rules, not moved
 * evidence, so they get their own positive pins.
 */
describe("the placement check ships in reviewer.md and the SKILL.md hand-off step (0.24.0)", () => {
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("reviewer.md's check list flags org-, machine-, or point-in-time-bound evidence in a reusable instruction file", () => {
    expect(reviewerMd).toContain(
      "Placement: does the change add org-, machine-, or point-in-time-bound evidence (dates, sample sizes, task ids, home paths, incident tallies) to a reusable instruction file (a skill, an agent prompt, an AGENTS.md section, a template)?",
    );
    expect(reviewerMd).toContain(
      "the fix is to move the evidence to the changelog, the run files, or the consuming workspace and leave a one-line pointer",
    );
  });

  it("SKILL.md step 9 (Hand off) checks for the same kind of leaked evidence before handoff", () => {
    expect(skillMd).toContain(
      "Before handing off, check that no org-, machine-, or point-in-time-bound evidence was added to a reusable instruction file",
    );
    expect(skillMd).toContain(
      "such evidence belongs in the changelog, the run files, or the consuming workspace, with a pointer left behind",
    );
  });
});

/**
 * 0.24.0 also generalizes the run-state paragraph's pointer to the
 * consuming gate's docs, dropping the pinned grounding-mcp version number
 * (point-in-time evidence) while keeping the same pointer.
 */
describe("the run-base paragraph points to the consuming gate's docs without a pinned version (0.24.0)", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("names the consuming gate's documentation generically, without a version number", () => {
    expect(skillMd).toContain(
      "see the consuming gate's documentation (grounding-mcp) for the full consumer semantics",
    );
    expect(skillMd).not.toContain("grounding-mcp 0.6.0");
  });
});

/**
 * Review round 2 fix (finding G): the 0.24.0 CHANGELOG evidence note
 * records the reviewer/advisor model correlation, but nothing pinned that
 * `DEFAULT_MODELS` actually still gives them the same default today. A
 * one-line mechanical anchor for that record, so a future model change for
 * either role is a deliberate, visible edit rather than a silent drift the
 * CHANGELOG note would then misdescribe.
 */
describe("the reviewer/advisor default-model correlation the CHANGELOG 0.24.0 evidence note records is still true", () => {
  // Imported dynamically, not added to the top-level import block: this
  // file is itself cited by many `path:N` line numbers across the docs/okf
  // bundle, and a new top-level import line would shift every citation
  // below it, exactly the class of bug this fix-round exists to correct.
  it("DEFAULT_MODELS gives the advisor and the reviewer the same default model", async () => {
    const { DEFAULT_MODELS } = await import("../src/models.js");
    expect(DEFAULT_MODELS.advisor).toBe(DEFAULT_MODELS.reviewer);
  });
});

/**
 * Review round 2 fix (finding H): the placement-guard CI job and the root
 * slop.config.yml are both new in 0.24.0 but had no test coverage. A typo
 * or an accidental removal in either file would silently drop the guard
 * from CI (or drop this package's assets from what it scans) with nothing
 * to catch it.
 */
describe("the placement-guard CI job and slop.config.yml stay wired up (0.24.0)", () => {
  // Local to this describe block, not hoisted, for the same reason as the
  // okf-kit version-pin block above: this file is itself cited by many
  // `path:N` line numbers across the docs/okf bundle, so a helper added
  // above existing code would shift every citation after it. Appending
  // only at the end of the file keeps every pre-existing citation intact.
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");

  it(".github/workflows/ci.yml carries a placement-guard job", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");
    expect(workflow).toMatch(/^\s*placement-guard:/m);
  });

  it("slop.config.yml lists this package's assets tree under placement.instructionGlobs", () => {
    const slopConfig = readRepoFile("slop.config.yml");
    expect(slopConfig).toContain(
      "packages/orchestrator-workflow/assets/**/*.md",
    );
  });
});

/**
 * Review round 2 fix (finding H): the CHANGELOG's 0.24.0 evidence note was
 * rewritten to quote the removed SKILL.md passage verbatim and add the
 * incident dates; nothing pinned that content, so a future edit could
 * silently drop it back to a paraphrase or lose the dates again.
 */
describe("the CHANGELOG 0.24.0 evidence note carries the four durable evidence facts", () => {
  const changelogMd = readDoc("CHANGELOG.md");
  // Scope to the 0.24.0 section only: the same substrings recur in older
  // entries, so a whole-file assertion would pass even if the note were
  // mangled (review round 2 mutation test).
  const start = changelogMd.indexOf("## [0.24.0]");
  const next = changelogMd.indexOf("\n## [", start + 1);
  const section = changelogMd.slice(start, next === -1 ? undefined : next);

  it("names the incident count, the reviewer role, the watchdog class, and the incident dates inside the 0.24.0 section", () => {
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain("four");
    expect(section).toContain("reviewer role");
    expect(section).toContain("watchdog");
    expect(section).toContain("three were on 2026-07-16");
    expect(section).toContain("one was on 2026-07-20");
  });
});

/**
 * agent-tasks 578f5bfd review round 2 (MEDIUM 3): the version-pin describe
 * above only ever checked `.github/workflows/okf-staleness.yml`. Round 2
 * added a second okf-kit install (`okf-anchor-guard` in `ci.yml`), which
 * that check never covered, so `ci.yml`'s own pin could silently drift
 * from `packages/okf-kit/package.json`'s real version with no test to
 * catch it. This globs every file under `.github/workflows/` instead of
 * naming one, so a third workflow adding its own `okf-kit@<version>` pin
 * (install or `npx` form) is covered automatically too.
 */
describe("every okf-kit@<version> pin under .github/workflows/ matches package.json", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");

  const okfKitPackageJson = JSON.parse(
    readRepoFile("packages/okf-kit/package.json"),
  ) as { version: string };
  const version = okfKitPackageJson.version;

  const workflowsDir = `${repoRoot}/.github/workflows`;
  const workflowFiles = readdirSync(workflowsDir).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
  const PIN_RE = /(?:npm install -g|npx) okf-kit@([\w.-]+)/g;

  it("found at least one okf-kit@<version> pin to check (sanity: not vacuously true)", () => {
    let total = 0;
    for (const file of workflowFiles) {
      total += [...readRepoFile(`.github/workflows/${file}`).matchAll(PIN_RE)]
        .length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("every pin (npm install -g and npx forms) across every workflow file equals packages/okf-kit/package.json's version", () => {
    const mismatches: string[] = [];
    for (const file of workflowFiles) {
      const content = readRepoFile(`.github/workflows/${file}`);
      for (const m of content.matchAll(PIN_RE)) {
        if (m[1] !== version) {
          mismatches.push(
            `.github/workflows/${file} pins okf-kit@${m[1]}, package.json is ${version}`,
          );
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});

// Shared by the two anchor-integrity checks below: the docs/okf bundle's
// own set of citable docs, and the kit-source basenames this bundle's
// anchoring covers (SKILL.md, the five assets/agents/*.md templates,
// every src/*.ts module, test/*.test.ts, the seven assets/templates/*.md
// run templates, and assets/agents-md-section.md). Deliberately excludes
// CHANGELOG.md (its citations use okf-kit's own heading-form anchor, a
// different mechanism, already checked by okf-kit's own anchor-heading-*
// rules) and README.md/INSTALL-AGENT.md (neither is a kit-source file;
// both stay out of scope).
//
// Review round 3 (MEDIUM 5): all lists below are derived from their own
// source of truth (`ROLES`, `test/`'s own directory listing, `src/`'s own
// directory listing, `assets/templates/`'s own directory listing,
// `docs/okf/`'s own directory listing) rather than hand-maintained, so a
// role/test-file/source-module/template/doc added later cannot silently
// drift out of sync with what this file actually checks.
//
// agent-tasks ca9d5048: extended from the original four kit-source
// categories (SKILL.md, agent templates, models.ts, test/*.test.ts) to
// every src/*.ts module and every assets/templates/*.md plus
// agents-md-section.md, closing the residual gap named in 578f5bfd round
// 4 (D26). The per-category unanchored-citation counts this round found
// and closed are not hand-duplicated here; see docs/okf/log.md's
// 2026-08-26 entry for the measured breakdown (D31 convention: numbers
// live in the log, not in this comment, so they cannot drift out of sync
// with a later re-measurement).
const ANCHOR_OKF_DOCS = readdirSync(`${PACKAGE_DIR}/docs/okf`)
  .filter((f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md")
  .sort();

const ANCHOR_AGENT_NAMES: readonly Role[] = ROLES;

const ANCHOR_TEST_NAMES = readdirSync(`${PACKAGE_DIR}/test`)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => f.slice(0, -".test.ts".length))
  .sort();

// Every src/*.ts module except models.ts, which the original map already
// carries under its own dedicated entries below.
const ANCHOR_SRC_NAMES = readdirSync(`${PACKAGE_DIR}/src`)
  .filter((f) => f.endsWith(".ts") && f !== "models.ts")
  .map((f) => f.slice(0, -".ts".length))
  .sort();

const ANCHOR_TEMPLATE_NAMES = readdirSync(`${PACKAGE_DIR}/assets/templates`)
  .filter((f) => f.endsWith(".md"))
  .sort();

function anchorScopeResolve(): Record<string, string> {
  const map: Record<string, string> = {
    "SKILL.md": "packages/orchestrator-workflow/assets/skill/SKILL.md",
    "packages/orchestrator-workflow/assets/skill/SKILL.md":
      "packages/orchestrator-workflow/assets/skill/SKILL.md",
    "models.ts": "packages/orchestrator-workflow/src/models.ts",
    "src/models.ts": "packages/orchestrator-workflow/src/models.ts",
    "packages/orchestrator-workflow/src/models.ts":
      "packages/orchestrator-workflow/src/models.ts",
    "agents-md-section.md":
      "packages/orchestrator-workflow/assets/agents-md-section.md",
    "assets/agents-md-section.md":
      "packages/orchestrator-workflow/assets/agents-md-section.md",
    "packages/orchestrator-workflow/assets/agents-md-section.md":
      "packages/orchestrator-workflow/assets/agents-md-section.md",
  };
  for (const name of ANCHOR_AGENT_NAMES) {
    const real = `packages/orchestrator-workflow/assets/agents/${name}.md`;
    map[`${name}.md`] = real;
    map[real] = real;
  }
  for (const name of ANCHOR_TEST_NAMES) {
    const real = `packages/orchestrator-workflow/test/${name}.test.ts`;
    map[`${name}.test.ts`] = real;
    map[`test/${name}.test.ts`] = real;
    map[real] = real;
  }
  for (const name of ANCHOR_SRC_NAMES) {
    const real = `packages/orchestrator-workflow/src/${name}.ts`;
    map[`${name}.ts`] = real;
    map[`src/${name}.ts`] = real;
    map[real] = real;
  }
  for (const name of ANCHOR_TEMPLATE_NAMES) {
    const real = `packages/orchestrator-workflow/assets/templates/${name}`;
    map[name] = real;
    map[`assets/templates/${name}`] = real;
    map[real] = real;
  }
  return map;
}

// Same shape as okf-kit's own CITATION_RE (packages/okf-kit/src/rules/
// citations-resolve.ts): a full citation is `path.ext:N` or `path.ext:N-M`,
// optionally followed by `#anchor` (bare/bracketed heading form, or a
// double-quoted string form). No backtick requirement: okf-kit checks a
// bare `path:N` in running prose exactly the same as a backtick-wrapped
// one, so this test does too.
const ANCHOR_CITATION_RE =
  /([\w./-]+\.(?:ts|js|mjs|md|yml|yaml|json)):(\d+)(?:-(\d+))?(?:#(\[?\w(?:[\w.-]*\w)?\]?|"[^"\n`]*"))?/g;

/**
 * agent-tasks 578f5bfd review round 2 (HIGH 2): pins the two properties
 * that make a string-form anchor actually load-bearing rather than
 * decorative. An anchor sitting on the FIRST line of a wide range survives
 * a k-line insertion above the range whenever k is smaller than the range
 * itself, because the shifted window (the citation's own line numbers,
 * read against the mutated file) still contains the original first line's
 * content, just at a different offset inside the window -- measured this
 * round: 107 of the 121 pre-fix anchors sat on the first line, and a
 * 1-line insertion near the top of SKILL.md left 24 of the round-1
 * bundle's 46 SKILL.md-targeting anchors silently green (corrected
 * 2026-08-26, review round 4, D30: this comment previously said "21 of
 * 61", copied from a mismeasured round-1 total; see docs/okf/log.md).
 * Anchoring on the LAST line instead
 * closes that: the original last line falls out of the shifted window on
 * any k >= 1, not only large ones. Separately, an anchor text that recurs
 * many times in its target can still coincidentally reappear inside a
 * shifted window even with its own original line moved out of it, so (b)
 * caps every anchor's file-wide occurrence count at 3. This test parses
 * every string-anchored full citation in the five docs/okf siblings,
 * resolves its target among the kit-source categories this bundle
 * anchors, and asserts both properties against the real, current target
 * file content -- not the doc's own claim. This test was red against the
 * pre-round-2 anchors (see docs/okf/log.md for the failing counts) and is
 * green after this round's anchor rewrite.
 */
describe("every string-anchored docs/okf citation's anchor is load-bearing (last line, low-collision)", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");
  const RESOLVE = anchorScopeResolve();

  interface AnchoredCitation {
    doc: string;
    citedPath: string;
    real: string;
    start: number;
    end: number;
    anchor: string;
  }

  function collectStringAnchoredCitations(): AnchoredCitation[] {
    const out: AnchoredCitation[] = [];
    for (const doc of ANCHOR_OKF_DOCS) {
      const content = readRepoFile(
        `packages/orchestrator-workflow/docs/okf/${doc}`,
      );
      for (const m of content.matchAll(ANCHOR_CITATION_RE)) {
        const citedPath = m[1];
        const anchorRaw = m[4];
        if (!anchorRaw || !anchorRaw.startsWith('"')) continue;
        const real = RESOLVE[citedPath];
        if (!real) continue;
        const start = Number(m[2]);
        const end = m[3] ? Number(m[3]) : start;
        out.push({
          doc,
          citedPath,
          real,
          start,
          end,
          anchor: anchorRaw.slice(1, -1),
        });
      }
    }
    return out;
  }

  const anchored = collectStringAnchoredCitations();

  it("found at least one string-anchored citation to check (sanity: not vacuously true)", () => {
    expect(anchored.length).toBeGreaterThan(0);
  });

  it("every string anchor's text occurs on the last line of its own cited range", () => {
    const violations: string[] = [];
    for (const c of anchored) {
      const lines = readRepoFile(c.real).split("\n");
      const lastLine = lines[c.end - 1] ?? "";
      if (!lastLine.includes(c.anchor)) {
        violations.push(
          `${c.doc}: \`${c.citedPath}:${c.start}-${c.end}#"${c.anchor}"\` -- ` +
            `anchor not found on last line ${c.end} of ${c.real}`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every string anchor's text occurs at most 3 times in its own target file", () => {
    const violations: string[] = [];
    for (const c of anchored) {
      const text = readRepoFile(c.real);
      const count = text.split(c.anchor).length - 1;
      if (count > 3) {
        violations.push(
          `${c.doc}: \`${c.citedPath}:${c.start}-${c.end}#"${c.anchor}"\` -- ` +
            `anchor text occurs ${count} times in ${c.real} (must be <= 3)`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // agent-tasks ca9d5048 review round 2 (HIGH 1): the last-line and
  // file-wide-<=3 checks above do not rule out an anchor text that recurs
  // MORE THAN ONCE inside its own cited range -- e.g. the same statement
  // repeated at two indentation depths within one function, or a short
  // literal reused across a handful of adjacent array entries. Such an
  // anchor still passes both checks above (it sits on the last line, and
  // 2-3 file-wide occurrences is within the cap) while failing the AC2
  // requirement that the anchor be "eindeutig im Bereich" (unique within
  // the cited range): a k-line insertion above the range can shift the
  // window so the anchor is found at its OTHER in-range occurrence rather
  // than genuinely surviving the shift. This asserts every string anchor's
  // text occurs exactly once inside `[start, end]` of its own cited range,
  // for every string-anchored citation in the bundle, not only newly added
  // ones.
  it("every string anchor's text occurs exactly once inside its own cited range", () => {
    const violations: string[] = [];
    for (const c of anchored) {
      const lines = readRepoFile(c.real).split("\n");
      const rangeText = lines.slice(c.start - 1, c.end).join("\n");
      const count = rangeText.split(c.anchor).length - 1;
      if (count !== 1) {
        violations.push(
          `${c.doc}: \`${c.citedPath}:${c.start}-${c.end}#"${c.anchor}"\` -- ` +
            `anchor text occurs ${count} times inside its own cited range of ${c.real} (must be exactly 1)`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

/**
 * agent-tasks ca9d5048 review round 3 (MEDIUM 1): the docs/okf bundle's
 * OTHER anchor family -- heading-form citations into CHANGELOG.md, e.g.
 * `` `CHANGELOG.md:552-576#0.16.0` `` -- was unguarded by any local test
 * (anchorScopeResolve deliberately excludes CHANGELOG.md, and the string
 * anchor assertions above skip a non-string anchor). Only okf-kit's own CI
 * job caught review round 2's HIGH 1: a 3-line edit to the CHANGELOG's
 * `[Unreleased]` bullet shifted every release heading below it by 3 lines,
 * and none of the 16 heading-anchored citations across the five docs/okf
 * siblings were re-pointed, yet every test in this file stayed green
 * because none of them ever reads CHANGELOG.md as an anchor target. This
 * mirrors okf-kit's own anchor-heading-* resolution
 * (`packages/okf-kit/src/rules/citations-resolve.ts`'s
 * `findEnclosingHeading`): the nearest `## [` heading at or before the
 * range's start line must be the cited version's own heading, and no
 * `## [` heading may start before the range's end line -- the range may
 * end anywhere inside that release's section but must never cross into
 * the next one.
 */
describe("every heading-anchored CHANGELOG.md citation's range stays inside its own release section", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");
  const CHANGELOG_PATH = "packages/orchestrator-workflow/CHANGELOG.md";
  const HEADING_RE = /^## \[([^\]]+)\]/;

  interface ChangelogHeadingCitation {
    doc: string;
    start: number;
    end: number;
    version: string;
  }

  function collectChangelogHeadingCitations(): ChangelogHeadingCitation[] {
    const out: ChangelogHeadingCitation[] = [];
    for (const doc of ANCHOR_OKF_DOCS) {
      const content = readRepoFile(
        `packages/orchestrator-workflow/docs/okf/${doc}`,
      );
      for (const m of content.matchAll(ANCHOR_CITATION_RE)) {
        if (!m[1].endsWith("CHANGELOG.md")) continue;
        const anchorRaw = m[4];
        if (!anchorRaw || anchorRaw.startsWith('"')) continue;
        const version = anchorRaw.replace(/^\[|\]$/g, "");
        const start = Number(m[2]);
        const end = m[3] ? Number(m[3]) : start;
        out.push({ doc, start, end, version });
      }
    }
    return out;
  }

  const citations = collectChangelogHeadingCitations();
  const headingLines: Array<{ lineNo: number; version: string }> = [];
  const changelogLines = readRepoFile(CHANGELOG_PATH).split("\n");
  changelogLines
    .forEach((line, idx) => {
      const m = line.match(HEADING_RE);
      if (m) headingLines.push({ lineNo: idx + 1, version: m[1] });
    });

  it("found at least one heading-anchored CHANGELOG.md citation to check (sanity: not vacuously true)", () => {
    expect(citations.length).toBeGreaterThan(0);
  });

  it("every heading-anchored CHANGELOG.md citation's range starts inside its cited version's section and does not cross into the next", () => {
    const violations: string[] = [];
    for (const c of citations) {
      const enclosing = [...headingLines]
        .reverse()
        .find((h) => h.lineNo <= c.start);
      if (!enclosing || enclosing.version !== c.version) {
        violations.push(
          `${c.doc}: \`CHANGELOG.md:${c.start}-${c.end}#${c.version}\` -- ` +
            `nearest enclosing heading at or before line ${c.start} is ` +
            `${enclosing ? `[${enclosing.version}] at line ${enclosing.lineNo}` : "none"}, not [${c.version}]`,
        );
        continue;
      }
      // The ranges cite the release's bullets, not the heading itself, so
      // a small shift (an [Unreleased] entry above) lands the start line on
      // a blank line or a `#` heading line before the enclosing-heading check
      // above can notice; okf-kit reports the same drift as blank-start-line.
      // Pin it here so a 1-, 2- or 3-line shift fails locally, not only in
      // the okf-kit report.
      const startText = (changelogLines[c.start - 1] ?? "").trim();
      if (startText === "" || startText.startsWith("#")) {
        violations.push(
          `${c.doc}: \`CHANGELOG.md:${c.start}-${c.end}#${c.version}\` -- ` +
            `start line ${c.start} is ${startText === "" ? "blank" : "a heading line"}, not release content (shifted?)`,
        );
        continue;
      }
      const next = headingLines.find((h) => h.lineNo > enclosing.lineNo);
      if (next && next.lineNo <= c.end) {
        violations.push(
          `${c.doc}: \`CHANGELOG.md:${c.start}-${c.end}#${c.version}\` -- ` +
            `range crosses into the next release's heading [${next.version}] at line ${next.lineNo}`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

/**
 * agent-tasks 578f5bfd review round 2 (MEDIUM 5), erosion brake: review
 * round 1 (HIGH 1) found 44 citations into SKILL.md/agent-templates/
 * models.ts/test files that this bundle's own citation-audit round
 * (5c8013c0/578f5bfd round 1) had missed anchoring. This asserts the
 * count stays at zero going forward: any future citation into one of
 * those four kit-source categories that lands in docs/okf without an
 * anchor fails here, listed by doc and citation, instead of silently
 * reintroducing the gap.
 */
describe("every docs/okf citation into a kit-source category this bundle anchors carries an anchor", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");
  const RESOLVE = anchorScopeResolve();

  const missing: string[] = [];
  let examined = 0;
  for (const doc of ANCHOR_OKF_DOCS) {
    const content = readRepoFile(
      `packages/orchestrator-workflow/docs/okf/${doc}`,
    );
    for (const m of content.matchAll(ANCHOR_CITATION_RE)) {
      const citedPath = m[1];
      const real = RESOLVE[citedPath];
      if (!real) continue;
      examined++;
      if (!m[4]) {
        const start = m[2];
        const end = m[3] ? `-${m[3]}` : "";
        missing.push(`${doc}: ${citedPath}:${start}${end}`);
      }
    }
  }

  // Review round 3 (LOW 6a): a brake that only checks "zero missing"
  // would stay green if the collection logic itself broke and silently
  // examined nothing (e.g. a target-resolution regression that emptied
  // `RESOLVE`). The floor sits with headroom below the live count (review
  // round 4, D31: the live count itself is not hand-written here or
  // anywhere else in the bundle). Review round 5 (LOW-g): the count is
  // in the test's own NAME, not only a stdout print -- `examined` is the
  // same variable both the title template literal and the assertion
  // below read, so the two can never diverge, and the count is visible
  // in any reporter's pass/fail line (`--reporter=verbose` or the
  // default) without needing to isolate stdout at all. Run `npx vitest
  // run test/docs-consistency.test.ts -t "in-scope citations (sanity"`
  // and read the count from the passing test's own name.
  //
  // agent-tasks ca9d5048: the floor is set to 200, roughly two thirds of
  // the live count measured on this task's own committed tree (see
  // docs/okf/log.md's 2026-08-26 entry for the exact figure), giving
  // headroom for the count to move around without the sanity check itself
  // needing a bump on every routine anchoring change, while still catching
  // a collection-logic regression that empties or badly shrinks `RESOLVE`.
  it(`examined ${examined} in-scope citations (sanity: the brake itself did not go blind, more than a token number)`, () => {
    expect(examined).toBeGreaterThan(200);
  });

  it("has zero unanchored citations into SKILL.md, an agent template, models.ts, src/*.ts, a test file, or an assets/templates/*.md or agents-md-section.md run template", () => {
    expect(missing, missing.join("\n")).toEqual([]);
  });
});

/**
 * agent-tasks 578f5bfd review round 3 found five full citations into a
 * `*.test.ts` target whose range either ended exactly on a DIFFERENT
 * test's own head line or named an unrelated test outright (all five
 * corrected that round). Review round 4 (D30) found the round-3 fix
 * itself was under-scoped: an "end is a foreign head line" check only
 * catches a citation that stops exactly AT a sibling's declaration; it
 * misses a citation that starts inside one describe/it/test block and
 * ends partway into a different one without landing exactly on that
 * block's own head line. A structural scan of the round-3-corrected
 * bundle found 14 such citations (plus more once single-line citations
 * and non-head-line starts were included in the scan) that the round-3
 * commit message and this file's own comment had called "legitimate
 * deliberate partial citations, not drift" without individually checking
 * each one -- three sampled by hand were citing the wrong test entirely
 * (see docs/okf/log.md for the count found, the count fixed, and the
 * three named examples).
 *
 * This test replaces the round-3 "end is a foreign head line" check with
 * the general rule it was an incomplete approximation of: every full
 * citation's range must lie entirely within ONE describe/it/test block --
 * the block containing the start line must also contain the end line.
 * Ending exactly on that block's own closing `});` is fine; ending inside
 * a nested child block is fine too (a wide citation of an entire
 * `describe` legitimately covers everything nested inside it, since the
 * nested block's own span is still within the describe's span); ending
 * past that block's own closing line -- in a sibling, a parent's trailing
 * content, or outside any block at all -- is not. The start line does not
 * have to be the block's own head line: a citation that begins partway
 * through one test and stays inside that same test the whole way is a
 * legitimate, deliberate sub-range, not drift; only crossing OUT of the
 * block the start line belongs to is flagged. Block boundaries are
 * computed with the TypeScript compiler API (`ts.createSourceFile` plus a
 * `CallExpression` walk for `describe`/`it`/`test` calls), not
 * brace-counting, so a brace inside a string, comment, or regex literal
 * cannot desynchronize the boundary the way naive counting could.
 *
 * Single-line citations are included (the round-3 version skipped
 * `start === end`); a single-line citation still has to resolve to some
 * describe/it/test block to be meaningful.
 */

// Imported here (appended at file end), not moved to the top-of-file
// import block, so adding it does not shift every existing citation into
// this file -- see the ANCHOR_OKF_DOCS comment above for why this file
// treats top-of-file insertion as unsafe.
import ts from "typescript";

describe("every full citation into a *.test.ts target stays inside one describe/it/test block (review round 4, D30)", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");
  const RESOLVE = anchorScopeResolve();

  interface TestBlock {
    startLine: number;
    endLine: number;
  }

  interface Checked {
    doc: string;
    citedPath: string;
    real: string;
    start: number;
    end: number;
  }

  // Only bare `describe(`/`it(`/`test(` calls are matched (an Identifier
  // callee); a property-access form like `describe.each(...)` or
  // `it.skip(...)` has a PropertyAccessExpression callee instead and is
  // silently not collected as a block. None of the five in-scope test
  // files use such a form today (checked: zero `describe.`/`it.`/`test.`
  // call sites across test/*.test.ts), so this is a latent gap, not a
  // measured one.
  function findTestBlocks(fileText: string, fileName: string): TestBlock[] {
    const sf = ts.createSourceFile(
      fileName,
      fileText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const blocks: TestBlock[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["describe", "it", "test"].includes(node.expression.text)
      ) {
        blocks.push({
          startLine:
            sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return blocks;
  }

  function innermostBlock(
    blocks: TestBlock[],
    line: number,
  ): TestBlock | undefined {
    let best: TestBlock | undefined;
    for (const b of blocks) {
      if (b.startLine <= line && line <= b.endLine) {
        if (!best || b.endLine - b.startLine < best.endLine - best.startLine) {
          best = b;
        }
      }
    }
    return best;
  }

  function collectFullTestCitations(): Checked[] {
    const out: Checked[] = [];
    for (const doc of ANCHOR_OKF_DOCS) {
      const content = readRepoFile(
        `packages/orchestrator-workflow/docs/okf/${doc}`,
      );
      for (const m of content.matchAll(ANCHOR_CITATION_RE)) {
        const citedPath = m[1];
        const real = RESOLVE[citedPath];
        if (!real || !real.endsWith(".test.ts")) continue;
        const start = Number(m[2]);
        const end = m[3] ? Number(m[3]) : start;
        out.push({ doc, citedPath, real, start, end });
      }
    }
    return out;
  }

  const checked = collectFullTestCitations();
  const blockCache = new Map<string, TestBlock[]>();
  function getBlocks(real: string): TestBlock[] {
    let blocks = blockCache.get(real);
    if (!blocks) {
      blocks = findTestBlocks(readRepoFile(real), real);
      blockCache.set(real, blocks);
    }
    return blocks;
  }

  it("found at least one full citation into a *.test.ts target to check (sanity: not vacuously true)", () => {
    expect(checked.length).toBeGreaterThan(0);
  });

  it("every citation's start and end line resolve to the same containing describe/it/test block", () => {
    const violations: string[] = [];
    for (const c of checked) {
      const blocks = getBlocks(c.real);
      const startBlock = innermostBlock(blocks, c.start);
      if (!startBlock || c.end > startBlock.endLine) {
        violations.push(
          `${c.doc}: \`${c.citedPath}:${c.start}-${c.end}\` -- start ` +
            `line ${c.start} of ${c.real} is ` +
            (startBlock
              ? `inside a block ending at line ${startBlock.endLine}, but the citation's end (${c.end}) falls past it`
              : `not inside any describe/it/test block at all`),
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
