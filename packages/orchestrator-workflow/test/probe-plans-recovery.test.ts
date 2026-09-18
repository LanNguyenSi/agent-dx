import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listSkillReferenceNames, readAsset } from "../src/assets.js";

const probes = readAsset("skill/references/evidence-and-probes.md");
const recovery = readAsset("skill/references/review-and-recovery.md");
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const changelog = readFileSync(`${PACKAGE_DIR}/CHANGELOG.md`, "utf8");
const gateBundleDoc = unwrap(
  readFileSync(`${PACKAGE_DIR}/docs/okf/review-gate-and-waivers.md`, "utf8"),
);

/** One `## ` section of a reference, heading included, up to the next one. */
function sectionOf(source: string, heading: string): string {
  const start = source.indexOf(`${heading}\n`);
  expect(start, `${heading} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\n## ", start + heading.length);
  return unwrap(source.slice(start, next === -1 ? undefined : next));
}

/** One top-level CHANGELOG bullet, so a neighbouring bullet cannot satisfy a pin. */
function changelogBullet(opening: string): string {
  const start = changelog.indexOf(opening);
  expect(start, `CHANGELOG bullet not found: ${opening}`).toBeGreaterThan(-1);
  return unwrap(changelog.slice(start, changelog.indexOf("\n- ", start + 1)));
}

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
 * task, so a fix that breaks something of a class not seen before passed
 * under it for one more round. This pins the decision point that closes
 * that gap. The section in review-and-recovery.md is the rule's only
 * normative statement; FIX_REGRESSION_TRIGGER binds the sites that restate
 * its trigger to the section's own words, and step 8 must not restate it.
 */
const FIX_REGRESSION_TRIGGER =
  "at least one `high` or `critical` finding that the previous round's review did not report, with `introduced_by_delta: yes`";

describe("fix-regression decision point", () => {
  const section = sectionOf(recovery, "## Fix-regression decision point");

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
    expect(section).toContain(FIX_REGRESSION_TRIGGER);
    expect(section).toContain(
      "`unknown` and `no` do not trigger this decision point",
    );
    expect(section).toContain(
      "The signal needs no recurrence: it fires even when the new finding's defect class has not appeared on this task before, which is what separates it from the Round-2 halt rule above.",
    );
  });

  it("binds the sites that restate the trigger to the section's own words", () => {
    expect(
      changelogBullet(
        '- `references/review-and-recovery.md` gains a "Fix-regression decision',
      ),
    ).toContain(FIX_REGRESSION_TRIGGER);
    expect(gateBundleDoc).toContain(FIX_REGRESSION_TRIGGER);
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

/**
 * Three ceremony rules, each defined at one site. The constants below are
 * the clauses the CHANGELOG bullet and the bundle doc repeat; asserting one
 * constant against every site keeps the copies from drifting. The claims
 * pinned per rule are the acceptance criterion's claim list for this change.
 */
const BASELINE_REVISION_RULE =
  "Record a baseline revision only when scope or the normative text of a criterion changes, including a change to what its verification checks; a wording precision that leaves the check itself unchanged is a `03-decisions.md` entry, not a revision.";
const DOCS_ONLY_REVIEW_DEFAULT =
  "For a review round whose entire delta is documentation, default to the `-medium` reviewer tier with `review_method: normal` where tier variants are installed";
const PROSE_MUTANTS_DO_NOT_CONVERGE =
  "A prose mutant survives exactly when its bytes sit in no assertion";
const ADEQUACY_ROUND_CAP =
  "Cap test-adequacy review rounds on the change at two.";
const CEREMONY_BULLET =
  "- Three ceremony rules in the skill references, none of which changes the";

describe("baseline revisions and the docs-only review default", () => {
  const workflow = unwrap(probes);

  it("limits baseline revisions to scope and criterion text, next to who may revise", () => {
    expect(workflow).toContain(
      `and verified rationale for carrying unchanged evidence forward. ${BASELINE_REVISION_RULE}`,
    );
  });

  it("names the docs-only default without touching the review minimums", () => {
    expect(workflow).toContain(
      `${DOCS_ONLY_REVIEW_DEFAULT}; going higher is the orchestrator's call with a recorded reason, and the minimums named above are unaffected.`,
    );
    expect(workflow).toContain(
      "do not pair `adversarial` with the `-medium` reviewer tier",
    );
    expect(workflow).toContain(
      "`adversarial` at minimum for security judgment, install/deploy scripts, hand-edited lockfiles, cross-major overrides, or anything the operator flags high-risk",
    );
  });

  it("points step 7 to the pinned-prose section without restating it", () => {
    expect(workflow).toContain(
      "For a change whose acceptance rests on tests that pin documentation wording, write the briefing as the Pinned-prose changes section of [review and recovery](review-and-recovery.md) requires.",
    );
    expect(workflow).not.toContain(PROSE_MUTANTS_DO_NOT_CONVERGE);
    expect(workflow).not.toContain("test-adequacy review rounds");
  });
});

