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

  it("loadConfig accepts a scan-root-relative entrypointGlobs pattern", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `entrypointGlobs:\n  - "src/index.ts"\n`);
    const cfg = loadConfig(file);
    expect(cfg.entrypointGlobs).toEqual(["src/index.ts"]);
  });

  it("loadConfig rejects an entrypointGlobs pattern with a leading slash", () => {
    // entrypointGlobs is matched against a path already made relative to
    // the scan root — a leading "/" can never match, so it's always a
    // misconfiguration (someone assuming absolute-path matching), not a
    // valid pattern. Reject it at parse time instead of silently matching
    // nothing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `entrypointGlobs:\n  - "/src/index.ts"\n`);
    expect(() => loadConfig(file)).toThrow(/entrypointGlobs/);
  });

  it("defaultConfig and mergeConfig default placement to empty arrays", () => {
    expect(defaultConfig().placement).toEqual({
      markers: [],
      instructionGlobs: [],
      allow: [],
    });
    expect(mergeConfig({}).placement).toEqual({
      markers: [],
      instructionGlobs: [],
      allow: [],
    });
  });

  it("mergeConfig parses a placement block", () => {
    const cfg = mergeConfig({
      placement: {
        markers: ["example-org"],
        instructionGlobs: ["**/PLAYBOOK.md"],
        allow: ["github\\.com/example-org/"],
      },
    });
    expect(cfg.placement).toEqual({
      markers: ["example-org"],
      instructionGlobs: ["**/PLAYBOOK.md"],
      allow: ["github\\.com/example-org/"],
    });
  });

  it("loadConfig rejects an invalid regex in placement.markers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `placement:\n  markers:\n    - "("\n`);
    expect(() => loadConfig(file)).toThrow(/Invalid regular expression/);
  });

  it("loadConfig rejects an invalid regex in placement.allow", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `placement:\n  allow:\n    - "["\n`);
    expect(() => loadConfig(file)).toThrow(/Invalid regular expression/);
  });

  it("loadConfig omitting placement entirely yields [] defaults", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `packs:\n  prose-slop: false\n`);
    const cfg = loadConfig(file);
    expect(cfg.placement).toEqual({
      markers: [],
      instructionGlobs: [],
      allow: [],
    });
  });
});
