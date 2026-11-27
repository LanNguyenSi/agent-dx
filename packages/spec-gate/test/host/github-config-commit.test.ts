import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BASE,
  failing,
  giving,
  hostAt,
  P,
  PULL_PATH,
  pullJson,
  REPOSITORY,
  reviewJson,
  sha,
  Stub,
} from "./stub.js";

let stub: Stub;

beforeAll(async () => {
  stub = await Stub.start();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.reset();
  stub.on(PULL_PATH, { json: pullJson() });
});

/** The commit that last changed `.spec-gate/`, and the pull request that merged it. */
const CONFIG = sha("c");
const COMMITS_PATH = `${P}/commits`;
const COMMITS_URL = `${COMMITS_PATH}?sha=main&path=.spec-gate&per_page=1`;
const PULLS_OF = `${P}/commits/${CONFIG}/pulls`;
const CONFIG_REVIEWS = `${P}/pulls/3/reviews`;

/** A pull request as the list of pull requests of a commit gives it. */
function mergedPull(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 3,
    state: "closed",
    title: "settings, approved by carol",
    user: { login: "dev" },
    merged_at: "2024-04-01T09:00:00Z",
    merge_commit_sha: CONFIG,
    head: { ref: "settings", sha: sha("d"), repo: { full_name: REPOSITORY } },
    base: { ref: "main", sha: BASE, repo: { full_name: REPOSITORY } },
    ...over,
  };
}

/** Routes a config commit merged by pull request 3 with `reviews`. */
function merged(reviews: unknown[], pulls: unknown[] = [mergedPull()]): void {
  stub.on(COMMITS_PATH, { json: [{ sha: CONFIG, commit: { message: "x" } }] });
  stub.on(PULLS_OF, { json: pulls });
  stub.on(CONFIG_REVIEWS, { json: reviews });
}

describe("lastConfigCommit: the commit", () => {
  it("asks for the last commit under .spec-gate on the target branch", async () => {
    stub.on(COMMITS_PATH, { json: [] });
    expect(await giving(hostAt(stub).lastConfigCommit())).toEqual({
      commit: null,
      approver: null,
    });
    expect(stub.hits.map((hit) => hit.url)).toEqual([PULL_PATH, COMMITS_URL]);
  });

  it("names the target branch of the pull request, encoded as one query value", async () => {
    stub.on(PULL_PATH, {
      json: pullJson({
        base: {
          ref: "release/1.x+y",
          sha: BASE,
          repo: { full_name: REPOSITORY },
        },
      }),
    });
    stub.on(COMMITS_PATH, { json: [] });
    await giving(hostAt(stub).lastConfigCommit());
    expect(stub.hits.at(-1)!.url).toBe(
      `${COMMITS_PATH}?sha=release%2F1.x%2By&path=.spec-gate&per_page=1`,
    );
  });

  it("reports the commit and its approver", async () => {
    merged([reviewJson("carol", "APPROVED", sha("d"), 1)]);
    expect(await giving(hostAt(stub).lastConfigCommit())).toEqual({
      commit: CONFIG,
      approver: "carol",
    });
    expect(stub.hits.map((hit) => hit.url)).toEqual([
      PULL_PATH,
      COMMITS_URL,
      `${PULLS_OF}?per_page=100&page=1`,
      `${CONFIG_REVIEWS}?per_page=100&page=1`,
    ]);
  });

  it.each([
    ["a body that is no list", { commits: [] }, "not a list"],
    ["an entry without an id", [{ commit: {} }], "no commit id"],
    ["an entry with a short id", [{ sha: "abc1234" }], "no commit id"],
    ["an entry that is no object", [CONFIG], "no commit id"],
  ])("throws on commits with %s", async (_what, json, reason) => {
    stub.on(COMMITS_PATH, { json });
    const error = await failing(hostAt(stub).lastConfigCommit());
    expect(error.message).toBe(
      `github: GET ${COMMITS_PATH} answered 200 (${reason})`,
    );
  });

  it.each([[404], [409], [500]])(
    "throws when the commits answer %d",
    async (status) => {
      stub.on(COMMITS_PATH, { status, json: { message: "no" } });
      const error = await failing(hostAt(stub).lastConfigCommit());
      expect(error.message).toBe(
        `github: GET ${COMMITS_PATH} answered ${status}`,
      );
    },
  );

  it("fails when the pull request cannot be read", async () => {
    stub.on(PULL_PATH, { status: 404 });
    const error = await failing(hostAt(stub).lastConfigCommit());
    expect(error.message).toBe(`github: GET ${PULL_PATH} answered 404`);
  });
});

