import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";
import { composeCodexAgent } from "../src/codex.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_TIER, ROLE_TIERS } from "../src/models.js";
import { SINGLE_REPLAY_RULE } from "./run-mode-constants.js";

const unwrap = (text: string) => text.replace(/\s+/g, " ");
const probes = unwrap(readAsset("skill/references/evidence-and-probes.md"));
const contracts = unwrap(readAsset("skill/references/contracts.md"));
const reviewerRaw = readAsset("agents/reviewer.md");
const reviewer = unwrap(reviewerRaw);

const BEFORE_THE_RULE = "The reviewer output contract itself is unchanged.";
const REVIEWER_DUTY =
  "When the briefing names run mode `single`, the orchestrator implemented the change itself and nobody has cross-checked its probe evidence: replay every orchestrator probe that the briefing names by definition";

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

  it("step 7 names the orchestrator's side, the report, the mismatch severity and the id-only case", () => {
    expect(step7).toContain(
      "the orchestrator records its own probes with their full definition in `04-implementation-summary.md` before requesting review",
    );
    expect(step7).toContain(
      "the reviewer briefing names the run mode and each of those probes by definition",
    );
    expect(step7).toContain("never in the reviewed tree");
    expect(step7).toContain(
      "whether that verdict matches the recorded `result` and `expectation`; a mismatch is a finding of at least `high`",
    );
    expect(step7).toContain(
      "a probe named only by id is `not_applicable` and counts as missing evidence, not as a pass",
    );
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
    expect(reviewer).toContain(REVIEWER_DUTY);
    expect(reviewer).toContain("Do not skip a named probe in that mode.");
    expect(reviewer).toContain(
      "A mismatch is a finding of at least `high`; a probe named only by id is `not_applicable` and is missing evidence, not a pass.",
    );
    expect(reviewer).toContain(
      "Without that mode line in the briefing this obligation does not exist.",
    );
  });

  it("the duty sits above the output block, which stays as it was", () => {
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
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
