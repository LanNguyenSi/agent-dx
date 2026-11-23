/**
 * The digest input: the normative layer of one spec, as one JSON value.
 *
 * Pure: nothing here reads a file or runs a program. The caller passes the
 * parsed spec, the parsed test plan and the argv lists of the commands the
 * plan refers to, read at the revision `commands_ref` names.
 *
 * What goes in (see `docs/digest.md` for the full statement):
 * - the frontmatter's `id`, `base_commit`, `commands_ref` and `retired_ids`,
 * - GOAL, AC (with source and owner), NG, DF, DC (with provenance), RS and
 *   the source-ledger assignment,
 * - every test-plan field whose layer is `normative`, whitespace-normalised
 *   only where `PLAN_FIELD_CLASSES` says the field is prose,
 * - the argv list of each command a normative test-plan field refers to.
 *
 * What stays out: `status`, `superseded_by`, the frontmatter `source`,
 * Context (the parser does not expose it), line numbers, every
 * binding and informative field, and every file other than `spec.md` and
 * `testplan.yaml`.
 */
import type { Spec, TestPlan, TestPlanRow } from "../formats/index.js";
import { layerOf } from "../formats/index.js";
import { DigestError } from "./errors.js";
import { COMMANDS_PATH } from "./git.js";
import type { Json } from "./jcs.js";
import { canonicalJson, sha256Digest } from "./jcs.js";
import {
  compareIds,
  compareText,
  normalizeText,
  sortById,
} from "./normalize.js";

/** Names the digest input's layout; a change of layout changes it. */
export const DIGEST_FORMAT = "spec-gate-digest/1";

export interface DigestParts {
  spec: Spec;
  testPlan: TestPlan;
  /** The argv list of each command the test plan refers to, by name. */
  commands: Readonly<Record<string, readonly string[]>>;
}

/** The sorted, distinct command names the test plan's normative fields refer to. */
export function referencedCommandNames(plan: TestPlan): string[] {
  const names = new Set<string>();
  for (const row of plan) {
    if (row.check_command_ref !== undefined) names.add(row.check_command_ref);
  }
  return [...names].sort(compareText);
}

/**
 * How the digest treats the text of each normative test-plan field.
 *
 * - `prose`: a sentence or label; runs of ASCII whitespace collapse and the
 *   ends are trimmed (see `normalizeText`).
 * - `exact`: the value is used as the parser returns it. Whitespace inside
 *   an ID, a path, a match string, a command or location name is part of
 *   the value: two such values that differ only there name different
 *   things.
 *
 * A normative field that is missing here is treated as `exact`, and a test
 * fails until the field is classified. Numbers and booleans are always
 * written as they are; the class only matters for strings.
 */
export type TextClass = "prose" | "exact";

export const PLAN_FIELD_CLASSES: Readonly<Record<string, TextClass>> =
  Object.freeze({
    // identity and references
    id: "exact",
    covers: "exact",
    kind: "exact",
    check_command_ref: "exact",
    // paths, locations, match text and run set-up
    input: "exact",
    steps: "exact",
    environment: "exact",
    verifier: "exact",
    evidence_location: "exact",
    fail_match: "exact",
    expected: "exact",
    // enumerations and counts
    control: "exact",
    method: "exact",
    runs: "exact",
    // prose
    claim: "prose",
    oracle: "prose",
    level: "prose",
    seam: "prose",
    red_reason: "prose",
    baseline: "prose",
    threshold: "prose",
    check: "prose",
    probe_hint: "prose",
  });

function textClassOf(field: string): TextClass {
  return Object.hasOwn(PLAN_FIELD_CLASSES, field)
    ? PLAN_FIELD_CLASSES[field]!
    : "exact";
}

const sortedIds = (ids: readonly string[]): string[] =>
  [...ids].sort(compareIds);

function specRows(spec: Spec): Record<string, Json> {
  const goal: Json = spec.goal
    ? { id: spec.goal.id, text: normalizeText(spec.goal.text) }
    : null;
  return {
    goal,
    acceptance: sortById(spec.acceptance).map((l) => ({
      id: l.id,
      text: normalizeText(l.text),
      source: sortedIds(l.source),
      owner: l.owner,
    })),
    non_goals: sortById(spec.nonGoals).map((l) => ({
      id: l.id,
      text: normalizeText(l.text),
      paths: [...l.paths].sort(compareText),
    })),
    defaults: sortById(spec.defaults).map((l) => ({
      id: l.id,
      text: normalizeText(l.text),
      reason: normalizeText(l.reason),
      affects_behavior: l.affects_behavior,
    })),
    decisions: sortById(spec.decisions).map((l) => {
      const provenance: Record<string, Json> = {
        channel: l.provenance.channel,
        author: l.provenance.author,
        time: l.provenance.time,
      };
      if (l.provenance.comment_url !== undefined) {
        provenance["comment_url"] = l.provenance.comment_url;
      }
      return {
        id: l.id,
        text: normalizeText(l.text),
        question: l.question,
        provenance,
      };
    }),
    residuals: sortById(spec.residuals).map((l) => {
      const row: Record<string, Json> = {
        id: l.id,
        text: normalizeText(l.text),
        class: l.class,
        status: l.status,
      };
      if (l.question !== undefined) row["question"] = l.question;
      return row;
    }),
    source_ledger: sortById(spec.ledger).map((l) => {
      const row: Record<string, Json> = {
        id: l.id,
        source_line: l.sourceLine,
        targets: sortedIds(l.targets),
        out: l.out,
      };
      if (l.reason !== undefined) row["reason"] = normalizeText(l.reason);
      return row;
    }),
  };
}

function planValue(field: string, value: unknown, prose: boolean): Json {
  if (typeof value === "string") return prose ? normalizeText(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => planValue(field, v, prose));
    // `covers` is a set of IDs; `steps` is an ordered list and keeps its order.
    return field === "covers" ? (items as string[]).sort(compareIds) : items;
  }
  throw new TypeError(`test plan field ${field} has an unexpected value`);
}

function planRow(row: TestPlanRow): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [field, value] of Object.entries(row)) {
    if (value === undefined || layerOf(field) !== "normative") continue;
    out[field] = planValue(field, value, textClassOf(field) === "prose");
  }
  return out;
}

/** Builds the value the digest is taken over. */
export function buildDigestInput(parts: DigestParts): Json {
  const { spec, testPlan, commands } = parts;
  const argv: Record<string, Json> = {};
  for (const name of referencedCommandNames(testPlan)) {
    const list = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (list === undefined) {
      throw new DigestError(
        "command-ref-unknown",
        `a test-plan row refers to command ${JSON.stringify(name)}, which is not in ${COMMANDS_PATH} at commands_ref ${spec.frontmatter.commands_ref}`,
      );
    }
    // argv elements are exact strings: no whitespace normalisation.
    argv[name] = [...list];
  }
  return {
    format: DIGEST_FORMAT,
    id: spec.frontmatter.id,
    base_commit: spec.frontmatter.base_commit,
    commands_ref: spec.frontmatter.commands_ref,
    retired_ids: sortedIds(spec.frontmatter.retired_ids),
    ...specRows(spec),
    test_plan: sortById(testPlan).map(planRow),
    commands: argv,
  };
}

/** `sha256:<64 hex>` of the canonical JSON of the digest input. */
export function computeDigest(parts: DigestParts): string {
  return sha256Digest(canonicalJson(buildDigestInput(parts)));
}
