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

describe("run-base fill instruction ships in the skill", () => {
  const skillMd = unwrap(readAsset("skill/SKILL.md"));

  it("SKILL.md instructs filling the run-base marker at run creation", () => {
    expect(skillMd).toContain("run-base");
    expect(skillMd).toContain("git rev-parse HEAD");
    expect(skillMd).toContain("before the first implementation commit");
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
