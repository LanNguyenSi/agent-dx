import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { runArgv } from "../src/probe/run.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-run-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runArgv", () => {
  it("hands an argument carrying shell metacharacters to the program verbatim and executes none of it", async () => {
    const logDir = makeTmpDir();
    const cwd = makeTmpDir();
    // Both substitution forms `sh -c` expands even inside double quotes.
    // Through an argv array there is no shell at all, so the program
    // sees the literal characters and nothing runs.
    const argument =
      "a$(touch injected-by-dollar.txt)`touch injected-by-backtick.txt`b";

    const result = await runArgv(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", argument],
      { cwd, logDir },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(argument);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("captures a non-zero exit code and stderr", async () => {
    const logDir = makeTmpDir();
    const result = await runArgv(
      process.execPath,
      ["-e", "process.stderr.write('boom'); process.exit(3);"],
      { logDir },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom");
    expect(result.timedOut).toBe(false);
    expect(result.outputTruncated).toBe(false);
  });

  it("writes both streams to one log file under logDir and names it in the result", async () => {
    const logDir = makeTmpDir();
    const result = await runArgv(
      process.execPath,
      ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n');"],
      { logDir, logFileName: "named.log" },
    );
    expect(result.logPath).toBe(path.join(logDir, "named.log"));
    const log = fs.readFileSync(result.logPath, "utf8");
    expect(log).toContain("out");
    expect(log).toContain("err");
    expect(result.logWriteFailed).toBe(false);
  });

  it("surfaces a log write failure in the result instead of crashing the process", async () => {
    const logDir = makeTmpDir();
    // A directory where the log FILE is about to be opened: the write
    // stream fails with EISDIR on its own 'error' event.
    fs.mkdirSync(path.join(logDir, "a-directory"));
    const result = await runArgv(
      process.execPath,
      ["-e", "process.stdout.write('hi')"],
      { logDir, logFileName: "a-directory" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.logWriteFailed).toBe(true);
    expect(result.logWriteError).toBeTruthy();
  });

  it("kills a command that outlives the timeout and reports timedOut", async () => {
    const logDir = makeTmpDir();
    const started = Date.now();
    const result = await runArgv(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { logDir, timeoutMs: 300 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20000);

  it("bounds what it keeps in memory and says so, rather than reporting a fragment as the whole output", async () => {
    const logDir = makeTmpDir();
    const result = await runArgv(
      process.execPath,
      ["-e", "process.stdout.write('y'.repeat(1100000))"],
      { logDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBe(1_000_000);
  }, 20000);

  it("kills the child's process group and reports aborted: true when the signal fires, without waiting out a SIGTERM grace", async () => {
    const logDir = makeTmpDir();
    const controller = new AbortController();
    const started = Date.now();
    // A child that traps SIGTERM: only the SIGKILL this runner sends on
    // an abort can end it, so a SIGTERM-and-wait abort would sit here
    // until the test's own timeout.
    const promise = runArgv(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('up'); setTimeout(() => {}, 30000)",
      ],
      { logDir, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20000);

  it("kills the child straight away for a signal that is already aborted when the call starts", async () => {
    const logDir = makeTmpDir();
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await runArgv(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { logDir, signal: controller.signal },
    );
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20000);

  it("reports aborted: false for a command that finishes on its own with a signal given", async () => {
    const logDir = makeTmpDir();
    const controller = new AbortController();
    const result = await runArgv(
      process.execPath,
      ["-e", "process.stdout.write('done')"],
      { logDir, signal: controller.signal },
    );
    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBe(false);
  });

  it("rejects when the program cannot be spawned at all", async () => {
    const logDir = makeTmpDir();
    await expect(
      runArgv(path.join(makeTmpDir(), "no-such-binary"), [], { logDir }),
    ).rejects.toThrow();
  });
});
