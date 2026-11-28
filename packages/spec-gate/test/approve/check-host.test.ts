import { beforeAll, describe, expect, it } from "vitest";
import {
  build,
  check,
  cond,
  failing,
  keep,
  pullRequestOf,
  review,
  type Scenario,
} from "./helpers.js";

const boom = () => {
  throw new Error("token=SECRET https://host.example/api");
};

/** The standard repository: proposed spec at the head, `CONFIG` on the default branch. */
let S: Scenario;

beforeAll(async () => {
  S = keep(await build());
}, 60_000);

describe(
  "condition 6: the host enforces the review",
  { timeout: 60_000 },
  () => {
    it.each([
      [
        "specs/ is not enforced",
        { "specs/": "not-enforced", ".spec-gate/": "enforced" },
      ],
      ["specs/ is unknown", { "specs/": "unknown", ".spec-gate/": "enforced" }],
      [
        ".spec-gate/ is not enforced",
        { "specs/": "enforced", ".spec-gate/": "not-enforced" },
      ],
      [
        ".spec-gate/ is unknown",
        { "specs/": "enforced", ".spec-gate/": "unknown" },
      ],
    ])(
      "%s: approval-not-enforced, an approve is reported and no approval",
      async (_what, enforcement) => {
        const report = await check(S, { enforcement });
        expect(cond(report, 6)).toMatchObject({
          ok: false,
          code: "approval-not-enforced",
        });
        expect(cond(report, 6).message).toContain(
          `specs/: ${enforcement["specs/"]}`,
        );
        expect(cond(report, 6).message).toContain(
          `.spec-gate/: ${enforcement[".spec-gate/"]}`,
        );
        expect(report.approved).toBe(false);
        expect(report.approve_reported).toBe(true);
        expect(failing(report)).toEqual([6]);
      },
    );

    const COULD_NOT_READ =
      "the host could not read whether a review is enforced";
    const POINTER = 'see "Token and permissions" in docs/approve.md';
    const NO_REVIEW = "the host reports no required review";

    it("both paths unknown: the detail says the enforcement could not be read, per path, and points to the permissions", async () => {
      const report = await check(S, { enforcement: "unknown" });
      const message = cond(report, 6).message;
      expect(cond(report, 6).code).toBe("approval-not-enforced");
      expect(message).toContain(`specs/ ${COULD_NOT_READ}`);
      expect(message).toContain(`.spec-gate/ ${COULD_NOT_READ}`);
      expect(message).toContain(POINTER);
      expect(message).not.toContain(NO_REVIEW);
    });

    it("both paths not enforced: the detail says the host reports no required review and nothing about reading", async () => {
      const report = await check(S, { enforcement: "not-enforced" });
      const message = cond(report, 6).message;
      expect(cond(report, 6).code).toBe("approval-not-enforced");
      expect(message).toContain(`specs/ ${NO_REVIEW}`);
      expect(message).toContain(`.spec-gate/ ${NO_REVIEW}`);
      expect(message).not.toContain(COULD_NOT_READ);
      expect(message).not.toContain(POINTER);
    });

    it("one unknown and one not enforced: each phrase is bound to its own path", async () => {
      const report = await check(S, {
        enforcement: { "specs/": "unknown", ".spec-gate/": "not-enforced" },
      });
      const message = cond(report, 6).message;
      expect(message).toContain(`specs/ ${COULD_NOT_READ}`);
      expect(message).toContain(`.spec-gate/ ${NO_REVIEW}`);
      expect(message).not.toContain(`specs/ ${NO_REVIEW}`);
      expect(message).not.toContain(`.spec-gate/ ${COULD_NOT_READ}`);
      const swapped = await check(S, {
        enforcement: { "specs/": "not-enforced", ".spec-gate/": "unknown" },
      });
      expect(cond(swapped, 6).message).toContain(`specs/ ${NO_REVIEW}`);
      expect(cond(swapped, 6).message).toContain(
        `.spec-gate/ ${COULD_NOT_READ}`,
      );
    });

    it("one enforced and one unknown: only the unknown path is explained", async () => {
      const report = await check(S, {
        enforcement: { "specs/": "enforced", ".spec-gate/": "unknown" },
      });
      const message = cond(report, 6).message;
      expect(message).toContain(`.spec-gate/ ${COULD_NOT_READ}`);
      expect(message).not.toContain(`specs/ ${COULD_NOT_READ}`);
      expect(message).not.toContain(NO_REVIEW);
    });

    it("an approve is not reported when no approval stands on the head", async () => {
      const report = await check(S, {
        enforcement: "not-enforced",
        reviews: [review("alice", "APPROVED", S.draft)],
      });
      expect(cond(report, 6).code).toBe("approval-not-enforced");
      expect(report.approve_reported).toBe(false);
    });

    it("the last change under .spec-gate/ is unknown: listed as null, and the condition holds", async () => {
      const report = await check(S, {
        configCommit: { commit: null, approver: null },
      });
      expect(report.last_config_commit).toEqual({
        commit: null,
        approver: null,
      });
      expect(cond(report, 6).ok).toBe(true);
      expect(report.approved).toBe(true);
    });

    it("the last change under .spec-gate/ is listed when the check fails elsewhere, with an unknown approver too", async () => {
      const report = await check(S, {
        reviews: [],
        configCommit: { commit: S.c1, approver: null },
      });
      expect(report.approved).toBe(false);
      expect(report.last_config_commit).toEqual({
        commit: S.c1,
        approver: null,
      });
    });
  },
);

