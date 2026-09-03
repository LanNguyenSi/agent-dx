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

describe("buildEnvelope: step order (arrays before strings)", () => {
  it("shortens the largest array first, leaving every shorter string untouched when that alone reaches the bound", () => {
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
    // Both tails were short to begin with, so shortening the one long
    // array should be able to reach 5000 chars without the string step
    // ever running.
    expect(checks[0].stdoutTail).toBe("tail-output\n".repeat(50));
    expect(checks[0].stderrTail).toBe("err-output\n".repeat(50));
  });

  it("shortens the longest string when no array can be shortened, leaving the shorter strings untouched", () => {
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
    // The array itself must actually shrink (mutant: array-capping
    // filtered to arrays literally named "failures" would leave this
    // 500-element "checks" array at its full length, reaching the bound
    // only by stripping every object's fields down to nothing instead,
    // which is strictly worse since a caller loses which checks even ran).
    const reducedChecks = envelope.checks as unknown[];
    expect(reducedChecks.length).toBeLessThan(500);
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

describe("buildEnvelope: undefined-valued fields", () => {
  it("measures a result carrying an undefined-valued field instead of throwing on it, and never drops it for zero progress", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "doctor",
      status: "ok",
      durationMs: 5,
      cwd: "/tmp",
      // `absent` is what a subcommand produces when an optional capture
      // came back empty (doctor's `version` for a binary that printed
      // nothing). JSON.stringify returns undefined, not a string, for such
      // a value, so measuring it as a reduction candidate used to throw
      // and turn the whole command into `status: error`.
      extra: { absent: undefined, filler: "x".repeat(50_000) },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    expect(envelope.status).toBe("ok");
    // Deleting it would have been "progress" worth exactly zero
    // characters, so the reduction leaves it alone.
    expect("absent" in envelope).toBe(true);
  });
});

describe("buildEnvelope: array truncation marker", () => {
  it("states the count omitted from the array's ORIGINAL length after several reduction passes, not just the last pass's", () => {
    const logDir = makeTmpDir();
    const originalLength = 5000;
    // ~12 serialized characters per element, so the array starts far
    // enough above the bound that no single pass can reach it: each pass
    // keeps at most half, and the marker has to keep counting from 5000
    // rather than restarting at whatever the previous pass left.
    const items = Array.from(
      { length: originalLength },
      (_, i) => `item-${String(i).padStart(4, "0")}`,
    );
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { items },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const reduced = envelope.items as unknown[];
    const marker = reduced[reduced.length - 1];
    expect(typeof marker).toBe("string");
    const omitted = Number(
      /^\.\.\.\((\d+) more items? omitted\)$/.exec(marker as string)?.[1],
    );
    expect(Number.isFinite(omitted)).toBe(true);
    // The kept real elements plus the omitted count must account for every
    // original element, whatever the reduction had to do to get there.
    expect(omitted + (reduced.length - 1)).toBe(originalLength);
  });
});

/** A result whose only reachable reduction is dropping whole keys: 5,000
 * top-level fields, no array with two or more elements, and every value
 * too short for the string step to shorten. */
function wideFlatExtra(): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: 5000 }, (_, i) => [`k${i}`, "ab"]),
  );
}

describe("buildEnvelope: wide results reachable only by dropping keys", () => {
  it("brings a 5,000-key flat result under maxChars 8000 within the default work budget", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: wideFlatExtra(),
      maxChars,
      logDir,
    });
    // The bound is what is asserted, not the elapsed time: a loaded
    // machine may take longer without the result being wrong, and the
    // budget's own effect is asserted separately below, where it is
    // deterministic.
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(warnings.some((w) => w.includes("could not be met"))).toBe(false);
  });

  it("drops every remaining field wholesale, with a warning saying so, once the work budget is spent", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: wideFlatExtra(),
      maxChars,
      logDir,
      // Deterministic: the budget is checked before the first pass, so a
      // budget of 0 always ends the loop before any reduction runs.
      reductionBudgetMs: 0,
    });
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) => w.includes("reduction work budget (0ms) reached")),
    ).toBe(true);
    expect(Object.keys(envelope).filter((k) => k.startsWith("k"))).toEqual([]);
    expect(envelope.truncated).toBe(true);
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
  });
});

describe("buildEnvelope: results that cannot be serialized at all", () => {
  it("emits the skeleton and a warning naming the reason for a value structuredClone refuses (a function), keeping the command's real status", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { onDone: () => {}, name: "unit" },
    });
    expect(envelope.status).toBe("fail");
    expect(exitCode).toBe(1);
    expect(envelope.onDone).toBeUndefined();
    expect(envelope.name).toBeUndefined();
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) =>
        w.startsWith("result fields dropped: not serializable"),
      ),
    ).toBe(true);
  });

  it("does the same for a circular object, which structuredClone copies happily and JSON.stringify then refuses", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { graph: node },
    });
    expect(envelope.status).toBe("fail");
    expect(envelope.graph).toBeUndefined();
    expect(envelope.truncated).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(
      warnings.some((w) =>
        w.startsWith("result fields dropped: not serializable"),
      ),
    ).toBe(true);
    expect(() => JSON.stringify(envelope)).not.toThrow();
  });
});

describe("buildEnvelope: overrun warning across a digit-count boundary", () => {
  it("states the envelope's true final length at every size in a range that crosses one", () => {
    const maxChars = 10;
    const digitCounts = new Set<number>();
    // The warning's own number is part of the length it reports, so the
    // sizes where the number gains a digit are exactly the ones an
    // approximate answer gets wrong. The cwd is a fixed field, never cut,
    // so its length drives the final size one character at a time.
    for (let cwdLength = 780; cwdLength <= 800; cwdLength++) {
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "doctor",
        status: "ok",
        durationMs: 5,
        cwd: `/${"c".repeat(cwdLength)}`,
        extra: { tools: [{ name: "git", found: true }] },
        maxChars,
      });
      const finalLength = JSON.stringify(envelope).length;
      digitCounts.add(String(finalLength).length);
      const warnings = envelope.warnings as string[];
      expect(warnings[warnings.length - 1]).toBe(
        `envelope is ${finalLength} characters; requested max-chars ${maxChars} could not be met`,
      );
    }
    // The range really does straddle a boundary, so the assertion above is
    // not just repeating one digit count 21 times.
    expect(digitCounts.size).toBeGreaterThan(1);
  });
});
