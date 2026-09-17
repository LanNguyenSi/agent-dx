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
    "Frontmatter `sources` paths must not have a last-commit time newer than the doc's `timestamp`, unless the doc's own last commit lands at/after the source's and that same commit actually re-stamped the doc: the doc's parsed frontmatter `timestamp` VALUE at that commit is strictly LATER than its value in the commit's first parent (rename-aware; creating the doc counts as re-stamping it). A commit that moves the stamp BACKWARDS is not a re-stamp: the affected sources stay STALE, and the doc additionally gets a `re-stamp moved backwards` warning naming the previous and new values. Creation is trusted only in a genuinely unshallow repository: in a shallow clone, a commit with no parents can simply be where history was cut off, not a real root commit, so it gets the same `not assessable` notice instead of being assumed created. When git cannot answer the question at all, the doc gets a `not assessable` notice instead of either a STALE warning or a silent pass.",
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

    // `--dirty-as-now` asked for, but git could not tell us what is dirty
    // (a `status` past RunGit's output cap, a `rev-parse` failure, git
    // missing): every path below then falls through to committed history,
    // which is the RIGHT fallback but the WRONG silence -- "the flag found
    // nothing dirty" and "the flag never ran" produce the identical empty
    // finding list. Say so once, bundle-level, in the same style as the
    // "not inside a git work tree" notice above (and, like that one,
    // emitted only here: `sources-fresh-future` shares the same degraded
    // state and relies on this single notice instead of duplicating it).
    if (ctx.dirtyAsNow && getDirtyStateShared(ctx, git, repoRoot) === null) {
      findings.push({
        ruleId: RULE_ID,
        severity: "notice",
        file: "",
        message:
          "`--dirty-as-now` not applied: git status could not be read, judging by committed history only",
      });
    }

    // One git call per unique source path across all docs, even though a
    // STALE/untracked finding is reported per (doc, path) below.
    const commitEpochCache = new Map<string, number | null>();
    // `--dirty-as-now`: every dirty path's "commit epoch" is the SAME
    // virtual-commit instant, shared (by `ctx` identity) with
    // `sources-fresh-future`'s doc-epoch lookup below -- see
    // `commitEpochWithDirtyAsNow`'s doc comment for why this lives in one
    // place instead of being reimplemented per rule.
    const commitEpochFor = (source: string): number | null =>
      commitEpochWithDirtyAsNow(ctx, git, repoRoot, source, () => {
        const cached = commitEpochCache.get(source);
        if (cached !== undefined) return cached;
        const epoch = getLastCommitEpoch(git, repoRoot, source);
        commitEpochCache.set(source, epoch);
        return epoch;
      });

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
      // GIT PROCESS BUDGET per doc per `check` run, `--dirty-as-now` OFF: 1
      // (the shared `git log -1 --format=%ct` epoch lookup) + at most 4 on
      // the re-stamp path (`git log -1 --format=%H%n%P`, `git diff-tree`,
      // two `git show`s), i.e. AT MOST 5 regardless of how many sources the
      // doc declares, since both lookups are memoized per doc. Plus one `git
      // log` per UNIQUE source path across the bundle (commitEpochCache),
      // and, per RUN rather than per doc, at most one `git rev-parse
      // --show-prefix` (getShowPrefixShared, spent the first time any
      // re-stamp lookup needs the top-level path frame) and at most one
      // `git rev-parse --is-shallow-repository` (isShallowRepoShared).
      // Pinned by "spends at most five git processes per doc" in
      // test/sources-fresh.test.ts.
      //
      // With `--dirty-as-now` ON, add one `git status` per run (the
      // show-prefix read above is shared with it, see readDirtyState) plus,
      // PER DOC, at most one `git ls-tree` and one `git show`, spent only
      // when that doc is itself dirty AND some source of its reads stale.
      const repoRelDocPath = toRepoRelDocPath(repoRoot, ctx.bundleDir, doc);
      const docCommitEpochFor = (): number | null =>
        getDocCommitEpochShared(ctx, git, repoRoot, repoRelDocPath);
      const showPrefixFor = (): string | null =>
        getShowPrefixShared(ctx, git, repoRoot);
      // The single decision point for "did the doc's last commit, real or
      // virtual, actually re-stamp it". A dirty doc (under `--dirty-as-now`)
      // is judged by its WORKING-TREE value against the value committed at
      // HEAD, the virtual commit's implicit first parent
      // (`dirtyDocRestampVerdict`); any other doc is judged against its real
      // last commit's first parent (`restampedByOwnLastCommit`). Because
      // `docCommitEpochFor` already reports a dirty doc's epoch as "now"
      // (`commitEpochWithDirtyAsNow`), the ordinary `docCommitEpoch >=
      // commitEpoch` gate below fires for a dirty doc exactly as for a real
      // co-commit, so ONE verdict function is picked here rather than two
      // mechanisms answering overlapping questions.
      let restampMemo: RestampResult | undefined;
      const restampFor = (): RestampResult => {
        if (restampMemo !== undefined) return restampMemo;
        restampMemo =
          ctx.dirtyAsNow && isDirtyForShared(ctx, git, repoRoot, repoRelDocPath)
            ? dirtyDocRestampVerdict(
                git,
                repoRoot,
                repoRelDocPath,
                doc.frontmatter.parsed,
                showPrefixFor,
              )
            : restampedByOwnLastCommit(
                git,
                repoRoot,
                repoRelDocPath,
                () => isShallowRepoShared(ctx, git, repoRoot),
                showPrefixFor,
              );
        return restampMemo;
      };
      // At most one "not assessable" notice per doc, however many of its
      // sources hit the unanswerable re-stamp question. Likewise at most
      // one "moved backwards" warning per doc (see the isStale branch
      // below), independent of the notice.
      let notAssessableReported = false;
      let backwardsReported = false;

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

        if (isStale) {
          // Doc committed (or, under `--dirty-as-now`, virtually committed
          // right now) at/after the source, AND that commit actually
          // re-stamped it: not stale (see comment above). A doc without git
          // history (null epoch, e.g. uncommitted and clean, no dirty
          // status at all) keeps the frontmatter-only comparison. When git
          // cannot answer the re-stamp question at all, the doc is reported
          // as not assessable rather than being guessed either way: calling
          // it STALE would turn a git hiccup into a red build, and calling
          // it fresh would be a silent pass.
          const docCommitEpoch = docCommitEpochFor();
          if (docCommitEpoch !== null && docCommitEpoch >= commitEpoch) {
            const result = restampFor();
            if (result.verdict === "restamped") {
              isStale = false;
            } else if (
              result.verdict === "unknown" ||
              result.verdict === "unknown-shallow-root"
            ) {
              if (!notAssessableReported) {
                notAssessableReported = true;
                findings.push({
                  ruleId: RULE_ID,
                  severity: "notice",
                  file: doc.relPath,
                  message:
                    result.verdict === "unknown-shallow-root"
                      ? "staleness not assessable: this is a shallow clone (`git clone --depth`), so git cannot tell whether the doc's earliest available commit really created it or is just where history was cut off -- use `fetch-depth: 0` (or an unshallow checkout) to assess it"
                      : "staleness not assessable: git could not read the doc's own last commit to decide whether it re-stamped the doc",
                });
              }
              continue;
            } else if (result.backwards && !backwardsReported) {
              // Not restamped (isStale stays true, reported as the usual
              // STALE warning below), PLUS one extra warning per doc
              // naming the doc and both instants: a backwards move is not
              // a re-verification and must not blend silently into the
              // ordinary STALE wording (AC-002).
              backwardsReported = true;
              const locationPhrase =
                result.backwards.location === "working-tree"
                  ? "in the working tree"
                  : "in the doc's last commit";
              findings.push({
                ruleId: RULE_ID,
                severity: "warning",
                file: doc.relPath,
                message: `re-stamp moved backwards: timestamp ${result.backwards.previousIso} -> ${result.backwards.newIso} ${locationPhrase} is not a re-verification`,
              });
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
 * yet) is likewise "unknown, not flagged" by DEFAULT: there is no real
 * commit time to compare the timestamp against, and flagging every
 * hand-authored, not-yet-committed doc as "future-dated" would be a false
 * positive on every fresh draft. Under `--dirty-as-now` (`ctx.dirtyAsNow`),
 * this changes: `getDocCommitEpochShared` below substitutes the shared
 * virtual-commit "now" instant for ANY dirty doc's epoch (untracked
 * included -- see `commitEpochWithDirtyAsNow`), so a dirty doc DOES get a
 * real comparison here, exactly the working-tree parity `--dirty-as-now`
 * exists for: a `timestamp` re-stamped to "now" reads fresh (within the
 * skew allowance), while one still carrying an implausible future value
 * gets caught before the commit that would otherwise make it so in CI.
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
 * The dirty state of the work tree as `--dirty-as-now` reads it: the full
 * SET of top-level-relative paths `git status` reports as dirty, plus the
 * show `prefix` (see `getShowPrefixShared`) that respells a path relative
 * to `ctx.repoRoot` in that same frame. Both halves travel together so a
 * caller can never match a path against the set having forgotten the
 * prefix -- see `isDirtyForShared`.
 */
interface DirtyState {
  /** `getShowPrefixShared`'s answer: `""` at the top level, else `sub/`. */
  prefix: string;
  /** Top-level-relative (never root-relative) dirty paths. */
  paths: Set<string>;
}

/**
 * The full SET of top-level-relative paths `git status` reports as dirty
 * (modified, staged, or untracked) across the WHOLE work tree, read via a
 * SINGLE `status` process per `check` run (never per source or per doc).
 * Used only behind `--dirty-as-now`: a dirty path has no "last commit" yet
 * that reflects its current content, so `sources-fresh` substitutes the
 * current time for it instead of `getLastCommitEpoch`'s necessarily stale
 * answer.
 *
 * `--no-optional-locks`: a read-only check (often a hook or CI step) must
 * not rewrite the index as a side effect. No `--ignored`: an ignored
 * source keeps its "untracked by git, staleness unknown" notice.
 *
 * `--untracked-files=all` is load-bearing. Under git's default untracked
 * mode a brand-new directory collapses into ONE `? newdir/` record and the
 * files inside it are never listed, while the matcher (`isDirtyForShared`)
 * matches a queried path that IS an entry or is an ANCESTOR of one -- so a
 * source or doc INSIDE a new directory matched nothing and silently kept
 * its committed-history verdict, the local/CI divergence this flag exists
 * to remove. The cost is one record per untracked file; a status past
 * RunGit's 16 MiB cap resolves to null like any other git failure and is
 * reported, never treated as "nothing is dirty".
 *
 * `--porcelain=v2 -z` rather than v1: RunGit `.trim()`s every output, and a
 * v1 line for an unstaged-only change starts with a LITERAL SPACE (` M
 * path`), so as the first line its leading field byte would be eaten and
 * the path mis-cut. Every v2 record starts with a non-whitespace kind
 * byte, and NUL delimiting keeps a path with a space, tab or non-ASCII
 * byte intact. Record shapes (fixed fields are read positionally, never
 * re-split by content): `? path`; `1 XY sub mH mI mW hH hI path` (8 fixed
 * fields); `2 XY sub mH mI mW hH hI score path\0origPath` (9 fixed fields,
 * origPath is the FOLLOWING token; both sides of a rename count as dirty);
 * `u XY sub m1 m2 m3 mW h1 h2 h3 path` (10 fixed fields).
 *
 * A failed git call (either one) makes the WHOLE state null: every path
 * then keeps its ordinary commit-epoch verdict, and the rule surfaces that
 * once as the bundle-level "`--dirty-as-now` not applied" notice, since
 * "the flag silently did nothing" and "nothing was dirty" are otherwise
 * indistinguishable to a reader of an empty finding list.
 */
function readDirtyState(
  ctx: BundleContext,
  git: RunGit,
  repoRoot: string,
): DirtyState | null {
  const prefix = getShowPrefixShared(ctx, git, repoRoot);
  if (prefix === null) return null;
  const out = git(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ],
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
      paths.add(normalizeRelPath(token.slice(2)));
      i += 1;
    } else if (kind === "1") {
      paths.add(normalizeRelPath(token.split(" ").slice(8).join(" ")));
      i += 1;
    } else if (kind === "2") {
      paths.add(normalizeRelPath(token.split(" ").slice(9).join(" ")));
      const origPath = tokens[i + 1];
      if (origPath !== undefined) paths.add(normalizeRelPath(origPath));
      i += 2;
    } else if (kind === "u") {
      paths.add(normalizeRelPath(token.split(" ").slice(10).join(" ")));
      i += 1;
    } else {
      // An unrecognized record kind (should not occur without --ignored,
      // which is never passed): skip rather than mis-parse it as a path.
      i += 1;
    }
  }
  return { prefix, paths };
}

