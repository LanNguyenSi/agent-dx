import { describe, expect, it } from "vitest";
import {
  getRawTimestampString,
  getTimestampEpoch,
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
