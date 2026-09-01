import { describe, expect, it } from "vitest";
import { allRules } from "../src/rules/index.js";

describe("rules registry", () => {
  it("maps to exactly the eight expected rule ids", () => {
    const ids = allRules.map((rule) => rule.id).sort();
    expect(ids).toEqual([
      "citations-resolve",
      "frontmatter-required",
      "links-resolve",
      "no-absolute-links",
      "prose-line-references",
      "reserved-files-bare",
      "sources-fresh",
      "sources-shape",
    ]);
  });
});
