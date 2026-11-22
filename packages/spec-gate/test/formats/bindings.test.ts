import { describe, expect, it } from "vitest";
import {
  BINDING_STATUSES,
  isSafeSelector,
  parseBindings,
  validateBindings,
} from "../../src/formats/index.js";

describe("bindings.yaml", () => {
  it("accepts the two statuses", () => {
    expect([...BINDING_STATUSES]).toEqual(["new", "existing"]);
    for (const status of BINDING_STATUSES) {
      expect(validateBindings({ "TP-1": { status } }).ok).toBe(true);
    }
  });

  it("defaults fixtures to an empty list and keeps given values", () => {
    const r = validateBindings({
      "TP-1": { status: "new" },
      "TP-2": {
        status: "existing",
        selector: "a > b",
        file: "test/a.test.ts",
        fixtures: ["x.json"],
        notes: "n",
      },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        "TP-1": { status: "new", fixtures: [] },
        "TP-2": {
          status: "existing",
          selector: "a > b",
          file: "test/a.test.ts",
          fixtures: ["x.json"],
          notes: "n",
        },
      },
    });
  });

  it("treats an empty fixtures list like an absent one", () => {
    const a = validateBindings({ "TP-1": { status: "new", fixtures: [] } });
    const b = validateBindings({ "TP-1": { status: "new" } });
    expect(a).toEqual(b);
  });

  it("rejects every normative field, naming the field and the row", () => {
    for (const field of [
      "id",
      "covers",
      "kind",
      "claim",
      "expected",
      "oracle",
      "red_reason",
      "baseline",
      "steps",
      "control",
    ]) {
      const r = validateBindings({ "TP-4": { status: "new", [field]: "x" } });
      expect(r.ok, field).toBe(false);
      if (r.ok) continue;
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatchObject({
        code: "wrong-layer-field",
        path: `TP-4.${field}`,
      });
      expect(r.errors[0]!.message).toContain(field);
      expect(r.errors[0]!.message).toContain("TP-4");
    }
  });

  it("accepts only repo-relative file paths", () => {
    for (const file of ["a.test.ts", "test/a.test.ts", "a b/c.ts"]) {
      expect(
        validateBindings({ "TP-1": { status: "new", file } }).ok,
        file,
      ).toBe(true);
    }
    for (const file of [
      "/a.ts",
      "../a.ts",
      "a/../b.ts",
      "a\\b.ts",
      "C:a.ts",
      "c:/a.ts",
    ]) {
      const r = validateBindings({ "TP-1": { status: "new", file } });
      expect(r.ok, JSON.stringify(file)).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(["invalid-value"]);
    }
  });

  it("rejects a control character in a file path as a forbidden character", () => {
    const r = validateBindings({ "TP-1": { status: "new", file: "a\nb.ts" } });
    expect(r.ok === false && r.errors.map((e) => e.code)).toEqual([
      "forbidden-character",
    ]);
  });

  it("rejects a field without a layer", () => {
    const r = validateBindings({ "TP-4": { status: "new", owner: "a" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({
      code: "unknown-field",
      path: "TP-4.owner",
    });
    expect(r.errors[0]!.message).toContain("no layer");
  });

  it("rejects a non-mapping document and non-TP keys", () => {
    expect(validateBindings([]).ok).toBe(false);
    expect(validateBindings(null).ok).toBe(false);
    const r = validateBindings({
      "TP-1": { status: "new" },
      "AC-1": { status: "new" },
    });
    expect(r.ok).toBe(false);
  });

  it("reports every bad binding", () => {
    const r = validateBindings({
      "TP-1": { selector: "x" },
      "TP-2": { status: "x" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => e.path).sort()).toEqual([
        "TP-1.status",
        "TP-2.status",
      ]);
  });

  it("parses text", () => {
    expect(parseBindings("TP-1:\n  status: new\n").ok).toBe(true);
    expect(parseBindings("").ok).toBe(false);
  });
});

describe("selector safety", () => {
  it("accepts ordinary selectors", () => {
    for (const s of [
      "a.test.ts > b c",
      "test_x",
      "path/to/test.py::TestA::test_b",
      "x-y",
      "a b",
    ]) {
      expect(isSafeSelector(s), s).toBe(true);
    }
  });

  it("rejects an empty selector, a leading dash and control characters", () => {
    for (const s of [
      "",
      "  ",
      "-x",
      "--grep=a",
      "a\nb",
      "a\u0000b",
      "a\rb",
      "\u007f",
    ]) {
      expect(isSafeSelector(s), JSON.stringify(s)).toBe(false);
    }
    expect(isSafeSelector("a\tb")).toBe(true);
  });

  it("applies the same rule inside a binding", () => {
    const dash = validateBindings({
      "TP-1": { status: "new", selector: "-x" },
    });
    expect(dash.ok === false && dash.errors[0]!.code).toBe("invalid-selector");
    // The message names the one thing this code stands for.
    expect(dash.ok === false && dash.errors[0]!.message).toBe(
      "binding TP-1: selector must not start with '-'",
    );
    const ctl = validateBindings({
      "TP-1": { status: "new", selector: "a\nb" },
    });
    expect(ctl.ok === false && ctl.errors.map((e) => e.code)).toEqual([
      "forbidden-character",
    ]);
    const empty = validateBindings({
      "TP-1": { status: "new", selector: "  " },
    });
    expect(empty.ok === false && empty.errors.map((e) => e.code)).toEqual([
      "empty-value",
    ]);
    expect(
      validateBindings({ "TP-1": { status: "new", selector: "ok" } }).ok,
    ).toBe(true);
  });
});
