/**
 * Source lines.
 *
 * The source ledger of a spec maps every line of the original ticket to
 * what became of it. A line is identified by its content and its
 * position, so the ledger survives a re-fetch of the ticket as long as
 * the line itself did not change.
 *
 * Splitting (`splitSourceLines`):
 * - Line breaks are `\r\n`, `\n` or `\r`.
 * - A fenced code block (a line starting with up to three spaces and
 *   three or more backticks or tildes, up to the matching closing fence
 *   or the end of the text) is one unit of kind `code`, even when empty.
 *   Its normalised text is `code:` followed by the block content with
 *   all whitespace runs collapsed to one space. Indented code blocks are
 *   not recognised; they are ordinary lines.
 * - A Markdown image `![alt](target)` is one unit of kind `image` with
 *   the normalised text `image:` followed by the target. It is cut out of
 *   its line first. If the rest of the line is non-empty after
 *   normalisation it is a unit of kind `text`; that unit comes before the
 *   line's image units, which follow in order of appearance. Only the
 *   Markdown image syntax is recognised.
 * - Every other line is a `text` unit.
 *
 * Normalisation of a text line:
 * 1. Unicode NFC.
 * 2. Repeatedly strip a leading block marker: `>` (block quote), `#` to
 *    `######` followed by a space (heading), a list bullet `-`, `*`, `+`
 *    or `<digits>.` / `<digits>)` followed by a space, and a task box
 *    `[ ]`, `[x]` or `[X]` followed by a space.
 * 3. Replace a link `[text](url)` by `text url`.
 * 4. Remove the inline markers `*`, `_`, `` ` ``, `~` and the table
 *    separator `|`.
 * 5. Collapse every whitespace run to one space and trim.
 * 6. A line that is now made only of `-`, `=`, `:` and spaces (a rule, a
 *    setext underline, a table separator row) becomes empty.
 *
 * Empty units are dropped. The remaining units are numbered from 1 in
 * order; that number is the unit's position. Case is never changed.
 *
 * The ID of a unit is `L<position>-<hash>`, where `<hash>` is the first
 * 12 lower-case hex characters of the SHA-256 of the UTF-8 bytes of the
 * normalised text (`SourceLine.hash` keeps all 64).
 */
import { createHash } from "node:crypto";
import type { FormatError, ParseResult } from "./errors.js";
import { failResult, okResult } from "./errors.js";
import { stripBom } from "./input.js";

export type SourceLineKind = "text" | "image" | "code";

export interface SourceLine {
  /** 1-based position among the non-empty units. */
  position: number;
  kind: SourceLineKind;
  /** The normalised text the hash is computed over. */
  normalized: string;
  /** Full SHA-256, lower-case hex. */
  hash: string;
  /** `L<position>-<first 12 hex characters of hash>`. */
  id: string;
}

export const SOURCE_LINE_HASH_LENGTH = 12;

const IMAGE_RE = /!\[[^\]]*\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g;
const LINK_RE = /\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const SOURCE_LINE_ID_RE = /^L([1-9][0-9]{0,8})-([0-9a-f]{12})$/;

export function hashSourceText(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function formatSourceLineId(position: number, hash: string): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new RangeError("position must be a positive integer");
  }
  if (!/^[0-9a-f]{12,64}$/.test(hash)) {
    throw new RangeError("hash must be at least 12 lower-case hex characters");
  }
  return `L${position}-${hash.slice(0, SOURCE_LINE_HASH_LENGTH)}`;
}

export interface ParsedSourceLineId {
  position: number;
  /** The 12-character hash prefix. */
  hash: string;
}

export function parseSourceLineId(
  text: string,
): ParseResult<ParsedSourceLineId> {
  const m = SOURCE_LINE_ID_RE.exec(text);
  if (!m) {
    const error: FormatError = {
      code: "invalid-id",
      path: "$",
      message: `${JSON.stringify(text)} is not a source line ID: expected L<position>-<12 hex characters>`,
    };
    return failResult([error]);
  }
  return okResult({ position: Number(m[1]), hash: m[2]! });
}

export function isSourceLineId(text: string): boolean {
  return SOURCE_LINE_ID_RE.test(text);
}

/** Normalises one text line; see the module comment for the exact steps. */
export function normalizeSourceText(line: string): string {
  let s = line.normalize("NFC");
  for (;;) {
    const next = s
      .replace(/^\s*>/, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*(?:[-*+]|[0-9]+[.)])\s+/, "")
      .replace(/^\s*\[[ xX]\]\s+/, "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(LINK_RE, "$1 $2");
  s = s.replace(/[*_`~|]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (/^[-=: ]*$/.test(s)) return "";
  return s;
}

interface Unit {
  kind: SourceLineKind;
  normalized: string;
}

/** Splits a source text into numbered, hashed units. */
export function splitSourceLines(text: string): SourceLine[] {
  const units: Unit[] = [];
  const lines = stripBom(text).split(/\r\n|\n|\r/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      const fence = open[1]!;
      const closeRe = new RegExp(
        `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
      );
      const inner: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i]!)) {
        inner.push(lines[i]!);
        i += 1;
      }
      i += 1; // the closing fence, or one past the end
      const body = inner
        .join("\n")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim();
      units.push({ kind: "code", normalized: `code:${body}` });
      continue;
    }
    const images: string[] = [];
    const rest = line.replace(IMAGE_RE, (_m, target: string) => {
      images.push(target);
      return " ";
    });
    const normalized = normalizeSourceText(rest);
    if (normalized !== "") units.push({ kind: "text", normalized });
    for (const target of images) {
      units.push({
        kind: "image",
        normalized: `image:${target.normalize("NFC")}`,
      });
    }
    i += 1;
  }
  return units.map((u, index) => {
    const hash = hashSourceText(u.normalized);
    const position = index + 1;
    return {
      position,
      kind: u.kind,
      normalized: u.normalized,
      hash,
      id: formatSourceLineId(position, hash),
    };
  });
}
