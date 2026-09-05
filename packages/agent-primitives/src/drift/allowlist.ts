export interface Heading {
  /** 1-indexed line the heading itself sits on. */
  line: number;
  level: number;
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Every Markdown heading in `content`, in file order. */
export function parseHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
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
 * `undefined` when none matches. */
export function historicalPhraseMatch(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const phrase of HISTORICAL_PHRASES) {
    if (lower.includes(phrase)) return phrase;
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
