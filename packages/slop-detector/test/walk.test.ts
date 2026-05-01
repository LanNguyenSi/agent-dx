import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath } from "../src/engine.js";
import { defaultConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-walk-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("walk + ignore globs", () => {
  it("does not descend into node_modules", () => {
    fs.mkdirSync(path.join(tmp, "node_modules", "deep"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "deep", "evil.md"), "</result>");
    fs.writeFileSync(path.join(tmp, "real.md"), "</result>");

    const summary = checkPath(tmp, { packs: allPacks, config: defaultConfig() });
    expect(summary.filesScanned).toBe(1);
    expect(summary.violations).toHaveLength(1);
    expect(summary.violations[0].path).toContain("real.md");
  });

  it("does not descend into dist or build or coverage", () => {
    for (const dir of ["dist", "build", "coverage", ".git"]) {
      fs.mkdirSync(path.join(tmp, dir), { recursive: true });
      fs.writeFileSync(path.join(tmp, dir, "x.md"), "</result>");
    }
    fs.writeFileSync(path.join(tmp, "real.md"), "</result>");

    const summary = checkPath(tmp, { packs: allPacks, config: defaultConfig() });
    expect(summary.filesScanned).toBe(1);
  });

  it("scans nested non-ignored directories", () => {
    fs.mkdirSync(path.join(tmp, "src", "deep", "nest"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "deep", "nest", "x.md"), "</result>");

    const summary = checkPath(tmp, { packs: allPacks, config: defaultConfig() });
    expect(summary.filesScanned).toBe(1);
    expect(summary.violations).toHaveLength(1);
  });
});
