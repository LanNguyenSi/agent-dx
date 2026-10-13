import {
  normalizeForFuzzyMatch,
  normalizeForTier,
  type LineRange,
  type MatchTier,
} from "./engine.js";

/** One line of a candidate that differs from the old text, both sides
 * rendered with `visualizeWhitespace`. */
export interface HintLineDifference {
  /** 1-based line in the file. */
  line: number;
  expected: string;
  actual: string;
}

export interface HintCandidate {
  /** 1-based first and last line of the candidate in the file. */
  line_start: number;
  line_end: number;
  /** Mean per-line similarity from 0 to 1, two decimals. */
  similarity: number;
  /** True when every differing line differs only in whitespace. */
  whitespace_only: boolean;
  differences: HintLineDifference[];
  /** Differing lines left out of `differences`. */
  more_differences: number;
}

export interface NotFoundHint {
  message: string;
  candidates: HintCandidate[];
  /** 1-based line where the new text already occurs, when it does. */
  new_text_at_line?: number;
}

const MAX_CANDIDATES = 3;
const MAX_DIFFERENCES = 6;
const MIN_SIMILARITY = 0.5;
/** Lines of the old text that take part in scoring a window. */
const MAX_WINDOW_LINES = 40;
/** Visualised line length kept in a difference. */
const MAX_VISUAL_CHARS = 160;

/**
 * Makes whitespace visible: a space as `·`, a tab as `→`, and any other
 * whitespace, zero-width or format character as `⟨U+XXXX⟩`, so two lines
 * that look alike in plain text show where they differ.
 */
