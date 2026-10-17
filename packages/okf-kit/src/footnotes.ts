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
/**
 * An HTML comment span. Besides the ordinary `<!-- ... -->`, it accepts the
 * HTML5 abrupt closing form `<!-->` as a complete (empty) comment -- the `>`
 * branch is tried first, so `<!-->` closes itself rather than opening a
 * comment that reaches for a `-->` further down.
 */
const HTML_COMMENT_RE = /<!--(?:>|[\s\S]*?-->)/g;

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

/**
 * `text` with every HTML comment blanked (keeping line structure), but only
 * where a comment is actually a comment: an HTML comment span is located on a
 * code-span-masked copy of `text`, so a `<!--` written inside an inline code
 * span is code, not a comment opener, and never swallows the prose (and any
 * `[^id]` reference) between it and a later `-->`. The comment spans found on
 * the masked copy are then blanked in the ORIGINAL `text`, which is what keeps
 * inline code itself intact for a definition's text (a code span that merely
 * overlaps a comment's real body stays because the comment's own `<!--` was
 * outside code and its blank range covers the whole span either way).
 */
function blankCommentsOutsideCode(text: string): string {
  const codeMask = blankInlineCode(text);
  const re = new RegExp(HTML_COMMENT_RE.source, "g");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeMask)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    out += text.slice(last, start) + blank(text.slice(start, end));
    last = end;
  }
  return out + text.slice(last);
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
  // The constructs are blanked in dependency order: a code-span-masked
  // comment pass runs first, so a `<!--` written inside an inline code span is
  // treated as code rather than opening a comment that reaches for a later
  // `-->`; HTML comments are gone before fences, so a fence marker written
  // inside a comment never opens a fence; inline code is blanked last, only
  // for the reference view.
  const commentFree = blankCommentsOutsideCode(body.replace(/\r\n?/g, "\n"));
  const fenceFree = blankFences(commentFree);
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
