import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface RunArgvOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds. No timeout when omitted. */
  timeoutMs?: number;
  /** Directory the log file is written into (created if missing). */
  logDir: string;
  /** Log file basename. Defaults to a name derived from the current time. */
  logFileName?: string;
  /** When aborted, kills the child's whole process group with `SIGKILL`
   * straight away, the same shape (and for the same reason) as
   * `ExecOptions.signal`: `probe` threads its own SIGINT/SIGTERM
   * controller into every `git apply`, so an interrupted apply cannot
   * land on the target after the emergency restore has already put the
   * original content back. Additive: omitted, behavior is unchanged. */
  signal?: AbortSignal;
}

export interface RunArgvResult {
  exitCode: number | null;
  durationMs: number;
  /** The whole captured stream, not a tail: this runner's callers parse
   * the output (see `stdout` in `mutant.ts`'s `--numstat` check), and a
   * tail would silently drop the beginning of a long listing. Bounded by
   * `MAX_CAPTURED_CHARS`; `outputTruncated` says when that bound was
   * reached, so a caller can refuse rather than parse a fragment. */
  stdout: string;
  stderr: string;
  logPath: string;
  timedOut: boolean;
  /** True when `options.signal` fired and killed the child before it
   * exited on its own. Distinct from `timedOut` (this runner's own
   * bound): an abort is the caller asking to stop, not the command
   * itself running too long. */
  aborted: boolean;
  /** True when either stream hit `MAX_CAPTURED_CHARS`, so `stdout` and
   * `stderr` are no longer the complete output of the command. */
  outputTruncated: boolean;
  /** Same meaning as `ExecResult.logWriteFailed`: the command's own exit
   * code and captured output are still reported, only the on-disk log is
   * unreliable. */
  logWriteFailed: boolean;
  /** Set alongside `logWriteFailed: true`, naming what went wrong. */
  logWriteError?: string;
  /** Always `true`: unlike `exec.ts`'s `ExecResult`, this runner (see
   * the docblock below) only ever settles on `close`, so by the time
   * this result exists the child's stdio has genuinely, already closed.
   * Kept as an explicit field (rather than leaving callers to assume
   * it) so a caller that treats the two runners uniformly can read the
   * same field off either result. */
  stdioClosed: true;
}

/** How long SIGTERM is given before SIGKILL follows on the timeout path,
 * the same grace `exec.ts` uses. */
const KILL_ESCALATION_GRACE_MS = 2000;

/** Hard bound on how much of each stream is kept in memory. Far above
 * anything `git apply` produces for a real patch, and low enough that a
 * hostile patch cannot make this process hold an unbounded string. */
const MAX_CAPTURED_CHARS = 1_000_000;

/**
 * Runs one program with an explicit argv array and NO shell, streaming
 * stdout and stderr to one interleaved log file under `logDir` the same
 * way `exec.ts` does, and resolving with the exit code, duration, the
 * captured streams, the log path, and whether the timeout fired.
 *
 * This exists because `probe` runs `git apply` with paths the caller
 * supplies (`-p, --patch`). Built as a shell string, such a path is
 * command injection no quoting scheme reliably prevents: `sh -c` expands
 * `$(...)` and backticks inside double quotes, so a patch file whose name
 * contains either would execute it. With an argv array there is no shell
 * to expand anything, and the path reaches `git` as one opaque argument.
 *
 * Unlike `execCommand` this settles on `close` alone: its callers run
 * `git apply`, which spawns no descendant that could inherit and hold the
 * stdio pipes open, so there is nothing for a flush grace to bound. The
 * child is still started in its own process group so a timeout, or
 * `options.signal`, can signal the whole group, matching `exec.ts` rather
 * than leaving a narrower kill here.
 */
export function runArgv(
  file: string,
  args: string[],
  options: RunArgvOptions,
): Promise<RunArgvResult> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(options.logDir, { recursive: true });
    const logFileName =
      options.logFileName ??
      `argv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
    const logPath = path.join(options.logDir, logFileName);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    // A WriteStream with no 'error' listener crashes the process on a
    // write failure (an unhandled 'error' event) instead of surfacing it.
    // Registered before any write, so no failure window is unguarded.
    let logWriteFailed: string | undefined;
    let logStreamSettled = false;
    let resolveLogStreamDone: (() => void) | undefined;
    const logStreamDone = new Promise<void>((res) => {
      resolveLogStreamDone = res;
    });
    const settleLogStream = () => {
      if (logStreamSettled) return;
      logStreamSettled = true;
      resolveLogStreamDone?.();
    };
    logStream.on("finish", settleLogStream);
    logStream.on("error", (err) => {
      logWriteFailed = err instanceof Error ? err.message : String(err);
      settleLogStream();
    });

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    // A StringDecoder per stream, for the same reason exec.ts uses one: a
    // multi-byte UTF-8 character (a path with a non-ASCII name) can land
    // split across two `data` chunks.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const start = Date.now();
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
    });

    /** Signals the child's whole process group (the negated pid), falling
     * back to the direct child when the group cannot be signalled. */
    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // Fall through to the direct child below.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The child is already gone; nothing left to signal.
      }
    };

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        setTimeout(() => {
          if (!settled) signalGroup("SIGKILL");
        }, KILL_ESCALATION_GRACE_MS).unref();
      }, options.timeoutMs);
      timer.unref();
    }

    // `SIGKILL` on the group straight away, with none of the timeout
    // path's `SIGTERM` grace, for the same reason `exec.ts`'s abort path
    // skips it: the caller aborting is about to write to the very file
    // this `git apply` is writing, and the escalation timer that would
    // eventually reach a surviving child dies with the exiting process.
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      signalGroup("SIGKILL");
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const detachAbortListener = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const capture = (text: string, isStdout: boolean): void => {
      logStream.write(text);
      const current = isStdout ? stdout : stderr;
      const room = MAX_CAPTURED_CHARS - current.length;
      if (room <= 0) {
        outputTruncated = true;
        return;
      }
      const kept = text.length > room ? text.slice(0, room) : text;
      if (kept.length < text.length) outputTruncated = true;
      if (isStdout) stdout = current + kept;
      else stderr = current + kept;
    };

    child.stdout.on("data", (data: Buffer) => {
      capture(stdoutDecoder.write(data), true);
    });
    child.stderr.on("data", (data: Buffer) => {
      capture(stderrDecoder.write(data), false);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detachAbortListener();
      logStream.end();
      logStreamDone.then(() => reject(err));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detachAbortListener();
      // Flush whatever incomplete trailing multi-byte sequence each
      // decoder is still holding back.
      const stdoutRemainder = stdoutDecoder.end();
      if (stdoutRemainder) capture(stdoutRemainder, true);
      const stderrRemainder = stderrDecoder.end();
      if (stderrRemainder) capture(stderrRemainder, false);
      logStream.end();
      logStreamDone.then(() => {
        resolve({
          exitCode: code,
          durationMs: Date.now() - start,
          stdout,
          stderr,
          logPath,
          timedOut,
          aborted,
          outputTruncated,
          logWriteFailed: logWriteFailed !== undefined,
          ...(logWriteFailed !== undefined
            ? { logWriteError: logWriteFailed }
            : {}),
          stdioClosed: true,
        });
      });
    });
  });
}
