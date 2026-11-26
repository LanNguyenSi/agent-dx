import { describe, expect, it } from "vitest";
import { standingApprovals } from "../../src/approve/index.js";
import type { TimedReview } from "../../src/approve/facts.js";
import type { ReviewState } from "../../src/host/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

/** Reviews as the fact reader hands them on: `[login, state, commit, minute]`. */
function timed(
  ...rows: [string, ReviewState, string, number][]
): TimedReview[] {
  return rows.map(([login, state, commit, minute], index) => ({
    login,
    state,
    commit,
    submittedAt: `2024-05-01T10:${String(minute).padStart(2, "0")}:00Z`,
    at: Date.UTC(2024, 4, 1, 10, minute),
    index,
  }));
}

describe("standingApprovals", () => {
  it("an approval stands", () => {
    expect(standingApprovals(timed(["alice", "APPROVED", A, 1]))).toEqual([
      { login: "alice", commit: A },
    ]);
  });

  it("no review, no approval", () => {
    expect(standingApprovals([])).toEqual([]);
  });

  it.each(["CHANGES_REQUESTED", "DISMISSED"] as const)(
    "a later %s of the same account takes the approval away",
    (state) => {
      expect(
        standingApprovals(
          timed(["alice", "APPROVED", A, 1], ["alice", state, A, 2]),
        ),
      ).toEqual([]);
    },
  );

  it("a later COMMENTED leaves the approval standing", () => {
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", A, 1], ["alice", "COMMENTED", A, 2]),
      ),
    ).toEqual([{ login: "alice", commit: A }]);
  });

  it("an approval after a request for changes stands, on the commit of the approval", () => {
    expect(
      standingApprovals(
        timed(
          ["alice", "APPROVED", A, 1],
          ["alice", "CHANGES_REQUESTED", A, 2],
          ["alice", "APPROVED", B, 3],
        ),
      ),
    ).toEqual([{ login: "alice", commit: B }]);
  });

  it("the latest approval names the commit, not an earlier one", () => {
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", B, 1], ["alice", "APPROVED", A, 2]),
      ),
    ).toEqual([{ login: "alice", commit: A }]);
  });

  it("orders by the submission time, not by the position in the list", () => {
    expect(
      standingApprovals(
        timed(
          ["alice", "CHANGES_REQUESTED", A, 5],
          ["alice", "APPROVED", A, 1],
        ),
      ),
    ).toEqual([]);
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", A, 5], ["alice", "DISMISSED", A, 1]),
      ),
    ).toEqual([{ login: "alice", commit: A }]);
  });

  it("the request for changes of one account does not touch the approval of another", () => {
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", A, 1], ["bob", "CHANGES_REQUESTED", A, 2]),
      ),
    ).toEqual([{ login: "alice", commit: A }]);
  });

  it("two spellings of one login are one account", () => {
    expect(
      standingApprovals(
        timed(
          ["Alice", "APPROVED", A, 1],
          ["alice", "CHANGES_REQUESTED", A, 2],
        ),
      ),
    ).toEqual([]);
  });

  it("an app and the user of the same name are two accounts", () => {
    expect(
      standingApprovals(
        timed(
          ["alice", "APPROVED", A, 1],
          ["alice[bot]", "CHANGES_REQUESTED", A, 2],
        ),
      ),
    ).toEqual([{ login: "alice", commit: A }]);
  });

  it("a tie at the latest time is not resolved in favour of the approval", () => {
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", A, 3], ["alice", "DISMISSED", A, 3]),
      ),
    ).toEqual([]);
    expect(
      standingApprovals(
        timed(
          ["alice", "CHANGES_REQUESTED", A, 3],
          ["alice", "APPROVED", A, 3],
        ),
      ),
    ).toEqual([]);
  });

  it("two approvals of different commits at the latest time are no approval; of one commit they are one", () => {
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", A, 3], ["alice", "APPROVED", B, 3]),
      ),
    ).toEqual([]);
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", A, 3], ["alice", "APPROVED", A, 3]),
      ),
    ).toEqual([{ login: "alice", commit: A }]);
  });

  it("a comment at the latest time does not make a tie", () => {
    expect(
      standingApprovals(
        timed(["alice", "APPROVED", A, 3], ["alice", "COMMENTED", A, 3]),
      ),
    ).toEqual([{ login: "alice", commit: A }]);
  });

  it("lists the approvals in a fixed order whatever the order of the reviews", () => {
    const rows: [string, ReviewState, string, number][] = [
      ["zoe", "APPROVED", A, 1],
      ["Bob", "APPROVED", B, 2],
      ["alice", "APPROVED", A, 3],
    ];
    const sorted = [
      { login: "alice", commit: A },
      { login: "Bob", commit: B },
      { login: "zoe", commit: A },
    ];
    expect(standingApprovals(timed(...rows))).toEqual(sorted);
    expect(standingApprovals(timed(...[...rows].reverse()))).toEqual(sorted);
  });
});
