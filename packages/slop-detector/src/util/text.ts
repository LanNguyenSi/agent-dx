export interface LineCol {
  line: number;
  column: number;
}

// Every finding builder resolves offsets through this helper, so the cost of
// a finding must not depend on how far into the file it sits. The positions
// of the newlines are collected once per text and each offset is then a
// binary search, which keeps a file with many findings linear in its size
// plus its findings. The one-entry cache is keyed by the text itself: the
// packs build all findings of a file before moving to the next one.
let cachedText: string | undefined;
let cachedNewlines: number[] = [];
let indexBuilds = 0;

/**
 * How many times a line index was built since the process started. Exists
 * so a test can assert that repeated lookups on one text reuse the index
 * instead of timing the difference; nothing in the packs reads it.
 */
export function lineIndexBuildCount(): number {
  return indexBuilds;
}

function newlinePositions(text: string): number[] {
  if (cachedText === text) return cachedNewlines;
  indexBuilds++;
  const positions: number[] = [];
  let i = text.indexOf("\n");
  while (i !== -1) {
    positions.push(i);
    i = text.indexOf("\n", i + 1);
  }
  cachedText = text;
  cachedNewlines = positions;
  return positions;
}

/**
 * 1-based line and column of a UTF-16 string offset. The column counts
 * string indexes from the last newline before the offset (so it is 1 at a
 * line start), and an offset past the end of the text keeps counting past
 * it.
 */
export function offsetToLineCol(text: string, offset: number): LineCol {
  const newlines = newlinePositions(text);
  // Newlines strictly before min(offset, text.length): lower bound.
  const limit = Math.min(offset, text.length);
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (newlines[mid] < limit) lo = mid + 1;
    else hi = mid;
  }
  const lastNewline = lo > 0 ? newlines[lo - 1] : -1;
  return { line: lo + 1, column: offset - lastNewline };
}

export function findAllRegex(
  text: string,
  re: RegExp,
): Array<{ index: number; match: string; groups: RegExpExecArray }> {
  const results: Array<{
    index: number;
    match: string;
    groups: RegExpExecArray;
  }> = [];
  if (!re.global) {
    throw new Error(`findAllRegex requires a global regex; got ${re}`);
  }
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({ index: m.index, match: m[0], groups: m });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return results;
}

// Backtick and tilde fences are the two fence styles Markdown (CommonMark
// / GFM) recognizes; an indented (four-space) code block is deliberately
// NOT stripped here -- see docs/review-slop.md for why.
//
// Both the opener and the closer are anchored to the start of a line (with
// CommonMark's up-to-three spaces of leading indentation), because a fence
// only opens a code block there. Unanchored, a mid-sentence run of three
// backticks or tildes -- prose *about* fences, a `~~~` used as a visual
// separator, a triple backtick inside a longer inline span -- paired with
// the next such run anywhere later in the file and blanked every word
// between them, hiding real findings from every rule that reads prose
// through this helper (prose-slop, agent-tics, review-slop).
const BACKTICK_FENCE = /^ {0,3}```[\s\S]*?^ {0,3}```/gm;
const TILDE_FENCE = /^ {0,3}~~~[\s\S]*?^ {0,3}~~~/gm;

export function stripFencedCode(text: string): string {
  return text
    .replace(BACKTICK_FENCE, (block) => " ".repeat(block.length))
    .replace(TILDE_FENCE, (block) => " ".repeat(block.length));
}

export function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, (block) => " ".repeat(block.length));
}
