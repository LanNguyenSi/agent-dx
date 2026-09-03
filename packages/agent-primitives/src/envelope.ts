import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

let runId: string | undefined;

/**
 * A random identifier for this process, generated once and reused.
 *
 * It names the full-result file (`result-full-<run-id>.json`) so two
 * invocations sharing one log directory do not overwrite each other's
 * evidence, and it is also the default log directory's own leaf name, so
 * both agree. Generated from `crypto.randomUUID`, never from a clock:
 * `buildEnvelope` reads no clock at all, and within one process this value
 * is constant, so the same input still produces the same envelope.
 */
export function currentRunId(): string {
  if (!runId) runId = randomUUID();
  return runId;
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

/**
 * Upper bound on how many times the reduction re-derives the payload from
 * the pristine copy: one pass at scale 1, then eleven bisection steps.
 * Each pass is O(n) in the payload, so the whole reduction is O(n) with a
 * constant factor of at most this many passes, whatever the shape of the
 * result. There is no wall-clock budget and no data-dependent loop: the
 * envelope is a function of its input alone.
 */
const MAX_REDUCTION_PASSES = 12;

/** Nesting depth kept at scale 1. Deeper containers are replaced by a
 * placeholder naming the depth they were pruned at. */
const BASE_MAX_DEPTH = 12;

/**
 * Floor under the scaled depth limit. Depth is the one cap that is not
 * derived from the bound: collapsing a result to two or three levels
 * destroys nearly all of its structure while saving little next to the
 * breadth caps, which do the real work. Keeping a floor here means a
 * pathologically deep graph is still bounded (a chain is cut a few levels
 * in) without an ordinary nested result being flattened at moderate
 * scales.
 */
const MIN_MAX_DEPTH = 6;

/** The object key under which a trimmed object records how many of its
 * keys were dropped. */
const OMITTED_KEYS_MARKER = "...";

/**
 * Serialized length of `obj`, total over every input.
 *
 * `JSON.stringify` returns `undefined` (not a string) for `undefined`, a
 * function, or a symbol, while TypeScript's lib signature says `string`;
 * reading the types alone, `.length` on that result looks safe and throws
 * at runtime. An unserializable value contributes nothing to an enclosing
 * object's serialization, so 0 is also the arithmetically right answer,
 * not just the non-throwing one.
 *
 * Still throws for a value JSON cannot represent at all (a cycle, a
 * BigInt); `buildEnvelope` catches that separately, since there the right
 * answer is a warning, not a number.
 */
function serializedLength(obj: unknown): number {
  const json = JSON.stringify(obj) as string | undefined;
  return json === undefined ? 0 : json.length;
}

/** One-line, length-capped description of a serialization failure, for a
 * warning that has to name a reason without pasting a stack trace into a
 * bounded envelope. */
function describeSerializationFailure(err: unknown): string {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}...` : firstLine;
}

/**
 * The four structural caps applied in one pass over the payload. Every
 * limit is a maximum that is kept, so "cut" always means "the excess
 * beyond this, and the marker says how much that was".
 */
export interface CapLimits {
  /** Characters kept of a longer string, before its suffix. */
  maxString: number;
  /** Elements kept of a longer array, before its trailing marker. */
  maxArray: number;
  /** Keys kept of a wider object, before its `...` key. */
  maxKeys: number;
  /** Deepest container level kept; a container below this is replaced by a
   * placeholder naming its depth. */
  maxDepth: number;
}

function pluralize(count: number, noun: string): string {
  return `${count} more ${noun}${count === 1 ? "" : "s"} omitted`;
}

/** Trailing element appended to a trimmed array. */
function arrayMarker(omitted: number): string {
  return `...(${pluralize(omitted, "item")})`;
}

/** Value of the `...` key added to a trimmed object. */
function objectMarker(omitted: number): string {
  return pluralize(omitted, "key");
}

/** Suffix appended to a shortened string. */
function stringMarker(omitted: number): string {
  return `...(${pluralize(omitted, "character")})`;
}

/** Replacement for a container below the depth limit. */
function depthMarker(depth: number): string {
  return `...(subtree pruned at depth ${depth})`;
}

/**
 * True only for a bare object literal (or a null-prototype object). A
 * Date, Map, Set or RegExp survives `structuredClone` as itself; rebuilding
 * one from its own enumerable properties would turn it into `{}` and
 * change what the caller's result says. Those pass through uncapped: their
 * serialized size is small and fixed, so they never drive the bound.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function capString(value: string, maxString: number): string {
  if (value.length <= maxString) return value;
  const capped =
    value.slice(0, maxString) + stringMarker(value.length - maxString);
  // Below a certain length the suffix is longer than what it replaces.
  // Leaving the string whole is then both smaller and more informative,
  // and it keeps a marker from being the only thing a tiny string says.
  return capped.length < value.length ? capped : value;
}

function capArray(
  items: unknown[],
  limits: CapLimits,
  depth: number,
): unknown[] {
  const keep = Math.min(items.length, Math.max(0, limits.maxArray));
  const out: unknown[] = new Array<unknown>(keep);
  for (let i = 0; i < keep; i++) {
    out[i] = capValue(items[i], limits, depth + 1);
  }
  if (keep < items.length) out.push(arrayMarker(items.length - keep));
  return out;
}

function capObject(
  obj: Record<string, unknown>,
  limits: CapLimits,
  depth: number,
): Record<string, unknown> {
  const entries = Object.entries(obj);
  const keep = Math.min(entries.length, Math.max(0, limits.maxKeys));
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keep; i++) {
    const entry = entries[i];
    out[entry[0]] = capValue(entry[1], limits, depth + 1);
  }
  if (keep < entries.length) {
    // A payload that already carries a literal "..." key among the kept
    // ones loses it to the marker here. The count stays honest about how
    // many keys were dropped, which is what the marker is for.
    out[OMITTED_KEYS_MARKER] = objectMarker(entries.length - keep);
  }
  return out;
}

function capValue(value: unknown, limits: CapLimits, depth: number): unknown {
  if (typeof value === "string") return capString(value, limits.maxString);
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;
  // Only containers are pruned by depth: replacing a number or a short
  // string with a placeholder would make the result bigger, not smaller.
  // Because the depth limit is finite, this also terminates on a cyclic
  // graph, though `buildEnvelope` rejects one before reduction ever runs.
  if (depth > limits.maxDepth) return depthMarker(depth);
  return isArray
    ? capArray(value, limits, depth)
    : capObject(value as Record<string, unknown>, limits, depth);
}

/**
 * One linear pass over `payload`, returning a NEW structure with the four
 * structural caps in `limits` applied. Pure: the input is never mutated
 * and never read again by the caller's own reduction, so every pass starts
 * from the same pristine payload rather than from the previous pass's
 * already-marked output (which would make the markers count from the wrong
 * baseline).
 *
 * Every cut is marked in band with an honest count derived from the
 * original: kept plus omitted always equals what was there.
 *
 * Cost is O(n) in the payload: a kept value is visited once, and a dropped
 * value is not visited at all.
 */
export function applyCaps(
  payload: Record<string, unknown>,
  limits: CapLimits,
): Record<string, unknown> {
  return capObject(payload, limits, 0);
}

/**
 * The caps at scale 1: everything a bound of `bound` characters could
 * conceivably hold along each dimension.
 *
 * Each breadth limit is the bound itself rather than a fraction of it, so
 * that scale 1 is never the binding constraint for a result that is only
 * a little too large: an array of `bound` elements needs at least two
 * characters per element and an object of `bound` keys at least six per
 * key, so any payload that overflows the bound is still reachable by
 * scaling down from here. A fraction (bound/4, say) would instead put a
 * hard ceiling on a single long string at a quarter of the budget and
 * leave three quarters of it unused.
 */
function baseLimitsFor(bound: number): CapLimits {
  return {
    maxString: bound,
    maxArray: bound,
    maxKeys: bound,
    maxDepth: BASE_MAX_DEPTH,
  };
}

/** The base limits multiplied by one scale factor in [0, 1]. */
function limitsForScale(base: CapLimits, scale: number): CapLimits {
  return {
    maxString: Math.floor(base.maxString * scale),
    maxArray: Math.floor(base.maxArray * scale),
    maxKeys: Math.floor(base.maxKeys * scale),
    maxDepth: Math.max(MIN_MAX_DEPTH, Math.round(base.maxDepth * scale)),
  };
}

/**
 * The payload at one scale: the structural caps at `scale`, or nothing at
 * all at scale 0, which is the skeleton floor the bisection below always
 * has as a fallback.
 */
function payloadAtScale(
  payload: Record<string, unknown>,
  base: CapLimits,
  scale: number,
): Record<string, unknown> {
  if (scale <= 0) return {};
  return applyCaps(payload, limitsForScale(base, scale));
}

// The fixed envelope fields: always present, and never subject to any
// reduction. They are held apart from the payload for the whole reduction
// and merged over it afterwards, so no cap can reach them and no payload
// key can shadow them. This set must stay equal to the key set of `base`
// in buildEnvelope.
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

function overrunWarning(finalLength: number, maxChars: number): string {
  return `envelope is ${finalLength} characters; requested max-chars ${maxChars} could not be met`;
}

/**
 * Appends the "could not be met" warning, with its stated length equal to
 * the envelope's true final serialized size including the warning itself.
 *
 * The warning's own text is part of that size, and the only part of the
 * text whose length varies is the number's digit count. So the final
 * length is `base + digits`, where `base` is the length with the number's
 * digits removed, and the honest number is the `n` satisfying `n === base
 * + digitCount(n)`. Scanning digit counts solves that exactly, in place of
 * an iterate-and-re-measure loop that gave up after a fixed number of
 * tries and then stated a number the envelope did not actually have (the
 * case it gave up on being precisely the one where the number crosses a
 * digit-count boundary).
 */
function pushOverrunWarning(
  envelope: Record<string, unknown>,
  maxChars: number,
): void {
  const baseWarnings = envelope.warnings as string[];
  const probe = overrunWarning(0, maxChars);
  const base =
    serializedLength({
      ...envelope,
      warnings: [...baseWarnings, probe],
    }) - String(0).length;
  let finalLength = base + 1;
  for (let digits = 1; digits <= 20; digits++) {
    const candidate = base + digits;
    if (String(candidate).length === digits) {
      finalLength = candidate;
      break;
    }
  }
  envelope.warnings = [...baseWarnings, overrunWarning(finalLength, maxChars)];
}

/**
 * Build the final envelope: deep-copies `extra` (the caller's object is
 * never read again after the copy, so it is never mutated by anything
 * below), merges it with the base fields (base fields win on any key
 * collision, so a subcommand's `extra` can never shadow
 * `tool`/`status`/`truncated`/`logs`/... ), and, only when the serialized
 * result exceeds `maxChars`, reduces the payload.
 *
 * The reduction is deterministic and clock-free. It has exactly one knob,
 * a scale factor in [0, 1] multiplying four structural caps derived from
 * the bound: how many characters of a string, how many elements of an
 * array, how many keys of an object, and how deep a subtree is kept. One
 * linear pass applies all four to the pristine payload; a bisection over
 * the scale factor, at most MAX_REDUCTION_PASSES passes in total (one at
 * scale 1, then eleven bisection steps), takes the largest scale whose
 * serialized envelope fits. Scale 0 drops the payload entirely and is
 * always available as the floor, so the search always has an answer. No
 * pass ever reads the output of another pass: every one starts from the
 * same pristine copy, which is what keeps a marker's count anchored to the
 * original and keeps siblings of the same size treated alike.
 *
 * Nothing is ever cut out of the serialized JSON string itself: what
 * shrinks is the structure, and every cut is marked in band with an honest
 * count (a trailing array element, a `...` key in an object, a suffix on a
 * string, a placeholder for a pruned subtree).
 *
 * The fixed skeleton fields (tool, version, command, status, durationMs,
 * cwd, truncated, warnings, logs) are held apart from the payload for the
 * whole reduction and merged over it afterwards (see PROTECTED_KEYS), so
 * they always survive intact, byte for byte. Because of that floor, the
 * real invariant is:
 *
 *   serializedLength(envelope) <= max(maxChars, skeletonFloor)
 *
 * not an unconditional `<= maxChars`. Whenever the caller's literal
 * `maxChars` request could not be honored (skeletonFloor alone exceeds
 * it), a warning names the envelope's true final length and the max-chars
 * that could not be met, so a caller can tell the difference between
 * "bounded as requested" and "bounded, but bigger than asked for, honestly
 * reported".
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

  // Deep-copy `extra` up front: this copy is the pristine payload every
  // reduction pass reads, and the caller's object must never be touched (a
  // shallow spread would leave nested arrays/objects shared by reference).
  //
  // structuredClone throws for values it cannot copy (a function, a
  // symbol, some host objects). That is a caller mistake, not a reason for
  // this process to report `status: error` and lose the command's real
  // verdict: the skeleton still carries the status, and a warning names
  // what went wrong.
  let payload: Record<string, unknown> = {};
  let unusableExtra: string | undefined;
  if (input.extra) {
    try {
      payload = structuredClone(input.extra);
    } catch (err) {
      unusableExtra = describeSerializationFailure(err);
    }
  }
  // A payload key named like a fixed field would be overwritten by the
  // merge below anyway; dropping it here keeps it from consuming a slot in
  // the object key cap and from being walked for nothing.
  for (const key of Object.keys(payload)) {
    if (PROTECTED_KEYS.has(key)) delete payload[key];
  }

  const base: Record<string, unknown> = {
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

  let envelope: Record<string, unknown> = { ...payload, ...base };

  // The first serialization needs the same guard for a different set of
  // values: a cycle and a BigInt both survive structuredClone and then
  // throw in JSON.stringify.
  let currentLen = 0;
  if (unusableExtra === undefined) {
    try {
      currentLen = serializedLength(envelope);
    } catch (err) {
      unusableExtra = describeSerializationFailure(err);
    }
  }

  if (unusableExtra !== undefined) {
    base.truncated = true;
    envelope = { ...base };
    warnings.push(`result fields dropped: not serializable (${unusableExtra})`);
    if (serializedLength(envelope) > maxChars) {
      pushOverrunWarning(envelope, maxChars);
    }
    return { envelope, exitCode: exitCodeForStatus(input.status) };
  }

  if (currentLen <= maxChars) {
    return { envelope, exitCode: exitCodeForStatus(input.status) };
  }

  // Rendered before the full-result path joins `logs`, so the file on disk
  // does not claim to contain itself.
  const fullResultJson = JSON.stringify(envelope, null, 2);

  base.truncated = true;
  // The full-result log path is appended to `logs` BEFORE the reduction
  // runs (not after): appending it later, once the envelope has already
  // been reduced to fit exactly, would grow it back past maxChars by
  // however many characters the path itself adds. Adding it first means
  // the reduction accounts for its size too, so the bound still holds.
  if (input.logDir) {
    try {
      fs.mkdirSync(input.logDir, { recursive: true });
      const fullResultPath = path.join(
        input.logDir,
        `result-full-${currentRunId()}.json`,
      );
      fs.writeFileSync(fullResultPath, fullResultJson);
      logs.push(fullResultPath);
    } catch (err) {
      // Truncation itself must not fail the command, but the failure must
      // not be silent either: name it in a warning before the reduction
      // runs, so its own size is accounted for too.
      const detail =
        err instanceof Error
          ? ((err as NodeJS.ErrnoException).code ?? err.message)
          : String(err);
      warnings.push(`full result not written to ${input.logDir}: ${detail}`);
    }
  }

  // The skeleton (fixed fields only) is never cut, so it is a hard floor
  // on what the reduction can achieve: aim for max(maxChars,
  // skeletonFloor), not maxChars itself, so the search has an achievable
  // target instead of rejecting every scale against an unreachable one.
  const skeleton: Record<string, unknown> = { ...base };
  const skeletonFloor = serializedLength(skeleton);
  const effectiveMaxChars = Math.max(maxChars, skeletonFloor);

  const baseLimits = baseLimitsFor(effectiveMaxChars);
  // Scale 0 (the skeleton) always fits by construction, so the search
  // always has a fitting candidate to fall back on.
  let best = skeleton;
  let passes = 0;

  const fitsAtScale = (scale: number): boolean => {
    passes++;
    const candidate = {
      ...payloadAtScale(payload, baseLimits, scale),
      ...base,
    };
    if (serializedLength(candidate) > effectiveMaxChars) return false;
    best = candidate;
    return true;
  };

  if (!fitsAtScale(1)) {
    // Bisection on the scale factor. `lo` is the largest scale known to
    // fit and `hi` the smallest known not to, so every mid that fits is
    // strictly larger than the current `best`'s scale and replacing
    // `best` is always an improvement. Marker text means "fits" is not
    // perfectly monotone in the scale (a marker can be longer than the
    // one tiny element it replaces), which costs at most some utilization,
    // never the bound: an unfitting candidate is simply not kept.
    let lo = 0;
    let hi = 1;
    while (passes < MAX_REDUCTION_PASSES) {
      const mid = (lo + hi) / 2;
      if (fitsAtScale(mid)) lo = mid;
      else hi = mid;
    }
  }
  envelope = best;

  if (serializedLength(envelope) > maxChars) {
    pushOverrunWarning(envelope, maxChars);
  }

  return { envelope, exitCode: exitCodeForStatus(input.status) };
}
