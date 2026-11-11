import fs from "node:fs";
import { combinedOutput } from "../exec.js";
import { hasKnownTestSummary } from "./zero-tests.js";

/**
 * Detects when a mutant run's test command failed because the BUILD
 * broke, not because a test said anything about the mutant: a mutant
 * that does not compile makes the test command exit non-zero before (or
 * instead of) any assertion, which the plain exit-code reading scores as
 * `killed`. A result like that measures nothing about the suite, so the
 * caller (`step.ts`) reports it as `build_failed` instead.
 *
 * Three toolchains are recognized, each from the output its own tool
 * prints (shapes captured from real runs, see test/fixtures/README.md):
 *
 * - `go`: `go test` prints `FAIL <pkg> [build failed]` or `FAIL <pkg>
 *   [setup failed]` for a package whose test binary could not be built.
 *   A package that failed to build next to packages that ran is still a
 *   build failure when no test failed anywhere; once ANY test failure is
 *   in the output (`--- FAIL:`, or `FAIL <pkg> <time>`) a test did
 *   observe the mutant and the run keeps its `killed` verdict.
 * - `tsc`: a TypeScript diagnostic line in tsc's own format, anchored at
 *   the start of the line (`path(line,col): error TS<code>:` or
 *   `path:line:col - error TS<code>:`, the path carrying no colon), in
 *   output with no test-runner summary. Three outcomes follow from what
 *   else the output says (`testEvidence`): no sign of a test having run is
 *   a build failure, which is what a `pretest` `tsc` step that fails
 *   before the runner starts looks like; clear evidence (a failure
 *   marker, `not ok`, an `AssertionError`, JUnit `<testcase>`, a TAP `ok`
 *   inside a TAP stream) keeps the kill; and only weak evidence (a named
 *   error line such as `TypeError:`) keeps the kill but reports it as
 *   ambiguous, so the caller marks it. Diagnostic lines, eslint's `✖ N
 *   problems`, a bare `Error:` line, pnpm's `ERR_PNPM_*` footer and a TAP
 *   `ok` outside a TAP stream are not evidence. A command that IS tsc (a
 *   type-level test suite run as `tsc --noEmit`) prints exactly this
 *   output for a real kill: such a command must opt out
 *   (`--no-build-detect`). Not recognized: drive-letter absolute paths,
 *   output prefixed by a runner (`web:build: `, `@scope/pkg: `), global
 *   diagnostics without a path (`error TS6053:`) and ts-node's
 *   `TSError:`.
 * - `vitest`: vitest could not load or transform a test file (`Transform
 *   failed`, `SyntaxError`, `Failed to load url`, `Failed to resolve
 *   import`, `Cannot find module`, or a `SyntaxError` without a stack frame
 *   in user code: one raised while running a loaded file, such as a
 *   `JSON.parse` at import, has such a frame and stays a kill) and the run
 *   executed no test at all (`Tests  no tests`). A run in which some other
 *   file's tests ran is not a build failure; for that reason the test
 *   command should be narrowed to the test files that import the mutated
 *   module, since a load failure beside passing files reads as a kill.
 *
 * `readBuildFailure` reads the captured output tails, or the full run
 * log when a tail was truncated (both directions matter: a test failure
 * or a build marker can scroll out of a 60-line tail); when that log
 * cannot be read it reports `skipped` and the caller keeps the old
 * reading. Any other toolchain is not recognized: its compile errors
 * still read as `killed`, and `recognizesBuildToolchain` below lets the
 * summary say so.
 */

export type BuildFailureDetectorName = "go" | "tsc" | "vitest";

export interface BuildFailureEvidence {
  detected: boolean;
  via?: BuildFailureDetectorName;
  /** Set (with `detected: false`) when a tsc diagnostic is present and the
   * output has a line that MAY be a test's own output but is not clear
   * evidence of one: the caller keeps the `killed` reading but must mark
   * it, never upgrade it to `build_failed` and never leave it silent.
   * `evidence` is the matched line. */
  ambiguous?: { via: "tsc"; evidence: string };
}

/** Strips ANSI SGR escape codes, the same as the vitest detector does:
 * vitest colorizes its output when it sees no unsupportive terminal. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** `FAIL <pkg> [build failed]` / `FAIL <pkg> [setup failed]`. */
const GO_BUILD_FAILED_LINE = /^FAIL\s+\S+\s+\[(?:build|setup) failed\]\s*$/m;

/** A test that actually failed under `go test`: the `--- FAIL:` line
 * (also indented, for subtests) or a package's own `FAIL <pkg> <time>`
 * summary (a build failure never carries a duration). */
const GO_TEST_FAILED =
  /^\s*--- FAIL:|^FAIL\s+\S+\s+(?:[\d.]+s|\(cached\))\s*$/m;

/** A package line `go test` printed for a test binary that ran, or a
 * test line of `-v` output: the shapes that say the toolchain is go. */
const GO_RUN_SHAPE =
  /^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[)|^\s*--- (?:FAIL|PASS|SKIP):/m;

