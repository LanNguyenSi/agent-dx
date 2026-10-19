import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  probe,
  type ProbeOptions,
  type ProbeResult,
} from "../src/probe/index.js";
import {
  detectKnownZeroTestsEvidence,
  hasKnownTestSummary,
} from "../src/probe/zero-tests.js";
import { phpunitZeroTestsVerdict } from "../src/verify/detectors/phpunit.js";
import { initNodeTestDotRepo } from "./helpers/node-test-dot-repo.js";

/**
 * Zero-tests-executed detection (task `273b3851`): a baseline (or a
 * mutant run) that exits `0` with nothing actually executed must never
 * be read as a real pass. See the CHANGELOG's `Unreleased` entry for the
 * real bug this closes (batch 43, a vitest `-t "name (with parens)"`
 * filter matching no test inside files vitest still loaded, `130
 * skipped` on both the baseline and the mutant run, reported
 * `survived`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, "..");

/** Reads one captured real-tool-output fixture (see
 * test/fixtures/README.md for the commands, tool versions and exit codes
 * these were captured from). */
function readCaptured(name: string): string {
  return fs.readFileSync(
    path.join(__dirname, "fixtures", "captured", `${name}.txt`),
    "utf8",
  );
}
const VITEST_ENTRY = path.join(
  PKG_ROOT,
  "node_modules",
  "vitest",
  "vitest.mjs",
);

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-zero-tests-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Unit-level detector tests (synthetic output, no real vitest/node
// process involved -- see the live-fixture describe block below for the
// real end-to-end pair). ---------------------------------------------

describe("detectKnownZeroTestsEvidence()", () => {
  it("vitest JSON: a captured filter miss has pending tests but zero executed", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("vitest-json-filter-miss"), ""),
    ).toEqual({ detected: true, via: "vitest" });
  });

  it("vitest JSON: a captured matching filter is not flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(
        readCaptured("vitest-json-filter-match"),
        "",
      ),
    ).toEqual({ detected: false });
  });

  it("vitest JSON: recognizes a complete result independently from stdout or stderr", () => {
    expect(
      detectKnownZeroTestsEvidence("", readCaptured("vitest-json-filter-miss")),
    ).toEqual({ detected: true, via: "vitest" });
  });

  it("vitest JSON: rejects partial, malformed, and lookalike objects", () => {
    for (const output of [
      '{"numPassedTests":0,"numFailedTests":0}',
      '{"numTotalTests":2,"numPassedTests":0,"numFailedTests":0,"numPendingTests":2',
      'runner log {"numTotalTests":2,"numPassedTests":0,"numFailedTests":0,"numPendingTests":2,"numTodoTests":0}',
      '{"numTotalTests":2,"numPassedTests":0,"numFailedTests":0,"numPendingTests":1,"numTodoTests":0}',
    ]) {
      expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
        detected: false,
      });
    }
  });

  it("vitest: 'No test files found' (no matching file at all)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "\n RUN  v4.1.11 /project\n\nNo test files found, exiting with code 1\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "vitest" });
  });

  it("vitest: an all-skipped Tests summary (0 passed, 0 failed)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      " Test Files  1 skipped (1)\n      Tests  2 skipped (2)\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "vitest" });
  });

  it("vitest: a real, executed, passing summary is NOT flagged (negative control)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      " Test Files  1 passed (1)\n      Tests  2 passed (2)\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("vitest: a mixed run (some passed, some skipped) is NOT flagged", () => {
    const evidence = detectKnownZeroTestsEvidence(
      " Test Files  1 passed (1)\n      Tests  1 passed | 1 skipped (2)\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("node --test: the spec reporter's zero-count summary", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "ℹ tests 0\nℹ pass 0\nℹ fail 0\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "node_test" });
  });

  it("node --test: the tap reporter's zero-count summary", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n",
      "",
    );
    expect(evidence).toEqual({ detected: true, via: "node_test" });
  });

  it("node --test: a real, executed count is NOT flagged", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "ℹ tests 1\nℹ pass 1\nℹ fail 0\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("node --test: captured name-pattern match and miss are intentionally indistinguishable", () => {
    for (const fixture of [
      "node-test-name-pattern-match",
      "node-test-name-pattern-miss",
    ]) {
      expect(detectKnownZeroTestsEvidence(readCaptured(fixture), "")).toEqual({
        detected: false,
      });
      expect(hasKnownTestSummary(readCaptured(fixture), "")).toBe(true);
    }
  });

  it("an unrecognized runner's output is not flagged by either detector", () => {
    const evidence = detectKnownZeroTestsEvidence("all good, 0 issues\n", "");
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit: 'No tests executed!' (an empty suite, or a --filter matching nothing)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "PHPUnit 9.6.36 by Sebastian Bergmann and contributors.\n\nNo tests executed!\n",
      "",
    );
    // `ambiguous: false`: PHPUnit itself STATED nothing ran (the
    // `"zero"` verdict), so the baseline-stage caller refuses
    // `no_tests_executed`, never the dedicated ambiguous reason.
    expect(evidence).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: false,
    });
  });

  it("phpunit: a stated zero-count OK summary ('OK (0 tests, 0 assertions)')", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "PHPUnit 9.6.36 by Sebastian Bergmann and contributors.\n\nOK (0 tests, 0 assertions)\n",
      "",
    );
    expect(evidence).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: false,
    });
  });

  it("phpunit: a real, executed, passing summary is NOT flagged (negative control)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "PHPUnit 9.6.36 by Sebastian Bergmann and contributors.\n\nOK (2 tests, 2 assertions)\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit: a real failing run (Tests: N, Assertions: M, Failures: F.) is NOT flagged", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "FAILURES!\nTests: 2, Assertions: 2, Failures: 1.\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit: a run with a real failure AND a real skip is NOT flagged (round-1 review finding: the old fixed-shape tally regex parsed this to passed:0/failed:0/errors:0, misread as no_tests_executed even though the suite caught the mutant)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "FAILURES!\nTests: 3, Assertions: 2, Failures: 1, Skipped: 1.\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit: an all-skipped run IS flagged, even though no FAILURES!/ERRORS! marker is present at all (round-1 review finding)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "OK, but incomplete, skipped, or risky tests!\nTests: 2, Assertions: 0, Skipped: 2.\n",
      "",
    );
    expect(evidence).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: false,
    });
  });

  it("phpunit: an ERRORS! run (errors and failures together, Errors: printed before Failures:) is NOT flagged", () => {
    const evidence = detectKnownZeroTestsEvidence(
      "ERRORS!\nTests: 6, Assertions: 3, Errors: 1, Failures: 1, Skipped: 1, Incomplete: 1.\n",
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit: a PHPUnit 9 warnings-only run IS flagged (it exits 0 with nothing executed, and reads as a green passed: 1 to any derivation that counts a synthetic warning as a test)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      readCaptured("phpunit-warnings"),
      "",
    );
    expect(evidence).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: false,
    });
  });

  it("phpunit: a risky test alongside a real one is NOT flagged (a risky test ran)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      readCaptured("phpunit-risky-and-real"),
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit: an all-risky run is NOT flagged either, even though it prints the same marker an all-skipped run does", () => {
    const evidence = detectKnownZeroTestsEvidence(
      readCaptured("phpunit-risky-only"),
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit: an errors-plus-skipped run with no failures is NOT flagged", () => {
    const evidence = detectKnownZeroTestsEvidence(
      readCaptured("phpunit-errors-and-skipped"),
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit 11: a PHPUnit-error (invalid data provider) run alongside a real Errors:1 count is NOT flagged (a real test genuinely ran)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      readCaptured("phpunit-error-data-provider"),
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit 11: a two-word 'PHPUnit Deprecations: N' tally token is NOT flagged (both tests genuinely ran and passed, tracker 3a0c5242)", () => {
    const evidence = detectKnownZeroTestsEvidence(
      readCaptured("phpunit-two-word-deprecation-tally"),
      "",
    );
    expect(evidence).toEqual({ detected: false });
  });

  it("phpunit 11: an exit()/die() mid-suite run IS flagged, via the ambiguous (unreadable-result) collapse rather than a zero-tests claim (tracker 3a0c5242, residual (c))", () => {
    // The reading itself says only that the result cannot be read from
    // this output (banner present, no summary line, no progress
    // counter, no post-run `Time:` line -- the capture's own single
    // progress dot is in fact one test that ran and passed before the
    // kill). `probe` collapses that to "refuse", the fail-safe
    // direction here, while `verify` keeps the distinction and warns
    // `zero_tests_ambiguous` instead of claiming `no_tests_executed`.
    const output = readCaptured("phpunit-exit-mid-suite");
    expect(phpunitZeroTestsVerdict(output).verdict).toBe("ambiguous");
    // `ambiguous: true`: the baseline-stage caller (`setup.ts`) reads
    // this to refuse `zero_tests_ambiguous` here instead of
    // `no_tests_executed`.
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: true,
    });
  });

  it("phpunit 9: the 9.6.36 exit()/die() capture is flagged the same way (the unreadable-result reading is not version-specific)", () => {
    const output = readCaptured("phpunit-exit-mid-suite-9");
    expect(phpunitZeroTestsVerdict(output).verdict).toBe("ambiguous");
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: true,
    });
  });

  it("phpunit 11: a COMPLETED green `--no-results` run is NOT flagged, so such a baseline is scored instead of refused (round-3 counterexample)", () => {
    // Captured real (PHPUnit 11.5.56, exit 0, two tests that both ran
    // and passed): `--no-results` suppresses the result REPORT, not the
    // run, and the progress counter plus the post-run Time/Memory line
    // are still there. Read as a killed run, this refused every probe
    // baseline of a project that runs PHPUnit this way.
    const output = readCaptured("phpunit-no-results-green");
    expect(phpunitZeroTestsVerdict(output).verdict).toBe("not_zero");
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: false,
    });
    // Still recognized as a known test summary, so the generic
    // byte-identical fallback stays out of the way of this shape.
    expect(hasKnownTestSummary(output, "")).toBe(true);
  });

  it("phpunit 11: a suppressed-report run whose --filter matched nothing IS flagged (fail-closed: nothing in that output says whether anything ran)", () => {
    const output = readCaptured("phpunit-no-results-filter-miss");
    expect(phpunitZeroTestsVerdict(output).verdict).toBe("ambiguous");
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: true,
    });
  });

  it("phpunit 11: a `--list-tests` listing IS flagged too, the documented over-caution of the same collapse", () => {
    const output = readCaptured("phpunit-list-tests");
    expect(phpunitZeroTestsVerdict(output).verdict).toBe("ambiguous");
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: true,
    });
  });

  it("phpunit: a banner-less green PHPUnit-11-shaped tally IS flagged here, the documented fail-safe collapse of the ambiguous reading", () => {
    // The same shape `verify` reports as `zero_tests_ambiguous` (no
    // version banner survived truncation, and the tally's plain
    // `Warnings: 15` count is what decides whether anything ran: read
    // as a 9 nothing did, read as a 10+ all 15 did and passed).
    // `probe` cannot warn and carry on the way `verify` can -- its
    // alternatives are to refuse the run or to score it -- so it
    // refuses: scoring it would compare a run whose executed count
    // cannot be read against the baseline as if it had run and passed,
    // and report `survived`. The refusal costs a probe result; the
    // other collapse would buy a verdict with a false one. Documented
    // in `probe/zero-tests.ts`'s own docblock and in docs/probe.md.
    const output = [
      "WWWWWWWWWWWWWWW                    15 / 15 (100%)",
      "",
      "Time: 00:00.412, Memory: 10.00 MB",
      "",
      "OK, but there were issues!",
      "Tests: 15, Assertions: 15, Warnings: 15.",
      "",
    ].join("\n");
    expect(phpunitZeroTestsVerdict(output).verdict).toBe("ambiguous");
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: true,
      via: "phpunit",
      ambiguous: true,
    });
  });

  it("phpunit: the same banner-less tally WITH its version banner is not flagged at all (the ambiguity is the missing banner, not the Warnings token)", () => {
    const output = [
      "PHPUnit 11.5.56 by Sebastian Bergmann and contributors.",
      "",
      "WWWWWWWWWWWWWWW                    15 / 15 (100%)",
      "",
      "OK, but there were issues!",
      "Tests: 15, Assertions: 15, Warnings: 15.",
      "",
    ].join("\n");
    expect(phpunitZeroTestsVerdict(output).verdict).toBe("not_zero");
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: false,
    });
  });
});

