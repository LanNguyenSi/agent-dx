import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds. No timeout when omitted. */
  timeoutMs?: number;
  /** Directory the log file is written into (created if missing). */
  logDir: string;
  /** Log file basename. Defaults to a name derived from the current time. */
  logFileName?: string;
  /** When aborted, kills the child's whole process group with `SIGKILL`
   * straight away, with none of the `SIGTERM` grace the timeout path
   * gives: a caller that aborts is about to write to the same files the
   * command runs against (`probe`'s emergency restore, the CLI's exit),
   * and a command that traps `SIGTERM` would otherwise still be running
   * when it does. This call then settles once the killed child's stdio
   * is closed, so awaiting it is what makes the caller's next write the
   * last one. Additive: omitted, behavior is unchanged. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  logPath: string;
  timedOut: boolean;
  /** True when `options.signal` fired and killed the child before it
   * exited on its own. Distinct from `timedOut` (this package's own
   * `--timeout`): an abort is the caller asking to stop, not the command
   * itself running too long. */
  aborted: boolean;
  /** True when the log file write stream reported an error (e.g. the
   * disk filled, or a path collision like a directory where a file was
   * expected). The command's own exit code and tails are still reported;
   * only the on-disk log is unreliable. */
  logWriteFailed: boolean;
  /** Set alongside `logWriteFailed: true`, naming what went wrong. */
  logWriteError?: string;
  /** True when the run settled on the stream flush grace instead of on
   * `close`: the command itself had exited, but something it left behind
   * still held the stdout/stderr pipes open, so anything still in flight
   * on them at that moment is not in `stdoutTail`, `stderrTail`, or the
   * log file. The exit code is the command's own either way; only the
   * captured output is in question. */
  outputMayBeIncomplete: boolean;
}

const TAIL_LINES = 60;
const TAIL_CHARS = 6000;
// Buffer is allowed to grow up to this multiple of the tail cap before
// being trimmed, so a long-running command does not pay a trim on every
// chunk while still staying bounded overall.
const TRIM_SLACK_MULTIPLE = 8;
const TRIM_KEEP_MULTIPLE = 4;

/** How long SIGTERM is given before SIGKILL follows on the timeout path.
 * The abort path does not use it: see `onAbort` below. */
const KILL_ESCALATION_GRACE_MS = 2000;

/** How long the stdio pipes are given to deliver what is already in
 * flight once the command itself has exited, before this call settles
 * without waiting for `close`. Only reached when something other than
 * the command still holds a pipe open; the normal path settles on
 * `close`, which usually arrives in the same tick as `exit`. */
const STREAM_FLUSH_GRACE_MS = 250;

class TailKeeper {
  private buf = "";

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > TAIL_CHARS * TRIM_SLACK_MULTIPLE) {
      this.buf = this.buf.slice(-TAIL_CHARS * TRIM_KEEP_MULTIPLE);
    }
  }

  tail(): string {
    let lines = this.buf.split("\n");
    if (lines.length > TAIL_LINES) {
      lines = lines.slice(-TAIL_LINES);
    }
    let text = lines.join("\n");
    if (text.length > TAIL_CHARS) {
      text = text.slice(-TAIL_CHARS);
    }
    return text;
  }
}

/**
 * Runs `sh -c <cmd>` with an optional timeout, env, and cwd. Streams stdout
 * and stderr to one interleaved log file under `logDir`, keeps fixed tails
 * (last 60 lines and at most 6000 characters per stream), and resolves with
 * the exit code, duration, tails, log path, and whether the timeout fired.
 *
 * The command runs in its own process group, and both the timeout and
 * `options.signal` signal that whole group, so a descendant the command
 * spawned dies with it instead of outliving the run and holding its stdio
 * pipes open. The timeout sends `SIGTERM` and escalates to `SIGKILL`
 * after a short grace; an abort sends `SIGKILL` outright, because its
 * caller is stopping either way and a `SIGTERM`-trapping command would
 * survive the grace. A descendant that puts itself in a process group of
 * its own is out of that reach; the run still settles a short grace after
 * the command itself exits rather than waiting on the pipes.
 */
