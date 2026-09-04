import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runArgv } from "./run.js";

export type MutantForm = "replace" | "match" | "patch";

export interface MutantSpec {
  form: MutantForm;
  /** Absolute path of the target file. */
  file: string;
  /** 1-indexed line number; informational only for `patch`. */
  line: number;
  /** `-r, --replace`: whole-line replacement text. */
  replaceText?: string;
  /** `-M, --match`: substring to find on `line`. */
  matchText?: string;
  /** `-w, --with`: replacement for the first match of `matchText`. */
  withText?: string;
  /** `-p, --patch`: path to a unified diff file. */
  patchPath?: string;
}

export interface MutantComputed {
  applicable: true;
  before: string;
  after: string;
  newContent: string;
  mutatedHash: string;
  /** Exec log paths produced while computing this mutant (empty for
   * `replace`/`match`, which do no exec calls; the dry-run `git apply`
   * and, for `patch`, the `--numstat` check for `patch`). */
  logPaths: string[];
}

export interface MutantNotApplicable {
  applicable: false;
  /** Human-readable detail for the warning, set when the reason is more
   * specific than "did not apply" (e.g. a patch touching paths other
   * than `--file`). */
  reason?: string;
  /** The machine-readable reason the caller reports. Defaults to
   * `mutant_not_applicable`; a `git apply` killed by its own bound, or
   * stopped by the caller's abort, is named apart from a patch that
   * genuinely does not apply, so a probe that never got an answer is not
   * read as one that got the answer "this patch is bad". */
  reasonCode?: "mutant_not_applicable" | "git_apply_timeout" | "aborted";
  logPaths: string[];
}

export type MutantComputeResult = MutantComputed | MutantNotApplicable;

/**
 * The bound every `git apply` invocation runs under when the caller
 * passes no `--timeout`. `--timeout` bounds the `--pre`/`-t` commands a
 * probe runs, and a caller who set one means "no step of this probe may
 * run longer than that"; without one, `git apply` still gets a bound of
 * its own, since a probe that hangs on it would sit under an in-flight
 * marker forever.
 */
export const DEFAULT_GIT_APPLY_TIMEOUT_MS = 10_000;

/** What every `git apply` here is given beyond its argv: the caller's
 * abort signal (so an interrupted apply is killed rather than left to
 * land after the emergency restore) and the bound above. */
export interface GitApplyOptions {
  signal?: AbortSignal;
  /** Overrides `DEFAULT_GIT_APPLY_TIMEOUT_MS`; the probe passes
   * `--timeout` through here. */
  timeoutMs?: number;
}

function hashString(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Maps one `git apply` result that did not exit 0 onto the reason the
 * caller reports, so a run killed by the bound above or by an abort is
 * never reported as a patch that failed to parse or to apply. Returns
 * `undefined` for a plain non-zero exit, which each call site names in
 * its own words. */
function stoppedReason(result: {
  timedOut: boolean;
  aborted: boolean;
}): { reasonCode: "git_apply_timeout" | "aborted"; label: string } | undefined {
  if (result.timedOut) {
    return { reasonCode: "git_apply_timeout", label: "hit its timeout" };
  }
  if (result.aborted) {
    return { reasonCode: "aborted", label: "was aborted" };
  }
  return undefined;
}

/** When `original` ends in a `\r` (a CRLF line) and `replacement` does
 * not already carry one, appends it so the line's terminator survives
 * the mutation instead of silently flipping that one line to LF while
 * its neighbors stay CRLF. */
function preserveTerminator(original: string, replacement: string): string {
  if (original.endsWith("\r") && !replacement.endsWith("\r")) {
    return `${replacement}\r`;
  }
  return replacement;
}

function computeReplace(
  content: string,
  line: number,
  replaceText: string,
): MutantComputeResult {
  const lines = content.split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length)
    return {
      applicable: false,
      reason: `line ${line} is out of range (file has ${lines.length} lines)`,
      logPaths: [],
    };
  const before = lines[idx];
  const after = preserveTerminator(before, replaceText);
  if (before === after)
    return {
      applicable: false,
      reason: `replacement is identical to the original line (line ${line})`,
      logPaths: [],
    };
  const newLines = lines.slice();
  newLines[idx] = after;
  const newContent = newLines.join("\n");
  return {
    applicable: true,
    before,
    after,
    newContent,
    mutatedHash: hashString(newContent),
    logPaths: [],
  };
}

