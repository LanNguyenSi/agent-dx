/**
 * `testplan.yaml`: the normative list of checks that prove the spec.
 *
 * The file is a YAML sequence of rows. Each row has the fields every kind
 * shares plus the fields of its `kind`; see `layers.ts` for the tables.
 *
 * The parser rejects:
 * - a field that has no layer (`unknown-field`),
 * - a field that belongs to another layer's file (`wrong-layer-field`,
 *   for example `selector`, which lives in `bindings.yaml`),
 * - a known field the row's kind does not use
 *   (`field-not-allowed-for-kind`),
 * - a missing required field of the kind (`missing-field`, naming kind,
 *   row and field),
 * - `covers` that is empty or names anything but AC, DF or NG IDs,
 * - duplicate row IDs.
 */
import type { ParseResult } from "./errors.js";
import { ErrorSink, failResult } from "./errors.js";
import { parseYamlText } from "./input.js";
import { isCoverableId } from "./ids.js";
import {
  RUNTIME_CONTROLS,
  RUNTIME_METHODS,
  TEST_PLAN_KINDS,
  allowedFieldsOf,
  layerOf,
  requiredFieldsOf,
} from "./layers.js";
import type { TestPlanKind } from "./layers.js";
import type { Rec } from "./validate.js";
import {
  describeType,
  enumValue,
  hasOwn,
  intValue,
  isRecord,
  nonEmptyString,
  stringList,
} from "./validate.js";

export interface TestPlanRow {
  id: string;
  covers: string[];
  kind: TestPlanKind;
  claim: string;
  input?: string;
  expected?: string;
  oracle?: string;
  level?: string;
  seam?: string;
  red_reason?: string;
  fail_match?: string;
  baseline?: string | number;
  threshold?: string | number;
  runs?: number;
  check_command_ref?: string;
  verifier?: string;
  evidence_location?: string;
  check?: string;
  environment?: string;
  steps?: string[];
  control?: (typeof RUNTIME_CONTROLS)[number];
  method?: (typeof RUNTIME_METHODS)[number];
  probe_hint?: string;
  notes?: string;
}

export type TestPlan = TestPlanRow[];

const COMMAND_REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** How each string-valued field is read. Fields not listed are handled explicitly. */
const STRING_FIELDS = [
  "claim",
  "input",
  "expected",
  "oracle",
  "level",
  "seam",
  "red_reason",
  "fail_match",
  "verifier",
  "evidence_location",
  "check",
  "environment",
  "probe_hint",
  "notes",
] as const;

function numberOrString(
  sink: ErrorSink,
  value: unknown,
  path: string,
  what: string,
): string | number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      sink.add("invalid-value", path, `${what} must be a finite number`);
      return undefined;
    }
    return value;
  }
  if (typeof value === "string") {
    return nonEmptyString(sink, value, path, what);
  }
  sink.add(
    "wrong-type",
    path,
    `${what} must be a string or a number, got ${describeType(value)}`,
  );
  return undefined;
}

function parseCovers(
  sink: ErrorSink,
  value: unknown,
  rowPath: string,
): string[] | undefined {
  const path = `${rowPath}.covers`;
  if (!Array.isArray(value)) {
    sink.add(
      "wrong-type",
      path,
      `covers must be a list, got ${describeType(value)}`,
    );
    return undefined;
  }
  if (value.length === 0) {
    sink.add(
      "covers-empty",
      path,
      "covers must name at least one AC, DF or NG ID",
    );
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let good = true;
  value.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    if (typeof item !== "string" || !isCoverableId(item)) {
      sink.add(
        "covers-invalid-id",
        itemPath,
        `covers may only name AC, DF or NG IDs, got ${JSON.stringify(item)}`,
      );
      good = false;
      return;
    }
    if (seen.has(item)) {
      sink.add("duplicate-value", itemPath, `covers lists ${item} twice`);
      good = false;
      return;
    }
    seen.add(item);
    out.push(item);
  });
  return good ? out : undefined;
}

