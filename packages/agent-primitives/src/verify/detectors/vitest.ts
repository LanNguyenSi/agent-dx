import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/** Strips ANSI SGR escape codes (`\x1b[...m`) only. vitest colorizes its
 * output by default whenever it does not detect an unsupportive
 * terminal, which includes the fully isolated environment a `-x`
 * override's real-tool invocation runs under here (no `TERM`, no
 * `NO_COLOR`): the raw exec tail can carry color codes interleaved with
 * every token this detector matches on, so they are stripped before any
 * regex runs rather than working around them token by token. Cursor
 * movement and other non-SGR escape sequences are out of scope: vitest's
 * default text reporter never emits them, so stripping them would be
 * dead code against every shape this detector is written for. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Matches vitest 4's own summary line (`Tests  N failed | M passed (T)` on
 * a mixed run, `Tests  N passed (N)` on a green run, `Tests  N skipped
 * (N)` on an all-skipped run, and any other segment combination of
 * `failed`/`passed`/`expected fail`/`skipped`/`todo`), the exit-1,
 * no-summary "no test files" case, or the "every matched file failed to
 * collect" case (`Tests  no tests`, vitest's `getStateString` on an empty
 * task list). Anchored on the whole `Tests  <n> (failed|passed|expected
 * fail|skipped|todo)` token (or the literal `Tests  no tests`) so it
 * never fires on unrelated text that merely contains the word "Tests";
 * `expected fail`/`skipped`/`todo` are included here (not just in
 * `parse`) so an all-`expected fail`, all-skipped, or all-todo run,
 * which carries neither `failed` nor `passed`, still selects this
 * detector instead of falling back to `generic`.
 */
const SUMMARY_LINE =
  /^\s*Tests\s+\d+\s+(failed|passed|expected fail|skipped|todo)\b/m;
const NO_TEST_FILES = /No test files found/;
const TESTS_NO_TESTS = /^\s*Tests\s+no tests\s*$/m;

/**
 * The whole `Tests` summary line, captured as the segment text between
 * `Tests` and the trailing `(<total>)`: vitest 4 lists these segments in
 * a fixed order (`failed`, `passed`, `expected fail`, `skipped`, `todo`)
 * but omits any segment whose count is zero, so the line shape varies by
 * run (`N failed (N)`, `N failed | M passed (T)`, `N skipped (N)`, `N
 * failed | M passed | K expected fail | L skipped | J todo (T)`, ...).
 * Parsing the segment text generically (below) rather than hard-coding
 * each combination as its own regex is what makes every one of these
 * shapes readable with one pass. Never matches the `Tests  no tests`
 * shape (no trailing `(<total>)` there); that shape is recognized by
 * `TESTS_NO_TESTS` above and left to the failures invariant, same as the
 * "no test files" shape.
 */
const TESTS_LINE = /^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/m;
/** One `<digits> <label>` segment inside the `Tests` line's segment text.
 * `expected fail` (a `.fails` test that failed as expected, so vitest
 * counts it as passing) is folded into `summary.passed` in `parse`
 * below rather than getting its own `Summary` field: from a caller's
 * point of view it is a pass, just one whose assertion was inverted. */
const SEGMENT = /(\d+)\s+(failed|passed|expected fail|skipped|todo)\b/g;

/**
 * ` FAIL  file > suite > name` (one or more `>`-separated suite segments
 * before the test name). Tried first, and only matches a line that
 * carries a ` > ` separator at all: the name is everything after the
 * first one, to the end of the line, so a name that itself ends in a
 * bracketed segment (a parameterized test's `name[0]`, or a
 * snapshot-shaped name) is captured whole. The file capture is never
 * `\S+`: it is captured structurally, lazily up to that first ` > `.
 */
const FAIL_LINE_WITH_SUITE = /^\s*FAIL\s+(.+?)\s+>\s+(.+?)\s*$/;

/**
 * ` FAIL  file` or ` FAIL  file [ file ]` (a file that failed to collect,
 * e.g. a broken import: no suite, no name, just the file repeated in
 * brackets). Only ever consulted when `FAIL_LINE_WITH_SUITE` above did
 * not match (no ` > ` anywhere on the line): keeping the two shapes as
 * separate, anchored alternatives -- rather than one regex with both a
 * suite group and a trailing-bracket group, each optional -- is what
 * keeps this shape's own bracket handling from ever being reached for a
 * suite/name line, so a name ending in `[0]` can never be mistaken for
 * this shape's collection-error marker. The file capture is never
 * `\S+`: it is captured structurally, up to the trailing ` [ ... ]`
 * marker when present, or to the end of the line otherwise.
 */
const FAIL_LINE_FILE_ONLY = /^\s*FAIL\s+(.+?)(?:\s+\[.*\])?\s*$/;

/** One parsed ` FAIL ` line: `name` is `undefined` for the file-only
 * shape (`FAIL_LINE_FILE_ONLY`), always present (though possibly empty)
 * for the suite/name shape (`FAIL_LINE_WITH_SUITE`). `null` when the
 * line is not a ` FAIL ` line at all. */
