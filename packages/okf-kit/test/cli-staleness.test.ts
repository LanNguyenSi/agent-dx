import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";
import { createTmpGitRepo, writeDoc, type TmpGitRepo } from "./git-helpers.js";

interface JsonReport {
  findings: Array<{ ruleId: string; severity: string; message: string }>;
  summary: { errors: number; warnings: number; notices: number };
}

describe("okf-kit cli staleness (sources-fresh + repo-root auto-detection)", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("auto-detects repoRoot via git when --repo-root is omitted: sources-shape existence and sources-fresh staleness both run", () => {
    repo.commitFile("real.ts", "export const a = 1;\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z", // after the commit: not stale
      sources: ["real.ts", "missing.ts"], // missing.ts: sources-shape existence error
    });

    const result = runCli(["check", path.join(repo.dir, "bundle"), "--json"]);
    expect(result.status).toBe(1);

    const parsed = JSON.parse(result.stdout) as JsonReport;
    expect(
      parsed.findings.some(
        (f) => f.ruleId === "sources-shape" && f.message.includes("missing.ts"),
      ),
    ).toBe(true);
    expect(
      parsed.findings.some(
        (f) =>
          f.ruleId === "sources-fresh" &&
          f.message.includes("not inside a git work tree"),
      ),
    ).toBe(false);
  });

  it("includes sources-fresh findings in --json, and --strict turns a STALE-only bundle into exit 1 while default exits 0", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-12-01T00:00:00Z", // before the commit: stale
      sources: ["source.ts"],
    });

    const defaultRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--json",
    ]);
    expect(defaultRun.status).toBe(0);
    const parsed = JSON.parse(defaultRun.stdout) as JsonReport;
    expect(
      parsed.findings.some(
        (f) => f.ruleId === "sources-fresh" && f.severity === "warning",
      ),
    ).toBe(true);
    expect(parsed.summary.warnings).toBeGreaterThan(0);
    expect(parsed.summary.errors).toBe(0);

    const strictRun = runCli([
      "check",
      path.join(repo.dir, "bundle"),
      "--repo-root",
      repo.dir,
      "--strict",
    ]);
    expect(strictRun.status).toBe(1);
  });

  it("skips staleness with a notice when the bundle is not inside a git work tree", () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-plain-"));
    try {
      fs.writeFileSync(
        path.join(plainDir, "source.ts"),
        "export const a = 1;\n",
      );
      writeDoc(plainDir, "doc.md", {
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const result = runCli(["check", plainDir, "--json"]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as JsonReport;
      expect(
        parsed.findings.some(
          (f) =>
            f.ruleId === "sources-fresh" &&
            f.message.includes("not inside a git work tree"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
