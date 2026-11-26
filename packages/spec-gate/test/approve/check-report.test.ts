import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  APPROVE_FORMAT,
  CONDITIONS,
  FAILURE_CODES,
  checkApproval,
} from "../../src/approve/index.js";
import { SPEC_REL } from "../lint/git-helpers.js";
import {
  build,
  check,
  codes,
  cond,
  hostFor,
  keep,
  pullRequestOf,
  requestFor,
  review,
  type Scenario,
} from "./helpers.js";

const ALL_OK = ["ok", "ok", "ok", "ok", "ok", "ok", "ok"];

/** The standard repository: proposed spec at the head, `CONFIG` on the default branch. */
let S: Scenario;

beforeAll(async () => {
  S = keep(await build());
}, 60_000);

describe("checkApproval: approved", { timeout: 60_000 }, () => {
  it("every condition holds: the whole report", async () => {
    const host = hostFor(S);
    const result = await checkApproval(requestFor(S, host));
    expect(result).toEqual({
      kind: "report",
      report: {
        format: APPROVE_FORMAT,
        spec: "tiny-valid",
        path: SPEC_REL,
        approved: true,
        approve_reported: false,
        head: S.head,
        reference: S.c1,
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        pull_request: {
          number: 7,
          author: "dev",
          head: S.head,
          base: S.c1,
          target_ref: "refs/heads/main",
        },
        conditions: CONDITIONS.map((c) => ({
          condition: c.condition,
          name: c.name,
          ok: true,
          code: "ok",
          message: expect.any(String),
        })),
        approvals: [
          { login: "alice", commit: S.head, at_head: true, problem: null },
        ],
        last_config_commit: { commit: S.c1, approver: "bob" },
        gaps: [{ code: "coldread-not-checked", message: expect.any(String) }],
      },
    });
    expect(host.calls).not.toContain("ciRunStatus");
  });

  it("is deterministic and holds nothing machine-local", async () => {
    const one = JSON.stringify(await check(S));
    const two = JSON.stringify(await check(S));
    expect(two).toBe(one);
    expect(one).not.toContain(S.dir);
    expect(one).not.toContain(fs.realpathSync(S.dir));
  });

  it("has seven conditions, numbered in order, each with a code the table knows", async () => {
    const report = await check(S, { reviews: [], enforcement: "unknown" });
    expect(report.conditions.map((c) => c.condition)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    for (const c of report.conditions) {
      expect(c.ok).toBe(c.code === "ok");
      if (!c.ok) {
        expect(FAILURE_CODES[c.code as keyof typeof FAILURE_CODES]).toContain(
          c.condition,
        );
      }
    }
  });

  it("with the default ref given as the local branch", async () => {
    const report = await check(S, {}, { defaultRef: "refs/heads/main" });
    expect(codes(report)).toEqual(ALL_OK);
    expect(report.approved).toBe(true);
  });
});

describe(
  "condition 1: an approving review stands on the head",
  { timeout: 60_000 },
  () => {
    it("holds with a comment after the approval", async () => {
      const report = await check(S, {
        reviews: [
          review("alice", "APPROVED", S.head, 1),
          review("alice", "COMMENTED", S.head, 2),
        ],
      });
      expect(cond(report, 1)).toMatchObject({ ok: true, code: "ok" });
      expect(report.approved).toBe(true);
    });

    it("no review: no-approval", async () => {
      const report = await check(S, { reviews: [] });
      expect(cond(report, 1)).toMatchObject({ ok: false, code: "no-approval" });
      expect(report.approved).toBe(false);
      expect(report.approve_reported).toBe(false);
      expect(report.approvals).toEqual([]);
    });

    it.each(["CHANGES_REQUESTED", "DISMISSED"] as const)(
      "an approval followed by %s of the same reviewer: no-approval",
      async (state) => {
        const report = await check(S, {
          reviews: [
            review("alice", "APPROVED", S.head, 1),
            review("Alice", state, S.head, 2),
          ],
        });
        expect(cond(report, 1)).toMatchObject({
          ok: false,
          code: "no-approval",
        });
        expect(report.approved).toBe(false);
        expect(report.approvals).toEqual([]);
      },
    );

    it("an approval of an older commit does not count: approval-stale", async () => {
      const report = await check(S, {
        reviews: [review("alice", "APPROVED", S.draft)],
      });
      expect(cond(report, 1)).toMatchObject({
        ok: false,
        code: "approval-stale",
      });
      expect(report.approved).toBe(false);
      expect(report.approve_reported).toBe(false);
      expect(report.approvals).toEqual([
        { login: "alice", commit: S.draft, at_head: false, problem: null },
      ]);
    });

    it("an approval of the head by one reviewer is enough beside a stale one by another", async () => {
      const report = await check(S, {
        reviews: [
          review("bob", "APPROVED", S.draft, 1),
          review("alice", "APPROVED", S.head, 2),
        ],
      });
      expect(report.approved).toBe(true);
      expect(report.approvals.map((a) => [a.login, a.at_head])).toEqual([
        ["alice", true],
        ["bob", false],
      ]);
    });

    it("the checkout is not at the head the host reports: head-mismatch, though the checked-out commit is approved", async () => {
      const report = await check(S, {
        pullRequest: pullRequestOf(S, { head: S.draft }),
      });
      expect(report.approvals[0]).toMatchObject({
        commit: S.head,
        at_head: true,
      });
      expect(cond(report, 1)).toMatchObject({
        ok: false,
        code: "head-mismatch",
      });
      expect(report.approved).toBe(false);
    });
  },
);

describe("checkApproval: refused", { timeout: 60_000 }, () => {
  const refusal = async (
    over: Parameters<typeof requestFor>[2],
  ): Promise<string> => {
    const host = hostFor(S);
    const result = await checkApproval(requestFor(S, host, over));
    expect(result.kind).toBe("refused");
    // Nothing was asked of the host for a check that cannot start.
    expect(host.calls).toEqual([]);
    expect(result).not.toHaveProperty("report");
    return result.kind === "refused" ? result.message : "";
  };

  it("without a default ref", async () => {
    expect(await refusal({ defaultRef: "" })).toContain("default ref");
    expect(
      await refusal({ defaultRef: undefined as unknown as string }),
    ).toContain("default ref");
  });

  it("with a default ref that is no full ref name or does not exist", async () => {
    expect(await refusal({ defaultRef: "main" })).toContain("--default-ref");
    expect(await refusal({ defaultRef: "refs/heads/nope" })).toContain(
      "--default-ref",
    );
  });

  it("with a base that is not on the default ref", async () => {
    expect(await refusal({ base: S.head })).toContain("--base");
    expect(await refusal({ base: "main" })).toContain("--base");
  });

  it("with a spec directory that is not a directory", async () => {
    expect(await refusal({ specDir: path.join(S.spec, "spec.md") })).toContain(
      "not a directory",
    );
    expect(await refusal({ specDir: path.join(S.dir, "nope") })).toContain(
      "not a directory",
    );
  });

  it("with a spec directory that is a link", async () => {
    const s = await build();
    const link = path.join(s.dir, "specs", "s2");
    fs.symlinkSync("s1", link);
    const host = hostFor(s);
    const result = await checkApproval(requestFor(s, host, { specDir: link }));
    expect(result).toMatchObject({ kind: "refused" });
    expect(host.calls).toEqual([]);
  });

  it("with a spec directory that is not specs/<name>", async () => {
    for (const specDir of [
      S.dir,
      path.join(S.dir, "specs"),
      path.join(S.spec, "source"),
      path.join(S.dir, ".spec-gate"),
    ]) {
      expect(await refusal({ specDir })).toContain("specs/<name>");
    }
  });

  it("with a spec directory whose name the git reads do not accept", async () => {
    const s = await build();
    const odd = path.join(s.dir, "specs", "a b");
    fs.mkdirSync(odd);
    const host = hostFor(s);
    const result = await checkApproval(requestFor(s, host, { specDir: odd }));
    expect(result).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("character"),
    });
    expect(host.calls).toEqual([]);
  });

  it("with a repository that does not hold the spec directory, or is none", async () => {
    const s = await build();
    await refusal({ repo: s.dir });
    await refusal({ repo: path.dirname(S.dir) });
  });
});
