/**
 * The check after the merge (`merged: true`): is what a merged pull request
 * left on the default branch the spec that was approved?
 *
 * - The pull request must be merged and its merge commit on the default
 *   branch.
 * - The spec is judged at the tip of the default branch: its digest against
 *   the digest at the commit of the approving review, its status and the
 *   final lint there.
 * - What the pull request changed is measured over the ranges of the merge
 *   (first parent to merge commit; for a squash or rebase merge also the
 *   reviewed commits), never from a base commit.
 * - The settings are read at the tip of the default branch and are trusted
 *   only when no range of the merge wrote under `.spec-gate/`.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVE_FORMAT,
  CONDITIONS,
  FAILURE_CODES,
  checkApproval,
  specDigestAt,
} from "../../src/approve/index.js";
import type { LintOptions } from "../../src/lint/index.js";
import { LintGitError } from "../../src/lint/git/index.js";
import type {
  GitInputs,
  RuleContext,
  RuleFinding,
} from "../../src/lint/types.js";
import { git } from "../canonical/helpers.js";
import { REMOTE_MAIN, SPEC_REL, cloneMain } from "../lint/git-helpers.js";
import { scratch } from "../lint/helpers.js";
import {
  CONFIG,
  CONFIG_ONLY_BOB,
  STALE_OTHER,
  afterMerge,
  build,
  check,
  chainOf,
  checkLanded,
  codes,
  cond,
  crissCross,
  editSpec,
  failing,
  hostFor,
  keepLanded,
  land,
  landedPull,
  otherSpec,
  propose,
  pullRequestOf,
  requestFor,
  review,
  squashEdited,
  squashWithOwnSettings,
  stepsOf,
  type Landed,
} from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** Called instead of `commitParents`; a value other than `undefined` is returned in its place. */
  // eslint-disable-next-line no-unused-vars
  commitParents: undefined as ((commit: string) => unknown) | undefined,
  /** Called instead of `isShallow`; a value other than `undefined` is returned in its place. */
  isShallow: undefined as (() => unknown) | undefined,
  /** Called instead of `mergeBases`; a value other than `undefined` is returned in its place. */
  // eslint-disable-next-line no-unused-vars
  mergeBases: undefined as ((a: string, b: string) => unknown) | undefined,
  /** The options of every run of the final lint. */
  lints: [] as unknown[],
  /** The git inputs of every run of the repository check. */
  repoChecks: [] as unknown[],
  /** Replaces the findings of the `.spec-gate/` rule over one range; `undefined` leaves them. */
  // eslint-disable-next-line no-unused-vars
  configFindings: undefined as ((git: GitInputs) => unknown) | undefined,
}));

vi.mock("../../src/approve/git.js", async (original) => {
  const actual = await original<typeof import("../../src/approve/git.js")>();
  return {
    ...actual,
    commitParents: (repo: string, commit: string) => {
      const instead = seam.commitParents?.(commit);
      return instead === undefined
        ? actual.commitParents(repo, commit)
        : (instead as string[]);
    },
    mergeBases: (repo: string, a: string, b: string) => {
      const instead = seam.mergeBases?.(a, b);
      return instead === undefined
        ? actual.mergeBases(repo, a, b)
        : (instead as string[]);
    },
    isShallow: (repo: string) => {
      const instead = seam.isShallow?.();
      return instead === undefined
        ? actual.isShallow(repo)
        : (instead as boolean);
    },
  };
});

vi.mock("../../src/lint/run.js", async (original) => {
  const actual = await original<typeof import("../../src/lint/run.js")>();
  return {
    ...actual,
    lintSpecDir: (dir: string, options?: LintOptions) => {
      seam.lints.push(options);
      return actual.lintSpecDir(dir, options);
    },
  };
});

vi.mock("../../src/lint/rules/refs.js", async (original) => {
  const actual =
    await original<typeof import("../../src/lint/rules/refs.js")>();
  return {
    ...actual,
    checkSpecChangesConfig: (ctx: RuleContext) => {
      const instead =
        ctx.inputs.spec.state === "absent" && ctx.git !== undefined
          ? seam.configFindings?.(ctx.git)
          : undefined;
      return instead === undefined
        ? actual.checkSpecChangesConfig(ctx)
        : (instead as RuleFinding[]);
    },
  };
});

vi.mock("../../src/repo/index.js", async (original) => {
  const actual = await original<typeof import("../../src/repo/index.js")>();
  return {
    ...actual,
    checkRepository: (git: GitInputs) => {
      seam.repoChecks.push(git);
      return actual.checkRepository(git);
    },
  };
});

beforeEach(() => {
  seam.commitParents = undefined;
  seam.isShallow = undefined;
  seam.mergeBases = undefined;
  seam.lints.length = 0;
  seam.repoChecks.length = 0;
  seam.configFindings = undefined;
});

const ALL_OK = Array(8).fill("ok") as string[];
/** The message of `spec-not-in-merge` when no measured step brings the spec. */
const NO_STEP =
  "no measured step of the default branch brought this spec to the state judged at the tip (proposed, with the digest at the tip): the pull request is not the one that brought it, and its approval is not an approval of this spec";
/** The message of `spec-not-in-merge` when the reviewed commits do not bring the spec. */
const NOT_REVIEWED =
  "the reviewed commits did not bring this spec to the state judged at the tip: at the approved head it is not proposed with the digest at the tip, or at the merge base of that head with the default branch it already was. The approval is not an approval of this spec";
const ONLY_BOB = CONFIG_ONLY_BOB;
const WITH_MALLORY =
  "approvers: [Alice, bob, dev, mallory]\nagent_identities: [Spec-Bot]\n";
const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** The standard pull request, merged each way. */
let MERGE: Landed;
let SQUASH: Landed;
let REBASE: Landed;

beforeAll(async () => {
  MERGE = keepLanded(await land(await build(), "merge-commit"));
  SQUASH = keepLanded(await land(await build(), "squash"));
  REBASE = keepLanded(await land(await build(), "rebase"));
}, 120_000);

/** The parents of `commit` in the repository of `m`, the first one first. */
async function parentsOf(m: Landed, commit: string): Promise<string[]> {
  const line = await git(m.dir, ["rev-list", "--parents", "-n", "1", commit]);
  return line.split(" ").slice(1);
}

describe("approved after the merge", { timeout: 60_000 }, () => {
  it("a merge commit: every condition holds, measured from its first parent", async () => {
    const report = await checkLanded(MERGE);
    expect(codes(report)).toEqual(ALL_OK);
    expect(report.approved).toBe(true);
    expect(report.mode).toBe("merged");
    expect(report.merge).toEqual({
      commit: MERGE.merge,
      first_parent: expect.stringMatching(/^[0-9a-f]{40}$/),
      shape: "merge-commit",
      reviewed_base: null,
      commits: 1,
      ranges: [{ from: report.merge!.first_parent, to: MERGE.merge }],
    });
    const parents = await parentsOf(MERGE, MERGE.merge);
    expect(parents).toHaveLength(2);
    expect(report.merge!.first_parent).toBe(parents[0]);
    expect(parents[1]).toBe(MERGE.head);
  });

  it("a squash merge: the whole report", async () => {
    const host = hostFor(SQUASH, { pullRequest: landedPull(SQUASH) });
    const result = await checkApproval(
      requestFor(SQUASH, host, { merged: true }),
    );
    expect(result).toEqual({
      kind: "report",
      report: {
        format: APPROVE_FORMAT,
        mode: "merged",
        spec: "tiny-valid",
        path: SPEC_REL,
        approved: true,
        approve_reported: false,
        // The checkout is at the tip of the default branch, not at the head
        // of the pull request.
        head: SQUASH.landed,
        reference: SQUASH.landed,
        default_commit: SQUASH.landed,
        digest: expect.stringMatching(SHA256),
        pull_request: {
          number: 7,
          author: "dev",
          head: SQUASH.head,
          base: SQUASH.c1,
          target_ref: "refs/heads/main",
        },
        merge: {
          commit: SQUASH.merge,
          first_parent: expect.stringMatching(/^[0-9a-f]{40}$/),
          shape: "single-commit",
          reviewed_base: SQUASH.c1,
          // The pull request has two commits: two first-parent steps are
          // measured, the squashed commit and the commit before it.
          commits: 2,
          ranges: [
            ...(await stepsOf(SQUASH.dir, SQUASH.merge, 2)),
            { from: SQUASH.c1, to: SQUASH.head },
          ],
        },
        conditions: CONDITIONS.map((c) => ({
          condition: c.condition,
          name: c.name,
          ok: true,
          code: "ok",
          message: expect.any(String),
        })),
        approvals: [
          { login: "alice", commit: SQUASH.head, at_head: true, problem: null },
        ],
        last_config_commit: { commit: SQUASH.c1, approver: "bob" },
        commands: [],
        gaps: [{ code: "coldread-not-checked", message: expect.any(String) }],
      },
    });
    const report = (result as { report: { merge: { first_parent: string } } })
      .report;
    // The first parent is the default branch before the squash: neither the
    // base the host reports nor the head.
    expect(await parentsOf(SQUASH, SQUASH.merge)).toEqual([
      report.merge.first_parent,
    ]);
    expect(report.merge.first_parent).not.toBe(SQUASH.c1);
    expect(report.merge.first_parent).not.toBe(SQUASH.head);
    expect(host.calls).not.toContain("ciRunStatus");
  });

  it("a rebase merge of two commits: both replayed commits and the reviewed commits are measured", async () => {
    const report = await checkLanded(REBASE);
    expect(codes(report)).toEqual(ALL_OK);
    expect(report.approved).toBe(true);
    expect(report.merge).toMatchObject({
      commit: REBASE.merge,
      shape: "single-commit",
      reviewed_base: REBASE.c1,
      commits: 2,
    });
    expect(report.merge!.ranges).toEqual([
      ...(await stepsOf(REBASE.dir, REBASE.merge, 2)),
      { from: REBASE.c1, to: REBASE.head },
    ]);
    expect(report.merge!.ranges[0]!.from).toBe(report.merge!.first_parent);
    // The first parent is the first replayed commit, not the default branch
    // before the pull request.
    expect(report.merge!.first_parent).not.toBe(REBASE.c1);
  });

  it("the messages name the tip of the default branch and the merge", async () => {
    const report = await checkLanded(SQUASH);
    expect(report.conditions.map((c) => c.message)).toEqual([
      "1 approving review stands on the head commit",
      "alice approved the head commit, is in approvers, is not the author and is not an agent identity",
      "the digest at the tip of the default branch equals the digest at the commit of every approving review considered, the spec is proposed at each of them, and the pull request brought the spec to that state",
      "the status at the tip of the default branch is proposed and the final lint has no error",
      "agent_identities is not empty and shares no account with approvers",
      "the host enforces a review for specs/ and .spec-gate/",
      "no file under .spec-gate/ differs over a range of the merge",
      "no protected spec disappears, changes its id, goes back to draft or loses its log over a range of the merge",
    ]);
  });

  it("is deterministic and holds nothing machine-local", async () => {
    const one = JSON.stringify(await checkLanded(SQUASH));
    const two = JSON.stringify(await checkLanded(SQUASH));
    expect(two).toBe(one);
    expect(one).not.toContain(SQUASH.dir);
    expect(one).not.toContain(fs.realpathSync(SQUASH.dir));
  });

  it("every code of a report after the merge is one the table knows for its condition", async () => {
    const report = await check(SQUASH, {}, { merged: true });
    expect(report.approved).toBe(false);
    for (const c of report.conditions) {
      expect(c.ok).toBe(c.code === "ok");
      if (!c.ok) {
        expect(FAILURE_CODES[c.code as keyof typeof FAILURE_CODES]).toContain(
          c.condition,
        );
      }
    }
  });
});

