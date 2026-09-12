import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runGit as realRunGit } from "../src/git.js";
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
   * Regression: the per-run `git status` refactor matched a directory
   * source against dirty paths using the RAW frontmatter spelling, so a
   * trailing-slash or leading-`./` spelling of the exact same directory
   * silently lost dirty detection (a `srcdir/` source built a
   * self-defeating `srcdir//` prefix; `./srcdir` never matches a `git
   * status` path, which never carries a `./` prefix). Both spellings must
   * report the identical STALE finding the bare `srcdir` spelling does
   * above.
   */
  it("with the flag: a directory source spelled with a trailing slash (`srcdir/`) still counts a dirty file under it", () => {
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
        sources: ["srcdir/"],
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
  });

  it("with the flag: a directory source spelled with a leading `./` (`./srcdir`) still counts a dirty file under it", () => {
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
        sources: ["./srcdir"],
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
  });

  /**
   * Directory-prefix boundary: a dirty path in a SIBLING directory whose
   * name merely starts with the same characters (`srcdirX/x.ts` vs the
   * `srcdir` source) must never match. The dirty-match prefix is
   * `${normalized}/`, so `srcdirX/...` (no slash right after `srcdir`)
   * never satisfies it.
   */
  it("with the flag: a dirty file in a sibling directory sharing a name prefix (`srcdirX/`) does NOT count the `srcdir` source as dirty", () => {
    repo.commitFile(
      "srcdir/a.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    repo.commitFile(
      "srcdirX/x.ts",
      "export const x = 1;\n",
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

    // Only the sibling directory is dirtied; `srcdir` itself is untouched.
    fs.writeFileSync(
      path.join(repo.dir, "srcdirX/x.ts"),
      "export const x = 2;\n",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    expect(sourcesFreshRule.run(ctx)).toEqual([]);
  });

  /**
   * A `git status` call that FAILS outright (not: succeeds with nothing
   * dirty) must not be confused with "everything is dirty" (which would
   * wrongly clean up genuinely stale docs) nor swallow the rule's ordinary,
   * committed-history-only STALE detection. This source is stale by real
   * committed history ALONE (its commit postdates the doc's `timestamp`,
   * with neither file actually left dirty on disk), so the correct
   * fallback -- "judge by the real commit epoch, as if `--dirty-as-now`
   * were simply unable to answer" -- must still report it, unaffected by
   * the failed status call, and the STALE epoch reported must be the
   * REAL commit time, never the shared "now" instant a dirty verdict would
   * substitute.
   */
  it("with the flag: an injected RunGit failing only the status call still reports the ordinary committed-history STALE verdict", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-12-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2025-12-01T00:00:00Z",
    );
    // A second, later commit on the source: stale by committed history
    // alone, no working-tree dirt involved at all.
    repo.commitFile(
      "source.ts",
      "export const a = 2;\n",
      "2026-01-01T00:00:00Z",
    );

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    ctx.runGit = (args, cwd) => {
      if (args.includes("status")) return null;
      return realRunGit(args, cwd);
    };

    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
    // The REAL commit epoch (2026-01-01), not a "now" substitution: a
    // failed status call must not be treated as "this path is dirty".
    expect(findings[0].message).toContain("2026-01-01");
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
