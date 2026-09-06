import fs from "node:fs";
import path from "node:path";
import { runGit as defaultRunGit } from "../git.js";
import {
  getRawTimestampString,
  getTimestampEpoch,
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
    "Frontmatter `sources` paths must not have a last-commit time newer than the doc's `timestamp`, unless the doc's own last commit lands at/after the source's and that same commit actually re-stamped the doc (added/changed its frontmatter `timestamp:` line, or created the doc).",
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
      // timestamp predates the merge -- see docStampTouchedFor below for
      // what "re-stamped" means and why the plain commit-ordering check
      // alone is not enough. Both lookups are lazy + memoized: each costs a
      // git process per doc but is only ever consulted on the stale path,
      // and the epoch lookup is shared with sources-fresh-future via
      // getDocCommitEpochShared so the two rules don't each spawn their own
      // `git log` for the same doc in one `check` run.
      const repoRelDocPath = toRepoRelDocPath(repoRoot, ctx.bundleDir, doc);
      const docCommitEpochFor = (): number | null =>
        getDocCommitEpochShared(ctx, git, repoRoot, repoRelDocPath);
      let docStampTouchedMemo: boolean | undefined;
      const docStampTouchedFor = (): boolean =>
        (docStampTouchedMemo ??= lastCommitTouchedTimestamp(
          git,
          repoRoot,
          repoRelDocPath,
        ));

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
        // comparison.
        if (isStale) {
          const docCommitEpoch = docCommitEpochFor();
          if (
            docCommitEpoch !== null &&
            docCommitEpoch >= commitEpoch &&
            docStampTouchedFor()
          ) {
            isStale = false;
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
 * Whether `doc`'s own last commit actually re-stamped it: added or changed
 * a frontmatter `timestamp:` line. A doc CREATED in that commit counts too,
 * without any special case -- a new file's entire diff (including its
 * `timestamp:` line) shows as added, so the same `+timestamp:` check covers
 * it. This is what narrows `sources-fresh`'s co-commit staleness exception:
 * a commit that merely happens to also touch the doc file (a typo fix, a
 * repo-wide formatter run, a rename) without re-stamping it carries no
 * verification claim and must NOT suppress staleness, only a commit that
 * actually rewrote the stamp (or created the doc) does.
 *
 * Deliberately scoped to a single-file `git log -p` diff rather than a
 * frontmatter-only parse: the frontmatter block's own keys are never
 * indented, so a top-level `+timestamp:` line in this diff can only come
 * from the frontmatter, not from prose in the doc body.
 */
function lastCommitTouchedTimestamp(
  git: RunGit,
  repoRoot: string,
  repoRelDocPath: string,
): boolean {
  const diff = git(
    ["log", "-1", "-p", "--format=", "--", repoRelDocPath],
    repoRoot,
  );
  if (!diff) return false;
  return /^\+timestamp:/m.test(diff);
}
