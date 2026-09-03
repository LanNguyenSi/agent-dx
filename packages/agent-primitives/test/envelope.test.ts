import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  applyCaps,
  buildEnvelope,
  exitCodeForStatus,
  statusClass,
  type CapLimits,
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

/** The fixed envelope fields, in the order the envelope carries them. */
const FIXED_FIELDS = [
  "tool",
  "version",
  "command",
  "status",
  "durationMs",
  "cwd",
  "truncated",
  "logs",
  "warnings",
];

/** `...(N more items omitted)` -> N. */
function arrayMarkerCount(marker: unknown): number {
  expect(typeof marker).toBe("string");
  const match = /^\.\.\.\((\d+) more items? omitted\)$/.exec(marker as string);
  expect(match, `not an array marker: ${String(marker)}`).toBeTruthy();
  return Number(match?.[1]);
}

/** `N more keys omitted` -> N. */
function objectMarkerCount(marker: unknown): number {
  expect(typeof marker).toBe("string");
  const match = /^(\d+) more keys? omitted$/.exec(marker as string);
  expect(match, `not an object marker: ${String(marker)}`).toBeTruthy();
  return Number(match?.[1]);
}

/** `...(N more characters omitted)` -> N. */
function stringMarkerCount(value: string): number {
  const match = /\.\.\.\((\d+) more characters? omitted\)$/.exec(value);
  expect(match, `no string marker at the end of a cut string`).toBeTruthy();
  return Number(match?.[1]);
}

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

  it("names the run in the full-result file, so a second invocation sharing one log dir does not overwrite the first's evidence", () => {
    const logDir = makeTmpDir();
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { blob: "x".repeat(50_000) },
      maxChars: 8000,
      logDir,
    });
    const logs = envelope.logs as string[];
    const name = path.basename(logs[logs.length - 1]);
    expect(name).not.toBe("result-full.json");
    expect(name).toMatch(/^result-full-.+\.json$/);
  });
});

describe("buildEnvelope: balance between sibling strings", () => {
  it("cuts two equally long sibling tails to (near) equal lengths instead of spending the whole budget on the first one", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "probe",
      status: "survived",
      durationMs: 10,
      cwd: "/tmp",
      extra: {
        baseline: { tail: "b".repeat(20_000) },
        mutated: { tail: "m".repeat(20_000) },
      },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const baselineTail = (envelope.baseline as { tail: string }).tail;
    const mutatedTail = (envelope.mutated as { tail: string }).tail;
    // Both sides of a probe have to survive: an envelope that keeps the
    // baseline tail whole and drops the mutant's says nothing about why
    // the probe came out the way it did.
    expect(baselineTail.length).toBeGreaterThanOrEqual(1000);
    expect(mutatedTail.length).toBeGreaterThanOrEqual(1000);
    const spread =
      Math.abs(baselineTail.length - mutatedTail.length) /
      Math.max(baselineTail.length, mutatedTail.length);
    expect(spread).toBeLessThanOrEqual(0.1);
  });
});

describe("buildEnvelope: granular container trimming", () => {
  it("trims entries inside a 500-entry map instead of deleting the map wholesale, keeps its sibling field, and states how many entries went", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    // A per-file coverage map: the container is keyed, so what has to be
    // trimmed are its entries. Deleting the whole `files` value would meet
    // the bound too, and would tell the reader nothing at all.
    const files = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `src/module-${i}/file.ts`,
        {
          path: `src/module-${i}/file.ts`,
          status: i % 3 === 0 ? "covered" : "partial",
        },
      ]),
    );
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { coverage: { files, total: 500 } },
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const coverage = envelope.coverage as {
      files: Record<string, unknown>;
      total: number;
    };
    expect(coverage.total).toBe(500);
    const keptKeys = Object.keys(coverage.files).filter((k) => k !== "...");
    expect(keptKeys.length).toBeGreaterThanOrEqual(50);
    expect(objectMarkerCount(coverage.files["..."]) + keptKeys.length).toBe(
      500,
    );
    // The surviving entries are whole, not stubs.
    const first = coverage.files[keptKeys[0]] as {
      path: string;
      status: string;
    };
    expect(first.path).toBe(keptKeys[0]);
    expect(["covered", "partial"]).toContain(first.status);
  });
});