describe("pinned-prose changes", () => {
  const section = sectionOf(recovery, "## Pinned-prose changes");

  it("sits after the decision point and before the final acceptance rule", () => {
    const point = recovery.indexOf("## Fix-regression decision point");
    const prose = recovery.indexOf("## Pinned-prose changes");
    expect(prose).toBeGreaterThan(point);
    expect(recovery.indexOf("## Final acceptance rule")).toBeGreaterThan(prose);
  });

  it("states its scope and why such review rounds do not converge", () => {
    expect(section).toContain(
      "This applies to a change whose acceptance rests on tests that pin documentation wording (a rule text asserted by string match).",
    );
    expect(section).toContain(
      `${PROSE_MUTANTS_DO_NOT_CONVERGE}, so a surviving mutant alone says nothing about quality, and review rounds that hunt for the next unpinned sentence do not converge.`,
    );
  });

  it("makes the criterion's claim list the pin obligation, at one normative site", () => {
    expect(section).toContain(
      "Name one normative site per rule when slicing; every other site that states the rule is a copy.",
    );
    expect(section).toContain(
      "List the load-bearing claims of the normative site in the acceptance criterion, and pin each one as the whole sentence or clause that carries it. That list is the pin obligation.",
    );
  });

  it("bounds the reviewer's mutant space and binds copies by a constant", () => {
    expect(section).toContain(
      "Bound the reviewer's prose mutant space to that list in the briefing. A survivor outside the list is a scope note, not a finding, unless the reviewer shows that the unlisted sentence is load-bearing.",
    );
    expect(section).toContain(
      "Bind each copy to the normative site through one shared test constant, and let a pointer point without restating the rule.",
    );
  });

  it("caps adequacy rounds, exempts semantic findings and leaves the gate alone", () => {
    expect(section).toContain(
      `${ADEQUACY_ROUND_CAP} Pin gaps that remain become accepted notes or a follow-up.`,
    );
    expect(section).toContain(
      "Semantic findings are exempt from the bound and from the cap: two sites stating different rules, a contradiction with another rule, and a false claim are defects at whatever severity they deserve.",
    );
    expect(section).toContain(
      "The review gate is unchanged: a high or critical finding still blocks.",
    );
    expect(section).toContain(
      "Anchored by an observed run; see the entry for this rule in the orchestrator-workflow CHANGELOG.",
    );
  });
});

describe("ceremony rule copies stay bound to their normative sites", () => {
  const constants = [
    BASELINE_REVISION_RULE,
    DOCS_ONLY_REVIEW_DEFAULT,
    PROSE_MUTANTS_DO_NOT_CONVERGE,
    ADEQUACY_ROUND_CAP,
  ];

  it("the CHANGELOG bullet repeats each rule in the reference's own words", () => {
    const bullet = changelogBullet(CEREMONY_BULLET);
    for (const constant of constants) expect(bullet).toContain(constant);
  });

  it("the bundle doc repeats each rule in the reference's own words", () => {
    for (const constant of constants) expect(gateBundleDoc).toContain(constant);
  });
});
