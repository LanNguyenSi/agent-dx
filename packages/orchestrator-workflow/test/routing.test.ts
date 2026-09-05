import { describe, expect, it } from "vitest";

import {
  defaultCodexRouting,
  mergeRouting,
  parseRouting,
  validateCodexCatalog,
} from "../src/routing.js";

describe("parseRouting", () => {
  it("parses sparse routing patches without adding omitted defaults", () => {
    expect(
      parseRouting({
        codex: {
          implementer: {
            high: { model: "gpt-future", effort: "high" },
          },
        },
      }),
    ).toEqual({
      codex: {
        implementer: {
          high: { model: "gpt-future", effort: "high" },
        },
      },
    });
  });

  it.each(["ollama/llama3:8b", "bedrock/anthropic.claude-3-5-sonnet-v1:0"])(
    "accepts qualified opencode model ids with version colons: %s",
    (model) => {
      expect(
        parseRouting({
          opencode: { explorer: { low: { model, effort: "low" } } },
        }),
      ).toEqual({
        opencode: { explorer: { low: { model, effort: "low" } } },
      });
    },
  );

  it.each([
    ["unknown harness", { unknown: {} }],
    ["unknown role", { codex: { planner: {} } }],
    ["disallowed role tier", { codex: { reviewer: { low: {} } } }],
    ["unknown tier", { codex: { explorer: { max: {} } } }],
    [
      "unknown selection field",
      {
        codex: {
          explorer: { low: { model: "gpt", effort: "low", extra: true } },
        },
      },
    ],
    [
      "missing selection effort",
      { codex: { explorer: { low: { model: "gpt" } } } },
    ],
    [
      "invalid effort",
      { codex: { explorer: { low: { model: "gpt", effort: "maximum" } } } },
    ],
    [
      "Claude aliases under Codex",
      { codex: { explorer: { low: { model: "sonnet", effort: "low" } } } },
    ],
    [
      "bare opencode ids",
      { opencode: { explorer: { low: { model: "gpt-5.6", effort: "low" } } } },
    ],
    [
      "NUL and DEL control characters",
      {
        codex: {
          explorer: { low: { model: "gpt\u0000\u007f", effort: "low" } },
        },
      },
    ],
    [
      "YAML structural punctuation",
      { codex: { explorer: { low: { model: "[gpt]", effort: "low" } } } },
    ],
    [
      "YAML implicit scalars",
      { codex: { explorer: { low: { model: "true", effort: "low" } } } },
    ],
    ["dangerous object key", JSON.parse('{"codex":{"__proto__":{}}}')],
  ])("rejects %s", (_case, input) => {
    expect(() => parseRouting(input)).toThrow();
  });
});

describe("mergeRouting", () => {
  it("deeply merges selection leaves, lets later layers win, and does not mutate inputs", () => {
    const base = parseRouting({
      codex: {
        implementer: {
          medium: { model: "gpt-base", effort: "medium" },
          high: { model: "gpt-high", effort: "high" },
        },
      },
    });
    const overlay = parseRouting({
      codex: {
        implementer: {
          medium: { model: "gpt-overlay", effort: "medium" },
        },
      },
    });
    const merged = mergeRouting(base, undefined, overlay);

    expect(merged.codex?.implementer).toEqual({
      medium: { model: "gpt-overlay", effort: "medium" },
      high: { model: "gpt-high", effort: "high" },
    });
    merged.codex!.implementer!.medium!.model = "changed-only-in-result";
    expect(base.codex!.implementer!.medium!.model).toBe("gpt-base");
    expect(overlay.codex!.implementer!.medium!.model).toBe("gpt-overlay");
  });
});

describe("defaultCodexRouting", () => {
  it("returns the approved complete Codex role and tier routing", () => {
    expect(defaultCodexRouting()).toEqual({
      codex: {
        explorer: {
          low: { model: "gpt-5.6-luna", effort: "low" },
          medium: { model: "gpt-5.6-sol", effort: "medium" },
          high: { model: "gpt-5.6-sol", effort: "high" },
        },
        "task-slicer": {
          low: { model: "gpt-5.6-luna", effort: "low" },
          medium: { model: "gpt-5.6-sol", effort: "medium" },
          high: { model: "gpt-5.6-sol", effort: "high" },
        },
        implementer: {
          low: { model: "gpt-5.6-luna", effort: "low" },
          medium: { model: "gpt-5.6-terra", effort: "medium" },
          high: { model: "gpt-5.6-terra", effort: "high" },
          xhigh: { model: "gpt-6-astra", effort: "xhigh" },
        },
        reviewer: {
          medium: { model: "gpt-5.6-terra", effort: "medium" },
          high: { model: "gpt-6-astra", effort: "high" },
          xhigh: { model: "gpt-6-astra", effort: "xhigh" },
        },
        advisor: {
          high: { model: "gpt-6-astra", effort: "high" },
          xhigh: { model: "gpt-6-astra", effort: "xhigh" },
        },
      },
    });
  });
});

const CATALOG = {
  models: [
    {
      slug: "gpt-5.6-luna",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
    },
    {
      slug: "gpt-6-astra",
      supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
    },
  ],
};

describe("validateCodexCatalog", () => {
  it("validates only the supplied effective Codex selections", () => {
    const selected = parseRouting({
      codex: {
        explorer: { low: { model: "gpt-5.6-luna", effort: "low" } },
      },
    });
    expect(validateCodexCatalog(selected, CATALOG)).toEqual([]);
  });

  it("rejects a selected model absent from a known catalog", () => {
    const selected = parseRouting({
      codex: { explorer: { low: { model: "gpt-missing", effort: "low" } } },
    });
    expect(() => validateCodexCatalog(selected, CATALOG)).toThrow(
      /unavailable/,
    );
  });

  it("rejects unsupported selected effort", () => {
    const selected = parseRouting({
      codex: { advisor: { high: { model: "gpt-6-astra", effort: "medium" } } },
    });
    expect(() => validateCodexCatalog(selected, CATALOG)).toThrow(
      /does not support/,
    );
  });

  it("warns when the catalog knows the model but omits effort support", () => {
    const selected = parseRouting({
      codex: { explorer: { low: { model: "gpt-5.6-luna", effort: "low" } } },
    });
    expect(
      validateCodexCatalog(selected, { models: [{ slug: "gpt-5.6-luna" }] }),
    ).toEqual([expect.stringContaining("could not be validated")]);
  });

  it("rejects malformed catalog data instead of treating it as valid", () => {
    const selected = parseRouting({
      codex: { explorer: { low: { model: "gpt-5.6-luna", effort: "low" } } },
    });
    expect(() =>
      validateCodexCatalog(selected, { models: [{ slug: 42 }] }),
    ).toThrow(/non-empty slug/);
  });
});
