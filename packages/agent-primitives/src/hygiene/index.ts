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
  /** test_cases_dropped: the name of every test case present at base and
   * gone at head, one entry per dropped case in base order, so a title
   * dropped twice appears twice. A renamed test counts as dropped under its
   * old name. */
  droppedNames?: string[];
}

/**
 * One intended-deletion declaration, merged per path from the flag and the
 * file (`--intended-deletion` / `--intended-deletion-file`): a root-relative
 * test path and what the task declares as intended for it.
 *
 * `declared` is the count form: `"all"` (a bare path or `=all`) or a number
 * (`=<n>`), at most that many counter units. `"all"` never excuses a drop
 * and a number never excuses a drop that empties the file (see
 * `hygiene()`), so for a whole-file drop only `names` can. `names` lists
 * tests by title (`<path>::<name>`), one entry per dropped case, so a title
 * dropped twice must appear twice; a declaration with only names has no
 * `declared`.
 */
export interface IntendedDeletionDeclaration {
  path: string;
  declared?: number | "all";
  names?: string[];
}

/** An applied allowance: one declaration that matched a real drop and
 * covered it. */
export interface IntendedDeletionApplied {
  path: string;
  baseCases: number;
  headCases: number;
  /** `baseCases - headCases`. */
  dropped: number;
  /** What the declaration allowed: a positive integer for a count, or
   * `"names"` when the declared test names covered every dropped test
   * (listed in `names`). */
  declared: number | "names";
  /** `declared: "names"`: the declared names, one entry per dropped case
   * (a title dropped twice appears twice). */
  names?: string[];
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
  /** Raw `--intended-deletion` specs (`<path>::<test name>`, `<path>=<n>`,
   * or the legacy `<path>` / `<path>=all`) given on the command line;
   * parsed and validated by `hygiene()`. A name repeated here counts once
   * per repetition. */
  intendedDeletions?: readonly string[];
  /** The same specs read from `--intended-deletion-file`, kept apart from
   * `intendedDeletions` because the two sources merge per name by the
   * larger count, not by sum: a name declared once in each counts once. A
   * name repeated within the file counts once per repetition. */
  intendedDeletionsFromFile?: readonly string[];
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
   * stripped, duplicate paths merged (the larger count, any number above
   * `"all"`; the union of the names). Always the effective set, so an
   * agent can see what was asked for even when nothing matched. */
  intendedDeclarations: IntendedDeletionDeclaration[];
  /** The declarations that were applied to a real drop. */
  intendedDeletions: IntendedDeletionApplied[];
  findings: HygieneFinding[];
  /** Tracked files with changes the comparison did not look at, capped at
   * `UNCOMMITTED_FILES_CAP` entries (`counts.uncommitted` is the full
   * number). Without `staged`/`worktree`: every tracked file with staged
   * or unstaged changes. With `staged`: those with unstaged changes.
   * With `worktree`: tracked files whose index version differs from both
   * HEAD and the working tree (the working-tree comparison does not look
   * at the index). Untracked files are never listed here. */
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

/** A JS/TS test-case marker: `it(`/`test(`, with `.only`/`.skip`/`.each(...)`
 * style suffixes. */
const JS_MARKER = /^\s*(?:it|test)(?:\.[A-Za-z]+(?:\([^)]*\))?)*\s*\(/;
const PY_MARKER = /^\s*(?:async\s+)?def\s+test_/;
const GO_MARKER = /^\s*func\s+Test[A-Za-z0-9_]*\s*\(/;
const ANNOTATION_MARKER = /^\s*@[Tt]est\b/;

/** The title in the first string literal of `text`, or `undefined` when the
 * text does not start with a closed one. Only `\` before the quote character
 * and before another `\` is unescaped. */
function leadingStringLiteral(text: string): string | undefined {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === quote || next === "\\") {
        out += next;
        i += 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === quote) return out;
    if (ch === "\n" && quote !== "`") return undefined;
    out += ch;
  }
  return undefined;
}

/** The name of the test case a marker line starts. A name is never needed
 * to count: a marker whose name cannot be read (a title in a variable, a
 * computed one) is named by its own trimmed line. */
