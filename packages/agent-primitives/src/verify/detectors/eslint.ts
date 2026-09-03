import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/** Strips ANSI SGR escape codes (`\x1b[...m`) only. eslint's stylish
 * formatter colorizes severities and the summary line whenever it does
 * not detect an unsupportive terminal, which includes the fully
 * isolated environment a `-x` override's real-tool invocation runs
 * under here (no `TERM`, no `NO_COLOR`); codes are stripped before the
 * issue-line and header regexes run. Cursor movement and other non-SGR
 * escape sequences are out of scope: the stylish formatter's default
 * text output never emits them, so stripping them would be dead code
 * against every shape this detector is written for. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * eslint's default "stylish" formatter: an absolute file path on its own
 * line, then one `line:col  severity  message[  rule]` row per problem
 * (severity `error` or `warning`; the rule id column is present for a
 * lint rule violation but absent for a `Parsing error: ...` row, which
 * has no associated rule), then a `✖ N problems (...)` summary.
 * Anchored on the `<digits>:<digits>  (error|warning)  ` token so it
 * never matches tsc's `(line,col): error TSnnnn:` shape (parentheses,
 * `TS` code) or vitest's `Tests`/`FAIL` lines. The rule id, when present,
 * is captured as a trailing token set off by two or more spaces from the
 * message; a row with no such trailing token (a parsing error) still
 * matches, with an `undefined` rule.
 */
const ISSUE_LINE =
  /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/;

/** A stylish file header: a line starting with `/` at column 0, never
 * indented, unlike every issue row under it (which is always indented)
 * and the `✖ N problems` summary line (which never starts with `/`).
 * Matched structurally on that leading-slash-at-column-0 shape rather
 * than requiring the rest of the line to contain no whitespace, so an
 * absolute path with a space in it (a real, if unusual, filesystem path)
 * is still recognized as a header instead of falling through and
 * leaving the previous file's rows misattributed to it. */
const FILE_HEADER = /^\//;

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
      if (line.trim().length === 0) {
        // A blank line always separates one file's block from the next
        // (or from the trailing summary): resetting here means a file
        // whose header this detector fails to recognize for any reason
        // never silently inherits the previous file's header instead.
        currentFile = undefined;
        continue;
      }
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
          message: rule ? `${message.trim()} (${rule})` : message.trim(),
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