describe(
  "the host fails: host-failed, never a pass",
  { timeout: 60_000 },
  () => {
    const expectFailed = async (
      says: Parameters<typeof check>[1],
      conditions: number[],
    ) => {
      const report = await check(S, says);
      for (const n of conditions) {
        expect(report.conditions[n - 1]).toMatchObject({
          ok: false,
          code: "host-failed",
        });
      }
      expect(failing(report)).toEqual(conditions);
      expect(report.approved).toBe(false);
      expect(JSON.stringify(report)).not.toContain("SECRET");
      expect(JSON.stringify(report)).not.toContain("host.example");
      return report;
    };

    it.each([
      ["throws", boom],
      ["returns a head that is no commit id", { number: 7, head: "pr" }],
    ])("pullRequest %s: conditions 1 and 2", async (_what, pullRequest) => {
      const report = await expectFailed({ pullRequest }, [1, 2]);
      expect(report.pull_request).toBeNull();
      expect(report.approve_reported).toBe(false);
      expect(report.approvals).toEqual([
        {
          login: "alice",
          commit: S.head,
          at_head: true,
          problem: "not-evaluated",
        },
      ]);
    });

    it.each([
      ["throws", boom],
      [
        "returns an entry with a state it does not know",
        () => [
          review("alice", "APPROVED", S.head),
          { ...review("alice", "APPROVED", S.head), state: "PENDING" },
        ],
      ],
    ])("reviews %s: conditions 1, 2 and 3", async (_what, reviews) => {
      const report = await expectFailed({ reviews }, [1, 2, 3]);
      expect(report.approvals).toEqual([]);
      expect(report.approve_reported).toBe(false);
    });

    it.each([
      ["throws for specs/", { "specs/": boom, ".spec-gate/": "enforced" }],
      ["throws for .spec-gate/", { "specs/": "enforced", ".spec-gate/": boom }],
      ["returns another word", () => "ENFORCED"],
    ])("reviewEnforcement %s: condition 6", async (_what, enforcement) => {
      const report = await expectFailed({ enforcement }, [6]);
      // A host that failed is not a host that said "not enforced".
      expect(report.approve_reported).toBe(false);
    });

    it.each([
      ["throws", boom],
      ["returns the word unknown", "unknown"],
    ])(
      "lastConfigCommit %s: condition 6, listed as unknown",
      async (_what, configCommit) => {
        const report = await expectFailed({ configCommit }, [6]);
        expect(report.last_config_commit).toEqual({
          commit: null,
          approver: null,
        });
      },
    );

    it("every method fails: no condition that needs the host holds", async () => {
      const report = await expectFailed(
        {
          pullRequest: boom,
          reviews: boom,
          enforcement: boom,
          configCommit: boom,
        },
        [1, 2, 3, 6],
      );
      expect(report.approve_reported).toBe(false);
      expect(report.pull_request).toBeNull();
    });

    it("the facts of the pull request are the host's: the report shows them as given", async () => {
      const report = await check(S, {
        pullRequest: pullRequestOf(S, { number: 41, author: "Dev" }),
      });
      expect(report.pull_request).toEqual({
        number: 41,
        author: "Dev",
        head: S.head,
        base: S.c1,
        target_ref: "refs/heads/main",
      });
      expect(report.approved).toBe(true);
    });
  },
);
