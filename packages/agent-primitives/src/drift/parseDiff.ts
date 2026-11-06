import {
  classifyLine,
  DOC_EXTENSIONS,
  PHP_EXTENSIONS,
  SCAN_PATHSPECS,
} from "./scan.js";

export type RemovedIdentifierKind = "declaration" | "config_key" | "file";

export interface RemovedIdentifier {
  name: string;
  kind: RemovedIdentifierKind;
  file: string;
  line: number;
  /**
   * The removed line carried an `export` keyword (after any indentation).
   * `false` for a config key, whose file format has no such keyword, and
   * for a kind `"file"` candidate (a deleted file's basename), which has no
   * declaration line to read it from.
   */
  exported: boolean;
  /**
   * The removed line was indented (leading whitespace). In a source file a
   * top-level declaration sits at column 0, so an indented one is bound
   * inside an enclosing scope: a function body, a method, a block. Read
   * literally for a config key too, where indentation is nesting rather
   * than scope (a top-level JSON key is indented), and `false` for a kind
   * `"file"` candidate, which has no line to measure.
   */
  indented: boolean;
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
  /** One entry per wholly deleted file whose basename was NOT emitted as
   * a removed identifier of kind `"file"`, because its extension is not a
   * recognized source extension, or its basename does not look like an
   * identifier (see `looksLikeIdentifier`). Reported so a caller can
   * explain, rather than silently drop, why an obviously-deleted file
   * contributed nothing. */
  skippedFileBasenames: { path: string; basename: string }[];
  /** One entry per distinct PHP declaration name the extractor read off a
   * removed line but did NOT emit, because the name does not clear
   * `looksLikeIdentifier` (the bar a deleted file's basename already
   * faces): a framework method name (`up`, `down`, `index`, `show`,
   * `handle`) is an ordinary prose word, and scanning it word by word
   * across every doc is noise, not a finding. A name the diff ALSO
   * declares on an added line is dropped from here (the removal was a
   * signature edit or a move, not a removal, so there is no blind spot to
   * warn about). Ordered by first occurrence for a deterministic envelope;
   * `drift()` warns once per name. */
  skippedPhpNames: string[];
  /** One entry per extension this command SCANS for sites (`SCAN_PATHSPECS`)
   * and does NOT have a declaration extractor for (see
   * `DECLARATION_EXTRACTOR_EXTENSIONS`): the diff removed lines from at
   * least one file of that extension, so a declaration may well have been
   * removed there and nothing was collected from it. Ordered by extension
   * for a deterministic envelope. Docs (`.md`/`.mdx`/`.txt`) are excluded:
   * they are scanned for sites but never declare anything, so their having
   * no extractor is not a gap. */
  extractorGaps: { ext: string; files: number }[];
}

/**
 * TS/JS top-level or exported declaration: `export? default? declare?
 * abstract? async? (type|interface|class|function[*]|const|let|var|enum)
 * Name`. Prototype scope, documented in docs/drift.md: a regex over
 * one diff line, not a parser, so it can be fooled by an unusual line
 * break or a declaration split across lines; it never looks past the
 * identifier name (no attempt to resolve its export path, re-export, or a
 * name bound to it by destructuring). `abstract` and `async` are accepted
 * ahead of any keyword (not only their usual `class`/`function` pairing)
 * since this is a permissive line-shape match, not a grammar check.
 *
 * Two facts about the line's shape are captured, not just the name: the
 * indentation (empty for a top-level declaration) and the `export`
 * keyword. They are what `drift()`'s local-binding rule keys off, and they
 * are reported on every declaration candidate (see `RemovedIdentifier`).
 */
const DECL_RE =
  /^(?<indent>\s*)(?<exported>export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:type|interface|class|function\*?|enum|const|let|var)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\b/;

/**
 * PHP declaration: `(public|protected|private|static|abstract|final|readonly)*
 * (function|const|class|interface|trait|enum) [&]Name`, at any indentation
 * (a method is the common case, so unlike the TS/JS regex column 0 is not
 * required). `exported` is read from the modifier prefix: a `private` or
 * `protected` visibility is a member hidden inside the class, every other
 * shape (top-level, public, or visibility left unspecified, which is PHP's
 * public) is open. The keyword list is matched case-insensitively (PHP
 * keywords are: `Function`, `CLASS`, `Readonly` are all legal spellings);
 * the captured name keeps the line's case. The regex is anchored, which
 * is what keeps the two anonymous shapes out of it: a closure (`function
 * (` with no name) never matches because a name is required, and `new
 * class extends Foo` never matches because the line starts with `new`,
 * which is neither a modifier nor a declaration keyword - an inline
 * anonymous class is a use, not a declaration. Like the TS/JS regex this
 * is one line of a diff, not a parser: a declaration split across lines
 * is missed, and so is one behind a leading `#[...]` attribute on the
 * same line. The same anchor is why a `function foo` inside a string
 * literal on an otherwise code line is NOT matched (the line starts with
 * code, not with the keyword or a modifier); the real false positive is a
 * heredoc/nowdoc or multi-line string whose body line itself starts with
 * a declaration shape. A comment line is skipped before matching (see
 * `classifyLine`), never by this regex's shape. The extracted name must
 * still clear `looksLikeIdentifier` to be reported (see
 * `extractIdentifier`).
 */
