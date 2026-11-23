import { describe, expect, it } from "vitest";
import {
  TRIAGE_CLASSES,
  TRIAGE_FIELD_NAMES,
  TRIAGE_VALUES,
  validateTriage,
  type Triage,
  type TriageClass,
  type TriageFieldName,
  type TriageValue,
} from "../../src/formats/index.js";
import {
  TRIAGE_RULE_TABLE,
  TRIAGE_RULE_VERSION,
  deriveTriageClass,
  profileForClass,
} from "../../src/triage/index.js";

type Values = Partial<Record<TriageFieldName, TriageValue>>;

const CLEAR: Values = {
  single_goal: "yes",
  code_related: "yes",
  core_is_decision: "no",
  scope_within_request: "yes",
  multiple_repos: "no",
  trivial: "no",
};

function triage(fields: Values = {}, blocking: string[] = []): Triage {
  const out = {} as Triage["fields"];
  for (const name of TRIAGE_FIELD_NAMES) {
    out[name] = { value: fields[name] ?? CLEAR[name]!, evidence: "e" };
  }
  return { fields: out, blocking_unknowns: blocking };
}

function docOf(fields: Values, blocking: string[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const name of TRIAGE_FIELD_NAMES) {
    doc[name] = { value: fields[name] ?? CLEAR[name]!, evidence: "e" };
  }
  doc["blocking_unknowns"] = blocking;
  return doc;
}

