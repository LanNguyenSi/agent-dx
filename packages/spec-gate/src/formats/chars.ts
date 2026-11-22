/**
 * Which characters a text value may not contain.
 *
 * The rule is by Unicode general category, not by a list of code points, so
 * a character added to a category later is caught without a change here:
 * - `Cc` (control): C0 and C1 controls, DEL, line feed, carriage return,
 *   NEL. A tab is allowed unless `allowTab` is false.
 * - `Cf` (format): zero-width characters, direction marks, bidirectional
 *   embeddings, overrides and isolates, the byte order mark, word joiner,
 *   soft hyphen, Arabic letter mark, tag characters.
 * - `Zl` and `Zp` (line and paragraph separators).
 *
 * Such a character makes a text read differently from what a parser or a
 * reviewer sees. `Cn` (unassigned) is not part of the rule because its
 * contents depend on the runtime's Unicode version.
 */

export const FORBIDDEN_CATEGORIES = ["Cc", "Cf", "Zl", "Zp"] as const;

const WITH_TAB_RE = /[\p{Cf}\p{Zl}\p{Zp}]|[^\t\P{Cc}]/u;
const NO_TAB_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface ForbiddenCharacter {
  /** The code point. */
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
