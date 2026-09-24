import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listSkillReferenceNames, readAsset } from "../src/assets.js";

const probes = readAsset("skill/references/evidence-and-probes.md");
const recovery = readAsset("skill/references/review-and-recovery.md");
const reviewer = readAsset("agents/reviewer.md");
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const changelog = readFileSync(`${PACKAGE_DIR}/CHANGELOG.md`, "utf8");
const gateBundleDoc = readFileSync(
  `${PACKAGE_DIR}/docs/okf/review-gate-and-waivers.md`,
  "utf8",
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
  const next = changelog.indexOf("\n- ", start + 1);
  return unwrap(changelog.slice(start, next === -1 ? undefined : next));
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
 * that gap. The rule is defined only in that section; FIX_REGRESSION_TRIGGER binds the sites that restate
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
    expect(
      sectionOf(gateBundleDoc, "## Fix-regression decision point"),
    ).toContain(FIX_REGRESSION_TRIGGER);
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
      "Before another fix round starts, name in one sentence why the fix could introduce the defect (the structural cause, or the statement that there is none)",
    );
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
    expect(pointerLine).not.toContain("introduced_by_delta");
    expect(pointerLine).not.toMatch(/`high` or `critical`/);
  });
});

/**
 * Three ceremony rules, each defined at one site. The constants below are
 * the clauses the CHANGELOG bullet and the bundle doc repeat; asserting one
 * constant against every site keeps the copies from drifting. The claims
 * pinned per rule are the acceptance criterion's claim list for this change.
 */
const BASELINE_REVISION_RULE =
  "Record a baseline revision only when scope or the normative text of a criterion changes, including a change to what its verification checks; a wording precision that leaves the check itself unchanged is a `03-decisions.md` entry, not a revision";
const DOCS_ONLY_DELTA_CONTENT =
  "contains only explanatory documentation, comments, or citations";
const DOCS_ONLY_DELTA_EXCLUSIONS =
  "contains no source- or test-file edits and no semantic change to executable commands, configuration, policy, instructions, or behavior";
const DOCS_ONLY_REVIEW_DEFAULT = `For a review round whose entire delta ${DOCS_ONLY_DELTA_CONTENT} and ${DOCS_ONLY_DELTA_EXCLUSIONS}, default to the \`-medium\` reviewer tier with \`review_method: normal\` where tier variants are installed`;
const DOCS_ONLY_REVIEW_EXCLUSION =
  "A review round that touches an instruction, policy, template or prompt file (for example a SKILL.md instruction) keeps the general default, whatever the file type, and the minimums named above are unaffected";
const PROSE_MUTANTS_DO_NOT_CONVERGE =
  "A prose mutant survives exactly when its bytes sit in no assertion";
const ADEQUACY_ROUND_CAP =
  "Cap test-adequacy review rounds on the change at two.";
const PIN_OBLIGATION =
  "Every normative sentence the change adds or alters at that site is pinned; one left unpinned is named in the criterion with the reason it is not load-bearing";
const ADEQUACY_ROUND_DEFINITION =
  "A test-adequacy review round is one whose returned findings are all `tests` findings of severity `low` or `medium` about pin gaps on the pinned prose; a round returning any other finding is an ordinary round outside the cap";
const ADEQUACY_ROUND_COUNTING =
  "The cap changes neither the Round-2 halt rule, the Review-round escalation budget nor the Fix-regression decision point: a test-adequacy review round still counts as a negative round where it is one";
const REVIEWER_PROSE_SCOPE =
  "When the briefing bounds the prose mutant space to a claim list, respect that bound and put scope notes in `residual_risks`, unless an unlisted sentence is shown to be load-bearing";

