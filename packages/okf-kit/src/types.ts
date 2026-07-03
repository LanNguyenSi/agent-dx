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

export interface BundleContext {
  bundleDir: string;
  repoRoot?: string;
  docs: BundleDoc[];
  /** Defaults to a real `git` child-process call (see src/git.ts) when a rule needs it and none was injected. */
  runGit?: RunGit;
}

export interface Rule {
  id: string;
  description: string;
  run(ctx: BundleContext): Finding[];
}
