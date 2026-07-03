import { describe, expect, it } from "vitest";
import { getTimestampEpoch } from "../src/util.js";

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
