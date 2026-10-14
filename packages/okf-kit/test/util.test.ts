import { describe, expect, it } from "vitest";
import {
  getRawTimestampString,
  getStampDivergence,
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
    // `TZ` environments. Compared against the literal epoch (not a
    // same-process `Date.parse("...Z")` call) so a mutant that drops the
    // UTC-forcing branch and hands the raw string straight to `Date.parse`
    // -- which happens to also equal this literal under `TZ=UTC` -- is
    // still caught by the CLI-level `TZ=Asia/Tokyo` pins; this pin alone
    // only proves the VALUE is right under whatever `TZ` this process runs
    // under (verified with `node -e`: 1767225600 ===
    // Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000)).
    expect(getTimestampEpoch({ timestamp: "2026-01-01T00:00:00" })).toBe(
      1767225600,
    );
  });

  it("parses a designator-less space-separated (YAML 1.1 canonical) string as UTC too (D-016)", () => {
    expect(getTimestampEpoch({ timestamp: "2026-01-01 00:00:00" })).toBe(
      1767225600,
    );
  });

  it("still parses a string carrying a numeric offset unchanged, not as UTC (D-016)", () => {
    // A numeric offset already names a real instant; forcing UTC on TOP of
    // it would silently discard the offset and misread the instant.
    expect(getTimestampEpoch({ timestamp: "2026-01-01T00:00:00+02:00" })).toBe(
      Math.floor(Date.parse("2026-01-01T00:00:00+02:00") / 1000),
    );
  });

  it("trims a trailing-space-padded designator value before parsing (`.trim()` in parseTimestampInstantMs)", () => {
    // `Date.parse` rejects a value with trailing whitespace after the `Z`
    // (verified with `node -e`: `Date.parse("2026-01-01T20:00:00Z ")` is
    // `NaN`), which is why the base behavior before this fix read a
    // padded value as "not assessable: no valid timestamp". The trim
    // makes this value parse the same as its unpadded form (literal
    // verified with `node -e`: 1767297600 ===
    // Math.floor(Date.parse("2026-01-01T20:00:00Z") / 1000)).
    expect(getTimestampEpoch({ timestamp: "2026-01-01T20:00:00Z " })).toBe(
      1767297600,
    );
  });

  it("trims a leading-space-padded designator-less value before parsing, still forced to UTC (`.trim()` in parseTimestampInstantMs, D-016)", () => {
    expect(getTimestampEpoch({ timestamp: " 2026-01-01T00:00:00" })).toBe(
      1767225600,
    );
  });

  it("stays judged for a date-only string (no time part at all)", () => {
    // "2026-01-01" has no designator to gate on and no time-of-day for
    // `hasUtcDesignator` to check either, so `parseTimestampInstantMs`
    // appends `Z` and hands `Date.parse` the string "2026-01-01Z". This
    // rests on `Date.parse` already resolving a bare date-only ISO string
    // ("2026-01-01") as UTC midnight by its own spec (unlike a
    // date-TIME string, which defaults to local time) -- the appended `Z`
    // here is redundant with that but harmless, since `Date.parse` also
    // accepts "<date>Z" (literal verified with `node -e`: 1767225600 ===
    // Math.floor(Date.parse("2026-01-01Z") / 1000)).
    expect(getTimestampEpoch({ timestamp: "2026-01-01" })).toBe(1767225600);
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
    // Literal epoch (verified with `node -e`: 1767272400000 ===
    // Date.parse("2026-01-01T13:00:00Z")), not a same-process `Date.parse`
    // call, for the same reason as the `getTimestampEpoch` pins above.
    expect(getTimestampEpochMs({ timestamp: "2026-01-01T13:00:00" })).toBe(
      1767272400000,
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

describe("generated.at as the effective stamp (OKF v0.2)", () => {
  it("reads the instant from generated.at instead of timestamp", () => {
    expect(
      getTimestampEpoch({
        timestamp: "2020-01-01T00:00:00Z",
        generated: { by: "okf-kit/1.0.0", at: "2026-03-04T05:06:07Z" },
      }),
    ).toBe(Date.parse("2026-03-04T05:06:07Z") / 1000);
    expect(
      getTimestampEpochMs({
        generated: { at: "2026-03-04T05:06:07.500Z" },
      }),
    ).toBe(Date.parse("2026-03-04T05:06:07.500Z"));
  });

  it("keeps the Date vs string handling for generated.at identical to timestamp's", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(getTimestampEpoch({ generated: { at: date } })).toBe(
      Date.parse("2026-01-01T00:00:00Z") / 1000,
    );
    // A core-schema YAML parse hands back a string; the same instant must
    // produce the same epoch either way.
    expect(
      getTimestampEpoch({ generated: { at: "2026-01-01T00:00:00Z" } }),
    ).toBe(getTimestampEpoch({ generated: { at: date } }));
    expect(
      getTimestampEpoch({ generated: { at: new Date("not-a-date") } }),
    ).toBeUndefined();
    // A designator-less generated.at is forced UTC exactly like a
    // designator-less timestamp.
    expect(
      getTimestampEpoch({ generated: { at: "2026-01-01T13:00:00" } }),
    ).toBe(Date.parse("2026-01-01T13:00:00Z") / 1000);
  });

  it("falls back to timestamp when generated.at is absent or unreadable, not when it is merely alongside generated.by", () => {
    expect(getTimestampEpoch({ timestamp: "2026-01-01T00:00:00Z" })).toBe(
      Date.parse("2026-01-01T00:00:00Z") / 1000,
    );
    expect(
      getTimestampEpoch({
        timestamp: "2026-01-01T00:00:00Z",
        generated: { by: "human:alice" },
      }),
    ).toBe(Date.parse("2026-01-01T00:00:00Z") / 1000);
    // Unreadable `at` shapes (number, blank string) count as absent.
    expect(
      getTimestampEpoch({
        timestamp: "2026-01-01T00:00:00Z",
        generated: { at: 12345 },
      }),
    ).toBe(Date.parse("2026-01-01T00:00:00Z") / 1000);
    expect(
      getTimestampEpoch({
        timestamp: "2026-01-01T00:00:00Z",
        generated: { at: "   " },
      }),
    ).toBe(Date.parse("2026-01-01T00:00:00Z") / 1000);
  });

  it("exposes generated.at's raw spelling, and none for a native date", () => {
    expect(
      getRawTimestampString({
        timestamp: "2020-01-01T00:00:00Z",
        generated: { at: "2026-01-01T00:00:00" },
      }),
    ).toBe("2026-01-01T00:00:00");
    expect(
      getRawTimestampString({
        generated: { at: new Date("2026-01-01T00:00:00Z") },
      }),
    ).toBeUndefined();
  });

  it("prefixes a generated.at identity so migrating the same instant off timestamp reads as changed", () => {
    expect(
      getTimestampIdentity({ generated: { at: "2026-01-01T00:00:00Z" } }),
    ).not.toBe(getTimestampIdentity({ timestamp: "2026-01-01T00:00:00Z" }));
    expect(
      getTimestampIdentity({ generated: { at: "2026-01-01T00:00:00Z" } }),
    ).toBe(
      getTimestampIdentity({ generated: { at: " 2026-01-01T00:00:00Z " } }),
    );
  });

  describe("getStampDivergence", () => {
    it("reports only a both-parseable, genuinely different pair", () => {
      expect(
        getStampDivergence({
          timestamp: "2026-01-02T00:00:00Z",
          generated: { at: "2026-01-05T00:00:00Z" },
        }),
      ).toMatchObject({ generatedAtMs: Date.parse("2026-01-05T00:00:00Z") });
      expect(
        getStampDivergence({
          timestamp: "2026-01-02T00:00:00Z",
          generated: { at: "2026-01-02T00:00:00.000Z" },
        }),
      ).toBeUndefined(); // same instant, redundant not contradictory
      expect(
        getStampDivergence({ timestamp: "2026-01-02T00:00:00Z" }),
      ).toBeUndefined();
      expect(
        getStampDivergence({ generated: { at: "2026-01-02T00:00:00Z" } }),
      ).toBeUndefined();
      expect(
        getStampDivergence({
          timestamp: "not-a-date",
          generated: { at: "2026-01-02T00:00:00Z" },
        }),
      ).toBeUndefined(); // unparseable side: no second instant to disagree with
      expect(
        getStampDivergence({
          timestamp: new Date("2026-01-02T00:00:00Z"),
          generated: { at: "2026-01-05T00:00:00Z" },
        }),
      ).toBeDefined(); // a native date timestamp diverges just the same
    });
  });
});
