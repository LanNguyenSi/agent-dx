import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { targetsDefault } from "../../src/approve/index.js";
import { REMOTE_MAIN } from "../lint/git-helpers.js";
import {
  build,
  check,
  cond,
  failing,
  keep,
  pullRequestOf,
  review,
  type Built,
  type Merge,
  type Scenario,
} from "./helpers.js";

const NO_COMMIT = "0".repeat(40);

/** The standard repository: proposed spec at the head, `CONFIG` on the default branch. */
let S: Scenario;

beforeAll(async () => {
  S = keep(await build());
}, 60_000);

/** Moves the default branch on to a commit with `config`; the pull request stays where it is. */
async function configOnDefault(s: Built, config: string): Promise<string> {
  await s.repo.checkout("main");
  const c2 = await s.repo.commit(
    { ".spec-gate/config.yaml": config },
    "settings change on the default branch",
  );
  await s.repo.setRef(REMOTE_MAIN, c2);
  await s.repo.checkout("pr");
  return c2;
}

describe("condition 2: the approver is allowed", { timeout: 60_000 }, () => {
  it("holds for an approver whose login differs from the list in case", async () => {
    const report = await check(S, {
      reviews: [review("ALICE", "APPROVED", S.head)],
    });
    expect(cond(report, 2)).toMatchObject({ ok: true, code: "ok" });
    expect(report.approved).toBe(true);
  });

  it.each([
    ["a stranger", "mallory", "not-allowlisted"],
    ["a look-alike of an approver", "аlice", "not-allowlisted"],
    ["the author, an approver, in another case", "DEV", "is-author"],
    ["the agent identity as an app", "spec-bot[bot]", "is-agent"],
  ])(
    "%s approved the head: approver-not-qualified",
    async (_who, login, problem) => {
      const report = await check(S, {
        reviews: [review(login, "APPROVED", S.head)],
      });
      expect(cond(report, 1).ok).toBe(true);
      expect(cond(report, 2)).toMatchObject({
        ok: false,
        code: "approver-not-qualified",
      });
      expect(cond(report, 2).message).toContain(problem);
      expect(report.approvals).toEqual([
        { login, commit: S.head, at_head: true, problem },
      ]);
      expect(report.approved).toBe(false);
      expect(failing(report)).toEqual([2]);
    },
  );

  it("which problem is named: agent before author", async () => {
    const report = await check(S, {
      pullRequest: pullRequestOf(S, { author: "spec-bot" }),
      reviews: [review("spec-bot", "APPROVED", S.head)],
    });
    expect(report.approvals[0]!.problem).toBe("is-agent");
  });

  it("which problem is named: author before allowlist", async () => {
    const report = await check(S, {
      pullRequest: pullRequestOf(S, { author: "mallory" }),
      reviews: [review("mallory", "APPROVED", S.head)],
    });
    expect(report.approvals[0]!.problem).toBe("is-author");
  });

  it("one allowed approver of the head is enough beside approvers that do not count", async () => {
    const report = await check(S, {
      reviews: [
        review("spec-bot[bot]", "APPROVED", S.head, 1),
        review("mallory", "APPROVED", S.head, 2),
        review("bob", "APPROVED", S.head, 3),
      ],
    });
    expect(report.approved).toBe(true);
    expect(report.approvals.map((a) => [a.login, a.problem])).toEqual([
      ["bob", null],
      ["mallory", "not-allowlisted"],
      ["spec-bot[bot]", "is-agent"],
    ]);
  });

  it("an allowed approver of an older commit does not make up for a stranger on the head", async () => {
    const report = await check(S, {
      reviews: [
        review("alice", "APPROVED", S.draft, 1),
        review("mallory", "APPROVED", S.head, 2),
      ],
    });
    expect(cond(report, 1).ok).toBe(true);
    expect(cond(report, 2)).toMatchObject({
      ok: false,
      code: "approver-not-qualified",
    });
    expect(report.approved).toBe(false);
  });

  it("no approval on the head: no-approval, the stale approver is still listed", async () => {
    const report = await check(S, {
      reviews: [review("mallory", "APPROVED", S.draft)],
    });
    expect(cond(report, 2)).toMatchObject({ ok: false, code: "no-approval" });
    expect(report.approvals).toEqual([
      {
        login: "mallory",
        commit: S.draft,
        at_head: false,
        problem: "not-allowlisted",
      },
    ]);
  });

  it("the pull request targets another branch: target-not-default", async () => {
    const report = await check(S, {
      pullRequest: pullRequestOf(S, { targetRef: "refs/heads/release" }),
    });
    expect(cond(report, 2)).toMatchObject({
      ok: false,
      code: "target-not-default",
    });
    expect(report.approved).toBe(false);
    expect(failing(report)).toEqual([2]);
  });

  describe("the base commit: the one given and the one the host reports", () => {
    it("given, and the host reports the same: holds", async () => {
      const report = await check(S, {}, { base: S.c1 });
      expect(failing(report)).toEqual([]);
      expect(report.approved).toBe(true);
      expect(report.reference).toBe(S.c1);
    });

    it("given, and the host reports another one: base-mismatch", async () => {
      const report = await check(
        S,
        { pullRequest: pullRequestOf(S, { base: S.draft }) },
        { base: S.c1 },
      );
      expect(cond(report, 2)).toMatchObject({
        ok: false,
        code: "base-mismatch",
      });
      expect(report.approved).toBe(false);
      expect(failing(report)).toEqual([2]);
    });

    it("not given, and the host reports an older commit of the default ref: holds", async () => {
      const s = await build();
      const c2 = await configOnDefault(
        s,
        "approvers: [alice]\nagent_identities: [spec-bot]\n",
      );
      const report = await check(s);
      expect(report.pull_request!.base).toBe(s.c1);
      expect(report.reference).toBe(c2);
      expect(cond(report, 2).ok).toBe(true);
      expect(report.approved).toBe(true);
    });

    it.each([
      ["a commit of the pull request branch", () => S.draft],
      ["a commit the repository does not have", () => NO_COMMIT],
    ])(
      "not given, and the host reports %s: base-not-on-default",
      async (_what, base) => {
        const report = await check(S, {
          pullRequest: pullRequestOf(S, { base: base() }),
        });
        expect(cond(report, 2)).toMatchObject({
          ok: false,
          code: "base-not-on-default",
        });
        expect(report.approved).toBe(false);
        expect(failing(report)).toEqual([2]);
      },
    );
  });

  it.each<[string, Merge]>([
    [
      "by fast-forward",
      async (s, head) => {
        await s.repo.setRef(REMOTE_MAIN, head);
      },
    ],
    [
      "by a merge commit",
      async (s) => {
        await s.repo.checkout("main");
        await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge", "pr");
        await s.repo.setRef(REMOTE_MAIN, await s.repo.head());
        await s.repo.checkout("pr");
      },
    ],
  ])(
    "the default ref already holds the head, merged %s with its own change to the settings: head-in-reference",
    async (_how, merge) => {
      const s = await build();
      const head = await s.repo.commit(
        {
          ".spec-gate/config.yaml":
            "approvers: [mallory]\nagent_identities: [Spec-Bot]\n",
        },
        "let me in",
      );
      await merge(s, head);
      const report = await check(
        { ...s, head },
        { reviews: [review("mallory", "APPROVED", head)] },
      );
      // Read at the reference commit, the settings are now the pull
      // request's own, and nothing differs between the diff base and the head.
      expect(report.approvals[0]!.problem).toBeNull();
      expect(cond(report, 7).ok).toBe(true);
      expect(cond(report, 2)).toMatchObject({
        ok: false,
        code: "head-in-reference",
      });
      expect(report.approved).toBe(false);
    },
  );

  it("the settings come from git at the reference commit, not from the pull request", async () => {
    const s = await build();
    // The pull request adds its own approver to the settings, in a commit
    // and in the work tree, and that approver approves.
    const edited =
      "approvers: [Alice, bob, dev, mallory]\nagent_identities: [Spec-Bot]\n";
    const head = await s.repo.commit(
      { ".spec-gate/config.yaml": edited },
      "let me in",
    );
    expect(
      fs.readFileSync(path.join(s.dir, ".spec-gate/config.yaml"), "utf8"),
    ).toBe(edited);
    const report = await check(
      { ...s, head },
      { reviews: [review("mallory", "APPROVED", head)] },
    );
    expect(cond(report, 1).ok).toBe(true);
    expect(cond(report, 2)).toMatchObject({
      ok: false,
      code: "approver-not-qualified",
    });
    expect(report.approvals).toEqual([
      {
        login: "mallory",
        commit: head,
        at_head: true,
        problem: "not-allowlisted",
      },
    ]);
    expect(report.reference).toBe(s.c1);
    expect(report.approved).toBe(false);
  });

  it("the pull request cannot drop the agent identity either", async () => {
    const s = await build();
    const head = await s.repo.commit(
      { ".spec-gate/config.yaml": "approvers: [spec-bot]\n" },
      "the agent approves",
    );
    const report = await check(
      { ...s, head },
      { reviews: [review("spec-bot", "APPROVED", head)] },
    );
    expect(report.approvals[0]!.problem).toBe("is-agent");
    expect(cond(report, 2).ok).toBe(false);
    expect(cond(report, 5).ok).toBe(true);
    expect(report.approved).toBe(false);
  });

  it("an agent identity that is also in approvers does not count as an approver", async () => {
    const s = await build({
      config: "approvers: [alice, spec-bot]\nagent_identities: [Spec-Bot]\n",
    });
    const report = await check(s, {
      reviews: [review("spec-bot", "APPROVED", s.head)],
    });
    expect(cond(report, 2)).toMatchObject({
      ok: false,
      code: "approver-not-qualified",
    });
    expect(report.approvals[0]!.problem).toBe("is-agent");
    expect(report.approved).toBe(false);
  });
});

