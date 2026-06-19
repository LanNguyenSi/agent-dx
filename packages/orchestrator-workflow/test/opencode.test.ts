import { describe, expect, it } from "vitest";

import {
  detectProvider,
  parseOpencodeCatalog,
  providerOf,
  resolveAlias,
  resolveOpencodeModels,
} from "../src/opencode.js";
import { DEFAULT_MODELS } from "../src/models.js";

// ---------------------------------------------------------------------------
// parseOpencodeCatalog
// ---------------------------------------------------------------------------

describe("parseOpencodeCatalog", () => {
  it("splits stdout into trimmed non-empty lines", () => {
    const stdout =
      "github-copilot/claude-sonnet-4.6\ngithub-copilot/claude-opus-4.8\n\n  openrouter/anthropic/claude-sonnet-4.6  \n";
    expect(parseOpencodeCatalog(stdout)).toEqual([
      "github-copilot/claude-sonnet-4.6",
      "github-copilot/claude-opus-4.8",
      "openrouter/anthropic/claude-sonnet-4.6",
    ]);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(parseOpencodeCatalog("")).toEqual([]);
    expect(parseOpencodeCatalog("   \n\n  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// providerOf
// ---------------------------------------------------------------------------

describe("providerOf", () => {
  it("returns substring before first /", () => {
    expect(providerOf("github-copilot/claude-sonnet-4.6")).toBe(
      "github-copilot",
    );
    expect(providerOf("openrouter/anthropic/claude-sonnet-4.6")).toBe(
      "openrouter",
    );
    expect(providerOf("anthropic/claude-opus-4-8")).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// detectProvider
// ---------------------------------------------------------------------------

const FAKE_CATALOG = [
  "github-copilot/claude-sonnet-4.6",
  "github-copilot/claude-opus-4.8",
  "github-copilot/claude-haiku-4.5",
  "github-copilot/gpt-4o",
  "openrouter/anthropic/claude-sonnet-4.6",
  "google/gemini-pro",
];

describe("detectProvider — explicit override", () => {
  it("returns the explicit provider without scanning the catalog", () => {
    expect(
      detectProvider({ catalog: FAKE_CATALOG, explicit: "my-provider" }),
    ).toEqual({ provider: "my-provider", ambiguous: false });
  });
});

describe("detectProvider — single provider", () => {
  it("returns the sole provider that has claude- models", () => {
    const catalog = [
      "github-copilot/claude-sonnet-4.6",
      "github-copilot/claude-opus-4.8",
      "github-copilot/gpt-4o",
      // openrouter model-id does NOT start with claude-
      "openrouter/anthropic/claude-sonnet-4.6",
      "google/gemini-pro",
    ];
    expect(detectProvider({ catalog })).toEqual({
      provider: "github-copilot",
      ambiguous: false,
    });
  });
});

describe("detectProvider — multiple providers", () => {
  it("returns ambiguous: true when two providers have claude- models", () => {
    const catalog = [
      "github-copilot/claude-sonnet-4.6",
      "anthropic/claude-opus-4-8",
    ];
    expect(detectProvider({ catalog })).toEqual({
      provider: undefined,
      ambiguous: true,
    });
  });
});

describe("detectProvider — no claude provider", () => {
  it("returns ambiguous: false when no provider has claude- models", () => {
    const catalog = [
      "openrouter/anthropic/claude-sonnet-4.6",
      "google/gemini-pro",
    ];
    expect(detectProvider({ catalog })).toEqual({
      provider: undefined,
      ambiguous: false,
    });
  });

  it("returns ambiguous: false for an empty catalog", () => {
    expect(detectProvider({ catalog: [] })).toEqual({
      provider: undefined,
      ambiguous: false,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAlias
// ---------------------------------------------------------------------------

const COPILOT_CATALOG = [
  "github-copilot/claude-haiku-4.5",
  "github-copilot/claude-haiku-4",
  "github-copilot/claude-sonnet-4.6",
  "github-copilot/claude-sonnet-4-5",
  "github-copilot/claude-opus-4.8",
  "github-copilot/claude-opus-4.8-thinking",
  "github-copilot/claude-sonnet-4.6-fast",
  "github-copilot/gpt-4o",
];

describe("resolveAlias — picks the highest version", () => {
  it("picks claude-sonnet-4.6 over 4-5 (dot vs dash formats)", () => {
    expect(resolveAlias("github-copilot", "sonnet", COPILOT_CATALOG)).toBe(
      "github-copilot/claude-sonnet-4.6",
    );
  });

  it("picks claude-haiku-4.5 over claude-haiku-4", () => {
    expect(resolveAlias("github-copilot", "haiku", COPILOT_CATALOG)).toBe(
      "github-copilot/claude-haiku-4.5",
    );
  });

  it("picks claude-opus-4.8 and skips -thinking variant", () => {
    expect(resolveAlias("github-copilot", "opus", COPILOT_CATALOG)).toBe(
      "github-copilot/claude-opus-4.8",
    );
  });
});

describe("resolveAlias — skips non-canonical variants", () => {
  it("skips -fast when canonical options exist", () => {
    // COPILOT_CATALOG has both 4.6 and 4.6-fast for sonnet.
    // Should pick 4.6 (canonical), not 4.6-fast.
    expect(resolveAlias("github-copilot", "sonnet", COPILOT_CATALOG)).toBe(
      "github-copilot/claude-sonnet-4.6",
    );
  });

  it("falls back to non-canonical when there are no canonical candidates", () => {
    const catalog = [
      "myprovider/claude-sonnet-4.6-fast",
      "myprovider/claude-sonnet-4.5-fast",
    ];
    expect(resolveAlias("myprovider", "sonnet", catalog)).toBe(
      "myprovider/claude-sonnet-4.6-fast",
    );
  });
});

describe("resolveAlias — returns undefined when absent", () => {
  it("returns undefined when provider has no matching family", () => {
    expect(
      resolveAlias("github-copilot", "haiku", ["github-copilot/gpt-4o"]),
    ).toBeUndefined();
  });

  it("returns undefined for an unknown provider", () => {
    expect(resolveAlias("unknown", "sonnet", COPILOT_CATALOG)).toBeUndefined();
  });
});

describe("resolveAlias — handles dot vs dash separators in version numbers", () => {
  it("treats 4.6 and 4-6 as the same numeric version", () => {
    const catalog = [
      "myprovider/claude-sonnet-4-6",
      "myprovider/claude-sonnet-4-5",
    ];
    expect(resolveAlias("myprovider", "sonnet", catalog)).toBe(
      "myprovider/claude-sonnet-4-6",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveOpencodeModels
// ---------------------------------------------------------------------------

const GH_CATALOG = [
  "github-copilot/claude-sonnet-4.6",
  "github-copilot/claude-opus-4.8",
  "github-copilot/claude-haiku-4.5",
];

describe("resolveOpencodeModels — FQ ids pass through", () => {
  it("returns FQ ids unchanged without touching the catalog", () => {
    const models = {
      explorer: "github-copilot/claude-sonnet-4.6",
      "task-slicer": "github-copilot/claude-sonnet-4.6",
      implementer: "github-copilot/claude-sonnet-4.6",
      reviewer: "github-copilot/claude-opus-4.8",
    };
    const { resolved, warnings } = resolveOpencodeModels(models, {
      catalog: [],
    });
    expect(resolved.explorer).toBe("github-copilot/claude-sonnet-4.6");
    expect(resolved.reviewer).toBe("github-copilot/claude-opus-4.8");
    expect(warnings).toHaveLength(0);
  });
});

describe("resolveOpencodeModels — alias resolution", () => {
  it("resolves known aliases via the catalog", () => {
    const { resolved, warnings } = resolveOpencodeModels(DEFAULT_MODELS, {
      catalog: GH_CATALOG,
    });
    expect(resolved.explorer).toBe("github-copilot/claude-sonnet-4.6");
    expect(resolved.reviewer).toBe("github-copilot/claude-opus-4.8");
    expect(resolved.implementer).toBe("github-copilot/claude-sonnet-4.6");
    expect(warnings).toHaveLength(0);
  });

  it("uses explicitProvider instead of auto-detection", () => {
    const catalog = [
      "provider-a/claude-sonnet-4.6",
      "provider-a/claude-opus-4.8",
      "provider-b/claude-sonnet-4.6",
      "provider-b/claude-opus-4.8",
      "provider-b/claude-haiku-4.5",
    ];
    const { resolved, warnings } = resolveOpencodeModels(DEFAULT_MODELS, {
      catalog,
      explicitProvider: "provider-b",
    });
    expect(resolved.explorer).toBe("provider-b/claude-sonnet-4.6");
    expect(resolved.reviewer).toBe("provider-b/claude-opus-4.8");
    expect(warnings).toHaveLength(0);
  });
});

describe("resolveOpencodeModels — ambiguous provider", () => {
  it("returns undefined + one combined warning for all alias roles", () => {
    const catalog = [
      "provider-a/claude-sonnet-4.6",
      "provider-b/claude-sonnet-4.6",
    ];
    const { resolved, warnings } = resolveOpencodeModels(DEFAULT_MODELS, {
      catalog,
    });
    expect(resolved.explorer).toBeUndefined();
    expect(resolved.reviewer).toBeUndefined();
    // One combined warning, not one per role
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--opencode-provider");
  });
});

describe("resolveOpencodeModels — no claude provider in catalog", () => {
  it("returns undefined + one combined warning", () => {
    const { resolved, warnings } = resolveOpencodeModels(DEFAULT_MODELS, {
      catalog: ["google/gemini-pro"],
    });
    expect(resolved.explorer).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--opencode-provider");
  });
});

describe("resolveOpencodeModels — unknown bare string", () => {
  it("returns undefined + per-role warning for non-alias bare values", () => {
    const models = {
      ...DEFAULT_MODELS,
      implementer: "my-unknown-model",
    };
    const { resolved, warnings } = resolveOpencodeModels(models, {
      catalog: GH_CATALOG,
    });
    expect(resolved.implementer).toBeUndefined();
    expect(warnings.some((w) => w.includes('"implementer"'))).toBe(true);
    // Other aliases should still resolve
    expect(resolved.explorer).toBe("github-copilot/claude-sonnet-4.6");
  });
});

describe("resolveOpencodeModels — empty catalog (opencode not available)", () => {
  it("returns all undefined for aliases + one combined warning", () => {
    const { resolved, warnings } = resolveOpencodeModels(DEFAULT_MODELS, {
      catalog: [],
    });
    for (const v of Object.values(resolved)) {
      expect(v).toBeUndefined();
    }
    expect(warnings).toHaveLength(1);
  });
});
