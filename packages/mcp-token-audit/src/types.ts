// Shapes we actually read from Claude Code transcript JSONL. ContentBlock
// is intentionally loose (index signature, unknown fields) because a
// transcript line carries far more than this, and we only care about the
// message.content tool_use / tool_result blocks. There is no separate
// ToolUseBlock/ToolResultBlock interface: aggregate.ts pulls individual
// fields (id, name, input, tool_use_id, content) out with its own
// defensive casts and typeof checks at the point of use, since transcript
// content is untrusted input. A narrower discriminated type would not
// remove that need, because the shape isn't guaranteed to match at
// runtime regardless of what TypeScript infers from `block.type`.

export type ContentBlock = { type: string; [key: string]: unknown };

export interface MessageEntry {
  type: "user" | "assistant";
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  [key: string]: unknown;
}

export type TranscriptEntry =
  MessageEntry | { type: string; [key: string]: unknown };

/** Per-tool aggregate over one or more transcript files. */
export interface ToolStats {
  tool: string;
  calls: number;
  /** Sum of approximate input characters (tool_use.input, JSON-stringified). */
  charsIn: number;
  /** Sum of approximate output characters (tool_result.content, stringified). */
  charsOut: number;
}

export interface AuditTotals {
  calls: number;
  charsIn: number;
  charsOut: number;
}

export interface AuditResult {
  /** Per-tool stats, sorted descending by total (in+out) characters. */
  perTool: ToolStats[];
  totals: AuditTotals;
  /** Subset of totals for tools whose name starts with `mcp__`. */
  mcpTotals: AuditTotals;
  skippedLines: number;
  filesScanned: number;
  /**
   * Transcript files that could not be read at all (permissions, a race
   * with log rotation, ...) and were skipped in their entirety. Distinct
   * from skippedLines, which counts malformed lines within files that
   * were readable.
   */
  skippedFiles: number;
}