export function visualizeWhitespace(line: string): string {
  let out = "";
  for (const ch of line) {
    if (ch === " ") out += "·";
    else if (ch === "\t") out += "→";
    else if (/[\s\u200B-\u200D\u2060\uFEFF]/u.test(ch) || /\p{Cf}/u.test(ch)) {
      out += `⟨U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
    } else out += ch;
  }
  return out.length > MAX_VISUAL_CHARS
    ? `${out.slice(0, MAX_VISUAL_CHARS)}…`
    : out;
}

function comparable(line: string): string {
  return normalizeForFuzzyMatch(line).trim().replace(/\s+/g, " ");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams of the whitespace-collapsed,
 * normalized lines: 1 when the lines differ only in whitespace or
 * typographic punctuation. */
export function lineSimilarity(a: string, b: string): number {
  const x = comparable(a);
  const y = comparable(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  for (const [g, n] of bx) shared += Math.min(n, by.get(g) ?? 0);
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

function splitOld(old: string): string[] {
  const lines = old.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The hint for an edit whose old text no tier found: the closest windows
 * of the file (anchored on the old text's first non-blank line, scored
 * over the whole window), with the differing lines shown with visible
 * whitespace, and whether the new text is already in the file.
 */
export function notFoundHint(
  content: string,
  old: string,
  newText: string,
): NotFoundHint {
  const fileLines = content.split("\n");
  if (fileLines.length > 1 && fileLines[fileLines.length - 1] === "") {
    fileLines.pop();
  }
  const oldLines = splitOld(old);
  const anchor = Math.max(
    0,
    oldLines.findIndex((l) => l.trim().length > 0),
  );
  const window = Math.min(oldLines.length, MAX_WINDOW_LINES);

  // Anchor pass: best few file lines for the anchor line.
  const anchorScores: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < fileLines.length; i++) {
    const s = lineSimilarity(oldLines[anchor] ?? "", fileLines[i]);
    if (s >= MIN_SIMILARITY) anchorScores.push({ i, s });
  }
  anchorScores.sort((a, b) => b.s - a.s || a.i - b.i);

  const seen = new Set<number>();
  const scored: Array<{ start: number; score: number }> = [];
  for (const { i } of anchorScores.slice(0, MAX_CANDIDATES * 4)) {
    const start = i - anchor;
    if (start < 0 || seen.has(start)) continue;
    seen.add(start);
    let total = 0;
    let n = 0;
    for (let j = 0; j < window; j++) {
      const fl = fileLines[start + j];
      total += fl === undefined ? 0 : lineSimilarity(oldLines[j], fl);
      n += 1;
    }
    const score = n === 0 ? 0 : total / n;
    if (score >= MIN_SIMILARITY) scored.push({ start, score });
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);

  const candidates: HintCandidate[] = scored
    .slice(0, MAX_CANDIDATES)
    .map(({ start, score }) => {
      const differences: HintLineDifference[] = [];
      let differing = 0;
      let whitespaceOnly = true;
      for (let j = 0; j < oldLines.length; j++) {
        const actual = fileLines[start + j];
        if (actual === oldLines[j]) continue;
        differing += 1;
        if (
          actual === undefined ||
          actual.replace(/\s+/g, "") !== oldLines[j].replace(/\s+/g, "")
        ) {
          whitespaceOnly = false;
        }
        if (differences.length < MAX_DIFFERENCES) {
          differences.push({
            line: start + j + 1,
            expected: visualizeWhitespace(oldLines[j]),
            actual:
              actual === undefined
                ? "(end of file)"
                : visualizeWhitespace(actual),
          });
        }
      }
      return {
        line_start: start + 1,
        line_end: Math.min(start + oldLines.length, fileLines.length),
        similarity: Math.round(score * 100) / 100,
        whitespace_only: whitespaceOnly && differing > 0,
        differences,
        more_differences: differing - differences.length,
      };
    });

  let newTextAtLine: number | undefined;
  if (newText.length > 0) {
    const at = content.indexOf(newText);
    if (at !== -1) {
      newTextAtLine = content.slice(0, at).split("\n").length;
    }
  }

  const parts: string[] = [];
  if (candidates.length > 0) {
    const best = candidates[0];
    parts.push(
      `closest candidate: lines ${String(best.line_start)}-${String(best.line_end)} (similarity ${best.similarity.toFixed(2)})${best.whitespace_only ? ", differing in whitespace only" : ""}`,
    );
  } else {
    parts.push("no similar lines found");
  }
  if (newTextAtLine !== undefined) {
    parts.push(
      `the new text is already in the file at line ${String(newTextAtLine)} (edit applied already?)`,
    );
  }
  return {
    message: `old text not found; ${parts.join("; ")}`,
    candidates,
    ...(newTextAtLine !== undefined ? { new_text_at_line: newTextAtLine } : {}),
  };
}

/** One line a refused fuzzy match touches, as it is and as the tier's
 * normalisation reads it, both rendered with `visualizeWhitespace`. */
export interface SideEffectLine {
  line: number;
  original: string;
  normalized: string;
}

export interface FuzzySideEffectHint {
  message: string;
  /** The touched lines the normalisation changes. */
  lines: SideEffectLine[];
  /** Each distinct character the normalisation changes on those lines,
   * as `<char> (U+XXXX) -> <replacement>`, plus `trailing whitespace`. */
  changed_characters: string[];
  /** The text of the file the old text matched, when it lies on one line
   * and is found exactly once there: use it as `old` for an exact match. */
  exact_text?: string;
}

/** Longest line searched for `exact_text`, and the longest candidate
 * relative to the old text. */
const MAX_EXACT_SEARCH_LINE = 1000;

function codePoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Every text on `line` that normalizes to `needle` under `tier`,
 * leaving out candidates that start or end in whitespace. */
function exactTextOnLine(
  line: string,
  needle: string,
  tier: MatchTier,
): string[] {
  const found = new Set<string>();
  if (line.length > MAX_EXACT_SEARCH_LINE) return [];
  const maxLen = needle.length * 2 + 8;
  for (let a = 0; a < line.length; a++) {
    if (/\s/u.test(line[a])) continue;
    for (let b = a + 1; b <= Math.min(line.length, a + maxLen); b++) {
      const sub = line.slice(a, b);
      if (sub !== sub.trimEnd()) continue;
      if (normalizeForTier(sub, tier) === needle) found.add(sub);
    }
  }
  return [...found];
}

/**
 * The hint for a fuzzy-tier match refused because rewriting its lines
 * would change text outside the matched text: the touched lines as they
 * are and as normalized, the characters the normalisation changes, and,
 * when it can be found, the exact text to use as `old` instead.
 */
export function fuzzySideEffectHint(
  content: string,
  affected: LineRange,
  tier: MatchTier,
  old: string,
): FuzzySideEffectHint {
  const fileLines = content.split("\n");
  const lines: SideEffectLine[] = [];
  const changed = new Set<string>();
  for (let n = affected.start; n <= affected.end; n++) {
    const original = fileLines[n - 1] ?? "";
    const normalized = normalizeForTier(original, tier);
    if (normalized === original) continue;
    lines.push({
      line: n,
      original: visualizeWhitespace(original),
      normalized: visualizeWhitespace(normalized),
    });
    const core = original.trimEnd();
    if (core !== original) changed.add("trailing whitespace");
    for (const ch of core) {
      const to = normalizeForTier(ch, tier);
      if (to !== ch) changed.add(`${ch} (${codePoint(ch)}) -> ${to}`);
    }
  }
  const needle = normalizeForTier(old, tier);
  let exactText: string | undefined;
  if (!needle.includes("\n")) {
    const hits = new Set<string>();
    for (let n = affected.start; n <= affected.end; n++) {
      for (const h of exactTextOnLine(fileLines[n - 1] ?? "", needle, tier)) {
        hits.add(h);
      }
    }
    if (hits.size === 1) exactText = [...hits][0];
  }
  const where =
    affected.start === affected.end
      ? `line ${String(affected.start)}`
      : `lines ${String(affected.start)}-${String(affected.end)}`;
  const chars = [...changed];
  return {
    message: `the ${tier} tier matched, but rewriting ${where} would also change text outside the match (${chars.length > 0 ? chars.join(", ") : "normalized text"}); nothing was written. Use the exact text from the file as old${exactText !== undefined ? `: ${JSON.stringify(exactText)}` : ""}`,
    lines,
    changed_characters: chars,
    ...(exactText !== undefined ? { exact_text: exactText } : {}),
  };
}
