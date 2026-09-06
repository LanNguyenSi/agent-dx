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
  /** The applied change's full, bounded diff excerpt, present only for
   * a `patch` mutant whose change `line`/`before`/`after` alone would
   * not already show in full: attached whenever the applied change is
   * anything other than exactly one hunk with exactly one removed and
   * one added line -- the only shape `before`/`after` actually covers
   * (a like-for-like line replacement). A one-hunk change that only
   * removes a line, only adds a line, or removes/adds more than one
   * line each gets `diff` too, since `before`/`after` alone would name
   * an unrelated, untouched neighbouring line in those shapes (see
   * `computePatch`'s own comment beside the gate). Absent for
   * `replace`/`match` (which only ever change the one line
   * `before`/`after` already quote) and for a single-hunk,
   * single-line-replacement `patch` mutant (the same case), so every
   * existing single-line result -- and the identity fixture built from
   * one -- stays byte-identical. See `computeAppliedDiffExcerpt`. */
  diff?: MutantDiffField;
  /** Set when a multi-line patch's applied-diff excerpt could not be
   * computed, or had to be refused (an unreadable `git diff` exit, its
   * own output too large to read back in full), even though `diff`
   * would otherwise have been attached: `step.ts` folds this into the
   * result's own `warnings`, so a missing `diff` is never silent. Never
   * set when `diff` is present, and never set for the ordinary
   * single-line-replacement case (`diff` is correctly absent there,
   * with nothing to warn about). */
  diffWarning?: string;
}

/** `MutantComputed.diff`: the SINGLE carrier of the applied change's
 * excerpt. `mutation_probe.verified_applied_via` never repeats this
 * field's own `text`; it points at this field instead (a short,
 * bounded descriptor -- see `formatVerifiedAppliedVia`), so a multi-line
 * patch's diff exists exactly once in a result, never duplicated across
 * two fields that a bounded envelope then has to fit twice over. See
 * `MutantComputed.diff`'s own docblock for when this field is present
 * at all. */
export interface MutantDiffField {
  /** A `git diff --no-index --unified=0` body: the `--- `/`+++ ` file
   * lines and every `@@ ... @@` hunk with its added/removed lines; no
   * context lines (the point is which lines changed, not the lines
   * around them) and no leading `diff --git `/`index ` lines (they would
   * only name this comparison's own throwaway scratch paths and a blob
   * hash from a repository that does not exist). Bounded to
   * `DIFF_EXCERPT_MAX_LINES`/`DIFF_EXCERPT_MAX_CHARS`, cut to whole
   * hunks (never mid-hunk: a hunk is kept only once every line its own
   * `@@ -a,b +c,d @@` header declares is present) when the applied
   * change is bigger than that, with `truncated` set. `buildEnvelope`'s
   * own generic string cap can still cut this further once the result
   * reaches `cli.ts` (it knows nothing about hunks); `cli.ts` calls
   * `reconcileEnvelopeDiffTruncation` on the built envelope to correct
   * that case the same way -- trimmed back to the last hunk it can
   * prove is fully present, `truncated` set -- so `truncated: false`
   * can never sit beside text the envelope itself cut. */
  text: string;
  /** Every hunk the applied change produced, counted before any
   * truncation and never revised afterward (by either bound), so it
   * always names the true total even when `text` shows only a prefix of
   * it. */
  hunkCount: number;
  /** Every removed line the applied change produced, summed from each
   * hunk's own `@@ -a,b +c,d @@` header (never from sniffing `text`'s
   * own `-` prefixes -- a removed line that itself starts with `-- `
   * would otherwise be missed), counted before any truncation. */
  removed: number;
  /** Every added line, the `+c,d` half of the same header sum,
   * `addedCount`'s counterpart to `removed` above. */
  added: number;
  /** `removed + added`. Named in `formatMutantSummary`'s one-line
   * summary alongside the hunk count, so "first of 1 hunks" can never
   * read as "the whole change was one line" for a hunk that in fact
   * replaced several. */
  changedLineCount: number;
  truncated: boolean;
}