/**
 * Canonicalizes a repo-relative path spelling before it is used as a dirty
 * lookup key or matched against one: strips a leading `./` and a trailing
 * `/`, converts backslashes, and collapses `.`/`..` segments and duplicate
 * slashes via `path.posix.normalize`. `git status` always reports canonical
 * forward-slash paths, but a frontmatter-authored `sources` entry is under
 * no such obligation: `./srcdir` and `srcdir/` name the same directory
 * `srcdir` does and MUST match the same dirty entries (a raw `srcdir/`
 * would build a self-defeating `srcdir//` prefix, a raw `./srcdir` never
 * matches at all). Applied on BOTH sides of every dirty-path comparison in
 * this file.
 *
 * `.`, `./` and the empty string all normalize to `.`, the root directory
 * itself: a legal `sources` spelling but never a `git status` entry, so
 * `isDirtyForShared` answers it by containment instead of by lookup.
 */
function normalizeRelPath(relPath: string): string {
  let p = relPath.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = path.posix.normalize(p);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Per-run cache (keyed by `BundleContext`, same pattern as
 * `docCommitEpochCache` below) of `readDirtyState`'s answer, so the WHOLE
 * `check` run -- both rules, every doc, every source -- spends at most one
 * `git status` (plus one `git rev-parse --show-prefix`) process, not one
 * per rule. A cached `null` (the git read failed) is a real cached answer,
 * hence the `.has` check rather than a truthiness test: a failed read is
 * not retried per source.
 */
const dirtyStateCache = new WeakMap<BundleContext, DirtyState | null>();

function getDirtyStateShared(
  ctx: BundleContext,
  git: RunGit,
  repoRoot: string,
): DirtyState | null {
  if (dirtyStateCache.has(ctx)) return dirtyStateCache.get(ctx) ?? null;
  const state = readDirtyState(ctx, git, repoRoot);
  dirtyStateCache.set(ctx, state);
  return state;
}

/**
 * Whether `relPath` (a `sources` entry OR a doc's own path relative to
 * `ctx.repoRoot`, in any spelling `normalizeRelPath` accepts) is dirty per
 * `git status`. The queried path is first respelled in the top-level frame
 * every reported entry uses (`toTopLevelPath`; a no-op when `--repo-root`
 * IS the top level). A dirty FILE then matches by exact normalized path; a
 * dirty DIRECTORY source matches if any reported path lives under it (a
 * `/`-terminated prefix, so `srcdirX/x.ts` never matches `srcdir`). `.`
 * names the root directory itself, which `git status` never reports as an
 * entry, so it is matched by containment: any dirty path at all.
 *
 * A failed state read (`null`) is "nothing is dirty": every path keeps its
 * ordinary commit-epoch verdict, and the rule reports the failure once at
 * bundle level (see `readDirtyState`).
 */
function isDirtyForShared(
  ctx: BundleContext,
  git: RunGit,
  repoRoot: string,
  relPath: string,
): boolean {
  const state = getDirtyStateShared(ctx, git, repoRoot);
  if (state === null) return false;
  const { paths } = state;
  const normalized = normalizeRelPath(toTopLevelPath(state.prefix, relPath));
  if (normalized === ".") return paths.size > 0;
  if (paths.has(normalized)) return true;
  const prefix = `${normalized}/`;
  for (const p of paths) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Per-run cache (keyed by `BundleContext`) of the SINGLE "now" instant
 * `--dirty-as-now` substitutes for every dirty path's commit epoch, across
 * BOTH rules and every doc/source they assess: one `check` run models every
 * dirty path as landing in the same virtual commit.
 *
 * THE CACHE IS THE GUARANTEE, not the order the callers happen to run in:
 * the rescue gate is an INEQUALITY (`docCommitEpoch >= commitEpoch`) whose
 * two sides are BOTH this value when a dirty doc is paired with a dirty
 * source, and reading the clock afresh per side would let a second boundary
 * between the two reads flip it into a silent, unreproducible STALE
 * depending on which side asked first. The clock is read exactly ONCE per
 * run (`ctx.now`, defaulting to `Date.now`, injectable so a test can pin
 * that count); every caller wanting "now" goes through this accessor.
 */
const nowEpochCache = new WeakMap<BundleContext, number>();

function getNowEpochShared(ctx: BundleContext): number {
  let epoch = nowEpochCache.get(ctx);
  if (epoch === undefined) {
    epoch = Math.floor((ctx.now ?? Date.now)() / 1000);
    nowEpochCache.set(ctx, epoch);
  }
  return epoch;
}

/**
 * Per-run cache of `git rev-parse --show-prefix` for `repoRoot`: `""` when
 * `repoRoot` IS the repository's top level, otherwise its path relative to
 * the top level with a trailing slash (`sub/`, `a/b/`); `null` when git
 * could not answer. Read at most once per run, and by everything in this
 * file that has to speak in the TOP-LEVEL path frame.
 *
 * THE INVARIANT: every path this file receives is relative to `repoRoot`,
 * but `git status` entries, `git diff-tree --name-status` entries and the
 * `<rev>:<path>` blob spelling `git show` takes are all top-level-relative
 * (a bare `<rev>:<path>` is NOT resolved against the cwd). The two frames
 * coincide only when `--repo-root` names the top level. Under a
 * `--repo-root` naming a SUBDIRECTORY, a root-relative path used in the
 * top-level frame either matches nothing (a blob read fails, a dirty path
 * never matches) or, worse, reads a SAME-NAMED file at the top level in
 * the doc's place and judges the doc by a stranger's stamp. So every
 * cross-frame step goes through `toTopLevelPath` with this prefix, never
 * a bare path.
 */
const showPrefixCache = new WeakMap<BundleContext, string | null>();

function getShowPrefixShared(
  ctx: BundleContext,
  git: RunGit,
  repoRoot: string,
): string | null {
  if (showPrefixCache.has(ctx)) return showPrefixCache.get(ctx) ?? null;
  // `""` (this IS the top level) is a valid answer; only an outright
  // failure is null.
  const raw = git(["rev-parse", "--show-prefix"], repoRoot);
  const prefix =
    raw === null ? null : raw === "" ? "" : `${normalizeRelPath(raw)}/`;
  showPrefixCache.set(ctx, prefix);
  return prefix;
}

/** `rootRelPath` (relative to `repoRoot`) respelled in the top-level frame `showPrefix` (from `getShowPrefixShared`) describes. */
function toTopLevelPath(showPrefix: string, rootRelPath: string): string {
  return `${showPrefix}${rootRelPath}`;
}

/**
 * THE one place a blob is read: `git show <rev>:<topLevelPath>`. The path
 * MUST already be in the top-level frame (`toTopLevelPath`), see
 * `getShowPrefixShared`. Null on any git failure, "no such path at that
 * rev" included.
 */
function showBlob(
  git: RunGit,
  repoRoot: string,
  rev: string,
  topLevelPath: string,
): string | null {
  return git(["show", `${rev}:${topLevelPath}`], repoRoot);
}

/**
 * THE single choke point where `--dirty-as-now`'s virtual-commit model is
 * applied: a dirty `relPath` (source or doc, see `isDirtyForShared`) is
 * judged as committed at the shared "now" instant (`getNowEpochShared`)
 * instead of consulting `actualEpoch` at all; anything else -- the flag
 * off, or `relPath` not dirty -- defers to `actualEpoch` (typically a
 * memoized real `git log` lookup), byte-identical to pre-flag behavior.
 * Every commit-epoch read in this file that is meant to honor
 * `--dirty-as-now` MUST go through this function (directly, or via
 * `getDocCommitEpochShared` below, which is itself built on it) rather
 * than re-implementing the dirty check inline, so a source's epoch and a
 * doc's own epoch are always read the same way, by both rules.
 */
function commitEpochWithDirtyAsNow(
  ctx: BundleContext,
  git: RunGit,
  repoRoot: string,
  relPath: string,
  actualEpoch: () => number | null,
): number | null {
  if (ctx.dirtyAsNow && isDirtyForShared(ctx, git, repoRoot, relPath)) {
    return getNowEpochShared(ctx);
  }
  return actualEpoch();
}

/**
 * `--dirty-as-now` only: the verdict for "did the doc's OWN uncommitted
 * working-tree state re-stamp it" -- the virtual-commit analogue of
 * `restampedByOwnLastCommit`'s co-commit check, used in its place (see
 * `restampFor` in the rule above) whenever the doc itself is dirty. The
 * virtual commit's implicit "first parent" is simply HEAD, so this compares
 * the doc's CURRENT (working-tree) parsed `timestamp` value -- already read
 * from disk by the caller, since `BundleDoc` always reflects the working
 * tree, dirty or not -- against the value committed at HEAD for the same
 * path. Per D-004, only a value that moves STRICTLY LATER than the one
 * committed at HEAD counts as re-stamped; a backwards move is
 * `not-restamped` and flagged via `compareRestampDirection`'s `backwards`
 * field (`location: "working-tree"`), mirroring the committed rescue's
 * direction rule documented on `restampedByOwnLastCommit` below.
 *
 * Distinguishes a genuinely untracked/new doc (no entry for this path at
 * HEAD at all -- `git ls-tree HEAD -- <path>` succeeds with EMPTY output,
 * never a git failure) from a real git failure reading an EXISTING HEAD
 * blob (`git show` itself failing -- a corrupt object, an unreadable blob):
 * the former counts as "restamped" (there is no prior committed value to
 * compare against, so its whole content, stamp included, is new -- the
 * working-tree equivalent of "the doc being created there"); the latter is
 * `unknown`, falling through to the rule's existing not-assessable notice
 * rather than being silently treated the same as "created". `git ls-tree`
 * itself failing (an unborn HEAD, git unavailable) is likewise `unknown`.
 */
function dirtyDocRestampVerdict(
  git: RunGit,
  repoRoot: string,
  repoRelDocPath: string,
  onDiskParsed: unknown,
  showPrefix: () => string | null,
): RestampResult {
  // A pathspec (`--`), cwd-relative: stays in the root-relative frame.
  const treeEntry = git(
    ["ls-tree", "-z", "HEAD", "--", repoRelDocPath],
    repoRoot,
  );
  if (treeEntry === null) return { verdict: "unknown" };
  if (treeEntry === "") return { verdict: "restamped" };

  const prefix = showPrefix();
  if (prefix === null) return { verdict: "unknown" };
  const committed = showBlob(
    git,
    repoRoot,
    "HEAD",
    toTopLevelPath(prefix, repoRelDocPath),
  );
  if (committed === null) return { verdict: "unknown" };
  return compareRestampDirection(
    onDiskParsed,
    parseFrontmatter(committed).frontmatter.parsed,
    "working-tree",
  );
}

function epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Per-run cache of a doc's own REAL (committed) last-commit epoch, keyed by
 * the `BundleContext` instance so `sources-fresh`'s doc-commit comparison
 * and `sources-fresh-future`'s timestamp comparison -- both need the
 * IDENTICAL (repoRoot, doc path) `getLastCommitEpoch` lookup for every doc
 * in one `check` invocation -- share one `git log` process per doc instead
 * of each rule spawning its own. Safe to key on the context object itself:
 * a fresh `BundleContext` is built per `runCheck`/`loadBundle` call, so
 * nothing reuses a stale cache entry across invocations, and the WeakMap
 * lets the cache be garbage-collected with the context once a run is done.
 *
 * `getDocCommitEpochShared` below is the single place BOTH rules read a
 * doc's commit epoch from, and it is itself built on
 * `commitEpochWithDirtyAsNow`: under `--dirty-as-now`, a dirty doc's epoch
 * is the shared virtual "now" instant instead of this real cache's answer,
 * so `sources-fresh`'s co-commit rescue and `sources-fresh-future`'s
 * timestamp comparison always see the identical (real-or-virtual) epoch
 * for the same doc in the same `check` run.
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
  return commitEpochWithDirtyAsNow(ctx, git, repoRoot, repoRelDocPath, () => {
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
  });
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
 * The full result of a restamp-direction decision: the `RestampVerdict`
 * plus, when the value moved BACKWARDS (the new instant is strictly EARLIER
 * than the one it replaced), the two parsed instants so the rule can report
 * exactly what moved and where (`location` distinguishes the committed path
 * from the `--dirty-as-now` working-tree path, since the two produce
 * differently worded findings). Kept as a structured field on the result
 * rather than a bare boolean so a caller can never lose or misplace which
 * commit/working-tree pair the movement belongs to.
 */
type RestampResult = {
  verdict: RestampVerdict;
  backwards?: {
    previousIso: string;
    newIso: string;
    location: "commit" | "working-tree";
  };
};

/**
 * Decides the value-comparison branch of a restamp verdict from two parsed
 * frontmatter values: `beforeParsed` (the older side: the first parent's
 * committed value, or the value committed at HEAD for the dirty path) and
 * `currentParsed` (the newer side: the commit's own value, or the on-disk
 * working-tree value for the dirty path).
 *
 * D-004: a re-stamp only counts when the new value is STRICTLY LATER than
 * the value it replaced -- comparing PARSED INSTANTS (epoch seconds), never
 * raw strings, so a squash that re-dates sources (and the doc) to the merge
 * instant still passes (later than any pre-merge stamp) while a genuinely
 * backdated re-stamp does not. Three outcomes:
 *
 *  - new epoch > old epoch: `restamped` (a real re-verification).
 *  - new epoch < old epoch: `not-restamped`, AND flagged via `backwards` --
 *    a backwards move is never a re-verification and is additionally
 *    reported as its own warning by the caller.
 *  - new epoch === old epoch (a cosmetic rewrite, e.g. adding milliseconds,
 *    or switching between a quoted string and a native YAML date that name
 *    the same instant): `not-restamped`, but NOT `backwards` -- nothing was
 *    certified newer, but nothing moved backwards either.
 *
 * When EITHER side's `timestamp` cannot be parsed to an epoch at all
 * (missing, blank, or a string `Date.parse` rejects), direction cannot be
 * judged: this falls back to today's pre-D-004 behaviour of comparing the
 * two values' raw IDENTITY (`getTimestampIdentity`) instead of guessing a
 * direction -- any textual change still counts as `restamped`, exactly as
 * before this decision existed, and never triggers `backwards` (there is no
 * direction to report).
 */
function compareRestampDirection(
  currentParsed: unknown,
  beforeParsed: unknown,
  location: "commit" | "working-tree",
): RestampResult {
  const currentEpoch = getTimestampEpoch(currentParsed);
  const beforeEpoch = getTimestampEpoch(beforeParsed);
  if (currentEpoch === undefined || beforeEpoch === undefined) {
    const currentStamp = getTimestampIdentity(currentParsed);
    const beforeStamp = getTimestampIdentity(beforeParsed);
    return {
      verdict: currentStamp !== beforeStamp ? "restamped" : "not-restamped",
    };
  }
  if (currentEpoch > beforeEpoch) return { verdict: "restamped" };
  if (currentEpoch < beforeEpoch) {
    return {
      verdict: "not-restamped",
      backwards: {
        previousIso: epochToIso(beforeEpoch),
        newIso: epochToIso(currentEpoch),
        location,
      },
    };
  }
  return { verdict: "not-restamped" };
}

/**
 * Whether `doc`'s own last commit actually re-stamped it, decided by
 * comparing the doc's PARSED FRONTMATTER `timestamp` VALUE at that commit
 * against its value in the commit's FIRST PARENT (see
 * `compareRestampDirection`: the new value must be strictly LATER, not
 * merely different, D-004). A doc created by that
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
 * repo-wide formatter run, a rename) without moving the stamp strictly
 * forward carries no verification claim and must NOT suppress staleness;
 * only a commit that actually moved the stamp to a later instant (or
 * created the doc) does.
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
 * Its limits, stated rather than hidden: this answers "did the value move
 * strictly forward", never "is the new value plausible". A hand-typed
 * forward-dated stamp still counts as a re-stamp (`sources-fresh-future` is
 * the rule that catches an implausible future value), and comparing against
 * only the FIRST parent means a merge that takes its doc content wholesale
 * from the second parent is judged against the first-parent baseline, which
 * is the same baseline the PR under review is measured against.
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
  showPrefix: () => string | null,
): RestampResult {
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
  if (head === null) return { verdict: "unknown" };
  const [sha, parentLine] = head.split("\n");
  if (!sha) return { verdict: "unknown" };
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
    return { verdict: isShallowRepo() ? "unknown-shallow-root" : "restamped" };
  }
  const firstParent = parents[0];

  // From here on everything git reports or takes is in the top-level frame
  // (see getShowPrefixShared): the diff-tree entries previousPathIn matches
  // against, and both `<rev>:<path>` blob reads.
  const prefix = showPrefix();
  if (prefix === null) return { verdict: "unknown" };
  const topLevelDocPath = toTopLevelPath(prefix, repoRelDocPath);

  const previous = previousPathIn(
    git,
    repoRoot,
    firstParent,
    sha,
    topLevelDocPath,
  );
  if (previous.kind === "unknown") return { verdict: "unknown" };
  if (previous.kind === "created") return { verdict: "restamped" };

  const current = showBlob(git, repoRoot, sha, topLevelDocPath);
  if (current === null) return { verdict: "unknown" };
  const before = showBlob(git, repoRoot, firstParent, previous.path);
  if (before === null) return { verdict: "unknown" };

  // Both undefined (no parseable stamp on either side) compares equal in
  // compareRestampDirection's identity fallback, i.e. "not re-stamped" --
  // nothing was rewritten, so nothing is claimed.
  return compareRestampDirection(
    parseFrontmatter(current).frontmatter.parsed,
    parseFrontmatter(before).frontmatter.parsed,
    "commit",
  );
}

/**
 * Where the doc lived in `parentSha`, so its previous revision can be read
 * by that path: the same path (`same`), a different one it was renamed from
 * (`renamed`), or nowhere at all because that commit created it (`created`).
 * `topLevelDocPath` and every returned path are in the top-level frame,
 * the one `diff-tree --name-status` reports in (see getShowPrefixShared).
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
 * `topLevelDocPath` never string-equals that quoted form and a non-ASCII doc
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
  topLevelDocPath: string,
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
      if (newPath === topLevelDocPath) {
        return { kind: "renamed", path: oldPath };
      }
      continue;
    }
    const p = tokens[i + 1];
    i += 2;
    if (p !== topLevelDocPath) continue;
    if (status.startsWith("A")) return { kind: "created" };
    return { kind: "same", path: topLevelDocPath };
  }
  return { kind: "same", path: topLevelDocPath };
}
