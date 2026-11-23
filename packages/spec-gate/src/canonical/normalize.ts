/**
 * Normalisation rules shared by every section of the digest input.
 *
 * `normalizeText` applies to prose fields only; `PLAN_FIELD_CLASSES` and
 * the spec builder in `digest.ts` decide which fields those are.
 */

/**
 * Whitespace rule: every run of ASCII whitespace (space, tab, line feed,
 * carriage return, form feed, vertical tab) becomes one space, and a space
 * at either end is removed. Other Unicode space characters are kept as
 * they are inside a text, so a change to one of them changes the digest.
 * At the ends of a spec item text or an attribute value the spec parser has
 * already trimmed every Unicode whitespace character, so there the rule is
 * wider than this function; a test-plan string reaches this function as
 * the YAML parser returns it.
 */
export function normalizeText(text: string): string {
  return text.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ | $/g, "");
}

const ID_RE = /^([A-Z]+)-([0-9]+)$/;

/**
 * ID order: the prefix compared by UTF-16 code units, then the number
 * compared as an integer, so `AC-2` sorts before `AC-10`. An ID without a
 * number (`GOAL`) sorts by its text alone, after the numbered IDs of a
 * lower prefix and before those of a higher one; against a numbered ID of
 * the same prefix (`GOAL` and `GOAL-1`) it sorts first.
 */
export function compareIds(a: string, b: string): number {
  const ma = ID_RE.exec(a);
  const mb = ID_RE.exec(b);
  const pa = ma ? ma[1]! : a;
  const pb = mb ? mb[1]! : b;
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (!ma || !mb) return ma ? 1 : mb ? -1 : 0;
  return Number(ma[2]) - Number(mb[2]);
}

/** A copy of `items` sorted by `compareIds` of their `id`. */
export function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => compareIds(x.id, y.id));
}

/** Plain code-unit order, for lists of paths. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