/** Validates one row. `index` is only used when the row has no usable ID. */
function parseRow(
  sink: ErrorSink,
  raw: unknown,
  index: number,
  seenIds: Set<string>,
): TestPlanRow | undefined {
  const before = sink.errors.length;
  if (!isRecord(raw)) {
    sink.add(
      "wrong-type",
      `[${index}]`,
      `row ${index} must be a mapping, got ${describeType(raw)}`,
    );
    return undefined;
  }
  const rec: Rec = raw;
  const rawId = rec["id"];
  const rowPath =
    typeof rawId === "string" && rawId !== "" ? rawId : `[${index}]`;
  const rowName = `row ${rowPath}`;

  // id
  let id: string | undefined;
  if (!hasOwn(rec, "id")) {
    sink.add(
      "missing-field",
      `${rowPath}.id`,
      `${rowName} is missing field id`,
    );
  } else if (typeof rawId !== "string" || !/^TP-[1-9][0-9]{0,8}$/.test(rawId)) {
    sink.add(
      "invalid-id",
      `${rowPath}.id`,
      `${rowName}: id must be a TP-<n> ID, got ${JSON.stringify(rawId)}`,
    );
  } else if (seenIds.has(rawId)) {
    sink.add("duplicate-id", `${rowPath}.id`, `${rowName}: id is used twice`);
  } else {
    seenIds.add(rawId);
    id = rawId;
  }

  // kind
  let kind: TestPlanKind | undefined;
  if (!hasOwn(rec, "kind")) {
    sink.add(
      "missing-field",
      `${rowPath}.kind`,
      `${rowName} is missing field kind`,
    );
  } else {
    kind = enumValue(
      sink,
      rec["kind"],
      TEST_PLAN_KINDS,
      `${rowPath}.kind`,
      `${rowName}: kind`,
    );
  }

  // layer check for every field, then the per-kind rules
  const allowed = kind ? allowedFieldsOf(kind) : undefined;
  for (const field of Object.keys(rec)) {
    const layer = layerOf(field);
    if (layer === undefined) {
      sink.add(
        "unknown-field",
        `${rowPath}.${field}`,
        `${rowName}: field ${JSON.stringify(field)} has no layer`,
      );
    } else if (layer === "binding") {
      sink.add(
        "wrong-layer-field",
        `${rowPath}.${field}`,
        `${rowName}: field ${JSON.stringify(field)} is a binding field and belongs in bindings.yaml`,
      );
    } else if (allowed && !allowed.includes(field)) {
      sink.add(
        "field-not-allowed-for-kind",
        `${rowPath}.${field}`,
        `${rowName}: field ${JSON.stringify(field)} is not used by kind ${kind}`,
      );
    }
  }
  if (kind) {
    for (const field of requiredFieldsOf(kind)) {
      // `id` is reported above, where the row is first named.
      if (field !== "id" && !hasOwn(rec, field)) {
        sink.add(
          "missing-field",
          `${rowPath}.${field}`,
          `${rowName} of kind ${kind} is missing required field ${field}`,
        );
      }
    }
  }

  // values
  let covers: string[] | undefined;
  if (hasOwn(rec, "covers")) covers = parseCovers(sink, rec["covers"], rowPath);

  const out: Partial<TestPlanRow> = {};
  for (const field of STRING_FIELDS) {
    if (!hasOwn(rec, field)) continue;
    const text = nonEmptyString(
      sink,
      rec[field],
      `${rowPath}.${field}`,
      `${rowName}: ${field}`,
    );
    if (text !== undefined) (out as Rec)[field] = text;
  }
  if (hasOwn(rec, "check_command_ref")) {
    const ref = nonEmptyString(
      sink,
      rec["check_command_ref"],
      `${rowPath}.check_command_ref`,
      `${rowName}: check_command_ref`,
    );
    if (ref !== undefined) {
      if (COMMAND_REF_RE.test(ref)) out.check_command_ref = ref;
      else {
        sink.add(
          "invalid-value",
          `${rowPath}.check_command_ref`,
          `${rowName}: check_command_ref must be a command name (lower-case letters, digits, '.', '_', '-')`,
        );
      }
    }
  }
  for (const field of ["baseline", "threshold"] as const) {
    if (!hasOwn(rec, field)) continue;
    const v = numberOrString(
      sink,
      rec[field],
      `${rowPath}.${field}`,
      `${rowName}: ${field}`,
    );
    if (v !== undefined) out[field] = v;
  }
  if (hasOwn(rec, "runs")) {
    const v = intValue(
      sink,
      rec["runs"],
      `${rowPath}.runs`,
      `${rowName}: runs`,
      1,
    );
    if (v !== undefined) out.runs = v;
  }
  if (hasOwn(rec, "steps")) {
    const v = stringList(
      sink,
      rec["steps"],
      `${rowPath}.steps`,
      `${rowName}: steps`,
      { nonEmpty: true },
    );
    if (v !== undefined) out.steps = v;
  }
  if (hasOwn(rec, "control")) {
    const v = enumValue(
      sink,
      rec["control"],
      RUNTIME_CONTROLS,
      `${rowPath}.control`,
      `${rowName}: control`,
    );
    if (v !== undefined) out.control = v;
  }
  if (hasOwn(rec, "method")) {
    const v = enumValue(
      sink,
      rec["method"],
      RUNTIME_METHODS,
      `${rowPath}.method`,
      `${rowName}: method`,
    );
    if (v !== undefined) out.method = v;
  }

  if (sink.errors.length > before) return undefined;
  return { ...out, id: id!, covers: covers!, kind: kind! } as TestPlanRow;
}

/** Validates an already decoded `testplan.yaml` document. */
export function validateTestPlan(doc: unknown): ParseResult<TestPlan> {
  const sink = new ErrorSink();
  if (!Array.isArray(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `testplan must be a list of rows, got ${describeType(doc)}`,
    );
    return failResult(sink.errors);
  }
  const rows: TestPlan = [];
  const seenIds = new Set<string>();
  doc.forEach((raw, i) => {
    const row = parseRow(sink, raw, i, seenIds);
    if (row) rows.push(row);
  });
  return sink.finish(rows);
}

/** Parses the text of a `testplan.yaml`. */
export function parseTestPlan(text: string): ParseResult<TestPlan> {
  const decoded = parseYamlText(text);
  if (!decoded.ok) return decoded;
  return validateTestPlan(decoded.value);
}
