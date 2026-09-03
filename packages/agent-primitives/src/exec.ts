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
}

export interface ExecResult {
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  logPath: string;
  timedOut: boolean;
}

const TAIL_LINES = 60;
const TAIL_CHARS = 6000;
// Buffer is allowed to grow up to this multiple of the tail cap before
// being trimmed, so a long-running command does not pay a trim on every
// chunk while still staying bounded overall.
const TRIM_SLACK_MULTIPLE = 8;
const TRIM_KEEP_MULTIPLE = 4;

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
    let settled = false;

    const child = spawn("sh", ["-c", cmd], {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Escalate if the process ignores SIGTERM.
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 2000).unref();
      }, options.timeoutMs);
      timer.unref();
    }

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
      logStream.end(() => {
        resolve({
          exitCode,
          durationMs: Date.now() - start,
          stdoutTail: stdoutTail.tail(),
          stderrTail: stderrTail.tail(),
          logPath,
          timedOut,
        });
      });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      logStream.end(() => reject(err));
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
