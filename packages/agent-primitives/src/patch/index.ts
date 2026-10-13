import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { UsageError } from "../envelope.js";
import { findGitRoot, isPathContained } from "../probe/containment.js";
import {
  applyRegionsToRaw,
  crlfToLf,
  detectLineEnding,
  rawMappingAgrees,
  resolveFileEdits,
  type EditResolution,
  type LineRange,
  type MatchTier,
  type Region,
} from "./engine.js";
import {
  fuzzySideEffectHint,
  notFoundHint,
  type FuzzySideEffectHint,
  type NotFoundHint,
} from "./hint.js";
import { unifiedDiff } from "./diff.js";

export { MATCH_TIERS, type MatchTier } from "./engine.js";
export { visualizeWhitespace } from "./hint.js";

/** One edit of a plan, as given. */
export interface PatchEditSpec {
  file: string;
  old: string;
  new: string;
  replaceAll?: boolean;
}

/** A usage error with a machine-readable reason (`plan_invalid`,
 * `empty_old`, ...), reported by the CLI as `status: "usage_error"`. */
export class PatchUsageError extends UsageError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}

const EDIT_KEYS = new Set(["file", "old", "new", "replaceAll"]);

/**
 * Parses and validates a plan: `{"edits":[{"file","old","new","replaceAll"?}]}`.
 * Unknown keys, a non-string field, an empty `edits` list or an empty
 * `old` are refused, so a misspelled key never silently does nothing.
 */
export function parsePatchPlan(text: string, source = "plan"): PatchEditSpec[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new PatchUsageError(
      `patch: ${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "plan_invalid",
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PatchUsageError(
      `patch: ${source} must be a JSON object with an "edits" array`,
      "plan_invalid",
    );
  }
  const extra = Object.keys(data).filter((k) => k !== "edits");
  if (extra.length > 0) {
    throw new PatchUsageError(
      `patch: ${source} has unknown key(s): ${extra.join(", ")} (only "edits" is allowed)`,
      "plan_invalid",
    );
  }
  const edits = (data as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new PatchUsageError(
      `patch: ${source} needs a non-empty "edits" array`,
      "plan_invalid",
    );
  }
  return edits.map((raw, i): PatchEditSpec => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}] must be an object`,
        "plan_invalid",
      );
    }
    const unknown = Object.keys(raw).filter((k) => !EDIT_KEYS.has(k));
    if (unknown.length > 0) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}] has unknown key(s): ${unknown.join(", ")} (allowed: file, old, new, replaceAll)`,
        "plan_invalid",
      );
    }
    const e = raw as Record<string, unknown>;
    for (const key of ["file", "old", "new"] as const) {
      if (typeof e[key] !== "string") {
        throw new PatchUsageError(
          `patch: edits[${String(i)}].${key} must be a string`,
          "plan_invalid",
        );
      }
    }
    if (e.replaceAll !== undefined && typeof e.replaceAll !== "boolean") {
      throw new PatchUsageError(
        `patch: edits[${String(i)}].replaceAll must be a boolean`,
        "plan_invalid",
      );
    }
    if ((e.file as string).length === 0) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}].file must not be empty`,
        "plan_invalid",
      );
    }
    const spec: PatchEditSpec = {
      file: e.file as string,
      old: e.old as string,
      new: e.new as string,
    };
    if (e.replaceAll === true) spec.replaceAll = true;
    return spec;
  });
}

/**
 * Per-edit status. `written`, `would_write` (dry run) and `unchanged` are
 * ok; `missing`, `ambiguous`, `overlap`, `fuzzy_side_effect` (a fuzzy
 * match whose lines would change outside the matched text) and
 * `not_editable` (a hard-linked or read-only file) are findings; `refused`
 * (a path outside the root or inside a git directory) is a usage error;
 * `error` is a file that could not be read, decoded or written;
 * `not_written` is an edit that resolved but was not written because the
 * plan was refused or a write failed.
 */
export type PatchEditStatus =
  | "written"
  | "would_write"
  | "unchanged"
  | "missing"
  | "ambiguous"
  | "overlap"
  | "fuzzy_side_effect"
  | "not_editable"
  | "refused"
  | "error"
  | "not_written";

export interface PatchEditResult {
  index: number;
  /** The path as given in the plan. */
  file: string;
  /** Root-relative path of the resolved target (absolute when outside). */
  path: string;
  status: PatchEditStatus;
  tier?: MatchTier;
  occurrences?: number;
  line_ranges?: LineRange[];
  match_lines?: number[];
  overlaps_with?: number[];
  reason?: string;
  detail?: string;
  hint?: NotFoundHint;
  side_effect?: FuzzySideEffectHint;
}