// --- pytest (captured real pytest 8.4.2, Python 3.9.6, `python3 -m
// pytest -p no:cacheprovider`, exit codes named per case): the final
// summary line in its bare `-q` form and its default-verbosity `=`-
// padded banner form. Timing digits stay IN these fixtures (unlike the
// PHP captures' elided `Time:` values): the whole point of recognizing
// the line is that its timing varies run to run, which is what used to
// make the generic byte-identical fallback's verdict flip. -------------

describe("detectKnownZeroTestsEvidence(): pytest (captured pytest 8.4.2)", () => {
  it("pytest: a passing run in the banner form (exit 0) is NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-pass"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-pass"), "")).toBe(true);
  });

  it("pytest: a passing run in the -q form (exit 0) is NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-pass-quiet"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-pass-quiet"), "")).toBe(
      true,
    );
  });

  it("pytest: a failing run in the banner form (exit 1) is NOT flagged (a real test executed)", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-fail"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-fail"), "")).toBe(true);
  });

  it("pytest: a failing run in the -q form (exit 1) is NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-fail-quiet"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-fail-quiet"), "")).toBe(
      true,
    );
  });

  it("pytest: a fixture-error run in the banner form (exit 1, `1 error`) is NOT flagged (the test ran and errored)", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-error"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-error"), "")).toBe(true);
  });

  it("pytest: a fixture-error run in the -q form (exit 1, `1 error`) is NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-error-quiet"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-error-quiet"), "")).toBe(
      true,
    );
  });

  it("pytest: `no tests ran` in the banner form (empty file, exit 5) IS a zero-tests detection", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-no-tests-ran"), ""),
    ).toEqual({ detected: true, via: "pytest" });
    expect(hasKnownTestSummary(readCaptured("pytest-no-tests-ran"), "")).toBe(
      true,
    );
  });

  it("pytest: `no tests ran` in the -q form (exit 5) IS a zero-tests detection", () => {
    expect(
      detectKnownZeroTestsEvidence(
        readCaptured("pytest-no-tests-ran-quiet"),
        "",
      ),
    ).toEqual({ detected: true, via: "pytest" });
    expect(
      hasKnownTestSummary(readCaptured("pytest-no-tests-ran-quiet"), ""),
    ).toBe(true);
  });

  it("pytest: a mixed-count run in the banner form (exit 1: failed+passed+skipped+deselected+xfailed+xpassed+warning) is NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-mixed"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-mixed"), "")).toBe(true);
  });

  it("pytest: the same mixed counts in the -q form are NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-mixed-quiet"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-mixed-quiet"), "")).toBe(
      true,
    );
  });

  it("pytest: an all-skipped run in the banner form (exit 0!) IS flagged: nothing executed despite the green exit code", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-skipped-only"), ""),
    ).toEqual({ detected: true, via: "pytest" });
    expect(hasKnownTestSummary(readCaptured("pytest-skipped-only"), "")).toBe(
      true,
    );
  });

  it("pytest: an all-skipped run in the -q form IS flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(
        readCaptured("pytest-skipped-only-quiet"),
        "",
      ),
    ).toEqual({ detected: true, via: "pytest" });
  });

  it("pytest: an all-deselected `-k` run in the banner form (`3 deselected`, exit 5) IS flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-deselected-only"), ""),
    ).toEqual({ detected: true, via: "pytest" });
    expect(
      hasKnownTestSummary(readCaptured("pytest-deselected-only"), ""),
    ).toBe(true);
  });

  it("pytest: an all-deselected `-k` run in the -q form IS flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(
        readCaptured("pytest-deselected-only-quiet"),
        "",
      ),
    ).toEqual({ detected: true, via: "pytest" });
  });

  it("pytest: a skipped+deselected-only `-k` run (`1 skipped, 1 deselected`, exit 0) IS flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(
        readCaptured("pytest-skipped-deselected"),
        "",
      ),
    ).toEqual({ detected: true, via: "pytest" });
  });

  it("pytest: plural `warnings`/`errors` counts (exit 1) are recognized and NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(
        readCaptured("pytest-warnings-errors-plural"),
        "",
      ),
    ).toEqual({ detected: false });
    expect(
      hasKnownTestSummary(readCaptured("pytest-warnings-errors-plural"), ""),
    ).toBe(true);
  });

  it("pytest: a warnings-only summary (`1 warning in 0.00s`, exit 5: a conftest.py warning at import, a test file collecting nothing) IS flagged -- the warning count is neutral, nothing else ran (round-1 review finding)", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-warning-only"), ""),
    ).toEqual({ detected: true, via: "pytest" });
    expect(hasKnownTestSummary(readCaptured("pytest-warning-only"), "")).toBe(
      true,
    );
  });

  it("pytest: a skipped test plus a warning (`1 skipped, 1 warning`, exit 0) IS flagged: ignoring the neutral warning, only a skipped count remains", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-skipped-warning"), ""),
    ).toEqual({ detected: true, via: "pytest" });
    expect(
      hasKnownTestSummary(readCaptured("pytest-skipped-warning"), ""),
    ).toBe(true);
  });

  it("pytest: a deselected test plus a warning (`1 deselected, 1 warning`, exit 5) IS flagged, the same neutral-warning reading", () => {
    expect(
      detectKnownZeroTestsEvidence(
        readCaptured("pytest-deselected-warning"),
        "",
      ),
    ).toEqual({ detected: true, via: "pytest" });
    expect(
      hasKnownTestSummary(readCaptured("pytest-deselected-warning"), ""),
    ).toBe(true);
  });

  it("pytest: a passing test plus a warning (`1 passed, 1 warning`, exit 0) is NOT flagged: neutrality only ignores the warning, the passed count still executed", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-passed-warning"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-passed-warning"), "")).toBe(
      true,
    );
  });

  it("pytest: a failing test plus a warning (`1 failed, 1 warning`, exit 1) is NOT flagged", () => {
    expect(
      detectKnownZeroTestsEvidence(readCaptured("pytest-failed-warning"), ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary(readCaptured("pytest-failed-warning"), "")).toBe(
      true,
    );
  });

  it("pytest: the real long-run capture (`1 passed in 61.15s (0:01:01)`, a 61s sleep, exit 0) is recognized and NOT flagged: the ` (H:MM:SS)` suffix pytest appends to timings of a minute or more is part of the timing tail (round-1 review finding)", () => {
    const output = readCaptured("pytest-long-run");
    expect(output).toContain("1 passed in 61.15s (0:01:01)");
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: false,
    });
    expect(hasKnownTestSummary(output, "")).toBe(true);
  });

  it("pytest: hand-written long-run lines -- `1 passed in 61.23s (0:01:01)` matches with and without `=` padding and `no tests ran in 61.23s (0:01:01)` is a zero-tests detection (the same real shape as the capture above, spelled with fixed digits; the bare `-q` variant of this exact line is the capture's own line with the banner padding removed, so no second 61s run was captured for it)", () => {
    for (const line of [
      "1 passed in 61.23s (0:01:01)\n",
      "= 1 passed in 61.23s (0:01:01) =\n",
      "====================================== 1 passed in 61.23s (0:01:01) ======================================\n",
    ]) {
      expect(detectKnownZeroTestsEvidence(line, "")).toEqual({
        detected: false,
      });
      expect(hasKnownTestSummary(line, "")).toBe(true);
    }
    expect(
      detectKnownZeroTestsEvidence("no tests ran in 61.23s (0:01:01)\n", ""),
    ).toEqual({ detected: true, via: "pytest" });
    expect(hasKnownTestSummary("no tests ran in 61.23s (0:01:01)\n", "")).toBe(
      true,
    );
    // And the suffix must stay closed: a trailing suffix-shaped word is
    // still trailing text the `$` anchor rejects (the finding-1
    // negative, re-pinned against the widened timing tail).
    expect(
      detectKnownZeroTestsEvidence("3 passed in 0.01s and more\n", ""),
    ).toEqual({ detected: false });
    expect(hasKnownTestSummary("3 passed in 0.01s and more\n", "")).toBe(false);
  });

  it("pytest: two captures of the same suite with DIFFERENT timing digits (`0.11s` vs `0.25s`) are both recognized and both not flagged (the byte-identity coin flip this closes)", () => {
    const run1 = readCaptured("pytest-timing-run1");
    const run2 = readCaptured("pytest-timing-run2");
    // The two tails genuinely differ in their timing digits: byte
    // identity would NOT hold for this pair, which is exactly why the
    // summary line has to be recognized on its own shape.
    expect(run1).not.toBe(run2);
    expect(run1).toContain("1 passed in 0.11s");
    expect(run2).toContain("1 passed in 0.25s");
    for (const output of [run1, run2]) {
      expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
        detected: false,
      });
      expect(hasKnownTestSummary(output, "")).toBe(true);
    }
  });
});

