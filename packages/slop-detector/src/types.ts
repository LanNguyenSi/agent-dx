export type Severity = "block" | "warn" | "info";

export type PackId = "agent-tics" | "prose-slop" | "comment-slop" | "code-slop" | "ui-slop";

export interface FileTarget {
  path: string;
  text: string;
  kind: FileKind;
}

export type FileKind = "prose" | "code" | "style" | "markup" | "binary";

export interface RuleContext {
  file: FileTarget;
  config: ResolvedConfig;
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
}

export interface CheckSummary {
  filesScanned: number;
  violations: Violation[];
  blockCount: number;
  warnCount: number;
  infoCount: number;
}
