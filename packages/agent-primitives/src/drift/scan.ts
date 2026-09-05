/** Extensions whose every line counts as documentation: a doc file has
 * no "code" lines to exclude. */
export const DOC_EXTENSIONS = new Set(["md", "mdx", "txt"]);

/** Source extensions scanned for `//`, `/* ... *\/` and `*`-continuation
 * comment lines. */
const SLASH_STAR_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

/** Source extensions scanned for `#` comment lines. */
const HASH_COMMENT_EXTENSIONS = new Set(["py", "sh", "yml", "yaml"]);

/** `git grep` pathspecs this command searches: docs, plus the source
 * extensions above. Anything outside this list is a known, documented
 * prototype limitation, never scanned at all. */
export const SCAN_PATHSPECS: readonly string[] = [
  "*.md",
  "*.mdx",
  "*.txt",
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.py",
  "*.sh",
  "*.yml",
  "*.yaml",
];

function extOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Classifies one matched line as `"doc"` (a whole documentation file),
 * `"comment"` (a comment line in a source file this command recognizes),
 * or `undefined` (a code line, or a file extension out of scope) - a
 * code line is never reported, whatever it mentions.
 */
export function classifyLine(
  filePath: string,
  text: string,
): "doc" | "comment" | undefined {
  const ext = extOf(filePath);
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  const trimmed = text.trimStart();
  if (SLASH_STAR_EXTENSIONS.has(ext)) {
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*")
    ) {
      return "comment";
    }
    return undefined;
  }
  if (HASH_COMMENT_EXTENSIONS.has(ext)) {
    return trimmed.startsWith("#") ? "comment" : undefined;
  }
  return undefined;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

const GREP_LINE_RE = /^(.+?):(\d+):(.*)$/;

/**
 * Parses `git grep -n -w -F -e <name> <rev> -- ...` output. Git prefixes
 * every matched line with the literal rev string passed on the command
 * line (`<rev>:<path>:<line>:<text>`); `rev` is stripped here so callers
 * never have to know about it. A line git could not attribute to a path
 * and line number (its own "Binary file X matches" notice for a file
 * `git grep` treats as binary) does not match `GREP_LINE_RE` and is
 * silently skipped, which is the correct outcome for it: this command
 * never reports a binary file.
 */
export function parseGrepOutput(output: string, rev: string): GrepMatch[] {
  const prefix = `${rev}:`;
  const matches: GrepMatch[] = [];
  for (const raw of output.split("\n")) {
    if (raw.length === 0) continue;
    const line = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const m = GREP_LINE_RE.exec(line);
    if (!m) continue;
    matches.push({ path: m[1], line: Number(m[2]), text: m[3] });
  }
  return matches;
}
