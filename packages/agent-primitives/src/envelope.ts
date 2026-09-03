import fs from "node:fs";
import path from "node:path";

export const TOOL_NAME = "agent-primitives";

/**
 * Every subcommand's status maps to one of three classes, which in turn
 * maps to a stable exit code: a subagent can gate on `&&` without parsing
 * the JSON body, and a typo in a flag never reads as a "survived" finding.
 */
export type StatusClass = "ok" | "finding" | "cannot-conclude";

const STATUS_CLASS: Record<string, StatusClass> = {
  // ok class -> exit 0
  ok: "ok",
  pass: "ok",
  killed: "ok",
  unchanged: "ok",
  written: "ok",
  // finding class -> exit 1
  missing: "finding",
  fail: "finding",
  survived: "finding",
  conflicted: "finding",
  // cannot-conclude class -> exit 2
  usage_error: "cannot-conclude",
  inconclusive: "cannot-conclude",
  error: "cannot-conclude",
};

/**
 * Resolve a status string to its class. An unrecognized status is treated
 * as cannot-conclude (exit 2): a caller must never fall through to the
 * "ok" exit code for a status this module was not told about.
 */
export function statusClass(status: string): StatusClass {
  return STATUS_CLASS[status] ?? "cannot-conclude";
}

/** Exit code for a status: ok -> 0, finding -> 1, cannot-conclude -> 2. */
export function exitCodeForStatus(status: string): number {
  switch (statusClass(status)) {
    case "ok":
      return 0;
    case "finding":
      return 1;
    case "cannot-conclude":
    default:
      return 2;
  }
}

export interface EnvelopeInput {
  version: string;
  command: string;
  status: string;
  durationMs: number;
  cwd: string;
  warnings?: string[];
  /** Pre-existing log paths (e.g. exec log files) to keep in `logs`. */
  logs?: string[];
  /** Subcommand-specific fields, merged into the envelope alongside the base fields. */
  extra?: Record<string, unknown>;
  /** Serialized envelope hard bound. Defaults to 8000. */
  maxChars?: number;
  /**
   * Directory to write the full, untruncated result to when reduction is
   * needed. Required for truncation to record a `logs` path; when omitted
   * and truncation is needed, no full-result file is written (only the
   * `truncated: true` marker is set).
   */
  logDir?: string;
}

export interface EnvelopeOutput {
  envelope: Record<string, unknown>;
  exitCode: number;
}

const DEFAULT_MAX_CHARS = 8000;

// Fixed reduction ladders, applied in order, each stopping as soon as the
// envelope fits under maxChars.
// Never cut a failure list all the way to 0 here: at least one failure
// entry is kept for the message-length and tail steps below to act on,
// and (if the skeleton itself is still too large) for the final hard cut
// to shrink further. A caller that truly wants zero failures should not
// pass a failures list to begin with.
const FAILURE_CAPS = [10, 5, 2, 1];
const MESSAGE_CAPS = [1000, 300, 100, 20];
const TAIL_CAPS = [6000, 2000, 500, 100, 0];

function serializedLength(obj: unknown): number {
  return JSON.stringify(obj).length;
}

/** Recursively find and cap every array field named `failures`. */
function capFailureLists(obj: unknown, cap: number): boolean {
  let changed = false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (capFailureLists(item, cap)) changed = true;
    }
    return changed;
  }
  if (obj !== null && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key === "failures" && Array.isArray(rec[key])) {
        const arr = rec[key] as unknown[];
        if (arr.length > cap) {
          rec[key] = arr.slice(0, cap);
          changed = true;
        }
      } else if (capFailureLists(rec[key], cap)) {
        changed = true;
      }
    }
  }
  return changed;
}

/** Recursively find and cap the length of every string field named `message`. */
function capMessages(obj: unknown, cap: number): boolean {
  let changed = false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (capMessages(item, cap)) changed = true;
    }
    return changed;
  }
  if (obj !== null && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const val = rec[key];
      if (key === "message" && typeof val === "string" && val.length > cap) {
        rec[key] = val.slice(0, cap);
        changed = true;
      } else if (capMessages(val, cap)) {
        changed = true;
      }
    }
  }
  return changed;
}