describe("baseline revisions and the docs-only review default", () => {
  const workflow = unwrap(probes);
  const closureStart = probes.indexOf("when the entire unreviewed delta");
  const closureEnd = probes.indexOf("This option never", closureStart);
  const docsOnlyClosure = unwrap(probes.slice(closureStart, closureEnd));

  it("limits baseline revisions to scope and criterion text, next to who may revise", () => {
    expect(workflow).toContain(
      `and verified rationale for carrying unchanged evidence forward. ${BASELINE_REVISION_RULE}: the orchestrator records it, states in that entry why no evidence is invalidated, and communicates the corrected wording in the next delegation.`,
    );
  });

  it("names the docs-only default without touching the review minimums", () => {
    expect(workflow).toContain(
      `${DOCS_ONLY_REVIEW_DEFAULT}. This refines the general tier default above for that one class only: there \`-medium\` is the default and a higher tier is the non-default choice recorded with a one-line reason. ${DOCS_ONLY_REVIEW_EXCLUSION}.`,
    );
    expect(workflow).toContain(
      "defaulting to the unsuffixed subagent when unsure; record a non-default tier choice with a one-line reason in `03-decisions.md` when the task is non-trivial",
    );
    expect(workflow).toContain(
      "the orchestrator may close a docs-only delta without another reviewer round only when the entire unreviewed delta",
    );
    expect(docsOnlyClosure).toContain(
      `the entire unreviewed delta ${DOCS_ONLY_DELTA_CONTENT}`,
    );
    expect(docsOnlyClosure).toContain(DOCS_ONLY_DELTA_EXCLUSIONS);
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
      `List the load-bearing claims of the normative site in the acceptance criterion, and pin each one as the whole sentence or clause that carries it. That list is the pin obligation. ${PIN_OBLIGATION}.`,
    );
  });

  it("bounds the reviewer's mutant space and binds copies by a constant", () => {
    expect(section).toContain(
      "Bound the reviewer's prose mutant space to that list in the briefing. A survivor outside the list is a scope note in the reviewer's `residual_risks`, not a finding, unless the reviewer shows that the unlisted sentence is load-bearing.",
    );
    expect(section).toContain(
      "Bind each copy to the normative site through one shared test constant, and let a pointer point without restating the rule.",
    );
  });

  it("caps adequacy rounds, exempts semantic findings and leaves the gate alone", () => {
    expect(section).toContain(
      `${ADEQUACY_ROUND_CAP} ${ADEQUACY_ROUND_DEFINITION}. Pin gaps that remain become accepted notes or a follow-up.`,
    );
    expect(section).toContain(
      "Semantic findings are exempt from the bound and from the cap: two sites stating different rules, a contradiction with another rule, and a false claim are defects at whatever severity they deserve.",
    );
    expect(section).toContain(`${ADEQUACY_ROUND_COUNTING}.`);
    expect(section).toContain(
      "The review gate is unchanged: a high or critical finding of any category still blocks and is never capped away, and accepting one follows the waiver rules.",
    );
    expect(section).toContain(
      "Anchored by an observed run; see the entry for this rule in the orchestrator-workflow CHANGELOG.",
    );
  });

  it("makes the briefing's prose scope binding explicit for reviewers", () => {
    expect(unwrap(reviewer)).toContain(`${REVIEWER_PROSE_SCOPE}.`);
  });
});

// The CHANGELOG's 0.37.0 section is a released entry: it stays as shipped
// and is not re-checked against later wording precisions (0.39.0 restated
// this rule's condition without repeating it verbatim). The live copy this
// suite pins against the reference is the bundle doc's own section below.
describe("ceremony rule copies stay bound to their normative sites", () => {
  const constants = [
    BASELINE_REVISION_RULE,
    DOCS_ONLY_REVIEW_DEFAULT,
    DOCS_ONLY_REVIEW_EXCLUSION,
    PROSE_MUTANTS_DO_NOT_CONVERGE,
    ADEQUACY_ROUND_CAP,
    PIN_OBLIGATION,
    ADEQUACY_ROUND_DEFINITION,
    ADEQUACY_ROUND_COUNTING,
    REVIEWER_PROSE_SCOPE,
  ];

  it("the bundle doc's own section repeats each rule in the reference's own words", () => {
    const bundleSection = sectionOf(
      gateBundleDoc,
      "## Ceremony rules: baseline revisions, docs-only review default, pinned prose",
    );
    for (const constant of constants) expect(bundleSection).toContain(constant);
  });
});

/**
 * What the two verdict fields of a mutation probe mean, where their values
 * come from, and who checks them. The implementer prompt is the normative
 * site for the field semantics; contracts.md copies them for the
 * orchestrator. Step 6 is the normative site for the transfer rules. The
 * init tests render every implementer tier and the Codex definition, so the
 * legend cannot be lost between the asset and a generated prompt.
 */
const PROBE_FIELD_LEGEND =
  "`result: killed` means the probe's test command reacted to the mutant under the runner's pass predicate, or the test pass predicate declared in the task assignment or probe plan when no runner supplies a verdict; `survived` means it did not. `expectation: met` means the measured result matches the expected result declared in the task assignment or probe plan, and `violated` means it does not; both fields are `not_applicable` when no result was measured.";
const PROBE_FIELD_COPY_RULE =
  "When a mutation-probe runner is available, run the named probes through it and copy every supplied `result` and `expectation` verbatim into `mutation_probes`, never substituting your interpretation of its test output.";
const PROBE_RESULT_ONLY_RULE =
  "Quote each supplied verdict in `tests.executed`; when it supplies only `result`, derive `expectation` from the expected result declared in the task assignment or probe plan, and identify that declaration and derivation there.";
const PROBE_ABSENCE_RULE =
  "When no machine-readable verdict is available, state that explicitly in `tests.executed`, identify the declared test pass predicate and expected result, and quote the observed baseline and mutant outcomes.";
const PROBE_MANUAL_RULE =
  "Derive `result` from those observations only when the baseline passed, mutant application was verified, and the mutant test completed under the same command and predicate; derive `expectation` by comparing that result with the declared expected result, and label both derivations as manual.";
const PROBE_ROW_COMPARISON =
  "Before transferring a probe row, compare each copied field with the quoted verdict and each derived field with its stated declaration and evidence. An explicit absence of a machine-readable verdict requires the manual comparison, not resupply of a nonexistent verdict.";
