export type RemovedIdentifierKind = "declaration" | "config_key" | "file";

export interface RemovedIdentifier {
  name: string;
  kind: RemovedIdentifierKind;
  file: string;
  line: number;
}

export interface ParsedDiff {
  /** Identifiers whose declaration was removed and not also declared on
   * an added line anywhere in the diff (see the "moved" rule below). */
  removed: RemovedIdentifier[];
  /** Names named in this diff's own report, purely for an operator's
   * audit: an identifier declared on both a removed and an added line is
   * treated as MOVED, never reported as removed. This is a name-only
   * rule (not per-file, not per-line): the identifier just has to
   * reappear as a declaration somewhere in the same diff. */
  movedNames: string[];
}

/**
 * TS/JS top-level or exported declaration: `export? default? declare?
 * (type|interface|class|function|const|let|var|enum) Name`. Prototype
 * scope, documented in the package README: a regex over one diff line,
 * not a parser, so it can be fooled by an unusual line break or a
 * declaration split across lines; it never looks past the identifier
 * name (no attempt to resolve its export path, re-export, or a name
 * bound to it by destructuring).
 */
const DECL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:type|interface|class|function|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/;

/** A JSON object's top-level key: `"name":` indented by at most two
 * spaces. Cheap and documented as such: it has no notion of nesting
 * depth beyond "how far the line is indented", so a deeply-indented but
 * still top-level key in an unusually formatted file is missed, and a
 * two-space-indented key one level deep in a densely packed file is
 * over-counted. Good enough for a well-formatted `package.json`-shaped
 * file, which is the only case this prototype targets. */
const JSON_TOP_KEY_RE = /^ {0,2}"([A-Za-z0-9_.$-]+)"\s*:/;

/** A YAML top-level key: no leading whitespace, not a list item and not
 * a comment. Same cheapness caveat as the JSON regex above: nesting is
 * inferred purely from "no leading whitespace", so a flow-style mapping
 * or a key on the same line as its parent is missed. */
const YAML_TOP_KEY_RE = /^([A-Za-z0-9_.-]+):(?:\s|$)/;

const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

function extOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function basenameNoExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Extracts the one declared/keyed identifier a diff line names, per the
 * file it belongs to: a TS/JS declaration for a source extension, a
 * top-level config key for `.json`/`.yml`/`.yaml`. Every other extension
 * (Markdown, plain text, ...) never contributes a removed identifier -
 * only a declaration's own file can remove one. */
function extractIdentifier(
  line: string,
  filePath: string,
): { name: string; kind: RemovedIdentifierKind } | undefined {
  const ext = extOf(filePath);
  if (SOURCE_EXTENSIONS.has(ext)) {
    const m = DECL_RE.exec(line);
    return m ? { name: m[1], kind: "declaration" } : undefined;
  }
  if (ext === "json") {
    const m = JSON_TOP_KEY_RE.exec(line);
    return m ? { name: m[1], kind: "config_key" } : undefined;
  }
  if (ext === "yml" || ext === "yaml") {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("-") || trimmed.startsWith("#")) return undefined;
    const m = YAML_TOP_KEY_RE.exec(line);
    return m ? { name: m[1], kind: "config_key" } : undefined;
  }
  return undefined;
}

/** "a/foo.ts" / "b/foo.ts" -> "foo.ts"; "/dev/null" is returned as-is so
 * the caller can recognize the no-file-on-this-side case. */
