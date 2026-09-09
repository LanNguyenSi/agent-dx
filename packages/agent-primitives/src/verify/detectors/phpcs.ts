import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/**
 * PHP_CodeSniffer's default full report, captured from real runs (see
 * `test/fixtures/README.md`): a `FILE: <path>` header, one `<line> |
 * ERROR|WARNING | [fixable-marker] message` row per finding, closed by a
 * `FOUND N ERRORS (AND M WARNINGS)? AFFECTING K LINES` summary. A clean
 * run prints nothing at all (empty stdout, exit 0) -- there is no
 * "no errors" shape to match, the same convention as this package's tsc
 * and eslint detectors, whose own clean captures do not match their
 * detector either. Anchored on the `FOUND ... AFFECTING ... LINES`
 * token, which none of vitest/tsc/eslint/phpunit/phpstan ever emit.
 */
const SUMMARY_LINE =
  /^FOUND (\d+) ERRORS?(?: AND (\d+) WARNINGS?)? AFFECTING (\d+) LINES?/m;
const FILE_HEADER = /^FILE:\s*(.+?)\s*$/;
/** One finding row: `<line> | ERROR|WARNING | [marker] message`. The
 * `[x]`/`[ ]` fixable marker `phpcbf` prints ahead of a fixable
 * violation's message is optional and stripped, never captured as part
 * of the message. A wrapped continuation line (` | | <indent>rest`, no
 * leading line number) is a documented boundary, same as this package's
 * other row-based detectors: it is never matched here, so a message that
 * wraps across two lines is reported with only its first line.
 */
const FINDING_ROW =
  /^\s*(\d+)\s*\|\s*(ERROR|WARNING)\s*\|\s*(?:\[.\]\s*)?(.+?)\s*$/;

export const phpcsDetector: Detector = {
  name: "phpcs",
  matches(input: DetectorInput): boolean {
    return SUMMARY_LINE.test(input.output);
  },
  parse(input: DetectorInput): DetectorParseResult {
    const output = input.output;
    const failures: DetectorParseResult["failures"] = [];
    let currentFile: string | undefined;
    let warningCount = 0;

    for (const line of output.split("\n")) {
      const header = FILE_HEADER.exec(line);
      if (header) {
        currentFile = header[1];
        continue;
      }
      const row = FINDING_ROW.exec(line);
      if (!row) continue;
      const [, lineNo, severity, message] = row;
      if (severity === "WARNING") {
        warningCount++;
        continue;
      }
      failures.push({
        ...(currentFile ? { file: currentFile } : {}),
        line: Number(lineNo),
        message,
      });
    }

    const summaryMatch = SUMMARY_LINE.exec(output);
    // The tool's own reported totals are preferred over the row counts
    // (same convention as `verify/index.ts`'s eslint-totals preference,
    // and this package's phpstan detector): a wrapped continuation
    // row's message is never mistaken for its own finding, but a run
    // with wrapped messages can still undercount by row alone.
    const errors = summaryMatch ? Number(summaryMatch[1]) : failures.length;
    const warnings = summaryMatch ? Number(summaryMatch[2] ?? 0) : warningCount;

    return {
      summary: { passed: 0, failed: 0, skipped: 0, errors, warnings },
      failures,
      warnings: [],
    };
  },
};
