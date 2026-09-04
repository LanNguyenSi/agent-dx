import fs from "node:fs";
import path from "node:path";
import type { MutantForm } from "./mutant.js";
// Type-only, so this module never imports `index.js` at runtime: `index.ts`
// imports `parsePlanFile` from here, and a runtime import back would make
// the two modules a cycle.
import type { ExpectVerdict, IsolationMode } from "./index.js";

/**
 * The largest plan file this package reads. A plan is JSON naming a test
 * command and a list of mutants, not a payload: even a thousand mutants
 * with long `replace` texts stay far below this, so anything past it is a
 * wrong path (a bundle, a log, a data file) rather than a plan, and is
 * refused by its recorded size without being loaded. Deliberately its own
 * constant rather than the 8 MiB `PATCH_MAX_BYTES`, which bounds a diff
 * (whole added files included), not a command list.
 */
export const PLAN_MAX_BYTES = 1024 * 1024;

/** One mutant of a plan, after validation: exactly one form, its own
 * fields, and the file it targets as written in the plan (resolved
 * against the invocation cwd by the caller, never here). */
export interface PlanMutantSpec {
  file: string;
  line?: number;
  form: MutantForm;
  replaceText?: string;
  matchText?: string;
  withText?: string;
  patchPath?: string;
  /** This mutant's own `expect`, when the plan gave it one; it wins over
   * the plan-level default and over a `--expect` on the command line. */
  expect?: ExpectVerdict;
}

/** A validated plan: what the file said, nothing resolved and nothing
 * defaulted except where a default is part of the schema. */
export interface ProbePlanSpec {
  testCommand: string;
  preCommand?: string;
  isolation?: IsolationMode;
  expect?: ExpectVerdict;
  /** Milliseconds, converted from the file's `timeout` (seconds, the
   * unit `--timeout` itself takes). */
  timeoutMs?: number;
  mutants: PlanMutantSpec[];
}

export type PlanParseFailureReason =
  "plan_not_readable" | "plan_invalid" | "plan_empty";

export type PlanParseResult =
  | { ok: true; plan: ProbePlanSpec }
  | { ok: false; reason: PlanParseFailureReason; message: string };

const PLAN_KEYS = [
  "test",
  "pre",
  "isolation",
  "expect",
  "timeout",
  "mutants",
] as const;

const MUTANT_KEYS = [
  "file",
  "line",
  "replace",
  "match",
  "with",
  "patch",
  "expect",
] as const;

function invalid(
  planPath: string,
  at: string,
  detail: string,
): PlanParseResult {
  return {
    ok: false,
    reason: "plan_invalid",
    message: `--plan ${planPath}: ${at} ${detail}`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects any key the schema does not name, so a typo (`tests`, `mutant`,
 * `timeoutMs`) is a refusal naming the key rather than a silently ignored
 * field whose value the run then never uses. */
function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function readString(
  value: unknown,
  planPath: string,
  at: string,
): { ok: true; value: string } | { ok: false; result: PlanParseResult } {
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      result: invalid(planPath, at, "must be a non-empty string"),
    };
  }
  return { ok: true, value };
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  planPath: string,
  at: string,
): { ok: true; value: T } | { ok: false; result: PlanParseResult } {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return {
      ok: false,
      result: invalid(
        planPath,
        at,
        `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`,
      ),
    };
  }
  return { ok: true, value: value as T };
}

/**
 * Reads and validates a `--plan` file. Two layers, in this order:
 *
 * 1. Metadata only (`statSync`, `accessSync`), the same bound `-p/--patch`
 *    is checked against before anything reads it: a directory, a FIFO or
 *    socket (whose unbounded read would block forever with no writer), an
 *    unreadable file, or one past `PLAN_MAX_BYTES` is `plan_not_readable`
 *    without a single byte being loaded.
 * 2. The schema: JSON object, known keys only, `test` present, `mutants`
 *    non-empty, and exactly one mutant form per entry. Every refusal names
 *    the offending path inside the plan (`mutants[2].patch`), so a caller
 *    fixing the file is never left guessing which entry was meant.
 *
 * Runs before the lock, the marker, the baseline or any worktree, so a
 * plan that cannot be used leaves nothing behind. The file is read exactly
 * once, here; nothing downstream re-reads it.
 *
 * The commands it carries (`test`, `pre`) are shell commands: this
 * function never treats anything in the file as a command to run, and the
 * trust boundary of the file itself is the caller's (see the README's
 * `--plan` section).
 */