describe("targetsDefault", () => {
  it.each([
    ["refs/heads/main", "refs/heads/main"],
    ["refs/heads/main", "refs/remotes/origin/main"],
    ["refs/heads/main", "refs/remotes/upstream/main"],
    ["refs/heads/release/1.x", "refs/remotes/origin/release/1.x"],
  ])("%s is the branch %s holds", (target, defaultRef) => {
    expect(targetsDefault(target, defaultRef)).toBe(true);
  });

  it.each([
    ["refs/heads/main", "refs/heads/master"],
    ["refs/heads/main", "refs/heads/main2"],
    ["refs/heads/main2", "refs/heads/main"],
    ["refs/heads/main", "refs/remotes/origin/master"],
    ["refs/heads/main", "refs/remotes/origin/x/main"],
    ["refs/heads/origin/main", "refs/remotes/origin/main"],
    ["refs/heads/main", "refs/remotes/main"],
    ["refs/heads/main", "refs/tags/main"],
    ["refs/heads/main", "refs/pull/7/main"],
    ["refs/heads/x/main", "refs/remotes/x/main"],
    ["refs/remotes/origin/main", "refs/remotes/origin/main"],
    ["main", "refs/heads/main"],
    ["main", "main"],
    ["refs/tags/main", "refs/tags/main"],
  ])("%s is not the branch %s holds", (target, defaultRef) => {
    expect(targetsDefault(target, defaultRef)).toBe(false);
  });
});

