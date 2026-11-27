/**
 * The host adapter: the facts the approval check needs from the place a
 * pull request lives (a code host), as typed values.
 *
 * Every value an adapter returns comes from the host's own event or API:
 * who opened the pull request, which commit a review was submitted on, what
 * the host enforces. Nothing may be taken from text a pull request author
 * writes (title, body, comments, commit messages, labels, branch names
 * other than the target ref the host reports), because that text is the
 * input of the party the check is about.
 *
 * The approval check treats an adapter as a source that can fail: a method
 * that throws, rejects or returns a value outside these types makes the
 * condition that needed it fail (`host-failed`). An adapter therefore never
 * guesses: what it cannot determine it reports as `unknown` where the type
 * has that value, and throws where it has none.
 */

/** The states of a submitted review that the approval check knows. */
export const REVIEW_STATES = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** What the host does about reviews for a path. */
export const ENFORCEMENT_STATES = [
  "enforced",
  "not-enforced",
  "unknown",
] as const;
export type Enforcement = (typeof ENFORCEMENT_STATES)[number];

/** Whether the host itself vouches for a CI run at a ref. */
export const CI_RUN_STATES = ["verified", "unverified", "unknown"] as const;
export type CiRunStatus = (typeof CI_RUN_STATES)[number];

/** The paths whose review enforcement the approval check asks for. */
export const REVIEW_PATHS = ["specs/", ".spec-gate/"] as const;
export type ReviewPath = (typeof REVIEW_PATHS)[number];

/** The pull request under check. */
export interface HostPullRequest {
  /** The number the host gave it. */
  number: number;
  /** The login of the account that opened it. */
  author: string;
  /** The full id of its head commit. */
  head: string;
  /** The full id of its base commit, as the host reports it. */
  base: string;
  /** The full name of the branch it targets on the host: `refs/heads/<branch>`. */
  targetRef: string;
}

/**
 * One submitted review. A review that was never submitted (a pending draft)
 * is not a review and is left out by the adapter.
 */
export interface HostReview {
  /** The login of the reviewer. */
  login: string;
  /** Its state now: a dismissed approval is `DISMISSED`, not `APPROVED`. */
  state: ReviewState;
  /** The full id of the commit the review was submitted on. */
  commit: string;
  /** When it was submitted: an ISO 8601 date-time with `Z` or a numeric offset. */
  submittedAt: string;
}

/**
 * The last commit on the default branch that changed a file under
 * `.spec-gate/`, and who approved the change that brought it in. `null` is
 * "unknown": the host cannot tell, or no such commit exists.
 */
export interface HostConfigCommit {
  /** The full id of that commit, or `null`. */
  commit: string | null;
  /** The login of the approver of that change, or `null`. */
  approver: string | null;
}

export interface HostAdapter {
  /** The pull request the check is about. */
  pullRequest(): Promise<HostPullRequest>;
  /** Every submitted review of the pull request, all pages. */
  reviews(): Promise<HostReview[]>;
  /**
   * Whether a change under `path` cannot be merged into the default branch
   * without an approving review. `enforced` means the host refuses the merge
   * (a branch protection or ruleset that requires the review for that path);
   * a code-owners file that nothing enforces is `not-enforced`.
   */
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  reviewEnforcement(path: ReviewPath): Promise<Enforcement>;
  /** The last change under `.spec-gate/` on the default branch. */
  lastConfigCommit(): Promise<HostConfigCommit>;
  /**
   * Whether the host vouches that `run`, a run of its own CI named by the
   * id or the address the host gave it, ran at `commit` (a full commit id).
   * `verified` only for a run that exists in this repository, has completed
   * and ran at that commit; it says nothing about what the run did or how
   * it ended. The approval check does not call it; the evidence checks do.
   */
  // eslint-disable-next-line no-unused-vars
  ciRunStatus(commit: string, run: string): Promise<CiRunStatus>;
}
