import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import type { RunResult } from "./helpers.js";

const CLI_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.js",
);

/**
 * Same rationale as `runCliWithTz` in test/cli-staleness.test.ts: a
 * SUBPROCESS is the only form that actually exercises a second `TZ`, since
 * Node resolves the process timezone once and caches it.
 */
function runCliWithTz(args: string[], tz: string): RunResult {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    if (typeof e.stdout !== "string") throw err;
    return {
      status: e.status ?? 1,
      stdout: e.stdout,
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

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
 * an UNTRACKED doc counts as re-stamped too (see dirtyDocRestampVerdict's
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
   * CI") could not turn a `--dirty-as-now --strict` failure clean. Without
   * this rescue, a doc bumped to "now" on disk still read STALE against a
   * dirty source's own `--dirty-as-now` substitution because a few seconds
   * elapse between writing the bump and running `check`.
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

    it("with the flag: a doc re-stamped locally to an EARLIER value than HEAD's is not a re-stamp -> STALE + backwards warning (D-004)", () => {
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
      // Locally re-stamp the doc BACKWARDS (uncommitted): the on-disk value
      // is strictly EARLIER than the value committed at HEAD, so per D-004
      // this is not a re-verification.
      writeDoc(repo.dir, "bundle/doc.md", {
        type: "concept",
        timestamp: "2025-01-15T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(2);
      const stale = findings.find((f) => f.message.includes("STALE"));
      const backwards = findings.find((f) =>
        f.message.includes("moved backwards"),
      );
      expect(stale).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(stale?.message).toContain("source.ts");
      expect(backwards).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(backwards?.message).toContain("2025-02-01T00:00:00.000Z");
      expect(backwards?.message).toContain("2025-01-15T00:00:00.000Z");
      expect(backwards?.message).toContain("in the working tree");
    });

    it("with the flag: a doc re-stamped locally to the SAME instant as HEAD's (different representation) is not a re-stamp -> STALE + same-instant notice (D-009)", () => {
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
      // Locally rewrite the doc's stamp to the SAME instant committed at
      // HEAD, just in a different raw representation (adds milliseconds
      // that round to nothing): per D-009 this is not a re-verification
      // either, and gets a NOTICE (not a warning) naming both values.
      writeDoc(repo.dir, "bundle/doc.md", {
        type: "concept",
        timestamp: "2025-02-01T00:00:00.000Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(2);
      const stale = findings.find((f) => f.message.includes("STALE"));
      const sameInstant = findings.find((f) =>
        f.message.includes("did not move the timestamp forward"),
      );
      expect(stale).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(stale?.message).toContain("source.ts");
      expect(sameInstant).toMatchObject({
        ruleId: "sources-fresh",
        severity: "notice",
      });
      // Both raw values, the one instant, and the working-tree phrasing
      // that distinguishes this path from the committed one, asserted as
      // one exact string: a notice that printed a single value twice
      // cannot satisfy it.
      expect(sameInstant?.message).toBe(
        're-stamp did not move the timestamp forward: "2025-02-01T00:00:00Z" was rewritten as "2025-02-01T00:00:00.000Z" in the working tree, but both name the same instant (2025-02-01T00:00:00.000Z), so this is not a re-verification',
      );
    });

    it("with the flag: HEAD committed as a native YAML date, re-stamped locally to a LATER string with a UTC designator -> direction judged, restamped/clean (D-013, superseded by D-016 for the direction check)", () => {
      // HEAD's committed value carries no raw string at all (a
      // `!!timestamp`-tagged scalar), so it takes the `Date#getTime()`
      // branch and never the string parse `parseTimestampInstantMs` gates
      // by designator (D-016); the on-disk value has a real `Z`. Both are
      // direction-comparable, the instants differ, and the
      // move is FORWARD, so this is an ordinary re-stamp under
      // `--dirty-as-now` -- clean, not a fallback to raw-identity
      // comparison the way a designator-less STRING would be.
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        "---\ntype: concept\ntimestamp: !!timestamp 2025-02-01 00:00:00\nsources:\n  - source.ts\n---\n\n# Doc\n",
        "2025-02-01T00:00:00Z",
      );

      fs.writeFileSync(
        path.join(repo.dir, "source.ts"),
        "export const a = 2;\n",
      );
      writeDoc(repo.dir, "bundle/doc.md", {
        type: "concept",
        timestamp: "2025-03-01T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      expect(sourcesFreshRule.run(ctx)).toEqual([]);
    });

    it("with the flag: HEAD committed as a native YAML date, re-stamped locally to an EARLIER string with a UTC designator -> direction judged, STALE + backwards warning (D-013, superseded by D-016 for the direction check)", () => {
      // The other direction of the same fixture shape: the on-disk value
      // is a real `Z` string EARLIER than HEAD's native-date instant.
      // Direction is still judged (neither side is ambiguous), and it
      // reads backwards, so per D-004 this is not a re-verification.
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        "---\ntype: concept\ntimestamp: !!timestamp 2025-03-01 00:00:00\nsources:\n  - source.ts\n---\n\n# Doc\n",
        "2025-03-01T00:00:00Z",
      );

      fs.writeFileSync(
        path.join(repo.dir, "source.ts"),
        "export const a = 2;\n",
      );
      writeDoc(repo.dir, "bundle/doc.md", {
        type: "concept",
        timestamp: "2025-01-15T00:00:00Z",
        sources: ["source.ts"],
      });

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      const findings = sourcesFreshRule.run(ctx);

      expect(findings).toHaveLength(2);
      const stale = findings.find((f) => f.message.includes("STALE"));
      const backwards = findings.find((f) =>
        f.message.includes("moved backwards"),
      );
      expect(stale).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(backwards).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
      });
      expect(backwards?.message).toContain("2025-03-01T00:00:00.000Z");
      expect(backwards?.message).toContain("2025-01-15T00:00:00.000Z");
      expect(backwards?.message).toContain("in the working tree");
    });

    it("with the flag: a designator-less backwards re-stamp on the working-tree path is reported, identically under TZ=UTC and TZ=Asia/Tokyo (D-016)", () => {
      // The committed and on-disk values are BOTH designator-less strings
      // (no `Z`, no offset), so this exercises D-016's UTC-forcing on the
      // `--dirty-as-now` working-tree path specifically, not just the
      // committed-history path test/sources-fresh.test.ts already pins
      // (D-016 line 1170) and not the native-YAML-date case above (D-013).
      // Before this fix, a designator-less pair fell back to
      // raw-identity comparison ("did the text change") and any textual
      // change -- including a genuine backwards move -- passed silently
      // as an ordinary re-stamp; this fixture is that exact case,
      // committed forward then re-stamped backward on disk.
      const cliRepo = createTmpGitRepo();
      try {
        cliRepo.commitFile(
          "source.ts",
          "export const a = 1;\n",
          "2025-01-01T00:00:00Z",
        );
        cliRepo.commitFile(
          "bundle/doc.md",
          docContent({
            type: "concept",
            timestamp: "2025-03-01T00:00:00",
            sources: ["source.ts"],
          }),
          "2025-03-01T00:00:00Z",
        );

        fs.writeFileSync(
          path.join(cliRepo.dir, "source.ts"),
          "export const a = 2;\n",
        );
        writeDoc(cliRepo.dir, "bundle/doc.md", {
          type: "concept",
          timestamp: "2025-01-15T00:00:00",
          sources: ["source.ts"],
        });

        const args = [
          "check",
          path.join(cliRepo.dir, "bundle"),
          "--repo-root",
          cliRepo.dir,
          "--dirty-as-now",
          "--json",
        ];
        const utc = runCliWithTz(args, "UTC");
        const tokyo = runCliWithTz(args, "Asia/Tokyo");

        const backwardsMessages: string[] = [];
        for (const result of [utc, tokyo]) {
          expect(result.status).toBe(0);
          const parsed = JSON.parse(result.stdout) as {
            findings: Array<{
              ruleId: string;
              severity: string;
              message: string;
            }>;
          };
          const backwards = parsed.findings.find((f) =>
            f.message.includes("moved backwards"),
          );
          expect(backwards).toMatchObject({
            ruleId: "sources-fresh",
            severity: "warning",
          });
          expect(backwards?.message).toContain("in the working tree");
          backwardsMessages.push(backwards?.message as string);
        }
        // Both timezones must report the SAME "moved backwards" instants --
        // the point of D-016. (The sibling STALE finding's "now" instant is
        // excluded from this comparison: it legitimately differs by the
        // wall-clock second between the two subprocess invocations, which
        // is unrelated to D-016.)
        expect(backwardsMessages[0]).toBe(backwardsMessages[1]);
      } finally {
        cliRepo.cleanup();
      }
    });

    it("with the flag: a doc committed with an unparseable timestamp, re-stamped locally to a valid value, falls back to raw-identity comparison -> restamped/clean (D-004 fallback)", () => {
      // HEAD's committed doc timestamp does not parse, so
      // compareRestampDirection's ms comparison cannot judge direction and
      // falls back to getTimestampIdentity: the on-disk value is a real,
      // different string, so it still counts as restamped, exactly as
      // before D-004/D-008 existed for this unparseable-either-side case.
      repo.commitFile(
        "source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      repo.commitFile(
        "bundle/doc.md",
        docContent({
          type: "concept",
          timestamp: "not-a-date",
          sources: ["source.ts"],
        }),
        "2025-02-01T00:00:00Z",
      );

      // Locally dirty the source (uncommitted edit).
      fs.writeFileSync(
        path.join(repo.dir, "source.ts"),
        "export const a = 2;\n",
      );
      // Locally re-stamp the doc (uncommitted) to a real, parseable value.
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

    it("with the flag: a dirty doc whose on-disk timestamp is byte-identical to HEAD's gets the plain STALE warning and NEITHER the backwards warning NOR the same-instant notice (D-009)", () => {
      // The same fixture shape as the test above, asserted against the
      // specific guard it exists for: an UNCHANGED stamp is not a re-stamp
      // ATTEMPT, so the same-instant notice (which fires when the raw value
      // was rewritten to another spelling of the same instant) must NOT
      // fire here. The test above pins the finding COUNT; this one pins the
      // two message kinds by name on the WORKING-TREE path, so a
      // byte-identical value can never start emitting a notice that tells
      // the reader to go look at a re-stamp nobody made.
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
      const bodyEditOnly = committedDoc.replace(
        "# Doc\n",
        "# Doc\n\nA local body edit, stamp untouched.\n",
      );
      fs.writeFileSync(path.join(repo.dir, "bundle/doc.md"), bodyEditOnly);
      // The frontmatter block is byte-identical; only the body differs.
      expect(bodyEditOnly.split("---\n")[1]).toEqual(
        committedDoc.split("---\n")[1],
      );

      const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
      ctx.dirtyAsNow = true;
      const findings = sourcesFreshRule.run(ctx);

      expect(
        findings.filter((f) => f.message.includes("moved backwards")),
      ).toEqual([]);
      expect(
        findings.filter((f) =>
          f.message.includes("did not move the timestamp forward"),
        ),
      ).toEqual([]);
      expect(findings.map((f) => f.severity)).toEqual(["warning"]);
      expect(findings[0].message).toContain("STALE");
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

  /**
   * The same working-tree rescue under a `--repo-root` naming a
   * SUBDIRECTORY of the repository. The doc's committed value is read with
   * `git show HEAD:<path>`, and git resolves a bare `<rev>:<path>` against
   * the repository's TOP LEVEL, never the cwd, while the rule's own doc
   * path is relative to the passed root. Spelled bare, the read either
   * fails (the rescue collapses to a not-assessable notice: a locally
   * re-stamped doc no longer reads clean) or, when a same-named doc
   * happens to exist at the top level, reads THAT doc's stamp in place of
   * this one's (a dirty-but-not-re-stamped doc can read clean, a false
   * green). The rule respells the path in the top-level frame via `git
   * rev-parse --show-prefix` before every blob read; these tests pin each
   * direction, including both shadowing directions against a same-named
   * top-level doc.
   */
  describe("--repo-root naming a subdirectory: doc re-stamp rescue", () => {
    const subDoc = (timestamp: string): Record<string, unknown> => ({
      type: "concept",
      timestamp,
      sources: ["source.ts"],
    });

    /** `sub/source.ts` committed, then `sub/bundle/doc.md` committed stamped `stamp`; returns the committed doc text. */
    function commitSubFixture(stamp = "2025-02-01T00:00:00Z"): string {
      repo.commitFile(
        "sub/source.ts",
        "export const a = 1;\n",
        "2025-01-01T00:00:00Z",
      );
      const committedDoc = docContent(subDoc(stamp));
      repo.commitFile("sub/bundle/doc.md", committedDoc, stamp);
      return committedDoc;
    }

    function subCtx(): ReturnType<typeof loadBundle> {
      const subRoot = path.join(repo.dir, "sub");
      const ctx = loadBundle(path.join(subRoot, "bundle"), subRoot);
      ctx.dirtyAsNow = true;
      return ctx;
    }

    it("a dirty source paired with a doc re-stamped locally reads clean, exactly as under the top-level root", () => {
      commitSubFixture();
      fs.writeFileSync(
        path.join(repo.dir, "sub/source.ts"),
        "export const a = 2;\n",
      );
      writeDoc(repo.dir, "sub/bundle/doc.md", subDoc("2025-09-01T00:00:00Z"));

      expect(sourcesFreshRule.run(subCtx())).toEqual([]);
    });

    it("a dirty source paired with a doc that is dirty but NOT re-stamped reads STALE, never a not-assessable notice", () => {
      const committedDoc = commitSubFixture();
      fs.writeFileSync(
        path.join(repo.dir, "sub/source.ts"),
        "export const a = 2;\n",
      );
      fs.writeFileSync(
        path.join(repo.dir, "sub/bundle/doc.md"),
        committedDoc.replace("# Doc\n", "# Doc\n\nA local note.\n"),
      );

      const findings = sourcesFreshRule.run(subCtx());

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "sources-fresh",
        severity: "warning",
        file: "doc.md",
      });
      expect(findings[0].message).toContain("STALE");
    });

    it("a same-named doc at the TOP LEVEL does not shadow the subdirectory doc: dirty-but-not-re-stamped stays STALE even though the top-level doc's stamp differs", () => {
      const committedDoc = commitSubFixture();
      // Same bundle-relative path, one level up, carrying a DIFFERENT
      // stamp: a bare `HEAD:bundle/doc.md` read returns this doc, whose
      // stamp differs from the subdirectory doc's on-disk value, i.e. a
      // false "re-stamped".
      repo.commitFile(
        "bundle/doc.md",
        docContent(subDoc("2025-09-01T00:00:00Z")),
        "2025-02-01T00:00:00Z",
      );
      fs.writeFileSync(
        path.join(repo.dir, "sub/source.ts"),
        "export const a = 2;\n",
      );
      fs.writeFileSync(
        path.join(repo.dir, "sub/bundle/doc.md"),
        committedDoc.replace("# Doc\n", "# Doc\n\nA local note.\n"),
      );

      const findings = sourcesFreshRule.run(subCtx());

      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].message).toContain("STALE");
    });

    it("a same-named doc at the TOP LEVEL does not shadow the subdirectory doc: a local re-stamp still rescues even though the top-level doc already carries that exact stamp", () => {
      commitSubFixture();
      // The top-level doc is committed with the very stamp the subdirectory
      // doc is about to be re-stamped to: a bare read would compare equal
      // and report "not re-stamped", a false STALE.
      repo.commitFile(
        "bundle/doc.md",
        docContent(subDoc("2025-09-01T00:00:00Z")),
        "2025-02-01T00:00:00Z",
      );
      fs.writeFileSync(
        path.join(repo.dir, "sub/source.ts"),
        "export const a = 2;\n",
      );
      writeDoc(repo.dir, "sub/bundle/doc.md", subDoc("2025-09-01T00:00:00Z"));

      expect(sourcesFreshRule.run(subCtx())).toEqual([]);
    });
  });

  /**
   * The virtual-commit instant is read from the clock exactly ONCE per
   * `check` run and shared by every dirty path in BOTH rules. The rescue
   * gate is an inequality between two "now" reads, so re-reading the clock
   * per call would make its verdict depend on which side was read first
   * and on whether a second boundary fell between the reads. An injected
   * clock (`ctx.now`) that jumps an hour on every call makes any re-read
   * visible in the epochs the findings cite, and in the call count.
   */
  it("with the flag: reads the injected clock exactly once per run, and every dirty path in both rules cites that same instant", () => {
    const t0Ms = 1_800_000_000_000; // whole seconds, so the cited ISO is exact
    const t0Iso = new Date(t0Ms).toISOString();
    repo.commitFile(
      "source.ts",
      "export const a = 1;\n",
      "2025-01-01T00:00:00Z",
    );
    // Doc A: committed, then body-dirtied (not re-stamped), its source
    // dirtied: sources-fresh reports STALE citing the source's virtual epoch.
    const committedA = docContent({
      type: "concept",
      timestamp: "2025-06-01T00:00:00Z",
      sources: ["source.ts"],
    });
    repo.commitFile("bundle/a.md", committedA, "2025-06-01T00:00:00Z");
    fs.writeFileSync(
      path.join(repo.dir, "bundle/a.md"),
      committedA.replace("# Doc\n", "# Doc\n\nA local note.\n"),
    );
    fs.writeFileSync(path.join(repo.dir, "source.ts"), "export const a = 2;\n");
    // Doc B: untracked and stamped two hours past t0: sources-fresh-future
    // reports FUTURE-DATED citing the doc's own virtual epoch.
    writeDoc(repo.dir, "bundle/b.md", {
      type: "concept",
      timestamp: new Date(t0Ms + 2 * 3_600_000).toISOString(),
      sources: ["source.ts"],
    });

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    let clockReads = 0;
    ctx.now = () => {
      clockReads += 1;
      return t0Ms + (clockReads - 1) * 3_600_000;
    };

    const findings = [
      ...sourcesFreshRule.run(ctx),
      ...sourcesFreshFutureRule.run(ctx),
    ];

    expect(clockReads).toBe(1);
    const stale = findings.filter((f) => f.message.includes("STALE"));
    expect(stale).toHaveLength(1);
    expect(stale[0].file).toBe("a.md");
    expect(stale[0].message).toContain(`changed ${t0Iso}`);
    const future = findings.filter((f) => f.message.includes("FUTURE-DATED"));
    expect(future).toHaveLength(1);
    expect(future[0].file).toBe("b.md");
    expect(future[0].message).toContain(`own last commit ${t0Iso}`);
  });

  /**
   * Control for `--untracked-files=all`: a brand-new directory whose ONLY
   * content is ignored must not become dirty just because the status read
   * enumerates untracked files. `--ignored` is never passed, so such a
   * source keeps the ordinary "untracked by git" notice rather than
   * reading STALE.
   */
  it("with the flag: a source inside a brand-new directory holding only IGNORED files keeps the `untracked by git` notice", () => {
    repo.commitFile(
      ".gitignore",
      "newdir/*.generated.ts\n",
      "2025-01-01T00:00:00Z",
    );
    repo.commitFile(
      "bundle/doc.md",
      docContent({
        type: "concept",
        timestamp: "2025-06-01T00:00:00Z",
        sources: ["newdir/a.generated.ts"],
      }),
      "2025-06-01T00:00:00Z",
    );
    fs.mkdirSync(path.join(repo.dir, "newdir"));
    fs.writeFileSync(
      path.join(repo.dir, "newdir/a.generated.ts"),
      "export const a = 1;\n",
    );
    // Precondition: with every untracked file enumerated, git still reports
    // nothing under the ignored-only directory.
    expect(
      repo.git(["status", "--porcelain=v2", "--untracked-files=all"]),
    ).not.toContain("newdir");

    const ctx = loadBundle(path.join(repo.dir, "bundle"), repo.dir);
    ctx.dirtyAsNow = true;
    const findings = sourcesFreshRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "sources-fresh",
      severity: "notice",
      file: "doc.md",
    });
    expect(findings[0].message).toContain("untracked by git");
    expect(findings[0].message).not.toContain("STALE");
  });
});
