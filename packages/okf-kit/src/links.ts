export interface LinkRef {
  /** The link destination after normalization, including any `#anchor`. */
  target: string;
  /** `target` with an optional trailing `#anchor` stripped. */
  pathPart: string;
}

const LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;

/**
 * Extracts markdown link targets from body text, restricted to the targets
 * the OKF checks care about: relative or bundle-root-relative `.md` links.
 * Fenced code blocks are stripped first so example markdown inside a code
 * fence is never mistaken for a real link. http(s):// and mailto: links and
 * any target not ending in `.md` (after stripping an optional `#anchor`)
 * are excluded.
 */
export function extractMarkdownLinks(body: string): LinkRef[] {
  const stripped = stripFencedCode(body);
  const refs: LinkRef[] = [];
  LINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_PATTERN.exec(stripped)) !== null) {
    const target = normalizeDestination(match[1]);
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    const pathPart = target.split("#")[0];
    if (!pathPart.endsWith(".md")) continue;
    refs.push({ target, pathPart });
  }
  return refs;
}

/**
 * Normalizes a raw CommonMark link destination capture (the text between the
 * link's parens) down to a bare path:
 *  - `<x.md>` form: unwrap the angle brackets (the destination can contain
 *    whitespace inside them; anything after the closing `>` is a title).
 *  - bare form: a link title, if present, is separated from the destination
 *    by whitespace and written as "t", 't', or (t); take the first
 *    whitespace-delimited token as the destination and drop the rest.
 *  - percent-decode the result (falling back to the raw string if it is not
 *    valid percent-encoding) so an encoded path compares equal to the real
 *    filename on disk.
 */
function normalizeDestination(raw: string): string {
  let dest = raw.trim();
  if (dest.startsWith("<")) {
    const closeIdx = dest.indexOf(">", 1);
    dest = closeIdx === -1 ? dest.slice(1) : dest.slice(1, closeIdx);
  } else {
    const spaceIdx = dest.search(/\s/);
    if (spaceIdx !== -1) dest = dest.slice(0, spaceIdx);
  }
  try {
    return decodeURIComponent(dest);
  } catch {
    return dest;
  }
}

function stripFencedCode(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fenceMarker: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !fenceMarker &&
      (trimmed.startsWith("```") || trimmed.startsWith("~~~"))
    ) {
      fenceMarker = trimmed.slice(0, 3);
      out.push("");
      continue;
    }
    if (fenceMarker) {
      if (trimmed.startsWith(fenceMarker)) {
        fenceMarker = undefined;
      }
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
