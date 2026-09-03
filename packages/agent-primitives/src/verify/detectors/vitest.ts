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
 * `failed`/`passed`/`skipped`/`todo`) or the exit-1, no-summary "no test
 * files" case. Anchored on the whole `Tests  <n> (failed|passed|skipped|
 * todo)` token so it never fires on unrelated text that merely contains
 * the word "Tests"; `skipped`/`todo` are included here (not just in
 * `parse`) so an all-skipped or all-todo run, which carries neither
 * `failed` nor `passed`, still selects this detector instead of falling
 * back to `generic`.
 */
const SUMMARY_LINE = /^\s*Tests\s+\d+\s+(failed|passed|skipped|todo)\b/m;
const NO_TEST_FILES = /No test files found/;

/**
 * The whole `Tests` summary line, captured as the segment text between
 * `Tests` and the trailing `(<total>)`: vitest 4 lists these segments in
 * a fixed order (`failed`, `passed`, `skipped`, `todo`) but omits any
 * segment whose count is zero, so the line shape varies by run (`N
 * failed (N)`, `N failed | M passed (T)`, `N skipped (N)`, `N failed | M
 * passed | K skipped | L todo (T)`, ...). Parsing the segment text
 * generically (below) rather than hard-coding each combination as its
 * own regex is what makes every one of these shapes readable with one
 * pass.
 */
const TESTS_LINE = /^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/m;
/** One `<digits> <label>` segment inside the `Tests` line's segment text. */
const SEGMENT = /(\d+)\s+(failed|passed|skipped|todo)\b/g;

/**
 * ` FAIL  file > suite > name` (one or more `>`-separated suite segments
 * before the test name). The assertion/error text is the first non-blank
 * line that follows, appended to the failure's message so a subagent
 * sees the "why" without opening the log file.
 */
const FAIL_LINE = /^\s*FAIL\s+(\S+)(?:\s+>\s+(.+?))?\s*$/;

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
        summary.passed = count;
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

export const vitestDetector: Detector = {
  name: "vitest",
  matches(input: DetectorInput): boolean {
    const output = stripAnsi(input.output);
    return SUMMARY_LINE.test(output) || NO_TEST_FILES.test(output);
  },
  parse(input: DetectorInput): DetectorParseResult {
    const output = stripAnsi(input.output);
    const lines = output.split("\n");
    const failures: DetectorParseResult["failures"] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = FAIL_LINE.exec(lines[i]);
      if (!match) continue;
      const file = match[1];
      const name = match[2]?.trim();
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
