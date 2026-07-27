// Pure text-rendering logic for the `slop-detector check` CLI command.
// Kept separate from `cli.ts` (which wires up commander, stdin, and
// `process.exit`) so it can be unit-tested directly without importing a
// module that runs `program.parseAsync()` as a side effect of import —
// same reason `mcp-check.ts` is kept separate from `mcp.ts`'s stdio
// transport wiring.

import type { CheckSummary, Severity } from "./types.js";

/**
 * Render a CheckSummary as the CLI's plain-text output: any engine-level
 * warnings first (e.g. an `entrypointGlobs` pattern that matched no
 * scanned files), then either the "clean" line or the violation list
 * grouped by file, then a tally. Returns the full text (including trailing
 * newlines) for the caller to write to stdout.
 */
export function renderText(summary: CheckSummary, explain: boolean): string {
  let text = "";
  for (const warning of summary.warnings ?? []) {
    text += `slop-detector: warning: ${warning}\n`;
  }
  if (summary.violations.length === 0) {
    text += `slop-detector: clean (${summary.filesScanned} files scanned)\n`;
    return text;
  }
  const byFile = groupBy(summary.violations, (v) => v.path);
  for (const [filePath, vs] of byFile) {
    text += `\n${filePath}\n`;
    for (const v of vs) {
      const sev = severityLabel(v.severity);
      text += `  ${sev} ${v.line}:${v.column}  ${v.ruleId}  ${v.message}\n`;
      if (explain) {
        text += `    ↪ ${v.rationale}\n`;
      }
    }
  }
  text += `\n${summary.filesScanned} files scanned, ${summary.violations.length} violations (block ${summary.blockCount}, warn ${summary.warnCount}, info ${summary.infoCount})\n`;
  return text;
}

function severityLabel(s: Severity): string {
  switch (s) {
    case "block":
      return "BLOCK";
    case "warn":
      return "WARN ";
    case "info":
      return "INFO ";
  }
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}
