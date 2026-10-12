/*
 * Text-matching engine for `agent-primitives patch`.
 *
 * Ported from pi-mono (https://github.com/badlogic/pi-mono),
 * packages/coding-agent/src/core/tools/edit-diff.ts at commit
 * 7bd01fb92485c06f92ecfff7ccf3197148bc16af. Taken over: the fuzzy
 * normalisation (`normalizeForFuzzyMatch`), the line helpers
 * (`splitLinesWithEndings`, `getLineSpans`, `getReplacementLineRange`,
 * `applyReplacements`), the grouping behind
 * `applyReplacementsPreservingUnchangedLines`, the empty-old-text refusal,
 * the uniqueness refusal and the overlap check, and the line-ending
 * detection. Changed here: the fuzzy normalisation is split into ordered
 * tiers that are each tried only when the previous one found nothing, and
 * ambiguity is counted in the tier that matched; `replaceAll` is added;
 * line endings are mapped back per offset instead of rewriting the whole
 * file with one ending; a fuzzy match returns its widened line region so
 * edits of different tiers in one file can be combined.
 *
 * Original notice of the ported file:
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** The matching tiers, in the order they are tried. */
export type MatchTier = "exact" | "trailing_whitespace" | "unicode";

export const MATCH_TIERS: readonly MatchTier[] = [
  "exact",
  "trailing_whitespace",
  "unicode",
];

/** Line ending a file uses for the text an edit inserts: the first ending
 * in the file, LF for a file with no line break. */
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** CRLF to LF. A lone CR is kept as an ordinary character, so the
 * LF view maps back to the raw text one offset at a time. */
export function crlfToLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Strip trailing whitespace from each line. */
export function stripTrailingWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/**
 * Normalize text for the `unicode` tier: NFKC, trailing whitespace
 * stripped per line, typographic quotes and dashes to ASCII, special
 * spaces to a plain space.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    stripTrailingWhitespace(text.normalize("NFKC"))
      // Smart single quotes to '
      .replace(/[‘’‚‛]/g, "'")
      // Smart double quotes to "
      .replace(/[“”„‟]/g, '"')
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en dash, U+2014 em dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[‐‑‒–—―−]/g, "-")
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[  -   　]/g, " ")
  );
}

export function normalizeForTier(text: string, tier: MatchTier): string {
  switch (tier) {
    case "exact":
      return text;
    case "trailing_whitespace":
      return stripTrailingWhitespace(text);
    case "unicode":
      return normalizeForFuzzyMatch(text);
  }
}

export function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export interface LineSpan {
  start: number;
  end: number;
}

export function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

/** 0-based index of the line holding `offset` (binary search). */
export function lineIndexAt(
  lines: readonly LineSpan[],
  offset: number,
): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface TextReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

function getReplacementLineRange(
  lines: readonly LineSpan[],
  replacement: TextReplacement,
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }

  return { startLine, endLine: endLine + 1 };
}

/** Apply non-overlapping replacements, last first so offsets stay valid.
 * `offset` is subtracted from every `matchIndex` (for a slice). */
export function applyReplacements(
  content: string,
  replacements: readonly TextReplacement[],
  offset = 0,
): string {
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  let result = content;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const replacement = sorted[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/** A replacement of `[start, end)` of the LF view of the original file. */
export interface Region {
  start: number;
  end: number;
  text: string;
  /** Plan indices of the edits this region carries. */
  edits: number[];
}

/**
 * Regions that apply `replacements`, matched against `baseContent` (a
 * normalized view of `originalContent` with the same line count), to
 * `originalContent`. Each replacement is widened to the lines it
 * touches; replacements touching a common line form one group; a group's
 * lines are rewritten from the normalized base and every other line keeps
 * its original bytes. The actual replacement ranges drive the grouping, so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function lineRegionsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: ReadonlyArray<TextReplacement & { editIndex: number }>,
): Region[] {
  const originalLines = getLineSpans(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    );
  }

  const groups: Array<{
    startLine: number;
    endLine: number;
    replacements: Array<TextReplacement & { editIndex: number }>;
  }> = [];
  const sortedReplacements = [...replacements].sort(
    (a, b) => a.matchIndex - b.matchIndex,
  );
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  return groups.map((group) => {
    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    return {
      start: originalLines[group.startLine].start,
      end: originalLines[group.endLine - 1].end,
      text: applyReplacements(
        baseContent.slice(groupStartOffset, groupEndOffset),
        group.replacements,
        groupStartOffset,
      ),
      edits: [...new Set(group.replacements.map((r) => r.editIndex))],
    };
  });
}

/** Splice non-overlapping regions into `content`. */
export function applyRegions(
  content: string,
  regions: readonly Region[],
): string {
  return applyReplacements(
    content,
    regions.map((r) => ({
      matchIndex: r.start,
      matchLength: r.end - r.start,
      newText: r.text,
    })),
  );
}

/**
 * Apply replacements matched against `baseContent` to `originalContent`
 * while preserving unchanged line blocks from the original (see
 * `lineRegionsPreservingUnchangedLines`).
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: readonly TextReplacement[],
): string {
  return applyRegions(
    originalContent,
    lineRegionsPreservingUnchangedLines(
      originalContent,
      baseContent,
      replacements.map((r) => ({ ...r, editIndex: 0 })),
    ),
  );
}

/** Start offsets of `needle` in `haystack`. `overlapping` steps by one
 * character (for counting ambiguity), otherwise by the needle length
 * (the occurrences `replaceAll` replaces). */
export function findOccurrences(
  haystack: string,
  needle: string,
  overlapping: boolean,
): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + (overlapping ? 1 : needle.length);
  }
  return out;
}