function computeMatch(
  content: string,
  line: number,
  matchText: string,
  withText: string,
): MutantComputeResult {
  const lines = content.split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length)
    return {
      applicable: false,
      reason: `line ${line} is out of range (file has ${lines.length} lines)`,
      logPaths: [],
    };
  const original = lines[idx];
  const pos = original.indexOf(matchText);
  if (matchText === "")
    return {
      applicable: false,
      reason: "-M/--match text must not be empty",
      logPaths: [],
    };
  if (pos === -1)
    return {
      applicable: false,
      reason: `substring not found on line ${line}`,
      logPaths: [],
    };
  if (withText === matchText)
    return {
      applicable: false,
      reason: `replacement is identical to the matched text (line ${line})`,
      logPaths: [],
    };
  // The tail (`original.slice(pos + matchText.length)`) already carries
  // whatever terminator (bare `\n` or `\r` before the join's `\n`) the
  // original line had, so a mid-line match/replace preserves CRLF for
  // free; only the whole-line `replace` form needs `preserveTerminator`.
  const after =
    original.slice(0, pos) + withText + original.slice(pos + matchText.length);
  const newLines = lines.slice();
  newLines[idx] = after;
  const newContent = newLines.join("\n");
  return {
    applicable: true,
    before: original,
    after,
    newContent,
    mutatedHash: hashString(newContent),
    logPaths: [],
  };
}

/** First line (0-indexed within each string's own split) at which `a`
 * and `b` differ, used to render an informational before/after for the
 * `patch` form (whose real "line" is inside the diff, not the CLI's
 * `-n`). Returns empty strings when the two are identical. */
function firstDiffLine(
  a: string,
  b: string,
): { before: string; after: string } {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      return { before: aLines[i] ?? "", after: bLines[i] ?? "" };
    }
  }
  return { before: "", after: "" };
}

/** Parses `git apply --numstat` output into the list of paths the patch
 * touches (one per line: `<added>\t<deleted>\t<path>`; the path is
 * always the last tab-separated field, which also survives the `-\t-`
 * placeholder numstat uses for binary files). */
export function parseNumstatPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("\t");
      return parts[parts.length - 1];
    });
}

export interface PatchTouchedPathsListing {
  ok: true;
  /** Paths the patch touches, in `git apply --numstat` order. */
  paths: string[];
  logPath: string;
}

export interface PatchTouchedPathsFailure {
  ok: false;
  reason: string;
  reasonCode?: "mutant_not_applicable" | "git_apply_timeout" | "aborted";
  logPath: string;
}

export type PatchTouchedPathsResult =
  PatchTouchedPathsListing | PatchTouchedPathsFailure;

/**
 * Lists the paths a patch touches via `git apply --numstat`, with the
 * same argv discipline (an argv array run through `run.ts`, `--` before
 * the path, no shell) and timeout/abort handling every other `git apply`
 * in this module uses. Used by `probe/index.ts`'s `-p` derivation path,
 * which needs this listing before `--file` (and so `computePatch`
 * itself) is even known -- `computePatch` keeps its own, differently
 * shaped extra-path check once `--file` (explicit or derived) is known,
 * since that one also has to compare each touched path against it.
 *
 * Run from a scratch directory rather than the containment root: like
 * `computePatch`'s own numstat call, this only parses the patch's own
 * recorded paths and never touches disk, so `git apply --numstat` does
 * not require its cwd to be a git repository, or to contain anything the
 * patch names.
 */
export async function listPatchTouchedPaths(
  patchPath: string,
  logDir: string,
  gitApply: GitApplyOptions,
): Promise<PatchTouchedPathsResult> {
  fs.mkdirSync(logDir, { recursive: true });
  const scratchDir = fs.mkdtempSync(path.join(logDir, "patch-list-"));
  const absPatchPath = path.resolve(patchPath);
  const numstatResult = await runArgv(
    "git",
    ["apply", "--numstat", "--", absPatchPath],
    {
      cwd: scratchDir,
      logDir: scratchDir,
      timeoutMs: gitApply.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS,
      ...(gitApply.signal ? { signal: gitApply.signal } : {}),
    },
  );
  if (numstatResult.exitCode !== 0) {
    const stopped = stoppedReason(numstatResult);
    return {
      ok: false,
      reason: stopped
        ? `git apply --numstat ${stopped.label} and was killed; see ${numstatResult.logPath}`
        : `git apply --numstat failed to parse the patch; see ${numstatResult.logPath}`,
      ...(stopped ? { reasonCode: stopped.reasonCode } : {}),
      logPath: numstatResult.logPath,
    };
  }
  if (numstatResult.outputTruncated) {
    return {
      ok: false,
      reason: `git apply --numstat produced more output than can be checked for the path(s) it touches; see ${numstatResult.logPath}`,
      logPath: numstatResult.logPath,
    };
  }
  return {
    ok: true,
    paths: parseNumstatPaths(numstatResult.stdout),
    logPath: numstatResult.logPath,
  };
}

