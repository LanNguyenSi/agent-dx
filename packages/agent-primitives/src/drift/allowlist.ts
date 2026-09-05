export interface Heading {
  /** 1-indexed line the heading itself sits on. */
  line: number;
  level: number;
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** A fenced code block delimiter: three or more backticks or tildes,
 * opening or closing a fenced region, so a `#`-prefixed line INSIDE the
 * fence (a shell comment, a Python comment, ...) is never misread as a
 * Markdown heading. */
const FENCE_RE = /^(`{3,}|~{3,})/;

/** Every Markdown heading in `content`, in file order. Lines inside a
 * fenced code block (delimited by matching ``` or ~~~ fences) are never
 * scanned for a heading: a `#` there is code or a shell comment, not
 * document structure. */
export function parseHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m)
      headings.push({ line: i + 1, level: m[1].length, text: m[2].trim() });
  }
  return headings;
}

/** The nearest heading at or before `atLine`, optionally restricted to a
 * maximum level (e.g. 2, so a level-3 subheading never overrides which
 * level-1/2 section a site is read as belonging to). `headings` must
 * already be in file order (as `parseHeadings` returns it). */
export function nearestHeading(
  headings: readonly Heading[],
  atLine: number,
  maxLevel?: number,
): Heading | undefined {
  let best: Heading | undefined;
  for (const heading of headings) {
    if (heading.line > atLine) break;
    if (maxLevel !== undefined && heading.level > maxLevel) continue;
    best = heading;
  }
  return best;
}

/**
 * Small, documented word list that marks a mention as historical rather
 * than a claim that the identifier is current. Matched case-insensitively
 * against the whole line's text (not just "near" the identifier): a
 * prototype-scope simplification, noted in the README.
 */
export const HISTORICAL_PHRASES: readonly string[] = [
  "former",
  "formerly",
  "used to",
  "no longer",
  "removed",
  "renamed",
  "replaced",
  "dropped",
  "deleted",
  "previously",
  "was ",
];

/** The first historical phrase found in `text` (case-insensitive), or
 * `undefined` when none matches. A whole-string primitive: callers that
 * need to bound the check to a span near a specific occurrence use
 * `historicalPhraseNearIdentifier` below instead. */
export function historicalPhraseMatch(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const phrase of HISTORICAL_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return undefined;
}

/** How far back (in characters) the historical-phrase window looks from
 * the start of an identifier occurrence, before any closer sentence
 * boundary cuts it short. Pinned against the real triologue f6c0f244
 * CHANGELOG.md:15 case: an unrelated "no longer" (about a different
 * identifier) sits well outside this range, but an unrelated "was "
 * (from "...when it was set:...", also about that other identifier)
 * sits only 69 characters back - a window has to stay under that to
 * exclude it too, not just the more obviously distant phrase. */
const WINDOW_BEFORE_CHARS = 60;

/** How far past the end of an identifier occurrence the historical-phrase
 * window still looks. */
const WINDOW_AFTER_CHARS = 20;

/** Escapes every regex-special character in `s` (a plain literal match,
 * unlike `globToRegExp` below which interprets glob metacharacters). */
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The 0-indexed start offsets of every whole-word occurrence of
 * `identifier` in `text`, in order. */
function wholeWordOccurrences(text: string, identifier: string): number[] {
  if (identifier.length === 0) return [];
  const re = new RegExp(`\\b${escapeRegExpLiteral(identifier)}\\b`, "g");
  const offsets: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    offsets.push(m.index);
  }
  return offsets;
}

/**
 * The first historical phrase found within a bounded span around any
 * whole-word occurrence of `identifier` in `text`, or `undefined` when
 * none matches. Unlike `historicalPhraseMatch`, this does not scan the
 * whole line: a long line can carry an unrelated historical phrase (about
 * a different identifier entirely) far from where `identifier` itself is
 * mentioned, and that must not suppress a present-tense mention of
 * `identifier`. Each occurrence's span covers up to `WINDOW_BEFORE_CHARS`
 * characters before it - cut short at the nearest preceding sentence
 * boundary (`". "` or `"; "`) when one falls within that range, so the
 * window never reaches back across an unrelated sentence - plus up to
 * `WINDOW_AFTER_CHARS` characters after it. When `identifier` does not
 * actually occur in `text` (a caller mistake; every real caller only
 * calls this for a line `git grep` matched on `identifier`), falls back
 * to the whole-line check rather than reporting nothing.
 */
export function historicalPhraseNearIdentifier(
  text: string,
  identifier: string,
): string | undefined {
  const occurrences = wholeWordOccurrences(text, identifier);
  if (occurrences.length === 0) return historicalPhraseMatch(text);
  for (const start of occurrences) {
    const before = text.slice(0, start);
    const windowFloor = Math.max(0, start - WINDOW_BEFORE_CHARS);
    const lookback = before.slice(windowFloor);
    const boundary = Math.max(
      lookback.lastIndexOf(". "),
      lookback.lastIndexOf("; "),
    );
    const spanStart = boundary >= 0 ? windowFloor + boundary + 2 : windowFloor;
    const spanEnd = Math.min(
      text.length,
      start + identifier.length + WINDOW_AFTER_CHARS,
    );
    const phrase = historicalPhraseMatch(text.slice(spanStart, spanEnd));
    if (phrase !== undefined) return phrase;
  }
  return undefined;
}

/** Escapes every regex-special character in `s` except the glob
 * metacharacters this module handles itself (`*`, `?`). */
function escapeRegExpChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * A small, dependency-free glob-to-RegExp translator for `--allow`:
 * `**` matches across path segments (including none), a single `*`
 * matches within one segment, `?` matches one character. No brace
 * expansion, no character classes - a prototype-scope subset, documented
 * in the README, sufficient for a path or path-prefix allowlist entry.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (c === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExpChar(c);
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** The first glob in `globs` matching `filePath`, or `undefined`. */
export function matchesAnyGlob(
  filePath: string,
  globs: readonly string[],
): string | undefined {
  for (const glob of globs) {
    if (globToRegExp(glob).test(filePath)) return glob;
  }
  return undefined;
}