export interface EditInput {
  /** Plan index of the edit. */
  index: number;
  /** Old text, LF line endings. */
  old: string;
  /** New text, LF line endings. */
  new: string;
  replaceAll: boolean;
}

export interface LineRange {
  start: number;
  end: number;
}

export type EditResolution =
  | {
      index: number;
      status: "resolved";
      tier: MatchTier;
      occurrences: number;
      /** 1-based line ranges in the original file, one per occurrence. */
      lineRanges: LineRange[];
    }
  | {
      index: number;
      status: "missing";
    }
  | {
      index: number;
      status: "ambiguous";
      tier: MatchTier;
      occurrences: number;
      /** 1-based start line of each match. */
      matchLines: number[];
    }
  | {
      index: number;
      status: "overlap";
      tier: MatchTier;
      occurrences: number;
      lineRanges: LineRange[];
      overlapsWith: number[];
    };

export interface FileResolution {
  edits: EditResolution[];
  /** The regions to apply when every edit resolved; empty otherwise. */
  regions: Region[];
  /** New LF content when every edit resolved, else undefined. */
  newContent: string | undefined;
}

interface TierView {
  content: string;
  lines: LineSpan[];
}

/**
 * Resolve every edit of one file against the LF view of its current
 * content, all against the same original (never against the output of an
 * earlier edit). Per edit, the tiers are tried in order and the first tier
 * with at least one match decides: more than one match there without
 * `replaceAll` is `ambiguous`, never a silent first match. Matches of
 * different edits that overlap (after a fuzzy match is widened to whole
 * lines) refuse every edit involved as `overlap`.
 */
