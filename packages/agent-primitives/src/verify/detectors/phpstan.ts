import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/**
 * PHPStan's default text formatter, captured from real runs (see
 * `test/fixtures/README.md`): a clean run's ` [OK] No errors` box, and a
 * failing run's per-file table (a `Line   <file>` header, then one
 * `<line>   <message>` row per finding, an optional identifier line
 * below it, closed by a ` [ERROR] Found N errors` box). Anchored on the
 * bracketed `[OK]`/`[ERROR]` tokens, which vitest/tsc/eslint/phpunit
 * never emit, so this detector never fires on their output.
 */
const OK_LINE = /\[OK\]\s*No errors/;
const ERROR_SUMMARY = /\[ERROR\]\s*Found (\d+) errors?/;

/** A per-file table header: `Line` in the first column, the file path in
 * the second (phpstan's own column title doubles as the file name for
 * that table, one table per file with at least one finding). */
const FILE_HEADER = /^\s*Line\s+(.+?)\s*$/;
/** One finding row: a line number, then the message. Never `\S+`: the
 * line number is anchored at the start (a wrapped continuation line, or
 * the identifier line phpstan prints below a finding, carries no digit
 * there and is correctly left unmatched, a documented boundary the way
 * eslint's/tsc's own row regexes document theirs). */
const FINDING_ROW = /^\s*(\d+)\s{2,}(.+?)\s*$/;
/** The table's own border rows (`------ ---`), never mistaken for a
 * finding row since `FINDING_ROW` requires a leading digit. */

export const phpstanDetector: Detector = {
  name: "phpstan",
  matches(input: DetectorInput): boolean {
    const output = input.output;
    return OK_LINE.test(output) || ERROR_SUMMARY.test(output);
  },
  parse(input: DetectorInput): DetectorParseResult {
    const output = input.output;

    if (OK_LINE.test(output)) {
      return {
        summary: { passed: 1, failed: 0, skipped: 0, errors: 0, warnings: 0 },
        failures: [],
        warnings: [],
      };
    }

    const failures: DetectorParseResult["failures"] = [];
    let currentFile: string | undefined;
    for (const line of output.split("\n")) {
      const header = FILE_HEADER.exec(line);
      if (header) {
        currentFile = header[1];
        continue;
      }
      const row = FINDING_ROW.exec(line);
      if (!row) continue;
      failures.push({
        ...(currentFile ? { file: currentFile } : {}),
        line: Number(row[1]),
        message: row[2],
      });
    }

    const summaryMatch = ERROR_SUMMARY.exec(output);
    // The tool's own reported total is preferred over the row count
    // (same convention as `verify/index.ts`'s eslint-totals preference
    // for a truncated tail): a wrapped continuation line phpstan prints
    // below a long message is never mistaken for its own row, so the
    // row count alone can undercount a run with long messages.
    // `failures.length` here is a direct-parse-only fallback: `parse()`
    // is only ever reached, through the normal detector protocol, once
    // `matches()` has already confirmed `ERROR_SUMMARY` (or `OK_LINE`,
    // handled above) is present, so `summaryMatch` is unreachable-false
    // under that protocol. It exists only for a caller invoking `parse()`
    // directly on non-matching input, outside that protocol.
    const errors = summaryMatch ? Number(summaryMatch[1]) : failures.length;

    return {
      summary: { passed: 0, failed: 0, skipped: 0, errors, warnings: 0 },
      failures,
      warnings: [],
    };
  },
};
