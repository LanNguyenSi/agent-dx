// Orchestration: read transcript files, parse + aggregate each, merge into
// one per-tool ranking, and split out the mcp__* subtotal. The only
// filesystem access here is the read itself (via discover.ts); everything
// else delegates to the pure functions in aggregate.ts.

import { readTranscriptFile } from "./discover.js";
import {
  aggregateEntries,
  mergeToolStats,
  parseTranscript,
} from "./aggregate.js";
import type { AuditResult, AuditTotals, ToolStats } from "./types.js";

const MCP_PREFIX = "mcp__";

/**
 * Audit a list of transcript file paths: parse each (tolerating malformed
 * lines and unreadable files), merge per-tool stats across all of them,
 * and rank by total (in+out) characters descending. `skippedDirs` is
 * threaded straight through from discover.ts's findTranscriptFiles (the
 * caller resolved `paths` from a set of project directories, some of
 * which may have been unreadable) so it ends up on the same AuditResult
 * as the other skip counters, for the CLI to report in one place.
 */
export function auditFiles(paths: string[], skippedDirs = 0): AuditResult {
  const merged = new Map<string, ToolStats>();
  let skippedLines = 0;
  let filesScanned = 0;
  let skippedFiles = 0;

  for (const path of paths) {
    let raw: string;
    try {
      raw = readTranscriptFile(path);
    } catch {
      // Unreadable file (permissions, race with rotation, ...): skip the
      // whole file, counted in skippedFiles. Not counted in skippedLines,
      // which tracks malformed *lines* within files we could read.
      skippedFiles += 1;
      continue;
    }
    filesScanned += 1;
    const { entries, skipped } = parseTranscript(raw);
    skippedLines += skipped;
    mergeToolStats(merged, aggregateEntries(entries));
  }

  const perTool = [...merged.values()].sort(
    (a, b) => totalChars(b) - totalChars(a),
  );
  const totals = sumTotals(perTool);
  const mcpTotals = sumTotals(
    perTool.filter((t) => t.tool.startsWith(MCP_PREFIX)),
  );

  return {
    perTool,
    totals,
    mcpTotals,
    skippedLines,
    filesScanned,
    skippedFiles,
    skippedDirs,
  };
}

function totalChars(stats: ToolStats): number {
  return stats.charsIn + stats.charsOut;
}

function sumTotals(list: ToolStats[]): AuditTotals {
  return list.reduce(
    (acc, t) => ({
      calls: acc.calls + t.calls,
      charsIn: acc.charsIn + t.charsIn,
      charsOut: acc.charsOut + t.charsOut,
    }),
    { calls: 0, charsIn: 0, charsOut: 0 },
  );
}
