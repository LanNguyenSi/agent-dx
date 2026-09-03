import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  buildEnvelope,
  exitCodeForStatus,
  statusClass,
} from "../src/envelope.js";
import { buildEnvelope as buildEnvelopeFromIndex } from "../src/index.js";

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
    // A 5 MB single line under a field name the reduction never
    // special-cases (it is generic, not name-based): only the
    // longest-string step can bring this under maxChars, repeatedly
    // halving it since nothing else in the graph is remotely as large.
    const hugeTail = "x".repeat(5 * 1024 * 1024);
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { checks: [{ name: "test", rawOutput: hugeTail }] },
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
    expect(fullResult.checks[0].rawOutput.length).toBe(hugeTail.length);
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

describe("buildEnvelope: PROTECTED_KEYS skip set", () => {
  it("keeps every fixed field and logs[0] verbatim at maxChars 50, even though the cut must reach the skeleton (mutant: removing the skip set would let a top-level fixed field be chosen as the largest remaining subtree and get dropped or cut)", () => {
    const logDir = makeTmpDir();
    const cwd = "/tmp/some/reasonably/long/cwd/path/used/for/discrimination";
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd,
      extra: {
        tools: Array.from({ length: 50 }, (_, i) => ({
          name: `tool-${i}`,
          found: true,
        })),
      },
      maxChars: 50,
      logDir,
    });
    expect(envelope.tool).toBe("agent-primitives");
    expect(envelope.version).toBe("0.1.0");
    expect(envelope.command).toBe("doctor");
    expect(envelope.status).toBe("ok");
    expect(envelope.cwd).toBe(cwd);
    expect(envelope.truncated).toBe(true);
    const logs = envelope.logs as string[];
    expect(logs.length).toBeGreaterThan(0);
    // The full-result path itself must survive untouched: if the skip set
    // were removed, this (a fairly long string) is a plausible target for
    // the longest-string or largest-subtree reducers and would come back
    // shortened or missing.
    expect(logs[0].startsWith(logDir)).toBe(true);
    expect(fs.existsSync(logs[0])).toBe(true);
  });
});

describe("buildEnvelope: overrun warning names the true final length", () => {
  it("pushes a warning naming the actual final length when even the skeleton exceeds maxChars", () => {
    const logDir = makeTmpDir();
    const maxChars = 10;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp/some/cwd",
      extra: { tools: [{ name: "git", found: true }] },
      maxChars,
      logDir,
    });
    const finalLength = JSON.stringify(envelope).length;
    const warnings = envelope.warnings as string[];
    const overrun = warnings.find((w) => w.includes("could not be met"));
    expect(overrun).toBeTruthy();
    expect(overrun).toBe(
      `envelope is ${finalLength} characters; requested max-chars ${maxChars} could not be met`,
    );
  });

  it("does not warn when the requested bound was actually met", () => {
    const logDir = makeTmpDir();
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra: { tools: [{ name: "git", found: true }] },
      maxChars: 8000,
      logDir,
    });
    const warnings = envelope.warnings as string[];
    expect(warnings.some((w) => w.includes("could not be met"))).toBe(false);
  });
});

describe("buildEnvelope: many-entry bound (generic reduction, not name-based)", () => {
  it("reduces 500 checks of 2000 characters each to fit within maxChars 8000", () => {
    const logDir = makeTmpDir();
    const checks = Array.from({ length: 500 }, (_, i) => ({
      name: `check-${i}`,
      message: "x".repeat(2000),
    }));
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { checks },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(warnings.some((w) => w.includes("could not be met"))).toBe(false);
  });
});

describe("buildEnvelope: never mutates the caller's extra", () => {
  it("leaves the caller's extra object (including nested arrays/objects) exactly as passed in, even under heavy reduction", () => {
    const logDir = makeTmpDir();
    const original = {
      checks: Array.from({ length: 50 }, (_, i) => ({
        name: `check-${i}`,
        message: "m".repeat(500),
      })),
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: original,
      maxChars: 200,
      logDir,
    });
    expect(original).toEqual(snapshot);
  });
});

describe("buildEnvelope: base fields win over extra", () => {
  it("does not let extra's status/truncated/tool keys shadow the real ones", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      extra: {
        status: "hijacked",
        truncated: true,
        tool: "not-agent-primitives",
        command: "hijacked-command",
        version: "9.9.9",
        cwd: "/hijacked",
      },
    });
    expect(envelope.status).toBe("ok");
    expect(envelope.truncated).toBe(false);
    expect(envelope.tool).toBe("agent-primitives");
    expect(envelope.command).toBe("doctor");
    expect(envelope.version).toBe("0.1.0");
    expect(envelope.cwd).toBe("/tmp");
    expect(exitCode).toBe(0);
  });
});

describe("buildEnvelope: unwritable log dir", () => {
  it("pushes a warning naming the failure instead of silently swallowing it", () => {
    const parentDir = makeTmpDir();
    // A regular file where a directory is expected: mkdirSync(recursive)
    // fails with ENOTDIR trying to create a subdirectory under it.
    const blockerFile = path.join(parentDir, "blocker");
    fs.writeFileSync(blockerFile, "not a directory");
    const unwritableLogDir = path.join(blockerFile, "sub");

    const hugeTail = "x".repeat(1024 * 1024);
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { checks: [{ name: "test", rawOutput: hugeTail }] },
      maxChars: 8000,
      logDir: unwritableLogDir,
    });
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) =>
        w.startsWith(`full result not written to ${unwritableLogDir}:`),
      ),
    ).toBe(true);
    expect(envelope.logs).toEqual([]);
  });
});

describe("index.js seam", () => {
  it("re-exports buildEnvelope with identical behavior", () => {
    const { envelope } = buildEnvelopeFromIndex({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 1,
      cwd: "/tmp",
    });
    expect(envelope.tool).toBe("agent-primitives");
    expect(envelope.status).toBe("ok");
  });
});
