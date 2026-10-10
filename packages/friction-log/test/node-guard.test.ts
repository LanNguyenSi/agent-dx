import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSupportedNode,
  nodeGuardMessage,
  parseMinMajor,
  readEnginesNode,
} from "../src/node-guard.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseMinMajor", () => {
  it("reads the major from a >= range", () => {
    expect(parseMinMajor(">=22")).toBe(22);
    expect(parseMinMajor(">=22.1.0")).toBe(22);
    expect(parseMinMajor(" >= 20 ")).toBe(20);
  });
  it("returns null for other shapes", () => {
    expect(parseMinMajor("^22")).toBeNull();
    expect(parseMinMajor("")).toBeNull();
  });
});

describe("isSupportedNode", () => {
  it("compares the major numerically", () => {
    expect(isSupportedNode("20.19.0", 22)).toBe(false);
    expect(isSupportedNode("9.0.0", 22)).toBe(false);
    expect(isSupportedNode("22.0.0", 22)).toBe(true);
    expect(isSupportedNode("v26.6.0", 22)).toBe(true);
  });
});

describe("nodeGuardMessage", () => {
  it("names the required and the running version when too old", () => {
    const msg = nodeGuardMessage("20.19.0", ">=22");
    expect(msg).toContain(">=22");
    expect(msg).toContain("20.19.0");
  });
  it("returns null on a supported version", () => {
    expect(nodeGuardMessage("22.3.1", ">=22")).toBeNull();
  });
  it("reads the required range from package.json engines", () => {
    expect(readEnginesNode()).toMatch(/^>=\d+/);
  });
});

describe("entry module", () => {
  it("refuses an old Node with exit 1 and a stderr message before loading the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "fl-guard-"));
    try {
      const preload = join(dir, "fake-node-20.mjs");
      writeFileSync(
        preload,
        `Object.defineProperty(process.versions, "node", { value: "20.19.0", configurable: true });`,
      );
      const r = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          preload,
          join(root, "src/cli.ts"),
          "list",
        ],
        { encoding: "utf8", cwd: root, env: { ...process.env, HOME: dir } },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(">=22");
      expect(r.stderr).toContain("20.19.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