describe("the mode is the caller's word", { timeout: 60_000 }, () => {
  it("without merged, a merged pull request is judged as an open one and is not approved", async () => {
    const report = await check(SQUASH, { pullRequest: landedPull(SQUASH) });
    expect(report.mode).toBe("open");
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(false);
    expect(cond(report, 1)).toMatchObject({ code: "head-mismatch" });
  });

  it("merged: false is the open mode", async () => {
    const report = await check(
      SQUASH,
      { pullRequest: landedPull(SQUASH) },
      { merged: false },
    );
    expect(report.mode).toBe("open");
    expect(cond(report, 1)).toMatchObject({ code: "head-mismatch" });
  });

  it.each([["true"], [1], [null], [{}]])(
    "merged given as %j is refused: a value that only reads as true picks no mode",
    async (merged) => {
      const host = hostFor(SQUASH, { pullRequest: landedPull(SQUASH) });
      const result = await checkApproval(
        requestFor(SQUASH, host, { merged: merged as never }),
      );
      expect(result).toEqual({
        kind: "refused",
        message: "approve-check: merged must be true or false",
      });
      expect(host.calls).toEqual([]);
    },
  );
});

describe("the pull request must be merged", { timeout: 60_000 }, () => {
  it("an open pull request: not-merged, for every condition that needs the merge", async () => {
    const s = await build();
    const report = await check(s, {}, { merged: true });
    for (const condition of [1, 2, 7, 8] as const) {
      expect(cond(report, condition)).toEqual({
        condition,
        name: CONDITIONS[condition - 1]!.name,
        ok: false,
        code: "not-merged",
        message:
          "the host does not report the pull request as merged; the check after the merge judges a merged pull request only",
      });
    }
    // The spec is not on the default branch at all.
    expect(cond(report, 3)).toMatchObject({ code: "digest-unavailable" });
    expect(cond(report, 4)).toMatchObject({ code: "spec-unreadable" });
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(false);
  });

  it("merged false with a merge commit named, as a host names its trial merge: not-merged", async () => {
    const report = await checkLanded(SQUASH, {
      pullRequest: landedPull(SQUASH, { merged: false }),
    });
    expect(failing(report)).toEqual([1, 2, 4, 7, 8]);
    for (const condition of [1, 2, 4, 7, 8] as const) {
      expect(cond(report, condition).code).toBe("not-merged");
    }
    expect(report.approved).toBe(false);
  });

  it("the host does not report the pull request: host-failed, and nothing is measured", async () => {
    const report = await checkLanded(SQUASH, {
      pullRequest: () => {
        throw new Error("token=SECRET");
      },
    });
    expect(failing(report)).toEqual([1, 2, 4, 7, 8]);
    for (const condition of [1, 2, 4, 7, 8] as const) {
      expect(cond(report, condition).code).toBe("host-failed");
    }
    expect(report.merge).toBeNull();
    expect(report.pull_request).toBeNull();
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(seam.repoChecks).toEqual([]);
  });

  it.each([
    ["no merged state", { merged: undefined }],
    ["a merged state as text", { merged: "true" }],
    ["no merge commit field", { mergeCommit: undefined }],
    ["a short merge commit", { mergeCommit: "abc1234" }],
  ])(
    "a pull request with %s is not a fact: host-failed",
    async (_what, over) => {
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, over),
      });
      expect(failing(report)).toEqual([1, 2, 4, 7, 8]);
      expect(cond(report, 2).code).toBe("host-failed");
      expect(report.pull_request).toBeNull();
    },
  );
});

describe(
  "the merge commit must be on the default branch",
  { timeout: 60_000 },
  () => {
    it("the default ref does not hold the merge commit yet: merge-not-on-default", async () => {
      const m = await land(await build(), "squash");
      // The default ref of the checkout is stale: one commit behind.
      const before = await m.repo.sh("rev-parse", `${m.merge}^`);
      await m.repo.setRef(REMOTE_MAIN, before);
      const report = await checkLanded(m);
      for (const condition of [2, 7, 8] as const) {
        expect(cond(report, condition)).toMatchObject({
          ok: false,
          code: "merge-not-on-default",
          message: `the merge commit ${m.merge} the host reports is not the commit the default ref names or an ancestor of it; the default branch may need to be fetched by the job`,
        });
      }
      expect(cond(report, 1)).toMatchObject({ ok: true });
      expect(report.merge).toBeNull();
      expect(report.approved).toBe(false);
    });

    it("the host names a commit of another branch: merge-not-on-default", async () => {
      // The head of the pull request is a commit, and not on the default branch.
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { mergeCommit: SQUASH.head }),
      });
      expect(failing(report)).toEqual([2, 4, 7, 8]);
      expect(cond(report, 7).code).toBe("merge-not-on-default");
      expect(report.approved).toBe(false);
    });

    it("the host names a commit the repository does not have: merge-not-on-default", async () => {
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { mergeCommit: "0".repeat(40) }),
      });
      expect(failing(report)).toEqual([2, 4, 7, 8]);
      expect(cond(report, 2).code).toBe("merge-not-on-default");
    });

    it("merged without a merge commit: merge-not-on-default", async () => {
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { mergeCommit: null }),
      });
      expect(failing(report)).toEqual([2, 4, 7, 8]);
      expect(cond(report, 8)).toMatchObject({
        code: "merge-not-on-default",
        message:
          "the host reports no merge commit for the merged pull request; there is no commit to look for on the default branch",
      });
    });

    it("the host names the second commit of the repository: its first-parent history is shorter than the pull request, merge-shape-unknown", async () => {
      // The settings commit has one parent and the head is not in its
      // history, so it reads as a single commit; three commits lie between
      // the merge base and the head, and one step lies below the commit.
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { mergeCommit: SQUASH.c1 }),
      });
      expect(report.merge).toBeNull();
      for (const condition of [2, 7, 8] as const) {
        expect(cond(report, condition)).toMatchObject({
          ok: false,
          code: "merge-shape-unknown",
          message:
            "the first-parent history of the merge commit holds fewer than the 3 commits of the pull request; where the pull request begins on the default branch cannot be told from git, so nothing is measured",
        });
      }
      expect(report.approved).toBe(false);
    });

    it("the host names a later commit of the default branch, and the steps below it still hold the squash with its own settings: config-in-merge", async () => {
      const m = await afterMerge(await squashWithOwnSettings(), {
        "later.txt": "later\n",
      });
      const honest = await checkLanded(m);
      expect(failing(honest)).toEqual([2, 7]);
      const report = await checkLanded(m, {
        pullRequest: landedPull(m, { mergeCommit: m.landed }),
      });
      // Two commits in the pull request, two steps below the commit the
      // host names: the second one is the squashed commit.
      expect(report.merge!.ranges[1]!.to).toBe(m.merge);
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(report.approved).toBe(false);
    });

    it("the host names a commit so much later that no measured step holds the spec: spec-not-in-merge", async () => {
      let m = await squashWithOwnSettings();
      m = await afterMerge(m, { "later-1.txt": "1\n" });
      m = await afterMerge(m, { "later-2.txt": "2\n" });
      const report = await checkLanded(m, {
        pullRequest: landedPull(m, { mergeCommit: m.landed }),
      });
      // The steps that are measured hold no change of the settings: only
      // that the spec did not land in them refuses the approval.
      expect(cond(report, 2)).toMatchObject({ ok: true });
      expect(cond(report, 7)).toMatchObject({ ok: true });
      expect(cond(report, 3).code).toBe("spec-not-in-merge");
      expect(failing(report)).toEqual([3]);
      expect(report.approved).toBe(false);
    });
  },
);

describe(
  "condition 1 after the merge: the approval stands on the head the host reports",
  { timeout: 60_000 },
  () => {
    it("holds although the checkout is not at that head", async () => {
      const report = await checkLanded(SQUASH);
      expect(report.head).toBe(SQUASH.landed);
      expect(report.head).not.toBe(SQUASH.head);
      expect(cond(report, 1)).toMatchObject({ ok: true, code: "ok" });
      expect(report.approvals).toEqual([
        { login: "alice", commit: SQUASH.head, at_head: true, problem: null },
      ]);
    });

    it("an approval of the commit the checkout is at is not an approval of the head: approval-stale", async () => {
      const report = await checkLanded(SQUASH, {
        reviews: [review("alice", "APPROVED", SQUASH.landed)],
      });
      expect(cond(report, 1)).toMatchObject({
        ok: false,
        code: "approval-stale",
      });
      expect(cond(report, 2)).toMatchObject({ ok: false, code: "no-approval" });
      expect(report.approvals[0]!.at_head).toBe(false);
      expect(report.approved).toBe(false);
    });

    it("the head was pushed after the approval: approval-stale, and the approved commit held a draft", async () => {
      // The approval stands on the draft commit; the head is the propose
      // commit, which changes the status alone, so the digest is the same.
      const report = await checkLanded(SQUASH, {
        reviews: [review("alice", "APPROVED", SQUASH.draft)],
      });
      expect(failing(report)).toEqual([1, 2, 3]);
      expect(cond(report, 1).code).toBe("approval-stale");
      expect(cond(report, 3).code).toBe("review-not-proposed");
      expect(report.approved).toBe(false);
    });

    it("no review: no-approval", async () => {
      const report = await checkLanded(SQUASH, { reviews: [] });
      expect(failing(report)).toEqual([1, 2, 3]);
      expect(codes(report).slice(0, 3)).toEqual([
        "no-approval",
        "no-approval",
        "no-approval",
      ]);
    });
  },
);