/**
 * The bound on `MutantDiffField.text`: the result stays one bounded JSON
 * object, so a patch that changes hundreds of lines gets a clearly
 * truncated excerpt (the earliest whole hunks, `truncated: true`,
 * `hunkCount` still the true total) rather than an unbounded dump.
 * Sized well past what an actual multi-hunk mutation-probe patch needs
 * to prove its hunks are not just the first one (the fixture this bound
 * is tested against uses three, each two lines), while still being far
 * below `PATCH_MAX_BYTES`.
 *
 * This bound alone does not guarantee `verified_applied_via`/`text`
 * survive `envelope.ts`'s own `DEFAULT_MAX_CHARS` (8,000) unmodified --
 * a large `--plan` batch, several such excerpts each near this bound,
 * or a caller-supplied `-m`/`--max-chars` below it can all still make
 * `buildEnvelope`'s own generic string/array reduction cut a `diff.text`
 * further. That is why the guarantee is not "size this bound small
 * enough that the envelope never touches it" (which cannot be sized
 * once `-m` is the caller's to set): `cli.ts` calls
 * `reconcileEnvelopeDiffTruncation` on the BUILT envelope, after
 * `buildEnvelope` has already run, and corrects exactly that case --
 * see that function's own docblock. This bound instead exists so the
 * common case (the default budget, a handful of mutants) needs no
 * correction at all: 3,000 characters / 100 lines leaves ample room in
 * the default envelope budget for the rest of one `mutation_probe`
 * entry (the fixed envelope fields, `mutant`, the short
 * `verified_applied_via` descriptor that now points at this field
 * instead of repeating it, and its siblings in a `--plan` batch); see
 * `test/mutant.test.ts`'s envelope-delivery tests. Deliberately its own
 * constants rather than `exec.ts`'s `TAIL_CHARS`/`TAIL_LINES`: those
 * keep a subprocess output's TAIL (the most recent lines), while a diff
 * excerpt keeps its HEAD (the earliest hunks) -- the two bounds happen
 * to hold the same shape of value (a capped text blob) for unrelated
 * reasons and are not meant to move together.
 */
export const DIFF_EXCERPT_MAX_LINES = 100;
export const DIFF_EXCERPT_MAX_CHARS = 3_000;

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

/** Global git settings that can rewrite content while a probe's own git
 * command writes it. These are command-line settings because a scratch
 * directory and a detached worktree must not depend on the caller's
 * repository config. Shared with worktree setup so its checkout and
 * tracked-diff apply cannot drift from either patch apply. */
export const GIT_CONTENT_WRITE_CONFIG_ARGS = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "apply.whitespace=nowarn",
] as const;

/** Global git settings pinned for the `git diff --no-index` this module
 * runs to read an applied change back (`computeAppliedDiffExcerpt`),
 * the read-side counterpart to `GIT_CONTENT_WRITE_CONFIG_ARGS` above:
 * a scratch directory with no `.git` of its own inherits whichever
 * ambient global/system git config the machine happens to have.
 * `core.autocrlf=false` for the same corruption `GIT_CONTENT_WRITE_CONFIG_ARGS`
 * documents on the write side (a CRLF mutant must compare equal to
 * itself regardless of which machine runs this). `diff.noprefix=false`
 * keeps the `--- `/`+++ ` header shape `computeAppliedDiffExcerpt`'s own
 * `before/`/`after/` naming depends on; under a global `diff.noprefix =
 * true` the excerpt would otherwise have no `a/`/`b/`-style prefix to
 * strip in the first place, which is harmless here but is pinned for
 * the same "never depend on ambient config" reason as the rest. The
 * call additionally passes `--no-ext-diff` as an argument (not a `-c`)
 * to the `git diff` invocation itself, so a global `diff.external`
 * cannot divert the comparison to an external tool this process never
 * inspects -- which would otherwise make the excerpt silently vanish
 * (an empty result, no warning) rather than fail loudly. `--no-textconv`
 * sits beside it for a narrower hostile config `--no-ext-diff` alone
 * does not cover: a `diff.<driver>.textconv` assigned via a
 * `core.attributesFile`/`.gitattributes` entry runs even with
 * `--no-ext-diff`, converting `before/`/`after/`'s content before the
 * comparison and fabricating hunks from the converted content instead
 * of what `git apply` actually wrote -- silently (`git diff` still
 * exits normally; there is nothing here for a warning to catch). */
