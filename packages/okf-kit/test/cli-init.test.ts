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

  it("init-then-check --strict reports no finding for incident-template.md", () => {
    const bundleDir = path.join(workDir, "docs", "okf");
    const fakeRepoRoot = path.join(workDir, "fake-repo-root");
    expect(runCli(["init", bundleDir]).status).toBe(0);
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
      "--strict",
      "--json",
    ]);
    const parsed = JSON.parse(checkResult.stdout) as {
      findings: Array<{ ruleId: string; file: string }>;
    };
    const incidentFindings = parsed.findings.filter(
      (f) => f.file === "incident-template.md",
    );
    expect(incidentFindings).toEqual([]);
  });

  it("a filled incident doc copied from the template is clean under check --strict", () => {
    const bundleDir = path.join(workDir, "docs", "okf");
    const fakeRepoRoot = path.join(workDir, "fake-repo-root");
    expect(runCli(["init", bundleDir]).status).toBe(0);
    fs.mkdirSync(path.join(fakeRepoRoot, "path", "to", "covered"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fakeRepoRoot, "path", "to", "covered", "source"),
      "placeholder\n",
    );

    const template = fs.readFileSync(
      path.join(bundleDir, "incident-template.md"),
      "utf8",
    );
    const filled = template
      .replace("title: <short symptom>", "title: Export drops the last row")
      .replace(
        "description: <one line>",
        "description: CSV export lost its final row for one release.",
      )
      .replace(
        "area: <cluster key, ideally the topic of a runbook>",
        "area: export",
      )
      .replace(
        "root_cause: <term from the bundle's vocabulary>",
        "root_cause: off-by-one",
      )
      .replace(
        "escape_reason: <why checks before release did not catch it>",
        "escape_reason: no test covered an export with an odd row count",
      )
      .replace(
        "applies_when: <the kind of work where this lesson matters>",
        "applies_when: changing pagination or export loops",
      )
      .replace(
        "rule: <what to do differently>",
        "rule: test exports with 0, 1 and n+1 rows",
      )
      .replace(
        "check: <how to verify it>",
        "check: export tests include an odd row count",
      )
      .replace("status: proposed", "status: adopted")
      .replace(
        "    # runbook: <path of the runbook that adopted this lesson, once adopted>",
        "    runbook: runbook-template.md",
      );
    expect(filled).toContain("runbook: runbook-template.md");
    expect(filled).not.toContain("<short symptom>");
    fs.writeFileSync(path.join(bundleDir, "incident-example.md"), filled);

    const checkResult = runCli([
      "check",
      bundleDir,
      "--repo-root",
      fakeRepoRoot,
      "--strict",
      "--json",
    ]);
    const parsed = JSON.parse(checkResult.stdout) as {
      findings: Array<{ ruleId: string; file: string; message: string }>;
    };
    const exampleFindings = parsed.findings.filter(
      (f) => f.file === "incident-example.md",
    );
    expect(exampleFindings).toEqual([]);
  });

  it("init inside a real git repo, then check (auto-detect) reports exactly 4 sources-shape errors for the unresolved placeholders, exit 1", () => {
    const repo: TmpGitRepo = createTmpGitRepo();
    try {
      const bundleDir = path.join(repo.dir, "docs", "okf");
      const initResult = runCli(["init", bundleDir]);
      expect(initResult.status).toBe(0);

      // No --repo-root: this is docs/init.md's "Placeholder sources are
      // intentional" promise, that a freshly scaffolded bundle inside a
      // real git repo is red-first
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

  it("init --spec v0.2 output passes check through the built CLI", () => {
    const bundleDir = path.join(workDir, "docs-v02", "okf");
    const fakeRepoRoot = path.join(workDir, "fake-repo-root");

    const initResult = runCli(["init", "--spec", "v0.2", bundleDir]);
    expect(initResult.status).toBe(0);
    const indexRaw = fs.readFileSync(path.join(bundleDir, "index.md"), "utf8");
    expect(indexRaw.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);

    // Same placeholder-resolution trick as the v0.1 round trip above, so
    // the run does not depend on ambient git.
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
    expect(parsed.summary.warnings).toBe(0);
  });

  it("init --spec with an invalid version is a usage error (exit 2)", () => {
    const bundleDir = path.join(workDir, "docs-badspec", "okf");
    const result = runCli(["init", "--spec", "v0.3", bundleDir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--spec must be one of v0.1, v0.2");
    expect(fs.existsSync(bundleDir)).toBe(false);
  });
});
