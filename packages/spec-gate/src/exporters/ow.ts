/**
 * The `ow` slicer briefing: one deterministic YAML document built from a
 * merged proposed spec, its test plan and its bindings. Every list has a
 * fixed derivation (file order, or sorted where the order of the source
 * file carries no meaning), so the same inputs always give byte-identical
 * output. The key order is fixed here and documented in `docs/export.md`.
 */
import { stringify } from "yaml";
import { formatQualifiedId, type TestPlanRow } from "../formats/index.js";
import { ExportError } from "./errors.js";
import type { MergedInputs } from "./merged.js";
import { isDroppedHintPath } from "./paths.js";

/** The only format name the CLI offers. */
export const OW_FORMAT = "ow";

/** The row fields in the key order `suggested_tests` objects use. */
const ROW_KEYS = [
  "id",
  "covers",
  "kind",
  "claim",
  "input",
  "expected",
  "oracle",
  "level",
  "seam",
  "red_reason",
  "fail_match",
  "baseline",
  "threshold",
  "runs",
  "check_command_ref",
  "verifier",
  "evidence_location",
  "check",
  "environment",
  "steps",
  "control",
  "method",
  "probe_hint",
  "notes",
] as const;

/** The constraint every slicer return is checked against (`check.ts`). */
export const QUALIFIED_ID_CONSTRAINT =
  "Every qualified AC and TP id of this spec must appear literally in at least one task.";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function testRow(row: TestPlanRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ROW_KEYS) {
    const value = row[key as keyof TestPlanRow];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/** The briefing text, ending with a line feed. */
export function buildOwExport(inputs: MergedInputs, digest: string): string {
  const { spec, testPlan, bindings, specRel, commit } = inputs;
  if (spec.goal === null) {
    throw new ExportError(
      "spec-invalid",
      "spec.md states no goal; a spec needs exactly one GOAL line before it can be exported",
    );
  }
  const specId = spec.frontmatter.id;
  const specMdRel = `${specRel}/spec.md`;
  const testplanRel = `${specRel}/testplan.yaml`;
  const nonGoalPaths = spec.nonGoals.flatMap((line) => line.paths);
  const forbiddenChanges = sortedUnique([
    ...nonGoalPaths,
    specMdRel,
    testplanRel,
  ]);
  const testPaths: string[] = [];
  for (const binding of Object.values(bindings)) {
    if (binding.file !== undefined) testPaths.push(binding.file);
    testPaths.push(...binding.fixtures);
  }
  const doc = {
    spec_ref: `${specRel}@${commit}`,
    digest,
    goal: spec.goal.text,
    acceptance_criteria: [
      ...spec.acceptance.map(
        (line) => `${formatQualifiedId(specId, line.id)}: ${line.text}`,
      ),
      ...testPlan.map(
        (row) => `${formatQualifiedId(specId, row.id)}: ${row.claim}`,
      ),
    ],
    suggested_tests: testPlan.map(testRow),
    forbidden_changes: forbiddenChanges,
    constraints: [
      ...spec.nonGoals
        .filter((line) => line.paths.length === 0)
        .map((line) => `${formatQualifiedId(specId, line.id)}: ${line.text}`),
      QUALIFIED_ID_CONSTRAINT,
    ],
    relevant_docs: [specMdRel, testplanRel],
    // A binding is data an implementation workflow may edit, so it is not
    // trusted to keep the hint clean: every binding path is canonical
    // (merged.ts refused any other spelling) and a candidate the briefing
    // forbids to change never belongs in the list of changes the spec
    // allows, neither by spelling its own name nor by spelling its way
    // under a Non-goal path or into a Non-goal glob.
    allowed_changes_hint: sortedUnique([
      ...testPaths,
      `${specRel}/bindings.yaml`,
      `${specRel}/bindings.log`,
      `${specRel}/evidence/`,
    ]).filter(
      (candidate) =>
        !isDroppedHintPath(candidate, specMdRel, testplanRel, nonGoalPaths),
    ),
  };
  return stringify(doc, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
}
