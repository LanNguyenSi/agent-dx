import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig, mergeConfig } from "../src/config.js";
import { checkText } from "../src/engine.js";
import { allPacks } from "../src/packs/registry.js";

describe("config", () => {
  it("default config enables agent-tics + prose-slop", () => {
    const cfg = defaultConfig();
    expect(cfg.packs["agent-tics"]).toBe(true);
    expect(cfg.packs["prose-slop"]).toBe(true);
    expect(cfg.packs["comment-slop"]).toBe(false);
  });

  it("config can disable an entire pack", () => {
    const cfg = mergeConfig({ packs: { "prose-slop": false } });
    const v = checkText("seamless — cutting-edge.", "x.md", { packs: allPacks, config: cfg });
    expect(v.filter((x) => x.pack === "prose-slop")).toHaveLength(0);
  });

  it("config can promote a rule from warn to block", () => {
    const cfg = mergeConfig({ rules: { "prose-slop/em-dash": { severity: "block" } } });
    const v = checkText("hi — there", "x.md", { packs: allPacks, config: cfg });
    const m = v.find((x) => x.ruleId === "prose-slop/em-dash");
    expect(m?.severity).toBe("block");
  });

  it("config can disable a single rule via override", () => {
    const cfg = mergeConfig({ rules: { "prose-slop/em-dash": { enabled: false } } });
    const v = checkText("hi — there seamless", "x.md", { packs: allPacks, config: cfg });
    expect(v.find((x) => x.ruleId === "prose-slop/em-dash")).toBeUndefined();
    expect(v.find((x) => x.ruleId === "prose-slop/marketing-adjectives")).toBeDefined();
  });

  it("config can enable an off-by-default rule", () => {
    const cfg = mergeConfig({ rules: { "prose-slop/redundant-note": { enabled: true } } });
    const v = checkText("Note: hello", "x.md", { packs: allPacks, config: cfg });
    expect(v.find((x) => x.ruleId === "prose-slop/redundant-note")).toBeDefined();
  });

  it("loadConfig parses a YAML file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `packs:\n  prose-slop: false\nrules:\n  agent-tics/stray-result-tag:\n    severity: warn\n`,
    );
    const cfg = loadConfig(file);
    expect(cfg.packs["prose-slop"]).toBe(false);
    expect(cfg.ruleOverrides["agent-tics/stray-result-tag"].severity).toBe("warn");
  });
});