describe("lastConfigCommit: the pull request that brought the commit in", () => {
  it.each([
    ["no pull request", []],
    [
      "a pull request merged with another merge commit",
      [mergedPull({ merge_commit_sha: sha("e") })],
    ],
    [
      "a pull request without a merge commit",
      [mergedPull({ merge_commit_sha: null })],
    ],
    ["a pull request that is not merged", [mergedPull({ merged_at: null })]],
    [
      "a pull request into another branch",
      [
        mergedPull({
          base: { ref: "release", sha: BASE, repo: { full_name: REPOSITORY } },
        }),
      ],
    ],
    [
      "a pull request into another repository",
      [
        mergedPull({
          base: { ref: "main", sha: BASE, repo: { full_name: "evil/widgets" } },
        }),
      ],
    ],
    [
      "two pull requests that both merged it",
      [mergedPull(), mergedPull({ number: 4 })],
    ],
  ])(
    "%s: the approver is unknown, and no reviews are read",
    async (_what, pulls) => {
      merged([reviewJson("carol", "APPROVED", sha("d"), 1)], pulls);
      stub.on(`${P}/pulls/4/reviews`, {
        json: [reviewJson("mallory", "APPROVED", sha("d"), 1)],
      });
      expect(await giving(hostAt(stub).lastConfigCommit())).toEqual({
        commit: CONFIG,
        approver: null,
      });
      expect(stub.hitsOf(CONFIG_REVIEWS)).toEqual([]);
      expect(stub.hitsOf(`${P}/pulls/4/reviews`)).toEqual([]);
    },
  );

  it("picks the one that merged it among others that only hold the commit", async () => {
    merged(
      [reviewJson("carol", "APPROVED", sha("d"), 1)],
      [
        mergedPull({ number: 4, merge_commit_sha: sha("e") }),
        mergedPull(),
        mergedPull({ number: 5, merged_at: null, merge_commit_sha: null }),
      ],
    );
    expect((await giving(hostAt(stub).lastConfigCommit())).approver).toBe(
      "carol",
    );
  });

  it.each([
    ["an entry that is no object", [3], "a pull request is no object"],
    ["a number as text", [mergedPull({ number: "3" })]],
    ["a number below one", [mergedPull({ number: 0 })]],
    ["a number that is no integer", [mergedPull({ number: 3.5 })]],
    ["a merge time that is no text", [mergedPull({ merged_at: true })]],
    ["a merge commit that is no text", [mergedPull({ merge_commit_sha: 1 })]],
    ["no base", [mergedPull({ base: null })]],
    [
      "a base without a repository",
      [mergedPull({ base: { ref: "main", repo: null } })],
    ],
    [
      "a base repository without a name",
      [mergedPull({ base: { ref: "main", repo: {} } })],
    ],
    [
      "a base branch that is no text",
      [mergedPull({ base: { ref: 1, repo: { full_name: REPOSITORY } } })],
    ],
  ])(
    "throws on %s in the pull requests of the commit",
    async (_what, pulls, reason = "a pull request has an unexpected shape") => {
      merged([], pulls);
      const error = await failing(hostAt(stub).lastConfigCommit());
      expect(error.message).toBe(
        `github: GET ${PULLS_OF} answered 200 (${reason})`,
      );
    },
  );

  it.each([[404], [409], [500]])(
    "throws when the pull requests of the commit answer %d",
    async (status) => {
      merged([]);
      stub.on(PULLS_OF, { status });
      const error = await failing(hostAt(stub).lastConfigCommit());
      expect(error.message).toBe(`github: GET ${PULLS_OF} answered ${status}`);
    },
  );
});