describe(
  "condition 2 after the merge: the settings at the tip of the default branch",
  { timeout: 60_000 },
  () => {
    it.each([
      ["without a base commit", false],
      ["with the base commit given, where the approver still was one", true],
    ])(
      "an approver revoked on the default branch after the merge does not count, %s: approver-not-qualified",
      async (_how, withBase) => {
        const m = await afterMerge(await land(await build(), "squash"), {
          ".spec-gate/config.yaml": ONLY_BOB,
        });
        // At the base commit the settings still name alice.
        expect(
          await git(m.dir, ["show", `${m.c1}:.spec-gate/config.yaml`]),
        ).toContain("Alice");
        const report = await checkLanded(m, {}, withBase ? { base: m.c1 } : {});
        expect(report.reference).toBe(withBase ? m.c1 : m.landed);
        expect(report.default_commit).toBe(m.landed);
        expect(cond(report, 2)).toMatchObject({
          ok: false,
          code: "approver-not-qualified",
          message:
            "no approver of the head commit counts: alice (not-allowlisted)",
        });
        expect(failing(report)).toEqual([2]);
        expect(report.approved).toBe(false);
      },
    );

    it("an approver revoked on the default branch after the merge: the change is in no range of the merge", async () => {
      const m = await afterMerge(await land(await build(), "squash"), {
        ".spec-gate/config.yaml": ONLY_BOB,
      });
      const report = await checkLanded(m);
      expect(report.default_commit).toBe(m.landed);
      expect(report.default_commit).not.toBe(m.merge);
      expect(cond(report, 2)).toMatchObject({
        ok: false,
        code: "approver-not-qualified",
        message:
          "no approver of the head commit counts: alice (not-allowlisted)",
      });
      // The change is the default branch's own, after the merge: no range
      // of the merge holds it.
      expect(failing(report)).toEqual([2]);
      expect(report.approved).toBe(false);
    });

    it("an approver added on the default branch after the merge counts: the settings are the tip's", async () => {
      const m = await afterMerge(await land(await build(), "squash"), {
        ".spec-gate/config.yaml": WITH_MALLORY,
      });
      const report = await checkLanded(m, {
        reviews: [review("mallory", "APPROVED", m.head)],
      });
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
    });

    it("the author and an agent identity do not count after the merge either", async () => {
      const report = await checkLanded(SQUASH, {
        reviews: [
          review("dev", "APPROVED", SQUASH.head, 1),
          review("spec-bot[bot]", "APPROVED", SQUASH.head, 2),
        ],
      });
      expect(cond(report, 2)).toMatchObject({
        ok: false,
        code: "approver-not-qualified",
      });
      expect(report.approvals.map((a) => a.problem)).toEqual([
        "is-author",
        "is-agent",
      ]);
      expect(failing(report)).toEqual([2]);
    });

    it("a pull request into another branch: target-not-default", async () => {
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { targetRef: "refs/heads/release" }),
      });
      expect(failing(report)).toEqual([2]);
      expect(cond(report, 2).code).toBe("target-not-default");
    });
  },
);

describe(
  "a merge that carries its own change to the settings",
  { timeout: 60_000 },
  () => {
    it.each([
      ["with the base commit given", true],
      ["without a base commit", false],
    ])(
      "a squash that puts the settings back to their text at the base the host reports, %s: not approved",
      async (_how, withBase) => {
        const m = await squashWithOwnSettings();
        const report = await checkLanded(m, {}, withBase ? { base: m.c1 } : {});
        // Read at the tip, the settings name alice again; they are the
        // merge's own and are not trusted.
        expect(report.approvals[0]!.problem).toBeNull();
        expect(cond(report, 2)).toEqual({
          condition: 2,
          name: "approver-allowed",
          ok: false,
          code: "config-in-merge",
          message:
            "1 path under .spec-gate/ changed over a range of the merge: the settings at the tip of the default branch may be the pull request's own, and who may approve is not taken from them",
        });
        expect(cond(report, 7)).toEqual({
          condition: 7,
          name: "config-untouched",
          ok: false,
          code: "spec-changes-config",
          message:
            "1 path under .spec-gate/ changed over a range of the merge; a change there is a pull request of its own",
        });
        expect(failing(report)).toEqual([2, 7]);
        expect(report.approved).toBe(false);
        // Nothing differs between the base the host reports and the merge
        // commit, and nothing between the reviewed base and the head: of
        // the measured ranges only the step of the squashed commit shows
        // the change.
        expect(report.merge!.commits).toBe(2);
        const changedOver = (range: { from: string; to: string }) =>
          git(m.dir, [
            "diff",
            "--name-only",
            range.from,
            range.to,
            "--",
            ".spec-gate",
          ]);
        expect(await changedOver({ from: m.c1, to: m.merge })).toBe("");
        expect(
          await Promise.all(report.merge!.ranges.map(changedOver)),
        ).toEqual([".spec-gate/config.yaml", "", ""]);
        expect(report.pull_request!.base).toBe(m.c1);
        expect(report.merge!.reviewed_base).toBe(m.c1);
        expect(report.reference).toBe(withBase ? m.c1 : m.landed);
      },
    );

    it("a squash of a head that names its own approver: not approved, by both ranges", async () => {
      const s = await build();
      await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "let me in",
      );
      const m = await land(s, "squash");
      const report = await checkLanded(m, {
        reviews: [review("mallory", "APPROVED", m.head)],
      });
      expect(report.approvals[0]!.problem).toBeNull();
      expect(cond(report, 2).code).toBe("config-in-merge");
      // One path, although two ranges show it.
      expect(cond(report, 7).message).toBe(
        "1 path under .spec-gate/ changed over a range of the merge; a change there is a pull request of its own",
      );
      expect(failing(report)).toEqual([2, 7]);
    });

    it("a rebase merge whose earlier commit names its own approver: the last commit is clean, an earlier step and the reviewed commits are not", async () => {
      const s = await build();
      await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "let me in",
      );
      await s.repo.commit({ "notes.txt": "a last commit\n" }, "notes");
      const m = await land(s, "rebase");
      const report = await checkLanded(m, {
        reviews: [review("mallory", "APPROVED", m.head)],
      });
      // The range of the merge commit alone holds no change of the settings.
      expect(report.merge!.commits).toBe(4);
      expect(report.merge!.ranges).toHaveLength(5);
      const last = report.merge!.ranges[0];
      const reviewed = report.merge!.ranges.at(-1);
      expect(last).toEqual({ from: report.merge!.first_parent, to: m.merge });
      expect(reviewed).toEqual({ from: m.c1, to: m.head });
      expect(await m.repo.sh("diff", "--name-only", last!.from, last!.to)).toBe(
        "notes.txt",
      );
      expect(report.approvals[0]!.problem).toBeNull();
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(cond(report, 7).code).toBe("spec-changes-config");
      expect(failing(report)).toEqual([2, 7]);
      expect(report.approved).toBe(false);
    });

    it("a head that changes the settings, squashed into a commit that does not carry the change: the reviewed commits changed them, not approved", async () => {
      const s = await build();
      await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "let me in",
      );
      const head = await s.repo.head();
      await s.repo.checkout("main");
      for (const n of [1, 2, 3]) {
        await s.repo.commit({ [`elsewhere-${n}.txt`]: "x\n" }, "elsewhere");
      }
      await s.repo.sh("merge", "-q", "--squash", "pr");
      const merge = await s.repo.commit(
        { ".spec-gate/config.yaml": CONFIG },
        "squash pr",
      );
      await s.repo.setRef(REMOTE_MAIN, merge);
      const report = await checkLanded({ ...s, head, merge, landed: merge });
      const changed = await Promise.all(
        report.merge!.ranges.map((range) =>
          git(s.dir, [
            "diff",
            "--name-only",
            range.from,
            range.to,
            "--",
            ".spec-gate",
          ]),
        ),
      );
      // No first-parent step changes the settings; the reviewed range does.
      expect(changed).toEqual(["", "", "", ".spec-gate/config.yaml"]);
      expect(failing(report)).toEqual([2, 7]);
      expect(cond(report, 7).code).toBe("spec-changes-config");
    });

    it("a merge commit that changes the settings in the merge itself: not approved", async () => {
      const s = await build();
      await s.repo.checkout("main");
      await s.repo.commit({ "elsewhere.txt": "main moved on\n" }, "elsewhere");
      await s.repo.sh("merge", "-q", "--no-ff", "--no-commit", "pr");
      const merge = await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "merge pr",
      );
      await s.repo.setRef(REMOTE_MAIN, merge);
      const m: Landed = { ...s, merge, landed: merge };
      const report = await checkLanded(m, {
        reviews: [review("mallory", "APPROVED", m.head)],
      });
      expect(report.merge!.shape).toBe("merge-commit");
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(cond(report, 7).code).toBe("spec-changes-config");
      expect(failing(report)).toEqual([2, 7]);
    });

    it("a merge commit of a head that changes the settings: not approved", async () => {
      const s = await build();
      await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "let me in",
      );
      const m = await land(s, "merge-commit");
      const report = await checkLanded(m, {
        reviews: [review("mallory", "APPROVED", m.head)],
      });
      expect(failing(report)).toEqual([2, 7]);
      expect(cond(report, 2).code).toBe("config-in-merge");
    });

    it("a change of the settings the default branch made before the merge is not the pull request's: approved", async () => {
      const s = await build();
      await s.repo.checkout("main");
      await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "the default branch adds an approver",
      );
      const m = await land(s, "squash");
      const report = await checkLanded(m, {}, { base: m.c1 });
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
    });
  },
);