/** Parses the first hunk header (`@@ -a,b +c,d @@`) of a unified diff and
 * returns the new-file line of the hunk's first CHANGED (`+`/`-`) body
 * line -- the informational `-n` this package derives for the `patch`
 * form when the caller gives none. That is `c` (the header's new-file
 * start) plus the number of leading unchanged (` `-prefixed) context
 * lines between the header and that first `+`/`-` line: git's default 3
 * lines of context means `c` itself is usually a context line, not the
 * changed one, so returning `c` unadjusted (the pre-fix behaviour) cites
 * the wrong line whenever a hunk carries any leading context. A `\ No
 * newline at end of file` marker line is not itself a body line -- it
 * annotates the line before it -- so it is skipped without counting
 * toward the offset or ending the scan. The hunk length (`,d`, and `,b`
 * on the old side) is optional per the unified-diff grammar -- a
 * single-line hunk omits it -- so only the `+c` start is required to
 * match. Returns `undefined` when the patch has no hunk header at all
 * (e.g. a patch that only renames or touches file modes with no content
 * change). */
export function deriveLineFromPatch(patchContent: string): number | undefined {
  const match = patchContent.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/m);
  if (!match) return undefined;
  const start = Number(match[1]);
  if (!Number.isFinite(start)) return undefined;
  const headerEnd = (match.index ?? 0) + match[0].length;
  const afterHeader = patchContent.slice(headerEnd).replace(/^\r?\n/, "");
  let contextLines = 0;
  for (const line of afterHeader.split(/\r?\n/)) {
    if (line.startsWith(" ")) {
      contextLines += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" -- annotates the previous line,
      // not a body line of its own; keep scanning past it.
      continue;
    }
    break;
  }
  return start + contextLines;
}

/**
 * Dry-runs a unified diff against a scratch copy of the file (never the
 * real target) via `git apply`, so applicability (and the resulting
 * content/hash) is known before anything touches the real file or the
 * in-flight marker is written. `git apply` does not require the scratch
 * directory to itself be a git repository.
 *
 * Every `git apply` here runs through `run.ts`: an argv array and no
 * shell at all. The patch path comes from the caller, and a path
 * containing `$(...)` or a backtick is executed by `sh -c` even inside
 * double quotes, so there is no quoting of it into a shell string that
 * would be safe. Each argv puts `--` before that path, so a patch file
 * whose name begins with a dash reaches `git apply` as a path and not as
 * an option; the argv shapes are pinned by a unit test.
 *
 * The scratch copy only ever seeds `--file`'s own relative path, so a
 * patch that also touches other paths would apply cleanly here (`git
 * apply` happily creates new files) while a real apply against the
 * repository root would go on to create/modify those other paths for
 * real, with nothing to restore them afterward. `git apply --numstat`
 * lists every path the patch touches; anything other than `--file`'s own
 * relative path makes the whole patch `mutant_not_applicable`.
 *
 * That check runs BEFORE the dry run, because it is the more specific
 * diagnosis and it does not depend on the scratch directory's contents.
 * A patch that modifies a second file which exists in the repository but
 * was never seeded into the scratch copy fails the dry run outright, and
 * running the dry run first would report that as "the patch did not
 * apply" when the real answer is that it touches paths other than
 * `--file`.
 */
