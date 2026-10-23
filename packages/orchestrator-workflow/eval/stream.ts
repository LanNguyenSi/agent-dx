import { readFileSync } from "node:fs";

import type { SessionJson } from "./runner.js";

/**
 * Parsing of a `claude -p --output-format stream-json --verbose` session: one
 * JSON object per line. The canary reads its tool calls and their results
 * from here, because the host can observe what a tool did without taking the
 * session's own account of it (event shapes of Claude Code 2.1.x:
 * `system`/`init`, `assistant` messages with `tool_use` blocks, `user`
 * messages with `tool_result` blocks, one closing `result` event).
 */

export interface StreamToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StreamToolResult {
  toolUseId: string;
  isError: boolean;
  text: string;
}

export interface StreamInit {
  tools: string[];
  skills: string[];
  slashCommands: string[];
  agents: string[];
  permissionMode: string | null;
  model: string | null;
}

export interface ParsedStream {
  /** The `system`/`init` event, or null when the stream carries none. */
  init: StreamInit | null;
  /** Tool calls in the order the session made them. */
  toolUses: StreamToolUse[];
  /** Results by `tool_use_id`. */
  toolResults: Map<string, StreamToolResult>;
  /** The closing `result` event, or null when the session never printed one. */
  result: Record<string, unknown> | null;
  /** Parsed events, and lines that were not a JSON object. */
  events: number;
  malformed: number;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function names(value: unknown): string[] {
  // `agents` and `skills` are lists of names in some builds and of objects with a name in others.
  if (!Array.isArray(value)) return [];
  return value
    .map((v) =>
      typeof v === "string"
        ? v
        : typeof v === "object" &&
            v !== null &&
            typeof (v as { name?: unknown }).name === "string"
          ? (v as { name: string }).name
          : null,
    )
    .filter((v): v is string => v !== null);
}

/** The text of a `tool_result` content: a string, or a list of text blocks. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

function blocks(message: unknown): Record<string, unknown>[] {
  const content =
    typeof message === "object" && message !== null
      ? (message as { content?: unknown }).content
      : undefined;
  return Array.isArray(content)
    ? content.filter(
        (b): b is Record<string, unknown> =>
          typeof b === "object" && b !== null && !Array.isArray(b),
      )
    : [];
}

/** Parses the stream; a line that is not a JSON object is counted, never fatal. */
export function parseStream(text: string): ParsedStream {
  const out: ParsedStream = {
    init: null,
    toolUses: [],
    toolResults: new Map(),
    result: null,
    events: 0,
    malformed: 0,
  };
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      out.malformed += 1;
      continue;
    }
    out.events += 1;
    if (event.type === "system" && event.subtype === "init") {
      out.init = {
        tools: strings(event.tools),
        skills: names(event.skills),
        slashCommands: strings(event.slash_commands),
        agents: names(event.agents),
        permissionMode:
          typeof event.permissionMode === "string"
            ? event.permissionMode
            : null,
        model: typeof event.model === "string" ? event.model : null,
      };
    } else if (event.type === "assistant") {
      for (const block of blocks(event.message)) {
        if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          out.toolUses.push({
            id: block.id,
            name: block.name,
            input:
              typeof block.input === "object" &&
              block.input !== null &&
              !Array.isArray(block.input)
                ? (block.input as Record<string, unknown>)
                : {},
          });
        }
      }
    } else if (event.type === "user") {
      for (const block of blocks(event.message)) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        )
          out.toolResults.set(block.tool_use_id, {
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            text: resultText(block.content),
          });
      }
    } else if (event.type === "result") {
      out.result = event;
    }
  }
  return out;
}

/**
 * The session's closing object from a stdout file: the whole file when it is
 * one JSON object (`--output-format json`), else the `result` event of a
 * stream. Null when neither exists, for example after a timeout.
 */
export function parseSessionOutput(stdoutFile: string): SessionJson | null {
  let text: string;
  try {
    text = readFileSync(stdoutFile, "utf8");
  } catch {
    return null;
  }
  try {
    const whole: unknown = JSON.parse(text);
    // A one-line stream (a single event) is also one JSON object: only a result, or an object
    // that names no event type, is the session's closing object.
    if (
      typeof whole === "object" &&
      whole !== null &&
      !Array.isArray(whole) &&
      ((whole as { type?: unknown }).type === undefined ||
        (whole as { type?: unknown }).type === "result")
    )
      return whole as SessionJson;
  } catch {
    // Not one object: a stream, or garbage.
  }
  return parseStream(text).result as SessionJson | null;
}

/** One tool call with its result, when the stream has both. */
export interface ObservedCall {
  use: StreamToolUse;
  result: StreamToolResult;
}

/** The calls of `tool` that `match` accepts and that the stream answered. */
export function callsOf(
  stream: ParsedStream,
  tool: string,
  match: (input: Record<string, unknown>) => boolean,
): ObservedCall[] {
  const found: ObservedCall[] = [];
  for (const use of stream.toolUses) {
    if (use.name !== tool || !match(use.input)) continue;
    const result = stream.toolResults.get(use.id);
    if (result !== undefined) found.push({ use, result });
  }
  return found;
}