describe(
  "condition 3 after the merge: the digest at the tip of the default branch",
  { timeout: 60_000 },
  () => {
    it("a squash that changed the normative layer after the approval: digest-mismatch-after-merge, naming both", async () => {
      const m = await squashEdited();
      const approved = specDigestAt(m.dir, m.head, SPEC_REL)!;
      const report = await checkLanded(m);
      expect(report.digest).toMatch(SHA256);
      expect(report.digest).not.toBe(approved);
      expect(cond(report, 3)).toEqual({
        condition: 3,
        name: "digest-unchanged",
        ok: false,
        code: "digest-mismatch-after-merge",
        message: `the digest ${report.digest!} at the tip of the default branch ${m.landed} differs from the digest ${approved} at the commit ${m.head} of an approving review: what is on the default branch is not what was approved`,
      });
      expect(failing(report)).toContain(3);
      expect(report.approved).toBe(false);
    });

    it("a later commit of the default branch that changes the spec: digest-mismatch-after-merge", async () => {
      const merged = await land(await build(), "squash");
      const before = (await checkLanded(merged)).digest!;
      editSpec(merged.dir);
      const m = await afterMerge(
        merged,
        {},
        "the spec changes after the merge",
      );
      const report = await checkLanded(m);
      expect(report.default_commit).toBe(m.landed);
      expect(report.digest).not.toBe(before);
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "digest-mismatch-after-merge",
      });
      expect(cond(report, 3).message).toContain(before);
      expect(cond(report, 3).message).toContain(report.digest!);
      expect(cond(report, 3).message).toContain(m.landed);
      expect(cond(report, 3).message).toContain(m.head);
      expect(report.approved).toBe(false);
    });

    it("the same, with the checkout left at the merge commit: the digest is still the one at the default ref", async () => {
      const merged = await land(await build(), "squash");
      editSpec(merged.dir);
      const m = await afterMerge(
        merged,
        {},
        "the spec changes after the merge",
      );
      await m.repo.sh("checkout", "-q", "--detach", m.merge);
      const report = await checkLanded(m);
      expect(report.head).toBe(m.merge);
      expect(report.default_commit).toBe(m.landed);
      // At the merge commit the digest is the approved one; the check does
      // not read it there.
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "digest-mismatch-after-merge",
      });
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "checkout-not-default-tip",
      });
      expect(failing(report)).toEqual([3, 4]);
    });

    it("the commit of the approving review is not in the repository: review-commit-unavailable, and the head is unavailable", async () => {
      const m = await land(await build(), "squash");
      const clone = await cloneMain(m.repo);
      const report = await checkLanded({
        ...m,
        dir: clone,
        spec: path.join(clone, SPEC_REL),
      });
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "review-commit-unavailable",
      });
      for (const condition of [2, 4, 7, 8] as const) {
        expect(cond(report, condition)).toMatchObject({
          ok: false,
          code: "head-unavailable",
          message:
            "the head commit of the pull request is not in the repository; the check never fetches, so the job has to bring that commit in before it runs",
        });
      }
      expect(failing(report)).toEqual([2, 3, 4, 7, 8]);
    });

    it("an approval of an older commit with another digest: the mismatch names that commit", async () => {
      // The reviewed commit is the settings commit of the default branch,
      // which holds no spec: no digest exists there.
      const report = await checkLanded(SQUASH, {
        reviews: [review("alice", "APPROVED", SQUASH.c1)],
      });
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "review-digest-unavailable",
      });
      expect(cond(report, 1).code).toBe("approval-stale");
    });
  },
);

describe(
  "condition 4 after the merge: the tip of the default branch",
  { timeout: 60_000 },
  () => {
    it("the checkout is at the head of the pull request, not at the tip: checkout-not-default-tip", async () => {
      const m = await land(await build(), "squash");
      await m.repo.sh("checkout", "-q", "--detach", m.head);
      // Building the scenario proposed the spec, which lints too.
      seam.lints.length = 0;
      const report = await checkLanded(m);
      expect(report.head).toBe(m.head);
      expect(cond(report, 4)).toEqual({
        condition: 4,
        name: "proposed-and-clean",
        ok: false,
        code: "checkout-not-default-tip",
        message:
          "the checkout is not at the commit the default ref names; after the merge the check judges the tip of the default branch and the lint reads the checkout",
      });
      expect(failing(report)).toEqual([4]);
      expect(report.approved).toBe(false);
      expect(seam.lints).toEqual([]);
    });

    it("a file of the spec directory edited in the work tree: worktree-not-head, named for the tip", async () => {
      const m = await land(await build(), "squash");
      fs.appendFileSync(path.join(m.spec, "spec.md"), "\n");
      const report = await checkLanded(m);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "worktree-not-head",
        message:
          "the spec directory of the work tree is not, byte for byte, the one the tip of the default branch holds; the lint would judge other files",
      });
      expect(failing(report)).toEqual([4]);
    });

    it("the spec went back to draft on the default branch after the merge: status-not-proposed", async () => {
      const merged = await land(await build(), "squash");
      const file = path.join(merged.spec, "spec.md");
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace(/^status: proposed$/m, "status: draft"),
      );
      const m = await afterMerge(merged, {}, "back to draft");
      const report = await checkLanded(m);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "status-not-proposed",
        message:
          "the status at the tip of the default branch is draft; only a proposed spec is approved",
      });
      expect(report.approved).toBe(false);
    });

    it("the spec was reverted on the default branch after the merge: the check refuses, there is no spec directory", async () => {
      const merged = await land(await build(), "squash");
      await merged.repo.sh("revert", "--no-edit", merged.merge);
      const landed = await merged.repo.head();
      await merged.repo.setRef(REMOTE_MAIN, landed);
      const m: Landed = { ...merged, landed };
      const result = await checkApproval(
        requestFor(m, hostFor(m, { pullRequest: landedPull(m) }), {
          merged: true,
        }),
      );
      expect(result).toEqual({
        kind: "refused",
        message: "approve-check: the spec directory is not a directory",
      });
    });

    it("the lint is given the repository and the default ref, with and without a base commit, and no range starts at the base", async () => {
      for (const over of [{}, { base: SQUASH.c1 }]) {
        seam.lints.length = 0;
        seam.repoChecks.length = 0;
        const report = await checkLanded(SQUASH, {}, over);
        expect(report.approved).toBe(true);
        expect(seam.lints).toEqual([
          { final: true, git: { repo: SQUASH.dir, defaultRef: REMOTE_MAIN } },
        ]);
        const ranges = (seam.repoChecks as GitInputs[]).map((git) => ({
          from: git.diffBase,
          to: git.head,
        }));
        expect(ranges).toEqual(report.merge!.ranges);
        expect(ranges[0]!.from).not.toBe(SQUASH.c1);
        for (const git of seam.repoChecks as GitInputs[]) {
          expect(git.reference).toBe(SQUASH.landed);
        }
      }
    });

    it("with a base commit given, the report differs in reference alone", async () => {
      const without = await checkLanded(SQUASH);
      const withBase = await checkLanded(SQUASH, {}, { base: SQUASH.c1 });
      expect(withBase.reference).toBe(SQUASH.c1);
      expect({ ...withBase, reference: without.reference }).toEqual(without);
    });

    it("a base commit that is not the one the host reports: base-mismatch, as before the merge", async () => {
      const report = await checkLanded(
        SQUASH,
        { pullRequest: landedPull(SQUASH, { base: SQUASH.landed }) },
        { base: SQUASH.c1 },
      );
      expect(failing(report)).toEqual([2]);
      expect(cond(report, 2).code).toBe("base-mismatch");
    });
  },
);

describe("condition 8 after the merge", { timeout: 60_000 }, () => {
  it("a squash that deletes another proposed spec: one finding, though both ranges show it", async () => {
    const s = await build({ merged: { [STALE_OTHER]: otherSpec("other") } });
    await s.repo.commit({ [STALE_OTHER]: null }, "delete a spec");
    const m = await land(s, "squash");
    const report = await checkLanded(m);
    expect(cond(report, 8)).toEqual({
      condition: 8,
      name: "repo-check-clean",
      ok: false,
      code: "repo-check-findings",
      message: `the repository check reports 1 finding: spec-removed ${JSON.stringify(STALE_OTHER)}`,
    });
    expect(failing(report)).toEqual([8]);
    expect(report.approved).toBe(false);
  });

  it("a rebase merge whose earlier commit deletes another proposed spec: found over the reviewed commits", async () => {
    const s = await build({ merged: { [STALE_OTHER]: otherSpec("other") } });
    await s.repo.commit({ [STALE_OTHER]: null }, "delete a spec");
    await s.repo.commit({ "notes.txt": "a last commit\n" }, "notes");
    const m = await land(s, "rebase");
    seam.repoChecks.length = 0;
    const report = await checkLanded(m);
    // Four commits in the pull request: four steps and the reviewed range.
    expect(seam.repoChecks).toHaveLength(5);
    expect(cond(report, 8)).toMatchObject({
      ok: false,
      code: "repo-check-findings",
    });
    expect(failing(report)).toEqual([8]);
  });

  it("a squash that deletes a spec the head never touched: found over the merge commit", async () => {
    const s = await build({ merged: { [STALE_OTHER]: otherSpec("other") } });
    await s.repo.checkout("main");
    await s.repo.commit({ "elsewhere.txt": "main moved on\n" }, "elsewhere");
    await s.repo.sh("merge", "-q", "--squash", "pr");
    const merge = await s.repo.commit({ [STALE_OTHER]: null }, "squash pr");
    await s.repo.setRef(REMOTE_MAIN, merge);
    const report = await checkLanded({ ...s, merge, landed: merge });
    expect(cond(report, 8).code).toBe("repo-check-findings");
    expect(failing(report)).toEqual([8]);
  });

  it("findings of two ranges are listed in the order of the repository check, each once", async () => {
    const A = "specs/a-first/spec.md";
    const Z = "specs/z-last/spec.md";
    const s = await build({
      merged: { [A]: otherSpec("a-first"), [Z]: otherSpec("z-last") },
    });
    // The reviewed commits delete both; the last commit alone deletes the
    // one that sorts last, so the range of the merge commit names it first.
    await s.repo.commit({ [A]: null }, "delete a spec");
    await s.repo.commit({ [Z]: null }, "delete another spec");
    const m = await land(s, "rebase");
    seam.repoChecks.length = 0;
    const report = await checkLanded(m);
    expect((seam.repoChecks as GitInputs[]).map((range) => range.head)).toEqual(
      [...(await chainOf(m.dir, m.merge, 4)), m.head],
    );
    expect(cond(report, 8).message).toBe(
      `the repository check reports 2 findings: spec-removed ${JSON.stringify(A)}, spec-removed ${JSON.stringify(Z)}`,
    );
    expect(failing(report)).toEqual([8]);
  });

  it("a spec the default branch deleted itself after the merge is not the pull request's: approved", async () => {
    const s = await build({ merged: { [STALE_OTHER]: otherSpec("other") } });
    const m = await afterMerge(await land(s, "squash"), {
      [STALE_OTHER]: null,
    });
    const report = await checkLanded(m);
    expect(codes(report)).toEqual(ALL_OK);
  });
});

