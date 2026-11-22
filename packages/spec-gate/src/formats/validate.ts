/**
 * Small value validators shared by the format parsers. Each one reports to
 * an `ErrorSink` and returns the typed value, or `undefined` after having
 * reported.
 */
import { FORBIDDEN_WHAT, findForbiddenCharacter } from "./chars.js";
import type { ErrorSink } from "./errors.js";

export type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(rec: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key);
}

export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export const ISO_UTC_RE =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;

export const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function nonEmptyString(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
): string | undefined {
  if (typeof value !== "string") {
    sink.add(
      "wrong-type",
      path,
      `${what} must be a string, got ${describeType(value)}`,
    );
    return undefined;
  }
  // The character rule comes before the emptiness test: trimming removes
  // some of the characters the rule refuses (a byte order mark, a line
  // separator), and a value made of them is reported as what it is.
  const bad = findForbiddenCharacter(value);
  if (bad) {
    sink.add(
      "forbidden-character",
      path,
      `${what} contains ${bad.label}, ${FORBIDDEN_WHAT}`,
    );
    return undefined;
  }
  if (value.trim() === "") {
    sink.add("empty-value", path, `${what} must not be empty`);
    return undefined;
  }
  return value;
}

export function enumValue<T extends string>(
  sink: ErrorSink,
  value: unknown,
  allowed: readonly T[],
  path: string,
  what: string,
): T | undefined {
  if (typeof value !== "string") {
    sink.add(
      "wrong-type",
      path,
      `${what} must be a string, got ${describeType(value)}`,
    );
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    sink.add(
      "invalid-value",
      path,
      `${what} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
    );
    return undefined;
  }
  return value as T;
}

export function boolValue(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
): boolean | undefined {
  if (typeof value !== "boolean") {
    sink.add(
      "wrong-type",
      path,
      `${what} must be a boolean, got ${describeType(value)}`,
    );
    return undefined;
  }
  return value;
}

export function intValue(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
  min: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    sink.add(
      "wrong-type",
      path,
      `${what} must be an integer, got ${describeType(value)}`,
    );
    return undefined;
  }
  if (value < min) {
    sink.add("invalid-value", path, `${what} must be at least ${min}`);
    return undefined;
  }
  return value;
}

export function isoTime(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
): string | undefined {
  const text = nonEmptyString(sink, value, path, what);
  if (text === undefined) return undefined;
  if (!ISO_UTC_RE.test(text)) {
    sink.add(
      "invalid-value",
      path,
      `${what} must be an ISO 8601 UTC time such as 2000-01-31T12:00:00Z`,
    );
    return undefined;
  }
  return text;
}

export function commitValue(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
): string | undefined {
  const text = nonEmptyString(sink, value, path, what);
  if (text === undefined) return undefined;
  if (!COMMIT_RE.test(text)) {
    sink.add(
      "invalid-value",
      path,
      `${what} must be a full lower-case hex commit id (40 or 64 characters)`,
    );
    return undefined;
  }
  return text;
}

/** A repo-relative path: no leading slash, no `..` segment, no control characters. */
export function relativePath(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
): string | undefined {
  const text = nonEmptyString(sink, value, path, what);
  if (text === undefined) return undefined;
  if (
    text.startsWith("/") ||
    /^[A-Za-z]:/.test(text) ||
    text.includes("\\") ||
    text.split("/").includes("..")
  ) {
    sink.add(
      "invalid-value",
      path,
      `${what} must be a relative path without '..' segments, got ${JSON.stringify(text)}`,
    );
    return undefined;
  }
  return text;
}

/** An http(s) URL. */
export function urlValue(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
): string | undefined {
  const text = nonEmptyString(sink, value, path, what);
  if (text === undefined) return undefined;
  let ok: boolean;
  try {
    const u = new URL(text);
    ok = u.protocol === "https:" || u.protocol === "http:";
  } catch {
    ok = false;
  }
  if (!ok || /\s/.test(text)) {
    sink.add("invalid-value", path, `${what} must be an http(s) URL`);
    return undefined;
  }
  return text;
}

/**
 * Reports every key of `rec` that is not in `allowed` as `unknown-field`.
 * `prefix` is the path of `rec` (empty for the root).
 */
export function rejectUnknownKeys(
  sink: ErrorSink,
  rec: Rec,
  allowed: readonly string[],
  prefix: string,
  what: string,
): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) {
      sink.add(
        "unknown-field",
        prefix === "" ? key : `${prefix}.${key}`,
        `${what} has unknown field ${JSON.stringify(key)}`,
      );
    }
  }
}

/** A list of unique, non-empty strings. */
export function stringList(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
  options: { nonEmpty?: boolean } = {},
): string[] | undefined {
  if (!Array.isArray(value)) {
    sink.add(
      "wrong-type",
      path,
      `${what} must be a list, got ${describeType(value)}`,
    );
    return undefined;
  }
  if (options.nonEmpty && value.length === 0) {
    sink.add("empty-value", path, `${what} must not be empty`);
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let good = true;
  value.forEach((item, i) => {
    const text = nonEmptyString(sink, item, `${path}[${i}]`, `${what} entry`);
    if (text === undefined) {
      good = false;
      return;
    }
    if (seen.has(text)) {
      sink.add(
        "duplicate-value",
        `${path}[${i}]`,
        `${what} lists ${JSON.stringify(text)} twice`,
      );
      good = false;
      return;
    }
    seen.add(text);
    out.push(text);
  });
  return good ? out : undefined;
}