describe(
  "condition 5: agent identities are set and are not approvers",
  { timeout: 60_000 },
  () => {
    it.each([
      ["no agent identity", "approvers: [alice]\n"],
      [
        "an agent identity that is an approver in another case",
        "approvers: [alice, SPEC-BOT]\nagent_identities: [spec-bot]\n",
      ],
      [
        "an agent identity whose app login is an approver",
        "approvers: [alice, 'spec-bot[bot]']\nagent_identities: [spec-bot]\n",
      ],
    ])(
      "%s: approval-not-verifiable, an approve is reported and no approval",
      async (_what, config) => {
        const s = await build({ config });
        const report = await check(s);
        expect(cond(report, 5)).toMatchObject({
          ok: false,
          code: "approval-not-verifiable",
        });
        expect(report.approved).toBe(false);
        expect(report.approve_reported).toBe(true);
        expect(failing(report)).toEqual([5]);
      },
    );

    it("no config file at the reference commit: the lists are empty, approval-not-verifiable", async () => {
      const s = await build({ config: null });
      const report = await check(s);
      expect(cond(report, 5)).toMatchObject({
        ok: false,
        code: "approval-not-verifiable",
      });
      expect(cond(report, 2)).toMatchObject({
        ok: false,
        code: "approver-not-qualified",
      });
      expect(report.approvals[0]!.problem).toBe("not-allowlisted");
      expect(report.approve_reported).toBe(true);
      expect(report.approved).toBe(false);
    });

    it("a config that does not parse at the reference commit: config-invalid for conditions 2 and 5, no approve reported", async () => {
      const s = await build();
      await configOnDefault(s, "approvers: [alice\n");
      const report = await check(s);
      expect(cond(report, 2)).toMatchObject({
        ok: false,
        code: "config-invalid",
      });
      expect(cond(report, 5)).toMatchObject({
        ok: false,
        code: "config-invalid",
      });
      expect(report.approvals[0]!.problem).toBe("not-evaluated");
      expect(report.approve_reported).toBe(false);
      expect(report.approved).toBe(false);
    });

    it("an approve is not reported when no approval stands on the head", async () => {
      const s = await build({ config: "approvers: [alice]\n" });
      const report = await check(s, {
        reviews: [review("alice", "APPROVED", s.draft)],
      });
      expect(cond(report, 5).code).toBe("approval-not-verifiable");
      expect(report.approve_reported).toBe(false);
    });
  },
);
