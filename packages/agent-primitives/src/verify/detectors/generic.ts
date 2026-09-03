import type { Detector, DetectorInput, DetectorParseResult } from "../types.js";

/**
 * The fallback detector: it parses no failures out of the output at all,
 * it only reflects the exit code into `summary.passed`/`summary.failed`.
 * It is deliberately "dumb" so the failures invariant in verify/index.ts
 * (a non-zero exit with zero parsed failures gets one synthetic failure
 * entry) is exercised on the real, un-mocked path rather than only in a
 * unit test of the invariant itself. `matches` always returns true, so
 * placing this detector last in a detector list makes it the fallback for
 * any output shape a more specific detector (T-005) does not recognize.
 */
export const genericDetector: Detector = {
  name: "generic",
  matches(): boolean {
    return true;
  },
  parse(input: DetectorInput): DetectorParseResult {
    const passed = input.exitCode === 0 ? 1 : 0;
    return {
      summary: {
        passed,
        failed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      },
      failures: [],
      warnings: [],
    };
  },
};
