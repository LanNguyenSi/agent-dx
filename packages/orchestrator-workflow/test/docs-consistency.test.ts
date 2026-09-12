import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, sep } from "node:path";

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
 * Shared by every describe block that compares the `mutation_probes` output
 * contract block between SKILL.md and implementer.md, so the extraction
 * regex itself cannot drift between call sites.
 */
function extractMutationProbesBlock(raw: string): string {
  const match = raw.match(/^mutation_probes:\n(?: {2}.+\n)*/m);
  expect(match, "mutation_probes block not found").toBeTruthy();
  return (match as RegExpMatchArray)[0];
}

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

  it("agents-md-section per-role routing bullet lists every role", () => {
    const match = agentsMdSection.match(
      /Per-role and per-tier model\/effort selections \(([^)]+)\)/,
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
 * grounding-mcp's run-completeness reader (own release cycle, agent-grounding
 * repo) resolves a run through a per-worktree `.ai/run` pointer file before
 * ever falling back to scanning `.ai/runs/`, and reads a keyed
 * `run-base[<key>]` marker in `00-goal.md` for multi-repo runs. This
 * describe block pins that the kit's own docs (the skill, the policy
 * section, the README, and the install doc) actually instruct writing both,
 * in the exact shapes the reader recognises, so the instructions the kit
 * ships cannot drift from what the consumer expects.
 */
