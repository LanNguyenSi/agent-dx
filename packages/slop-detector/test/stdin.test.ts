import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  DEFAULT_STDIN_IDLE_TIMEOUT_MS,
  noStdinContentError,
  readStdin,
  stdinIdleTimeoutMs,
  type StdinLike,
} from "../src/stdin.js";

// A plain EventEmitter satisfies `StdinLike` (see its comment in
// src/stdin.ts) without spinning up a real stream or a subprocess, so
// `readStdin`'s arm-once/disarm-on-first-chunk behavior is pinned here at
// unit-test speed and precision (fake timers), while test/cli.test.ts keeps
// the end-to-end subprocess coverage for the two argv-visible shapes.
class FakeStdin extends EventEmitter implements StdinLike {
  paused = false;
  setEncoding(): void {}
  pause(): void {
    this.paused = true;
  }
}

describe("stdinIdleTimeoutMs", () => {
  it("undefined env falls back to the default", () => {
    expect(stdinIdleTimeoutMs({})).toBe(DEFAULT_STDIN_IDLE_TIMEOUT_MS);
    expect(DEFAULT_STDIN_IDLE_TIMEOUT_MS).toBe(10_000);
  });

  it("a non-numeric value falls back to the default", () => {
    expect(stdinIdleTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "abc" })).toBe(
      DEFAULT_STDIN_IDLE_TIMEOUT_MS,
    );
  });

  it("a negative value falls back to the default", () => {
    expect(stdinIdleTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "-5" })).toBe(
      DEFAULT_STDIN_IDLE_TIMEOUT_MS,
    );
  });

  it("zero falls back to the default (must be strictly positive)", () => {
    expect(stdinIdleTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "0" })).toBe(
      DEFAULT_STDIN_IDLE_TIMEOUT_MS,
    );
  });

  it("a valid positive value is used as-is", () => {
    expect(stdinIdleTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "250" })).toBe(
      250,
    );
  });
});

describe("readStdin", () => {
  it("resolves with the collected data on end", async () => {
    const stdin = new FakeStdin();
    const promise = readStdin(1_000, stdin);
    stdin.emit("data", "hello ");
    stdin.emit("data", "world");
    stdin.emit("end");
    await expect(promise).resolves.toBe("hello world");
  });

  it("rejects with the never-written error if nothing arrives before the bound", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const promise = readStdin(50, stdin);
      const assertion = expect(promise).rejects.toThrow(
        /stdin produced no data for 50ms and never ended/,
      );
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(stdin.paused).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the guard is disarmed on the first chunk and never re-armed: a stall after data does not reject", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const promise = readStdin(50, stdin);
      stdin.emit("data", "partial");
      // Longer than the bound, well past where a re-armed timer would have
      // fired again -- this is the mutant (a)-killing assertion: restoring
      // the old re-arm-on-every-chunk behavior makes this reject instead.
      await vi.advanceTimersByTimeAsync(500);
      stdin.emit("data", " more");
      stdin.emit("end");
      await expect(promise).resolves.toBe("partial more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a stream error", async () => {
    const stdin = new FakeStdin();
    const promise = readStdin(1_000, stdin);
    const boom = new Error("boom");
    stdin.emit("error", boom);
    await expect(promise).rejects.toBe(boom);
  });
});

describe("noStdinContentError", () => {
  it("names --stdin-path and the reason", () => {
    const err = noStdinContentError("stdin is a TTY, so nothing was piped in");
    expect(err.message).toContain("stdin is a TTY");
    expect(err.message).toContain("--stdin-path");
    expect(err.message).toMatch(/nothing was scanned/);
  });
});
