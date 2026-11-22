import { describe, expect, it } from "vitest";
import {
  COVERABLE_ID_PREFIXES,
  GOAL_ID,
  NUMBERED_ID_PREFIXES,
  formatId,
  formatQualifiedId,
  isCoverableId,
  isId,
  isSpecId,
  parseId,
  parseQualifiedId,
} from "../../src/formats/index.js";

describe("IDs", () => {
  it("names exactly the nine prefixes", () => {
    expect(GOAL_ID).toBe("GOAL");
    expect([...NUMBERED_ID_PREFIXES]).toEqual([
      "AC",
      "NG",
      "DF",
      "DC",
      "RS",
      "SL",
      "TP",
      "QN",
    ]);
  });

  it("parses every prefix", () => {
    for (const prefix of NUMBERED_ID_PREFIXES) {
      const r = parseId(`${prefix}-12`);
      expect(r).toEqual({ ok: true, value: { prefix, number: 12 } });
    }
    expect(parseId("GOAL")).toEqual({ ok: true, value: { prefix: "GOAL" } });
  });

  it.each([
    "",
    "AC",
    "AC-",
    "AC-0",
    "AC-01",
    "AC--1",
    "AC-1x",
    "ac-1",
    "GOAL-1",
    "XX-1",
    " AC-1",
    "AC-1 ",
    "AC-1234567890",
    "spec#AC-1",
  ])("rejects %j", (text) => {
    const r = parseId(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("invalid-id");
    expect(isId(text)).toBe(false);
  });

  it("formats and round-trips", () => {
    for (const prefix of NUMBERED_ID_PREFIXES) {
      expect(parseId(formatId(prefix, 7))).toEqual({
        ok: true,
        value: { prefix, number: 7 },
      });
    }
    expect(formatId("GOAL")).toBe("GOAL");
    expect(formatId("AC", 3)).toBe("AC-3");
  });

  it("refuses to format an invalid ID", () => {
    expect(() => formatId("AC")).toThrow(RangeError);
    expect(() => formatId("AC", 0)).toThrow(RangeError);
    expect(() => formatId("AC", 1.5)).toThrow(RangeError);
    expect(() => formatId("GOAL", 1)).toThrow(RangeError);
    expect(() => formatId("AC", 1_000_000_000)).toThrow(RangeError);
    expect(formatId("AC", 999_999_999)).toBe("AC-999999999");
    expect(parseId("AC-999999999").ok).toBe(true);
    expect(() => formatId("XX" as "AC", 1)).toThrow(RangeError);
  });

  it("parses and formats qualified IDs", () => {
    expect(parseQualifiedId("login-fix#AC-1")).toEqual({
      ok: true,
      value: { specId: "login-fix", id: { prefix: "AC", number: 1 } },
    });
    expect(parseQualifiedId("login-fix#GOAL")).toEqual({
      ok: true,
      value: { specId: "login-fix", id: { prefix: "GOAL" } },
    });
    expect(formatQualifiedId("login-fix", "TP-4")).toBe("login-fix#TP-4");
    expect(parseQualifiedId(formatQualifiedId("a", "AC-2")).ok).toBe(true);
  });

  it.each([
    "AC-1",
    "#AC-1",
    "spec#",
    "spec#AC-1#2",
    "Spec#AC-1",
    "spec_x#AC-1",
    "spec#AC-0",
    "-spec#AC-1",
    "spec-#AC-1",
    `${"a".repeat(65)}#AC-1`,
  ])("rejects the qualified form %j", (text) => {
    const r = parseQualifiedId(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("invalid-id");
  });

  it("refuses to format a bad qualified ID", () => {
    expect(() => formatQualifiedId("Bad Id", "AC-1")).toThrow(RangeError);
    expect(() => formatQualifiedId("ok", "AC-0")).toThrow(RangeError);
  });

  it("accepts spec IDs up to 64 characters", () => {
    expect(isSpecId("a".repeat(64))).toBe(true);
    expect(isSpecId("a".repeat(65))).toBe(false);
    expect(isSpecId("a-b-1")).toBe(true);
    expect(isSpecId("a--b")).toBe(false);
  });

  it("lets a test-plan row cover only AC, DF and NG", () => {
    expect([...COVERABLE_ID_PREFIXES]).toEqual(["AC", "DF", "NG"]);
    for (const ok of ["AC-1", "DF-2", "NG-3"])
      expect(isCoverableId(ok)).toBe(true);
    for (const bad of [
      "GOAL",
      "DC-1",
      "RS-1",
      "SL-1",
      "TP-1",
      "QN-1",
      "AC-0",
      "",
    ]) {
      expect(isCoverableId(bad)).toBe(false);
    }
  });
});
