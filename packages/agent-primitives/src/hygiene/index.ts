import { UsageError } from "../envelope.js";
import { findGitRoot } from "../probe/containment.js";
import {
  isShallowRepository,
  mergeBase,
  resolveCommit,
  runGit,
} from "../drift/git.js";
import { withoutPathspecEnv } from "../git-env.js";

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
  /** The commit `base` resolved to. */
  baseSha: string;
  /** The commit `head` resolved to; `null` with `staged` (the index is
   * not a commit). */
  headSha: string | null;
  /** The commit the comparison starts from: the merge-base of `baseSha`
   * and the head commit (`HEAD` with `staged`), or `baseSha` when there
   * is none (a warning says why). */
  mergeBase: string;
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

/** Basename patterns of editor and `sed -i` leftovers. BSD sed takes the
 * argument after `-i` as the backup suffix, so `sed -i -E ...` or
 * `sed -i -e ...` writes `<file>-E` or `<file>-e`. The flag-as-suffix
 * family covers every sed option letter an agent plausibly writes right
 * after `-i`: `-e`, `-E`, `-n`, `-r`, `-s`. Plus `*.bak`, `*.orig`, `*~`. */
const BACKUP_BASENAME = /(-[eEnrs]|\.bak|\.orig|~)$/;

export function isBackupPath(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return BACKUP_BASENAME.test(base);
}

const TEST_PATH =
  /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)[A-Za-z0-9]*Test\.java$|(^|\/)[A-Za-z0-9_]*Test\.php$/;

export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(filePath);
}

/** Test-case markers, one per line at most: JS/TS `it(`/`test(` (with
 * `.only`/`.skip`/`.each(...)` style suffixes), Python `def test_`,
 * Go `func Test`, and `@test`/`@Test` annotations. A `.php` file is
 * counted by `countPhpTestMethods` instead. A heuristic over text,
 * not a parser: it exists to notice a count going down. */
