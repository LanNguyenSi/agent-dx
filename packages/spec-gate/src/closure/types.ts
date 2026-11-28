/**
 * The report of `spec-gate closure` (`spec-gate-closure/1`): for every
 * test-plan row, whether the committed evidence proves it at or after the
 * start commit, and why. The field order of every object below is the
 * order of the JSON line.
 */
import type { TestPlanKind } from "../formats/index.js";

export const CLOSURE_FORMAT = "spec-gate-closure/1";

export const ROW_STATES = [
  "proven",
  "failed",
  "unproven",
  "not-decidable",
  "pending-post-deploy",
] as const;
export type RowState = (typeof ROW_STATES)[number];

/**
 * Why an envelope does not count, one code per envelope, checked in this
 * order: the first condition it fails names it.
 */
export const IGNORE_REASONS = [
  "phase-baseline",
  "before-start",
  "not-on-head",
  "dirty",
  "command-unknown",
  "digest-mismatch",
  "selector-mismatch",
] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

export interface IgnoredEnvelope {
  /** 1-based line of the envelope in `evidence/TP-<n>.jsonl`. */
  line: number;
  reason: IgnoreReason;
}

export interface ClosureRow {
  id: string;
  kind: TestPlanKind;
  state: RowState;
  reason: string;
  /** A counted envelope has `producer: local`. */
  self_reported: boolean;
  /** A counted envelope has `producer: ci`, whose run is not verified here. */
  ci_unverified: boolean;
  /** How many envelopes count. */
  counted: number;
  ignored: IgnoredEnvelope[];
  /** `stays-green` only: the probe is not decidable from envelopes. */
  probe?: "not-checked";
  /** `red-first` only: the envelope holds no output to check the red reason with. */
  red_reason?: "not-checked";
  /** `measurement`, `manual` and `runtime` only: where the evidence lives (`null` when the row names none). */
  evidence_location?: string | null;
}

export interface ClosureReport {
  format: typeof CLOSURE_FORMAT;
  /** The spec id. */
  spec: string;
  start: string;
  head: string;
  /** The merged spec commit: the last commit on the default branch that changed `spec.md` or `testplan.yaml`. */
  spec_commit: string;
  /** No row is `failed` or `unproven`. */
  ok: boolean;
  rows: ClosureRow[];
  counts: Record<RowState, number>;
  /** TP IDs of well-named evidence files that are no test-plan row. */
  unknown_rows: string[];
}

export interface ClosureRequest {
  /** `--repo`: the trusted checkout root. */
  repo: string;
  /** `--default-ref`: a full ref name of the fetched default branch. */
  defaultRef: string;
  /** `--start`: the full id of the start commit, from the host. */
  start: string;
  /** `--head`: the full id of the commit the work is evaluated at; default the checkout's `HEAD`. */
  head?: string;
}

export type ClosureResult =
  | { ok: true; report: ClosureReport }
  | { ok: false; code: string; message: string };
