/**
 * The report of `spec-gate closure` (`spec-gate-closure/1`): for every
 * test-plan row of the merged spec, whether the evidence files in the spec
 * directory prove it at or after the start commit, and why. The field order of every object below is the
 * order of the JSON line.
 */
import type { TestPlanKind } from "../formats/index.js";
import type { CiRunStatus } from "../host/index.js";

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

/**
 * How a counted `producer: ci` envelope is marked after the host was asked
 * about its run, worst first: `unknown` and `unverified` are answers of the
 * host (`CiRunStatus`), `host-failed` is what a host that throws or answers
 * with a value outside `CI_RUN_STATES` is marked as. A row's `ci_status` is
 * the worst status of its counted ci envelopes.
 */
export const CI_STATUSES: readonly CiStatus[] = [
  "host-failed",
  "unknown",
  "unverified",
  "verified",
];
export type CiStatus = "host-failed" | CiRunStatus;

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
  /** A counted envelope has `producer: ci` whose run the host did not vouch for; without a host, any counted `producer: ci` envelope. */
  ci_unverified: boolean;
  /** Only when the host was asked and a `ci` envelope counted, added last: the worst status of the counted ci envelopes. It never changes `state` or `ok`. */
  ci_status?: CiStatus;
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
  /** Only with `--github-repo`, after `spec_commit`: the host the CI runs were checked with; `api_url` is the `--api-url` value, `null` when the adapter's default root was used. */
  host?: { repo: string; api_url: string | null };
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
  /** `--github-repo`: `<owner>/<name>`. With it the run of every counted `producer: ci` envelope is checked with the host; without it nothing is asked and no request is made. */
  githubRepo?: string;
  /** `--api-url`: the API root of the host; only read with `--github-repo`. */
  apiUrl?: string;
  /** How many arguments and options the command line held that the verb does not know. */
  unknownArguments?: number;
}

export type ClosureResult =
  | { ok: true; report: ClosureReport }
  | { ok: false; code: string; message: string };
