/**
 * The digest input: the normative layer of one spec, as one JSON value.
 *
 * Pure: nothing here reads a file or runs a program. The caller passes the
 * parsed spec, the parsed test plan and the argv lists of the commands the
 * plan refers to, read at the revision `commands_ref` names.
 *
 * What goes in (see `docs/digest.md` for the full statement):
 * - the frontmatter's `base_commit`, `commands_ref` and `retired_ids`,
 * - GOAL, AC (with source and owner), NG, DF, DC (with provenance), RS and
 *   the source-ledger assignment,
 * - every test-plan field whose layer is `normative`,
 * - the argv list of each command a normative test-plan field refers to.
 *
 * What stays out: `status`, `superseded_by`, the frontmatter `id` and
 * `source`, Context (the parser does not expose it), line numbers, every
 * binding and informative field, and every file other than `spec.md` and
 * `testplan.yaml`.
 */
import type { Spec, TestPlan, TestPlanRow } from "../formats/index.js";
import { layerOf } from "../formats/index.js";
import { DigestError } from "./errors.js";
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

const sortedIds = (ids: readonly string[]): string[] =>
  [...ids].sort(compareIds).map(normalizeText);

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
      owner: normalizeText(l.owner),
    })),
    non_goals: sortById(spec.nonGoals).map((l) => ({
      id: l.id,
      text: normalizeText(l.text),
      paths: l.paths.map(normalizeText).sort(compareText),
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
        author: normalizeText(l.provenance.author),
        time: normalizeText(l.provenance.time),
      };
      if (l.provenance.comment_url !== undefined) {
        provenance["comment_url"] = normalizeText(l.provenance.comment_url);
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

function planValue(field: string, value: unknown): Json {
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => planValue(field, v));
    // `covers` is a set of IDs; `steps` is an ordered list and keeps its order.
    return field === "covers" ? (items as string[]).sort(compareIds) : items;
  }
  throw new TypeError(`test plan field ${field} has an unexpected value`);
}

function planRow(row: TestPlanRow): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [field, value] of Object.entries(row)) {
    if (value === undefined || layerOf(field) !== "normative") continue;
    out[field] = planValue(field, value);
  }
  return out;
}

/** Builds the value the digest is taken over. */
export function buildDigestInput(parts: DigestParts): Json {
  const { spec, testPlan, commands } = parts;
  const argv: Record<string, Json> = {};
  for (const name of referencedCommandNames(testPlan)) {
    const list = commands[name];
    if (list === undefined) {
      throw new DigestError(
        "command-ref-unknown",
        `a test-plan row refers to command ${JSON.stringify(name)}, which is not in the commands file at commands_ref`,
      );
    }
    // argv elements are exact strings: no whitespace normalisation.
    argv[name] = [...list];
  }
  return {
    format: DIGEST_FORMAT,
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
