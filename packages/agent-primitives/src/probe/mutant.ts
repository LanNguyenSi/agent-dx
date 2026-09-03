import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execCommand } from "../exec.js";

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
}

export interface MutantNotApplicable {
  applicable: false;
}

export type MutantComputeResult = MutantComputed | MutantNotApplicable;

function hashString(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function computeReplace(
  content: string,
  line: number,
  replaceText: string,
): MutantComputeResult {
  const lines = content.split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return { applicable: false };
  const before = lines[idx];
  if (before === replaceText) return { applicable: false };
  const newLines = lines.slice();
  newLines[idx] = replaceText;
  const newContent = newLines.join("\n");
  return {
    applicable: true,
    before,
    after: replaceText,
    newContent,
    mutatedHash: hashString(newContent),
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
  if (idx < 0 || idx >= lines.length) return { applicable: false };
  const original = lines[idx];
  const pos = original.indexOf(matchText);
  if (matchText === "" || pos === -1) return { applicable: false };
  if (withText === matchText) return { applicable: false };
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

/**
 * Dry-runs a unified diff against a scratch copy of the file (never the
 * real target) via `git apply`, so applicability (and the resulting
 * content/hash) is known before anything touches the real file or the
 * in-flight marker is written. `git apply` does not require the scratch
 * directory to itself be a git repository.
 */
async function computePatch(
  originalContent: string,
  absFile: string,
  root: string,
  patchPath: string,
  logDir: string,
): Promise<MutantComputeResult> {
  const relPath = path.relative(root, absFile);
  fs.mkdirSync(logDir, { recursive: true });
  const scratchDir = fs.mkdtempSync(path.join(logDir, "mutant-dry-run-"));
  const scratchFile = path.join(scratchDir, relPath);
  fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
  fs.writeFileSync(scratchFile, originalContent);

  const absPatchPath = path.resolve(patchPath);
  const result = await execCommand(
    `git apply -- ${JSON.stringify(absPatchPath)}`,
    {
      cwd: scratchDir,
      logDir: scratchDir,
      timeoutMs: 10_000,
    },
  );
  if (result.exitCode !== 0) {
    return { applicable: false };
  }
  const newContent = fs.readFileSync(scratchFile, "utf8");
  if (newContent === originalContent) return { applicable: false };
  const { before, after } = firstDiffLine(originalContent, newContent);
  return {
    applicable: true,
    before,
    after,
    newContent,
    mutatedHash: hashString(newContent),
  };
}

export interface ComputeMutantOptions {
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
      );
  }
}

/** Applies an already-validated `patch` mutant to the real target file
 * via `git apply`, run through `exec.ts` so the invocation is logged
 * like every other command this package runs. */
export function applyPatchForReal(
  patchPath: string,
  root: string,
  logDir: string,
) {
  const absPatchPath = path.resolve(patchPath);
  return execCommand(`git apply -- ${JSON.stringify(absPatchPath)}`, {
    cwd: root,
    logDir,
    timeoutMs: 10_000,
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
