import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runArgv } from "./run.js";

export type MutantForm = "replace" | "match" | "patch";

export interface MutantSpec {
  form: MutantForm;
  /** Absolute path of the target file. */
  file: string;
  /** 1-indexed line number of the line to mutate. Required for
   * `replace` and `match`, which mutate exactly that line; the `patch`
   * form does not read it at all, since which line a patch changes is
   * decided by the patch, not by the caller -- `computeMutant` reports
   * that line back as `MutantComputed.line`. */
  line?: number;
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
  /** 1-indexed line this mutant actually changes, and the line `before`
   * and `after` below quote: the requested `line` for `replace` and
   * `match`, and for `patch` the first line at which the applied result
   * differs from the original -- what `git apply` did, not what a
   * reading of the patch text predicted it would do. Reported as
   * `mutant.line` and in the `mutation_probe` strings, so the line
   * number and the quoted content can never disagree. */
  line: number;
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

/**
 * Upper bound on how large a `-p/--patch` file `probe/index.ts` accepts
 * at all: the `patch_not_readable` `stat` that runs once, before the
 * `--file` derivation's `git apply --numstat` and before the lock, the
 * marker, or any worktree exists. Nothing in this process reads the
 * patch's bytes; the bound is on what gets handed to `git apply`, so a
 * caller who points `-p` at a multi-gigabyte file is told so up front
 * instead of waiting on a child parsing it. Neither of this package's
 * own existing subprocess-output caps is a byte-sized file cap that this
 * value could reuse directly: `src/exec.ts` streams a child's
 * stdout/stderr with no cap of its own, and `src/probe/run.ts`'s
 * `MAX_CAPTURED_CHARS` (1,000,000) bounds captured subprocess
 * *characters*, not bytes of an input file. So this falls back to a flat
 * 8 MiB.
 */
export const PATCH_MAX_BYTES = 8 * 1024 * 1024;

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
    line,
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
    line,
    before: original,
    after,
    newContent,
    mutatedHash: hashString(newContent),
    logPaths: [],
  };
}

/**
 * The first line at which `a` and `b` differ: its 1-indexed number in
 * `a` plus that line's content on each side. This is what the `patch`
 * form reports as `mutant.line`/`before`/`after`, and the three come
 * from this one comparison so they cannot disagree with each other:
 * `line` is by construction the index at which `before` was taken from
 * `a`.
 *
 * Comparison is exact -- whole lines, no trimming -- so a change that
 * only adds or removes trailing whitespace is a difference like any
 * other, and lines are split on `"\n"` alone (never `/\r?\n/`), so in a
 * CRLF file both sides keep their `\r` and a line whose only change is
 * its terminator still differs.
 *
 * `undefined` means the two are identical, which for a dry run means
 * the patch applied but changed nothing: the same condition as
 * `a === b`, since splitting on `"\n"` and rejoining is lossless.
 *
 * When the first difference lies past `a`'s last line (a patch that
 * appends to a file with no trailing newline), `line` is one past
 * `a`'s line count and `before` is the empty string: the original has
 * no such line, so there is nothing to quote.
 */
function firstDiffLine(
  a: string,
  b: string,
): { line: number; before: string; after: string } | undefined {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      return {
        line: i + 1,
        before: aLines[i] ?? "",
        after: bLines[i] ?? "",
      };
    }
  }
  return undefined;
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
 *
 * The reported `line` comes from this dry run's own result too (the
 * first line at which the applied content differs from the original),
 * not from reading the patch text: the applied file is the ground truth
 * for which line a patch changes, and taking `line`, `before` and
 * `after` from one comparison is what keeps the reported number and the
 * quoted content from ever naming different lines.
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

  // `-c core.autocrlf=false`: the scratch directory has no `.git` of its
  // own, so without this it inherits whichever ambient global/system
  // git config the machine running this happens to have. Under a global
  // `core.autocrlf = true` (a common Windows default), this write would
  // otherwise convert the scratch file's LF endings to CRLF as `git
  // apply` writes it -- corrupting the very content `newContent` below
  // reads back and compares against `originalContent` (measured:
  // spurious differences from the first line on, not just the hunk's
  // own change). Pinned here rather than relying on the caller's own
  // repository config, since the scratch copy is not that repository.
  // `-c apply.whitespace=nowarn` for the same reason: under a global
  // `apply.whitespace = fix`, `git apply` would strip trailing
  // whitespace the patch adds, so a whitespace-only mutant would read
  // back as "no content change" on that machine and not on another.
  const result = await runArgv(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "apply.whitespace=nowarn",
      "apply",
      "--",
      absPatchPath,
    ],
    { cwd: scratchDir, ...runOptions },
  );
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
  // One comparison of the applied result against the original answers
  // both questions at once: `undefined` is "the patch changed nothing"
  // (identical content), and otherwise the line it names IS the line
  // this mutant changes -- there is no second, text-level reading of the
  // patch that could disagree with what `git apply` actually did.
  const diff = firstDiffLine(originalContent, newContent);
  if (diff === undefined)
    return {
      applicable: false,
      reason: "patch applied cleanly but produced no content change",
      logPaths,
    };
  return {
    applicable: true,
    line: diff.line,
    before: diff.before,
    after: diff.after,
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
 * for `patch` it is a `git apply` dry run against a scratch copy.
 *
 * `spec.line ?? 0` on the two forms that need a line follows the same
 * shape as `spec.replaceText ?? ""` beside it: an optional field a form
 * requires, defaulted to a value that form itself refuses (line 0 is out
 * of range for any file), so a spec missing it is a not-applicable
 * result naming the problem rather than a crash. `probe()` never
 * produces such a spec -- it returns `line_required` first. */
export function computeMutant(
  spec: MutantSpec,
  opts: ComputeMutantOptions,
): Promise<MutantComputeResult> {
  switch (spec.form) {
    case "replace":
      return Promise.resolve(
        computeReplace(
          opts.originalContent,
          spec.line ?? 0,
          spec.replaceText ?? "",
        ),
      );
    case "match":
      return Promise.resolve(
        computeMatch(
          opts.originalContent,
          spec.line ?? 0,
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
