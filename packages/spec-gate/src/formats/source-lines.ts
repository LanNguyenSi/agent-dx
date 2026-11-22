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
 *   As in CommonMark, the opening line of a backtick fence has no backtick
 *   after the opening run, so a line such as "```npm test``` runs" is an
 *   ordinary line, not a fence.
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
 * The text is refused above `MAX_INPUT_LENGTH` characters (the result then
 * carries an `input-too-large` error). Image and link recognition is a
 * linear scan.
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
import { MAX_INPUT_LENGTH, stripBom } from "./input.js";

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

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCK_MARKERS_RE =
  /^(?:\s*(?:>|#{1,6}\s+|[-*+]\s+|[0-9]+[.)]\s+|\[[ xX]\]\s+))*/;
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

/** Counts the steps of a scan, for tests that bound the work done. */
export interface ScanStats {
  steps: number;
}

interface BracketMatch {
  start: number;
  end: number;
  text: string;
  target: string;
}

/**
 * Index of the first character at or after each position that satisfies
 * `pred`, or -1. One backward pass; makes every later lookup O(1).
 */
function nextIndex(
  line: string,
  kind: "close" | "stop" | "nonSpace" | "quote",
  stats?: ScanStats,
): Int32Array {
  const out = new Int32Array(line.length + 1);
  out[line.length] = -1;
  for (let i = line.length - 1; i >= 0; i--) {
    if (stats) stats.steps += 1;
    const ch = line[i]!;
    let hit: boolean;
    if (kind === "close") hit = ch === "]";
    else if (kind === "quote") hit = ch === '"';
    else if (kind === "stop") hit = ch === ")" || /\s/.test(ch);
    else hit = !/\s/.test(ch);
    out[i] = hit ? i : out[i + 1]!;
  }
  return out;
}

/**
 * Finds every non-overlapping `[text](target "title")` in a line, left to
 * right, the way the regular expression
 * `\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)` does, but in time
 * linear in the line length. With `image` set, each match must be preceded
 * by `!` (and starts there).
 */
function scanBracketLinks(
  line: string,
  image: boolean,
  stats?: ScanStats,
): BracketMatch[] {
  const open = image ? "![" : "[";
  if (!line.includes(open)) return [];
  const close = nextIndex(line, "close", stats);
  const stop = nextIndex(line, "stop", stats);
  const nonSpace = nextIndex(line, "nonSpace", stats);
  const quote = nextIndex(line, "quote", stats);
  const out: BracketMatch[] = [];
  let i = line.indexOf(open);
  while (i >= 0) {
    if (stats) stats.steps += 1;
    const textStart = i + open.length;
    const c = close[textStart]!;
    let end = -1;
    let target = "";
    if (c >= 0 && line[c + 1] === "(") {
      const t0 = nonSpace[c + 2] === -1 ? line.length : nonSpace[c + 2]!;
      const t1 = stop[t0]! === -1 ? line.length : stop[t0]!;
      target = line.slice(t0, t1);
      const j = nonSpace[t1] === -1 ? line.length : nonSpace[t1]!;
      if (line[j] === ")") end = j + 1;
      else if (line[j] === '"') {
        const q = quote[j + 1]!;
        if (q >= 0) {
          const k = nonSpace[q + 1] === -1 ? line.length : nonSpace[q + 1]!;
          if (line[k] === ")") end = k + 1;
        }
      }
    }
    if (end >= 0) {
      out.push({ start: i, end, text: line.slice(textStart, c), target });
      i = line.indexOf(open, end);
    } else {
      i = line.indexOf(open, i + 1);
    }
  }
  return out;
}

function replaceMatches(
  line: string,
  matches: BracketMatch[],
  mode: "link" | "blank",
): string {
  let out = "";
  let at = 0;
  for (const m of matches) {
    out +=
      line.slice(at, m.start) +
      (mode === "link" ? `${m.text} ${m.target}` : " ");
    at = m.end;
  }
  return out + line.slice(at);
}

/** Normalises one text line; see the module comment for the exact steps. */
export function normalizeSourceText(line: string, stats?: ScanStats): string {
  let s = line.normalize("NFC");
  s = s.replace(BLOCK_MARKERS_RE, "");
  s = replaceMatches(s, scanBracketLinks(s, false, stats), "link");
  s = s.replace(/[*_`~|]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (/^[-=: ]*$/.test(s)) return "";
  return s;
}

interface Unit {
  kind: SourceLineKind;
  normalized: string;
}

/**
 * Splits a source text into numbered, hashed units. A text over
 * `MAX_INPUT_LENGTH` characters is refused with an `input-too-large` error.
 */
export function splitSourceLines(
  text: string,
  stats?: ScanStats,
): ParseResult<SourceLine[]> {
  if (text.length > MAX_INPUT_LENGTH) {
    return failResult([
      {
        code: "input-too-large",
        path: "$",
        message: `source text is ${text.length} characters, the limit is ${MAX_INPUT_LENGTH}`,
      },
    ]);
  }
  const units: Unit[] = [];
  const lines = stripBom(text).split(/\r\n|\n|\r/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = FENCE_OPEN_RE.exec(line);
    // A backtick fence opener has no backtick after its opening run.
    if (open && !(open[1]![0] === "`" && line.includes("`", open[0].length))) {
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
    const found = scanBracketLinks(line, true, stats);
    const rest = replaceMatches(line, found, "blank");
    const normalized = normalizeSourceText(rest, stats);
    if (normalized !== "") units.push({ kind: "text", normalized });
    for (const m of found) {
      units.push({
        kind: "image",
        normalized: `image:${m.target.normalize("NFC")}`,
      });
    }
    i += 1;
  }
  return okResult(
    units.map((u, index) => {
      const hash = hashSourceText(u.normalized);
      const position = index + 1;
      return {
        position,
        kind: u.kind,
        normalized: u.normalized,
        hash,
        id: formatSourceLineId(position, hash),
      };
    }),
  );
}
