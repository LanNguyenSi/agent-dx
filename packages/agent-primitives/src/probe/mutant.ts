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
   * would otherwise have been attached, and set -- with `diff` present
   * -- when the excerpt was computed but the whole diff beside it could
   * not be written to disk (`diff.path` is then absent). `step.ts`
   * folds this into the result's own `warnings` either way, so neither
   * a missing `diff` nor a missing `diff.path` is ever silent. Never set
   * for the ordinary single-line-replacement case (`diff` is correctly
   * absent there, with nothing to warn about). */
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
   * hash from a repository that does not exist).
   *
   * Bounded to `DIFF_EXCERPT_MAX_LINES`/`DIFF_EXCERPT_MAX_CHARS`. The
   * bound is unconditional -- it applies to the first hunk as much as to
   * any other -- and it cuts in this order: whole hunks are dropped from
   * the end first (`truncated`), and only when the FIRST hunk alone
   * already exceeds the bound is that hunk itself cut, at a line
   * boundary, keeping its `@@` header plus as many whole body lines as
   * fit (`hunkTruncated`). When not even the header fits, `text` is the
   * empty string and `bodyOmitted` says so, rather than an empty string
   * sitting silently behind a "see mutant.diff" pointer. `path` below
   * always names the whole, unbounded diff on disk, whichever of those
   * happened.
   *
   * `buildEnvelope`'s own generic string cap can still cut this further
   * once the result reaches `cli.ts` (it knows nothing about hunks);
   * `cli.ts` calls `reconcileEnvelopeDiffTruncation` on the built
   * envelope, WITH the pre-envelope result beside it, and rebuilds the
   * delivered excerpt from that original under the same bound rule --
   * so `truncated`/`hunkTruncated: false` can never sit beside text the
   * envelope itself cut, and a delivered text that the envelope did not
   * touch is never rewritten on the strength of a suffix pattern alone
   * (see `reconcileEnvelopeDiffTruncation`'s own docblock). */
  text: string;
  /** Absolute path of the whole applied diff, written to the probe's own
   * log directory (`mutant-diff-<random>/mutant-diff.patch`) before any
   * bound ran, so the complete mutant is recoverable no matter how much
   * of `text` survived this module's bound or the envelope's. Present
   * whenever the file could be written; a failure to write it leaves
   * this absent and names itself in `MutantComputed.diffWarning`. Also
   * appended to the mutant's own `logPaths`. */
  path?: string;
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
  /** True when `text` does not carry every hunk of the applied change:
   * whole hunks were dropped from the end (and/or the one hunk that is
   * present was itself cut, see `hunkTruncated`). False only when `text`
   * is the complete diff. */
  truncated: boolean;
  /** True when the excerpt was cut INSIDE a hunk rather than between
   * two: the first hunk alone exceeded the bound, so `text` carries its
   * `@@` header plus the whole body lines that fit and nothing else.
   * Distinct from `truncated`, which says whole hunks are missing;
   * `hunkTruncated` implies `truncated` (a hunk that is cut is not
   * fully present). Absent when false. */
  hunkTruncated?: boolean;
  /** True when `text` carries no hunk at all -- not even the first
   * hunk's `@@` header fit the bound -- so `text` is `""`. The flag
   * exists so an empty string is never delivered as if it were an
   * excerpt: a reader sees the omission named, with `path` (and, once
   * the envelope has run, `logs`) still naming the whole diff. Absent
   * when false. */
  bodyOmitted?: boolean;
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
 * It bounds EVERY hunk, the first one included: a single hunk that
 * replaces a thousand lines is cut at a line boundary inside itself
 * (`hunkTruncated: true`) rather than shipped whole, which is what makes
 * this an actual bound on the field rather than a bound on all hunks
 * but one. `path` still names the whole diff on disk in that case, so
 * nothing is lost, only moved out of the envelope.
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
      hunkTruncated: boolean;
      bodyOmitted: boolean;
      logPath: string;
      /** Absolute path of the whole diff on disk, absent only when it
       * could not be written (`patchWarning` then names why). */
      patchPath?: string;
      patchWarning?: string;
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
    // Written BEFORE any bound runs, and never bounded itself: whatever
    // this module's own excerpt bound (and, later, the envelope's) has
    // to leave out, this file still has. `mutant.diff.path` and the
    // mutant's `logPaths` both name it, so the whole applied change is
    // recoverable from any result that carries the field at all.
    const fullDiffText = bodyLines.join("\n") + "\n";
    let patchPath: string | undefined;
    let patchWarning: string | undefined;
    try {
      const candidate = path.join(diffDir, "mutant-diff.patch");
      fs.writeFileSync(candidate, fullDiffText);
      patchPath = candidate;
    } catch (err) {
      patchWarning =
        "the applied change's full diff could not be written beside the " +
        `excerpt (${errorMessage(err)}); mutant.diff.path is absent and ` +
        "only the bounded excerpt is available";
    }
    const bounded = buildBoundedHunkExcerpt(
      preamble,
      hunks,
      DIFF_EXCERPT_MAX_LINES,
      DIFF_EXCERPT_MAX_CHARS,
    );
    return {
      text: bounded.text,
      hunkCount: hunks.length,
      removedCount,
      addedCount,
      truncated: bounded.truncated,
      hunkTruncated: bounded.hunkTruncated,
      bodyOmitted: bounded.bodyOmitted,
      logPath: diffResult.logPath,
      ...(patchPath !== undefined ? { patchPath } : {}),
      ...(patchWarning !== undefined ? { patchWarning } : {}),
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

/**
 * `git diff`'s own marker line for a file whose last line has no
 * terminating newline. It follows the removed or added line it annotates
 * and is NOT counted by the enclosing hunk's `@@ -a,b +c,d @@` header,
 * so every walk over a hunk's declared body has to step over it rather
 * than spend one of the header's counts on it: counting it would end a
 * complete EOF hunk one line early, dropping the `+` line of a
 * replacement and leaving a diff that reads as a pure deletion.
 * Matched by prefix rather than by the whole sentence, since the text
 * after `\ ` is git's own wording and not part of this module's
 * contract.
 */
const NO_NEWLINE_MARKER_PREFIX = "\\ ";

/** True for a `\ No newline at end of file` marker line (see
 * `NO_NEWLINE_MARKER_PREFIX`): body content of a hunk, but not one of
 * the lines its header counts. */
function isNoNewlineMarker(line: string): boolean {
  return line.startsWith(NO_NEWLINE_MARKER_PREFIX);
}

/** Splits a `git diff --unified=0` body (already filtered of the
 * leading `diff --git `/`index ` lines) into its leading `preamble`
 * (the `--- `/`+++ ` file lines, kept whole and always ahead of every
 * hunk) and one array per hunk: each hunk's own `@@ ... @@` header line
 * followed by every line up to (not including) the next header. This is
 * what lets the excerpt's own truncation below cut only at hunk
 * boundaries -- a hunk is an atomic unit here, never split across the
 * cut, and the preamble is never mistaken for part of one. Exported
 * alongside `buildBoundedHunkExcerpt`, whose input shape it produces. */
export function splitDiffBody(bodyLines: string[]): {
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

/** What `buildBoundedHunkExcerpt` produced: the delivered `text` plus
 * the three flags `MutantDiffField` carries for it, and `keptHunks`,
 * the number of hunks kept WHOLE (0 when the first hunk itself had to be
 * cut), which `reconcileEnvelopeDiffTruncation` needs to tell "dropped
 * the original's own mid-hunk tail" from "kept it". */
export interface BoundedExcerpt {
  text: string;
  truncated: boolean;
  hunkTruncated: boolean;
  bodyOmitted: boolean;
  keptHunks: number;
}

/**
 * Keeps `preamble` whole and as many of `hunks`, in order, as fit
 * within `maxLines`/`maxChars` alongside it -- WHOLE hunks first, never
 * a prefix of one, so a truncated excerpt ends at a hunk boundary
 * whenever at least one hunk fits.
 *
 * When not even the FIRST hunk fits, the bound still holds: that hunk is
 * cut inside itself, at a line boundary, keeping its `@@` header plus as
 * many whole body lines as fit (`hunkTruncated: true`). Shipping it
 * whole instead -- what this did before -- meant a one-hunk change of
 * any size was delivered unbounded with `truncated: false`, so the
 * documented 100-line/3,000-character bound was not in fact a bound on
 * the field. A cut hunk declares more body lines in its own header than
 * it carries, which is exactly what makes it recognisable as cut, to a
 * reader and to `trimToLastCompleteHunk` alike.
 *
 * When not even the header line fits, `text` is `""` and `bodyOmitted`
 * says so (the preamble alone is dropped too: it names only this
 * comparison's own scratch paths, so it is not the part worth spending
 * the last characters on). An empty `text` behind a "see mutant.diff"
 * pointer, with nothing saying it is empty, is the one outcome this
 * function must never produce silently.
 *
 * Joins exactly the way the excerpt's own `text` always has: `preamble`
 * and every kept hunk, each already its own `"\n"`-joined block, joined
 * to each other by `"\n"` in turn.
 *
 * Exported so the bound rule -- the contract of `MutantDiffField.text`,
 * and the one rule both the pre-envelope excerpt and
 * `reconcileEnvelopeDiffTruncation` apply -- can be pinned directly, at
 * literal small bounds, instead of only through a 3,000-character
 * end-to-end fixture whose expected output nobody can write down.
 *
 * Decision: the `hunks.length === 0` branch below is a REQUIRED
 * exception, not a discretionary one, and stays a dedicated branch
 * rather than being folded into `boundHunksUnder`. `boundHunksUnder`
 * indexes `hunks[0]` once its whole-hunk loop keeps none (the "first
 * hunk alone does not fit" fallback), which is unconditional once
 * `hunks` is non-empty; called with an empty array it would iterate
 * `for (const line of hunks[0])` over `undefined` and throw, rather than
 * return a value this function's own callers (`computeAppliedDiffExcerpt`
 * refuses a zero-hunk diff before ever reaching this bound, but this
 * export has no such guard for a caller composing `preamble` directly)
 * could use. Folding the two paths would mean teaching
 * `boundHunksUnder` itself to special-case an empty `hunks` array first,
 * which is exactly this branch, just moved one call frame down.
 */
export function buildBoundedHunkExcerpt(
  preamble: string[],
  hunks: string[][],
  maxLines: number,
  maxChars: number,
): BoundedExcerpt {
  if (hunks.length === 0) {
    // No hunk to bound at all (a `preamble`-only diff -- not produced by
    // this module's own callers today, but a caller composing `preamble`
    // directly hits this). Bounded the same way a hunk's own body is:
    // whole lines kept while both `maxLines` and `maxChars` still allow
    // one more, never a mid-line cut, so this exported surface never
    // ships an unconditionally whole (and unbounded) preamble the way
    // every other branch of this function is bounded.
    let kept = 0;
    let lineTotal = 0;
    let charTotal = 0;
    for (const line of preamble) {
      const nextLineTotal = lineTotal + 1;
      const nextCharTotal = charTotal + (kept > 0 ? 1 : 0) + line.length;
      if (nextLineTotal > maxLines || nextCharTotal > maxChars) break;
      lineTotal = nextLineTotal;
      charTotal = nextCharTotal;
      kept++;
    }
    const text = preamble.slice(0, kept).join("\n");
    const truncated = kept < preamble.length;
    return {
      text,
      truncated,
      hunkTruncated: false,
      bodyOmitted: truncated && text === "",
      keptHunks: 0,
    };
  }
  const withPreamble = boundHunksUnder(preamble, hunks, maxLines, maxChars);
  // The preamble is kept only while at least one WHOLE hunk fits beside
  // it. Once it does not, those two lines go first: they name only this
  // comparison's own throwaway scratch paths (`before/x`, `after/x`),
  // while every character they cost is a character of the actual change
  // that cannot be shown. At a tight `-m` that is the difference between
  // an excerpt and an empty string behind a pointer.
  if (withPreamble.keptHunks > 0 || preamble.length === 0) {
    return withPreamble;
  }
  const withoutPreamble = boundHunksUnder([], hunks, maxLines, maxChars);
  return {
    ...withoutPreamble,
    // Dropping the preamble is itself something the delivered text does
    // not carry, so this is never reported as an untruncated excerpt --
    // not even when every hunk then fits.
    truncated: true,
  };
}

/** `buildBoundedHunkExcerpt`'s own body, for one fixed choice of
 * preamble: whole hunks while they fit, then a line-bounded prefix of
 * the first hunk, then nothing. */
function boundHunksUnder(
  preamble: string[],
  hunks: string[][],
  maxLines: number,
  maxChars: number,
): BoundedExcerpt {
  const preambleText = preamble.join("\n");
  const preambleLines = preamble.length;
  const preambleChars = preambleLines > 0 ? preambleText.length + 1 : 0;
  const fits = (lines: number, chars: number): boolean =>
    preambleLines + lines <= maxLines && preambleChars + chars <= maxChars;

  let kept = 0;
  let lineTotal = 0;
  let charTotal = 0;
  for (const hunk of hunks) {
    const nextLineTotal = lineTotal + hunk.length;
    // `+ 1` for the "\n" that joins this hunk to the previous one; the
    // first hunk is joined to the preamble instead, already paid for in
    // `preambleChars`.
    const nextCharTotal =
      charTotal + (kept > 0 ? 1 : 0) + hunk.join("\n").length;
    if (!fits(nextLineTotal, nextCharTotal)) break;
    lineTotal = nextLineTotal;
    charTotal = nextCharTotal;
    kept++;
  }

  if (kept > 0) {
    const keptHunksText = hunks
      .slice(0, kept)
      .map((h) => h.join("\n"))
      .join("\n");
    return {
      text:
        preambleLines > 0 ? `${preambleText}\n${keptHunksText}` : keptHunksText,
      truncated: kept < hunks.length,
      hunkTruncated: false,
      bodyOmitted: false,
      keptHunks: kept,
    };
  }

  // The first hunk alone does not fit: cut it at a line boundary,
  // header first.
  const first = hunks[0];
  const partial: string[] = [];
  let partialChars = 0;
  for (const line of first) {
    const nextChars = partialChars + (partial.length > 0 ? 1 : 0) + line.length;
    if (!fits(partial.length + 1, nextChars)) break;
    partial.push(line);
    partialChars = nextChars;
  }
  if (partial.length === 0) {
    return {
      text: "",
      truncated: true,
      hunkTruncated: false,
      bodyOmitted: true,
      keptHunks: 0,
    };
  }
  const partialText = partial.join("\n");
  return {
    text: preambleLines > 0 ? `${preambleText}\n${partialText}` : partialText,
    truncated: true,
    hunkTruncated: true,
    bodyOmitted: false,
    keptHunks: 0,
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
          ...(excerpt.patchPath !== undefined
            ? { path: excerpt.patchPath }
            : {}),
          hunkCount: excerpt.hunkCount,
          removed: excerpt.removedCount,
          added: excerpt.addedCount,
          changedLineCount: excerpt.removedCount + excerpt.addedCount,
          truncated: excerpt.truncated,
          ...(excerpt.hunkTruncated ? { hunkTruncated: true } : {}),
          ...(excerpt.bodyOmitted ? { bodyOmitted: true } : {}),
        }
      : undefined;
  // The full diff's own file joins the mutant's log paths whenever the
  // field that names it is attached, so a reader who never looks at
  // `diff.path` still finds the whole applied change among the logs.
  const excerptLogPaths =
    diffField !== undefined && excerpt !== undefined
      ? [
          ...logPaths,
          excerpt.logPath,
          ...(excerpt.patchPath !== undefined ? [excerpt.patchPath] : []),
        ]
      : logPaths;
  // A full diff that could not be written is reported the same way a
  // missing excerpt is: a warning, never a silently absent field.
  const combinedWarning =
    diffField !== undefined && excerpt?.patchWarning !== undefined
      ? excerpt.patchWarning
      : excerptWarning;
  return {
    applicable: true,
    line: diff.line,
    before: diff.before,
    after: diff.after,
    newContent,
    mutatedHash: hashString(newContent),
    logPaths: excerptLogPaths,
    ...(diffField !== undefined ? { diff: diffField } : {}),
    ...(combinedWarning !== undefined ? { diffWarning: combinedWarning } : {}),
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

/** Longest prefix of a descriptor's own `file` part kept before the
 * truncation marker; long enough that every existing fixture's short
 * repository-relative path passes through unchanged, short enough that a
 * `-l`/`-C` path of hundreds of characters (a deep `os.tmpdir()`, a
 * `--isolation worktree` scratch root, a long ambient `TMPDIR`) cannot
 * make `mutation_probe.mutant`/`verified_applied_via` grow without bound
 * on the file part alone -- the one part of these two descriptors that,
 * unlike the excerpt beside it, `buildEnvelope`'s own reduction and
 * `reconcileEnvelopeDiffTruncation` never touch. */
const DESCRIPTOR_PATH_MAX_CHARS = 200;

/**
 * Caps the `file` part of `formatMutantSummary`/`formatVerifiedAppliedVia`
 * at `DESCRIPTOR_PATH_MAX_CHARS`, in the same marker convention
 * `envelope.ts`'s own string cap uses (`stringMarker`): a kept prefix
 * followed by `...(N more characters omitted)`, `N` the TRUE number of
 * characters left out, never a rounded or approximate count. A `file`
 * already at or under the bound passes through byte-identical, so every
 * existing fixture (short repository-relative paths) is unaffected.
 */
function capDescriptorPath(file: string): string {
  if (file.length <= DESCRIPTOR_PATH_MAX_CHARS) return file;
  const omitted = file.length - DESCRIPTOR_PATH_MAX_CHARS;
  const noun = omitted === 1 ? "character" : "characters";
  return (
    `${file.slice(0, DESCRIPTOR_PATH_MAX_CHARS)}` +
    `...(${String(omitted)} more ${noun} omitted)`
  );
}

/**
 * Formats the `mutant: "<file>:<line>: <before> -> <after>"` string
 * used verbatim as `mutation_probe.mutant`. When `diff` is given (a
 * patch mutant whose change spans more than the one line `before`/
 * `after` already quote), a trailing note names the true changed-line
 * count alongside the hunk count -- so a single multi-line hunk (e.g.
 * "first of 4 changed lines across 1 hunk") is never misread as "the
 * whole change was one line" the way a hunk count alone would read --
 * and ends on `describeExcerptPointer`'s clause, which says in what
 * state the excerpt beside it was delivered (whole, truncated, cut
 * mid-hunk, omitted) and where the whole diff is. This one line can
 * never be read as the whole mutant on its own.
 *
 * Pure, and re-run by `reconcileEnvelopeDiffTruncation` on the corrected
 * field after the envelope has cut it, so this string's claim about the
 * excerpt is always a claim about the excerpt that was actually
 * delivered.
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
  excerptOmittedFromEnvelope = false,
): string {
  file = capDescriptorPath(file);
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
    `${String(diff.hunkCount)} ${hunkWord}; ` +
    `${describeExcerptPointer(diff, excerptOmittedFromEnvelope)})`;
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
 *
 * Ends on the same `describeExcerptPointer` clause `formatMutantSummary`
 * does, and is rebuilt from the same corrected field after the envelope
 * has run, so the two descriptors and the field they describe always
 * agree.
 */
export function formatVerifiedAppliedVia(
  file: string,
  line: number,
  before: string,
  after: string,
  diff?: MutantDiffField,
  excerptOmittedFromEnvelope = false,
): string {
  if (diff === undefined) {
    return [
      `${capDescriptorPath(file)}:${line}`,
      `- ${before}`,
      `+ ${after}`,
    ].join("\n");
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
    "added); " +
    describeExcerptPointer(diff, excerptOmittedFromEnvelope)
  );
}

/**
 * The one clause both descriptors end on, so `mutation_probe.mutant` and
 * `mutation_probe.verified_applied_via` can never make different claims
 * about the same field: where the applied diff is, and in what state the
 * excerpt beside them was delivered.
 *
 * `excerptOmittedFromEnvelope` is the case only
 * `reconcileEnvelopeDiffTruncation` can see: `buildEnvelope`'s own
 * reduction dropped the whole `diff` object (a dropped key, a
 * depth-pruned placeholder), so a descriptor still saying "see
 * mutant.diff" would point at a field that is not in the result. It
 * points at `logs` instead, which is a protected envelope field the
 * reduction never cuts and which carries the full, unreduced result's
 * own path whenever anything was cut at all.
 *
 * The variants are deliberately close in length, and the omitted one is
 * the SHORTEST: the reconciliation rebuilds these strings after the
 * envelope has already been sized, so a rebuilt descriptor that grew
 * would push the result past the bound it was just fitted to. See
 * `reconcileEnvelopeDiffTruncation` for how the few characters the
 * longer variants can add are paid for out of the excerpt's own budget.
 *
 * The full diff's own path is named as a FIELD (`mutant.diff.path`),
 * never pasted in: the path itself is unbounded (a caller's `-l` can be
 * any depth), and a descriptor that grows with it would be the same
 * "excerpt paid for twice" defect in another dress.
 */
function describeExcerptPointer(
  diff: MutantDiffField,
  excerptOmittedFromEnvelope: boolean,
): string {
  if (excerptOmittedFromEnvelope) {
    return "mutant.diff omitted from this envelope; see logs";
  }
  const wherePath =
    diff.path !== undefined ? "; full diff at mutant.diff.path" : "";
  if (diff.bodyOmitted) return `see mutant.diff (excerpt omitted)${wherePath}`;
  if (diff.hunkTruncated) return `see mutant.diff (cut mid-hunk)${wherePath}`;
  if (diff.truncated) return `see mutant.diff (truncated)${wherePath}`;
  return `see mutant.diff (whole)${wherePath}`;
}

/** The longest `describeExcerptPointer` can be for a given `diff`, over
 * every state the reconciliation could move it into. Used to reserve
 * that many characters before the corrected excerpt is built, so
 * rebuilding the two descriptors afterwards can never make the delivered
 * result longer than it already was. */
function maxExcerptPointerLength(diff: MutantDiffField): number {
  const states: MutantDiffField[] = [
    { ...diff, truncated: false, hunkTruncated: false, bodyOmitted: false },
    { ...diff, truncated: true, hunkTruncated: false, bodyOmitted: false },
    { ...diff, truncated: true, hunkTruncated: true, bodyOmitted: false },
    { ...diff, truncated: true, hunkTruncated: false, bodyOmitted: true },
  ];
  return Math.max(
    ...states.map((state) => describeExcerptPointer(state, false).length),
    describeExcerptPointer(diff, true).length,
  );
}

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
 * `computeAppliedDiffExcerpt`'s hunk counting already uses. A
 * `\ No newline at end of file` marker line is body of its hunk but is
 * not one of the lines the header counts, so the walk steps over it
 * rather than spending a count on it (see `NO_NEWLINE_MARKER_PREFIX`).
 *
 * Returns `""` when not even the first hunk survives complete -- the
 * safe answer when the cut landed inside the first hunk itself, still
 * honouring "never mid-hunk" over "always non-empty".
 *
 * Called by `reconcileEnvelopeDiffTruncation` on the PRE-envelope
 * excerpt, to separate the part of it whose hunks are provably whole
 * from a mid-hunk tail this module's own bound may have left
 * (`hunkTruncated`), so that tail is never re-delivered as if it were
 * complete. Exported for the same reason `reconcileEnvelopeDiffTruncation`
 * is: a library caller composing its own envelope can reuse it.
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
    // Walk the header's declared body: `removed + added` CONTENT lines,
    // stepping over any `\ No newline at end of file` marker lines,
    // which are body of the hunk but are not counted by its header.
    // Counting them would end a complete end-of-file hunk one line
    // early -- dropping the `+` line of a replacement, so the excerpt
    // reads as a pure deletion -- and would abort the walk at the
    // marker for any hunk that follows.
    let wanted = counts.removed + counts.added;
    let j = i + 1;
    while (j < lines.length && wanted > 0) {
      if (!isNoNewlineMarker(lines[j])) wanted--;
      j++;
    }
    if (wanted > 0) break;
    // A marker line trailing the hunk's last content line belongs to
    // this hunk, not to whatever follows.
    while (j < lines.length && isNoNewlineMarker(lines[j])) j++;
    end = j;
    i = j;
  }
  // Not even the first hunk survived complete: a preamble with no hunk
  // behind it is not "at a hunk boundary" either, so this reports
  // nothing rather than a fragment nothing here can vouch for.
  if (end === preambleEnd) return "";
  return lines.slice(0, end).join("\n");
}

/**
 * The pre-envelope mutant fields `reconcileEnvelopeDiffTruncation` needs
 * as EVIDENCE: what `probe()`/`probePlan()` actually produced, before
 * `buildEnvelope` copied and reduced it. The delivered envelope alone
 * cannot say whether a `diff.text` was cut (a legitimate excerpt can end
 * in the envelope's own omission-marker literal, and a cut one can end
 * in anything), so the correction is decided by comparing the two, never
 * by a suffix pattern.
 *
 * Structurally typed on purpose: `cli.ts` passes `result.mutant` and
 * `result.results` straight through, and a library caller composing its
 * own envelope can pass any object of the same shape.
 */
export interface EnvelopeDiffOriginals {
  /** The single probe's own pre-envelope `mutant` field, matching
   * `envelope.mutant`. */
  mutant?: MutantOriginal | undefined;
  /** The plan's pre-envelope result entries, in the same order as
   * `envelope.plan.results`. The envelope's array cap only ever drops a
   * TAIL (and marks it with a trailing string element), so index `i` of
   * the delivered array is index `i` of this one. */
  planResults?: readonly (PlanEntryOriginal | undefined)[] | undefined;
}

/** The part of a pre-envelope `mutant` field this correction reads: the
 * excerpt to compare against, and the four values the two descriptor
 * strings are formatted from (taken from here rather than from the
 * delivered envelope, whose own copies the reduction may have capped). */
export interface MutantOriginal {
  file: string;
  line: number;
  before: string;
  after: string;
  diff?: MutantDiffField | undefined;
}

/** One pre-envelope `plan.results[]` entry, as far as this correction
 * reads it. */
export interface PlanEntryOriginal {
  mutant?: MutantOriginal | undefined;
}

/**
 * Rebuilds the excerpt the envelope is willing to carry, from the
 * PRE-envelope text, under the same bound rule
 * `buildBoundedHunkExcerpt` applies everywhere else -- rather than
 * repairing the cut string the envelope produced.
 *
 * `maxChars` is the character budget the delivered text already occupied,
 * so the replacement can only be shorter or the same length: the envelope
 * was sized with that many characters in this slot, and this correction
 * never spends more than it found there.
 *
 * Only the part of the original whose hunks are provably whole is
 * re-bounded (`trimToLastCompleteHunk`): when this module's own bound had
 * already cut inside the first hunk (`hunkTruncated`), that mid-hunk tail
 * must not be re-delivered as if it were a complete hunk. When the
 * original carries no complete hunk at all, the original text itself is
 * re-bounded instead, so the first hunk's header and the body lines that
 * fit still reach the reader rather than nothing at all.
 */
function rebuildDeliveredExcerpt(
  original: MutantDiffField,
  maxChars: number,
): MutantDiffField {
  const completePrefix = trimToLastCompleteHunk(original.text);
  const source = completePrefix === "" ? original.text : completePrefix;
  const { preamble, hunks } = splitDiffBody(source.split("\n"));
  const bounded = buildBoundedHunkExcerpt(
    preamble,
    hunks,
    DIFF_EXCERPT_MAX_LINES,
    maxChars,
  );
  // `truncated`/`hunkTruncated` are ORed with the original's own: a
  // correction can only ever take more away, never restore what this
  // module's bound had already dropped. `hunkTruncated` carries over
  // only while the hunk it describes is still the one being delivered
  // (`keptHunks === hunks.length` means every hunk of `source` survived,
  // the last of them the mid-hunk one).
  const carriedHunkTruncated =
    original.hunkTruncated === true &&
    completePrefix === "" &&
    bounded.keptHunks === hunks.length &&
    !bounded.bodyOmitted;
  const truncated = original.truncated || bounded.truncated;
  const hunkTruncated = bounded.hunkTruncated || carriedHunkTruncated;
  return {
    ...original,
    text: bounded.text,
    truncated,
    ...(hunkTruncated ? { hunkTruncated: true } : { hunkTruncated: undefined }),
    ...(bounded.bodyOmitted
      ? { bodyOmitted: true }
      : { bodyOmitted: undefined }),
  };
}

/** Drops the keys an optional flag was explicitly set to `undefined` on,
 * so a corrected field never carries `"hunkTruncated": undefined` into
 * `JSON.stringify` (which would drop it anyway) or into a test's own
 * deep-equality check (which would not). */
function withoutUndefined(diff: MutantDiffField): MutantDiffField {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(diff)) {
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as MutantDiffField;
}

/** `envelope.ts`'s own `stringMarker`, rebuilt here for the one thing
 * this module has to do with it: re-capping a descriptor string the
 * envelope had ALREADY cut, so a rewritten one is marked exactly the way
 * the reduction marks its own cuts rather than ending mid-word with no
 * sign that it does. */
function envelopeStringMarker(omitted: number): string {
  return `...(${String(omitted)} more character${omitted === 1 ? "" : "s"} omitted)`;
}

/**
 * Caps `value` so its total length (marker included) is at most `total`,
 * the length of the string it replaces -- the rule that keeps this
 * correction from growing an envelope that has already been fitted to a
 * bound. Returns `undefined` when no marked cut fits in `total` at all
 * (the marker alone is longer than the room there is), which the caller
 * reads as "leave the delivered string alone".
 */
function capToLength(value: string, total: number): string | undefined {
  if (value.length <= total) return value;
  for (let kept = total; kept >= 0; kept--) {
    const marked =
      value.slice(0, kept) + envelopeStringMarker(value.length - kept);
    if (marked.length <= total) return marked;
  }
  return undefined;
}

/**
 * Rewrites `probe.mutant`/`probe.verified_applied_via` in place, from
 * `original`'s four quoted values and the field as CORRECTED, so the two
 * descriptors and the field they describe can never make different
 * claims.
 *
 * A descriptor the envelope's own string cap already cut is a different
 * case: it is no longer the string this module wrote, so replacing it
 * with a full-length rewrite would add back every character the
 * reduction had just removed. Such a descriptor is re-capped to exactly
 * the length it was delivered at instead -- corrected as far as it goes,
 * never longer than it was, and marked as cut the same way the envelope
 * marks its own. Which case applies is decided by comparing the
 * delivered string with the one the probe actually produced, not by
 * looking for a marker on it.
 *
 * Returns the number of characters the two rewrites ADDED (never
 * negative), so the caller can see it stayed within the budget it
 * reserved.
 */
function rewriteProbeDescriptors(
  probeField: unknown,
  original: MutantOriginal,
  diff: MutantDiffField | undefined,
  excerptOmittedFromEnvelope: boolean,
): number {
  if (!isPlainRecord(probeField)) return 0;
  let added = 0;
  const rewrite = (
    key: "mutant" | "verified_applied_via",
    format: (diff?: MutantDiffField, omitted?: boolean) => string,
  ): void => {
    const delivered = probeField[key];
    if (typeof delivered !== "string") return;
    const corrected = format(diff, excerptOmittedFromEnvelope);
    const wasIntact = delivered === format(original.diff, false);
    if (wasIntact) {
      added += Math.max(0, corrected.length - delivered.length);
      probeField[key] = corrected;
      return;
    }
    const capped = capToLength(corrected, delivered.length);
    if (capped !== undefined) probeField[key] = capped;
  };
  rewrite("mutant", (d, omitted) =>
    formatMutantSummary(
      original.file,
      original.line,
      original.before,
      original.after,
      d,
      omitted,
    ),
  );
  rewrite("verified_applied_via", (d, omitted) =>
    formatVerifiedAppliedVia(
      original.file,
      original.line,
      original.before,
      original.after,
      d,
      omitted,
    ),
  );
  return added;
}

/** The keys the correction is allowed to write back into a delivered
 * `diff` object: the excerpt and the three flags that describe it.
 * Everything else the envelope delivered stays exactly as delivered --
 * `path` above all, whose full value the reduction may itself have
 * capped (`logs` still carries it whole, which is why it can be), and
 * restoring the uncapped one here would put back characters the
 * envelope had just removed to meet its bound. */
const CORRECTABLE_DIFF_KEYS = [
  "text",
  "truncated",
  "hunkTruncated",
  "bodyOmitted",
] as const;

/** `envelope.ts`'s own `"..."` key, added to a `diff` object whose keys
 * `capObject`'s `maxKeys` cap had to drop some of. Duplicated narrowly
 * here (rather than importing a private constant across module
 * boundaries) for the one thing this module has to do with it: keeping
 * that key's own count honest when `writeCorrectableDiffKeys` writes a
 * key back that the cap had dropped (see there). */
const DIFF_OMITTED_KEYS_MARKER = "...";

/** Parses the count out of `envelope.ts`'s own `objectMarker` text ("N
 * more key(s) omitted"), the only shape this module ever reads that
 * marker for. `undefined` for anything else -- including a `diff` object
 * that happens to carry a literal `"..."` key of its own, which this
 * must not mistake for a reduction marker it can rewrite -- read the
 * same as "no count here to correct". */
function parseOmittedKeysCount(marker: unknown): number | undefined {
  if (typeof marker !== "string") return undefined;
  const match = /^(\d+) more keys? omitted$/.exec(marker);
  return match ? Number(match[1]) : undefined;
}

/** `envelope.ts`'s own `objectMarker`, rebuilt here for the same reason
 * `envelopeStringMarker` is: restating a count in the reduction's own
 * words rather than inventing a different one. */
function diffObjectOmittedMarker(omitted: number): string {
  return `${String(omitted)} more key${omitted === 1 ? "" : "s"} omitted`;
}

/**
 * Writes `CORRECTABLE_DIFF_KEYS` from `corrected` into the delivered
 * `deliveredDiff` object in place, against `originalDiff` -- the diff
 * exactly as `computePatch` produced it, before `buildEnvelope` ever
 * touched it -- as the record of which keys genuinely existed prior to
 * any capping at all.
 *
 * `deliveredDiff` can carry its own `"..."` marker when `buildEnvelope`'s
 * object-key cap (`capObject`'s `maxKeys`) dropped some of its keys
 * before this ever ran -- `text` survived (case 2 only reaches here when
 * it did), but `truncated`/`hunkTruncated`/`bodyOmitted` may not have.
 * Writing one of those keys back here un-drops it ONLY when
 * `originalDiff` itself already carried it (`truncated` always does; an
 * optional flag does only when the PRISTINE excerpt was already in that
 * state, e.g. already `hunkTruncated` before any envelope ran at all):
 * the object then has one more key than the cap counted as kept, so the
 * marker's own count must decrement to match, or it overstates how much
 * of the object is still missing. A key this correction introduces that
 * `originalDiff` never had at all (this module's OWN tighter rebuild
 * turning up `hunkTruncated: true` where the pristine excerpt was whole)
 * is not "un-dropping" anything the cap ever took away -- decrementing
 * for it would UNDERstate what the cap actually dropped, the opposite
 * mistake. A key this writes back that `deliveredDiff` already carried
 * is a plain overwrite and touches no count at all. An object with no
 * marker at all was never key-capped, so these flags are simply new,
 * ordinary fields on it -- nothing to correct there.
 */
function writeCorrectableDiffKeys(
  deliveredDiff: Record<string, unknown>,
  corrected: MutantDiffField,
  originalDiff: MutantDiffField,
): void {
  let omitted = parseOmittedKeysCount(deliveredDiff[DIFF_OMITTED_KEYS_MARKER]);
  for (const key of CORRECTABLE_DIFF_KEYS) {
    const value = (corrected as unknown as Record<string, unknown>)[key];
    const hadKey = Object.prototype.hasOwnProperty.call(deliveredDiff, key);
    if (value === undefined) {
      if (hadKey) delete deliveredDiff[key];
      continue;
    }
    if (!hadKey && omitted !== undefined) {
      const wasInOriginal = Object.prototype.hasOwnProperty.call(
        originalDiff,
        key,
      );
      if (wasInOriginal) omitted = Math.max(0, omitted - 1);
    }
    deliveredDiff[key] = value;
  }
  if (omitted !== undefined) {
    if (omitted > 0) {
      deliveredDiff[DIFF_OMITTED_KEYS_MARKER] =
        diffObjectOmittedMarker(omitted);
    } else {
      delete deliveredDiff[DIFF_OMITTED_KEYS_MARKER];
    }
  }
}

/**
 * The `diff` the two descriptors are formatted from: `corrected` itself,
 * unless the delivered `path` (untouched by this correction --
 * `CORRECTABLE_DIFF_KEYS` never includes it) no longer matches the
 * original's. A delivered `path` can differ from the original in two
 * ways, both meaning the same thing for a descriptor: the envelope's
 * own generic string cap capped the path VALUE itself (a nonexistent
 * path ending in that cap's own omission marker), or the reduction
 * dropped the `path` key entirely. Either way, a clause naming
 * `mutant.diff.path` would point the reader at a path that is not the
 * one the full diff actually lives at (or not present at all), so the
 * descriptor is built from a copy with `path` cleared instead -- the
 * reader falls back to `logs`, exactly as `describeExcerptPointer`
 * already does whenever `diff.path` is undefined.
 */
function descriptorDiffFor(
  deliveredDiff: unknown,
  corrected: MutantDiffField,
): MutantDiffField {
  const deliveredPath = isPlainRecord(deliveredDiff)
    ? deliveredDiff.path
    : undefined;
  return deliveredPath === corrected.path
    ? corrected
    : { ...corrected, path: undefined };
}

/** One target this module corrected a `diff.text` for (case 2 of
 * `reconcileOneMutant`): the live, in-envelope `diff` object (mutated in
 * place, so re-applying a smaller budget to it is visible to the
 * envelope `enforceEnvelopeBudget` re-measures), the `mutation_probe`
 * object beside it, and the pre-envelope evidence the excerpt is
 * rebuilt from. Case 1 (untouched) and case 3 (dropped) have no excerpt
 * left to shrink further, so neither is ever pushed here -- but case 3's
 * own descriptor rewrite can still grow the envelope (see
 * `enforceEnvelopeBudget`'s docblock), which is why that function's
 * re-measure runs even when `targets` ends up empty. */
interface CorrectionTarget {
  diff: Record<string, unknown>;
  probeField: unknown;
  original: MutantOriginal;
}

/**
 * Corrects ONE delivered mutant (`mutantField`) and the descriptor
 * strings beside it (`probeField`) against what the probe actually
 * produced (`original`).
 *
 * Three cases, decided by evidence rather than by the shape of the
 * delivered string:
 *
 * 1. The delivered `diff.text` equals the original's: the envelope did
 *    not touch it, so nothing here does either -- including a text whose
 *    own last line happens to end in the envelope's omission-marker
 *    literal, which a pattern-matching correction would have emptied.
 * 2. The delivered `diff.text` differs: the envelope cut it. The excerpt
 *    is rebuilt from the ORIGINAL under the delivered text's own
 *    character budget (never longer than what was there), and both
 *    descriptors are restated from the corrected field, so a `truncated`
 *    or `hunkTruncated` the correction introduces is stated by all three.
 *    Pushed onto `targets`, so `enforceEnvelopeBudget` can shrink it
 *    further if the correction itself pushed the whole envelope over
 *    its bound.
 * 3. The delivered `diff` is gone (a dropped key, a depth-pruned
 *    placeholder, or a `mutant` field replaced wholesale): nothing is
 *    put back -- the reduction dropped it because it did not fit -- but
 *    the descriptors stop pointing at a field that is not there and name
 *    `logs` instead, which is a protected envelope field carrying the
 *    full result's own path whenever anything was cut.
 *
 * Budget: an intact descriptor's rewrite can only grow by the difference
 * between the pointer clause it already carries and the longest one the
 * correction could put there (`maxExcerptPointerLength`, a dozen
 * characters); that much is reserved out of the excerpt's own budget
 * before the excerpt is rebuilt, and a descriptor that was already cut
 * is re-capped rather than restored. The one case that can still add
 * characters is case 3 for a mutant whose full diff could not be written
 * at all (no `path`, so the omission clause is the longer one) -- at
 * most a few dozen characters, against a `diff` object the reduction had
 * just dropped whole. That reserve does not, on its own, account for
 * every way this correction can grow the envelope (see
 * `enforceEnvelopeBudget`, which re-measures and corrects for the rest).
 */
function reconcileOneMutant(
  mutantField: unknown,
  probeField: unknown,
  original: MutantOriginal | undefined,
  targets: CorrectionTarget[],
): void {
  const originalDiff = original?.diff;
  // No excerpt was ever produced for this mutant (`replace`/`match`, or
  // a single-line-replacement patch): nothing to correct, and the
  // descriptors are the three-line form that never mentions `diff`.
  if (original === undefined || originalDiff === undefined) return;

  const deliveredDiff = isPlainRecord(mutantField)
    ? mutantField.diff
    : undefined;
  const deliveredText =
    isPlainRecord(deliveredDiff) && typeof deliveredDiff.text === "string"
      ? deliveredDiff.text
      : undefined;

  // Case 3: the envelope removed or replaced the field itself.
  if (deliveredText === undefined) {
    rewriteProbeDescriptors(probeField, original, originalDiff, true);
    return;
  }
  // Case 1: byte-identical to what the probe produced. The envelope did
  // not cut it, whatever its last line looks like.
  if (deliveredText === originalDiff.text) return;

  // Case 2: cut. Reserve what the descriptors that are still intact may
  // grow by, rebuild the excerpt from the original within the rest of
  // the delivered budget, then restate both descriptors.
  const budget = Math.max(
    0,
    deliveredText.length -
      reservedForDescriptorGrowth(probeField, original, originalDiff),
  );
  const corrected = withoutUndefined(
    rebuildDeliveredExcerpt(originalDiff, budget),
  );
  if (isPlainRecord(deliveredDiff)) {
    writeCorrectableDiffKeys(deliveredDiff, corrected, originalDiff);
    rewriteProbeDescriptors(
      probeField,
      original,
      descriptorDiffFor(deliveredDiff, corrected),
      false,
    );
    targets.push({ diff: deliveredDiff, probeField, original });
  } else {
    rewriteProbeDescriptors(probeField, original, corrected, false);
  }
}

/** How many characters to hold back from the corrected excerpt's budget
 * so restating the descriptors afterwards cannot make this entry longer
 * than the envelope already fitted it to: the pointer clause's own
 * worst-case growth, once per descriptor that is still intact (a
 * descriptor the envelope already cut is re-capped, never restored, so
 * it needs no room). */
function reservedForDescriptorGrowth(
  probeField: unknown,
  original: MutantOriginal,
  originalDiff: MutantDiffField,
): number {
  const slack = Math.max(
    0,
    maxExcerptPointerLength(originalDiff) -
      describeExcerptPointer(originalDiff, false).length,
  );
  if (slack === 0 || !isPlainRecord(probeField)) return 0;
  const intact = (key: "mutant" | "verified_applied_via", produced: string) =>
    probeField[key] === produced;
  const summaryIntact = intact(
    "mutant",
    formatMutantSummary(
      original.file,
      original.line,
      original.before,
      original.after,
      originalDiff,
    ),
  );
  const viaIntact = intact(
    "verified_applied_via",
    formatVerifiedAppliedVia(
      original.file,
      original.line,
      original.before,
      original.after,
      originalDiff,
    ),
  );
  return (summaryIntact ? slack : 0) + (viaIntact ? slack : 0);
}

/** `JSON.stringify(value).length`, never throwing: by the time this
 * runs, `envelope` already survived `buildEnvelope`'s own serialization
 * (a cycle or a BigInt would have been caught there), so this is a
 * defensive fallback rather than an expected path -- an unserializable
 * value contributes nothing to an enclosing object's own serialized
 * length either, which is what makes `0` the right answer here too. */
function jsonLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json.length : 0;
  } catch {
    return 0;
  }
}

/** The current excerpt length of `target`, as it sits in the envelope
 * right now (read fresh every time, since `enforceEnvelopeBudget` mutates
 * it in place between calls). */
function currentExcerptLength(target: CorrectionTarget): number {
  const text = target.diff.text;
  return typeof text === "string" ? text.length : 0;
}

/** Rebuilds `target`'s excerpt from its own pre-envelope original under
 * `budget` characters, writes it back the same way `reconcileOneMutant`'s
 * case 2 does, and restates both descriptors -- the one step
 * `enforceEnvelopeBudget`'s search repeats at a shrinking budget. A
 * `target` is only ever pushed by case 2, so `original.diff` is always
 * defined here. */
function applyExcerptBudget(target: CorrectionTarget, budget: number): void {
  const originalDiff = target.original.diff;
  if (originalDiff === undefined) return;
  const corrected = withoutUndefined(
    rebuildDeliveredExcerpt(originalDiff, budget),
  );
  writeCorrectableDiffKeys(target.diff, corrected, originalDiff);
  rewriteProbeDescriptors(
    target.probeField,
    target.original,
    descriptorDiffFor(target.diff, corrected),
    false,
  );
}

/**
 * Re-measures the envelope once every mutant's excerpt has already been
 * corrected (`reconcileOneMutant`'s case 2), and shrinks the largest
 * excerpts further when the correction itself pushed the WHOLE envelope
 * past `bound`.
 *
 * Two things the per-mutant correction's own budget does not account
 * for can grow the envelope even though no excerpt grew past the length
 * it was delivered at: writing `CORRECTABLE_DIFF_KEYS` back can un-drop
 * a key `buildEnvelope`'s own object-key cap had counted as omitted
 * (`writeCorrectableDiffKeys` corrects that key's own count, but the
 * re-added key's bytes are still new bytes), and a descriptor rewrite
 * can spend the full reserved pointer-clause slack
 * (`reservedForDescriptorGrowth`) even when the excerpt itself did not
 * shrink to make room for it. Neither is bounded against the WHOLE
 * envelope, only against one mutant's own prior field -- which is
 * exactly how a single-mutant `probe` result (`envelope.mutant` alone,
 * with nothing else to blame the growth on) can come back longer than
 * the `-m` it was built with.
 *
 * `bound` is `max(maxChars, preCorrectionLength)`: `buildEnvelope`
 * already guarantees its own return is at most `max(maxChars,
 * skeletonFloor)`, and `preCorrectionLength` -- the envelope's
 * serialized length before this function touched anything -- can never
 * be smaller than that true `skeletonFloor` (it IS that floor exactly
 * when the reduction fell all the way back to the skeleton). Using it in
 * place of computing `skeletonFloor` directly needs no knowledge of
 * which envelope fields are fixed and which are payload -- knowledge
 * this module, unlike `envelope.ts`, has no reason to have.
 *
 * `length <= bound` covers both directions the correction can move the
 * envelope relative to where it started, and both still need the
 * overrun warning reconciled against the TRUE final length rather than
 * left stating `preCorrectionLength`: when the correction GREW the
 * envelope but not past `bound` (nothing here is shrunk), and when the
 * correction SHRANK an envelope that was already past `maxChars` before
 * this function ran (`preCorrectionLength > maxChars`, so `bound ===
 * preCorrectionLength`) -- a re-cut to a hunk boundary in
 * `reconcileOneMutant`'s case 2 routinely lands shorter than the
 * generic mid-hunk cut `buildEnvelope`'s own reduction delivered, so
 * `length` can sit anywhere from "still over `maxChars`" down to "back
 * in bound" without ever exceeding `bound` itself, and without the
 * shrink loop below ever running to fix the warning up as a side
 * effect. `reconcileBudgetOverrunWarning` below is what actually
 * updates or removes a prior "could not be met" warning in both cases;
 * without it, a warning `buildEnvelope` (or a caller composing its own
 * envelope) already appended keeps naming a length this correction has
 * since made stale.
 *
 * Targets are visited largest-excerpt-first, each shrunk by binary
 * search on its own budget to the largest that still fits the WHOLE
 * envelope, before the next target's excerpt is touched at all: a
 * single oversized mutant is shrunk on its own rather than spreading a
 * uniform cut across every mutant in a plan that did not need one.
 *
 * Once there is nothing left here to shrink (every target has been
 * shrunk to nothing, or there was never a target to begin with),
 * `reconcileBudgetOverrunWarning` states the TRUE final length, in the
 * same words `buildEnvelope`'s own overrun warning uses, if the
 * envelope still exceeds `maxChars`, or removes a stale warning if the
 * shrinking brought it back within `maxChars`, so a caller can tell
 * "bounded as requested" from "bounded, but bigger than asked for,
 * honestly reported" here too.
 *
 * An EMPTY `targets` does not skip this re-measure: `reconcileOneMutant`'s
 * case 3 rewrites a descriptor without ever pushing a target (see its own
 * docblock), and that rewrite alone can push the whole envelope past
 * `bound` with nothing here left to shrink. The shrink loop below is
 * simply a no-op over an empty `order` in that shape -- the re-measure and
 * `reconcileBudgetOverrunWarning` still have to run so that growth is
 * reported rather than silently shipped over budget.
 */
function enforceEnvelopeBudget(
  envelope: Record<string, unknown>,
  targets: readonly CorrectionTarget[],
  maxChars: number,
  preCorrectionLength: number,
): void {
  const bound = Math.max(maxChars, preCorrectionLength);
  let length = jsonLength(envelope);
  if (length <= bound) {
    reconcileBudgetOverrunWarning(envelope, maxChars, length);
    return;
  }

  const order = [...targets].sort(
    (a, b) => currentExcerptLength(b) - currentExcerptLength(a),
  );
  for (const target of order) {
    if (length <= bound) break;
    let hi = currentExcerptLength(target);
    if (hi === 0) continue;
    let lo = 0;
    let best = -1;
    // Binary search on the target's own excerpt budget: `fitsWithLimits`
    // in `envelope.ts` searches a single scale the same way, over the
    // same kind of monotone (never strictly, marker text aside)
    // "shorter budget never grows the result" relationship. An
    // unfitting `mid` is simply not kept, so a rare non-monotone blip
    // costs utilization, never correctness: `best` only ever holds a
    // budget this loop measured the WHOLE envelope at and found to fit.
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      applyExcerptBudget(target, mid);
      if (jsonLength(envelope) <= bound) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    applyExcerptBudget(target, Math.max(0, best));
    length = jsonLength(envelope);
  }

  reconcileBudgetOverrunWarning(envelope, maxChars, length);
}

/** Matches exactly the wording `pushBudgetOverrunWarning` (here) and
 * `pushOverrunWarning` (`envelope.ts`) both produce, so either origin's
 * prior warning is recognised the same way: a `warnings` entry naming a
 * length this correction may since have made stale -- but ONLY a prior
 * warning about THIS `maxChars`. A warning stating a length that failed
 * to fit a DIFFERENT, harsher bound from a prior reduction pass (the
 * very shape the README's "prior, harsher reduction pass" clause
 * blesses) remains true regardless of what this call's own `maxChars`
 * is, so it is deliberately left unmatched here: neither
 * `pushBudgetOverrunWarning`'s replace filter nor
 * `reconcileBudgetOverrunWarning`'s removal branch may touch it. Shared
 * by `pushBudgetOverrunWarning` (replace) and
 * `reconcileBudgetOverrunWarning` (detect, to decide whether a removal
 * is even in play). */
function isBudgetOverrunWarning(value: unknown, maxChars: number): boolean {
  return (
    typeof value === "string" &&
    /^envelope is \d+ characters; requested max-chars \d+ could not be met$/.test(
      value,
    ) &&
    value.endsWith(`requested max-chars ${String(maxChars)} could not be met`)
  );
}

/** `envelope.ts`'s own overrun-warning wording and its digit-count
 * arithmetic, duplicated here for the one thing this module has to do
 * with it: the warning's own text is part of the length it states, and
 * appending it here (after `enforceEnvelopeBudget`'s shrinking already
 * ran) grows the envelope by exactly that text -- so a naive `length`
 * captured before appending would understate the true final size by the
 * warning's own byte count. Scanning digit counts (rather than a
 * fixed-iteration re-measure loop) finds the exact `n` satisfying
 * `n === base + digitCount(n)`, so the number this states is always the
 * envelope's real, final, serialized length, warning included. */
function pushBudgetOverrunWarning(
  envelope: Record<string, unknown>,
  maxChars: number,
): void {
  // A `warnings` this correction cannot append to safely (anything but
  // an array, e.g. a caller-composed envelope that never ran this
  // module's own reduction) is left exactly as it was, rather than
  // silently replaced with a fresh one-element array.
  if (envelope.warnings !== undefined && !Array.isArray(envelope.warnings)) {
    return;
  }
  const baseWarnings = Array.isArray(envelope.warnings)
    ? (envelope.warnings as unknown[])
    : [];
  // `buildEnvelope`'s own reduction may already have appended this exact
  // wording for THIS SAME `maxChars` (the envelope did not fit even
  // before this module's correction ran): replacing it here, rather
  // than appending a second one, keeps the array carrying at most one
  // "could not be met" warning per bound, stating the true final length
  // rather than the stale one measured before this correction's own
  // shrinking. A warning about a DIFFERENT bound (a prior, harsher
  // reduction pass) is left in place -- it remains true regardless of
  // what this call's own `maxChars` is.
  const priorWarnings = baseWarnings.filter(
    (w) => !isBudgetOverrunWarning(w, maxChars),
  );
  const wording = (n: number): string =>
    `envelope is ${String(n)} characters; requested max-chars ${String(maxChars)} could not be met`;
  const probe = wording(0);
  const base =
    jsonLength({ ...envelope, warnings: [...priorWarnings, probe] }) -
    "0".length;
  let finalLength = base + 1;
  for (let digits = 1; digits <= 20; digits++) {
    const candidate = base + digits;
    if (String(candidate).length === digits) {
      finalLength = candidate;
      break;
    }
  }
  envelope.warnings = [...priorWarnings, wording(finalLength)];
}

/** Keeps a prior "could not be met" warning (`buildEnvelope`'s own, or
 * one a caller composed its own envelope with) in sync with `length`,
 * the envelope's TRUE final serialized length once `enforceEnvelopeBudget`
 * is done touching it -- called from BOTH of that function's exits: the
 * `length <= bound` early return (nothing here was shrunk; covers a
 * correction that grew the envelope without crossing `bound`, and one
 * that shrank an envelope already over `maxChars` before this module
 * ran without crossing back below `bound` either) and the end of the
 * shrink loop. `length > maxChars` still needs a warning naming the
 * true final length (`pushBudgetOverrunWarning` already replaces rather
 * than duplicates); `length <= maxChars` means the envelope is back in
 * bound, so a warning about THIS bound that is no longer true is
 * dropped rather than left stating a size the envelope no longer has --
 * a warning about a DIFFERENT, harsher bound from a prior reduction
 * pass is left untouched either way, since it names a length that
 * still failed to fit that other bound regardless of what this call's
 * own `maxChars` is. A `warnings` array that never carried a "could not
 * be met" entry for THIS bound, or a non-array `warnings` (left
 * untouched, same as `pushBudgetOverrunWarning`'s own guard), costs
 * nothing extra here. */
function reconcileBudgetOverrunWarning(
  envelope: Record<string, unknown>,
  maxChars: number,
  length: number,
): void {
  if (length > maxChars) {
    pushBudgetOverrunWarning(envelope, maxChars);
    return;
  }
  if (!Array.isArray(envelope.warnings)) return;
  const warnings = envelope.warnings as unknown[];
  if (!warnings.some((w) => isBudgetOverrunWarning(w, maxChars))) return;
  envelope.warnings = warnings.filter(
    (w) => !isBudgetOverrunWarning(w, maxChars),
  );
}

/**
 * Called by `cli.ts` on the envelope `buildEnvelope` already returned,
 * with the pre-envelope result beside it, for both `probe` (a single
 * `mutant`/`mutation_probe` pair at the top level) and `probe --plan`
 * (one pair per `plan.results[]` entry).
 *
 * What it corrects and why it runs here rather than preventing the cut:
 * `buildEnvelope`'s reduction knows nothing about hunks, so it can cut a
 * `diff.text` mid-hunk (and mid-line) while `truncated` still reads the
 * pre-envelope `false`, and `keepWhole` -- the mechanism that protects
 * `plan.summary` -- cannot reach a value nested inside an array, which
 * `plan.results` always is. Holding an excerpt out of the reduction
 * entirely would also make the WHOLE envelope miss a tight `-m` rather
 * than only the excerpt.
 *
 * Every correction is decided by comparing the delivered value with the
 * original one this is handed, never by recognising a suffix on the
 * delivered string: see `reconcileOneMutant` for the three cases.
 * `hunkCount`/`removed`/`added`/`changedLineCount` are never touched --
 * they name the true totals, fixed before any bound ran -- and neither
 * is `path`, which names the whole diff on disk regardless.
 *
 * `maxChars`, when given, is the same bound `buildEnvelope` built this
 * envelope with (`cli.ts` passes its own resolved `-m`/`--max-chars`):
 * once every mutant's excerpt is corrected, `enforceEnvelopeBudget`
 * re-measures the WHOLE envelope and shrinks the largest corrected
 * excerpts further if the correction itself pushed it back over that
 * bound. Omitted (a library caller composing its own envelope with no
 * fixed budget in mind), this step is skipped entirely -- the per-mutant
 * correction still runs, exactly as it always has.
 *
 * A no-op when `envelope.mutant`/`envelope.plan.results` are absent or a
 * shape this cannot walk, and for any mutant that never had an excerpt.
 */
export function reconcileEnvelopeDiffTruncation(
  envelope: Record<string, unknown>,
  originals: EnvelopeDiffOriginals,
  maxChars?: number,
): void {
  const preCorrectionLength = maxChars !== undefined ? jsonLength(envelope) : 0;
  const targets: CorrectionTarget[] = [];
  reconcileOneMutant(
    envelope.mutant,
    envelope.mutation_probe,
    originals.mutant,
    targets,
  );
  const plan = envelope.plan;
  if (isPlainRecord(plan) && Array.isArray(plan.results)) {
    plan.results.forEach((entry, index) => {
      if (!isPlainRecord(entry)) return;
      reconcileOneMutant(
        entry.mutant,
        entry.mutation_probe,
        originals.planResults?.[index]?.mutant,
        targets,
      );
    });
  }
  if (maxChars !== undefined) {
    enforceEnvelopeBudget(envelope, targets, maxChars, preCorrectionLength);
  }
}