describe("triage rule table", () => {
  it("is data: six ordered rows, classes in rule order", () => {
    expect(TRIAGE_RULE_VERSION).toBe(1);
    expect(TRIAGE_RULE_TABLE.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(TRIAGE_RULE_TABLE.map((r) => r.cls)).toEqual([...TRIAGE_CLASSES]);
  });

  it("marks only rows 1 to 3 as unknown-precedence rows", () => {
    expect(TRIAGE_RULE_TABLE.map((r) => r.unknownPrecedence)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("profileForClass", () => {
  it("is light for no-spec-needed, full for actionable, null for the rest", () => {
    expect(profileForClass("no-spec-needed")).toBe("light");
    expect(profileForClass("actionable")).toBe("full");
    for (const cls of ["unsuitable", "decision", "split", "clarify"]) {
      expect(profileForClass(cls as (typeof TRIAGE_CLASSES)[number]), cls).toBe(
        null,
      );
    }
  });
});

describe("deriveTriageClass: one fixture per table row", () => {
  it("row 1 unsuitable when code_related is no", () => {
    expect(deriveTriageClass(triage({ code_related: "no" }))).toEqual({
      class: "unsuitable",
      rule_version: 1,
      row: 1,
      unknown_fields: [],
    });
  });

  it("row 1 unsuitable when scope_within_request is no", () => {
    expect(
      deriveTriageClass(triage({ scope_within_request: "no" })),
    ).toMatchObject({ class: "unsuitable", row: 1 });
  });

  it("row 2 decision when core_is_decision is yes", () => {
    expect(
      deriveTriageClass(triage({ core_is_decision: "yes" })),
    ).toMatchObject({ class: "decision", rule_version: 1, row: 2 });
  });

  it("row 3 split when single_goal is no", () => {
    expect(deriveTriageClass(triage({ single_goal: "no" }))).toMatchObject({
      class: "split",
      row: 3,
    });
  });

  it("row 3 split when multiple_repos is yes", () => {
    expect(deriveTriageClass(triage({ multiple_repos: "yes" }))).toMatchObject({
      class: "split",
      row: 3,
    });
  });

  it("row 4 clarify when blocking_unknowns is not empty", () => {
    expect(deriveTriageClass(triage({}, ["which repo"]))).toEqual({
      class: "clarify",
      rule_version: 1,
      row: 4,
      unknown_fields: [],
    });
  });

  it("row 5 no-spec-needed when trivial is yes", () => {
    expect(deriveTriageClass(triage({ trivial: "yes" }))).toEqual({
      class: "no-spec-needed",
      rule_version: 1,
      row: 5,
      unknown_fields: [],
    });
  });

  it("row 6 actionable otherwise", () => {
    expect(deriveTriageClass(triage())).toEqual({
      class: "actionable",
      rule_version: 1,
      row: 6,
      unknown_fields: [],
    });
  });
});

describe("deriveTriageClass: unknown precedence in rows 1 to 3", () => {
  const cases: { field: TriageFieldName; row: number }[] = [
    { field: "code_related", row: 1 },
    { field: "scope_within_request", row: 1 },
    { field: "core_is_decision", row: 2 },
    { field: "single_goal", row: 3 },
    { field: "multiple_repos", row: 3 },
  ];

  it.each(cases)(
    "an unknown $field alone forces clarify at row $row",
    ({ field, row }) => {
      expect(deriveTriageClass(triage({ [field]: "unknown" }))).toEqual({
        class: "clarify",
        rule_version: 1,
        row,
        unknown_fields: [field],
      });
    },
  );

  it("lists every unknown field of rows 1 to 3 in table order when one row forces clarify", () => {
    expect(
      deriveTriageClass(
        triage({
          code_related: "unknown",
          core_is_decision: "unknown",
          multiple_repos: "unknown",
        }),
      ),
    ).toEqual({
      class: "clarify",
      rule_version: 1,
      row: 1,
      unknown_fields: ["code_related", "core_is_decision", "multiple_repos"],
    });
    expect(
      deriveTriageClass(
        triage({ scope_within_request: "unknown", single_goal: "unknown" }),
      ),
    ).toEqual({
      class: "clarify",
      rule_version: 1,
      row: 1,
      unknown_fields: ["scope_within_request", "single_goal"],
    });
  });

  it("cross-row: core_is_decision unknown with single_goal no is clarify at row 2", () => {
    expect(
      deriveTriageClass(
        triage({ core_is_decision: "unknown", single_goal: "no" }),
      ),
    ).toEqual({
      class: "clarify",
      rule_version: 1,
      row: 2,
      unknown_fields: ["core_is_decision"],
    });
  });

  it("cross-row: code_related unknown with trivial yes is clarify at row 1, never no-spec-needed", () => {
    expect(
      deriveTriageClass(triage({ code_related: "unknown", trivial: "yes" })),
    ).toEqual({
      class: "clarify",
      rule_version: 1,
      row: 1,
      unknown_fields: ["code_related"],
    });
  });

  it("cross-row: core_is_decision unknown with blocking_unknowns is clarify at row 2, not row 4", () => {
    expect(
      deriveTriageClass(triage({ core_is_decision: "unknown" }, ["x"])),
    ).toEqual({
      class: "clarify",
      rule_version: 1,
      row: 2,
      unknown_fields: ["core_is_decision"],
    });
  });

  it("example: code_related no with single_goal unknown is unsuitable", () => {
    expect(
      deriveTriageClass(triage({ code_related: "no", single_goal: "unknown" })),
    ).toEqual({
      class: "unsuitable",
      rule_version: 1,
      row: 1,
      unknown_fields: [],
    });
  });

  it("example: code_related unknown with all else clear is clarify", () => {
    expect(deriveTriageClass(triage({ code_related: "unknown" }))).toEqual({
      class: "clarify",
      rule_version: 1,
      row: 1,
      unknown_fields: ["code_related"],
    });
  });

  it("a row's own known condition fires even when another of its fields is unknown", () => {
    expect(
      deriveTriageClass(
        triage({ single_goal: "unknown", multiple_repos: "yes" }),
      ),
    ).toMatchObject({ class: "split", row: 3 });
  });
});

describe("deriveTriageClass: trivial unknown", () => {
  it("counts as not trivial, so nothing else applies gives actionable", () => {
    expect(deriveTriageClass(triage({ trivial: "unknown" }))).toEqual({
      class: "actionable",
      rule_version: 1,
      row: 6,
      unknown_fields: [],
    });
  });

  it("an unknown trivial does not force clarify", () => {
    expect(
      profileForClass(deriveTriageClass(triage({ trivial: "unknown" })).class),
    ).toBe("full");
  });
});

describe("deriveTriageClass: exhaustive over all inputs", () => {
  const bundleOrder: TriageFieldName[] = [
    "code_related",
    "scope_within_request",
    "core_is_decision",
    "single_goal",
    "multiple_repos",
  ];

  // The expected derivation, restated from the documented rule independently
  // of `deriveTriageClass`: walk rows 1 to 3; the first row whose condition
  // is true on known values decides; otherwise the first row that has an
  // unknown field forces `clarify` and reports every unknown field of those
  // rows; after row 3 a non-empty blocking list gives `clarify` at row 4,
  // `trivial` yes gives `no-spec-needed` at row 5, otherwise row 6.
  function expectedDerivation(
    values: Record<TriageFieldName, TriageValue>,
    blocking: string[],
  ): { class: TriageClass; row: number; unknown_fields: TriageFieldName[] } {
    const bundled = bundleOrder.filter((name) => values[name] === "unknown");
    if (values.code_related === "no" || values.scope_within_request === "no") {
      return { class: "unsuitable", row: 1, unknown_fields: [] };
    }
    if (
      values.code_related === "unknown" ||
      values.scope_within_request === "unknown"
    ) {
      return { class: "clarify", row: 1, unknown_fields: bundled };
    }
    if (values.core_is_decision === "yes") {
      return { class: "decision", row: 2, unknown_fields: [] };
    }
    if (values.core_is_decision === "unknown") {
      return { class: "clarify", row: 2, unknown_fields: bundled };
    }
    if (values.single_goal === "no" || values.multiple_repos === "yes") {
      return { class: "split", row: 3, unknown_fields: [] };
    }
    if (
      values.single_goal === "unknown" ||
      values.multiple_repos === "unknown"
    ) {
      return { class: "clarify", row: 3, unknown_fields: bundled };
    }
    if (blocking.length > 0) {
      return { class: "clarify", row: 4, unknown_fields: [] };
    }
    if (values.trivial === "yes") {
      return { class: "no-spec-needed", row: 5, unknown_fields: [] };
    }
    return { class: "actionable", row: 6, unknown_fields: [] };
  }

  it("matches the independent oracle on class, row and unknown_fields over 3^6 field values times blocking empty/non-empty", () => {
    let checked = 0;
    for (let code = 0; code < 729; code++) {
      const values = {} as Record<TriageFieldName, TriageValue>;
      let rest = code;
      for (const name of TRIAGE_FIELD_NAMES) {
        values[name] = TRIAGE_VALUES[rest % 3];
        rest = Math.floor(rest / 3);
      }
      for (const blocking of [[], ["x"]]) {
        const d = deriveTriageClass(triage(values, blocking));
        const want = expectedDerivation(values, blocking);
        checked++;

        expect(
          { class: d.class, row: d.row, unknown_fields: d.unknown_fields },
          `${JSON.stringify(values)} blocking=${blocking.length}`,
        ).toEqual(want);
        expect(d.rule_version).toBe(1);

        // the derived class is always a legal class the format accepts
        const doc = docOf(values, blocking);
        doc["class"] = d.class;
        doc["rule_version"] = d.rule_version;
        expect(validateTriage(doc).ok, JSON.stringify(doc)).toBe(true);

        // same input gives same output
        expect(deriveTriageClass(triage(values, blocking))).toEqual(d);
      }
    }
    expect(checked).toBe(1458);
  });
});
