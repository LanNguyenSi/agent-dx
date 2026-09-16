export type Severity = "block" | "warn" | "info";

export type PackId =
  | "agent-tics"
  | "prose-slop"
  | "comment-slop"
  | "code-slop"
  | "ui-slop"
  | "placement-slop"
  | "workflow-slop";

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
   * Every exported symbol in the scan root, grouped by file. Built by
   * `buildCorpus` when the corpus feature flag is active and consumed
   * directly by `code-slop/unused-export` — the rule does not re-parse a
   * file or re-walk its AST to rediscover its own export list.
   *
   * Note: a file with multiple declarations for the same exported name
   * (e.g. overloaded `function` signatures, each satisfying
   * `extractDeclaredNames`) produces one entry per declaration here, not
   * one per unique symbol name — callers that care about uniqueness must
   * de-duplicate by `symbol`.
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
  /**
   * `config.entrypointGlobs` patterns that matched zero scanned files.
   * `checkFiles` turns these into `CheckSummary.warnings` — a typo'd or
   * wrongly-rooted glob otherwise fails silently and the corpus rules
   * behave exactly as if `entrypointGlobs` had never been set.
   */
  unmatchedEntrypointGlobs: string[];
}

export interface RuleContext {
  file: FileTarget;
  config: ResolvedConfig;
  /** Present only when SLOP_CORPUS=1 env var or config.corpus:true is active. */
  corpus?: Corpus;
  /**
   * The absolute directory a scan-root-relative glob (e.g.
   * `placement.instructionGlobs`) should be matched against. Always
   * populated by `checkText`/`checkFiles`/`checkPath`: `CheckOptions.scanRoot`
   * when given, else the nearest directory containing a `package.json`
   * (walked up from the file being checked), else `process.cwd()` — the
   * same fallback order `buildCorpus`/`_resolveEntrypointGlobs` use for
   * `entrypointGlobs`. Optional only so a hand-built `RuleContext` (as
   * opposed to one produced by the engine) still type-checks.
   */
  scanRoot?: string;
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
   * Glob patterns marking additional files as public-API entrypoints for
   * the corpus pre-pass, on top of whatever `package.json` main/bin/exports
   * resolve to. Use this to mark a `src/` barrel whose package.json
   * entrypoints point at compiled `dist/` output, so the corpus-aware
   * rules don't flag its re-exports.
   *
   * Matched relative to `CheckOptions.scanRoot` when given, else the
   * nearest directory containing a `package.json`, else `process.cwd()`
   * (see `buildCorpus` in engine.ts). Optional and defaulting to `[]` so
   * that omitting it — including from a hand-built `ResolvedConfig`
   * object, as opposed to one produced by `defaultConfig`/`mergeConfig` —
   * is not a breaking change.
   */
  entrypointGlobs?: string[];
  /**
   * Config surface for the `placement-slop` pack: org-, machine-, and
   * point-in-time-bound evidence leaking into reusable instruction files.
   * All three fields default to `[]` in `defaultConfig`/`mergeConfig`, so a
   * hand-built `ResolvedConfig` that omits `placement` entirely (as opposed
   * to one produced by those two functions) still works: every rule reads
   * through `config.placement?.<field> ?? []`.
   */
  placement?: {
    /** Regex patterns (compiled as given, no implicit flags) naming this org's own handles/products/paths. */
    markers: string[];
    /** Additive glob patterns, on top of the pack's built-in instruction-file globs (SKILL.md, AGENTS.md, ...). */
    instructionGlobs: string[];
    /** Regex patterns; a line matching any of these is skipped by every rule in the pack. */
    allow: string[];
  };
  /**
   * Config surface for the `workflow-slop` pack: GitHub Actions `run:`
   * expression-injection detection. Defaults to `[]` in
   * `defaultConfig`/`mergeConfig`, so a hand-built `ResolvedConfig` that
   * omits `workflow` entirely still works: the rule reads through
   * `config.workflow?.allowExpressions ?? []`.
   */
  workflow?: {
    /**
     * Additional exact-match expression bodies (as written between
     * `${{` and `}}`, whitespace-trimmed) treated as safe on top of the
     * pack's built-in allowlist — for example a repo-verified-literal
     * `matrix.<field>` reference, which the pack deliberately excludes
     * by default (see `workflow-slop.ts` for why).
     */
    allowExpressions: string[];
    /**
     * Additional `owner/repo@vN` entries treated as a Node-20 GitHub
     * Actions major by `workflow-slop/node20-action-major`, on top of the
     * pack's built-in default list (`src/data/node20-actions.ts`). Lets a
     * repo extend the list (a newly discovered Node-20 major, or a
     * locally vendored action) without waiting on a slop-detector release.
     */
    node20Majors: string[];
    /**
     * `owner/repo@vN` entries removed from the effective Node-20 list
     * before `workflow-slop/node20-action-major` runs (applied after
     * `node20Majors`, so it can also drop a config-added entry). Use this
     * once an action's moving major tag has migrated off Node 20.
     */
    node20MajorsIgnore: string[];
    /**
     * Exact npm-audit gate blocks this repo has reviewed and vouched
     * for, recognised by `workflow-slop/audit-gate-shape` on top of its
     * built-in shapes. Ships empty: a canonical gate block is org
     * content, not package content, so the package carries no template
     * of its own.
     */
    auditGateTemplates: AuditGateTemplate[];
  };
}

/**
 * One registered npm-audit gate template. `sha256` is the digest of the
 * gate block's normalised statements (each statement trimmed, joined by
 * newlines); `statements` is the same list written out, from which the
 * digest is computed. Exactly one of the two is given.
 *
 * A matched template is trusted as is: `audit-gate-shape` runs no shape
 * analysis on a block whose digest matches, because registering the
 * digest is the operator's statement that they reviewed this exact
 * script. The cost is the flip side of that: any later edit to a
 * registered block changes its digest and is reported until the
 * operator registers the new one.
 */
export interface AuditGateTemplate {
  /** Name used in messages and in the config file, for the operator. */
  name: string;
  /** Lowercase hex sha256 of the newline-joined trimmed statements. */
  sha256?: string;
  /** The normalised statements themselves, hashed the same way. */
  statements?: string[];
}

export interface CheckSummary {
  filesScanned: number;
  violations: Violation[];
  blockCount: number;
  warnCount: number;
  infoCount: number;
  /**
   * Engine-level configuration warnings, distinct from lint violations —
   * currently populated with one entry per zero-match glob pattern from
   * either `entrypointGlobs` or `placement.instructionGlobs`. Absent (not
   * just empty) when there is nothing to report, so existing consumers
   * that don't check for it are unaffected.
   */
  warnings?: string[];
}
