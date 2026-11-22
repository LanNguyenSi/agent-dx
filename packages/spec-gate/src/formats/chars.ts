/**
 * Which characters a text may not contain.
 *
 * The rule is by Unicode general category, not by a list of code points, so
 * a character added to a category later is caught without a change here:
 * - `Cc` (control): C0 and C1 controls, DEL, line feed, carriage return,
 *   NEL. A tab is allowed unless `allowTab` is false.
 * - `Cf` (format): zero-width characters, direction marks, bidirectional
 *   embeddings, overrides and isolates, the byte order mark, word joiner,
 *   soft hyphen, Arabic letter mark, tag characters.
 * - `Zl` and `Zp` (line and paragraph separators).
 * - `Cs` (surrogate): a surrogate code unit without its partner, which makes
 *   the string ill-formed. A well-formed pair is one code point of another
 *   category and passes. Two different lone surrogates encode to the same
 *   UTF-8 bytes, so they would be told apart in memory and not in a hash.
 *
 * Such a character makes a text read differently from what a parser or a
 * reviewer sees. `Cn` (unassigned) is not part of the rule because its
 * contents depend on the runtime's Unicode version. A character that renders
 * blank but belongs to another category (a space separator such as U+00A0 or
 * U+3000, a Hangul filler, a variation selector, a private-use character) is
 * not refused.
 */

export const FORBIDDEN_CATEGORIES = ["Cc", "Cf", "Zl", "Zp", "Cs"] as const;

/** How an error message names what was found. */
export const FORBIDDEN_WHAT =
  "a control, format or separator character or a lone surrogate";

const WITH_TAB_RE = /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|[^\t\P{Cc}]/u;
const NO_TAB_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

export interface ForbiddenCharacter {
  /** The code point; for a lone surrogate, its code unit. */
  codePoint: number;
  /** Index of its first code unit in the text. */
  index: number;
  /** Written as `U+00AD`. */
  label: string;
}

/** The first forbidden character in a text, or null. */
export function findForbiddenCharacter(
  text: string,
  options: { allowTab?: boolean } = {},
): ForbiddenCharacter | null {
  const re = options.allowTab === false ? NO_TAB_RE : WITH_TAB_RE;
  const m = re.exec(text);
  if (!m) return null;
  const codePoint = m[0].codePointAt(0)!;
  return {
    codePoint,
    index: m.index,
    label: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
  };
}

export interface ForbiddenLine extends ForbiddenCharacter {
  /** 1-based line that holds the character. */
  line: number;
}

/**
 * Checks a whole text line by line and returns the first forbidden
 * character of every line that has one. A line ends at a line feed, with or
 * without a carriage return before it; those are the only line ends, and
 * they are not part of a line. Every other character is checked, so a
 * carriage return anywhere else, a line separator or a byte order mark in
 * the middle of the text is found. A tab is allowed.
 *
 * This is the check for text that is read in lines (`spec.md`, a YAML
 * file): it sees comments and anything else a decoder drops.
 */
export function findForbiddenLines(text: string): ForbiddenLine[] {
  return scanForbiddenLines(text, Infinity).found;
}

/**
 * As `findForbiddenLines`, but keeps only the first `keep` lines and counts
 * them all, so a text with a forbidden character on every line does not
 * turn into a list of that length.
 */
export function scanForbiddenLines(
  text: string,
  keep: number,
): { found: ForbiddenLine[]; total: number } {
  const found: ForbiddenLine[] = [];
  let total = 0;
  const lines = text.split("\n");
  for (const [i, raw] of lines.entries()) {
    // Only a carriage return that a line feed follows is part of a line end.
    const crlf = i < lines.length - 1 && raw.endsWith("\r");
    const bad = findForbiddenCharacter(crlf ? raw.slice(0, -1) : raw);
    if (!bad) continue;
    total += 1;
    if (found.length < keep) found.push({ ...bad, line: i + 1 });
  }
  return { found, total };
}
