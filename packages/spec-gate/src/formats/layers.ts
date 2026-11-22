/**
 * Test-plan kinds and the field-to-layer table.
 *
 * Every field of a test-plan row or a binding row belongs to exactly one
 * layer:
 * - `normative`: part of what the approver signs off; changes with the
 *   digest.
 * - `binding`: ties a plan row to a concrete test; lives in
 *   `bindings.yaml` and may change after the spec is proposed.
 * - `informative`: free notes, never read by a check.
 *
 * A field without an entry here is rejected by the parsers.
 */
import { markdownCell } from "./markdown.js";

export const TEST_PLAN_KINDS = [
  "red-first",
  "stays-green",
  "measurement",
  "static",
  "manual",
  "runtime",
  "post-deploy",
] as const;

export type TestPlanKind = (typeof TEST_PLAN_KINDS)[number];

export type Layer = "normative" | "binding" | "informative";

export const FIELD_LAYERS: Readonly<Record<string, Layer>> = Object.freeze({
  // all test-plan rows
  id: "normative",
  covers: "normative",
  kind: "normative",
  claim: "normative",
  input: "normative",
  expected: "normative",
  oracle: "normative",
  level: "normative",
  seam: "normative",
  // red-first
  red_reason: "normative",
  fail_match: "normative",
  // measurement
  baseline: "normative",
  threshold: "normative",
  runs: "normative",
  // static
  check_command_ref: "normative",
  // manual
  verifier: "normative",
  // manual and runtime
  evidence_location: "normative",
  // post-deploy
  check: "normative",
  // post-deploy and runtime
  environment: "normative",
  // runtime
  steps: "normative",
  control: "normative",
  method: "normative",
  // stays-green
  probe_hint: "normative",
  // bindings.yaml
  status: "binding",
  selector: "binding",
  file: "binding",
  fixtures: "binding",
  // either file
  notes: "informative",
});

export function layerOf(field: string): Layer | undefined {
  return Object.prototype.hasOwnProperty.call(FIELD_LAYERS, field)
    ? FIELD_LAYERS[field]
    : undefined;
}

/** Fields every test-plan row carries, whatever its kind. */
export const COMMON_REQUIRED_FIELDS = [
  "id",
  "covers",
  "kind",
  "claim",
] as const;

/** Fields any test-plan row may carry, whatever its kind. */
export const COMMON_OPTIONAL_FIELDS = [
  "input",
  "expected",
  "oracle",
  "level",
  "seam",
  "notes",
] as const;

export const RUNTIME_CONTROLS = ["base", "negative", "none"] as const;
export const RUNTIME_METHODS = ["browser", "script"] as const;

/** What a binding must look like when the spec becomes `proposed`. */
export type BindingStatusAtProposed = "new" | "existing" | "any" | "none";

export interface KindSpec {
  /** Required in addition to `COMMON_REQUIRED_FIELDS`. */
  required: readonly string[];
  /** Allowed in addition to the common fields and `required`. */
  optional: readonly string[];
  bindingStatusAtProposed: BindingStatusAtProposed;
  /** The evidence a later check expects for this kind. */
  laterEvidence: string;
  /** Short note on the kind's standing. */
  note?: string;
}

export const KIND_SPECS: Readonly<Record<TestPlanKind, KindSpec>> = {
  "red-first": {
    required: ["red_reason", "expected", "oracle"],
    optional: ["fail_match"],
    bindingStatusAtProposed: "new",
    laterEvidence: "per slice red for the stated reason, then green",
  },
  "stays-green": {
    required: ["probe_hint"],
    optional: [],
    bindingStatusAtProposed: "existing",
    laterEvidence: "green at the start commit and afterwards, plus a probe",
  },
  measurement: {
    required: ["baseline", "threshold", "runs"],
    optional: [],
    bindingStatusAtProposed: "any",
    laterEvidence: "measured values before and after",
  },
  static: {
    required: ["check_command_ref"],
    optional: [],
    bindingStatusAtProposed: "any",
    laterEvidence: "exit code 0 of the referenced command",
  },
  manual: {
    required: ["verifier", "evidence_location"],
    optional: [],
    bindingStatusAtProposed: "none",
    laterEvidence: "evidence at the stated location",
  },
  runtime: {
    required: ["environment", "steps", "expected", "evidence_location"],
    optional: ["control", "method"],
    bindingStatusAtProposed: "any",
    laterEvidence:
      "evidence of the steps run in the stated environment, at the stated location",
  },
  "post-deploy": {
    required: ["check", "environment"],
    optional: [],
    bindingStatusAtProposed: "any",
    laterEvidence:
      "evidence after deploy; the row is reported as pending until then",
    note: "Not yet validated by real usage; the field set may change.",
  },
};

/** Required fields of a kind, common fields included. */
export function requiredFieldsOf(kind: TestPlanKind): string[] {
  return dedupe([...COMMON_REQUIRED_FIELDS, ...KIND_SPECS[kind].required]);
}

/** Every field a row of this kind may carry. */
export function allowedFieldsOf(kind: TestPlanKind): string[] {
  const spec = KIND_SPECS[kind];
  return dedupe([
    ...COMMON_REQUIRED_FIELDS,
    ...COMMON_OPTIONAL_FIELDS,
    ...spec.required,
    ...spec.optional,
  ]);
}

/** Fields a row in `bindings.yaml` may carry (the TP ID is its key). */
export const BINDING_FIELDS = [
  "status",
  "selector",
  "file",
  "fixtures",
  "notes",
] as const;

export const BINDING_STATUSES = ["new", "existing"] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Every field name the test-plan and binding parsers can accept. */
export function allKnownFields(): string[] {
  const out: string[] = [...BINDING_FIELDS];
  for (const kind of TEST_PLAN_KINDS) out.push(...allowedFieldsOf(kind));
  return dedupe(out);
}

/** Markdown table of the field-to-layer table, as embedded in `docs/formats.md`. */
export function renderFieldLayerTable(): string {
  const rows = ["| Field | Layer | Used by |", "|---|---|---|"];
  for (const [field, layer] of Object.entries(FIELD_LAYERS)) {
    const usedBy: string[] = [];
    if ((BINDING_FIELDS as readonly string[]).includes(field)) {
      usedBy.push("bindings.yaml");
    }
    const kinds = TEST_PLAN_KINDS.filter((k) =>
      allowedFieldsOf(k).includes(field),
    );
    if (kinds.length === TEST_PLAN_KINDS.length) {
      usedBy.push("testplan.yaml (every kind)");
    } else if (kinds.length > 0) {
      usedBy.push(`testplan.yaml (${kinds.join(", ")})`);
    }
    rows.push(
      `| \`${field}\` | ${layer} | ${markdownCell(usedBy.join("; "))} |`,
    );
  }
  return rows.join("\n");
}

/** Markdown table of the per-kind rules, as embedded in `docs/formats.md`. */
export function renderKindTable(): string {
  const rows = [
    "| Kind | Required (besides id, covers, kind, claim) | Optional (besides input, expected, oracle, level, seam, notes) | Binding status at `proposed` | Later evidence |",
    "|---|---|---|---|---|",
  ];
  const list = (fields: readonly string[]) =>
    fields.length === 0 ? "none" : fields.map((f) => `\`${f}\``).join(", ");
  for (const kind of TEST_PLAN_KINDS) {
    const spec = KIND_SPECS[kind];
    rows.push(
      `| \`${kind}\` | ${list(spec.required)} | ${list(spec.optional)} | ${spec.bindingStatusAtProposed} | ${markdownCell(spec.laterEvidence)} |`,
    );
  }
  return rows.join("\n");
}
