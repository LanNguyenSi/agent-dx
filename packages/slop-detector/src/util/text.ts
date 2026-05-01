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
  const results: Array<{ index: number; match: string; groups: RegExpExecArray }> = [];
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

export function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length));
}

export function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, (block) => " ".repeat(block.length));
}
