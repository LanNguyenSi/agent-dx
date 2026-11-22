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
 * - The raw text is checked for forbidden characters line by line before
 *   it is parsed (`forbidden-character`, see `chars.ts`), so a comment is
 *   checked like a value. The formats check their string values again
 *   after decoding, where an escape sequence has become its character.
 * - One byte order mark at the start of the text is removed first.
 *
 * JSON is parsed strictly with `JSON.parse` and additionally checked for
 * duplicate object keys, which `JSON.parse` silently collapses.
 */
import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";
import type { Document } from "yaml";
import { FORBIDDEN_WHAT, findForbiddenLines } from "./chars.js";
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

type Located = { range?: [number, number, number] | null };

/** Problems that matter most come first; ties keep document order. */
const PROBLEM_RANK: Partial<Record<FormatError["code"], number>> = {
  "yaml-alias": 0,
  "yaml-tag": 0,
};

/**
 * Checks every node of a parsed document, whatever its type, with one
 * generic rule: no anchor, no explicit tag, no alias. The walk is a loop
 * over an explicit stack, so a deeply nested document cannot overflow the
 * call stack, and there is one handler for all node types, so no handler
 * can shadow another. Two more rules are checked while walking: a
 * collection used as a mapping key, and a duplicate mapping key (a Set per
 * mapping, linear in the number of keys; keys are compared as the strings
 * they become in a JavaScript object, so `1` and `"1"` collide).
 *
 * Returns the most serious problem: alias and tag problems before the
 * others, then document order. `checkTags` is off for JSON.
 */
function inspectDocument(
  doc: Document,
  lc: LineCounter,
  checkTags: boolean,
): DocProblem | null {
  let best: DocProblem | null = null;
  let bestRank = Infinity;
  const report = (p: DocProblem) => {
    const rank = PROBLEM_RANK[p.code] ?? 1;
    if (rank < bestRank) {
      best = p;
      bestRank = rank;
    }
  };
  const lineOf = (node: Located | null | undefined) => {
    const offset = node?.range?.[0];
    return offset === undefined ? undefined : lc.linePos(offset).line;
  };
  const stack: unknown[] = [doc.contents];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || typeof node !== "object") {
      continue;
    }
    if (isAlias(node)) {
      report({
        code: "yaml-alias",
        message: "YAML alias is not allowed",
        line: lineOf(node),
      });
      continue;
    }
    const n = node as { anchor?: string; tag?: string } & Located;
    if (n.anchor) {
      report({
        code: "yaml-alias",
        message: `YAML anchor &${n.anchor} is not allowed`,
        line: lineOf(n),
      });
    }
    if (checkTags && n.tag) {
      report({
        code: "yaml-tag",
        message: `YAML tag ${n.tag} is not allowed`,
        line: lineOf(n),
      });
    }
    if (isSeq(node)) {
      for (let i = node.items.length - 1; i >= 0; i--)
        stack.push(node.items[i]);
    } else if (isMap(node)) {
      const seen = new Set<string>();
      const children: unknown[] = [];
      for (const pair of node.items) {
        const key = pair.key;
        if (isMap(key) || isSeq(key)) {
          report({
            code: "invalid-yaml",
            message: "a mapping key must be a plain scalar",
            line: lineOf(key),
          });
        } else if (isScalar(key)) {
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
        children.push(pair.key, pair.value);
      }
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return best;
}

/**
 * Second, independent net: the decoded value holds only plain objects,
 * arrays, strings, finite or non-finite numbers, booleans and null. Any
 * other prototype (Set, Map, Date, Uint8Array, a class instance) means a
 * tag got through the node check.
 */
export function isPlainValue(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null) continue;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") continue;
    if (t !== "object") return false;
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of Object.keys(v as object)) {
      stack.push((v as Record<string, unknown>)[key]);
    }
  }
  return true;
}

/** Decodes one YAML document into plain JavaScript values. */
export function parseYamlText(input: string): ParseResult<unknown> {
  const tooLarge = checkSize<unknown>(input);
  if (tooLarge) return tooLarge;
  // A byte order mark may start a file, as in `spec.md`; anywhere else it
  // is a format character like any other.
  const text = stripBom(input);
  // Before the YAML parser sees the text: it drops comments and reads a
  // line break only at a line feed, so a character in a comment could show
  // a reader a line the parser never reads.
  const forbidden = findForbiddenLines(text);
  if (forbidden.length > 0) {
    return failResult(
      forbidden.map((bad) => ({
        code: "forbidden-character",
        path: "$",
        message: `line ${bad.line} contains ${bad.label}, ${FORBIDDEN_WHAT}`,
        line: bad.line,
      })),
    );
  }
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
  if (!isPlainValue(value)) {
    return fail(
      "yaml-tag",
      "the document decodes to a value that is not plain data",
    );
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