describe("a shape git cannot tell", { timeout: 60_000 }, () => {
  it("the default branch was moved to the head by fast-forward: merge-shape-unknown, though the head names its own approver in an earlier commit", async () => {
    const s = await build();
    await s.repo.commit(
      { ".spec-gate/config.yaml": WITH_MALLORY },
      "let me in",
    );
    const head = await s.repo.commit({ "notes.txt": "last\n" }, "notes");
    await s.repo.setRef(REMOTE_MAIN, head);
    const m: Landed = { ...s, head, merge: head, landed: head };
    const report = await checkLanded(m, {
      reviews: [review("mallory", "APPROVED", head)],
    });
    // The first parent of the head would show a clean range.
    expect(report.approvals[0]!.problem).toBeNull();
    for (const condition of [2, 4, 7, 8] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "merge-shape-unknown",
        message:
          "the head commit of the pull request is on the default branch without a merge commit of its own (a fast-forward, or a push of the branch); where the pull request begins on the default branch cannot be told from git, so nothing is measured",
      });
    }
    expect(failing(report)).toEqual([2, 4, 7, 8]);
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(false);
  });

  it("two merge bases of the head and the first parent of a squash: ambiguous-merge-base, and nothing is measured", async () => {
    const m = await land(await crissCross("config-restored", "side"), "squash");
    seam.repoChecks.length = 0;
    const report = await checkLanded(m);
    for (const condition of [2, 7, 8] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "ambiguous-merge-base",
        message:
          "the head commit of the pull request and the first parent of its merge commit have 2 merge bases; the reviewed change is not measured from one of several",
      });
    }
    expect(report.merge).toBeNull();
    expect(seam.repoChecks).toEqual([]);
    expect(report.approved).toBe(false);
  });

  it("a shallow clone that ends at the merge commit: the commit shows no parents, and nothing is approved", async () => {
    const m = await land(await build(), "squash");
    const clone = path.join(scratch(), "shallow");
    await git(scratch(), [
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      "main",
      `file://${m.dir}`,
      clone,
    ]);
    expect(await git(clone, ["rev-parse", "--is-shallow-repository"])).toBe(
      "true",
    );
    const report = await checkLanded({
      ...m,
      dir: clone,
      spec: path.join(clone, SPEC_REL),
    });
    expect(report.head).toBe(m.landed);
    for (const condition of [2, 4, 7, 8] as const) {
      expect(cond(report, condition)).toEqual({
        condition,
        name: CONDITIONS[condition - 1]!.name,
        ok: false,
        code: "shallow-repository",
        message:
          "the repository is shallow: its history ends at a boundary, where a commit shows no parents and a merge base can be older than the true one. Nothing is measured in it; the job must check out the full history",
      });
    }
    expect(failing(report)).toEqual([2, 3, 4, 7, 8]);
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(false);
    expect(seam.repoChecks).toEqual([]);
  });

  it("a shallow clone that holds the merge commit, its parents and the head of the pull request: refused all the same", async () => {
    const m = await land(await build(), "squash");
    const clone = path.join(scratch(), "shallow");
    await git(scratch(), [
      "clone",
      "-q",
      "--depth",
      "8",
      "--branch",
      "main",
      `file://${m.dir}`,
      clone,
    ]);
    await git(clone, [
      "fetch",
      "-q",
      "--depth",
      "3",
      "origin",
      "pr:refs/remotes/origin/pr",
    ]);
    expect(await git(clone, ["rev-parse", "--is-shallow-repository"])).toBe(
      "true",
    );
    // The head, the first parent and a merge base are all there.
    expect(await git(clone, ["cat-file", "-t", m.head])).toBe("commit");
    expect(await git(clone, ["merge-base", m.head, `${m.merge}~1`])).toMatch(
      /^[0-9a-f]{40}$/,
    );
    const report = await checkLanded({
      ...m,
      dir: clone,
      spec: path.join(clone, SPEC_REL),
    });
    for (const condition of [2, 4, 7, 8] as const) {
      expect(cond(report, condition).code).toBe("shallow-repository");
    }
    expect(failing(report)).toEqual([2, 4, 7, 8]);
    // Nothing is derived in a shallow history, although it could be here.
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(false);
  });

  it("the open mode refuses a shallow repository as well, for every condition that reads ancestry", async () => {
    const s = await build();
    const clone = path.join(scratch(), "shallow");
    await git(scratch(), [
      "clone",
      "-q",
      "--depth",
      "3",
      "--branch",
      "pr",
      `file://${s.dir}`,
      clone,
    ]);
    await git(clone, ["update-ref", REMOTE_MAIN, s.c1]);
    expect(await git(clone, ["rev-parse", "--is-shallow-repository"])).toBe(
      "true",
    );
    const report = await check({
      ...s,
      dir: clone,
      spec: path.join(clone, SPEC_REL),
    });
    expect(report.mode).toBe("open");
    for (const condition of [2, 4, 7, 8] as const) {
      expect(cond(report, condition).code).toBe("shallow-repository");
    }
    expect(failing(report)).toEqual([2, 4, 7, 8]);
    expect(report.approved).toBe(false);
    // The same commits in the full repository are approved.
    expect((await check(s)).approved).toBe(true);
  });

  it("git cannot say whether the repository is shallow: git-failed, in both modes", async () => {
    seam.isShallow = () => {
      throw new LintGitError("git-failed", "git could not be run");
    };
    const merged = await checkLanded(SQUASH);
    const s = await build();
    const open = await check(s);
    for (const report of [merged, open]) {
      for (const condition of [2, 4, 7, 8] as const) {
        expect(cond(report, condition)).toMatchObject({
          ok: false,
          code: "git-failed",
          message:
            "the repository could not be read (git-failed); whether its history is complete is not known",
        });
      }
      expect(report.approved).toBe(false);
    }
    seam.isShallow = () => {
      throw new TypeError("a bug");
    };
    await expect(checkLanded(SQUASH)).rejects.toThrow("a bug");
  });

  it("a range that could not be compared: git-failed for conditions 2 and 7, and the settings are not trusted", async () => {
    // The comparison over the reviewed commits fails; the one over the
    // merge commit shows nothing.
    seam.configFindings = (range) =>
      range.head === SQUASH.head
        ? [
            {
              file: "repo:.spec-gate",
              path: "$",
              code: "git-failed",
              message: "x",
            },
          ]
        : undefined;
    const report = await checkLanded(SQUASH);
    for (const condition of [2, 7] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "git-failed",
        message:
          "the repository could not be read; the change under .spec-gate/ is not verified",
      });
    }
    expect(failing(report)).toEqual([2, 7]);
    expect(report.approved).toBe(false);
  });

  it("a failed comparison beside a changed path is git-failed, not a count of paths", async () => {
    seam.configFindings = (range) =>
      range.head === SQUASH.head
        ? [
            {
              file: "repo:.spec-gate",
              path: "$",
              code: "git-failed",
              message: "x",
            },
          ]
        : [
            {
              file: "repo:.spec-gate/a",
              path: "$",
              code: "spec-changes-config",
              message: "x",
            },
          ];
    const report = await checkLanded(SQUASH);
    expect(cond(report, 2).code).toBe("git-failed");
    expect(cond(report, 7).code).toBe("git-failed");
  });

  it("a read of the parents that fails: git-failed, never a pass", async () => {
    seam.commitParents = () => {
      throw new LintGitError("git-failed", "git could not be run");
    };
    const report = await checkLanded(SQUASH);
    for (const condition of [2, 4, 7, 8] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "git-failed",
        message:
          "the repository could not be read (git-failed); where the pull request landed is not known and nothing is measured from a guess",
      });
    }
    expect(failing(report)).toEqual([2, 4, 7, 8]);
    expect(report.merge).toBeNull();
  });

  it("an error that is no git error is not swallowed", async () => {
    seam.commitParents = () => {
      throw new TypeError("a bug");
    };
    await expect(checkLanded(SQUASH)).rejects.toThrow("a bug");
  });
});

