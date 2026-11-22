import { describe, expect, it } from "vitest";
import {
  TEST_PLAN_KINDS,
  allowedFieldsOf,
  layerOf,
  parseTestPlan,
  requiredFieldsOf,
  validateTestPlan,
} from "../../src/formats/index.js";
import type { TestPlanKind } from "../../src/formats/index.js";

/** A valid row of each kind, as a plain object. */
const VALID: Record<TestPlanKind, Record<string, unknown>> = {
  "red-first": {
    id: "TP-1",
    covers: ["AC-1"],
    kind: "red-first",
    claim: "c",
    red_reason: "r",
    expected: "e",
    oracle: "o",
  },
  "stays-green": {
    id: "TP-1",
    covers: ["AC-1"],
    kind: "stays-green",
    claim: "c",
    probe_hint: "h",
  },
  measurement: {
    id: "TP-1",
    covers: ["NG-1"],
    kind: "measurement",
    claim: "c",
    baseline: 1,
    threshold: "<= 2",
    runs: 3,
  },
  static: {
    id: "TP-1",
    covers: ["NG-1"],
    kind: "static",
    claim: "c",
    check_command_ref: "typecheck",
  },
  manual: {
    id: "TP-1",
    covers: ["AC-1"],
    kind: "manual",
    claim: "c",
    verifier: "v",
    evidence_location: "l",
  },
  runtime: {
    id: "TP-1",
    covers: ["AC-1"],
    kind: "runtime",
    claim: "c",
    environment: "staging",
    steps: ["a"],
    expected: "e",
    evidence_location: "l",
  },
  "post-deploy": {
    id: "TP-1",
    covers: ["AC-1"],
    kind: "post-deploy",
    claim: "c",
    check: "k",
    environment: "production",
  },
};

function codes(row: Record<string, unknown>): string[] {
  const r = validateTestPlan([row]);
  return r.ok ? [] : r.errors.map((e) => `${e.code} @ ${e.path}`);
}