// --- Negative controls for the pytest summary-line regex: the other
// detectors' timing/count lines keep whatever result they had before
// the pytest branch existed (the branch is ordered last in both
// functions and none of these lines matches it, pinned here at the
// public-API level; `via` also never flips to "pytest" for them). -----

describe("pytest summary-line regex, negative controls", () => {
  it("vitest's own `Tests  3 passed (3)` line is not read by the pytest branch (it stays a vitest summary, and a nonzero one, exactly as before the pytest regex existed)", () => {
    const output = "      Tests  3 passed (3)\n";
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: false,
    });
    expect(hasKnownTestSummary(output, "")).toBe(true);
  });

  it("vitest's `Duration  N.NNs (...)` timing line is recognized by NO detector (unknown to pytest, whose regex must not fire on a trailing ` in ...s`-shaped tail)", () => {
    const output =
      "   Duration  1.23s (transform 45ms, setup 0ms, collect 30ms, tests 5ms, environment 0ms, prepare 1ms)\n";
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: false,
    });
    expect(hasKnownTestSummary(output, "")).toBe(false);
  });

  it("node's own `duration_ms` timing lines (spec and tap shapes) are recognized by NO detector (the word and timing-tail anchors hold)", () => {
    for (const output of [
      "ℹ duration_ms 29.783208\n",
      "# duration_ms 29.78\n",
    ]) {
      expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
        detected: false,
      });
      expect(hasKnownTestSummary(output, "")).toBe(false);
    }
  });

  it("PHPUnit's `Time:`/tally lines are unchanged by the pytest branch (`Time: 00:00.412, Memory: 10.00 MB` alone stays unknown; the tally still routes through the phpunit branch, never `via: pytest`)", () => {
    const timeLine = "Time: 00:00.412, Memory: 10.00 MB\n";
    expect(detectKnownZeroTestsEvidence(timeLine, "")).toEqual({
      detected: false,
    });
    expect(hasKnownTestSummary(timeLine, "")).toBe(false);
    const tally = "Tests: 15, Assertions: 15, Warnings: 15.\n";
    expect(detectKnownZeroTestsEvidence(tally, "").via).not.toBe("pytest");
  });

  it("an unknown runner's prose that merely contains counts or `passed in` stays unknown to both functions", () => {
    for (const output of [
      "all 5 tests passed in 0.5s of CI time\n",
      "5 passed in the final report\n",
      "3 passed (3) in 0.51s\n",
      "all good, 0 issues\n",
    ]) {
      expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
        detected: false,
      });
      expect(hasKnownTestSummary(output, "")).toBe(false);
    }
  });

  it("a pytest-shaped summary behind a log-prefix (`INFO 2 passed in 3s`, the shape a logging formatter prints when pytest's own output is re-logged) is NOT a summary: the `^` anchor is load-bearing (round-1 review finding)", () => {
    const output = "INFO 2 passed in 3s\n";
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: false,
    });
    expect(hasKnownTestSummary(output, "")).toBe(false);
  });

  it("a pytest-shaped summary followed by trailing text that is not pytest's own long-run suffix (`3 passed in 0.01s and more`) is NOT a summary: the `$` anchor is load-bearing (round-1 review finding)", () => {
    const output = "3 passed in 0.01s and more\n";
    expect(detectKnownZeroTestsEvidence(output, "")).toEqual({
      detected: false,
    });
    expect(hasKnownTestSummary(output, "")).toBe(false);
  });
});