const PROBE_RESUPPLY_RULE =
  "On a mismatch or missing required evidence, obtain corrected evidence from the implementer or rerun the probe in isolation, record the action in `03-decisions.md`, and keep the row blocked from transfer until the comparison succeeds; if the evidence cannot be obtained, record the unresolved proof rather than repeatedly requesting an unavailable verdict. Never invent a verdict, override a supplied field, or fill an unsupported derivation.";
const PROBE_OWN_ROWS_RULE =
  "Apply the same evidence reporting and comparison to probes you run yourself before recording their rows in `04-implementation-summary.md`.";
const PROBE_REVIEWER_RULE =
  "For probes you run, apply the implementer's verdict-copy and manual-derivation rules to your own measurements, reporting the quoted verdict or explicit verdict absence and derivation evidence in `reproduction` and carrying the same reported values into any associated finding.";
const PROBE_SET_SCOPE_RULE =
  "A quoted probe verdict is not a named result of the verification set, so the set's missing-or-extra rule does not apply to it.";
const PROBE_SINGLE_REPLAY_RULE =
  "It reports per probe, in `reproduction`, the probe, the replayed verdict or explicit verdict absence with manual derivation evidence, and whether the measured `result` and `expectation` match the recorded fields; a mismatch is a finding of at least `high` and sets `matches_implementer_claim: mismatched`.";
const PROBE_VERDICT_BULLET =
  "- Mutation-probe verdict reporting now distinguishes";

describe("mutation probe verdict fields", () => {
  const implementerPrompt = unwrap(readAsset("agents/implementer.md"));
  const contracts = unwrap(readAsset("skill/references/contracts.md"));

  const implementerRules = [
    PROBE_FIELD_LEGEND,
    PROBE_FIELD_COPY_RULE,
    PROBE_RESULT_ONLY_RULE,
    PROBE_ABSENCE_RULE,
    PROBE_MANUAL_RULE,
  ];
  const workflowRules = [
    PROBE_ROW_COMPARISON,
    PROBE_RESUPPLY_RULE,
    PROBE_OWN_ROWS_RULE,
    PROBE_SET_SCOPE_RULE,
    PROBE_SINGLE_REPLAY_RULE,
  ];
  const allRules = [...implementerRules, ...workflowRules, PROBE_REVIEWER_RULE];

  it("pins every implementer rule at its normative site and contracts copy", () => {
    for (const rule of implementerRules) {
      expect(implementerPrompt).toContain(rule);
      expect(contracts).toContain(rule);
    }
  });

  it("pins every workflow rule at its workflow step and verification-set copy", () => {
    const step6 = unwrap(
      probes.slice(
        probes.indexOf("6. **Delegate implementation.**"),
        probes.indexOf("7. **Delegate review.**"),
      ),
    );
    const step7 = unwrap(
      probes.slice(
        probes.indexOf("7. **Delegate review.**"),
        probes.indexOf("8. **Decide acceptance.**"),
      ),
    );
    for (const rule of workflowRules.filter(
      (rule) => rule !== PROBE_SINGLE_REPLAY_RULE,
    )) {
      expect(step6).toContain(rule);
    }
    expect(step7).toContain(PROBE_SINGLE_REPLAY_RULE);
    expect(sectionOf(probes, "## Verification sets")).toContain(
      PROBE_SET_SCOPE_RULE,
    );
  });

  it("pins the reviewer rule at its normative site", () => {
    expect(unwrap(reviewer)).toContain(PROBE_REVIEWER_RULE);
    expect(unwrap(reviewer)).toContain(PROBE_SINGLE_REPLAY_RULE);
  });

  it.each([
    {
      name: "both supplied fields",
      producer: [PROBE_FIELD_COPY_RULE, PROBE_RESULT_ONLY_RULE],
    },
    {
      name: "result only",
      producer: [PROBE_FIELD_COPY_RULE, PROBE_RESULT_ONLY_RULE],
    },
    { name: "no verdict", producer: [PROBE_ABSENCE_RULE, PROBE_MANUAL_RULE] },
  ])(
    "pins producer evidence and transfer decisions for $name",
    ({ producer }) => {
      for (const rule of producer) expect(implementerPrompt).toContain(rule);
      expect(unwrap(probes)).toContain(PROBE_ROW_COMPARISON);
      expect(unwrap(probes)).toContain(PROBE_RESUPPLY_RULE);
    },
  );

  it("names no concrete probe tool", () => {
    for (const text of [implementerPrompt, contracts, unwrap(probes)])
      expect(text).not.toContain("agent-primitives");
  });

  it("binds the CHANGELOG bullet and the bundle doc to the same words", () => {
    const bullet = changelogBullet(PROBE_VERDICT_BULLET);
    const bundleSection = sectionOf(
      readFileSync(
        `${PACKAGE_DIR}/docs/okf/subagent-contracts-superset.md`,
        "utf8",
      ),
      "## Probe verdict fields: legend, copy rule, cross-check",
    );
    for (const constant of allRules) {
      expect(bullet).toContain(constant);
      expect(bundleSection).toContain(constant);
    }
  });
});
