import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ROLES } from "../src/models.js";
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