describe("hasKnownTestSummary()", () => {
  it("true for complete Vitest JSON summaries, including zero and nonzero runs", () => {
    expect(
      hasKnownTestSummary(readCaptured("vitest-json-filter-match"), ""),
    ).toBe(true);
    expect(
      hasKnownTestSummary(readCaptured("vitest-json-filter-miss"), ""),
    ).toBe(true);
  });

  it("does not treat a JSON lookalike as a known Vitest summary", () => {
    expect(
      hasKnownTestSummary('{"numPassedTests":0,"numFailedTests":0}', ""),
    ).toBe(false);
  });

  it("true for a vitest summary, zero-count or not", () => {
    expect(hasKnownTestSummary(" Tests  2 passed (2)\n", "")).toBe(true);
    expect(hasKnownTestSummary(" Tests  2 skipped (2)\n", "")).toBe(true);
  });

  it("true for a node --test summary line", () => {
    expect(hasKnownTestSummary("ℹ tests 3\n", "")).toBe(true);
  });

  it("true for a phpunit summary, zero-count or not", () => {
    expect(hasKnownTestSummary("OK (2 tests, 2 assertions)\n", "")).toBe(true);
    expect(hasKnownTestSummary("No tests executed!\n", "")).toBe(true);
  });

  it("true for phpunit's all-skipped marker, even with no FAILURES!/ERRORS! line (round-1 review finding: this must be true so the generic byte-identical fallback stays out of the way and the phpunit branch alone decides)", () => {
    expect(
      hasKnownTestSummary(
        "OK, but incomplete, skipped, or risky tests!\nTests: 2, Assertions: 0, Skipped: 2.\n",
        "",
      ),
    ).toBe(true);
  });

  it("false for output neither detector recognizes", () => {
    expect(hasKnownTestSummary("ok\n", "")).toBe(false);
    expect(hasKnownTestSummary("", "")).toBe(false);
  });

  it("true for the exit()/die() mid-suite capture (PHPUnit's own banner alone, no completion marker at all; tracker 3a0c5242)", () => {
    expect(
      hasKnownTestSummary(readCaptured("phpunit-exit-mid-suite"), ""),
    ).toBe(true);
  });
});