export function execCommand(
  cmd: string,
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(options.logDir, { recursive: true });
    const logFileName =
      options.logFileName ??
      `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
    const logPath = path.join(options.logDir, logFileName);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    // A WriteStream with no 'error' listener crashes the process on a
    // write failure (an unhandled 'error' event) instead of surfacing it.
    // Registered immediately, before any write, so no failure window is
    // ever unguarded; `logStreamSettled`/`logStreamDone` let `finish`
    // below wait for the stream to actually close (or fail) instead of
    // relying on `.end(callback)`'s 'finish' event, which an errored
    // stream may never emit.
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

    const stdoutTail = new TailKeeper();
    const stderrTail = new TailKeeper();
    // A StringDecoder (not Buffer#toString) per stream: a multi-byte UTF-8
    // character can land split across two `data` chunks, and decoding each
    // chunk independently would turn the split bytes into replacement
    // characters ("�") on each side of the split. StringDecoder holds
    // back incomplete trailing bytes until the next chunk completes them.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const start = Date.now();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let outputMayBeIncomplete = false;
    let flushTimer: NodeJS.Timeout | undefined;

    // `detached: true` puts the child in a new process group of its own
    // (it becomes the group leader), so every descendant it spawns lands
    // in that same group and `signalGroup` below can reach all of them
    // with one signal. Without it, a timeout or an abort kills only the
    // direct child and any grandchild survives: it keeps running, and,
    // because it inherited the stdout/stderr pipes, it also keeps the
    // pipes open, so the run's own bound is not a bound at all.
    const child = spawn("sh", ["-c", cmd], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
    });

    /**
     * Signals the child's whole process group (the negated pid), so a
     * descendant holding the stdio pipes open dies with the command it
     * belongs to. Falls back to signalling the direct child alone when
     * the group cannot be signalled: the group does not exist yet (an
     * abort landing in the window between `spawn` returning and the
     * child's own `setsid`), it is already gone, or the platform refuses
     * a negated pid.
     */
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

    /** The timeout path's kill: SIGTERM first, then SIGKILL once this
     * grace has passed without the run settling, for a command (or a
     * descendant) that ignores SIGTERM. A command that hit its timeout is
     * given the chance to shut down on its own first; an abort is not
     * (see `onAbort`). */
    const terminateGroup = () => {
      signalGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) signalGroup("SIGKILL");
      }, KILL_ESCALATION_GRACE_MS).unref();
    };

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateGroup();
      }, options.timeoutMs);
      timer.unref();
    }

    // `SIGKILL` on the group straight away, NOT the timeout's
    // SIGTERM-then-escalate: this is `probe`'s SIGINT/SIGTERM handler (or
    // the CLI's) about to make its emergency restore the last write to
    // the target. A command that traps `SIGTERM` would sit out the grace
    // period, and the escalation timer that would eventually reach it
    // dies with the process that is exiting, so the child would outlive
    // the restore and write over it. Nothing is lost by skipping the
    // grace: the caller is stopping either way, so there is no orderly
    // shutdown left for the command to perform.
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

    child.stdout.on("data", (data: Buffer) => {
      const text = stdoutDecoder.write(data);
      stdoutTail.push(text);
      logStream.write(text);
    });
    child.stderr.on("data", (data: Buffer) => {
      const text = stderrDecoder.write(data);
      stderrTail.push(text);
      logStream.write(text);
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      detachAbortListener();
      // Stop reading before the log stream is ended: when this call is
      // settling on the flush grace rather than on `close`, a descendant
      // still holds the pipes and any further chunk would be a write to
      // an already-ended stream.
      child.stdout.destroy();
      child.stderr.destroy();
      // Flush any incomplete trailing multi-byte sequence held by each
      // decoder (StringDecoder#end returns the remainder, if any).
      const stdoutRemainder = stdoutDecoder.end();
      if (stdoutRemainder) {
        stdoutTail.push(stdoutRemainder);
        logStream.write(stdoutRemainder);
      }
      const stderrRemainder = stderrDecoder.end();
      if (stderrRemainder) {
        stderrTail.push(stderrRemainder);
        logStream.write(stderrRemainder);
      }
      logStream.end();
      logStreamDone.then(() => {
        resolve({
          exitCode,
          durationMs: Date.now() - start,
          stdoutTail: stdoutTail.tail(),
          stderrTail: stderrTail.tail(),
          logPath,
          timedOut,
          aborted,
          logWriteFailed: logWriteFailed !== undefined,
          ...(logWriteFailed !== undefined
            ? { logWriteError: logWriteFailed }
            : {}),
          outputMayBeIncomplete,
        });
      });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      detachAbortListener();
      logStream.end();
      logStreamDone.then(() => reject(err));
    });

    // `exit` fires when the command itself has exited; `close`
    // additionally waits for every stdio pipe to be closed, which a
    // surviving descendant holding stdout or stderr open can delay for as
    // long as it likes. Settling is therefore driven by `exit` plus a
    // bounded grace for whatever is still in flight on the pipes, and
    // `close` (the normal case, and the only one that can report the
    // stream-accurate code) short-circuits that grace as soon as it
    // arrives.
    child.on("exit", (code) => {
      if (settled) return;
      flushTimer = setTimeout(() => {
        // Settling here rather than on `close` means a descendant is
        // still holding the pipes: whatever it (or the command) had in
        // flight at this instant is dropped, and the result says so
        // instead of presenting a possibly-cut tail as the whole output.
        outputMayBeIncomplete = true;
        finish(code);
      }, STREAM_FLUSH_GRACE_MS);
      flushTimer.unref();
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
