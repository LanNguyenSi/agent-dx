import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const agentsMdSection = readAsset("agents-md-section.md");
const skillMd = readAsset("skill/SKILL.md");
const goalTemplate = readAsset("templates/00-goal.md");
const handoffTemplate = readAsset("templates/06-handoff.md");
const implementerMd = readAsset("agents/implementer.md");
const reviewerMd = readAsset("agents/reviewer.md");
const evidenceAndProbes = readAsset("skill/references/evidence-and-probes.md");
const reviewAndRecovery = readAsset("skill/references/review-and-recovery.md");
const contracts = readAsset("skill/references/contracts.md");
const runStateAndHarness = readAsset(
  "skill/references/run-state-and-harness.md",
);

const unwrap = (text: string) => text.replace(/\s+/g, " ");

describe("Outward-facing actions rule ships in the policy block", () => {
  it("agents-md-section has the section heading", () => {
    expect(agentsMdSection).toContain("### Outward-facing actions");
  });

  it("states the rule is orchestrator-only", () => {
    expect(agentsMdSection).toContain(
      "An outward action is orchestrator-only.",
    );
  });

  it("states a task assignment never authorizes one", () => {
    expect(agentsMdSection).toContain(
      "An outward action is orchestrator-only. A task assignment to a subagent\n  never authorizes one, whatever the assignment says",
    );
  });

  it("states a local worktree commit is not an outward action", () => {
    expect(agentsMdSection).toContain(
      "A local commit on a task branch inside a worktree is not an outward action,\n  in any run mode; only pushing it is.",
    );
  });

  it("names the action classes once, generically", () => {
    const flat = unwrap(agentsMdSection);
    expect(flat).toContain(
      "pushing a branch or tag, opening or merging a pull request, commenting on, transitioning, or closing a ticket or pull request, releasing or publishing a package, publishing a page or artifact, and sending a message.",
    );
  });

  it("points to the 00-goal.md outward marker and its default", () => {
    expect(agentsMdSection).toContain(
      "`00-goal.md`'s `outward` marker (default `none`)",
    );
  });

  it("points to the handoff's Sent / Drafted Outward section", () => {
    expect(agentsMdSection).toContain(
      "`06-handoff.md`'s Sent / Drafted Outward section",
    );
  });
});

describe("Outward-facing actions rule ships in SKILL.md", () => {
  it("has the section heading", () => {
    expect(skillMd).toContain("## Outward-facing actions");
  });

  it("states the rule is orchestrator-only and operator-confirmed", () => {
    expect(skillMd).toContain(
      "message) is orchestrator-only and needs operator confirmation, unless its",
    );
  });

  it("states a subagent return reporting one as executed is invalid", () => {
    expect(skillMd).toContain(
      "a\nsubagent return that reports one as executed is invalid",
    );
  });
});

describe("00-goal.md carries the outward marker, defaulting to none", () => {
  it("has exactly one outward marker line, byte-exact, defaulting to none", () => {
    const matches = [
      ...goalTemplate.matchAll(/<!--\s*outward:\s*(\S+)\s*-->/g),
    ];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("none");
  });

  it("sits directly below the run mode description comment", () => {
    const lines = goalTemplate.split(/\r?\n/);
    const modeCommentIndex = lines.findIndex((line) =>
      line.includes("Run mode: single | delegated | batch."),
    );
    expect(modeCommentIndex).toBeGreaterThanOrEqual(0);
    expect(lines[modeCommentIndex + 1]).toBe("<!-- outward: none -->");
  });

  it("does not reuse the solution-acceptance prefix for the outward marker", () => {
    expect(goalTemplate).not.toContain("solution-acceptance: outward");
  });
});

describe("run-state-and-harness.md documents the outward marker mechanics", () => {
  it("has the Outward marker subsection, nested inside Run state (not a new top-level section)", () => {
    expect(runStateAndHarness).toContain("### Outward marker");
  });

  it("is the last section of the reference (Run mode still ends the file)", () => {
    const start = runStateAndHarness.indexOf("## Run mode\n");
    expect(start).toBeGreaterThan(-1);
    expect(runStateAndHarness.indexOf("\n## ", start + 3)).toBe(-1);
  });

  it("carries the marker line and its default", () => {
    expect(runStateAndHarness).toContain("<!-- outward: none -->");
    expect(unwrap(runStateAndHarness)).toContain(
      "a missing or unrecognised value means `none`",
    );
  });
});

describe("implementer contract: outward actions", () => {
  it("states a return reporting an executed outward action is invalid", () => {
    expect(implementerMd).toContain(
      "class; your task assignment never authorizes one, whatever it says. A\n  return that reports an outward action as executed is invalid.",
    );
  });

  it("states a local commit on the task branch is not an outward action", () => {
    expect(implementerMd).toContain(
      "A local\n  commit on your task branch inside your worktree is not an outward action,\n  in any run mode; only pushing it is.",
    );
  });

  it("contracts.md also states the invalid-return rule for the implementer", () => {
    expect(contracts).toContain(
      "A return that\nreports an outward action (see AGENTS.md's Outward-facing actions rule) as\nexecuted is invalid, whatever the task assignment said",
    );
  });
});

describe("reviewer contract: outward actions", () => {
  it("states the reviewer never performs an outward action", () => {
    expect(reviewerMd).toContain("Never perform an outward action");
  });

  it("states a return reporting one as executed is invalid", () => {
    expect(reviewerMd).toContain(
      "A return that reports one as executed is invalid.",
    );
  });

  it("contracts.md also states the invalid-return rule for the reviewer", () => {
    expect(contracts).toContain(
      "A return\nthat reports an outward action (see AGENTS.md's Outward-facing actions rule)\nas executed is invalid; the reviewer never performs one.",
    );
  });
});

describe("orchestrator mechanical cross-check ships in evidence-and-probes.md", () => {
  it("names the ahead-count-vs-commits-field check and the no-PR-opened check", () => {
    const flat = unwrap(evidenceAndProbes);
    expect(flat).toContain(
      "compare the branch's ahead count (for example from `git status -sb`) against the returned `commits` field, and confirm no pull request was opened on the task branch by a subagent",
    );
  });

  it("treats a mismatch or an outward-action-executed report as a misfire", () => {
    const flat = unwrap(evidenceAndProbes);
    expect(flat).toContain(
      "A mismatch, or a return that reports an outward action as executed, is a misfire",
    );
  });
});

describe("subagent misfire rule covers an outward-action-executed report", () => {
  it("review-and-recovery.md lists it among the misfire examples", () => {
    expect(unwrap(reviewAndRecovery)).toContain(
      "or that reports an outward action (see AGENTS.md's Outward-facing actions rule) as executed, since a task assignment never authorizes one",
    );
  });
});

describe("06-handoff.md has the Sent / Drafted Outward section", () => {
  it("has the section heading", () => {
    expect(handoffTemplate).toContain("## Sent / Drafted Outward");
  });

  it("documents the omit-when-not-applicable rule", () => {
    expect(handoffTemplate).toContain(
      "Omit this section when nothing was sent or drafted.",
    );
  });

  it("sits between Documentation Impact and Follow-Ups", () => {
    const docImpact = handoffTemplate.indexOf("## Documentation Impact");
    const sentDrafted = handoffTemplate.indexOf("## Sent / Drafted Outward");
    const followUps = handoffTemplate.indexOf("## Follow-Ups");
    expect(docImpact).toBeGreaterThan(-1);
    expect(sentDrafted).toBeGreaterThan(docImpact);
    expect(followUps).toBeGreaterThan(sentDrafted);
  });
});