function matchFailLine(
  line: string,
): { file: string; name: string | undefined } | null {
  const withSuite = FAIL_LINE_WITH_SUITE.exec(line);
  if (withSuite) return { file: withSuite[1], name: withSuite[2] };
  const fileOnly = FAIL_LINE_FILE_ONLY.exec(line);
  if (fileOnly) return { file: fileOnly[1], name: undefined };
  return null;
}

interface TestsSummary {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  /** True only when a `failed` segment was actually present in the
   * `Tests` line; distinguishes "0 failed, stated" from "no `failed`
   * segment at all" so `parse` below knows when it is safe to fall back
   * to `failures.length` instead of trusting a `failed` of 0 that the
   * summary line never actually claimed. */
  hasFailedSegment: boolean;
}

/** Parses the `Tests` summary line segment-wise: every `<digits> <label>`
 * pair between `Tests` and the trailing `(<total>)`, in whatever
 * combination vitest printed. Returns `null` when no `Tests` line is
 * present at all (the "no test files" shape). */
function parseTestsSummary(output: string): TestsSummary | null {
  const lineMatch = TESTS_LINE.exec(output);
  if (!lineMatch) return null;

  const segments = lineMatch[1];
  const summary: TestsSummary = {
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    hasFailedSegment: false,
  };
  let matchedAny = false;
  SEGMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT.exec(segments)) !== null) {
    matchedAny = true;
    const count = Number(match[1]);
    switch (match[2]) {
      case "failed":
        summary.failed = count;
        summary.hasFailedSegment = true;
        break;
      case "passed":
        summary.passed += count;
        break;
      case "expected fail":
        // Folded into `passed`, not tracked separately: vitest itself
        // counts a `.fails` test that failed as expected as a pass.
        summary.passed += count;
        break;
      case "skipped":
        summary.skipped = count;
        break;
      case "todo":
        summary.todo = count;
        break;
    }
  }
  return matchedAny ? summary : null;
}

/**
 * Known boundary: this detector reads the `Test Files`/`Tests` summary
 * lines and ` FAIL ` blocks only. It does not parse vitest's separate
 * `Type Errors`, `Errors`, or `Leaks` summary lines (typecheck failures
 * under `vitest typecheck`, uncaught errors outside any test, and memory
 * leak warnings, respectively) into `summary` or `failures`; a run that
 * prints one of those lines alongside a `Tests` line still gets whatever
 * the `Tests` line and ` FAIL ` blocks state, just nothing from the
 * other three. A run whose *only* signal is one of those lines (no
 * `Tests` line at all) does not match this detector in the first place
 * and falls back to `generic`, which the failures invariant in
 * verify/index.ts still covers with a synthetic failure entry, so
 * nothing is silently reported as a pass either way.
 */
export const vitestDetector: Detector = {
  name: "vitest",
  matches(input: DetectorInput): boolean {
    const output = stripAnsi(input.output);
    return (
      SUMMARY_LINE.test(output) ||
      NO_TEST_FILES.test(output) ||
      TESTS_NO_TESTS.test(output)
    );
  },
  parse(input: DetectorInput): DetectorParseResult {
    const output = stripAnsi(input.output);
    const lines = output.split("\n");
    const failures: DetectorParseResult["failures"] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = matchFailLine(lines[i]);
      if (!match) continue;
      const file = match.file;
      const name = match.name?.trim();
      let assertion: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (candidate.length === 0) continue;
        assertion = candidate;
        break;
      }
      failures.push({
        file,
        ...(name ? { name } : {}),
        message: assertion ?? `FAIL ${file}${name ? ` > ${name}` : ""}`,
      });
    }

    const summary = parseTestsSummary(output);
    let passed = 0;
    let failed = 0;
    // `skipped` in the Summary type carries both vitest's own `skipped`
    // and `todo` segments: both mean "not executed", and the Summary
    // interface has no separate `todo` field for it.
    let skipped = 0;
    if (summary) {
      passed = summary.passed;
      failed = summary.failed;
      skipped = summary.skipped + summary.todo;
    }
    // A `Tests` line with no `failed` segment at all (undercounting to 0
    // by omission, not by stating "0 failed") on a run that nonetheless
    // parsed `FAIL` blocks would otherwise under-report; fall back to the
    // number of parsed failures rather than trust the missing segment.
    if ((!summary || !summary.hasFailedSegment) && failures.length > 0) {
      failed = failures.length;
    }
    // The "no test files" shape (exit 1, no summary line at all) leaves
    // passed/failed/skipped at 0: correct as-is, not a false "nothing
    // failed" claim, since the failures invariant in verify/index.ts
    // synthesizes one failure entry for any fail/error check whose
    // detector parsed zero failures, covering this case without this
    // detector having to fabricate one itself.

    return {
      summary: { passed, failed, skipped, errors: 0, warnings: 0 },
      failures,
      warnings: [],
    };
  },
};