describe("buildEnvelope: wide objects", () => {
  it("keeps a useful number of a 5,000-key object's keys under maxChars 8000", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`k${i}`, "v".repeat(20)]),
      ),
      maxChars,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    const kept = Object.keys(envelope).filter((k) => k.startsWith("k"));
    expect(kept.length).toBeGreaterThanOrEqual(100);
    expect(objectMarkerCount(envelope["..."]) + kept.length).toBe(5000);
    // Every kept value is whole: the keys that survive are worth reading.
    expect(envelope[kept[0]]).toBe("v".repeat(20));
  });

  it("stays under the bound for a 20,000-key object of 100-character values", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: Object.fromEntries(
        Array.from({ length: 20_000 }, (_, i) => [`k${i}`, "v".repeat(100)]),
      ),
      maxChars,
      logDir,
    });
    // The bound, not a wall time: the pass count is fixed and each pass is
    // linear, so the guarantee this test can state is the result, and a
    // loaded machine never makes it flake.
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    expect(
      Object.keys(envelope).filter((k) => k.startsWith("k")).length,
    ).toBeGreaterThan(0);
  });
});

describe("buildEnvelope: utilization", () => {
  it("uses at least 90 percent of the requested budget for an input far above it", () => {
    const logDir = makeTmpDir();
    const maxChars = 8000;
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { blob: "z".repeat(1_000_000) },
      maxChars,
      logDir,
    });
    const length = JSON.stringify(envelope).length;
    expect(length).toBeLessThanOrEqual(maxChars);
    // A reduction that always undershoots is bounded but useless: the
    // caller asked for 8000 characters of evidence and should get them.
    expect(length).toBeGreaterThanOrEqual(maxChars * 0.9);
  });
});

describe("buildEnvelope: determinism", () => {
  function reducibleInput(logDir: string) {
    return {
      version: "0.1.0",
      command: "verify",
      status: "fail" as const,
      durationMs: 10,
      cwd: "/tmp",
      extra: {
        blob: "q".repeat(60_000),
        list: Array.from({ length: 300 }, (_, i) => ({ i, name: `n-${i}` })),
      },
      maxChars: 8000,
      logDir,
    };
  }

  it("produces exactly one distinct serialization over 50 calls with the same input", () => {
    const logDir = makeTmpDir();
    const serializations = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { envelope } = buildEnvelope(reducibleInput(logDir));
      serializations.add(JSON.stringify(envelope));
    }
    expect(serializations.size).toBe(1);
  });

  it("reduces without reading a clock: Date.now and performance.now may throw throughout", () => {
    const logDir = makeTmpDir();
    const boom = (): never => {
      throw new Error("clock read");
    };
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(boom);
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(boom);
    let envelope: Record<string, unknown>;
    try {
      // Negative control: the stubs really are in place, so a clock read
      // anywhere inside buildEnvelope would surface as a thrown error
      // rather than as a silently ignored value.
      expect(() => Date.now()).toThrow("clock read");
      expect(() => performance.now()).toThrow("clock read");
      envelope = buildEnvelope(reducibleInput(logDir)).envelope;
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
    }
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(8000);
    expect(envelope.truncated).toBe(true);
  });
});

describe("buildEnvelope: tiny bounds", () => {
  for (const maxChars of [0, 10, 50]) {
    it(`yields parseable JSON at the skeleton floor with an honest overrun warning at maxChars ${maxChars}`, () => {
      const logDir = makeTmpDir();
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "doctor",
        status: "ok",
        durationMs: 5,
        cwd: "/tmp/some/cwd",
        extra: { tools: Array.from({ length: 20 }, (_, i) => ({ i })) },
        maxChars,
        logDir,
      });
      const json = JSON.stringify(envelope);
      expect(() => JSON.parse(json)).not.toThrow();
      // Nothing but the fixed fields is left, and the JSON string itself
      // was never cut mid-token to get there.
      expect(Object.keys(envelope)).toEqual(FIXED_FIELDS);
      const warnings = envelope.warnings as string[];
      expect(warnings[warnings.length - 1]).toBe(
        `envelope is ${json.length} characters; requested max-chars ${maxChars} could not be met`,
      );
    });
  }
});

