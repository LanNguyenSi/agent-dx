import { UsageError } from "../envelope.js";
import { findGitRoot } from "../probe/containment.js";
import { revExists, runGit } from "../drift/git.js";

/** Default for `maxDeletePercent`: a commit that removes more than this
 * share of an extend-only file's base lines is flagged. */
export const DEFAULT_MAX_DELETE_PERCENT = 20;

export type HygieneFindingKind =
  "backup_file" | "extend_only_rewrite" | "test_cases_dropped";

export interface HygieneFinding {
  kind: HygieneFindingKind;
  path: string;
  detail: string;
  /** extend_only_rewrite: base line count, removed line count, percent. */
  baseLines?: number;
  removedLines?: number;
  removedPercent?: number;
  /** test_cases_dropped: marker counts at base and at head. */
  baseCases?: number;
  headCases?: number;
}

export interface HygieneOptions {
  cwd: string;
  base: string;
  /** Revision to compare against `base`; default `HEAD`. Ignored when
   * `staged` is true. */
  head?: string;
  /** Compare `base` against the git index instead of a commit, so the
   * check can run before `git commit` and see exactly what would land. */
  staged?: boolean;
  /** Root-relative paths the task only extends. */
  extendOnly?: readonly string[];
  maxDeletePercent?: number;
}

export interface HygieneResult {
  status: "ok" | "fail";
  base: string;
  head: string;
  maxDeletePercent: number;
  extendOnly: string[];
  findings: HygieneFinding[];
  counts: {
    files: number;
    backupFiles: number;
    extendOnlyRewrites: number;
    testCaseDrops: number;
  };
  warnings: string[];
}

/** Basename patterns of editor and `sed -i` leftovers: `*-E` (BSD sed
 * given `-i -E`, where `-E` becomes the backup suffix), `*.bak`, `*.orig`,
 * `*~`. */
const BACKUP_BASENAME = /(-E|\.bak|\.orig|~)$/;

export function isBackupPath(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return BACKUP_BASENAME.test(base);
}

const TEST_PATH =
  /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)[A-Za-z0-9]*Test\.java$/;

export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(filePath);
}

/** Test-case markers, one per line at most: JS/TS `it(`/`test(` (with
 * `.only`/`.skip`/`.each(...)` style suffixes), Python `def test_`,
 * Go `func Test`, and `@test`/`@Test` annotations. A heuristic over text,
 * not a parser: it exists to notice a count going down. */
export function countTestCases(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (
      /^\s*(?:it|test)(?:\.[A-Za-z]+(?:\([^)]*\))?)*\s*\(/.test(line) ||
      /^\s*(?:async\s+)?def\s+test_/.test(line) ||
      /^\s*func\s+Test[A-Za-z0-9_]*\s*\(/.test(line) ||
      /^\s*@[Tt]est\b/.test(line)
    ) {
      count += 1;
    }
  }
  return count;
}

interface ChangedFile {
  status: string;
  oldPath: string;
  newPath: string;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "");
}

function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0").filter((s) => s.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      files.push({
        status: status[0],
        oldPath: parts[i],
        newPath: parts[i + 1],
      });
      i += 2;
    } else {
      files.push({ status: status[0], oldPath: parts[i], newPath: parts[i] });
      i += 1;
    }
  }
  return files;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

/**
 * Mechanical commit-hygiene check for a git range (or the index). Reports
 * backup files the change adds, extend-only files the change mostly
 * deletes, and test files whose test-case count went down. Throws
 * `UsageError` outside a git work tree or for an unresolvable revision.
 */
