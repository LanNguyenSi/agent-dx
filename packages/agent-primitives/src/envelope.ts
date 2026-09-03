import fs from "node:fs";
import path from "node:path";

export const TOOL_NAME = "agent-primitives";

/**
 * Thrown by a caller-supplied validation (e.g. doctor's binary-name check)
 * for input that should be reported as `status: usage_error` rather than
 * `status: error`. The CLI's top-level catch distinguishes this from a
 * generic runtime error by instanceof, so callers anywhere in the package
 * can signal a usage error without threading a status code back up.
 */
export class UsageError extends Error {}

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
  /**
   * Requested serialized-envelope bound. Defaults to 8000. This is a
   * request, not an unconditional guarantee: the fixed envelope fields
   * (see PROTECTED_KEYS below) are never cut, so the real floor is
   * `skeletonFloor` (their own serialized size). The actual guarantee is
   * `serializedLength(envelope) <= max(maxChars, skeletonFloor)`; when
   * `maxChars` itself could not be met (because the skeleton alone is
   * already bigger), a warning names the true final length instead of
   * silently exceeding the request.
   */
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

function serializedLength(obj: unknown): number {
  return JSON.stringify(obj).length;
}

function getAtPath(obj: unknown, keyPath: Array<string | number>): unknown {
  let cursor: unknown = obj;
  for (const key of keyPath) {
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
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
 * Walks `obj` (arrays and plain objects), skipping the named keys at the
 * top level only (`path.length === 0`), and calls `visit` for every array
 * and every string found anywhere else in the graph. Shared traversal for
 * the three reducers below so each only needs to define what to do with a
 * candidate, not how to walk the tree.
 */
function walk(
  obj: unknown,
  path: Array<string | number>,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
  visitArray: (path: Array<string | number>, arr: unknown[]) => void,
  visitString: (path: Array<string | number>, str: string) => void,
  visitEntry?: (
    parentPath: Array<string | number>,
    key: string,
    value: unknown,
  ) => void,
): void {
  if (Array.isArray(obj)) {
    visitArray(path, obj);
    for (let i = 0; i < obj.length; i++) {
      walk(
        obj[i],
        [...path, i],
        skipTopLevelKeys,
        visitArray,
        visitString,
        visitEntry,
      );
    }
    return;
  }
  if (typeof obj === "string") {
    visitString(path, obj);
    return;
  }
  if (obj !== null && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (path.length === 0 && skipTopLevelKeys?.has(key)) continue;
      visitEntry?.(path, key, val);
      walk(
        val,
        [...path, key],
        skipTopLevelKeys,
        visitArray,
        visitString,
        visitEntry,
      );
    }
  }
}

/**
 * Finds the array (anywhere in the graph, at least 2 elements so there is
 * something to drop while keeping at least one real element) with the
 * largest own serialized length. Only arrays with >= 2 elements are
 * considered: a 1-element or empty array cannot be usefully shortened by
 * this reducer and is left to the string-cap or subtree-drop steps.
 */
function findLargestArray(
  root: unknown,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
): { path: Array<string | number>; serializedLen: number } | undefined {
  let best: { path: Array<string | number>; serializedLen: number } | undefined;
  walk(
    root,
    [],
    skipTopLevelKeys,
    (path, arr) => {
      if (arr.length < 2) return;
      const serializedLen = serializedLength(arr);
      if (!best || serializedLen > best.serializedLen) {
        best = { path, serializedLen };
      }
    },
    () => {},
  );
  return best;
}

/** Finds the longest string anywhere in the graph, above a small floor
 * (4 chars) below which halving-plus-marker can never be shorter than the
 * original. */
function findLongestString(
  root: unknown,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
): { path: Array<string | number>; length: number } | undefined {
  let best: { path: Array<string | number>; length: number } | undefined;
  walk(
    root,
    [],
    skipTopLevelKeys,
    () => {},
    (path, str) => {
      if (str.length <= 4) return;
      if (!best || str.length > best.length) {
        best = { path, length: str.length };
      }
    },
  );
  return best;
}

/**
 * Finds the single object key (anywhere in the graph, including nested
 * objects and objects inside arrays) whose value has the largest
 * serialized length. This is the final, unconditional fallback: deleting
 * a whole key always strictly reduces the serialized size, so it is what
 * guarantees the reduction loop below terminates even when no array or
 * string reduction can make further byte progress.
 */
function findLargestSubtreeKey(
  root: unknown,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
):
  | { parentPath: Array<string | number>; key: string; serializedLen: number }
  | undefined {
  let best:
    | { parentPath: Array<string | number>; key: string; serializedLen: number }
    | undefined;
  walk(
    root,
    [],
    skipTopLevelKeys,
    () => {},
    () => {},
    (parentPath, key, value) => {
      const serializedLen = serializedLength(value);
      if (!best || serializedLen > best.serializedLen) {
        best = { parentPath, key, serializedLen };
      }
    },
  );
  return best;
}

/**
 * Reduction step 1: halves the single largest array in the graph (by its
 * own serialized size), keeping the first half and appending one marker
 * string noting how many elements were dropped. Only applied when it is a
 * genuine byte-size improvement (a small array of small elements next to a
 * long marker could otherwise grow); returns false and leaves the graph
 * untouched when it is not, so the caller falls through to the next step.
 */
function capLargestArray(
  root: unknown,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
): boolean {
  const target = findLargestArray(root, skipTopLevelKeys);
  if (!target) return false;
  const arr = getAtPath(root, target.path) as unknown[];
  const before = serializedLength(arr);
  const keep = Math.max(1, Math.floor(arr.length / 2));
  const dropped = arr.length - keep;
  if (dropped <= 0) return false;
  const marker = `...(${dropped} more item${dropped === 1 ? "" : "s"} omitted)`;
  const next = [...arr.slice(0, keep), marker];
  if (serializedLength(next) >= before) return false;
  setAtPath(root, target.path, next);
  return true;
}

/**
 * Reduction step 2: halves the single longest string in the graph,
 * keeping the head and appending a `...` marker. Same byte-progress guard
 * as `capLargestArray`.
 */
function capLongestString(
  root: unknown,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
): boolean {
  const target = findLongestString(root, skipTopLevelKeys);
  if (!target) return false;
  const cur = getAtPath(root, target.path) as string;
  const keep = Math.floor(cur.length / 2);
  const next = cur.slice(0, keep) + "...";
  if (next.length >= cur.length) return false;
  setAtPath(root, target.path, next);
  return true;
}

/**
 * Reduction step 3 (unconditional fallback): deletes the single largest
 * remaining subtree (an object key, anywhere in the graph) entirely.
 * Always makes real progress when a candidate exists, so the reduction
 * loop can never truly stall while `extra` still has content.
 */
function dropLargestSubtree(
  root: unknown,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
): boolean {
  const target = findLargestSubtreeKey(root, skipTopLevelKeys);
  if (!target) return false;
  const parent =
    target.parentPath.length === 0 ? root : getAtPath(root, target.parentPath);
  delete (parent as Record<string, unknown>)[target.key];
  return true;
}

// The fixed envelope fields: always present, and never subject to any
// reduction step. `extra` is spread first so these win on any key
// collision, and every reduction step is told to skip them by name (at
// the top level only, so this never has to inspect a `logs`/`warnings`
// key nested somewhere inside a subcommand's own `extra` data).
const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  "tool",
  "version",
  "command",
  "status",
  "durationMs",
  "cwd",
  "truncated",
  "warnings",
  "logs",
]);

