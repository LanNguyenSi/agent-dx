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
 * edits of different tiers in one file can be combined; within that region
 * only the matched original text is replaced, and a match whose lines
 * would change outside it is refused instead of rewritten from the
 * normalized text; a needle whose last line ends in whitespace matches a
 * fuzzy tier only at a line end; line spans are counted per `\n` (an
 * empty last line included); replacements are joined in one pass.
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
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes to "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en dash, U+2014 em dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
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

/**
 * One span per `\n`-separated line (each including its `\n`), so the
 * count always equals `content.split("\n").length`: a final line without
 * a line break is a span of its own, even when it is empty. Two views of
 * one file that keep the line breaks therefore always have the same
 * number of spans, also when a normalisation empties the last line.
 */
export function getLineSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (;;) {
    const nl = content.indexOf("\n", start);
    if (nl === -1) {
      spans.push({ start, end: content.length });
      return spans;
    }
    spans.push({ start, end: nl + 1 });
    start = nl + 1;
  }
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
  const startLine = lineIndexAt(lines, replacementStart);
  const first = lines[startLine];
  if (
    first === undefined ||
    replacementStart < first.start ||
    replacementStart >= first.end
  ) {
    throw new Error("Replacement range is outside the base content.");
  }
  const endLine = lineIndexAt(
    lines,
    Math.max(replacementStart, replacementEnd - 1),
  );
  if (lines[endLine].end < replacementEnd) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}

/** Apply non-overlapping replacements, building the result from chunks
 * joined once (linear in the content size, also for many replacements).
 * `offset` is subtracted from every `matchIndex` (for a slice).
 * Overlapping replacements are a caller bug and throw. */
export function applyReplacements(
  content: string,
  replacements: readonly TextReplacement[],
  offset = 0,
): string {
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of sorted) {
    const at = replacement.matchIndex - offset;
    if (at < cursor) {
      throw new Error("Replacements overlap; refusing to apply them.");
    }
    parts.push(content.slice(cursor, at), replacement.newText);
    cursor = at + replacement.matchLength;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

/** A replacement of `[start, end)` of the LF view of the original file. */
export interface Region {
  start: number;
  end: number;
  text: string;
  /** Plan indices of the edits this region carries. */
  edits: number[];
  /** Set on a fuzzy-tier region whose rewrite would also change
   * characters of the original outside the matched text (`text` is then
   * the normalized rewrite, which is never written). */
  sideEffect?: true;
  /** On a fuzzy-tier region: the replacements of the matched original
   * text inside it (LF-view offsets), so the raw write keeps every other
   * byte of the region's lines, line endings included. */
  parts?: Array<{ start: number; end: number; text: string }>;
}

/** A replacement matched in a normalized view, with the plan index of its
 * edit and whether trailing whitespace the normalisation dropped right
 * after the match is kept (true unless the edit's own old text ended its
 * last line in whitespace, which then counts as part of the match). */
export type FuzzyReplacement = TextReplacement & {
  editIndex: number;
  keepTrailingWhitespace?: boolean;
};

/** Trailing whitespace of the last line of `text` (not the line break). */
function trailingInlineWhitespace(text: string): string {
  return /[^\S\n]*$/u.exec(text)?.[0] ?? "";
}

/**
 * Where the matches of a group lie in its original text, when the
 * original text outside the matches reads exactly as the normalized text
 * does: `original` must read `pre`, then some matched text, then the
 * literal gap to the next match, and so on, ending in the literal text
 * after the last match. Returns the replacement of each matched original
 * text (offsets into `original`), or undefined when there is no such
 * split, because writing the normalized rewrite would then change
 * characters outside the matched text. The gaps are located leftmost
 * first, which finds a split whenever one exists.
 */
function matchesInOriginal(
  original: string,
  base: string,
  sorted: readonly FuzzyReplacement[],
  offset: number,
): Array<{ start: number; end: number; text: string }> | undefined {
  const pre = base.slice(0, sorted[0].matchIndex - offset);
  if (!original.startsWith(pre)) return undefined;
  const parts: Array<{ start: number; end: number; text: string }> = [];
  let origPos = pre.length;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const baseEnd = r.matchIndex - offset + r.matchLength;
    const next = sorted[i + 1] as FuzzyReplacement | undefined;
    if (next !== undefined && next.matchIndex - offset < baseEnd) {
      throw new Error("Replacements overlap; refusing to apply them.");
    }
    const gap =
      next === undefined
        ? base.slice(baseEnd)
        : base.slice(baseEnd, next.matchIndex - offset);
    let gapAt: number;
    if (next === undefined) {
      gapAt = original.length - gap.length;
      if (gapAt < origPos + 1 || !original.endsWith(gap)) return undefined;
    } else {
      gapAt =
        gap.length === 0 ? origPos + 1 : original.indexOf(gap, origPos + 1);
      if (gapAt === -1) return undefined;
    }
    let end = gapAt;
    if (r.keepTrailingWhitespace === true) {
      end -= trailingInlineWhitespace(original.slice(origPos, gapAt)).length;
    }
    parts.push({
      start: origPos,
      end: Math.max(origPos, end),
      text: r.newText,
    });
    origPos = gapAt + gap.length;
  }
  return parts;
}

