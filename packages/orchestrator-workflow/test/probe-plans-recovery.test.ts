import { describe, expect, it } from "vitest";

import { listSkillReferenceNames, readAsset } from "../src/assets.js";

const probes = readAsset("skill/references/evidence-and-probes.md");
const recovery = readAsset("skill/references/review-and-recovery.md");
const unwrap = (text: string) => text.replace(/\s+/g, " ");

describe("persisted probe plans and recovery references", () => {
  it("routes every packaged reference from the compact entrypoint", () => {
    const core = readAsset("skill/SKILL.md");
    const routed = [...core.matchAll(/\]\(references\/([^\s)]+\.md)\)/g)].map(
      (match) => match[1],
    );
    expect(routed.length).toBeGreaterThan(0);
    expect([...new Set(routed)].sort()).toEqual(listSkillReferenceNames());
    for (const name of routed)
      expect(readAsset(`skill/references/${name}`).trim()).not.toBe("");
  });

  it("keeps plans optional and runner-neutral while requiring immutable bindings", () => {
    expect(unwrap(probes)).toContain(
      "optional, runner-supported executable artifact",
    );
    expect(unwrap(probes)).toContain("path plus immutable revision or hash");
    expect(unwrap(probes)).toContain("A plan alone is never evidence");
    expect(unwrap(probes)).toContain("Missing, stale, or unresolvable");
    expect(unwrap(probes)).toContain("Never silently rewrite an existing plan");
    expect(unwrap(probes)).toContain("intentional supersession");
    expect(probes).not.toContain("agent-primitives");
  });

  it("routes incomplete work through a persisted cursor without widening authority", () => {
    expect(unwrap(recovery)).toContain(
      "recovery cursor in the existing run state",
    );
    expect(unwrap(recovery)).toContain(
      "failed step, evidence owner, next action",
    );
    expect(unwrap(recovery)).toContain(
      "restore the applicable state before rerunning",
    );
    expect(recovery).toContain(
      "Only the operator may authorize a critical waiver",
    );
    expect(recovery).toContain(
      "Do not broaden this into a halt on any repeated finding",
    );
    expect(unwrap(recovery)).toContain(
      "Do not require probes for all findings",
    );
  });
});

/**
 * The Round-2 halt rule needs a defect class to recur before it stops a
 * task. A fix that introduces a new high finding of a class not seen before
 * passed under it for one more round. This pins the decision point that
 * closes that gap: its three qualifiers, the recorded outcomes, and the
 * boundaries that keep it from becoming a second halt rule or a budget
 * counter.
 */
describe("fix-regression decision point", () => {
  const section = unwrap(
    recovery.slice(
      recovery.indexOf("## Fix-regression decision point"),
      recovery.indexOf("## Final acceptance rule"),
    ),
  );

  it("sits between the escalation budget and the final acceptance rule", () => {
    const budget = recovery.indexOf("## Review-round escalation budget");
    const point = recovery.indexOf("## Fix-regression decision point");
    const final = recovery.indexOf("## Final acceptance rule");
    expect(budget).toBeGreaterThan(-1);
    expect(point).toBeGreaterThan(budget);
    expect(final).toBeGreaterThan(point);
  });

  it("states the qualifiers of the signal", () => {
    expect(section).toContain(
      "the review of a fix round (any implementation round after the task's first)",
    );
    expect(section).toContain(
      "at least one `high` or `critical` finding that the previous round's review did not report, with `introduced_by_delta: yes`",
    );
    expect(section).toContain(
      "`unknown` and `no` do not trigger this decision point",
    );
    expect(section).toContain("The signal needs no recurrence");
  });

  it("evaluates the qualifier on the findings, not on the recurrence field", () => {
    expect(section).toContain(
      "Read the qualifier off the findings of the two reviews, not off `recurrence`: a `recurrence: repeated` finding that the previous round's review did not report still triggers it.",
    );
  });

  it("leaves `unknown` to the halt rule and the budget, which both act on it", () => {
    expect(section).toContain(
      "`no` continues through the ordinary finding gate, and `unknown` keeps its existing treatment under the Round-2 halt rule and the escalation budget",
    );
    expect(section).not.toContain("they follow the ordinary finding gate");
    const whole = unwrap(recovery);
    expect(whole).toContain(
      "Apply this signal only to `introduced_by_delta: yes`/`unknown`",
    );
    expect(whole).toContain(
      "A negative round counts only with at least one introduced_by_delta yes/unknown finding",
    );
  });

  it("requires a recorded decision with four outcomes before another fix round", () => {
    expect(section).toContain("Before another fix round starts");
    expect(section).toContain(
      "record one of four outcomes as a decision in `03-decisions.md`: continue with the stated reason, redesign, split, or hold",
    );
    expect(section).toContain(
      "Spawning the advisor for this decision is optional",
    );
  });

  it("stays a decision point: no halt signal, no budget count, no review shortcut", () => {
    expect(section).toContain("This is a decision point, not a halt");
    expect(section).toContain("it is not a round-2 halt signal");
    expect(section).toContain(
      "it does not count toward the Review-round escalation budget (the negative round itself still counts there as before)",
    );
    expect(section).toContain("It never replaces a review round");
    expect(section).toContain(
      "When the same review also fires the Round-2 halt signal, the halt rule governs",
    );
  });

  it("states its evidence strength as an observed run and points to the CHANGELOG", () => {
    expect(section).toContain(
      "Anchored by an observed run; see the entry for this rule in the orchestrator-workflow CHANGELOG.",
    );
  });

  it("is reachable from the acceptance step, which points without restating the trigger", () => {
    expect(unwrap(probes)).toContain(
      "When a fix round's review meets the trigger of the Fix-regression decision point (defined only in [review and recovery](review-and-recovery.md), not restated here), record the Fix-regression decision point before another fix round starts.",
    );
    const pointerLine = probes
      .split("\n")
      .find((line) => line.includes("Fix-regression decision point"));
    expect(pointerLine).toBeDefined();
    expect(pointerLine).not.toContain("introduced_by_delta: yes`, record");
  });
});
