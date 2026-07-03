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

export interface BundleContext {
  bundleDir: string;
  repoRoot?: string;
  docs: BundleDoc[];
}

export interface Rule {
  id: string;
  description: string;
  run(ctx: BundleContext): Finding[];
}
