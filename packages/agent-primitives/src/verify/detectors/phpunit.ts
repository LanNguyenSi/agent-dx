import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/**
 * PHPUnit 9.6's default (non-TestDox) text reporter, captured from real
 * runs (see `test/fixtures/README.md` for the exact command, tool
 * version, and PHP version used): a green run's `OK (N tests, M
 * assertions)` line, a red run's `FAILURES!` marker plus its `Tests: N,
 * Assertions: M, Failures: F.` tally line, and the "no tests matched at
 * all" `No tests executed!` line (an empty suite, or a `--filter` that
 * matched nothing). Anchored on these whole-line tokens so this detector
 * never fires on vitest's `Tests  N (failed|passed|...) (T)` shape (no
 * `OK (`, `FAILURES!`, or `Tests: N, Assertions: M` token there) or on
 * tsc/eslint's diagnostic-line shapes.
 */
const OK_LINE = /^OK \((\d+) tests?, \d+ assertions?\)\s*$/m;
const FAILURES_MARKER = /^FAILURES!\s*$/m;
const TESTS_TALLY_LINE =
  /^Tests: (\d+), Assertions: \d+(?:, Failures: (\d+))?(?:, Errors: (\d+))?\.\s*$/m;
const NO_TESTS_EXECUTED = /^No tests executed!\s*$/m;

/** One `N) Class::method` failure/error header, PHPUnit's own numbered
 * entry format under `FAILURES!`/`ERRORS!`. */
const ENTRY_HEADER = /^\d+\) (.+?)::(.+)$/;
/** The `file:line` locator line PHPUnit prints under each entry's own
 * message (its own line, set off by a blank line above and below in the
 * default reporter). Captured structurally (`.+` up to the last `:`
 * followed by only digits to end of line), not `\S+`, so a path
 * containing a colon is still handled the same way any other detector
 * here treats a locator line. */
const ENTRY_FILE_LINE = /^(.+):(\d+)$/;
/** A PHP-level deprecation notice PHPUnit lets through to its own
 * output (e.g. a dynamic-property-creation notice on PHP 8.2+, captured
 * on a green run alongside its `OK (...)` line): reported as a free-text
 * detector warning rather than folded into `failures`, since the run
 * itself still passed.
 */
const DEPRECATION_LINE = /^Deprecated: (.+)$/gm;

/**
 * Known boundary: this detector reads PHPUnit's own numbered
 * `FAILURES!`/`ERRORS!` entries and the `OK (...)`/`Tests: ...` summary
 * lines. It does not parse PHPUnit's TestDox reporter, its JUnit XML
 * output, or a `Warnings:`/`Risky:` trailer line into `summary` beyond
 * what `Tests: ...` itself states.
 */
export const phpunitDetector: Detector = {
  name: "phpunit",
  matches(input: DetectorInput): boolean {
    const output = input.output;
    return (
      OK_LINE.test(output) ||
      FAILURES_MARKER.test(output) ||
      TESTS_TALLY_LINE.test(output) ||
      NO_TESTS_EXECUTED.test(output)
    );
  },
  parse(input: DetectorInput): DetectorParseResult {
    const output = input.output;
    const failures: DetectorParseResult["failures"] = [];
    let passed = 0;
    let failed = 0;
    let errors = 0;

    const okMatch = OK_LINE.exec(output);
    const tallyMatch = TESTS_TALLY_LINE.exec(output);
    if (okMatch) {
      passed = Number(okMatch[1]);
    } else if (tallyMatch) {
      const total = Number(tallyMatch[1]);
      failed = Number(tallyMatch[2] ?? 0);
      errors = Number(tallyMatch[3] ?? 0);
      passed = Math.max(total - failed - errors, 0);
    }
    // `No tests executed!` (and any other shape none of the above
    // matched, unreachable when `matches` gated this call) leaves
    // passed/failed/errors at 0: correct as-is, not a false "nothing
    // failed" claim -- same convention as the vitest detector's
    // "no test files" case.

    const lines = output.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const header = ENTRY_HEADER.exec(lines[i]);
      if (!header) continue;
      const name = `${header[1]}::${header[2]}`;
      let file: string | undefined;
      let entryLine: number | undefined;
      let message = "";
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (
          ENTRY_HEADER.test(line) ||
          /^(FAILURES!|ERRORS!)\s*$/.test(line) ||
          /^Tests: \d+, Assertions: \d+/.test(line)
        ) {
          break;
        }
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (file === undefined) {
          const fileLine = ENTRY_FILE_LINE.exec(trimmed);
          if (fileLine) {
            file = fileLine[1];
            entryLine = Number(fileLine[2]);
            continue;
          }
        }
        message = message.length > 0 ? `${message} ${trimmed}` : trimmed;
      }
      i = j - 1;
      failures.push({
        ...(file ? { file } : {}),
        ...(entryLine !== undefined ? { line: entryLine } : {}),
        name,
        message: message.length > 0 ? message : `${name} failed`,
      });
    }

    const warnings: string[] = [];
    for (const match of output.matchAll(DEPRECATION_LINE)) {
      warnings.push(`phpunit_deprecation: ${match[1].trim()}`);
    }

    return {
      summary: { passed, failed, skipped: 0, errors, warnings: 0 },
      failures,
      warnings,
    };
  },
};