const PHP_DECL_RE =
  /^(?<indent>\s*)(?<modifiers>(?:(?:public|protected|private|static|abstract|final|readonly)\s+)*)(?:function|const|class|interface|trait|enum)\s+&?(?<name>[A-Za-z_][A-Za-z0-9_]*)\b/i;

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

/** The extensions `extractIdentifier` knows how to read a declaration or
 * config key out of: the TS/JS source extensions, JSON/YAML top-level
 * keys, and PHP (`PHP_DECL_RE`). */
const DECLARATION_EXTRACTOR_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ...PHP_EXTENSIONS,
  "json",
  "yml",
  "yaml",
]);

/** The extensions `SCAN_PATHSPECS` scans for sites but has no declaration
 * extractor for, docs excluded (a doc never declares anything, so its
 * missing extractor is not a gap). When a diff removes lines from a file
 * of one of these extensions a declaration may have been removed there
 * and nothing collected from it; `parseRemovedIdentifiers` reports that
 * as an extractor gap (`extractorGaps`) instead of staying silent. */
const EXTRACTOR_GAP_EXTENSIONS = new Set(
  SCAN_PATHSPECS.map((spec) => spec.replace(/^\*\./, "")).filter(
    (ext) =>
      !DOC_EXTENSIONS.has(ext) && !DECLARATION_EXTRACTOR_EXTENSIONS.has(ext),
  ),
);

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

/** True when `name` is shaped enough like an identifier to be worth
 * reporting as one: at least 4 characters, and containing an uppercase
 * letter, a hyphen, or an underscore. Without this guard a deleted file's
 * basename floods the report with every ordinary lowercase prose word that
 * happens to also be a filename (`index`, `setup`, `logo`, ...), and a PHP
 * declaration's name floods it with every framework method name (`up`,
 * `down`, `index`, `show`, `store`, `handle`, `render` - a Laravel
 * migration, a resource controller). A prototype-scope heuristic,
 * documented in docs/drift.md as a known limitation: a short or
 * all-lowercase-no-separator identifier (`db`, `api`) is never reported
 * this way. */
function looksLikeIdentifier(name: string): boolean {
  return name.length >= 4 && /[A-Z_-]/.test(name);
}

/** Extracts the one declared/keyed identifier a diff line names, per the
 * file it belongs to: a TS/JS declaration for a source extension, a PHP
 * declaration for `.php`, a top-level config key for `.json`/`.yml`/`.yaml`.
 * Every other extension (Markdown, plain text, ...) never contributes a
 * removed identifier - only a declaration's own file can remove one, and
 * the extensions that are scanned for sites without having an extractor
 * here surface as `extractorGaps` instead. A removed PHP line whose
 * trimmed text starts a comment (`//`, `#`, `*`, `/*`, the same classifier
 * `scan.ts` uses for site lines) is not a declaration even when the
 * comment quotes one. A PHP declaration NAME that does not clear
 * `looksLikeIdentifier` (the bar a deleted file's basename already faces)
 * is not emitted: the result comes back flagged
 * (`identifierBarFailed: true`) so `parseRemovedIdentifiers` can record
 * the name as skipped rather than silently drop it. The line's shape
 * (exported, indented) travels with the name; see `RemovedIdentifier`. */