export const GIT_DIFF_READ_CONFIG_ARGS = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "diff.noprefix=false",
] as const;

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
/**
 * Computes `MutantComputed.diff` for a `patch` mutant: a
 * `git diff --no-index --unified=0` between two scratch copies of
 * `originalContent` and `newContent` -- never the patch file's own
 * bytes, the same invariant `patchUnusableReason`'s docblock documents
 * (this process never reads a `-p/--patch` path's content; `git apply`,
 * a child process, is what does). The two copies both use `relPath`'s
 * basename, one under a `before/` and one under an `after/` scratch
 * subdirectory, so the diff's own `--- `/`+++ ` header lines read as
 * "before/<name>" and "after/<name>" rather than two arbitrary temp
 * paths.
 *
 * `--unified=0` (no context lines) is deliberate: this excerpt exists to
 * show which lines changed, not the lines around them, and every context
 * line would spend the same bound the changed lines do. The invocation
 * pins `GIT_DIFF_READ_CONFIG_ARGS` plus `--no-ext-diff`/`--no-textconv`
 * (see that constant's own docblock) so ambient git config cannot make
 * the excerpt vanish or misrepresent it the way it could for the
 * write-side `git apply` calls.
 *
 * Returns a `warning` string instead of the excerpt on anything that
 * keeps this from computing correctly: a scratch directory that could
 * not be created or written, a `git` too old for `--no-index`, any
 * other non-0/1 exit, the comparison reporting zero hunks despite the
 * caller's own comparison already finding a difference, the `git diff`
 * output itself having been too large to read back in full (its own
 * `outputTruncated`, which would make `hunkCount` an undercount rather
 * than the true total the field promises), or any other exception the
 * body throws (this whole function's body runs under one `try`, not
 * only the `mkdtemp` call, so a write failure past that point cannot
 * escape as an unhandled rejection either). The caller already knows
 * the two contents differ from its own comparison, so a failure here
 * only means the extra excerpt is unavailable, never that the mutant
 * itself is inconclusive -- but it is never silent: the caller folds
 * `warning` into `MutantComputed.diffWarning`, which `step.ts` reports
 * alongside the result. The `before`/`after` scratch copies (the raw
 * file content, not the exec log inside the same scratch directory)
 * are removed once `git diff` has read them back, on every path out of
 * this function; the log itself is left in place, since a caller that
 * keeps this excerpt's `logPath` in `logPaths` must still be able to
 * open it.
 */
async function computeAppliedDiffExcerpt(
  originalContent: string,
  newContent: string,
  relPath: string,
  logDir: string,
  runOptions: { logDir: string; timeoutMs: number; signal?: AbortSignal },
): Promise<
  | {
      text: string;
      hunkCount: number;
      removedCount: number;
      addedCount: number;
      truncated: boolean;
      logPath: string;
    }
  | { warning: string }