/**
 * Regions that apply `replacements`, matched against `baseContent` (a
 * normalized view of `originalContent` with the same line count), to
 * `originalContent`. Each replacement is widened to the lines it
 * touches; replacements touching a common line form one group, and every
 * line outside the groups keeps its original bytes. Within a group the
 * matched original text is replaced and the rest of the group's original
 * text is kept, which works only when that rest reads the same in both
 * views; when it does not, the region carries `sideEffect` (and the
 * normalized rewrite as its text). The actual replacement ranges drive the
 * grouping, so duplicate normalized lines cannot be aligned to the wrong
 * occurrence.
 */
export function lineRegionsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: readonly FuzzyReplacement[],
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
    replacements: FuzzyReplacement[];
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

  return groups.map((group): Region => {
    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    const start = originalLines[group.startLine].start;
    const end = originalLines[group.endLine - 1].end;
    const base = baseContent.slice(groupStartOffset, groupEndOffset);
    const original = originalContent.slice(start, end);
    const edits = [...new Set(group.replacements.map((r) => r.editIndex))];
    const parts = matchesInOriginal(
      original,
      base,
      group.replacements,
      groupStartOffset,
    );
    if (parts !== undefined) {
      return {
        start,
        end,
        text: applyReplacements(
          original,
          parts.map((p) => ({
            matchIndex: p.start,
            matchLength: p.end - p.start,
            newText: p.text,
          })),
        ),
        edits,
        parts: parts.map((p) => ({
          start: start + p.start,
          end: start + p.end,
          text: p.text,
        })),
      };
    }
    return {
      start,
      end,
      text: applyReplacements(base, group.replacements, groupStartOffset),
      edits,
      sideEffect: true,
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
    }
  | {
      index: number;
      status: "fuzzy_side_effect";
      tier: MatchTier;
      occurrences: number;
      lineRanges: LineRange[];
      /** 1-based lines whose rewrite would change text outside the match. */
      affectedLines: LineRange;
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

/** True when the last line of `old` ends in whitespace a fuzzy tier
 * strips: such a match must then end at a line end, since the stripped
 * whitespace stood for the rest of that line. */
function lastLineEndsInWhitespace(old: string): boolean {
  const last = old.slice(old.lastIndexOf("\n") + 1);
  return last.length > 0 && last.trimEnd() !== last;
}

/**
 * Resolve every edit of one file against the LF view of its current
 * content, all against the same original (never against the output of an
 * earlier edit). Per edit, the tiers are tried in order and the first tier
 * with at least one match decides: more than one match there without
 * `replaceAll` is `ambiguous`, never a silent first match. Matches of
 * different edits that overlap (after a fuzzy match is widened to whole
 * lines) refuse every edit involved as `overlap`. A fuzzy match whose
 * lines would change outside the matched text (a typographic quote or an
 * NFKC form next to the match) refuses its edits as `fuzzy_side_effect`.
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
    keepTrailingWhitespace: boolean;
    replacements: TextReplacement[];
  }> = [];

  for (const edit of edits) {
    let found = false;
    const endsInWhitespace = lastLineEndsInWhitespace(edit.old);
    for (const tier of MATCH_TIERS) {
      const view = viewFor(tier);
      if (view === null) continue;
      const needle = normalizeForTier(edit.old, tier);
      if (needle.length === 0) continue;
      // A needle whose last line lost trailing whitespace to this tier
      // matches only where the match ends at a line end.
      const atLineEnd = (o: number): boolean =>
        tier === "exact" ||
        !endsInWhitespace ||
        o + needle.length === view.content.length ||
        view.content[o + needle.length] === "\n";
      const all = findOccurrences(view.content, needle, true).filter(atLineEnd);
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
        ? findOccurrences(view.content, needle, false).filter(atLineEnd)
        : all;
      const replacements = used.map((o) => ({
        matchIndex: o,
        matchLength: needle.length,
        newText: edit.new,
      }));
      matched.push({
        index: edit.index,
        tier,
        keepTrailingWhitespace: !endsInWhitespace,
        replacements,
      });
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
  // character; a fuzzy match is widened to whole lines, in which the
  // matched original text is replaced and the rest is kept.
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
    // Edits already refused as overlapping are left out: their ranges
    // cannot be spliced together.
    const inTier = matched.filter(
      (m) => m.tier === tier && !overlapping.has(m.index),
    );
    if (inTier.length === 0) continue;
    const view = viewFor(tier);
    if (view === null) continue;
    const tierRegions = lineRegionsPreservingUnchangedLines(
      content,
      view.content,
      inTier.flatMap((m) =>
        m.replacements.map((r) => ({
          ...r,
          editIndex: m.index,
          keepTrailingWhitespace: m.keepTrailingWhitespace,
        })),
      ),
    );
    // One at a time: spreading many thousand regions into push() would
    // exceed the call stack.
    for (const r of tierRegions) regions.push(r);
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

  // Fuzzy regions that would change text outside their matches.
  const sideEffects = new Map<number, LineRange>();
  const contentLines = getLineSpans(content);
  for (const r of regions) {
    if (r.sideEffect !== true) continue;
    const lines = {
      start: lineIndexAt(contentLines, r.start) + 1,
      end: lineIndexAt(contentLines, Math.max(r.start, r.end - 1)) + 1,
    };
    for (const i of r.edits) sideEffects.set(i, lines);
  }

  const finalResolutions = resolutions.map((r): EditResolution => {
    if (r.status !== "resolved") return r;
    const others = overlapping.get(r.index);
    if (others !== undefined) {
      return {
        index: r.index,
        status: "overlap",
        tier: r.tier,
        occurrences: r.occurrences,
        lineRanges: r.lineRanges,
        overlapsWith: [...others].sort((a, b) => a - b),
      };
    }
    const affected = sideEffects.get(r.index);
    if (affected !== undefined) {
      return {
        index: r.index,
        status: "fuzzy_side_effect",
        tier: r.tier,
        occurrences: r.occurrences,
        lineRanges: r.lineRanges,
        affectedLines: affected,
      };
    }
    return r;
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

/** The replacements a region set makes, finest first: a fuzzy region's
 * `parts`, any other region as a whole. */
export function regionReplacements(
  regions: readonly Region[],
): Array<{ start: number; end: number; text: string }> {
  return regions.flatMap(
    (r) => r.parts ?? [{ start: r.start, end: r.end, text: r.text }],
  );
}

/**
 * Apply LF-view regions to the raw text: untouched bytes (including the
 * line endings of untouched lines, in a mixed-ending file too, and the
 * kept text of a fuzzy region's lines) stay as they are, and every line
 * break the replacement text inserts uses `ending`.
 */
export function applyRegionsToRaw(
  raw: string,
  regions: readonly Region[],
  ending: "\r\n" | "\n",
): string {
  const toRaw = lfToRawMapper(raw);
  return applyReplacements(
    raw,
    regionReplacements(regions).map((r) => {
      const start = toRaw(r.start);
      return {
        matchIndex: start,
        matchLength: toRaw(r.end) - start,
        newText: ending === "\r\n" ? r.text.replace(/\n/g, "\r\n") : r.text,
      };
    }),
  );
}

/**
 * True when every replaced LF-view range and every kept range between
 * them maps onto raw text that reads as that same LF-view text (CRLF
 * read as LF), so the raw splice changes exactly what the LF view does.
 */
export function rawMappingAgrees(
  raw: string,
  lf: string,
  regions: readonly Region[],
): boolean {
  const toRaw = lfToRawMapper(raw);
  const agrees = (a: number, b: number): boolean =>
    crlfToLf(raw.slice(toRaw(a), toRaw(b))) === lf.slice(a, b);
  const sorted = regionReplacements(regions).sort((x, y) => x.start - y.start);
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) return false;
    if (!agrees(cursor, r.start) || !agrees(r.start, r.end)) return false;
    cursor = r.end;
  }
  return agrees(cursor, lf.length) && toRaw(lf.length) === raw.length;
}
