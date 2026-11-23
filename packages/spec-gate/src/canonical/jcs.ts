/**
 * Canonical JSON per RFC 8785 (JSON Canonicalization Scheme), for the
 * values the digest builds: null, booleans, finite numbers, strings,
 * arrays and plain objects.
 *
 * - Object keys are sorted by UTF-16 code units (the default order of
 *   `Array.prototype.sort` on strings).
 * - Numbers are serialised as ECMAScript's `Number.prototype.toString`
 *   does (which writes `-0` as `0`); `NaN` and the infinities are refused.
 * - Strings are serialised as `JSON.stringify` does, which is the RFC's
 *   rule: only `"`, `\` and the control characters below U+0020 are
 *   escaped, everything else is written as is. A string with a lone
 *   surrogate is refused, because it has no UTF-8 form.
 * - An array with a hole is refused: JSON has no form for it.
 * - No whitespace between tokens.
 */
import { createHash } from "node:crypto";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_DEPTH = 64;
const LONE_SURROGATE_RE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serializeString(text: string): string {
  if (LONE_SURROGATE_RE.test(text)) {
    throw new TypeError("canonical JSON: string holds a lone surrogate");
  }
  return JSON.stringify(text);
}

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new TypeError("canonical JSON: value is nested too deeply");
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonical JSON: number is not finite");
      }
      return String(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) {
            throw new TypeError("canonical JSON: array has a hole");
          }
          items.push(serialize(value[i], depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonical JSON: value is not a plain object");
      }
      const rec = value as Record<string, unknown>;
      const parts = Object.keys(rec)
        .sort(compareCodeUnits)
        .map(
          (key) => `${serializeString(key)}:${serialize(rec[key], depth + 1)}`,
        );
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON: cannot serialise a ${typeof value}`);
  }
}

/** The RFC 8785 form of `value`. */
export function canonicalJson(value: Json): string {
  return serialize(value, 0);
}

/** `sha256:<64 hex>` over the UTF-8 bytes of `text`. */
export function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
