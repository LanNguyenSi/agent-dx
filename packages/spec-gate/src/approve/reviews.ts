/**
 * Which reviews are approvals that still stand. Pure: a list in, a list out.
 *
 * Per account the latest decisive review counts. `APPROVED`,
 * `CHANGES_REQUESTED` and `DISMISSED` are decisive; `COMMENTED` is not, so a
 * comment after an approval leaves the approval standing, and a later
 * request for changes or a dismissal takes it away. Reviews are ordered by
 * the time the host reports. When an account has several decisive reviews
 * at its latest time, the approval stands only if all of them are approvals
 * of one commit: a tie is never resolved in favour of an approval.
 */
import type { TimedReview } from "./facts.js";
import { accountKey } from "./logins.js";

/** An approval that stands: the account's latest decisive review. */
export interface StandingApproval {
  /** The reviewer's login as the host spelled it in that review. */
  login: string;
  /** The commit the approval was submitted on. */
  commit: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function standingApprovals(
  reviews: readonly TimedReview[],
): StandingApproval[] {
  const byAccount = new Map<string, TimedReview[]>();
  for (const review of reviews) {
    if (review.state === "COMMENTED") continue;
    const key = accountKey(review.login);
    const list = byAccount.get(key) ?? [];
    list.push(review);
    byAccount.set(key, list);
  }
  const standing: StandingApproval[] = [];
  for (const list of byAccount.values()) {
    const latest = list.reduce(
      (max, review) => Math.max(max, review.at),
      -Infinity,
    );
    const last = list.filter((review) => review.at === latest);
    const first = last[0]!;
    if (
      last.every(
        (review) =>
          review.state === "APPROVED" && review.commit === first.commit,
      )
    ) {
      standing.push({ login: first.login, commit: first.commit });
    }
  }
  return standing.sort(
    (a, b) =>
      compareText(accountKey(a.login), accountKey(b.login)) ||
      compareText(a.login, b.login) ||
      compareText(a.commit, b.commit),
  );
}
