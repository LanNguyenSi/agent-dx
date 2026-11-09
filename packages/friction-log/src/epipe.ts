/**
 * Exit quietly when the reader of a piped stream goes away (EPIPE), for
 * example `friction-log file 7 --sink stdout-json | head -c 1`. Any other
 * stream error is rethrown so real failures still surface.
 */
export function installEpipeGuard(
  stream: NodeJS.WritableStream,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      exit(0);
      return;
    }
    throw err;
  });
}

/**
 * Guard stderr, where exiting would be wrong: `file --sink stdout-json`
 * prints its status lines to stderr, and a closed stderr reader (for example
 * `friction-log file 7 --sink stdout-json 2>&1 | head -c 1`) means "stop
 * writing to stderr", not "the run was fine". So unlike installEpipeGuard
 * this never touches the exit code: the process ends with the code the run
 * would have had anyway (0 for a successful run, the error code for a failed
 * one). On EPIPE the stream is marked closed instead: `write` and `end`
 * become no-ops, so later stderr writes neither throw nor re-emit. Any other
 * stream error is rethrown so real failures still surface.
 */
export function installEpipeSilencer(stream: NodeJS.WritableStream): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") {
      throw err;
    }
    const closed = stream as unknown as {
      write: () => boolean;
      end: () => unknown;
    };
    closed.write = () => true;
    closed.end = () => closed;
  });
}
