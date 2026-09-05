import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { readAgentAsset } from "../src/assets.js";
import { composeCodexAgent } from "../src/codex.js";

describe("composeCodexAgent", () => {
  it("renders a parseable unsuffixed default agent with its canonical prompt", () => {
    const rendered = composeCodexAgent("implementer", {
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    const parsed = parse(rendered);
    const asset = readAgentAsset("implementer");

    expect(parsed).toMatchObject({
      name: "implementer",
      description: asset.description,
      model: "gpt-5.6-terra",
      model_reasoning_effort: "medium",
      developer_instructions: asset.body.trimEnd(),
    });
    expect(parsed).not.toHaveProperty("sandbox_mode");
  });

  it("renders tier names and tier descriptions", () => {
    const parsed = parse(
      composeCodexAgent(
        "reviewer",
        { model: "gpt-6-astra", effort: "xhigh" },
        "xhigh",
      ),
    );
    expect(parsed).toMatchObject({
      name: "reviewer-xhigh",
      description:
        "Skeptical technical reviewer: checks a change against spec, architecture, security, edge cases, and test adequacy, classifies findings by severity, recommends fixes. (Effort tier: xhigh.)",
      model: "gpt-6-astra",
      model_reasoning_effort: "xhigh",
    });
  });

  it("uses read-only sandbox only for explorer and advisor", () => {
    expect(
      parse(
        composeCodexAgent("explorer", { model: "gpt-5.6-luna", effort: "low" }),
      ).sandbox_mode,
    ).toBe("read-only");
    expect(
      parse(
        composeCodexAgent("advisor", { model: "gpt-6-astra", effort: "high" }),
      ).sandbox_mode,
    ).toBe("read-only");
    expect(
      parse(
        composeCodexAgent("reviewer", { model: "gpt-6-astra", effort: "high" }),
      ),
    ).not.toHaveProperty("sandbox_mode");
  });

  it("escapes quotes, backslashes, control characters, and newlines in TOML values", () => {
    const value = 'future"model\\path\nwith\tcontrol\u0001';
    const parsed = parse(
      composeCodexAgent("implementer", { model: value, effort: "medium" }),
    );
    expect(parsed.model).toBe(value);
    expect(typeof parsed.developer_instructions).toBe("string");
    expect(
      (parsed.developer_instructions as string).split("\n").length,
    ).toBeGreaterThan(1);
  });
});
