import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const agentsMdSection = readAsset("agents-md-section.md");
const skillMd = readAsset("skill/SKILL.md");
const goalTemplate = readAsset("templates/00-goal.md");
const handoffTemplate = readAsset("templates/06-handoff.md");
const implementerMd = readAsset("agents/implementer.md");
const reviewerMd = readAsset("agents/reviewer.md");
const explorerMd = readAsset("agents/explorer.md");
const taskSlicerMd = readAsset("agents/task-slicer.md");
const evidenceAndProbes = readAsset("skill/references/evidence-and-probes.md");
const reviewAndRecovery = readAsset("skill/references/review-and-recovery.md");
const contracts = readAsset("skill/references/contracts.md");
const runStateAndHarness = readAsset(
  "skill/references/run-state-and-harness.md",
);

const unwrap = (text: string) => text.replace(/\s+/g, " ");

// The one definition site for the outward action-class token list.
const CANONICAL_TOKEN_SENTENCE_RE = /outward` marker below are: (.+?)\./;

function parseCanonicalTokens(): string[] {
  const match = unwrap(agentsMdSection).match(CANONICAL_TOKEN_SENTENCE_RE);
  if (!match) {
    throw new Error(
      "canonical action-class token list sentence not found in agents-md-section.md",
    );
  }
  return match[1].split(",").map((token) => token.trim().replace(/^`|`$/g, ""));
}

describe("Outward-facing actions rule ships in the policy block", () => {
  it("agents-md-section has the section heading", () => {
    expect(agentsMdSection).toContain("### Outward-facing actions");
  });

  it("defines an outward action by boundary: any write outside the local checkout and run directory", () => {
    expect(unwrap(agentsMdSection)).toContain(
      "this rule governs what it writes to the outside: any write to a system outside the local checkout and the run directory.",
    );
  });

  it("names ticket creation and editing (title, body, labels, assignees) as boundary examples", () => {
    expect(unwrap(agentsMdSection)).toContain(
      "creating, commenting on, transitioning, editing (title, body, labels, or assignees), or closing a ticket or issue",
    );
  });

  it("names PR edits/approvals, deleting a remote branch, triggering CI or a deployment, and external tracker/API/database writes as boundary examples", () => {
    const flat = unwrap(agentsMdSection);
    expect(flat).toContain(
      "opening, merging, or editing a pull request, including its approvals",
    );
    expect(flat).toContain("deleting a remote branch");
    expect(flat).toContain("triggering CI or a deployment");
    expect(flat).toContain("writing to an external tracker, API, or database");
  });

  it("excludes a subagent's own handback from 'sending a message'", () => {
    expect(unwrap(agentsMdSection)).toContain(
      "sending a message to a person or system outside the run, which does not include a subagent's handback to the agent that spawned it.",
    );
  });

  it("carries the canonical action-class token list, one definition site", () => {
    const tokens = parseCanonicalTokens();
    expect(tokens).toEqual([
      "push-branch",
      "push-tag",
      "open-pr",
      "merge-pr",
      "edit-pr",
      "comment",
      "create-ticket",
      "edit-ticket",
      "transition",
      "close",
      "delete-remote-branch",
      "trigger-ci",
      "deploy",
      "release",
      "publish",
      "message",
    ]);
  });

  it("states the rule is always orchestrator-only, regardless of the marker", () => {
    expect(agentsMdSection).toContain(
      "An outward action is always orchestrator-only, whether or not any class is\n  durably authorized: only the orchestrator ever performs one.",
    );
  });

  it("states a task assignment never authorizes one", () => {
    expect(agentsMdSection).toContain(
      "A task\n  assignment to a subagent never authorizes one, whatever the assignment\n  says; a subagent return that reports an outward action as executed is\n  invalid.",
    );
  });

  it("states the marker only waives the orchestrator's own per-action confirmation, never a subagent's", () => {
    expect(unwrap(agentsMdSection)).toContain(
      "the marker only waives that per-action confirmation for the orchestrator and never authorizes a subagent to perform the action itself.",
    );
  });

  it("states marker provenance: operator instruction only, recorded in 03-decisions.md, subagents never edit it", () => {
    const provenance =
      "A class enters the marker only on the operator's explicit instruction, recorded in `03-decisions.md` with where that instruction came from (the operator's own message); widening an already-authorized marker mid-run needs the same explicit instruction. A subagent never edits the marker, and the orchestrator never adds a class to it on its own judgment.";
    expect(unwrap(agentsMdSection)).toContain(provenance);
  });

  it("states a local worktree commit is not an outward action", () => {
    expect(agentsMdSection).toContain(
      "A local commit on a task branch inside a worktree is not an outward action,\n  in any run mode; only pushing it is.",
    );
  });

  it("states performing an unauthorized outward action is forbidden but reporting one is mandatory", () => {
    expect(unwrap(agentsMdSection)).toContain(
      "Performing an outward action without authorization is forbidden; reporting one that was performed is mandatory. On detecting or receiving such a report, the orchestrator informs the operator immediately, records it in `03-decisions.md`, and lists it in the handoff's Sent / Drafted Outward section as unauthorized.",
    );
  });

  it("requires the orchestrator's per-action operator confirmation as the base rule", () => {
    expect(unwrap(agentsMdSection)).toContain(
      "An outward action needs the orchestrator's operator confirmation per action, unless its class is recorded as durably authorized in `00-goal.md`'s `outward` marker (default `none`)",
    );
  });

  it("states outward text is drafted into the run directory first", () => {
    expect(agentsMdSection).toContain(
      "Outward text (a comment, a PR description) is drafted into the run\n  directory first;",
    );
  });

  it("names pushing a branch or tag among the boundary examples", () => {
    expect(agentsMdSection).toContain("Examples: pushing a branch or tag;");
  });

  it("points to the 00-goal.md outward marker and its default", () => {
    expect(agentsMdSection).toContain(
      "`00-goal.md`'s `outward` marker (default `none`)",
    );
  });

  it("points to the handoff's Sent / Drafted Outward section", () => {
    expect(agentsMdSection).toContain("Sent / Drafted Outward section");
  });
});

describe("Outward-facing actions rule ships in SKILL.md", () => {
  it("has the section heading", () => {
    expect(skillMd).toContain("## Outward-facing actions");
  });

  it("states the rule is always orchestrator-only, whatever a task assignment says", () => {
    expect(unwrap(skillMd)).toContain(
      "is always orchestrator-only, whatever a task assignment says, and a subagent return that reports one as executed is invalid",
    );
  });

  it("states the marker waives only per-action confirmation and never authorizes a subagent", () => {
    expect(unwrap(skillMd)).toContain(
      "which waives only that per-action confirmation and never authorizes a subagent.",
    );
  });

  it("states marker provenance with the same wording as the AGENTS.md block", () => {
    const provenance =
      "A class enters the marker only on the operator's explicit instruction, recorded in `03-decisions.md` with where that instruction came from (the operator's own message); widening an already-authorized marker mid-run needs the same explicit instruction. A subagent never edits the marker, and the orchestrator never adds a class to it on its own judgment.";
    expect(unwrap(skillMd)).toContain(provenance);
    expect(unwrap(agentsMdSection)).toContain(provenance);
  });

  it("states performing an unauthorized outward action is forbidden but reporting one is mandatory", () => {
    expect(unwrap(skillMd)).toContain(
      "performing an outward action without authorization is forbidden but reporting one that was performed is mandatory",
    );
  });

  it("states a local commit is not an outward action", () => {
    expect(unwrap(skillMd)).toContain(
      "local commit on a task branch inside a worktree is not an outward action, in any run mode; only pushing it is.",
    );
  });
});

describe("00-goal.md carries the outward marker, defaulting to none", () => {
  it("has exactly one outward marker line, byte-exact, defaulting to none", () => {
    const matches = [
      ...goalTemplate.matchAll(/<!--\s*outward:\s*classes\s*=\s*(\S+)\s*-->/g),
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
    expect(lines[modeCommentIndex + 1]).toBe(
      "<!-- outward: classes = none -->",
    );
  });

  it("does not reuse the solution-acceptance prefix for the outward marker", () => {
    expect(goalTemplate).not.toContain("solution-acceptance: outward");
  });

  it("states the marker's default is none in its description comment", () => {
    expect(goalTemplate).toContain("Default none.");
  });

  it("records that a class is added only on the operator's explicit instruction", () => {
    expect(unwrap(goalTemplate)).toContain(
      "added only on the operator's explicit instruction and recorded in 03-decisions.md.",
    );
  });

  it("uses only canonical tokens in its example", () => {
    const canonicalTokens = parseCanonicalTokens();
    const exampleMatch = unwrap(goalTemplate).match(
      /for example (push-branch, open-pr)/,
    );
    expect(exampleMatch).not.toBeNull();
    const exampleTokens = (exampleMatch as RegExpMatchArray)[1]
      .split(",")
      .map((t) => t.trim());
    for (const token of exampleTokens) {
      expect(canonicalTokens).toContain(token);
    }
  });
});

describe("run-state-and-harness.md documents the outward marker mechanics", () => {
  it("has the Outward marker subsection, nested inside Run state (not a new top-level section)", () => {
    const runStateIdx = runStateAndHarness.indexOf("## Run state");
    expect(runStateIdx).toBeGreaterThan(-1);
    const nextTopLevelIdx = runStateAndHarness.indexOf(
      "\n## ",
      runStateIdx + "## Run state".length,
    );
    expect(nextTopLevelIdx).toBeGreaterThan(-1);
    const outwardIdx = runStateAndHarness.indexOf("### Outward marker");
    expect(outwardIdx).toBeGreaterThan(runStateIdx);
    expect(outwardIdx).toBeLessThan(nextTopLevelIdx);
  });

  it("carries the marker line and its default", () => {
    expect(runStateAndHarness).toContain("<!-- outward: classes = none -->");
    expect(unwrap(runStateAndHarness)).toContain(
      "means `none`: no class is authorized.",
    );
  });

  it("states the real reason the marker skips the solution-acceptance prefix", () => {
    expect(unwrap(runStateAndHarness)).toContain(
      "the real reason is to keep an authorization grant out of the acceptance-verdict reader's namespace altogether",
    );
  });

  it("uses the kit's plain-record marker shape, like review-round-escalation", () => {
    expect(runStateAndHarness).toContain(
      "The shape matches the kit's other plain-record marker,\n`<!-- review-round-escalation: choice = n/a -->`.",
    );
  });

  it("states an unknown token is ignored on its own while known tokens next to it keep their grant", () => {
    expect(unwrap(runStateAndHarness)).toContain(
      "Inside an otherwise well-formed line, each unrecognised token is individually ignored (treated as not granted) while every recognised token next to it keeps its grant; one bad token never voids the rest of the line.",
    );
  });

  it("states marker provenance with the same wording as the AGENTS.md block", () => {
    const provenance =
      "A class enters the marker only on the operator's explicit instruction, recorded in `03-decisions.md` with where that instruction came from (the operator's own message); widening an already-authorized marker mid-run needs the same explicit instruction. A subagent never edits the marker, and the orchestrator never adds a class to it on its own judgment.";
    expect(unwrap(runStateAndHarness)).toContain(provenance);
  });

  it("uses only canonical tokens in its example", () => {
    const canonicalTokens = parseCanonicalTokens();
    const exampleMatch = unwrap(runStateAndHarness).match(
      /for example `classes = (push-branch, open-pr)`/,
    );
    expect(exampleMatch).not.toBeNull();
    const exampleTokens = (exampleMatch as RegExpMatchArray)[1]
      .split(",")
      .map((t) => t.trim());
    for (const token of exampleTokens) {
      expect(canonicalTokens).toContain(token);
    }
  });
});

describe("implementer contract: outward actions", () => {
  it("states the rule is always orchestrator-only, even when a class is durably authorized", () => {
    expect(unwrap(implementerMd)).toContain(
      "is always orchestrator-only: you never perform one, whatever your task assignment says, even when a class is durably authorized in the run's `00-goal.md` `outward` marker (that marker only waives the orchestrator's own per-action operator confirmation and never authorizes a subagent).",
    );
  });

  it("states a return reporting an executed outward action is invalid", () => {
    expect(implementerMd).toContain(
      "outward action as executed is invalid. A local commit on your task branch",
    );
  });

  it("states a local commit on the task branch is not an outward action", () => {
    expect(implementerMd).toContain(
      "A local commit on your task branch\n  inside your worktree is not an outward action, in any run mode; only\n  pushing it is.",
    );
  });

  it("names pushing a branch or tag among the boundary examples", () => {
    expect(implementerMd).toContain(
      "the run directory: pushing a branch or tag;",
    );
  });

  it("contracts.md also states the invalid-return rule for the implementer", () => {
    expect(contracts).toContain(
      "A return that\nreports an outward action (see AGENTS.md's Outward-facing actions rule) as\nexecuted is invalid, whatever the task assignment said",
    );
  });
});

describe("reviewer contract: outward actions", () => {
  it("states the reviewer never performs an outward action, always orchestrator-only with no exception", () => {
    expect(unwrap(reviewerMd)).toContain(
      "it is always orchestrator-only and operator-confirmed, with no exception for the reviewer.",
    );
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

describe("explorer and task-slicer contracts: never perform an outward action", () => {
  it("explorer.md states it", () => {
    expect(explorerMd).toContain(
      "Never perform an outward action (see AGENTS.md's Outward-facing actions\n  rule; creating a ticket is included)",
    );
  });

  it("task-slicer.md states it", () => {
    expect(taskSlicerMd).toContain(
      "Never perform an outward action (see AGENTS.md's Outward-facing actions\n  rule; creating a ticket is included)",
    );
  });
});

describe("orchestrator mechanical cross-check ships in evidence-and-probes.md", () => {
  it("compares the run-base commit range against the commits field", () => {
    const flat = unwrap(evidenceAndProbes);
    expect(flat).toContain(
      "compare `git rev-list --reverse <run-base>..<task-branch>` (or the host's equivalent) against the returned `commits` field",
    );
  });

  it("checks the remote for the task branch before the orchestrator's own push", () => {
    const flat = unwrap(evidenceAndProbes);
    expect(flat).toContain(
      "check the remote for the task branch before the orchestrator's own push (for example `git ls-remote --heads <remote> <branch>`, or the host's equivalent)",
    );
  });

  it("requires no pull request on the task branch that the orchestrator did not open itself", () => {
    const flat = unwrap(evidenceAndProbes);
    expect(flat).toContain(
      "confirm no pull request exists on the task branch that the orchestrator did not open itself",
    );
  });

  it("treats a mismatch, a branch already on the remote, or an outward-action-executed report as a misfire", () => {
    const flat = unwrap(evidenceAndProbes);
    expect(flat).toContain(
      "A mismatch, a branch already on the remote, or a return that reports an outward action as executed, is a misfire",
    );
  });

  it("routes a detected unauthorized outward action to the operator and 03-decisions.md, not just the misfire rule", () => {
    const flat = unwrap(evidenceAndProbes);
    expect(flat).toContain(
      "When the check finds an outward action was actually performed (a push, an opened pull request) without authorization, that is more than a misfire to resume past: the orchestrator informs the operator immediately, records the incident in `03-decisions.md`, and lists it in `06-handoff.md`'s Sent / Drafted Outward section as unauthorized.",
    );
  });
});

describe("subagent misfire rule covers an outward-action-executed report", () => {
  it("review-and-recovery.md lists it among the misfire examples", () => {
    expect(unwrap(reviewAndRecovery)).toContain(
      "or that reports an outward action (see AGENTS.md's Outward-facing actions rule) as executed, since a task assignment never authorizes one",
    );
  });

  it("review-and-recovery.md still requires reporting a performed outward action, informing the operator immediately", () => {
    expect(unwrap(reviewAndRecovery)).toContain(
      "Performing an outward action is forbidden, but reporting one that was actually performed is still mandatory: recovering the return as a misfire (it is not evidence) does not excuse the orchestrator from also treating the report itself as an incident, informing the operator immediately, recording it in `03-decisions.md`, and listing it in `06-handoff.md`'s Sent / Drafted Outward section as unauthorized.",
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

  it("gives an unauthorized-action option in its row template", () => {
    expect(unwrap(handoffTemplate)).toContain(
      "or an action performed without authorization (unauthorized)",
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
