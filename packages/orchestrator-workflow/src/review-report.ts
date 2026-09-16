import { parse as parseYaml } from "yaml";

/**
 * Structural schema for the reviewer output contract (the final ```yaml
 * block in `assets/agents/reviewer.md`, mirrored byte-for-byte in
 * `assets/skill/references/contracts.md`). This module is the single
 * hand-maintained copy of that shape in code; `test/docs-consistency.test.ts`
 * parses the contract block itself and asserts it matches the constants
 * below exactly, so a contract edit without a matching edit here fails the
 * suite instead of drifting silently.
 *
 * This validator checks structure only. It never judges semantic adequacy,
 * never waives a finding, and its passing is never orchestrator acceptance.
 */

/** Top-level field names, in the contract's own order. */
export const TOP_LEVEL_FIELDS = [
  "status",
  "role",
  "task_id",
  "summary",
  "findings",
  "acceptance_recommendation",
  "missing_tests",
  "residual_risks",
  "reproduction",
  "method_applied",
  "withdrawn",
] as const;

/** Field names of one `findings[]` entry, in the contract's own order. */
export const FINDING_FIELDS = [
  "severity",
  "category",
  "description",
  "suggested_fix",
  "recurrence",
  "introduced_by_delta",
] as const;

/** Field names of the `reproduction` object, in the contract's own order. */
export const REPRODUCTION_FIELDS = [
  "method",
  "sample_size",
  "result",
  "matches_implementer_claim",
] as const;

/** Field names of one `withdrawn[]` entry, in the contract's own order. */
export const WITHDRAWN_FIELDS = ["description", "reason"] as const;

/**
 * Enum spellings keyed by their bare field name. Every enum-bearing field
 * in the contract has a name unique across the whole block, so a flat map
 * (rather than one keyed by full path) is enough and matches how the
 * contract text itself reads (`key: a | b | c`).
 */
export const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  status: ["reviewed"],
  role: ["reviewer"],
  severity: ["low", "medium", "high", "critical"],
  category: [
    "correctness",
    "architecture",
    "security",
    "tests",
    "maintainability",
    "performance",
    "docs",
  ],
  recurrence: ["new", "repeated"],
  introduced_by_delta: ["yes", "no", "unknown"],
  acceptance_recommendation: [
    "accept",
    "accept_with_notes",
    "fix_required",
    "reject",
  ],
  matches_implementer_claim: ["matched", "mismatched", "not_applicable"],
  method_applied: ["normal", "rigorous", "adversarial"],
};

export interface Diagnostic {
  /** Dotted/bracketed location of the offending field, e.g. `findings[0].severity`. */
  path: string;
  /** What the schema requires at that path. */
  expected: string;
  /** What was actually found (or "missing"). */
  got: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  /** Non-fatal observations, e.g. prose found after the fenced block. */
  warnings: string[];
}

/**
 * This validator reports structural validity only. It does not judge
 * semantic adequacy, cannot waive findings, and passing it does not
 * constitute orchestrator acceptance.
 */
export const STRUCTURAL_ONLY_NOTE =
  "Structural check only: this does not judge semantic adequacy, cannot waive findings, and does not constitute orchestrator acceptance.";

function describeValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === "object") return "mapping";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkEnumField(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  path: string,
  diagnostics: Diagnostic[],
): void {
  const value = record[key];
  const expected = allowed.join(" | ");
  if (value === undefined) {
    diagnostics.push({ path, expected, got: "missing" });
    return;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    diagnostics.push({ path, expected, got: describeValue(value) });
  }
}

function checkStringField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: Diagnostic[],
): void {
  const value = record[key];
  if (value === undefined) {
    diagnostics.push({ path, expected: "string", got: "missing" });
    return;
  }
  if (typeof value !== "string") {
    diagnostics.push({ path, expected: "string", got: describeValue(value) });
  }
}

function checkNonEmptyStringField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: Diagnostic[],
): void {
  const value = record[key];
  if (value === undefined) {
    diagnostics.push({ path, expected: "non-empty string", got: "missing" });
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({
      path,
      expected: "non-empty string",
      got: describeValue(value),
    });
  }
}

/** Accepts a string or a number (a reviewer may write `sample_size: 5`). */
function checkScalarField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: Diagnostic[],
): void {
  const value = record[key];
  if (value === undefined) {
    diagnostics.push({ path, expected: "string", got: "missing" });
    return;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    diagnostics.push({ path, expected: "string", got: describeValue(value) });
  }
}

function checkArrayField(
  doc: Record<string, unknown>,
  key: string,
  diagnostics: Diagnostic[],
): void {
  const value = doc[key];
  if (value === undefined) {
    diagnostics.push({ path: key, expected: "array", got: "missing" });
    return;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      path: key,
      expected: "array",
      got: describeValue(value),
    });
  }
}

/**
 * A field-level checker for one `findings[]`/`reproduction`/`withdrawn[]`
 * sub-field: given the owning record and the *base* path of that record
 * (e.g. `findings[0]` or `reproduction`), it appends its own `.field`
 * suffix and pushes a diagnostic when the field is missing or wrong.
 */
