import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import {
  sourcesFreshFutureRule,
  sourcesFreshRule,
} from "../src/rules/sources-fresh.js";
import {
  createTmpGitRepo,
  docContent,
  writeDoc,
  type TmpGitRepo,
} from "./git-helpers.js";

describe("sources-fresh-future", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("flags a timestamp later than the doc's own last commit (past the skew allowance) as FUTURE-DATED", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    // The doc is committed at 2026-01-01T00:00:00Z, but its frontmatter
    // timestamp claims 2026-01-02, a full day later than its own commit --
    // exactly the "local time written as UTC" mistake this rule catches.
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-01-02T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshFutureRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh-future",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("FUTURE-DATED");
    expect(findings[0].message).toContain("2026-01-02");
    expect(findings[0].message).toContain("2026-01-01");
  });

  it("negative control: a doc stamped after its sources' last commit (and at its own commit) passes both freshness rules", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2026-01-01T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-02-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2026-02-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
    expect(sourcesFreshFutureRule.run(ctx)).toEqual([]);
  });

  it("does not flag a timestamp within the default 10-minute skew allowance of the doc's own commit", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        // 5 minutes after the doc's own commit: inside the default skew.
        timestamp: "2026-01-01T00:05:00Z",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshFutureRule.run(ctx)).toEqual([]);
  });

  it("does not flag a timestamp exactly at the skew boundary (pins > over >=)", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        // Exactly 10 minutes (600s, the default skew) after the commit.
        timestamp: "2026-01-01T00:10:00Z",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshFutureRule.run(ctx)).toEqual([]);
  });

  it("flags a timestamp one second past the skew boundary", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-01-01T00:10:01Z",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshFutureRule.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("FUTURE-DATED");
  });

  it("respects a configured ctx.freshnessFutureSkewSeconds instead of the 10-minute default", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        // 5 minutes after commit: passes under the default 10-minute skew
        // (see the sibling test above), but should be flagged under a
        // tighter, explicitly configured 60-second skew.
        timestamp: "2026-01-01T00:05:00Z",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.freshnessFutureSkewSeconds = 60;
    const findings = sourcesFreshFutureRule.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("skew allowance 60s");
  });

  it("does not flag an uncommitted doc (no own commit yet): unknown, not flagged", () => {
    // writeDoc does not commit; the doc has no git history at all, so
    // there is no real commit time to compare a far-future timestamp
    // against.
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2099-01-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshFutureRule.run(ctx)).toEqual([]);
  });

  it("does not flag a missing or unparseable timestamp (left to sources-fresh's own notice)", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "not-a-date",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshFutureRule.run(ctx)).toEqual([]);
  });

  it("finds zero violations when no doc declares sources", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2099-01-01T00:00:00Z",
      }),
      "2026-01-01T00:00:00Z",
    );
    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshFutureRule.run(ctx)).toEqual([]);
  });

  it("emits no findings (defers to sources-fresh's single bundle-level notice) when repoRoot is not a git work tree", () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-kit-plain-"));
    try {
      writeDoc(plainDir, "doc.md", {
        type: "concept",
        timestamp: "2099-01-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(plainDir, undefined);
      expect(sourcesFreshFutureRule.run(ctx)).toEqual([]);
      // sources-fresh itself still reports the single skip notice.
      expect(sourcesFreshRule.run(ctx)).toHaveLength(1);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("skips (notice) a timestamp with no UTC designator or numeric offset, regardless of gap size", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        // No `Z`, no numeric offset: parses in the local timezone under
        // Date.parse, so it is not reliably comparable against a
        // minutes-wide skew allowance and must be skipped, not assessed.
        timestamp: "2026-01-02T00:00:00",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshFutureRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh-future",
      severity: "notice",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("no UTC designator");
  });

  it("assesses a timestamp with a numeric UTC offset instead of Z", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        // +00:00 is equivalent to Z; still a real offset, so it must be
        // assessed (not skipped) and flags exactly like the Z-suffixed
        // equivalent tested above.
        timestamp: "2026-01-02T00:00:00+00:00",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshFutureRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("FUTURE-DATED");
  });

  it("applies the doc-commit comparison to docs in bundle subdirectories", () => {
    repo.commitFile(
      "bundle/sub/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-01-05T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshFutureRule.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("sub/doc.md");
  });
});