> {
  let diffDir: string;
  try {
    diffDir = fs.mkdtempSync(path.join(logDir, "mutant-diff-"));
  } catch (err) {
    return {
      warning:
        "could not create a scratch directory for the applied-diff " +
        `excerpt (${errorMessage(err)}); mutation_probe.mutant/` +
        "verified_applied_via fall back to the first changed line only",
    };
  }
  const base = path.basename(relPath) || "file";
  const beforeDir = path.join(diffDir, "before");
  const afterDir = path.join(diffDir, "after");
  const cleanupScratchContent = (): void => {
    fs.rmSync(beforeDir, { recursive: true, force: true });
    fs.rmSync(afterDir, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(beforeDir, { recursive: true });
    fs.mkdirSync(afterDir, { recursive: true });
    fs.writeFileSync(path.join(beforeDir, base), originalContent);
    fs.writeFileSync(path.join(afterDir, base), newContent);
    const diffResult = await runArgv(
      "git",
      [
        ...GIT_DIFF_READ_CONFIG_ARGS,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-index",
        "--unified=0",
        "--",
        `before/${base}`,
        `after/${base}`,
      ],
      { ...runOptions, cwd: diffDir, logDir: diffDir },
    );
    cleanupScratchContent();
    // `git diff --no-index` exits 0 for "no difference" (unreachable
    // here: the caller only calls this once its own comparison already
    // found one), 1 for "differences found" (the expected case), and
    // anything else for a failure this excerpt cannot recover from.
    if (diffResult.exitCode !== 0 && diffResult.exitCode !== 1) {
      return {
        warning:
          "the applied-diff excerpt's own `git diff --no-index` exited " +
          `${String(diffResult.exitCode)} unexpectedly; see ${diffResult.logPath}`,
      };
    }
    if (diffResult.outputTruncated) {
      return {
        warning:
          "the applied-diff excerpt's own `git diff --no-index` produced " +
          "more output than could be read back in full, so its hunk " +
          `count could not be trusted; see ${diffResult.logPath}`,
      };
    }
    const bodyLines = diffResult.stdout
      .split("\n")
      .filter(
        (line) => !line.startsWith("diff --git ") && !line.startsWith("index "),
      );
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
      bodyLines.pop();
    }
    const { preamble, hunks } = splitDiffBody(bodyLines);
    if (hunks.length === 0) {
      return {
        warning:
          "the applied-diff excerpt's own `git diff --no-index` reported " +
          `no hunks for a change already known to differ; see ${diffResult.logPath}`,
      };
    }
    let removedCount = 0;
    let addedCount = 0;
    for (const hunk of hunks) {
      // Every hunk's first line is its own header, by construction of
      // `splitDiffBody` (it only ever starts a new hunk there); the
      // `undefined` branch is unreachable in practice and only keeps
      // the arithmetic below from widening to `number | undefined`.
      const counts = parseHunkHeaderCounts(hunk[0]);
      if (counts === undefined) continue;
      removedCount += counts.removed;
      addedCount += counts.added;
    }
    const { text, truncated } = buildBoundedHunkExcerpt(
      preamble,
      hunks,
      DIFF_EXCERPT_MAX_LINES,
      DIFF_EXCERPT_MAX_CHARS,
    );
    return {
      text,
      hunkCount: hunks.length,
      removedCount,
      addedCount,
      truncated,
      logPath: diffResult.logPath,
    };
  } catch (err) {
    cleanupScratchContent();
    return {
      warning:
        "computing the applied-diff excerpt failed " +
        `(${errorMessage(err)}); mutation_probe.mutant/verified_applied_via ` +
        "fall back to the first changed line only",
    };
  }
}

/** `err instanceof Error ? err.message : String(err)`, named so every
 * `computeAppliedDiffExcerpt` warning reads the same way regardless of
 * what was thrown. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parses one `git diff --unified=0` hunk header (`@@ -a,b +c,d @@`,
 * either count's `,N` omitted meaning `1`) into the old/new line counts
 * it declares. Under `--unified=0` there are no context lines, so a
 * hunk's declared old count IS its removed-line count and its declared
 * new count IS its added-line count -- reading them off the header
 * avoids sniffing `+`/`-` prefixes on the body lines themselves, which
 * would miscount a removed line that itself starts with `-- ` or an
 * added line starting with `++ `. Returns `undefined` for a non-header
 * line. */
function parseHunkHeaderCounts(
  line: string,
): { removed: number; added: number } | undefined {
  const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  if (match === null) return undefined;
  return {
    removed: match[1] === undefined ? 1 : Number(match[1]),
    added: match[2] === undefined ? 1 : Number(match[2]),
  };
}

/** Splits a `git diff --unified=0` body (already filtered of the
 * leading `diff --git `/`index ` lines) into its leading `preamble`
 * (the `--- `/`+++ ` file lines, kept whole and always ahead of every
 * hunk) and one array per hunk: each hunk's own `@@ ... @@` header line
 * followed by every line up to (not including) the next header. This is
 * what lets the excerpt's own truncation below cut only at hunk
 * boundaries -- a hunk is an atomic unit here, never split across the
 * cut, and the preamble is never mistaken for part of one. */
function splitDiffBody(bodyLines: string[]): {
  preamble: string[];
  hunks: string[][];
} {
  const preamble: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | undefined;
  for (const line of bodyLines) {
    if (parseHunkHeaderCounts(line) !== undefined) {
      current = [line];
      hunks.push(current);
    } else if (current !== undefined) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, hunks };
}

