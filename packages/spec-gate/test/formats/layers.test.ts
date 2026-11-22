import { describe, expect, it } from "vitest";
import {
  BINDING_FIELDS,
  COMMON_OPTIONAL_FIELDS,
  COMMON_REQUIRED_FIELDS,
  FIELD_LAYERS,
  KIND_SPECS,
  TEST_PLAN_KINDS,
  allKnownFields,
  allowedFieldsOf,
  layerOf,
  requiredFieldsOf,
} from "../../src/formats/index.js";

describe("field-to-layer table", () => {
  it("has the seven kinds", () => {
    expect([...TEST_PLAN_KINDS]).toEqual([
      "red-first",
      "stays-green",
      "measurement",
      "static",
      "manual",
      "runtime",
      "post-deploy",
    ]);
    expect(Object.keys(KIND_SPECS).sort()).toEqual([...TEST_PLAN_KINDS].sort());
  });

  it("lists every field that any kind requires or allows", () => {
    for (const kind of TEST_PLAN_KINDS) {
      for (const field of requiredFieldsOf(kind)) {
        expect(layerOf(field), `${kind} requires ${field}`).toBeDefined();
      }
      for (const field of allowedFieldsOf(kind)) {
        expect(layerOf(field), `${kind} allows ${field}`).toBeDefined();
      }
    }
    for (const field of [
      ...COMMON_REQUIRED_FIELDS,
      ...COMMON_OPTIONAL_FIELDS,
    ]) {
      expect(layerOf(field)).toBeDefined();
    }
    for (const field of BINDING_FIELDS) {
      expect(layerOf(field), `binding field ${field}`).toBeDefined();
    }
  });

  it("lists no field that nothing uses", () => {
    expect(Object.keys(FIELD_LAYERS).sort()).toEqual(allKnownFields().sort());
  });

  it("uses only the three layers", () => {
    for (const layer of Object.values(FIELD_LAYERS)) {
      expect(["normative", "binding", "informative"]).toContain(layer);
    }
  });

  it("puts the binding fields in the binding layer, notes in the informative one, the rest in the normative one", () => {
    for (const f of ["status", "selector", "file", "fixtures"]) {
      expect(layerOf(f)).toBe("binding");
    }
    expect(layerOf("notes")).toBe("informative");
    const others = Object.keys(FIELD_LAYERS).filter(
      (f) => !["status", "selector", "file", "fixtures", "notes"].includes(f),
    );
    for (const f of others) expect(layerOf(f), f).toBe("normative");
  });

  it("puts the runtime fields in the normative layer", () => {
    for (const f of [
      "environment",
      "steps",
      "expected",
      "evidence_location",
      "control",
      "method",
    ]) {
      expect(layerOf(f), f).toBe("normative");
    }
  });

  it("returns no layer for an unknown field, an inherited property or a prototype key", () => {
    expect(layerOf("priority")).toBeUndefined();
    expect(layerOf("constructor")).toBeUndefined();
    expect(layerOf("toString")).toBeUndefined();
    expect(layerOf("__proto__")).toBeUndefined();
  });

  it("is frozen", () => {
    expect(Object.isFrozen(FIELD_LAYERS)).toBe(true);
  });
});

describe("per-kind field rules", () => {
  const required: Record<string, string[]> = {
    "red-first": ["red_reason", "expected", "oracle"],
    "stays-green": ["probe_hint"],
    measurement: ["baseline", "threshold", "runs"],
    static: ["check_command_ref"],
    manual: ["verifier", "evidence_location"],
    runtime: ["environment", "steps", "expected", "evidence_location"],
    "post-deploy": ["check", "environment"],
  };

  it("requires the common fields plus the kind's own", () => {
    for (const kind of TEST_PLAN_KINDS) {
      expect(requiredFieldsOf(kind).sort()).toEqual(
        [...COMMON_REQUIRED_FIELDS, ...required[kind]!]
          .filter((f, i, all) => all.indexOf(f) === i)
          .sort(),
      );
    }
  });

  it("allows control and method on runtime rows only", () => {
    for (const kind of TEST_PLAN_KINDS) {
      const allowed = allowedFieldsOf(kind);
      expect(allowed.includes("control")).toBe(kind === "runtime");
      expect(allowed.includes("method")).toBe(kind === "runtime");
    }
  });

  it("ties stays-green to existing bindings and red-first to new ones", () => {
    expect(KIND_SPECS["stays-green"].bindingStatusAtProposed).toBe("existing");
    expect(KIND_SPECS["red-first"].bindingStatusAtProposed).toBe("new");
    expect(KIND_SPECS.manual.bindingStatusAtProposed).toBe("none");
  });

  it("marks post-deploy as not yet validated", () => {
    expect(KIND_SPECS["post-deploy"].note).toMatch(/not yet validated/i);
  });
});
