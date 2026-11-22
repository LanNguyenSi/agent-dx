/**
 * Text-to-value decoding shared by the YAML and JSON based formats.
 *
 * YAML settings (all of them deliberate):
 * - YAML 1.2 core schema: `yes`, `no`, `on`, `off` stay strings and
 *   timestamps stay strings, so a value never changes type by spelling.
 * - Duplicate mapping keys are an error (`duplicate-key`).
 * - Aliases and anchors are rejected (`yaml-alias`): no value is ever
 *   shared or expanded behind the reader's back.
 * - Explicit tags (`!!str`, `!custom`) are rejected (`yaml-tag`): nothing
 *   is resolved into a non-plain type.
 * - Merge keys (`<<`) are not merged; the key stays literal and is then
 *   rejected as an unknown field by the format that sees it.
 * - Exactly one document per file; an empty document is an error.
 *
 * JSON is parsed strictly with `JSON.parse` and additionally checked for
 * duplicate object keys, which `JSON.parse` silently collapses.
 */
import { parseDocument, visit } from "yaml";
import type { FormatError, ParseResult } from "./errors.js";
import { failResult, okResult } from "./errors.js";

/** Upper bound for any single input, in UTF-16 code units. */
export const MAX_INPUT_LENGTH = 1_048_576;

function fail<T>(
  code: FormatError["code"],
  message: string,
  line?: number,
): ParseResult<T> {
  const error: FormatError = { code, path: "$", message };
  if (line !== undefined) error.line = line;
  return failResult([error]);
}

/** Removes a leading byte order mark. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function checkSize<T>(text: string): ParseResult<T> | null {
  if (text.length > MAX_INPUT_LENGTH) {
    return fail(
      "input-too-large",
      `input is ${text.length} characters, the limit is ${MAX_INPUT_LENGTH}`,
    );
  }
  return null;
}

/** Decodes one YAML document into plain JavaScript values. */
export function parseYamlText(text: string): ParseResult<unknown> {
  const tooLarge = checkSize<unknown>(text);
  if (tooLarge) return tooLarge;
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
  });
  const first = doc.errors[0];
  if (first) {
    const line = first.linePos?.[0]?.line;
    const code =
      first.code === "DUPLICATE_KEY" ? "duplicate-key" : "invalid-yaml";
    return fail(code, first.message.split("\n")[0] ?? first.message, line);
  }
  const seen: { alias: string | null; tag: string | null } = {
    alias: null,
    tag: null,
  };
  // An alias always refers to an anchored node, so flagging every anchor
  // also catches every alias.
  visit(doc, {
    Node(_key, node) {
      if (node.anchor) seen.alias ??= `anchor &${node.anchor}`;
      if (node.tag) seen.tag ??= node.tag;
    },
  });
  if (seen.alias !== null) {
    return fail("yaml-alias", `YAML ${seen.alias} is not allowed`);
  }
  if (seen.tag !== null) {
    return fail("yaml-tag", `YAML tag ${seen.tag} is not allowed`);
  }
  const value: unknown = doc.toJS();
  if (value === null || value === undefined) {
    return fail("empty-document", "the document is empty");
  }
  return okResult(value);
}

/** Decodes one strict JSON document; duplicate object keys are errors. */
export function parseJsonText(text: string): ParseResult<unknown> {
  const tooLarge = checkSize<unknown>(text);
  if (tooLarge) return tooLarge;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return fail("invalid-json", (err as Error).message);
  }
  // JSON is a YAML subset, so the YAML parser sees the same structure and
  // reports duplicate keys that JSON.parse dropped.
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
  });
  const dup = doc.errors.find((e) => e.code === "DUPLICATE_KEY");
  if (dup) {
    return fail(
      "duplicate-key",
      dup.message.split("\n")[0] ?? dup.message,
      dup.linePos?.[0]?.line,
    );
  }
  return okResult(value);
}
