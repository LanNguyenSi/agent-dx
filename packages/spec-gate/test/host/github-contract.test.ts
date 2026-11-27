/**
 * The approval check, unchanged, run on the GitHub adapter against the stub:
 * the facts the adapter reads are the facts the conditions need.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkApproval, type ApproveReport } from "../../src/approve/index.js";
import {
  build,
  codes,
  cond,
  failing as failingConditions,
  keep,
  requestFor,
  type Scenario,
} from "../approve/helpers.js";
import {
  expectClean,
  hostAt,
  P,
  PROTECTION_PATH,
  PULL_PATH,
  pullJson,
  pullRequestRule,
  REPOSITORY,
  reviewJson,
  REVIEWS_PATH,
  RULES_PATH,
  sha,
  Stub,
} from "./stub.js";

let stub: Stub;
/** The standard repository: a proposed spec at the head, the settings on the default branch. */
let S: Scenario;

beforeAll(async () => {
  stub = await Stub.start();
  S = keep(await build());
}, 60_000);
afterAll(async () => {
  await stub.close();
});

/**
 * A host on which everything holds: pull request 7 by `dev` from the head
 * to `main`, an approval by `alice` on the head, a ruleset that requires
 * one approval, and the settings merged by pull request 3 with an approval
 * by `bob`.
 */
beforeEach(() => {
  stub.reset();
  stub.on(PULL_PATH, {
    json: pullJson({
      head: { ref: "pr", sha: S.head, repo: { full_name: "dev/widgets" } },
      base: { ref: "main", sha: S.c1, repo: { full_name: REPOSITORY } },
    }),
  });
  stub.on(REVIEWS_PATH, { json: [reviewJson("alice", "APPROVED", S.head, 1)] });
  stub.on(RULES_PATH, { json: [pullRequestRule(1)] });
  stub.on(`${P}/commits`, { json: [{ sha: S.c1 }] });
  stub.on(`${P}/commits/${S.c1}/pulls`, {
    json: [
      {
        number: 3,
        merged_at: "2024-05-01T11:00:00Z",
        merge_commit_sha: S.c1,
        head: { ref: "settings", sha: sha("d") },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
      },
    ],
  });
  stub.on(`${P}/pulls/3/reviews`, {
    json: [reviewJson("bob", "APPROVED", sha("d"), 1)],
  });
});

async function check(): Promise<ApproveReport> {
  const result = await checkApproval(requestFor(S, hostAt(stub)));
  if (result.kind !== "report") {
    throw new Error(`the check refused: ${result.message}`);
  }
  expectClean(result.report);
  return result.report;
}

describe("checkApproval on the GitHub adapter", { timeout: 60_000 }, () => {
  it("approved: every condition holds on the facts the adapter reads", async () => {
    const report = await check();
    expect(codes(report)).toEqual(Array(8).fill("ok"));
    expect(report.approved).toBe(true);
    expect(report.approve_reported).toBe(false);
    expect(report.pull_request).toEqual({
      number: 7,
      author: "dev",
      head: S.head,
      base: S.c1,
      target_ref: "refs/heads/main",
    });
    expect(report.approvals).toEqual([
      { login: "alice", commit: S.head, at_head: true, problem: null },
    ]);
    expect(report.last_config_commit).toEqual({
      commit: S.c1,
      approver: "bob",
    });
    // One read of the pull request and of the enforcement serves the whole check.
    expect(stub.hitsOf(PULL_PATH)).toHaveLength(1);
    expect(stub.hitsOf(RULES_PATH)).toHaveLength(1);
    expect(stub.hits.every((hit) => hit.method === "GET")).toBe(true);
  });

  it("not approved: a request for changes on a later page takes the approval away", async () => {
    const page = (n: number) => `${REVIEWS_PATH}?per_page=100&page=${n}`;
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED", S.head, 1)],
      headers: { link: `<${stub.url}${page(2)}>; rel="next"` },
    });
    stub.on(page(2), {
      json: [reviewJson("alice", "CHANGES_REQUESTED", S.head, 2)],
    });
    const report = await check();
    expect(report.approved).toBe(false);
    expect(report.approve_reported).toBe(false);
    expect(cond(report, 1)).toMatchObject({ ok: false, code: "no-approval" });
    expect(report.approvals).toEqual([]);
  });

  it("not approved: the text of the pull request says approved, no review does", async () => {
    stub.on(REVIEWS_PATH, { json: [] });
    const report = await check();
    expect(report.approved).toBe(false);
    expect(cond(report, 1)).toMatchObject({ ok: false, code: "no-approval" });
  });

  it("not approved: nothing proves that the host enforces the review", async () => {
    stub.on(RULES_PATH, { json: [] });
    stub.on(PROTECTION_PATH, {
      status: 403,
      json: { message: "Resource not accessible by integration" },
    });
    const report = await check();
    expect(report.approved).toBe(false);
    expect(report.approve_reported).toBe(true);
    expect(failingConditions(report)).toEqual([6]);
    expect(cond(report, 6)).toMatchObject({
      ok: false,
      code: "approval-not-enforced",
    });
    expect(cond(report, 6).message).toContain("specs/: unknown");
    expect(cond(report, 6).message).toContain(".spec-gate/: unknown");
  });

  it("not approved: a host that fails gives host-failed, and nothing it said reaches the report", async () => {
    stub.on(REVIEWS_PATH, {
      status: 500,
      json: { message: "boom at the host" },
    });
    const report = await check();
    expect(report.approved).toBe(false);
    expect(cond(report, 1)).toMatchObject({ ok: false, code: "host-failed" });
    expect(JSON.stringify(report)).not.toContain("boom");
  });
});