/** tsc's own diagnostic lines, anchored at the start of the line with a
 * path that carries no colon, so a test runner printing `AssertionError:
 * src/a.ts(2,9): error TS2322: ...` is not one. */
const TSC_DIAGNOSTIC_LINE =
  /^[^\s:][^:\n]*\(\d+,\d+\): error TS\d+:|^[^\s:][^:\n]*:\d+:\d+ - error TS\d+:/m;

/** A line that says a test ran and failed, as `summary.ts` reads them for
 * its `failing=` column. The last alternative is PHPUnit's numbered
 * failure line, `1) Ns\Class::testMethod`: a number, `)`, a class name
 * (namespace separators allowed) and `::` before the method. PHPUnit's
 * closing `FAILURES!` and `Tests: ..., Failures: 1.` lines name no
 * test. */
export const FAILURE_LINE =
  /^\s*(FAIL\b|FAILED\b|not ok\b|--- FAIL\b|[✗✖●]|(?:\w*Error|AssertionError)\b|\d+\) [\w\\]+::\w+)/;

/** Lines that clearly say a test ran: a runner's failure marker (`FAIL`,
 * `not ok`, `--- FAIL`, a cross or bullet mark, an `AssertionError`), a
 * PHPUnit numbered failure, and JUnit `<testcase>` / `<failure>`. The
 * multiplication sign `×` is left out of the marks: pnpm prints its
 * `× "pnpm recursive run" failed` footer with it, and the runners that
 * use it (vitest's default reporter) also print a `FAIL` line or a
 * summary. */
const STRONG_TEST_LINE =
  /^\s*(?:FAIL\b|FAILED\b|not ok\b|--- FAIL\b|[✗✖●]|\w*AssertionError\b|\d+\) [\w\\]+::\w+|<testcase\b|<failure\b)/;

/** eslint's closing `✖ 3 problems (...)` line starts with the same cross
 * a test reporter prints and says nothing about a test. */
const ESLINT_SUMMARY_LINE = /^\s*✖\s+\d+ problems?\b/;

/** A full TAP verdict line, which counts only inside a TAP stream. */
const TAP_OK_LINE = /^ok \d+(?: |$)/;
const TAP_STREAM_MARKER = /^TAP version\b|^\s*1\.\.\d+\s*$|^# (?:pass|fail)\b/m;

/** A named error at the start of a line that is not a plain `Error:`
 * (`TypeError: ...`, `TSError: ...`): it may come from a test, from
 * a script that ran after a failed compile, or from the compiler's own
 * wrapper, so it is ambiguous rather than evidence either way. */
const WEAK_ERROR_LINE = /^\s*\w+Error\b/;

interface TestEvidence {
  strong?: string;
  weak?: string;
}

/**
 * What the output says about a test having run, line by line, for the
 * tsc rule. Lines that are themselves tsc diagnostics are skipped (a
 * root-level `AppError.ts` is a path, not an error), and so are eslint's
 * `✖ N problems` summary, a bare `Error:` line and pnpm's `ERR_PNPM_*`
 * footer, which neither start like a test marker nor carry a name before
 * `Error`. A TAP `ok N` line counts only when the output is a TAP stream
 * (a `TAP version` line, a `1..N` plan, `# pass` / `# fail`).
 * The first strong line wins; otherwise the first weak one is reported.
 */
function testEvidence(combined: string): TestEvidence {
  const lines = combined.split("\n");
  const tap = TAP_STREAM_MARKER.test(combined);
  let weak: string | undefined;
  for (const line of lines) {
    if (TSC_DIAGNOSTIC_LINE.test(line) || ESLINT_SUMMARY_LINE.test(line)) {
      continue;
    }
    if (STRONG_TEST_LINE.test(line) || (tap && TAP_OK_LINE.test(line))) {
      return { strong: line.trim() };
    }
    if (weak === undefined && WEAK_ERROR_LINE.test(line)) weak = line.trim();
  }
  return weak === undefined ? {} : { weak };
}

/** jest's totals line (`Tests:       1 failed, 3 passed, 4 total`), which
 * `hasKnownTestSummary` does not know: a run that printed it ran tests. */
const JEST_TESTS_LINE = /^\s*Tests:\s+.*\b\d+ (?:passed|failed)\b/m;

const VITEST_NO_TESTS_LINE = /^\s*Tests\s+no tests\s*$/m;
const VITEST_FAILED_FILES_LINE = /^\s*Test Files\s+.*\bfailed\b/m;
const VITEST_LOAD_ERROR =
  /Transform failed with \d+ errors?|\[PARSE_ERROR\]|Failed to load url|Failed to resolve import|Cannot find (?:module|package) /;
const SYNTAX_ERROR = /\bSyntaxError\b/;
/** A stack frame in user code: vitest's `❯ path:line:col` or node's `at
 * ... (path:line:col)`, not inside node_modules. */
const USER_FRAME = /^\s*(?:❯|at)\s+(?!.*node_modules).*:\d+:\d+/m;

function vitestLoadError(combined: string): boolean {
  return (
    VITEST_LOAD_ERROR.test(combined) ||
    (SYNTAX_ERROR.test(combined) && !USER_FRAME.test(combined))
  );
}

