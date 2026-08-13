import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { sourcesFreshRule } from "../src/rules/sources-fresh.js";
import type { RunGit } from "../src/types.js";
import {
  createTmpGitRepo,
  docContent,
  writeDoc,
  type TmpGitRepo,
} from "./git-helpers.js";

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

  it("does not flag a source that landed in the same commit as the doc (squash-merge case)", () => {
    // Frontmatter timestamp predates the commit: before the doc-commit
    // comparison existed, this was exactly the stale-on-arrival squash-merge
    // false positive.
    repo.commitFiles(
      [
        {
          relPath: "bundle/doc.md",
          content: docContent({
            type: "concept",
            timestamp: "2026-01-01T00:00:00Z",
            sources: ["source.ts"],
          }),
        },
        { relPath: "source.ts", content: "export const a = 2;\n" },
      ],
      "2026-02-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("does not flag a source when the doc was committed strictly after it (stamp older than both)", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 2;\n",
      "2026-02-01T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2026-03-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("applies the doc-commit comparison to docs in bundle subdirectories", () => {
    repo.commitFiles(
      [
        {
          relPath: "bundle/sub/doc.md",
          content: docContent({
            type: "concept",
            timestamp: "2026-01-01T00:00:00Z",
            sources: ["source.ts"],
          }),
        },
        { relPath: "source.ts", content: "export const a = 2;\n" },
      ],
      "2026-02-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("suppresses only sources at/before the doc's last commit, newer ones stay STALE", () => {
    // Pins the accepted >= semantics for multi-source docs: committing the
    // doc silences drift for every source older than that commit (documented
    // limitation), while a source changed afterwards still warns.
    repo.commitFiles(
      [
        {
          relPath: "bundle/doc.md",
          content: docContent({
            type: "concept",
            timestamp: "2026-01-01T00:00:00Z",
            sources: ["a.ts", "b.ts"],
          }),
        },
        { relPath: "a.ts", content: "export const a = 1;\n" },
        { relPath: "b.ts", content: "export const b = 1;\n" },
      ],
      "2026-02-01T00:00:00Z",
    );
    repo.commitFile("b.ts", "export const b = 2;\n", "2026-03-01T00:00:00Z");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("b.ts");
    expect(findings[0].message).not.toContain("a.ts");
  });

  it("keeps the frontmatter-only comparison for a doc without git history", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 2;\n",
      "2026-02-01T00:00:00Z",
    );
    // writeDoc does not commit: the doc has no git history, so the doc-commit
    // comparison must stay out of the way and the stamp alone decides.
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2026-01-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
  });

  it("still flags STALE when the source changed after the doc's last commit", () => {
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2026-01-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2026-02-01T00:00:00Z",
    );
    repo.commitFile(
      "source.ts",
      "export const a = 3;\n",
      "2026-03-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("STALE");
  });

  it("uses an injected runGit stub instead of a real git process when supplied", () => {
    const stubEpoch = Math.floor(Date.parse("2025-06-01T00:00:00Z") / 1000);
    const docEpoch = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    // The doc's own last-commit epoch must be OLDER than the source's, or the
    // doc-commit freshness comparison would legitimately suppress the STALE
    // finding this test asserts.
    const stubRunGit: RunGit = (args) => {
      if (args[0] !== "log") return null;
      return args[args.length - 1] === "doc.md"
        ? String(docEpoch)
        : String(stubEpoch);
    };

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
