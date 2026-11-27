import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODELS,
  MODEL_ID_FORBIDDEN_CHARS,
  assertValidModelId,
  parseModelsSpec,
} from "../src/models.js";
import { parseRouting } from "../src/routing.js";

// Each character is placed inside an otherwise valid id: a leading or
// trailing one is already rejected by the trim check, so an internal
// placement is what pins the shared whitespace/control class.
const FORBIDDEN: [string, string][] = [
  ["carriage return", "\r"],
  ["tab", "\t"],
  ["vertical tab", "\v"],
  ["form feed", "\f"],
  ["NUL", "\0"],
  ["DEL", "\u007f"],
  ["space", " "],
  ["line separator", "\u2028"],
  ["paragraph separator", "\u2029"],
];

describe("assertValidModelId", () => {
  it.each(FORBIDDEN)("rejects an id holding an internal %s", (_label, char) => {
    expect(() => assertValidModelId(`son${char}net`)).toThrow(
      /Invalid model id/,
    );
  });

  it("accepts aliases, full ids, and qualified opencode provider/model ids", () => {
    for (const model of [
      "sonnet",
      "anthropic/claude-opus-4-8",
      "openrouter/anthropic/claude-sonnet-4.5",
    ]) {
      expect(() => assertValidModelId(model)).not.toThrow();
    }
  });
});

describe("MODEL_ID_FORBIDDEN_CHARS", () => {
  it.each(FORBIDDEN)("matches an internal %s", (_label, char) => {
    expect(MODEL_ID_FORBIDDEN_CHARS.test(`son${char}net`)).toBe(true);
  });

  it("does not match a plain id", () => {
    expect(MODEL_ID_FORBIDDEN_CHARS.test("anthropic/claude-opus-4-8")).toBe(
      false,
    );
  });
});

describe("parseModelsSpec", () => {
  it.each(FORBIDDEN)(
    "rejects a --models value holding an internal %s",
    (_label, char) => {
      expect(() =>
        parseModelsSpec(`reviewer=son${char}net`, DEFAULT_MODELS),
      ).toThrow(/Invalid model id/);
    },
  );

  it("accepts and applies a valid full id over the base", () => {
    expect(
      parseModelsSpec("reviewer=anthropic/claude-opus-4-8", DEFAULT_MODELS),
    ).toMatchObject({ reviewer: "anthropic/claude-opus-4-8" });
  });
});

describe("routing validates model ids with the same class", () => {
  it("rejects a routing model holding only DEL with the whitespace-or-control message", () => {
    expect(() =>
      parseRouting({
        codex: { explorer: { low: { model: "gpt\u007f", effort: "low" } } },
      }),
    ).toThrow(/whitespace or control characters/);
  });

  it("rejects a routing model holding only a line separator with the whitespace-or-control message", () => {
    expect(() =>
      parseRouting({
        codex: { explorer: { low: { model: "gpt\u2028x", effort: "low" } } },
      }),
    ).toThrow(/whitespace or control characters/);
  });
});
