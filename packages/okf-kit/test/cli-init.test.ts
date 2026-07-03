import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";

describe("okf-kit cli init", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-cli-init-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("init-then-check round trip in a non-git tmp dir yields zero errors", () => {
    const bundleDir = path.join(workDir, "docs", "okf");

    const initResult = runCli(["init", bundleDir]);
    expect(initResult.status).toBe(0);
    expect(initResult.stdout).toContain("Scaffolded OKF bundle");
    expect(initResult.stdout).toContain("sources-shape");

    // No --repo-root and workDir is a plain (non-git) tmp dir: existence
    // and staleness checks are inactive by design, only shape checks run.
    const checkResult = runCli(["check", bundleDir, "--json"]);
    expect(checkResult.status).toBe(0);
    const parsed = JSON.parse(checkResult.stdout) as {
      summary: { errors: number; warnings: number; notices: number };
    };
    expect(parsed.summary.errors).toBe(0);
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
