/**
 * Finding order and report assembly. The report is built key by key in a
 * fixed order and carries nothing machine-local: no absolute path, no time.
 */
import {
  REPORT_FORMAT,
  type AckedFinding,
  type Finding,
  type LintReport,
  type Mode,
  type Profile,
  type ProfileSource,
} from "./types.js";
import type { SpecStatus } from "../formats/index.js";

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The sort key of every list in the report: `file`, then `line` (a finding
 * without a line first), then `path`, `rule`, `id` (none first) and
 * `message`, strings by UTF-16 code unit so the order does not depend on a
 * locale.
 */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    compareText(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.path, b.path) ||
    compareText(a.rule, b.rule) ||
    compareText(a.id ?? "", b.id ?? "") ||
    compareText(a.message, b.message)
  );
}

/** A finding with its keys in report order and no undefined value. */
function shape<T extends Finding>(finding: T): T {
  const out: Record<string, unknown> = {
    rule: finding.rule,
    level: finding.level,
    file: finding.file,
    path: finding.path,
  };
  if (finding.id !== undefined) out["id"] = finding.id;
  if (finding.line !== undefined) out["line"] = finding.line;
  if (finding.code !== undefined) out["code"] = finding.code;
  out["message"] = finding.message;
  const reason = (finding as Partial<AckedFinding>).reason;
  if (reason !== undefined) out["reason"] = reason;
  return out as unknown as T;
}

export interface ReportInput {
  spec: string | null;
  mode: Mode;
  profile: Profile;
  profileSource: ProfileSource;
  status: SpecStatus | null;
  strict: boolean;
  errors: readonly Finding[];
  warnings: readonly Finding[];
  acked: readonly AckedFinding[];
}

export function buildReport(input: ReportInput): LintReport {
  const errors = [...input.errors].sort(compareFindings).map(shape);
  const warnings = [...input.warnings].sort(compareFindings).map(shape);
  const acked = [...input.acked].sort(compareFindings).map(shape);
  return {
    format: REPORT_FORMAT,
    spec: input.spec,
    mode: input.mode,
    profile: input.profile,
    profile_source: input.profileSource,
    status: input.status,
    ok: errors.length === 0 && (!input.strict || warnings.length === 0),
    errors,
    warnings,
    acked,
    counts: {
      errors: errors.length,
      warnings: warnings.length,
      acked: acked.length,
    },
  };
}
