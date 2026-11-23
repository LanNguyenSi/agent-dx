import { describe, expect, it } from "vitest";
import {
  compareIds,
  compareText,
  normalizeText,
  sortById,
} from "../../src/canonical/index.js";

describe("normalizeText", () => {
  it("collapses every run of ASCII whitespace to one space and trims the ends", () => {
    expect(normalizeText("a  b")).toBe("a b");
    expect(normalizeText("a\tb")).toBe("a b");
    expect(normalizeText("a \t\r\n\f\v b")).toBe("a b");
    expect(normalizeText("  a b  ")).toBe("a b");
    expect(normalizeText("\n\ta\n")).toBe("a");
    expect(normalizeText("a b")).toBe("a b");
  });

  it("keeps other Unicode spaces and every non-space character", () => {
    expect(normalizeText("a b")).toBe("a b");
    expect(normalizeText("a  b")).toBe("a  b");
    expect(normalizeText(" a")).toBe(" a");
    expect(normalizeText("a　b")).toBe("a　b");
    expect(normalizeText("A b")).not.toBe(normalizeText("a b"));
  });
});

describe("compareIds", () => {
  it("orders by prefix, then by the number as an integer", () => {
    const ids = ["AC-10", "AC-2", "NG-1", "AC-1", "DC-3", "AC-100", "AC-9"];
    expect([...ids].sort(compareIds)).toEqual([
      "AC-1",
      "AC-2",
      "AC-9",
      "AC-10",
      "AC-100",
      "DC-3",
      "NG-1",
    ]);
  });

  it("is a total order that agrees with itself", () => {
    expect(compareIds("AC-1", "AC-1")).toBe(0);
    expect(compareIds("AC-1", "AC-2")).toBeLessThan(0);
    expect(compareIds("AC-2", "AC-1")).toBeGreaterThan(0);
    expect(compareIds("GOAL", "GOAL")).toBe(0);
    expect(compareIds("GOAL", "AC-1")).toBeGreaterThan(0);
    expect(compareIds("AC-1", "GOAL")).toBeLessThan(0);
    expect(compareIds("GOAL", "NG-1")).toBeLessThan(0);
  });
});

describe("sortById and compareText", () => {
  it("sorts rows by id without touching the input", () => {
    const rows = [{ id: "TP-10" }, { id: "TP-2" }, { id: "TP-1" }];
    expect(sortById(rows).map((r) => r.id)).toEqual(["TP-1", "TP-2", "TP-10"]);
    expect(rows.map((r) => r.id)).toEqual(["TP-10", "TP-2", "TP-1"]);
  });

  it("compares text by UTF-16 code units", () => {
    expect(["b", "a", "B", "😀", "דּ"].sort(compareText)).toEqual([
      "B",
      "a",
      "b",
      "😀",
      "דּ",
    ]);
    expect(compareText("a", "a")).toBe(0);
  });
});
