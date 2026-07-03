import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { UsageError } from "../src/errors.js";
import { runInit } from "../src/init.js";

const SCAFFOLD_FILENAMES = [
  "index.md",
  "log.md",
  "overview-template.md",
  "module-template.md",
  "invariant-template.md",
  "runbook-template.md",
  "benchmark-template.md",
];

const TYPE_BY_TEMPLATE: Record<string, string> = {
  "overview-template.md": "overview",
  "module-template.md": "module",
  "invariant-template.md": "invariant",
  "runbook-template.md": "runbook",
  "benchmark-template.md": "benchmark",
};

describe("runInit", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-init-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("creates all scaffold files, creating missing parent directories", () => {
    const targetDir = path.join(workDir, "a", "b", "docs", "okf");
    const result = runInit(targetDir);

    expect(result.targetDir).toBe(path.resolve(targetDir));
    expect(result.filesWritten.sort()).toEqual([...SCAFFOLD_FILENAMES].sort());
    for (const name of SCAFFOLD_FILENAMES) {
      expect(fs.existsSync(path.join(targetDir, name))).toBe(true);
    }
  });

  it("succeeds without --force on an existing empty directory", () => {
    const targetDir = path.join(workDir, "empty");
    fs.mkdirSync(targetDir);
    expect(() => runInit(targetDir)).not.toThrow();
    expect(fs.existsSync(path.join(targetDir, "index.md"))).toBe(true);
  });

  it("refuses on an existing non-empty target directory without --force, and writes nothing", () => {
    const targetDir = path.join(workDir, "nonempty");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "keep-me.txt"), "pre-existing\n");

    expect(() => runInit(targetDir)).toThrow(UsageError);
    // Refusal must be all-or-nothing: no partial scaffold on top of the
    // pre-existing file.
    expect(fs.existsSync(path.join(targetDir, "index.md"))).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, "keep-me.txt"), "utf8")).toBe(
      "pre-existing\n",
    );
  });

  it("with --force, overwrites only the files it owns and leaves other files alone", () => {
    const targetDir = path.join(workDir, "nonempty-forced");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "keep-me.txt"), "pre-existing\n");
    fs.writeFileSync(path.join(targetDir, "index.md"), "stale content\n");

    expect(() => runInit(targetDir, { force: true })).not.toThrow();

    expect(fs.readFileSync(path.join(targetDir, "keep-me.txt"), "utf8")).toBe(
      "pre-existing\n",
    );
    expect(fs.readFileSync(path.join(targetDir, "index.md"), "utf8")).not.toBe(
      "stale content\n",
    );
    for (const name of SCAFFOLD_FILENAMES) {
      expect(fs.existsSync(path.join(targetDir, name))).toBe(true);
    }
  });

  it("every generated file's timestamp (where present) is a valid ISO string within a few minutes of now", () => {
    const targetDir = path.join(workDir, "timestamps");
    const before = Date.now();
    runInit(targetDir);
    const after = Date.now();

    const ctx = loadBundle(targetDir);
    const timestamped = ctx.docs.filter((d) => d.frontmatter.present);
    expect(timestamped.length).toBeGreaterThan(0);
    for (const doc of timestamped) {
      const parsed = doc.frontmatter.parsed as { timestamp?: unknown };
      expect(typeof parsed.timestamp).toBe("string");
      const ms = Date.parse(parsed.timestamp as string);
      expect(Number.isNaN(ms)).toBe(false);
      expect(ms).toBeGreaterThanOrEqual(before - 1000);
      expect(ms).toBeLessThanOrEqual(after + 1000);
    }
  });

  it("reserved files (index.md, log.md) carry no frontmatter", () => {
    const targetDir = path.join(workDir, "reserved");
    runInit(targetDir);
    const ctx = loadBundle(targetDir);

    const index = ctx.docs.find((d) => d.relPath === "index.md");
    const log = ctx.docs.find((d) => d.relPath === "log.md");
    expect(index?.isReserved).toBe(true);
    expect(log?.isReserved).toBe(true);
    expect(index?.frontmatter.present).toBe(false);
    expect(log?.frontmatter.present).toBe(false);
  });

  it("every non-reserved generated file has type frontmatter matching its intended type", () => {
    const targetDir = path.join(workDir, "types");
    runInit(targetDir);
    const ctx = loadBundle(targetDir);

    for (const [filename, expectedType] of Object.entries(TYPE_BY_TEMPLATE)) {
      const doc = ctx.docs.find((d) => d.relPath === filename);
      expect(doc, `${filename} should exist`).toBeDefined();
      expect(doc?.isReserved).toBe(false);
      const parsed = doc?.frontmatter.parsed as { type?: unknown };
      expect(parsed.type).toBe(expectedType);
    }
  });

  it("benchmark-template.md has no `sources` key", () => {
    const targetDir = path.join(workDir, "benchmark-sources");
    runInit(targetDir);
    const ctx = loadBundle(targetDir);
    const benchmark = ctx.docs.find(
      (d) => d.relPath === "benchmark-template.md",
    );
    const parsed = benchmark?.frontmatter.parsed as Record<string, unknown>;
    expect("sources" in parsed).toBe(false);
  });

  it("no generated file contains an absolute (leading-slash) link", () => {
    const targetDir = path.join(workDir, "links");
    runInit(targetDir);
    for (const name of SCAFFOLD_FILENAMES) {
      const raw = fs.readFileSync(path.join(targetDir, name), "utf8");
      expect(raw).not.toContain("](/");
    }
  });
});
