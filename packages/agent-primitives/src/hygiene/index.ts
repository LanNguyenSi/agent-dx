import fs from "node:fs";
import path from "node:path";
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

/**
 * One intended-deletion declaration (`--intended-deletion` /
 * `--intended-deletion-file`): a root-relative test path and how much of
 * its test-case drop the task declares as intended. `"all"` (a bare path)
 * allows a drop of any size; a number allows a drop of at most that many
 * counter units (JS/TS markers, or PHPUnit methods in a `.php` file).
 */
export interface IntendedDeletionDeclaration {
  path: string;
  declared: number | "all";
}

/** An applied allowance: one declaration that matched a real drop and
 * covered it. */
export interface IntendedDeletionApplied {
  path: string;
  baseCases: number;
  headCases: number;
  /** `baseCases - headCases`. */
  dropped: number;
  /** What the declaration allowed: a positive integer, or `"all"`. */
  declared: number | "all";
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
  /** Compare the merge-base of `base` and `HEAD` with the working tree
   * (tracked files: staged and unstaged changes alike), so uncommitted
   * work is checked as it stands. Mutually exclusive with `staged` and
   * `head`. */
  worktree?: boolean;
  /** Root-relative paths the task only extends. */
  extendOnly?: readonly string[];
  /** Raw `--intended-deletion` specs (`<path>`, `<path>=<n>` or
   * `<path>=all`), from the flag and from `--intended-deletion-file`
   * alike; parsed and validated by `hygiene()`. */
  intendedDeletions?: readonly string[];
  maxDeletePercent?: number;
}

export interface HygieneResult {
  status: "ok" | "fail";
  base: string;
  head: string;
  /** The commit `base` resolved to. */
  baseSha: string;
  /** The commit `head` resolved to; `null` with `staged` or `worktree`
   * (neither the index nor the working tree is a commit). */
  headSha: string | null;
  /** The commit the comparison starts from: the merge-base of `baseSha`
   * and the head commit (`HEAD` with `staged` or `worktree`), or `baseSha` when there
   * is none (a warning says why). */
  mergeBase: string;
  maxDeletePercent: number;
  extendOnly: string[];
  /** The declarations this run was given, normalised: leading `./`
   * stripped, duplicate paths collapsed to the one that wins (the larger
   * count, `"all"` above any number). Always the effective set, so an
   * agent can see what was asked for even when nothing matched. */
  intendedDeclarations: IntendedDeletionDeclaration[];
  /** The declarations that were applied to a real drop. */
  intendedDeletions: IntendedDeletionApplied[];
  findings: HygieneFinding[];
  /** Tracked files with changes the comparison did not look at, capped at
   * `UNCOMMITTED_FILES_CAP` entries (`counts.uncommitted` is the full
   * number). Without `staged`/`worktree`: every tracked file with staged
   * or unstaged changes. With `staged`: those with unstaged changes.
   * With `worktree`: always empty (the working tree is the comparison).
   * Untracked files are never listed here. */
  uncommittedFiles: string[];
  counts: {
    files: number;
    backupFiles: number;
    extendOnlyRewrites: number;
    testCaseDrops: number;
    intendedDeletions: number;
    /** Tracked files with changes the comparison did not cover (exact; `uncommittedFiles` is capped). */
    uncommitted: number;
  };
  warnings: string[];
}

/** Most paths `HygieneResult.uncommittedFiles` lists; the count is exact. */
export const UNCOMMITTED_FILES_CAP = 50;
/** Most paths the uncommitted-changes warning itself names. */
const UNCOMMITTED_WARNING_PATHS = 5;

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

/** A method line: optional leading attribute groups (`#[...]`, several),
 * an optional single-line `/** ... *\/` docblock, then the modifiers and
 * the name. An attribute whose arguments contain `]` is not seen
 * through, and a docblock or attribute on a method line is read only when
 * it comes before the modifiers. */
