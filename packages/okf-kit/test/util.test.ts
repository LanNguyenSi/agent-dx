import { describe, expect, it } from "vitest";
import {
  getRawTimestampString,
  getTimestampEpoch,
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
