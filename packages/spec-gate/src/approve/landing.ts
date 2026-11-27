/**
 * Where a merged pull request landed: the ranges of commits the merged mode
 * of the approval check measures, derived from git and from two facts of
 * the host, the head commit of the pull request and its merge commit.
 * Nothing else goes in: no base commit a caller or the host names, and no
 * text of the pull request.
 *
 * What the merge put on the default branch is the change from the first
 * parent of the merge commit to the merge commit: the first parent is what
 * the branch held before. Whether that range is the whole pull request
 * depends on how it was merged, and git shows two shapes that can be told:
 *
 * - `merge-commit`: the merge commit has two parents, the second is the head
 *   commit of the pull request, and that head was not on the default branch
 *   before. The range from the first parent to the merge commit holds
 *   everything the pull request brought in.
 * - `single-commit`: the merge commit has one parent and the head commit of
 *   the pull request is not in its history, as after a squash merge and
 *   after a rebase merge. A squash merge puts the whole pull request into
 *   that one commit. A rebase merge puts only its last commit there; the
 *   commits before it sit further down the first-parent chain, and git does
 *   not say where they begin. So a second range is measured as well: from
 *   the one merge base of the head commit with the first parent to the head
 *   commit, which is what the reviewed commits change, whichever of them
 *   landed in which commit.
 *
 * Every other shape is `merge-shape-unknown`, and nothing is measured: a
 * head commit that is itself on the default branch without such a merge
 * commit (a fast-forward, a push of the branch), a merge commit with no
 * parent or more than two, and a merge commit whose second parent is not
 * the head. There the first-parent range would leave out commits of the
 * pull request that lie before it.
 */
import type { HostPullRequest } from "../host/index.js";
import { isAncestor, isCommit } from "../lint/git/index.js";
import { commitParents, mergeBases } from "./git.js";
import type { FailureCode, MergeShape } from "./types.js";

/** A range of the merge: what differs between the trees of two commits. */
export interface MergeRange {
  from: string;
  to: string;
}

export interface Landing {
  /** The merge commit the host reports. */
  merge: string;
  /** Its first parent: what the default branch held before it. */
  firstParent: string;
  shape: MergeShape;
  /** `single-commit` only: the one merge base of the head commit and `firstParent`. */
  reviewedBase: string | null;
  /** What is measured: `firstParent` to `merge`, and for `single-commit` also `reviewedBase` to the head commit. */
  ranges: MergeRange[];
}

/** The codes of a landing that could not be derived. */
export type LandingCode = Extract<
  FailureCode,
  | "not-merged"
  | "merge-not-on-default"
  | "head-unavailable"
  | "merge-shape-unknown"
  | "ambiguous-merge-base"
  | "git-failed"
>;

export type LandingResult =
  | { ok: true; landing: Landing }
  | { ok: false; code: LandingCode; message: string };

const no = (code: LandingCode, message: string): LandingResult => ({
  ok: false,
  code,
  message,
});

const NOT_TOLD =
  "where the pull request begins on the default branch cannot be told from git, so nothing is measured";

/**
 * Derives the landing of `pullRequest` on the branch whose tip is
 * `defaultCommit`. A git read that fails is a `LintGitError`; the caller
 * turns it into `git-failed`.
 */
export function landingOf(
  repo: string,
  pullRequest: Pick<HostPullRequest, "head" | "merged" | "mergeCommit">,
  defaultCommit: string,
): LandingResult {
  if (pullRequest.merged !== true) {
    return no(
      "not-merged",
      "the host does not report the pull request as merged; the check after the merge judges a merged pull request only",
    );
  }
  const merge = pullRequest.mergeCommit;
  if (merge === null) {
    return no(
      "merge-not-on-default",
      "the host reports no merge commit for the merged pull request; there is no commit to look for on the default branch",
    );
  }
  if (!isCommit(repo, merge) || !isAncestor(repo, merge, defaultCommit)) {
    return no(
      "merge-not-on-default",
      `the merge commit ${merge} the host reports is not the commit the default ref names or an ancestor of it; the default branch may need to be fetched by the job`,
    );
  }
  const head = pullRequest.head;
  const parents = commitParents(repo, merge);
  if (parents.length === 2 && parents[1] === head) {
    const firstParent = parents[0]!;
    if (isAncestor(repo, head, firstParent)) {
      // The head was on the branch before this commit: what it brought in
      // came in earlier, and the range of this commit would not show it.
      return no(
        "merge-shape-unknown",
        `the head commit of the pull request was on the default branch before its merge commit; ${NOT_TOLD}`,
      );
    }
    return {
      ok: true,
      landing: {
        merge,
        firstParent,
        shape: "merge-commit",
        reviewedBase: null,
        ranges: [{ from: firstParent, to: merge }],
      },
    };
  }
  if (parents.length !== 1) {
    return no(
      "merge-shape-unknown",
      `the merge commit has ${parents.length} parents and is not a merge of the head commit of the pull request into the default branch; ${NOT_TOLD}`,
    );
  }
  const firstParent = parents[0]!;
  if (!isCommit(repo, head)) {
    return no(
      "head-unavailable",
      "the head commit of the pull request is not in the repository; the check never fetches, so the job has to bring that commit in before it runs",
    );
  }
  if (isAncestor(repo, head, merge)) {
    return no(
      "merge-shape-unknown",
      `the head commit of the pull request is on the default branch without a merge commit of its own (a fast-forward, or a push of the branch); ${NOT_TOLD}`,
    );
  }
  const bases = mergeBases(repo, head, firstParent);
  if (bases.length === 0) {
    return no(
      "git-failed",
      "the head commit of the pull request and the default branch share no history; there is no commit to measure the reviewed change from",
    );
  }
  if (bases.length > 1) {
    return no(
      "ambiguous-merge-base",
      `the head commit of the pull request and the first parent of its merge commit have ${bases.length} merge bases; the reviewed change is not measured from one of several`,
    );
  }
  const reviewedBase = bases[0]!;
  return {
    ok: true,
    landing: {
      merge,
      firstParent,
      shape: "single-commit",
      reviewedBase,
      ranges: [
        { from: firstParent, to: merge },
        { from: reviewedBase, to: head },
      ],
    },
  };
}
