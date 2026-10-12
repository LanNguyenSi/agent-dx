import {
  getLineSpans,
  lineIndexAt,
  splitLinesWithEndings,
  type Region,
} from "./engine.js";

const CONTEXT_LINES = 3;

interface LineChange {
  /** 0-based first old line and exclusive end. */
  oldStart: number;
  oldEnd: number;
  newLines: string[];
}

/**
 * Line changes for non-overlapping regions of `content` (an LF view):
 * each region is widened to the lines it touches, regions sharing a line
 * are merged, and lines equal on both sides at a change's edges are
 * trimmed so a hunk shows only what differs.
 */
function lineChanges(
  content: string,
  regions: readonly Region[],
): LineChange[] {
  const lines = getLineSpans(content);
  const oldLines = splitLinesWithEndings(content);
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const merged: Array<{ first: number; last: number; regions: Region[] }> = [];
  for (const r of sorted) {
    const first = lineIndexAt(lines, r.start);
    const last = lineIndexAt(lines, Math.max(r.start, r.end - 1));
    const prev = merged[merged.length - 1];
    if (prev !== undefined && first <= prev.last) {
      prev.last = Math.max(prev.last, last);
      prev.regions.push(r);
    } else {
      merged.push({ first, last, regions: [r] });
    }
  }
  const changes: LineChange[] = [];
  for (const group of merged) {
    let text = "";
    let cursor = lines[group.first].start;
    for (const r of group.regions) {
      text += content.slice(cursor, r.start) + r.text;
      cursor = r.end;
    }
    text += content.slice(cursor, lines[group.last].end);
    let oldStart = group.first;
    let oldEnd = group.last + 1;
    const newLines = splitLinesWithEndings(text);
    while (
      oldStart < oldEnd &&
      newLines.length > 0 &&
      oldLines[oldStart] === newLines[0]
    ) {
      oldStart += 1;
      newLines.shift();
    }
    while (
      oldEnd > oldStart &&
      newLines.length > 0 &&
      oldLines[oldEnd - 1] === newLines[newLines.length - 1]
    ) {
      oldEnd -= 1;
      newLines.pop();
    }
    if (oldStart === oldEnd && newLines.length === 0) continue;
    changes.push({ oldStart, oldEnd, newLines });
  }
  return changes;
}

function emitLine(out: string[], prefix: string, line: string): void {
  if (line.endsWith("\n")) {
    out.push(prefix + line.slice(0, -1));
  } else {
    out.push(prefix + line);
    out.push("\\ No newline at end of file");
  }
}

/**
 * A unified diff (`--- a/<path>`, `+++ b/<path>`, hunks with three lines
 * of context) of applying `regions` to `content`. Line endings are shown
 * as LF whatever the file uses. Empty when nothing changes.
 */
export function unifiedDiff(
  displayPath: string,
  content: string,
  regions: readonly Region[],
): string {
  const changes = lineChanges(content, regions);
  if (changes.length === 0) return "";
  const oldLines = splitLinesWithEndings(content);
  const out: string[] = [`--- a/${displayPath}`, `+++ b/${displayPath}`];

  // Group changes whose context windows touch into one hunk.
  const hunks: LineChange[][] = [];
  for (const c of changes) {
    const prev = hunks[hunks.length - 1];
    const prevLast = prev?.[prev.length - 1];
    if (
      prevLast !== undefined &&
      c.oldStart - prevLast.oldEnd <= 2 * CONTEXT_LINES
    ) {
      prev.push(c);
    } else {
      hunks.push([c]);
    }
  }

  // Running difference between new and old line numbers before a hunk.
  let delta = 0;
  for (const hunk of hunks) {
    const first = hunk[0];
    const last = hunk[hunk.length - 1];
    const ctxStart = Math.max(0, first.oldStart - CONTEXT_LINES);
    const ctxEnd = Math.min(oldLines.length, last.oldEnd + CONTEXT_LINES);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let cursor = ctxStart;
    let hunkDelta = 0;
    for (const c of hunk) {
      for (; cursor < c.oldStart; cursor++) {
        emitLine(body, " ", oldLines[cursor]);
        oldCount += 1;
        newCount += 1;
      }
      for (let i = c.oldStart; i < c.oldEnd; i++) {
        emitLine(body, "-", oldLines[i]);
        oldCount += 1;
      }
      for (const nl of c.newLines) {
        emitLine(body, "+", nl);
        newCount += 1;
      }
      hunkDelta += c.newLines.length - (c.oldEnd - c.oldStart);
      cursor = c.oldEnd;
    }
    for (; cursor < ctxEnd; cursor++) {
      emitLine(body, " ", oldLines[cursor]);
      oldCount += 1;
      newCount += 1;
    }
    const oldStartNo = oldCount === 0 ? ctxStart : ctxStart + 1;
    const newStartNo = newCount === 0 ? ctxStart + delta : ctxStart + delta + 1;
    out.push(
      `@@ -${String(oldStartNo)},${String(oldCount)} +${String(newStartNo)},${String(newCount)} @@`,
    );
    out.push(...body);
    delta += hunkDelta;
  }
  return out.join("\n") + "\n";
}