export function detectBuildFailure(
  stdoutTail: string,
  stderrTail: string,
): BuildFailureEvidence {
  const combined = stripAnsi(combinedOutput(stdoutTail, stderrTail));
  if (GO_BUILD_FAILED_LINE.test(combined)) {
    // One real test failure anywhere is a test observing the mutant.
    return GO_TEST_FAILED.test(combined)
      ? { detected: false }
      : { detected: true, via: "go" };
  }
  if (
    VITEST_NO_TESTS_LINE.test(combined) &&
    VITEST_FAILED_FILES_LINE.test(combined) &&
    vitestLoadError(combined)
  ) {
    return { detected: true, via: "vitest" };
  }
  if (
    TSC_DIAGNOSTIC_LINE.test(combined) &&
    !hasKnownTestSummary(stdoutTail, stderrTail) &&
    !JEST_TESTS_LINE.test(combined)
  ) {
    const evidence = testEvidence(combined);
    if (evidence.strong !== undefined) return { detected: false };
    if (evidence.weak !== undefined) {
      return {
        detected: false,
        ambiguous: { via: "tsc", evidence: evidence.weak.slice(0, 160) },
      };
    }
    return { detected: true, via: "tsc" };
  }
  return { detected: false };
}

/**
 * Whether the output belongs to a toolchain `detectBuildFailure` can
 * speak for: a go test run, a vitest run or a tsc diagnostic. Used by the
 * summary to say that a `killed` row of any other toolchain was not
 * checked for a build failure. Deliberately generous in the other
 * direction too (a recognized toolchain whose output shows no build
 * failure is simply a real kill).
 */
export function recognizesBuildToolchain(
  stdoutTail: string,
  stderrTail: string,
): boolean {
  const combined = stripAnsi(combinedOutput(stdoutTail, stderrTail));
  return (
    GO_RUN_SHAPE.test(combined) ||
    TSC_DIAGNOSTIC_LINE.test(combined) ||
    VITEST_FAILED_FILES_LINE.test(combined) ||
    /^\s*Tests\s+\d+\s+(?:failed|passed|expected fail|skipped|todo)\b/m.test(
      combined,
    )
  );
}

/** The mutant run's output as `exec.ts` captured it, plus where its full
 * log is: what `readBuildFailure` needs. */
export interface MutantRunOutput {
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  logPath: string;
  logWriteFailed?: boolean;
  outputMayBeIncomplete?: boolean;
}

/** Why a truncated run's full log was no basis for a reading. */
export type SkipCause =
  "log_too_large" | "log_write_failed" | "output_incomplete" | "log_unreadable";

export interface BuildFailureReading extends BuildFailureEvidence {
  /** Set when a tail was truncated and the full log could not be read
   * (or could not be trusted): nothing was evaluated, and the caller
   * must keep the verdict it had and say so. */
  skipped?: SkipCause;
}

/** The short label of a skip cause, as the `--summary` row prints it. */
export function skipCauseLabel(cause: SkipCause): string {
  switch (cause) {
    case "log_too_large":
      return "log too large";
    case "log_write_failed":
      return "log write failed";
    case "output_incomplete":
      return "output may be incomplete";
    case "log_unreadable":
      return "log unreadable";
  }
}

/** The warning for a skipped reading, worded by cause. */
export function skipWarning(
  cause: SkipCause,
  maxLogBytes: number,
  logPath: string,
): string {
  const why: Record<SkipCause, string> = {
    log_too_large: `its full log is larger than ${String(maxLogBytes / (1024 * 1024))} MiB`,
    log_write_failed: "writing its full log failed",
    output_incomplete: "its output may be incomplete",
    log_unreadable: "its full log could not be read",
  };
  return `build-failure detection was skipped: the mutant run's output was truncated and ${why[cause]}, so a killed verdict here may rest on a compile error; see ${logPath}`;
}

/**
 * `detectBuildFailure` over the right text: the captured tails when
 * neither was truncated, else the full run log (the same source the
 * `--pass-regex` truncation correction reads). A log that cannot be read
 * back, is larger than `maxLogBytes`, or may be incomplete
 * (`logWriteFailed`, `outputMayBeIncomplete`) is no basis for a verdict
 * either way, so the reading is `skipped` rather than a guess from a tail
 * that may have lost the marker or the failing test.
 */
export function readBuildFailure(
  run: MutantRunOutput,
  maxLogBytes: number,
): BuildFailureReading {
  if (!run.stdoutTruncated && !run.stderrTruncated) {
    return detectBuildFailure(run.stdoutTail, run.stderrTail);
  }
  if (run.logWriteFailed === true) {
    return { detected: false, skipped: "log_write_failed" };
  }
  if (run.outputMayBeIncomplete === true) {
    return { detected: false, skipped: "output_incomplete" };
  }
  try {
    if (fs.statSync(run.logPath).size > maxLogBytes) {
      return { detected: false, skipped: "log_too_large" };
    }
    return detectBuildFailure(fs.readFileSync(run.logPath, "utf8"), "");
  } catch {
    return { detected: false, skipped: "log_unreadable" };
  }
}