describe("testplan.yaml: kinds and required fields", () => {
  it("accepts a valid row of every kind", () => {
    for (const kind of TEST_PLAN_KINDS) {
      expect(codes(VALID[kind]!), kind).toEqual([]);
    }
  });

  it("rejects each missing required field of each kind, naming kind, row and field", () => {
    for (const kind of TEST_PLAN_KINDS) {
      for (const field of requiredFieldsOf(kind)) {
        if (field === "id" || field === "kind") continue;
        const row = { ...VALID[kind]! };
        delete row[field];
        const r = validateTestPlan([row]);
        expect(r.ok, `${kind} without ${field}`).toBe(false);
        if (r.ok) continue;
        expect(r.errors).toHaveLength(1);
        const e = r.errors[0]!;
        expect(e.code).toBe("missing-field");
        expect(e.path).toBe(`TP-1.${field}`);
        expect(e.message).toContain(kind);
        expect(e.message).toContain("TP-1");
        expect(e.message).toContain(field);
      }
    }
  });

  it("rejects each field of another kind", () => {
    for (const kind of TEST_PLAN_KINDS) {
      const foreign = Object.keys({
        ...Object.fromEntries(
          TEST_PLAN_KINDS.filter((k) => k !== kind).flatMap((k) =>
            allowedFieldsOf(k).map((f) => [f, true]),
          ),
        ),
      }).filter(
        (f) => !allowedFieldsOf(kind).includes(f) && layerOf(f) !== "binding",
      );
      for (const field of foreign) {
        const r = validateTestPlan([{ ...VALID[kind]!, [field]: "x" }]);
        expect(r.ok, `${kind} with ${field}`).toBe(false);
        if (r.ok) continue;
        expect(r.errors.map((e) => e.code)).toContain(
          "field-not-allowed-for-kind",
        );
        expect(r.errors[0]!.path).toBe(`TP-1.${field}`);
      }
    }
  });

  it("accepts the optional fields of a kind", () => {
    expect(
      codes({
        ...VALID["red-first"]!,
        fail_match: "m",
        level: "unit",
        seam: "s",
        input: "i",
        notes: "n",
      }),
    ).toEqual([]);
    expect(
      codes({ ...VALID.runtime!, control: "base", method: "script" }),
    ).toEqual([]);
    expect(codes({ ...VALID.runtime!, control: "none" })).toEqual([]);
  });

  it("names a field without a layer and its row", () => {
    const r = validateTestPlan([{ ...VALID["red-first"]!, priority: "high" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({
      code: "unknown-field",
      path: "TP-1.priority",
    });
    expect(r.errors[0]!.message).toContain("priority");
    expect(r.errors[0]!.message).toContain("TP-1");
    expect(r.errors[0]!.message).toContain("no layer");
  });

  it("rejects an unknown field even when the row's kind is invalid", () => {
    const r = validateTestPlan([
      { ...VALID["red-first"]!, kind: "nope", priority: 1 },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => `${e.code} @ ${e.path}`).sort()).toEqual([
      "invalid-value @ TP-1.kind",
      "unknown-field @ TP-1.priority",
    ]);
  });

  it("rejects an inherited-looking field name as an unknown field", () => {
    const row = JSON.parse('{"__proto__": 1, "constructor": 2}') as Record<
      string,
      unknown
    >;
    const r = validateTestPlan([{ ...VALID["red-first"]!, ...row }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => `${e.code} @ ${e.path}`).sort()).toEqual([
      "unknown-field @ TP-1.__proto__",
      "unknown-field @ TP-1.constructor",
    ]);
  });

  it("returns the typed rows", () => {
    const r = validateTestPlan([
      { ...VALID.runtime!, control: "negative", method: "browser" },
      { ...VALID.measurement!, id: "TP-2" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toMatchObject({
      id: "TP-1",
      kind: "runtime",
      steps: ["a"],
      control: "negative",
      method: "browser",
    });
    expect(r.value[1]).toMatchObject({
      id: "TP-2",
      baseline: 1,
      threshold: "<= 2",
      runs: 3,
    });
  });

  it("accepts measurement baseline and threshold as a string or a number, not as anything else", () => {
    for (const v of [0, 1.5, "120ms"]) {
      expect(
        codes({ ...VALID.measurement!, baseline: v, threshold: v }),
      ).toEqual([]);
    }
    for (const v of [true, null, [1], {}]) {
      expect(codes({ ...VALID.measurement!, baseline: v })).toEqual([
        "wrong-type @ TP-1.baseline",
      ]);
    }
    for (const v of [Infinity, -Infinity, NaN]) {
      expect(codes({ ...VALID.measurement!, baseline: v })).toEqual([
        "invalid-value @ TP-1.baseline",
      ]);
    }
    expect(codes({ ...VALID.measurement!, threshold: "" })).toEqual([
      "empty-value @ TP-1.threshold",
    ]);
  });

  it("requires runs to be a positive integer", () => {
    for (const v of [1, 2, 100]) {
      expect(codes({ ...VALID.measurement!, runs: v })).toEqual([]);
    }
    expect(codes({ ...VALID.measurement!, runs: 0 })).toEqual([
      "invalid-value @ TP-1.runs",
    ]);
    expect(codes({ ...VALID.measurement!, runs: -1 })).toEqual([
      "invalid-value @ TP-1.runs",
    ]);
    expect(codes({ ...VALID.measurement!, runs: "3" })).toEqual([
      "wrong-type @ TP-1.runs",
    ]);
  });

  it("requires a command reference to look like a command name", () => {
    for (const ok of ["typecheck", "unit-1", "a.b_c"]) {
      expect(codes({ ...VALID.static!, check_command_ref: ok })).toEqual([]);
    }
    for (const bad of ["Type Check", "-x", "a b", "A", ""]) {
      expect(
        codes({ ...VALID.static!, check_command_ref: bad }).length,
        bad,
      ).toBe(1);
    }
  });
});

describe("testplan.yaml: covers", () => {
  const cover = (covers: unknown) => codes({ ...VALID["red-first"]!, covers });

  it("accepts AC, DF and NG IDs in any mix", () => {
    expect(cover(["AC-1"])).toEqual([]);
    expect(cover(["AC-1", "DF-2", "NG-3"])).toEqual([]);
    expect(cover(["NG-1"])).toEqual([]);
  });

  it("rejects an empty list", () => {
    expect(cover([])).toEqual(["covers-empty @ TP-1.covers"]);
  });

  it("rejects a non-list", () => {
    expect(cover("AC-1")).toEqual(["wrong-type @ TP-1.covers"]);
    expect(cover(null)).toEqual(["wrong-type @ TP-1.covers"]);
  });

  it("rejects every other prefix and non-IDs, naming the entry", () => {
    for (const bad of [
      "GOAL",
      "DC-1",
      "RS-1",
      "SL-1",
      "TP-1",
      "QN-1",
      "AC-0",
      "spec#AC-1",
      1,
      null,
    ]) {
      expect(cover(["AC-1", bad]), String(bad)).toEqual([
        "covers-invalid-id @ TP-1.covers[1]",
      ]);
    }
  });

  it("rejects a duplicate entry", () => {
    expect(cover(["AC-1", "AC-1"])).toEqual([
      "duplicate-value @ TP-1.covers[1]",
    ]);
  });
});

describe("testplan.yaml: ids and shape", () => {
  it("requires TP-<n> ids and rejects duplicates", () => {
    expect(codes({ ...VALID.manual!, id: "TP-12" })).toEqual([]);
    for (const bad of ["TP-0", "TP-01", "tp-1", "AC-1", 5]) {
      expect(codes({ ...VALID.manual!, id: bad }).length, String(bad)).toBe(1);
    }
    const r = validateTestPlan([VALID.manual!, VALID.manual!]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(["duplicate-id"]);
  });

  it("names rows without an id by position", () => {
    const row = { ...VALID.manual! };
    delete row["id"];
    const r = validateTestPlan([VALID.manual, row]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.path).toBe("[1].id");
  });

  it("accepts an empty plan and rejects a non-list", () => {
    expect(validateTestPlan([])).toEqual({ ok: true, value: [] });
    expect(validateTestPlan({}).ok).toBe(false);
    expect(validateTestPlan(null).ok).toBe(false);
    expect(validateTestPlan("x").ok).toBe(false);
  });

  it("reports every bad row, not only the first", () => {
    const r = validateTestPlan([
      { ...VALID.manual!, id: "TP-1", verifier: undefined },
      { ...VALID.manual!, id: "TP-2", claim: "" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.path).sort()).toEqual([
      "TP-1.verifier",
      "TP-2.claim",
    ]);
  });

  it("parses text and rejects non-plain YAML", () => {
    expect(parseTestPlan("[]").ok).toBe(true);
    expect(parseTestPlan("").ok).toBe(false);
  });
});