export function countTestCases(content: string, filePath?: string): number {
  if (filePath !== undefined && filePath.endsWith(".php")) {
    return countPhpTestMethods(content);
  }
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

const PHP_FUNCTION =
  /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const PHP_DOC_TEST_TAG = /(?:^|[\s*])@test\b/;
const PHP_TEST_ATTRIBUTE =
  /#\[\s*(?:[^\]]*,\s*)?\\?(?:PHPUnit\\Framework\\Attributes\\)?Test\s*(?:\(\s*\))?\s*[,\]]/;

/** PHPUnit test methods: a method whose name starts with `test`, or a
 * method preceded by an `@test` docblock tag or a `#[Test]` attribute
 * (short or fully qualified). Each method counts once, so a method with
 * both a `test*` name and a marker is one case, and removing only the
 * marker from such a method is not a drop. A text heuristic: a
 * `function test...(` line at the start of a heredoc line is counted
 * too. */
export function countPhpTestMethods(content: string): number {
  let count = 0;
  let pendingMarker = false;
  for (const line of content.split("\n")) {
    const fn = PHP_FUNCTION.exec(line);
    if (fn !== null) {
      if (pendingMarker || fn[1].startsWith("test")) count += 1;
      pendingMarker = false;
      continue;
    }
    if (PHP_DOC_TEST_TAG.test(line) || PHP_TEST_ATTRIBUTE.test(line)) {
      pendingMarker = true;
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

/** Rows of `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a
 * rename `added\tremoved\t\0old\0new\0`. A binary file counts as `-`. */
interface NumstatRow {
  added: number | undefined;
  removed: number | undefined;
  oldPath: string;
  newPath: string;
}

function parseNumstat(out: string): NumstatRow[] {
  const parts = out.split("\0");
  const rows: NumstatRow[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i] ?? "");
    if (m === null) continue;
    const num = (v: string | undefined): number | undefined =>
      v === undefined || v === "-" ? undefined : Number(v);
    if (m[3] === "") {
      rows.push({
        added: num(m[1]),
        removed: num(m[2]),
        oldPath: parts[i + 1] ?? "",
        newPath: parts[i + 2] ?? "",
      });
      i += 2;
    } else {
      rows.push({
        added: num(m[1]),
        removed: num(m[2]),
        oldPath: m[3] ?? "",
        newPath: m[3] ?? "",
      });
    }
  }
  return rows;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

/**
 * Mechanical commit-hygiene check for a git range (or the index). Reports
 * backup files the change adds, extend-only files the change mostly
 * deletes, and test files whose test-case count went down. The comparison
 * starts at the merge-base of `base` and the head (`HEAD` with `staged`),
 * so a base that moved after the branch point does not count its own later
 * changes. Throws `UsageError` outside a git work tree or for an
 * unresolvable revision.
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
  const baseSha = resolveCommit(gitRoot, options.base);
  if (baseSha === undefined) {
    throw new UsageError(`hygiene: --base revision not found: ${options.base}`);
  }
  const staged = options.staged === true;
  const head = staged ? "(index)" : (options.head ?? "HEAD");
  let headSha: string | null = null;
  if (!staged) {
    const resolved = resolveCommit(gitRoot, head);
    if (resolved === undefined) {
      throw new UsageError(`hygiene: --head revision not found: ${head}`);
    }
    headSha = resolved;
  }

  // Both sides are resolved to commits once and the comparison starts at
  // their merge-base, so a symbolic base that moved after the branch point
  // (a remote-tracking ref, a local default branch) gives the same result
  // as the SHA it resolves to. Comparing against the base directly would
  // count every change the base side made since the branch point, for
  // example test cases added there, against the head side. With `staged`
  // the head commit for the merge-base is `HEAD`.
  const headCommit = staged ? resolveCommit(gitRoot, "HEAD") : headSha;
  let diffBase = baseSha;
  if (headCommit === undefined || headCommit === null) {
    warnings.push(
      `HEAD does not resolve to a commit: comparing the index with ${baseSha} directly`,
    );
  } else {
    const mb = mergeBase(gitRoot, baseSha, headCommit);
    if (mb.sha !== undefined) {
      diffBase = mb.sha;
    } else {
      const cause = isShallowRepository(gitRoot)
        ? "shallow clone: the history needed to find a common ancestor may be missing, fetch more history"
        : mb.reason === "no-common-ancestor"
          ? "no common ancestor"
          : `git merge-base failed: ${mb.detail}`;
      warnings.push(
        `no merge-base between ${baseSha} and ${headCommit} (${cause}): diffing the two trees directly`,
      );
    }
  }
  const extendOnly = [
    ...new Set((options.extendOnly ?? []).map(normalizePath)),
  ];

  const rangeArgs = staged
    ? ["--cached", diffBase]
    : [diffBase, headSha ?? head];
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
    const r = runGit(gitRoot, [
      "show",
      staged ? `:${p}` : `${headSha ?? head}:${p}`,
    ]);
    return r.error === undefined && r.status === 0 ? r.stdout : undefined;
  };
  const showBase = (p: string): string | undefined => {
    const r = runGit(gitRoot, ["show", `${diffBase}:${p}`]);
    return r.error === undefined && r.status === 0 ? r.stdout : undefined;
  };

  const findings: HygieneFinding[] = [];

  // Only a file that newly acquires a backup-style name is a finding: an
  // added file, or a rename/copy from a name that did not match. A tracked
  // file that already carried such a name at the base and is merely modified
  // is the repository's own file, not a leftover of this change.
  for (const file of changed) {
    if (!["A", "R", "C"].includes(file.status)) continue;
    if (!isBackupPath(file.newPath)) continue;
    if (
      (file.status === "R" || file.status === "C") &&
      isBackupPath(file.oldPath)
    ) {
      continue;
    }
    findings.push({
      kind: "backup_file",
      path: file.newPath,
      detail: `backup or editor leftover matching *-e, *-E, *-n, *-r, *-s, *.bak, *.orig or *~ (${file.status === "A" ? "added" : file.status === "R" ? "renamed to this name" : "copied to this name"} by the range)`,
    });
  }

  const byOld = new Map(changed.map((f) => [normalizePath(f.oldPath), f]));
  for (const target of extendOnly) {
    const baseContent = showBase(target);
    if (baseContent === undefined) {
      warnings.push(
        diffBase === baseSha
          ? `extend-only path ${target} does not exist at ${options.base}; skipped`
          : `extend-only path ${target} does not exist at the merge-base ${diffBase} of ${options.base}; skipped`,
      );
      continue;
    }
    const file = byOld.get(target);
    if (file === undefined) continue;
    const baseLines = lineCount(baseContent);
    if (baseLines === 0) continue;
    const headContent = file.status === "D" ? "" : showHead(file.newPath);
    if (headContent === undefined) {
      warnings.push(`could not read ${file.newPath} at ${head}`);
      continue;
    }
    let removed = 0;
    if (file.status !== "D") {
      // `--literal-pathspecs`: a path is a file name, never pathspec magic,
      // so a file named `:x.md` or `*.md` is measured as itself.
      const numstat = runGit(
        gitRoot,
        [
          "--literal-pathspecs",
          "diff",
          "--no-color",
          "-z",
          "-M",
          "--numstat",
          ...rangeArgs,
          "--",
          file.oldPath,
          ...(file.newPath !== file.oldPath ? [file.newPath] : []),
        ],
        withoutPathspecEnv(),
      );
      const row =
        numstat.error === undefined && numstat.status === 0
          ? parseNumstat(numstat.stdout).find((r) => r.oldPath === file.oldPath)
          : undefined;
      if (row?.removed === undefined) {
        warnings.push(
          `could not measure removed lines of extend-only path ${file.oldPath} (no numstat row, or a binary file); not checked`,
        );
        continue;
      }
      removed = row.removed;
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
    const baseCases = countTestCases(baseContent, file.oldPath);
    const headCases = countTestCases(headContent, file.newPath);
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
    baseSha,
    headSha,
    mergeBase: diffBase,
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
