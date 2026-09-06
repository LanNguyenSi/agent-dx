import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../bundle.js";
import { runGit as defaultRunGit } from "../git.js";
import {
  getRawTimestampString,
  getTimestampEpoch,
  getTimestampIdentity,
  getValidSources,
  hasUtcDesignator,
} from "../util.js";
import type {
  BundleContext,
  BundleDoc,
  Finding,
  Rule,
  RunGit,
} from "../types.js";

const RULE_ID = "sources-fresh";
const FUTURE_RULE_ID = "sources-fresh-future";

/**
 * Default clock-skew allowance (seconds) for `sources-fresh-future`: a doc
 * timestamp up to this far after the doc's own last commit is still treated
 * as fresh, absorbing the ordinary gap between "author wrote the timestamp"
 * and "the commit that carries it landed". Override via
 * `ctx.freshnessFutureSkewSeconds` (CLI: `--future-skew-minutes`).
 */
export const DEFAULT_FUTURE_SKEW_SECONDS = 600;

export const sourcesFreshRule: Rule = {
  id: RULE_ID,
  description:
    "Frontmatter `sources` paths must not have a last-commit time newer than the doc's `timestamp`, unless the doc's own last commit lands at/after the source's and that same commit actually re-stamped the doc: the doc's parsed frontmatter `timestamp` VALUE at that commit differs from its value in the commit's first parent (rename-aware; creating the doc counts as re-stamping it). When git cannot answer that question, the doc gets a `not assessable` notice instead of either a STALE warning or a silent pass.",
  run(ctx) {
    const findings: Finding[] = [];

    const docsWithSources = getDocsWithSources(ctx);
    if (docsWithSources.length === 0) return findings;

    if (!ctx.repoRoot) {
      // Never silently skip: an unset repoRoot means no existence check ran
      // either (sources-shape), so staleness truly was not assessed, not
      // "everything looked fine". One notice for the whole bundle, not one
      // per doc: this is a bundle-level condition, not a per-doc finding.
      // sources-fresh-future shares this same population and posture; it
      // relies on this single notice too instead of emitting its own (see
      // that rule below).
      findings.push({
        ruleId: RULE_ID,
        severity: "notice",
        file: "",
        message: "staleness skipped: not inside a git work tree",
      });
      return findings;
    }
    const repoRoot = ctx.repoRoot;
    const git = ctx.runGit ?? defaultRunGit;

    // One git call per unique source path across all docs, even though a
    // STALE/untracked finding is reported per (doc, path) below.
    const commitEpochCache = new Map<string, number | null>();
    const commitEpochFor = (source: string): number | null => {
      const cached = commitEpochCache.get(source);
      if (cached !== undefined) return cached;
      const epoch = getLastCommitEpoch(git, repoRoot, source);
      commitEpochCache.set(source, epoch);
      return epoch;
    };

    for (const { doc, sources } of docsWithSources) {
      const timestampEpoch = getTimestampEpoch(doc.frontmatter.parsed);
      if (timestampEpoch === undefined) {
        findings.push({
          ruleId: RULE_ID,
          severity: "notice",
          file: doc.relPath,
          message: "staleness not assessable: no valid timestamp",
        });
        continue;
      }

      // A doc whose own last commit is at or after the source's last commit
      // (typically: both landed in one squash-merge), AND that same commit
      // actually re-stamped the doc, is not stale, even if its frontmatter
      // timestamp predates the merge -- see restampedByOwnLastCommit below
      // for what "re-stamped" means and why the plain commit-ordering check
      // alone is not enough. Both lookups are lazy + memoized: they are only
      // ever consulted on the stale path, and the epoch lookup is shared
      // with sources-fresh-future via getDocCommitEpochShared so the two
      // rules don't each spawn their own `git log` for the same doc in one
      // `check` run.
      //
      // GIT PROCESS BUDGET, per doc, per `check` run: 1 (the shared
      // `git log -1 --format=%ct` epoch lookup, always) + at most 4 more on
      // the re-stamp path (`git log -1 --format=%H%n%P`, then `git diff-tree`,
      // then two `git show`s), i.e. AT MOST 5 -- regardless of how many
      // sources the doc declares, since both lookups are memoized per doc.
      // A doc created by its last commit (or by the repo's root commit)
      // stops after 2 (or 1). Plus one `git log` per UNIQUE source path
      // across the whole bundle (commitEpochCache above). Pinned by
      // "spends at most five git processes per doc" in
      // test/sources-fresh.test.ts.
      const repoRelDocPath = toRepoRelDocPath(repoRoot, ctx.bundleDir, doc);
      const docCommitEpochFor = (): number | null =>
        getDocCommitEpochShared(ctx, git, repoRoot, repoRelDocPath);
      let restampMemo: RestampVerdict | undefined;
      const restampFor = (): RestampVerdict =>
        (restampMemo ??= restampedByOwnLastCommit(
          git,
          repoRoot,
          repoRelDocPath,
        ));
      // At most one "not assessable" notice per doc, however many of its
      // sources hit the unanswerable re-stamp question.
      let notAssessableReported = false;

      for (const source of sources) {
        // A missing path on disk is sources-shape's job to report; avoid a
        // duplicate/confusing finding here.
        if (!fs.existsSync(path.join(repoRoot, source))) continue;

        const commitEpoch = commitEpochFor(source);
        if (commitEpoch === null) {
          findings.push({
            ruleId: RULE_ID,
            severity: "notice",
            file: doc.relPath,
            message: `untracked by git, staleness unknown: \`${source}\``,
          });
          continue;
        }

        let isStale = commitEpoch > timestampEpoch;

        // Doc committed at/after the source, AND that commit actually
        // re-stamped it: not stale (see comment above). A doc without git
        // history (null epoch, e.g. uncommitted) keeps the frontmatter-only
        // comparison. When git cannot answer the re-stamp question at all,
        // the doc is reported as not assessable rather than being guessed
        // either way: calling it STALE would turn a git hiccup into a red
        // build, and calling it fresh would be a silent pass.
        if (isStale) {
          const docCommitEpoch = docCommitEpochFor();
          if (docCommitEpoch !== null && docCommitEpoch >= commitEpoch) {
            const verdict = restampFor();
            if (verdict === "restamped") {
              isStale = false;
            } else if (verdict === "unknown") {
              if (!notAssessableReported) {
                notAssessableReported = true;
                findings.push({
                  ruleId: RULE_ID,
                  severity: "notice",
                  file: doc.relPath,
                  message:
                    "staleness not assessable: git could not read the doc's own last commit to decide whether it re-stamped the doc",
                });
              }
              continue;
            }
          }
        }

        if (isStale) {
          findings.push({
            ruleId: RULE_ID,
            severity: "warning",
            file: doc.relPath,
            message: `STALE: \`${source}\` changed ${epochToIso(commitEpoch)} after doc timestamp ${epochToIso(timestampEpoch)}`,
          });
        }
      }
    }

    return findings;
  },
};