/**
 * Keeps `preamble` whole and as many of `hunks`, in order, as fit
 * within `maxLines`/`maxChars` alongside it -- WHOLE hunks only, never
 * a prefix of one, so a truncated excerpt always ends at a hunk
 * boundary rather than mid-hunk. Always keeps at least the first hunk,
 * even when it alone (plus the preamble) already exceeds the bound:
 * reporting zero hunks would say less than reporting one hunk over
 * budget, and a caller past this (`buildEnvelope`'s own generic string
 * cap, then `reconcileEnvelopeDiffTruncation` correcting that) still
 * bounds the result overall. Joins exactly the way the excerpt's own
 * `text` always has: `preamble` and every kept hunk, each already its
 * own `"\n"`-joined block, joined to each other by `"\n"` in turn.
 */
function buildBoundedHunkExcerpt(
  preamble: string[],
  hunks: string[][],
  maxLines: number,
  maxChars: number,
): { text: string; truncated: boolean } {
  const preambleText = preamble.join("\n");
  if (hunks.length === 0) return { text: preambleText, truncated: false };
  let kept = 1;
  let lineTotal = preamble.length + hunks[0].length;
  let charTotal =
    (preamble.length > 0 ? preambleText.length + 1 : 0) +
    hunks[0].join("\n").length;
  for (let i = 1; i < hunks.length; i++) {
    const hunkLines = hunks[i].length;
    const hunkChars = hunks[i].join("\n").length;
    const nextLineTotal = lineTotal + hunkLines;
    // `+ 1` for the "\n" that joins this hunk to the previous one.
    const nextCharTotal = charTotal + 1 + hunkChars;
    if (nextLineTotal > maxLines || nextCharTotal > maxChars) break;
    lineTotal = nextLineTotal;
    charTotal = nextCharTotal;
    kept++;
  }
  const keptHunksText = hunks
    .slice(0, kept)
    .map((h) => h.join("\n"))
    .join("\n");
  return {
    text:
      preamble.length > 0 ? `${preambleText}\n${keptHunksText}` : keptHunksText,
    truncated: kept < hunks.length,
  };
}

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
    [...GIT_CONTENT_WRITE_CONFIG_ARGS, "apply", "--", absPatchPath],
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
  // The multi-hunk excerpt (and the extra `git diff --no-index` call
  // that computes it) is skipped outright when `originalContent` and
  // `newContent` are already known to be a single-line change: same
  // line count, exactly one differing index. That is the common case
  // (and every existing patch-mutant test fixture, including the
  // identity fixture), so it keeps its exact previous log/argv
  // footprint -- no extra subprocess call, no `diff` field -- rather
  // than paying for an excerpt that would only ever be discarded.
  const singleLineChange = isSingleLineChange(originalContent, newContent);
  const excerptResult = singleLineChange
    ? undefined
    : await computeAppliedDiffExcerpt(
        originalContent,
        newContent,
        relPath,
        logDir,
        runOptions,
      );
  const excerpt =
    excerptResult !== undefined && !("warning" in excerptResult)
      ? excerptResult
      : undefined;
  const excerptWarning =
    excerptResult !== undefined && "warning" in excerptResult
      ? excerptResult.warning
      : undefined;
  // Attached unless the excerpt itself reports exactly one hunk with
  // exactly one removed and one added line: the one shape `before`/
  // `after` (this mutant's first changed line alone) actually covers
  // completely (a like-for-like line replacement). Every other shape --
  // a one-hunk pure deletion, a one-hunk pure insertion, or several
  // hunks -- gets `diff`, since `before`/`after` alone would otherwise
  // quote an untouched neighbouring line that only looks like the
  // mutation because the surrounding lines shifted (a removed/inserted
  // line moves every line after it up or down by one, so a naive
  // line-by-line comparison finds its first disagreement on a line
  // neither the patch nor `git apply` actually touched).
  const diffField: MutantDiffField | undefined =
    excerpt !== undefined &&
    !(
      excerpt.hunkCount === 1 &&
      excerpt.removedCount === 1 &&
      excerpt.addedCount === 1
    )
      ? {
          text: excerpt.text,
          hunkCount: excerpt.hunkCount,
          removed: excerpt.removedCount,
          added: excerpt.addedCount,
          changedLineCount: excerpt.removedCount + excerpt.addedCount,
          truncated: excerpt.truncated,
        }
      : undefined;
  return {
    applicable: true,
    line: diff.line,
    before: diff.before,
    after: diff.after,
    newContent,
    mutatedHash: hashString(newContent),
    logPaths:
      diffField !== undefined && excerpt !== undefined
        ? [...logPaths, excerpt.logPath]
        : logPaths,
    ...(diffField !== undefined ? { diff: diffField } : {}),
    ...(excerptWarning !== undefined ? { diffWarning: excerptWarning } : {}),
  };
}

