export interface LinkRef {
  /** The link target exactly as written, including any `#anchor`. */
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
    const target = match[1].trim();
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
