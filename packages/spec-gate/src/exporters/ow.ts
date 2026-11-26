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
import {
  assertBindingPaths,
  forbiddenNonGoalPath,
  forbiddenSpecFile,
  isDroppedHintPath,
  isLiteralRepoPath,
} from "./paths.js";

/** The only format name the CLI offers. */
export const OW_FORMAT = "ow";

/**
 * The list as given, accepted by the compiler only when it names every
 * field of a test-plan row: a field added to the row type and not listed
 * here is a compile error, not a field missing from the briefing.
 */
function everyRowKey<K extends keyof TestPlanRow>(
  keys: readonly K[],
  ...complete: [keyof TestPlanRow] extends [K]
    ? []
    : [missing: Exclude<keyof TestPlanRow, K>]
): readonly K[] {
  void complete;
  return keys;
}

/** The row fields in the key order `suggested_tests` objects use. */
const ROW_KEYS = everyRowKey([
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
]);

/** The constraint every slicer return is checked against (`check.ts`). */
export const QUALIFIED_ID_CONSTRAINT =
  "Every qualified AC and TP id of this spec must appear literally in at least one task.";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function testRow(row: TestPlanRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ROW_KEYS) {
    const value = row[key];
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
  // The path rules of `docs/export.md` are enforced here and not left to
  // the caller: whatever built the inputs, a briefing is printed only when
  // every path in it can be judged, and the hint is filtered against the
  // very entries `forbidden_changes` prints.
  if (!isLiteralRepoPath(specRel)) {
    throw new ExportError(
      "spec-dir-invalid",
      `the spec directory ${JSON.stringify(specRel)} is not a canonical repo-relative path`,
    );
  }
  const specId = spec.frontmatter.id;
  const specMdRel = `${specRel}/spec.md`;
  const testplanRel = `${specRel}/testplan.yaml`;
  const forbidden = [
    ...spec.nonGoals.flatMap((line) =>
      line.paths.map((entry) => forbiddenNonGoalPath(line.id, entry)),
    ),
    forbiddenSpecFile(specMdRel),
    forbiddenSpecFile(testplanRel),
  ];
  const forbiddenChanges = sortedUnique(forbidden.map((entry) => entry.text));
  assertBindingPaths(Object.entries(bindings));
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
    // trusted to keep the hint clean: a candidate that an entry of
    // `forbidden_changes` covers never belongs in the list of changes the
    // spec allows, neither by naming a forbidden path nor by lying below
    // one or below a directory a Non-goal glob matches.
    allowed_changes_hint: sortedUnique([
      ...testPaths,
      `${specRel}/bindings.yaml`,
      `${specRel}/bindings.log`,
      `${specRel}/evidence/`,
    ]).filter((candidate) => !isDroppedHintPath(candidate, forbidden)),
  };
  return stringify(doc, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
}
