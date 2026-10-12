import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { UsageError } from "../envelope.js";
import { findGitRoot, isPathContained } from "../probe/containment.js";
import {
  applyRegions,
  applyRegionsToRaw,
  crlfToLf,
  detectLineEnding,
  resolveFileEdits,
  type EditResolution,
  type LineRange,
  type MatchTier,
  type Region,
} from "./engine.js";
import { notFoundHint, type NotFoundHint } from "./hint.js";
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
 * ok; `missing`, `ambiguous` and `overlap` are findings; `refused` (a path
 * outside the root or inside `.git`) is a usage error; `error` is a file
 * that could not be read, decoded or written; `not_written` is an edit
 * that resolved but was not written because the plan was refused or a
 * write failed.
 */
export type PatchEditStatus =
  | "written"
  | "would_write"
  | "unchanged"
  | "missing"
  | "ambiguous"
  | "overlap"
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
}

export type PatchFileStatus =
  "written" | "would_write" | "unchanged" | "not_written" | "refused" | "error";

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
  /** Test seam: replaces the rename that commits a written file. */
  renameFile?: (from: string, to: string) => void;
}

interface FileState {
  key: string;
  display: string;
  real: string;
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

function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]+/).some((seg) => seg === ".git");
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
  if (text.startsWith("﻿")) return { ok: true, raw: text.slice(1), bom: true };
  return { ok: true, raw: text, bom: false };
}

function errnoDetail(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e instanceof Error ? e.message : String(err);
}

/**
 * Applies a plan of exact-text edits. Every edit is resolved against the
 * current content of every file before anything is written: a missing,
 * ambiguous or overlapping edit, a refused path or an unreadable file
 * refuses the whole plan and nothing is written. Then each changed file is
 * written through a temporary file in its own directory and a rename, in
 * plan order; a file whose bytes changed since they were read, or a write
 * error, stops the write phase and the result names the files already
 * written.
 */
