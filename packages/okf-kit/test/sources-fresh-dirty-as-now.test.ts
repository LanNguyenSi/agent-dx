import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { sourcesFreshRule } from "../src/rules/sources-fresh.js";
import { createTmpGitRepo, writeDoc, type TmpGitRepo } from "./git-helpers.js";

/**
 * `--dirty-as-now` (`ctx.dirtyAsNow`): a source with an uncommitted change
 * has no "last commit" that reflects its current content yet, so a plain
 * `check` run (which only sees committed history) can under-report
 * staleness that CI will report once the edit is committed -- the exact gap
 * behind the "re-stamp, commit, then measure" discipline (see the README's
 * "Staleness (sources-fresh)" section). These tests build a fixture where a
 * source was committed BEFORE the doc's `timestamp` (so it is fresh by
 * committed history alone), then dirty the source on disk without
 * committing: the flag is the only thing that turns that dirty edit into a
 * STALE finding.
 */
describe("sources-fresh: --dirty-as-now", () => {
  let repo: TmpGitRepo;

  beforeEach(() => {
    repo = createTmpGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("without the flag: a dirty source older-by-history than the doc timestamp stays unreported (the gap this flag closes)", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["source.ts"],
    });

    // Dirty the source on disk -- modified, uncommitted -- without touching
    // its git history.
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 2;\n");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  it("with the flag: the same dirty source is reported sources-fresh stale", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["source.ts"],
    });

    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 2;\n");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
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

  it("with the flag: an untracked (never-committed) source is also treated as dirty-as-now", () => {
    fs.writeFileSync(
      path.join(repo.dir, "untracked-source.ts"),
      "export const a = 1;\n",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["untracked-source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("untracked-source.ts");
  });

  it("with the flag: a clean (committed, unmodified) source is unaffected", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });
});