describe(
  "a pull request of several commits, squashed or replayed",
  { timeout: 120_000 },
  () => {
    /** The settings change under `.spec-gate/` over `range` of `dir`, as path names. */
    const settingsDiff = (dir: string, range: { from: string; to: string }) =>
      git(dir, [
        "diff",
        "--name-only",
        range.from,
        range.to,
        "--",
        ".spec-gate",
      ]);

    it("a rebase merge whose commits repeat a change of the default branch and then undo it: the replay undoes it on the default branch, not approved", async () => {
      const s = await build();
      await s.repo.checkout("main");
      await s.repo.commit(
        { ".spec-gate/config.yaml": ONLY_BOB },
        "alice and dev are no approvers any more",
      );
      await s.repo.checkout("pr");
      await s.repo.commit(
        { ".spec-gate/config.yaml": ONLY_BOB },
        "sync settings from main",
      );
      await s.repo.commit(
        { ".spec-gate/config.yaml": CONFIG },
        "undo the sync",
      );
      await s.repo.commit({ "notes.txt": "a last commit\n" }, "notes");
      const m = await land(s, "rebase");
      // The replay put the revoked approver back on the default branch.
      expect(
        await git(m.dir, ["show", `${m.landed}:.spec-gate/config.yaml`]),
      ).toContain("Alice");
      const report = await checkLanded(m);
      expect(report.approvals[0]!.problem).toBeNull();
      // Neither the last replayed commit nor the reviewed commits as a
      // whole show a change of the settings: a step in between does.
      const ranges = report.merge!.ranges;
      expect(report.merge!.commits).toBe(5);
      expect(ranges).toHaveLength(6);
      expect(await settingsDiff(m.dir, ranges[0]!)).toBe("");
      expect(await settingsDiff(m.dir, ranges.at(-1)!)).toBe("");
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(cond(report, 7)).toMatchObject({
        ok: false,
        code: "spec-changes-config",
        message:
          "1 path under .spec-gate/ changed over a range of the merge; a change there is a pull request of its own",
      });
      expect(failing(report)).toEqual([2, 7]);
      expect(report.approved).toBe(false);
    });

    it("the same when no commit becomes empty in the replay: not approved", async () => {
      const s = await build();
      await s.repo.checkout("main");
      await s.repo.commit(
        { ".spec-gate/config.yaml": ONLY_BOB },
        "alice and dev are no approvers any more",
      );
      await s.repo.checkout("pr");
      await s.repo.commit(
        { ".spec-gate/config.yaml": ONLY_BOB, "notes0.txt": "zero\n" },
        "sync settings, first notes",
      );
      await s.repo.commit(
        { ".spec-gate/config.yaml": CONFIG, "notes1.txt": "one\n" },
        "more notes",
      );
      await s.repo.commit({ "notes.txt": "a last commit\n" }, "notes");
      const m = await land(s, "rebase");
      expect(
        await git(m.dir, ["show", `${m.landed}:.spec-gate/config.yaml`]),
      ).toContain("Alice");
      const report = await checkLanded(m);
      expect(await settingsDiff(m.dir, report.merge!.ranges.at(-1)!)).toBe("");
      expect(failing(report)).toEqual([2, 7]);
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(report.approved).toBe(false);
    });

    it("a rebase merge whose commits add a spec the default branch gained and then delete it: the replay deletes it on the default branch, not approved", async () => {
      const s = await build();
      await s.repo.checkout("main");
      const gained = await s.repo.commit(
        { [STALE_OTHER]: otherSpec("other-spec") },
        "another proposed spec lands on main",
      );
      await s.repo.checkout("pr");
      await s.repo.commit(
        { [STALE_OTHER]: otherSpec("other-spec") },
        "another proposed spec lands on main",
      );
      await s.repo.commit({ [STALE_OTHER]: null }, "drop it again");
      await s.repo.commit({ "notes.txt": "a last commit\n" }, "notes");
      const m = await land(s, "rebase");
      const has = (commit: string) =>
        git(m.dir, ["ls-tree", "--name-only", commit, STALE_OTHER]);
      expect(await has(gained)).toBe(STALE_OTHER);
      expect(await has(m.landed)).toBe("");
      const report = await checkLanded(m);
      expect(cond(report, 8)).toMatchObject({
        ok: false,
        code: "repo-check-findings",
        message: `the repository check reports 1 finding: spec-removed ${JSON.stringify(STALE_OTHER)}`,
      });
      expect(failing(report)).toEqual([8]);
      expect(report.approved).toBe(false);
    });

    it("a squash merge of a pull request of four commits: approved, four steps measured", async () => {
      const s = await build();
      await s.repo.commit({ "notes-1.txt": "one\n" }, "notes");
      await s.repo.commit({ "notes-2.txt": "two\n" }, "more notes");
      const m = await land(s, "squash");
      const report = await checkLanded(m);
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
      expect(report.merge).toMatchObject({
        shape: "single-commit",
        commits: 4,
      });
      expect(report.merge!.ranges).toEqual([
        ...(await stepsOf(m.dir, m.merge, 4)),
        { from: m.c1, to: m.head },
      ]);
    });

    it("a rebase merge of a pull request of four commits onto a default branch that moved: approved", async () => {
      const s = await build();
      await s.repo.commit({ "notes-1.txt": "one\n" }, "notes");
      await s.repo.commit({ "notes-2.txt": "two\n" }, "more notes");
      const m = await land(s, "rebase");
      const report = await checkLanded(m);
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
      expect(report.merge).toMatchObject({
        shape: "single-commit",
        commits: 4,
      });
      // The four steps are the four replayed commits: the step below them
      // is a commit of the default branch.
      const below = report.merge!.ranges[3]!.from;
      expect(await git(m.dir, ["log", "-1", "--format=%s", below])).toBe(
        "elsewhere",
      );
    });

    it("a rebase merge of a pull request that merged the default branch once, right after a commit of the default branch that changed the settings: one step more than replayed commits, that commit counts, not approved", async () => {
      const s = await build();
      await s.repo.checkout("main");
      const moved = await s.repo.commit({ "other.txt": "x\n" }, "main moves");
      await s.repo.checkout("pr");
      await s.repo.sh("merge", "-q", "--no-ff", "-m", "update branch", moved);
      const head = await s.repo.commit({ "notes.txt": "n\n" }, "notes");
      await s.repo.checkout("main");
      await s.repo.commit({ "unrelated.txt": "u\n" }, "unrelated");
      const settings = await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "the default branch adds an approver",
      );
      await s.repo.sh("checkout", "-q", "-b", "landing", "pr");
      await s.repo.sh("rebase", "-q", "main", "landing");
      await s.repo.checkout("main");
      await s.repo.sh("merge", "-q", "--ff-only", "landing");
      const merge = await s.repo.head();
      await s.repo.setRef(REMOTE_MAIN, merge);
      const report = await checkLanded({ ...s, head, merge, landed: merge });
      // The merge commit of the branch is counted and not replayed: four
      // steps for three replayed commits, and the fourth is the default
      // branch's own.
      expect(report.merge!.commits).toBe(4);
      expect(report.merge!.ranges[3]!.to).toBe(settings);
      expect(report.merge!.ranges[2]!.from).toBe(settings);
      expect(failing(report)).toEqual([2, 7]);
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(report.approved).toBe(false);
    });

    it("a squash right after a commit of the default branch that changed the settings: that commit is among the measured steps and counts, not approved", async () => {
      // Git does not tell a squash from the last commit of a replay, so the
      // step before a squash of two commits is measured as if it were one.
      const s = await build();
      await s.repo.checkout("main");
      await s.repo.commit(
        { ".spec-gate/config.yaml": WITH_MALLORY },
        "the default branch adds an approver",
      );
      await s.repo.sh("merge", "-q", "--squash", "pr");
      const merge = await s.repo.commit({}, "squash pr");
      await s.repo.setRef(REMOTE_MAIN, merge);
      const report = await checkLanded({ ...s, merge, landed: merge });
      expect(await settingsDiff(s.dir, report.merge!.ranges[0]!)).toBe("");
      expect(await settingsDiff(s.dir, report.merge!.ranges[1]!)).toBe(
        ".spec-gate/config.yaml",
      );
      expect(failing(report)).toEqual([2, 7]);
      expect(cond(report, 2).code).toBe("config-in-merge");
    });
  },
);