export function parsePlanFile(planPath: string): PlanParseResult {
  const absPlanPath = path.resolve(planPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPlanPath);
  } catch {
    return {
      ok: false,
      reason: "plan_not_readable",
      message: `--plan could not be read: ${absPlanPath}`,
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      reason: "plan_not_readable",
      message: `--plan is not a regular file: ${absPlanPath}`,
    };
  }
  if (stat.size > PLAN_MAX_BYTES) {
    return {
      ok: false,
      reason: "plan_not_readable",
      message:
        `--plan is ${String(stat.size)} bytes, over the ` +
        `${String(PLAN_MAX_BYTES)}-byte cap: ${absPlanPath}`,
    };
  }
  try {
    fs.accessSync(absPlanPath, fs.constants.R_OK);
  } catch {
    return {
      ok: false,
      reason: "plan_not_readable",
      message: `--plan could not be read: ${absPlanPath}`,
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(absPlanPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: "plan_not_readable",
      message: `--plan could not be read: ${absPlanPath} (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: "plan_invalid",
      message: `--plan ${absPlanPath}: not valid JSON (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  return validatePlan(parsed, absPlanPath);
}

/** The schema half of `parsePlanFile`, on an already-parsed value.
 * Exported for the unit tests that drive it directly, and used by
 * `parsePlanFile` itself; `planPath` only ever appears in messages. */
export function validatePlan(
  parsed: unknown,
  planPath: string,
): PlanParseResult {
  if (!isPlainObject(parsed)) {
    return invalid(planPath, "plan", "must be a JSON object");
  }
  const extra = unknownKey(parsed, PLAN_KEYS);
  if (extra !== undefined) {
    return invalid(
      planPath,
      `plan.${extra}`,
      `is not a known plan key (${PLAN_KEYS.join(", ")})`,
    );
  }
  const test = readString(parsed.test, planPath, "plan.test");
  if (!test.ok) return test.result;
  const plan: ProbePlanSpec = { testCommand: test.value, mutants: [] };
  if (parsed.pre !== undefined) {
    const pre = readString(parsed.pre, planPath, "plan.pre");
    if (!pre.ok) return pre.result;
    plan.preCommand = pre.value;
  }
  if (parsed.isolation !== undefined) {
    const isolation = readEnum(
      parsed.isolation,
      ["worktree", "inplace"] as const,
      planPath,
      "plan.isolation",
    );
    if (!isolation.ok) return isolation.result;
    plan.isolation = isolation.value;
  }
  if (parsed.expect !== undefined) {
    const expect = readEnum(
      parsed.expect,
      ["fail", "pass"] as const,
      planPath,
      "plan.expect",
    );
    if (!expect.ok) return expect.result;
    plan.expect = expect.value;
  }
  if (parsed.timeout !== undefined) {
    if (
      typeof parsed.timeout !== "number" ||
      !Number.isFinite(parsed.timeout) ||
      parsed.timeout <= 0
    ) {
      return invalid(
        planPath,
        "plan.timeout",
        "must be a positive number of seconds",
      );
    }
    plan.timeoutMs = Math.round(parsed.timeout * 1000);
  }
  if (!Array.isArray(parsed.mutants)) {
    return invalid(planPath, "plan.mutants", "must be an array");
  }
  if (parsed.mutants.length === 0) {
    return {
      ok: false,
      reason: "plan_empty",
      message: `--plan ${planPath}: plan.mutants is empty; a plan needs at least one mutant`,
    };
  }
  for (const [index, raw] of parsed.mutants.entries()) {
    const at = `plan.mutants[${String(index)}]`;
    if (!isPlainObject(raw)) {
      return invalid(planPath, at, "must be a JSON object");
    }
    const extraMutantKey = unknownKey(raw, MUTANT_KEYS);
    if (extraMutantKey !== undefined) {
      return invalid(
        planPath,
        `${at}.${extraMutantKey}`,
        `is not a known mutant key (${MUTANT_KEYS.join(", ")})`,
      );
    }
    // `--file` is required for every plan mutant, unlike the single-probe
    // `-p` form which can derive it: the containment check for the whole
    // plan runs before the lock, and deriving a path would mean running a
    // `git apply --numstat` child per patch mutant before anything is
    // locked or checked.
    const file = readString(raw.file, planPath, `${at}.file`);
    if (!file.ok) return file.result;
    const mutant: PlanMutantSpec = { file: file.value, form: "replace" };
    if (raw.line !== undefined) {
      if (
        typeof raw.line !== "number" ||
        !Number.isInteger(raw.line) ||
        raw.line < 1
      ) {
        return invalid(planPath, `${at}.line`, "must be an integer >= 1");
      }
      mutant.line = raw.line;
    }
    if (raw.expect !== undefined) {
      const expect = readEnum(
        raw.expect,
        ["fail", "pass"] as const,
        planPath,
        `${at}.expect`,
      );
      if (!expect.ok) return expect.result;
      mutant.expect = expect.value;
    }
    const hasReplace = raw.replace !== undefined;
    const hasMatchPair = raw.match !== undefined || raw.with !== undefined;
    const hasPatch = raw.patch !== undefined;
    const formCount = [hasReplace, hasMatchPair, hasPatch].filter(
      Boolean,
    ).length;
    if (formCount !== 1) {
      return invalid(
        planPath,
        at,
        'needs exactly one mutant form: "replace", or "match" together with "with", or "patch"',
      );
    }
    if (hasReplace) {
      if (typeof raw.replace !== "string") {
        return invalid(planPath, `${at}.replace`, "must be a string");
      }
      mutant.form = "replace";
      mutant.replaceText = raw.replace;
    } else if (hasMatchPair) {
      if (raw.match === undefined || raw.with === undefined) {
        return invalid(
          planPath,
          at,
          '"match" and "with" must be given together',
        );
      }
      if (typeof raw.match !== "string" || raw.match.length === 0) {
        return invalid(planPath, `${at}.match`, "must be a non-empty string");
      }
      if (typeof raw.with !== "string") {
        return invalid(planPath, `${at}.with`, "must be a string");
      }
      mutant.form = "match";
      mutant.matchText = raw.match;
      mutant.withText = raw.with;
    } else {
      const patch = readString(raw.patch, planPath, `${at}.patch`);
      if (!patch.ok) return patch.result;
      mutant.form = "patch";
      mutant.patchPath = patch.value;
    }
    // `line` is what `replace`/`match` mutate; the `patch` form's line is
    // decided by the diff itself, so it is neither required nor used.
    if (mutant.form !== "patch" && mutant.line === undefined) {
      return invalid(
        planPath,
        `${at}.line`,
        'is required for the "replace" and "match" forms',
      );
    }
    plan.mutants.push(mutant);
  }
  return { ok: true, plan };
}