const PHP_FUNCTION =
  /^(\s*(?:#\[[^\]]*\]\s*)*(?:\/\*\*.*?\*\/\s*)?)(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const PHP_DOC_TEST_TAG = /(?:^|[\s*])@test\b/;
const PHP_TEST_ATTRIBUTE =
  /#\[\s*(?:[^\]]*,\s*)?\\?(?:PHPUnit\\Framework\\Attributes\\)?Test\s*(?:\(\s*\))?\s*[,\]]/;
/** The `Test` attribute name inside the continuation of an attribute group
 * (the `#[` is on an earlier line): tested on the previous and the current
 * line only, so a long continuation stays linear. */
const PHP_TEST_ATTRIBUTE_CONTINUATION =
  /(?:^|[\s,\[(])\\?(?:PHPUnit\\Framework\\Attributes\\)?Test\s*(?:\(\s*\))?\s*[,\]]/;
/** A docblock line (`/**`, ` *` or `*\/`): only these lines may carry the
 * `@test` marker. */
const PHP_DOCBLOCK_LINE = /^\s*(?:\/\*\*|\*)/;
/** A comment line (a `//` or `#` line comment, or a plain `/*` opener;
 * not an attribute): it neither sets nor clears the pending marker. */
const PHP_COMMENT_LINE = /^\s*(?:\/\/|\/\*|#(?!\[))/;

/** `[` minus `]` on a line: how far an attribute group opened on this line
 * is from being closed. */
function bracketDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === "[") delta += 1;
    else if (ch === "]") delta -= 1;
  }
  return delta;
}

/** PHPUnit test methods: a method whose name starts with `test`, or a
 * method carrying an `@test` docblock tag or a `#[Test]` attribute
 * (short or fully qualified); the attribute or a single-line docblock
 * may also sit on the method line itself, before the modifiers. Each
 * method counts once, so a method with both a `test*` name and a marker
 * is one case, and removing only the marker from such a method is not a
 * drop.
 *
 * A line-by-line heuristic, not a parser, with one invariant: a line that
 * matches the method pattern is always counted when its name starts with
 * `test` or a marker is pending, and no comment, string or attribute state
 * can hide it. The `@test` marker is set only on docblock lines (`/**`,
 * ` *` or `*\/`) and on the method line itself; a `//` or `#` comment and
 * code never set it. A pending marker is cleared by the next non-blank
 * line that is not a docblock, comment or attribute line, and by every
 * counted method. An attribute group whose `]` comes on a later line is
 * followed until it balances: it only keeps the pending marker alive and
 * sets it when the group names `Test`, it never hides a method line, and
 * it ends at the first method line or the first line that closes it.
 * Documented limits: a method-like line inside a block comment, heredoc
 * or nowdoc is counted (the accepted over-count direction); a bracket
 * misread inside an attribute can keep or drop one marker but hide no
 * method; and a docblock or attribute that follows the modifiers on the
 * method line is not read. */
export function countPhpTestMethods(content: string): number {
  let count = 0;
  let pendingMarker = false;
  let inAttribute = false;
  let attributeDepth = 0;
  let previousLine = "";
  for (const line of content.split("\n")) {
    const fn = PHP_FUNCTION.exec(line);
    if (fn !== null) {
      const prefix = fn[1] ?? "";
      const sameLineMarker =
        PHP_TEST_ATTRIBUTE.test(prefix) ||
        (prefix.includes("/**") && PHP_DOC_TEST_TAG.test(prefix));
      if ((fn[2] ?? "").startsWith("test") || pendingMarker || sameLineMarker) {
        count += 1;
      }
      pendingMarker = false;
      inAttribute = false;
      attributeDepth = 0;
      continue;
    }
    if (inAttribute) {
      attributeDepth += bracketDelta(line);
      if (
        !pendingMarker &&
        PHP_TEST_ATTRIBUTE_CONTINUATION.test(previousLine + "\n" + line)
      ) {
        pendingMarker = true;
      }
      previousLine = line;
      if (attributeDepth <= 0) {
        inAttribute = false;
        attributeDepth = 0;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#[")) {
      const delta = bracketDelta(line);
      if (delta > 0) {
        inAttribute = true;
        attributeDepth = delta;
        previousLine = line;
        if (PHP_TEST_ATTRIBUTE.test(line)) pendingMarker = true;
      } else if (PHP_TEST_ATTRIBUTE.test(line)) {
        pendingMarker = true;
      }
      continue;
    }
    if (PHP_DOCBLOCK_LINE.test(line)) {
      if (PHP_DOC_TEST_TAG.test(line)) pendingMarker = true;
      continue;
    }
    if (PHP_COMMENT_LINE.test(line)) continue;
    pendingMarker = false;
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

/** `true` when `a` allows at least as much of a drop as `b` does (`"all"`
 * above every number): the rule that decides which of two declarations of
 * the same path wins. */
function declaresMore(a: number | "all", b: number | "all"): boolean {
  if (a === "all") return b !== "all";
  if (b === "all") return false;
  return a > b;
}

/**
 * Parses one raw intended-deletion spec: `<path>`, `<path>=<n>` (a
 * positive integer) or `<path>=all`. The count is read after the LAST
 * `=`, so a path whose own name contains `=` must always carry an
 * explicit `=<n>` or `=all` (the bare form is read as a count and
 * rejected); a bare path elsewhere means `"all"`. An empty path, `=0`,
 * a negative or a non-integer count is a usage error.
 */
export function parseIntendedDeletion(
  raw: string,
): IntendedDeletionDeclaration {
  const spec = raw.trim();
  const eq = spec.lastIndexOf("=");
  let path = spec;
  let declared: number | "all" = "all";
  if (eq >= 0) {
    path = spec.slice(0, eq);
    const value = spec.slice(eq + 1).trim();
    if (value === "all") {
      declared = "all";
    } else if (!/^\d+$/.test(value)) {
      throw new UsageError(
        `hygiene: --intended-deletion "${raw}" must be <path>, <path>=<positive integer> or <path>=all`,
      );
    } else {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) {
        throw new UsageError(
          `hygiene: --intended-deletion "${raw}" must be <path>, <path>=<positive integer> or <path>=all`,
        );
      }
      declared = n;
    }
  }
  path = normalizePath(path.trim());
  if (path === "") {
    throw new UsageError(
      `hygiene: --intended-deletion "${raw}" has an empty path`,
    );
  }
  return { path, declared };
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

/** One tracked path `git status` reports as changed, with its two status
 * letters: `x` is the index side, `y` the working-tree side. */
interface StatusEntry {
  x: string;
  y: string;
  path: string;
}

/** Parses `git status --porcelain -z`: `XY <path>\0`, and for a rename or
 * copy `XY <new>\0<old>\0` (the source path is consumed, the new path is
 * the entry's). */
function parsePorcelainStatus(out: string): StatusEntry[] {
  const parts = out.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (part.length < 4 || part[2] !== " ") continue;
    const x = part[0] ?? " ";
    const y = part[1] ?? " ";
    entries.push({ x, y, path: part.slice(3) });
    if (x === "R" || x === "C" || y === "R" || y === "C") i += 1;
  }
  return entries;
}

/** `true` for a `path.relative` result that leaves its base directory. */
function escapesRoot(relative: string): boolean {
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

/**
 * Reads a tracked file's content from the working tree the way the index
 * path sees it: a regular file by its bytes, a symlink by its link target
 * text (what `git show :<path>` returns for a symlink blob). A path that
 * leaves the repository root, whose directory resolves outside it through
 * a symlink, or that is neither a regular file nor a symlink (a directory
 * or submodule checkout) is unreadable, like a path `git show` refuses.
 */
export function readWorktreeFile(
  gitRoot: string,
  rel: string,
): string | undefined {
  try {
    const full = path.resolve(gitRoot, rel);
    const relative = path.relative(gitRoot, full);
    if (relative === "" || escapesRoot(relative)) return undefined;
    const realRoot = fs.realpathSync(gitRoot);
    const realDir = fs.realpathSync(path.dirname(full));
    const dirRelative = path.relative(realRoot, realDir);
    if (escapesRoot(dirRelative)) return undefined;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return fs.readlinkSync(full);
    if (!stat.isFile()) return undefined;
    return fs.readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Mechanical commit-hygiene check for a git range, the index (`staged`) or
 * the working tree (`worktree`). Reports
 * backup files the change adds, extend-only files the change mostly
 * deletes, and test files whose test-case count went down. The comparison
 * starts at the merge-base of `base` and the head (`HEAD` with `staged`),
 * so a base that moved after the branch point does not count its own later
 * changes. Throws `UsageError` outside a git work tree or for an
 * unresolvable revision, and for an unusable intended-deletion spec.
 * A `test_cases_dropped` drop the range declares with `intendedDeletions`
 * is allowed instead of reported (see `IntendedDeletionDeclaration`); no
 * other finding kind can be declared away.
 */
export function hygiene(options: HygieneOptions): HygieneResult {
  const staged = options.staged === true;
  const worktree = options.worktree === true;
  if (worktree && staged) {
    throw new UsageError(
      "hygiene: --worktree and --staged are mutually exclusive (pick one comparison)",
    );
  }
  if (worktree && options.head !== undefined) {
    throw new UsageError(
      "hygiene: --worktree and --head are mutually exclusive (the working tree has no head revision)",
    );
  }
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
  /** The head side is not a commit: the index or the working tree. */
  const uncommittedHead = staged || worktree;
  const head = worktree
    ? "(worktree)"
    : staged
      ? "(index)"
      : (options.head ?? "HEAD");
  let headSha: string | null = null;
  if (!uncommittedHead) {
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
  // or `worktree` the head commit for the merge-base is `HEAD`.
  const headCommit = uncommittedHead ? resolveCommit(gitRoot, "HEAD") : headSha;
  let diffBase = baseSha;
  if (headCommit === undefined || headCommit === null) {
    warnings.push(
      `HEAD does not resolve to a commit: comparing the ${worktree ? "working tree" : "index"} with ${baseSha} directly`,
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

  // Declarations in first-seen order; a path declared twice keeps the
  // declaration that allows more (`all` above any number, then the larger
  // count), so `--intended-deletion p=3` together with a file line `p=5`
  // allows 5, and the flag-versus-file order never decides the outcome.
  const declaredByPath = new Map<string, IntendedDeletionDeclaration>();
  for (const raw of options.intendedDeletions ?? []) {
    const declaration = parseIntendedDeletion(raw);
    const existing = declaredByPath.get(declaration.path);
    if (
      existing === undefined ||
      declaresMore(declaration.declared, existing.declared)
    ) {
      declaredByPath.set(declaration.path, declaration);
    }
  }
  /** Declaration paths whose drop was looked at (allowed or not): a
   * declaration that matched no drop at all is reported stale. */
  const consultedDeclarations = new Set<string>();

  // `git diff <commit>` compares the commit with the working tree (tracked
  // files only, staged and unstaged changes alike); `--cached` with the
  // index.
  const rangeArgs = worktree
    ? [diffBase]
    : staged
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
    if (worktree) return readWorktreeFile(gitRoot, p);
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

  const intendedDeletions: IntendedDeletionApplied[] = [];
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
      // Matched on the head-side path: a renamed test file's declaration
      // names the path the file has at head, the one the finding names.
      const declaration = declaredByPath.get(normalizePath(file.newPath));
      const dropped = baseCases - headCases;
      if (declaration !== undefined) {
        consultedDeclarations.add(normalizePath(file.newPath));
      }
      const covered =
        declaration !== undefined &&
        (declaration.declared === "all" || dropped <= declaration.declared);
      if (covered && declaration !== undefined) {
        intendedDeletions.push({
          path: file.newPath,
          baseCases,
          headCases,
          dropped,
          declared: declaration.declared,
        });
        continue;
      }
      findings.push({
        kind: "test_cases_dropped",
        path: file.newPath,
        detail: `test-case markers fell from ${String(baseCases)} to ${String(headCases)}${file.status === "D" ? " (file deleted)" : ""}${declaration !== undefined ? ` (declared ${String(declaration.declared)})` : ""}`,
        baseCases,
        headCases,
      });
    }
  }

  for (const [path] of declaredByPath) {
    if (!consultedDeclarations.has(path)) {
      warnings.push(`intended deletion not used: ${path}`);
    }
  }

  // Tracked files with changes the comparison above did not look at. A
  // git failure here is a warning only: findings and status stay as they
  // were.
  let uncommittedAll: string[] = [];
  if (!worktree) {
    const status = runGit(gitRoot, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=no",
    ]);
    if (status.error !== undefined || status.status !== 0) {
      warnings.push(
        `could not list uncommitted changes (git status failed: ${status.error ?? status.stderr.trim()}); changes outside this comparison, if any, are not reported`,
      );
    } else {
      uncommittedAll = parsePorcelainStatus(status.stdout)
        .filter((e) => (staged ? e.y !== " " : true))
        .map((e) => e.path);
    }
  }
  if (uncommittedAll.length > 0) {
    const named = uncommittedAll.slice(0, UNCOMMITTED_WARNING_PATHS);
    const more = uncommittedAll.length - named.length;
    warnings.push(
      `${String(uncommittedAll.length)} tracked files have uncommitted changes not covered by this comparison; ${staged ? "stage and commit them, or use --worktree" : "commit them, or use --staged / --worktree"} (${named.join(", ")}${more > 0 ? `, and ${String(more)} more` : ""})`,
    );
  }
  if (worktree) {
    // Untracked files are not compared; the ones that look like a test or a
    // backup leftover are named, since `git add` would put them in range.
    const untracked = runGit(gitRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (untracked.error !== undefined || untracked.status !== 0) {
      warnings.push(
        `could not list untracked files (git ls-files failed: ${untracked.error ?? untracked.stderr.trim()}); untracked test or backup files, if any, are not reported`,
      );
    } else {
      const matching = untracked.stdout
        .split("\0")
        .filter((f) => f !== "" && (isTestPath(f) || isBackupPath(f)));
      if (matching.length > 0) {
        const named = matching.slice(0, UNCOMMITTED_WARNING_PATHS);
        const more = matching.length - named.length;
        warnings.push(
          `${String(matching.length)} untracked files match a test or backup pattern and are not compared; git add them to include them (${named.join(", ")}${more > 0 ? `, and ${String(more)} more` : ""})`,
        );
      }
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
    intendedDeclarations: [...declaredByPath.values()],
    intendedDeletions,
    findings,
    uncommittedFiles: uncommittedAll.slice(0, UNCOMMITTED_FILES_CAP),
    counts: {
      files: changed.length,
      backupFiles: count("backup_file"),
      extendOnlyRewrites: count("extend_only_rewrite"),
      testCaseDrops: count("test_cases_dropped"),
      intendedDeletions: intendedDeletions.length,
      uncommitted: uncommittedAll.length,
    },
    warnings,
  };
}
