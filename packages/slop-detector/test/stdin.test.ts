import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS,
  noStdinContentError,
  readStdin,
  stdinFirstByteTimeoutMs,
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

describe("stdinFirstByteTimeoutMs", () => {
  it("undefined env falls back to the default", () => {
    expect(stdinFirstByteTimeoutMs({})).toBe(
      DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS,
    );
    expect(DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS).toBe(10_000);
  });

  it("a non-numeric value falls back to the default", () => {
    expect(
      stdinFirstByteTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "abc" }),
    ).toBe(DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS);
  });

  it("a negative value falls back to the default", () => {
    expect(
      stdinFirstByteTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "-5" }),
    ).toBe(DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS);
  });

  it("zero falls back to the default (must be strictly positive)", () => {
    expect(
      stdinFirstByteTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "0" }),
    ).toBe(DEFAULT_STDIN_FIRST_BYTE_TIMEOUT_MS);
  });

  it("a valid positive value is used as-is", () => {
    expect(
      stdinFirstByteTimeoutMs({ SLOP_DETECTOR_STDIN_TIMEOUT_MS: "250" }),
    ).toBe(250);
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

  it("once the bound fires and the promise has rejected, late data/end is inert: no unhandled rejection", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const promise = readStdin(50, stdin);
      // Attach the rejection handler before advancing the clock, so the
      // rejection this produces is observed and never surfaces as an
      // unhandled rejection.
      const assertion = expect(promise).rejects.toThrow(
        /stdin produced no data for 50ms and never ended/,
      );
      await vi.advanceTimersByTimeAsync(50);
      // The promise already settled (rejected); a producer that shows up
      // late must not change that outcome or throw on its own.
      stdin.emit("data", "too late");
      stdin.emit("end");
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an immediate end with no data resolves '' and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const promise = readStdin(1_000, stdin);
      stdin.emit("end");
      await expect(promise).resolves.toBe("");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer on the success path (data then end)", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const promise = readStdin(1_000, stdin);
      stdin.emit("data", "hello");
      stdin.emit("end");
      await expect(promise).resolves.toBe("hello");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