function markerName(lines: readonly string[], index: number): string {
  const line = lines[index] ?? "";
  const fallback = line.trim();
  const js = JS_MARKER.exec(line);
  if (js !== null) {
    // The title may open on a later line: `it(\n  "title",`.
    const rest = [
      line.slice(js[0].length),
      ...lines.slice(index + 1, index + 4),
    ]
      .join("\n")
      .trimStart();
    const title = leadingStringLiteral(rest)?.trim();
    return title !== undefined && title !== "" ? title : fallback;
  }
  const py = /^\s*(?:async\s+)?def\s+(test_[^\s(:]*)/.exec(line);
  if (PY_MARKER.test(line)) return py?.[1] ?? fallback;
  const go = /^\s*func\s+(Test[A-Za-z0-9_]*)/.exec(line);
  if (GO_MARKER.test(line)) return go?.[1] ?? fallback;
  // `@Test` style annotation: the method it annotates, on the same line or
  // on one of the next lines.
  const rest = line.replace(ANNOTATION_MARKER, "").replace(/^\s*\([^)]*\)/, "");
  const candidates = [rest];
  for (const next of lines.slice(index + 1, index + 5)) {
    if (next.trim() === "" || /^\s*@/.test(next)) continue;
    candidates.push(next);
    break;
  }
  for (const candidate of candidates) {
    const method = /([A-Za-z_$][\w$]*)\s*\(/.exec(candidate);
    if (method !== null) return method[1] as string;
  }
  return fallback;
}

/** The test cases of a file, one name per marker, in file order: JS/TS
 * `it(`/`test(` (with `.only`/`.skip`/`.each(...)` style suffixes; the name
 * is the title string), Python `def test_` and Go `func Test` (the function
 * name), and `@test`/`@Test` annotations (the annotated method). A `.php`
 * file is listed by `listPhpTestMethods` instead. `describe(` blocks are
 * no markers. A heuristic over text, not a parser: it exists to notice a
 * count going down and to name what went. */
export function listTestCases(content: string, filePath?: string): string[] {
  if (filePath !== undefined && filePath.endsWith(".php")) {
    return listPhpTestMethods(content);
  }
  const lines = content.split("\n");
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (
      JS_MARKER.test(line) ||
      PY_MARKER.test(line) ||
      GO_MARKER.test(line) ||
      ANNOTATION_MARKER.test(line)
    ) {
      names.push(normalizeTestName(markerName(lines, i)));
    }
  }
  return names;
}

/** Number of test-case markers in a file (see `listTestCases`). */
export function countTestCases(content: string, filePath?: string): number {
  return listTestCases(content, filePath).length;
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
  return listPhpTestMethods(content).length;
}

/** The names of the methods `countPhpTestMethods` counts, in file order. */
export function listPhpTestMethods(content: string): string[] {
  const names: string[] = [];
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
        names.push(fn[2] ?? "");
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
  return names;
}

interface ChangedFile {
  status: string;
  oldPath: string;
  newPath: string;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "");
}

/** `true` when `a` ranks above `b` among two count declarations of one
 * path: the larger number wins, and any number wins over `"all"`, which
 * excuses nothing and so must never hide a count that would. */
function declaresMore(a: number | "all", b: number | "all"): boolean {
  if (a === "all") return false;
  if (b === "all") return true;
  return a > b;
}

/** What the specs of one source say about one path: the larger count
 * (`"all"` and numbers per `declaresMore`) and how many times each test
 * name was declared. */
interface DeclarationState {
  declared?: number | "all";
  nameCounts: Map<string, number>;
}

function mergeDeclared(
  a: number | "all" | undefined,
  b: number | "all" | undefined,
): number | "all" | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return declaresMore(b, a) ? b : a;
}

/** Collects the specs of ONE source (the flag, or the file): a repeated
 * name adds up (declare it as often as it was dropped), the larger count
 * of a path wins. */
function collectDeclarations(
  raws: readonly string[],
): Map<string, DeclarationState> {
  const byPath = new Map<string, DeclarationState>();
  for (const raw of raws) {
    const parsed = parseIntendedDeletion(raw);
    let state = byPath.get(parsed.path);
    if (state === undefined) {
      state = { nameCounts: new Map() };
      byPath.set(parsed.path, state);
    }
    state.declared = mergeDeclared(state.declared, parsed.declared);
    for (const name of parsed.names ?? []) {
      state.nameCounts.set(name, (state.nameCounts.get(name) ?? 0) + 1);
    }
  }
  return byPath;
}

/** Merges the two sources: per path the larger count, per name the larger
 * number of declarations from either source (not their sum, not a set
 * union), so neither source wins and the order never decides. */