async function computePatch(
  originalContent: string,
  absFile: string,
  root: string,
  patchPath: string,
  logDir: string,
  gitApply: GitApplyOptions,
): Promise<MutantComputeResult> {
  const relPath = path.relative(root, absFile);
  fs.mkdirSync(logDir, { recursive: true });
  const scratchDir = fs.mkdtempSync(path.join(logDir, "mutant-dry-run-"));
  const scratchFile = path.join(scratchDir, relPath);
  fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
  fs.writeFileSync(scratchFile, originalContent);

  const absPatchPath = path.resolve(patchPath);
  const runOptions = {
    logDir: scratchDir,
    timeoutMs: gitApply.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS,
    ...(gitApply.signal ? { signal: gitApply.signal } : {}),
  };
  const numstatResult = await runArgv(
    "git",
    ["apply", "--numstat", "--", absPatchPath],
    { cwd: scratchDir, ...runOptions },
  );
  if (numstatResult.exitCode !== 0) {
    const stopped = stoppedReason(numstatResult);
    return {
      applicable: false,
      reason: stopped
        ? `git apply --numstat ${stopped.label} and was killed; see ${numstatResult.logPath}`
        : `git apply --numstat failed to parse the patch; see ${numstatResult.logPath}`,
      ...(stopped ? { reasonCode: stopped.reasonCode } : {}),
      logPaths: [numstatResult.logPath],
    };
  }
  // The extra-path check below is only a check while it sees the whole
  // listing: a truncated one could hide the very path that makes the
  // patch unsafe, so a patch whose numstat output does not fit is
  // refused rather than half-checked.
  if (numstatResult.outputTruncated) {
    return {
      applicable: false,
      reason: `git apply --numstat produced more output than can be checked for paths other than --file; see ${numstatResult.logPath}`,
      logPaths: [numstatResult.logPath],
    };
  }
  const touchedPaths = parseNumstatPaths(numstatResult.stdout);
  const extraPaths = touchedPaths.filter((p) => p !== relPath);
  if (extraPaths.length > 0) {
    return {
      applicable: false,
      reason:
        `patch touches paths other than --file (${relPath}): ` +
        extraPaths.join(", "),
      logPaths: [numstatResult.logPath],
    };
  }

  const result = await runArgv("git", ["apply", "--", absPatchPath], {
    cwd: scratchDir,
    ...runOptions,
  });
  const logPaths = [numstatResult.logPath, result.logPath];
  if (result.exitCode !== 0) {
    const stopped = stoppedReason(result);
    return {
      applicable: false,
      reason: stopped
        ? `the dry-run git apply ${stopped.label} and was killed; see ${result.logPath}`
        : `patch did not apply cleanly; see ${result.logPath}`,
      ...(stopped ? { reasonCode: stopped.reasonCode } : {}),
      logPaths,
    };
  }

  const newContent = fs.readFileSync(scratchFile, "utf8");
  if (newContent === originalContent)
    return {
      applicable: false,
      reason: "patch applied cleanly but produced no content change",
      logPaths,
    };
  const { before, after } = firstDiffLine(originalContent, newContent);
  return {
    applicable: true,
    before,
    after,
    newContent,
    mutatedHash: hashString(newContent),
    logPaths,
  };
}

export interface ComputeMutantOptions extends GitApplyOptions {
  /** Containment root, used to resolve the patch form's relative path. */
  root: string;
  /** Scratch space for the patch form's dry run. */
  logDir: string;
  /** The target file's current (pre-mutation) content. */
  originalContent: string;
}

/** Computes what a mutant would do without ever touching the real
 * target file: for `replace`/`match` this is pure string manipulation,
 * for `patch` it is a `git apply` dry run against a scratch copy. */
export function computeMutant(
  spec: MutantSpec,
  opts: ComputeMutantOptions,
): Promise<MutantComputeResult> {
  switch (spec.form) {
    case "replace":
      return Promise.resolve(
        computeReplace(opts.originalContent, spec.line, spec.replaceText ?? ""),
      );
    case "match":
      return Promise.resolve(
        computeMatch(
          opts.originalContent,
          spec.line,
          spec.matchText ?? "",
          spec.withText ?? "",
        ),
      );
    case "patch":
      return computePatch(
        opts.originalContent,
        spec.file,
        opts.root,
        spec.patchPath ?? "",
        opts.logDir,
        { signal: opts.signal, timeoutMs: opts.timeoutMs },
      );
  }
}

/** Applies an already-validated `patch` mutant to the real target file
 * via `git apply`, run through `run.ts` (an argv array, no shell) so the
 * invocation is logged like every other command this package runs and the
 * patch path can never be read as shell syntax. `gitApply.signal` is what
 * keeps an interrupted apply from landing on the target after the
 * caller's emergency restore has already put the original back. */
export function applyPatchForReal(
  patchPath: string,
  root: string,
  logDir: string,
  gitApply: GitApplyOptions = {},
) {
  const absPatchPath = path.resolve(patchPath);
  return runArgv("git", ["apply", "--", absPatchPath], {
    cwd: root,
    logDir,
    timeoutMs: gitApply.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS,
    ...(gitApply.signal ? { signal: gitApply.signal } : {}),
  });
}

/** Formats the `mutant: "<file>:<line>: <before> -> <after>"` string
 * used verbatim as `mutation_probe.mutant`. */
export function formatMutantSummary(
  file: string,
  line: number,
  before: string,
  after: string,
): string {
  return `${file}:${line}: ${before} -> ${after}`;
}

/** A short, fixed-shape (three lines) snippet proving the mutant was
 * really applied: the file:line header, the original line, and the
 * mutated line. */
export function formatVerifiedAppliedVia(
  file: string,
  line: number,
  before: string,
  after: string,
): string {
  return [`${file}:${line}`, `- ${before}`, `+ ${after}`].join("\n");
}
