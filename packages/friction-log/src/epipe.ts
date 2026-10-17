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
