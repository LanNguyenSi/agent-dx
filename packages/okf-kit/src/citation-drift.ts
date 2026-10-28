import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./bundle.js";
import { UsageError } from "./errors.js";
import { runGitRaw } from "./git.js";
import {
  collectResolvedCitations,
  splitLines,
  type BasenameCache,
  type LineSpan,
  type ResolvedCitation,
} from "./rules/citations-resolve.js";
import type { BundleDoc } from "./types.js";

/**
 * Citation drift against a git ref (`check --base <ref>`, `repoint --base
 * <ref>`).
 *
 * `citations-resolve` only sees a drifted line citation when the new line
 * happens to be blank, a lone closing brace or past the end of the file. A
 * source edit that inserts or removes lines above a cited range usually
 * leaves the citation on some other perfectly ordinary line, which no
 * structural check can tell apart from a correct one. With a base ref the
 * question has an answer: the doc was written against the file as it was at
 * the ref, so the text a citation named THERE is the text it must still name.
 *
 * For every citation the doc already carried at the ref (a citation written
 * or re-pointed since is judged against the current file by its author and is
 * left alone, which also keeps a second `repoint` run a no-op) the verdict is:
 *   - `ok`: the lines the citation names now hold the text they held at the
 *     ref (an unchanged file, or an edit below the range)
 *   - `moved`: the text moved and can be located mechanically: no hunk of
 *     `git diff -U0 <ref>` touches the cited range, so the whole range shifted
 *     by the net line delta of the hunks above it, and the text at the shifted
 *     lines is verified equal to the text cited at the ref
 *   - `changed`: a hunk touches the cited range (a line inside it was edited,
 *     removed, or had lines inserted between its first and last line), or the
 *     shifted lines do not hold the cited text; the new position cannot be
 *     derived, so it is reported and never rewritten
 *   - `skipped`: no verdict is possible (the cited file did not exist at the
 *     ref, the doc or the citation was not in the doc at the ref, the cited
 *     range was not valid at the ref)
 *
 * A cited file that was renamed since the ref is followed in one direction:
 * a citation that names the NEW path is compared against the old path's
 * content at the ref. A citation that still names the old path no longer
 * resolves to a file, so `citations-resolve` reports it as `missing-file`
 * and it never reaches this check; path rewrites are out of scope.
 *
 * Anchored (`#"..."`) citations self-locate and are not special-cased: the
 * line numbers are checked and rewritten like any other, the anchor stays.
 * Reserved docs (`index.md`, `log.md`) are skipped: their line numbers
 * narrate past states and are not live citations.
 */

export type DriftStatus = "ok" | "moved" | "changed" | "skipped";

export interface CitationVerdict {
  citation: ResolvedCitation;
  /** Repo-relative, forward-slash path of the cited file. */
  file: string;
  status: DriftStatus;
  /** For `moved`: the lines the cited text now occupies. */
  newStartLine?: number;
  newEndLine?: number;
  /** For `changed` and `skipped`: why. Empty otherwise. */
  reason: string;
}

export interface DriftBase {
  /** The ref as the caller spelled it, for messages. */
  ref: string;
  /** The commit it resolves to. */
  sha: string;
}

/**
 * Resolves `ref` to a commit in the repo at `repoRoot`. A ref that names no
 * commit is a `UsageError` (exit 2), so a typo never degrades into a clean
 * "nothing drifted" run.
 */
export function resolveBaseCommit(repoRoot: string, ref: string): DriftBase {
  if (ref.trim() === "" || ref.startsWith("-")) {
    throw new UsageError(
      `--base needs a git ref (branch, tag or commit), got \`${ref}\``,
    );
  }
  const sha = runGitRaw(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    repoRoot,
  )?.trim();
  if (!sha) {
    throw new UsageError(
      `--base \`${ref}\` is not a commit in this repository (git rev-parse --verify failed)`,
    );
  }
  return { ref, sha };
}

/** One `@@ -a,b +c,d @@` hunk of a zero-context diff. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunks of a `git diff -U0` output, in file order. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split("\n")) {
    const m = HUNK_HEADER_RE.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/**
 * True when `hunk` removes, edits, or inserts inside old lines `from..to`
 * (1-based, inclusive). A pure insertion (`oldCount` 0) sits AFTER old line
 * `oldStart`; it touches the range only when it lands between two of the
 * range's lines (`from <= oldStart < to`), never just before the first or
 * just after the last.
 */
export function hunkTouchesRange(
  hunk: Hunk,
  from: number,
  to: number,
): boolean {
  if (hunk.oldCount === 0) return from <= hunk.oldStart && hunk.oldStart < to;
  return hunk.oldStart <= to && hunk.oldStart + hunk.oldCount - 1 >= from;
}