/** Recursively find and cap the length of every string field whose key ends in "Tail". */
function capTails(obj: unknown, cap: number): boolean {
  let changed = false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (capTails(item, cap)) changed = true;
    }
    return changed;
  }
  if (obj !== null && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const val = rec[key];
      if (key.endsWith("Tail") && typeof val === "string" && val.length > cap) {
        rec[key] = val.slice(0, cap);
        changed = true;
      } else if (capTails(val, cap)) {
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Find the largest string value anywhere in the object (recursively) and
 * return a path to reach it plus its current length, or undefined when no
 * string field is present. Used as the final, unconditional hard cut so
 * `JSON.stringify(result).length <= maxChars` always holds, even for a
 * pathological single field (e.g. a multi-megabyte one-line tail) that the
 * fixed ladders above did not fully reduce.
 */
function findLargestString(
  obj: unknown,
  path: Array<string | number> = [],
): { path: Array<string | number>; length: number } | undefined {
  let best: { path: Array<string | number>; length: number } | undefined;
  if (typeof obj === "string") {
    return { path, length: obj.length };
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const candidate = findLargestString(obj[i], [...path, i]);
      if (candidate && (!best || candidate.length > best.length))
        best = candidate;
    }
    return best;
  }
  if (obj !== null && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const candidate = findLargestString(val, [...path, key]);
      if (candidate && (!best || candidate.length > best.length))
        best = candidate;
    }
    return best;
  }
  return undefined;
}

function setAtPath(
  obj: unknown,
  keyPath: Array<string | number>,
  value: unknown,
): void {
  let cursor: unknown = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    cursor = (cursor as Record<string | number, unknown>)[keyPath[i]];
  }
  const last = keyPath[keyPath.length - 1];
  (cursor as Record<string | number, unknown>)[last] = value;
}

/**
 * Final, unconditional hard cut: repeatedly shorten the single largest
 * string field until the serialized object fits maxChars, or no string
 * field remains. Guarantees `serializedLength(obj) <= maxChars` whenever
 * the non-string skeleton itself fits in that budget.
 */
function hardCut(obj: unknown, maxChars: number): boolean {
  let changed = false;
  let guard = 0;
  while (serializedLength(obj) > maxChars && guard < 100) {
    guard++;
    const overBy = serializedLength(obj) - maxChars;
    const target = findLargestString(obj);
    if (!target || target.length === 0) break;
    const newLength = Math.max(0, target.length - overBy - 16);
    const newValue = getAtPath(obj, target.path).slice(0, newLength);
    setAtPath(obj, target.path, newValue);
    changed = true;
  }
  return changed;
}

function getAtPath(obj: unknown, keyPath: Array<string | number>): string {
  let cursor: unknown = obj;
  for (const key of keyPath) {
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor as string;
}

/**
 * Build the final envelope: merges the base fields with `extra`, then
 * applies the reduction order (failure lists, then message lengths, then
 * output tails, then a final hard cut of the largest remaining string)
 * until `JSON.stringify(envelope).length <= maxChars`. Sets `truncated:
 * true` and appends the full-result path to `logs` whenever anything was
 * cut. Returns the envelope plus the exit code implied by `status`.
 */
export function buildEnvelope(input: EnvelopeInput): EnvelopeOutput {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const logs = [...(input.logs ?? [])];

  const envelope: Record<string, unknown> = {
    tool: TOOL_NAME,
    version: input.version,
    command: input.command,
    status: input.status,
    durationMs: input.durationMs,
    cwd: input.cwd,
    truncated: false,
    logs,
    warnings: input.warnings ?? [],
    ...(input.extra ?? {}),
  };
  // `extra` must not be able to shadow `logs`/`truncated` after the fact.
  envelope.logs = logs;

  if (serializedLength(envelope) <= maxChars) {
    return { envelope, exitCode: exitCodeForStatus(input.status) };
  }

  // A full, untruncated copy is captured before any reduction so it can be
  // written to the log dir once we know truncation is unavoidable.
  const fullResult = JSON.parse(JSON.stringify(envelope));

  envelope.truncated = true;
  // The full-result log path is appended to `logs` BEFORE the reduction
  // ladders run (not after): appending it later, once the envelope has
  // already been cut down to fit exactly, would grow the envelope back
  // past maxChars by however many characters the path itself adds. Adding
  // it first means every reduction step below - including the final hard
  // cut - accounts for its size too, so the bound still holds afterward.
  if (input.logDir) {
    try {
      fs.mkdirSync(input.logDir, { recursive: true });
      const fullResultPath = path.join(input.logDir, "result-full.json");
      fs.writeFileSync(fullResultPath, JSON.stringify(fullResult, null, 2));
      logs.push(fullResultPath);
      envelope.logs = logs;
    } catch {
      // Best effort: truncation itself must not fail the command.
    }
  }

  for (const cap of FAILURE_CAPS) {
    capFailureLists(envelope, cap);
    if (serializedLength(envelope) <= maxChars) break;
  }
  if (serializedLength(envelope) > maxChars) {
    for (const cap of MESSAGE_CAPS) {
      capMessages(envelope, cap);
      if (serializedLength(envelope) <= maxChars) break;
    }
  }
  if (serializedLength(envelope) > maxChars) {
    for (const cap of TAIL_CAPS) {
      capTails(envelope, cap);
      if (serializedLength(envelope) <= maxChars) break;
    }
  }
  if (serializedLength(envelope) > maxChars) {
    hardCut(envelope, maxChars);
  }

  return { envelope, exitCode: exitCodeForStatus(input.status) };
}
