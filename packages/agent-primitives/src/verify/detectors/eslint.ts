import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/** Strips ANSI SGR escape codes (`\x1b[...m`). eslint's stylish
 * formatter colorizes severities and the summary line whenever it does
 * not detect an unsupportive terminal, which includes the fully
 * isolated environment a `-x` override's real-tool invocation runs
 * under here (no `TERM`, no `NO_COLOR`); codes are stripped before the
 * issue-line regex runs. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * eslint's default "stylish" formatter: an absolute file path on its own
 * line, then one `line:col  severity  message  rule` row per problem
 * (severity `error` or `warning`), then a `✖ N problems (...)` summary.
 * Anchored on the `<digits>:<digits>  (error|warning)  ` token so it
 * never matches tsc's `(line,col): error TSnnnn:` shape (parentheses,
 * `TS` code) or vitest's `Tests`/`FAIL` lines.
 */
const ISSUE_LINE = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/;

/** A stylish file header: an absolute path, alone on its own line (never
 * indented, unlike every issue row under it). */
const FILE_HEADER = /^\/\S*$/;

export const eslintDetector: Detector = {
  name: "eslint",
  matches(input: DetectorInput): boolean {
    return stripAnsi(input.output)
      .split("\n")
      .some((line) => ISSUE_LINE.test(line));
  },
  parse(input: DetectorInput): DetectorParseResult {
    const failures: DetectorParseResult["failures"] = [];
    let errors = 0;
    let warnings = 0;
    let currentFile: string | undefined;

    for (const line of stripAnsi(input.output).split("\n")) {
      if (FILE_HEADER.test(line)) {
        currentFile = line.trim();
        continue;
      }
      const match = ISSUE_LINE.exec(line);
      if (!match) continue;
      const [, lineNo, , severity, message, rule] = match;
      if (severity === "error") {
        errors++;
        failures.push({
          file: currentFile,
          line: Number(lineNo),
          message: `${message.trim()} (${rule})`,
        });
      } else {
        // Warning-severity rows are never failures, on any exit code:
        // eslint itself exits 0 when only warnings are present, and a
        // check that fails for an unrelated reason (a mixed run) still
        // must not count style warnings as the cause.
        warnings++;
      }
    }

    return {
      summary: { passed: 0, failed: 0, skipped: 0, errors, warnings },
      failures,
      warnings: [],
    };
  },
};