/**
 * Complements `sources-fresh`'s "too old" check with the opposite direction:
 * a doc `timestamp` that is later than the doc file's OWN last commit (past
 * a small clock-skew allowance) is almost always a mistake, not a real
 * future date -- typically a local wall-clock time hand-written with a
 * trailing `Z`/UTC suffix it does not actually have. Unlike `sources-fresh`,
 * this check never looks at `sources` commit times at all: it only compares
 * the doc's own `timestamp` against the doc file's own git history, so it
 * has nothing to say about whether any source is stale.
 *
 * Deliberately assessed for the SAME population as `sources-fresh` (docs
 * with a validly-shaped `sources` list and a repo root available): a
 * `timestamp` only has "last verified against sources" semantics for a doc
 * that declares `sources` (see the package README's authoring guidance), so
 * a sourceless doc is out of scope for both freshness rules, not just this
 * one. It shares `sources-fresh`'s "staleness unknown" posture for the two
 * cases that make a real answer impossible: no repo root (silently defers
 * to the single bundle-level notice `sources-fresh` already emits above,
 * rather than duplicating it) and no valid `timestamp` (`sources-fresh`
 * already reports that per-doc notice, so this rule silently skips such a
 * doc rather than reporting it twice). An uncommitted doc (no own commit
 * yet) is likewise "unknown, not flagged": there is no real commit time to
 * compare the timestamp against, and flagging every hand-authored,
 * not-yet-committed doc as "future-dated" would be a false positive on
 * every fresh draft.
 */
