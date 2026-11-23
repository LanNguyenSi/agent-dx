import { describe, expect, it } from "vitest";
import {
  buildReport,
  compareFindings,
  type Finding,
} from "../../src/lint/index.js";

const f = (over: Partial<Finding>): Finding => ({
  rule: "r",
  level: "error",
  file: "a.md",
  path: "$",
  message: "m",
  ...over,
});

const base = {
  spec: null,
  mode: "lint" as const,
  profile: "full" as const,
  profileSource: "default" as const,
  status: null,
  strict: false,
  errors: [],
  warnings: [],
  acked: [],
  skipped: [],
};

describe("finding order", () => {
  it("sorts by file, then line, then path, rule, id and message", () => {
    const sorted = (list: Finding[]) => [...list].sort(compareFindings);
    expect(
      sorted([f({ file: "b" }), f({ file: "a" })]).map((x) => x.file),
    ).toEqual(["a", "b"]);
    expect(sorted([f({ line: 9 }), f({ line: 2 })]).map((x) => x.line)).toEqual(
      [2, 9],
    );
    // a numeric compare: 10 after 9, not before it as text
    expect(
      sorted([f({ line: 10 }), f({ line: 9 })]).map((x) => x.line),
    ).toEqual([9, 10]);
    // a finding without a line comes before one with a line
    expect(sorted([f({ line: 1 }), f({})]).map((x) => x.line)).toEqual([
      undefined,
      1,
    ]);
    expect(
      sorted([f({ path: "b" }), f({ path: "a" })]).map((x) => x.path),
    ).toEqual(["a", "b"]);
    expect(
      sorted([f({ rule: "b" }), f({ rule: "a" })]).map((x) => x.rule),
    ).toEqual(["a", "b"]);
    expect(
      sorted([f({ id: "b" }), f({ id: "a" }), f({})]).map((x) => x.id),
    ).toEqual([undefined, "a", "b"]);
    expect(
      sorted([f({ message: "b" }), f({ message: "a" })]).map((x) => x.message),
    ).toEqual(["a", "b"]);
  });

  it("ranks the keys in order: file before line before path before rule", () => {
    const first = f({ file: "a", line: 5, path: "z", rule: "z" });
    const second = f({ file: "b", line: 1, path: "a", rule: "a" });
    expect(compareFindings(first, second)).toBeLessThan(0);
    const third = f({ file: "a", line: 1, path: "z", rule: "z" });
    expect(compareFindings(third, first)).toBeLessThan(0);
    const fourth = f({ file: "a", line: 1, path: "a", rule: "z" });
    expect(compareFindings(fourth, third)).toBeLessThan(0);
    const fifth = f({ file: "a", line: 1, path: "a", rule: "a" });
    expect(compareFindings(fifth, fourth)).toBeLessThan(0);
  });

  it("compares strings by code unit, not by locale", () => {
    expect(compareFindings(f({ path: "B" }), f({ path: "a" }))).toBeLessThan(0);
  });

  it("buildReport sorts every list and the input order does not matter", () => {
    const a = f({ file: "a" });
    const b = f({ file: "b" });
    const one = buildReport({ ...base, errors: [b, a] });
    const two = buildReport({ ...base, errors: [a, b] });
    expect(one).toEqual(two);
    expect(one.errors.map((x) => x.file)).toEqual(["a", "b"]);
    const w = buildReport({
      ...base,
      warnings: [
        f({ level: "warning", file: "b" }),
        f({ level: "warning", file: "a" }),
      ],
    });
    expect(w.warnings.map((x) => x.file)).toEqual(["a", "b"]);
    const acked = buildReport({
      ...base,
      acked: [
        { ...f({ level: "warning", file: "b" }), reason: "r" },
        { ...f({ level: "warning", file: "a" }), reason: "r" },
      ],
    });
    expect(acked.acked.map((x) => x.file)).toEqual(["a", "b"]);
  });
});

describe("report shape", () => {
  it("writes the top-level keys and the finding keys in a fixed order", () => {
    const report = buildReport({
      ...base,
      errors: [f({ id: "AC-1", line: 3, code: "c" })],
      acked: [{ ...f({ level: "warning" }), reason: "why" }],
    });
    expect(Object.keys(report)).toEqual([
      "format",
      "spec",
      "mode",
      "profile",
      "profile_source",
      "status",
      "ok",
      "errors",
      "warnings",
      "acked",
      "skipped",
      "counts",
    ]);
    expect(Object.keys(report.errors[0]!)).toEqual([
      "rule",
      "level",
      "file",
      "path",
      "id",
      "line",
      "code",
      "message",
    ]);
    expect(Object.keys(report.acked[0]!)).toEqual([
      "rule",
      "level",
      "file",
      "path",
      "message",
      "reason",
    ]);
    expect(
      Object.keys(buildReport({ ...base, errors: [f({})] }).errors[0]!),
    ).toEqual(["rule", "level", "file", "path", "message"]);
  });

  it("sorts skipped by rule id and keeps only rule and reason", () => {
    const report = buildReport({
      ...base,
      skipped: [
        { rule: "b-rule", reason: "gate" },
        { rule: "a-rule", reason: "no-git" },
      ],
    });
    expect(report.skipped).toEqual([
      { rule: "a-rule", reason: "no-git" },
      { rule: "b-rule", reason: "gate" },
    ]);
    expect(Object.keys(report.skipped[0]!)).toEqual(["rule", "reason"]);
  });

  it("counts the three lists", () => {
    const report = buildReport({
      ...base,
      errors: [f({}), f({ file: "b" })],
      warnings: [f({ level: "warning" })],
      acked: [],
    });
    expect(report.counts).toEqual({ errors: 2, warnings: 1, acked: 0 });
  });

  it("ok is false with an error, and false with a warning only under strict", () => {
    const warning = f({ level: "warning" });
    expect(buildReport({ ...base }).ok).toBe(true);
    expect(buildReport({ ...base, errors: [f({})] }).ok).toBe(false);
    expect(buildReport({ ...base, warnings: [warning] }).ok).toBe(true);
    expect(buildReport({ ...base, warnings: [warning], strict: true }).ok).toBe(
      false,
    );
    expect(buildReport({ ...base, errors: [f({})], strict: true }).ok).toBe(
      false,
    );
    expect(
      buildReport({
        ...base,
        acked: [{ ...warning, reason: "r" }],
        strict: true,
      }).ok,
    ).toBe(true);
  });
});
