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
import { LineCounter, isAlias, isScalar, parseDocument, visit } from "yaml";
import type { Document } from "yaml";
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

interface DocProblem {
  code: FormatError["code"];
  message: string;
  line?: number;
}

/**
 * Walks a parsed document once and reports the first of: an alias or
 * anchor, an explicit tag, a collection used as a mapping key, a duplicate
 * mapping key. The duplicate check is a Set per mapping, so it is linear
 * in the number of keys. Keys are compared as the strings they become when
 * the document turns into a JavaScript object, so `1` and `"1"` collide.
 */
function inspectDocument(
  doc: Document,
  lc: LineCounter,
  checkTags: boolean,
): DocProblem | null {
  let problem: DocProblem | null = null;
  const lineOf = (node: { range?: [number, number, number] | null }) => {
    const offset = node.range?.[0];
    return offset === undefined ? undefined : lc.linePos(offset).line;
  };
  const report = (p: DocProblem) => {
    problem ??= p;
  };
  visit(doc, {
    Alias(_key, node) {
      report({
        code: "yaml-alias",
        message: "YAML alias is not allowed",
        line: lineOf(node),
      });
    },
    Node(_key, node) {
      if (node.anchor) {
        report({
          code: "yaml-alias",
          message: `YAML anchor &${node.anchor} is not allowed`,
          line: lineOf(node),
        });
      }
      if (checkTags && node.tag) {
        report({
          code: "yaml-tag",
          message: `YAML tag ${node.tag} is not allowed`,
          line: lineOf(node),
        });
      }
    },
    Map(_key, map) {
      const seen = new Set<string>();
      for (const pair of map.items) {
        const key = pair.key;
        if (!isScalar(key)) {
          if (!isAlias(key)) {
            report({
              code: "invalid-yaml",
              message: "a mapping key must be a plain scalar",
              line: lineOf(key as { range?: [number, number, number] }),
            });
          }
          continue;
        }
        const name = String(key.value);
        if (seen.has(name)) {
          report({
            code: "duplicate-key",
            message: `duplicate mapping key ${JSON.stringify(name)}`,
            line: lineOf(key),
          });
        }
        seen.add(name);
      }
    },
  });
  return problem;
}

/** Decodes one YAML document into plain JavaScript values. */
export function parseYamlText(text: string): ParseResult<unknown> {
  const tooLarge = checkSize<unknown>(text);
  if (tooLarge) return tooLarge;
  const lc = new LineCounter();
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: false,
    merge: false,
    logLevel: "error",
    lineCounter: lc,
  });
  const first = doc.errors[0];
  if (first) {
    return fail(
      "invalid-yaml",
      first.message.split("\n")[0] ?? first.message,
      first.linePos?.[0]?.line,
    );
  }
  const problem = inspectDocument(doc, lc, true);
  if (problem) return fail(problem.code, problem.message, problem.line);
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (err) {
    return fail("invalid-yaml", (err as Error).message.split("\n")[0] ?? "");
  }
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
  // the same walk reports duplicate keys that JSON.parse dropped.
  const lc = new LineCounter();
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: false,
    logLevel: "error",
    lineCounter: lc,
  });
  const problem = inspectDocument(doc, lc, false);
  if (problem?.code === "duplicate-key") {
    return fail("duplicate-key", problem.message, problem.line);
  }
  return okResult(value);
}
