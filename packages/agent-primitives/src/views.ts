import type { DriftResult } from "./drift/index.js";
import type { HygieneResult } from "./hygiene/index.js";
import type { CheckResult, VerifyResult } from "./verify/types.js";

/**
 * Compact views for `hygiene`, `drift` and `verify`: `--summary` (one line
 * per finding, site or check plus a totals line) and the list of top-level
 * envelope fields `--print` accepts. They are a second rendering of the
 * result the JSON envelope is built from and change nothing about it;
 * `probe` has its own renderers in `probe/summary.ts`.
 */

/** Envelope fields every command carries, plus the `fullResult` pointer
 * a reduced envelope adds. */
const COMMON_PRINTABLE_FIELDS: readonly string[] = [
  "tool",
  "version",
  "command",
  "status",
  "durationMs",
  "cwd",
  "truncated",
  "logs",
  "warnings",
  "fullResult",
];

/** Top-level envelope fields `hygiene --print` accepts. */
export const HYGIENE_PRINTABLE_FIELDS: readonly string[] = [
  ...COMMON_PRINTABLE_FIELDS,
  "base",
  "head",
  "base_sha",
  "head_sha",
  "merge_base",
  "max_delete_percent",
  "extend_only",
  "findings",
  "counts",
];

/** Top-level envelope fields `drift --print` accepts. */
export const DRIFT_PRINTABLE_FIELDS: readonly string[] = [
  ...COMMON_PRINTABLE_FIELDS,
  "base",
  "head",
  "base_sha",
  "head_sha",
  "merge_base",
  "removed_identifiers",
  "sites",
  "allowlisted",
  "counts",
];

/** Top-level envelope fields `verify --print` accepts. */
export const VERIFY_PRINTABLE_FIELDS: readonly string[] = [
  ...COMMON_PRINTABLE_FIELDS,
  "reason",
  "checks",
  "totalDurationMs",
];

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cap(value: string, max: number): string {
  const line = oneLine(value);
  return line.length > max ? line.slice(0, max - 3) + "..." : line;
}

const size = (rows: readonly string[]): number =>
  rows.reduce((n, r) => n + r.length + 1, 0);

/**
 * Joins `rows` and `tail` into the printed summary, bounded by `maxChars`
 * the way `probe --summary` is: the `tail` (the totals line) always
 * survives, the rows that do not fit are replaced by one marker line
 * naming how many were left out and, when it fits, where the full result
 * is. `noun` names what a row is (`finding`, `site`, `line`).
 */
function fitSummary(
  rows: readonly string[],
  tail: readonly string[],
  maxChars: number,
  noun: string,
  fullResult: string | undefined,
): string {
  if (size(rows) + size(tail) <= maxChars) {
    return [...rows, ...tail].join("\n") + "\n";
  }
  const marker = (omitted: number): string => {
    const base = `... ${omitted} more ${noun}${omitted === 1 ? "" : "s"} omitted (-m ${maxChars} characters); `;
    const withPath =
      fullResult !== undefined
        ? `${base}raise -m or read the full result: ${fullResult}`
        : `${base}raise -m`;
    // A long path must not push the summary past -m: fall back to the
    // short hint when the marker with the path cannot sit beside the tail.
    return withPath.length + 1 + size(tail) <= maxChars
      ? withPath
      : `${base}raise -m`;
  };
  let kept = rows.length;
  while (
    kept > 0 &&
    size(rows.slice(0, kept)) +
      marker(rows.length - kept).length +
      1 +
      size(tail) >
      maxChars
  ) {
    kept -= 1;
  }
  return (
    [...rows.slice(0, kept), marker(rows.length - kept), ...tail].join("\n") +
    "\n"
  );
}

function warningRows(warnings: readonly string[]): string[] {
  return warnings.map((w) => `warning: ${oneLine(w)}`);
}

function withFullResult(
  totals: string,
  fullResult: string | undefined,
): string {
  return fullResult === undefined
    ? totals
    : `${totals} fullResult=${fullResult}`;
}

/** `hygiene --summary`: `<kind> | <path> | <detail>` per finding, then the
 * warnings, then a `totals:` line. */
export function renderHygieneSummary(
  result: HygieneResult,
  maxChars: number,
  fullResult?: string,
): string {
  const rows = [
    ...result.findings.map(
      (f) => `${f.kind} | ${f.path} | ${cap(f.detail, 200)}`,
    ),
    ...warningRows(result.warnings),
  ];
  const c = result.counts;
  const totals = withFullResult(
    `totals: status=${result.status} files=${c.files} findings=${result.findings.length} backup_files=${c.backupFiles} extend_only_rewrites=${c.extendOnlyRewrites} test_case_drops=${c.testCaseDrops} warnings=${result.warnings.length}`,
    fullResult,
  );
  return fitSummary(rows, [totals], maxChars, "line", fullResult);
}

/** `drift --summary`: `<path>:<line> | <identifier> | <kind>[ | allowlisted]
 * | <text>` per site in `sites`, then the warnings, then a `totals:` line. */
export function renderDriftSummary(
  result: DriftResult,
  maxChars: number,
  fullResult?: string,
): string {
  const rows = [
    ...result.sites.map(
      (s) =>
        `${s.path}:${s.line} | ${s.identifier} | ${s.kind}${s.allowlisted === true ? " | allowlisted" : ""} | ${cap(s.text, 140)}`,
    ),
    ...warningRows(result.warnings),
  ];
  const c = result.counts;
  const totals = withFullResult(
    `totals: status=${result.status} removed=${c.removed} sites=${c.sites} allowlisted=${c.allowlisted} warnings=${result.warnings.length}`,
    fullResult,
  );
  return fitSummary(rows, [totals], maxChars, "line", fullResult);
}

function checkLine(check: CheckResult): string {
  const s = check.summary;
  const parts = [
    check.name,
    check.status,
    `exit=${check.exitCode === null ? "-" : String(check.exitCode)}`,
    `${check.durationMs}ms`,
    `passed=${s.passed} failed=${s.failed} skipped=${s.skipped} errors=${s.errors}`,
  ];
  if (check.reason !== undefined) parts.push(`reason=${check.reason}`);
  const first = check.failures[0];
  if (first !== undefined) {
    const where = [first.file, first.line].filter(Boolean).join(":");
    parts.push(
      `first failure: ${cap(`${where ? `${where}: ` : ""}${first.message}`, 160)}`,
    );
  }
  return parts.join(" | ");
}

/** `verify --summary`: one line per check (name, status, exit code,
 * duration, tallies, the reason of a skipped check, the first failure),
 * then the warnings, then a `totals:` line. */
export function renderVerifySummary(
  result: VerifyResult,
  maxChars: number,
  fullResult?: string,
): string {
  const rows = [
    ...result.checks.map(checkLine),
    ...warningRows(result.warnings),
  ];
  const count = (status: CheckResult["status"]): number =>
    result.checks.filter((c) => c.status === status).length;
  const totals = withFullResult(
    `totals: status=${result.status}${result.reason !== undefined ? ` reason=${result.reason}` : ""} checks=${result.checks.length} pass=${count("pass")} fail=${count("fail")} skipped=${count("skipped")} error=${count("error")} totalDurationMs=${result.totalDurationMs} warnings=${result.warnings.length}`,
    fullResult,
  );
  return fitSummary(rows, [totals], maxChars, "line", fullResult);
}
