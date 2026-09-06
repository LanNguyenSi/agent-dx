import fs from "node:fs";
import path from "node:path";
import { runGit as defaultRunGit } from "../git.js";
import { getTimestampEpoch, getValidSources } from "../util.js";
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
    "Frontmatter `sources` paths must not have a last-commit time newer than the doc's `timestamp` and the doc file's own last commit.",
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
      // (typically: both landed in one squash-merge) is not stale, even if
      // its frontmatter timestamp is old. Lazy + memoized: the lookup costs a
      // git process per doc but is only ever consulted on the stale path.
      const repoRelDocPath = toRepoRelDocPath(repoRoot, ctx.bundleDir, doc);
      let docCommitEpochMemo: number | null | undefined;
      const docCommitEpochFor = (): number | null =>
        (docCommitEpochMemo ??= getLastCommitEpoch(
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

        // Doc committed at/after the source: not stale (see comment above).
        // A doc without git history (null epoch, e.g. uncommitted) keeps the
        // frontmatter-only comparison.
        if (isStale) {
          const docCommitEpoch = docCommitEpochFor();
          if (docCommitEpoch !== null && docCommitEpoch >= commitEpoch) {
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
    "A doc's frontmatter `timestamp` must not be later than the doc file's own last commit time by more than a clock-skew allowance (default 10 minutes, `--future-skew-minutes`); catches a local time mistakenly written with a `Z`/UTC suffix. Assessed for the same docs as `sources-fresh` (a `sources` list and a repo root); see the README's \"Staleness (sources-fresh)\" section for how the two rules relate.",
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

      const repoRelDocPath = toRepoRelDocPath(repoRoot, ctx.bundleDir, doc);
      const docCommitEpoch = getLastCommitEpoch(git, repoRoot, repoRelDocPath);
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