/**
 * Net line shift of the hunks that lie entirely above old line `from`: the
 * amount a line at `from` moved, positive when lines were inserted above it,
 * negative when lines were removed. Only meaningful for a range no hunk
 * touches.
 */
export function lineShiftAbove(hunks: Hunk[], from: number): number {
  let shift = 0;
  for (const hunk of hunks) {
    const endsAbove =
      hunk.oldCount === 0
        ? hunk.oldStart < from
        : hunk.oldStart + hunk.oldCount - 1 < from;
    if (endsAbove) shift += hunk.newCount - hunk.oldCount;
  }
  return shift;
}

export interface FileInfo {
  /** Set when the file cannot be judged; the reason. */
  skip?: string;
  oldLines: string[];
  newLines: string[];
  hunks: Hunk[];
}

const comparable = (line: string | undefined): string | undefined =>
  line === undefined ? undefined : line.trimEnd();

/**
 * `<sha>:./<path>`: the blob of a path relative to the git working directory,
 * which is the repo root the caller passed (`--repo-root` may be a
 * subdirectory of the git top level, where `<sha>:<path>` would read the path
 * from the top level instead).
 */
const blobSpec = (sha: string, rel: string): string => `${sha}:./${rel}`;

/** `git diff -z --name-status -M <sha>`: new path -> old path, renames only. */
function loadRenames(root: string, sha: string): Map<string, string> {
  const renames = new Map<string, string>();
  const out = runGitRaw(
    ["diff", "-z", "--name-status", "-M", "--no-ext-diff", "--relative", sha],
    root,
  );
  if (!out) return renames;
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (status === "") continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (status.startsWith("R") && from && to) renames.set(to, from);
      i += 2;
    } else {
      i += 1;
    }
  }
  return renames;
}

function loadFileInfo(
  root: string,
  base: DriftBase,
  rel: string,
  renames: Map<string, string>,
): FileInfo {
  const empty = { oldLines: [], newLines: [], hunks: [] };
  const oldPath = renames.get(rel) ?? rel;
  const oldRaw = runGitRaw(
    ["cat-file", "blob", blobSpec(base.sha, oldPath)],
    root,
  );
  if (oldRaw === null) {
    return { ...empty, skip: `${rel} did not exist at ${base.ref}` };
  }
  let newRaw: string;
  try {
    newRaw = fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return { ...empty, skip: `${rel} could not be read` };
  }
  const paths = oldPath === rel ? [rel] : [oldPath, rel];
  const diff = runGitRaw(
    [
      "diff",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      "--relative",
      base.sha,
      "--",
      ...paths,
    ],
    root,
  );
  if (diff === null) {
    return { ...empty, skip: `git diff against ${base.ref} failed for ${rel}` };
  }
  return {
    oldLines: splitLines(oldRaw),
    newLines: splitLines(newRaw),
    hunks: parseHunks(diff),
  };
}

export function judge(
  citation: ResolvedCitation,
  file: string,
  info: FileInfo,
  base: DriftBase,
): CitationVerdict {
  const verdict = (
    status: DriftStatus,
    reason: string,
    extra: Partial<CitationVerdict> = {},
  ): CitationVerdict => ({ citation, file, status, reason, ...extra });
  const { oldLines, newLines, hunks } = info;
  const from = citation.startLine;
  const to = citation.endLine;
  if (from < 1 || to < from || to > oldLines.length) {
    return verdict(
      "skipped",
      `the cited range is not a valid range of ${file} at ${base.ref}`,
    );
  }
  const sameAt = (shift: number): boolean => {
    for (let line = from; line <= to; line++) {
      const now = comparable(newLines[line - 1 + shift]);
      if (now === undefined || now !== comparable(oldLines[line - 1])) {
        return false;
      }
    }
    return true;
  };
  // The content comparison: the lines a citation names must still hold the
  // text they held at the ref. It is what separates a citation an edit
  // happened to leave alone from one it moved onto other, non-empty lines.
  if (sameAt(0)) return verdict("ok", "");
  if (hunks.some((hunk) => hunkTouchesRange(hunk, from, to))) {
    return verdict(
      "changed",
      `lines inside the cited range were edited, removed or interleaved with new lines since ${base.ref}`,
    );
  }
  const shift = lineShiftAbove(hunks, from);
  if (!sameAt(shift)) {
    return verdict(
      "changed",
      `the text cited at ${base.ref} was not found at the lines it should have moved to`,
    );
  }
  return verdict("moved", "", {
    newStartLine: from + shift,
    newEndLine: to + shift,
  });
}