// --- probe() through the shared baseline-stage check (setup.ts): a
// synthetic testCommand stands in for a real test runner's output, the
// same idiom test/probe-refusal-contract.test.ts's own provocations
// use. -----------------------------------------------------------------

function initGitRepo(): string {
  const repo = makeTmpDir();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  fs.writeFileSync(
    path.join(repo, "fixture.js"),
    "module.exports = { flag: true };\n",
  );
  // Real, dependent test (reads fixture.js, prints "ready" only once its
  // own assertion has already passed): unlike a fixed echo, mutating
  // fixture.js genuinely changes this test command's outcome, so a
  // negative control built on it is not itself ambiguous between "ran
  // for real" and "printed the same fixed text either way".
  fs.writeFileSync(
    path.join(repo, "fixture.test.js"),
    [
      "const assert = require('node:assert');",
      "const { flag } = require('./fixture.js');",
      "assert.strictEqual(flag, true);",
      "console.log('ready');",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    { cwd: repo },
  );
  return repo;
}

function baseOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 1,
    form: "replace",
    replaceText: "module.exports = { flag: false };",
    testCommand: "exit 0",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

describe("probe(): baseline-stage no_tests_executed refusal", () => {
  it("a baseline that exits 0 but whose own output is an all-skipped vitest summary is refused, never a verdict", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"console.log(' Test Files  1 skipped (1)'); console.log('      Tests  2 skipped (2)');\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(result.mutation_probe?.reason).toBe("no_tests_executed");
    expect(result.mutant).toBeDefined();
    // No real killed/survived verdict was reached, so there is nothing
    // for `expectation` to report agreement or disagreement about. This
    // baseline-side refusal builds its mutation_probe without touching
    // step.ts's expectation guard, so it pins the envelope shape only;
    // the mutant-side case further down is the one that discriminates.
    expect(result.mutation_probe?.expectation).toBeUndefined();
  });

  it("a baseline that exits 1 with vitest's own 'No test files found' text is no_tests_executed, never baseline_failed", async () => {
    // Reviewer round-1 finding: the check just above is ordered BEFORE
    // the exit-code branch specifically so vitest's exit-1 "No test
    // files found" shape (as opposed to the exit-0 all-skipped/`-t`
    // shape the test above pins) is still read as `no_tests_executed`,
    // never misread as a genuinely failing baseline.
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"console.log('No test files found, exiting with code 1'); process.exit(1);\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
  });

  it("negative control: a baseline that genuinely runs and passes (and a mutant the suite genuinely catches) is never flagged", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, { testCommand: "node fixture.test.js" }),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });

  it("a baseline that exits 0 but whose own output is PHPUnit's 'No tests executed!' is refused, never a verdict", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"console.log('PHPUnit 9.6.36 by Sebastian Bergmann and contributors.'); console.log(''); console.log('No tests executed!');\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(result.mutation_probe?.reason).toBe("no_tests_executed");
    expect(result.mutant).toBeDefined();
  });

  it("a baseline that exits 0 but whose own output is PHPUnit's all-skipped marker (no FAILURES!/ERRORS! at all) is refused, never a verdict (round-1 review finding)", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"console.log('PHPUnit 9.6.36 by Sebastian Bergmann and contributors.'); console.log(''); console.log('OK, but incomplete, skipped, or risky tests!'); console.log('Tests: 2, Assertions: 0, Skipped: 2.');\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(result.mutation_probe?.reason).toBe("no_tests_executed");
    expect(result.mutant).toBeDefined();
  });

  it("a baseline whose phpunit output cannot be read either way (banner, no result report) refuses zero_tests_ambiguous, never no_tests_executed", async () => {
    // The same mid-suite exit()/die() shape `phpunit-exit-mid-suite.txt`
    // captures real: banner, one progress dot, nothing else PHPUnit's
    // own result report requires. `phpunitZeroTestsVerdict` reads this
    // `"ambiguous"`, never `"zero"` -- nothing here STATES that no test
    // ran -- so the baseline-stage refusal must name the dedicated
    // reason instead of overstating it as `no_tests_executed`.
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"console.log('PHPUnit 11.5.56 by Sebastian Bergmann and contributors.'); console.log(''); console.log('Runtime:       PHP 8.3.33'); console.log(''); console.log('.');\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("zero_tests_ambiguous");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(result.mutation_probe?.reason).toBe("zero_tests_ambiguous");
    expect(result.mutant).toBeDefined();
    expect(
      result.warnings.some(
        (w) =>
          w.includes("cannot be read for whether any test executed") &&
          w.includes("phpunit"),
      ),
    ).toBe(true);
  });
});