export const sourcesFreshFutureRule: Rule = {
  id: FUTURE_RULE_ID,
  description:
    "A doc's frontmatter `timestamp` must not be later than the doc file's own last commit time by more than a clock-skew allowance (default 10 minutes, `--future-skew-minutes`); catches a local time mistakenly written with a `Z`/UTC suffix. Skipped (notice) for a timestamp with no explicit UTC designator (`Z`) or numeric offset, since that parses in the local timezone and cannot be compared reliably against a minutes-wide allowance. Assessed for the same docs as `sources-fresh` (a `sources` list and a repo root); see the README's \"Staleness (sources-fresh)\" section for how the two rules relate.",
  run(ctx) {
    const findings: Finding[] = [];

    const docsWithSources = getDocsWithSources(ctx);
    if (docsWithSources.length === 0) return findings;
    if (!ctx.repoRoot) return findings;

    const repoRoot = ctx.repoRoot;
    const git = ctx.runGit ?? defaultRunGit;
    const skewSeconds =
      ctx.freshnessFutureSkewSeconds ?? DEFAULT_FUTURE_SKEW_SECONDS;

    for (const { doc } of docsWithSources) {
      const timestampEpoch = getTimestampEpoch(doc.frontmatter.parsed);
      if (timestampEpoch === undefined) continue;

      // A string timestamp with no `Z`/numeric-offset suffix parses in the
      // machine's local timezone (`Date.parse`), which would make this
      // check's verdict swing by hours between machines against a
      // minutes-wide allowance -- not usable. A native `Date` frontmatter
      // value (see getTimestampEpoch's doc comment) carries no such
      // ambiguity and always passes this gate. sources-fresh's own
      // thresholds are in days, wide enough that this ambiguity doesn't
      // practically matter there, so this gate is deliberately NOT applied
      // to that rule.
      const rawTimestamp = getRawTimestampString(doc.frontmatter.parsed);
      if (rawTimestamp !== undefined && !hasUtcDesignator(rawTimestamp)) {
        findings.push({
          ruleId: FUTURE_RULE_ID,
          severity: "notice",
          file: doc.relPath,
          message:
            "future-dated check skipped: timestamp has no UTC designator (`Z`) or numeric offset, can't be compared reliably across timezones",
        });
        continue;
      }

      const repoRelDocPath = toRepoRelDocPath(repoRoot, ctx.bundleDir, doc);
      const docCommitEpoch = getDocCommitEpochShared(
        ctx,
        git,
        repoRoot,
        repoRelDocPath,
      );
      if (docCommitEpoch === null) continue;

      if (timestampEpoch > docCommitEpoch + skewSeconds) {
        findings.push({
          ruleId: FUTURE_RULE_ID,
          severity: "warning",
          file: doc.relPath,
          message: `FUTURE-DATED: doc timestamp ${epochToIso(timestampEpoch)} is after the doc's own last commit ${epochToIso(docCommitEpoch)} (skew allowance ${skewSeconds}s)`,
        });
      }
    }

    return findings;
  },
};

/**
 * Docs carrying a validly-shaped frontmatter `sources` list (see
 * `getValidSources`), each paired with that list. Shared by both rules in
 * this file: `sources-fresh` and `sources-fresh-future` assess the same
 * doc population, just in opposite time directions.
 */
function getDocsWithSources(
  ctx: BundleContext,
): Array<{ doc: BundleDoc; sources: string[] }> {
  return ctx.docs
    .map((doc) => ({ doc, sources: getValidSources(doc.frontmatter.parsed) }))
    .filter(
      (entry): entry is { doc: BundleDoc; sources: string[] } =>
        entry.sources !== undefined,
    );
}

/** `doc`'s own path, relative to `repoRoot`, forward-slash separated -- the pathspec `git log` needs. */
function toRepoRelDocPath(
  repoRoot: string,
  bundleDir: string,
  doc: BundleDoc,
): string {
  return path
    .relative(repoRoot, path.join(bundleDir, doc.relPath))
    .split(path.sep)
    .join("/");
}

/**
 * Last-commit epoch (seconds) for `source` relative to `repoRoot`, or null
 * when the path has no git history (untracked) or the git call itself
 * failed. `git log` with a pathspec that matches no commits exits 0 with
 * empty stdout, which is exactly the "untracked" case, distinct from a real
 * git failure (which RunGit also reports as null): both collapse to null
 * here because sources-fresh treats them the same way, "staleness unknown".
 * Uses committer time (`%ct`), not author time (`%at`): a rebase or
 * cherry-pick can carry a stale author date forward while the committer
 * date reflects when the content actually landed on this branch, which is
 * what both freshness rules care about.
 */
