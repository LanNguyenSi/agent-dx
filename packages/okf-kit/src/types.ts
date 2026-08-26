export type Severity = "error" | "warning" | "notice";

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

export interface BundleContext {
  bundleDir: string;
  repoRoot?: string;
  docs: BundleDoc[];
  /** Defaults to a real `git` child-process call (see src/git.ts) when a rule needs it and none was injected. */
  runGit?: RunGit;
  /** See `RequireAnchorsOptions`. Undefined when `--require-anchors` was not passed. */
  requireAnchors?: RequireAnchorsOptions;
}

export interface Rule {
  id: string;
  description: string;
  run(ctx: BundleContext): Finding[];
}