function skeletonOnly(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PROTECTED_KEYS) {
    if (key in envelope) out[key] = envelope[key];
  }
  return out;
}

/**
 * Pushes the "could not be met" warning and makes its own stated length
 * match the envelope's true final serialized size, including the warning
 * itself. Since the warning's own text contributes to that size, this is
 * a small fixed point: compute a candidate length, render the warning
 * with it, re-measure, and repeat until stable (converges in at most a
 * couple of iterations; the only way it would not is the warning's
 * stated number crossing a digit-count boundary because of its own
 * length, which a few iterations always settle).
 */
function pushOverrunWarning(
  envelope: Record<string, unknown>,
  maxChars: number,
): void {
  const baseWarnings = envelope.warnings as string[];
  let n = serializedLength(envelope);
  for (let i = 0; i < 5; i++) {
    const message = `envelope is ${n} characters; requested max-chars ${maxChars} could not be met`;
    const candidateWarnings = [...baseWarnings, message];
    const candidateLen = serializedLength({
      ...envelope,
      warnings: candidateWarnings,
    });
    if (candidateLen === n) {
      envelope.warnings = candidateWarnings;
      return;
    }
    n = candidateLen;
  }
  envelope.warnings = [
    ...baseWarnings,
    `envelope is ${n} characters; requested max-chars ${maxChars} could not be met`,
  ];
}

