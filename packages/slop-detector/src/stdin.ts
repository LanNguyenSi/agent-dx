// Reading stdin has to both terminate and produce something. `check` with
// no path (or a bare "-") scans content piped in on stdin, and
// `--stdin-path` only names that piped content, so a caller who meant to
// scan a file but piped nothing in has two ways to go wrong, and both used
// to pass silently:
//
//   - stdin ends with no content at all (an interactive TTY, `< /dev/null`,
//     `printf "" |`, a whitespace-only body). That produced a clean,
//     green report over an empty document -- exit 0, "0 violations" --
//     which reads as "checked, nothing found" rather than "nothing was
//     checked". Emptiness, not TTY-ness, is the predicate for this (checked
//     by the caller in cli.ts, not here).
//   - stdin never writes anything at all: an inherited, non-TTY stream with
//     no writer, which is what a CI step or an agent harness spawning the
//     CLI with stdio inherited hands it. That hung forever with no output.
//
// The second is bounded by a FIRST-BYTE timeout that is armed once, before
// the first byte, and cleared for good the moment any data arrives -- it is
// never re-armed. The guard exists only for a stdin with no writer at all;
// once a producer has proven it is alive by writing something, this reader
// trusts it to keep going and waits for `end` without a bound. The
// trade-off: a producer that writes some data and then stalls forever
// mid-stream (rather than never starting) is an ordinary pipe hang again,
// not a bounded usage error -- unlike the never-written case, that shape is
// indistinguishable from a producer that is just slow, and a fixed bound
// during a large flowing input, once one that we know is arriving, would
// either be a false timeout on somebody's over-a-few-seconds write or no
// protection at all. 10s is far above any of the documented producers (a
// `git log`, a file redirect, a heredoc), and
// SLOP_DETECTOR_STDIN_TIMEOUT_MS overrides it (it exists so the
// never-written-stdin case is cheap to pin in `test/cli.test.ts`; the
// default must stand on its own without a caller setting anything).

export const DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS = 10_000;

/**
 * Resolves the first-byte bound from `SLOP_DETECTOR_STDIN_TIMEOUT_MS`,
 * falling back to `DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS` when the variable
 * is unset, not a finite number, or not strictly positive. Takes `env` as a
 * parameter (defaulting to `process.env`) so the branches are
 * unit-testable without spawning a subprocess.
 */
export function stdinFirstByteTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SLOP_DETECTOR_STDIN_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS;
}

export function noStdinContentError(reason: string): Error {
  return new Error(
    `${reason}, so nothing was scanned. \`check\` with no path (or a bare "-") scans content piped in on stdin, and \`--stdin-path <name>\` only names that piped content -- it never opens a file. Pipe content in, e.g. \`git log -1 --format=%B | slop-detector check --stdin-path COMMIT_MSG --pack review-slop\`, or pass one or more paths to scan files instead.`,
  );
}

/**
 * The slice of `NodeJS.ReadStream` `readStdin` actually needs, so a unit
 * test can pass a plain `EventEmitter`-backed fake instead of a real
 * stream.
 */
export interface StdinLike {
  setEncoding(encoding: BufferEncoding): void;
  // `any[]`, matching Node's own `EventEmitter#on` signature, not
  // `unknown[]`: a narrower listener type (e.g. `(chunk: string) => void`)
  // must still be assignable here under `strictFunctionTypes`, which
  // `any` (but not `unknown`) permits.
  on(event: string, listener: (...args: any[]) => void): unknown;
  pause(): void;
}

export function readStdin(
  firstByteTimeoutMs: number,
  stdin: StdinLike = process.stdin,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let firstByte: NodeJS.Timeout | undefined = setTimeout(() => {
      stdin.pause();
      reject(
        noStdinContentError(
          `stdin produced no data for ${firstByteTimeoutMs}ms and never ended`,
        ),
      );
    }, firstByteTimeoutMs);
    // Cleared once, on the first chunk, and never re-armed after that --
    // see the module comment above for why.
    const disarm = () => {
      if (firstByte === undefined) return;
      clearTimeout(firstByte);
      firstByte = undefined;
    };
    const settle = (fn: () => void) => {
      disarm();
      fn();
    };
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      disarm();
      data += chunk;
    });
    stdin.on("end", () => settle(() => resolve(data)));
    stdin.on("error", (err: Error) => settle(() => reject(err)));
  });
}