function mergeSources(
  a: Map<string, DeclarationState>,
  b: Map<string, DeclarationState>,
): Map<string, DeclarationState> {
  const merged = new Map<string, DeclarationState>();
  for (const source of [a, b]) {
    for (const [p, state] of source) {
      let into = merged.get(p);
      if (into === undefined) {
        into = { nameCounts: new Map() };
        merged.set(p, into);
      }
      into.declared = mergeDeclared(into.declared, state.declared);
      for (const [name, count] of state.nameCounts) {
        into.nameCounts.set(
          name,
          Math.max(into.nameCounts.get(name) ?? 0, count),
        );
      }
    }
  }
  return merged;
}

/** The public form of a merged state: a name appears once per declaration
 * that counts. */
function toDeclaration(
  declarationPath: string,
  state: DeclarationState,
): IntendedDeletionDeclaration {
  const declaration: IntendedDeletionDeclaration = { path: declarationPath };
  if (state.declared !== undefined) declaration.declared = state.declared;
  const names: string[] = [];
  for (const [name, count] of state.nameCounts) {
    for (let i = 0; i < count; i++) names.push(name);
  }
  if (names.length > 0) declaration.names = names;
  return declaration;
}

/** A test name as compared and declared: every run of whitespace, newlines
 * included, collapsed to one space, and trimmed. A title that spans lines
 * can therefore be declared on one line, in the file as well as the flag. */
export function normalizeTestName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Separates the path from the test title in a names declaration. The
 * first occurrence splits, so a title may contain `::`, `=` and `,`; a path
 * cannot contain `::`. */
export const INTENDED_DELETION_NAME_SEPARATOR = "::";

/**
 * Parses one raw intended-deletion spec:
 *
 * - `<path>::<test name>`: names one test case (repeat the declaration for
 *   each case, also for a title that was dropped several times).
 *   Everything after the first `::` is the title with whitespace collapsed
 *   (`normalizeTestName`), so a title may hold `=`, `,` or `::`. The `::`
 *   is looked for before anything else, so a title ending in `=3` is never
 *   read as a count.
 * - `<path>=<n>` (a positive integer): at most `n` dropped test cases. It
 *   never excuses a drop that removes every test case of the file.
 * - `<path>` or `<path>=all`: the legacy blanket form, parsed for
 *   compatibility; it excuses nothing on its own.
 *
 * In the last two forms the count is read after the LAST `=`, so a path
 * whose own name contains `=` must always carry an explicit `=<n>` or
 * `=all` (the bare form is read as a count and rejected). An empty path or
 * test name, `=0`, a negative or a non-integer count is a usage error.
 */
