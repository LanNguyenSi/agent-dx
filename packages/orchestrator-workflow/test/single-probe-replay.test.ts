import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import { composeCodexAgent } from "../src/codex.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_TIER, ROLE_TIERS } from "../src/models.js";
import {
  HAND_APPLIED_MUTANT_IS_A_FINDING,
  IN_PLACE_AUTHORIZATION_CLAUSE,
  IN_PLACE_RESTORED_VERIFIED_CLAUSE,
  NAMED_PROBE_FORMS,
  RUNNER_ONLY_PROBE_RULE,
  SINGLE_MODE_NOT_APPLICABLE_CLAUSE,
  SINGLE_REPLAY_RULE,
} from "./run-mode-constants.js";

const unwrap = (text: string) => text.replace(/\s+/g, " ");
const probes = unwrap(readAsset("skill/references/evidence-and-probes.md"));
const contracts = unwrap(readAsset("skill/references/contracts.md"));
const reviewerRaw = readAsset("agents/reviewer.md");
const reviewer = unwrap(reviewerRaw);

const BEFORE_THE_RULE = "The reviewer output contract itself is unchanged.";
const REVIEWER_DUTY =
  "When the briefing names run mode `single`, the orchestrator implemented the change itself and nobody has cross-checked its probe evidence: replay every named orchestrator probe, where named means the briefing gives its full definition or a resolved immutable plan-and-result reference";

/**
 * In a delegated run the orchestrator cross-checks the implementer's probe
 * evidence. In run mode `single` author and checker would be the same party,
 * so the reviewer replays the orchestrator's probes. One normative statement
 * (step 7 of the detailed workflow), two sites bound to its wording.
 */
