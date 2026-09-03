import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/** Strips ANSI SGR escape codes (`\x1b[...m`). vitest colorizes its
 * output by default whenever it does not detect an unsupportive
 * terminal, which includes the fully isolated environment a `-x`
 * override's real-tool invocation runs under here (no `TERM`, no
 * `NO_COLOR`): the raw exec tail can carry color codes interleaved with
 * every token this detector matches on, so they are stripped before any
 * regex runs rather than working around them token by token. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Matches vitest 4's own summary line (`Tests  N failed | M passed (T)` on
 * a mixed run, `Tests  N passed (N)` on a green run with no `failed`
 * segment) or the exit-1, no-summary "no test files" case. Anchored on
 * the whole `Tests  <n> (failed|passed)` token so it never fires on
 * unrelated text that merely contains the word "Tests".
 */
const SUMMARY_LINE = /^\s*Tests\s+\d+\s+(failed|passed)\b/m;
const NO_TEST_FILES = /No test files found/;

/** `Tests  N failed | M passed (T)`: mixed run, at least one failure. */
const MIXED_SUMMARY = /Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed\s*\(\d+\)/;
/** `Tests  N passed (N)`: green run, no `failed` segment at all. */
const PASS_SUMMARY = /Tests\s+(\d+)\s+passed\s*\(\d+\)/;

/**
 * ` FAIL  file > suite > name` (one or more `>`-separated suite segments
 * before the test name). The assertion/error text is the first non-blank
 * line that follows, appended to the failure's message so a subagent
 * sees the "why" without opening the log file.
 */
const FAIL_LINE = /^\s*FAIL\s+(\S+)(?:\s+>\s+(.+?))?\s*$/;

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

    const mixed = MIXED_SUMMARY.exec(output);
    const passOnly = mixed ? null : PASS_SUMMARY.exec(output);

    let passed = 0;
    let failed = 0;
    if (mixed) {
      failed = Number(mixed[1]);
      passed = Number(mixed[2]);
    } else if (passOnly) {
      passed = Number(passOnly[1]);
    }
    // The "no test files" shape (exit 1, no summary line at all) leaves
    // passed/failed at 0: correct as-is, not a false "nothing failed"
    // claim, since the failures invariant in verify/index.ts synthesizes
    // one failure entry for any fail/error check whose detector parsed
    // zero failures, covering this case without this detector having to
    // fabricate one itself.

    return {
      summary: { passed, failed, skipped: 0, errors: 0, warnings: 0 },
      failures,
      warnings: [],
    };
  },
};