export type PatchFileStatus =
  | "written"
  | "would_write"
  | "unchanged"
  | "not_written"
  | "not_editable"
  | "refused"
  | "error";

export interface PatchFileResult {
  path: string;
  status: PatchFileStatus;
  edits: number[];
  line_ending?: "lf" | "crlf";
  bom?: boolean;
  diff?: string;
  reason?: string;
  detail?: string;
}

export type PatchStatus =
  | "written"
  | "would_write"
  | "unchanged"
  | "missing"
  | "ambiguous"
  | "overlap"
  | "fuzzy_side_effect"
  | "not_editable"
  | "usage_error"
  | "error";

export interface PatchResult {
  status: PatchStatus;
  reason?: string;
  message?: string;
  dryRun: boolean;
  root: string;
  edits: PatchEditResult[];
  files: PatchFileResult[];
  /** Files actually written, in write order (also after a write error). */
  writtenFiles: string[];
  /** Edit counts by status, plus the number of distinct files and of
   * files written. */
  counts: {
    edits: number;
    files: number;
    files_written: number;
    written: number;
    would_write: number;
    unchanged: number;
    missing: number;
    ambiguous: number;
    overlap: number;
    fuzzy_side_effect: number;
    not_editable: number;
    refused: number;
    errors: number;
  };
  warnings: string[];
}

export interface PatchOptions {
  cwd: string;
  edits: readonly PatchEditSpec[];
  dryRun?: boolean;
  allowOutside?: boolean;
  /** Edit a file with more than one hard link anyway: the rename that
   * writes it gives the edited name a new inode, so the other names keep
   * the old content. Refused (`not_editable`, `hard_link`) otherwise. */
  breakHardLinks?: boolean;
  /** Test seam: replaces the rename that commits a written file. */
  renameFile?: (from: string, to: string) => void;
}

interface FileState {
  key: string;
  display: string;
  real: string;
  /** Every absolute spelling of the file the plan used. */
  lexicals: string[];
  edits: number[];
  status?: PatchFileStatus;
  reason?: string;
  detail?: string;
  buffer?: Buffer;
  raw?: string;
  bom?: boolean;
  lf?: string;
  ending?: "\r\n" | "\n";
  mode?: number;
  regions?: Region[];
  newRaw?: string;
  diff?: string;
}

/** A `.git` path component in any letter case: on a case-insensitive
 * filesystem `.GIT` and `.Git` name the same directory. */
function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]+/).some((seg) => seg.toLowerCase() === ".git");
}

/** `dev:ino` of a path (following symlinks); undefined when it cannot be
 * stated. Names one file whatever its spelling: letter case, Unicode
 * normalisation, a symlink or another hard link. */
function identityOf(p: string): string | undefined {
  try {
    const st = fs.statSync(p, { bigint: true });
    return `${String(st.dev)}:${String(st.ino)}`;
  } catch {
    return undefined;
  }
}

/**
 * Identities of the git directory and common directory (they differ in a
 * linked worktree) git finds from `root`, whatever they are named. Asked
 * also when `root` has no work tree: inside a bare repository or a git
 * directory, git answers with that directory. The set is empty when git
 * finds no repository there, and then also carries a warning when the
 * check could not be made: git cannot be run, or `root` is a git work
 * tree (`inWorkTree`) and git fails or names a directory that cannot be
 * stated there.
 */
function gitDirIdentities(
  root: string,
  inWorkTree: boolean,
): { ids: Set<string>; warning?: string } {
  const ids = new Set<string>();
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
    delete env[key];
  }
  const skipped = (why: string): { ids: Set<string>; warning: string } => ({
    ids,
    warning: `the git directory check by identity was skipped (${why}); only a .git path component is refused`,
  });
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    if (typeof e.status !== "number") {
      return skipped(`git could not be run: ${errnoDetail(err)}`);
    }
    // Outside any repository git exits non-zero: nothing to refuse.
    if (!inWorkTree) return { ids };
    return skipped(
      `git rev-parse failed with exit code ${String(e.status)} in the work tree ${root}`,
    );
  }
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const id = identityOf(path.resolve(root, line));
    if (id === undefined) {
      return skipped(`git named ${line}, which cannot be stated`);
    }
    ids.add(id);
  }
  if (ids.size === 0 && inWorkTree) {
    return skipped("git named no git directory for the work tree");
  }
  return { ids };
}

