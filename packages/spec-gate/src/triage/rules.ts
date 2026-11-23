/**
 * Triage class derivation.
 *
 * The discoverer writes six yes/no/unknown fields and a list of blocking
 * unknowns. `triage` derives one class from them with a versioned truth
 * table whose first matching row wins. The table lives here as data; the
 * rule itself is documented in `docs/triage.md`.
 *
 * Unknown precedence: rows 1 to 3 are read in order. A row fires when its
 * condition is true with the known values. A row that does not fire but
 * would fire for some value of a field it reads (that field is `unknown`)
 * forces `clarify`: an unknown in rows 1 to 3 never leads to `actionable`
 * and never lets a later row decide. `trivial` = `unknown` counts as not
 * trivial, so row 5 does not fire on it.
 */
import type {
  Triage,
  TriageClass,
  TriageFieldName,
  TriageValue,
} from "../formats/index.js";

/** The version of the truth table below; bumped whenever the table changes. */
export const TRIAGE_RULE_VERSION = 1;

/** One disjunct of a row's field condition: this field equals this value. */
export interface TriageFieldTest {
  field: TriageFieldName;
  is: TriageValue;
}

/** The condition of a rule row, as data. */
export type TriageCondition =
  /** Fires when any test holds for a known field value. */
  | { type: "field"; anyOf: readonly TriageFieldTest[] }
  /** Fires when `blocking_unknowns` is not empty. */
  | { type: "blocking-unknowns" }
  /** The final row: fires when nothing else did. */
  | { type: "otherwise" };

/** One row of the truth table. */
export interface TriageRuleRow {
  /** 1-based order; the first row that fires decides. */
  order: number;
  /** The class the row yields. */
  cls: TriageClass;
  condition: TriageCondition;
  /** True for rows 1 to 3, whose unknown fields force `clarify`. */
  unknownPrecedence: boolean;
}

/** The truth table, first matching row wins. */
export const TRIAGE_RULE_TABLE: readonly TriageRuleRow[] = [
  {
    order: 1,
    cls: "unsuitable",
    condition: {
      type: "field",
      anyOf: [
        { field: "code_related", is: "no" },
        { field: "scope_within_request", is: "no" },
      ],
    },
    unknownPrecedence: true,
  },
  {
    order: 2,
    cls: "decision",
    condition: {
      type: "field",
      anyOf: [{ field: "core_is_decision", is: "yes" }],
    },
    unknownPrecedence: true,
  },
  {
    order: 3,
    cls: "split",
    condition: {
      type: "field",
      anyOf: [
        { field: "single_goal", is: "no" },
        { field: "multiple_repos", is: "yes" },
      ],
    },
    unknownPrecedence: true,
  },
  {
    order: 4,
    cls: "clarify",
    condition: { type: "blocking-unknowns" },
    unknownPrecedence: false,
  },
  {
    order: 5,
    cls: "no-spec-needed",
    condition: {
      type: "field",
      anyOf: [{ field: "trivial", is: "yes" }],
    },
    unknownPrecedence: false,
  },
  {
    order: 6,
    cls: "actionable",
    condition: { type: "otherwise" },
    unknownPrecedence: false,
  },
];

/** The class, the row that decided it, and the unknowns that forced clarify. */
export interface TriageDerivation {
  class: TriageClass;
  rule_version: number;
  /** The order number of the row that decided. */
  row: number;
  /** The unknown fields that forced `clarify`; empty otherwise. */
  unknown_fields: TriageFieldName[];
}

/** The spec profile each class leads to, or `null` when it ends with no spec. */
export type TriageProfile = "light" | "full";

function rowFires(row: TriageRuleRow, triage: Triage): boolean {
  const { condition } = row;
  switch (condition.type) {
    case "field":
      return condition.anyOf.some(
        (test) => triage.fields[test.field].value === test.is,
      );
    case "blocking-unknowns":
      return triage.blocking_unknowns.length > 0;
    case "otherwise":
      return true;
  }
}

function unknownFieldsForcingClarify(
  row: TriageRuleRow,
  triage: Triage,
): TriageFieldName[] {
  if (!row.unknownPrecedence || row.condition.type !== "field") return [];
  return row.condition.anyOf
    .filter((test) => triage.fields[test.field].value === "unknown")
    .map((test) => test.field);
}

/**
 * Derives the class from a validated `Triage`. Pure: it reads the fields and
 * `blocking_unknowns` and writes nothing.
 */
export function deriveTriageClass(triage: Triage): TriageDerivation {
  for (const row of TRIAGE_RULE_TABLE) {
    if (rowFires(row, triage)) {
      return {
        class: row.cls,
        rule_version: TRIAGE_RULE_VERSION,
        row: row.order,
        unknown_fields: [],
      };
    }
    const unknownFields = unknownFieldsForcingClarify(row, triage);
    if (unknownFields.length > 0) {
      return {
        class: "clarify",
        rule_version: TRIAGE_RULE_VERSION,
        row: row.order,
        unknown_fields: unknownFields,
      };
    }
  }
  // Unreachable while the table ends with the otherwise row.
  throw new Error("triage rule table has no row that fires");
}

/**
 * The spec profile a class leads to: `light` for `no-spec-needed`, `full`
 * for `actionable`, `null` for every class that ends with no spec
 * (`unsuitable`, `decision`, `split`, `clarify`).
 */
export function profileForClass(cls: TriageClass): TriageProfile | null {
  if (cls === "no-spec-needed") return "light";
  if (cls === "actionable") return "full";
  return null;
}
