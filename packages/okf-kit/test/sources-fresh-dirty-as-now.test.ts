import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../src/bundle.js";
import { runGit as realRunGit } from "../src/git.js";
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
   * Brand-new UNTRACKED DIRECTORY. Under git's default untracked mode
   * (`normal`), `git status` collapses a new directory into ONE record for
   * the directory itself (`? newdir/`) and never lists the files inside
   * it, while the dirty matcher matches a queried path that IS an entry or
   * is an ANCESTOR of one. A source or doc INSIDE such a directory
   * therefore matched nothing and silently kept its committed-history
   * verdict: `check --dirty-as-now --strict` exited 0 with only the
   * "untracked by git" notice while a plain `check` after committing that
   * same source exited 1 with STALE -- exactly the local/CI divergence
   * this flag exists to close (round-3 review, HIGH). The fix is `-uall`
   * on the status call, so git enumerates every untracked FILE as its own
   * record; these three tests are its regression coverage, one per shape
   * (source in a new dir, doc in a new dir judged future-dated, doc in a
   * new dir rescuing a dirty source).
   */
  it("with the flag: a source inside a brand-new UNTRACKED DIRECTORY is reported STALE, not merely `untracked by git`", () => {
    // The doc is committed and clean; only the new directory is untracked.
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-06-01T00:00:00Z",
        sources: ["newdir/a.ts"],
      }),
      "2025-06-01T00:00:00Z",
    );
    fs.mkdirSync(path.join(repo.dir, "newdir"));
    fs.writeFileSync(
      path.join(repo.dir, "newdir/a.ts"),
      "export const a = 1;\n",
    );
    // Precondition: git really does collapse this into a single
    // directory-level record under its default untracked mode, so the test
    // below fails for the documented reason and not by accident.
    expect(repo.git(["status", "--porcelain=v2"])).toContain("? newdir/");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "warning",
    });
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("newdir/a.ts");
  });

  it("with the flag: a doc inside a brand-new UNTRACKED DIRECTORY is assessed against the virtual now (FUTURE-DATED when stamped an hour ahead)", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    // The whole bundle directory is new and untracked, doc included.
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: new Date(Date.now() + 3600 * 1000).toISOString(),
      sources: ["source.ts"],
    });
    expect(repo.git(["status", "--porcelain=v2"])).toContain("? bundle/");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    const findings = sourcesFreshFutureRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh-future",
      severity: "warning",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("FUTURE-DATED");
  });

  it("with the flag: a doc inside a brand-new UNTRACKED DIRECTORY stamped now rescues a dirty source (both rules clean)", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    // Stamped a few seconds ago rather than exactly now, so the source's
    // virtual epoch is strictly later than the doc `timestamp` and the
    // rescue -- not a coincidental tie -- is what makes this clean.
    writeDoc(repo.dir, "bundle/doc.md", {
      type: "concept",
      timestamp: new Date(Date.now() - 5000).toISOString(),
      sources: ["source.ts"],
    });
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 2;\n");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;

    expect([
      ...sourcesFreshRule.run(ctx),
      ...sourcesFreshFutureRule.run(ctx),
    ]).toEqual([]);
  });

  /**
   * `--repo-root` pointing at a SUBDIRECTORY of the real repository.
   * `git status` reports every path relative to the repository's TOP
   * LEVEL, while a `sources` entry is relative to the passed root, so
   * without rebasing the queried path onto the top level (`git rev-parse
   * --show-prefix`) nothing ever matched and the flag silently no-opped
   * (round-3 review, LOW).
   */
  it("with the flag: a --repo-root naming a SUBDIRECTORY of the repo still matches dirty paths", () => {
    repo.commitFile(
      "sub/source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    repo.commitFile(
      "sub/bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-06-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2025-06-01T00:00:00Z",
    );
    fs.writeFileSync(
      path.join(repo.dir, "sub/source.ts"),
      "export const a = 2;\n",
    );

    const subRoot = path.join(repo.dir, "sub");
    const ctx = loadBundle(path.join(subRoot, "bundle"), subRoot);
    ctx.dirtyAsNow = true;
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("STALE");
    expect(findings[0].message).toContain("source.ts");
  });

  /**
   * `.` (and `./`, and anything else that normalizes to it) names the root
   * directory itself -- a legal `sources` spelling that `git status` never
   * reports as an entry and that no `"./"`-prefix test can match either,
   * so it silently lost dirty detection entirely until it was matched by
   * containment instead (round-3 review, LOW).
   */
  for (const spelling of [".", "./"]) {
    it(`with the flag: a source spelled \`${spelling}\` (the repo root) counts any dirty path under it, and nothing when the tree is clean`, () => {
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        docContent({
          type: "concept",
          timestamp: "2025-06-01T00:00:00Z",
          sources: [spelling],
        }),
        "2025-06-01T00:00:00Z",
      );

      // Control first: a clean work tree must not make the root source
      // dirty just because it is spelled `.`.
      const cleanCtx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      cleanCtx.dirtyAsNow = true;
      expect(sourcesFreshRule.run(cleanCtx)).toEqual([]);

      fs.writeFileSync(
        path.join(repo.dir, "source.ts"),
        "export const a = 2;\n",
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("STALE");
    });
  }

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
   * substitute. It must ALSO say that the flag did not apply: see the
   * dangerous-direction test below for why the fallback alone is not
   * enough.
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

    const warnings = findings.filter((f) => f.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("STALE");
    // The REAL commit epoch (2026-01-01), not a "now" substitution: a
    // failed status call must not be treated as "this path is dirty".
    expect(warnings[0].message).toContain("2026-01-01");
    // ...and the run says the flag did not apply, rather than implying the
    // work tree was simply clean.
    expect(
      findings.filter((f) =>
        f.message.includes("`--dirty-as-now` not applied"),
      ),
    ).toHaveLength(1);
  });

  /**
   * The DANGEROUS direction of the same failure, and the reason the notice
   * above exists (round-3 review, MEDIUM, repeated): here the source IS
   * genuinely dirty and committed history alone says "fresh", so a failed
   * `git status` silently disables the flag and the whole run reports
   * NOTHING -- byte-identical to the output of a run where everything was
   * in order. A user cannot tell "your tree is clean" from "the flag never
   * ran". One bundle-level notice, in the style of the existing "not
   * inside a git work tree" one, is what distinguishes them.
   */
  it("with the flag: a failing status call over a genuinely dirty source reports the not-applied notice instead of an empty finding list", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-06-01T00:00:00Z",
        sources: ["source.ts"],
      }),
      "2025-06-01T00:00:00Z",
    );
    // Genuinely dirty: with a working `git status` this is the STALE case
    // the first test in this file pins.
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 2;\n");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    ctx.runGit = (args, cwd) => {
      if (args.includes("status")) return null;
      return realRunGit(args, cwd);
    };

    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "notice",
      file: "",
    });
    expect(findings[0].message).toContain("`--dirty-as-now` not applied");
    expect(findings[0].message).toContain("committed history");
  });

  it("without the flag: the same failing status call stays silent (the notice is scoped to --dirty-as-now)", () => {
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
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
    // Flag deliberately omitted: nothing asked for a status read, so a
    // failing one has nothing to report.
    ctx.runGit = (args, cwd) => {
      if (args.includes("status")) return null;
      return realRunGit(args, cwd);
    };

    expect(sourcesFreshRule.run(ctx)).toEqual([]);
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