export function patch(options: PatchOptions): PatchResult {
  const dryRun = options.dryRun === true;
  const cwd = path.resolve(options.cwd);
  const rootLexical = findGitRoot(cwd) ?? cwd;
  let root: string;
  try {
    root = fs.realpathSync(rootLexical);
  } catch (err) {
    throw new UsageError(
      `patch: cannot resolve root ${rootLexical}: ${errnoDetail(err)}`,
    );
  }
  const warnings: string[] = [];
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

  // Resolve every target path; group edits per real file.
  const files = new Map<string, FileState>();
  const order: FileState[] = [];
  const editResults: PatchEditResult[] = [];
  for (let i = 0; i < options.edits.length; i++) {
    const spec = options.edits[i];
    const lexical = path.resolve(cwd, spec.file);
    let real: string | undefined;
    let pathError:
      | { reason: string; detail: string; status: "refused" | "error" }
      | undefined;
    try {
      real = fs.realpathSync(lexical);
    } catch (err) {
      pathError = {
        status: "error",
        reason: "not_found",
        detail: `cannot resolve ${spec.file}: ${errnoDetail(err)}`,
      };
    }
    const contained = real !== undefined && isPathContained(root, real);
    const display =
      real === undefined
        ? spec.file
        : contained
          ? path.relative(root, real)
          : real;
    if (real !== undefined) {
      const lexicalRel = path.relative(rootLexical, lexical);
      if (
        hasGitSegment(contained ? path.relative(root, real) : real) ||
        hasGitSegment(
          isPathContained(rootLexical, lexical) ? lexicalRel : lexical,
        )
      ) {
        pathError = {
          status: "refused",
          reason: "git_dir",
          detail: `${spec.file} is inside a .git directory; patch never writes there`,
        };
      } else if (!contained && options.allowOutside !== true) {
        pathError = {
          status: "refused",
          reason: "outside_root",
          detail: `${spec.file} resolves to ${real}, outside the root ${root} (pass --allow-outside to permit)`,
        };
      } else {
        let st: fs.Stats | undefined;
        try {
          st = fs.statSync(real);
        } catch (err) {
          pathError = {
            status: "error",
            reason: "unreadable",
            detail: errnoDetail(err),
          };
        }
        if (st !== undefined && !st.isFile()) {
          pathError = {
            status: "error",
            reason: "not_a_file",
            detail: `${spec.file} is not a regular file`,
          };
        }
      }
    }
    const key = real ?? `missing:${lexical}`;
    let state = files.get(key);
    if (state === undefined) {
      state = { key, display, real: real ?? lexical, edits: [] };
      files.set(key, state);
      order.push(state);
    }
    state.edits.push(i);
    if (pathError !== undefined && state.status === undefined) {
      state.status = pathError.status;
      state.reason = pathError.reason;
      state.detail = pathError.detail;
    }
    editResults.push({
      index: i,
      file: spec.file,
      path: display,
      status: "not_written",
    });
  }

  // Read and resolve every file that passed the path checks.
  for (const state of order) {
    if (state.status !== undefined) continue;
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(state.real);
      state.mode = fs.statSync(state.real).mode & 0o7777;
    } catch (err) {
      state.status = "error";
      state.reason = "unreadable";
      state.detail = errnoDetail(err);
      continue;
    }
    const decoded = decodeFile(buffer);
    if (!decoded.ok) {
      state.status = "error";
      state.reason = decoded.reason;
      state.detail = decoded.detail;
      continue;
    }
    state.buffer = buffer;
    state.raw = decoded.raw;
    state.bom = decoded.bom;
    state.ending = detectLineEnding(decoded.raw);
    state.lf = crlfToLf(decoded.raw);
    const resolution = resolveFileEdits(
      state.lf,
      state.edits.map((i) => ({
        index: i,
        old: crlfToLf(options.edits[i].old),
        new: crlfToLf(options.edits[i].new),
        replaceAll: options.edits[i].replaceAll === true,
      })),
    );
    for (const r of resolution.edits) applyResolution(editResults[r.index], r);
    for (const r of resolution.edits) {
      if (r.status === "missing") {
        const spec = options.edits[r.index];
        editResults[r.index].hint = notFoundHint(
          state.lf,
          crlfToLf(spec.old),
          crlfToLf(spec.new),
        );
      }
    }
    if (resolution.newContent !== undefined) {
      state.regions = resolution.regions;
      const newRaw = applyRegionsToRaw(
        decoded.raw,
        resolution.regions,
        state.ending,
      );
      state.newRaw = newRaw;
      state.diff = unifiedDiff(state.display, state.lf, resolution.regions);
      // Cross-check: the raw splice and the LF splice must agree.
      if (
        crlfToLf(newRaw) !==
        crlfToLf(applyRegions(state.lf, resolution.regions))
      ) {
        state.status = "error";
        state.reason = "internal";
        state.detail =
          "line-ending mapping disagreed with the LF view; nothing written";
      }
    }
  }

  // Path and IO errors on the edits of an unusable file.
  for (const state of order) {
    if (state.status === "refused" || state.status === "error") {
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
    has("overlap");

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
  if (editResults.some((e) => e.tier !== undefined && e.tier !== "exact")) {
    warnings.push(
      "a fuzzy tier matched: the lines such a match touches are rewritten from the normalized text (trailing whitespace dropped; under the unicode tier also NFKC and ASCII quotes, dashes and spaces)",
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
      refused: count("refused"),
      errors: count("error"),
    },
    warnings,
  };
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
  }
}

/** Writes one file through a temporary file in the same directory plus a
 * rename, keeping the file mode and BOM. Returns a failure or undefined. */
function writeFile(
  state: FileState,
  rename: (from: string, to: string) => void,
): { reason: string; detail: string } | undefined {
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
  const content = (state.bom === true ? "﻿" : "") + (state.newRaw ?? "");
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
