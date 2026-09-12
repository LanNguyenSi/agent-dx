import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { sourcesFreshRule } from "../src/rules/sources-fresh.js";
import {
  createTmpGitRepo,
  docContent,
  writeDoc,
  type TmpGitRepo,
} from "./git-helpers.js";

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
 *
 * The doc itself is always committed and left clean in the tests below
 * (unless a test is specifically about the doc's own dirty state), so a
 * source-only dirty edit is never accidentally rescued by the working-tree
 * re-stamp parity covered in the "doc re-stamped locally" describe block --
 * an UNTRACKED doc counts as re-stamped too (see isDocLocallyRestamped's
 * doc comment in src/rules/sources-fresh.ts), which a never-committed doc
 * fixture would trigger unconditionally.
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
    // Doc committed and left clean: this test is about a dirty SOURCE only.
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-06-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2025-06-01T00:00:00Z",
    );

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
    // Doc committed and left clean: this test is about an untracked SOURCE
    // only, not about the doc's own dirty/untracked state.
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-06-01T00:00:00Z",
        sources: ["untracked-source.ts"],
      }),
      "2025-06-01T00:00:00Z",
    );

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

  it("with the flag: a dirty file under a DIRECTORY source counts the whole directory as dirty", () => {
    repo.commitFile(
      "srcdir/a.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-06-01T00:00:00Z",
        sources: ["srcdir"],
      }),
      "2025-06-01T00:00:00Z",
    );

    fs.writeFileSync(
      path.join(repo.dir, "srcdir/a.ts"),
      "export const a = 2;\n",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("srcdir");
  });

  /**
   * The working-tree analogue of the co-commit re-stamp rescue
   * (`restampedByOwnLastCommit`): a doc re-stamped LOCALLY (uncommitted)
   * must rescue a dirty source under `--dirty-as-now` exactly like a real
   * re-stamp committed together with the source does without the flag --
   * otherwise the README's own recommended remedy ("commit both, matching
   * CI") could not turn a `--dirty-as-now --strict` failure clean. See the
   * HIGH finding in round 1 review: without this rescue, a doc bumped to
   * "now" on disk still read STALE against a dirty source's own
   * `--dirty-as-now` substitution because a few seconds elapse between
   * writing the bump and running `check`.
   */
  describe("doc re-stamped locally (working-tree re-stamp parity)", () => {
    it("with the flag: a dirty source paired with a doc re-stamped locally (uncommitted) reports clean", () => {
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        docContent({
          type: "concept",
          timestamp: "2025-02-01T00:00:00Z",
          sources: ["source.ts"],
        }),
        "2025-02-01T00:00:00Z",
      );

      // Locally dirty the source (uncommitted edit).
      fs.writeFileSync(
        path.join(repo.dir, "source.ts"),
        "export const a = 2;\n",
      );
      // Locally re-stamp the doc (uncommitted): the on-disk timestamp value
      // now differs from the value committed at HEAD.
      writeDoc(repo.dir, "bundle/doc.md", {
        type: "concept",
        timestamp: "2025-09-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("with the flag: a dirty source paired with a doc that is dirty but NOT locally re-stamped stays STALE", () => {
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      const committedDoc = docContent({
        type: "concept",
        timestamp: "2025-02-01T00:00:00Z",
        sources: ["source.ts"],
      });
      repo.commitFile("bundle/doc.md", committedDoc, "2025-02-01T00:00:00Z");

      fs.writeFileSync(
        path.join(repo.dir, "source.ts"),
        "export const a = 2;\n",
      );
      // Locally dirty the doc's BODY only, leaving the frontmatter (and
      // therefore its parsed `timestamp` value) byte-for-byte identical to
      // the committed version: dirty, but not re-stamped.
      const dirtyButNotRestamped = committedDoc.replace(
        "# Doc\n",
        "# Doc\n\nA local note, not a re-stamp.\n",
      );
      expect(dirtyButNotRestamped).not.toEqual(committedDoc);
      fs.writeFileSync(
        path.join(repo.dir, "bundle/doc.md"),
        dirtyButNotRestamped,
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("STALE");
      expect(findings[0].message).toContain("source.ts");
    });

    it("control, flag OFF: committing the same source-edit-plus-re-stamp together reports clean (what the flag is matching)", () => {
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        docContent({
          type: "concept",
          timestamp: "2025-02-01T00:00:00Z",
          sources: ["source.ts"],
        }),
        "2025-02-01T00:00:00Z",
      );

      // Same edits as the "reports clean" case above, but landed together
      // in one real commit instead of left dirty.
      repo.commitFiles(
        [
          { relPath: "source.ts", content: "export const a = 2;\n" },
          {
            relPath: "bundle/doc.md",
            content: docContent({
              type: "concept",
              timestamp: "2025-09-01T00:00:00Z",
              sources: ["source.ts"],
            }),
          },
        ],
        "2025-09-01T00:00:00Z",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      // Flag deliberately omitted: this is the committed-history control.
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });
  });
});