type FieldChecker = (
  record: Record<string, unknown>,
  basePath: string,
  diagnostics: Diagnostic[],
) => void;

/**
 * Dispatch table keyed by every name in {@link FINDING_FIELDS}. The
 * `Record<(typeof FINDING_FIELDS)[number], FieldChecker>` type means a
 * name added to `FINDING_FIELDS` without a matching entry here is a
 * TypeScript compile error, not a silently-unchecked field (fix-round,
 * review finding M2).
 */
const FINDING_CHECKS: Record<(typeof FINDING_FIELDS)[number], FieldChecker> = {
  severity: (entry, path, diagnostics) =>
    checkEnumField(
      entry,
      "severity",
      ENUM_VALUES.severity,
      `${path}.severity`,
      diagnostics,
    ),
  category: (entry, path, diagnostics) =>
    checkEnumField(
      entry,
      "category",
      ENUM_VALUES.category,
      `${path}.category`,
      diagnostics,
    ),
  description: (entry, path, diagnostics) =>
    checkStringField(entry, "description", `${path}.description`, diagnostics),
  suggested_fix: (entry, path, diagnostics) =>
    checkStringField(
      entry,
      "suggested_fix",
      `${path}.suggested_fix`,
      diagnostics,
    ),
  recurrence: (entry, path, diagnostics) =>
    checkEnumField(
      entry,
      "recurrence",
      ENUM_VALUES.recurrence,
      `${path}.recurrence`,
      diagnostics,
    ),
  introduced_by_delta: (entry, path, diagnostics) =>
    checkEnumField(
      entry,
      "introduced_by_delta",
      ENUM_VALUES.introduced_by_delta,
      `${path}.introduced_by_delta`,
      diagnostics,
    ),
};

/** Dispatch table keyed by every name in {@link REPRODUCTION_FIELDS}. */
const REPRODUCTION_CHECKS: Record<
  (typeof REPRODUCTION_FIELDS)[number],
  FieldChecker
> = {
  method: (value, path, diagnostics) =>
    checkScalarField(value, "method", `${path}.method`, diagnostics),
  sample_size: (value, path, diagnostics) =>
    checkScalarField(value, "sample_size", `${path}.sample_size`, diagnostics),
  result: (value, path, diagnostics) =>
    checkScalarField(value, "result", `${path}.result`, diagnostics),
  matches_implementer_claim: (value, path, diagnostics) =>
    checkEnumField(
      value,
      "matches_implementer_claim",
      ENUM_VALUES.matches_implementer_claim,
      `${path}.matches_implementer_claim`,
      diagnostics,
    ),
};

/** Dispatch table keyed by every name in {@link WITHDRAWN_FIELDS}. */
const WITHDRAWN_CHECKS: Record<
  (typeof WITHDRAWN_FIELDS)[number],
  FieldChecker
> = {
  description: (entry, path, diagnostics) =>
    checkStringField(entry, "description", `${path}.description`, diagnostics),
  reason: (entry, path, diagnostics) =>
    checkStringField(entry, "reason", `${path}.reason`, diagnostics),
};

function checkFindings(
  doc: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  const value = doc.findings;
  if (value === undefined) {
    diagnostics.push({ path: "findings", expected: "array", got: "missing" });
    return;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      path: "findings",
      expected: "array",
      got: describeValue(value),
    });
    return;
  }
  value.forEach((entry, index) => {
    const path = `findings[${index}]`;
    if (!isPlainRecord(entry)) {
      diagnostics.push({
        path,
        expected: "mapping",
        got: describeValue(entry),
      });
      return;
    }
    for (const field of FINDING_FIELDS) {
      FINDING_CHECKS[field](entry, path, diagnostics);
    }
  });
}

function checkReproduction(
  doc: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  const value = doc.reproduction;
  if (value === undefined) {
    diagnostics.push({
      path: "reproduction",
      expected: "mapping",
      got: "missing",
    });
    return;
  }
  if (!isPlainRecord(value)) {
    diagnostics.push({
      path: "reproduction",
      expected: "mapping",
      got: describeValue(value),
    });
    return;
  }
  for (const field of REPRODUCTION_FIELDS) {
    REPRODUCTION_CHECKS[field](value, "reproduction", diagnostics);
  }
}

function checkWithdrawn(
  doc: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  const value = doc.withdrawn;
  if (value === undefined) {
    diagnostics.push({
      path: "withdrawn",
      expected: "array (may be empty)",
      got: "missing",
    });
    return;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      path: "withdrawn",
      expected: "array (may be empty)",
      got: describeValue(value),
    });
    return;
  }
  value.forEach((entry, index) => {
    const path = `withdrawn[${index}]`;
    if (!isPlainRecord(entry)) {
      diagnostics.push({
        path,
        expected: "mapping",
        got: describeValue(entry),
      });
      return;
    }
    for (const field of WITHDRAWN_FIELDS) {
      WITHDRAWN_CHECKS[field](entry, path, diagnostics);
    }
  });
}

