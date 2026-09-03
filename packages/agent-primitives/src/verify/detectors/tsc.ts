import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/** Strips ANSI SGR escape codes (`\x1b[...m`) only. This detector is
 * written against `--pretty false`, which never colorizes on its own;
 * codes are still stripped defensively, since a wrapper around `tsc`
 * (or a future default change) could inject them into that same
 * diagnostic-line shape. Cursor movement and other non-SGR escape
 * sequences are out of scope: `tsc`'s non-pretty diagnostic output has
 * no occasion to emit them, so stripping them would be dead code
 * against every shape this detector is written for. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * One `tsc` diagnostic line: `file(line,col): error TSnnnn: message`.
 * `--pretty false` emits exactly this, one diagnostic per line, no ANSI,
 * no source snippet; a bare `tsc --noEmit` (no explicit `--pretty
 * false`) emits the identical shape whenever it is not connected to a
 * TTY, which every invocation through `exec.ts` is, so the detector
 * targets this one shape regardless of which of the two commands ran.
 * Anchored on the `(line,col): error|warning TSnnnn:` token so it never
 * matches eslint's `line:col  severity` shape (no parentheses, no `TS`
 * code) or vitest's output. The file capture is never `\S+`: it is
 * captured structurally up to the line's own `(line,col):` separator
 * (greedy `.+` stops at the last `(` on the line, which is always that
 * separator, never a `(` a path could itself contain, since a path
 * containing a literal `(line,col):`-shaped suffix is not a diagnostic
 * this detector is written to guard against).
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