describe("lastConfigCommit: the approver, by the rule of the approval check", () => {
  const D = sha("d");

  it.each([
    ["no review", [], null],
    ["one approval", [reviewJson("carol", "APPROVED", D, 1)], "carol"],
    [
      "an approval and a later request for changes by the same account",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("carol", "CHANGES_REQUESTED", D, 2),
      ],
      null,
    ],
    [
      "a request for changes and a later approval by the same account",
      [
        reviewJson("carol", "CHANGES_REQUESTED", D, 1),
        reviewJson("carol", "APPROVED", D, 2),
      ],
      "carol",
    ],
    [
      "an approval that was dismissed",
      [reviewJson("carol", "DISMISSED", D, 1)],
      null,
    ],
    [
      "an approval and a later comment by the same account",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("carol", "COMMENTED", D, 2),
      ],
      "carol",
    ],
    ["a comment only", [reviewJson("carol", "COMMENTED", D, 1)], null],
    [
      "two approvers: the later approval",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("bob", "APPROVED", D, 2),
      ],
      "bob",
    ],
    [
      "two approvers, listed out of order: the later approval",
      [
        reviewJson("bob", "APPROVED", D, 5),
        reviewJson("carol", "APPROVED", D, 1),
      ],
      "bob",
    ],
    [
      "two approvers, the later one first in the order of accounts",
      [
        reviewJson("bob", "APPROVED", D, 5),
        reviewJson("zed", "APPROVED", D, 1),
      ],
      "bob",
    ],
    [
      "two approvers, the later one last in the order of accounts",
      [
        reviewJson("zed", "APPROVED", D, 5),
        reviewJson("bob", "APPROVED", D, 1),
      ],
      "zed",
    ],
    [
      "an account that approved twice under two spellings: the later spelling",
      [
        reviewJson("Carol", "APPROVED", D, 1),
        reviewJson("bob", "APPROVED", D, 3),
        reviewJson("carol", "APPROVED", D, 5),
      ],
      "carol",
    ],
    [
      "a later approver whose approval no longer stands",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("bob", "APPROVED", D, 2),
        reviewJson("bob", "CHANGES_REQUESTED", D, 3),
      ],
      "carol",
    ],
    [
      "a later comment of the earlier approver does not make that approval the later one",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("bob", "APPROVED", D, 2),
        reviewJson("carol", "COMMENTED", D, 3),
      ],
      "bob",
    ],
    [
      "two approvals at the same time: the first account in order",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("bob", "APPROVED", D, 1),
      ],
      "bob",
    ],
    [
      "two spellings of one account: its latest review decides",
      [
        reviewJson("Carol", "APPROVED", D, 1),
        reviewJson("carol", "CHANGES_REQUESTED", D, 2),
      ],
      null,
    ],
    [
      "a pending review after the approval is no review",
      [
        reviewJson("carol", "APPROVED", D, 1),
        { id: 9, user: { login: "carol" }, state: "PENDING", commit_id: null },
      ],
      "carol",
    ],
  ])("%s", async (_what, reviews, approver) => {
    merged(reviews);
    expect(await giving(hostAt(stub).lastConfigCommit())).toEqual({
      commit: CONFIG,
      approver,
    });
  });

  it("throws on a review of that pull request with an unknown state", async () => {
    merged([reviewJson("carol", "LGTM", sha("d"), 1)]);
    const error = await failing(hostAt(stub).lastConfigCommit());
    expect(error.message).toBe(
      `github: GET ${CONFIG_REVIEWS} answered 200 (a review has an unknown state)`,
    );
  });

  it("throws when the reviews of that pull request cannot be read", async () => {
    merged([]);
    stub.on(CONFIG_REVIEWS, { status: 403 });
    const error = await failing(hostAt(stub).lastConfigCommit());
    expect(error.message).toBe(`github: GET ${CONFIG_REVIEWS} answered 403`);
  });
});
