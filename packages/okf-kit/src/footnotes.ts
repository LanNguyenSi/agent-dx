/**
 * Footnote scanning for OKF v0.2 body citations. A v0.2 doc cites a
 * `sources` entry by a footnote: a REFERENCE `[^id]` in the prose, and
 * (per the usual markdown footnote syntax) a DEFINITION line
 * `[^id]: text` that carries the footnote's text. The reference is what
 * ties a claim to a source, so `footnotes-resolve` judges references; the
 * definition supplies the text in which a line-precise code citation
 * (`citations-resolve`) is written.
 *
 * Grammar, deliberately small and the same for both consumers:
 *  - an id is one or more characters other than whitespace and `]`, and is
 *    case-sensitive (`[^A]` and `[^a]` are different footnotes);
 *  - a DEFINITION is a line that starts (after at most three spaces) with
 *    `[^id]:`; its text is the rest of that line plus the indented
 *    continuation lines under it. The `[^id]:` marker is not a reference;
 *  - a REFERENCE is any other `[^id]` (including one inside a definition's
 *    text);
 *  - fenced code blocks (``` and ~~~) and inline code spans are not
 *    scanned, and a `[^id]` written with a leading backslash is escaped
 *    text, not a reference.
 */

export interface FootnoteDefinition {
  id: string;
  /** The definition's text (marker excluded), continuation lines joined with a space. */
  text: string;
}

export interface FootnoteScan {
  /** Every reference id in document order, one entry per occurrence. */
  references: string[];
  definitions: FootnoteDefinition[];
}

const DEFINITION_RE = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const REFERENCE_RE = /\[\^([^\]\s]+)\]/g;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Replaces every character of `text` except newlines with a space, keeping offsets and line structure. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * `body` with fenced code blocks blanked out. A fence closes on a line of
 * the same character with at least as many characters as the opener; an
 * unclosed fence runs to the end of the doc.
 */
function blankFences(body: string): string {
  let fence: { char: string; len: number } | undefined;
  return body
    .split("\n")
    .map((line) => {
      if (fence) {
        const close = new RegExp(`^ {0,3}${fence.char}{${fence.len},}\\s*$`);
        if (close.test(line)) fence = undefined;
        return blank(line);
      }
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        fence = { char: open[1][0], len: open[1].length };
        return blank(line);
      }
      return line;
    })
    .join("\n");
}

/** `text` with inline code spans blanked: a run of N backticks closes at the next run of exactly N. */
function blankInlineCode(text: string): string {
  return text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (span) => blank(span));
}

/** The definition at `lines[i]` (marker match plus the indices of its continuation lines), or undefined. */
function definitionAt(
  lines: string[],
  i: number,
): { match: RegExpExecArray; last: number } | undefined {
  const match = DEFINITION_RE.exec(lines[i]);
  if (!match) return undefined;
  let last = i;
  while (last + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[last + 1])) {
    last++;
  }
  return { match, last };
}

export function scanFootnotes(body: string): FootnoteScan {
  // `withCode` keeps inline code (a definition's text names line ranges in
  // backticks); `noCode` is what references are searched in. Blanking
  // preserves line structure, so index i is the same line in both.
  const fenceFree = blankFences(body.replace(/\r\n?/g, "\n"));
  const withCode = fenceFree.split("\n");
  const noCode = blankInlineCode(fenceFree).split("\n");
  const references: string[] = [];
  const definitions: FootnoteDefinition[] = [];
  for (let i = 0; i < withCode.length; i++) {
    const def = definitionAt(withCode, i);
    if (!def) {
      collectReferences(noCode[i], references);
      continue;
    }
    const textOf = (lines: string[]): string =>
      [def.match[2], ...lines.slice(i + 1, def.last + 1).map((l) => l.trim())]
        .join(" ")
        .trim();
    definitions.push({ id: def.match[1], text: textOf(withCode) });
    // The marker is not a reference; the text (and continuation) may be.
    const noCodeDef = DEFINITION_RE.exec(noCode[i]);
    collectReferences(
      [
        noCodeDef ? noCodeDef[2] : "",
        ...noCode.slice(i + 1, def.last + 1),
      ].join(" "),
      references,
    );
    i = def.last;
  }
  return { references, definitions };
}

function collectReferences(line: string, into: string[]): void {
  REFERENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_RE.exec(line)) !== null) {
    if (m.index > 0 && line[m.index - 1] === "\\") continue;
    into.push(m[1]);
  }
}