function stripAbPrefix(rawPath: string): string {
  if (rawPath === "/dev/null") return rawPath;
  return rawPath.replace(/^[ab]\//, "");
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses the output of `git diff --no-color -U0 base..head` (see
 * `git.ts`'s `diffText`) into the identifiers whose declaration this
 * range removed.
 *
 * With `-U0` every line in a hunk is either removed or added, never
 * carried context, and every hunk lists its removed lines (in the old
 * file's line order) before its added lines (in the new file's line
 * order) - the ordinary shape of a unified diff hunk. Line numbers are
 * derived from the hunk header plus a per-hunk counter, never from a
 * second pass over the file: correct as long as that ordering holds,
 * which this prototype does not re-verify beyond what git itself
 * produces.
 *
 * A whole deleted file contributes its basename (without extension) as a
 * removed identifier of kind `"file"`, UNLESS a file of the same basename
 * (again without extension, whatever its own extension) was newly added
 * anywhere in the same diff - that is a rename this diff's `git diff`
 * did not detect as one (different content), not a removal, and is
 * therefore also treated as moved.
 *
 * The "moved" rule for declarations/config keys is name-only: an
 * identifier declared on both a removed and an added line anywhere in
 * the diff (any file, any line) is excluded from `removed` and listed in
 * `movedNames` instead, on the reading that the same name reappearing as
 * a declaration means it moved rather than disappeared. This can both
 * over- and under-forgive: an identifier removed from one file and
 * coincidentally declared fresh, unrelated, in another counts as moved
 * too; documented as a known limitation, not fixed here.
 */
export function parseRemovedIdentifiers(diff: string): ParsedDiff {
  const lines = diff.split("\n");

  const removedCandidates: RemovedIdentifier[] = [];
  const addedNames = new Set<string>();
  const addedFileBasenames = new Set<string>();
  const deletedFiles: { path: string }[] = [];

  let oldPath: string | undefined;
  let newPath: string | undefined;
  let deletedFile = false;
  let newFile = false;
  let oldLine = 0;
  let newLine = 0;

  const flushBlock = (): void => {
    if (deletedFile && oldPath !== undefined) {
      deletedFiles.push({ path: oldPath });
    }
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      flushBlock();
      oldPath = undefined;
      newPath = undefined;
      deletedFile = false;
      newFile = false;
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      deletedFile = true;
      continue;
    }
    if (raw.startsWith("new file mode")) {
      newFile = true;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const p = stripAbPrefix(raw.slice(4));
      oldPath = p === "/dev/null" ? undefined : p;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = stripAbPrefix(raw.slice(4));
      newPath = p === "/dev/null" ? undefined : p;
      if (newFile && newPath !== undefined) {
        addedFileBasenames.add(basenameNoExt(newPath));
      }
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    if (raw.startsWith("-") && !raw.startsWith("--- ")) {
      const content = raw.slice(1);
      const filePath = oldPath ?? newPath;
      if (filePath !== undefined) {
        const found = extractIdentifier(content, filePath);
        if (found) {
          removedCandidates.push({
            name: found.name,
            kind: found.kind,
            file: filePath,
            line: oldLine,
          });
        }
      }
      oldLine++;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++ ")) {
      const content = raw.slice(1);
      const filePath = newPath ?? oldPath;
      if (filePath !== undefined) {
        const found = extractIdentifier(content, filePath);
        if (found) addedNames.add(found.name);
      }
      newLine++;
      continue;
    }
  }
  flushBlock();

  for (const { path } of deletedFiles) {
    const base = basenameNoExt(path);
    if (!addedFileBasenames.has(base)) {
      removedCandidates.push({ name: base, kind: "file", file: path, line: 1 });
    }
  }

  const removed: RemovedIdentifier[] = [];
  const movedNames: string[] = [];
  const seenMoved = new Set<string>();
  const seenRemoved = new Set<string>();
  for (const candidate of removedCandidates) {
    const dedupeKey = `${candidate.kind}:${candidate.name}:${candidate.file}:${candidate.line}`;
    if (seenRemoved.has(dedupeKey)) continue;
    seenRemoved.add(dedupeKey);
    if (candidate.kind !== "file" && addedNames.has(candidate.name)) {
      if (!seenMoved.has(candidate.name)) {
        seenMoved.add(candidate.name);
        movedNames.push(candidate.name);
      }
      continue;
    }
    removed.push(candidate);
  }

  return { removed, movedNames };
}