/**
 * Build the final envelope: deep-copies `extra` (the caller's object is
 * never read again after the copy, so it is never mutated by anything
 * below), merges it with the base fields (base fields win on any key
 * collision, so a subcommand's `extra` can never shadow
 * `tool`/`status`/`truncated`/`logs`/... ), and, only when the serialized
 * result exceeds `maxChars`, runs a single progress-guarded reduction loop
 * over the whole graph: cap the largest array anywhere (keeping the first
 * half plus a marker), then the longest string anywhere (keeping the head
 * plus a `...` marker), then drop the largest remaining subtree entirely,
 * repeating in that priority order until the envelope fits or nothing
 * makes further byte progress. There is no fixed iteration count; the
 * loop's only stopping conditions are "fits now" and "no step reduced
 * anything".
 *
 * The fixed skeleton fields (tool, version, command, status, durationMs,
 * cwd, truncated, warnings, logs) are excluded from every reduction step
 * (by name, at the top level, see PROTECTED_KEYS), so they always survive
 * intact, byte for byte. Because of that floor, the real invariant is:
 *
 *   serializedLength(envelope) <= max(maxChars, skeletonFloor)
 *
 * not an unconditional `<= maxChars`. Whenever the caller's literal
 * `maxChars` request could not be honored (skeletonFloor alone exceeds
 * it), a warning is appended naming the envelope's true final length and
 * the max-chars that could not be met, so a caller can tell the
 * difference between "bounded as requested" and "bounded, but bigger than
 * asked for, honestly reported".
 *
 * Sets `truncated: true` and appends the full, untruncated result's path
 * to `logs` whenever anything was cut.
 *
 * Returns the envelope plus the exit code implied by `status`.
 */
export function buildEnvelope(input: EnvelopeInput): EnvelopeOutput {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const logs = [...(input.logs ?? [])];
  const warnings = [...(input.warnings ?? [])];

  // Deep-copy `extra` up front: every reduction step below mutates this
  // copy in place, and the caller's object must never be touched (a
  // shallow spread would leave nested arrays/objects shared by reference,
  // so mutating them here would silently mutate the caller's data too).
  const extraCopy: Record<string, unknown> = input.extra
    ? structuredClone(input.extra)
    : {};

  const envelope: Record<string, unknown> = {
    ...extraCopy,
    tool: TOOL_NAME,
    version: input.version,
    command: input.command,
    status: input.status,
    durationMs: input.durationMs,
    cwd: input.cwd,
    truncated: false,
    logs,
    warnings,
  };

  if (serializedLength(envelope) <= maxChars) {
    return { envelope, exitCode: exitCodeForStatus(input.status) };
  }

  // A full, untruncated copy is captured before any reduction so it can be
  // written to the log dir once we know truncation is unavoidable.
  const fullResult = structuredClone(envelope);

  envelope.truncated = true;
  // The full-result log path is appended to `logs` BEFORE the reduction
  // loop runs (not after): appending it later, once the envelope has
  // already been cut down to fit exactly, would grow the envelope back
  // past maxChars by however many characters the path itself adds. Adding
  // it first means the reduction loop below accounts for its size too, so
  // the bound still holds afterward.
  if (input.logDir) {
    try {
      fs.mkdirSync(input.logDir, { recursive: true });
      const fullResultPath = path.join(input.logDir, "result-full.json");
      fs.writeFileSync(fullResultPath, JSON.stringify(fullResult, null, 2));
      logs.push(fullResultPath);
      envelope.logs = logs;
    } catch (err) {
      // Truncation itself must not fail the command, but the failure must
      // not be silent either: name it in a warning before the reduction
      // loop runs, so it is never itself a candidate for later cutting.
      const detail =
        err instanceof Error
          ? ((err as NodeJS.ErrnoException).code ?? err.message)
          : String(err);
      warnings.push(`full result not written to ${input.logDir}: ${detail}`);
      envelope.warnings = warnings;
    }
  }

  // The skeleton (fixed fields only) is never cut, so it is a hard floor
  // on what the reduction loop can achieve: aim for max(maxChars,
  // skeletonFloor), not maxChars itself, so the loop below has an
  // achievable target instead of spinning until "no progress" against an
  // unreachable one.
  const skeletonFloor = serializedLength(skeletonOnly(envelope));
  const effectiveMaxChars = Math.max(maxChars, skeletonFloor);

  let progressed = true;
  while (progressed && serializedLength(envelope) > effectiveMaxChars) {
    progressed =
      capLargestArray(envelope, PROTECTED_KEYS) ||
      capLongestString(envelope, PROTECTED_KEYS) ||
      dropLargestSubtree(envelope, PROTECTED_KEYS);
  }

  if (serializedLength(envelope) > maxChars) {
    pushOverrunWarning(envelope, maxChars);
  }

  return { envelope, exitCode: exitCodeForStatus(input.status) };
}