function getLastCommitEpoch(
  git: RunGit,
  repoRoot: string,
  source: string,
): number | null {
  const out = git(["log", "-1", "--format=%ct", "--", source], repoRoot);
  if (!out) return null;
  const epoch = Number.parseInt(out, 10);
  return Number.isNaN(epoch) ? null : epoch;
}

function epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Per-run cache of a doc's own last-commit epoch, keyed by the
 * `BundleContext` instance so `sources-fresh`'s doc-commit comparison and
 * `sources-fresh-future`'s timestamp comparison -- both need the IDENTICAL
 * (repoRoot, doc path) `getLastCommitEpoch` lookup for every doc in one
 * `check` invocation -- share one `git log` process per doc instead of each
 * rule spawning its own. Safe to key on the context object itself: a fresh
 * `BundleContext` is built per `runCheck`/`loadBundle` call, so nothing
 * reuses a stale cache entry across invocations, and the WeakMap lets the
 * cache be garbage-collected with the context once a run is done.
 */
const docCommitEpochCache = new WeakMap<
  BundleContext,
  Map<string, number | null>
>();

function getDocCommitEpochShared(
  ctx: BundleContext,
  git: RunGit,
  repoRoot: string,
  repoRelDocPath: string,
): number | null {
  let cache = docCommitEpochCache.get(ctx);
  if (!cache) {
    cache = new Map();
    docCommitEpochCache.set(ctx, cache);
  }
  const cached = cache.get(repoRelDocPath);
  if (cached !== undefined) return cached;
  const epoch = getLastCommitEpoch(git, repoRoot, repoRelDocPath);
  cache.set(repoRelDocPath, epoch);
  return epoch;
}

/**
 * Verdict for "did the doc's OWN last commit re-stamp it?" -- the question
 * that narrows `sources-fresh`'s co-commit staleness exception.
 *
 * `unknown` is a first-class answer, not an error: git can legitimately fail
 * to produce one of the inputs (a corrupt object, a missing binary, an
 * unreadable blob), and neither of the other two answers may be invented in
 * that case. `sources-fresh` turns it into a `not assessable` notice.
 */
type RestampVerdict = "restamped" | "not-restamped" | "unknown";

/**
 * Whether `doc`'s own last commit actually re-stamped it, decided by
 * comparing the doc's PARSED FRONTMATTER `timestamp` VALUE at that commit
 * against its value in the commit's FIRST PARENT. A doc created by that
 * commit (or by the repo's root commit) counts as re-stamped: its stamp
 * arrived with it.
 *
 * This is what narrows `sources-fresh`'s co-commit staleness exception: a
 * commit that merely happens to also touch the doc file (a typo fix, a
 * repo-wide formatter run, a rename) without changing the stamp carries no
 * verification claim and must NOT suppress staleness; only a commit that
 * actually rewrote the stamp (or created the doc) does.
 *
 * WHY VALUES AND NOT DIFF TEXT. An earlier version of this check scanned
 * `git log -1 -p -- <doc>` for a `^\+timestamp:` line. Scanning diff TEXT is
 * wrong in three distinct, independently reachable ways, each of which this
 * value comparison closes structurally rather than by another special case:
 *
 *  1. A fenced YAML EXAMPLE in the doc's BODY can contain an unindented
 *     `timestamp:` line. Added in a commit that also changed a source, that
 *     body line reads as a re-stamp and silently suppresses staleness --
 *     exactly the review class this rule exists to close. Parsing
 *     frontmatter cannot see a body line at all.
 *  2. A RENAME (`git mv`) shows as `new file mode` under a single-path
 *     `git log -p`, firing the "created counts as stamped" branch even
 *     though the stamp never moved. The rename-aware lookup below reads the
 *     doc's real previous path instead.
 *  3. A MERGE commit prints NO patch at all under `git log -p` (git's
 *     default combined-diff suppression), so a genuine re-stamp landing on
 *     a `refs/pull/N/merge` ref -- the ref CI actually checks out -- became
 *     an invisible false-positive STALE. Both trees are perfectly readable
 *     via `git show`, merge or not.
 *
 * Its limits, stated rather than hidden: this answers "did the value
 * change", never "is the new value right". A hand-typed or backdated stamp
 * still counts as a re-stamp (`sources-fresh-future` is the rule that
 * catches an implausible value), and comparing against only the FIRST parent
 * means a merge that takes its doc content wholesale from the second parent
 * is judged against the first-parent baseline, which is the same baseline
 * the PR under review is measured against.
 *
 * Spends at most 4 git processes and returns early before most of them: 1
 * for the commit + parents, 1 for the rename-aware name-status lookup
 * (skipped for a root commit), and 2 blob reads (skipped when the doc was
 * created there). See the GIT PROCESS BUDGET comment in the rule above.
 */