export function resolveFileEdits(
  content: string,
  edits: readonly EditInput[],
): FileResolution {
  const views = new Map<MatchTier, TierView | null>();
  const viewFor = (tier: MatchTier): TierView | null => {
    if (!views.has(tier)) {
      const normalized = normalizeForTier(content, tier);
      // A tier whose normalisation changed the line count cannot be mapped
      // back line by line; it is skipped.
      const lines = getLineSpans(normalized);
      const ok =
        tier === "exact" ||
        normalized.split("\n").length === content.split("\n").length;
      views.set(tier, ok ? { content: normalized, lines } : null);
    }
    return views.get(tier) ?? null;
  };
  const resolutions: EditResolution[] = [];
  const matched: Array<{
    index: number;
    tier: MatchTier;
    replacements: TextReplacement[];
  }> = [];

  for (const edit of edits) {
    let found = false;
    for (const tier of MATCH_TIERS) {
      const view = viewFor(tier);
      if (view === null) continue;
      const needle = normalizeForTier(edit.old, tier);
      if (needle.length === 0) continue;
      const all = findOccurrences(view.content, needle, true);
      if (all.length === 0) continue;
      found = true;
      if (all.length > 1 && !edit.replaceAll) {
        resolutions.push({
          index: edit.index,
          status: "ambiguous",
          tier,
          occurrences: all.length,
          matchLines: all.map((o) => lineIndexAt(view.lines, o) + 1),
        });
        break;
      }
      const used = edit.replaceAll
        ? findOccurrences(view.content, needle, false)
        : all;
      const replacements = used.map((o) => ({
        matchIndex: o,
        matchLength: needle.length,
        newText: edit.new,
      }));
      matched.push({ index: edit.index, tier, replacements });
      resolutions.push({
        index: edit.index,
        status: "resolved",
        tier,
        occurrences: used.length,
        lineRanges: used.map((o) => ({
          start: lineIndexAt(view.lines, o) + 1,
          end: lineIndexAt(view.lines, o + needle.length - 1) + 1,
        })),
      });
      break;
    }
    if (!found) resolutions.push({ index: edit.index, status: "missing" });
  }

  // Overlap, step 1: within one tier's space, matched character ranges of
  // different edits must not intersect.
  const overlapping = new Map<number, Set<number>>();
  const markOverlap = (a: readonly number[], b: readonly number[]): void => {
    for (const x of a) {
      for (const y of b) {
        if (x === y) continue;
        for (const [from, to] of [
          [x, y],
          [y, x],
        ]) {
          if (!overlapping.has(from)) overlapping.set(from, new Set());
          overlapping.get(from)?.add(to);
        }
      }
    }
  };
  for (const tier of MATCH_TIERS) {
    const spans = matched
      .filter((m) => m.tier === tier)
      .flatMap((m) =>
        m.replacements.map((r) => ({
          index: m.index,
          start: r.matchIndex,
          end: r.matchIndex + r.matchLength,
        })),
      )
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        if (spans[j].start >= spans[i].end) break;
        markOverlap([spans[i].index], [spans[j].index]);
      }
    }
  }

  // Regions in the LF view: an exact match is replaced character for
  // character; a fuzzy match is widened to whole lines rewritten from that
  // tier's normalized view.
  const regions: Region[] = [];
  for (const m of matched) {
    if (m.tier !== "exact") continue;
    for (const r of m.replacements) {
      regions.push({
        start: r.matchIndex,
        end: r.matchIndex + r.matchLength,
        text: r.newText,
        edits: [m.index],
      });
    }
  }
  for (const tier of MATCH_TIERS) {
    if (tier === "exact") continue;
    const inTier = matched.filter((m) => m.tier === tier);
    if (inTier.length === 0) continue;
    const view = viewFor(tier);
    if (view === null) continue;
    regions.push(
      ...lineRegionsPreservingUnchangedLines(
        content,
        view.content,
        inTier.flatMap((m) =>
          m.replacements.map((r) => ({ ...r, editIndex: m.index })),
        ),
      ),
    );
  }

  // Overlap, step 2: regions (across tiers, and fuzzy line widening) must
  // not intersect.
  regions.sort((a, b) => a.start - b.start);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (regions[j].start >= regions[i].end) break;
      markOverlap(regions[i].edits, regions[j].edits);
    }
  }

  const finalResolutions = resolutions.map((r): EditResolution => {
    const others = overlapping.get(r.index);
    if (r.status !== "resolved" || others === undefined) return r;
    return {
      index: r.index,
      status: "overlap",
      tier: r.tier,
      occurrences: r.occurrences,
      lineRanges: r.lineRanges,
      overlapsWith: [...others].sort((a, b) => a - b),
    };
  });

  const allResolved = finalResolutions.every((r) => r.status === "resolved");
  return {
    edits: finalResolutions,
    regions: allResolved ? regions : [],
    newContent: allResolved ? applyRegions(content, regions) : undefined,
  };
}

/** Offsets of the LF view mapped to the raw text: each CRLF collapsed in
 * the LF view adds one raw character before every later offset. */
export function lfToRawMapper(raw: string): (lfOffset: number) => number {
  const crlfAt: number[] = [];
  let removed = 0;
  for (let i = raw.indexOf("\r\n"); i !== -1; i = raw.indexOf("\r\n", i + 2)) {
    // Position of the '\n' in the LF view.
    crlfAt.push(i - removed);
    removed += 1;
  }
  return (lfOffset: number): number => {
    // Count CRLFs whose LF-view position is strictly before lfOffset.
    let lo = 0;
    let hi = crlfAt.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (crlfAt[mid] < lfOffset) lo = mid + 1;
      else hi = mid;
    }
    return lfOffset + lo;
  };
}

/**
 * Apply LF-view regions to the raw text: untouched bytes (including the
 * line endings of untouched lines, in a mixed-ending file too) are kept,
 * and every line break the regions insert uses `ending`.
 */
export function applyRegionsToRaw(
  raw: string,
  regions: readonly Region[],
  ending: "\r\n" | "\n",
): string {
  const toRaw = lfToRawMapper(raw);
  return applyReplacements(
    raw,
    regions.map((r) => {
      const start = toRaw(r.start);
      return {
        matchIndex: start,
        matchLength: toRaw(r.end) - start,
        newText: ending === "\r\n" ? r.text.replace(/\n/g, "\r\n") : r.text,
      };
    }),
  );
}
