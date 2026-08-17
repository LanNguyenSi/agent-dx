// Pure text/JSON rendering of an AuditResult. Kept separate from cli.ts
// (which wires up commander and process I/O) so it can be unit-tested
// directly, same reason slop-detector splits cli-render.ts from cli.ts.

import { charsToTokens } from "./aggregate.js";
import type { AuditResult, ToolStats } from "./types.js";

export interface ToolRow {
  tool: string;
  calls: number;
  tokIn: number;
  tokOut: number;
  tokPerCall: number;
}

export function toRows(perTool: ToolStats[]): ToolRow[] {
  return perTool.map((t) => {
    const tokIn = charsToTokens(t.charsIn);
    const tokOut = charsToTokens(t.charsOut);
    const tokPerCall =
      t.calls === 0 ? 0 : Math.round((tokIn + tokOut) / t.calls);
    return { tool: t.tool, calls: t.calls, tokIn, tokOut, tokPerCall };
  });
}

export interface JsonOutput {
  filesScanned: number;
  skippedLines: number;
  skippedFiles: number;
  tools: ToolRow[];
  totals: { calls: number; tokIn: number; tokOut: number; tok: number };
  mcp: {
    calls: number;
    tokIn: number;
    tokOut: number;
    tok: number;
    pctOfTotal: number;
  };
}

export function toJsonOutput(result: AuditResult): JsonOutput {
  const tools = toRows(result.perTool);
  const totalTokIn = charsToTokens(result.totals.charsIn);
  const totalTokOut = charsToTokens(result.totals.charsOut);
  const totalTok = totalTokIn + totalTokOut;
  const mcpTokIn = charsToTokens(result.mcpTotals.charsIn);
  const mcpTokOut = charsToTokens(result.mcpTotals.charsOut);
  const mcpTok = mcpTokIn + mcpTokOut;
  return {
    filesScanned: result.filesScanned,
    skippedLines: result.skippedLines,
    skippedFiles: result.skippedFiles,
    tools,
    totals: {
      calls: result.totals.calls,
      tokIn: totalTokIn,
      tokOut: totalTokOut,
      tok: totalTok,
    },
    mcp: {
      calls: result.mcpTotals.calls,
      tokIn: mcpTokIn,
      tokOut: mcpTokOut,
      tok: mcpTok,
      pctOfTotal: totalTok === 0 ? 0 : round2((mcpTok / totalTok) * 100),
    },
  };
}

export function renderJson(result: AuditResult): string {
  return JSON.stringify(toJsonOutput(result), null, 2) + "\n";
}

export function renderText(result: AuditResult): string {
  const rows = toRows(result.perTool);
  let text = "";

  if (rows.length === 0) {
    text += "mcp-token-audit: no tool calls found\n";
  } else {
    const header = ["tool", "calls", "~tok_in", "~tok_out", "~tok/call"];
    const dataRows = rows.map((r) => [
      r.tool,
      String(r.calls),
      String(r.tokIn),
      String(r.tokOut),
      String(r.tokPerCall),
    ]);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...dataRows.map((row) => row[i].length)),
    );
    const formatRow = (cells: string[]) =>
      cells
        .map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
        .join("  ");
    text += formatRow(header) + "\n";
    for (const row of dataRows) {
      text += formatRow(row) + "\n";
    }
  }

  const out = toJsonOutput(result);
  text += `\ntotal: ${out.totals.calls} calls, ~${out.totals.tokIn} tok in, ~${out.totals.tokOut} tok out, ~${out.totals.tok} tok\n`;
  text += `mcp__*: ${out.mcp.calls} calls, ~${out.mcp.tok} tok (${out.mcp.pctOfTotal.toFixed(1)}% of total)\n`;
  if (result.skippedLines > 0) {
    text += `skipped ${result.skippedLines} malformed line(s)\n`;
  }
  if (result.skippedFiles > 0) {
    text += `skipped ${result.skippedFiles} unreadable file(s)\n`;
  }
  text += `${result.filesScanned} transcript file(s) scanned\n`;
  return text;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
