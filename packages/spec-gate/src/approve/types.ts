/**
 * The report of the approval check and the conditions it is made of.
 *
 * The report is deterministic: the same repository state and the same host
 * facts give the same report, key for key. It holds no time, no absolute
 * path and nothing a host adapter threw.
 *
 * The check has two modes. In the open mode it judges the head of an open
 * pull request. In the merged mode (`merged: true` in the request) it
 * judges what a merged pull request left on the default branch. The
 * conditions keep their numbers and names in both; `MERGED_SUMMARIES` says
 * what each one asks after the merge.
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
      "No file under `.spec-gate/` differs between the merge base of the head with the default branch and the head.",
  },
  {
    condition: 8,
    name: "repo-check-clean",
    summary:
      "The repository check has no finding between the merge base of the head with the default branch and the head: no protected spec disappears, changes its id, goes back to `draft` or loses its log.",
  },
] as const;

export type ConditionNumber = (typeof CONDITIONS)[number]["condition"];
export type ConditionName = (typeof CONDITIONS)[number]["name"];

/** What each condition asks in the merged mode, by condition number. */
export const MERGED_SUMMARIES: Record<ConditionNumber, string> = {
  1: "The host reports the pull request as merged, and an approving review stands on the head commit the host reports for it.",
  2: "An approver of that head commit is in `approvers`, is not the pull request author and is not an agent identity; the settings are read at the tip of the default branch, the pull request targeted the default branch, its merge commit is on the default branch and no range of the merge changes a path under `.spec-gate/`.",
  3: "The digest of the spec at the tip of the default branch equals the digest at the commit of every approving review considered.",
  4: "The spec is `proposed` at the tip of the default branch, the checkout is at that commit, the spec directory of the work tree is the one it holds, and the final lint has no error.",
  5: "`agent_identities` is not empty and shares no account with `approvers`.",
  6: "The host enforces a review for `specs/` and for `.spec-gate/`, and reports the last change under `.spec-gate/`.",
  7: "No path under `.spec-gate/` differs over a range of the merge.",
  8: "The repository check has no finding over a range of the merge.",
};

/** The modes of the check. */
export const APPROVE_MODES = ["open", "merged"] as const;
export type ApproveMode = (typeof APPROVE_MODES)[number];

/** How a merged pull request reached the default branch, as git shows it. */
export const MERGE_SHAPES = ["merge-commit", "single-commit"] as const;
export type MergeShape = (typeof MERGE_SHAPES)[number];

/** The code of a condition that holds. */
export const OK_CODE = "ok";

/**
 * Every code a condition that does not hold can carry, with the conditions
 * that use it.
 */
export const FAILURE_CODES = {
  "host-failed": [1, 2, 3, 6, 7, 8],
  "git-failed": [2, 3, 4, 7, 8],
  "ambiguous-merge-base": [2, 4, 7, 8],
  "not-merged": [1, 2, 7, 8],
  "merge-not-on-default": [2, 7, 8],
  "head-unavailable": [2, 7, 8],
  "merge-shape-unknown": [2, 7, 8],
  "head-mismatch": [1],
  "no-approval": [1, 2, 3],
  "approval-stale": [1],
  "config-invalid": [2, 5],
  "target-not-default": [2],
  "base-mismatch": [2],
  "base-not-on-default": [2],
  "head-in-reference": [2],
  "config-in-merge": [2],
  "approver-not-qualified": [2],
  "digest-unavailable": [3],
  "review-commit-unavailable": [3],
  "review-digest-unavailable": [3],
  "digest-mismatch": [3],
  "digest-mismatch-after-merge": [3],
  "spec-unreadable": [4],
  "status-not-proposed": [4],
  "checkout-not-default-tip": [4],
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
  /**
   * Whether `commit` is the head: `HEAD` of the checkout in the open mode,
   * the head commit the host reports for the pull request in the merged
   * mode.
   */
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

/**
 * What a merged pull request put on the default branch, as the merged mode
 * measured it.
 */
export interface ReportedMerge {
  /** The merge commit the host reports. */
  commit: string;
  /** Its first parent: what the default branch held before it. */
  first_parent: string;
  shape: MergeShape;
  /**
   * `single-commit` only: the one merge base of the head commit of the pull
   * request and `first_parent`. `null` for `merge-commit`.
   */
  reviewed_base: string | null;
  /** The ranges conditions 2, 7 and 8 measured, each from one commit to another. */
  ranges: { from: string; to: string }[];
}

export interface ApproveReport {
  format: typeof APPROVE_FORMAT;
  /** `merged` when the request asked for the check after the merge. */
  mode: ApproveMode;
  /**
   * The frontmatter `id` at the commit that was judged (the head in the
   * open mode, the tip of the default branch in the merged mode), or `null`
   * when `spec.md` does not parse there.
   */
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
  /**
   * `HEAD` of the repository. In the open mode it is the commit that was
   * judged; in the merged mode that is `default_commit`, and condition 4
   * holds only when the two are the same.
   */
  head: string;
  /**
   * The base commit that is compared with the base the host reports: `base`
   * when given, else `default_commit`. No condition measures from it;
   * conditions 4, 7 and 8 measure from the one merge base of `head` and
   * `default_commit`.
   */
  reference: string;
  /** The commit the default ref names: the settings were read there. */
  default_commit: string;
  /** The digest of the spec at the commit that was judged, or `null` when none exists. */
  digest: string | null;
  /** The pull request as the host reports it, or `null` when the host failed. */
  pull_request: {
    number: number;
    author: string;
    head: string;
    base: string;
    target_ref: string;
  } | null;
  /**
   * The merge as the merged mode measured it. `null` in the open mode, and
   * in the merged mode when it could not be derived; conditions 2, 7 and 8
   * say why.
   */
  merge: ReportedMerge | null;
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
   * The commands the spec at the commit that was judged refers to, read from git at the
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
  /**
   * True for the check after the merge: the pull request must be merged,
   * and what is judged is the spec at the tip of the default branch. No
   * range is taken from `base` then either.
   */
  merged?: boolean;
  host: HostAdapter;
}

export type ApproveResult =
  | { kind: "report"; report: ApproveReport }
  /** The inputs cannot be used; no condition was evaluated and nothing is approved. */
  | { kind: "refused"; message: string };
