import { describe, it, expect } from "vitest";
import { checkText } from "../src/engine.js";
import { defaultConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

const baseOpts = () => ({ packs: allPacks, config: defaultConfig() });

describe("prose-slop", () => {
  it("flags em-dash in prose", () => {
    const v = checkText("This is fine — or not.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/em-dash")).toBeDefined();
  });

  it("does not flag em-dash inside fenced code", () => {
    const text = "Prose normal.\n\n```\ncode — ok\n```\n";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/em-dash")).toBeUndefined();
  });

  it("does not flag em-dash inside inline code", () => {
    const v = checkText("Use `foo — bar` notation.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/em-dash")).toBeUndefined();
  });

  it("does not flag em-dash in code files", () => {
    const v = checkText("// some — comment", "x.ts", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/em-dash")).toBeUndefined();
  });

  it("flags `It is important to note`", () => {
    const v = checkText("It is important to note that X.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/hedging-opener")).toBeDefined();
  });

  it("flags `Furthermore` opener", () => {
    const v = checkText("First sentence.\n\nFurthermore, X happened.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/hedging-opener")).toBeDefined();
  });

  it("flags marketing adjective `seamless`", () => {
    const v = checkText("A seamless experience.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/marketing-adjectives")).toBeDefined();
  });

  it("flags marketing adjective `cutting-edge`", () => {
    const v = checkText("Built on cutting-edge tech.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/marketing-adjectives")).toBeDefined();
  });

  it("flags `delve into`", () => {
    const v = checkText("Let's delve into the details.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/delve-tapestry")).toBeDefined();
  });

  it("flags `leverage the power of`", () => {
    const v = checkText("We leverage the power of caching.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/delve-tapestry")).toBeDefined();
  });

  it("does not flag `delve` as a substring of unrelated word", () => {
    const v = checkText("This was a non-issue.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/delve-tapestry")).toBeUndefined();
  });

  it("redundant-note is off by default", () => {
    const v = checkText("Note: this is fine", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/redundant-note")).toBeUndefined();
  });

  it("does not flag any prose rule on code files", () => {
    const v = checkText("It is important to note that seamless cutting-edge code.", "x.ts", baseOpts());
    expect(v.filter((x) => x.pack === "prose-slop")).toHaveLength(0);
  });

  it("does not flag prose rules on yaml config files", () => {
    const text = "# comment with em-dash — and seamless adjective\nkey: value\n";
    const v = checkText(text, "ci.yml", baseOpts());
    expect(v.filter((x) => x.pack === "prose-slop")).toHaveLength(0);
  });

  it("does not flag prose rules on json files", () => {
    const v = checkText('{"note": "It is important to note something seamless"}', "tsconfig.json", baseOpts());
    expect(v.filter((x) => x.pack === "prose-slop")).toHaveLength(0);
  });
});