describe(
  "the merge must be the one that brought the spec",
  { timeout: 120_000 },
  () => {
    it("a later pull request that only edits another file, approved and squashed: spec-not-in-merge", async () => {
      const first = await land(await build(), "squash");
      await first.repo.checkout("pr2", first.landed);
      const head = await first.repo.commit({ "README.md": "two\n" }, "typo");
      await first.repo.checkout("main");
      await first.repo.commit({ "between.txt": "x\n" }, "between");
      await first.repo.sh("merge", "-q", "--squash", "pr2");
      const merge = await first.repo.commit({}, "squash pr2");
      await first.repo.setRef(REMOTE_MAIN, merge);
      const later: Landed = { ...first, head, merge, landed: merge };
      const report = await checkLanded(later, {
        pullRequest: landedPull(later, { base: first.landed }),
      });
      expect(cond(report, 3)).toEqual({
        condition: 3,
        name: "digest-unchanged",
        ok: false,
        code: "spec-not-in-merge",
        message: NO_STEP,
      });
      // Its head holds the spec, with the approved digest, and alice
      // approved that head: nothing else fails.
      expect(failing(report)).toEqual([3]);
      expect(report.approved).toBe(false);
    });

    it("a later pull request of two commits squashed right after the spec landed: the measured steps hold the spec, the reviewed commits do not change it, spec-not-in-merge", async () => {
      const first = await land(await build(), "squash");
      await first.repo.checkout("pr2", first.landed);
      await first.repo.commit({ "README.md": "two\n" }, "typo");
      const head = await first.repo.commit({ "README.md": "three\n" }, "typo");
      await first.repo.checkout("main");
      await first.repo.sh("merge", "-q", "--squash", "pr2");
      const merge = await first.repo.commit({}, "squash pr2");
      await first.repo.setRef(REMOTE_MAIN, merge);
      const later: Landed = { ...first, head, merge, landed: merge };
      const report = await checkLanded(later, {
        pullRequest: landedPull(later, { base: first.landed }),
      });
      // The second measured step is the commit that brought the spec.
      expect(report.merge!.ranges[1]!.to).toBe(first.merge);
      expect(report.merge!.reviewed_base).toBe(first.landed);
      expect(cond(report, 3).code).toBe("spec-not-in-merge");
      expect(cond(report, 3).message).toBe(NOT_REVIEWED);
      expect(failing(report)).toEqual([3]);
    });

    it("a later pull request merged with a merge commit that does not touch the spec: spec-not-in-merge", async () => {
      const first = await land(await build(), "squash");
      await first.repo.checkout("pr2", first.landed);
      const head = await first.repo.commit({ "README.md": "two\n" }, "typo");
      await first.repo.checkout("main");
      await first.repo.sh("merge", "-q", "--no-ff", "-m", "merge pr2", head);
      const merge = await first.repo.head();
      await first.repo.setRef(REMOTE_MAIN, merge);
      const later: Landed = { ...first, head, merge, landed: merge };
      const report = await checkLanded(later, {
        pullRequest: landedPull(later, { base: first.landed }),
      });
      expect(report.merge!.shape).toBe("merge-commit");
      expect(cond(report, 3).code).toBe("spec-not-in-merge");
      expect(cond(report, 3).message).toBe(NO_STEP);
      expect(failing(report)).toEqual([3]);
    });

    /** Squashes `branch` onto `main` as it is, with no commit in between. */
    async function squashOnto(
      s: Awaited<ReturnType<typeof land>>,
      branch: string,
      head: string,
    ): Promise<Awaited<ReturnType<typeof land>>> {
      await s.repo.checkout("main");
      await s.repo.sh("merge", "-q", "--squash", branch);
      const merge = await s.repo.commit({}, `squash ${branch}`);
      await s.repo.setRef(REMOTE_MAIN, merge);
      return { ...s, head, merge, landed: merge };
    }

    it.each(["squash", "merge-commit"] as const)(
      "a draft the default branch already held, proposed by a pull request that changes nothing else and is approved, merged by %s: approved",
      async (how) => {
        const s = await build({ propose: false });
        await s.repo.checkout("main");
        await s.repo.commit({ "elsewhere.txt": "e\n" }, "elsewhere");
        await s.repo.sh(
          "merge",
          "-q",
          "--no-ff",
          "-m",
          "merge the draft",
          "pr",
        );
        const withDraft = await s.repo.head();
        await s.repo.setRef(REMOTE_MAIN, withDraft);
        await s.repo.checkout("pr2", withDraft);
        const head = await propose(s.repo);
        // The status is no part of the digest: draft and proposed are equal.
        expect(specDigestAt(s.dir, head, SPEC_REL)).toBe(
          specDigestAt(s.dir, withDraft, SPEC_REL),
        );
        await s.repo.checkout("main");
        await s.repo.commit({ "moved.txt": "m\n" }, "main moves");
        let merge: string;
        if (how === "squash") {
          await s.repo.sh("merge", "-q", "--squash", "pr2");
          merge = await s.repo.commit({}, "squash pr2");
        } else {
          await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge pr2", "pr2");
          merge = await s.repo.head();
        }
        await s.repo.setRef(REMOTE_MAIN, merge);
        const report = await checkLanded(
          { ...s, head, tip: withDraft, merge, landed: merge },
          { reviews: [review("alice", "APPROVED", head)] },
        );
        expect(codes(report)).toEqual(ALL_OK);
        expect(report.approved).toBe(true);
      },
    );

    it("an approved edit, an unrelated commit, then an approved pull request of three commits that puts the old text back: the two ends of its steps are equal, a step changes the spec, approved", async () => {
      const first = await afterMerge(await land(await build(), "squash"), {
        "unrelated.txt": "u\n",
      });
      await first.repo.checkout("pr2", first.landed);
      editSpec(first.dir);
      const edited = await squashOnto(
        first,
        "pr2",
        await first.repo.commit({}, "the spec says 403"),
      );
      await edited.repo.checkout("pr3", edited.landed);
      await edited.repo.sh("revert", "--no-edit", edited.merge);
      await edited.repo.commit({ "why.txt": "the edit was wrong\n" }, "why");
      const back = await squashOnto(
        edited,
        "pr3",
        await edited.repo.commit({ "more.txt": "more\n" }, "more"),
      );
      const report = await checkLanded(
        { ...back, tip: edited.landed },
        { reviews: [review("alice", "APPROVED", back.head)] },
      );
      const steps = report.merge!.ranges.slice(0, 3);
      expect(report.merge!.commits).toBe(3);
      const digests = steps.map((step) => [
        specDigestAt(back.dir, step.from, SPEC_REL),
        specDigestAt(back.dir, step.to, SPEC_REL),
      ]);
      // The squash and the edit before it change the digest; the unrelated
      // commit does not, and the first and the last digest are the same.
      expect(digests.map(([from, to]) => from !== to)).toEqual([
        true,
        true,
        false,
      ]);
      expect(digests[2]![0]).toBe(digests[0]![1]);
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
    });

    it("an approval of the pull request that added the spec as a draft, proposed later by a pull request nobody approved: review-not-proposed", async () => {
      const s = await build({ propose: false });
      const draftHead = s.head;
      await s.repo.checkout("main");
      await s.repo.commit({ "elsewhere.txt": "e\n" }, "elsewhere");
      await s.repo.sh("merge", "-q", "--squash", "pr");
      const draftMerge = await s.repo.commit({}, "squash the draft");
      await s.repo.setRef(REMOTE_MAIN, draftMerge);
      await s.repo.checkout("pr2", draftMerge);
      const proposeHead = await propose(s.repo);
      await s.repo.checkout("main");
      await s.repo.commit({ "moved.txt": "m\n" }, "main moves");
      await s.repo.sh("merge", "-q", "--squash", "pr2");
      const landed = await s.repo.commit({}, "squash the propose");
      await s.repo.setRef(REMOTE_MAIN, landed);
      const report = await checkLanded(
        { ...s, head: draftHead, merge: draftMerge, landed },
        { reviews: [review("alice", "APPROVED", draftHead)] },
      );
      // At the tip the spec is proposed, and its digest is the approved one.
      expect(cond(report, 4)).toMatchObject({ ok: true });
      expect(cond(report, 3)).toEqual({
        condition: 3,
        name: "digest-unchanged",
        ok: false,
        code: "review-not-proposed",
        message: `the spec is not proposed at the commit ${draftHead} of an approving review; an approval of a draft does not count, whatever status the default branch gave the spec later`,
      });
      expect(failing(report)).toEqual([3]);
      expect(report.approved).toBe(false);
      // The pull request that proposed it has no approval at all.
      const proposing = await checkLanded(
        { ...s, head: proposeHead, tip: draftMerge, merge: landed, landed },
        { reviews: [] },
      );
      expect(cond(proposing, 1).code).toBe("no-approval");
      expect(proposing.approved).toBe(false);
    });

    it("a second pull request with the same commits, squashed later into a commit that changes nothing: its reviewed commits hold the spec, no measured step changes it, spec-not-in-merge", async () => {
      let first = await land(await build(), "squash");
      first = await afterMerge(first, { "later-1.txt": "1\n" });
      first = await afterMerge(first, { "later-2.txt": "2\n" });
      const again = await squashOnto(first, "pr", first.head);
      const report = await checkLanded(again);
      // Two steps, the empty squash and an unrelated commit: the spec is
      // proposed with one digest at every end of them.
      expect(report.merge!.commits).toBe(2);
      expect(
        await git(again.dir, [
          "diff",
          "--name-only",
          `${again.merge}~1`,
          again.merge,
        ]),
      ).toBe("");
      expect(specDigestAt(again.dir, first.c1, SPEC_REL)).toBeNull();
      expect(cond(report, 3).code).toBe("spec-not-in-merge");
      expect(cond(report, 3).message).toBe(NO_STEP);
      expect(failing(report)).toEqual([3]);
    });

    /** Writes the spec of `dir` with its status set to `status`, the rest as it is. */
    function setStatus(dir: string, status: "draft" | "proposed"): void {
      const file = path.join(dir, SPEC_REL, "spec.md");
      const text = fs.readFileSync(file, "utf8");
      if (!/^status: (draft|proposed)$/m.test(text)) {
        throw new Error("the spec has no status line");
      }
      fs.writeFileSync(
        file,
        text.replace(/^status: (draft|proposed)$/m, `status: ${status}`),
      );
    }

    it("an unrelated pull request merged by a merge commit while the default branch holds the spec as a draft, proposed again by a later push: the spec is a draft at both ends of its step, spec-not-in-merge", async () => {
      // The spec lands proposed with no approval of its own.
      const first = await land(await build(), "squash");
      await first.repo.checkout("other", first.landed);
      const head = await first.repo.commit({ "README.md": "two\n" }, "typo");
      await first.repo.checkout("main");
      setStatus(first.dir, "draft");
      const drafted = await first.repo.commit({}, "back to draft");
      await first.repo.sh("merge", "-q", "--no-ff", "-m", "merge other", head);
      const merge = await first.repo.head();
      setStatus(first.dir, "proposed");
      const landed = await first.repo.commit({}, "proposed again");
      await first.repo.setRef(REMOTE_MAIN, landed);
      expect(
        await git(first.dir, ["diff", "--name-only", drafted, merge]),
      ).toBe("README.md");
      const report = await checkLanded(
        { ...first, head, tip: first.landed, merge, landed },
        { reviews: [review("alice", "APPROVED", head)] },
      );
      expect(report.merge!.shape).toBe("merge-commit");
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "spec-not-in-merge",
        message: NO_STEP,
      });
      expect(failing(report)).toEqual([3]);
      expect(report.approved).toBe(false);
    });

    it("the host names an earlier commit of the default branch where the spec is at neither end of a measured step: spec-not-in-merge", async () => {
      const s = await build();
      await s.repo.checkout("main");
      await s.repo.commit(
        { ".spec-gate/config.yaml": ONLY_BOB },
        "alice is no approver any more",
      );
      const fillers: string[] = [];
      for (let i = 1; i <= 4; i += 1) {
        fillers.push(
          await s.repo.commit({ [`f-${i}.txt`]: `${i}\n` }, "filler"),
        );
      }
      await s.repo.sh("merge", "-q", "--squash", "pr");
      const merge = await s.repo.commit(
        { ".spec-gate/config.yaml": CONFIG },
        "squash pr",
      );
      await s.repo.setRef(REMOTE_MAIN, merge);
      const m: Landed = { ...s, merge, landed: merge };
      // The honest host: the squash carries its own settings.
      expect(failing(await checkLanded(m))).toEqual([2, 7]);
      const report = await checkLanded(m, {
        pullRequest: landedPull(m, { mergeCommit: fillers[3]! }),
      });
      // The steps below the named commit are clean and hold no spec.
      expect(cond(report, 2)).toMatchObject({ ok: true });
      expect(cond(report, 7)).toMatchObject({ ok: true });
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "spec-not-in-merge",
        message: NO_STEP,
      });
      expect(failing(report)).toEqual([3]);
    });

    it("an unrelated pull request, merged by a merge commit whose own tree proposes the spec again: the step arrives, the reviewed commits do not, spec-not-in-merge", async () => {
      const first = await land(await build(), "squash");
      await first.repo.checkout("other", first.landed);
      const head = await first.repo.commit({ "README.md": "two\n" }, "typo");
      await first.repo.checkout("main");
      setStatus(first.dir, "draft");
      const drafted = await first.repo.commit({}, "back to draft");
      await first.repo.sh("merge", "-q", "--no-ff", "--no-commit", head);
      setStatus(first.dir, "proposed");
      const merge = await first.repo.commit({}, "merge other");
      await first.repo.setRef(REMOTE_MAIN, merge);
      expect(await git(first.dir, ["rev-parse", `${merge}^2`])).toBe(head);
      // Over the one step of the merge commit the spec goes from draft to
      // proposed; the reviewed commits changed README.md alone.
      expect(
        await git(first.dir, ["diff", "--name-only", drafted, merge]),
      ).toBe(`README.md\n${SPEC_REL}/spec.md`);
      expect(
        await git(first.dir, ["diff", "--name-only", first.landed, head]),
      ).toBe("README.md");
      const report = await checkLanded(
        { ...first, head, tip: first.landed, merge, landed: merge },
        { reviews: [review("alice", "APPROVED", head)] },
      );
      expect(report.merge).toMatchObject({
        shape: "merge-commit",
        reviewed_base: null,
      });
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "spec-not-in-merge",
        message: NOT_REVIEWED,
      });
      expect(failing(report)).toEqual([3]);
      expect(report.approved).toBe(false);
    });

    it("an approved edit of the spec: approved for the pull request that edited it, and the pull request that first brought it no longer matches the tip", async () => {
      const first = await land(await build(), "squash");
      await first.repo.checkout("pr2", first.landed);
      editSpec(first.dir);
      const edited = await squashOnto(
        first,
        "pr2",
        await first.repo.commit({}, "the spec says 403"),
      );
      const report = await checkLanded(
        { ...edited, tip: first.landed },
        { reviews: [review("alice", "APPROVED", edited.head)] },
      );
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
      const old = await checkLanded({ ...first, landed: edited.landed });
      expect(cond(old, 3).code).toBe("digest-mismatch-after-merge");
      expect(old.approved).toBe(false);
    });

    it("an approved edit, then an approved pull request of two commits that puts the old text back, squashed right after: approved", async () => {
      const first = await land(await build(), "squash");
      await first.repo.checkout("pr2", first.landed);
      editSpec(first.dir);
      const edited = await squashOnto(
        first,
        "pr2",
        await first.repo.commit({}, "the spec says 403"),
      );
      await edited.repo.checkout("pr3", edited.landed);
      await edited.repo.sh("revert", "--no-edit", edited.merge);
      const back = await squashOnto(
        edited,
        "pr3",
        await edited.repo.commit({ "why.txt": "the edit was wrong\n" }, "why"),
      );
      const report = await checkLanded(
        { ...back, tip: edited.landed },
        { reviews: [review("alice", "APPROVED", back.head)] },
      );
      // The two measured steps are the squash and the edit before it: the
      // spec has the tip's digest before the first and after the last.
      expect(report.merge!.commits).toBe(2);
      expect(
        specDigestAt(back.dir, report.merge!.ranges[1]!.from, SPEC_REL),
      ).toBe(report.digest);
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
    });

    it("a second pull request with the same commits, squashed right after the first: the measured steps hold the first landing, and it is taken for the one that brought the spec", async () => {
      // A decided boundary: the steps before a squash are commits of the
      // default branch, and the check cannot tell them from replayed ones.
      const first = await land(await build(), "squash");
      const again = await squashOnto(first, "pr", first.head);
      const report = await checkLanded(again);
      expect(report.merge!.ranges[1]!.to).toBe(first.merge);
      expect(codes(report)).toEqual(ALL_OK);
    });

    it("the state is judged against the digest at the tip, not at the merge commit: a second pull request squashed right after the first with another text, the approved text pushed back later, is approved inside the same boundary", async () => {
      const s = await build();
      await s.repo.checkout("pr2", s.head);
      const head2 = await s.repo.commit({ "README.md": "two\n" }, "typo");
      const first = await land(s, "squash");
      const specFile = path.join(first.dir, SPEC_REL, "spec.md");
      const approvedText = fs.readFileSync(specFile, "utf8");
      await first.repo.checkout("main");
      await first.repo.sh("merge", "-q", "--squash", "pr2");
      editSpec(first.dir);
      const merge = await first.repo.commit({}, "squash pr2 with another text");
      fs.writeFileSync(specFile, approvedText);
      const tip = await first.repo.commit({}, "the approved text again");
      await first.repo.setRef(REMOTE_MAIN, tip);
      const report = await checkLanded(
        { ...first, head: head2, merge, landed: tip },
        { reviews: [review("alice", "APPROVED", head2)] },
      );
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
    });

    it.each([
      ["merge-commit", "merge-commit"],
      ["merge-commit", "fast-forward"],
      ["squash", "merge-commit"],
      ["squash", "fast-forward"],
    ] as const)(
      "a decided boundary: the approval was given before the default branch moved to a draft under the pull request (merged by %s, the draft by %s): approved",
      async (how, mid) => {
        // The spec lands proposed with no approval of its own.
        const first = await land(await build(), "squash");
        // One branch, two commits: back to draft, then the proposed text
        // again and a typo fix. The approver is shown README.md alone.
        await first.repo.checkout("sneaky", first.landed);
        setStatus(first.dir, "draft");
        const drafting = await first.repo.commit({}, "back to draft");
        setStatus(first.dir, "proposed");
        const head = await first.repo.commit({ "README.md": "two\n" }, "typo");
        expect(
          await git(first.dir, [
            "diff",
            "--name-only",
            `${first.landed}...${head}`,
          ]),
        ).toBe("README.md");
        // The first commit alone reaches the default branch.
        await first.repo.checkout("main");
        if (mid === "fast-forward") {
          await first.repo.sh("merge", "-q", "--ff-only", drafting);
        } else {
          await first.repo.sh(
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "draft",
            drafting,
          );
        }
        let merge: string;
        if (how === "squash") {
          await first.repo.sh("merge", "-q", "--squash", "sneaky");
          merge = await first.repo.commit({}, "squash sneaky");
        } else {
          await first.repo.sh(
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "merge",
            "sneaky",
          );
          merge = await first.repo.head();
        }
        await first.repo.setRef(REMOTE_MAIN, merge);
        const report = await checkLanded(
          { ...first, head, tip: first.landed, merge, landed: merge },
          { reviews: [review("alice", "APPROVED", head)] },
        );
        // After the base moved, git shows what a propose-only pull request
        // over a draft shows. Telling the two apart needs a fact of the
        // host about when the review was given.
        expect(codes(report)).toEqual(ALL_OK);
        expect(report.approved).toBe(true);
      },
    );

    it("a merge commit whose head has two merge bases with its first parent: ambiguous-merge-base for condition 3, none is picked", async () => {
      const m = await land(
        await crissCross("spec-deleted", "side"),
        "merge-commit",
      );
      const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
      expect(
        (await git(m.dir, ["merge-base", "--all", m.head, first])).split("\n"),
      ).toHaveLength(2);
      const report = await checkLanded(m);
      expect(report.merge!.shape).toBe("merge-commit");
      expect(cond(report, 3)).toEqual({
        condition: 3,
        name: "digest-unchanged",
        ok: false,
        code: "ambiguous-merge-base",
        message:
          "the head commit of the pull request and the first parent of its merge commit have 2 merge bases; what the reviewed commits brought is not read from one of several",
      });
      expect(report.approved).toBe(false);
    });

    it("a merge commit whose head shares no history with its first parent: git-failed for condition 3, and conditions 2, 7 and 8 keep their range", async () => {
      seam.mergeBases = () => [];
      const report = await checkLanded(MERGE);
      expect(cond(report, 3)).toMatchObject({
        ok: false,
        code: "git-failed",
        message:
          "the head commit of the pull request and the first parent of its merge commit share no history; what the reviewed commits brought is not known",
      });
      expect(failing(report)).toEqual([3]);
      expect(report.merge!.ranges).toHaveLength(1);
    });

    it("a read of the merge bases that fails: git-failed for condition 3, never a pass", async () => {
      seam.mergeBases = () => {
        throw new LintGitError(
          "git-failed",
          "git could not find the merge bases",
        );
      };
      const report = await checkLanded(MERGE);
      expect(cond(report, 3)).toMatchObject({ ok: false, code: "git-failed" });
      expect(failing(report)).toEqual([3]);
    });

    it("the merge base of a merge commit is asked for the head and the first parent, once, and only for condition 3", async () => {
      const asked: [string, string][] = [];
      seam.mergeBases = (a, b) => {
        asked.push([a, b]);
        return undefined;
      };
      const report = await checkLanded(MERGE);
      expect(report.approved).toBe(true);
      expect(asked).toEqual([[MERGE.head, report.merge!.first_parent]]);
    });

    it("the pull request that brought the spec passes, for each way it was merged", async () => {
      for (const m of [MERGE, SQUASH, REBASE]) {
        expect(cond(await checkLanded(m), 3)).toMatchObject({
          ok: true,
          code: "ok",
        });
      }
    });
  },
);

describe("the open mode is unchanged", { timeout: 60_000 }, () => {
  it("reports its mode and no merge", async () => {
    const s = await build();
    const report = await check(s);
    expect(report.mode).toBe("open");
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(true);
  });

  it("an approval of an older commit that held the spec as a draft: the open mode does not ask for the status there, condition 3 holds", async () => {
    const s = await build();
    const report = await check(s, {
      reviews: [review("alice", "APPROVED", s.draft)],
    });
    expect(cond(report, 1).code).toBe("approval-stale");
    expect(cond(report, 3)).toMatchObject({ ok: true, code: "ok" });
    expect(failing(report)).toEqual([1, 2]);
  });

  it("a host that reports the pull request without the merge facts gives no fact", async () => {
    const s = await build();
    const pull = pullRequestOf(s);
    delete pull.merged;
    delete pull.mergeCommit;
    const report = await check(s, { pullRequest: pull });
    expect(cond(report, 1).code).toBe("host-failed");
    expect(report.approved).toBe(false);
  });
});
