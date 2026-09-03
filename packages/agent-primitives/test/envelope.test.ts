import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  buildEnvelope,
  exitCodeForStatus,
  statusClass,
} from "../src/envelope.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-envelope-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("statusClass / exitCodeForStatus", () => {
  it("maps ok class statuses to exit 0", () => {
    expect(statusClass("ok")).toBe("ok");
    expect(exitCodeForStatus("ok")).toBe(0);
    expect(exitCodeForStatus("pass")).toBe(0);
    expect(exitCodeForStatus("killed")).toBe(0);
  });

  it("maps finding class statuses to exit 1", () => {
    expect(statusClass("missing")).toBe("finding");
    expect(exitCodeForStatus("missing")).toBe(1);
    expect(exitCodeForStatus("fail")).toBe(1);
    expect(exitCodeForStatus("survived")).toBe(1);
  });

  it("maps cannot-conclude class statuses (including usage_error) to exit 2", () => {
    expect(statusClass("usage_error")).toBe("cannot-conclude");
    expect(exitCodeForStatus("usage_error")).toBe(2);
    expect(exitCodeForStatus("inconclusive")).toBe(2);
  });

  it("treats an unrecognized status as cannot-conclude (exit 2), never falls through to ok", () => {
    expect(exitCodeForStatus("something-new")).toBe(2);
  });
});

describe("buildEnvelope: hard bound", () => {
  it("keeps a small result untouched and not truncated", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra: { tools: [{ name: "git", found: true }] },
    });
    expect(envelope.truncated).toBe(false);
    expect(envelope.logs).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("caps a synthetic result carrying a 5 MB single-line tail so the serialized envelope stays under maxChars, marks truncated, and records the full-result path", () => {
    const logDir = makeTmpDir();
    const hugeTail = "x".repeat(5 * 1024 * 1024);
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { checks: [{ name: "test", stdoutTail: hugeTail }] },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    const logs = envelope.logs as string[];
    expect(logs.length).toBeGreaterThan(0);
    const fullResultPath = logs[logs.length - 1];
    expect(fs.existsSync(fullResultPath)).toBe(true);
    const fullResult = JSON.parse(fs.readFileSync(fullResultPath, "utf8"));
    expect(fullResult.checks[0].stdoutTail.length).toBe(hugeTail.length);
  });
});

describe("buildEnvelope: reduction order", () => {
  it("cuts failure lists before message lengths and before tails", () => {
    const logDir = makeTmpDir();
    const longMessage = "m".repeat(2000);
    const failures = Array.from({ length: 30 }, (_, i) => ({
      file: `f${i}.ts`,
      line: i,
      message: longMessage,
    }));
    const maxChars = 5000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: {
        checks: [
          {
            name: "test",
            failures,
            stdoutTail: "tail-output\n".repeat(50),
            stderrTail: "err-output\n".repeat(50),
          },
        ],
      },
      maxChars,
      logDir,
    });
    const checks = envelope.checks as Array<{
      failures: unknown[];
      stdoutTail: string;
      stderrTail: string;
    }>;
    expect(checks[0].failures.length).toBeLessThan(30);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    // The tails were short to begin with (well under a message cap), so a
    // correct failures-first order should be able to fit under 5000 chars
    // without ever touching them.
    expect(checks[0].stdoutTail).toBe("tail-output\n".repeat(50));
    expect(checks[0].stderrTail).toBe("err-output\n".repeat(50));
  });

  it("clamps message lengths when trimming failures alone is not enough, before touching tails", () => {
    const logDir = makeTmpDir();
    const longMessage = "m".repeat(3000);
    const maxChars = 2000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: {
        checks: [
          {
            name: "test",
            failures: [{ file: "f.ts", line: 1, message: longMessage }],
            stdoutTail: "short-tail",
          },
        ],
      },
      maxChars,
      logDir,
    });
    const checks = envelope.checks as Array<{
      failures: Array<{ message: string }>;
      stdoutTail: string;
    }>;
    expect(checks[0].failures[0].message.length).toBeLessThan(
      longMessage.length,
    );
    expect(checks[0].stdoutTail).toBe("short-tail");
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
  });
});
