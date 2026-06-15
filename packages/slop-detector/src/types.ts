export type Severity = "block" | "warn" | "info";

export type PackId = "agent-tics" | "prose-slop" | "comment-slop" | "code-slop" | "ui-slop";

export interface FileTarget {
  path: string;
  text: string;
  kind: FileKind;
}

export type FileKind = "prose" | "code" | "style" | "markup" | "binary";

export interface Corpus {
  /**
   * Every exported symbol in the scan root, keyed as "file::symbol".
   * Built by `buildCorpus` when the corpus feature flag is active.
   */
  exports: Map<string, { file: string; symbol: string }>;
  /**
   * Identifiers referenced (imported or called) per file.
   * Key = absolute file path; value = Set of identifier names.
   */
  referencesByFile: Map<string, Set<string>>;
  /**
   * Source files reachable from the nearest package.json
   * via `main`, `bin`, or `exports` fields.
   */
  entrypoints: Set<string>;
  /**
   * Total count of CallExpression nodes whose callee is a plain Identifier,
   * aggregated across all scanned files.  Used by corpus-aware rules to
   * detect single-call-site helpers.
   */
  callCountBySymbol: Map<string, number>;
}

export interface RuleContext {
  file: FileTarget;
  config: ResolvedConfig;
  /** Present only when SLOP_CORPUS=1 env var or config.corpus:true is active. */
  corpus?: Corpus;
}

export interface Violation {
  ruleId: string;
  pack: PackId;
  severity: Severity;
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  rationale: string;
  matched: string;
}

export interface Rule {
  id: string;
  pack: PackId;
  defaultSeverity: Severity;
  enabledByDefault: boolean;
  rationale: string;
  appliesTo: (file: FileTarget) => boolean;
  check: (ctx: RuleContext) => Violation[];
}

export interface PackDefinition {
  id: PackId;
  description: string;
  rules: Rule[];
}

export interface RuleOverride {
  severity?: Severity;
  enabled?: boolean;
}

export interface ResolvedConfig {
  packs: Record<PackId, boolean>;
  ruleOverrides: Record<string, RuleOverride>;
  ignorePaths: string[];
  treatAsProse: string[];
  treatAsCode: string[];
  /** When true, `checkFiles`/`checkPath` will build a corpus for cross-file rules. */
  corpus?: boolean;
}

export interface CheckSummary {
  filesScanned: number;
  violations: Violation[];
  blockCount: number;
  warnCount: number;
  infoCount: number;
}
