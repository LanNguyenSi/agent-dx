/**
 * Stable IDs.
 *
 * Inside a spec folder an ID is unqualified (`AC-1`). Outside it, for
 * example in an export or a ticket comment, it is qualified with the spec
 * ID: `<spec-id>#AC-1`. IDs are never reused; see `retired_ids` in
 * `spec.ts`.
 */
import type { FormatError, ParseResult } from "./errors.js";
import { failResult, okResult } from "./errors.js";

/** The one ID without a number. A spec has exactly one goal. */
export const GOAL_ID = "GOAL";

/** Prefixes that carry a number: `<PREFIX>-<n>`, n a positive integer without leading zeros. */
export const NUMBERED_ID_PREFIXES = [
  "AC",
  "NG",
  "DF",
  "DC",
  "RS",
  "SL",
  "TP",
  "QN",
] as const;

export type NumberedIdPrefix = (typeof NUMBERED_ID_PREFIXES)[number];
export type IdPrefix = typeof GOAL_ID | NumberedIdPrefix;

/** What each prefix names, for documentation and messages. */
export const ID_PREFIX_MEANING: Readonly<Record<IdPrefix, string>> = {
  GOAL: "goal (exactly one per spec)",
  AC: "acceptance criterion",
  NG: "non-goal or must-not-change line",
  DF: "default (an answer set by the translator, with reason)",
  DC: "decision (an answer given by a person)",
  RS: "residual (an open point carried into the spec)",
  SL: "source-ledger entry",
  TP: "test-plan row",
  QN: "question",
};

/** Prefixes a test-plan row may cover. */
export const COVERABLE_ID_PREFIXES = ["AC", "DF", "NG"] as const;

const NUMBERED_RE = /^(AC|NG|DF|DC|RS|SL|TP|QN)-([1-9][0-9]{0,8})$/;
const SPEC_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_SPEC_ID_LENGTH = 64;

export interface ParsedId {
  prefix: IdPrefix;
  /** Absent for `GOAL`. */
  number?: number;
}

export interface QualifiedId {
  specId: string;
  id: ParsedId;
}

function idError(path: string, message: string): FormatError {
  return { code: "invalid-id", path, message };
}

/** Parses an unqualified ID (`GOAL` or `<PREFIX>-<n>`). */
export function parseId(text: string): ParseResult<ParsedId> {
  if (text === GOAL_ID) return okResult({ prefix: GOAL_ID });
  const m = NUMBERED_RE.exec(text);
  if (!m) {
    return failResult([
      idError(
        "$",
        `${JSON.stringify(text)} is not an ID: expected GOAL or one of ${NUMBERED_ID_PREFIXES.join(", ")} followed by -<n> (n >= 1, no leading zeros)`,
      ),
    ]);
  }
  return okResult({
    prefix: m[1] as NumberedIdPrefix,
    number: Number(m[2]),
  });
}

export function isId(text: string): boolean {
  return parseId(text).ok;
}

/** Formats an unqualified ID. Throws a `RangeError` on an invalid prefix/number pair. */
export function formatId(prefix: IdPrefix, n?: number): string {
  if (prefix === GOAL_ID) {
    if (n !== undefined) throw new RangeError("GOAL carries no number");
    return GOAL_ID;
  }
  if (!(NUMBERED_ID_PREFIXES as readonly string[]).includes(prefix)) {
    throw new RangeError(`unknown ID prefix ${JSON.stringify(prefix)}`);
  }
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > 999_999_999) {
    throw new RangeError(`${prefix} needs a positive integer number`);
  }
  return `${prefix}-${n}`;
}

export function isNumberedId(text: string): boolean {
  return NUMBERED_RE.test(text);
}

/** True when `text` is an AC, DF or NG ID, the only IDs a test-plan row may cover. */
export function isCoverableId(text: string): boolean {
  const m = NUMBERED_RE.exec(text);
  return (
    m !== null && (COVERABLE_ID_PREFIXES as readonly string[]).includes(m[1]!)
  );
}

export function idPrefixOf(text: string): IdPrefix | undefined {
  const parsed = parseId(text);
  return parsed.ok ? parsed.value.prefix : undefined;
}

export function isSpecId(text: string): boolean {
  return text.length <= MAX_SPEC_ID_LENGTH && SPEC_ID_RE.test(text);
}

/** Parses `<spec-id>#<ID>`. */
export function parseQualifiedId(text: string): ParseResult<QualifiedId> {
  const parts = text.split("#");
  if (parts.length !== 2) {
    return failResult([
      idError(
        "$",
        `${JSON.stringify(text)} is not a qualified ID: expected <spec-id>#<ID> with exactly one '#'`,
      ),
    ]);
  }
  const [specId, rawId] = parts as [string, string];
  if (!isSpecId(specId)) {
    return failResult([
      idError(
        "$",
        `${JSON.stringify(specId)} is not a spec ID: expected lower-case letters, digits and single hyphens, at most ${MAX_SPEC_ID_LENGTH} characters`,
      ),
    ]);
  }
  const id = parseId(rawId);
  if (!id.ok) return failResult(id.errors);
  return okResult({ specId, id: id.value });
}

/** Formats `<spec-id>#<ID>`. Throws a `RangeError` when either part is invalid. */
export function formatQualifiedId(specId: string, id: string): string {
  if (!isSpecId(specId)) {
    throw new RangeError(`invalid spec ID ${JSON.stringify(specId)}`);
  }
  if (!isId(id)) {
    throw new RangeError(`invalid ID ${JSON.stringify(id)}`);
  }
  return `${specId}#${id}`;
}

/** Markdown table of the ID prefixes, as embedded in `docs/formats.md`. */
export function renderIdPrefixTable(): string {
  const rows = ["| Prefix | Form | Meaning |", "|---|---|---|"];
  for (const prefix of [GOAL_ID, ...NUMBERED_ID_PREFIXES] as IdPrefix[]) {
    const form = prefix === GOAL_ID ? "`GOAL`" : `\`${prefix}-<n>\``;
    rows.push(`| \`${prefix}\` | ${form} | ${ID_PREFIX_MEANING[prefix]} |`);
  }
  return rows.join("\n");
}
