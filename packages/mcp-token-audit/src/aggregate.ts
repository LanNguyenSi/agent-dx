// Pure parsing and aggregation logic: JSONL text in, per-tool token
// approximations out. No filesystem access here (that lives in
// discover.ts / audit.ts) so this is directly unit-testable against
// hand-written fixtures.

import type {
  ContentBlock,
  MessageEntry,
  ToolStats,
  TranscriptEntry,
} from "./types.js";

/**
 * Parse a transcript's raw JSONL text into entries, skipping blank lines
 * and any line that fails to JSON.parse. Malformed lines are counted, not
 * thrown on: a truncated write or a mid-session crash should not make the
 * whole file unusable for auditing.
 */
export function parseTranscript(raw: string): {
  entries: TranscriptEntry[];
  skipped: number;
} {
  const entries: TranscriptEntry[] = [];
  let skipped = 0;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

function isMessageEntry(entry: TranscriptEntry): entry is MessageEntry {
  return entry.type === "user" || entry.type === "assistant";
}

function contentBlocks(entry: TranscriptEntry): ContentBlock[] {
  if (!isMessageEntry(entry)) return [];
  const content = entry.message?.content;
  if (!content || typeof content === "string") return [];
  return content;
}

/**
 * Approximate a token count from a character count (~4 chars/token for
 * English text). This is a rough heuristic, not a real tokenizer call: it
 * is meant for relative before/after comparisons of MCP response-payload
 * size, not for billing or exact context accounting.
 */
export function charsToTokens(chars: number): number {
  return Math.round(chars / 4);
}

function stringifyToolResultContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text ?? "");
        }
        return JSON.stringify(block);
      })
      .join("");
  }
  return JSON.stringify(content);
}

interface PendingToolUse {
  name: string;
  charsIn: number;
}

/**
 * Pair tool_use blocks with their tool_result by tool_use.id /
 * tool_result.tool_use_id, and aggregate call counts plus approximate
 * in/out character totals per tool name.
 *
 * Two-pass by construction: a tool_use and its tool_result can land on
 * different transcript lines, and with sidechains/parallel calls the
 * ordering between unrelated pairs is not guaranteed. So this first
 * collects every tool_use by id (name + input size), then every
 * tool_result's output size by tool_use_id, then folds the two together.
 * A tool_use with no matching tool_result (e.g. a transcript truncated
 * mid-call) still counts as a call, with charsOut 0.
 */
export function aggregateEntries(
  entries: TranscriptEntry[],
): Map<string, ToolStats> {
  const toolUses = new Map<string, PendingToolUse>();
  const resultChars = new Map<string, number>();

  for (const entry of entries) {
    for (const block of contentBlocks(entry)) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        const id = (block as { id?: unknown }).id;
        const name = (block as { name?: unknown }).name;
        if (typeof id !== "string" || typeof name !== "string") continue;
        const input = (block as { input?: unknown }).input;
        const charsIn = input === undefined ? 0 : JSON.stringify(input).length;
        toolUses.set(id, { name, charsIn });
      } else if (block.type === "tool_result") {
        const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id;
        if (typeof toolUseId !== "string") continue;
        const content = (block as { content?: unknown }).content;
        resultChars.set(toolUseId, stringifyToolResultContent(content).length);
      }
    }
  }

  const perTool = new Map<string, ToolStats>();
  for (const [id, { name, charsIn }] of toolUses) {
    const charsOut = resultChars.get(id) ?? 0;
    const stats = perTool.get(name) ?? {
      tool: name,
      calls: 0,
      charsIn: 0,
      charsOut: 0,
    };
    stats.calls += 1;
    stats.charsIn += charsIn;
    stats.charsOut += charsOut;
    perTool.set(name, stats);
  }
  return perTool;
}

/** Fold `source` per-tool stats into `target`, mutating `target` in place. */
export function mergeToolStats(
  target: Map<string, ToolStats>,
  source: Map<string, ToolStats>,
): void {
  for (const [name, stats] of source) {
    const existing = target.get(name);
    if (existing) {
      existing.calls += stats.calls;
      existing.charsIn += stats.charsIn;
      existing.charsOut += stats.charsOut;
    } else {
      target.set(name, { ...stats });
    }
  }
}