describe("probe(): --require-baseline-evidence", () => {
  it("refuses baseline_evidence_not_matched when the pattern does not match the baseline output", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand: "node fixture.test.js",
        requireBaselineEvidence: /this text never appears/,
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_evidence_not_matched");
    expect(result.mutation_probe?.result).toBe("not_run");
  });

  it("proceeds normally (to a real killed verdict) once the pattern matches the baseline output", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        testCommand: "node fixture.test.js",
        requireBaselineEvidence: /ready/,
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  });

  it("a truncated baseline tail that missed the pattern names the truncation in the warning", async () => {
    // Reviewer round-1 finding: `--require-baseline-evidence` (like the
    // zero-tests detectors) only ever sees the CAPTURED tail
    // (`exec.ts`'s 60-line/6000-char bound). A pattern printed first,
    // then scrolled out of the tail by >60 filler lines, reads as a
    // plain miss unless the warning names the truncation.
    const repo = initGitRepo();
    const fillerLines = Array.from(
      { length: 120 },
      (_, i) => `console.log('filler line ${i}');`,
    ).join(" ");
    const result = await probe(
      baseOptions(repo, {
        testCommand: `node -e "console.log('EVIDENCE-LINE'); ${fillerLines}"`,
        requireBaselineEvidence: /EVIDENCE-LINE/,
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_evidence_not_matched");
    expect(
      result.warnings.some((w) => /captured stdout tail was truncated/.test(w)),
    ).toBe(true);
  });
});

// --- The mutant-side zero-tests detector (step.ts's classify step),
// pinned independently of criterion 2's fixture pair: there, the
// BASELINE itself is zero-tests-shaped, so setup.ts refuses before
// step.ts is ever reached and the mutant-side branch is never exercised.
// Here the baseline is a genuine, executed pass and only the MUTANT run
// flips to a known zero-tests shape, so only step.ts's own detector (not
// setup.ts's) can catch it. -------------------------------------------

function initRunnerRepo(): string {
  const repo = makeTmpDir();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  fs.writeFileSync(
    path.join(repo, "runner.js"),
    [
      "console.log(' Test Files  1 passed (1)');",
      "console.log('      Tests  2 passed (2)');",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    { cwd: repo },
  );
  return repo;
}

describe("probe(): mutant-side zero-tests detector (step.ts)", () => {
  it("a mutant that flips the runner's own summary line to a known zero-tests shape, still exit 0, is refused, never survived", async () => {
    const repo = initRunnerRepo();
    const result = await probe(
      baseOptions(repo, {
        file: "runner.js",
        line: 2,
        replaceText: "console.log('No test files found, exiting with code 1');",
        testCommand: "node runner.js",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    // A mutant-side refusal reached through `step.ts`'s own classify
    // step (unlike the baseline-side refusal above, which never reaches
    // it): still no real killed/survived verdict, so still nothing for
    // `expectation` to report.
    expect(result.mutation_probe?.expectation).toBeUndefined();
    expect(
      result.warnings.some((w) =>
        /the mutant run's own output shows no test was actually executed/.test(
          w,
        ),
      ),
    ).toBe(true);
  });

  it("a mutant that flips a genuinely-passing phpunit-shaped baseline to the all-skipped marker, still exit 0, is refused via the phpunit branch, not the byte-identical fallback (round-1 review finding: baseline and mutant text differ by construction here, so a pass on this test proves the marker itself is recognized, not that the fallback happened to mask the gap)", async () => {
    const repo = makeTmpDir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    fs.writeFileSync(
      path.join(repo, "runner.js"),
      [
        "console.log('PHPUnit 9.6.36 by Sebastian Bergmann and contributors.');",
        "console.log('OK (2 tests, 2 assertions)');",
        "",
      ].join("\n"),
    );
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
      { cwd: repo },
    );
    const result = await probe(
      baseOptions(repo, {
        file: "runner.js",
        line: 2,
        replaceText:
          "console.log('OK, but incomplete, skipped, or risky tests!'); console.log('Tests: 2, Assertions: 0, Skipped: 2.');",
        testCommand: "node runner.js",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(
      result.warnings.some((w) =>
        /the mutant run's own output shows no test was actually executed \(phpunit\)/.test(
          w,
        ),
      ),
    ).toBe(true);
  });

  it("a mutant whose own phpunit output is merely UNREADABLE (banner, no result report, the mid-suite exit()/die() shape) reports the dedicated zero_tests_ambiguous reason, never no_tests_executed: the mutant phase now makes the same split the baseline phase already does", async () => {
    // Same distinction the previous case pins for a genuine "zero"
    // reading (PHPUnit's own all-skipped marker), checked here for the
    // OTHER `detectKnownZeroTestsEvidence` origin: `ambiguous: true`
    // (`phpunitZeroTestsVerdict` reading `"ambiguous"`, the
    // `phpunit-exit-mid-suite.txt` shape -- banner present, no `OK (`,
    // no marker, no tally, no progress counter, no post-run `Time:`
    // line). `setup.ts` reads that same flag to pick `zero_tests_ambiguous`
    // at the BASELINE phase; `step.ts`'s mutant-phase classify step now
    // reads it too (see docs/probe.md's refusal-reason-shape table row and
    // the CHANGELOG entry closing this residual), so a mutant run whose
    // own phpunit output cannot be read either way is reported as
    // unreadable, not overstated as a stated zero, at both phases alike.
    const repo = makeTmpDir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    fs.writeFileSync(
      path.join(repo, "runner.js"),
      [
        "console.log('PHPUnit 9.6.36 by Sebastian Bergmann and contributors.');",
        "console.log('OK (2 tests, 2 assertions)');",
        "",
      ].join("\n"),
    );
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
      { cwd: repo },
    );
    const result = await probe(
      baseOptions(repo, {
        file: "runner.js",
        line: 2,
        replaceText: "console.log('.');",
        testCommand: "node runner.js",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("zero_tests_ambiguous");
    expect(result.reason).not.toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
    expect(result.mutation_probe?.reason).toBe("zero_tests_ambiguous");
    expect(
      result.warnings.some((w) =>
        /the mutant run's own output shows no test was actually executed \(phpunit\)/.test(
          w,
        ),
      ),
    ).toBe(true);
  });
});

// --- The generic byte-identical fallback's opt-out via
// `--require-baseline-evidence`, and its truncation guard: real `node
// --test` runs, since the `--test-reporter=dot` shape (bare `..`, no
// summary line either built-in detector recognizes) is exactly the
// "quiet deterministic runner" the fallback exists for and the escape
// hatch is meant to unblock. -------------------------------------------

function dotReporterOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "calc.js",
    line: 5,
    form: "replace",
    // Mutates the untested `unused` function only: the tested `add`
    // path, and therefore the dot reporter's `..` output, is unaffected
    // either way -- a genuine, legitimate survivor.
    replaceText: "  return a - b;",
    testCommand: "node --test --test-reporter=dot calc.test.js",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

describe("probe(): generic byte-identical fallback, --require-baseline-evidence opt-out", () => {
  it("without --require-baseline-evidence, a genuine dot-reporter survivor is read as inconclusive/no_tests_executed by design", async () => {
    const repo = initNodeTestDotRepo(makeTmpDir);
    const result = await probe(dotReporterOptions(repo));
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
  });

  it("with a matching --require-baseline-evidence, the same dot-reporter survivor stays survived, not second-guessed", async () => {
    const repo = initNodeTestDotRepo(makeTmpDir);
    const result = await probe(
      dotReporterOptions(repo, { requireBaselineEvidence: /\.\./ }),
    );
    expect(result.status).toBe("survived");
    expect(result.reason).toBeUndefined();
  });
});

describe("probe(): generic byte-identical fallback, truncated-tail guard", () => {
  it("never fires when either side's captured tail was truncated, even on byte-identical unknown output", async () => {
    // A genuine, legitimate survivor (an untested function mutated) whose
    // runner prints >60 identical lines of unrecognized text on both the
    // baseline and the mutant run: without the truncation guard, the
    // byte-identical (truncated) tails would misread this as
    // `no_tests_executed`; with it, the real `survived` verdict stands.
    const repo = initGitRepo();
    const fillerLines = Array.from(
      { length: 120 },
      (_, i) => `console.log('noise line ${i}');`,
    ).join(" ");
    const result = await probe(
      baseOptions(repo, {
        // The default mutant (flips `flag`) is a genuine survivor here:
        // the noisy command below never requires('./fixture.js') at all,
        // so it cannot observe the mutation either way.
        testCommand: `node -e "${fillerLines}"`,
      }),
    );
    expect(result.status).toBe("survived");
    expect(result.reason).toBeUndefined();
  });
});

// --- The mutant-side detector and the generic fallback also apply to a
// `killed` verdict whose "killed"-ness rests on nothing but a PASSING
// exit code (`--expect pass`): the exact silent exit-0 evidence this
// whole mechanism distrusts, whichever direction `--expect` points. ----

describe("probe(): --expect pass, which verdicts rest on the mutant run's own exit code", () => {
  it("a quiet unknown runner with identical exit-0 output on both runs is refused, never certified killed", async () => {
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        expect: "pass",
        // A constant, unrecognized line on both the baseline and the
        // mutant run (the mutant here is irrelevant to this command's
        // output either way): under `--expect pass`, exit 0 on both
        // sides alone would otherwise be certified `killed` with no
        // evidence anything real ran.
        testCommand: "node -e \"console.log('constant-output')\"",
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.mutation_probe?.result).toBe("not_run");
  });
  // See "criterion 2 fixture pair" below for the negative control (a
  // real, executed vitest summary under --expect pass is unaffected):
  // it needs the real-vitest fixture defined further down this file.

  it("a killed verdict under --expect pass whose mutant run exited NON-ZERO stands, even with byte-identical output on both sides", async () => {
    // The generic byte-identical fallback used to be entered by verdict shape
    // alone (`survived`, or `killed` under `--expect pass`, the old
    // expectation-matched labels), which pulls in EVERY `--expect pass`
    // verdict resting on a failing predicate regardless of the mutant run's
    // own exit code -- including this one, whose `killed`-ness (the mutant
    // run's actual outcome, independent of `--expect`) rests on the mutant
    // run exiting NON-ZERO, the opposite of the silent exit-0 evidence this
    // mechanism exists to distrust. The fallback is now entered only when
    // the mutant run's OWN predicate reads as passing (its exit code by
    // default, `--pass-regex`'s match when that is given), so this case never
    // enters it at all.
    const repo = initGitRepo();
    const result = await probe(
      baseOptions(repo, {
        expect: "pass",
        // Prints the SAME constant line whichever content fixture.js
        // has, but exits 0 only when it still reads the baseline's
        // `flag: true` -- the default mutant flips it to `flag: false`,
        // so the baseline passes (exit 0) and the mutant run fails
        // (exit 1) while producing byte-identical output.
        testCommand:
          "node -e \"const { flag } = require('./fixture.js'); console.log('constant-output'); process.exit(flag ? 0 : 1);\"",
      }),
    );
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.expectation).toBe("violated");
    expect(result.reason).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

// --- Criterion 2's discriminating fixture pair, through a REAL vitest
// process (not a synthetic stand-in): a `-t` filter matching no test
// name yields `no_tests_executed`, never `survived`; the SAME probe with
// a matching filter still yields `killed`. -----------------------------

const FIXTURE_TEST_FILE = "sample.test.js";
const FIXTURE_TEST_CONTENT = [
  'import { describe, it, expect } from "vitest";',
  'describe("sample", () => {',
  '  it("adds", () => {',
  "    expect(1 + 1).toBe(2);",
  "  });",
  '  it("multiplies", () => {',
  "    expect(2 * 3).toBe(6);",
  "  });",
  "});",
  "",
].join("\n");

/** A throwaway vitest project, one real test file with two passing
 * tests ("adds", "multiplies"). No `node_modules` of its own: vitest is
 * resolved by absolute path back into this package's own installed
 * copy (`VITEST_ENTRY`), the same pattern `test/cli.test.ts`'s own live
 * tool tests use. Freshly copied per test rather than reused from
 * `test/fixtures/`, so this file's own mutant (a real `probe()`
 * backup/mutate/restore against a REAL file) never touches a committed
 * fixture. */
function makeVitestFixture(): string {
  const dir = makeTmpDir();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "zero-tests-fixture",
      private: true,
      type: "module",
    }),
  );
  fs.writeFileSync(path.join(dir, FIXTURE_TEST_FILE), FIXTURE_TEST_CONTENT);
  return dir;
}

function fixtureOptions(cwd: string, testCommand: string): ProbeOptions {
  return {
    file: FIXTURE_TEST_FILE,
    line: 4,
    form: "replace",
    // Breaks the "adds" assertion: a mutant a filter that actually
    // selects "adds" catches, one a filter matching nothing cannot.
    replaceText: "    expect(1 + 1).toBe(999);",
    testCommand,
    isolation: "inplace",
    expect: "fail",
    cwd,
    logDir: makeTmpDir(),
  };
}

describe("probe(): criterion 2 fixture pair, real vitest (task 273b3851)", () => {
  it("a -t filter matching no test name yields no_tests_executed, never survived", async () => {
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe(
      fixtureOptions(
        cwd,
        `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE} -t "no such name"`,
      ),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("no_tests_executed");
    expect(result.status).not.toBe("survived");
    expect(result.mutation_probe?.result).toBe("not_run");
  }, 20000);

  it("the SAME probe with a matching filter still yields killed", async () => {
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe(
      fixtureOptions(
        cwd,
        `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE} -t "adds"`,
      ),
    );
    expect(result.status).toBe("killed");
    expect(result.reason).toBeUndefined();
  }, 20000);

  it("negative control: no filter at all (the whole suite runs) also yields killed, never flagged", async () => {
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe(
      fixtureOptions(cwd, `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE}`),
    );
    expect(result.status).toBe("killed");
  }, 20000);

  it("negative control: --expect pass with a real, executed vitest summary is unaffected by the widened exit-0 check", async () => {
    // A harmless mutant (renames the describe block; the assertions
    // themselves are untouched, so the suite still genuinely passes) run
    // under --expect pass: a real "Tests 2 passed (2)" summary on both
    // the baseline and the mutant run means neither the mutant-side
    // zero-tests detector nor the generic fallback has anything to catch
    // here, whatever the exit code says. The suite still passes, so the
    // actual outcome is `survived` (independent of `--expect`); `--expect
    // pass` wanted exactly that, so the expectation is met.
    const cwd = makeVitestFixture();
    const result: ProbeResult = await probe({
      file: FIXTURE_TEST_FILE,
      line: 2,
      form: "replace",
      replaceText: 'describe("sample renamed", () => {',
      testCommand: `node ${VITEST_ENTRY} run ${FIXTURE_TEST_FILE}`,
      isolation: "inplace",
      expect: "pass",
      cwd,
      logDir: makeTmpDir(),
    });
    expect(result.status).toBe("survived");
    expect(result.mutation_probe?.expectation).toBe("met");
    expect(result.reason).toBeUndefined();
  }, 20000);
});

// --- End-to-end pair over a REAL pytest process (pytest 8.4.2 was used
// for the captures above; CI may not ship pytest at all, so both tests
// name their tool requirement and skip rather than silently weakening
// the suite, the same `HAS_PYTHON3` seam `probe-pycache.test.ts` uses).

/** Whether `python3 -m pytest --version` succeeds: the pair below needs
 * a real pytest, not just a real python3. */
const HAS_PYTEST = (() => {
  try {
    execFileSync("python3", ["-m", "pytest", "--version"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();

const CALC_PY = [
  "def add(a, b):",
  "    return a + b",
  "",
  "",
  "def unused(x):",
  "    return x",
  "",
].join("\n");

const TEST_CALC_PY = [
  "from calc import add",
  "",
  "",
  "def test_add():",
  "    assert add(2, 3) == 5",
  "",
].join("\n");

function initPytestRepo(): string {
  const repo = makeTmpDir();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "calc.py"), CALC_PY);
  fs.writeFileSync(path.join(repo, "test_calc.py"), TEST_CALC_PY);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    { cwd: repo },
  );
  return repo;
}

// `-p no:cacheprovider`: pytest writes no `.pytest_cache` into the
// freshly git-committed fixture repo (an untracked leftover there would
// be probe's own restored-tree check complaining, not the point).
const PYTEST_CMD = "python3 -m pytest -p no:cacheprovider -q test_calc.py";

describe("probe(): real pytest end-to-end, timing-digit stability", () => {
  it.skipIf(!HAS_PYTEST)(
    "the same green mutant over a genuinely passing pytest suite is `survived` on two back-to-back runs whose summary timings differ (needs python3 -m pytest; skipped without it), not a byte-identity coin flip",
    async () => {
      // Mutates only the untested `unused` (same length): the suite
      // genuinely runs and passes on both sides -- a real survivor.
      // pytest's summary line carries timing digits (`1 passed in
      // 0.11s` vs `0.09s`), so before the summary line was recognized
      // the generic fallback's agreement with itself was luck.
      const repo = initPytestRepo();
      const options = (): ProbeOptions => ({
        file: "calc.py",
        line: 6,
        form: "replace",
        replaceText: "    return y",
        testCommand: PYTEST_CMD,
        isolation: "inplace",
        expect: "fail",
        cwd: repo,
        logDir: makeTmpDir(),
      });
      for (const run of [1, 2]) {
        const result = await probe(options());
        expect(result.status, `run ${String(run)}`).toBe("survived");
        expect(result.reason, `run ${String(run)}`).toBeUndefined();
      }
    },
    60000,
  );

  it.skipIf(!HAS_PYTEST)(
    "a mutant that renames the only test function so the mutant run collects nothing (`no tests ran in X.XXs`, exit 5) is no_tests_executed, never a verdict (needs python3 -m pytest; skipped without it)",
    async () => {
      const repo = initPytestRepo();
      const result = await probe({
        file: "test_calc.py",
        line: 4,
        form: "replace",
        replaceText: "def xtest_add():",
        testCommand: PYTEST_CMD,
        isolation: "inplace",
        expect: "fail",
        cwd: repo,
        logDir: makeTmpDir(),
      });
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("no_tests_executed");
      expect(result.mutation_probe?.result).toBe("not_run");
      expect(
        result.warnings.some((w) =>
          /the mutant run's own output shows no test was actually executed \(pytest\)/.test(
            w,
          ),
        ),
      ).toBe(true);
    },
    60000,
  );
});
