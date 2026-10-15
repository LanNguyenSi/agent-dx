export type Severity = "error" | "warning" | "notice";

/**
 * The OKF spec version a bundle is checked against. Detected from the
 * bundle-root `index.md` frontmatter `okf_version` key (OKF v0.2; the quoted-
 * string form and the YAML number form of `0.1`/`0.2` both count, the number
 * only when the frontmatter spells it exactly like that -- `0.20` parses to
 * `0.2` but is not the `0.2` anyone declared), overridden by `check --spec`
 * (`src/cli.ts`), and `v0.1` for every bundle with no key and no frontmatter,
 * exactly as before the key existed.
 */
export type SpecVersion = "v0.1" | "v0.2";

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** Bundle-relative path, forward-slash separated. */
  file: string;
  message: string;
  detail?: string;
}

export interface FrontmatterInfo {
  present: boolean;
  parsed?: unknown;
  parseError?: string;
  /**
   * The frontmatter block's own YAML source text, the lines between the two
   * `---` delimiters (and only those: a body that mentions a frontmatter key
   * is never part of it). `parsed` alone cannot answer "how was this value
   * spelled" -- YAML resolves the number `0.20` to `0.2` -- so a reader that
   * judges the spelling reads it here (see `readOkfVersion`). Undefined when
   * no block is present.
   */
  yaml?: string;
}

export interface BundleDoc {
  /** Bundle-relative path, forward-slash separated. */
  relPath: string;
  basename: string;
  isReserved: boolean;
  raw: string;
  frontmatter: FrontmatterInfo;
  body: string;
}

/**
 * Runs `git <args>` in `cwd`. Returns trimmed stdout on success (git exit
 * code 0), or null on any failure (non-zero exit, not a git work tree, git
 * binary missing). Never throws. Injectable so rules that shell out to git
 * (currently only sources-fresh) can be tested with a stub instead of a
 * real git process.
 */
export type RunGit = (args: string[], cwd: string) => string | null;

/**
 * Opt-in options for `citations-resolve`'s stricter anchor checks (see
 * `--require-anchors` in `src/cli.ts` and the "Anchor strictness (opt-in)"
 * doc block in `src/rules/citations-resolve.ts`). Absent entirely when the
 * opt-in was not requested, so a rule can gate its stricter behavior on a
 * single `ctx.requireAnchors` truthiness check without a separate boolean.
 */
export interface RequireAnchorsOptions {
  /**
   * Glob or exact-match patterns (matched against a citation's raw
   * `citedPath` text, e.g. `"README.md"`), exempting a matching in-repo
   * full citation from the `anchor-required` check.
   */
  allow: string[];
}

/**
 * Opt-in options for `prose-line-references` (see `--prose-line-references`
 * in `src/cli.ts` and `src/rules/prose-line-references.ts`). Absent entirely
 * when the opt-in was not requested, matching `RequireAnchorsOptions`'
 * single-truthiness-check discipline: a consumer that never passes
 * `--prose-line-references` gets byte-identical `check` output to before
 * this rule existed.
 */
export interface ProseLineReferencesOptions {
  /**
   * When true, every prose line reference the extraction grammar finds is
   * flagged (`prose-line-reference-not-anchored`), not only a drifted one --
   * the remedy is always the same: lift it into a backtick `path:N-M`
   * citation, or de-precise it to a symbol name. Ignored (no effect) when
   * `proseLineReferences` itself is absent.
   */
  strict?: boolean;
}

export interface BundleContext {
  bundleDir: string;
  repoRoot?: string;
  docs: BundleDoc[];
  /**
   * The OKF spec version every rule judges this bundle against: detected
   * by `loadBundle` from the bundle-root `index.md` frontmatter
   * `okf_version` key (absent key, absent frontmatter, or an unrecognized
   * value all mean `v0.1`), replaced by `check --spec <version>` when that
   * option is passed (`runCheck` in `src/cli.ts`). Rules that branch on the
   * spec version read it here; rules that do not care stay untouched.
   */
  specVersion: SpecVersion;
  /** Defaults to a real `git` child-process call (see src/git.ts) when a rule needs it and none was injected. */
  runGit?: RunGit;
  /** See `RequireAnchorsOptions`. Undefined when `--require-anchors` was not passed. */
  requireAnchors?: RequireAnchorsOptions;
  /** See `ProseLineReferencesOptions`. Undefined when `--prose-line-references` was not passed. */
  proseLineReferences?: ProseLineReferencesOptions;
  /**
   * Clock-skew allowance (seconds) for `sources-fresh-future` (see
   * `--future-skew-minutes` in `src/cli.ts` and `DEFAULT_FUTURE_SKEW_SECONDS`
   * in `src/rules/sources-fresh.ts`). Undefined when `--future-skew-minutes`
   * was not passed, in which case the rule applies its own default.
   */
  freshnessFutureSkewSeconds?: number;
  /**
   * Opt-in for `sources-fresh` AND `sources-fresh-future` (see
   * `--dirty-as-now` in `src/cli.ts`): every uncommitted change (modified,
   * staged, or untracked per `git status --porcelain --untracked-files=all`) is modeled as though
   * it landed in ONE virtual commit made right now, instead of at its last
   * real commit's time. That virtual-commit epoch is the SINGLE place both
   * rules read a dirty path's "commit time" from (see
   * `getDocCommitEpochShared`/`commitEpochFor` in
   * `src/rules/sources-fresh.ts`): a dirty `sources` path's epoch becomes
   * now (`sources-fresh`'s base comparison), and a dirty DOC's own epoch
   * becomes now too (both `sources-fresh`'s co-commit rescue and
   * `sources-fresh-future`'s timestamp comparison read that same virtual
   * epoch). Closes the gap between a pre-commit `check` run (which sees
   * only committed history) and CI's post-commit run (which sees the new
   * commit time) for content edited but not yet committed. Undefined (the
   * default) leaves both rules looking only at committed history,
   * byte-identical to behavior before this option existed.
   */
  dirtyAsNow?: boolean;
  /**
   * Clock for `--dirty-as-now`'s virtual-commit instant, in milliseconds
   * since the epoch like `Date.now` (the default when undefined). Read
   * exactly ONCE per `check` run (`getNowEpochShared` in
   * `src/rules/sources-fresh.ts`); injectable so a test can pin that count
   * and the shared value rather than racing the wall clock.
   */
  now?: () => number;
  /**
   * Companion bundles for `frontmatter-refs-resolve`: alias -> absolute
   * directory, from repeatable `--companion <alias>=<dir>`. Undefined when
   * none were passed.
   */
  companions?: Map<string, string>;
  /**
   * `--skip-companion-refs`: a `<alias>:<path>` reference whose alias was
   * not passed is a notice instead of an error.
   */
  skipCompanionRefs?: boolean;
}

export interface Rule {
  id: string;
  description: string;
  run(ctx: BundleContext): Finding[];
}
