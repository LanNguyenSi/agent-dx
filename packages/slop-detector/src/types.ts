export type Severity = "block" | "warn" | "info";

export type PackId = "agent-tics" | "prose-slop" | "comment-slop" | "code-slop" | "ui-slop";

export interface FileTarget {
  path: string;
  text: string;
  kind: FileKind;
}

export type FileKind = "prose" | "code" | "style" | "markup" | "binary";

/** A single exported symbol, pre-resolved to a report-ready location. */
export interface CorpusExportEntry {
  file: string;
  symbol: string;
  loc: { line: number; column: number; endLine: number; endColumn: number };
  /** Short source snippet for the violation's `matched` field. */
  snippet: string;
}

export interface Corpus {
  /**
   * Every exported symbol in the scan root, keyed as "file::symbol".
   * Built by `buildCorpus` when the corpus feature flag is active.
   * Consumed directly by `code-slop/unused-export` — rules do not need to
   * re-parse a file to recompute its own exports.
   */
  exports: Map<string, CorpusExportEntry>;
  /**
   * The same entries as `exports`, grouped by file for O(1) "give me this
   * file's exports" access instead of a full scan of `exports`.
   */
  exportsByFile: Map<string, CorpusExportEntry[]>;
  /**
   * Inverted index: identifier name -> set of files whose reference set
   * contains that name (imported, called, or re-exported from). Lets
   * corpus-aware rules answer "is this name used by any file other than
   * mine?" in O(1) instead of scanning every file's reference set per
   * export.
   */
  referencingFilesByName: Map<string, Set<string>>;
  /**
   * Source files reachable from the nearest package.json
   * via `main`, `bin`, or `exports` fields, plus any file matched by
   * `config.entrypointGlobs`.
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
  /**
   * Glob patterns (matched relative to the scan root) marking additional
   * files as public-API entrypoints for the corpus pre-pass, on top of
   * whatever `package.json` main/bin/exports resolve to. Use this to mark
   * a `src/` barrel whose package.json entrypoints point at compiled
   * `dist/` output, so the corpus-aware rules don't flag its re-exports.
   */
  entrypointGlobs: string[];
}

export interface CheckSummary {
  filesScanned: number;
  violations: Violation[];
  blockCount: number;
  warnCount: number;
  infoCount: number;
}