describe("buildEnvelope: honest in-band markers", () => {
  it("states the count omitted from an array's ORIGINAL length, whatever scale the search settled on", () => {
    const logDir = makeTmpDir();
    const originalLength = 5000;
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
    const omitted = arrayMarkerCount(reduced[reduced.length - 1]);
    expect(omitted + (reduced.length - 1)).toBe(originalLength);
    // The kept elements are the head of the original, untouched.
    expect(reduced[0]).toBe("item-0000");
  });

  it("states the count omitted from a string's original length in its suffix", () => {
    const logDir = makeTmpDir();
    const original = "s".repeat(40_000);
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { tail: original },
      maxChars: 8000,
      logDir,
    });
    const tail = envelope.tail as string;
    const omitted = stringMarkerCount(tail);
    const suffixLength = `...(${omitted} more characters omitted)`.length;
    expect(omitted + (tail.length - suffixLength)).toBe(original.length);
  });

  it("replaces a subtree below the depth limit with a placeholder naming the depth", () => {
    const logDir = makeTmpDir();
    let chain: unknown = "leaf";
    for (let i = 0; i < 20; i++) chain = { next: chain, level: i };
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { deep: chain, filler: "x".repeat(50_000) },
      maxChars: 8000,
      logDir,
    });
    let cursor: unknown = envelope.deep;
    let placeholder: string | undefined;
    while (cursor !== undefined && cursor !== null) {
      if (typeof cursor === "string") {
        if (cursor.startsWith("...(subtree pruned at depth ")) {
          placeholder = cursor;
        }
        break;
      }
      cursor = (cursor as { next?: unknown }).next;
    }
    expect(placeholder).toMatch(/^\.\.\.\(subtree pruned at depth \d+\)$/);
  });

  it("never re-marks an already marked value: applyCaps reads only the pristine payload", () => {
    const payload = { items: Array.from({ length: 100 }, (_, i) => i) };
    const limits: CapLimits = {
      maxString: 1000,
      maxArray: 10,
      maxKeys: 1000,
      maxDepth: 12,
    };
    const once = applyCaps(payload, limits) as { items: unknown[] };
    // Same input, same limits, same answer; and the caller's payload is
    // untouched, so a second pass can start from it again.
    const again = applyCaps(payload, limits) as { items: unknown[] };
    expect(JSON.stringify(again)).toBe(JSON.stringify(once));
    expect(payload.items.length).toBe(100);
    expect(arrayMarkerCount(once.items[once.items.length - 1])).toBe(90);
  });
});

describe("buildEnvelope: PROTECTED_KEYS are held apart from the payload", () => {
  it("keeps every fixed field and logs[0] verbatim at maxChars 50, even though the cut must reach the skeleton", () => {
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
    // The full-result path itself must survive untouched: it is a fairly
    // long string, a plausible target for the string cap if the fixed
    // fields were reduced along with the payload.
    expect(logs[0].startsWith(logDir)).toBe(true);
    expect(fs.existsSync(logs[0])).toBe(true);
  });

  it("keeps the fixed fields byte for byte at every scale the search can settle on", () => {
    const cwd = "/tmp/a/deliberately/long/working/directory/for/this/assertion";
    const longWarning = "w".repeat(300);
    for (const maxChars of [10, 50, 200, 1000, 4000, 8000, 100_000]) {
      const logDir = makeTmpDir();
      const { envelope } = buildEnvelope({
        version: "0.1.0",
        command: "verify",
        status: "fail",
        durationMs: 42,
        cwd,
        warnings: [longWarning],
        extra: {
          blob: "z".repeat(200_000),
          rows: Array.from({ length: 2000 }, (_, i) => ({
            i,
            text: "t".repeat(80),
          })),
        },
        maxChars,
        logDir,
      });
      expect(envelope.tool).toBe("agent-primitives");
      expect(envelope.version).toBe("0.1.0");
      expect(envelope.command).toBe("verify");
      expect(envelope.status).toBe("fail");
      expect(envelope.durationMs).toBe(42);
      expect(envelope.cwd).toBe(cwd);
      expect((envelope.warnings as string[])[0]).toBe(longWarning);
      const logs = envelope.logs as string[];
      expect(logs.length).toBe(1);
      expect(fs.existsSync(logs[0])).toBe(true);
    }
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

  it("does not warn for a heavily reduced result that did meet the bound", () => {
    const logDir = makeTmpDir();
    const { envelope } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`k${i}`, "ab"]),
      ),
      maxChars: 8000,
      logDir,
    });
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(8000);
    const warnings = envelope.warnings as string[];
    expect(warnings.some((w) => w.includes("could not be met"))).toBe(false);
  });

  it("states the envelope's true final length at every size in a range that crosses a digit-count boundary", () => {
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
    expect(digitCounts.size).toBeGreaterThan(1);
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
  it("measures a result carrying an undefined-valued field instead of throwing on it, and keeps the key", () => {
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
    expect("absent" in envelope).toBe(true);
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

  it("does the same for a BigInt, which structuredClone copies and JSON.stringify refuses", () => {
    const { envelope, exitCode } = buildEnvelope({
      version: "0.1.0",
      command: "verify",
      status: "fail",
      durationMs: 10,
      cwd: "/tmp",
      extra: { count: 10n, name: "unit" },
    });
    expect(envelope.status).toBe("fail");
    expect(exitCode).toBe(1);
    expect(envelope.count).toBeUndefined();
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
