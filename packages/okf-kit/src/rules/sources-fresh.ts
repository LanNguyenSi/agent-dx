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
    "Frontmatter `sources` paths must not have a last-commit time newer than the doc's `timestamp`, unless the doc's own last commit lands at/after the source's and that same commit actually re-stamped the doc: the doc's parsed frontmatter `timestamp` VALUE at that commit differs from its value in the commit's first parent (rename-aware; creating the doc counts as re-stamping it). Creation is trusted only in a genuinely unshallow repository: in a shallow clone, a commit with no parents can simply be where history was cut off, not a real root commit, so it gets the same `not assessable` notice instead of being assumed created. When git cannot answer the question at all, the doc gets a `not assessable` notice instead of either a STALE warning or a silent pass.",
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
    // `--dirty-as-now` only: ONE `git status --porcelain` for the WHOLE
    // work tree, for the WHOLE run, not one process per unique source path
    // (or per doc, for the local-restamp rescue below) -- see
    // readDirtyPaths' doc comment. Lazily read on first use, so a run that
    // never actually needs a dirty check (every source is already stale or
    // fresh by committed history alone) still pays nothing; never consulted
    // at all when ctx.dirtyAsNow is falsy.
    let dirtyPathsMemo: Set<string> | null | undefined;
    const dirtyPaths = (): Set<string> | null => {
      if (dirtyPathsMemo === undefined) {
        dirtyPathsMemo = readDirtyPaths(git, repoRoot);
      }
      return dirtyPathsMemo;
    };
    // A dirty FILE source matches by exact path; a dirty DIRECTORY source
    // matches if any reported dirty path lives under it. A failed status
    // call (null) is treated as "nothing is dirty", the same conservative
    // default every other git failure in this file falls back to.
    const isDirtyFor = (relPath: string): boolean => {
      const paths = dirtyPaths();
      if (paths === null) return false;
      if (paths.has(relPath)) return true;
      const prefix = `${relPath}/`;
      for (const p of paths) {
        if (p.startsWith(prefix)) return true;
      }
      return false;
    };
    // Captured once per rule run, not per source: every dirty source in
    // this invocation is treated as committed at the SAME instant, so two
    // dirty sources never disagree with each other about "now".
    const nowEpoch = Math.floor(Date.now() / 1000);
    const commitEpochFor = (source: string): number | null => {
      if (ctx.dirtyAsNow && isDirtyFor(source)) return nowEpoch;
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
      // GIT PROCESS BUDGET, per doc, per `check` run, with `--dirty-as-now`
      // OFF (this figure is measured with the flag off; see below for its
      // extra cost with the flag on): 1 (the shared `git log -1
      // --format=%ct` epoch lookup, always) + at most 4 more on the
      // re-stamp path (`git log -1 --format=%H%n%P`, then `git diff-tree`,
      // then two `git show`s), i.e. AT MOST 5 -- regardless of how many
      // sources the doc declares, since both lookups are memoized per doc.
      // A doc created by its last commit (or by the repo's root commit)
      // stops after 2 (or 1). Plus one `git log` per UNIQUE source path
      // across the whole bundle (commitEpochCache above). Pinned by
      // "spends at most five git processes per doc" in
      // test/sources-fresh.test.ts. PLUS: at most 1 `git rev-parse
      // --is-shallow-repository` for the ENTIRE run, not per doc (see
      // isShallowRepoShared below) -- only spent at all when some doc's
      // re-stamp lookup actually reaches a root commit.
      //
      // With `--dirty-as-now` ON, add: 1 `git status --porcelain` for the
      // ENTIRE run (not per doc, not per source -- see readDirtyPaths),
      // plus at most 1 `git show HEAD:<doc>` PER DOC, spent only when that
      // doc is itself dirty AND some source of its reads stale (see
      // isDocLocallyRestamped below).
      const repoRelDocPath = toRepoRelDocPath(repoRoot, ctx.bundleDir, doc);
      const docCommitEpochFor = (): number | null =>
        getDocCommitEpochShared(ctx, git, repoRoot, repoRelDocPath);
      let restampMemo: RestampVerdict | undefined;
      const restampFor = (): RestampVerdict =>
        (restampMemo ??= restampedByOwnLastCommit(
          git,
          repoRoot,
          repoRelDocPath,
          () => isShallowRepoShared(ctx, git, repoRoot),
        ));
      // `--dirty-as-now` only: the working-tree analogue of restampFor
      // above, for a doc that has itself been re-stamped locally but not
      // yet committed. Lazy + memoized per doc, same discipline as
      // restampMemo; never consulted when ctx.dirtyAsNow is falsy.
      let docLocallyRestampedMemo: boolean | undefined;
      const docLocallyRestampedFor = (): boolean =>
        (docLocallyRestampedMemo ??=
          isDirtyFor(repoRelDocPath) &&
          isDocLocallyRestamped(
            git,
            repoRoot,
            repoRelDocPath,
            getTimestampIdentity(doc.frontmatter.parsed),
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

        // `--dirty-as-now` only: a doc re-stamped LOCALLY (uncommitted)
        // rescues a dirty source exactly like the co-commit rescue below
        // rescues a source committed together with a real re-stamp -- see
        // isDocLocallyRestamped's doc comment. Checked BEFORE the co-commit
        // path: a doc that has not yet been committed with its new stamp
        // has no docCommitEpoch that could satisfy that path's `>=
        // commitEpoch` guard (its last COMMITTED epoch is necessarily
        // older than "now"), so without this branch the rescue could never
        // fire for the exact case it exists for.
        if (isStale && ctx.dirtyAsNow && docLocallyRestampedFor()) {
          isStale = false;
        } else if (isStale) {
          // Doc committed at/after the source, AND that commit actually
          // re-stamped it: not stale (see comment above). A doc without git
          // history (null epoch, e.g. uncommitted) keeps the
          // frontmatter-only comparison. When git cannot answer the
          // re-stamp question at all, the doc is reported as not assessable
          // rather than being guessed either way: calling it STALE would
          // turn a git hiccup into a red build, and calling it fresh would
          // be a silent pass.
          const docCommitEpoch = docCommitEpochFor();
          if (docCommitEpoch !== null && docCommitEpoch >= commitEpoch) {
            const verdict = restampFor();
            if (verdict === "restamped") {
              isStale = false;
            } else if (
              verdict === "unknown" ||
              verdict === "unknown-shallow-root"
            ) {
              if (!notAssessableReported) {
                notAssessableReported = true;
                findings.push({
                  ruleId: RULE_ID,
                  severity: "notice",
                  file: doc.relPath,
                  message:
                    verdict === "unknown-shallow-root"
                      ? "staleness not assessable: this is a shallow clone (`git clone --depth`), so git cannot tell whether the doc's earliest available commit really created it or is just where history was cut off -- use `fetch-depth: 0` (or an unshallow checkout) to assess it"
                      : "staleness not assessable: git could not read the doc's own last commit to decide whether it re-stamped the doc",
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

/**
 * The full SET of repo-root-relative paths `git status --porcelain`
 * reports as dirty (modified, staged, or untracked) across the WHOLE work
 * tree, read via a SINGLE git process for the entire `check` run -- not
 * one process per unique `sources` path (the original, pre-review
 * implementation), and not one per doc for the local-restamp rescue
 * below. Used only behind `--dirty-as-now` (`ctx.dirtyAsNow`): a dirty
 * path has no "last commit" yet that reflects its current content, so
 * `sources-fresh` substitutes the current time for it instead of falling
 * through to `getLastCommitEpoch`'s answer (the LAST commit's time, which
 * for a locally-edited-but-uncommitted file is necessarily stale).
 *
 * `--no-optional-locks` skips git's opportunistic index refresh (which can
 * otherwise rewrite the on-disk index file as a side effect of a plain
 * `status`) -- unwanted here since this runs as a read-only check, often
 * from a hook or CI step that should not perturb the index. Ignored files
 * are deliberately NOT included (no `--ignored`): an ignored source keeps
 * today's "untracked by git, staleness unknown" notice instead of being
 * newly reported dirty by this option.
 *
 * Uses `--porcelain=v2 -z`, not the more familiar `--porcelain` (v1) line
 * format, for one reason that is NOT about renames or quoting (`-z` alone
 * would fix both): RunGit (src/git.ts) `.trim()`s every git invocation's
 * output, and a v1 line for an unstaged-only change starts with a LITERAL
 * SPACE (` M path`, index clean, worktree modified) -- an entirely common
 * case. When that happens to be the FIRST line of the whole status output,
 * `.trim()` strips that leading space as ordinary boundary whitespace,
 * silently shifting every fixed-offset field in that one line and
 * corrupting its path (verified against real git output: a lone `M
 * source.ts` line, meant to be ` M source.ts`, parses to the wrong path
 * with a fixed `line.slice(3)` cut). Every v2 record instead starts with a
 * digit or letter (`1`, `2`, `u`, `?`) that is never whitespace, so the
 * SAME `.trim()` can never eat a leading field byte. NUL (`-z`) delimits
 * every record and untracked/rename path field can safely contain a space,
 * tab, or non-ASCII byte, mirroring previousPathIn's `-z` rationale
 * elsewhere in this file. Record shapes actually seen here (verified
 * against real git output; XY, sub, mode and hash fields are read
 * positionally, never re-split by content, since a path can itself
 * legitimately contain a space): `? path` (untracked); `1 XY sub mH mI mW
 * hH hI path` (ordinary; 8 fixed fields before path); `2 XY sub mH mI mW
 * hH hI score path\0origPath` (rename/copy; 9 fixed fields before path,
 * origPath is the FOLLOWING NUL-delimited token verbatim); `u XY sub m1 m2
 * m3 mW h1 h2 h3 path` (unmerged; 10 fixed fields before path) -- both
 * sides of a rename count as dirty. `!` (ignored) records are never
 * produced since `--ignored` is not passed.
 *
 * A failed git call (`out === null`) is treated as "nothing is dirty", the
 * same conservative default as every other git failure in this file: every
 * path falls through to its ordinary commit-epoch path rather than this
 * function inventing a dirty verdict.
 */
function readDirtyPaths(git: RunGit, repoRoot: string): Set<string> | null {
  const out = git(
    ["--no-optional-locks", "status", "--porcelain=v2", "-z"],
    repoRoot,
  );
  if (out === null) return null;
  const paths = new Set<string>();
  // `-z` NUL-terminates every record, including the last -- RunGit's
  // `.trim()` does not strip NUL, so splitting always leaves one empty
  // trailing token.
  const tokens = out.split("\0").filter((t) => t !== "");
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const kind = token[0];
    if (kind === "?") {
      paths.add(token.slice(2));
      i += 1;
    } else if (kind === "1") {
      paths.add(token.split(" ").slice(8).join(" "));
      i += 1;
    } else if (kind === "2") {
      paths.add(token.split(" ").slice(9).join(" "));
      const origPath = tokens[i + 1];
      if (origPath !== undefined) paths.add(origPath);
      i += 2;
    } else if (kind === "u") {
      paths.add(token.split(" ").slice(10).join(" "));
      i += 1;
    } else {
      // An unrecognized record kind (should not occur without --ignored,
      // which is never passed): skip rather than mis-parse it as a path.
      i += 1;
    }
  }
  return paths;
}

/**
 * `--dirty-as-now` only: whether `doc` itself carries an uncommitted LOCAL
 * re-stamp -- the working-tree analogue of `restampedByOwnLastCommit`'s
 * co-commit rescue above. That rescue only fires once a source and its doc
 * land in the SAME commit; without this counterpart, a doc re-stamped on
 * disk but not yet committed, paired with a dirty source, reads STALE under
 * `--dirty-as-now` even though committing both right now -- the very
 * remedy the flag's README recipe recommends -- reports clean. Compares
 * parsed frontmatter `timestamp` VALUES (via `getTimestampIdentity`,
 * shared with restampedByOwnLastCommit), never diff text, for the same
 * reasons documented there.
 *
 * `onDiskTimestamp` is the doc's CURRENT (working-tree) parsed timestamp
 * identity, already read from disk by the caller (BundleDoc always
 * reflects the working tree, dirty or not). It is compared against the
 * value committed at HEAD for the same path. A doc with no committed blob
 * at HEAD (`git show HEAD:<path>` fails -- untracked, never committed at
 * all) counts as re-stamped too: there is no prior committed value to
 * compare against, so its whole content, stamp included, is new.
 *
 * Only ever called when the doc is already known to be dirty (see
 * docLocallyRestampedFor's `isDirtyFor` guard above), so this spends at
 * most one `git show` per doc, and only on the stale path.
 */
function isDocLocallyRestamped(
  git: RunGit,
  repoRoot: string,
  repoRelDocPath: string,
  onDiskTimestamp: unknown,
): boolean {
  const committed = git(["show", `HEAD:${repoRelDocPath}`], repoRoot);
  if (committed === null) return true;
  const committedStamp = getTimestampIdentity(
    parseFrontmatter(committed).frontmatter.parsed,
  );
  return committedStamp !== onDiskTimestamp;
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
 * Per-run cache (keyed by `BundleContext`, same pattern as
 * `docCommitEpochCache` above) of whether `repoRoot` is a shallow clone
 * (`git clone --depth <n>`), so `restampedByOwnLastCommit`'s root-commit
 * shortcut spends at most ONE `git rev-parse --is-shallow-repository` for
 * the whole `check` run, not one per doc. A failed git call (repoRoot
 * somehow not a real git work tree after all) is treated as shallow: this
 * function's only consumer only ever asks it to decide whether a commit
 * with an empty parent list is trustworthy as a genuine root commit, and
 * the file's standing rule is to answer "unknown" rather than invent
 * either verdict when git itself cannot be asked -- so a failure here must
 * NOT fall back to the previous "always trust it" behavior.
 */
const shallowRepoCache = new WeakMap<BundleContext, boolean>();

function isShallowRepoShared(
  ctx: BundleContext,
  git: RunGit,
  repoRoot: string,
): boolean {
  const cached = shallowRepoCache.get(ctx);
  if (cached !== undefined) return cached;
  const out = git(["rev-parse", "--is-shallow-repository"], repoRoot);
  const isShallow = out === null ? true : out.trim() === "true";
  shallowRepoCache.set(ctx, isShallow);
  return isShallow;
}

/**
 * Verdict for "did the doc's OWN last commit re-stamp it?" -- the question
 * that narrows `sources-fresh`'s co-commit staleness exception.
 *
 * `unknown` and `unknown-shallow-root` are both first-class answers, not an
 * error: git can legitimately fail to produce one of the inputs (a corrupt
 * object, a missing binary, an unreadable blob) -- `unknown` -- or the
 * repository can be a shallow clone where an empty parent list does not
 * mean what it normally means -- `unknown-shallow-root`, see
 * `restampedByOwnLastCommit`'s root-commit branch below -- and neither of
 * the other two answers may be invented in either case. `sources-fresh`
 * turns both into a `not assessable` notice (with different wording).
 */
type RestampVerdict =
  "restamped" | "not-restamped" | "unknown" | "unknown-shallow-root";

/**
 * Whether `doc`'s own last commit actually re-stamped it, decided by
 * comparing the doc's PARSED FRONTMATTER `timestamp` VALUE at that commit
 * against its value in the commit's FIRST PARENT. A doc created by that
 * commit (or by a genuine root commit of an unshallow repository) counts as
 * re-stamped: its stamp arrived with it. In a SHALLOW clone (`git clone
 * --depth`), the doc's last commit can have an EMPTY parent list purely
 * because that is where history was grafted off, not because it is really
 * the repo's first commit -- `isShallowRepo` (checked lazily, only when a
 * commit with no parents is actually seen) distinguishes the two, so a
 * shallow checkout gets `unknown-shallow-root` there instead of an assumed
 * `restamped`.
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
  isShallowRepo: () => boolean,
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
  // An empty parent list means "the doc arrived with the repo's first
  // commit, stamp and all" ONLY in a genuinely unshallow repository. In a
  // shallow clone (`git clone --depth`), the boundary commit git grafted
  // the history onto also reports an empty parent list for every path
  // touched at or before it -- indistinguishable from a real root commit
  // by this lookup alone -- so trusting it there would let the shallow-clone
  // shortcut fire unconditionally and silently suppress every doc's
  // staleness. isShallowRepo() is checked here, not unconditionally at the
  // top of this function, so an unshallow repo never pays for it.
  if (parents.length === 0) {
    return isShallowRepo() ? "unknown-shallow-root" : "restamped";
  }
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
 *
 * Runs with `-z` (NUL-delimited output) rather than the default newline/tab
 * form, and for one reason that is NOT about newlines: git's default
 * `--name-status` output C-QUOTES any path containing a non-ASCII byte
 * (`core.quotePath` defaults to true) as a double-quoted string with octal
 * escapes (e.g. `"bundle/\303\266lt.md"` for `bundle/ölt.md`), so a plain
 * `repoRelDocPath` never string-equals that quoted form and a non-ASCII doc
 * falls through every branch below to the `same` fallback, which returns
 * the doc's real (unquoted) CURRENT path unchanged. When that commit was
 * actually a rename or creation, the doc was NOT at that path in the first
 * parent -- it lived under a different name there, or did not exist yet --
 * so the caller's `git show <firstParent>:<that path>` blob read fails,
 * turning a normal rename or creation into a false `not assessable`
 * notice. `-z` prints every path verbatim,
 * unquoted, regardless of `core.quotePath`, closing that structurally
 * rather than by passing `-c core.quotePath=false` (which is a config
 * override this rule would otherwise have to remember on every git
 * invocation touching a path, not just this one).
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
      "-z",
      "--name-status",
      "--no-commit-id",
      parentSha,
      sha,
    ],
    repoRoot,
  );
  if (nameStatus === null) return { kind: "unknown" };

  // `-z` NUL-terminates every field (status, then path(s)) instead of the
  // default "status TAB path NEWLINE" (or, for a rename/copy row, "status
  // TAB old-path TAB new-path NEWLINE") -- including a trailing NUL after
  // the very last field, which RunGit's `.trim()` does not strip (NUL is
  // not whitespace), so the split below always drops one empty trailing
  // token. A rename/copy row is 3 NUL-terminated tokens (status, old path,
  // new path); every other row is 2 (status, path) -- read positionally,
  // not by re-joining on a separator, since a path can itself legitimately
  // contain a tab or newline once quoting is off.
  const tokens = nameStatus.split("\0").filter((t) => t !== "");
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 3;
      if (newPath === repoRelDocPath) {
        return { kind: "renamed", path: oldPath };
      }
      continue;
    }
    const p = tokens[i + 1];
    i += 2;
    if (p !== repoRelDocPath) continue;
    if (status.startsWith("A")) return { kind: "created" };
    return { kind: "same", path: repoRelDocPath };
  }
  return { kind: "same", path: repoRelDocPath };
}