/**
 * A checker for one top-level field: given the whole parsed document, it
 * pushes a diagnostic when that field is missing or wrong.
 */
type DocChecker = (
  doc: Record<string, unknown>,
  diagnostics: Diagnostic[],
) => void;

/**
 * Dispatch table keyed by every name in {@link TOP_LEVEL_FIELDS}. As with
 * {@link FINDING_CHECKS}, the `Record<(typeof TOP_LEVEL_FIELDS)[number],
 * DocChecker>` type turns a `TOP_LEVEL_FIELDS` entry without a matching
 * checker into a TypeScript compile error (fix-round, review finding M2):
 * a field added to both the contract fences and this array can no longer
 * go unchecked while every test stays green, since it fails to typecheck
 * before any test runs.
 */
const TOP_LEVEL_CHECKS: Record<(typeof TOP_LEVEL_FIELDS)[number], DocChecker> =
  {
    status: (doc, diagnostics) =>
      checkEnumField(doc, "status", ENUM_VALUES.status, "status", diagnostics),
    role: (doc, diagnostics) =>
      checkEnumField(doc, "role", ENUM_VALUES.role, "role", diagnostics),
    task_id: (doc, diagnostics) =>
      checkNonEmptyStringField(doc, "task_id", "task_id", diagnostics),
    summary: (doc, diagnostics) => checkArrayField(doc, "summary", diagnostics),
    findings: checkFindings,
    acceptance_recommendation: (doc, diagnostics) =>
      checkEnumField(
        doc,
        "acceptance_recommendation",
        ENUM_VALUES.acceptance_recommendation,
        "acceptance_recommendation",
        diagnostics,
      ),
    missing_tests: (doc, diagnostics) =>
      checkArrayField(doc, "missing_tests", diagnostics),
    residual_risks: (doc, diagnostics) =>
      checkArrayField(doc, "residual_risks", diagnostics),
    reproduction: checkReproduction,
    method_applied: (doc, diagnostics) =>
      checkEnumField(
        doc,
        "method_applied",
        ENUM_VALUES.method_applied,
        "method_applied",
        diagnostics,
      ),
    withdrawn: checkWithdrawn,
  };

interface ExtractedYaml {
  yamlText: string;
  warnings: string[];
}

/**
 * A reviewer return is commonly wrapped in a single fenced code block.
 * Strips one leading/trailing fence when present, whatever language tag
 * it carries (```yaml, ```yml, a bare ``` , or any other tag -- a
 * language-less fence previously fell through to the "literal YAML"
 * branch below and produced a confusing YAML parse error instead of a
 * clean structural diagnostic; fix-round, review finding L2); anything
 * unfenced is treated as literal YAML. The fence is located anywhere in
 * the input, not only at its very start: a return prefixed with prose
 * ("Here is my report:\n```yaml ...") previously fell through to the
 * "literal YAML" branch, since the fence pattern was anchored to the
 * start of the string, and produced a raw parse error instead of a
 * structural diagnostic (fix-round, review finding L1). Prose found
 * before the opening fence or after the closing fence is tolerated, but
 * each is named as its own warning rather than silently dropped.
 */
export function extractYamlSource(raw: string): ExtractedYaml {
  const warnings: string[] = [];
  const withoutBom = raw.replace(/^﻿/, "");
  const fenceMatch = withoutBom.match(/```[A-Za-z]*\r?\n([\s\S]*?)\r?\n?```/);
  if (fenceMatch) {
    const start = fenceMatch.index ?? 0;
    const before = withoutBom.slice(0, start);
    if (before.trim().length > 0) {
      warnings.push(
        "prose found before the opening ```yaml fence; only the fenced block was validated",
      );
    }
    const inner = fenceMatch[1];
    const after = withoutBom.slice(start + fenceMatch[0].length);
    if (after.trim().length > 0) {
      warnings.push(
        "prose found after the closing ```yaml fence; only the fenced block was validated",
      );
    }
    return { yamlText: inner, warnings };
  }
  return { yamlText: withoutBom, warnings };
}

/**
 * Validates a reviewer return against the reviewer output contract's
 * structure. Reports structural validity ONLY: it never judges semantic
 * adequacy, never waives a finding, and passing it is never orchestrator
 * acceptance.
 */
export function validateReviewReport(raw: string): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const { yamlText, warnings } = extractYamlSource(raw);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    diagnostics.push({
      path: "<root>",
      expected: "valid YAML",
      got: error instanceof Error ? error.message : String(error),
    });
    return { valid: false, diagnostics, warnings };
  }

  if (!isPlainRecord(parsed)) {
    diagnostics.push({
      path: "<root>",
      expected: "a YAML mapping (object)",
      got: describeValue(parsed),
    });
    return { valid: false, diagnostics, warnings };
  }

  for (const field of TOP_LEVEL_FIELDS) {
    TOP_LEVEL_CHECKS[field](parsed, diagnostics);
  }

  return { valid: diagnostics.length === 0, diagnostics, warnings };
}
