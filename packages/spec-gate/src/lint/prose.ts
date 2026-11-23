/**
 * The word list of the `prose` rule: data, not control flow. A normative
 * line states what is checked; the words here leave the bar to a later
 * reading, in English or in German. The list is fixed: adding a word
 * changes the rule and every spec it flags.
 *
 * Matching is whole-word and case-insensitive. A word hits only between
 * non-word neighbours (or the ends of the text), so `fast` never hits
 * `fastest` and `ggf` never hits `ggfx`. Entries with a space are
 * phrases and match the space between their words literally.
 */

/** The words and phrases, lower case, as they are reported. */
export const PROSE_WORDS: readonly string[] = [
  // English
  "should",
  "may",
  "might",
  "could",
  "appropriate",
  "reasonable",
  "fast",
  "quickly",
  "user-friendly",
  "easy",
  "robust",
  "as needed",
  "if possible",
  "etc",
  // German
  "sollte",
  "sollten",
  "koennte",
  "könnte",
  "eventuell",
  "ggf",
  "moeglichst",
  "möglichst",
  "schnell",
  "benutzerfreundlich",
  "einfach",
  "angemessen",
  "bei Bedarf",
  "usw",
];

function literal(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One whole-word matcher per list entry, in the same order. */
const PROSE_MATCHERS = PROSE_WORDS.map(
  (word) =>
    new RegExp(`(?<![\\p{L}\\p{N}_])${literal(word)}(?![\\p{L}\\p{N}_])`, "iu"),
);

/**
 * The listed words `text` contains, each once, in list order. The finding
 * names the word, so the caller reports one per entry of this list.
 */
export function findProseWords(text: string): string[] {
  const hit: string[] = [];
  PROSE_WORDS.forEach((word, i) => {
    if (PROSE_MATCHERS[i]!.test(text)) hit.push(word);
  });
  return hit;
}
