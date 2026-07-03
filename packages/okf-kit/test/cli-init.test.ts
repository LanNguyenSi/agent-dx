import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";
import { createTmpGitRepo, type TmpGitRepo } from "./git-helpers.js";

interface JsonReport {
  findings: Array<{ ruleId: string; message: string }>;
  summary: { errors: number; warnings: number; notices: number };
}

describe("okf-kit cli init", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-cli-init-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("init-then-check round trip yields zero errors once the placeholder resolves, regardless of ambient git context", () => {
    const bundleDir = path.join(workDir, "docs", "okf");
    const fakeRepoRoot = path.join(workDir, "fake-repo-root");

    const initResult = runCli(["init", bundleDir]);
    expect(initResult.status).toBe(0);
    expect(initResult.stdout).toContain("Scaffolded OKF bundle");
    expect(initResult.stdout).toContain("sources-shape");

    // Make the `path/to/covered/source` placeholder resolve to a real file
    // under an explicit --repo-root that is NOT itself a git repo. This
    // does not depend on os.tmpdir() happening to sit outside any ambient
    // git work tree: --repo-root is explicit, so auto-detection never
    // runs, and existence resolution depends only on this directory.
    fs.mkdirSync(path.join(fakeRepoRoot, "path", "to", "covered"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fakeRepoRoot, "path", "to", "covered", "source"),
      "placeholder\n",
    );

    const checkResult = runCli([
      "check",
      bundleDir,
      "--repo-root",
      fakeRepoRoot,
      "--json",
    ]);
    expect(checkResult.status).toBe(0);
    const parsed = JSON.parse(checkResult.stdout) as JsonReport;
    expect(parsed.summary.errors).toBe(0);
  });

  it("init inside a real git repo, then check (auto-detect) reports exactly 4 sources-shape errors for the unresolved placeholders, exit 1", () => {
    const repo: TmpGitRepo = createTmpGitRepo();
    try {
      const bundleDir = path.join(repo.dir, "docs", "okf");
      const initResult = runCli(["init", bundleDir]);
      expect(initResult.status).toBe(0);

      // No --repo-root: this is the README's central promise, that a
      // freshly scaffolded bundle inside a real git repo is red-first
      // (auto-detected repo root, unresolved placeholders flagged) until
      // the placeholders are replaced with real paths.
      const checkResult = runCli(["check", bundleDir, "--json"]);
      expect(checkResult.status).toBe(1);
      const parsed = JSON.parse(checkResult.stdout) as JsonReport;

      const placeholderErrors = parsed.findings.filter(
        (f) =>
          f.ruleId === "sources-shape" &&
          f.message.includes("path/to/covered/source"),
      );
      expect(placeholderErrors).toHaveLength(4);
      expect(parsed.summary.errors).toBe(4);
    } finally {
      repo.cleanup();
    }
  });

  it("uses docs/okf as the default target directory relative to cwd", () => {
    const initResult = runCli(["init"], workDir);
    expect(initResult.status).toBe(0);
    expect(fs.existsSync(path.join(workDir, "docs", "okf", "index.md"))).toBe(
      true,
    );
  });

  it("refuses on an existing non-empty target dir without --force, exit 2 with a clear message", () => {
    const bundleDir = path.join(workDir, "bundle");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "keep-me.txt"), "pre-existing\n");

    const result = runCli(["init", bundleDir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not empty");
    expect(result.stderr).toContain("--force");
  });

  it("exits 2 when the target path exists and is a file, not a directory", () => {
    const targetPath = path.join(workDir, "not-a-dir");
    fs.writeFileSync(targetPath, "I am a file\n");

    const result = runCli(["init", targetPath]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a directory");
  });

  it("succeeds with --force on the same non-empty target dir", () => {
    const bundleDir = path.join(workDir, "bundle-forced");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "keep-me.txt"), "pre-existing\n");

    const result = runCli(["init", bundleDir, "--force"]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(bundleDir, "index.md"))).toBe(true);
    expect(fs.readFileSync(path.join(bundleDir, "keep-me.txt"), "utf8")).toBe(
      "pre-existing\n",
    );
  });
});
