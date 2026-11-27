/**
 * The report of the approval check and the conditions it is made of.
 *
 * The report is deterministic: the same repository state and the same host
 * facts give the same report, key for key. It holds no time, no absolute
 * path and nothing a host adapter threw.
 */
import type { HostAdapter } from "../host/index.js";

export const APPROVE_FORMAT = "spec-gate-approve/1";

/** The conditions of an approval, in report order. */
export const CONDITIONS = [
  {
    condition: 1,
    name: "approval-at-head",
    summary:
      "An approving review stands on the head commit of the pull request, and the checkout is at that commit.",
  },
  {
    condition: 2,
    name: "approver-allowed",
    summary:
      "An approver of the head commit is in `approvers`, is not the pull request author and is not an agent identity; the settings are read at the tip of the default branch and the pull request targets the default branch.",
  },
  {
    condition: 3,
    name: "digest-unchanged",
    summary:
      "The digest of the spec at the head equals the digest at the commit of every approving review considered.",
  },
  {
    condition: 4,
    name: "proposed-and-clean",
    summary:
      "The spec is `proposed` at the head, the spec directory of the work tree is the one the head holds, and the final lint has no error.",
  },
  {
    condition: 5,
    name: "agent-identities-separate",
    summary:
      "`agent_identities` is not empty and shares no account with `approvers`.",
  },
  {
    condition: 6,
    name: "review-enforced",
    summary:
      "The host enforces a review for `specs/` and for `.spec-gate/`, and reports the last change under `.spec-gate/`.",
  },
  {
    condition: 7,
    name: "config-untouched",
    summary:
      "No file under `.spec-gate/` differs between the diff base and the head.",
  },
  {
    condition: 8,
    name: "repo-check-clean",
    summary:
      "The repository check has no finding between the diff base and the head: no protected spec disappears, changes its id, goes back to `draft` or loses its log.",
  },
] as const;

export type ConditionNumber = (typeof CONDITIONS)[number]["condition"];
export type ConditionName = (typeof CONDITIONS)[number]["name"];

/** The code of a condition that holds. */
export const OK_CODE = "ok";

/**
 * Every code a condition that does not hold can carry, with the conditions
 * that use it.
 */
export const FAILURE_CODES = {
  "host-failed": [1, 2, 3, 6],
  "git-failed": [2, 3, 4, 7, 8],
  "head-mismatch": [1],
  "no-approval": [1, 2, 3],
  "approval-stale": [1],
  "config-invalid": [2, 5],
  "target-not-default": [2],
  "base-mismatch": [2],
  "base-not-on-default": [2],
  "head-in-reference": [2],
  "approver-not-qualified": [2],
  "digest-unavailable": [3],
  "review-commit-unavailable": [3],
  "review-digest-unavailable": [3],
  "digest-mismatch": [3],
  "spec-unreadable": [4],
  "status-not-proposed": [4],
  "worktree-not-head": [4],
  "lint-failed": [4],
  "lint-errors": [4],
  "head-moved": [4],
  "approval-not-verifiable": [5],
  "approval-not-enforced": [6],
  "spec-changes-config": [7],
  "repo-check-findings": [8],
  "tree-too-large": [8],
} as const satisfies Record<string, readonly ConditionNumber[]>;

export type FailureCode = keyof typeof FAILURE_CODES;

export interface ConditionResult {
  condition: ConditionNumber;
  name: ConditionName;
  ok: boolean;
  /** `ok`, or the reason the condition does not hold. */
  code: typeof OK_CODE | FailureCode;
  message: string;
}

/** Why an approver does not count. */
export const APPROVER_PROBLEMS = [
  "is-agent",
  "is-author",
  "not-allowlisted",
  "not-evaluated",
] as const;
export type ApproverProblem = (typeof APPROVER_PROBLEMS)[number];

/** One approval that stands: the latest decisive review of an account. */
export interface ReportedApproval {
  login: string;
  commit: string;
  /** Whether `commit` is the head. */
  at_head: boolean;
  /** `null` for an approver that counts. */
  problem: ApproverProblem | null;
}

/** A check the approval does not make; it never changes `approved`. */
export interface Gap {
  code: string;
  message: string;
}

export const GAPS: readonly Gap[] = [
  {
    code: "coldread-not-checked",
    message:
      "the cold-read digest is not compared: no cold-read format exists yet",
  },
];

/** The code of the gap a report carries when `commands` is `null`. */
export const COMMANDS_GAP = "commands-not-resolved";

/** One command a runner may start for the spec, as the set at `commands_ref` has it. */
export interface ReportedCommand {
  name: string;
  /** The argv list, element for element; `{selector}` is left as it is written. */
  argv: string[];
}

export interface ApproveReport {
  format: typeof APPROVE_FORMAT;
  /** The frontmatter `id` at the head, or `null` when `spec.md` does not parse there. */
  spec: string | null;
  /** The spec directory in the repository, `specs/<name>`. */
  path: string;
  /** True only when every condition holds. */
  approved: boolean;
  /**
   * True when an approving review stands on the head but the approval is
   * `approval-not-verifiable` or `approval-not-enforced`: an approve was
   * seen, an approval is not claimed.
   */
  approve_reported: boolean;
  /** The commit that was checked: `HEAD` of the repository. */
  head: string;
  /** The reference commit of the final lint and of the diff base: `base` when given, else `default_commit`. */
  reference: string;
  /** The commit the default ref names: the settings were read there. */
  default_commit: string;
  /** The digest of the spec at the head, or `null` when none exists. */
  digest: string | null;
  /** The pull request as the host reports it, or `null` when the host failed. */
  pull_request: {
    number: number;
    author: string;
    head: string;
    base: string;
    target_ref: string;
  } | null;
  /** Exactly one entry per condition, in order. */
  conditions: ConditionResult[];
  /** Every approval that stands, on the head or not. */
  approvals: ReportedApproval[];
  /**
   * The last change under `.spec-gate/` on the default branch and its
   * approver, as the host reports them; `null` is unknown. A review rule
   * switched on later does not cover an earlier merge, so the reader gets
   * to see who let the current settings in.
   */
  last_config_commit: { commit: string | null; approver: string | null };
  /**
   * The commands the spec at the head refers to, read from git at the
   * `commands_ref` of that spec and sorted by name: every command a
   * test-plan row names, and the command that carries `{selector}` when the
   * set has one. `null` when they cannot be read; `gaps` then holds
   * `commands-not-resolved` with the reason. Never a condition.
   */
  commands: ReportedCommand[] | null;
  gaps: Gap[];
}

export interface ApproveRequest {
  /** The trusted checkout root, as for the lint: never found from the spec directory. */
  repo: string;
  /** The spec directory, `specs/<name>` inside `repo`. */
  specDir: string;
  /** The full name of the ref that holds the default branch in `repo`. */
  defaultRef: string;
  /** The full id of the pull request base commit, when the caller has it. */
  base?: string;
  host: HostAdapter;
}

export type ApproveResult =
  | { kind: "report"; report: ApproveReport }
  /** The inputs cannot be used; no condition was evaluated and nothing is approved. */
  | { kind: "refused"; message: string };
