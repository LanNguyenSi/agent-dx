import { describe, expect, it } from "vitest";
import { createEmptyFeatureSelection, parseFeatureFlags } from "./features.js";

describe("parseFeatureFlags", () => {
  it("returns an empty selection for missing input", () => {
    expect(parseFeatureFlags()).toEqual(createEmptyFeatureSelection());
  });

  it("parses comma-separated values with whitespace and duplicates", () => {
    expect(parseFeatureFlags("memory, skills, memory")).toEqual({
      memory: true,
      skills: true,
    });
  });

  it("rejects unknown feature names", () => {
    expect(() => parseFeatureFlags("memory,unknown")).toThrow(
      "Unknown features: unknown. Allowed features: memory, skills.",
    );
  });

  it("rejects the removed triologue feature", () => {
    expect(() => parseFeatureFlags("memory,triologue")).toThrow(
      "Unknown features: triologue. Allowed features: memory, skills.",
    );
  });
});
