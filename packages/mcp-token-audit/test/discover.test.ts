import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findTranscriptFiles } from "../src/discover.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-token-audit-discover-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("findTranscriptFiles", () => {
  it("collects only *.jsonl files directly under each given project dir", () => {
    const projDir = join(tmp, "proj-a");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "s1.jsonl"), "{}\n");
    writeFileSync(join(projDir, "s2.jsonl"), "{}\n");
    writeFileSync(join(projDir, "notes.txt"), "not a transcript");

    const { files, skippedDirs } = findTranscriptFiles([projDir]);
    expect(files.sort()).toEqual(
      [join(projDir, "s1.jsonl"), join(projDir, "s2.jsonl")].sort(),
    );
    expect(skippedDirs).toBe(0);
  });

  it("skips a project dir that does not exist and counts it in skippedDirs, instead of failing the whole run", () => {
    const { files, skippedDirs } = findTranscriptFiles([join(tmp, "nope")]);
    expect(files).toEqual([]);
    expect(skippedDirs).toBe(1);
  });

  it("still returns files from readable dirs when another dir is unreadable", () => {
    const projDir = join(tmp, "proj-good");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "s1.jsonl"), "{}\n");

    const { files, skippedDirs } = findTranscriptFiles([
      join(tmp, "nope-1"),
      projDir,
      join(tmp, "nope-2"),
    ]);
    expect(files).toEqual([join(projDir, "s1.jsonl")]);
    expect(skippedDirs).toBe(2);
  });

  it("filters by mtime when --days is given", () => {
    const projDir = join(tmp, "proj-b");
    mkdirSync(projDir, { recursive: true });
    const fresh = join(projDir, "fresh.jsonl");
    const stale = join(projDir, "stale.jsonl");
    writeFileSync(fresh, "{}\n");
    writeFileSync(stale, "{}\n");

    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(stale, tenDaysAgo, tenDaysAgo);

    const { files } = findTranscriptFiles([projDir], 1);
    expect(files).toEqual([fresh]);
  });
});

describe("defaultProjectDirs", () => {
  it("lists only directories under ~/.claude/projects, sorted", async () => {
    vi.resetModules();
    const fakeHome = mkdtempSync(join(tmpdir(), "mcp-token-audit-home-"));
    mkdirSync(join(fakeHome, ".claude", "projects", "proj-z"), {
      recursive: true,
    });
    mkdirSync(join(fakeHome, ".claude", "projects", "proj-a"), {
      recursive: true,
    });
    writeFileSync(join(fakeHome, ".claude", "projects", "stray-file"), "x");

    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return { ...actual, homedir: () => fakeHome };
    });
    const { defaultProjectDirs: mockedDefaultProjectDirs } =
      await import("../src/discover.js");

    expect(mockedDefaultProjectDirs()).toEqual([
      join(fakeHome, ".claude", "projects", "proj-a"),
      join(fakeHome, ".claude", "projects", "proj-z"),
    ]);

    vi.doUnmock("node:os");
    vi.resetModules();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("returns an empty array when ~/.claude/projects does not exist", async () => {
    vi.resetModules();
    const fakeHome = mkdtempSync(join(tmpdir(), "mcp-token-audit-home-empty-"));
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return { ...actual, homedir: () => fakeHome };
    });
    const { defaultProjectDirs: mockedDefaultProjectDirs } =
      await import("../src/discover.js");

    expect(mockedDefaultProjectDirs()).toEqual([]);

    vi.doUnmock("node:os");
    vi.resetModules();
    rmSync(fakeHome, { recursive: true, force: true });
  });
});
