export interface LineCol {
  line: number;
  column: number;
}

export function offsetToLineCol(text: string, offset: number): LineCol {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
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