function extractIdentifier(
  line: string,
  filePath: string,
):
  | {
      name: string;
      kind: RemovedIdentifierKind;
      exported: boolean;
      indented: boolean;
      identifierBarFailed?: true;
    }
  | undefined {
  const ext = extOf(filePath);
  if (SOURCE_EXTENSIONS.has(ext)) {
    const m = DECL_RE.exec(line);
    if (m === null) return undefined;
    const groups = m.groups ?? {};
    return {
      name: groups["name"] ?? "",
      kind: "declaration",
      exported: groups["exported"] !== undefined,
      indented: (groups["indent"] ?? "").length > 0,
    };
  }
  if (PHP_EXTENSIONS.has(ext)) {
    if (classifyLine(filePath, line) !== undefined) return undefined;
    const m = PHP_DECL_RE.exec(line);
    if (m === null) return undefined;
    const groups = m.groups ?? {};
    const modifiers = (groups["modifiers"] ?? "").toLowerCase();
    const name = groups["name"] ?? "";
    return {
      name,
      kind: "declaration",
      exported: !/\b(?:private|protected)\b/.test(modifiers),
      indented: (groups["indent"] ?? "").length > 0,
      ...(looksLikeIdentifier(name)
        ? {}
        : { identifierBarFailed: true as const }),
    };
  }
  if (ext === "json") {
    const m = JSON_TOP_KEY_RE.exec(line);
    return m
      ? {
          name: m[1] ?? "",
          kind: "config_key",
          exported: false,
          indented: /^\s/.test(line),
        }
      : undefined;
  }
  if (ext === "yml" || ext === "yaml") {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("-") || trimmed.startsWith("#")) return undefined;
    const m = YAML_TOP_KEY_RE.exec(line);
    return m
      ? {
          name: m[1] ?? "",
          kind: "config_key",
          exported: false,
          indented: /^\s/.test(line),
        }
      : undefined;
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
 * removed identifier of kind `"file"` only when its extension is one of
 * `SOURCE_EXTENSIONS` AND the basename looks like an identifier (see
 * `looksLikeIdentifier`) - guarding against a deleted `docs/setup.md` or
 * `logo.png` flooding the report with every prose mention of "setup" or
 * "logo". A basename skipped for either reason is recorded in
 * `skippedFileBasenames`, not silently dropped. UNLESS a file of the same
 * basename (again without extension, whatever its own extension) was
 * newly added anywhere in the same diff - that is a rename this diff's
 * `git diff` did not detect as one (different content), not a removal,
 * and is therefore also treated as moved (and never counted as skipped
 * either, since it was never a candidate to skip).
 *
 * The "moved" rule for declarations/config keys is name-only: an
 * identifier declared on both a removed and an added line anywhere in
 * the diff (any file, any line) is excluded from `removed` and listed in
 * `movedNames` instead, on the reading that the same name reappearing as
 * a declaration means it moved rather than disappeared. This can both
 * over- and under-forgive: an identifier removed from one file and
 * coincidentally declared fresh, unrelated, in another counts as moved
 * too; documented as a known limitation, not fixed here.
 *
 * Independently of any extractor: when the diff removes lines from a
 * file whose extension `SCAN_PATHSPECS` scans for sites but no
 * declaration extractor reads (a `.py` or `.sh` file), a declaration
 * may have been removed there without anything being collected from
 * it. Each such extension is recorded once in `extractorGaps`, with
 * the number of distinct files of that extension the diff removed
 * lines from, so `drift()` can warn per extension; docs are excluded
 * because they never declare, and an extension with an extractor
 * (TS/JS, JSON, YAML, PHP) never appears.
 *
 * A PHP declaration line whose NAME does not clear `looksLikeIdentifier`
 * - the bar a deleted file's basename already faces - contributes no
 * identifier either: a framework method name (`up`, `down`, `index`,
 * `handle`) is an ordinary prose word that would be scanned against
 * every doc and comment. Each distinct such name is recorded once in
 * `skippedPhpNames` so `drift()` can warn, not stay silent - unless the
 * same diff also declares that name on an ADDED PHP line, which makes the
 * removal a signature edit or a move rather than a removal, and there is
 * then nothing to warn about.
 */
export function parseRemovedIdentifiers(diff: string): ParsedDiff {
  const lines = diff.split("\n");

  const removedCandidates: RemovedIdentifier[] = [];
  const addedNames = new Set<string>();
  const addedFileBasenames = new Set<string>();
  // Names a removed PHP line declared that did not clear the identifier
  // bar: never emitted, but recorded once each (first occurrence wins) so
  // `drift()` warns about the blind spot instead of leaving a silent zero.
  const skippedPhpNames: string[] = [];
  // The same names seen on an ADDED PHP declaration line. A name that
  // failed the bar on a removed line and appears again on an added one was
  // edited (a signature change on a migration or controller method) or
  // moved, not removed, so it is dropped from `skippedPhpNames` at the end
  // rather than warned about.
  const addedBarFailedNames = new Set<string>();
  const deletedFiles: { path: string }[] = [];
  // Extension -> the distinct files of that extension this diff removed
  // lines from, for the extensions with no declaration extractor
  // (`EXTRACTOR_GAP_EXTENSIONS`): a `.py`/`.sh` line is scanned for sites
  // but never read for declarations, so the caller is warned (per
  // extension, with the file count) rather than left with a silent zero.
  const gapFilesByExt = new Map<string, Set<string>>();

  let oldPath: string | undefined;
  let newPath: string | undefined;
  let deletedFile = false;
  let newFile = false;
  let oldLine = 0;
  let newLine = 0;
  // True once the current file block's first `@@ ... @@` hunk header has
  // been seen. A unified diff's `--- `/`+++ ` file headers only ever
  // appear BEFORE a file's first hunk; a REMOVED line whose own content
  // happens to start with "-- " (or an ADDED line starting with "++ ")
  // becomes, once prefixed with the diff's own leading `-`/`+`, a line
  // that looks exactly like `--- `/`+++ ` - e.g. a removed SQL comment
  // `-- note` becomes the diff line `--- note`. Gating the header check
  // on "not seen a hunk yet for this file" is what tells the two apart:
  // a real header can only occur pre-hunk, so a `--- `/`+++ `-shaped line
  // seen after the hunk header is unambiguously content, never a header.
  let sawHunk = false;

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
      sawHunk = false;
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
    if (!sawHunk && raw.startsWith("--- ")) {
      const p = stripAbPrefix(raw.slice(4));
      oldPath = p === "/dev/null" ? undefined : p;
      continue;
    }
    if (!sawHunk && raw.startsWith("+++ ")) {
      const p = stripAbPrefix(raw.slice(4));
      newPath = p === "/dev/null" ? undefined : p;
      if (newFile && newPath !== undefined) {
        addedFileBasenames.add(basenameNoExt(newPath));
      }
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      sawHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    if (raw.startsWith("-")) {
      const content = raw.slice(1);
      const filePath = oldPath ?? newPath;
      if (filePath !== undefined) {
        const gapExt = extOf(filePath);
        if (EXTRACTOR_GAP_EXTENSIONS.has(gapExt)) {
          const files = gapFilesByExt.get(gapExt) ?? new Set<string>();
          files.add(filePath);
          gapFilesByExt.set(gapExt, files);
        }
        const found = extractIdentifier(content, filePath);
        if (found !== undefined) {
          if (found.identifierBarFailed === true) {
            if (!skippedPhpNames.includes(found.name)) {
              skippedPhpNames.push(found.name);
            }
          } else {
            removedCandidates.push({
              name: found.name,
              kind: found.kind,
              file: filePath,
              line: oldLine,
              exported: found.exported,
              indented: found.indented,
            });
          }
        }
      }
      oldLine++;
      continue;
    }
    if (raw.startsWith("+")) {
      const content = raw.slice(1);
      const filePath = newPath ?? oldPath;
      if (filePath !== undefined) {
        const found = extractIdentifier(content, filePath);
        // A PHP name that fails the identifier bar never joins `addedNames`,
        // so the moved rule never sees it and a same-spelled name removed in
        // ANOTHER language (a YAML `show:` key beside an added PHP `function
        // show()`) stays reported rather than being treated as moved.
        if (found !== undefined) {
          if (found.identifierBarFailed === true) {
            addedBarFailedNames.add(found.name);
          } else {
            addedNames.add(found.name);
          }
        }
      }
      newLine++;
      continue;
    }
  }
  flushBlock();

  const skippedFileBasenames: { path: string; basename: string }[] = [];
  for (const { path } of deletedFiles) {
    const base = basenameNoExt(path);
    if (addedFileBasenames.has(base)) continue;
    if (SOURCE_EXTENSIONS.has(extOf(path)) && looksLikeIdentifier(base)) {
      // A deleted file has no declaration line, so neither shape fact can
      // be read: both are false, which keeps the local-binding rule (an
      // indented, non-exported declaration only) away from it.
      removedCandidates.push({
        name: base,
        kind: "file",
        file: path,
        line: 1,
        exported: false,
        indented: false,
      });
    } else {
      skippedFileBasenames.push({ path, basename: base });
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

  const extractorGaps: { ext: string; files: number }[] = [];
  for (const ext of [...gapFilesByExt.keys()].sort()) {
    const files = gapFilesByExt.get(ext);
    if (files !== undefined && files.size > 0) {
      extractorGaps.push({ ext, files: files.size });
    }
  }

  return {
    removed,
    movedNames,
    skippedFileBasenames,
    // Mirroring the moved rule for a name the bar never let through: one
    // the diff declares again on an added PHP line was edited or moved,
    // not removed, so it is no blind spot and gets no warning.
    skippedPhpNames: skippedPhpNames.filter(
      (name) => !addedBarFailedNames.has(name),
    ),
    extractorGaps,
  };
}