/** Cheap pre-check, no `git` call: true when `a` and `b` have the same
 * number of lines and differ at exactly one index. Every single-line
 * `replace`/`match` mutant is this by construction, and so is a `patch`
 * mutant whose hunk replaces one line with another -- the case
 * `before`/`after` already covers completely, which is what lets
 * `computePatch` skip `computeAppliedDiffExcerpt`'s `git diff` call for
 * it rather than computing an excerpt only to discard it. An insertion
 * or deletion (a line-count change) is never this, even when it is the
 * only line touched, since there is no single index for both to differ
 * at only once. */
function isSingleLineChange(a: string, b: string): boolean {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  if (aLines.length !== bLines.length) return false;
  let differences = 0;
  for (let i = 0; i < aLines.length; i++) {
    if (aLines[i] !== bLines[i]) {
      differences++;
      if (differences > 1) return false;
    }
  }
  return differences === 1;
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
  return runArgv(
    "git",
    [...GIT_CONTENT_WRITE_CONFIG_ARGS, "apply", "--", absPatchPath],
    {
      cwd: root,
      logDir,
      timeoutMs: gitApply.timeoutMs ?? DEFAULT_GIT_APPLY_TIMEOUT_MS,
      ...(gitApply.signal ? { signal: gitApply.signal } : {}),
    },
  );
}

/** `n === 1 ? singular : plural`, so a hunk/changed-line count of
 * exactly one never reads as "1 hunks" / "1 changed lines". */
