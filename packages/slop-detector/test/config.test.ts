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
    const v = checkText("seamless — cutting-edge.", "x.md", {
      packs: allPacks,
      config: cfg,
    });
    expect(v.filter((x) => x.pack === "prose-slop")).toHaveLength(0);
  });

  it("config can promote a rule from warn to block", () => {
    const cfg = mergeConfig({
      rules: { "prose-slop/em-dash": { severity: "block" } },
    });
    const v = checkText("hi — there", "x.md", { packs: allPacks, config: cfg });
    const m = v.find((x) => x.ruleId === "prose-slop/em-dash");
    expect(m?.severity).toBe("block");
  });

  it("config can disable a single rule via override", () => {
    const cfg = mergeConfig({
      rules: { "prose-slop/em-dash": { enabled: false } },
    });
    const v = checkText("hi — there seamless", "x.md", {
      packs: allPacks,
      config: cfg,
    });
    expect(v.find((x) => x.ruleId === "prose-slop/em-dash")).toBeUndefined();
    expect(
      v.find((x) => x.ruleId === "prose-slop/marketing-adjectives"),
    ).toBeDefined();
  });

  it("config can enable an off-by-default rule", () => {
    const cfg = mergeConfig({
      rules: { "prose-slop/redundant-note": { enabled: true } },
    });
    const v = checkText("Note: hello", "x.md", {
      packs: allPacks,
      config: cfg,
    });
    expect(
      v.find((x) => x.ruleId === "prose-slop/redundant-note"),
    ).toBeDefined();
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
    expect(cfg.ruleOverrides["agent-tics/stray-result-tag"].severity).toBe(
      "warn",
    );
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

  it("loadConfig rejects a placement.markers pattern that matches the empty string", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `placement:\n  markers:\n    - "a*"\n`);
    expect(() => loadConfig(file)).toThrow(/matches the empty string/);
  });

  it("loadConfig rejects a placement.allow pattern that matches the empty string", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `placement:\n  allow:\n    - ".*"\n`);
    expect(() => loadConfig(file)).toThrow(/matches the empty string/);
  });

  it("loadConfig rejects a placement.instructionGlobs pattern with a leading slash", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `placement:\n  instructionGlobs:\n    - "/SKILL.md"\n`,
    );
    expect(() => loadConfig(file)).toThrow(/instructionGlobs/);
  });

  it("mergeConfig normalizes a leading './' in placement.instructionGlobs", () => {
    const cfg = mergeConfig({
      placement: { instructionGlobs: ["./sub/**/*.md"] },
    });
    expect(cfg.placement?.instructionGlobs).toEqual(["sub/**/*.md"]);
  });

  it("loadConfig rejects a review.allowPaths pattern with a leading slash", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `review:\n  allowPaths:\n    - "/CHANGELOG.md"\n`);
    expect(() => loadConfig(file)).toThrow(/allowPaths/);
  });

  it("mergeConfig normalizes a leading './' in review.allowPaths", () => {
    const cfg = mergeConfig({
      review: { allowPaths: ["./sub/CHANGELOG.md"] },
    });
    expect(cfg.review?.allowPaths).toEqual(["sub/CHANGELOG.md"]);
  });

  it("loadConfig rejects a workflow.allowExpressions entry that still carries the \\${{ }} wrapper", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  allowExpressions:\n    - "\${{ matrix.node }}"\n`,
    );
    expect(() => loadConfig(file)).toThrow(/bare expression body only/);
  });

  it("loadConfig accepts a bare workflow.allowExpressions entry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  allowExpressions:\n    - "matrix.node"\n`,
    );
    const cfg = loadConfig(file);
    expect(cfg.workflow?.allowExpressions).toEqual(["matrix.node"]);
  });

  it("workflow.auditGateTemplates defaults to [] (the package ships no org template)", () => {
    expect(defaultConfig().workflow?.auditGateTemplates).toEqual([]);
    expect(mergeConfig({}).workflow?.auditGateTemplates).toEqual([]);
  });

  it("loadConfig accepts a workflow.auditGateTemplates entry with a sha256", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    const sha = "a".repeat(64);
    fs.writeFileSync(
      file,
      `workflow:\n  auditGateTemplates:\n    - name: canonical\n      sha256: ${sha}\n`,
    );
    expect(loadConfig(file).workflow?.auditGateTemplates).toEqual([
      { name: "canonical", sha256: sha },
    ]);
  });

  it("loadConfig rejects a workflow.auditGateTemplates entry with neither sha256 nor statements", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  auditGateTemplates:\n    - name: canonical\n`,
    );
    expect(() => loadConfig(file)).toThrow(/entries carry exactly one of/);
  });

  it("loadConfig rejects a workflow.auditGateTemplates entry carrying both", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  auditGateTemplates:\n    - name: canonical\n      sha256: ${"b".repeat(64)}\n      statements: ["set +e"]\n`,
    );
    expect(() => loadConfig(file)).toThrow(/entries carry exactly one of/);
  });

  it("loadConfig rejects a workflow.auditGateTemplates sha256 that is not a 64-char hex digest", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  auditGateTemplates:\n    - name: canonical\n      sha256: deadbeef\n`,
    );
    expect(() => loadConfig(file)).toThrow(/64-character hex sha256 digest/);
  });

  it("workflow.executedActionInputs defaults to []", () => {
    expect(defaultConfig().workflow?.executedActionInputs).toEqual([]);
    expect(mergeConfig({}).workflow?.executedActionInputs).toEqual([]);
  });

  it("loadConfig accepts a bare workflow.executedActionInputs entry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  executedActionInputs:\n    - "acme/run-code:code"\n`,
    );
    const cfg = loadConfig(file);
    expect(cfg.workflow?.executedActionInputs).toEqual(["acme/run-code:code"]);
  });

  it("loadConfig rejects a workflow.executedActionInputs entry carrying an @ref (matching is ref-independent)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  executedActionInputs:\n    - "acme/run-code@v1:code"\n`,
    );
    expect(() => loadConfig(file)).toThrow(/ref-independent/);
  });

  it("loadConfig rejects a workflow.executedActionInputs entry with no owner/repo separator", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  executedActionInputs:\n    - "run-code:code"\n`,
    );
    expect(() => loadConfig(file)).toThrow(/owner\/repo:input/);
  });

  it("loadConfig rejects a workflow.executedActionInputs entry with no input name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  executedActionInputs:\n    - "acme/run-code"\n`,
    );
    expect(() => loadConfig(file)).toThrow(/owner\/repo:input/);
  });

  it("loadConfig rejects a workflow.executedActionInputs entry whose input name carries a colon (the first colon after owner/repo is the separator, so a colon can never be part of the input name)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  executedActionInputs:\n    - "acme/run-code:my:input"\n`,
    );
    expect(() => loadConfig(file)).toThrow(
      /the input name cannot itself contain a colon/,
    );
  });

  it("loadConfig rejects a workflow.executedActionInputs entry whose input name carries a literal space (written as an underscore instead)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `workflow:\n  executedActionInputs:\n    - "acme/run-code:my input"\n`,
    );
    expect(() => loadConfig(file)).toThrow(/for a literal space/);
  });

  // The pattern-anchor pointer moved out of README.md into
  // docs/configuration.md; these three schemas each report the same
  // "leading /" rejection and must each point at the doc that now holds
  // the "Path pattern anchor" section, not the retired README location.
  it("loadConfig rejects an entrypointGlobs pattern with a leading slash and points at docs/configuration.md's pattern anchor section", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `entrypointGlobs:\n  - "/src/index.ts"\n`);
    expect(() => loadConfig(file)).toThrow(
      /see docs\/configuration\.md.*Path pattern anchor/,
    );
  });

  it("loadConfig rejects a placement.instructionGlobs pattern with a leading slash and points at docs/configuration.md's pattern anchor section", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `placement:\n  instructionGlobs:\n    - "/AGENTS.md"\n`,
    );
    expect(() => loadConfig(file)).toThrow(
      /see docs\/configuration\.md.*Path pattern anchor/,
    );
  });

  it("loadConfig rejects a review.allowPaths pattern with a leading slash and points at docs/configuration.md's pattern anchor section", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-cfg-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, `review:\n  allowPaths:\n    - "/test/**"\n`);
    expect(() => loadConfig(file)).toThrow(
      /see docs\/configuration\.md.*Path pattern anchor/,
    );
  });
});
