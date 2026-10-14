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
  "incident-template.md",
  "benchmark-template.md",
];

const TYPE_BY_TEMPLATE: Record<string, string> = {
  "overview-template.md": "overview",
  "module-template.md": "module",
  "invariant-template.md": "invariant",
  "runbook-template.md": "runbook",
  "incident-template.md": "incident",
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

  it("refuses when the target path exists and is a file, not a directory", () => {
    const targetPath = path.join(workDir, "not-a-dir");
    fs.writeFileSync(targetPath, "I am a file\n");

    expect(() => runInit(targetPath)).toThrow(UsageError);
    // Must not have touched or replaced the file.
    expect(fs.statSync(targetPath).isDirectory()).toBe(false);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("I am a file\n");
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

  it("stamps every doc's frontmatter timestamp and the log.md entry with the exact injected `now`, proving the seam is wired", () => {
    const fixed = new Date("2030-05-17T08:15:30.000Z");
    const targetDir = path.join(workDir, "fixed-now");
    runInit(targetDir, { now: () => fixed });

    const ctx = loadBundle(targetDir);
    const timestamped = ctx.docs.filter((d) => d.frontmatter.present);
    expect(timestamped.length).toBeGreaterThan(0);
    for (const doc of timestamped) {
      const parsed = doc.frontmatter.parsed as { timestamp?: unknown };
      expect(parsed.timestamp).toBe(fixed.toISOString());
    }

    const logRaw = fs.readFileSync(path.join(targetDir, "log.md"), "utf8");
    expect(logRaw).toContain(fixed.toISOString());
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

  it("incident-template.md has no `sources` key and carries the lesson fields", () => {
    const targetDir = path.join(workDir, "incident-fields");
    runInit(targetDir);
    const ctx = loadBundle(targetDir);
    const incident = ctx.docs.find((d) => d.relPath === "incident-template.md");
    const parsed = incident?.frontmatter.parsed as Record<string, unknown>;
    expect("sources" in parsed).toBe(false);
    expect(parsed.type).toBe("incident");
    for (const key of [
      "area",
      "root_cause",
      "escape_reason",
      "applies_when",
      "related",
    ]) {
      expect(key in parsed, key).toBe(true);
    }
    const lessons = parsed.lessons as Array<Record<string, unknown>>;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ id: "L1", status: "proposed" });
    expect("runbook" in lessons[0]).toBe(false);
    const raw = fs.readFileSync(
      path.join(targetDir, "incident-template.md"),
      "utf8",
    );
    expect(raw).toContain("No personal data");
    expect(raw).toContain("never the reverse");
  });

  it("no generated file contains an absolute (leading-slash) link", () => {
    const targetDir = path.join(workDir, "links");
    runInit(targetDir);
    for (const name of SCAFFOLD_FILENAMES) {
      const raw = fs.readFileSync(path.join(targetDir, name), "utf8");
      expect(raw).not.toContain("](/");
    }
  });

  it("v0.1 scaffold content is pinned byte-for-byte (default and explicit --spec v0.1)", () => {
    const fixed = new Date("2030-05-17T08:15:30.000Z");
    const defaultDir = path.join(workDir, "v01-default");
    const explicitDir = path.join(workDir, "v01-explicit");
    runInit(defaultDir, { now: () => fixed });
    runInit(explicitDir, { now: () => fixed, spec: "v0.1" });

    const contents: Record<string, string> = {};
    for (const name of SCAFFOLD_FILENAMES) {
      const raw = fs.readFileSync(path.join(defaultDir, name), "utf8");
      // The explicit flag and its absence write identical bytes.
      expect(fs.readFileSync(path.join(explicitDir, name), "utf8"), name).toBe(
        raw,
      );
      contents[name] = raw;
    }
    // Snapshot of the exact v0.1 bytes, so no refactor of the template
    // functions (which all grew a spec parameter) can silently move the
    // v0.1 scaffold.
    expect(contents).toMatchSnapshot();
  });

  it("--spec v0.2 declares okf_version in the root index.md and uses generated instead of timestamp", () => {
    const fixed = new Date("2030-05-17T08:15:30.000Z");
    const targetDir = path.join(workDir, "v02");
    runInit(targetDir, { now: () => fixed, spec: "v0.2" });

    const ctx = loadBundle(targetDir);
    expect(ctx.specVersion).toBe("v0.2");

    const index = ctx.docs.find((d) => d.relPath === "index.md");
    expect(index?.frontmatter.present).toBe(true);
    expect(index?.frontmatter.parsed).toEqual({ okf_version: "0.2" });

    const log = ctx.docs.find((d) => d.relPath === "log.md");
    expect(log?.frontmatter.present).toBe(false);

    for (const filename of Object.keys(TYPE_BY_TEMPLATE)) {
      const doc = ctx.docs.find((d) => d.relPath === filename);
      const parsed = doc?.frontmatter.parsed as Record<string, unknown>;
      expect("timestamp" in parsed, filename).toBe(false);
      const generated = parsed.generated as Record<string, unknown>;
      expect(generated.at, filename).toBe(fixed.toISOString());
      // A placeholder that already matches the human:<id> shape, so the
      // scaffold itself checks clean under generated-shape.
      expect(generated.by, filename).toBe("human:<id>");
    }

    // The v0.2 scaffold must differ from the v0.1 bytes only where the
    // version block and the stamp block live; every other line matches.
    const v01Dir = path.join(workDir, "v02-vs-v01");
    runInit(v01Dir, { now: () => fixed });
    const indexV01 = fs.readFileSync(path.join(v01Dir, "index.md"), "utf8");
    const indexV02 = fs.readFileSync(path.join(targetDir, "index.md"), "utf8");
    expect(indexV02).toBe('---\nokf_version: "0.2"\n---\n\n' + indexV01);
    expect(fs.readFileSync(path.join(targetDir, "log.md"), "utf8")).toBe(
      fs.readFileSync(path.join(v01Dir, "log.md"), "utf8"),
    );
  });
});