describe("run pointer and keyed run-base marker ship in the skill, the policy section, and the install docs", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const agentsMdSection = unwrap(readAsset("agents-md-section.md"));
  const readmeMd = unwrap(readDoc("README.md"));
  const installAgentMd = unwrap(readDoc("INSTALL-AGENT.md"));

  const runStateSection = phraseBoundedSlice(
    skillMd,
    "## Run state",
    "## Workflow",
  );

  /**
   * Discriminates on the exact phrase "`.ai/run` pointer" rather than the
   * bare substring ".ai/run", which also matches unrelated text like
   * ".ai/runs/" (the run directory itself) and so cannot tell a real
   * pointer mention from an incidental one.
   */
  const expectPointerMention = (slice: string) =>
    expect(slice).toContain("`.ai/run` pointer");

  it("SKILL.md Run state documents the .ai/run pointer contract", () => {
    expect(runStateSection).toContain("`<worktree-root>/.ai/run`");
    expect(runStateSection).toContain("absolute path");
    expect(runStateSection).toContain("first non-empty line");
    expect(runStateSection).toContain(".gitignore");
    expect(runStateSection).toContain("sorts newest by directory name");
    expect(runStateSection).toContain("make sure it is ignored");
  });

  it("SKILL.md Run state carries the exact keyed run-base example", () => {
    expect(runStateSection).toContain("run-base[<repo-basename>] = <sha>");
  });

  it("SKILL.md Run state states the keyed-marker grammar rule and both deviation outcomes", () => {
    expect(runStateSection).toContain("on its own line");
    expect(runStateSection).toContain(
      "either rejected (it blocks the run) or not recognised at all",
    );
  });

  it("SKILL.md step 1 mentions writing the .ai/run pointer", () => {
    const step1 = phraseBoundedSlice(
      skillMd,
      "1. **Understand the goal.**",
      "2. **Discover",
    );
    expectPointerMention(step1);
  });

  it("each of the three Harness notes bullets mentions the .ai/run pointer rule", () => {
    const claudeCode = phraseBoundedSlice(
      skillMd,
      "**Claude Code**:",
      "- **opencode**:",
    );
    const opencode = phraseBoundedSlice(
      skillMd,
      "**opencode**:",
      "- **OpenAI Codex**:",
    );
    const codex = phraseBoundedSlice(
      skillMd,
      "**OpenAI Codex**:",
      "## Subagent misfire rule",
    );
    for (const bullet of [claudeCode, opencode, codex]) {
      expectPointerMention(bullet);
    }
  });

  it("agents-md-section Run state carries the pointer and keyed marker bullet", () => {
    const runState = phraseBoundedSlice(
      agentsMdSection,
      "### Run state",
      "### Models",
    );
    expectPointerMention(runState);
    expect(runState).toContain("run-base[<repo-basename>]");
  });

  it("README What gets installed mentions the .ai/run pointer and .gitignore", () => {
    const section = phraseBoundedSlice(
      readmeMd,
      "## What gets installed",
      "## Role profile",
    );
    expectPointerMention(section);
    expect(section).toContain(".gitignore");
  });

  it("INSTALL-AGENT.md write surface mentions the .ai/run pointer and .gitignore", () => {
    const section = phraseBoundedSlice(
      installAgentMd,
      "### Write surface",
      "(opencode)",
    );
    expectPointerMention(section);
    expect(section).toContain(".gitignore");
  });

  it("INSTALL-AGENT.md manual scaffold list mentions the .ai/run pointer and .gitignore", () => {
    const section = phraseBoundedSlice(
      installAgentMd,
      ".ai/runs/.gitkeep`, empty.",
      "Append the content of",
    );
    expectPointerMention(section);
    expect(section).toContain(".gitignore");
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
    expect(skillMd).not.toContain("So far this signal has only been observed");
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
    expect(readmeMd).toContain("role definition itself does not prevent it");
    expect(readmeMd).toContain(
      "A native read-only sandbox can block those writes",
    );
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

  function criterionRecordsShape(): RegExp {
    return /^ {4}acceptance_criteria:\n {6}- id: ""\n {8}required: true\n {8}text: ""\n {8}verification: ""\n {8}negative_space: ""$/m;
  }

  it("SKILL.md's task slicer output contract block carries the list-shaped task fields with the mirrored list shape", () => {
    const block = yamlBlockAfter(skillMdRaw, "## Task slicer output contract");
    for (const field of listShapedTaskFields) {
      expect(
        block,
        `missing "${field}:" (or wrong list shape) in SKILL.md's task slicer output contract`,
      ).toMatch(fieldWithListShape(field));
    }
    expect(block).toMatch(criterionRecordsShape());
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
    expect(block).toMatch(criterionRecordsShape());
  });

  function requiredTaskFields(block: string): string[] {
    // Only the explicit delegation envelope is excluded. Scan the WHOLE
    // block for top-level fields, including those following context.
    const envelope = ["role", "task_id", "context", "expected_output"];
    const topLevel = [...block.matchAll(/^(\w+):/gm)].map((match) => match[1]);
    const context =
      block.match(/^context:\n((?:[ \t]+[^\n]*\n|\n)*)/m)?.[1] ?? "";
    const children = [...context.matchAll(/^ {2}(\w+):/gm)].map(
      (match) => match[1],
    );
    return [
      ...topLevel.filter((field) => !envelope.includes(field)),
      ...children,
    ];
  }

  it("derives fields after context and excludes only immediate envelope fields", () => {
    const input = yamlBlockAfter(skillMdRaw, "## Subagent input contract");
    const extended = input.replace(
      "expected_output:",
      "future_task_field:\n  nested: value\nexpected_output:",
    );
    expect(requiredTaskFields(extended)).toEqual([
      "goal",
      "acceptance_baseline",
      "acceptance_criteria",
      "constraints",
      "allowed_changes",
      "forbidden_changes",
      "future_task_field",
      "relevant_files",
      "relevant_docs",
    ]);
    const slicer = yamlBlockAfter(skillMdRaw, "## Task slicer output contract");
    expect(() => {
      for (const field of requiredTaskFields(extended)) {
        expect(slicer).toMatch(new RegExp(`^ {4}${field}:`, "m"));
      }
    }).toThrow();
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
    const required = requiredTaskFields(subagentBlock);
    // Guard both sides of context: later scope fields must remain covered.
    for (const field of [
      "goal",
      "acceptance_baseline",
      "acceptance_criteria",
      "relevant_files",
      "relevant_docs",
      "constraints",
      "allowed_changes",
      "forbidden_changes",
    ]) {
      expect(required).toContain(field);
    }
    expect(
      subagentBlock.match(/^acceptance_criteria:/gm),
      "the subagent input contract must not silently override record criteria with a second key",
    ).toHaveLength(1);
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
      "acceptance_baseline:",
      "acceptance_criteria:",
      "relevant_files:",
      "relevant_docs:",
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
      "copies each task's goal, acceptance_baseline, acceptance_criteria, relevant_files, relevant_docs, constraints, allowed_changes, and forbidden_changes 1:1 into the subagent input contract",
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
      'mutation_probes: - mutant: "" file: "" anchor: "" before: "" after: "" verified_applied_via: "" result: "" expectation: met | violated restored_verified: "" replayed: false | true';
    expect(skillMd).toContain(field);
    expect(implementerMd).toContain(field);
  });

  it("both copies pin the field enumeration in prose", () => {
    const enumeration =
      "(mutant, file, anchor, before, after, verified_applied_via, result, expectation, restored_verified)";
    expect(skillMd).toContain(enumeration);
    expect(implementerMd).toContain(enumeration);
  });
});

/**
 * The implementer output contract had no field for the commit sha the
 * implementer produced; briefs asked for it in prose and implementers
 * omitted it (twice in one session), forcing the orchestrator to re-derive
 * it from git. Unlike a prose ask, a contract field is checked by the
 * misfire rule. Pins the `commits` field (byte-identical between SKILL.md's
 * reference copy and the installed implementer.md prompt, the same rigor
 * applied to `mutation_probes` above), its not-applicable `commits: []`
 * clause, the misfire-rule sentence that treats an omission as a misfire
 * when the task assignment asked for a commit, and the "full sha" /
 * "in order" semantics themselves, not only the surrounding clauses.
 */
describe("commits field ships in the skill and the implementer prompt", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const implementerMd = unwrap(readAsset("agents/implementer.md"));

  it("the installed implementer prompt instructs reporting the full sha of every commit produced, in order", () => {
    expect(implementerMd).toContain(
      "Report the full sha of every commit you produced on the task branch, in",
    );
    expect(implementerMd).toContain("`commits` field");
    expect(implementerMd).toContain(
      "an output missing that field when the task assignment asked for a commit is treated as a misfire, not evidence",
    );
  });

  it("the subagent misfire rule treats a missing commits field, when a commit was asked for, as a misfire", () => {
    expect(skillMd).toContain(
      "or that omits the `commits` field even though the task assignment asked for a commit",
    );
  });

  it("both copies pin the full-sha, in-order semantics, not only the commits: [] clause", () => {
    expect(skillMd).toContain("full sha");
    expect(implementerMd).toContain("full sha");
    expect(skillMd).toContain("in the order produced");
    expect(implementerMd).toContain("in order");
  });

  it("both implementer output contracts carry an identical commits field (raw, not line-unwrapped)", () => {
    const extractCommitsBlock = (raw: string): string => {
      const match = raw.match(/^commits:\n(?: {2}.+\n)*/m);
      expect(match, "commits block not found").toBeTruthy();
      return (match as RegExpMatchArray)[0];
    };
    const skillBlock = extractCommitsBlock(readAsset("skill/SKILL.md"));
    const implementerBlock = extractCommitsBlock(
      readAsset("agents/implementer.md"),
    );
    expect(skillBlock.length).toBeGreaterThan(5);
    expect(skillBlock).toBe(implementerBlock);
  });

  it("both copies carry the not-applicable commits: [] clause", () => {
    const clause = "`commits: []` rather than omitting the field";
    expect(skillMd).toContain(clause);
    expect(implementerMd).toContain(clause);
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

  it("step 8's trigger reference and the budget section's own trigger name the same 'second'/'third' thresholds (a drifted count in either place must fail this)", () => {
    const stepEight =
      "By the second round-2 halt signal or the third `fix_required` review round on the same task, apply the Review-round escalation budget";
    const sectionTrigger =
      "by the second round-2 halt signal on the same task, or by the third `fix_required` review round on the same task, whichever comes first, choose one of three escalations";
    expect(skillMd).toContain(stepEight);
    expect(skillMd).toContain(sectionTrigger);
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
      "raise the implementer to at least `-xhigh` where that variant is installed, or to the strongest model available in this environment. When it already runs at both, this option is exhausted; under a `full` profile the choice falls to the advisor spawn or the merge-hold, under a `minimal` profile (no advisor subagent to spawn) it falls straight to the merge-hold.",
    );
    expect(skillMd).toContain(
      '"redesign, split, or hold?" and weigh its recommendation before deciding.',
    );
    expect(skillMd).toContain(
      "hold the change unmerged and hand the decision to the operator.",
    );
  });

  it("SKILL.md guards the advisor spawn option with its install/profile condition (F2: no advisor spawn implied under a minimal profile)", () => {
    expect(skillMd).toContain(
      "**Advisor spawn** (where the advisor is installed, `full` profile):",
    );
    expect(skillMd).toContain(
      "under a `minimal` profile (no advisor subagent to spawn) it falls straight to the merge-hold.",
    );
  });

  it("SKILL.md states the choice is mandatory but which one is judgment, and that escalating never replaces a review round", () => {
    expect(skillMd).toContain(
      "Judgment governs which of the three to pick; only that one is chosen and recorded is mandatory.",
    );
    expect(skillMd).toContain("Escalating does not replace a review round");
  });

  it("SKILL.md and agents-md-section.md both name the 03-decisions.md marker by name", () => {
    expect(skillMd).toContain("`review-round-escalation` marker");
    expect(agentsMdSection).toContain("`review-round-escalation` marker");
  });

  it("SKILL.md and agents-md-section.md both record the table row as the data, the marker as its derived shortcut (F1: not just the marker)", () => {
    expect(skillMd).toContain(
      "Add a row (task, choice, reason) to `03-decisions.md`'s Review-round escalation table, the record of the decision, and set the `review-round-escalation` marker to the most recent choice (a reader shortcut derived from that table,",
    );
    expect(agentsMdSection).toContain(
      "adds a row (task, choice, reason) to `03-decisions.md`'s Review-round escalation table, then sets the `review-round-escalation` marker to the most recent choice.",
    );
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
 * (see the CHANGELOG's `[0.30.0]` entry); this test only pins the
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
 * The review-method axis (round 2 of pandora task 226c532c) added
 * `method_applied`/`withdrawn` to both reviewer output-contract copies.
 * Round 1 shipped the fields but no named parity pin existed for them
 * (coverage was only incidental, via whichever ad hoc block comparison a
 * later change happened to add); this closes that gap the same way the
 * `reproduction` and `recurrence` fields above are pinned: field presence
 * in both copies, a byte-for-byte block equality check, plus the
 * SKILL.md step 7 selection-rule sentence and the reviewer.md
 * unnamed-method default.
 */
describe("review-method axis ships method_applied/withdrawn identically in both output contracts", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));

  it("both copies carry the method_applied field with the three-method enum", () => {
    const field = "method_applied: normal | rigorous | adversarial";
    expect(skillMd).toContain(field);
    expect(reviewerMd).toContain(field);
  });

  it("both copies carry the withdrawn field with its description/reason sub-fields", () => {
    const field = 'withdrawn: - description: "" reason: ""';
    expect(skillMd).toContain(field);
    expect(reviewerMd).toContain(field);
  });

  it("the method_applied/withdrawn block is byte-for-byte identical between SKILL.md and reviewer.md (raw, not line-unwrapped)", () => {
    const extractMethodBlock = (raw: string): string => {
      const match = raw.match(/^method_applied:.*\n(?:.+\n)*?```/m);
      expect(match, "method_applied block not found").toBeTruthy();
      return (match as RegExpMatchArray)[0].replace(/\n```$/, "");
    };
    const skillBlock = extractMethodBlock(readAsset("skill/SKILL.md"));
    const reviewerBlock = extractMethodBlock(readAsset("agents/reviewer.md"));
    expect(skillBlock.length).toBeGreaterThan(20);
    expect(skillBlock).toBe(reviewerBlock);
  });

  it("reviewer.md states rigorous as the default when the briefing names no method", () => {
    expect(reviewerMd).toContain("treat an unnamed method as `rigorous`");
    expect(reviewerMd).toContain("`rigorous` (default)");
  });

  it("SKILL.md step 7 states the review-method selection rule by risk class, including the never-adversarial-on-medium constraint", () => {
    expect(skillMd).toContain(
      "Pick it by risk class: `adversarial` at minimum for security judgment, install/deploy scripts, hand-edited lockfiles, cross-major overrides, or anything the operator flags high-risk; `normal` only for docs, renames, or batch cosmetics; `rigorous` otherwise.",
    );
    expect(skillMd).toContain(
      "do not pair `adversarial` with the `-medium` reviewer tier, a budget mismatch that names probes without the effort to run them",
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
 *
 * Agent-dx task T-003 moved `promptProfile` out of cli.ts into
 * cli-inputs.ts (alongside the rest of init's option resolution, extracted
 * into `resolveInitInputs` so a later `apply --target` command can reuse
 * it); this guard now reads the function from its new home.
 */
describe("cli-inputs.ts's --profile prompt labels are derived from rolesForProfile, not hardcoded (review round 1, M1)", () => {
  const cliSrc = readDoc("src/cli-inputs.ts");

  it("promptProfile derives both choice labels from rolesForProfile instead of a literal role list", () => {
    const start = cliSrc.indexOf("async function promptProfile");
    const end = cliSrc.indexOf("/** The subset of `init`'s commander options");
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
// rules) and README.md/INSTALL-AGENT.md: neither is a kit-source file, so
// this in-repo mirror does not cover them, but since agent-tasks 84917365
// their own anchor coverage comes from the unexempted `okf-anchor-guard`
// CI step's `--require-anchors` run instead (see the describe block
// asserting that step carries no `--require-anchors-allow` exemption,
// below).
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

// agent-tasks b50fd903 review round 2 (HIGH 1): defined here, right after
// ANCHOR_CITATION_RE, instead of down by the "Citation-sibling-drift
// guard" section where this regex and its full rationale originally lived
// (see that section's own comment for the extraction pipeline and the
// coverage-gap history). `extractSiblingGuardCitations` (also defined
// further down, but a plain `function` declaration and therefore hoisted
// to the top of the module, reachable from here) is what the three
// `matchAll(ANCHOR_CITATION_RE)` resolution sites below now call so an
// anchored continuation citation is resolved -- and checked -- exactly
// like a full citation at those sites too, not only by the sibling guard
// itself. The regex has to live here, textually, rather than just the
// function that reads it: `describe()` callbacks run top-to-bottom as
// this module loads (a describe body executes synchronously, in file
// order, to register its `it`s), and every one of those three sites calls
// its own citation collector eagerly at the top of its own describe body
// -- so a `const` still declared AFTER those call sites would still be in
// its temporal dead zone at the moment they run, even though the
// `function` that closes over it is already callable by then.
const ANCHOR_CONTINUATION_CITATION_RE =
  /:(\d+)(?:-(\d+))?#(\[?\w(?:[\w.-]*\w)?\]?|"[^"\n`]*")/g;

// agent-tasks b50fd903 review round 2 (LOW 8): the anchor alternation
// inside ANCHOR_CONTINUATION_CITATION_RE above is a hand copy of
// ANCHOR_CITATION_RE's own group 4 anchor pattern, with no coupling
// enforced between the two -- a future edit to one could silently drift
// from the other. Reconstructing one regex from the other programmatically
// would risk a regex-construction bug in a guard 78-plus other docs/okf
// citations resolve through, so this instead asserts the coupling: the
// continuation regex's own source is parsed for its anchor group (the
// text between the known `:(\d+)(?:-(\d+))?#(` prefix and the closing
// `)`), and that substring must occur, unchanged, inside
// ANCHOR_CITATION_RE's own source. A drift between the two throws here,
// at module load, rather than passing silently.
{
  const CONTINUATION_ANCHOR_PREFIX = ":(\\d+)(?:-(\\d+))?#(";
  const continuationSource = ANCHOR_CONTINUATION_CITATION_RE.source;
  if (
    !continuationSource.startsWith(CONTINUATION_ANCHOR_PREFIX) ||
    !continuationSource.endsWith(")")
  ) {
    throw new Error(
      "ANCHOR_CONTINUATION_CITATION_RE's source shape changed; update the " +
        "anchor-alternation coupling check next to its own definition",
    );
  }
  const continuationAnchorAlternation = continuationSource.slice(
    CONTINUATION_ANCHOR_PREFIX.length,
    -1,
  );
  if (!ANCHOR_CITATION_RE.source.includes(continuationAnchorAlternation)) {
    throw new Error(
      "ANCHOR_CONTINUATION_CITATION_RE's anchor alternation has drifted " +
        "from ANCHOR_CITATION_RE's own group 4 anchor pattern",
    );
  }
}

// agent-tasks 8c89aa12: same "last content line" semantics as okf-kit's
// own opt-in `anchor-not-on-last-line` check
// (packages/okf-kit/src/rules/citations-resolve.ts's
// CLOSING_BOILERPLATE_RE/isContentLine/lastContentLineInRange), mirrored
// here rather than imported so this test's assertion is self-contained
// and does not take a runtime dependency on okf-kit's own source tree
// layout. Referenced by symbol name, not a line range: a line-number
// reference here rotted once already (it said "464-494" while the real
// span had already drifted to 472-497, round 3, F4) and would rot again
// on the next unrelated edit to citations-resolve.ts above this span.
// The "mirror stays in sync" assertion right below this block is what
// actually catches drift now, not this comment.
const CLOSING_BOILERPLATE_RE = /^[\]\)\};,]*$/;

function isContentLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && !CLOSING_BOILERPLATE_RE.test(trimmed);
}

function lastContentLineInRange(
  lines: string[],
  startLine: number,
  endLine: number,
): number {
  for (let ln = endLine; ln >= startLine; ln--) {
    if (isContentLine(lines[ln - 1] ?? "")) return ln;
  }
  return endLine;
}

/**
 * agent-tasks 8c89aa12 fix round 3 (F4): the CLOSING_BOILERPLATE_RE/
 * isContentLine/lastContentLineInRange block just above is a hand-copied
 * mirror of okf-kit's own citations-resolve.ts, not an import (see the
 * comment above for why); nothing enforced that the mirror stayed in sync
 * with its source, so a change to okf-kit's logic could silently diverge
 * from what this file actually asserts. This test reads both spans by
 * symbol name (`const CLOSING_BOILERPLATE_RE` through the end of
 * `function lastContentLineInRange`), strips comments and blank lines
 * from each (matching modulo docstring/whitespace, not modulo logic), and
 * asserts the remaining code is byte-identical. Mutation probe: changing
 * one character in either copy fails this test (verified manually this
 * round, not re-run on every CI pass).
 */
describe("the local anchor-not-on-last-line mirror stays in sync with okf-kit's own copy", () => {
  const OKF_KIT_CITATIONS_RESOLVE_PATH = `${PACKAGE_DIR}/../okf-kit/src/rules/citations-resolve.ts`;

  function stripCommentsAndBlankLines(code: string): string {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, incl. JSDoc
      .replace(/^[ \t]*\/\/.*$/gm, "") // whole-line `//` comments
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n");
  }

  function extractMirroredSpan(source: string): string {
    const lines = source.split("\n");
    const startIdx = lines.findIndex((l) =>
      l.includes("const CLOSING_BOILERPLATE_RE"),
    );
    const funcIdx = lines.findIndex(
      (l, i) => i > startIdx && l.startsWith("function lastContentLineInRange"),
    );
    if (startIdx === -1 || funcIdx === -1) {
      throw new Error(
        "could not locate CLOSING_BOILERPLATE_RE / lastContentLineInRange in the given source",
      );
    }
    let endIdx = -1;
    for (let i = funcIdx; i < lines.length; i++) {
      if (lines[i].trim() === "}") {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) {
      throw new Error(
        "could not find the closing brace of lastContentLineInRange",
      );
    }
    return lines.slice(startIdx, endIdx + 1).join("\n");
  }

  it("the mirrored CLOSING_BOILERPLATE_RE/isContentLine/lastContentLineInRange block matches okf-kit's own copy, modulo comments and whitespace", () => {
    const okfKitSource = readFileSync(OKF_KIT_CITATIONS_RESOLVE_PATH, "utf8");
    const localSource = readFileSync(
      fileURLToPath(new URL("docs-consistency.test.ts", import.meta.url)),
      "utf8",
    );
    const okfKitSpan = stripCommentsAndBlankLines(
      extractMirroredSpan(okfKitSource),
    );
    const localSpan = stripCommentsAndBlankLines(
      extractMirroredSpan(localSource),
    );
    expect(localSpan).toEqual(okfKitSpan);
  });
});

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

  // agent-tasks b50fd903 review round 2 (HIGH 1): now consumes
  // `extractSiblingGuardCitations` (the citation-sibling-drift guard's own
  // extractor, defined further down this file) instead of running its own
  // `content.matchAll(ANCHOR_CITATION_RE)` loop, so a resolved, anchored
  // continuation citation (`:N-M#"..."`, path implied by the preceding
  // full citation in the same paragraph) is checked by the three
  // properties below exactly like a full citation is -- this is the site
  // that actually catches a stale continuation anchor: model-
  // preselection.md's four continuations all resolve into `src/init.ts`,
  // not a `*.test.ts` file, so the block-straddle collector further down
  // never sees them either way.
  // agent-tasks b50fd903 review round 3 (MEDIUM 2): `docs` is now an
  // explicit parameter (default: the real ANCHOR_OKF_DOCS content) so a
  // test below can drive this collector against a synthetic doc set
  // carrying a resolved continuation citation and observe whether it
  // survives intact. A mutant narrowing the `for (const c of citations)`
  // filter below to also require the citation's own DOC line to literally
  // contain `c.citedPath` is true for every FULL citation (the path is
  // written right there) but false for a resolved CONTINUATION (whose
  // `citedPath` is inherited from an earlier line, never written on its
  // own) -- such a mutant silently drops every continuation from
  // `anchored` while every existing per-anchor assertion below stays
  // green on the smaller set. The real bundle's own continuations all
  // happen to target `src/init.ts`, so running this collector against the
  // real bundle alone can never prove that drop didn't happen; the
  // synthetic fixture below can.
  function collectStringAnchoredCitations(
    docs: { doc: string; content: string }[] = ANCHOR_OKF_DOCS.map((doc) => ({
      doc,
      content: readRepoFile(`packages/orchestrator-workflow/docs/okf/${doc}`),
    })),
    resolveRealPath: (citedPath: string) => string | undefined = (citedPath) =>
      RESOLVE[citedPath],
  ): AnchoredCitation[] {
    const out: AnchoredCitation[] = [];
    for (const { doc, content } of docs) {
      const citations = extractSiblingGuardCitations(content, resolveRealPath);
      for (const c of citations) {
        if (!c.isStringAnchor || c.anchorText === undefined) continue;
        out.push({
          doc,
          citedPath: c.citedPath,
          real: c.real,
          start: c.start,
          end: c.end,
          anchor: c.anchorText,
        });
      }
    }
    return out;
  }

  const anchored = collectStringAnchoredCitations();

  it("found at least one string-anchored citation to check (sanity: not vacuously true)", () => {
    expect(anchored.length).toBeGreaterThan(0);
  });

  // agent-tasks b50fd903 review round 3 (MEDIUM 2): synthetic-doc-set
  // regression guard for the coupling comment above. `fake/target.ts`
  // resolves to itself; `collectStringAnchoredCitations` never reads the
  // target's own content (only the anchor-load-bearing checks further
  // below do that), so no real repo file is needed. The doc string below
  // carries one full citation and, right after it, one path-less
  // continuation into the same target -- exactly the shape
  // `model-preselection.md` uses for real. Both must survive
  // `collectStringAnchoredCitations` intact.
  it("a resolved continuation citation survives collectStringAnchoredCitations alongside its governing full citation", () => {
    const fakeTarget = "fake/target.ts";
    const doc = [
      "# Fixture",
      "",
      `- see \`${fakeTarget}:1#"line one"\` and, right after it,`,
      '  `:3#"anchor line three"` in the same paragraph.',
      "",
    ].join("\n");
    const found = collectStringAnchoredCitations(
      [{ doc: "fixture.md", content: doc }],
      (citedPath) => (citedPath === fakeTarget ? fakeTarget : undefined),
    );
    expect(
      found.some(
        (c) =>
          c.citedPath === fakeTarget &&
          c.start === 1 &&
          c.anchor === "line one",
      ),
      "the full citation itself must survive",
    ).toBe(true);
    expect(
      found.some(
        (c) =>
          c.citedPath === fakeTarget &&
          c.start === 3 &&
          c.anchor === "anchor line three",
      ),
      "the resolved continuation must survive too (kills a filter that " +
        "requires the citation's own doc line to literally contain " +
        "citedPath, which is only true for a full citation)",
    ).toBe(true);
  });

  // agent-tasks 8c89aa12: aligned with okf-kit's own `--require-anchors`
  // `anchor-not-on-last-line` last-CONTENT-line semantics
  // (packages/okf-kit/src/rules/citations-resolve.ts's
  // CLOSING_BOILERPLATE_RE/isContentLine/lastContentLineInRange,
  // mirrored above -- see the "mirror stays in sync" test right after
  // that mirror for the coupling check, round 3 F4): a range
  // ending on bare closing boilerplate (`});`, `]);`, a lone `}`, ...)
  // is not forced to anchor on that boilerplate line itself, only on the
  // real content line before it. This check previously required the
  // range's literal last line unconditionally, which is unreconcilable
  // with okf-kit's rule for a range ending in such boilerplate: a
  // citation anchored on the real content line just before a closing
  // `});` (e.g. init.test.ts:122-126, whose last line 126 is bare
  // `});`) passes okf-kit but failed this local check, and the reverse
  // (anchored literally on the `});` line) would pass this local check
  // while failing okf-kit's. Kept as a variant only for the strictness
  // this file's other checks still add beyond okf-kit (substring
  // uniqueness below, the TS-AST straddle check further down), not for a
  // different last-line definition.
  it("every string anchor's text occurs on the last content line of its own cited range", () => {
    const violations: string[] = [];
    for (const c of anchored) {
      const lines = readRepoFile(c.real).split("\n");
      const lastContentLine = lastContentLineInRange(lines, c.start, c.end);
      const anchorLine = lines[lastContentLine - 1] ?? "";
      if (!anchorLine.includes(c.anchor)) {
        violations.push(
          `${c.doc}: \`${c.citedPath}:${c.start}-${c.end}#"${c.anchor}"\` -- ` +
            `anchor not found on last content line ${lastContentLine} of ${c.real}`,
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
  //
  // agent-tasks 8c89aa12: kept as a deliberately stricter local variant
  // of okf-kit's own `--require-anchors` `anchor-not-unique-in-range`
  // rather than dropped. okf-kit counts LINE occurrences of the anchor
  // text within the range; this local check counts SUBSTRING occurrences
  // (`rangeText.split(c.anchor).length - 1`), so an anchor text that
  // occurs twice on the same line (e.g. two calls to the same short
  // helper in one statement) is unique-per-line to okf-kit but not
  // unique-per-substring here, and is reported as a local finding
  // instead of silently relying on the looser native rule.
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
 * agent-tasks 578f5bfd review round 2 (MEDIUM 5), erosion brake: review
 * round 1 (HIGH 1) found 44 citations into SKILL.md/agent-templates/
 * models.ts/test files that this bundle's own citation-audit round
 * (5c8013c0/578f5bfd round 1) had missed anchoring. This asserts the
 * count stays at zero going forward: any future citation into one of
 * those four kit-source categories that lands in docs/okf without an
 * anchor fails here, listed by doc and citation, instead of silently
 * reintroducing the gap.
 *
 * agent-tasks 8c89aa12: kept as a deliberately STRICTER local variant of
 * okf-kit's own `--require-anchors` `anchor-required` check, not a
 * redundant duplicate of it (round 1 of this same task dropped this
 * assertion on the mistaken premise that okf-kit's native rule was a
 * strict superset of it; that premise does not hold and this restores
 * the assertion -- see docs/okf/log.md for the correction). okf-kit
 * resolves a bare basename citation (e.g. `SKILL.md:10`) via the citing
 * doc's own frontmatter `sources` list first (packages/okf-kit/src/
 * rules/citations-resolve.ts's path-resolution doc comment, step 1:
 * exact-suffix match, only when exactly one `sources` entry matches),
 * and when that doesn't disambiguate it falls through to a repo-wide
 * basename search; if THAT is ambiguous too (more than one file in the
 * repo shares the basename), okf-kit reports `unresolved-ambiguous` and
 * skips every other check for that citation, `anchor-required` included
 * -- the citation is silently exempt from the native guard, not covered
 * by it. `anchorScopeResolve()` above has no such escape hatch: it binds
 * every bare kit-source basename unconditionally to its one real file
 * under packages/orchestrator-workflow, so this local check still covers
 * a citation okf-kit skips as ambiguous. Demonstrated by mutation probe,
 * not hypothetical: an unanchored `SKILL.md:10` injected into
 * install-fence-mechanics.md (whose own frontmatter `sources` does not
 * list SKILL.md) trips this local assertion while okf-kit's own filter
 * stays at 0, because repo-wide `SKILL.md` is ambiguous between
 * packages/github-api-tool/SKILL.md and this package's own (see
 * docs/okf/log.md for the measured run).
 */
describe("every docs/okf citation into a kit-source category this bundle anchors carries an anchor", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");
  const RESOLVE = anchorScopeResolve();

  // agent-tasks b50fd903 review round 2 (HIGH 1): consumes
  // `extractSiblingGuardCitations` (defined further down this file, the
  // citation-sibling-drift guard's own extractor) instead of a bespoke
  // `content.matchAll(ANCHOR_CITATION_RE)` loop, so `examined` also counts
  // a resolved continuation citation. A continuation can never land in
  // `missing`: ANCHOR_CONTINUATION_CITATION_RE requires the anchor group,
  // so every continuation this extractor returns already carries one.
  // Review round 3 (MEDIUM 4), closed in round 4: `docs` and the resolver
  // are parameters (defaulting to the real bundle) for the same reason
  // `collectStringAnchoredCitations` took them in round 3 -- a mutant
  // that silently drops every resolved continuation here leaves both
  // assertions below green on the real bundle (nothing in it is an
  // unanchored continuation, and `examined` only has to clear a floor),
  // so the property is pinned against a synthetic doc set and as an
  // exact DELTA instead.
  function collectBrakeScan(
    docs: { doc: string; content: string }[] = ANCHOR_OKF_DOCS.map((doc) => ({
      doc,
      content: readRepoFile(`packages/orchestrator-workflow/docs/okf/${doc}`),
    })),
    resolveRealPath: (citedPath: string) => string | undefined = (citedPath) =>
      RESOLVE[citedPath],
  ): { examined: number; missing: string[] } {
    let examined = 0;
    const missing: string[] = [];
    for (const { doc, content } of docs) {
      const citations = extractSiblingGuardCitations(content, resolveRealPath);
      for (const c of citations) {
        examined++;
        if (c.anchorRaw === undefined) {
          const end = c.end !== c.start ? `-${c.end}` : "";
          missing.push(`${doc}: ${c.citedPath}:${c.start}${end}`);
        }
      }
    }
    return { examined, missing };
  }

  const { examined, missing } = collectBrakeScan();

  // Round 4 (MEDIUM 4): the floor below cannot tell 601 from 598, so the
  // continuation-dropping mutant the reviewer found at this collector
  // survived it. Pinned exactly, without hand-writing the live count
  // anywhere: adding ONE doc carrying one full citation raises `examined`
  // by exactly one, and adding one path-less continuation to that same
  // doc raises it by exactly one more. A collector that drops resolved
  // continuations gets the first delta right and the second one wrong.
  const BRAKE_DELTA_TARGET = "fake/brake-target.ts";
  const brakeDeltaResolve = (citedPath: string): string | undefined =>
    citedPath === BRAKE_DELTA_TARGET ? BRAKE_DELTA_TARGET : RESOLVE[citedPath];
  const brakeRealDocs = ANCHOR_OKF_DOCS.map((doc) => ({
    doc,
    content: readRepoFile(`packages/orchestrator-workflow/docs/okf/${doc}`),
  }));
  const brakeFullOnlyDoc = [
    "# Fixture",
    "",
    `- see \`${BRAKE_DELTA_TARGET}:1#"line one"\` for the shape.`,
    "",
  ].join("\n");
  const brakeWithContinuationDoc = [
    "# Fixture",
    "",
    `- see \`${BRAKE_DELTA_TARGET}:1#"line one"\` for the shape, and`,
    '  `:3#"line three"` right after it in the same paragraph.',
    "",
  ].join("\n");

  it("one added full citation raises the brake's examined count by exactly one, and one added continuation citation by exactly one more", () => {
    const base = collectBrakeScan(brakeRealDocs, brakeDeltaResolve).examined;
    const withFull = collectBrakeScan(
      [...brakeRealDocs, { doc: "fixture.md", content: brakeFullOnlyDoc }],
      brakeDeltaResolve,
    ).examined;
    const withContinuation = collectBrakeScan(
      [
        ...brakeRealDocs,
        { doc: "fixture.md", content: brakeWithContinuationDoc },
      ],
      brakeDeltaResolve,
    ).examined;
    expect(withFull - base, "the added full citation must be examined").toBe(1);
    expect(
      withContinuation - withFull,
      "the added path-less continuation citation must be examined too",
    ).toBe(1);
  });

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
 *
 * agent-tasks 8c89aa12: kept as a deliberately stricter local variant of
 * okf-kit's own `--require-anchors` `test-range-straddles-block` rather
 * than dropped. okf-kit's rule is a line-based heuristic (a
 * block-head line at the same or a shallower indent than the range's
 * start line, anywhere in the range other than the start line itself)
 * and documents its own gap: a range that leaves its block without a
 * later block-head line inside it -- ending on an outer block's own
 * closing line -- is not detected. This test computes real block
 * boundaries with the TypeScript compiler API instead, so it also
 * catches that gap; both checks run in CI (this test locally,
 * okf-anchor-guard natively).
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

  // agent-tasks b50fd903 review round 2 (HIGH 1): consumes
  // `extractSiblingGuardCitations` (defined further down this file, the
  // citation-sibling-drift guard's own extractor) instead of a bespoke
  // `content.matchAll(ANCHOR_CITATION_RE)` loop, so a resolved continuation
  // citation into a `*.test.ts` target is checked for block-straddle
  // exactly like a full citation is.
  // Review round 3 (MEDIUM 4), closed in round 4: `docs` and the resolver
  // are parameters (defaulting to the real bundle) so the
  // resolved-continuation property can be pinned against a synthetic doc
  // set here too. The real bundle's own continuations all resolve into
  // `src/init.ts`, never into a `*.test.ts` target, so this collector's
  // own output cannot distinguish "continuations are collected" from
  // "continuations are silently dropped" on the real bundle at all --
  // the mutant that drops them survived every assertion in this file.
  function collectFullTestCitations(
    docs: { doc: string; content: string }[] = ANCHOR_OKF_DOCS.map((doc) => ({
      doc,
      content: readRepoFile(`packages/orchestrator-workflow/docs/okf/${doc}`),
    })),
    resolveRealPath: (citedPath: string) => string | undefined = (citedPath) =>
      RESOLVE[citedPath],
  ): Checked[] {
    const out: Checked[] = [];
    for (const { doc, content } of docs) {
      const citations = extractSiblingGuardCitations(content, resolveRealPath);
      for (const c of citations) {
        if (!c.real.endsWith(".test.ts")) continue;
        out.push({
          doc,
          citedPath: c.citedPath,
          real: c.real,
          start: c.start,
          end: c.end,
        });
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

  // Round 4 (MEDIUM 4): the synthetic-doc-set half of the pin above --
  // one full citation into a `*.test.ts` target and one path-less
  // continuation chained off it in the same paragraph, both of which
  // this collector must return. A mutant that keeps the call to
  // `extractSiblingGuardCitations` but drops resolved continuations
  // afterwards passes every real-bundle assertion in this describe and
  // fails here.
  it("a resolved continuation citation into a *.test.ts target survives collectFullTestCitations alongside its governing full citation", () => {
    const fakeTarget = "fake/target.test.ts";
    const doc = [
      "# Fixture",
      "",
      `- see \`${fakeTarget}:1#"line one"\` and, right after it,`,
      '  `:3#"line three"` in the same paragraph.',
      "",
    ].join("\n");
    const found = collectFullTestCitations(
      [{ doc: "fixture.md", content: doc }],
      (citedPath) => (citedPath === fakeTarget ? fakeTarget : undefined),
    );
    expect(
      found.map((c) => `${c.real}:${c.start}`),
      "both the full citation and the resolved continuation must survive",
    ).toEqual([`${fakeTarget}:1`, `${fakeTarget}:3`]);
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

/**
 * Fix-round-2 regression guard (agent-tasks 05b372d6, review finding F1):
 * a migrated `CHANGELOG.md:#[version]` heading-section citation written
 * without its surrounding backticks is not a citation at all to okf-kit's
 * `HEADING_SECTION_CITATION_RE`/`HEADING_SECTION_MALFORMED_RE` (both
 * require the backtick delimiter), so it silently stops being checked
 * rather than failing loudly. This is a plain string scan for the literal
 * `CHANGELOG.md:#`, not a re-implementation of `findHeadingSection` or
 * the heading-section grammar itself: it only pins the one property that
 * regressed (every occurrence must sit inside a backtick pair, opened
 * immediately before it and closed before the next newline), leaving
 * actual resolution to okf-kit's own `citations-resolve` rule.
 */
describe("every CHANGELOG.md:# heading-section citation is backtick-delimited (review round 2, F1)", () => {
  const LITERAL = "CHANGELOG.md:#";

  interface Candidate {
    doc: string;
    index: number;
  }

  // This block deliberately widens ANCHOR_OKF_DOCS by log.md: the anchor
  // checks skip log.md as append-only history, but a heading-section
  // citation there is still a live citation to okf-kit, and losing its
  // backticks would silently stop it from being one (review round 2).
  const BACKTICK_GUARD_DOCS = [...ANCHOR_OKF_DOCS, "log.md"];

  function collectCandidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const doc of BACKTICK_GUARD_DOCS) {
      const content = readDoc(`docs/okf/${doc}`);
      let index = content.indexOf(LITERAL);
      while (index !== -1) {
        out.push({ doc, index });
        index = content.indexOf(LITERAL, index + LITERAL.length);
      }
    }
    return out;
  }

  const candidates = collectCandidates();

  it("found at least 16 CHANGELOG.md:# candidates to check (sanity: not vacuously true)", () => {
    expect(candidates.length).toBeGreaterThanOrEqual(17);
  });

  // A citation's path prefix (e.g. `packages/orchestrator-workflow/`) may
  // sit between the opening backtick and the "CHANGELOG.md:#" literal
  // itself, so the opener is found by walking backward over path
  // characters (word chars, `.`, `/`, `-`), not by checking the character
  // immediately before the literal.
  const PATH_CHAR_RE = /[\w./-]/;

  it("every candidate is opened by a backtick before its path prefix and closed by a backtick before the next newline", () => {
    const violations: string[] = [];
    for (const { doc, index } of candidates) {
      const content = readDoc(`docs/okf/${doc}`);
      let openerIndex = index - 1;
      while (openerIndex >= 0 && PATH_CHAR_RE.test(content[openerIndex])) {
        openerIndex -= 1;
      }
      const opener = openerIndex >= 0 ? content[openerIndex] : undefined;
      if (opener !== "`") {
        violations.push(
          `${doc}: "${LITERAL}" at offset ${index} is not opened by a ` +
            `backtick before its path prefix (found ${JSON.stringify(opener ?? null)})`,
        );
        continue;
      }
      const closeIndex = content.indexOf("`", index);
      const newlineIndex = content.indexOf("\n", index);
      if (
        closeIndex === -1 ||
        (newlineIndex !== -1 && closeIndex > newlineIndex)
      ) {
        violations.push(
          `${doc}: "${LITERAL}" citation at offset ${index} has no closing ` +
            `backtick before the next newline`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("operator-install CLI surface stays documented in README (fix round 1, L7)", () => {
  const readmeMd = readDoc("README.md");
  const cliTs = readDoc("src/cli.ts");
  const doctorTs = readDoc("src/doctor.ts");

  const OPERATOR_COMMANDS = ["setup", "apply", "doctor", "adopt"] as const;

  /**
   * Slices `src/cli.ts` into one text block per operator-install command,
   * from its `.command("<name>")` call up to (but excluding) the next
   * `.command(` call or end of file, so an `.option(`/`.requiredOption(`
   * match below is scoped to the right command and cannot leak into a
   * sibling command's flags.
   */
  function commandBlock(name: string): string {
    const start = cliTs.indexOf(`.command("${name}")`);
    if (start === -1) {
      throw new Error(`src/cli.ts has no .command("${name}") call`);
    }
    const nextCommand = cliTs.indexOf(".command(", start + 1);
    return nextCommand === -1
      ? cliTs.slice(start)
      : cliTs.slice(start, nextCommand);
  }

  /**
   * Extracts every long-form `--flag` name commander registers via
   * `.option(...)`/`.requiredOption(...)` in the given block. A flag spec
   * string can carry a short alias too (e.g. `"-y, --yes"`), so this pulls
   * every `--word[-word]*` token out of each spec rather than assuming one
   * flag per call.
   */
  function extractLongFlags(block: string): string[] {
    const flags = new Set<string>();
    const callRe = /\.(?:requiredOption|option)\(\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(block)) !== null) {
      const spec = match[1];
      const flagRe = /--[a-zA-Z][a-zA-Z0-9-]*/g;
      let flagMatch: RegExpExecArray | null;
      while ((flagMatch = flagRe.exec(spec)) !== null) {
        flags.add(flagMatch[0]);
      }
    }
    return [...flags];
  }

  const expectedFlags = new Set<string>();
  for (const name of OPERATOR_COMMANDS) {
    for (const flag of extractLongFlags(commandBlock(name))) {
      expectedFlags.add(flag);
    }
  }

  it("found a non-trivial set of flags to check (sanity: not vacuously true)", () => {
    expect(expectedFlags.size).toBeGreaterThanOrEqual(10);
  });

  const operatorSection = (() => {
    const start = readmeMd.indexOf("## Operator-level install");
    const end = readmeMd.indexOf("## Ownership and re-runs", start);
    if (start === -1 || end === -1) {
      throw new Error(
        "README.md lost the Operator-level install section or its successor heading",
      );
    }
    return readmeMd.slice(start, end);
  })();

  it("every setup/apply/doctor/adopt option name appears verbatim inside README's Operator-level install section", () => {
    const missing: string[] = [];
    for (const flag of expectedFlags) {
      const boundaryRe = new RegExp(`(?<![\\w-])${flag}(?![\\w-])`);
      if (!boundaryRe.test(operatorSection)) {
        missing.push(flag);
      }
    }
    expect(missing, missing.join(", ")).toEqual([]);
  });

  const TARGET_STATUSES = (() => {
    const start = doctorTs.indexOf("export type TargetStatus =");
    if (start === -1) {
      throw new Error("src/doctor.ts has no `export type TargetStatus =`");
    }
    const end = doctorTs.indexOf(";", start);
    const union = doctorTs.slice(start, end);
    return [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  })();

  it("found all seven TargetStatus members (sanity: not vacuously true)", () => {
    expect(TARGET_STATUSES.length).toBe(7);
  });

  const doctorParagraph = (() => {
    const start = operatorSection.indexOf("**`doctor [--json] [--prune]`**");
    const end = operatorSection.indexOf("**`adopt", start);
    if (start === -1 || end === -1) {
      throw new Error(
        "README.md lost the doctor paragraph lead-in or the adopt lead-in after it",
      );
    }
    const statusSentenceEnd = operatorSection.indexOf(". It exits", start);
    if (statusSentenceEnd === -1 || statusSentenceEnd > end) {
      throw new Error(
        'README.md doctor paragraph lost its status sentence (ending in ". It exits")',
      );
    }
    return operatorSection.slice(start, statusSentenceEnd);
  })();

  it("every TargetStatus member appears inside README's doctor status sentence", () => {
    const missing: string[] = [];
    for (const status of TARGET_STATUSES) {
      if (!doctorParagraph.includes(`\`${status}\``)) {
        missing.push(status);
      }
    }
    expect(missing, missing.join(", ")).toEqual([]);
  });
});

// Imported here (appended at file end), not moved to the top-of-file import
// block, so adding it does not shift every existing citation into this file
// (line numbers into this file are cited by other docs/okf modules) -- see
// the ANCHOR_OKF_DOCS comment above for why this file treats top-of-file
// insertion as unsafe.
import { adoptExitCodeForStatus, type TargetStatus } from "../src/doctor.js";
import {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  createOperatorManifest,
  upsertOperatorTarget,
} from "../src/operator-manifest.js";

/**
 * agent-tasks b457ee55 (T-009): pins the new operator-install-and-registry.md
 * module doc's load-bearing claims against the real exports they describe,
 * so a later change to the operator manifest schema, the doctor status
 * vocabulary, the CLI command set, or the lock's timing defaults fails here
 * instead of only going stale silently in prose. `createOperatorManifest`/
 * `upsertOperatorTarget` are used rather than a hand-typed key list so the
 * schema pin tracks the real runtime shape, not a second, potentially
 * diverging enumeration of the same fields.
 *
 * fix round (review finding M2): the three per-key `toContain` loops below
 * are not discriminating against an *added* key: a new field whose name
 * happens to already appear elsewhere in the doc (in backticks, for
 * whatever unrelated reason) would keep every `toContain` green while the
 * doc's own "stores exactly ..."/"carries ..." enumeration sentences became
 * false. Each `it` below now also asserts the exact key list via `toEqual`
 * against a literal copied from the doc's current enumeration, so a key
 * added to (or removed from) the real runtime shape fails this test loudly
 * regardless of what the doc's prose happens to already contain, forcing
 * both the test and the doc's enumeration sentence to be updated together.
 */
describe("operator-install-and-registry.md names the real operator manifest schema keys", () => {
  const doc = readDoc("docs/okf/operator-install-and-registry.md");

  function sampleManifest() {
    return createOperatorManifest(
      { harnesses: [], profile: "full", tiers: false, models: {}, routing: {} },
      "2020-01-01T00:00:00.000Z",
    );
  }

  it("names every OperatorManifest envelope key", () => {
    // Literal mirrors the doc's own "carries `kit`, `schemaVersion`,
    // `defaults`, `targets`, `createdAt`, `updatedAt`" sentence; a key added
    // to or removed from the real envelope fails here even if its name
    // already appears elsewhere in the doc.
    expect(Object.keys(sampleManifest())).toEqual([
      "kit",
      "schemaVersion",
      "defaults",
      "targets",
      "createdAt",
      "updatedAt",
    ]);
    for (const key of Object.keys(sampleManifest())) {
      expect(doc).toContain(`\`${key}\``);
    }
  });

  it("names every OperatorManifestDefaults key", () => {
    // Literal mirrors the doc's own "carries `harnesses`, `profile`,
    // `tiers`, legacy `models`, and optional `routing`" sentence.
    expect(Object.keys(sampleManifest().defaults)).toEqual([
      "harnesses",
      "profile",
      "tiers",
      "models",
      "routing",
    ]);
    for (const key of Object.keys(sampleManifest().defaults)) {
      expect(doc).toContain(`\`${key}\``);
    }
  });

  it("names every OperatorTarget registry-entry key", () => {
    const { manifest } = upsertOperatorTarget(
      sampleManifest(),
      "/tmp/operator-install-and-registry-schema-pin",
      "1.2.3",
      "2020-01-01T00:00:00.000Z",
    );
    const target = manifest.targets[0];
    expect(target).toBeDefined();
    // Literal mirrors the doc's own "stores exactly `path`,
    // `lastAppliedVersion`, `lastAppliedAt`" sentence. This is the exact
    // mutation probe from review finding M2: adding `pin?: string` to
    // `OperatorTarget` and emitting it from `upsertOperatorTarget`'s push
    // branch previously kept every per-key `toContain` above green while
    // this doc sentence went false; this `toEqual` now fails loudly
    // instead.
    expect(Object.keys(target as object)).toEqual([
      "path",
      "lastAppliedVersion",
      "lastAppliedAt",
    ]);
    for (const key of Object.keys(target)) {
      expect(doc).toContain(`\`${key}\``);
    }
  });
});

/**
 * agent-tasks b457ee55 (T-009): the seven-member `TargetStatus` union has no
 * runtime export of its own, so this pins the vocabulary as a literal list
 * typed against `adoptExitCodeForStatus`'s parameter (an invalid status
 * string here would fail to compile), and derives the exit-code grouping
 * from that same exported function rather than a second hand-written
 * mapping, so the doc's stated grouping cannot silently diverge from the
 * real one in doctor.ts.
 */
describe("operator-install-and-registry.md names every doctor status and its real exit-code mapping", () => {
  const doc = readDoc("docs/okf/operator-install-and-registry.md");
  const unwrapped = unwrap(doc);
  const STATUSES: TargetStatus[] = [
    "clean",
    "divergent",
    "version-lag",
    "drift",
    "missing",
    "no-manifest",
    "unverifiable",
  ];

  // A per-status `toContain` check would not be discriminating: mutating
  // one status word (e.g. `version-lag` -> `version-lagging`) inside the
  // doc's vocabulary sentence still leaves the correct spelling sitting in
  // several other sentences of the doc (the precedence rule, the exit-code
  // grouping, the pin-rule section, ...), so a per-word `toContain` stays
  // green. Instead this asserts the exact contiguous vocabulary-listing
  // sentence, built from `STATUSES` itself, so any single word substituted
  // inside that one sentence breaks the match.
  it("names the exact seven-status vocabulary as one contiguous, comma-joined sentence", () => {
    const sentence = unwrap(`${STATUSES.map((s) => `\`${s}\``).join(", ")}.`);
    expect(unwrapped).toContain(sentence);
  });

  it("states the real adoptExitCodeForStatus grouping, derived from the export itself", () => {
    const byCode = new Map<number, TargetStatus[]>();
    for (const status of STATUSES) {
      const code = adoptExitCodeForStatus(status);
      byCode.set(code, [...(byCode.get(code) ?? []), status]);
    }
    for (const [code, statuses] of byCode) {
      const phrase = unwrap(
        `\`${code}\` for ${statuses.map((s) => `\`${s}\``).join("/")}`,
      );
      expect(unwrapped).toContain(phrase);
    }
  });
});

/**
 * agent-tasks b457ee55 (T-009): command names are read out of cli.ts's own
 * `.command("...")` registrations rather than hand-listed, so a command
 * added or renamed later is picked up automatically instead of silently
 * going unchecked; `init`/`uninstall` are excluded since they belong to
 * install-fence-mechanics.md, not this doc.
 */
describe("operator-install-and-registry.md names the real operator-facing commands", () => {
  const doc = readDoc("docs/okf/operator-install-and-registry.md");
  const cliSource = readFileSync(`${PACKAGE_DIR}/src/cli.ts`, "utf8");
  const allCommandNames = [
    ...cliSource.matchAll(/\.command\("([a-z]+)"\)/g),
  ].map((m) => m[1]);
  const operatorCommandNames = allCommandNames.filter(
    (name) => name !== "init" && name !== "uninstall",
  );

  it("found the four operator-facing commands in cli.ts (sanity: not vacuously true)", () => {
    expect(operatorCommandNames.sort()).toEqual([
      "adopt",
      "apply",
      "doctor",
      "setup",
    ]);
  });

  it("names every operator-facing command cli.ts actually registers", () => {
    for (const name of operatorCommandNames) {
      expect(doc).toContain(`\`${name}\``);
    }
  });
});

/**
 * agent-tasks b457ee55 (T-009): pins the doc's stated lock timeout/stale
 * window against the real exported constants, not a copied-in number, and
 * against the real invariant (timeout > stale) rather than assuming it.
 * The doc states each number more than once (the timeout is mentioned where
 * it is introduced and again where it is compared to the stale window), so
 * a single `toContain` check is not discriminating: mutating only one of
 * the two mentions would still leave the other one matching. Instead this
 * extracts every `<N>-second timeout`/`<N>-second staleness window` mention
 * from the (whitespace-unwrapped, so a line-wrapped mention still counts)
 * doc text and requires every one of them to equal the real constant.
 */
describe("operator-install-and-registry.md states the real lock timeout and stale-window defaults", () => {
  const doc = readDoc("docs/okf/operator-install-and-registry.md");
  const unwrapped = unwrap(doc);

  it("every second-based mention of the lock timeout matches DEFAULT_LOCK_TIMEOUT_MS", () => {
    const expectedSeconds = DEFAULT_LOCK_TIMEOUT_MS / 1000;
    const mentions = [...unwrapped.matchAll(/(\d+)-second timeout/g)].map((m) =>
      Number(m[1]),
    );
    expect(mentions.length).toBeGreaterThan(0);
    for (const seconds of mentions) {
      expect(seconds).toBe(expectedSeconds);
    }
  });

  it("every second-based mention of the lock stale window matches DEFAULT_LOCK_STALE_MS", () => {
    const expectedSeconds = DEFAULT_LOCK_STALE_MS / 1000;
    const mentions = [
      ...unwrapped.matchAll(/(\d+)-second staleness window/g),
    ].map((m) => Number(m[1]));
    expect(mentions.length).toBeGreaterThan(0);
    for (const seconds of mentions) {
      expect(seconds).toBe(expectedSeconds);
    }
  });

  it("states the real timeout-above-stale invariant, not just the two numbers", () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LOCK_STALE_MS);
    expect(doc).toContain("is deliberately kept above");
  });
});

/**
 * agent-tasks b457ee55 (T-009 fix round 1, review finding H1): the doc
 * previously claimed `doctor`'s own multi-target exit code was "built from"
 * `adoptExitCodeForStatus`'s per-status 0/1/2 mapping. False: `runDoctor`'s
 * own exit code, once a manifest exists to evaluate, is a two-way 0/1
 * aggregate over all registered targets (`doctor.ts`'s `targets.some(...)  ?
 * 1 : 0`), computed inline and never assigning `2` to any individual
 * target's status; `adoptExitCodeForStatus` is a separate, exported,
 * single-target function scoped to `adopt`'s own contract. This pins the
 * two apart: `doctor`'s own exit-code paragraph never attaches a status to
 * exit `2`, and `adopt`'s own paragraph is the only place the full 0/1/2
 * per-status grouping appears. The four-status set that pushes `doctor`'s
 * own aggregate to `1` is read directly out of `doctor.ts`'s source text
 * (there is no exported constant for it, unlike `REMOVE_ON_PRUNE`, which is
 * a different, two-status set used only for `--prune` eligibility), so a
 * change to that inline condition is caught here too.
 */
describe("operator-install-and-registry.md keeps doctor's own aggregate exit code and adopt's per-status mapping distinct", () => {
  const doc = readDoc("docs/okf/operator-install-and-registry.md");
  const doctorSource = readFileSync(`${PACKAGE_DIR}/src/doctor.ts`, "utf8");
  const doctorSection = unwrap(
    phraseBoundedSlice(doc, "## `doctor`", "## `adopt`"),
  );
  const adoptSection = unwrap(
    phraseBoundedSlice(doc, "## `adopt`", "## The pin rule"),
  );

  it("found runDoctor's own status-to-exit-1 set in doctor.ts (sanity: not vacuously true)", () => {
    const blockStart = doctorSource.indexOf(
      "const exitCode: 0 | 1 = targets.some(",
    );
    expect(blockStart, "exitCode block not found").toBeGreaterThanOrEqual(0);
    const blockEnd = doctorSource.indexOf("? 1", blockStart);
    expect(blockEnd, "? 1 not found after exitCode block").toBeGreaterThan(
      blockStart,
    );
    const block = doctorSource.slice(blockStart, blockEnd);
    const statuses = [...block.matchAll(/report\.status === "([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(statuses).toEqual([
      "drift",
      "missing",
      "no-manifest",
      "unverifiable",
    ]);
  });

  it("doctor's own aggregate paragraph never attaches any status to exit 2", () => {
    expect(doctorSection).toContain("`1` if any remaining target");
    expect(doctorSection).toContain("else `0`");
    expect(doctorSection).not.toMatch(/`2`\s+for\s+`/);
  });

  it("adopt's own paragraph names the full 0/1/2 per-status mapping", () => {
    expect(adoptSection).toMatch(/`0`\s+for\s+`clean`/);
    expect(adoptSection).toMatch(/`1`\s+for\s+`drift`/);
    expect(adoptSection).toMatch(/`2`\s+for\s+`missing`/);
  });
});

/**
 * agent-tasks b457ee55 (T-009 fix round 2, review finding M1): the doc
 * previously claimed "once the install actually runs, the only case that
 * runs it and then returns without registering is the pin gate above" --
 * inverted. The pin gate (cli.ts's `if (repoPin && repoPin !==
 * PACKAGE_VERSION && !pinOverridden)` block) returns BEFORE `runInit` is
 * ever called, so it never "runs" the install at all; and registration can
 * still fail AFTER a real install ran, without a second install attempt
 * (the operator-manifest lock-timeout catch, and the
 * `applyRegistrationFailureMessage` branch when the operator manifest turns
 * unreadable or absent between this command's own read and its later
 * write). This pins both halves of the correction: (a) the round-2 wording
 * must not reappear in the doc's own `apply` section, and (b) the real
 * control-flow order in cli.ts -- derived from the source text itself, not
 * hand-copied line numbers -- actually has the pin gate's `return;` before
 * `runInit`'s call, and the lock-timeout catch's `return;` after it, so a
 * later refactor that moves the pin gate past the install fails (b) loudly
 * instead of only leaving the doc's prose to silently go wrong again.
 */
describe("operator-install-and-registry.md's apply section states the pin gate's return in the right order relative to the install (fix round 2, M1)", () => {
  const doc = readDoc("docs/okf/operator-install-and-registry.md");
  const applySection = unwrap(
    phraseBoundedSlice(doc, "## `apply`", "## `doctor`"),
  );
  const cliSource = readFileSync(`${PACKAGE_DIR}/src/cli.ts`, "utf8");

  it("does not claim the pin gate runs the install and then returns", () => {
    expect(applySection).not.toContain(
      "runs it and then returns without registering is the pin gate",
    );
  });

  it("states positively that the pin gate returns before the install, citing the gate before runInit's call site", () => {
    expect(applySection).toContain(
      "The pin gate returns before the install is ever attempted",
    );
    const gateCitation = applySection.search(
      /cli\.ts:\d+(?:-\d+)?#"Repository is pinned at"/,
    );
    const runInitCitation = applySection.search(
      /cli\.ts:\d+(?:-\d+)?#"const report = runInit\(\{"/,
    );
    expect(gateCitation, "pin-gate citation missing").toBeGreaterThanOrEqual(0);
    expect(runInitCitation, "runInit citation missing").toBeGreaterThan(
      gateCitation,
    );
    expect(applySection).not.toMatch(
      /pin gate returns (only )?after the install/,
    );
  });

  it("keeps the post-install registration-failure paragraph (installed but unregistered, exit 1)", () => {
    expect(applySection).toContain(
      "Once the install has actually run, registration can still fail without a second install attempt",
    );
    expect(applySection).toMatch(
      /cli\.ts:\d+(?:-\d+)?#"the kit was installed but the target was not registered"/,
    );
    expect(applySection).toContain("applyRegistrationFailureMessage");
  });

  it("the pin gate's own return precedes runInit's call in cli.ts's real source order, and the lock-timeout catch's return follows it", () => {
    const pinGateIfIndex = cliSource.indexOf(
      "if (repoPin && repoPin !== PACKAGE_VERSION && !pinOverridden) {",
    );
    expect(
      pinGateIfIndex,
      "pin gate condition not found",
    ).toBeGreaterThanOrEqual(0);
    const pinGateReturnIndex = cliSource.indexOf("return;", pinGateIfIndex);
    expect(
      pinGateReturnIndex,
      "pin gate return not found after its condition",
    ).toBeGreaterThan(pinGateIfIndex);

    const runInitIndex = cliSource.indexOf(
      "const report = runInit({",
      pinGateIfIndex,
    );
    expect(
      runInitIndex,
      "runInit call not found after pin gate",
    ).toBeGreaterThan(pinGateIfIndex);

    // The pin gate's own return must lie strictly before runInit's call: a
    // refactor that moved the pin gate to run after the install (or that
    // reordered runInit above the gate) flips this comparison.
    expect(pinGateReturnIndex).toBeLessThan(runInitIndex);

    const lockCatchIndex = cliSource.indexOf(
      "if (error instanceof OperatorManifestLockTimeoutError) {",
    );
    expect(
      lockCatchIndex,
      "lock-timeout catch not found",
    ).toBeGreaterThanOrEqual(0);
    const lockReturnIndex = cliSource.indexOf("return;", lockCatchIndex);
    expect(
      lockReturnIndex,
      "lock-timeout catch's return not found",
    ).toBeGreaterThan(lockCatchIndex);

    // The lock-timeout catch's own return sits AFTER runInit's call: unlike
    // the pin gate, this return is only reachable once the install already
    // ran.
    expect(lockReturnIndex).toBeGreaterThan(runInitIndex);
  });
});

/**
 * Round-2 review fix (agent-tasks 84917365, finding F7a): the
 * `okf-anchor-guard` job's "Anchor-citation guard" step in
 * `.github/workflows/ci.yml` used to run `okf-kit check` with
 * `--require-anchors-allow 'README.md' ...`, exempting README.md and
 * INSTALL-AGENT.md's own citations from the anchor requirement. That
 * allowlist was removed once every citation into those two files was
 * anchored (see docs/okf/log.md's 2026-08-30 entry). Nothing pinned its
 * absence, so a re-added allowlist flag on that step would silently
 * un-cover README.md/INSTALL-AGENT.md again with no test to catch it.
 */
describe("the Anchor-citation guard CI step runs --require-anchors with no --require-anchors-allow exemption", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const workflow = readFileSync(`${repoRoot}/.github/workflows/ci.yml`, "utf8");

  const stepStart = workflow.indexOf("- name: Anchor-citation guard");
  const stepEnd = workflow.indexOf("\n  lint-cli-flag-order:", stepStart);
  const step = workflow.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);

  it("found the step (sanity: not vacuously true)", () => {
    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(stepEnd).toBeGreaterThan(stepStart);
  });

  it("runs okf-kit check with --require-anchors", () => {
    expect(step).toContain("--require-anchors");
  });

  it("never re-adds --require-anchors-allow to this step", () => {
    expect(step).not.toContain("--require-anchors-allow");
  });
});

describe("roles prefer connected structural search, verify, and mutation-probe runners", () => {
  const explorerMd = unwrap(readAsset("agents/explorer.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
  const implementerMd = unwrap(readAsset("agents/implementer.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  // The sentences wrap across lines in the assets; compare with whitespace collapsed.
  const flat = (doc: string) => doc.replace(/\s+/g, " ");

  it("explorer prompt and SKILL.md Discover step carry the same guarded structural-search clause", () => {
    const clause =
      "when a structural code-search tool is available, prefer it over text grep for symbol lookups (callers, definitions)";
    expect(flat(explorerMd)).toContain(clause);
    expect(flat(skillMd)).toContain(clause);
  });

  it("reviewer prompt routes probes through a connected mutation-probe runner and reads a verify runner's summary first", () => {
    expect(flat(reviewerMd)).toContain(
      "When a mutation-probe runner is available in the session, run probes through it instead of editing files by hand",
    );
    expect(flat(reviewerMd)).toContain(
      "when a verify runner is available, read its summary before opening full logs",
    );
  });

  it("implementer prompt runs named checks through a connected verify runner and probes through a connected mutation-probe runner", () => {
    expect(flat(implementerMd)).toContain(
      "When a verify runner is available, run it for the checks the acceptance criteria name and report its summary under `tests.executed`",
    );
    expect(flat(implementerMd)).toContain(
      "run the named probes through it and copy its fields into `mutation_probes`",
    );
  });

  it("the runner guidance stays tool-agnostic: no product or binary name is hardcoded", () => {
    for (const doc of [explorerMd, reviewerMd, implementerMd, skillMd]) {
      for (const name of [
        "agent-primitives",
        "ast-grep",
        "codebase-oracle",
        "ripgrep",
      ]) {
        expect(doc).not.toContain(name);
      }
    }
  });
});

/**
 * Recurring process class from a batch review: an implementer left a long
 * probe or test run backgrounded and ended its turn, so the result was
 * only recovered by resuming the subagent later. The prompt now requires
 * running such a command in the foreground and waiting for it to finish.
 */
describe("the implementer never backgrounds a long verification run (a mutant deleting this sentence must fail this)", () => {
  const implementerMd = unwrap(readAsset("agents/implementer.md"));
  const implementerRules = phraseBoundedSlice(
    implementerMd,
    "Rules:",
    "For v1, return the delegated baseline identity",
  );

  it("implementer prompt requires foreground verification runs, never a backgrounded run left to outlive the turn", () => {
    expect(implementerRules).toContain(
      "Run every long test, build, or mutation-probe command in the foreground",
    );
    expect(implementerRules).toContain(
      "never end your turn with the run still outstanding",
    );
  });
});

/**
 * Recurring process class from a batch review: a spawned-CLI test was
 * calibrated to a byte-count ceiling that sat inside the output's own
 * run-to-run noise (timing digits, temp-dir names), so it passed locally
 * and failed on the next run with no code change. reviewer.md and
 * implementer.md both now carry the same caution and the same two fixes.
 * This pair is pinned in its own dedicated block rather than added to
 * `MIRRORED_CHECKLIST_PAIRS` above, since that table pairs a reviewer
 * checklist item with its SKILL.md mirror, not with implementer.md.
 */
describe("a spawned-CLI test's assertion is calibrated in-process or against its contract, never a byte ceiling inside run-to-run noise", () => {
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
  const implementerMd = unwrap(readAsset("agents/implementer.md"));
  const reviewerTestAdequacy = phraseBoundedSlice(
    reviewerMd,
    "Test adequacy:",
    "- Maintainability:",
  );
  const implementerRules = phraseBoundedSlice(
    implementerMd,
    "Rules:",
    "For v1, return the delegated baseline identity",
  );

  const PHRASE =
    "A test that spawns a CLI and asserts its output against a byte-count ceiling calibrated to sit inside the output's own run-to-run noise";

  it("reviewer.md and implementer.md both carry the byte-ceiling caution, worded identically", () => {
    expect(reviewerTestAdequacy).toContain(PHRASE);
    expect(implementerRules).toContain(PHRASE);
  });

  it("both prompts steer to the same two fixes: pin in-process, or assert the bound/warning contract", () => {
    for (const doc of [reviewerTestAdequacy, implementerRules]) {
      expect(doc).toContain("pin the argument under test in-process");
      expect(doc).toContain(
        "assert the actual contract (a bound, or the presence of a warning), never a byte ceiling",
      );
    }
  });
});

/**
 * Recurring process class from a batch review: the orchestrator ran
 * mutation probes in place on a worktree a reviewer subagent was
 * concurrently reviewing, so the reviewer verified findings against a
 * tree that was mutating under it. SKILL.md step 7 now names the fix.
 */
describe("the orchestrator never probes a worktree a reviewer subagent is concurrently using (SKILL.md step 7)", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const step7 = phraseBoundedSlice(
    skillMd,
    "7. **Delegate review.**",
    "8. **Decide acceptance.**",
  );

  it("step 7 requires worktree isolation or waiting before probing a tree the reviewer is using (a mutant deleting this sentence must fail this)", () => {
    expect(step7).toContain(
      "Never run mutation probes in place against a worktree a reviewer subagent is concurrently reviewing",
    );
    expect(step7).toContain(
      "isolate the probe in a separate worktree or wait until the reviewer has returned",
    );
  });
});

/**
 * The CHANGELOG's own bullet narrates all three rules above (foreground
 * verification, the byte-ceiling caution, and the worktree isolation rule)
 * with their motivating incidents; nothing pinned that prose, so a future
 * edit could silently drop or water down the bullet while the three prompt
 * rules it describes stay intact. Anchor on the bullet's own opening text
 * rather than the release heading above it, since a release moves the
 * bullet under a version heading while the bullet's own wording survives
 * the move unchanged.
 */
describe("the CHANGELOG's release bullet names all three process rules from this round", () => {
  const changelogMd = readDoc("CHANGELOG.md");
  const bulletAnchor =
    "The implementer prompt now requires running every long test, build, or";
  const anchorIndex = changelogMd.indexOf(bulletAnchor);
  const start = changelogMd.lastIndexOf("\n- ", anchorIndex) + 1;
  const next = changelogMd.indexOf("\n## [", start + 1);
  const section = unwrap(
    changelogMd.slice(start, next === -1 ? undefined : next),
  );

  it("names the foreground-run rule, the byte-ceiling caution, and the worktree-isolation rule", () => {
    expect(
      anchorIndex,
      "CHANGELOG bullet anchor phrase not found",
    ).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(0);
    expect(section).toContain(
      "running every long test, build, or mutation-probe command in the foreground",
    );
    expect(section).toContain("byte-count ceiling");
    expect(section).toContain(
      "prohibits running mutation probes in place against a worktree a reviewer subagent is concurrently reviewing",
    );
  });
});

describe("Codex routing and agent-led installation stay documented", () => {
  const installAgentMd = unwrap(readDoc("INSTALL-AGENT.md"));
  const readmeMd = unwrap(readDoc("README.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const agentsMdSection = unwrap(readAsset("agents-md-section.md"));

  it("documents the native Codex agent surface and its fallback", () => {
    for (const doc of [readmeMd, installAgentMd, skillMd]) {
      expect(doc).toContain("`.codex/agents/");
    }
    expect(readmeMd).toContain("`model_reasoning_effort`");
    expect(skillMd).toContain("inline and sequentially");
    expect(skillMd).toContain("When a named-agent selector is available");
    expect(skillMd).toContain(
      "When spawning accepts explicit model and reasoning effort but has no named selector",
    );
    expect(skillMd).toContain("fresh task-local spawn");
    expect(agentsMdSection).toContain(
      "inspect the native delegation capabilities before dispatch",
    );
  });

  it("keeps Codex reviewer sandbox claims precise", () => {
    for (const doc of [readmeMd, skillMd]) {
      expect(doc.toLowerCase()).toContain(
        "reviewer inherits the caller's sandbox",
      );
      expect(doc.toLowerCase()).toContain("prohibits source edits");
    }
  });

  it("documents deterministic routing inputs and preservation", () => {
    for (const doc of [readmeMd, installAgentMd]) {
      expect(doc).toContain("--routing");
      expect(doc).toContain("--codex-catalog");
      expect(doc).toContain("rollback");
    }
    expect(agentsMdSection).toContain("Preserve recorded routing choices");
    expect(agentsMdSection).toContain(
      "never treat a newer model as an automatic upgrade",
    );
  });

  it("makes the agent-led path infer known choices and ask only for unresolved material decisions", () => {
    expect(installAgentMd).toContain(
      "Existing authorization and preferences remain valid",
    );
    expect(installAgentMd).toContain(
      "ask the operator only when a material preference, authority boundary, or conflict remains unresolved",
    );
    expect(installAgentMd).toContain(
      "Do not open a GUI or change global or fleet configuration",
    );
  });

  it("reuses existing overwrite authority before asking about --force", () => {
    expect(installAgentMd).toContain(
      "reuse prior overwrite authority for the same scope",
    );
    expect(installAgentMd).toContain(
      "ask before `--force` only when authority or scope remains unresolved",
    );
    expect(installAgentMd).not.toContain("asks before any `--force` re-run");
  });

  it("does not claim the legacy --models input configures Codex", () => {
    expect(readmeMd).toContain("It does not configure Codex");
    expect(installAgentMd).toContain(
      "`--models` is a backward-compatible input for Claude Code and opencode only; never use it to configure Codex",
    );
  });
});

describe("task briefs enumerate reference sites for changed values", () => {
  const skillMd = readAsset("skill/SKILL.md");
  const taskSlicerMd = readAsset("agents/task-slicer.md");

  it("requires reference sites to be annotated in the existing task fields", () => {
    const instruction =
      "For every identifier, config value, build context, or documented command";
    const expected = [
      "enumerate every file and doc site that references it",
      "`relevant_files` or `relevant_docs`",
      "annotation for a site the task will not edit",
    ];
    for (const doc of [skillMd, taskSlicerMd].map(unwrap)) {
      const start = doc.indexOf(instruction);
      expect(
        start,
        "reference-site instruction missing from asset",
      ).toBeGreaterThanOrEqual(0);
      const sentence = doc.slice(start, doc.indexOf(".", start) + 1);
      for (const phrase of expected) {
        expect(
          sentence,
          `reference-site instruction missing "${phrase}"`,
        ).toContain(phrase);
      }
    }
  });
});

describe("docs-only closing deltas stay narrowly bounded", () => {
  const closingDeltaRule = (doc: string): string => {
    const start = doc.indexOf("After independent review");
    expect(start, "closing-delta rule missing").toBeGreaterThanOrEqual(0);
    const end = doc.indexOf("`accepted`", start);
    expect(end, "closing-delta rule has no accepted Decision").toBeGreaterThan(
      start,
    );
    return unwrap(doc.slice(start, end + "`accepted`".length));
  };
  const rules = [
    closingDeltaRule(readAsset("skill/SKILL.md")),
    closingDeltaRule(readAsset("agents-md-section.md")),
  ];

  it("requires an independent review and an entirely explanatory unreviewed delta", () => {
    for (const rule of rules) {
      expect(rule).toContain("After independent review");
      expect(rule).toContain("without another reviewer round");
      expect(rule).toContain("entire unreviewed delta");
      expect(rule).toContain(
        "explanatory documentation, comments, or citations",
      );
    }
  });

  it("excludes source/test edits, semantic changes, and ineligible findings", () => {
    for (const rule of rules) {
      expect(rule).toContain("source- or test-file edits");
      expect(rule).toContain(
        "executable commands, configuration, policy, instructions, or behavior",
      );
      expect(rule).toContain(
        "low/medium documentation or maintainability findings",
      );
      expect(rule).toContain("high/critical or other ineligible finding");
    }
  });

  it("preserves the review-findings row contract for an eligible closure", () => {
    for (const rule of rules) {
      expect(rule).toContain("`05-review-findings.md` row");
      expect(rule).toContain("Severity and Decision headers unchanged");
      expect(rule).toContain("Decision");
      expect(rule).toContain("`accepted`");
    }
  });
});

/**
 * A fix round replayed only that round's own new mutation probes, letting a
 * regression a prior round's probe would have caught slip back in
 * unnoticed between rounds. This pins the replay rule: step 6's
 * assignment-time instruction to name every mutation probe named in an
 * earlier round of this task (sourced from `04-implementation-summary.md`;
 * on the task's first round there are none to name), the regression-signal
 * consequence for a replayed probe that now survives or can no longer be
 * applied, the `replayed` sub-field added to both output contract copies
 * (byte-identical, the same rigor applied to the other `mutation_probes`
 * sub-fields above), the same rule sentence in the installed
 * implementer.md prompt, and the reviewer-briefing instruction in step 7
 * that lets a reviewer skip re-running a probe the implementer's replay
 * already reports as killed without changing the reviewer contract itself
 * (review round 2: the trigger's ordinal was ambiguous, a replayed-but-now-
 * surviving probe had no reporting consequence, and the step 7 permission
 * had no delivery path since the reviewer never reads SKILL.md). Anchored
 * by a measurement; see the CHANGELOG entry for this rule.
 */
describe("fix-round mutation probe replay ships in step 6, step 7, and both implementer contracts", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const implementerMd = unwrap(readAsset("agents/implementer.md"));
  const changelogMd = readDoc("CHANGELOG.md");

  it("step 6 instructs replaying every mutation probe named in an earlier round of this task", () => {
    expect(skillMd).toContain(
      "On any round after the task's first, the briefing also names every mutation probe named in an earlier round of this task (on the task's first round there are none), drawn from the run's `04-implementation-summary.md`, naming each by its mutant definition (file, anchor, before, after), not merely by its id",
    );
    expect(skillMd).toContain(
      "The implementer replays each one, not only the round's new probes, before the next reviewer spawn, and reports each in `mutation_probes` with the evidence fields plus `replayed: true`",
    );
  });

  it("step 6 treats a replayed probe that now survives or cannot be applied as a regression signal", () => {
    expect(skillMd).toContain(
      "a probe recorded with only an id and no definition to reapply cannot be replayed and is `not_applicable`, not a regression.",
    );
    expect(skillMd).toContain(
      "A replayed probe whose `expectation` is now `violated`, or which can no longer be applied, is the regression signal; `result` alone is not: reported as such (`result` `survived` or `not_applicable` with the reason) and resolved before the next reviewer spawn.",
    );
  });

  it("the installed implementer prompt carries the same replay rule", () => {
    expect(implementerMd).toContain(
      "On any round after the task's first, the assignment also names every mutation probe named in an earlier round of this task (on the task's first round there are none), drawn from the run's `04-implementation-summary.md`, naming each by its mutant definition (file, anchor, before, after), not merely by its id",
    );
    expect(implementerMd).toContain(
      "Replay each one, not only this round's new probes, before returning your report, and report each replayed probe in `mutation_probes` with the evidence fields plus `replayed: true`",
    );
  });

  it("the installed implementer prompt carries the same regression-signal consequence", () => {
    expect(implementerMd).toContain(
      "a probe recorded with only an id and no definition to reapply cannot be replayed and is `not_applicable`, not a regression.",
    );
    expect(implementerMd).toContain(
      "A replayed probe whose `expectation` is now `violated`, or which can no longer be applied, is the regression signal; `result` alone is not: report it as such (`result` `survived` or `not_applicable` with the reason) and resolve it before the next reviewer spawn.",
    );
  });

  it("SKILL.md's output-contract prose paragraph (a third copy of the replay rule) also states the trigger", () => {
    expect(skillMd).toContain(
      "On any round after the task's first, the implementer replays every probe named in an earlier round of this task (on the task's first round there are none), naming each by its mutant definition, not merely by its id, not only this round's new probes, before the next reviewer spawn, reporting each one in `mutation_probes` alongside the round's new probes.",
    );
  });

  it("SKILL.md's output-contract prose paragraph also states the regression-signal consequence", () => {
    expect(skillMd).toContain(
      "A replayed probe whose `expectation` is now `violated`, or which can no longer be applied, is the regression signal, reported as such and resolved before the next reviewer spawn; `result` alone is not a regression signal, and a probe recorded with only an id and no definition to reapply is `not_applicable`.",
    );
  });

  it("SKILL.md's output-contract prose paragraph states the `replayed` semantics (false for new, true for a replayed prior-round probe)", () => {
    expect(skillMd).toContain(
      "Each item also carries `replayed`: `false` for a probe newly introduced this round, `true` for a prior round's probe replayed this round under the replay rule in step 6.",
    );
  });

  it("implementer.md states the `replayed` semantics for a newly introduced probe", () => {
    expect(implementerMd).toContain(
      "Each item also carries `replayed`: `false` for a probe newly introduced this round.",
    );
  });

  it("step 6 instructs recording each mutation probe as a row in 04-implementation-summary.md's Mutation Probes subsection", () => {
    expect(skillMd).toContain(
      "recording each probe the implementer reports as a row in `04-implementation-summary.md`'s Mutation Probes subsection, with the round it was named in.",
    );
  });

  it("both output contract copies carry a byte-identical mutation_probes block including the replayed sub-field", () => {
    const skillBlock = extractMutationProbesBlock(readAsset("skill/SKILL.md"));
    const implementerBlock = extractMutationProbesBlock(
      readAsset("agents/implementer.md"),
    );
    expect(skillBlock).toContain("replayed: false | true");
    expect(skillBlock).toBe(implementerBlock);
  });

  it("step 7 tells the orchestrator to name the replayed-and-killed probes in the reviewer briefing by mutant definition, not merely by id, without changing the reviewer contract", () => {
    expect(skillMd).toContain(
      "the orchestrator's reviewer briefing names the replayed probes the implementer reports as killed together with their mutant definition (`file`, `anchor`, `before`, `after`) and `verified_applied_via` value, not merely their id; a probe recorded with only an id and no definition cannot be skipped this way and is `not_applicable`. The reviewer may then skip re-running the ones named by definition. The reviewer output contract itself is unchanged.",
    );
  });

  it("the reviewer prompt's output-contract yaml block gains no `replayed` field", () => {
    const reviewerMd = readAsset("agents/reviewer.md");
    // Slice from the output-contract heading itself (the way
    // template-markers.test.ts slices from "### Mutation Probes") rather
    // than matching the first yaml fence in the file, so a fence added
    // earlier in the prompt (an example, a decoy) cannot be mistaken for the
    // output contract. Also require exactly one yaml fence in the whole
    // file (not only after the heading), so a fence added anywhere -
    // including above the output contract, where it would silently become
    // the "first fence" the old regex matched - fails this test loudly
    // instead of passing by accident. The whole-file count is the primary
    // guard: it fails for an added fence anywhere in the file. The heading
    // slice below is a second, narrower guard that additionally covers the
    // one case the whole-file count alone would not distinguish: the
    // file's single fence sitting above the heading instead of after it.
    const allFences = [...reviewerMd.matchAll(/```yaml\n([\s\S]*?)```/g)];
    expect(
      allFences.length,
      "expected exactly one yaml fence in reviewer.md",
    ).toBe(1);
    const heading =
      "Return exactly this structure as your final output, nothing else:";
    const headingIndex = reviewerMd.indexOf(heading);
    expect(
      headingIndex,
      "reviewer output-contract heading not found",
    ).toBeGreaterThanOrEqual(0);
    const afterHeading = reviewerMd.slice(headingIndex);
    const fences = [...afterHeading.matchAll(/```yaml\n([\s\S]*?)```/g)];
    expect(
      fences.length,
      "expected exactly one yaml fence after the output-contract heading",
    ).toBe(1);
    const outputContractBlock = fences[0][1];
    // The file's one fence (asserted above) must be this one: ties the
    // whole-file guard and the heading-slice guard to the same block.
    expect(outputContractBlock).toBe(allFences[0][1]);
    expect(outputContractBlock).not.toContain("replayed");
  });

  it("both copies' mutation_probes block has exactly the ten sub-fields in a fixed order", () => {
    const skillBlock = extractMutationProbesBlock(readAsset("skill/SKILL.md"));
    const implementerBlock = extractMutationProbesBlock(
      readAsset("agents/implementer.md"),
    );
    const subFieldNames = (block: string): string[] =>
      [...block.matchAll(/^\s*(?:- )?(\w+):/gm)].map((m) => m[1]);
    const expectedOrder = [
      "mutation_probes",
      "mutant",
      "file",
      "anchor",
      "before",
      "after",
      "verified_applied_via",
      "result",
      "expectation",
      "restored_verified",
      "replayed",
    ];
    expect(subFieldNames(skillBlock)).toEqual(expectedOrder);
    expect(subFieldNames(implementerBlock)).toEqual(expectedOrder);
  });

  // The CHANGELOG's own prose description of the replay rule is a fourth
  // copy (after SKILL.md step 6, SKILL.md's output-contract paragraph, and
  // implementer.md) and was previously unpinned. Anchor on a phrase inside
  // the bullet rather than the "[Unreleased]" heading above it, since a
  // release moves the bullet under a version heading (it now sits under
  // `[0.30.0]`, released the same day this pin was added) while the
  // bullet's own wording survives the move unchanged. The anchor phrase
  // itself deliberately stops short of the trigger clause ("after a
  // task's first") and the two evidence phrases checked below, so those
  // checks are real: none of them is already guaranteed true merely
  // because the anchor was found, the way a check against the anchor's
  // own text would be.
  it("the CHANGELOG's own prose copy of the replay rule names the trigger and the `replayed` field", () => {
    const bulletAnchor = "the orchestrator's briefing names";
    const anchorIndex = changelogMd.indexOf(bulletAnchor);
    expect(
      anchorIndex,
      "CHANGELOG replay-rule bullet anchor phrase not found",
    ).toBeGreaterThanOrEqual(0);
    const bulletStart = changelogMd.lastIndexOf("\n- ", anchorIndex) + 1;
    expect(
      bulletStart,
      "start of CHANGELOG replay-rule bullet not found",
    ).toBeGreaterThan(0);
    // The bullet ends at the next bullet, or (if this is the list's last
    // bullet) the next heading, or (if nothing follows) the file's end.
    let bulletEnd = changelogMd.indexOf("\n- ", anchorIndex + 1);
    if (bulletEnd < 0) {
      bulletEnd = changelogMd.indexOf("\n#", anchorIndex + 1);
    }
    if (bulletEnd < 0) {
      bulletEnd = changelogMd.length;
    }
    const bullet = changelogMd.slice(bulletStart, bulletEnd);
    // Names the trigger: a fix round after the task's first round. Real
    // check: the anchor above stops before this clause.
    expect(bullet).toContain("On any round after a task's first");
    expect(bullet).toContain("every mutation probe named in an earlier round");
    // Names the `replayed` field the evidence is carried in.
    expect(bullet).toContain("`replayed` sub-field");
  });
});

/**
 * Pins the GitHub Actions run-step shell-replay checklist item, each element
 * bounded via `phraseBoundedSlice` to the rule's own sentences in
 * `implementer.md` and `reviewer.md` (from the trigger phrase through the
 * untrusted-event-data clause) so an unrelated match elsewhere in either
 * file cannot satisfy the check. Covers: the trigger phrase; the condition
 * that selects the pipefail form (the `-eo pipefail` invocation when
 * `shell: bash` is set on the step or via `defaults.run.shell`, since a bare
 * `run:` step with no `shell:` key defaults to `bash -e` with no pipefail);
 * the platform note that the `bash -e` default holds on Linux and macOS
 * runners while Windows runners default to pwsh; the expected-success/
 * expected-failure replay; the in-order job replay; the non-zero-exit guard
 * requirement; and the `${{ }}` substitution/untrusted-data clause. Also
 * pins that the reviewer prompt alone replays in a scratch copy outside the
 * reviewed working tree (keeping its read-only Bash rule intact), that only
 * the reviewer prompt's copy points to the `reproduction` field, SKILL.md's
 * one-sentence reference to the installed implementer prompt, and the
 * CHANGELOG citation the rule's `[0.30.0]` entry carries.
 */
describe("GitHub Actions run-step shell replay ships in the implementer prompt, the reviewer prompt, and SKILL.md", () => {
  const implementerMd = unwrap(readAsset("agents/implementer.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));
  const changelogMd = readDoc("CHANGELOG.md");

  const startPhrase =
    "any diff that adds or changes a GitHub Actions `run:` step";
  const endPhrase = "never paste untrusted event data into your shell.";

  const implementerSlice = phraseBoundedSlice(
    implementerMd,
    startPhrase,
    endPhrase,
  );
  const reviewerSlice = phraseBoundedSlice(reviewerMd, startPhrase, endPhrase);

  const sharedElements = [
    "any diff that adds or changes a GitHub Actions `run:` step",
    "--noprofile --norc -eo pipefail",
    "when `shell: bash` is set on the step or via",
    "`defaults.run.shell`",
    "`bash -e` otherwise on Linux and macOS runners (Actions'",
    "Windows runners default to pwsh",
    "the expected-success and the expected-failure inputs",
    "replay its steps in their committed order",
    "captures the status inside an `if` or a `set +e`/`set -e` guard",
    "Substitute `${{ }}` expressions with representative values before replaying",
    "never paste untrusted event data into your shell",
  ];

  it("the installed implementer prompt's own rule sentences carry the shell-replay rule", () => {
    for (const element of sharedElements) {
      expect(implementerSlice).toContain(element);
    }
  });

  it("the installed reviewer prompt's own rule sentences carry the same shell-replay rule", () => {
    for (const element of sharedElements) {
      expect(reviewerSlice).toContain(element);
    }
  });

  it("the reviewer prompt's copy replays in a scratch copy outside the reviewed working tree, keeping the read-only Bash rule intact", () => {
    expect(reviewerMd).toContain(
      "Do the replay in a scratch copy of the repository outside the reviewed working tree",
    );
    expect(reviewerMd).toContain(
      "this keeps the replay compatible with the read-only Bash rule",
    );
    expect(implementerMd).not.toContain(
      "scratch copy of the repository outside the reviewed working tree",
    );
  });

  it("only the reviewer prompt reports the replay in the reproduction field", () => {
    expect(reviewerMd).toContain(
      "Report the replay in the `reproduction` field",
    );
    expect(implementerMd).not.toContain(
      "Report the replay in the `reproduction` field",
    );
  });

  it("the reviewer prompt's reproduction trigger names the shell replay as a second, non-probabilistic trigger", () => {
    expect(reviewerMd).toContain(
      "The GitHub Actions shell replay above is a second, explicitly non-probabilistic trigger for the same field",
    );
  });

  it("SKILL.md carries one sentence pointing to the installed implementer prompt", () => {
    expect(skillMd).toContain(
      "the installed `implementer.md` prompt requires replaying it locally under the shell the step actually runs",
    );
    expect(skillMd).toContain(
      "with the expected-success and the expected-failure inputs, before treating it as tested",
    );
  });

  it("SKILL.md mirrors the reviewer's second reproduction trigger", () => {
    expect(skillMd).toContain(
      "The GitHub Actions shell replay named in step 6 is a second, explicitly non-probabilistic trigger for the same field",
    );
  });

  it("the CHANGELOG's 0.30.0 section carries the ow-kit-effort-analysis.md section 7(vi) citation", () => {
    const start = changelogMd.indexOf("## [0.30.0]");
    const next = changelogMd.indexOf("\n## [", start + 1);
    expect(start).toBeGreaterThan(-1);
    const section = changelogMd.slice(start, next === -1 ? undefined : next);
    expect(section).toContain("ow-kit-effort-analysis.md` section 7(vi)");
  });

  it("docs/okf/subagent-contracts-superset.md names the shell replay as the reproduction field's second trigger", () => {
    const subagentContractsMd = readDoc(
      "docs/okf/subagent-contracts-superset.md",
    ).replace(/\s+/g, " ");
    expect(subagentContractsMd).toContain(
      "The GitHub Actions run-step shell replay named in both installed prompts (see CHANGELOG's `[0.30.0]` entry) is a second, explicitly non-probabilistic trigger for the same field: `sample_size: not_applicable` is allowed when the replay itself has no meaningful sample size",
    );
  });
});

/**
 * Pins the identifier-drift reviewer checklist item added alongside the
 * GitHub Actions shell-replay item above: after a change deletes or
 * renames an exported identifier, type, config key or file, comments,
 * README, unshipped CHANGELOG prose, or doc comments that still describe
 * the old name as current are drift and are findings; when a drift check
 * is connected it is run over the base..head range, and (T-003b) its
 * allowlist is checked only conditionally, not asserted as fact for every
 * connected checker. The item itself stays tool-agnostic (see the "roles
 * prefer connected structural search, verify, and mutation-probe runners"
 * describe block's tool-agnosticism guard); the concrete
 * `agent-primitives drift` guard is named only in CHANGELOG.md. Appended
 * at the file's end (not inserted mid-file) so no earlier line-anchored
 * OKF citation into this file shifts. `reviewerMd` is already
 * whitespace-collapsed by `unwrap`, so slicing it needs no further
 * flattening.
 */
describe("identifier drift ships as a reviewer checklist item", () => {
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
  const changelogMd = readDoc("CHANGELOG.md");

  const driftSlice = phraseBoundedSlice(
    reviewerMd,
    "Identifier drift: after a change deletes or renames an exported identifier, type, config key or file",
    "the change under review).",
  );

  it("the reviewer prompt names the trigger with the exact 'after a change deletes or renames' wording (a mutant broadening it to 'after any change' must fail this)", () => {
    expect(driftSlice).toContain(
      "after a change deletes or renames an exported identifier, type, config key or file",
    );
    expect(driftSlice).not.toContain("after any change");
  });

  it("the reviewer prompt states the check: comments, README, unshipped CHANGELOG prose, or doc comments still describing the old name as current are drift and are findings", () => {
    expect(driftSlice).toContain(
      "check whether comments, README, unshipped CHANGELOG prose or doc comments still describe the old name as current",
    );
    expect(driftSlice).toContain("such sites are drift and are findings");
  });

  it("the reviewer prompt names the 'drift check ... is connected' clause (a mutant removing this clause must fail this)", () => {
    expect(driftSlice).toContain(
      "When a drift check that lists docs and comments still naming a removed or renamed identifier is connected, run it over the base..head range and judge every site it reports",
    );
  });

  // Narrow on purpose: this only guards the one product name the item must
  // never hardcode (decision D-026); it is not a general prohibition on
  // every possible tool or vendor name appearing in this item.
  it("the reviewer prompt stays generic here: no product or binary name is hardcoded in this item", () => {
    expect(driftSlice).not.toContain("agent-primitives");
  });

  it("the reviewer prompt makes the allowlist check conditional, not a blanket claim (a mutant restoring the old unconditional 'its allowlist covers ...' wording must fail this)", () => {
    expect(driftSlice).toContain(
      "if it allowlists released changelog sections or historical phrasing, check that its allowlist matches the change under review",
    );
    expect(driftSlice).not.toContain(
      "its allowlist covers released changelog sections and historical phrasing",
    );
  });

  it("the CHANGELOG's identifier-drift bullet carries the ow-kit-effort-analysis.md section 7(iv) citation and names the agent-primitives drift guard (a mutant re-citing 7(v) must fail this)", () => {
    // Anchored on the bullet's own opening and closing text rather than the
    // release-section span, so this still holds if the bullet moves under a
    // later version heading.
    const section = unwrap(
      phraseBoundedSlice(
        changelogMd,
        "The installed reviewer prompt now carries a checklist item for identifier\n  drift:",
        "section 7(iv).",
      ),
    );
    expect(section).toContain("ow-kit-effort-analysis.md` section 7(iv)");
    expect(section).toContain("agent-primitives drift");
    expect(section).toContain("see the agent-primitives package");
  });
});

/**
 * T-003b (agent-dx 503136a4): the identifier-drift item has no SKILL.md
 * counterpart even though the kit otherwise mirrors reviewer checks there
 * (Placement at step 9, the Actions replay at steps 6/7), and Scaling
 * delegation lets the orchestrator review a trivial rename itself, where
 * the reviewer prompt never loads. SKILL.md step 7 now carries one
 * sentence covering that gap, beside the Actions-replay reference it
 * shares a paragraph with.
 */
describe("identifier drift is also covered for the orchestrator's own trivial-rename review (SKILL.md step 7)", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("step 7 names identifier drift for a deleted or renamed exported identifier, type, config key, or file, covering both the reviewer and the orchestrator's own trivial-rename review (a mutant deleting this sentence must fail this)", () => {
    expect(skillMd).toContain(
      "A change that deletes or renames an exported identifier, type, config key, or file is also checked for identifier drift",
    );
    expect(skillMd).toContain(
      "by the reviewer or by the orchestrator itself when it reviews a trivial rename per Scaling delegation, using a connected drift check when one exists",
    );
  });
});

/**
 * The reviewer checklist items above are individually pinned in
 * `reviewer.md`, and several are separately pinned again wherever SKILL.md
 * carries a mirrored sentence for the orchestrator (Placement at step 9,
 * the GitHub Actions shell replay at steps 6/7, identifier drift at step
 * 7). Those pins live in independent `describe` blocks, so removing one
 * side of a mirrored pair only fails the block that pins that side: a
 * reviewer.md edit that silently drops its SKILL.md counterpart (or vice
 * versa) is not caught by any single existing test. This block asserts
 * every mirrored pair together from one table, so either half missing
 * fails the same test.
 *
 * Convention for adding a new pair (when a new reviewer checklist item
 * gains a SKILL.md mirror): add one entry to `MIRRORED_CHECKLIST_PAIRS`
 * with a short `item` label, the exact `reviewerPhrase` substring (after
 * `unwrap`, so line-wrapping in the source file does not matter), and the
 * exact `skillPhrase` substring its SKILL.md counterpart carries. Do not
 * add a pair for a checklist item that has no SKILL.md mirror (identifier
 * drift's own reviewer-only wording, e.g. the "no product or binary name
 * is hardcoded" guard above, stays out of this table on purpose). Not
 * every mirrored item lives in this table: Recurrence, the empirical
 * reproduction rule, and the mandatory `acceptance_recommendation` field
 * are also mirrored between reviewer.md and SKILL.md, but each is already
 * pinned as a pair in its own dedicated `describe` block elsewhere in this
 * file, so they are deliberately not duplicated here. The byte-ceiling
 * caution is mirrored too, but between reviewer.md and implementer.md, not
 * between reviewer.md and SKILL.md; it does not belong in this table (which
 * pairs a reviewer checklist item with its SKILL.md mirror only) and stays
 * pinned in its own dedicated block above instead.
 */
describe("the reviewer checklist items mirrored in this table still carry their SKILL.md counterpart", () => {
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  const MIRRORED_CHECKLIST_PAIRS: Array<{
    item: string;
    reviewerPhrase: string;
    skillPhrase: string;
  }> = [
    {
      item: "Placement",
      reviewerPhrase:
        "Placement: does the change add org-, machine-, or point-in-time-bound evidence",
      skillPhrase:
        "check that no org-, machine-, or point-in-time-bound evidence was added to a reusable instruction file",
    },
    {
      item: "GitHub Actions shell replay",
      reviewerPhrase:
        "GitHub Actions shell replay: for any diff that adds or changes a GitHub Actions `run:` step, replay it yourself under the shell the step actually runs",
      skillPhrase:
        "The GitHub Actions shell replay named in step 6 is a second, explicitly non-probabilistic trigger for the same field",
    },
    {
      item: "identifier drift",
      reviewerPhrase:
        "Identifier drift: after a change deletes or renames an exported identifier, type, config key or file",
      skillPhrase:
        "A change that deletes or renames an exported identifier, type, config key, or file is also checked for identifier drift",
    },
  ];

  it.each(MIRRORED_CHECKLIST_PAIRS)(
    "$item: reviewer.md and SKILL.md both carry their half of the pair",
    ({ reviewerPhrase, skillPhrase }) => {
      expect(reviewerMd).toContain(reviewerPhrase);
      expect(skillMd).toContain(skillPhrase);
    },
  );

  it("found at least three mirrored pairs to check (sanity: not vacuously true)", () => {
    expect(MIRRORED_CHECKLIST_PAIRS.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Citation-sibling-drift guard.
//
// A citation that resolves and anchors correctly by every check above can
// still name the WRONG sibling among a run of near-identical citations --
// three review findings shared one shape: the same `file:range#anchor`
// cited twice in one paragraph while a genuinely different, equally-real
// sibling range went uncited (a repeated-`it`-block citation collapsing
// three sibling ranges onto one, twice; three per-harness bullet citations
// doing the same), or a string anchor's own text also occurring, verbatim,
// at another uncited line of the same target within a short window while
// the paragraph cites a sibling range of that file (two logically distinct
// assertions collapsing onto one shared range and anchor text). Neither
// okf-kit's `citations-resolve` rule nor the local anchor guards above can
// see this class: every individual citation involved passes "on the last
// content line", "unique within its own range", and "<=3 file-wide"
// unchanged, because the defect is a PAIRING problem across citations in
// the same paragraph, not a property of any one citation read in
// isolation.
//
// Two mechanical rules, applied per paragraph (a paragraph is a maximal run
// of non-blank doc lines; a citation never spans a line break, so every
// match is attributed to exactly one paragraph):
//
//   (a) duplicate-citation: the same resolved `file:range#anchor` (heading
//       or string form) appears two or more times within one paragraph.
//       This is the shape a paragraph takes when prose meant to walk on to
//       the next sibling and instead re-typed the previous citation.
//
//   (b) wrong-sibling-anchor: a STRING anchor's own text also occurs,
//       verbatim, on another line of the same target file, within
//       SIBLING_GUARD_WINDOW lines of the citation's own range, that (i)
//       lies outside the citation's own range AND (ii) is not itself
//       covered by any other citation to that file already present in the
//       same paragraph, while the paragraph cites at least one sibling
//       range of that file. An "unclaimed" nearby occurrence like this is
//       exactly what a wrong-sibling re-point leaves behind: the real,
//       correct line for the reference the citation was meant to make
//       sits right there, uncited, while the citation instead repeats (or
//       sits right next to) a sibling's own range. Heading-form anchors
//       are out of scope for this rule (no "occurs on a line" semantics
//       for a section-level anchor); rule (a) still covers a
//       heading-anchored duplicate.
//
// SIBLING_GUARD_WINDOW is 20, widened from the round-1 value of 10 (round 2
// D-010) once a real bundle case was measured to fall outside it: two
// genuinely distinct sibling notes sharing identical text 20 lines apart
// (see docs/okf/log.md for the measured hit counts at each window and the
// re-triage of every additional hit the wider window surfaces). Every hit
// this window reports against the current bundle is read against its real
// target file and the citing paragraph, then either fixed (a real
// mis-pointed citation) or allowlisted below with the specific reason
// found -- see docs/okf/log.md for the current measured counts, kept out
// of this comment per this file's own D31 convention of leaving numbers to
// the log rather than hand-writing them at two sites that can drift apart.
//
// A path-less continuation citation (`:N-M#"..."`, whose path is implied
// by the preceding FULL citation in the same paragraph) used to never
// match ANCHOR_CITATION_RE at all, so this guard could not see one --
// model-preselection.md alone carries four. Closed:
// ANCHOR_CONTINUATION_CITATION_RE (defined earlier in this file,
// immediately after ANCHOR_CITATION_RE -- see the comment there for why
// it has to live there textually) matches the path-less tail on its own,
// and `governingPathByParagraph` below resolves it against the nearest
// preceding full citation's own `citedPath` in the SAME paragraph (reset
// per paragraph, exactly like the paragraph id itself; and reset again,
// not carried, across an unresolved or ambiguous full citation in that
// paragraph -- see the `else` branch below), the same "nearest preceding,
// same paragraph" BINDING RULE okf-kit's own short-form/continuation
// citations use in citations-resolve.ts. That is a mirror of the binding
// rule only, not of the grammar: this bundle's anchored, path-less
// `:N-M#"..."` form IS backtick-wrapped (round 3 correction: an earlier
// version of this comment said "no backticks, no connective", which is
// false), but okf-kit's own `CONT_COLON_RE`/`SHORT_FORM_COLON_RE` still
// cannot see it. `CONT_COLON_RE` requires its own closing backtick to
// follow the digit range immediately (`` `:N-M` ``); this bundle's form
// closes the backtick after the `#"anchor"` tail instead, so it never
// matches. `SHORT_FORM_COLON_RE` has no backtick requirement of its own,
// but `collectShortFormMatches` skips any match immediately preceded by
// a backtick (true here) and requires a serial-connective prefix
// ("and", "also", ...) otherwise (absent here too) -- either reason
// alone would already exclude it. okf-kit sees these citations as
// nothing at all, not merely as unresolved ones. This guard, and (as of
// this round) the three ANCHOR_CITATION_RE resolution sites above that
// now also call `extractSiblingGuardCitations`, are the only things that
// check them; that is the residual, named here next to the other
// remaining one below. Deliberately scoped to the anchored form only
// (`#"..."`/`#heading`): the anchor group is REQUIRED in
// ANCHOR_CONTINUATION_CITATION_RE, not optional as it is in
// ANCHOR_CITATION_RE, so a bare `:N-M` (a page range, a ratio, a time --
// this bundle's prose is not free of digit pairs) is never mistaken for a
// continuation citation; every real continuation this bundle uses carries
// an anchor. A continuation match that lands inside an already-matched
// full citation's own character span (the tail of `path.ext:N-M#anchor`
// itself) is excluded, so the two regexes never double-count the same
// characters.
//
// One remaining known coverage gap, not yet closed: a citation-shaped
// string sitting inside a fenced ``` code block is skipped below rather
// than matched -- cheap to add and closes the reverse risk (a code sample
// being misread as a real citation), but means a genuine citation someone
// mistakenly wrote inside a fence would also go unseen; fenced citations
// are not a pattern this bundle currently uses. Round 3 (LOW 5): the
// three `matchAll(ANCHOR_CITATION_RE)` resolution sites above that now
// call this function inherit both consequences too -- a citation inside
// a fence goes unchecked by them as well, and a document ending inside
// an unclosed fence makes them throw, same as this guard -- accepted
// as the same latent, currently-unused-shape cost, not a new one.

// Round 4 lows (agent-dx 4ece8e1e): hoisted to module scope, beside
// `citationScanParagraphs`, so both consumers below (`extractSiblingGuard
// Citations`'s continuation-vs-full-tail filter, and `checkLogCitations`'s
// own continuation-form rule) read the SAME regex object rather than each
// carrying its own byte-identical hand copy with no coupling between them
// (round 2's sibling-guard copy and the log guard's own separate copy of
// the same pattern, both previously declared locally inside each
// function). A single definition makes a drift between the two copies
// structurally impossible, rather than merely asserted: a real
// continuation is never directly preceded by a bare path (e.g. a `.toml`
// citation's own `:N-M#"..."` tail), regardless of which caller is asking.
const PATH_SHAPED_BEFORE_RE = /[\w./-]+\.[A-Za-z0-9]+$/;

interface CitationScanParagraph {
  paragraphId: number;
  /** The paragraph's own lines, trimmed and re-joined with one space. */
  text: string;
  /** 1-based physical doc line an offset into `text` came from. */
  lineOf: (offset: number) => number;
}

// agent-tasks b50fd903 review round 3 (MEDIUM 2/3), closed in round 4:
// both citation scanners in this file used to match per PHYSICAL LINE
// (`lines.forEach`), while every doc in this bundle hard-wraps its prose
// at roughly 72 columns -- so a citation whose own text straddles a wrap
// (`src/init.ts:915-952#"force:` ending one line, `true,"` starting the
// next) matched NEITHER regex and was invisible to every check built on
// them. Re-running the same regexes over the raw document text does not
// close it either: ANCHOR_CITATION_RE's string-anchor alternation
// forbids a newline inside the anchor (`"[^"\n`]*"`) by construction, so
// the text has to be re-joined the way the wrap split it, first. That
// join is this helper, shared by `extractSiblingGuardCitations` below
// and by the `docs/okf/log.md` guard at the end of this file so the two
// cannot drift apart again (round 3 hand-copied this function's fence
// pass into that guard and left its throw behind; there is one copy
// now). Each paragraph -- a run of consecutive non-blank lines, the same
// unit `governingPathByParagraph` binds a continuation citation within
// -- is trimmed per line and joined with exactly ONE space, which is
// what a hard wrap replaced; `lineOf` maps every joined offset back to
// the physical line it came from, so findings, allowlist geometry and
// failure messages still name real doc lines.
//
// Fenced ``` lines are dropped from the joined text (coverage gap (2)
// above: a citation-shaped string in a code sample is never matched as a
// real citation; the delimiter line itself counts as fenced, it is never
// citation-shaped in this bundle) without breaking the paragraph they
// sit in, so paragraph ids are unchanged by fencing. Round 3 (F7): the
// fence toggle flips on ANY delimiter line and never checks that they
// balance, so a single stray ``` (a typo, a half-pasted code sample)
// would silently mark every remaining line of the doc as fenced and drop
// every citation after it -- the guard would then report zero findings
// for that doc and look green for exactly the wrong reason. Fail loudly
// instead of scanning a doc the fence pass cannot read. The bundle
// currently uses no fences at all, so this is a guard against a future
// edit, not a description of today's content; the paired "every bundle
// doc yields at least one citation" assertion further below, and the
// log guard's own computed-count floor, are what catch the same
// silent-zero outcome from any other cause.
function citationScanParagraphs(
  docText: string,
  guardName: string,
): CitationScanParagraph[] {
  const lines = docText.split("\n");
  let inFence = false;
  const fencedLine: boolean[] = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return true;
    }
    return inFence;
  });
  if (inFence) {
    throw new Error(
      `${guardName}: document ends inside an unclosed code fence; ` +
        "every citation after the stray delimiter would be silently skipped",
    );
  }
  const paragraphs: CitationScanParagraph[] = [];
  let paragraphId = 0;
  let prevBlank = true;
  let parts: string[] = [];
  let marks: { offset: number; line: number }[] = [];
  let length = 0;
  const flush = (): void => {
    if (marks.length > 0) {
      const text = parts.join(" ");
      const lineMarks = marks;
      paragraphs.push({
        paragraphId,
        text,
        lineOf: (offset: number): number => {
          let line = lineMarks[0].line;
          for (const mark of lineMarks) {
            if (mark.offset > offset) break;
            line = mark.line;
          }
          return line;
        },
      });
    }
    parts = [];
    marks = [];
    length = 0;
  };
  lines.forEach((line, idx) => {
    if (line.trim() === "") {
      flush();
      prevBlank = true;
      return;
    }
    if (prevBlank) {
      paragraphId += 1;
      prevBlank = false;
    }
    if (fencedLine[idx]) return;
    const piece = line.trim();
    if (parts.length > 0) length += 1;
    marks.push({ offset: length, line: idx + 1 });
    parts.push(piece);
    length += piece.length;
  });
  flush();
  return paragraphs;
}

function extractSiblingGuardCitations(
  docText: string,
  resolveRealPath: (citedPath: string) => string | undefined,
): SiblingGuardCitation[] {
  const citations: SiblingGuardCitation[] = [];
  // Nearest preceding full citation's own `citedPath` string, per
  // paragraph id -- the governing path a path-less continuation in that
  // same paragraph resolves against. Never read across a paragraph
  // boundary: paragraph ids are unique per paragraph already (see the
  // `paragraphOfLine` pass above), so there is nothing to reset between
  // paragraphs, only nothing to find yet.
  const governingPathByParagraph = new Map<number, string>();
  // agent-tasks b50fd903 review round 2 (LOW 5): a continuation match is
  // dropped as an already-matched full citation's own tail only when it
  // falls inside that match's own span (below). ANCHOR_CITATION_RE only
  // recognises a fixed extension allowlist (ts|js|mjs|md|yml|yaml|json),
  // so a full citation into a path with a DIFFERENT extension (a
  // `.toml`, a `.tsx`) never produces a fullMatches entry to overlap
  // against, and that citation's own `:N-M#"..."` tail would be misread
  // as a real, path-less continuation. Cheaper and more general than
  // growing ANCHOR_CITATION_RE's own extension list: drop a continuation
  // match whenever the text immediately before it, on the same line, is
  // itself path-shaped (ends in `something.ext`) regardless of what that
  // extension is -- a real continuation is always preceded by prose or a
  // citation delimiter (`;`, `,`, whitespace), never directly by a bare
  // path. Round 4 lows: `PATH_SHAPED_BEFORE_RE` is the module-scope const
  // beside `citationScanParagraphs`, shared with `checkLogCitations`'s own
  // use of the same rule (no more hand-copied, driftable duplicate).
  const scanned = citationScanParagraphs(
    docText,
    "citation-sibling-drift guard",
  );
  scanned.forEach((scan) => {
    const text = scan.text;
    const paragraph = scan.paragraphId;
    const fullMatches = [...text.matchAll(ANCHOR_CITATION_RE)].map((m) => ({
      kind: "full" as const,
      index: m.index!,
      end: m.index! + m[0].length,
      match: m,
    }));
    const continuationMatches = [
      ...text.matchAll(ANCHOR_CONTINUATION_CITATION_RE),
    ]
      .map((m) => ({
        kind: "continuation" as const,
        index: m.index!,
        end: m.index! + m[0].length,
        match: m,
      }))
      // Drop a "continuation" match that is really just the path-less
      // tail of an already-matched full citation in this same paragraph
      // (e.g. the `:915-952#"force: true,"` substring of
      // `src/init.ts:915-952#"force: true,"`), never a real continuation.
      .filter(
        (cm) =>
          !fullMatches.some((fm) => cm.index >= fm.index && cm.index < fm.end),
      )
      .filter((cm) => !PATH_SHAPED_BEFORE_RE.test(text.slice(0, cm.index)));
    // Process both kinds in true left-to-right document order so a full
    // citation earlier in the same paragraph updates the governing path
    // before a continuation later in that same paragraph reads it --
    // "nearest preceding", not "last full citation anywhere above".
    const ordered = [...fullMatches, ...continuationMatches].sort(
      (a, b) => a.index - b.index,
    );
    for (const entry of ordered) {
      if (entry.kind === "full") {
        const m = entry.match;
        const citedPath = m[1];
        const real = resolveRealPath(citedPath);
        // agent-tasks b50fd903 review round 2 (LOW 4): okf-kit RESETS its
        // own governing path on an unresolved/ambiguous citation rather
        // than leaving the previous one in place; this mirror used to
        // just leave `governingPathByParagraph` holding the last
        // RESOLVABLE path (latent today: no fixture in this bundle
        // currently exercises an unresolved citation sitting between a
        // governing citation and a later continuation). Matched here: a
        // full citation that fails to resolve clears the paragraph's
        // governing path instead of leaving a stale one behind, so a
        // continuation after it has nothing to bind to either.
        if (real) governingPathByParagraph.set(paragraph, citedPath);
        else governingPathByParagraph.delete(paragraph);
        if (!real) continue;
        const start = Number(m[2]);
        const end = m[3] ? Number(m[3]) : start;
        const anchorRaw = m[4];
        const isStringAnchor = !!anchorRaw && anchorRaw.startsWith('"');
        citations.push({
          citedPath,
          real,
          start,
          end,
          anchorRaw,
          isStringAnchor,
          anchorText: isStringAnchor ? anchorRaw!.slice(1, -1) : undefined,
          line: scan.lineOf(entry.index),
          paragraphId: paragraph,
        });
      } else {
        const citedPath = governingPathByParagraph.get(paragraph);
        if (citedPath === undefined) continue;
        const real = resolveRealPath(citedPath);
        if (!real) continue;
        const m = entry.match;
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : start;
        const anchorRaw = m[3];
        const isStringAnchor = anchorRaw.startsWith('"');
        citations.push({
          citedPath,
          real,
          start,
          end,
          anchorRaw,
          isStringAnchor,
          anchorText: isStringAnchor ? anchorRaw.slice(1, -1) : undefined,
          line: scan.lineOf(entry.index),
          paragraphId: paragraph,
        });
      }
    }
  });
  return citations;
}

interface SiblingGuardCitation {
  citedPath: string;
  real: string;
  start: number;
  end: number;
  anchorRaw: string | undefined;
  isStringAnchor: boolean;
  anchorText: string | undefined;
  line: number;
  paragraphId: number;
}

interface DuplicateCitationFinding {
  kind: "duplicate-citation";
  paragraphId: number;
  citedPath: string;
  real: string;
  start: number;
  end: number;
  anchorRaw: string | undefined;
  count: number;
  // Round 3 (R1): the doc lines every citation of this group sits on, in
  // document order, so an allowlist entry can record (and a test can
  // re-check) WHERE the repeat it was cleared against actually is,
  // instead of exempting any future repeat of the same range anywhere in
  // the doc.
  citationLines: number[];
}

interface WrongSiblingAnchorFinding {
  kind: "wrong-sibling-anchor";
  paragraphId: number;
  citedPath: string;
  real: string;
  start: number;
  end: number;
  anchorText: string;
  unclaimedLines: number[];
  // Round 4 (L2): the DOC line the citation itself sits on (as opposed to
  // `start`/`end`, the cited RANGE in the target file). A wrong-sibling-
  // anchor finding is built from exactly one citation, so this is just
  // that citation's own `line`; carried onto the finding so the allowlist
  // match can pin an entry to the paragraph it was actually reviewed in
  // (see `SiblingGuardAllowlistEntry.paragraphLine`).
  citationLine: number;
}

type SiblingGuardFinding = DuplicateCitationFinding | WrongSiblingAnchorFinding;

const SIBLING_GUARD_WINDOW = 20;

function groupSiblingGuardCitationsByParagraph(
  citations: SiblingGuardCitation[],
): Map<number, SiblingGuardCitation[]> {
  const byParagraph = new Map<number, SiblingGuardCitation[]>();
  for (const c of citations) {
    const list = byParagraph.get(c.paragraphId);
    if (list) {
      list.push(c);
    } else {
      byParagraph.set(c.paragraphId, [c]);
    }
  }
  return byParagraph;
}

// Rule (a).
function findDuplicateCitations(
  citations: SiblingGuardCitation[],
): DuplicateCitationFinding[] {
  const findings: DuplicateCitationFinding[] = [];
  for (const [paragraphId, list] of groupSiblingGuardCitationsByParagraph(
    citations,
  )) {
    const groups = new Map<string, SiblingGuardCitation[]>();
    for (const c of list) {
      const key = `${c.real}:${c.start}-${c.end}#${c.anchorRaw ?? ""}`;
      const group = groups.get(key);
      if (group) {
        group.push(c);
      } else {
        groups.set(key, [c]);
      }
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [first] = group;
      findings.push({
        kind: "duplicate-citation",
        paragraphId,
        citedPath: first.citedPath,
        real: first.real,
        start: first.start,
        end: first.end,
        anchorRaw: first.anchorRaw,
        count: group.length,
        citationLines: group.map((c) => c.line),
      });
    }
  }
  return findings;
}

// Rule (b).
function findWrongSiblingAnchors(
  citations: SiblingGuardCitation[],
  readTargetFile: (realPath: string) => string,
  window: number,
): WrongSiblingAnchorFinding[] {
  const findings: WrongSiblingAnchorFinding[] = [];
  const fileLinesCache = new Map<string, string[]>();
  const fileLines = (real: string): string[] => {
    let lines = fileLinesCache.get(real);
    if (!lines) {
      lines = readTargetFile(real).split("\n");
      fileLinesCache.set(real, lines);
    }
    return lines;
  };
  for (const [paragraphId, list] of groupSiblingGuardCitationsByParagraph(
    citations,
  )) {
    for (const c of list) {
      if (!c.isStringAnchor || c.anchorText === undefined) continue;
      const sameFile = list.filter((o) => o.real === c.real);
      const hasSibling = sameFile.some(
        (o) => o !== c && (o.start !== c.start || o.end !== c.end),
      );
      if (!hasSibling) continue;
      const anchorText = c.anchorText;
      const lines = fileLines(c.real);
      const claimedRanges: Array<[number, number]> = sameFile.map((o) => [
        o.start,
        o.end,
      ]);
      const isClaimed = (ln: number): boolean =>
        claimedRanges.some(([s, e]) => ln >= s && ln <= e);
      const unclaimedLines: number[] = [];
      const lo = Math.max(1, c.start - window);
      const hi = Math.min(lines.length, c.end + window);
      for (let ln = lo; ln <= hi; ln++) {
        if (ln >= c.start && ln <= c.end) continue;
        if (isClaimed(ln)) continue;
        if ((lines[ln - 1] ?? "").includes(anchorText)) {
          unclaimedLines.push(ln);
        }
      }
      if (unclaimedLines.length > 0) {
        findings.push({
          kind: "wrong-sibling-anchor",
          paragraphId,
          citedPath: c.citedPath,
          real: c.real,
          start: c.start,
          end: c.end,
          anchorText,
          unclaimedLines,
          citationLine: c.line,
        });
      }
    }
  }
  return findings;
}

function findCitationSiblingDrift(
  docText: string,
  resolveRealPath: (citedPath: string) => string | undefined,
  readTargetFile: (realPath: string) => string,
  window: number = SIBLING_GUARD_WINDOW,
): SiblingGuardFinding[] {
  const citations = extractSiblingGuardCitations(docText, resolveRealPath);
  return [
    ...findDuplicateCitations(citations),
    ...findWrongSiblingAnchors(citations, readTargetFile, window),
  ];
}

function formatSiblingGuardFinding(f: SiblingGuardFinding): string {
  if (f.kind === "duplicate-citation") {
    return (
      `duplicate-citation: \`${f.citedPath}:${f.start}-${f.end}#${f.anchorRaw ?? ""}\` ` +
      `cited ${f.count} times in one paragraph`
    );
  }
  return (
    `wrong-sibling-anchor: \`${f.citedPath}:${f.start}-${f.end}#"${f.anchorText}"\` -- ` +
    `anchor text also occurs, uncited, at line(s) ${f.unclaimedLines.join(", ")} of ${f.real}`
  );
}

function formatSiblingGuardFindings(findings: SiblingGuardFinding[]): string {
  return findings.map(formatSiblingGuardFinding).join("\n");
}

/**
 * Builds an in-memory fixture "file" with 1-indexed lines: every line not
 * explicitly given content gets an inert filler line, so a fixture only has
 * to spell out the lines its own scenario actually cares about.
 */
function buildSiblingGuardFixtureFile(
  totalLines: number,
  contentByLine: Record<number, string>,
): string {
  const lines: string[] = [];
  for (let ln = 1; ln <= totalLines; ln++) {
    lines.push(contentByLine[ln] ?? `  // filler line ${ln}`);
  }
  return lines.join("\n");
}

describe("citation-sibling-drift guard: fixtures reproduce the three review-batch shapes", () => {
  const identity = (citedPath: string): string => citedPath;

  it("shape 1 (a run of near-identical sibling ranges collapsing onto one, twice, the third never cited): drifted form is flagged by the duplicate rule, corrected form is clean", () => {
    const target = buildSiblingGuardFixtureFile(34, {
      10: "    checkPointerFixture(section);",
      20: "    checkPointerFixture(section);",
      30: "    checkPointerFixture(section);",
    });
    const readTarget = (): string => target;

    const drifted =
      "the README and both write-surface listings mention the pointer via\n" +
      "the helper, in both places\n" +
      '(fixture-pointer.test.ts:8-10#"checkPointerFixture(section)";\n' +
      'fixture-pointer.test.ts:8-10#"checkPointerFixture(section)").\n';
    const driftedFindings = findCitationSiblingDrift(
      drifted,
      identity,
      readTarget,
    );
    expect(
      driftedFindings.some((f) => f.kind === "duplicate-citation"),
      formatSiblingGuardFindings(driftedFindings),
    ).toBe(true);

    const corrected =
      "the README and both write-surface listings mention the pointer via\n" +
      "the helper, in all three places\n" +
      '(fixture-pointer.test.ts:8-10#"checkPointerFixture(section)";\n' +
      'fixture-pointer.test.ts:18-20#"checkPointerFixture(section)";\n' +
      'fixture-pointer.test.ts:28-30#"checkPointerFixture(section)").\n';
    const correctedFindings = findCitationSiblingDrift(
      corrected,
      identity,
      readTarget,
    );
    expect(
      correctedFindings,
      formatSiblingGuardFindings(correctedFindings),
    ).toEqual([]);
  });

  it("shape 2 (three per-harness bullets collapsing onto one cited line, the third never cited): drifted form is flagged by the duplicate rule, corrected form is clean", () => {
    const target = buildSiblingGuardFixtureFile(24, {
      9: "  pointer rule from Run state applies unchanged.",
      14: "  pointer rule from Run state applies unchanged.",
    });
    const readTarget = (): string => target;

    const drifted =
      "every harness bullet says the pointer rule applies unchanged\n" +
      '(fixture-harness.md:7-9#"pointer rule from Run state applies unchanged.";\n' +
      'fixture-harness.md:7-9#"pointer rule from Run state applies unchanged.").\n';
    const driftedFindings = findCitationSiblingDrift(
      drifted,
      identity,
      readTarget,
    );
    expect(
      driftedFindings.some((f) => f.kind === "duplicate-citation"),
      formatSiblingGuardFindings(driftedFindings),
    ).toBe(true);

    const corrected =
      "every harness bullet says the pointer rule applies unchanged\n" +
      '(fixture-harness.md:7-9#"pointer rule from Run state applies unchanged.";\n' +
      'fixture-harness.md:12-14#"pointer rule from Run state applies unchanged.").\n';
    const correctedFindings = findCitationSiblingDrift(
      corrected,
      identity,
      readTarget,
    );
    expect(
      correctedFindings,
      formatSiblingGuardFindings(correctedFindings),
    ).toEqual([]);
  });

  it("shape 3 (two distinct assertions collapsing onto one shared range and anchor text, the second's own line never cited): drifted form is flagged only by the wrong-sibling rule (it is not a literal duplicate), corrected form re-points to a more specific anchor and is clean", () => {
    const target = buildSiblingGuardFixtureFile(30, {
      10: '      "...is a regression signal, reported as such (...) and resolved before the next reviewer spawn.",',
      20: '      "...is a regression signal: report it as such (...) and resolve it before the next reviewer spawn.",',
    });
    const readTarget = (): string => target;

    const drifted =
      "the step 6 copy and the implementer-prompt copy both state the\n" +
      "regression-signal consequence\n" +
      '(fixture-contracts.test.ts:10#"is a regression signal",\n' +
      'fixture-contracts.test.ts:8-10#"is a regression signal").\n';
    const driftedFindings = findCitationSiblingDrift(
      drifted,
      identity,
      readTarget,
    );
    expect(
      driftedFindings.some((f) => f.kind === "duplicate-citation"),
      "shape 3's drifted form must not be a literal duplicate (it exercises " +
        "the wrong-sibling rule, not the duplicate rule): " +
        formatSiblingGuardFindings(driftedFindings),
    ).toBe(false);
    expect(
      driftedFindings.some((f) => f.kind === "wrong-sibling-anchor"),
      formatSiblingGuardFindings(driftedFindings),
    ).toBe(true);

    const corrected =
      "the step 6 copy and the implementer-prompt copy both state the\n" +
      "regression-signal consequence\n" +
      '(fixture-contracts.test.ts:10#"is a regression signal",\n' +
      'fixture-contracts.test.ts:18-20#"signal: report it as such").\n';
    const correctedFindings = findCitationSiblingDrift(
      corrected,
      identity,
      readTarget,
    );
    expect(
      correctedFindings,
      formatSiblingGuardFindings(correctedFindings),
    ).toEqual([]);
  });

  // Round 2 (F4): the shape 3 fixture above is a deliberate near-miss (two
  // citations to slightly different ranges sharing one anchor text), not
  // the real batch-39 geometry. The real case (docs/okf/log.md's
  // 2026-09-06T21:33:40Z entry) was one citation reused verbatim for two
  // claims -- a literal duplicate -- whose real, uncited sibling sat 15
  // lines below it, not the fixture's 10. This fixture reproduces that
  // real distance and shape, and checks both rules' behaviour on it: the
  // drifted form is a literal duplicate, so rule (a) must fire and rule
  // (b) must not (no sibling RANGE exists yet to compare against, only a
  // repeated one); the corrected form re-points the second citation to
  // the real 15-line-distant sibling and is clean under both rules.
  it("shape 3, real geometry (a literal duplicate, correct sibling 15 lines away, per docs/okf/log.md): drifted form is flagged by the duplicate rule and not the wrong-sibling rule, corrected form re-points to the real sibling and is clean under both rules", () => {
    const target = buildSiblingGuardFixtureFile(35, {
      10: '      "...is a regression signal, reported as such (...) and resolved before the next reviewer spawn.",',
      25: '      "...is a regression signal, reported as such (...) and resolved before the next reviewer spawn.",',
    });
    const readTarget = (): string => target;

    const drifted =
      "the step 6 copy and the implementer-prompt copy both state the\n" +
      "regression-signal consequence\n" +
      '(fixture-real-s3.test.ts:8-10#"is a regression signal",\n' +
      'fixture-real-s3.test.ts:8-10#"is a regression signal").\n';
    const driftedFindings = findCitationSiblingDrift(
      drifted,
      identity,
      readTarget,
      SIBLING_GUARD_WINDOW,
    );
    expect(
      driftedFindings.some((f) => f.kind === "duplicate-citation"),
      "the real S3 shape is a literal duplicate, so rule (a) must fire: " +
        formatSiblingGuardFindings(driftedFindings),
    ).toBe(true);
    expect(
      driftedFindings.some((f) => f.kind === "wrong-sibling-anchor"),
      "a repeated IDENTICAL range is not a sibling range, so rule (b) must " +
        "not also fire on the drifted form: " +
        formatSiblingGuardFindings(driftedFindings),
    ).toBe(false);

    const corrected =
      "the step 6 copy and the implementer-prompt copy both state the\n" +
      "regression-signal consequence\n" +
      '(fixture-real-s3.test.ts:8-10#"is a regression signal",\n' +
      'fixture-real-s3.test.ts:23-25#"is a regression signal").\n';
    const correctedFindings = findCitationSiblingDrift(
      corrected,
      identity,
      readTarget,
      SIBLING_GUARD_WINDOW,
    );
    expect(
      correctedFindings,
      formatSiblingGuardFindings(correctedFindings),
    ).toEqual([]);
  });

  // Round 2 (F4) negative control: `findDuplicateCitations` never receives
  // a `window` argument (see its signature above) -- a literal duplicate
  // is a PAIRING comparison, not a windowed one, so rule (a) must report
  // it identically no matter how small or large SIBLING_GUARD_WINDOW is.
  // Pins that against regression (e.g. someone later folding rule (a)
  // into the same windowed comparison rule (b) uses).
  it("shape 3 real geometry, negative control: rule (a) (duplicate-citation) fires identically regardless of the window argument", () => {
    const target = buildSiblingGuardFixtureFile(35, {
      10: '      "...is a regression signal, reported as such (...) and resolved before the next reviewer spawn.",',
      25: '      "...is a regression signal, reported as such (...) and resolved before the next reviewer spawn.",',
    });
    const readTarget = (): string => target;
    const drifted =
      "the step 6 copy and the implementer-prompt copy both state the\n" +
      "regression-signal consequence\n" +
      '(fixture-real-s3.test.ts:8-10#"is a regression signal",\n' +
      'fixture-real-s3.test.ts:8-10#"is a regression signal").\n';

    for (const window of [0, 1, 1000]) {
      const findings = findCitationSiblingDrift(
        drifted,
        identity,
        readTarget,
        window,
      );
      expect(
        findings.some((f) => f.kind === "duplicate-citation"),
        `window=${window}: ` + formatSiblingGuardFindings(findings),
      ).toBe(true);
    }
  });

  // Round 2 (F7): a citation-shaped string inside a fenced ``` code block
  // must not be treated as a real citation. Repeats the same real citation
  // once for real, once verbatim inside a fence in the SAME paragraph (no
  // blank line separates them): if fence lines were still scanned, the
  // fenced copy would collide with the real one and rule (a) would report
  // a duplicate-citation finding that should not exist.
  it("a citation-shaped string inside a fenced ``` code block is not matched as a real citation", () => {
    const target = buildSiblingGuardFixtureFile(15, {
      12: '  "real anchor",',
    });
    const readTarget = (): string => target;
    const docText =
      "prose citing a real range\n" +
      '(fixture-fence.test.ts:10-12#"real anchor").\n' +
      "```\n" +
      'fixture-fence.test.ts:10-12#"real anchor"\n' +
      "```\n";
    const findings = findCitationSiblingDrift(
      docText,
      identity,
      readTarget,
      SIBLING_GUARD_WINDOW,
    );
    expect(findings, formatSiblingGuardFindings(findings)).toEqual([]);
  });

  // Round 3 (F4): before this fixture, SIBLING_GUARD_WINDOW's value was
  // pinned only indirectly -- by the no-dead-exemption test, which fails
  // when a shrunken window stops producing a hit some allowlist entry was
  // written for. That is a bundle-dependent pin: it would evaporate the
  // day the last window-dependent entry is fixed or removed. This is the
  // direct, bundle-independent one. The uncited sibling occurrence sits 15
  // lines past the cited range's end (the real batch-39 distance, see the
  // real-geometry fixture above), and a genuine second range of the same
  // file is cited in the same paragraph, so rule (b)'s sibling
  // precondition holds. At SIBLING_GUARD_WINDOW the occurrence is inside
  // the scan window and the rule fires; at the round-1 value of 10 it is
  // outside and the rule stays silent -- which is exactly the case round 2
  // measured against the real bundle and widened the window for.
  it("rule (b) sees an uncited sibling occurrence 15 lines outside the cited range at SIBLING_GUARD_WINDOW, and does not at the round-1 window of 10", () => {
    const target = buildSiblingGuardFixtureFile(60, {
      12: "    expect(shape).toContain(sentinelPhrase);",
      27: "    expect(shape).toContain(sentinelPhrase);",
      42: "    expect(other).toContain(secondPhrase);",
    });
    const readTarget = (): string => target;
    const docText =
      "both shapes are pinned by the same suite\n" +
      '(fixture-window.test.ts:10-12#"expect(shape).toContain(sentinelPhrase);";\n' +
      'fixture-window.test.ts:40-42#"expect(other).toContain(secondPhrase);").\n';

    const atGuardWindow = findCitationSiblingDrift(
      docText,
      identity,
      readTarget,
      SIBLING_GUARD_WINDOW,
    );
    const wrongSibling = atGuardWindow.filter(
      (f): f is WrongSiblingAnchorFinding => f.kind === "wrong-sibling-anchor",
    );
    expect(
      wrongSibling.map((f) => f.unclaimedLines),
      "at SIBLING_GUARD_WINDOW the 15-line-distant occurrence must be seen: " +
        formatSiblingGuardFindings(atGuardWindow),
    ).toEqual([[27]]);

    const atTen = findCitationSiblingDrift(docText, identity, readTarget, 10);
    expect(
      atTen.filter((f) => f.kind === "wrong-sibling-anchor"),
      "at the round-1 window of 10 the same occurrence is out of range: " +
        formatSiblingGuardFindings(atTen),
    ).toEqual([]);
  });

  // Round 3 (F7): `inFence` above toggles on any ``` delimiter line and
  // never checks the delimiters balance. A single stray fence would mark
  // the whole rest of a doc as fenced, drop every citation after it, and
  // leave the guard reporting a clean zero for that doc. Pins the loud
  // failure instead of the silent one.
  it("a doc that ends inside an unclosed ``` fence throws instead of silently dropping every citation after the stray delimiter", () => {
    const target = buildSiblingGuardFixtureFile(15, {
      12: '  "real anchor",',
    });
    const readTarget = (): string => target;
    const docText =
      "prose citing a real range\n" +
      '(fixture-unbalanced.test.ts:10-12#"real anchor").\n' +
      "\n" +
      "```\n" +
      "a code sample whose closing delimiter was lost in an edit\n";
    expect(() =>
      findCitationSiblingDrift(
        docText,
        identity,
        readTarget,
        SIBLING_GUARD_WINDOW,
      ),
    ).toThrow(/unclosed code fence/);
  });

  // Closes coverage gap (1) from the block comment above
  // `extractSiblingGuardCitations`: a path-less continuation citation
  // (`:N-M#"..."`) must participate in the duplicate-citation rule the
  // same as a full citation would. The drifted form's second citation is
  // written as a bare continuation (`:10-12#"..."`, no path, chained off
  // the full citation right before it in the same paragraph) repeating
  // the SAME range and anchor as the full citation -- a literal
  // duplicate, indistinguishable in shape from the three review-batch
  // shapes above except that the repeat is spelled as a continuation, not
  // a second full citation. If continuation resolution were disabled (or
  // never implemented), this guard would see only ONE citation in this
  // paragraph (the continuation is invisible to ANCHOR_CITATION_RE) and
  // report no finding at all -- this is the mutation-probe (a) target.
  it('a path-less continuation citation (`:N-M#"..."`) duplicating the preceding full citation\'s range and anchor is flagged by the duplicate rule; re-pointing the continuation to a different range clears it', () => {
    const target = buildSiblingGuardFixtureFile(28, {
      10: "    checkContinuationFixture(x);",
      12: "    // end checkContinuationFixture(x);",
      20: "    checkContinuationFixture(x);",
      22: "    // end checkContinuationFixture(x);",
    });
    const readTarget = (): string => target;

    const drifted =
      "the mirrored README bullet and the write-surface listing both point\n" +
      "at the same helper, cited once in full and once as a continuation\n" +
      '(fixture-continuation.test.ts:10-12#"checkContinuationFixture(x)";\n' +
      ':10-12#"checkContinuationFixture(x)").\n';
    const driftedFindings = findCitationSiblingDrift(
      drifted,
      identity,
      readTarget,
    );
    expect(
      driftedFindings.some((f) => f.kind === "duplicate-citation"),
      "a path-less continuation repeating the preceding citation's own " +
        "range and anchor must be seen as a duplicate: " +
        formatSiblingGuardFindings(driftedFindings),
    ).toBe(true);

    const corrected =
      "the mirrored README bullet and the write-surface listing both point\n" +
      "at the same helper, cited once in full and once as a continuation\n" +
      '(fixture-continuation.test.ts:10-12#"checkContinuationFixture(x)";\n' +
      ':20-22#"checkContinuationFixture(x)").\n';
    const correctedFindings = findCitationSiblingDrift(
      corrected,
      identity,
      readTarget,
    );
    expect(
      correctedFindings,
      formatSiblingGuardFindings(correctedFindings),
    ).toEqual([]);
  });

  // Discriminates "resolves against the NEAREST PRECEDING full citation in
  // the paragraph" from the plausible bug "resolves against the FIRST
  // full citation in the paragraph" -- the mutation-probe (b) target. The
  // paragraph below names two full citations to two DIFFERENT target
  // files, then a bare continuation. Only the correct (nearest-preceding)
  // binding makes the continuation an exact duplicate of the SECOND full
  // citation (same real file, range, and anchor): a "first in paragraph"
  // binding would instead resolve the continuation against the first
  // file, at a range and anchor it never actually repeats there, so no
  // duplicate-citation finding would be produced at all. A silent zero
  // findings on this fixture is exactly what a wrong-sibling continuation
  // binding would produce, and is what this test is written to catch.
  it("a path-less continuation resolves against the nearest PRECEDING full citation in the paragraph, not the paragraph's first one", () => {
    const readTarget = (): string => buildSiblingGuardFixtureFile(15, {});

    const docText =
      "one paragraph names two different helpers before the continuation\n" +
      '(fixture-cont-a.test.ts:5-5#"noop", fixture-cont-b.test.ts:9-9#"marker",\n' +
      ':9-9#"marker").\n';
    const findings = findCitationSiblingDrift(docText, identity, readTarget);
    // agent-tasks b50fd903 review round 2 (LOW 9): asserts the full
    // `findings` array, not only the `duplicate-citation`-filtered subset
    // of it -- the filtered form would stay green even if a wrong-sibling
    // continuation binding produced some OTHER, unexpected finding
    // alongside (or instead of) the one this fixture is written to check.
    expect(
      findings,
      'the continuation must duplicate fixture-cont-b.test.ts:9-9#"marker" ' +
        "(the SECOND, nearer full citation), not fixture-cont-a.test.ts's " +
        'unrelated 5-5#"noop", and no other finding: ' +
        formatSiblingGuardFindings(findings),
    ).toHaveLength(1);
    const [finding] = findings;
    if (finding.kind !== "duplicate-citation") {
      throw new Error(
        `expected a duplicate-citation finding, got ${finding.kind}`,
      );
    }
    expect(finding.real).toBe("fixture-cont-b.test.ts");
    expect(finding.start).toBe(9);
    expect(finding.end).toBe(9);
  });

  // agent-tasks b50fd903 review round 2 (MEDIUM, tests): the paragraph-
  // scoping property -- a continuation never resolves against a governing
  // citation from a DIFFERENT (earlier) paragraph -- was previously
  // asserted only in the comment above `governingPathByParagraph`, not by
  // any fixture. A mutant that falls back to the whole map's last value
  // when the current paragraph has none of its own
  // (`governingPathByParagraph.get(paragraph) ?? [...values()].pop()`)
  // passed every existing fixture and survived, because none of them put
  // a bare continuation in a paragraph that never itself named a full
  // citation. This one does: a full citation in the first paragraph, a
  // blank line, then a bare continuation alone in the second paragraph.
  // The continuation must produce no citation at all (nothing to resolve
  // against in its OWN paragraph) and therefore no finding.
  it("a path-less continuation in a paragraph that names no full citation of its own resolves against nothing, even though an earlier paragraph did", () => {
    const readTarget = (): string => buildSiblingGuardFixtureFile(12, {});

    const docText =
      'the first paragraph names a real citation (fixture-para.test.ts:5-5#"noop").\n' +
      "\n" +
      'the second paragraph opens with a bare continuation (:5-5#"noop") that ' +
      "must not silently inherit the first paragraph's governing path.\n";
    const citations = extractSiblingGuardCitations(docText, identity);
    expect(
      citations.filter((c) => c.line === 3),
      "the second paragraph's bare continuation must not resolve to any " +
        "citation at all: " +
        JSON.stringify(citations.filter((c) => c.line === 3)),
    ).toEqual([]);
    const findings = findCitationSiblingDrift(docText, identity, readTarget);
    expect(findings, formatSiblingGuardFindings(findings)).toEqual([]);
  });

  // agent-tasks b50fd903 review round 2 (LOW 6): the true left-to-right,
  // "nearest preceding" ordering of full and continuation matches on the
  // SAME line (the `.sort((a, b) => a.index - b.index)` on the merged
  // `ordered` array) was unpinned: a mutant replacing the comparator with
  // a constant `() => 0` survived every existing fixture, because
  // `Array.prototype.sort` is stable and the merged array is built as
  // `[...fullMatches, ...continuationMatches]` -- with a no-op comparator
  // every full match on a line is still processed before every
  // continuation on that same line, in original (already left-to-right)
  // order within each kind, which happens to reproduce the correct
  // "nearest preceding" answer whenever a line's continuation comes AFTER
  // every full citation on it, exactly the shape every prior fixture
  // used. This fixture puts a continuation BETWEEN two full citations on
  // one line: the correct sort binds it to the nearer, EARLIER one; the
  // constant-comparator mutant instead processes both full citations
  // first (setting the governing path to the LATER one) and only then the
  // continuation, binding it to the wrong (later) file.
  it("a path-less continuation between two full citations on the same line binds to the earlier one (left-to-right order, not full-matches-first)", () => {
    const readTarget = (): string => buildSiblingGuardFixtureFile(15, {});

    const docText =
      "one line names an early file, a continuation, then a later file " +
      '(fixture-order-a.test.ts:5-5#"noop" :5-5#"noop" ' +
      'fixture-order-b.test.ts:9-9#"marker").\n';
    const findings = findCitationSiblingDrift(docText, identity, readTarget);
    expect(
      findings,
      "the continuation sits between the two full citations and must " +
        "duplicate the EARLIER one (fixture-order-a.test.ts:5-5), not the " +
        "later fixture-order-b.test.ts:9-9: " +
        formatSiblingGuardFindings(findings),
    ).toHaveLength(1);
    const [finding] = findings;
    if (finding.kind !== "duplicate-citation") {
      throw new Error(
        `expected a duplicate-citation finding, got ${finding.kind}`,
      );
    }
    expect(finding.real).toBe("fixture-order-a.test.ts");
    expect(finding.start).toBe(5);
    expect(finding.end).toBe(5);
  });

  // agent-tasks b50fd903 review round 2 (LOW 4): okf-kit resets its own
  // governing path when a citation fails to resolve/is ambiguous, rather
  // than leaving the previous resolvable path in place; this mirror used
  // to just leave it. An unresolved citation (a path `resolveRealPath`
  // returns `undefined` for) sits between the governing citation and the
  // continuation below: the continuation must NOT fall back to the
  // earlier, still-resolvable path -- it must resolve to nothing, and the
  // fixture's would-be duplicate must not be reported.
  it("an unresolved citation between a governing citation and a continuation clears the governing path (the continuation resolves to nothing)", () => {
    const readTarget = (): string => buildSiblingGuardFixtureFile(15, {});
    const resolveExceptUnresolvable = (
      citedPath: string,
    ): string | undefined =>
      citedPath === "fixture-unresolvable.test.ts" ? undefined : citedPath;

    const docText =
      'the paragraph cites a real file (fixture-reset.test.ts:5-5#"noop"), ' +
      'then an unresolvable one (fixture-unresolvable.test.ts:1-1#"gone"), ' +
      'then a bare continuation (:5-5#"noop") that must not fall back to ' +
      "the first, no-longer-governing citation.\n";
    const citations = extractSiblingGuardCitations(
      docText,
      resolveExceptUnresolvable,
    );
    expect(
      citations.some((c) => c.real === "fixture-reset.test.ts" && c.line > 1),
      "no citation after the unresolved one may resolve against " +
        "fixture-reset.test.ts: " +
        JSON.stringify(citations),
    ).toBe(false);
    const findings = findCitationSiblingDrift(
      docText,
      resolveExceptUnresolvable,
      readTarget,
    );
    expect(findings, formatSiblingGuardFindings(findings)).toEqual([]);
  });

  // agent-tasks b50fd903 review round 2 (LOW 5): the continuation-vs-full-
  // match overlap filter previously only dropped a "continuation" match
  // sitting inside an ANCHOR_CITATION_RE match's own span -- but that
  // regex only recognises a fixed extension allowlist
  // (ts|js|mjs|md|yml|yaml|json). A path into a DIFFERENT extension (here
  // `.toml`) is not itself citable by this guard (that allowlist is
  // unchanged), but its `:N-M#"..."` tail is still syntactically a real
  // ANCHOR_CONTINUATION_CITATION_RE match with nothing to overlap-filter
  // it out, so it gets silently misread as resolving against whatever
  // full citation DID govern the paragraph -- a phantom, wrong citation,
  // not merely a missed one. The paragraph below cites one real target,
  // then mentions an unrelated `.toml` setting later in the same
  // sentence: extraction must yield exactly the one real citation, not a
  // second, phantom one pointing at `fixture-guard.test.ts:3-4`.
  it('a `.toml` path\'s own `:N-M#"..."` tail is not misread as a continuation of an earlier real citation in the same paragraph', () => {
    const docText =
      'the paragraph cites a real file (fixture-guard.test.ts:1-1#"marker"), ' +
      'then names an unrelated setting (fixture.toml:3-4#"key = true") that ' +
      "must not phantom-continue.\n";
    const citations = extractSiblingGuardCitations(docText, identity);
    expect(
      citations,
      "the `.toml` path's own tail must not be read as a continuation " +
        "citation of fixture-guard.test.ts: " +
        JSON.stringify(citations),
    ).toHaveLength(1);
    expect(citations[0].real).toBe("fixture-guard.test.ts");
    expect(citations[0].start).toBe(1);
    expect(citations[0].end).toBe(1);
    expect(citations[0].anchorText).toBe("marker");
  });

  // agent-tasks b50fd903 review round 2 (HIGH 1 regression guard): the
  // whole point of extending the three early ANCHOR_CITATION_RE
  // resolution sites to also consume `extractSiblingGuardCitations` is
  // that a resolved continuation citation gets checked -- last content
  // line, occurrence count, block containment -- exactly like a full
  // citation is. This is a smaller, direct reproduction of that
  // property, independent of the real bundle docs those sites read: a
  // continuation resolves to a real citation object with a `start`/`end`
  // range and an `anchorText`, and `lastContentLineInRange` (the same
  // helper the "last content line" resolution site uses) can find that
  // its anchor does NOT actually sit on the range's own last content
  // line when the continuation is stale -- the exact shape a mutant that
  // disables continuation resolution (this round's probe (e), and the
  // replayed round-1 probe that always `continue`s the continuation
  // branch) would hide, by producing no citation for the resolution
  // sites to check at all. Review round 3 correction: this pins
  // `extractSiblingGuardCitations`'s own output only, not what the three
  // resolution sites do with it afterward -- a round-2 survivor
  // (`collectStringAnchoredCitations`'s own filter, narrowed to also
  // require the citation's own doc line to literally contain
  // `citedPath`) kept every continuation resolving here while still
  // dropping it one step later; see the source-span pin and the
  // synthetic-doc-set test next to that collector's own definition for
  // the property this fixture alone does not cover.
  it("a resolved continuation citation's anchor is checked against its own cited range the same way a full citation's is", () => {
    const docText =
      'the paragraph cites a real file (fixture-stale.test.ts:1-1#"first"), ' +
      'then a stale continuation (:5-5#"first") whose anchor text does not ' +
      "actually occur at that range.\n";
    const citations = extractSiblingGuardCitations(docText, identity);
    const continuation = citations.find(
      (c) => c.real === "fixture-stale.test.ts" && c.start === 5,
    );
    expect(
      continuation,
      "the continuation must still resolve to a citation object for a " +
        "resolution site to check at all: " +
        JSON.stringify(citations),
    ).toBeDefined();
    const targetLines = buildSiblingGuardFixtureFile(6, {
      1: '  const first = "first";',
      5: '  const other = "different text";',
    }).split("\n");
    const lastContentLine = lastContentLineInRange(
      targetLines,
      continuation!.start,
      continuation!.end,
    );
    const anchorLine = targetLines[lastContentLine - 1] ?? "";
    expect(
      anchorLine.includes(continuation!.anchorText!),
      "a continuation whose anchor text does not occur at its own cited " +
        "range must be detectable the same way a full citation's stale " +
        "anchor is (the resolution sites' own \"anchor on last content " +
        `line" check): got last content line ${lastContentLine} = ` +
        JSON.stringify(anchorLine),
    ).toBe(false);
  });

  // Round 4 lows (agent-dx 4ece8e1e): the paragraph join through
  // `citationScanParagraphs` is pinned at the log guard's own wrap
  // fixtures (`checkLogCitations`, below), but `extractSiblingGuardCitations`
  // is a separate function that also calls that helper, and nothing here
  // pinned ITS OWN use of the join. A mutant that reverts
  // `extractSiblingGuardCitations` alone back to a per-physical-line scan
  // (bypassing `citationScanParagraphs`) would still pass every fixture
  // above unchanged -- none of them puts a citation's own text across a
  // hard line break -- while the log guard's fixtures, which exercise a
  // different function, keep passing regardless. This fixture wraps BOTH
  // a full citation's anchor and a path-less continuation's anchor across
  // a hard line break in the same synthetic doc: a per-line reversion
  // cannot match either (the anchor's closing quote is on the next
  // physical line, invisible to ANCHOR_CITATION_RE/ANCHOR_CONTINUATION_
  // CITATION_RE run one line at a time), so extraction would silently
  // yield nothing at all. Each citation must still be reported at the
  // PHYSICAL line its own text starts on (before the wrap), not the line
  // its anchor happens to finish on.
  it("a full citation and a path-less continuation whose own anchors each straddle a hard line break are still extracted by extractSiblingGuardCitations, each at the physical line its own text starts on", () => {
    const docText =
      'a full citation whose anchor wraps across the break (fixture-wrap.test.ts:5-6#"first line\n' +
      'anchor") and, in the same paragraph, a continuation whose anchor also wraps (:9-10#"second line\n' +
      'anchor") appear together.\n';
    const citations = extractSiblingGuardCitations(docText, identity);
    expect(
      citations.map((c) => ({
        real: c.real,
        start: c.start,
        end: c.end,
        line: c.line,
      })),
      "both the full citation and the path-less continuation must be " +
        "extracted despite each one's own anchor straddling a hard line " +
        "break, each reported at the physical line its citation TEXT " +
        `starts on (not the line its anchor happens to close on): ${JSON.stringify(citations)}`,
    ).toEqual([
      { real: "fixture-wrap.test.ts", start: 5, end: 6, line: 1 },
      { real: "fixture-wrap.test.ts", start: 9, end: 10, line: 2 },
    ]);
  });
});

// Imported here, not moved to the top-of-file import block, for the same
// reason `import ts from "typescript"` sits at its own point-of-use above:
// adding it there would shift every existing citation into this file.
import { createHash } from "node:crypto";

interface SiblingGuardAllowlistEntry {
  doc: string;
  kind: SiblingGuardFinding["kind"];
  real: string;
  start: number;
  end: number;
  // First 8 hex chars of sha256 over the finding's own anchor text
  // (`anchorText` for wrong-sibling-anchor, `anchorRaw` -- including its
  // own quote characters -- for duplicate-citation). Round 2 (F5): an
  // entry matched by (doc, kind, real, range) alone silently exempts ANY
  // future finding on that same range regardless of what its anchor
  // actually says, so a later citation edit that changes the anchor but
  // keeps the range would stay silently exempt instead of getting a fresh
  // review. `anchorKey` closes that: a changed anchor changes the key, so
  // the match (and the "every entry matched" test below) fails until the
  // entry is re-reviewed. Never the literal anchor text itself -- see the
  // note below on why this array must not quote one.
  anchorKey: string;
  // Round 4 (L2): the doc line of the finding's first citation in its
  // group -- the citing line itself for a wrong-sibling-anchor entry (each
  // wrong-sibling-anchor finding is built from exactly one citation), the
  // EARLIEST of the repeated citations' lines for a duplicate-citation
  // entry. Before this field, the match keyed on (doc, kind, real, range,
  // anchorKey, geometry) alone, so one entry could clear the same
  // coincidence in every paragraph of a doc that happened to reproduce it,
  // never reviewed per paragraph. A doc that makes the same citing mistake
  // in two different paragraphs now needs two entries and two claims, not
  // one covering both silently.
  paragraphLine: number;
  // Round 3 (R1), wrong-sibling-anchor entries only: the target-file
  // line(s) carrying the uncited, identical anchor text this entry was
  // actually cleared against, in the order the rule reports them. Both
  // halves of R1 hang off this field: it is part of the match key (an
  // entry exempts only the hit whose uncited lines are exactly these, so
  // a NEW uncited occurrence appearing next to an already-cleared one
  // fails instead of inheriting the old verdict), and the geometry test
  // below re-reads each of these lines and requires it to still carry the
  // citation's own anchor text. Recorded as a list, not a single line,
  // because a real bundle hit (uninstall.ts's bare loop keyword) reports
  // two uncited occurrences at once and a single-line field could not
  // represent it without dropping one of them from the check.
  uncitedLines?: readonly number[];
  // Round 3 (R1), duplicate-citation entries only: the DOC line the
  // repeat sits on. Same two jobs as `uncitedLines`: part of the match
  // key, and re-checked by the geometry test against the doc's own text.
  secondCitationLine?: number;
  // Round 3 (R2): replaces the free-form `reason`. One sentence naming
  // what the CITING SENTENCE describes and why the cited line, not the
  // uncited sibling (rule b) or a walked-on sibling range (rule a), is
  // that sentence's evidence -- written so a reviewer can falsify it by
  // reading the two lines the entry names and nothing else. Deliberately
  // narrow: a reason like "a common idiom" is unfalsifiable and is what
  // let two rounds of wrong-sibling verdicts ship green.
  claim: string;
}

function siblingGuardAnchorKeyFor(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function siblingGuardAnchorKey(finding: SiblingGuardFinding): string {
  return siblingGuardAnchorKeyFor(
    finding.kind === "duplicate-citation"
      ? (finding.anchorRaw ?? "")
      : finding.anchorText,
  );
}

function siblingGuardCitationAnchorKey(
  citation: SiblingGuardCitation,
  kind: SiblingGuardFinding["kind"],
): string {
  return siblingGuardAnchorKeyFor(
    kind === "duplicate-citation"
      ? (citation.anchorRaw ?? "")
      : (citation.anchorText ?? ""),
  );
}

// PROCESS, not a preference: an entry below is added only after an
// INDEPENDENT review pass has classified the hit as a coincidence, never
// on the reading of whoever implemented or re-pointed the citation. Two
// consecutive review rounds found entries here that certified real
// wrong-sibling drift, and both got in the same way -- the implementer
// classified its own guard's hits and wrote a free-prose reason no test
// could check. The classification is recorded in docs/okf/log.md; the
// three machine-checked halves are `uncitedLines`/`secondCitationLine` and
// `paragraphLine` (the geometry the verdict was reached against, re-checked
// below) and `claim` (a falsifiable one-sentence statement a reviewer can
// check by reading exactly two lines).
//
// Matched by (doc, kind, real target, range, anchorKey, recorded
// geometry, `paragraphLine`) -- not by the citation's own spelling of the
// path, and deliberately not by the anchor's own literal text either: four
// of these entries target this very file (`test/docs-consistency.test.ts`),
// so quoting an anchor's exact text in this array would itself add another
// occurrence of that text to the file the "at most 3 times file-wide"
// check (above) counts against -- the `claim` below paraphrases each one
// instead of quoting it verbatim, and `anchorKey` carries a hash instead of
// the text for the same reason. Round 4 (L2): `paragraphLine` pins an
// entry to the one citation (or repeat-group) it was actually reviewed
// against, so a doc that repeats the same coincidence in two different
// paragraphs needs two entries -- this closed a real case (round 4's M3
// finding): one entry silently cleared the identical range cited from two
// separate paragraphs of `model-preselection.md`, until the second
// paragraph's citation was re-pointed to its own, different evidence.
const SIBLING_GUARD_BUNDLE_ALLOWLIST: SiblingGuardAllowlistEntry[] = [
  {
    doc: "operator-install-and-registry.md",
    kind: "duplicate-citation",
    real: "packages/orchestrator-workflow/src/cli.ts",
    start: 1484,
    end: 1495,
    anchorKey: "3378a4b9",
    paragraphLine: 326,
    secondCitationLine: 334,
    claim:
      "the `adopt` paragraph makes two different claims about the same single write call -- first that the action writes nothing but the operator manifest, then at line 334 that the same call bootstraps a missing operator manifest from the target's own recorded settings; `adopt` has no second write call the repeat could have walked on to.",
  },
  {
    doc: "run-state-lifecycle-and-markers.md",
    kind: "duplicate-citation",
    real: "packages/orchestrator-workflow/test/template-markers.test.ts",
    start: 39,
    end: 41,
    anchorKey: "f3227b28",
    paragraphLine: 67,
    secondCitationLine: 89,
    claim:
      "the first citation attaches the byte-exact pin to the shipped marker literal; line 89 repeats it as the last item of the paragraph's closing enumeration of all three run-base pins in that file (:19, :33, :39-41), which leaves no fourth sibling test for the repeat to have named.",
  },
  {
    doc: "subagent-contracts-superset.md",
    kind: "duplicate-citation",
    real: "packages/orchestrator-workflow/test/docs-consistency.test.ts",
    start: 542,
    end: 542,
    anchorKey: "47aedb12",
    paragraphLine: 336,
    secondCitationLine: 341,
    claim:
      "the paragraph opens by naming the test that pins the 0.11.0 misfire rule, then closes at line 341 with an enumeration of that same test's clause-level pins (the section heading, both detection signals, the false-positive scoping language, the resume-or-respawn response paired with the non-evidence rule, and the `03-decisions.md` record requirement) whose last item is the review-gate consequence clause the opening citation already named; the enumeration is complete, so the line-341 repeat is the doc's closing-list convention, not a skipped sibling.",
  },
  {
    doc: "subagent-contracts-superset.md",
    kind: "duplicate-citation",
    real: "packages/orchestrator-workflow/test/docs-consistency.test.ts",
    start: 1063,
    end: 1063,
    anchorKey: "03317257",
    paragraphLine: 421,
    secondCitationLine: 425,
    claim:
      "same opening-citation-then-closing-enumeration convention as the 541 entry, here at :1062/line 425: the closing list walks :1037, :1045, :1050 and ends on the cross-copy equality check the :1062 opening sentence named, leaving no further assertion of that block uncited.",
  },
  {
    doc: "subagent-contracts-superset.md",
    kind: "duplicate-citation",
    real: "packages/orchestrator-workflow/test/docs-consistency.test.ts",
    start: 1177,
    end: 1177,
    anchorKey: "b19680bb",
    paragraphLine: 549,
    secondCitationLine: 555,
    claim:
      "same convention again, here at :1176/line 555: the closing list walks :1142, :1148, :1155, :1170 and ends on the not-applicable-clause pin the :1176 opening sentence named, leaving no further assertion of that block uncited.",
  },
  {
    doc: "install-fence-mechanics.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/src/init.ts",
    start: 766,
    end: 766,
    anchorKey: "3a4a026f",
    paragraphLine: 37,
    uncitedLines: [786],
    claim:
      "the sentence describes the per-template asset read driven by `listTemplateNames()`; line 766 is the read of a templates-directory asset, while uncited 786 reads the skill asset for a different install step the sentence never mentions.",
  },
  {
    doc: "install-fence-mechanics.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/test/init.test.ts",
    start: 197,
    end: 204,
    anchorKey: "67834189",
    paragraphLine: 291,
    uncitedLines: [195],
    claim:
      "the sentence claims an inline marker mention survives a re-run; line 203 is the assertion that it did survive, while uncited 195 is the test's own input string, which writes the mention before the run and asserts nothing.",
  },
  {
    doc: "install-fence-mechanics.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/src/init.ts",
    start: 747,
    end: 752,
    anchorKey: "33e8e25a",
    paragraphLine: 334,
    uncitedLines: [760],
    claim:
      "the sentence is explicitly about the path-exists-and-unedited branch; line 752 records the hash inside that branch's own `if`, while uncited 760 is the path-does-not-exist branch's record, which the sentence's own wording excludes.",
  },
  {
    doc: "install-fence-mechanics.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/test/init.test.ts",
    start: 129,
    end: 142,
    anchorKey: "6b912d8f",
    paragraphLine: 336,
    uncitedLines: [118],
    claim:
      "the sentence claims a plain SECOND run is a byte-for-byte no-op; line 142 is the idempotence block's second-run assertion, while uncited 118 is the same assertion inside an earlier first-install test, which says nothing about a second run.",
  },
  {
    doc: "install-fence-mechanics.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/src/uninstall.ts",
    start: 138,
    end: 147,
    anchorKey: "0bf37874",
    paragraphLine: 343,
    uncitedLines: [152, 157],
    claim:
      "the sentence names the containment re-check made before the unlink; line 147 is that guard's own loop exit, while uncited 152 and 157 exit the same loop for a missing file and a non-regular file, two guards this sentence does not describe (the anchor is a bare loop keyword, so it is the cited RANGE, not the anchor, that identifies the branch here).",
  },
  {
    doc: "model-preselection.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/src/init.ts",
    start: 862,
    end: 866,
    anchorKey: "8cd81eb8",
    paragraphLine: 156,
    uncitedLines: [869],
    claim:
      "the :156 sentence names the effort-line computation call and the model argument it is computed from; line 865 is that argument, while uncited 869 passes the computed local into the agent-composition call that only the (now separately cited, at init.ts:867-869) :423 sentence describes.",
  },
  {
    doc: "model-preselection.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/test/init.test.ts",
    start: 1497,
    end: 1513,
    anchorKey: "5ea9652d",
    paragraphLine: 376,
    uncitedLines: [1493],
    claim:
      "the sentence names the content assertion pinning the five-line default frontmatter; line 1513 is the asserted array element, while uncited 1493 is a comment above the test restating the same literal in prose.",
  },
  {
    doc: "model-preselection.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/test/init.test.ts",
    start: 1816,
    end: 1849,
    anchorKey: "d90f95bc",
    paragraphLine: 392,
    uncitedLines: [1850],
    claim:
      "the sentence names only the Claude-family variant-suffix outcomes; line 1849 asserts the low tier gets no `variant:` line, which is what the sentence needs, while uncited 1850 asserts the absence of `reasoningEffort`, opencode's own field for a non-Claude-family, non-Ollama provider (`src/init.ts:461`), not a codex field (codex's own equivalent is `model_reasoning_effort`, `src/codex.ts:50`) -- not part of what this sentence claims (the Ollama-side outcome it does name is cited separately, at a different range).",
  },
  {
    doc: "operator-install-and-registry.md",
    kind: "wrong-sibling-anchor",
    real: "packages/orchestrator-workflow/src/doctor.ts",
    start: 113,
    end: 121,
    anchorKey: "9ff75269",
    paragraphLine: 276,
    uncitedLines: [107],
    claim:
      "the sentence names the `--json` subset interface by name; line 121 is that interface's own field declaration, while uncited 107 is the identical field on the superset interface the very same sentence contrasts it against.",
  },
];

function siblingGuardFindingMatchesAllowlist(
  doc: string,
  finding: SiblingGuardFinding,
  entry: SiblingGuardAllowlistEntry,
): boolean {
  if (entry.doc !== doc || entry.kind !== finding.kind) return false;
  if (entry.real !== finding.real) return false;
  if (entry.start !== finding.start || entry.end !== finding.end) return false;
  if (entry.anchorKey !== siblingGuardAnchorKey(finding)) return false;
  // Round 4 (L2): pins an entry to the ONE paragraph it was reviewed
  // against -- the citing line itself for a wrong-sibling-anchor finding
  // (built from exactly one citation), the earliest of the repeated
  // citations' lines for a duplicate-citation finding. Without this, a
  // same (doc, kind, real, range, anchorKey, geometry) finding recurring
  // in a SECOND paragraph -- an unreviewed, independent coincidence --
  // would silently inherit the first paragraph's verdict.
  const findingParagraphLine =
    finding.kind === "duplicate-citation"
      ? finding.citationLines[0]
      : finding.citationLine;
  if (entry.paragraphLine !== findingParagraphLine) return false;
  // Round 3 (R1): the recorded geometry is part of the key, so an entry
  // exempts only the hit it was actually cleared against. A hit that grew
  // a new uncited occurrence, or a repeat that moved to another doc line,
  // no longer matches and fails the per-doc check until it is re-reviewed.
  if (finding.kind === "wrong-sibling-anchor") {
    const recorded = entry.uncitedLines;
    if (recorded === undefined) return false;
    return (
      recorded.length === finding.unclaimedLines.length &&
      recorded.every((line, idx) => line === finding.unclaimedLines[idx])
    );
  }
  // Round 4 (M1): also require the repeat COUNT to match. The pre-round-4
  // match compared only `citationLines[1]`, so a finding with a THIRD
  // repeat (`citationLines.length` 3, e.g. [a, b, c]) would still match an
  // entry cleared for a two-citation group whenever its second element
  // happened to equal the recorded line -- silently exempting the third,
  // unreviewed occurrence on the back of a verdict reached for only two.
  return (
    finding.citationLines.length === 2 &&
    entry.secondCitationLine === finding.citationLines[1]
  );
}

/**
 * Round 3 (R1): re-checks an allowlist entry's RECORDED GEOMETRY against
 * the current files, independently of whether the guard still reports the
 * hit. The entry never stores the anchor's literal text (see the array's
 * header note), so the anchor is re-derived from the doc's own citation of
 * the recorded range, and only then used to read the recorded line of the
 * target file. Returns a violation message, or undefined when the entry's
 * geometry still holds.
 *
 * Why this is not redundant with the match: the match compares an entry to
 * a FINDING the guard produced, so a mutation that stops the guard from
 * producing findings at all (a broken window, a dropped rule) silently
 * empties both sides of that comparison. This reads the files directly.
 */
function siblingGuardEntryGeometryViolation(
  entry: SiblingGuardAllowlistEntry,
  docText: string,
  resolveRealPath: (citedPath: string) => string | undefined,
  readTargetFile: (realPath: string) => string,
): string | undefined {
  const where = `${entry.doc}: entry for ${entry.real}:${entry.start}-${entry.end} (${entry.kind})`;
  const citations = extractSiblingGuardCitations(
    docText,
    resolveRealPath,
  ).filter(
    (c) =>
      c.real === entry.real &&
      c.start === entry.start &&
      c.end === entry.end &&
      siblingGuardCitationAnchorKey(c, entry.kind) === entry.anchorKey,
  );
  if (citations.length === 0) {
    return `${where} -- the doc no longer carries a citation of that range with the recorded anchorKey ${entry.anchorKey}`;
  }
  if (entry.kind === "wrong-sibling-anchor") {
    // Round 4 (L2): picks the SPECIFIC citation the entry was reviewed
    // against, by its recorded `paragraphLine`, rather than `citations[0]`
    // (which, before this round, could silently be a same-range,
    // same-anchor citation sitting in a different, unreviewed paragraph).
    const citation = citations.find((c) => c.line === entry.paragraphLine);
    if (citation === undefined) {
      return `${where} -- the doc no longer carries this citation at its recorded paragraph line ${entry.paragraphLine}`;
    }
    const anchorText = citation.anchorText;
    if (anchorText === undefined) {
      return `${where} -- recorded as a wrong-sibling-anchor exemption, but the doc's citation carries no string anchor`;
    }
    const recorded = entry.uncitedLines;
    if (recorded === undefined || recorded.length === 0) {
      return `${where} -- a wrong-sibling-anchor entry must record the uncited line(s) it was cleared against`;
    }
    const targetLines = readTargetFile(entry.real).split("\n");
    for (const lineNumber of recorded) {
      const line = targetLines[lineNumber - 1];
      if (line === undefined || !line.includes(anchorText)) {
        return `${where} -- recorded uncited line ${lineNumber} of ${entry.real} no longer carries the citation's own anchor text; the exemption was reached against a geometry that no longer exists`;
      }
    }
    return undefined;
  }
  const recordedSecond = entry.secondCitationLine;
  if (recordedSecond === undefined) {
    return `${where} -- a duplicate-citation entry must record the doc line its repeat sits on`;
  }
  // Round 4 (L3): replaces the near-tautological "a citation exists at the
  // recorded line, and that line's own text contains that same citation's
  // own path/start" check (true of ANY citation the extractor produced,
  // by construction -- it carries no information about whether the
  // recorded line is actually the SECOND member of the group). This reads
  // the group's own citations, sorts them into document order, and checks
  // the recorded lines by POSITION: `paragraphLine` must be the first,
  // `secondCitationLine` the second. Scoped to the SAME PARAGRAPH as the
  // recorded `paragraphLine` (not every same-range/anchorKey citation
  // doc-wide): `findDuplicateCitations` itself groups per paragraph, and
  // the same test/doc pair is legitimately cited again, unrelated, in a
  // different paragraph elsewhere in several bundle docs.
  const paragraphCitation = citations.find(
    (c) => c.line === entry.paragraphLine,
  );
  if (paragraphCitation === undefined) {
    return `${where} -- the doc no longer carries this citation at its recorded paragraph line ${entry.paragraphLine}`;
  }
  const groupLines = citations
    .filter((c) => c.paragraphId === paragraphCitation.paragraphId)
    .map((c) => c.line)
    .sort((a, b) => a - b);
  if (groupLines[0] !== entry.paragraphLine) {
    return (
      `${where} -- doc line ${entry.paragraphLine} is no longer the FIRST citation of ` +
      `this group in document order (group lines: ${groupLines.join(", ")})`
    );
  }
  if (groupLines.length < 2 || groupLines[1] !== recordedSecond) {
    return (
      `${where} -- doc line ${recordedSecond} is no longer the SECOND citation of ` +
      `this group in document order (group lines: ${groupLines.join(", ")})`
    );
  }
  return undefined;
}

// Round 4 (L1): every doc line number an entry itself records, across both
// kinds -- `start`/`end` (both kinds), `paragraphLine` (both kinds),
// `secondCitationLine` (duplicate-citation only), `uncitedLines`
// (wrong-sibling-anchor only, zero or more). A `claim` is falsifiable only
// if it names at least one of these; extracted to its own function so a
// dedicated, bundle-independent fixture can probe it directly rather than
// only through the real array (which never contains a bad entry to catch
// a weakened check with).
function siblingGuardEntryOwnLines(
  entry: SiblingGuardAllowlistEntry,
): number[] {
  return [
    entry.start,
    entry.end,
    entry.paragraphLine,
    ...(entry.secondCitationLine !== undefined
      ? [entry.secondCitationLine]
      : []),
    ...(entry.uncitedLines ?? []),
  ];
}

function siblingGuardClaimIsFalsifiable(
  entry: SiblingGuardAllowlistEntry,
): boolean {
  if (entry.claim.length <= 40) return false;
  return siblingGuardEntryOwnLines(entry).some((n) =>
    entry.claim.includes(String(n)),
  );
}

describe("the citation-sibling-drift guard reports zero (unallowlisted) findings on the current bundle", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");
  const readBundleDoc = (doc: string): string =>
    readRepoFile(`packages/orchestrator-workflow/docs/okf/${doc}`);
  const RESOLVE = anchorScopeResolve();
  const resolveRealPath = (citedPath: string): string | undefined =>
    RESOLVE[citedPath];

  // Round 4 (L1): renamed from "states a falsifiable claim", which the
  // body only checked by length -- a 41-character string with no relation
  // to the entry it sits on would have passed. Now also requires the claim
  // to name at least one of the entry's own recorded lines (`start`,
  // `end`, `paragraphLine`, `secondCitationLine`, `uncitedLines`), so a
  // claim that talks ABOUT the right shape but never actually points at
  // the geometry it is supposed to falsify fails here.
  it("every allowlist entry's claim is long enough AND names one of its own recorded lines (sanity: a falsifiable claim, not just a long string)", () => {
    for (const entry of SIBLING_GUARD_BUNDLE_ALLOWLIST) {
      expect(entry.claim.length, JSON.stringify(entry)).toBeGreaterThan(40);
      expect(
        siblingGuardClaimIsFalsifiable(entry),
        `${entry.doc} (${entry.real}:${entry.start}-${entry.end}) claim names ` +
          `none of its own recorded lines (${siblingGuardEntryOwnLines(entry).join(", ")}): ${entry.claim}`,
      ).toBe(true);
    }
  });

  // Round 4 (L1), bundle-independent: a dedicated fixture for
  // `siblingGuardClaimIsFalsifiable`, since the real array above never
  // contains a bad entry -- a mutant that weakens the check back to
  // length-only would survive the "every allowlist entry" test forever,
  // because no CURRENT entry exercises the rejection path. This
  // constructs a 41-character stub claim (long enough to pass the old
  // check) that names none of its own recorded lines, and asserts the
  // helper still rejects it.
  it("a 41-character claim that names none of its own entry's recorded lines is not falsifiable (the length check alone is not enough)", () => {
    const longEnoughButUnrelated: SiblingGuardAllowlistEntry = {
      doc: "fixture-doc.md",
      kind: "wrong-sibling-anchor",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorKey: "deadbeef",
      paragraphLine: 5,
      uncitedLines: [20],
      claim: "a common idiom explains this coincidence.", // 41 chars, no digits
    };
    expect(longEnoughButUnrelated.claim.length).toBeGreaterThan(40);
    expect(
      siblingGuardClaimIsFalsifiable(longEnoughButUnrelated),
      "a claim long enough to pass the old length-only check, but naming " +
        "none of the entry's own recorded lines (5, 10, 12, 20), must " +
        "still be rejected as unfalsifiable",
    ).toBe(false);

    const namesItsOwnLine: SiblingGuardAllowlistEntry = {
      ...longEnoughButUnrelated,
      claim: "line 20 is a different, unrelated coincidence entirely.",
    };
    expect(
      siblingGuardClaimIsFalsifiable(namesItsOwnLine),
      "the same length, now naming one of its own recorded lines (20), " +
        "must pass",
    ).toBe(true);
  });

  // Round 3 (R1): the entries' recorded geometry is re-derived from the
  // current doc and target files, not from the guard's own output, so an
  // entry whose situation changed (the uncited occurrence edited away or
  // moved, the repeat relocated to another doc line) fails here even if
  // the guard itself were broken and reported nothing at all.
  it("every allowlist entry's recorded geometry still holds against the current files", () => {
    const violations = SIBLING_GUARD_BUNDLE_ALLOWLIST.map((entry) =>
      siblingGuardEntryGeometryViolation(
        entry,
        readBundleDoc(entry.doc),
        resolveRealPath,
        readRepoFile,
      ),
    ).filter((v): v is string => v !== undefined);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // Round 2 (F5): the range-only match above does not by itself prove an
  // entry is still live -- a stale entry (its citation later re-pointed or
  // deleted, or the source line it named edited away) would sit in the
  // array forever, matching nothing, without ever failing a test. This
  // collects every finding across the whole bundle once and asserts each
  // allowlist entry matched at least one of them, so a dead exemption
  // fails here instead of silently accreting.
  it("every allowlist entry matched at least one finding on the current bundle (sanity: no dead exemption)", () => {
    const allFindings: Array<{ doc: string; finding: SiblingGuardFinding }> =
      [];
    for (const doc of ANCHOR_OKF_DOCS) {
      for (const finding of findCitationSiblingDrift(
        readBundleDoc(doc),
        resolveRealPath,
        readRepoFile,
      )) {
        allFindings.push({ doc, finding });
      }
    }
    const unmatched = SIBLING_GUARD_BUNDLE_ALLOWLIST.filter(
      (entry) =>
        !allFindings.some(({ doc, finding }) =>
          siblingGuardFindingMatchesAllowlist(doc, finding, entry),
        ),
    );
    expect(
      unmatched,
      `dead allowlist entries (matched no finding on the current bundle): ${JSON.stringify(unmatched, null, 2)}`,
    ).toEqual([]);
  });

  // Round 3 (F7), the paired half of the fence-balance throw: a doc that
  // yields no citations at all is indistinguishable, from the per-doc
  // checks below, from a doc whose citations are all clean. Every bundle
  // module doc really does cite something, so pin that rather than let a
  // future extractor regression pass as a clean bundle.
  it("every bundle doc yields at least one extracted citation (sanity: the per-doc checks below are not vacuous)", () => {
    for (const doc of ANCHOR_OKF_DOCS) {
      const citations = extractSiblingGuardCitations(
        readBundleDoc(doc),
        resolveRealPath,
      );
      expect(citations.length, `${doc} yielded no citations`).toBeGreaterThan(
        0,
      );
    }
  });

  // Round 2 (F5): a dedicated, bundle-independent proof that `anchorKey`
  // actually gates the match rather than being a decorative extra field.
  // Builds one allowlist entry and two hand-made findings that share the
  // entry's (doc, kind, real, range) exactly but differ in anchor text: a
  // match on range alone (the pre-round-2 behaviour) would wrongly exempt
  // the second one too.
  it("an allowlist entry does not match a same-range finding whose anchor text differs (anchorKey gates the match, not just the range)", () => {
    const sameAnchorFinding: WrongSiblingAnchorFinding = {
      kind: "wrong-sibling-anchor",
      paragraphId: 0,
      citedPath: "fixture-target.ts",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorText: "the allowlisted coincidence",
      unclaimedLines: [20],
      citationLine: 5,
    };
    const entry: SiblingGuardAllowlistEntry = {
      doc: "fixture-doc.md",
      kind: "wrong-sibling-anchor",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorKey: siblingGuardAnchorKey(sameAnchorFinding),
      paragraphLine: 5,
      uncitedLines: [20],
      claim:
        "fixture: the citing sentence names the cited range's own subject, and the uncited line at 20 belongs to a different one.",
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        sameAnchorFinding,
        entry,
      ),
    ).toBe(true);

    // Round 3: the differing finding keeps the entry's recorded geometry
    // (`unclaimedLines: [20]`) and differs in the anchor text ALONE, so
    // this stays a proof about `anchorKey` specifically. Round 3's added
    // geometry comparison would otherwise reject a variant that also moved
    // the uncited line, and a mutant that drops the anchorKey check
    // entirely would survive this fixture on the geometry check's back --
    // measured, not hypothetical: the round-2 anchorKey probe came back
    // `survived` on the first replay of this round for exactly that
    // reason. A same-anchorless-range finding with an anchor edited to
    // something that happens to recur on the SAME uncited line is a real
    // shape (a citation re-anchored in place), and nobody has reviewed it.
    const differentAnchorFinding: WrongSiblingAnchorFinding = {
      ...sameAnchorFinding,
      anchorText: "a completely different anchor text",
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        differentAnchorFinding,
        entry,
      ),
      "a same-range finding with a different anchor must NOT silently " +
        "match an entry verified for a different anchor's coincidence",
    ).toBe(false);
  });

  // Round 3 (R1), bundle-independent: the recorded geometry gates the
  // match too. Same doc, kind, range and anchor as the cleared hit, but a
  // different uncited occurrence -- which is a different situation, and
  // one nobody has reviewed. The pre-round-3 match ignored the uncited
  // line entirely and would have exempted it.
  it("an allowlist entry does not match a same-anchor finding whose uncited lines differ (the recorded geometry gates the match)", () => {
    const clearedFinding: WrongSiblingAnchorFinding = {
      kind: "wrong-sibling-anchor",
      paragraphId: 0,
      citedPath: "fixture-target.ts",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorText: "the allowlisted coincidence",
      unclaimedLines: [20],
      citationLine: 5,
    };
    const entry: SiblingGuardAllowlistEntry = {
      doc: "fixture-doc.md",
      kind: "wrong-sibling-anchor",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorKey: siblingGuardAnchorKey(clearedFinding),
      paragraphLine: 5,
      uncitedLines: [20],
      claim:
        "fixture: the citing sentence names the cited range's own subject, and the uncited line at 20 belongs to a different one.",
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        clearedFinding,
        entry,
      ),
    ).toBe(true);

    const movedOccurrence: WrongSiblingAnchorFinding = {
      ...clearedFinding,
      unclaimedLines: [25],
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        movedOccurrence,
        entry,
      ),
      "an uncited occurrence at another line is another situation and " +
        "must not inherit the cleared hit's exemption",
    ).toBe(false);

    const extraOccurrence: WrongSiblingAnchorFinding = {
      ...clearedFinding,
      unclaimedLines: [20, 25],
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        extraOccurrence,
        entry,
      ),
      "a SECOND uncited occurrence appearing next to the cleared one is " +
        "new, unreviewed drift and must not inherit the exemption either",
    ).toBe(false);
  });

  // Round 4 (L2), bundle-independent: `paragraphLine` gates the match too.
  // Same doc, kind, real target, range, anchorKey AND recorded geometry
  // (`uncitedLines`) as the cleared hit -- the pre-round-4 match would
  // exempt this -- but the finding's own citing line says it comes from a
  // DIFFERENT paragraph. A second paragraph reproducing the exact same
  // coincidence is independent, unreviewed drift, not a repeat of the
  // first paragraph's already-classified hit.
  it("an allowlist entry does not match a same-geometry finding from a different paragraph (paragraphLine gates the match)", () => {
    const clearedFinding: WrongSiblingAnchorFinding = {
      kind: "wrong-sibling-anchor",
      paragraphId: 0,
      citedPath: "fixture-target.ts",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorText: "the allowlisted coincidence",
      unclaimedLines: [20],
      citationLine: 5,
    };
    const entry: SiblingGuardAllowlistEntry = {
      doc: "fixture-doc.md",
      kind: "wrong-sibling-anchor",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorKey: siblingGuardAnchorKey(clearedFinding),
      paragraphLine: 5,
      uncitedLines: [20],
      claim:
        "fixture: the citing sentence names the cited range's own subject, and the uncited line at 20 belongs to a different one.",
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        clearedFinding,
        entry,
      ),
    ).toBe(true);

    const anotherParagraphFinding: WrongSiblingAnchorFinding = {
      ...clearedFinding,
      paragraphId: 4,
      citationLine: 40,
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        anotherParagraphFinding,
        entry,
      ),
      "the identical range/anchor/geometry coincidence reproduced in a " +
        "different paragraph is independent, unreviewed drift and must " +
        "not inherit the first paragraph's exemption",
    ).toBe(false);
  });

  // Round 4 (M1): a duplicate-citation counterpart to the round-3
  // anchorKey/geometry fixtures above -- the pre-round-4 match compared
  // only `finding.citationLines[1]` against `entry.secondCitationLine`,
  // which a literal `return true;` mutant of that comparison survives
  // undetected (no fixture built a duplicate-citation finding whose
  // second citation line actually DIFFERS from the entry it is compared
  // against). Also covers the three-repeat blind spot named in the
  // review: a finding with a THIRD citation (`citationLines` [a, b, c])
  // whose second element happens to equal the recorded line, compared
  // against an entry that was only ever reviewed for a two-citation
  // repeat.
  it("an allowlist entry does not match a duplicate-citation finding whose second citation line differs, or whose group grew a third repeat", () => {
    const twoRepeatFinding: DuplicateCitationFinding = {
      kind: "duplicate-citation",
      paragraphId: 0,
      citedPath: "fixture-target.ts",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorRaw: '"the allowlisted coincidence"',
      count: 2,
      citationLines: [5, 30],
    };
    const entry: SiblingGuardAllowlistEntry = {
      doc: "fixture-doc.md",
      kind: "duplicate-citation",
      real: "fixture-target.ts",
      start: 10,
      end: 12,
      anchorKey: siblingGuardAnchorKey(twoRepeatFinding),
      paragraphLine: 5,
      secondCitationLine: 30,
      claim:
        "fixture: the opening citation at line 5 and the repeat at line 30 both name the same subject, and no third citation exists for the repeat to have walked on to.",
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        twoRepeatFinding,
        entry,
      ),
    ).toBe(true);

    const movedRepeat: DuplicateCitationFinding = {
      ...twoRepeatFinding,
      citationLines: [5, 33],
    };
    expect(
      siblingGuardFindingMatchesAllowlist("fixture-doc.md", movedRepeat, entry),
      "a repeat that moved to a different doc line is a different " +
        "situation and must not inherit the cleared verdict",
    ).toBe(false);

    const threeRepeatFinding: DuplicateCitationFinding = {
      ...twoRepeatFinding,
      count: 3,
      citationLines: [5, 30, 55],
    };
    expect(
      siblingGuardFindingMatchesAllowlist(
        "fixture-doc.md",
        threeRepeatFinding,
        entry,
      ),
      "a finding whose group grew a THIRD, unreviewed repeat must not " +
        "match an entry that was only ever cleared for a two-citation group, " +
        "even though its second element (30) still equals the recorded line",
    ).toBe(false);
  });

  // Round 4 (M1), the `siblingGuardEntryGeometryViolation` counterpart:
  // before round 4 (L3), the duplicate-citation branch only checked that
  // SOME citation existed at the recorded line and that its own text
  // contained its own path/start -- true of any citation the extractor
  // produced, by construction. A mutant replacing that whole guard with
  // `if (false)` survived, because no fixture exercised the branch where
  // the recorded line is NOT actually the group's second citation in
  // document order. This fixture does: same recorded geometry, but the
  // doc's citations moved so the recorded `secondCitationLine` is no
  // longer where the repeat actually sits.
  it("a duplicate-citation entry whose recorded doc lines are no longer the group's first/second citations in order is reported as a geometry violation", () => {
    const identity = (citedPath: string): string => citedPath;
    const entry: SiblingGuardAllowlistEntry = {
      doc: "fixture-dup-geometry.md",
      kind: "duplicate-citation",
      real: "fixture-dup-geometry.test.ts",
      start: 10,
      end: 12,
      anchorKey: siblingGuardAnchorKeyFor('"shared anchor"'),
      paragraphLine: 2,
      secondCitationLine: 6,
      claim:
        "fixture: the opening citation at line 2 and the repeat at line 6 both name the same subject, with no third sibling for the repeat to have walked on to.",
    };

    const intactDoc =
      "opening filler line\n" +
      'fixture-dup-geometry.test.ts:10-12#"shared anchor" opens the point,\n' +
      "some unrelated prose in between\n" +
      "more unrelated prose\n" +
      "still more unrelated prose\n" +
      'fixture-dup-geometry.test.ts:10-12#"shared anchor" repeats it here.\n';
    expect(
      siblingGuardEntryGeometryViolation(entry, intactDoc, identity, () => ""),
      "the citations sit on lines 2 and 6, exactly the recorded " +
        "paragraphLine/secondCitationLine pair, and must pass",
    ).toBeUndefined();

    // A new, EARLIER citation of the same range appears in the same
    // paragraph (no blank line separates it from the recorded line-2
    // citation, which is still there): the group's real first citation is
    // now line 1, not the recorded 2, even though line 2 itself is
    // untouched -- exactly the shape the pre-round-4 tautological check
    // could not see, since a citation still exists at the recorded line.
    const driftedDoc =
      'fixture-dup-geometry.test.ts:10-12#"shared anchor" appears extra early here,\n' +
      'fixture-dup-geometry.test.ts:10-12#"shared anchor" opens the point,\n' +
      "more unrelated prose\n" +
      "still more unrelated prose\n" +
      'fixture-dup-geometry.test.ts:10-12#"shared anchor" repeats it here.\n';
    expect(
      siblingGuardEntryGeometryViolation(entry, driftedDoc, identity, () => ""),
      "a new citation of the same range appeared at line 1, so the " +
        "recorded paragraphLine (2) is no longer the group's FIRST " +
        "citation and this must be reported",
    ).toMatch(/no longer the FIRST citation/);
  });

  // Round 3 (R1), bundle-independent: the geometry re-check itself. An
  // entry whose recorded uncited line no longer carries the citation's
  // anchor text was cleared against a situation that no longer exists,
  // and must be reported rather than left exempting whatever is there
  // now.
  it("an entry whose recorded uncited line no longer carries the anchor text is reported as a geometry violation", () => {
    const anchor = "the allowlisted coincidence";
    const docText =
      "prose citing a range and a sibling of it\n" +
      `(fixture-geometry.test.ts:10-12#"${anchor}";\n` +
      'fixture-geometry.test.ts:40-42#"a second, unrelated anchor").\n';
    const entry: SiblingGuardAllowlistEntry = {
      doc: "fixture-geometry.md",
      kind: "wrong-sibling-anchor",
      real: "fixture-geometry.test.ts",
      start: 10,
      end: 12,
      anchorKey: siblingGuardAnchorKeyFor(anchor),
      paragraphLine: 2,
      uncitedLines: [20],
      claim:
        "fixture: the citing sentence names the cited range's own subject, and the uncited line at 20 belongs to a different one.",
    };
    const identity = (citedPath: string): string => citedPath;

    const intact = buildSiblingGuardFixtureFile(50, {
      12: `  ${anchor}`,
      20: `  ${anchor}`,
      42: "  a second, unrelated anchor",
    });
    expect(
      siblingGuardEntryGeometryViolation(
        entry,
        docText,
        identity,
        () => intact,
      ),
      "the entry's recorded geometry is intact here and must pass",
    ).toBeUndefined();

    const drifted = buildSiblingGuardFixtureFile(50, {
      12: `  ${anchor}`,
      26: `  ${anchor}`,
      42: "  a second, unrelated anchor",
    });
    expect(
      siblingGuardEntryGeometryViolation(
        entry,
        docText,
        identity,
        () => drifted,
      ),
      "line 20 no longer carries the anchor, so the exemption's own " +
        "geometry is gone and must be reported",
    ).toMatch(/recorded uncited line 20/);
  });

  for (const doc of ANCHOR_OKF_DOCS) {
    it(`${doc}: zero unallowlisted citation-sibling-drift findings`, () => {
      const findings = findCitationSiblingDrift(
        readBundleDoc(doc),
        resolveRealPath,
        readRepoFile,
      );
      const unallowlisted = findings.filter(
        (f) =>
          !SIBLING_GUARD_BUNDLE_ALLOWLIST.some((entry) =>
            siblingGuardFindingMatchesAllowlist(doc, f, entry),
          ),
      );
      expect(unallowlisted, formatSiblingGuardFindings(unallowlisted)).toEqual(
        [],
      );
    });
  }
});

// agent-tasks b50fd903 review round 2 (MEDIUM 2), closed in round 3: the
// three ANCHOR_CITATION_RE resolution sites above were rewired to call
// `extractSiblingGuardCitations` in round 2, but nothing pinned that
// wiring -- a line-count-preserving mutant at `collectStringAnchoredCitations`'s
// own filter (extending it to also require the citation's own doc line to
// literally contain `c.citedPath`) silently dropped every resolved
// continuation from its output while every existing assertion in this
// file stayed green (313/313), because the real bundle's own
// continuations all resolve into a target none of the other checks
// happen to fail differently for. Two independent pins close that: a
// source-span check that each of the three sites still calls the shared
// extractor and carries no bare `matchAll(ANCHOR_CITATION_RE)` loop of
// its own (below), and a synthetic-doc-set test driving
// `collectStringAnchoredCitations` directly, defined right next to that
// function's own definition above (it needs that function's closure over
// `RESOLVE`'s sibling parameter, so it cannot live down here).
describe("the three ANCHOR_CITATION_RE resolution sites stay wired to extractSiblingGuardCitations (task agent-dx b50fd903, review round 3, MEDIUM 2)", () => {
  const selfSource = readFileSync(
    fileURLToPath(new URL("docs-consistency.test.ts", import.meta.url)),
    "utf8",
  );
  const selfLines = selfSource.split("\n");

  function sliceSpan(startMarker: string, closeLine: string): string {
    const startIdx = selfLines.findIndex((l) => l.includes(startMarker));
    if (startIdx === -1) {
      throw new Error(
        `could not locate "${startMarker}" in this file's own source`,
      );
    }
    let endIdx = -1;
    for (let i = startIdx + 1; i < selfLines.length; i++) {
      if (selfLines[i] === closeLine) {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) {
      throw new Error(`could not find "${closeLine}" closing "${startMarker}"`);
    }
    return selfLines.slice(startIdx, endIdx + 1).join("\n");
  }

  const collectorSpans: Record<string, string> = {
    collectStringAnchoredCitations: sliceSpan(
      "function collectStringAnchoredCitations(",
      "  }",
    ),
    "the unanchored-citation brake": sliceSpan(
      "function collectBrakeScan(",
      "  }",
    ),
    collectFullTestCitations: sliceSpan(
      "function collectFullTestCitations(",
      "  }",
    ),
  };

  for (const [name, span] of Object.entries(collectorSpans)) {
    it(`${name} calls extractSiblingGuardCitations and carries no bare matchAll(ANCHOR_CITATION_RE) loop of its own`, () => {
      expect(
        span,
        `could not find a call to extractSiblingGuardCitations( inside ${name}'s own span`,
      ).toContain("extractSiblingGuardCitations(");
      expect(
        span,
        `${name}'s own span still runs a bare content.matchAll(ANCHOR_CITATION_RE) loop`,
      ).not.toContain("content.matchAll(ANCHOR_CITATION_RE)");
    });
  }
});

// agent-tasks b50fd903 review round 2 (MEDIUM 3), redesigned in round 3
// per D-037: `docs/okf/log.md` is excluded from `ANCHOR_OKF_DOCS` (it is
// the bundle's own changelog, not a knowledge doc) and therefore from
// every guard above, and okf-kit's own citation grammar cannot see this
// bundle's path-less continuation form at all (see the reason correction
// next to `extractSiblingGuardCitations`'s own definition) -- so
// citation-shaped historical text written into a log entry is read by
// NOTHING. Round 1 of this task removed exactly such text from a log
// entry (0f054d2) and round 2 wrote five more (see review round 2,
// MEDIUM 3). Rather than another round of rephrasing that recurs on the
// next entry, log.md gets its own guard: every full, anchored citation it
// writes must still resolve at head (the target exists, the anchor text
// sits somewhere inside the cited range), and it may never carry the
// bundle's path-less continuation form at all, since that form has no
// governing-citation semantics of its own here -- nothing in this bundle
// resolves a continuation written in log.md against anything, so it can
// only ever be stale prose masquerading as a citation. A historical value
// belongs in plain prose instead (see the log entry this round adds for
// the convention: "moved to lines N through M", not `` `:N-M#"..."` ``).
describe("docs/okf/log.md's own citations resolve, and it carries no path-less continuation citation form (task agent-dx b50fd903, review round 3, D-037)", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const readRepoFile = (relPath: string): string =>
    readFileSync(`${repoRoot}/${relPath}`, "utf8");
  const scopedResolve = anchorScopeResolve();

  // log.md narrates the whole package's history, so it cites files
  // ANCHOR_OKF_DOCS's own resolver (`anchorScopeResolve`) never needed to
  // know about: the package's own CHANGELOG/README/INSTALL-AGENT, and its
  // docs/okf siblings by their own bare or full path. Extended here,
  // local to this guard, rather than widening `anchorScopeResolve` itself
  // for every other caller.
  const EXTRA_LOG_CITATION_TARGETS: Record<string, string> = {
    "CHANGELOG.md": "packages/orchestrator-workflow/CHANGELOG.md",
    "packages/orchestrator-workflow/CHANGELOG.md":
      "packages/orchestrator-workflow/CHANGELOG.md",
    "INSTALL-AGENT.md": "packages/orchestrator-workflow/INSTALL-AGENT.md",
    "packages/orchestrator-workflow/INSTALL-AGENT.md":
      "packages/orchestrator-workflow/INSTALL-AGENT.md",
    "README.md": "packages/orchestrator-workflow/README.md",
    "assets/skill/SKILL.md":
      "packages/orchestrator-workflow/assets/skill/SKILL.md",
    "packages/orchestrator-workflow/README.md":
      "packages/orchestrator-workflow/README.md",
  };
  for (const doc of ANCHOR_OKF_DOCS) {
    EXTRA_LOG_CITATION_TARGETS[`docs/okf/${doc}`] =
      `packages/orchestrator-workflow/docs/okf/${doc}`;
    EXTRA_LOG_CITATION_TARGETS[
      `packages/orchestrator-workflow/docs/okf/${doc}`
    ] = `packages/orchestrator-workflow/docs/okf/${doc}`;
  }

  // Review round 3 (LOW), closed in round 4: a bare basename that BOTH
  // the bespoke map above binds to this package's own file AND exists at
  // the repository root is genuinely ambiguous -- `README.md:108` in a
  // log entry could mean either, and the map silently picked this
  // package's every time. Computed from the map and the disk rather than
  // hand-listed, so it stays right when a root file of the same name is
  // added or removed later; such a citation is reported unresolved with
  // both candidates named, and the entry has to write the path out in
  // full (`packages/orchestrator-workflow/README.md:108`), which both
  // maps already accept. Residual, unchanged and named here: the deeper
  // repo-wide basename ambiguity okf-kit reports (`SKILL.md` exists in
  // more than one package) is still bound unconditionally, by
  // `anchorScopeResolve()`'s own documented design, and this guard
  // inherits that binding rather than second-guessing it.
  const ROOT_AMBIGUOUS_BARE_NAMES = new Set(
    Object.keys(EXTRA_LOG_CITATION_TARGETS).filter(
      (name) =>
        !name.includes("/") &&
        EXTRA_LOG_CITATION_TARGETS[name] !== name &&
        existsSync(`${repoRoot}/${name}`),
    ),
  );

  interface LogPathResolution {
    real?: string;
    /** Why it did not resolve, for the failure message. */
    reason?: string;
  }

  function resolveLogCitationPath(citedPath: string): LogPathResolution {
    // Review round 3 (LOW), closed in round 4: the on-disk fallback below
    // used to join `repoRoot` with the cited path unchecked, so a
    // `../outside-target.md` citation resolved to a real file OUTSIDE the
    // repository and was then read and anchor-checked against it. A `..`
    // segment is never a legitimate citation in this bundle; reject it
    // before any lookup, and assert containment on the fallback anyway
    // (belt and braces for a path the segment check does not model).
    if (citedPath.split("/").includes("..")) {
      return {
        reason:
          "cited path escapes the repository with a `..` segment; write it repo-root-relative instead",
      };
    }
    if (ROOT_AMBIGUOUS_BARE_NAMES.has(citedPath)) {
      return {
        reason:
          `bare \`${citedPath}\` is ambiguous between ${EXTRA_LOG_CITATION_TARGETS[citedPath]} ` +
          `and the repository root's own ${citedPath}; write the full repo-root-relative path`,
      };
    }
    if (scopedResolve[citedPath]) return { real: scopedResolve[citedPath] };
    if (EXTRA_LOG_CITATION_TARGETS[citedPath]) {
      return { real: EXTRA_LOG_CITATION_TARGETS[citedPath] };
    }
    // Fallback for anything already fully repo-root-relative that the
    // maps above do not name explicitly (e.g. a future citation into a
    // sibling package): a real file on disk at exactly that path, inside
    // the repository.
    const candidate = resolvePath(repoRoot, citedPath);
    if (
      candidate.startsWith(`${resolvePath(repoRoot)}${sep}`) &&
      existsSync(candidate)
    ) {
      return { real: citedPath };
    }
    return { reason: "no such file inside the repository" };
  }

  interface LogCitationCheckResult {
    unresolvedFullCitations: string[];
    anchorNotInRange: string[];
    continuationForms: string[];
    /** Anchored full citations this scan actually read and checked. */
    fullCitationsChecked: number;
  }

  // Review round 3 (MEDIUM 2/3), closed in round 4: this scan used to
  // hand-copy `extractSiblingGuardCitations`'s fence-skip pass -- without
  // its unbalanced-fence throw, so one stray ``` anywhere in log.md
  // silently excused every citation after it -- and to match per physical
  // line, so any citation whose own text wrapped across a hard line break
  // was invisible to BOTH rules below. Both closed by consuming the
  // shared `citationScanParagraphs` helper (defined next to that
  // function): one fence pass, one throw, and paragraph-joined text with
  // an offset-to-line map, so a wrapped citation is matched and still
  // reported at the physical line it starts on.
  function checkLogCitations(
    docText: string,
    resolveRealPath: (citedPath: string) => LogPathResolution,
    readTarget: (real: string) => string,
  ): LogCitationCheckResult {
    // The module-scope `PATH_SHAPED_BEFORE_RE` beside `citationScan
    // Paragraphs` (round 4 lows: shared with `extractSiblingGuardCitations`
    // above, no more hand-copied duplicate): a real continuation is never
    // directly preceded by a bare path (e.g. a `.toml` citation's own
    // `:N-M#"..."` tail), and this guard forbids the continuation FORM
    // outright rather than resolving it, so it cannot reuse that
    // function's resolved-citations return value to tell the two apart.
    const unresolvedFullCitations: string[] = [];
    const anchorNotInRange: string[] = [];
    const continuationForms: string[] = [];
    let fullCitationsChecked = 0;
    const scanned = citationScanParagraphs(
      docText,
      "docs/okf/log.md citation guard",
    );
    scanned.forEach((scan) => {
      const text = scan.text;
      const fullMatches = [...text.matchAll(ANCHOR_CITATION_RE)];
      for (const m of fullMatches) {
        const anchorRaw = m[4];
        if (!anchorRaw || !anchorRaw.startsWith('"')) continue;
        const citedPath = m[1];
        const start = Number(m[2]);
        const end = m[3] ? Number(m[3]) : start;
        const rangeSuffix = m[3] ? `-${end}` : "";
        const anchorText = anchorRaw.slice(1, -1);
        const line = scan.lineOf(m.index!);
        const resolved = resolveRealPath(citedPath);
        const real = resolved.real;
        if (real === undefined) {
          unresolvedFullCitations.push(
            `log.md:${line}: ${citedPath}:${start}${rangeSuffix} -- ${resolved.reason ?? "no such file"}`,
          );
          continue;
        }
        fullCitationsChecked++;
        const targetLines = readTarget(real).split("\n");
        const rangeLines = targetLines.slice(start - 1, end);
        if (!rangeLines.some((l) => l.includes(anchorText))) {
          anchorNotInRange.push(
            `log.md:${line}: ${citedPath}:${start}${rangeSuffix}#"${anchorText}" -- anchor text not found inside its own cited range of ${real}`,
          );
        }
      }
      const continuationMatches = [
        ...text.matchAll(ANCHOR_CONTINUATION_CITATION_RE),
      ]
        .filter(
          (m) =>
            !fullMatches.some(
              (fm) =>
                m.index! >= fm.index! && m.index! < fm.index! + fm[0].length,
            ),
        )
        .filter((m) => !PATH_SHAPED_BEFORE_RE.test(text.slice(0, m.index!)));
      for (const m of continuationMatches) {
        continuationForms.push(
          `log.md:${scan.lineOf(m.index!)}: \`${m[0]}\` -- path-less continuation citation form is forbidden in docs/okf/log.md (log.md has no governing-citation semantics; rephrase as plain prose)`,
        );
      }
    });
    return {
      unresolvedFullCitations,
      anchorNotInRange,
      continuationForms,
      fullCitationsChecked,
    };
  }

  const FIXTURE_TARGET = "fake/target.ts";
  const FIXTURE_TARGET_CONTENT = ["line one", "line two", "line three"].join(
    "\n",
  );
  const fixtureResolve = (citedPath: string): LogPathResolution =>
    citedPath === FIXTURE_TARGET
      ? { real: FIXTURE_TARGET }
      : { reason: "no such file inside the repository" };
  const fixtureReadTarget = (real: string): string => {
    if (real === FIXTURE_TARGET) return FIXTURE_TARGET_CONTENT;
    throw new Error(`fixture readTarget: unexpected real path ${real}`);
  };

  it("fixture: a full citation whose anchor text is not inside its own cited range fails", () => {
    const doc = [
      "# Bundle log",
      "",
      `- an entry citing \`${FIXTURE_TARGET}:1#"line two"\` (stale: "line two" is on line 2, not inside the cited range 1-1).`,
    ].join("\n");
    const result = checkLogCitations(doc, fixtureResolve, fixtureReadTarget);
    expect(result.anchorNotInRange.length).toBeGreaterThan(0);
    expect(result.unresolvedFullCitations).toEqual([]);
    expect(result.continuationForms).toEqual([]);
  });

  it("fixture: a full citation into a nonexistent path fails", () => {
    const doc = [
      "# Bundle log",
      "",
      '- an entry citing `nope/does-not-exist.ts:1#"anchor"`.',
    ].join("\n");
    const result = checkLogCitations(doc, fixtureResolve, fixtureReadTarget);
    expect(result.unresolvedFullCitations.length).toBeGreaterThan(0);
    expect(result.continuationForms).toEqual([]);
  });

  it("fixture: a path-less continuation citation form fails, even when it would resolve", () => {
    const doc = [
      "# Bundle log",
      "",
      `- an entry citing \`${FIXTURE_TARGET}:2#"line two"\` and, in the same paragraph, the old value \`:1#"line one"\`.`,
    ].join("\n");
    const result = checkLogCitations(doc, fixtureResolve, fixtureReadTarget);
    expect(result.continuationForms.length).toBeGreaterThan(0);
  });

  it("fixture: a clean log entry (a resolving full citation, an old value described in plain prose) passes", () => {
    const doc = [
      "# Bundle log",
      "",
      `- an entry citing \`${FIXTURE_TARGET}:2#"line two"\` only; the old value sat on line 1, described here in prose, not backticked as a citation.`,
    ].join("\n");
    const result = checkLogCitations(doc, fixtureResolve, fixtureReadTarget);
    expect(result.unresolvedFullCitations).toEqual([]);
    expect(result.anchorNotInRange).toEqual([]);
    expect(result.continuationForms).toEqual([]);
  });

  // Round 4 (MEDIUM 2): the two rules above are matched over
  // paragraph-joined text, so a citation that a hard wrap split across
  // two physical lines is seen. Both fixtures fail under the round-3
  // per-line scan and pass under this one; the wrap point sits inside the
  // anchor string, which is where this bundle's own wraps land (the
  // anchor is the longest part of a citation and the only part that
  // contains spaces).
  it("fixture: a full citation whose anchor wraps across a hard line break is still checked (a stale wrapped anchor fails)", () => {
    const doc = [
      "# Bundle log",
      "",
      `- an entry citing \`${FIXTURE_TARGET}:1#"line one and`,
      '  something that is not there"` across a wrapped line.',
    ].join("\n");
    const result = checkLogCitations(doc, fixtureResolve, fixtureReadTarget);
    expect(
      result.anchorNotInRange,
      "a wrapped full citation with a bogus anchor must be reported",
    ).toHaveLength(1);
    expect(result.anchorNotInRange[0]).toContain("log.md:3");
    expect(result.unresolvedFullCitations).toEqual([]);
  });

  it("fixture: a path-less continuation citation form that wraps across a hard line break is still flagged", () => {
    const doc = [
      "# Bundle log",
      "",
      `- an entry citing \`${FIXTURE_TARGET}:2#"line two"\` and then, in the`,
      '  same paragraph, the old value `:1#"line one is what it',
      '  said"` written as a citation.',
    ].join("\n");
    const result = checkLogCitations(doc, fixtureResolve, fixtureReadTarget);
    expect(
      result.continuationForms,
      "the wrapped continuation form must be reported",
    ).toHaveLength(1);
    expect(result.continuationForms[0]).toContain("log.md:4");
  });

  // Round 4 (MEDIUM 3): the round-3 scan hand-copied the fence-skip pass
  // without its throw, so a single stray ``` (this doc's own line 4 here)
  // silently excused every citation after it -- a deliberately stale
  // citation and a forbidden continuation both passed. The shared
  // `citationScanParagraphs` helper throws instead.
  it("fixture: a log that ends inside an unclosed ``` fence throws instead of silently excusing every citation after the stray delimiter", () => {
    const doc = [
      "# Bundle log",
      "",
      "- an entry.",
      "```",
      "",
      `- an entry citing \`${FIXTURE_TARGET}:1#"line two"\` and \`:3#"line one"\`.`,
    ].join("\n");
    expect(() =>
      checkLogCitations(doc, fixtureResolve, fixtureReadTarget),
    ).toThrow(/unclosed code fence/);
  });

  it("fixture: a cited path escaping the repository with a `..` segment does not resolve", () => {
    expect(resolveLogCitationPath("../outside-target.md").real).toBeUndefined();
    expect(resolveLogCitationPath("../outside-target.md").reason).toContain(
      "escapes the repository",
    );
    expect(
      resolveLogCitationPath("packages/orchestrator-workflow/../../README.md")
        .real,
    ).toBeUndefined();
    // Round 4 lows (agent-dx 4ece8e1e): the `..`-segment rejection above
    // fires before the on-disk fallback ever runs, so it cannot pin the
    // fallback's OWN containment check. `/etc/hosts` carries no `..`
    // segment and reliably exists on disk (macOS and Linux CI runners
    // alike), so it reaches the fallback: `path.resolve(repoRoot,
    // "/etc/hosts")` discards `repoRoot` (an absolute second argument
    // wins), leaving a candidate outside the repository that only the
    // `candidate.startsWith(repoRoot + sep)` conjunct rejects.
    // Neutralising that conjunct to `true &&` would let this resolve
    // (the file exists), silently reading and anchor-checking a real
    // file outside the repository. Assert the premise first: a runner
    // where this file is absent would otherwise pass this fixture for
    // the wrong reason (nothing to wrongly resolve, not the conjunct
    // correctly rejecting it).
    expect(existsSync("/etc/hosts")).toBe(true);
    expect(resolveLogCitationPath("/etc/hosts").real).toBeUndefined();
    // Round 4 lows, review round 2 finding 1: the containment conjunct
    // is `candidate.startsWith(`${resolvePath(repoRoot)}${sep}`)`, with a
    // trailing `${sep}`. Dropping just that suffix (leaving a bare
    // `startsWith(repoRoot)`) is not caught by `/etc/hosts` above, since
    // that candidate does not even share `repoRoot` as a string prefix.
    // A sibling directory whose name extends `repoRoot`'s own basename
    // (`${repoRoot}-other`) does share the prefix without being inside
    // it, and pins the `${sep}` suffix specifically.
    const siblingDir = `${resolvePath(repoRoot)}-other`;
    const siblingFile = `${siblingDir}/README.md`;
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(siblingFile, "not part of this repository\n");
    try {
      expect(existsSync(siblingFile)).toBe(true);
      expect(resolveLogCitationPath(siblingFile).real).toBeUndefined();
    } finally {
      rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  it("fixture: a bare basename that also exists at the repository root is reported ambiguous, not silently bound to this package's own file", () => {
    // Computed, not assumed: this only pins behaviour for the bare names
    // that really are ambiguous on disk right now, and states the
    // guard's contract for each side.
    expect(
      ROOT_AMBIGUOUS_BARE_NAMES.size,
      "no bare basename in the log-citation map collides with a repository-root file any more; drop this fixture or pick a new example",
    ).toBeGreaterThan(0);
    for (const name of ROOT_AMBIGUOUS_BARE_NAMES) {
      const bare = resolveLogCitationPath(name);
      expect(bare.real, `bare ${name} must not resolve`).toBeUndefined();
      expect(bare.reason).toContain("ambiguous");
      const explicit = EXTRA_LOG_CITATION_TARGETS[name];
      expect(resolveLogCitationPath(explicit).real).toBe(explicit);
    }
  });

  // Round 4 lows, review round 2 finding 2: `PATH_SHAPED_BEFORE_RE` (the
  // module-scope const, shared with the sibling-drift guard above) has
  // two consumers; the sibling guard's own use was already pinned
  // (`.toml`-shaped continuation tails there), but this guard's own
  // `.filter((m) => !PATH_SHAPED_BEFORE_RE.test(...))` line had no fixture
  // of its own, so replacing it with `() => true` still passed every
  // existing test here. `ANCHOR_CITATION_RE`'s extension allowlist
  // (ts|js|mjs|md|yml|yaml|json) never matches `.toml`, so a `.toml`
  // citation's own `:N-M#"..."` tail produces no `fullMatches` entry to
  // overlap against, and would otherwise be misread as a real,
  // path-less continuation.
  it('fixture: a `.toml`-style path\'s own `:N-M#"..."` tail is not reported as a forbidden continuation form', () => {
    const doc = [
      "# Bundle log",
      "",
      '- an entry citing `fake/config.toml:12-18#"some setting"`.',
    ].join("\n");
    const result = checkLogCitations(doc, fixtureResolve, fixtureReadTarget);
    expect(result.continuationForms).toEqual([]);
  });

  // Round 4 (MEDIUM 3), the paired half of the fence throw: a scan that
  // found nothing at all is indistinguishable, from the two assertions
  // below, from a clean log. The live count is computed here, at
  // collection time, and carried in the test's own NAME -- the same
  // `liveLog` object the assertions read, so title and verdict cannot
  // diverge -- rather than hand-written into this file, the CHANGELOG or
  // a log entry, where it would drift on the next edit (D-050; the
  // unanchored-citation brake above uses the same shape). Read the
  // current number off the passing test's own name:
  // `npx vitest run test/docs-consistency.test.ts -t "anchored full
  // citations of docs/okf/log.md"`. The floor keeps headroom below the
  // live count for the same reason the brake's does.
  const liveLog = checkLogCitations(
    readRepoFile("packages/orchestrator-workflow/docs/okf/log.md"),
    resolveLogCitationPath,
    readRepoFile,
  );

  it(`read and checked ${liveLog.fullCitationsChecked} anchored full citations of docs/okf/log.md (sanity: this guard did not go blind on the real file)`, () => {
    expect(liveLog.fullCitationsChecked).toBeGreaterThan(20);
  });

  it("every anchored full citation in docs/okf/log.md resolves at head (path exists, anchor text inside the cited range)", () => {
    expect(
      liveLog.unresolvedFullCitations,
      liveLog.unresolvedFullCitations.join("\n"),
    ).toEqual([]);
    expect(
      liveLog.anchorNotInRange,
      liveLog.anchorNotInRange.join("\n"),
    ).toEqual([]);
  });

  it("docs/okf/log.md carries no anchored, path-less continuation citation form", () => {
    expect(
      liveLog.continuationForms,
      liveLog.continuationForms.join("\n"),
    ).toEqual([]);
  });
});

describe("review-method obligation rows keep their direction word (R2 of the review-method run)", () => {
  it("both rows say the Check list and Rules sit below the table, never above", () => {
    const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
    expect(reviewerMd).toContain("as already required below");
    expect(reviewerMd).not.toContain("as already required above");
  });
});

describe("implementer and reviewer cite coverage gate thresholds, not run-specific percentages", () => {
  const implementerMd = unwrap(readAsset("agents/implementer.md"));
  const reviewerMd = unwrap(readAsset("agents/reviewer.md"));
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  const normalize = (text: string) => text.replace(/\s+/g, " ");

  // Four distinct verbatim sentences, one per location, each with its own
  // lead-in wording so a test targeting one location cannot be satisfied by
  // a different location's paragraph (R2 fix: the shared `rule` fragment
  // used to match the reviewer's wording even when the implementer mirror's
  // own body was gutted).
  const IMPLEMENTER_SENTENCE =
    "Cite a coverage gate's threshold and pass/fail counts, not a run-specific coverage percentage; cite a percentage only together with the exact commit and the run count, since branch coverage can vary between runs of the same commit.";
  const REVIEWER_SENTENCE =
    "When citing a coverage gate, cite the threshold and pass/fail counts, not a run-specific coverage percentage; cite a percentage only together with the exact commit and the run count, since branch coverage can vary between runs of the same commit.";
  const SKILL_IMPLEMENTER_MIRROR =
    "The installed `implementer.md` prompt has the implementer cite a coverage gate's threshold and pass/fail counts, not a run-specific coverage percentage, citing a percentage only together with the exact commit and the run count, since branch coverage can vary between runs of the same commit.";
  const SKILL_REVIEWER_MIRROR =
    "When citing a coverage gate, the installed `reviewer.md` prompt has the reviewer cite the threshold and pass/fail counts, not a run-specific coverage percentage, citing a percentage only together with the exact commit and the run count, since branch coverage can vary between runs of the same commit.";

  it("assets/agents/implementer.md tests-rule bullet carries the coverage-citation sentence", () => {
    expect(normalize(implementerMd)).toContain(normalize(IMPLEMENTER_SENTENCE));
  });

  it("assets/agents/reviewer.md carries its own coverage-citation bullet, scoped separately from the reproduction bullet", () => {
    expect(normalize(reviewerMd)).toContain(normalize(REVIEWER_SENTENCE));
  });

  it("SKILL.md mirrors the coverage-citation rule for the implementer", () => {
    expect(normalize(skillMd)).toContain(normalize(SKILL_IMPLEMENTER_MIRROR));
  });

  it("SKILL.md mirrors the coverage-citation rule for the reviewer", () => {
    expect(normalize(skillMd)).toContain(normalize(SKILL_REVIEWER_MIRROR));
  });
});
