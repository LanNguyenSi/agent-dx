// What the CLI does when a write to its own stdout fails, decided by kind.
//
// The reader went away: the consumer of the report closed its end before
// the whole report was written (`... | head -c 10`). That is the reader's
// choice, not a failure of the run, so the run ends with its verdict code
// and prints nothing. Which errno a write to a gone reader raises depends on
// the platform and on what the reader is: EPIPE for a pipe(2) pipe (a shell
// pipeline), ENOTCONN for the socketpair a Node parent gets from
// `spawn(..., { stdio: "pipe" })` on macOS, ECONNRESET for a socket peer
// that reset the connection. Any other error means the report was not
// delivered for a reason of this run's own (a full disk, a bad descriptor),
// so it is reported on one stderr line and the run exits 2, the code the CLI
// already uses for a failure that is not a verdict.
export const STDOUT_READER_GONE_CODES: ReadonlySet<string> = new Set([
  "EPIPE",
  "ENOTCONN",
  "ECONNRESET",
]);

export interface StdoutErrorOutcome {
  exitCode: number;
  // One line for stderr (no stack, no trailing newline), or null for none.
  stderrLine: string | null;
}

export function classifyStdoutError(
  err: NodeJS.ErrnoException,
  verdictExitCode: number | string | null | undefined,
): StdoutErrorOutcome {
  const code = typeof err.code === "string" ? err.code : undefined;
  if (code !== undefined && STDOUT_READER_GONE_CODES.has(code)) {
    const verdict = Number(verdictExitCode ?? 0);
    return {
      exitCode: Number.isInteger(verdict) ? verdict : 0,
      stderrLine: null,
    };
  }
  return {
    exitCode: 2,
    stderrLine: `slop-detector: could not write the report to stdout (${code ?? "unknown error"})`,
  };
}
