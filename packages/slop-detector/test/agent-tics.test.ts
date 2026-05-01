import { describe, it, expect } from "vitest";
import { checkText } from "../src/engine.js";
import { defaultConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

const baseOpts = () => ({ packs: allPacks, config: defaultConfig() });

describe("agent-tics", () => {
  it("flags </result> in prose", () => {
    const v = checkText("Some text\n</result>\nmore", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeDefined();
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")?.severity).toBe("block");
  });

  it("flags </invoke> in prose", () => {
    const v = checkText("</invoke>", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-invoke-tag")).toBeDefined();
  });

  it("flags antml function-call tags", () => {
    const v = checkText("<function_calls>", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-invoke-tag")).toBeDefined();
  });

  it("flags Claude Code footer in prose", () => {
    const v = checkText("Generated with Claude Code", "README.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/claude-code-footer")).toBeDefined();
  });

  it("does not flag Claude Code footer in code files", () => {
    const v = checkText("// Generated with Claude Code", "x.ts", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/claude-code-footer")).toBeUndefined();
  });

  it("flags duplicate Summary headings", () => {
    const text = "## Summary\nfirst\n\n## Summary\nsecond";
    const v = checkText(text, "x.md", baseOpts());
    const matches = v.filter((x) => x.ruleId === "agent-tics/doubled-summary-heading");
    expect(matches.length).toBe(1);
    expect(matches[0].line).toBe(4);
  });

  it("does not flag a single Summary heading", () => {
    const v = checkText("## Summary\nonly one", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/doubled-summary-heading")).toBeUndefined();
  });

  it("flags TODO placeholder text", () => {
    const v = checkText("TODO: [insert real description here]", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/placeholder-todo")).toBeDefined();
  });

  it("does not flag a real TODO with content", () => {
    const v = checkText("TODO: investigate the cache invalidation race", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/placeholder-todo")).toBeUndefined();
  });

  it("respects disable-line directive", () => {
    const text = "</result> <!-- slop-detector:disable-line -->";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeUndefined();
  });

  it("respects disable-line scoped to a specific rule", () => {
    const text = "</result> <!-- slop-detector:disable-line=agent-tics/stray-result-tag -->";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeUndefined();
  });

  it("does not skip unrelated rules with scoped disable", () => {
    const text = "</result> seamless <!-- slop-detector:disable-line=agent-tics/stray-result-tag -->";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeUndefined();
    expect(v.find((x) => x.ruleId === "prose-slop/marketing-adjectives")).toBeDefined();
  });

  it("respects disable-next-line", () => {
    const text = "<!-- slop-detector:disable-next-line -->\n</result>";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeUndefined();
  });

  it("ellipsis-promise rule is off by default", () => {
    const v = checkText("I'll continue this...", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/ellipsis-promise")).toBeUndefined();
  });

  it("does not flag </result> inside fenced code in prose files", () => {
    const text = "Documenting the rule:\n\n```\n</result>\n```\n";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeUndefined();
  });

  it("does not flag </result> inside inline code in prose files", () => {
    const v = checkText("The `</result>` artefact is what we catch.", "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeUndefined();
  });

  it("still flags </result> inside fenced code in non-prose files", () => {
    const v = checkText("```\n</result>\n```\n", "x.ts", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeDefined();
  });

  it("doubled-summary-heading does not fire on Summary inside fenced code", () => {
    const text = "```md\n## Summary\nTemplate stub\n```\n\n## Summary\nMy actual summary";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/doubled-summary-heading")).toBeUndefined();
  });

  it("placeholder-todo does not fire inside fenced code", () => {
    const text = "Example template:\n\n```\nTODO: [insert details]\n```\n";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/placeholder-todo")).toBeUndefined();
  });

  it("claude-code-footer does not fire inside fenced code", () => {
    const text = "Document the footer:\n\n```\n🤖 Generated with Claude Code\n```\n";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/claude-code-footer")).toBeUndefined();
  });

  it("scoped disable on a specific rule-id leaves sibling rules active", () => {
    const text = "</result> seamless cutting-edge <!-- slop-detector:disable-line=prose-slop/marketing-adjectives -->";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "prose-slop/marketing-adjectives")).toBeUndefined();
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeDefined();
  });

  it("disable directive accepts comma-separated rule-ids with slashes", () => {
    const text =
      "</result> seamless <!-- slop-detector:disable-line=agent-tics/stray-result-tag,prose-slop/marketing-adjectives -->";
    const v = checkText(text, "x.md", baseOpts());
    expect(v.find((x) => x.ruleId === "agent-tics/stray-result-tag")).toBeUndefined();
    expect(v.find((x) => x.ruleId === "prose-slop/marketing-adjectives")).toBeUndefined();
  });
});
