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
 *  - fenced code blocks (``` and ~~~), inline code spans (which never
 *    cross a blank line) and HTML comments are not scanned; indented
 *    code blocks are not excluded, and a `[^id]` written with a leading backslash is escaped
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
const COMMENT_OPENER = "<!--";
const COMMENT_CLOSER = "-->";

/** Replaces every character of `text` except newlines with a space, keeping offsets and line structure. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/** The state carried from line to line by `maskFencesAndComments`. */
interface MaskState {
  /** The open fence, if any; it closes only on its own marker shape. */
  fence?: { char: string; len: number };
  /** True inside an open HTML comment, where only `-->` is looked for. */
  comment: boolean;
  /** Length of the open inline code delimiter run, 0 when outside one. */
  openRun: number;
  /** True when a `-->` occurs on a later line of the doc (fences not considered). */
  closerLater: boolean;
}

/**
 * One line through the fence/comment scanner, updating the carried state and
 * returning the masked line. The order of checks is the whole design: in a
 * fence only the fence closer is looked for (a `<!--` in fence code is code);
 * in a comment only `-->` is looked for (a fence marker in comment text
 * never opens a fence); outside both, a fence opener at line start opens a
 * fence, and elsewhere an inline code span is crossed before a `<!--`
 * outside a span is taken as a comment opener only when a `-->` follows it
 * somewhere later in the doc (so a stray `<!--` in prose hides nothing); the
 * forms `<!-->` and `<!--->` are complete empty comments on their own. An
 * unclosed fence runs to the end of the doc, and so does a comment that was
 * opened because a later `-->` existed.
 */
function maskLine(line: string, s: MaskState): string {
  if (s.fence) {
    const close = new RegExp(`^ {0,3}${s.fence.char}{${s.fence.len},}\\s*$`);
    if (close.test(line)) s.fence = undefined;
    return blank(line);
  }
  if (/^[ \t]*$/.test(line)) {
    // A blank line ends an inline code span, never a comment.
    s.openRun = 0;
    return s.comment ? blank(line) : line;
  }
  if (!s.comment) {
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      s.fence = { char: open[1][0], len: open[1].length };
      s.openRun = 0;
      return blank(line);
    }
  }
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (s.comment) {
      const end = line.indexOf(COMMENT_CLOSER, i);
      if (end < 0) break;
      out += blank(line.slice(i, end + COMMENT_CLOSER.length));
      s.comment = false;
      i = end + COMMENT_CLOSER.length;
      continue;
    }
    if (s.openRun > 0) {
      const j = line.indexOf("`", i);
      if (j < 0) break;
      let k = j;
      while (k < line.length && line[k] === "`") k++;
      if (k - j === s.openRun) s.openRun = 0;
      out += line.slice(i, k);
      i = k;
      continue;
    }
    if (line.startsWith(COMMENT_OPENER, i)) {
      // `<!-->` and `<!--->` are complete empty comments (CommonMark 0.31).
      const empty = line.startsWith("<!-->", i)
        ? "<!-->"
        : line.startsWith("<!--->", i)
          ? "<!--->"
          : undefined;
      if (empty) {
        out += blank(empty);
        i += empty.length;
        continue;
      }
      // Any other `<!--` opens a comment only when a `-->` follows it.
      const from = i + COMMENT_OPENER.length;
      if (s.closerLater || line.indexOf(COMMENT_CLOSER, from) >= 0) {
        s.comment = true;
        out += blank(COMMENT_OPENER);
        i = from;
        continue;
      }
    }
    if (line[i] === "`") {
      let k = i;
      while (k < line.length && line[k] === "`") k++;
      s.openRun = k - i;
      out += line.slice(i, k);
      i = k;
      continue;
    }
    out += line[i];
    i++;
  }
  // Left open in a comment: the rest of the line is comment. Left open in an
  // inline code span: inline code survives this pass (it is blanked later).
  return out + (s.comment ? blank(line.slice(i)) : line.slice(i));
}

/**
 * `body` with fenced code blocks and HTML comment spans blanked (line
 * structure kept), decided by ONE line-by-line pass that tracks fence state
 * and comment state together, so neither construct can swallow the other's
 * region. Inline code is only consulted to decide whether a `<!--` is a
 * comment opener; blanking inline code is a separate step.
 */
function maskFencesAndComments(body: string): string {
  const lines = body.split("\n");
  let lastCloser = -1;
  lines.forEach((l, n) => {
    if (l.includes(COMMENT_CLOSER)) lastCloser = n;
  });
  const s: MaskState = { comment: false, openRun: 0, closerLater: false };
  return lines
    .map((line, n) => {
      s.closerLater = n < lastCloser;
      return maskLine(line, s);
    })
    .join("\n");
}

/**
 * `text` with inline code spans blanked: a run of N backticks closes at the
 * next run of exactly N. A span never crosses a blank line (a paragraph
 * boundary), so one unpaired backtick only affects its own paragraph.
 */
function blankInlineCode(text: string): string {
  return text
    .split(/(\n[ \t]*\n)/)
    .map((part) =>
      part.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (span) => blank(span)),
    )
    .join("");
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
  //
  // One pass blanks fences and comments together, tracking both states at
  // once: a `<!--` inside an open fence is code and never opens a comment, a
  // fence marker inside an open comment never opens a fence, and outside both
  // a `<!--` inside an inline code span is code rather than a comment opener.
  // Inline code is blanked last, only for the reference view.
  const masked = maskFencesAndComments(body.replace(/\r\n?/g, "\n"));
  const withCode = masked.split("\n");
  const noCode = blankInlineCode(masked).split("\n");
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