function restampedByOwnLastCommit(
  git: RunGit,
  repoRoot: string,
  repoRelDocPath: string,
): RestampVerdict {
  // %H then %P on its own line: the doc's last commit and its parent list in
  // ONE process. Default history simplification is exactly what this needs
  // for a single path: a merge whose result for that path differs from every
  // parent (a conflict resolution, or a clean auto-merge of two sides that
  // both touched the doc) IS returned here, while a merge that is TREESAME
  // to a parent resolves to the real content-changing commit on that side.
  const head = git(
    ["log", "-1", "--format=%H%n%P", "--", repoRelDocPath],
    repoRoot,
  );
  if (head === null) return "unknown";
  const [sha, parentLine] = head.split("\n");
  if (!sha) return "unknown";
  const parents = (parentLine ?? "").split(" ").filter((p) => p !== "");
  // Root commit: the doc arrived with the repo's first commit, stamp and all.
  if (parents.length === 0) return "restamped";
  const firstParent = parents[0];

  const previous = previousPathIn(
    git,
    repoRoot,
    firstParent,
    sha,
    repoRelDocPath,
  );
  if (previous.kind === "unknown") return "unknown";
  if (previous.kind === "created") return "restamped";

  const current = git(["show", `${sha}:${repoRelDocPath}`], repoRoot);
  if (current === null) return "unknown";
  const before = git(["show", `${firstParent}:${previous.path}`], repoRoot);
  if (before === null) return "unknown";

  const currentStamp = getTimestampIdentity(
    parseFrontmatter(current).frontmatter.parsed,
  );
  const beforeStamp = getTimestampIdentity(
    parseFrontmatter(before).frontmatter.parsed,
  );
  // Both undefined (no parseable stamp on either side) compares equal, i.e.
  // "not re-stamped" -- nothing was rewritten, so nothing is claimed.
  return currentStamp !== beforeStamp ? "restamped" : "not-restamped";
}

/**
 * Where the doc lived in `parentSha`, so its previous revision can be read
 * by that path: the same path (`same`), a different one it was renamed from
 * (`renamed`), or nowhere at all because that commit created it (`created`).
 *
 * Runs `git diff-tree` WITHOUT a pathspec on purpose. A pathspec is applied
 * BEFORE rename detection, so `git diff-tree -M --name-status <parent> <sha>
 * -- <doc>` reports a renamed doc as `A` (verified against a real `git mv`
 * fixture) -- which is precisely the false "created" verdict that made a
 * rename suppress staleness. The unfiltered output is still bounded and
 * small: `--name-status -r` prints one line per changed path, not any file
 * content, and the raised RunGit output cap (see src/git.ts) covers even a
 * repo-wide formatting commit.
 *
 * A doc that does not appear in the diff at all resolves to `same`: the two
 * revisions are then byte-identical by construction, and the value
 * comparison above resolves that to "not re-stamped" without a second code
 * path deciding it.
 */
function previousPathIn(
  git: RunGit,
  repoRoot: string,
  parentSha: string,
  sha: string,
  repoRelDocPath: string,
):
  | { kind: "same" | "renamed"; path: string }
  | { kind: "created" }
  | { kind: "unknown" } {
  const nameStatus = git(
    [
      "diff-tree",
      "-r",
      "-M",
      "--name-status",
      "--no-commit-id",
      parentSha,
      sha,
    ],
    repoRoot,
  );
  if (nameStatus === null) return { kind: "unknown" };

  for (const line of nameStatus.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const status = fields[0];
    // Rename/copy rows carry BOTH paths: `R<score>\t<old>\t<new>`.
    if (status.startsWith("R") || status.startsWith("C")) {
      if (fields.length >= 3 && fields[2] === repoRelDocPath) {
        return { kind: "renamed", path: fields[1] };
      }
      continue;
    }
    if (fields[1] !== repoRelDocPath) continue;
    if (status.startsWith("A")) return { kind: "created" };
    return { kind: "same", path: repoRelDocPath };
  }
  return { kind: "same", path: repoRelDocPath };
}
