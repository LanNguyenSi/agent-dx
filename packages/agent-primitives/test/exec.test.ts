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
    // Counted with a `while` loop and `$(( ))` arithmetic (both POSIX shell)
    // rather than `seq`, which is not in POSIX and is absent on some
    // minimal images.
    const result = await execCommand(
      "i=1; while [ $i -le 200 ]; do echo line-$i; i=$((i+1)); done",
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

  it("an aborted signal kills the child and resolves with aborted: true instead of leaving it running", async () => {
    const logDir = makeTmpDir();
    const controller = new AbortController();
    const promise = execCommand("sleep 5", {
      logDir,
      signal: controller.signal,
    });
    // Give the child a moment to actually start before aborting it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  }, 10000);

  it("kills the child straight away, and reports aborted: true, for a signal that is already aborted when the call starts", async () => {
    const logDir = makeTmpDir();
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await execCommand("sleep 10", {
      logDir,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    // The pre-check runs before the command could plausibly finish: an
    // already-aborted signal must not be noticed only once the child has
    // run to completion.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  it("bounds a run whose command leaves a descendant holding stdio: --timeout kills the whole process group", async () => {
    const logDir = makeTmpDir();
    const dir = makeTmpDir();
    const heartbeat = path.join(dir, "heartbeat.txt");
    const workerPath = path.join(dir, "worker.js");
    const spawnerPath = path.join(dir, "spawner.js");

    // The worker is a descendant that inherits the command's stdout and
    // stderr and outlives the command's own process unless the whole
    // group is signalled. It would run far longer than the timeout, and
    // its heartbeat file says whether it is still running.
    fs.writeFileSync(
      workerPath,
      [
        "const fs = require('node:fs');",
        "let n = 0;",
        "const tick = () => {",
        "  n += 1;",
        `  fs.writeFileSync(${JSON.stringify(heartbeat)}, String(n));`,
        "};",
        "tick();",
        "const id = setInterval(tick, 100);",
        "setTimeout(() => { clearInterval(id); process.exit(0); }, 12000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      spawnerPath,
      [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, [${JSON.stringify(workerPath)}], {`,
        "  stdio: 'inherit',",
        "});",
        "setTimeout(() => { process.exit(0); }, 12000);",
        "",
      ].join("\n"),
    );

    const started = Date.now();
    const result = await execCommand(`node ${JSON.stringify(spawnerPath)}`, {
      logDir,
      timeoutMs: 2000,
    });
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    // Bounded by the timeout plus the kill and flush grace, not by the
    // descendant's own 12s lifetime.
    expect(elapsed).toBeLessThan(8000);
    // The descendant really started, so the assertion below is about a
    // process that existed rather than one that never ran.
    expect(fs.existsSync(heartbeat)).toBe(true);
    // And it is gone, not merely orphaned: its heartbeat stops.
    const countAtReturn = fs.readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fs.readFileSync(heartbeat, "utf8")).toBe(countAtReturn);
  }, 30000);

  it("settles a short grace after the command's own exit, with the command's own exit code, when a descendant in its own process group outlives it holding stdio, and says the captured output may be incomplete", async () => {
    const logDir = makeTmpDir();
    const dir = makeTmpDir();
    const heartbeat = path.join(dir, "heartbeat.txt");
    const pidFile = path.join(dir, "worker.pid");
    const workerPath = path.join(dir, "worker.js");
    const spawnerPath = path.join(dir, "spawner.js");

    // The descendant is spawned `detached: true` (a process group of its
    // own, so the group signal exec.ts sends on a timeout cannot reach
    // it) with `stdio: 'inherit'` (so it holds the command's stdout and
    // stderr open long after the command itself is gone). `close` on
    // exec.ts's child therefore does not arrive until this worker exits;
    // only the `exit` event plus the flush grace can settle the run.
    // It records its own pid so this test can clean it up rather than
    // leaving a process behind for the rest of the suite.
    fs.writeFileSync(
      workerPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "let n = 0;",
        "const tick = () => {",
        "  n += 1;",
        `  fs.writeFileSync(${JSON.stringify(heartbeat)}, String(n));`,
        "};",
        "tick();",
        "const id = setInterval(tick, 100);",
        "setTimeout(() => { clearInterval(id); process.exit(0); }, 12000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      spawnerPath,
      [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, [${JSON.stringify(workerPath)}], {`,
        "  stdio: 'inherit',",
        "  detached: true,",
        "});",
        "child.unref();",
        "process.exit(7);",
        "",
      ].join("\n"),
    );

    const started = Date.now();
    const result = await execCommand(`node ${JSON.stringify(spawnerPath)}`, {
      logDir,
    });
    const elapsed = Date.now() - started;

    try {
      // The command's own exit code, not a null from a kill and not the
      // descendant's.
      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBe(false);
      // Bounded by the flush grace after the command's own exit, nowhere
      // near the descendant's 12s lifetime.
      expect(elapsed).toBeLessThan(3000);
      // Settling that way means anything still in flight on the pipes was
      // dropped, and the result says so.
      expect(result.outputMayBeIncomplete).toBe(true);
      // The descendant really did outlive the call, so the assertions
      // above are about the flush-grace path rather than a command that
      // simply had no descendant.
      expect(fs.existsSync(heartbeat)).toBe(true);
    } finally {
      // Never leave the worker running for the rest of the suite.
      try {
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, or never started.
      }
    }
  }, 30000);

  it("does not report outputMayBeIncomplete for a command whose stdio closes with it", async () => {
    const logDir = makeTmpDir();
    const result = await execCommand("echo hi", { logDir });
    expect(result.outputMayBeIncomplete).toBe(false);
  });

  it("does not report aborted: true for a command that finishes on its own with a signal given", async () => {
    const logDir = makeTmpDir();
    const controller = new AbortController();
    const result = await execCommand("echo hi", {
      logDir,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(false);
    expect(result.exitCode).toBe(0);
  });

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
