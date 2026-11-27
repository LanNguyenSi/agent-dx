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
  CONFIG_ONLY_BOB,
  STALE_OTHER,
  afterMerge,
  build,
  check,
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
  pullRequestOf,
  requestFor,
  review,
  squashEdited,
  squashWithOwnSettings,
  type Landed,
} from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** Called instead of `commitParents`; a value other than `undefined` is returned in its place. */
  // eslint-disable-next-line no-unused-vars
  commitParents: undefined as ((commit: string) => unknown) | undefined,
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
  seam.lints.length = 0;
  seam.repoChecks.length = 0;
  seam.configFindings = undefined;
});

const ALL_OK = Array(8).fill("ok") as string[];
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
          ranges: [
            { from: expect.any(String), to: SQUASH.merge },
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

  it("a rebase merge of two commits: the last one and the reviewed commits are measured", async () => {
    const report = await checkLanded(REBASE);
    expect(codes(report)).toEqual(ALL_OK);
    expect(report.approved).toBe(true);
    expect(report.merge).toMatchObject({
      commit: REBASE.merge,
      shape: "single-commit",
      reviewed_base: REBASE.c1,
    });
    expect(report.merge!.ranges).toEqual([
      { from: report.merge!.first_parent, to: REBASE.merge },
      { from: REBASE.c1, to: REBASE.head },
    ]);
    // The first parent is the first replayed commit, not the default branch
    // before the pull request.
    expect(report.merge!.first_parent).not.toBe(REBASE.c1);
  });

  it("the messages name the tip of the default branch and the merge", async () => {
    const report = await checkLanded(SQUASH);
    expect(report.conditions.map((c) => c.message)).toEqual([
      "1 approving review stands on the head commit",
      "alice approved the head commit, is in approvers, is not the author and is not an agent identity",
      "the digest at the tip of the default branch equals the digest at the commit of every approving review considered",
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
    expect(failing(report)).toEqual([1, 2, 7, 8]);
    for (const condition of [1, 2, 7, 8] as const) {
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
    expect(failing(report)).toEqual([1, 2, 7, 8]);
    for (const condition of [1, 2, 7, 8] as const) {
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
      expect(failing(report)).toEqual([1, 2, 7, 8]);
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
      expect(failing(report)).toEqual([2, 7, 8]);
      expect(cond(report, 7).code).toBe("merge-not-on-default");
      expect(report.approved).toBe(false);
    });

    it("the host names a commit the repository does not have: merge-not-on-default", async () => {
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { mergeCommit: "0".repeat(40) }),
      });
      expect(failing(report)).toEqual([2, 7, 8]);
      expect(cond(report, 2).code).toBe("merge-not-on-default");
    });

    it("merged without a merge commit: merge-not-on-default", async () => {
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { mergeCommit: null }),
      });
      expect(failing(report)).toEqual([2, 7, 8]);
      expect(cond(report, 8)).toMatchObject({
        code: "merge-not-on-default",
        message:
          "the host reports no merge commit for the merged pull request; there is no commit to look for on the default branch",
      });
    });

    it("an earlier commit of the default branch as merge commit is measured as what it is: the spec did not land there", async () => {
      // The settings commit has one parent and the head is not in its
      // history, so it reads as a single commit; the ranges are its own.
      const report = await checkLanded(SQUASH, {
        pullRequest: landedPull(SQUASH, { mergeCommit: SQUASH.c1 }),
      });
      expect(report.merge).toMatchObject({
        commit: SQUASH.c1,
        shape: "single-commit",
      });
      // That commit wrote the settings: they are not trusted.
      expect(cond(report, 2).code).toBe("config-in-merge");
      expect(cond(report, 7).code).toBe("spec-changes-config");
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

    it("the head was pushed after the approval: approval-stale, though the digest is the same", async () => {
      // The approval stands on the draft commit; the head is the propose
      // commit, which changes the status alone.
      const report = await checkLanded(SQUASH, {
        reviews: [review("alice", "APPROVED", SQUASH.draft)],
      });
      expect(failing(report)).toEqual([1, 2]);
      expect(cond(report, 1).code).toBe("approval-stale");
      expect(cond(report, 3)).toMatchObject({ ok: true });
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
    it("an approver revoked on the default branch after the merge does not count: approver-not-qualified", async () => {
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
            "the merged pull request changes 1 path under .spec-gate/: the settings at the tip of the default branch may be its own, and who may approve is not taken from them",
        });
        expect(cond(report, 7)).toEqual({
          condition: 7,
          name: "config-untouched",
          ok: false,
          code: "spec-changes-config",
          message:
            "the merged pull request changes 1 path under .spec-gate/; a change there is a pull request of its own",
        });
        expect(failing(report)).toEqual([2, 7]);
        expect(report.approved).toBe(false);
        // Nothing differs between the base the host reports and the merge
        // commit, and nothing between the reviewed base and the head: only
        // the first parent shows the change.
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
        "the merged pull request changes 1 path under .spec-gate/; a change there is a pull request of its own",
      );
      expect(failing(report)).toEqual([2, 7]);
    });

    it("a rebase merge whose earlier commit names its own approver: the last commit is clean, the reviewed commits are not", async () => {
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
      const [last, reviewed] = report.merge!.ranges;
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
      for (const condition of [2, 7, 8] as const) {
        expect(cond(report, condition)).toMatchObject({
          ok: false,
          code: "head-unavailable",
          message:
            "the head commit of the pull request is not in the repository; the check never fetches, so the job has to bring that commit in before it runs",
        });
      }
      expect(failing(report)).toEqual([2, 3, 7, 8]);
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
    const report = await checkLanded(m);
    expect(seam.repoChecks).toHaveLength(2);
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
    const report = await checkLanded(m);
    expect((seam.repoChecks as GitInputs[]).map((range) => range.head)).toEqual(
      [m.merge, m.head],
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
    for (const condition of [2, 7, 8] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "merge-shape-unknown",
        message:
          "the head commit of the pull request is on the default branch without a merge commit of its own (a fast-forward, or a push of the branch); where the pull request begins on the default branch cannot be told from git, so nothing is measured",
      });
    }
    expect(failing(report)).toEqual([2, 7, 8]);
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
    for (const condition of [7, 8] as const) {
      expect(cond(report, condition).code).toBe("merge-shape-unknown");
      expect(cond(report, condition).message).toContain("has 0 parents");
    }
    // The base the host reports is behind the boundary as well.
    expect(cond(report, 2).code).toBe("base-not-on-default");
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(false);
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
    for (const condition of [2, 7, 8] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "git-failed",
        message:
          "the repository could not be read (git-failed); where the pull request landed is not known and nothing is measured from a guess",
      });
    }
    expect(failing(report)).toEqual([2, 7, 8]);
    expect(report.merge).toBeNull();
  });

  it("an error that is no git error is not swallowed", async () => {
    seam.commitParents = () => {
      throw new TypeError("a bug");
    };
    await expect(checkLanded(SQUASH)).rejects.toThrow("a bug");
  });
});

describe("the open mode is unchanged", { timeout: 60_000 }, () => {
  it("reports its mode and no merge", async () => {
    const s = await build();
    const report = await check(s);
    expect(report.mode).toBe("open");
    expect(report.merge).toBeNull();
    expect(report.approved).toBe(true);
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
