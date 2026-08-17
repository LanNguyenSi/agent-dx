// Shapes we actually read from Claude Code transcript JSONL. Both are
// intentionally loose (index signatures, unknown fields) because a
// transcript line carries far more than this, and we only care about the
// message.content tool_use / tool_result blocks.

export interface ToolUseBlock {
  type: "tool_use";
  id?: unknown;
  name?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export type ContentBlock =
  ToolUseBlock | ToolResultBlock | { type: string; [key: string]: unknown };

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
}
