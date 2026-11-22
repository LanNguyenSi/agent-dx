import { describe, expect, it } from "vitest";
import {
  TRIAGE_CLASSES,
  TRIAGE_FIELD_NAMES,
  TRIAGE_VALUES,
  parseTriage,
  validateTriage,
} from "../../src/formats/index.js";

function triage(over: Record<string, unknown> = {}): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  for (const f of TRIAGE_FIELD_NAMES) d[f] = { value: "yes", evidence: "e" };
  d["blocking_unknowns"] = [];
  d["class"] = "actionable";
  d["rule_version"] = 1;
  return { ...d, ...over };
}

function without(...keys: string[]): Record<string, unknown> {
  const d = triage();
  for (const k of keys) delete d[k];
  return d;
}

describe("triage.json", () => {
  it("names the six fields, three values and six classes", () => {
    expect([...TRIAGE_FIELD_NAMES]).toEqual([
      "single_goal",
      "code_related",
      "core_is_decision",
      "scope_within_request",
      "multiple_repos",
      "trivial",
    ]);
    expect([...TRIAGE_VALUES]).toEqual(["yes", "no", "unknown"]);
    expect([...TRIAGE_CLASSES]).toEqual([
      "unsuitable",
      "decision",
      "split",
      "clarify",
      "no-spec-needed",
      "actionable",
    ]);
  });

  it("accepts every class and every value", () => {
    for (const cls of TRIAGE_CLASSES) {
      expect(validateTriage(triage({ class: cls })).ok, cls).toBe(true);
    }
    for (const value of TRIAGE_VALUES) {
      expect(
        validateTriage(triage({ trivial: { value, evidence: "e" } })).ok,
        value,
      ).toBe(true);
    }
  });

  it("returns the fields grouped, with class and rule version", () => {
    const r = validateTriage(triage({ blocking_unknowns: ["which repo"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fields.single_goal).toEqual({ value: "yes", evidence: "e" });
    expect(r.value.blocking_unknowns).toEqual(["which repo"]);
    expect(r.value.class).toBe("actionable");
    expect(r.value.rule_version).toBe(1);
  });

  it("accepts a file the discoverer wrote, before the class is derived", () => {
    const r = validateTriage(without("class", "rule_version"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.class).toBeUndefined();
    expect(r.value.rule_version).toBeUndefined();
  });

  it("writes class and rule_version together: each alone is an error naming the other", () => {
    const a = validateTriage(without("rule_version"));
    expect(a.ok).toBe(false);
    if (!a.ok)
      expect(a.errors).toEqual([
        expect.objectContaining({
          code: "missing-field",
          path: "rule_version",
        }),
      ]);
    const b = validateTriage(without("class"));
    expect(b.ok).toBe(false);
    if (!b.ok)
      expect(b.errors).toEqual([
        expect.objectContaining({ code: "missing-field", path: "class" }),
      ]);
  });

  it("parses text with strict JSON", () => {
    expect(parseTriage(JSON.stringify(triage())).ok).toBe(true);
    expect(parseTriage("{").ok).toBe(false);
    expect(parseTriage("// c\n{}").ok).toBe(false);
  });

  it("rejects duplicate keys that JSON.parse would drop", () => {
    const r = parseTriage('{"a": 1, "a": 2}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("duplicate-key");
  });

  it("rejects a prototype key as an unknown field", () => {
    const r = parseTriage(
      `{"__proto__": {}, ${JSON.stringify(triage()).slice(1)}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(["unknown-field"]);
  });

  it("requires the evidence of each field to be a non-empty string", () => {
    for (const evidence of ["", "  ", 1, null, ["x"]]) {
      expect(
        validateTriage(triage({ trivial: { value: "no", evidence } })).ok,
        String(evidence),
      ).toBe(false);
    }
  });
});