function pluralizeCount(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/**
 * Formats the `mutant: "<file>:<line>: <before> -> <after>"` string
 * used verbatim as `mutation_probe.mutant`. When `diff` is given (a
 * patch mutant whose change spans more than the one line `before`/
 * `after` already quote), a trailing note names the true changed-line
 * count alongside the hunk count -- so a single multi-line hunk (e.g.
 * "first of 4 changed lines across 1 hunk") is never misread as "the
 * whole change was one line" the way a hunk count alone would read --
 * and, when the excerpt itself had to be cut, that it was truncated;
 * this one line can never be read as the whole mutant on its own, see
 * `mutant.diff` (`MutantDiffField.text`, the sole carrier) for the full
 * excerpt.
 *
 * When `diff.removed !== diff.added`, the `before -> after` pair itself
 * is dropped rather than shown alongside the note: an unequal count
 * means the two do not correspond to each other one for one (a pure
 * deletion's `after` is really the next, untouched line the deletion
 * shifted up; a pure insertion's `before` is really the same line
 * shifted down; a mixed edit has no single pair at all -- see
 * `MutantComputed.diff`'s own docblock on why `before`/`after` can name
 * an untouched neighbour in these shapes). Only the side this mutant
 * actually introduced or removed is quoted. The pair form survives only
 * when `removed === added` (including the `=== 1` case `diff` is never
 * attached for at all, and the multi-hunk/multi-line cases where the
 * two sides are equal in count even if not truly a byte-for-byte
 * correspondence).
 */
export function formatMutantSummary(
  file: string,
  line: number,
  before: string,
  after: string,
  diff?: MutantDiffField,
): string {
  if (diff === undefined) return `${file}:${line}: ${before} -> ${after}`;
  const lineWord = pluralizeCount(
    diff.changedLineCount,
    "changed line",
    "changed lines",
  );
  const hunkWord = pluralizeCount(diff.hunkCount, "hunk", "hunks");
  // "first of" only when there is more than the one line quoted to be
  // first OF: at exactly one changed line, the quote already is the
  // whole change, and "first of 1 changed line" would read as if more
  // followed.
  const prefix = diff.changedLineCount > 1 ? "first of " : "";
  const tail =
    `(${prefix}${String(diff.changedLineCount)} ${lineWord} across ` +
    `${String(diff.hunkCount)} ${hunkWord}; see mutant.diff` +
    `${diff.truncated ? ", truncated" : ""})`;
  if (diff.removed !== diff.added) {
    if (diff.added === 0) return `${file}:${line}: ${before} removed ${tail}`;
    if (diff.removed === 0) return `${file}:${line}: ${after} added ${tail}`;
    return `${file}:${line}: ${before} changed ${tail}`;
  }
  return `${file}:${line}: ${before} -> ${after} ${tail}`;
}

/**
 * A short, bounded descriptor pointing at the excerpt, never a copy of
 * it: `mutant.diff.text` (`MutantDiffField`'s own docblock) is the
 * SINGLE carrier of a multi-line patch's applied diff, so this string
 * never repeats it -- a result carrying the excerpt twice is exactly
 * the defect this redesign removes (see the CHANGELOG). When `diff` is
 * undefined (every `replace`/`match` mutant, and a `patch` mutant whose
 * change is the one like-for-like line replacement `before`/`after`
 * already cover), this is unchanged from before: the file:line header
 * plus the original and mutated line, three lines, byte-identical to
 * every existing fixture built from that case.
 */
export function formatVerifiedAppliedVia(
  file: string,
  line: number,
  before: string,
  after: string,
  diff?: MutantDiffField,
): string {
  if (diff === undefined) {
    return [`${file}:${line}`, `- ${before}`, `+ ${after}`].join("\n");
  }
  const hunkWord = pluralizeCount(diff.hunkCount, "hunk", "hunks");
  const lineWord = pluralizeCount(
    diff.changedLineCount,
    "changed line",
    "changed lines",
  );
  return (
    "git diff --no-index of the before/after scratch copies: " +
    `${String(diff.hunkCount)} ${hunkWord}, ${String(diff.changedLineCount)} ` +
    `${lineWord} (${String(diff.removed)} removed, ${String(diff.added)} ` +
    "added); see mutant.diff" +
    (diff.truncated ? " (truncated)" : "")
  );
}

/**
 * Matches the suffix `envelope.ts`'s own `capString` appends to a string
 * it had to cut (`stringMarker`: `"...(N more character(s) omitted)"`).
 * Used only to recognise, after the fact, that `buildEnvelope`'s generic
 * reduction (which knows nothing about hunks) is what shortened a
 * `diff.text` this module had already bounded to whole hunks -- never
 * produced by this module itself, which never appends a marker to a
 * truncated excerpt (only sets `truncated: true` beside a shorter
 * `text`).
 */
const ENVELOPE_STRING_MARKER_RE = /\.\.\.\(\d+ more characters? omitted\)$/;

/** True only for a bare object literal (or a null-prototype object,
 * e.g. one parsed by `JSON.parse`/`structuredClone`) -- the same test
 * `envelope.ts`'s own `isPlainObject` makes, duplicated narrowly here
 * rather than importing a private helper across module boundaries. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Trims `text` (a `diff.text` value that `buildEnvelope`'s own reduction
 * has already cut, its trailing omission marker already stripped by the
 * caller) back to the last hunk this function can PROVE is fully
 * present: scanning forward from the start, a hunk's own `@@ -a,b +c,d
 * @@` header declares how many body lines follow it, and a hunk counts
 * as present only when that many lines actually still follow the header
 * in `text`. The first hunk whose declared body does not fully fit (or
 * a stray line found before any header, which never happens for this
 * module's own output but is handled rather than thrown on) ends the
 * scan; everything from there on is dropped, never partially kept.
 *
 * This never trusts character/line COUNTS alone to decide completeness
 * (the cut that produced `text` can land in the middle of any line, so
 * the very last line surviving the cut may itself be a partial one);
 * it trusts only the hunk headers' own declared counts, the same source
 * `computeAppliedDiffExcerpt`'s hunk counting already uses.
 *
 * Returns `""` when not even the first hunk survives complete -- the
 * safe answer when the cut landed inside the first hunk itself, still
 * honouring "never mid-hunk" over "always non-empty".
 */
export function trimToLastCompleteHunk(text: string): string {
  const lines = text.split("\n");
  // Skip a leading preamble (the excerpt's own `--- `/`+++ ` file
  // lines, or anything else that is not itself a hunk header): kept
  // whole, never checked for completeness the way a hunk's declared
  // body is, since only `parseHunkHeaderCounts` gives this function
  // anything to verify a line count against.
  let i = 0;
  while (i < lines.length && parseHunkHeaderCounts(lines[i]) === undefined) {
    i++;
  }
  const preambleEnd = i;
  let end = preambleEnd;
  while (i < lines.length) {
    const counts = parseHunkHeaderCounts(lines[i]);
    if (counts === undefined) break;
    const hunkEnd = i + 1 + counts.removed + counts.added;
    if (hunkEnd > lines.length) break;
    end = hunkEnd;
    i = hunkEnd;
  }
  // Not even the first hunk survived complete: a preamble with no hunk
  // behind it is not "at a hunk boundary" either, so this reports
  // nothing rather than a fragment nothing here can vouch for.
  if (end === preambleEnd) return "";
  return lines.slice(0, end).join("\n");
}

/**
 * Corrects one `MutantDiffField` that `buildEnvelope`'s own generic
 * string cap cut AFTER this module had already bounded it to whole
 * hunks: detects the envelope's own omission-marker suffix on
 * `diff.text` (`ENVELOPE_STRING_MARKER_RE`), and when present, drops the
 * marker, drops the one trailing line the character-level cut may have
 * left partial (the split on `"\n"` cannot tell a clean cut -- which
 * leaves an empty trailing element -- from a mid-line one, so the last
 * element is always dropped; a clean cut only ever loses an empty
 * string), trims what remains to the last hunk `trimToLastCompleteHunk`
 * can prove is whole, and sets `truncated: true`. A `diff.text` with no
 * such marker is untouched -- including a `diff` this module's own
 * bound already truncated (`truncated` already `true`, and already cut
 * at a hunk boundary by `buildBoundedHunkExcerpt`, so there is nothing
 * for this to correct there).
 *
 * `hunkCount` is never touched either way: it already names the true
 * total, fixed once by `computeAppliedDiffExcerpt` before any bound
 * ran, and stays accurate regardless of how much of `text` survives.
 */
function reconcileDiffField(diff: MutantDiffField): MutantDiffField {
  if (!ENVELOPE_STRING_MARKER_RE.test(diff.text)) return diff;
  const withoutMarker = diff.text.replace(ENVELOPE_STRING_MARKER_RE, "");
  const withoutPartialLine = withoutMarker.split("\n").slice(0, -1).join("\n");
  return {
    ...diff,
    text: trimToLastCompleteHunk(withoutPartialLine),
    truncated: true,
  };
}

/** Mutates `mutantField.diff` in place via `reconcileDiffField`, when
 * `mutantField` is a plain object carrying one; a no-op for anything
 * else (no `diff`, or a shape the envelope's own reduction already
 * replaced with something other than an object -- a depth-pruned
 * placeholder string, say, which is a different, already-visible kind
 * of cut this function has nothing to correct). */
function reconcileMutantFieldDiff(mutantField: unknown): void {
  if (!isPlainRecord(mutantField)) return;
  const diff = mutantField.diff;
  if (!isPlainRecord(diff) || typeof diff.text !== "string") return;
  mutantField.diff = reconcileDiffField(diff as unknown as MutantDiffField);
}

/**
 * Called by `cli.ts` on the envelope `buildEnvelope` already returned,
 * for both `probe` (a single `mutant` field at the top level) and
 * `probe --plan` (one `mutant` field per `plan.results[]` entry):
 * corrects any `MutantDiffField` the envelope's own reduction cut
 * further, so `diff.truncated: false` can never sit beside text the
 * envelope silently shortened (see `reconcileDiffField`'s own
 * docblock for the mechanism, and this task's `MutantDiffField.text`
 * docblock for why this runs here rather than trying to prevent the
 * cut in the first place: `keepWhole` cannot reach a value nested
 * inside an array, which `plan.results` always is).
 *
 * A no-op when `envelope.mutant` and `envelope.plan.results` are absent
 * or already a shape this cannot walk (both defensive, not expected in
 * practice: every `probe`/`probe --plan` envelope carries one or the
 * other whenever a mutant reached `computeMutant`).
 */
export function reconcileEnvelopeDiffTruncation(
  envelope: Record<string, unknown>,
): void {
  reconcileMutantFieldDiff(envelope.mutant);
  const plan = envelope.plan;
  if (isPlainRecord(plan) && Array.isArray(plan.results)) {
    for (const entry of plan.results) {
      if (isPlainRecord(entry)) reconcileMutantFieldDiff(entry.mutant);
    }
  }
}
