import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { execCommand } from "../src/exec.js";
import { execCommand as execCommandFromIndex } from "../src/index.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-exec-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("execCommand", () => {
  it("captures exit 0 and stdoutTail for a simple command", async () => {
    const logDir = makeTmpDir();
    const result = await execCommand("echo hi", { logDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail.trim()).toBe("hi");
    expect(result.timedOut).toBe(false);
    expect(fs.existsSync(result.logPath)).toBe(true);
    expect(fs.readFileSync(result.logPath, "utf8").trim()).toBe("hi");
  });

  it("captures a non-zero exit code and stderr", async () => {
    const logDir = makeTmpDir();
    const result = await execCommand("echo boom 1>&2; exit 3", { logDir });
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail.trim()).toBe("boom");
  });

  it("caps tails to the last 60 lines and at most 6000 characters per stream", async () => {
    const logDir = makeTmpDir();
    // 200 lines, each well under 6000 chars alone, to test the line cap.
    const result = await execCommand(
      "for i in $(seq 1 200); do echo line-$i; done",
      {
        logDir,
      },
    );
    const lines = result.stdoutTail.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines[lines.length - 1]).toBe("line-200");
    expect(result.stdoutTail.length).toBeLessThanOrEqual(6000);

    const logDir2 = makeTmpDir();
    // One very long single line, to test the character cap independent of
    // the line cap.
    const longLine = "y".repeat(20000);
    const result2 = await execCommand(`printf '%s' '${longLine}'`, {
      logDir: logDir2,
    });
    expect(result2.stdoutTail.length).toBeLessThanOrEqual(6000);
  });

  it("hits the timeout and reports timedOut: true for a long-running command", async () => {
    const logDir = makeTmpDir();
    const result = await execCommand("sleep 5", { logDir, timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10000);

  it("runs in the given cwd", async () => {
    const logDir = makeTmpDir();
    const cwd = makeTmpDir();
    const result = await execCommand("pwd", { logDir, cwd });
    expect(result.stdoutTail.trim()).toBe(fs.realpathSync(cwd));
  });

  it("decodes a multi-byte UTF-8 character split across two data chunks without producing replacement characters", async () => {
    const logDir = makeTmpDir();
    // "é" is 0xC3 0xA9 in UTF-8; emitting the two bytes as separate `node
    // -e` writes with a pause between them forces two separate stdout
    // `data` chunks, each landing mid-character. Decoding each chunk
    // independently (e.g. Buffer#toString) would turn each lone byte into
    // U+FFFD. Bytes are emitted from node rather than a shell `printf`
    // escape (`\xNN`), which dash (the default /bin/sh on Debian/Ubuntu,
    // including the ubuntu-24.04 CI image) does not interpret the way
    // bash does.
    const result = await execCommand(
      `node -e "process.stdout.write(Buffer.from([0xc3]))" && sleep 0.1 && node -e "process.stdout.write(Buffer.from([0xa9]))"`,
      {
        logDir,
      },
    );
    expect(result.stdoutTail).toBe("é");
    expect(result.stdoutTail).not.toContain("�");
  });

  it("flushes an incomplete trailing multi-byte sequence via decoder.end() instead of dropping it silently", async () => {
    const logDir = makeTmpDir();
    // A single 0xC3 byte (the start of a 2-byte UTF-8 sequence for "é")
    // with no continuation byte ever sent: the command exits while the
    // decoder is still holding it back. Without the decoder.end() flush
    // in exec.ts's `finish`, this byte is simply lost and stdoutTail is
    // empty.
    const result = await execCommand(
      `node -e "process.stdout.write(Buffer.from([0xc3]))"`,
      { logDir },
    );
    expect(result.stdoutTail.length).toBeGreaterThan(0);
  });

  it("surfaces a log write failure in ExecResult instead of crashing the process", async () => {
    const logDir = makeTmpDir();
    // Pre-create a directory at the exact path execCommand will try to
    // open as the log FILE: fs.createWriteStream trying to open a
    // directory for writing fails with EISDIR, asynchronously, on the
    // stream's 'error' event -- exactly the class of failure the log
    // stream's error listener exists to catch instead of crashing.
    fs.mkdirSync(path.join(logDir, "a-directory"));
    const result = await execCommand("echo hi", {
      logDir,
      logFileName: "a-directory",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail.trim()).toBe("hi");
    expect(result.logWriteFailed).toBe(true);
    expect(result.logWriteError).toBeTruthy();
  });

  it("re-exports execCommand from ../src/index.js with identical behavior", async () => {
    const logDir = makeTmpDir();
    const result = await execCommandFromIndex("echo hi", { logDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail.trim()).toBe("hi");
  });
});
