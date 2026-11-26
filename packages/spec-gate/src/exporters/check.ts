/**
 * `spec-gate export --check`: does the slicer return name every qualified
 * AC and TP id of the spec? The ids come from `spec.md` and
 * `testplan.yaml` of the spec directory, in file order (AC first, then the
 * test-plan rows); the return must show each of them as a whole token in a
 * string field of at least one of its tasks.
 *
 * A token boundary: the qualified id may be surrounded by anything except
 * the characters an id itself is built from (letters, digits, `-`, `_`).
 * Without that rule a return that mentions `#AC-10` would answer for
 * `#AC-1`, and the id of one spec embedded in a longer token would answer
 * for another spec.
 */
import path from "node:path";
import {
  formatQualifiedId,
  parseSpec,
  parseTestPlan,
  parseYamlText,
} from "../formats/index.js";
import { SPEC_FILE, TESTPLAN_FILE } from "../canonical/index.js";
import { hasOwn, isRecord } from "../formats/validate.js";
import { ExportError } from "./errors.js";
import type { ExportErrorCode } from "./errors.js";
import { readWorktreeText } from "./worktree.js";

/** Characters that would make a match part of a longer token. */
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

export type CheckOutcome =
  | { ok: true; missing: string[] }
  | { ok: false; code: ExportErrorCode; message: string };

function fail(code: ExportErrorCode, message: string): CheckOutcome {
  return { ok: false, code, message };
}

/** Whether `qualified` occurs in `text` as a whole token. */
export function containsQualifiedId(text: string, qualified: string): boolean {
  let from = 0;
  while (true) {
    const at = text.indexOf(qualified, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text.charAt(at - 1);
    const after = text.charAt(at + qualified.length);
    if (!TOKEN_CHAR.test(before) && !TOKEN_CHAR.test(after)) return true;
    from = at + 1;
  }
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (isRecord(value)) {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
}

/** The qualified ids of the spec directory, AC lines then test-plan rows. */
function qualifiedIds(specDir: string): string[] | CheckOutcome {
  let specText: string;
  let planText: string;
  try {
    specText = readWorktreeText(
      path.join(specDir, SPEC_FILE),
      `${SPEC_FILE} of the spec directory`,
      "input-missing",
    );
    planText = readWorktreeText(
      path.join(specDir, TESTPLAN_FILE),
      `${TESTPLAN_FILE} of the spec directory`,
      "input-missing",
    );
  } catch (err) {
    if (!(err instanceof ExportError)) throw err;
    return fail(err.code, err.message);
  }
  const spec = parseSpec(specText);
  if (!spec.ok) {
    return fail(
      "spec-invalid",
      `${SPEC_FILE} is not valid (${spec.errors.length} error(s)): ${spec.errors[0]?.message ?? "no detail"}`,
    );
  }
  const plan = parseTestPlan(planText);
  if (!plan.ok) {
    return fail(
      "testplan-invalid",
      `${TESTPLAN_FILE} is not valid (${plan.errors.length} error(s)): ${plan.errors[0]?.message ?? "no detail"}`,
    );
  }
  const id = spec.value.frontmatter.id;
  return [
    ...spec.value.acceptance.map((line) => formatQualifiedId(id, line.id)),
    ...plan.value.map((row) => formatQualifiedId(id, row.id)),
  ];
}

/**
 * Check `returnPath` against the spec directory. `missing` is in the order
 * the ids were generated, so the list is stable.
 */
export function checkSlicerReturn(
  specDir: string,
  returnPath: string,
): CheckOutcome {
  const ids = qualifiedIds(specDir);
  if (!Array.isArray(ids)) return ids;

  let text: string;
  try {
    text = readWorktreeText(
      returnPath,
      "the slicer return",
      "return-unreadable",
    );
  } catch (err) {
    if (!(err instanceof ExportError)) throw err;
    return fail(err.code, err.message);
  }
  const decoded = parseYamlText(text);
  if (!decoded.ok) {
    return fail(
      "return-parse",
      `the slicer return is not valid YAML (${decoded.errors.length} error(s)): ${decoded.errors[0]?.message ?? "no detail"}`,
    );
  }
  const doc = decoded.value;
  if (!isRecord(doc) || !hasOwn(doc, "tasks")) {
    return fail(
      "return-shape",
      "the slicer return must be a mapping with a tasks list",
    );
  }
  const tasks = doc["tasks"];
  if (!Array.isArray(tasks)) {
    return fail(
      "return-shape",
      "the tasks of the slicer return must be a list",
    );
  }
  const taskStrings: string[][] = [];
  for (const [index, task] of tasks.entries()) {
    if (!isRecord(task)) {
      return fail(
        "return-shape",
        `task ${index} of the slicer return must be a mapping`,
      );
    }
    const strings: string[] = [];
    collectStrings(task, strings);
    taskStrings.push(strings);
  }

  const missing = ids.filter(
    (qualified) =>
      !taskStrings.some((strings) =>
        strings.some((s) => containsQualifiedId(s, qualified)),
      ),
  );
  return { ok: true, missing };
}