describe("single-mode probe replay", () => {
  const step7 = probes.slice(
    probes.indexOf("7. **Delegate review.**"),
    probes.indexOf("8. **Decide acceptance.**"),
  );

  it("step 7 states the duty right after the skip permission paragraph and excludes that permission", () => {
    expect(step7).toContain(
      `${BEFORE_THE_RULE} In run mode \`single\` that skip permission does not apply:`,
    );
    expect(step7).toContain(`the reviewer must ${SINGLE_REPLAY_RULE},`);
  });

  it("step 7 defines a named probe once and every other clause speaks of named probes only", () => {
    expect(step7).toContain(
      `A probe counts as named when the briefing gives ${NAMED_PROBE_FORMS}; an id alone does not name a probe.`,
    );
    expect(step7.split(NAMED_PROBE_FORMS)).toHaveLength(2);
    const rule = step7.slice(step7.indexOf("In run mode `single`"));
    expect(rule).not.toContain("by definition");
    expect(rule).not.toContain("by that reference");
  });

  it("step 7 names the orchestrator's side, the report, the mismatch consequences and the missing-evidence cases", () => {
    expect(step7).toContain(
      "The orchestrator records every probe it ran in one of those two forms in `04-implementation-summary.md` before requesting review",
    );
    expect(step7).toContain(
      "the reviewer briefing states the run mode and names each of those probes",
    );
    expect(step7).toContain("never in the reviewed tree");
    expect(step7).toContain(
      "It reports per probe, in `reproduction`, the probe, the replayed verdict or explicit verdict absence with manual derivation evidence, and whether the measured `result` and `expectation` match the recorded fields; a mismatch is a finding of at least `high` and sets `matches_implementer_claim: mismatched`.",
    );
    expect(step7).toContain(
      "A probe given only by id is `not_applicable` and counts as missing evidence, not as a pass, and so does a `single` briefing that names no probe at all.",
    );
  });

  // Issue #339: the bounded in-place exception's own conditions
  // (authorization, restored_verified, clean tree, exclusive access) and
  // the run mode `single` duty's not_applicable fallback are common wording
  // between the reviewer prompt and step 7's mirror of it; pin both spans
  // against the same constants so a weakening edit to either site is caught.
  // Issue #339: a write a declared check or the probe runner's own
  // isolation leaves behind, wherever that tool places it, is expected, not
  // a location violation. Closes the gap where the write-boundary bullet's
  // literal "one exception" reading would forbid build/test artifacts a
  // declared check produces as a side effect.
  it("the write-boundary bullet states that a write a directed tool makes is expected wherever that tool places it", () => {
    expect(reviewer).toContain(
      "A write made by a tool these rules direct you to run, a declared check (including build or test artifacts a side effect leaves in the reviewed tree) or the probe runner operating in its own default isolation, is expected wherever that tool places it, not a location violation.",
    );
  });

  it("step 7 and the reviewer prompt carry the same in-place exception conditions and single-mode not_applicable fallback", () => {
    expect(step7).toContain(IN_PLACE_AUTHORIZATION_CLAUSE);
    expect(step7).toContain(IN_PLACE_RESTORED_VERIFIED_CLAUSE);
    expect(step7).toContain(SINGLE_MODE_NOT_APPLICABLE_CLAUSE);
    expect(reviewer).toContain(IN_PLACE_AUTHORIZATION_CLAUSE);
    expect(reviewer).toContain(IN_PLACE_RESTORED_VERIFIED_CLAUSE);
    expect(reviewer).toContain(SINGLE_MODE_NOT_APPLICABLE_CLAUSE);
    expect(reviewer).toContain(HAND_APPLIED_MUTANT_IS_A_FINDING);
  });

  it("the rule is stated once: only step 7 carries its opening sentence", () => {
    const opening = "that skip permission does not apply";
    expect(probes.split(opening)).toHaveLength(2);
    expect(contracts).not.toContain(opening);
    expect(reviewer).not.toContain(opening);
  });

  it("contracts.md points to the rule and adds no output field", () => {
    expect(contracts).toContain(
      `In run mode \`single\`, \`reproduction\` also carries the result of the reviewer's duty to ${SINGLE_REPLAY_RULE}; step 7 of the detailed workflow states the rule, and no output field is added for it.`,
    );
  });

  it("the reviewer prompt carries the duty, bound to the rule's wording, and keeps it inert without the mode line", () => {
    expect(REVIEWER_DUTY).toContain(SINGLE_REPLAY_RULE);
    expect(REVIEWER_DUTY).toContain(NAMED_PROBE_FORMS);
    expect(reviewer).toContain(REVIEWER_DUTY);
    expect(reviewer).toContain(
      "Do not skip a named probe in that mode, under any `review_method`; a probe that cannot run through the runner is reported `not_applicable`, not skipped; any mismatch also sets `matches_implementer_claim: mismatched`.",
    );
    expect(reviewer).toContain(
      "A mismatch is a finding of at least `high`; a probe given only by id is `not_applicable` and is missing evidence, not a pass, and so is a briefing in that mode that names no probe.",
    );
    expect(reviewer).toContain(
      "Without that mode line in the briefing this obligation does not exist.",
    );
  });

  it("the prompt's duty span defines named once and enumerates no naming form outside that definition", () => {
    // Mirror of the step 7 pin: the prompt is the copy a reviewer reads
    // without the skill, so a clause that re-enumerates the forms there
    // would bring back the asymmetry between the two sites.
    const duty = reviewer.slice(
      reviewer.indexOf("When the briefing names run mode `single`"),
      reviewer.indexOf("Return exactly this structure"),
    );
    expect(duty.length).toBeGreaterThan(0);
    expect(duty.split(NAMED_PROBE_FORMS)).toHaveLength(2);
    expect(duty).not.toContain("by definition");
    expect(duty).not.toContain("by that reference");
    expect(duty).not.toContain("may be skipped");
  });

  it("the `normal` method row counts the replay among the obligations that apply under every method", () => {
    expect(reviewer).toContain(
      "the empirical-reproduction rule, the GitHub Actions shell replay rule, and the probe replay of a run mode `single` briefing apply under every method.",
    );
  });

  it("the orchestrator-side clause agrees with the persisted probe plan provision", () => {
    expect(probes).toContain(
      "Assignments and summaries may point to it and a result artifact instead of resending a definition",
    );
    expect(step7).toContain(NAMED_PROBE_FORMS);
  });

  it("the duty sits above the output block and no mode value leaks into that block", () => {
    const duty = reviewerRaw.indexOf("When the briefing names run mode");
    const output = reviewerRaw.indexOf("Return exactly this structure");
    expect(duty).toBeGreaterThan(-1);
    expect(duty).toBeLessThan(output);
    expect(reviewerRaw.slice(output)).not.toContain("single");
  });

  it("every rendered reviewer variant of every harness carries the duty", () => {
    const codexBodies = [
      parse(
        composeCodexAgent("reviewer", { model: "gpt-6-astra", effort: "high" }),
      ).developer_instructions,
      ...ROLE_TIERS.reviewer.map(
        (tier) =>
          parse(
            composeCodexAgent(
              "reviewer",
              { model: "gpt-6-astra", effort: tier },
              tier,
            ),
          ).developer_instructions,
      ),
    ];
    for (const body of codexBodies) {
      expect(unwrap(String(body))).toContain(REVIEWER_DUTY);
    }

    const target = mkdtempSync(join(tmpdir(), "ow-single-replay-"));
    try {
      runInit({
        targetDir: target,
        harnesses: ["claude", "opencode"],
        models: { ...DEFAULT_MODELS },
        opencodeModels: { reviewer: "anthropic/claude-opus-4-8" },
        opencodeClassModels: {
          small: "anthropic/claude-haiku-4-5",
          medium: "anthropic/claude-sonnet-4-6",
          large: "anthropic/claude-opus-4-8",
        },
        tiers: true,
      });
      for (const harness of [".claude", ".opencode"]) {
        for (const tier of ROLE_TIERS.reviewer) {
          const suffix = tier === DEFAULT_TIER.reviewer ? "" : `-${tier}`;
          const rendered = unwrap(
            readFileSync(
              join(target, harness, "agents", `reviewer${suffix}.md`),
              "utf8",
            ),
          );
          expect(rendered, `${harness}/reviewer${suffix}.md`).toContain(
            REVIEWER_DUTY,
          );
        }
        for (const file of readdirSync(join(target, harness, "agents"))) {
          if (file.startsWith("reviewer")) continue;
          expect(
            readFileSync(join(target, harness, "agents", file), "utf8"),
            `${harness}/${file}`,
          ).not.toContain("When the briefing names run mode");
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // Issue #339: a mutant is applied only through the
  // probe runner, in every run mode; a probe that cannot run through the
  // runner is `not_applicable` (missing evidence, not a pass), never
  // hand-applied. Pins the rule's own wording across every rendered
  // reviewer variant of every harness, the same way the duty test above
  // does, so a future edit cannot drop the rule from one install target
  // while leaving it in another.
  it("every rendered reviewer variant of every harness applies a mutant only through the runner, reporting not_applicable when none is available", () => {
    const codexBodies = [
      parse(
        composeCodexAgent("reviewer", { model: "gpt-6-astra", effort: "high" }),
      ).developer_instructions,
      ...ROLE_TIERS.reviewer.map(
        (tier) =>
          parse(
            composeCodexAgent(
              "reviewer",
              { model: "gpt-6-astra", effort: tier },
              tier,
            ),
          ).developer_instructions,
      ),
    ];
    for (const body of codexBodies) {
      expect(unwrap(String(body))).toContain(RUNNER_ONLY_PROBE_RULE);
    }

    const target = mkdtempSync(join(tmpdir(), "ow-runner-only-probe-"));
    try {
      runInit({
        targetDir: target,
        harnesses: ["claude", "opencode"],
        models: { ...DEFAULT_MODELS },
        opencodeModels: { reviewer: "anthropic/claude-opus-4-8" },
        opencodeClassModels: {
          small: "anthropic/claude-haiku-4-5",
          medium: "anthropic/claude-sonnet-4-6",
          large: "anthropic/claude-opus-4-8",
        },
        tiers: true,
      });
      for (const harness of [".claude", ".opencode"]) {
        for (const tier of ROLE_TIERS.reviewer) {
          const suffix = tier === DEFAULT_TIER.reviewer ? "" : `-${tier}`;
          const rendered = unwrap(
            readFileSync(
              join(target, harness, "agents", `reviewer${suffix}.md`),
              "utf8",
            ),
          );
          expect(rendered, `${harness}/reviewer${suffix}.md`).toContain(
            RUNNER_ONLY_PROBE_RULE,
          );
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // Issue #339: the in-place bounded-exception conditions and the
  // single-mode not_applicable fallback each previously survived a
  // weakening/inverting mutant because nothing pinned their own wording
  // across every install target, the same gap RUNNER_ONLY_PROBE_RULE closed
  // for the general rule above. Mirrors that test's pattern for the two
  // constants unique to this narrower span.
  it("every rendered reviewer variant of every harness carries the in-place exception conditions and the single-mode not_applicable fallback", () => {
    const codexBodies = [
      parse(
        composeCodexAgent("reviewer", { model: "gpt-6-astra", effort: "high" }),
      ).developer_instructions,
      ...ROLE_TIERS.reviewer.map(
        (tier) =>
          parse(
            composeCodexAgent(
              "reviewer",
              { model: "gpt-6-astra", effort: tier },
              tier,
            ),
          ).developer_instructions,
      ),
    ];
    for (const body of codexBodies) {
      const text = unwrap(String(body));
      expect(text).toContain(IN_PLACE_AUTHORIZATION_CLAUSE);
      expect(text).toContain(IN_PLACE_RESTORED_VERIFIED_CLAUSE);
      expect(text).toContain(SINGLE_MODE_NOT_APPLICABLE_CLAUSE);
      expect(text).toContain(HAND_APPLIED_MUTANT_IS_A_FINDING);
    }

    const target = mkdtempSync(join(tmpdir(), "ow-in-place-exception-"));
    try {
      runInit({
        targetDir: target,
        harnesses: ["claude", "opencode"],
        models: { ...DEFAULT_MODELS },
        opencodeModels: { reviewer: "anthropic/claude-opus-4-8" },
        opencodeClassModels: {
          small: "anthropic/claude-haiku-4-5",
          medium: "anthropic/claude-sonnet-4-6",
          large: "anthropic/claude-opus-4-8",
        },
        tiers: true,
      });
      for (const harness of [".claude", ".opencode"]) {
        for (const tier of ROLE_TIERS.reviewer) {
          const suffix = tier === DEFAULT_TIER.reviewer ? "" : `-${tier}`;
          const rendered = unwrap(
            readFileSync(
              join(target, harness, "agents", `reviewer${suffix}.md`),
              "utf8",
            ),
          );
          for (const clause of [
            IN_PLACE_AUTHORIZATION_CLAUSE,
            IN_PLACE_RESTORED_VERIFIED_CLAUSE,
            SINGLE_MODE_NOT_APPLICABLE_CLAUSE,
            HAND_APPLIED_MUTANT_IS_A_FINDING,
          ]) {
            expect(rendered, `${harness}/reviewer${suffix}.md`).toContain(
              clause,
            );
          }
        }
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // Issue #339: the site the reviewer previously
  // contradicted itself at (a conditional "when one is available" framing,
  // and a "scratch copy" alternative to the runner) must not resurface in
  // either normative site for probe replay: step 7's single-mode duty
  // paragraph and the reviewer prompt's own duty span. The GitHub Actions
  // shell replay rule legitimately uses "scratch copy" elsewhere in both
  // files (a different context, pinned separately); this check is scoped
  // to the probe-replay spans only, not the whole file.
  it("step 7's single-mode duty and the reviewer prompt's duty span carry neither a conditional runner framing nor a scratch-copy alternative for probe replay", () => {
    const step7 = probes.slice(
      probes.indexOf("7. **Delegate review.**"),
      probes.indexOf("8. **Decide acceptance.**"),
    );
    const singleModeDuty = step7.slice(step7.indexOf("In run mode `single`"));
    expect(singleModeDuty).not.toContain("when one is available");
    expect(singleModeDuty).not.toContain("scratch copy");

    const promptDuty = reviewer.slice(
      reviewer.indexOf("When the briefing names run mode `single`"),
      reviewer.indexOf("Return exactly this structure"),
    );
    expect(promptDuty).not.toContain("when one is available");
    expect(promptDuty).not.toContain("scratch copy");
  });
});
