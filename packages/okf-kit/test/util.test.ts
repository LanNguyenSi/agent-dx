import { describe, expect, it } from "vitest";
import {
  getRawTimestampString,
  getTimestampEpoch,
  getTimestampEpochMs,
  getTimestampIdentity,
  hasUtcDesignator,
} from "../src/util.js";

describe("getTimestampEpoch", () => {
  it("parses a Date instance directly", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(getTimestampEpoch({ timestamp: date })).toBe(
      Math.floor(date.getTime() / 1000),
    );
  });

  it("parses a valid ISO string", () => {
    expect(getTimestampEpoch({ timestamp: "2026-01-01T00:00:00Z" })).toBe(
      Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
    );
  });

  it("returns undefined for an invalid Date instance", () => {
    expect(
      getTimestampEpoch({ timestamp: new Date("not-a-date") }),
    ).toBeUndefined();
  });

  it("returns undefined for an unparseable string", () => {
    expect(getTimestampEpoch({ timestamp: "not-a-date" })).toBeUndefined();
  });

  it("returns undefined when timestamp is missing", () => {
    expect(getTimestampEpoch({})).toBeUndefined();
  });

  it("returns undefined for a non-string, non-Date value", () => {
    expect(getTimestampEpoch({ timestamp: 12345 })).toBeUndefined();
  });

  it("returns undefined when parsed frontmatter is not a record", () => {
    expect(getTimestampEpoch(undefined)).toBeUndefined();
    expect(getTimestampEpoch(null)).toBeUndefined();
    expect(getTimestampEpoch(["not", "a", "record"])).toBeUndefined();
  });

  it("parses a designator-less string as UTC, not the process's local timezone (D-016)", () => {
    // No `Z`, no numeric offset: forced to UTC rather than handed to
    // `Date.parse` raw, so this is the SAME value regardless of which `TZ`
    // the process happens to run under -- see the CLI-level pin in
    // test/cli-staleness.test.ts for the end-to-end proof across two real
    // `TZ` environments.
    expect(getTimestampEpoch({ timestamp: "2026-01-01T00:00:00" })).toBe(
      Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
    );
  });

  it("parses a designator-less space-separated (YAML 1.1 canonical) string as UTC too (D-016)", () => {
    expect(getTimestampEpoch({ timestamp: "2026-01-01 00:00:00" })).toBe(
      Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
    );
  });

  it("still parses a string carrying a numeric offset unchanged, not as UTC (D-016)", () => {
    // A numeric offset already names a real instant; forcing UTC on TOP of
    // it would silently discard the offset and misread the instant.
    expect(getTimestampEpoch({ timestamp: "2026-01-01T00:00:00+02:00" })).toBe(
      Math.floor(Date.parse("2026-01-01T00:00:00+02:00") / 1000),
    );
  });
});

