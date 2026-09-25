import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, runCli } from "./helpers.js";

const REPO_ROOT = path.join(FIXTURES_DIR, "docs-for-bundle");
const BUNDLE_DIR = path.join(REPO_ROOT, "docs");

describe("okf-kit docs-for cli", () => {
  it("exits 0 and lists matching docs, one per line, as text", () => {
    const result = runCli([
      "docs-for",
      BUNDLE_DIR,
      "src/foo.ts",
      "--repo-root",
      REPO_ROOT,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("exact.md: src/foo.ts\nmulti.md: src/foo.ts\n");
  });

  it("exits 0 with an explicit no-match message when nothing matches", () => {
    const result = runCli([
      "docs-for",
      BUNDLE_DIR,
      "src/nope.ts",
      "--repo-root",
      REPO_ROOT,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no bundle doc claims");
  });

  it("emits a stable --json shape", () => {
    const result = runCli([
      "docs-for",
      BUNDLE_DIR,
      "src/dir/nested.ts",
      "--repo-root",
      REPO_ROOT,
      "--json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      bundleDir: string;
      matches: Array<{ doc: string; sources: string[] }>;
    };
    expect(parsed.bundleDir).toBe(BUNDLE_DIR);
    expect(parsed.matches).toEqual([
      { doc: "dirsrc.md", sources: ["src/dir"] },
      { doc: "multi.md", sources: ["src/dir"] },
    ]);
  });

  it("exits 2 when the bundle directory does not exist", () => {
    const result = runCli([
      "docs-for",
      path.join(FIXTURES_DIR, "does-not-exist"),
      "src/foo.ts",
      "--repo-root",
      REPO_ROOT,
    ]);
    expect(result.status).toBe(2);
  });

  it("exits 2 when no path argument is given (commander's own missing-argument error)", () => {
    const result = runCli(["docs-for", BUNDLE_DIR, "--repo-root", REPO_ROOT]);
    expect(result.status).toBe(2);
  });

  it("exits 2 for a given path outside --repo-root", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-kit-docsfor-cli-outside-"),
    );
    try {
      const result = runCli([
        "docs-for",
        BUNDLE_DIR,
        path.join(outside, "src", "foo.ts"),
        "--repo-root",
        REPO_ROOT,
      ]);
      expect(result.status).toBe(2);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("exits 2 on an unknown option", () => {
    const result = runCli([
      "docs-for",
      BUNDLE_DIR,
      "src/foo.ts",
      "--repo-root",
      REPO_ROOT,
      "--bogus",
    ]);
    expect(result.status).toBe(2);
  });
});
