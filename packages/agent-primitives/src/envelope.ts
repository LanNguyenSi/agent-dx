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
  /**
   * Wall-clock budget, in milliseconds, for the whole reduction loop.
   * Defaults to 200. A result whose shape defeats the reducers (very many
   * small keys, say) must not turn a bounded-output helper into a
   * multi-second stall: once the budget is spent, every reducible field is
   * dropped wholesale and a warning says so, which is a worse result but a
   * fast and honest one. Exposed mainly so tests can drive that path
   * deterministically.
   */
  reductionBudgetMs?: number;
}

export interface EnvelopeOutput {
  envelope: Record<string, unknown>;
  exitCode: number;
}

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_REDUCTION_BUDGET_MS = 200;

/** Strings at or below this length can never be shortened by the
 * string-capping step: head-plus-marker would be no shorter than the
 * original. */
const MIN_CAPPABLE_STRING = 4;
const STRING_TRUNCATION_MARKER = "...";

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

function getAtPath(obj: unknown, keyPath: Array<string | number>): unknown {
  let cursor: unknown = obj;
  for (const key of keyPath) {
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
}

/** Like `getAtPath`, but reports `undefined` instead of throwing when a
 * step along the path is missing. Bulk key drops can invalidate a path
 * collected earlier in the same pass (dropping a parent removes every
 * descendant), so the drop step resolves parents through this. */
function tryGetAtPath(obj: unknown, keyPath: Array<string | number>): unknown {
  let cursor: unknown = obj;
  for (const key of keyPath) {
    if (cursor === null || typeof cursor !== "object") return undefined;
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

interface ArrayCandidate {
  path: Array<string | number>;
  serializedLen: number;
}

interface StringCandidate {
  path: Array<string | number>;
  length: number;
}

interface EntryCandidate {
  parentPath: Array<string | number>;
  key: string;
  /** Characters the enclosing object's serialization loses when this key is
   * deleted: the quoted key, the colon, the value, and one separating
   * comma. */
  saving: number;
}

interface Candidates {
  /** Largest array (by its own serialized size) with at least 2 elements:
   * a shorter one cannot be usefully halved. */
  largestArray?: ArrayCandidate;
  /** Longest string above the floor below which capping cannot shorten. */
  longestString?: StringCandidate;
  /** Every deletable object entry in the graph. */
  entries: EntryCandidate[];
}

/**
 * Characters `value` contributes as an object property's value.
 *
 * A string is sized by its own length plus its quotes rather than by
 * serializing it: JSON escaping only ever makes a string longer, so this
 * under-estimates instead of over-estimating, and it keeps a
 * multi-megabyte tail from being serialized once per reduction pass merely
 * to be measured.
 *
 * Reports 0 for exactly the values JSON omits from an enclosing object
 * (undefined, a function, a symbol), which is what lets the caller test
 * "contributes nothing" as a number comparison.
 */
function valueSerializedLength(value: unknown): number {
  if (typeof value === "string") return value.length + 2;
  return serializedLength(value);
}

/**
 * One walk of the whole graph collecting every reduction candidate at
 * once: the largest array, the longest string, and every deletable object
 * entry. Walking once per reduction pass rather than once per reduction
 * step is what keeps a wide result (thousands of keys) from costing three
 * full traversals per pass.
 *
 * `skipTopLevelKeys` is applied at the top level only, so this never has
 * to inspect a `logs`/`warnings` key nested somewhere inside a
 * subcommand's own `extra` data.
 */
function collectCandidates(
  root: unknown,
  skipTopLevelKeys: ReadonlySet<string> | undefined,
): Candidates {
  const out: Candidates = { entries: [] };
  const visit = (value: unknown, keyPath: Array<string | number>): void => {
    if (Array.isArray(value)) {
      if (value.length >= 2) {
        const serializedLen = serializedLength(value);
        if (!out.largestArray || serializedLen > out.largestArray.serializedLen)
          out.largestArray = { path: keyPath, serializedLen };
      }
      for (let i = 0; i < value.length; i++) visit(value[i], [...keyPath, i]);
      return;
    }
    if (typeof value === "string") {
      if (
        value.length > MIN_CAPPABLE_STRING &&
        (!out.longestString || value.length > out.longestString.length)
      ) {
        out.longestString = { path: keyPath, length: value.length };
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (keyPath.length === 0 && skipTopLevelKeys?.has(key)) continue;
        // An undefined-valued property serializes to nothing at all, so
        // deleting it saves no characters. Skipping it here keeps it out
        // of the drop step, where it would otherwise count as "progress"
        // that shrinks the envelope by zero. Measuring it at all is only
        // safe because `serializedLength` is total: JSON.stringify returns
        // undefined, not a string, for precisely these values.
        const valueLen = valueSerializedLength(child);
        if (valueLen === 0) continue;
        // `"key":<value>,` -- the quoted key, the colon, the value, and
        // the separating comma.
        out.entries.push({
          parentPath: keyPath,
          key,
          saving: key.length + 3 + valueLen + 1,
        });
        visit(child, [...keyPath, key]);
      }
    }
  };
  visit(root, []);
  return out;
}

/**
 * Reduction step 1: shortens the single largest array in the graph,
 * keeping a head plus one marker string naming how many elements were
 * omitted.
 *
 * The marker counts from the array's ORIGINAL length, not from this pass's
 * input: `originalLengths` remembers what an array held before it was
 * first capped, so a second pass over the same array reports "N of the
 * original N+kept omitted" rather than restarting the count at whatever
 * the first pass left behind.
 *
 * How much is cut is driven by `excess` (how many characters the envelope
 * is still over budget) rather than by halving unconditionally: a 5,000
 * element list otherwise costs one full re-walk and re-serialization per
 * halving. Halving is kept as an upper bound on what is retained, so every
 * successful pass still makes geometric progress even when the estimate is
 * too small. Applied only when it is a genuine byte-size improvement (a
 * short array of short elements next to a longer marker could otherwise
 * grow); returns false and leaves the graph untouched when it is not, so
 * the caller falls through to the next step.
 */
function capLargestArray(
  root: unknown,
  candidates: Candidates,
  excess: number,
  originalLengths: WeakMap<object, number>,
): boolean {
  const target = candidates.largestArray;
  if (!target) return false;
  const arr = getAtPath(root, target.path) as unknown[];
  const before = target.serializedLen;
  const tracked = originalLengths.get(arr);
  // A previously capped array carries this step's marker as its last
  // element; strip it so the marker is never itself halved into the kept
  // elements and the counts below are always about real elements.
  const items = tracked === undefined ? arr : arr.slice(0, -1);
  const originalLength = tracked ?? arr.length;
  if (items.length < 2) return false;
  const perElement = Math.max(1, Math.ceil(before / arr.length));
  const mustDrop = Math.max(1, Math.ceil(Math.max(excess, 1) / perElement));
  const keep = Math.max(
    1,
    Math.min(items.length - mustDrop, Math.floor(items.length / 2)),
  );
  if (keep >= items.length) return false;
  const dropped = originalLength - keep;
  const marker = `...(${dropped} more item${dropped === 1 ? "" : "s"} omitted)`;
  const next = [...items.slice(0, keep), marker];
  if (serializedLength(next) >= before) return false;
  originalLengths.set(next, originalLength);
  setAtPath(root, target.path, next);
  return true;
}

/**
 * Reduction step 2: shortens the single longest string in the graph,
 * keeping a head plus a `...` marker. Cut to what `excess` needs (bounded
 * below by halving, so progress stays geometric) for the same reason as
 * the array step, and with the same byte-progress guard.
 */
function capLongestString(
  root: unknown,
  candidates: Candidates,
  excess: number,
): boolean {
  const target = candidates.longestString;
  if (!target) return false;
  const cur = getAtPath(root, target.path) as string;
  const needed = Math.max(excess, 1) + STRING_TRUNCATION_MARKER.length;
  const keep = Math.min(
    Math.max(0, cur.length - needed),
    Math.floor(cur.length / 2),
  );
  const next = cur.slice(0, keep) + STRING_TRUNCATION_MARKER;
  if (next.length >= cur.length) return false;
  setAtPath(root, target.path, next);
  return true;
}

/**
 * Reduction step 3 (unconditional fallback): deletes whole object keys,
 * largest first, until the estimated saving covers `excess`. Deleting a
 * key always strictly reduces the serialized size (undefined-valued
 * properties, the one exception, are never collected as candidates), so
 * this is what guarantees the reduction loop below terminates even when no
 * array or string reduction can make further byte progress.
 *
 * Dropping in bulk rather than one key per pass is what keeps a result
 * with thousands of small keys from costing thousands of full traversals.
 * Candidates are sorted largest-first, so a graph where one big subtree
 * covers the whole excess still loses exactly that one subtree, as a
 * single-drop step would have done. Dropping a parent also removes its
 * descendants, which may appear later in the same sorted list; those are
 * skipped rather than followed into a missing parent.
 */
function dropLargestSubtrees(
  root: unknown,
  candidates: Candidates,
  excess: number,
): boolean {
  if (candidates.entries.length === 0) return false;
  const sorted = [...candidates.entries].sort((a, b) => b.saving - a.saving);
  let saved = 0;
  let dropped = 0;
  for (const candidate of sorted) {
    if (dropped > 0 && saved >= excess) break;
    const parent =
      candidate.parentPath.length === 0
        ? root
        : tryGetAtPath(root, candidate.parentPath);
    if (parent === null || typeof parent !== "object") continue;
    const parentObj = parent as Record<string, unknown>;
    if (!(candidate.key in parentObj)) continue;
    delete parentObj[candidate.key];
    saved += candidate.saving;
    dropped++;
  }
  return dropped > 0;
}

// The fixed envelope fields: always present, and never subject to any
// reduction step. `extra` is spread first so these win on any key
// collision, and every reduction step is told to skip them by name (at
// the top level only, see collectCandidates).
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

/** Deletes every reducible (non-fixed) top-level field, leaving the
 * skeleton. Used by the two wholesale paths: an unserializable result, and
 * an exhausted reduction budget. */
function dropAllReducibleKeys(envelope: Record<string, unknown>): void {
  for (const key of Object.keys(envelope)) {
    if (!PROTECTED_KEYS.has(key)) delete envelope[key];
  }
}

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
 * result exceeds `maxChars`, runs a progress-guarded reduction loop over
 * the whole graph. Each pass walks the graph once to collect candidates,
 * then applies the first step that makes byte progress: shorten the
 * largest array anywhere (head plus a marker naming the original count),
 * then the longest string anywhere (head plus `...`), then drop whole keys
 * largest-first until the remaining excess is covered. There is no fixed
 * iteration count; the loop's stopping conditions are "fits now", "no step
 * reduced anything", and "the work budget is spent".
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
  const budgetMs = input.reductionBudgetMs ?? DEFAULT_REDUCTION_BUDGET_MS;
  const logs = [...(input.logs ?? [])];
  const warnings = [...(input.warnings ?? [])];

  // Deep-copy `extra` up front: every reduction step below mutates this
  // copy in place, and the caller's object must never be touched (a
  // shallow spread would leave nested arrays/objects shared by reference,
  // so mutating them here would silently mutate the caller's data too).
  //
  // structuredClone throws for values it cannot copy (a function, a
  // symbol, some host objects). That is a caller mistake, not a reason for
  // this process to report `status: error` and lose the command's real
  // verdict: the skeleton still carries the status, and a warning names
  // what went wrong.
  let extraCopy: Record<string, unknown> = {};
  let unusableExtra: string | undefined;
  if (input.extra) {
    try {
      extraCopy = structuredClone(input.extra);
    } catch (err) {
      unusableExtra = describeSerializationFailure(err);
    }
  }

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
    dropAllReducibleKeys(envelope);
    envelope.truncated = true;
    warnings.push(`result fields dropped: not serializable (${unusableExtra})`);
    if (serializedLength(envelope) > maxChars) {
      pushOverrunWarning(envelope, maxChars);
    }
    return { envelope, exitCode: exitCodeForStatus(input.status) };
  }

  if (currentLen <= maxChars) {
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

  const originalLengths = new WeakMap<object, number>();
  const reductionStart = Date.now();
  let budgetExhausted = false;
  // Defensive, not reachable by any input this module accepts: every
  // collected candidate strictly shrinks the envelope when applied (the
  // one zero-saving case, an undefined-valued property, is never
  // collected), and the drop step always has a candidate while any
  // reducible field remains, so the loop's real exits are "fits" and
  // "budget spent". The guard is kept as a termination proof that does not
  // depend on that argument staying true as further reducers are added.
  let progressed = true;
  currentLen = serializedLength(envelope);
  while (progressed && currentLen > effectiveMaxChars) {
    if (Date.now() - reductionStart >= budgetMs) {
      budgetExhausted = true;
      break;
    }
    const excess = currentLen - effectiveMaxChars;
    const candidates = collectCandidates(envelope, PROTECTED_KEYS);
    progressed =
      capLargestArray(envelope, candidates, excess, originalLengths) ||
      capLongestString(envelope, candidates, excess) ||
      dropLargestSubtrees(envelope, candidates, excess);
    currentLen = serializedLength(envelope);
  }

  if (budgetExhausted) {
    dropAllReducibleKeys(envelope);
    warnings.push(
      `reduction work budget (${budgetMs}ms) reached; remaining result fields were dropped wholesale`,
    );
    envelope.warnings = warnings;
  }

  if (serializedLength(envelope) > maxChars) {
    pushOverrunWarning(envelope, maxChars);
  }

  return { envelope, exitCode: exitCodeForStatus(input.status) };
}
