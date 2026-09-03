import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/** Strips ANSI SGR escape codes (`\x1b[...m`). `tsc --pretty` (the
 * default when stdout looks like it might support it) colorizes and
 * reflows its diagnostics; the fully isolated environment a `-x`
 * override's real-tool invocation runs under here (no `TERM`, no
 * `NO_COLOR`) still triggers that, so codes are stripped before the
 * diagnostic-line regex runs. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * One `tsc` diagnostic line: `file(line,col): error TSnnnn: message`.
 * `--pretty false` (the shape this detector is written against) emits
 * exactly this, one diagnostic per line, no ANSI, no source snippet.
 * Anchored on the `(line,col): error|warning TSnnnn:` token so it never
 * matches eslint's `line:col  severity` shape (no parentheses, no `TS`
 * code) or vitest's output.
 */
const DIAGNOSTIC_LINE = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

export const tscDetector: Detector = {
  name: "tsc",
  matches(input: DetectorInput): boolean {
    return stripAnsi(input.output)
      .split("\n")
      .some((line) => DIAGNOSTIC_LINE.test(line));
  },
  parse(input: DetectorInput): DetectorParseResult {
    const failures: DetectorParseResult["failures"] = [];
    let errors = 0;
    let warnings = 0;

    for (const line of stripAnsi(input.output).split("\n")) {
      const match = DIAGNOSTIC_LINE.exec(line);
      if (!match) continue;
      const [, file, lineNo, col, severity, code, message] = match;
      if (severity === "error") {
        errors++;
        failures.push({
          file,
          line: Number(lineNo),
          message: `${code}: ${message} (col ${col})`,
        });
      } else {
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
