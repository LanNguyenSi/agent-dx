import { combinedOutput, type ExecResult } from "../exec.js";
import { nonZeroPassWarning, truncationNote } from "../pass-regex.js";
import { classifyStatus } from "../verify/index.js";

/** What a `--smoke` command said about the new worktree. */
export interface SmokeVerdict {
  status: "ready" | "not_ready";
  /** Why the worktree is not ready; empty when it is. */
  reason: string;
  warnings: string[];
}

/**
 * Turns one finished smoke run into a verdict with the same predicate
 * `verify` applies to a check: without a pattern the exit code decides
 * (`0` is ready; any other code, a timeout, or a missing or non-executable
 * command is not); with a pattern, a match against the combined stdout and
 * stderr is ready and its absence is not, whatever the exit code says,
 * except that a run that never produced a verdict (a timeout, exit
 * 126/127, a kill) is not ready and the pattern is not consulted.
 */
export function smokeVerdict(
  run: ExecResult,
  passRegex: RegExp | undefined,
): SmokeVerdict {
  const warnings: string[] = [];
  const exitStatus = classifyStatus(run.exitCode, run.timedOut);
  if (run.aborted) {
    return {
      status: "not_ready",
      reason: "the smoke run was aborted",
      warnings,
    };
  }
  if (passRegex !== undefined && exitStatus !== "error") {
    const output = combinedOutput(run.stdoutTail, run.stderrTail);
    if (passRegex.test(output)) {
      if (run.exitCode !== 0) {
        warnings.push(
          nonZeroPassWarning({
            prefix: "smoke: ",
            outputSubject: "the smoke output",
            exitSubject: "the smoke command",
            pattern: passRegex.source,
            exitCode: run.exitCode,
            logPath: run.logPath,
          }),
        );
      }
      return { status: "ready", reason: "", warnings };
    }
    return {
      status: "not_ready",
      reason: `--pass-regex (${passRegex.source}) did not match the smoke output${truncationNote("smoke run", run.stdoutTruncated, run.stderrTruncated)}`,
      warnings,
    };
  }
  if (exitStatus === "pass") return { status: "ready", reason: "", warnings };
  const how = run.timedOut
    ? "timed out"
    : run.exitCode === null
      ? "was killed before it reported an exit code"
      : `exited with code ${String(run.exitCode)}`;
  if (passRegex !== undefined) {
    warnings.push(
      `smoke: --pass-regex (${passRegex.source}) was given but the smoke command ${how}, so the predicate was never consulted`,
    );
  }
  return {
    status: "not_ready",
    reason: `the smoke command ${how}`,
    warnings,
  };
}