export function hygiene(options: HygieneOptions): HygieneResult {
  const warnings: string[] = [];
  const maxPct = options.maxDeletePercent ?? DEFAULT_MAX_DELETE_PERCENT;
  if (!Number.isFinite(maxPct) || maxPct < 0 || maxPct > 100) {
    throw new UsageError(
      `hygiene: --max-delete-percent must be a number from 0 to 100, got ${String(options.maxDeletePercent)}`,
    );
  }
  const gitRoot = findGitRoot(options.cwd);
  if (gitRoot === undefined) {
    throw new UsageError(
      `hygiene: ${options.cwd} is not inside a git work tree`,
    );
  }
  if (!revExists(gitRoot, options.base)) {
    throw new UsageError(`hygiene: --base revision not found: ${options.base}`);
  }
  const staged = options.staged === true;
  const head = staged ? "(index)" : (options.head ?? "HEAD");
  if (!staged && !revExists(gitRoot, head)) {
    throw new UsageError(`hygiene: --head revision not found: ${head}`);
  }
  const extendOnly = [
    ...new Set((options.extendOnly ?? []).map(normalizePath)),
  ];

  const rangeArgs = staged ? ["--cached", options.base] : [options.base, head];
  const names = runGit(gitRoot, [
    "diff",
    "--no-color",
    "-z",
    "-M",
    "--name-status",
    ...rangeArgs,
  ]);
  if (names.error !== undefined || names.status !== 0) {
    throw new UsageError(
      `hygiene: git diff failed: ${names.error ?? names.stderr.trim()}`,
    );
  }
  const changed = parseNameStatus(names.stdout);

  const showHead = (p: string): string | undefined => {
    const r = runGit(gitRoot, ["show", staged ? `:${p}` : `${head}:${p}`]);
    return r.error === undefined && r.status === 0 ? r.stdout : undefined;
  };
  const showBase = (p: string): string | undefined => {
    const r = runGit(gitRoot, ["show", `${options.base}:${p}`]);
    return r.error === undefined && r.status === 0 ? r.stdout : undefined;
  };

  const findings: HygieneFinding[] = [];

  for (const file of changed) {
    if (file.status === "D") continue;
    if (isBackupPath(file.newPath)) {
      findings.push({
        kind: "backup_file",
        path: file.newPath,
        detail: `backup or editor leftover matching *-E, *.bak, *.orig or *~ (${file.status === "A" ? "added" : "changed"} by the range)`,
      });
    }
  }

  const byOld = new Map(changed.map((f) => [normalizePath(f.oldPath), f]));
  for (const target of extendOnly) {
    const file = byOld.get(target);
    if (file === undefined) continue;
    const baseContent = showBase(file.oldPath);
    if (baseContent === undefined) continue;
    const baseLines = lineCount(baseContent);
    if (baseLines === 0) continue;
    const headContent = file.status === "D" ? "" : showHead(file.newPath);
    if (headContent === undefined) {
      warnings.push(`could not read ${file.newPath} at ${head}`);
      continue;
    }
    const numstat = runGit(gitRoot, [
      "diff",
      "--no-color",
      "--no-renames",
      "--numstat",
      ...rangeArgs,
      "--",
      file.oldPath,
      ...(file.newPath !== file.oldPath ? [file.newPath] : []),
    ]);
    let removed = 0;
    for (const row of numstat.stdout.split("\n")) {
      const m = /^(\d+)\t(\d+)\t(.*)$/.exec(row);
      if (m !== null && m[3] === file.oldPath) removed += Number(m[2]);
    }
    if (file.status === "D") removed = baseLines;
    const pct = Math.round((removed / baseLines) * 1000) / 10;
    if (pct > maxPct) {
      findings.push({
        kind: "extend_only_rewrite",
        path: file.oldPath,
        detail: `removes ${String(removed)} of ${String(baseLines)} base lines (${String(pct)}%), over the ${String(maxPct)}% limit for an extend-only file`,
        baseLines,
        removedLines: removed,
        removedPercent: pct,
      });
    }
  }

  for (const file of changed) {
    if (file.status === "A") continue;
    if (!isTestPath(file.oldPath)) continue;
    const baseContent = showBase(file.oldPath);
    if (baseContent === undefined) continue;
    const headContent = file.status === "D" ? "" : showHead(file.newPath);
    if (headContent === undefined) continue;
    const baseCases = countTestCases(baseContent);
    const headCases = countTestCases(headContent);
    if (headCases < baseCases) {
      findings.push({
        kind: "test_cases_dropped",
        path: file.newPath,
        detail: `test-case markers fell from ${String(baseCases)} to ${String(headCases)}${file.status === "D" ? " (file deleted)" : ""}`,
        baseCases,
        headCases,
      });
    }
  }

  const count = (k: HygieneFindingKind): number =>
    findings.filter((f) => f.kind === k).length;
  return {
    status: findings.length > 0 ? "fail" : "ok",
    base: options.base,
    head,
    maxDeletePercent: maxPct,
    extendOnly,
    findings,
    counts: {
      files: changed.length,
      backupFiles: count("backup_file"),
      extendOnlyRewrites: count("extend_only_rewrite"),
      testCaseDrops: count("test_cases_dropped"),
    },
    warnings,
  };
}
