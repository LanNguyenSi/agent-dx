import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_REPOS,
  defaultConfig,
  loadConfig,
  mergeConfig,
} from "../src/config.js";

const tmpDirs: string[] = [];

function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-scout-cfg-"));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("defaultConfig", () => {
  it("uses opensrc and codebase-oracle as the default commands", () => {
    const c = defaultConfig();
    expect(c.opensrcCommand).toBe("opensrc");
    expect(c.oracleCommand).toBe("codebase-oracle");
    expect(c.defaultRepos).toEqual([...DEFAULT_REPOS]);
  });
});

describe("mergeConfig", () => {
  it("overrides only the supplied fields", () => {
    const merged = mergeConfig({ oracleCommand: "npx codebase-oracle" });
    expect(merged.oracleCommand).toBe("npx codebase-oracle");
    expect(merged.opensrcCommand).toBe("opensrc");
  });
  it("leaves oracleCwd unset by default and carries it when supplied", () => {
    expect(mergeConfig({}).oracleCwd).toBeUndefined();
    expect(mergeConfig({ oracleCwd: "/repos/codebase-oracle" }).oracleCwd).toBe(
      "/repos/codebase-oracle",
    );
  });
});

describe("loadConfig", () => {
  it("returns defaults when no path is given", () => {
    expect(loadConfig().opensrcCommand).toBe("opensrc");
  });
  it("loads and merges a JSON config file", () => {
    const file = writeTmp(
      "pattern-scout.config.json",
      JSON.stringify({ defaultRepos: ["zod"] }),
    );
    const c = loadConfig(file);
    expect(c.defaultRepos).toEqual(["zod"]);
    expect(c.opensrcCommand).toBe("opensrc");
  });
  it("throws on a missing file", () => {
    expect(() => loadConfig("/no/such/pattern-scout.config.json")).toThrow(
      /not found/,
    );
  });
  it("throws on invalid JSON", () => {
    const file = writeTmp("bad.json", "{ not json");
    expect(() => loadConfig(file)).toThrow(/not valid JSON/);
  });
  it("throws on a schema violation", () => {
    const file = writeTmp("wrong.json", JSON.stringify({ opensrcCommand: 123 }));
    expect(() => loadConfig(file)).toThrow(/Invalid config/);
  });
});