const repoRelative = (root: string, absPath: string): string | null => {
  let real: string;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    return null;
  }
  const rel = path.relative(root, real).split(path.sep).join("/");
  return rel === "" || rel.startsWith("../") || rel === ".." ? null : rel;
};

/**
 * A citation of a doc together with what identifies it across two versions of
 * that doc: the cited file, its numbers, and its prose context (the doc line
 * it sits on with every digit run blanked, plus its ordinal among the
 * citations with that same context).
 */
interface DocCitation {
  citation: ResolvedCitation;
  file: string;
  context: string;
  used: boolean;
}

function docCitations(
  root: string,
  raw: string,
  citations: ResolvedCitation[],
): DocCitation[] {
  const seen = new Map<string, number>();
  const out: DocCitation[] = [];
  const located = citations
    .map((citation) => ({
      citation,
      file: repoRelative(root, citation.resolvedPath),
      offset: (citation.startSpan ?? citation.endSpan)?.offset ?? 0,
    }))
    .sort((a, b) => a.offset - b.offset);
  for (const { citation, file, offset } of located) {
    if (file === null) continue;
    const lineStart = raw.lastIndexOf("\n", offset - 1) + 1;
    const lineEnd = raw.indexOf("\n", offset);
    const prose = raw
      .slice(lineStart, lineEnd === -1 ? raw.length : lineEnd)
      .replace(/\d+/g, "#");
    const base = `${file}|${prose}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    out.push({ citation, file, context: `${base}|${ordinal}`, used: false });
  }
  return out;
}

const sameNumbers = (a: ResolvedCitation, b: ResolvedCitation): boolean =>
  a.startLine === b.startLine && a.endLine === b.endLine;

/**
 * How a citation of the current doc relates to the doc at the ref:
 *   - `carried`: the citation sits on the same prose line (same ordinal) with
 *     the same numbers, so the doc named this very text at the ref
 *   - `by-numbers`: only a citation with the same file and numbers exists
 *     among the ref citations no other citation claimed (the sentence was
 *     reworded since). The numbers may be stale, or they may be right because
 *     someone fixed them by hand against the current file; a coincidence of
 *     file and numbers cannot tell the two apart, so such a citation is never
 *     rewritten (see `analyzeCitationDrift`)
 *   - `skip`: a citation whose line carried other numbers at the ref was
 *     re-pointed or edited since, and one with no counterpart was written
 *     since; both name the current file by construction and are not judged
 */
type Carry =
  | { kind: "carried" }
  | { kind: "by-numbers" }
  | { kind: "skip"; reason: string };

/**
 * Pairs `now`'s citations with the ones the doc carried at the ref. Doc lines
 * that read the same once digits are blanked (rows of one table, items of one
 * list) are told apart only by their ordinal, so removing or inserting one of
 * them shifts every later pairing and the stale citations below it are
 * skipped as re-pointed; pairing by numbers first would instead let a second
 * `repoint` run pair a re-pointed row with another row's old numbers and
 * rewrite it again.
 */
function carriedAtRef(
  now: DocCitation[],
  atRef: DocCitation[],
): Map<DocCitation, Carry> {
  const verdict = new Map<DocCitation, Carry>();
  const unmatched: DocCitation[] = [];
  for (const entry of now) {
    const counterpart = atRef.find(
      (r) => !r.used && r.context === entry.context,
    );
    if (!counterpart) {
      unmatched.push(entry);
    } else if (sameNumbers(entry.citation, counterpart.citation)) {
      counterpart.used = true;
      verdict.set(entry, { kind: "carried" });
    } else {
      counterpart.used = true;
      verdict.set(entry, {
        kind: "skip",
        reason: "re-pointed or edited since",
      });
    }
  }
  for (const entry of unmatched) {
    const counterpart = atRef.find(
      (r) =>
        !r.used &&
        r.file === entry.file &&
        sameNumbers(r.citation, entry.citation),
    );
    if (counterpart) {
      counterpart.used = true;
      verdict.set(entry, { kind: "by-numbers" });
    } else {
      verdict.set(entry, { kind: "skip", reason: "written since" });
    }
  }
  return verdict;
}

export interface DriftInput {
  /** Real path of the repo root. */
  root: string;
  bundleDir: string;
  docs: BundleDoc[];
}

/**
 * Judges every line citation of the bundle's non-reserved docs against
 * `base`. Verdicts come in doc order, then the order the citations appear.
 */
export function analyzeCitationDrift(
  input: DriftInput,
  base: DriftBase,
): CitationVerdict[] {
  // `input.root` goes to the citation scan unchanged (path resolution climbs
  // from the doc up to it, so both must be spelled the same way as in
  // `check`); every git call and every repo-relative path uses its real path.
  const root = fs.realpathSync(input.root);
  const realBundleDir = fs.realpathSync(input.bundleDir);
  const renames = loadRenames(root, base.sha);
  const files = new Map<string, FileInfo>();
  const cache: BasenameCache = new Map();
  const refCache: BasenameCache = new Map();
  const verdicts: CitationVerdict[] = [];

  for (const doc of input.docs) {
    if (doc.isReserved) continue;
    const citations = collectResolvedCitations(
      input.root,
      input.bundleDir,
      doc,
      cache,
    );
    if (citations.length === 0) continue;

    // The citations the doc carried at the ref.
    const docRel = path
      .relative(root, path.join(realBundleDir, doc.relPath))
      .split(path.sep)
      .join("/");
    const refRaw = runGitRaw(
      ["cat-file", "blob", blobSpec(base.sha, docRel)],
      root,
    );
    const now = docCitations(root, doc.raw, citations);
    let carried: Map<DocCitation, Carry> | null = null;
    if (refRaw !== null) {
      const { frontmatter, body } = parseFrontmatter(refRaw);
      const refDoc: BundleDoc = { ...doc, raw: refRaw, frontmatter, body };
      const atRef = docCitations(
        root,
        refRaw,
        collectResolvedCitations(input.root, input.bundleDir, refDoc, refCache),
      );
      carried = carriedAtRef(now, atRef);
    }

    for (const entry of now) {
      const { citation, file } = entry;
      const skipped = (reason: string): CitationVerdict => ({
        citation,
        file,
        status: "skipped",
        reason,
      });
      if (carried === null) {
        verdicts.push(skipped(`the doc did not exist at ${base.ref}`));
        continue;
      }
      const carry = carried.get(entry);
      if (carry?.kind === "skip") {
        verdicts.push(
          skipped(
            `the doc did not carry this citation at ${base.ref} (${carry.reason})`,
          ),
        );
        continue;
      }
      let info = files.get(file);
      if (!info) {
        info = loadFileInfo(root, base, file, renames);
        files.set(file, info);
      }
      if (info.skip !== undefined) {
        verdicts.push(skipped(info.skip));
        continue;
      }
      const verdict = judge(citation, file, info, base);
      // A citation paired with the ref only by file and numbers may have been
      // fixed by hand against the current file, in which case "moving" it
      // would break a correct citation. It is reported, never rewritten.
      verdicts.push(
        carry?.kind === "by-numbers" && verdict.status === "moved"
          ? {
              ...verdict,
              status: "changed",
              reason: `matched to the citation at ${base.ref} by file and numbers only (the sentence changed since), so it may already have been fixed by hand; check it, it is not re-pointed`,
              newStartLine: undefined,
              newEndLine: undefined,
            }
          : verdict,
      );
    }
  }
  return verdicts;
}

/** `line 14` or `lines 14-16`. */
export function describeLines(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

/** One digit-run replacement in a doc. */
export interface DocEdit {
  span: LineSpan;
  /** The number the span holds now. */
  from: number;
  /** The number to write. */
  to: number;
}

/** The edits that re-point a `moved` verdict's citation. */
export function editsFor(verdict: CitationVerdict): DocEdit[] {
  if (
    verdict.status !== "moved" ||
    verdict.newStartLine === undefined ||
    verdict.newEndLine === undefined
  ) {
    return [];
  }
  const { citation } = verdict;
  const edits: DocEdit[] = [];
  if (citation.startSpan) {
    edits.push({
      span: citation.startSpan,
      from: citation.startLine,
      to: verdict.newStartLine,
    });
  }
  if (citation.endSpan) {
    edits.push({
      span: citation.endSpan,
      from: citation.endLine,
      to: verdict.newEndLine,
    });
  }
  return edits;
}

/**
 * Applies `edits` to `raw`. Each span must still hold the number the edit
 * expects (a stale scan is an error, never a wrong rewrite); edits are
 * applied back to front so earlier offsets stay valid.
 */
export function applyEdits(raw: string, edits: DocEdit[]): string {
  let out = raw;
  const ordered = [...edits].sort((a, b) => b.span.offset - a.span.offset);
  for (const edit of ordered) {
    const { offset, length } = edit.span;
    const held = out.slice(offset, offset + length);
    if (!/^\d+$/.test(held) || Number(held) !== edit.from) {
      throw new Error(
        `citation text at offset ${offset} is \`${held}\`, expected ${edit.from}; the doc changed since it was scanned`,
      );
    }
    out = out.slice(0, offset) + String(edit.to) + out.slice(offset + length);
  }
  return out;
}