/** True when a directory above `real` is one of the git directories in
 * `gitIds`, compared by identity rather than by name. */
function insideGitDir(real: string, gitIds: ReadonlySet<string>): boolean {
  if (gitIds.size === 0) return false;
  let dir = path.dirname(real);
  for (;;) {
    const id = identityOf(dir);
    if (id !== undefined && gitIds.has(id)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Decodes a file for editing, or names why it cannot be edited. */
function decodeFile(
  buffer: Buffer,
):
  | { ok: true; raw: string; bom: boolean }
  | { ok: false; reason: string; detail: string } {
  if (buffer.includes(0)) {
    return {
      ok: false,
      reason: "binary",
      detail: "file contains a NUL byte; binary files are not edited",
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch {
    return {
      ok: false,
      reason: "not_utf8",
      detail: "file is not valid UTF-8; only UTF-8 text files are edited",
    };
  }
  if (text.startsWith("\uFEFF"))
    return { ok: true, raw: text.slice(1), bom: true };
  return { ok: true, raw: text, bom: false };
}

function errnoDetail(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e instanceof Error ? e.message : String(err);
}

/**
 * Applies a plan of exact-text edits. Every edit is resolved against the
 * current content of every file before anything is written: a missing,
 * ambiguous, overlapping or side-effecting edit, a refused path, a file
 * that is not editable as is, or an unreadable file refuses the whole plan
 * and nothing is written. Then each changed file is written through a
 * temporary file in its own directory and a rename, in plan order; a file
 * whose path or bytes changed since they were read, or a write error,
 * stops the write phase and the result names the files already written.
 */
export function patch(options: PatchOptions): PatchResult {
  const dryRun = options.dryRun === true;
  const cwd = path.resolve(options.cwd);
  const gitRoot = findGitRoot(cwd);
  const rootLexical = gitRoot ?? cwd;
  let root: string;
  try {
    // The native realpath returns each component as it is stored, so a
    // case or Unicode-normalisation variant of the root reads as the root.
    root = fs.realpathSync.native(rootLexical);
  } catch (err) {
    throw new UsageError(
      `patch: cannot resolve root ${rootLexical}: ${errnoDetail(err)}`,
    );
  }
  // Asked whether or not a work tree was found: `-C` may lie in a bare
  // repository or a git directory, which has no work tree.
  const gitDirs = gitDirIdentities(root, gitRoot !== undefined);
  const gitIds = gitDirs.ids;
  const warnings: string[] =
    gitDirs.warning !== undefined ? [gitDirs.warning] : [];
  const rename =
    options.renameFile ?? ((a: string, b: string) => fs.renameSync(a, b));

  for (let i = 0; i < options.edits.length; i++) {
    if (options.edits[i].old.length === 0) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}].old must not be empty`,
        "empty_old",
      );
    }
  }

  // Resolve every target path; group edits per file identity (dev:ino),
  // so every spelling of one file shares one state and one write.
  const files = new Map<string, FileState>();
  const order: FileState[] = [];
  const editResults: PatchEditResult[] = [];
  for (let i = 0; i < options.edits.length; i++) {
    const spec = options.edits[i];
    const lexical = path.resolve(cwd, spec.file);
    let real: string | undefined;
    let identity: string | undefined;
    let pathError:
      | {
          reason: string;
          detail: string;
          status: "refused" | "error" | "not_editable";
        }
      | undefined;
    try {
      real = fs.realpathSync.native(lexical);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      pathError =
        code === "ENOENT" || code === "ENOTDIR"
          ? {
              status: "error",
              reason: "not_found",
              detail: `${spec.file}: file does not exist; patch only edits existing files (it never creates one)`,
            }
          : {
              status: "error",
              reason: "unreadable",
              detail: `cannot resolve ${spec.file}: ${errnoDetail(err)}`,
            };
    }
    let st: fs.Stats | undefined;
    if (real !== undefined) {
      try {
        st = fs.statSync(real);
        identity = identityOf(real);
      } catch (err) {
        pathError = {
          status: "error",
          reason: "unreadable",
          detail: errnoDetail(err),
        };
      }
    }
    const contained = real !== undefined && isPathContained(root, real);
    const display =
      real === undefined
        ? spec.file
        : contained
          ? path.relative(root, real)
          : real;
    if (real !== undefined && pathError === undefined) {
      const lexicalRel = path.relative(rootLexical, lexical);
      if (
        hasGitSegment(contained ? path.relative(root, real) : real) ||
        hasGitSegment(
          isPathContained(rootLexical, lexical) ? lexicalRel : lexical,
        ) ||
        insideGitDir(real, gitIds)
      ) {
        pathError = {
          status: "refused",
          reason: "git_dir",
          detail: `${spec.file} is inside a git directory; patch never writes there`,
        };
      } else if (!contained && options.allowOutside !== true) {
        pathError = {
          status: "refused",
          reason: "outside_root",
          detail: `${spec.file} resolves to ${real}, outside the root ${root} (pass --allow-outside to permit)`,
        };
      } else if (st !== undefined && !st.isFile()) {
        pathError = {
          status: "error",
          reason: "not_a_file",
          detail: `${spec.file} is not a regular file`,
        };
      } else if (
        st !== undefined &&
        st.nlink > 1 &&
        options.breakHardLinks !== true
      ) {
        pathError = {
          status: "not_editable",
          reason: "hard_link",
          detail: `${spec.file} has ${String(st.nlink)} hard links; writing it would leave the other names with the old content (pass --break-hard-links to accept that)`,
        };
      } else if (!isWritable(real)) {
        pathError = {
          status: "not_editable",
          reason: "read_only",
          detail: `${spec.file} is not writable; patch does not change a read-only file`,
        };
      }
    }
    const key = identity ?? `missing:${lexical}`;
    let state = files.get(key);
    if (state === undefined) {
      state = { key, display, real: real ?? lexical, lexicals: [], edits: [] };
      files.set(key, state);
      order.push(state);
    }
    state.lexicals.push(lexical);
    state.edits.push(i);
    if (pathError !== undefined && state.status === undefined) {
      state.status = pathError.status;
      state.reason = pathError.reason;
      state.detail = pathError.detail;
    }
    editResults.push({
      index: i,
      file: spec.file,
      path: state.display,
      status: "not_written",
    });
  }

  // Read and resolve every file that passed the path checks. An exception
  // inside the engine is that file's error, never the whole command's.
  for (const state of order) {
    if (state.status !== undefined) continue;
    try {
      resolveState(state, options.edits, editResults);
    } catch (err) {
      state.status = "error";
      state.reason = "internal";
      state.detail = `internal error while resolving the edits: ${errnoDetail(err)}; nothing written`;
    }
  }

  // Path, IO and editability errors on the edits of an unusable file.
  for (const state of order) {
    if (
      state.status === "refused" ||
      state.status === "error" ||
      state.status === "not_editable"
    ) {
      for (const i of state.edits) {
        editResults[i].status = state.status;
        editResults[i].reason = state.reason;
        editResults[i].detail = state.detail;
      }
    }
  }

  const has = (s: PatchEditStatus): boolean =>
    editResults.some((e) => e.status === s);
  const refusedPlan =
    has("refused") ||
    has("error") ||
    has("missing") ||
    has("ambiguous") ||
    has("overlap") ||
    has("fuzzy_side_effect") ||
    has("not_editable");

  const writtenFiles: string[] = [];
  let writeFailure:
    { file: string; detail: string; reason: string } | undefined;

  if (!refusedPlan) {
    for (const state of order) {
      const unchanged = state.newRaw === state.raw;
      if (unchanged) {
        state.status = "unchanged";
        continue;
      }
      if (dryRun) {
        state.status = "would_write";
        continue;
      }
      if (writeFailure !== undefined) {
        state.status = "not_written";
        continue;
      }
      const failure = writeFile(state, rename);
      if (failure === undefined) {
        state.status = "written";
        writtenFiles.push(state.display);
      } else {
        state.status = "error";
        state.reason = failure.reason;
        state.detail = failure.detail;
        writeFailure = { file: state.display, ...failure };
      }
    }
    for (const state of order) {
      for (const i of state.edits) {
        const s = state.status;
        editResults[i].status =
          s === "written" ||
          s === "would_write" ||
          s === "unchanged" ||
          s === "error"
            ? s
            : "not_written";
        if (s === "error") {
          editResults[i].reason = state.reason;
          editResults[i].detail = state.detail;
        }
      }
    }
  } else {
    for (const state of order) {
      if (state.status === undefined) state.status = "not_written";
    }
  }

  const count = (s: PatchEditStatus): number =>
    editResults.filter((e) => e.status === s).length;
  let status: PatchStatus;
  let reason: string | undefined;
  let message: string | undefined;
  const firstWith = (s: PatchEditStatus): PatchEditResult | undefined =>
    editResults.find((e) => e.status === s);
  if (has("refused")) {
    status = "usage_error";
    const first = firstWith("refused");
    reason = first?.reason;
    message =
      first !== undefined ? `${first.path}: ${first.detail ?? ""}` : undefined;
  } else if (has("error")) {
    status = "error";
    const first = firstWith("error");
    reason = writeFailure !== undefined ? "write_failed" : first?.reason;
    message =
      writeFailure !== undefined
        ? `writing ${writeFailure.file} failed (${writeFailure.detail}); already written: ${writtenFiles.length > 0 ? writtenFiles.join(", ") : "none"}`
        : first !== undefined
          ? `${first.path}: ${first.detail ?? ""}`
          : undefined;
  } else if (has("missing")) {
    status = "missing";
  } else if (has("ambiguous")) {
    status = "ambiguous";
  } else if (has("overlap")) {
    status = "overlap";
  } else if (has("fuzzy_side_effect")) {
    status = "fuzzy_side_effect";
  } else if (has("not_editable")) {
    status = "not_editable";
    reason = firstWith("not_editable")?.reason;
  } else if (dryRun) {
    status = order.some((s) => s.status === "would_write")
      ? "would_write"
      : "unchanged";
  } else {
    status = writtenFiles.length > 0 ? "written" : "unchanged";
  }
  if (refusedPlan && status !== "usage_error" && status !== "error") {
    message = "plan refused: nothing was written";
  }
  if (
    editResults.some(
      (e) =>
        e.tier !== undefined &&
        e.tier !== "exact" &&
        e.status !== "fuzzy_side_effect",
    )
  ) {
    warnings.push(
      "a fuzzy tier matched: the old text matched only after normalization (trailing whitespace ignored; under the unicode tier also NFKC, typographic quotes, dashes and special spaces), so the replaced text in the file differs from old; every character outside the match is kept",
    );
  }

  const fileResults: PatchFileResult[] = order.map((s) => {
    const out: PatchFileResult = {
      path: s.display,
      status: s.status ?? "not_written",
      edits: s.edits,
    };
    if (s.ending !== undefined)
      out.line_ending = s.ending === "\r\n" ? "crlf" : "lf";
    if (s.bom !== undefined) out.bom = s.bom;
    if (s.diff !== undefined && s.diff.length > 0) out.diff = s.diff;
    if (s.reason !== undefined) out.reason = s.reason;
    if (s.detail !== undefined) out.detail = s.detail;
    return out;
  });

  return {
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(message !== undefined ? { message } : {}),
    dryRun,
    root,
    edits: editResults,
    files: fileResults,
    writtenFiles,
    counts: {
      edits: editResults.length,
      files: order.length,
      files_written: writtenFiles.length,
      written: count("written"),
      would_write: count("would_write"),
      unchanged: count("unchanged"),
      missing: count("missing"),
      ambiguous: count("ambiguous"),
      overlap: count("overlap"),
      fuzzy_side_effect: count("fuzzy_side_effect"),
      not_editable: count("not_editable"),
      refused: count("refused"),
      errors: count("error"),
    },
    warnings,
  };
}

/** True when the current process may write `p`. */
function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads, decodes and resolves the edits of one file into `state`. */
function resolveState(
  state: FileState,
  edits: readonly PatchEditSpec[],
  editResults: PatchEditResult[],
): void {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(state.real);
    state.mode = fs.statSync(state.real).mode & 0o7777;
  } catch (err) {
    state.status = "error";
    state.reason = "unreadable";
    state.detail = errnoDetail(err);
    return;
  }
  const decoded = decodeFile(buffer);
  if (!decoded.ok) {
    state.status = "error";
    state.reason = decoded.reason;
    state.detail = decoded.detail;
    return;
  }
  state.buffer = buffer;
  state.raw = decoded.raw;
  state.bom = decoded.bom;
  state.ending = detectLineEnding(decoded.raw);
  const lf = crlfToLf(decoded.raw);
  state.lf = lf;
  const resolution = resolveFileEdits(
    lf,
    state.edits.map((i) => ({
      index: i,
      old: crlfToLf(edits[i].old),
      new: crlfToLf(edits[i].new),
      replaceAll: edits[i].replaceAll === true,
    })),
  );
  for (const r of resolution.edits) {
    const target = editResults[r.index];
    applyResolution(target, r);
    if (r.status === "missing") {
      target.hint = notFoundHint(
        lf,
        crlfToLf(edits[r.index].old),
        crlfToLf(edits[r.index].new),
      );
    } else if (r.status === "fuzzy_side_effect") {
      target.side_effect = fuzzySideEffectHint(
        lf,
        r.affectedLines,
        r.tier,
        crlfToLf(edits[r.index].old),
      );
      target.detail = target.side_effect.message;
    }
  }
  if (resolution.newContent !== undefined) {
    state.regions = resolution.regions;
    // Every raw range the write replaces or keeps must read as the LF
    // view does, or the raw splice would not be the change the LF view
    // (and the diff) shows.
    if (!rawMappingAgrees(decoded.raw, lf, resolution.regions)) {
      state.status = "error";
      state.reason = "internal";
      state.detail =
        "line-ending mapping disagreed with the LF view; nothing written";
      return;
    }
    state.newRaw = applyRegionsToRaw(
      decoded.raw,
      resolution.regions,
      state.ending,
    );
    state.diff = unifiedDiff(state.display, lf, resolution.regions);
  }
}

function applyResolution(target: PatchEditResult, r: EditResolution): void {
  switch (r.status) {
    case "resolved":
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.line_ranges = r.lineRanges;
      break;
    case "missing":
      target.status = "missing";
      break;
    case "ambiguous":
      target.status = "ambiguous";
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.match_lines = r.matchLines;
      target.detail = `old text matches ${String(r.occurrences)} times (${r.tier} tier) at lines ${r.matchLines.join(", ")}; add surrounding context or set replaceAll`;
      break;
    case "overlap":
      target.status = "overlap";
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.line_ranges = r.lineRanges;
      target.overlaps_with = r.overlapsWith;
      target.detail = `overlaps edits ${r.overlapsWith.map((i) => `[${String(i)}]`).join(", ")} in the same file (a fuzzy-tier match covers whole lines); merge them into one edit or target disjoint text`;
      break;
    case "fuzzy_side_effect":
      target.status = "fuzzy_side_effect";
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.line_ranges = r.lineRanges;
      break;
  }
}

/** Writes one file through a temporary file in the same directory plus a
 * rename, keeping the file mode and BOM. Right before, every spelling of
 * the file must still resolve to the path that was read (a directory
 * swapped for a symlink in between is refused) and the bytes must be the
 * ones that were read. Returns a failure or undefined. */
function writeFile(
  state: FileState,
  rename: (from: string, to: string) => void,
): { reason: string; detail: string } | undefined {
  // The resolved path must still resolve to itself (no directory on it
  // was swapped for a symlink), and every spelling the plan used must
  // still name the same file.
  let now: string;
  try {
    now = fs.realpathSync.native(state.real);
  } catch (err) {
    return {
      reason: "path_changed",
      detail: `${state.real} no longer resolves (${errnoDetail(err)}); not written`,
    };
  }
  if (now !== state.real) {
    return {
      reason: "path_changed",
      detail: `${state.real} now resolves to ${now}; not written`,
    };
  }
  for (const spelling of state.lexicals) {
    if (identityOf(spelling) !== state.key) {
      return {
        reason: "path_changed",
        detail: `${spelling} no longer names the file that was read; not written`,
      };
    }
  }
  let current: Buffer;
  try {
    current = fs.readFileSync(state.real);
  } catch (err) {
    return { reason: "unreadable", detail: errnoDetail(err) };
  }
  if (state.buffer === undefined || !current.equals(state.buffer)) {
    return {
      reason: "changed_since_read",
      detail: "the file changed after it was read; not overwritten",
    };
  }
  const dir = path.dirname(state.real);
  const tmp = path.join(
    dir,
    `.${path.basename(state.real)}.${randomBytes(6).toString("hex")}.agent-primitives-patch.tmp`,
  );
  const content = (state.bom === true ? "\uFEFF" : "") + (state.newRaw ?? "");
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: state.mode ?? 0o644 });
    // writeFileSync's mode is filtered by the umask; set it exactly.
    fs.chmodSync(tmp, state.mode ?? 0o644);
    rename(tmp, state.real);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temporary file is reported below if it could not be removed.
    }
    return {
      reason: "write_failed",
      detail: `${errnoDetail(err)}${fs.existsSync(tmp) ? `; temporary file left at ${tmp}` : ""}`,
    };
  }
  return undefined;
}
