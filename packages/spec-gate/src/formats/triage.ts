/**
 * `triage.json`: the discoverer's reading of the request, and the class
 * code derives from it.
 *
 * ```json
 * {
 *   "single_goal": { "value": "yes", "evidence": "..." },
 *   "code_related": { "value": "yes", "evidence": "..." },
 *   "core_is_decision": { "value": "no", "evidence": "..." },
 *   "scope_within_request": { "value": "yes", "evidence": "..." },
 *   "multiple_repos": { "value": "no", "evidence": "..." },
 *   "trivial": { "value": "no", "evidence": "..." },
 *   "blocking_unknowns": [],
 *   "class": "actionable",
 *   "rule_version": 1
 * }
 * ```
 *
 * The six fields and `blocking_unknowns` are written by the discoverer.
 * `class` and `rule_version` are written together by the triage step, so
 * a file has both or neither. The truth table that maps fields to a class
 * is not part of this format.
 */
import type { ParseResult } from "./errors.js";
import { ErrorSink, failResult } from "./errors.js";
import { parseJsonText } from "./input.js";
import type { Rec } from "./validate.js";
import {
  describeType,
  enumValue,
  hasOwn,
  intValue,
  isRecord,
  nonEmptyString,
  rejectUnknownKeys,
  stringList,
} from "./validate.js";

export const TRIAGE_FIELD_NAMES = [
  "single_goal",
  "code_related",
  "core_is_decision",
  "scope_within_request",
  "multiple_repos",
  "trivial",
] as const;
export type TriageFieldName = (typeof TRIAGE_FIELD_NAMES)[number];

export const TRIAGE_VALUES = ["yes", "no", "unknown"] as const;
export type TriageValue = (typeof TRIAGE_VALUES)[number];

export const TRIAGE_CLASSES = [
  "unsuitable",
  "decision",
  "split",
  "clarify",
  "no-spec-needed",
  "actionable",
] as const;
export type TriageClass = (typeof TRIAGE_CLASSES)[number];

export interface TriageField {
  value: TriageValue;
  evidence: string;
}

export interface Triage {
  fields: Record<TriageFieldName, TriageField>;
  blocking_unknowns: string[];
  class?: TriageClass;
  rule_version?: number;
}

const TOP_KEYS = [
  ...TRIAGE_FIELD_NAMES,
  "blocking_unknowns",
  "class",
  "rule_version",
] as const;

function parseField(
  sink: ErrorSink,
  name: string,
  raw: unknown,
): TriageField | undefined {
  const before = sink.errors.length;
  if (!isRecord(raw)) {
    sink.add(
      "wrong-type",
      name,
      `${name} must be an object with value and evidence, got ${describeType(raw)}`,
    );
    return undefined;
  }
  const rec: Rec = raw;
  rejectUnknownKeys(sink, rec, ["value", "evidence"], name, name);
  for (const key of ["value", "evidence"]) {
    if (!hasOwn(rec, key)) {
      sink.add("missing-field", `${name}.${key}`, `${name} is missing ${key}`);
    }
  }
  const value = hasOwn(rec, "value")
    ? enumValue(
        sink,
        rec["value"],
        TRIAGE_VALUES,
        `${name}.value`,
        `${name}.value`,
      )
    : undefined;
  const evidence = hasOwn(rec, "evidence")
    ? nonEmptyString(
        sink,
        rec["evidence"],
        `${name}.evidence`,
        `${name}.evidence`,
      )
    : undefined;
  if (sink.errors.length > before) return undefined;
  return { value: value!, evidence: evidence! };
}

/** Validates an already decoded `triage.json` document. */
export function validateTriage(doc: unknown): ParseResult<Triage> {
  const sink = new ErrorSink();
  if (!isRecord(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `triage must be an object, got ${describeType(doc)}`,
    );
    return failResult(sink.errors);
  }
  const rec: Rec = doc;
  rejectUnknownKeys(sink, rec, TOP_KEYS, "", "triage");
  const fields: Partial<Record<TriageFieldName, TriageField>> = {};
  for (const name of TRIAGE_FIELD_NAMES) {
    if (!hasOwn(rec, name)) {
      sink.add("missing-field", name, `triage is missing field ${name}`);
      continue;
    }
    const f = parseField(sink, name, rec[name]);
    if (f) fields[name] = f;
  }
  let blocking: string[] = [];
  if (!hasOwn(rec, "blocking_unknowns")) {
    sink.add(
      "missing-field",
      "blocking_unknowns",
      "triage is missing field blocking_unknowns",
    );
  } else {
    const v = stringList(
      sink,
      rec["blocking_unknowns"],
      "blocking_unknowns",
      "blocking_unknowns",
    );
    if (v) blocking = v;
  }
  const hasClass = hasOwn(rec, "class");
  const hasVersion = hasOwn(rec, "rule_version");
  let cls: TriageClass | undefined;
  let version: number | undefined;
  if (hasClass) {
    cls = enumValue(sink, rec["class"], TRIAGE_CLASSES, "class", "class");
  }
  if (hasVersion) {
    version = intValue(
      sink,
      rec["rule_version"],
      "rule_version",
      "rule_version",
      1,
    );
  }
  if (hasClass !== hasVersion) {
    sink.add(
      "missing-field",
      hasClass ? "rule_version" : "class",
      "class and rule_version are written together; a file has both or neither",
    );
  }
  if (!sink.empty) return failResult(sink.errors);
  const out: Triage = {
    fields: fields as Record<TriageFieldName, TriageField>,
    blocking_unknowns: blocking,
  };
  if (cls !== undefined) out.class = cls;
  if (version !== undefined) out.rule_version = version;
  return sink.finish(out);
}

/** Parses the text of a `triage.json`. */
export function parseTriage(text: string): ParseResult<Triage> {
  const decoded = parseJsonText(text);
  if (!decoded.ok) return decoded;
  return validateTriage(decoded.value);
}
