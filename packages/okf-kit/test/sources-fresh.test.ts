import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { sourcesFreshRule } from "../src/rules/sources-fresh.js";
import type { RunGit } from "../src/types.js";
import { createTmpGitRepo, writeDoc, type TmpGitRepo } from "./git-helpers.js";

describe("sources-fresh", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("flags a source committed after the doc's timestamp as STALE", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-12-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("source.ts");
  });

  it("does not flag a source when the doc timestamp is after the source's last commit", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("bumping the doc timestamp above the commit time makes the STALE finding disappear", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );

    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-12-01T00:00:00Z",
      sources: ["source.ts"],
    });
    const staleCtx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(staleCtx)).toHaveLength(1);

    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-06-01T00:00:00Z",
      sources: ["source.ts"],
    });
    const freshCtx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(freshCtx)).toEqual([]);
  });

  it("does not flag a source committed at exactly the doc's timestamp second (pins > over >=)", () => {
    const boundary = "2026-03-15T12:00:00Z";
    repo.commitFile("source.ts", "export const a = 1;\n", boundary);
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: boundary,
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("flags an untracked source path as a notice, not STALE", () => {
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 1;\n");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "notice",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("untracked");
  });

  it("flags a missing or unparseable timestamp as a notice, not STALE, exactly once per doc", () => {
    repo.commitFile("a.ts", "export const a = 1;\n", "2026-01-01T00:00:00Z");
    repo.commitFile("b.ts", "export const b = 1;\n", "2026-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "not-a-date",
      sources: ["a.ts", "b.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "notice",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("no valid timestamp");
  });

  it("leaves a missing source path on disk to sources-shape (no S1 finding)", () => {
    repo.commitFile("real.ts", "export const a = 1;\n", "2025-01-01T00:00:00Z");
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["does-not-exist.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("emits exactly one bundle-level notice when repoRoot is not a git work tree", () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-plain-"));
    try {
      writeDoc(plainDir, "doc.md", {
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(plainDir, undefined);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("sources-fresh");
      expect(findings[0].severity).toBe("notice");
      expect(findings[0].message).toContain("not inside a git work tree");
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("finds zero violations when no doc declares sources", () => {
    writeDoc(repo.dir, "bundle/doc.md", { type: "concept" });
    const ctx = loadBundle(path.join(repo.dir, "bundle"), undefined);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("uses an injected runGit stub instead of a real git process when supplied", () => {
    const stubEpoch = Math.floor(Date.parse("2025-06-01T00:00:00Z") / 1000);
    const stubRunGit: RunGit = (args) =>
      args[0] === "log" ? String(stubEpoch) : null;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-stub-"));
    try {
      fs.writeFileSync(path.join(dir, "source.ts"), "export const a = 1;\n");
      writeDoc(dir, "doc.md", {
        type: "concept",
        timestamp: "2020-01-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(dir, dir, stubRunGit);
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(findings[0].message).toContain("STALE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