export function parseIntendedDeletion(
  raw: string,
): IntendedDeletionDeclaration {
  const spec = raw.trim();
  const sep = spec.indexOf(INTENDED_DELETION_NAME_SEPARATOR);
  if (sep >= 0) {
    const namedPath = normalizePath(spec.slice(0, sep).trim());
    const name = normalizeTestName(
      spec.slice(sep + INTENDED_DELETION_NAME_SEPARATOR.length),
    );
    if (namedPath === "") {
      throw new UsageError(
        `hygiene: --intended-deletion "${raw}" has an empty path`,
      );
    }
    if (name === "") {
      throw new UsageError(
        `hygiene: --intended-deletion "${raw}" has an empty test name`,
      );
    }
    return { path: namedPath, names: [name] };
  }
  const eq = spec.lastIndexOf("=");
  let path = spec;
  let declared: number | "all" = "all";
  const form =
    "must be <path>::<test name>, <path>=<positive integer> or (legacy) <path>[=all]";
  if (eq >= 0) {
    path = spec.slice(0, eq);
    const value = spec.slice(eq + 1).trim();
    if (value === "all") {
      declared = "all";
    } else if (!/^\d+$/.test(value)) {
      throw new UsageError(`hygiene: --intended-deletion "${raw}" ${form}`);
    } else {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) {
        throw new UsageError(`hygiene: --intended-deletion "${raw}" ${form}`);
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

/** At most this many names are spelled out in a finding's `detail`; the
 * finding's `droppedNames` carries all of them. */
export const DROPPED_NAMES_IN_DETAIL = 10;

/** How many times each name occurs, in first-seen order. */
function countNames(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return counts;
}

/** The names with a count per repeated one (`"works" x2`), JSON-quoted so a
 * title with commas stays unambiguous; at most `cap` distinct names are
 * spelled out, then `and N more`. `named` adds `(named xK)` for a name
 * the declaration covers only in part. */
function formatNames(
  counts: ReadonlyMap<string, number>,
  named?: ReadonlyMap<string, number>,
  cap = DROPPED_NAMES_IN_DETAIL,
): string {
  const entries = [...counts];
  const shown = entries.slice(0, cap).map(([name, count]) => {
    const done = named?.get(name) ?? 0;
    return `${JSON.stringify(name)}${count > 1 ? ` x${String(count)}` : ""}${done > 0 ? ` (named x${String(done)})` : ""}`;
  });
  const more = entries.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, and ${String(more)} more` : ""}`;
}

/** The cases present at base and gone at head, one entry per dropped case
 * in base order: a title that base has twice and head once is dropped
 * once. */
function droppedTestNames(
  baseNames: readonly string[],
  headNames: readonly string[],
): string[] {
  const remaining = countNames(headNames);
  const dropped: string[] = [];
  for (const n of baseNames) {
    const left = remaining.get(n) ?? 0;
    if (left > 0) remaining.set(n, left - 1);
    else dropped.push(n);
  }
  return dropped;
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
    // Defence in depth: the realpath check below already refuses a path
    // that leaves the root, git never reports one.
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
 * is allowed instead of reported; no other finding kind can be declared
 * away. Every such finding lists the dropped test names. A drop is excused
 * when the declaration names every dropped test (`<path>::<name>`), or, for
 * a file that keeps at least one test case, when a count (`<path>=<n>`)
 * covers it. `all` (and the bare path) and a count on a drop that removes
 * every test case of the file excuse nothing: they stay a finding that
 * names the dropped tests. A declared name that is not among the dropped
 * tests of a file that dropped is a usage error (a stale declaration).
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

  // The flag and the file are collected apart and then merged: a path's
  // count is the larger of the two (any number above `all`), a test name
  // counts as often as the more generous source declares it (a repeated
  // name adds up within one source, never across the two). Neither source
  // wins and the order never decides the outcome.
  const declaredByPath = new Map<string, IntendedDeletionDeclaration>();
  for (const [declarationPath, state] of mergeSources(
    collectDeclarations(options.intendedDeletions ?? []),
    collectDeclarations(options.intendedDeletionsFromFile ?? []),
  )) {
    declaredByPath.set(declarationPath, toDeclaration(declarationPath, state));
  }
  /** Declaration paths whose drop was looked at (allowed or not): a
   * declaration that matched no drop at all is reported stale. */
  const consultedDeclarations = new Set<string>();

  // The commit-versus-working-tree comparison (tracked files only, staged
  // and unstaged changes alike) is `git diff-index <commit>`, not `git diff
  // <commit>`: the porcelain refreshes the index and writes `.git/index`
  // back, the plumbing never does. A file whose stat data is merely stale
  // can therefore show up as modified; its content then equals the base's
  // and yields no finding. `--cached` compares with the index, a second
  // revision with that commit.
  const diffCommand = worktree ? "diff-index" : "diff";
  const rangeArgs = worktree
    ? [diffBase]
    : staged
      ? ["--cached", diffBase]
      : [diffBase, headSha ?? head];
  const names = runGit(gitRoot, [
    diffCommand,
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
          diffCommand,
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
  const staleNames: string[] = [];
  for (const file of changed) {
    if (file.status === "A") continue;
    if (!isTestPath(file.oldPath)) continue;
    const baseContent = showBase(file.oldPath);
    if (baseContent === undefined) continue;
    const headContent = file.status === "D" ? "" : showHead(file.newPath);
    if (headContent === undefined) continue;
    const baseNames = listTestCases(baseContent, file.oldPath);
    const headNames = listTestCases(headContent, file.newPath);
    const baseCases = baseNames.length;
    const headCases = headNames.length;
    if (headCases < baseCases) {
      // Matched on the head-side path: a renamed test file's declaration
      // names the path the file has at head, the one the finding names.
      const declaration = declaredByPath.get(normalizePath(file.newPath));
      const dropped = baseCases - headCases;
      const wholeFile = headCases === 0;
      const droppedNames = droppedTestNames(baseNames, headNames);
      const declaredNames = declaration?.names ?? [];
      if (declaration !== undefined) {
        consultedDeclarations.add(normalizePath(file.newPath));
      }
      const droppedCounts = countNames(droppedNames);
      const declaredCounts = countNames(declaredNames);
      // A name declared more often than it was dropped (or not dropped at
      // all) is a stale or misspelled declaration.
      const over = [...declaredCounts].filter(
        ([name, count]) => count > (droppedCounts.get(name) ?? 0),
      );
      if (over.length > 0) {
        staleNames.push(
          `${file.newPath}: ${over
            .map(
              ([name, count]) =>
                `${JSON.stringify(name)} declared ${String(count)} time(s), dropped ${String(droppedCounts.get(name) ?? 0)}`,
            )
            .join(
              ", ",
            )} (all dropped tests: ${formatNames(droppedCounts, undefined, Infinity)})`,
        );
        continue;
      }
      const unnamedCounts = new Map<string, number>();
      for (const [name, count] of droppedCounts) {
        if (count > (declaredCounts.get(name) ?? 0)) {
          unnamedCounts.set(name, count);
        }
      }
      const unnamed = [...unnamedCounts.keys()];
      // A drop is excused by naming every dropped test, or, when the file
      // keeps some test cases, by a count that covers it. `all` and a
      // whole-file count never excuse anything.
      const countCovers =
        !wholeFile &&
        typeof declaration?.declared === "number" &&
        dropped <= declaration.declared;
      if (
        declaration !== undefined &&
        declaredNames.length > 0 &&
        unnamed.length === 0
      ) {
        intendedDeletions.push({
          path: file.newPath,
          baseCases,
          headCases,
          dropped,
          declared: "names",
          names: declaredNames,
        });
        continue;
      }
      if (typeof declaration?.declared === "number" && countCovers) {
        intendedDeletions.push({
          path: file.newPath,
          baseCases,
          headCases,
          dropped,
          declared: declaration.declared,
        });
        continue;
      }
      const notes: string[] = [];
      const count = declaration?.declared;
      if (count === "all") {
        notes.push(
          wholeFile
            ? "declared all, which does not excuse a whole-file drop"
            : "declared all, which does not excuse a drop",
        );
      } else if (typeof count === "number") {
        notes.push(
          wholeFile
            ? `declared ${String(count)}, a count does not excuse a whole-file drop`
            : `declared ${String(count)}`,
        );
      }
      if (declaredNames.length > 0) {
        notes.push(
          `${String(declaredNames.length)} of ${String(droppedNames.length)} dropped tests named`,
        );
      }
      const needsNames =
        wholeFile || count === "all" || declaredNames.length > 0;
      findings.push({
        kind: "test_cases_dropped",
        path: file.newPath,
        detail: `test-case markers fell from ${String(baseCases)} to ${String(headCases)}${file.status === "D" ? " (file deleted)" : ""}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}; ${declaredNames.length > 0 ? "not named" : "dropped"}: ${formatNames(unnamedCounts, declaredCounts)}${needsNames ? `; excuse them with --intended-deletion '${file.newPath}::<test name>' per test` : ""}`,
        baseCases,
        headCases,
        droppedNames,
      });
    }
  }
  if (staleNames.length > 0) {
    throw new UsageError(
      `hygiene: --intended-deletion names tests that were not dropped (a stale or misspelled name): ${staleNames.join("; ")}`,
    );
  }

  for (const [path] of declaredByPath) {
    if (!consultedDeclarations.has(path)) {
      warnings.push(`intended deletion not used: ${path}`);
    }
  }

  // Tracked files with changes the comparison above did not look at. A
  // git failure here is a warning only: findings and status stay as they
  // were.
  //
  // `--no-optional-locks` keeps `git status` from refreshing the index and
  // writing it back: hygiene never changes `.git/index`, and never takes
  // `index.lock` away from a concurrent `git add` or `git commit`.
  //
  // Which entries the comparison did not cover: default mode, any change;
  // `--staged`, a change in the working tree (`y`); `--worktree`, an index
  // version that differs from both HEAD and the working tree (`x` and `y`
  // both set), since the working-tree comparison never looks at the index.
  let uncommittedAll: string[] = [];
  const status = runGit(gitRoot, [
    "--no-optional-locks",
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
      .filter((e) =>
        worktree ? e.x !== " " && e.y !== " " : staged ? e.y !== " " : true,
      )
      .map((e) => e.path);
  }
  if (uncommittedAll.length > 0) {
    const named = uncommittedAll.slice(0, UNCOMMITTED_WARNING_PATHS);
    const more = uncommittedAll.length - named.length;
    const paths = `(${named.join(", ")}${more > 0 ? `, and ${String(more)} more` : ""})`;
    warnings.push(
      worktree
        ? `${String(uncommittedAll.length)} tracked files have a staged version that differs from both HEAD and the working tree; stage the working tree (git add) or check with --staged ${paths}`
        : `${String(uncommittedAll.length)} tracked files have uncommitted changes not covered by this comparison; ${staged ? "stage and commit them, or use --worktree" : "commit them, or use --staged / --worktree"} ${paths}`,
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