describe("getTimestampEpochMs", () => {
  it("distinguishes two instants less than a second apart, unlike getTimestampEpoch (D-008)", () => {
    const earlier = getTimestampEpochMs({
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const later = getTimestampEpochMs({
      timestamp: "2026-01-01T00:00:00.500Z",
    });
    expect(earlier).toBeDefined();
    expect(later).toBeDefined();
    expect(later).toBeGreaterThan(earlier as number);
    // The whole-second floor both instants would share under
    // getTimestampEpoch -- pinning WHY the millisecond helper exists.
    expect(getTimestampEpoch({ timestamp: "2026-01-01T00:00:00.000Z" })).toBe(
      getTimestampEpoch({ timestamp: "2026-01-01T00:00:00.500Z" }),
    );
  });

  it("parses a Date instance directly, at millisecond resolution", () => {
    const date = new Date("2026-01-01T00:00:00.123Z");
    expect(getTimestampEpochMs({ timestamp: date })).toBe(date.getTime());
  });

  it("returns undefined for an invalid Date instance", () => {
    expect(
      getTimestampEpochMs({ timestamp: new Date("not-a-date") }),
    ).toBeUndefined();
  });

  it("returns undefined for an unparseable string", () => {
    expect(getTimestampEpochMs({ timestamp: "not-a-date" })).toBeUndefined();
  });

  it("returns undefined when timestamp is missing, non-scalar, or parsed is not a record", () => {
    expect(getTimestampEpochMs({})).toBeUndefined();
    expect(getTimestampEpochMs({ timestamp: 12345 })).toBeUndefined();
    expect(getTimestampEpochMs(undefined)).toBeUndefined();
    expect(getTimestampEpochMs(null)).toBeUndefined();
  });

  it("parses a designator-less string as UTC, at millisecond resolution (D-016)", () => {
    expect(getTimestampEpochMs({ timestamp: "2026-01-01T13:00:00" })).toBe(
      Date.parse("2026-01-01T13:00:00Z"),
    );
  });
});

describe("getRawTimestampString", () => {
  it("returns the raw string when timestamp is a string", () => {
    expect(getRawTimestampString({ timestamp: "2026-01-01T00:00:00Z" })).toBe(
      "2026-01-01T00:00:00Z",
    );
  });

  it("returns undefined for a Date instance (no ambiguity to check)", () => {
    expect(
      getRawTimestampString({ timestamp: new Date("2026-01-01T00:00:00Z") }),
    ).toBeUndefined();
  });

  it("returns undefined for a blank string, missing key, or non-record", () => {
    expect(getRawTimestampString({ timestamp: "  " })).toBeUndefined();
    expect(getRawTimestampString({})).toBeUndefined();
    expect(getRawTimestampString(undefined)).toBeUndefined();
  });
});

describe("hasUtcDesignator", () => {
  it("accepts a trailing Z", () => {
    expect(hasUtcDesignator("2026-01-01T00:00:00Z")).toBe(true);
  });

  it("accepts a numeric offset with a colon", () => {
    expect(hasUtcDesignator("2026-01-01T00:00:00+02:00")).toBe(true);
  });

  it("accepts a numeric offset without a colon", () => {
    expect(hasUtcDesignator("2026-01-01T00:00:00-0500")).toBe(true);
  });

  it("rejects a bare local datetime with a T separator", () => {
    expect(hasUtcDesignator("2026-01-01T00:00:00")).toBe(false);
  });

  it("rejects a bare local datetime with a space separator", () => {
    expect(hasUtcDesignator("2026-01-01 00:00:00")).toBe(false);
  });
});

describe("getTimestampIdentity", () => {
  it("returns undefined for an absent, blank, or non-scalar timestamp", () => {
    expect(getTimestampIdentity({})).toBeUndefined();
    expect(getTimestampIdentity({ timestamp: "   " })).toBeUndefined();
    expect(getTimestampIdentity({ timestamp: 42 })).toBeUndefined();
    expect(getTimestampIdentity(undefined)).toBeUndefined();
  });

  it("compares equal for the same string value, ignoring surrounding whitespace", () => {
    expect(getTimestampIdentity({ timestamp: "2026-01-01T00:00:00Z" })).toBe(
      getTimestampIdentity({ timestamp: " 2026-01-01T00:00:00Z " }),
    );
  });

  it("compares unequal for a rewritten value, even one denoting the same instant", () => {
    // The test is "did the author touch the stamp", not "did the instant
    // move": re-writing Z as +00:00 IS a re-stamp.
    expect(
      getTimestampIdentity({ timestamp: "2026-01-01T00:00:00Z" }),
    ).not.toBe(
      getTimestampIdentity({ timestamp: "2026-01-01T00:00:00+00:00" }),
    );
    expect(
      getTimestampIdentity({ timestamp: "2026-01-01T00:00:00Z" }),
    ).not.toBe(getTimestampIdentity({ timestamp: "2026-01-02T00:00:00Z" }));
  });

  it("keeps a native Date distinguishable from the string spelling of the same instant", () => {
    expect(
      getTimestampIdentity({ timestamp: new Date("2026-01-01T00:00:00Z") }),
    ).not.toBe(getTimestampIdentity({ timestamp: "2026-01-01T00:00:00Z" }));
  });

  it("returns undefined for an invalid Date", () => {
    expect(
      getTimestampIdentity({ timestamp: new Date("not-a-date") }),
    ).toBeUndefined();
  });
});
