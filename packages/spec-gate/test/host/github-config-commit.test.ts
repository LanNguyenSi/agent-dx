import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_MAX_PAGES } from "../../src/host/index.js";
import { conjunctIds } from "./conjunct-mutants.js";
import {
  BASE,
  failing,
  giving,
  hostAt,
  P,
  PULL_PATH,
  pullJson,
  type Reply,
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
    // After the hour the reviews of the fixtures are submitted in.
    merged_at: "2024-05-01T11:00:00Z",
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
      "an account that approved twice with another approver between: its later approval decides",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("dave", "APPROVED", D, 2),
        reviewJson("carol", "APPROVED", D, 3),
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
});

describe("lastConfigCommit: the approval is of the merged commit and not after the merge", () => {
  /** The head of pull request 3, and a commit it held before. */
  const D = sha("d");
  const E = sha("e");
  const at = (time: string) => ({ submitted_at: `2024-05-01T${time}Z` });

  it.each([
    [
      "the only approval is of another commit than the merged head",
      [reviewJson("carol", "APPROVED", E, 1)],
      null,
    ],
    [
      "an approval of the head, and a later approval of an older commit by another account",
      [
        reviewJson("alice", "APPROVED", D, 1),
        reviewJson("mallory", "APPROVED", E, 2),
      ],
      "alice",
    ],
    [
      "an account whose latest approval is of an older commit",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("carol", "APPROVED", E, 2),
      ],
      null,
    ],
    [
      "an approval submitted after the merge",
      [reviewJson("mallory", "APPROVED", D, 0, at("11:00:01"))],
      null,
    ],
    [
      "an approval before the merge and one by another account after it",
      [
        reviewJson("alice", "APPROVED", D, 1),
        reviewJson("mallory", "APPROVED", D, 0, at("12:00:00")),
      ],
      "alice",
    ],
    [
      "an approval at the very time of the merge",
      [reviewJson("carol", "APPROVED", D, 0, at("11:00:00"))],
      "carol",
    ],
    [
      "an approval before the merge that the account took back after it",
      [
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("carol", "CHANGES_REQUESTED", D, 0, at("11:30:00")),
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

  it.each([
    ["no head", { head: undefined }],
    ["a head that is null", { head: null }],
    ["a head without a commit", { head: { ref: "settings" } }],
    ["a short head commit", { head: { sha: "ddddddd" } }],
    ["a head commit in upper case", { head: { sha: "D".repeat(40) } }],
    ["a merge time that is no time", { merged_at: "yesterday" }],
    ["a merge time without a zone", { merged_at: "2024-05-01T11:00:00" }],
  ])(
    "a merged pull request with %s: the approver is unknown, and no reviews are read",
    async (_what, over) => {
      merged([reviewJson("carol", "APPROVED", D, 1)], [mergedPull(over)]);
      expect(await giving(hostAt(stub).lastConfigCommit())).toEqual({
        commit: CONFIG,
        approver: null,
      });
      expect(stub.hitsOf(CONFIG_REVIEWS)).toEqual([]);
    },
  );
});

describe("lastConfigCommit: reviews of that pull request that cannot be read", () => {
  const D = sha("d");

  it.each([
    ["a review without a user", { user: null }],
    ["a review whose commit the host no longer has", { commit_id: null }],
    ["a review with an unknown state", { state: "LGTM" }],
    ["a review without a time", { submitted_at: undefined }],
  ])(
    "%s: the approver is unknown, and the fact does not fail",
    async (_what, over) => {
      merged([
        reviewJson("carol", "APPROVED", D, 1),
        reviewJson("bob", "COMMENTED", D, 2, over),
      ]);
      expect(await giving(hostAt(stub).lastConfigCommit())).toEqual({
        commit: CONFIG,
        approver: null,
      });
    },
  );

  it("more reviews than the page cap: the approver is unknown, and the fact does not fail", async () => {
    merged([]);
    stub.on(CONFIG_REVIEWS, (hit) => {
      const n = Number(new URL(hit.url, stub.url).searchParams.get("page"));
      return {
        json: [reviewJson("carol", "APPROVED", D, 1)],
        headers: {
          link: `<${stub.url}${CONFIG_REVIEWS}?per_page=100&page=${n + 1}>; rel="next"`,
        },
      };
    });
    expect(await giving(hostAt(stub).lastConfigCommit())).toEqual({
      commit: CONFIG,
      approver: null,
    });
    expect(stub.hitsOf(CONFIG_REVIEWS)).toHaveLength(GITHUB_MAX_PAGES);
  });

  it.each([[401], [403], [404], [500]])(
    "throws when the reviews of that pull request answer %d",
    async (status) => {
      merged([]);
      stub.on(CONFIG_REVIEWS, { status });
      const error = await failing(hostAt(stub).lastConfigCommit());
      expect(error.message).toBe(
        `github: GET ${CONFIG_REVIEWS} answered ${status}`,
      );
    },
  );

  it.each([
    ["no JSON", "<html>Bad gateway</html>", "invalid JSON"],
    ["no list", "{}", "not a list"],
  ])(
    "throws when the reviews of that pull request are %s",
    async (_what, body, reason) => {
      merged([]);
      stub.on(CONFIG_REVIEWS, { body });
      const error = await failing(hostAt(stub).lastConfigCommit());
      expect(error.message).toBe(
        `github: GET ${CONFIG_REVIEWS} answered 200 (${reason})`,
      );
    },
  );
});

/** The head of pull request 3, a commit it held before, and the hour of its reviews. */
const D = sha("d");
const E = sha("e");
/**
 * A review of pull request 3: at minute `when` of the hour before the merge
 * (the merge is at 11:00:00), or at the time `when` of that day.
 */
const rv = (
  login: string,
  state: string,
  commit: string,
  when: number | string,
  over: Record<string, unknown> = {},
) =>
  typeof when === "number"
    ? reviewJson(login, state, commit, when, over)
    : reviewJson(login, state, commit, 0, {
        submitted_at: `2024-05-01T${when}Z`,
        ...over,
      });
const ok = (login: string, commit: string, when: number | string) =>
  rv(login, "APPROVED", commit, when);
/** A pull request that only holds the commit: merged elsewhere, or still open. */
const other = (number: number) =>
  mergedPull({ number, merge_commit_sha: sha("e") });
const open = (number: number) =>
  mergedPull({ number, merged_at: null, merge_commit_sha: null });
const SHAPE_OF_PULL = `github: GET ${PULLS_OF} answered 200 (a pull request has an unexpected shape)`;

interface ConfigRow {
  /** The commits the host lists for the path; one entry with the config commit when left out. */
  commits?: unknown;
  /** The pull requests of that commit; pull request 3, merged, when left out. */
  pulls?: unknown[] | "endless";
  /** The reviews of pull request 3: a list, a list without end, or a status. */
  reviews?: unknown[] | "endless" | { status: number };
  /** The fact, with the config commit when `commit` is left out, or the error. */
  expect:
    { commit?: string | null; approver: string | null } | { error: string };
  /** Whether the reviews of pull request 3 are asked for at all. */
  reviewsAsked?: boolean;
  /** The branch the pull request under check targets; main when left out. */
  target?: string;
  /** The commit the host lists and whose pull requests are routed; the config commit when left out. */
  commit?: string;
  /** The number of the pull request whose reviews are routed; 3 when left out. */
  reviewsOf?: number;
  /** The request for the commits, as it must be sent. */
  askedCommits?: string;
}

const into = (ref: string) => ({
  base: { ref, sha: BASE, repo: { full_name: REPOSITORY } },
});

/**
 * Every conjunct of the last change under `.spec-gate/`: the commit, the
 * pull request that merged it, and which approval of that pull request
 * counts. One row each; the row of an id fails when the change of that id in
 * `conjunct-mutants.ts` is made to the source.
 */
const CONJUNCTS: {
  id: string;
  function: string;
  conjunct: string;
  row: ConfigRow;
}[] = [
  {
    id: "C-CFG-01",
    function: "lastConfigCommit",
    conjunct: "commits that are no list are an error, not 'no commit'",
    row: {
      commits: { commits: [] },
      expect: {
        error: `github: GET ${COMMITS_PATH} answered 200 (not a list)`,
      },
    },
  },
  {
    id: "C-CFG-02",
    function: "lastConfigCommit",
    conjunct: "no commit under the path: commit and approver are unknown",
    row: { commits: [], expect: { commit: null, approver: null } },
  },
  {
    id: "C-CFG-03",
    function: "lastConfigCommit",
    conjunct:
      "the first commit the host lists is the last change, not a later entry",
    row: {
      commits: [{ sha: CONFIG }, { sha: sha("f") }],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-CFG-04",
    function: "lastConfigCommit",
    conjunct: "a commit that is no full commit id is an error",
    row: {
      commits: [{ sha: "ccccccc" }],
      expect: {
        error: `github: GET ${COMMITS_PATH} answered 200 (no commit id)`,
      },
    },
  },
  {
    id: "C-CFG-05",
    function: "lastConfigCommit",
    conjunct: "a commit entry that is no object has no id",
    row: {
      commits: [CONFIG],
      expect: {
        error: `github: GET ${COMMITS_PATH} answered 200 (no commit id)`,
      },
    },
  },
  {
    id: "C-CFG-06",
    function: "lastConfigCommit",
    conjunct: "without a pull request that merged the commit nobody is named",
    row: {
      pulls: [],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
    },
  },
  {
    id: "C-CFG-07",
    function: "lastConfigCommit",
    conjunct:
      "without a pull request that merged the commit the commit is still reported",
    row: { pulls: [other(4)], expect: { commit: CONFIG, approver: null } },
  },
  {
    id: "C-CFG-08",
    function: "lastConfigCommit",
    conjunct:
      "a merged head that is no full commit id: unknown, and the reviews are not read",
    row: {
      pulls: [mergedPull({ head: { sha: "ddddddd" } })],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-CFG-09",
    function: "mergedPullOf",
    conjunct:
      "a pull request without a head has no head: the merge commit does not stand in",
    row: {
      pulls: [mergedPull({ head: undefined })],
      reviews: [ok("carol", CONFIG, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-CFG-10",
    function: "lastConfigCommit",
    conjunct:
      "a merge time that cannot be read: unknown, and the reviews are not read",
    row: {
      pulls: [mergedPull({ merged_at: "yesterday" })],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-CFG-11",
    function: "lastConfigCommit",
    conjunct:
      "reviews that cannot be read as reviews are unknown, not an error",
    row: {
      reviews: [
        ok("carol", D, 1),
        rv("bob", "COMMENTED", D, 2, { user: null }),
      ],
      expect: { approver: null },
    },
  },
  {
    id: "C-CFG-12",
    function: "lastConfigCommit",
    conjunct:
      "reviews that cannot be read as reviews leave the commit reported",
    row: {
      reviews: [
        ok("carol", D, 1),
        rv("bob", "COMMENTED", D, 2, { commit_id: null }),
      ],
      expect: { commit: CONFIG, approver: null },
    },
  },
  {
    id: "C-CFG-13",
    function: "readReviews",
    conjunct: "a request for the reviews that fails is an error, not unknown",
    row: {
      reviews: { status: 500 },
      expect: { error: `github: GET ${CONFIG_REVIEWS} answered 500` },
    },
  },
  {
    id: "C-CFG-14",
    function: "list",
    conjunct: "reviews past the page cap are unknown, not an error",
    row: { reviews: "endless", expect: { approver: null } },
  },
  {
    id: "C-MRG-01",
    function: "mergedPullOf",
    conjunct: "a pull request that is not merged does not count",
    row: {
      pulls: [mergedPull({ merged_at: null })],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-MRG-02",
    function: "mergedPullOf",
    conjunct: "a pull request merged with another merge commit does not count",
    row: {
      pulls: [mergedPull({ merge_commit_sha: sha("e") })],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-MRG-03",
    function: "mergedPullOf",
    conjunct: "a pull request into another branch does not count",
    row: {
      pulls: [
        mergedPull({
          base: { ref: "release", sha: BASE, repo: { full_name: REPOSITORY } },
        }),
      ],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-MRG-04",
    function: "mergedPullOf",
    conjunct: "a pull request into another repository does not count",
    row: {
      pulls: [
        mergedPull({
          base: { ref: "main", sha: BASE, repo: { full_name: "evil/widgets" } },
        }),
      ],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-MRG-05",
    function: "mergedPullOf",
    conjunct: "two pull requests that both merged the commit: none is picked",
    row: {
      pulls: [mergedPull(), mergedPull({ number: 4 })],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-MRG-06",
    function: "mergedPullOf",
    conjunct:
      "the merging pull request is found when it is the first of several",
    row: {
      pulls: [mergedPull(), other(4), open(5)],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-MRG-07",
    function: "mergedPullOf",
    conjunct:
      "the merging pull request is found when it is the last of several",
    row: {
      pulls: [other(4), open(5), mergedPull()],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-MRG-08",
    function: "mergedPullOf",
    conjunct: "the merging pull request is found between others",
    row: {
      pulls: [other(4), mergedPull(), open(5)],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-MRG-09",
    function: "mergedPullOf",
    conjunct: "an entry that is no object is an error, not skipped",
    row: {
      pulls: [3, mergedPull()],
      reviews: [ok("carol", D, 1)],
      expect: {
        error: `github: GET ${PULLS_OF} answered 200 (a pull request is no object)`,
      },
    },
  },
  {
    id: "C-MRG-10",
    function: "list",
    conjunct:
      "pull requests past the page cap are an error: only reviews are reported",
    row: {
      pulls: "endless",
      expect: {
        error: `github: GET ${PULLS_OF} answered 200 (more pages than the page cap)`,
      },
    },
  },
  {
    id: "C-MRG-11",
    function: "mergedPullOf",
    conjunct: "a number that is a text is an error",
    row: {
      pulls: [mergedPull({ number: "3" })],
      reviews: [ok("carol", D, 1)],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-12",
    function: "mergedPullOf",
    conjunct: "a number that is no integer is an error",
    row: {
      pulls: [mergedPull({ number: 3.5 })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-13",
    function: "mergedPullOf",
    conjunct: "a number below one is an error",
    row: {
      pulls: [mergedPull({ number: 0 })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-14",
    function: "mergedPullOf",
    conjunct: "a merge time of another type is an error, not 'not merged'",
    row: {
      pulls: [mergedPull({ merged_at: true })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-15",
    function: "mergedPullOf",
    conjunct:
      "a merge commit of another type is an error, not 'another commit'",
    row: {
      pulls: [mergedPull({ merge_commit_sha: 1 })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-16",
    function: "mergedPullOf",
    conjunct: "a base branch of another type is an error, not 'another branch'",
    row: {
      pulls: [
        mergedPull({ base: { ref: 1, repo: { full_name: REPOSITORY } } }),
      ],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-17",
    function: "mergedPullOf",
    conjunct:
      "a base without a repository is an error, not 'another repository'",
    row: {
      pulls: [mergedPull({ base: { ref: "main", repo: null } })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-18",
    function: "mergedPullOf",
    conjunct: "a base repository without a name is an error",
    row: {
      pulls: [mergedPull({ base: { ref: "main", repo: {} } })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-19",
    function: "mergedPullOf",
    conjunct: "a pull request without a base is an error, not skipped",
    row: {
      pulls: [mergedPull({ base: null })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-20",
    function: "mergedPullOf",
    conjunct:
      "an open pull request beside the merging one is skipped, not an error",
    row: {
      pulls: [open(5), mergedPull()],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-MRG-21",
    function: "mergedPullOf",
    conjunct:
      "a merged pull request without a merge commit beside the merging one is skipped",
    row: {
      pulls: [mergedPull({ number: 5, merge_commit_sha: null }), mergedPull()],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-MRG-22",
    function: "mergedPullOf",
    conjunct: "pull requests that only hold the commit name no merging one",
    row: {
      pulls: [other(4), open(5)],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-APP-01",
    function: "latestApprover",
    conjunct: "an approval after the merge does not count",
    row: {
      reviews: [ok("mallory", D, "11:00:01")],
      expect: { approver: null },
    },
  },
  {
    id: "C-APP-02",
    function: "latestApprover",
    conjunct: "an approval at the very time of the merge counts",
    row: {
      reviews: [ok("carol", D, "11:00:00")],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-APP-03",
    function: "latestApprover",
    conjunct:
      "a review of any state after the merge is dropped: a later withdrawal leaves the approver",
    row: {
      reviews: [
        ok("carol", D, 1),
        rv("carol", "CHANGES_REQUESTED", D, "11:30:00"),
      ],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-APP-04",
    function: "latestApprover",
    conjunct: "a late approval is dropped when the host lists it first",
    row: {
      reviews: [ok("mallory", D, "12:00:00"), ok("alice", D, 1)],
      expect: { approver: "alice" },
    },
  },
  {
    id: "C-APP-05",
    function: "latestApprover",
    conjunct: "a late approval is dropped when the host lists it last",
    row: {
      reviews: [ok("alice", D, 1), ok("mallory", D, "12:00:00")],
      expect: { approver: "alice" },
    },
  },
  {
    id: "C-APP-06",
    function: "latestApprover",
    conjunct:
      "a late approval is dropped when the host lists it between others",
    row: {
      reviews: [
        ok("alice", D, 1),
        ok("mallory", D, "12:00:00"),
        rv("bob", "COMMENTED", D, 2),
      ],
      expect: { approver: "alice" },
    },
  },
  {
    id: "C-APP-07",
    function: "latestApprover",
    conjunct: "only an approval that still stood at the merge counts",
    row: {
      reviews: [ok("carol", D, 1), rv("carol", "CHANGES_REQUESTED", D, 2)],
      expect: { approver: null },
    },
  },
  {
    id: "C-APP-08",
    function: "latestApprover",
    conjunct:
      "an approval of another commit than the merged head does not count",
    row: { reviews: [ok("carol", E, 1)], expect: { approver: null } },
  },
  {
    id: "C-APP-09",
    function: "latestApprover",
    conjunct:
      "an account off the head that sorts first is skipped: the search goes on",
    row: {
      reviews: [ok("aaron", E, 2), ok("bob", D, 1)],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-APP-10",
    function: "latestApprover",
    conjunct:
      "an account off the head between two on it is skipped: the search goes on",
    row: {
      reviews: [ok("aaron", D, 1), ok("bob", E, 5), ok("carol", D, 2)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-APP-11",
    function: "latestApprover",
    conjunct:
      "an account off the head that sorts last and approved last does not count",
    row: {
      reviews: [ok("bob", D, 1), ok("zed", E, 5)],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-APP-12",
    function: "latestApprover",
    conjunct:
      "the approval that stands is compared: an earlier one of the head by the same account does not count",
    row: {
      reviews: [ok("carol", D, 1), ok("carol", E, 2)],
      expect: { approver: null },
    },
  },
  {
    id: "C-APP-13",
    function: "latestApprover",
    conjunct:
      "the time of an approval is taken from that account's reviews only",
    row: {
      reviews: [ok("zed", D, 5), ok("bob", D, 1)],
      expect: { approver: "zed" },
    },
  },
  {
    id: "C-APP-14",
    function: "latestApprover",
    conjunct: "the later approval wins when its account sorts first",
    row: {
      reviews: [ok("zed", D, 1), ok("bob", D, 5)],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-APP-15",
    function: "latestApprover",
    conjunct: "the later approval wins when its account sorts last",
    row: {
      reviews: [ok("bob", D, 2), ok("zed", D, 4)],
      expect: { approver: "zed" },
    },
  },
  {
    id: "C-APP-16",
    function: "latestApprover",
    conjunct:
      "the later approval wins when its account sorts between two others",
    row: {
      reviews: [ok("aaron", D, 1), ok("bob", D, 5), ok("carol", D, 2)],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-APP-17",
    function: "latestApprover",
    conjunct: "a later comment does not make an approval the later one",
    row: {
      reviews: [
        ok("carol", D, 1),
        ok("bob", D, 2),
        rv("carol", "COMMENTED", D, 3),
      ],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-APP-18",
    function: "latestApprover",
    conjunct: "the latest approval of an account sets its time, not its first",
    row: {
      reviews: [ok("carol", D, 1), ok("dave", D, 2), ok("carol", D, 3)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-APP-19",
    function: "latestApprover",
    conjunct: "on a tie the account that sorts first is named",
    row: {
      reviews: [ok("carol", D, 1), ok("bob", D, 1)],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-APP-20",
    function: "latestApprover",
    conjunct:
      "accounts are visited in their own order, whatever order the host lists the reviews in",
    row: {
      reviews: [ok("bob", D, 1), ok("carol", D, 1)],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-APP-21",
    function: "latestApprover",
    conjunct: "without an approval nobody is named",
    row: { reviews: [], expect: { approver: null } },
  },
  {
    id: "C-APP-22",
    function: "latestApprover",
    conjunct: "one approval of the head before the merge names its account",
    row: { reviews: [ok("carol", D, 1)], expect: { approver: "carol" } },
  },
  {
    id: "C-APP-23",
    function: "latestApprover",
    conjunct: "the account that sorts last is looked at",
    row: {
      reviews: [ok("bob", D, 1), ok("zed", D, 5)],
      expect: { approver: "zed" },
    },
  },
  {
    id: "C-APP-24",
    function: "latestApprover",
    conjunct: "the account that sorts first is looked at",
    row: {
      reviews: [ok("bob", D, 5), ok("zed", E, 1)],
      expect: { approver: "bob" },
    },
  },
  {
    id: "C-CFG-15",
    function: "lastConfigCommit",
    conjunct:
      "a pull request merged into the target branch counts when the target is not main",
    row: {
      target: "release",
      pulls: [mergedPull(into("release"))],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-CFG-16",
    function: "lastConfigCommit",
    conjunct:
      "a pull request merged into main does not count when the target is another branch",
    row: {
      target: "release",
      pulls: [mergedPull()],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
      reviewsAsked: false,
    },
  },
  {
    id: "C-CFG-17",
    function: "lastConfigCommit",
    conjunct:
      "the pull requests asked for are those of the commit the host listed",
    row: {
      commit: sha("9"),
      pulls: [mergedPull({ merge_commit_sha: sha("9") })],
      reviews: [ok("carol", D, 1)],
      expect: { commit: sha("9"), approver: "carol" },
    },
  },
  {
    id: "C-CFG-18",
    function: "lastConfigCommit",
    conjunct: "the reviews read are those of the merging pull request",
    row: {
      pulls: [mergedPull({ number: 12 })],
      reviewsOf: 12,
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-CFG-19",
    function: "lastConfigCommit",
    conjunct:
      "approvals are compared with the head of the merging pull request",
    row: {
      pulls: [mergedPull({ head: { sha: sha("8") } })],
      reviews: [ok("carol", sha("8"), 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-CFG-20",
    function: "lastConfigCommit",
    conjunct:
      "approvals are compared with the merge time of the merging pull request",
    row: {
      reviews: [ok("mallory", D, "11:00:01")],
      expect: { approver: null },
    },
  },
  {
    id: "C-CFG-21",
    function: "lastConfigCommit",
    conjunct: "the target branch is one value of the query, encoded",
    row: {
      target: "release/1.x+y",
      commits: [],
      expect: { commit: null, approver: null },
      askedCommits: `${COMMITS_PATH}?sha=release%2F1.x%2By&path=.spec-gate&per_page=1`,
    },
  },
  {
    id: "C-CFG-22",
    function: "lastConfigCommit",
    conjunct: "the commits asked for are those of the target branch",
    row: {
      target: "release",
      commits: [],
      expect: { commit: null, approver: null },
      askedCommits: `${COMMITS_PATH}?sha=release&path=.spec-gate&per_page=1`,
    },
  },
  {
    id: "C-CFG-23",
    function: "lastConfigCommit",
    conjunct: "the commits asked for are those under .spec-gate",
    row: {
      commits: [],
      expect: { commit: null, approver: null },
      askedCommits: COMMITS_URL,
    },
  },
  {
    id: "C-CFG-24",
    function: "mergedPullOf",
    conjunct: "the path of the pull requests names the commit",
    row: {
      commit: sha("7"),
      pulls: [mergedPull({ merge_commit_sha: sha("7") })],
      reviews: [ok("carol", D, 1)],
      expect: { commit: sha("7"), approver: "carol" },
    },
  },
  {
    id: "C-CFG-25",
    function: "readReviews",
    conjunct: "the path of the reviews names the pull request",
    row: {
      pulls: [mergedPull({ number: 15 })],
      reviewsOf: 15,
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-APP-25",
    function: "latestApprover",
    conjunct: "an approval within the second after the merge does not count",
    row: {
      reviews: [ok("mallory", D, "11:00:00.500")],
      expect: { approver: null },
    },
  },
  {
    id: "C-MRG-23",
    function: "mergedPullOf",
    conjunct:
      "a base repository that is null is an unexpected shape, and no crash",
    row: {
      pulls: [mergedPull({ base: { ref: "main", sha: BASE, repo: null } })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-24",
    function: "mergedPullOf",
    conjunct:
      "a merge time that is neither null nor a text is an unexpected shape",
    row: {
      pulls: [mergedPull({ merged_at: 5 })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-25",
    function: "mergedPullOf",
    conjunct:
      "a base that is null has no branch: an unexpected shape, and no crash",
    row: {
      pulls: [mergedPull({ base: null })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-MRG-26",
    function: "mergedPullOf",
    conjunct:
      "a base that is null has no repository: an unexpected shape, and no crash",
    row: {
      pulls: [mergedPull({ base: null })],
      expect: { error: SHAPE_OF_PULL },
    },
  },
  {
    id: "C-CFG-26",
    function: "lastConfigCommit",
    conjunct: "the approver is looked for in the reviews that were read",
    row: { reviews: [ok("carol", D, 1)], expect: { approver: "carol" } },
  },
  {
    id: "C-CFG-27",
    function: "lastConfigCommit",
    conjunct: "the commits are asked for at the path of the commits",
    row: {
      commits: [],
      expect: { commit: null, approver: null },
      askedCommits: COMMITS_URL,
    },
  },
  {
    id: "C-CFG-28",
    function: "lastConfigCommit",
    conjunct:
      "without a readable merge time no review counts, however early it was",
    row: {
      pulls: [mergedPull({ merged_at: "soon" })],
      reviews: [
        rv("carol", "APPROVED", D, 0, { submitted_at: "1969-12-31T23:59:59Z" }),
      ],
      expect: { approver: null },
    },
  },
  {
    id: "C-CFG-29",
    function: "mergedPullOf",
    conjunct:
      "a head that is null is no commit: the approver is unknown, and that is no crash",
    row: {
      pulls: [mergedPull({ head: null })],
      reviews: [ok("carol", D, 1)],
      expect: { approver: null },
    },
  },
  {
    id: "C-CFG-30",
    function: "lastConfigCommit",
    conjunct: "a listed commit that is null has no id, and that is no crash",
    row: {
      commits: [null],
      expect: {
        error: `github: GET ${COMMITS_PATH} answered 200 (no commit id)`,
      },
    },
  },
  {
    id: "C-APP-26",
    function: "latestApprover",
    conjunct: "the first standing approval is taken without a comparison",
    row: { reviews: [ok("carol", D, 1)], expect: { approver: "carol" } },
  },
  {
    id: "C-MRG-27",
    function: "mergedPullOf",
    conjunct: "pull request 1 is a pull request",
    row: {
      pulls: [mergedPull({ number: 1 })],
      reviewsOf: 1,
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-MRG-28",
    function: "mergedPullOf",
    conjunct:
      "an open pull request with the same commit does not stand beside the merged one",
    row: {
      pulls: [mergedPull({ number: 4, merged_at: null }), mergedPull()],
      reviews: [ok("carol", D, 1)],
      expect: { approver: "carol" },
    },
  },
  {
    id: "C-APP-27",
    function: "latestApprover",
    conjunct:
      "the standing approvals are those of the reviews before the merge",
    row: { reviews: [ok("carol", D, 1)], expect: { approver: "carol" } },
  },
];

describe("CONJUNCTS: the last change under .spec-gate and its approver", () => {
  it("the table and the list of changes name the same conjuncts, each once", () => {
    const ids = CONJUNCTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(conjunctIds("github-config-commit"));
  });

  /** A list without end: every page holds `entry` and a link to the next page. */
  const endless =
    (path: string, entry: unknown) =>
    (hit: { url: string }): Reply => {
      const n = Number(new URL(hit.url, stub.url).searchParams.get("page"));
      return {
        json: [entry],
        headers: {
          link: `<${stub.url}${path}?per_page=100&page=${n + 1}>; rel="next"`,
        },
      };
    };

  it.each(
    CONJUNCTS.map((entry) => [entry.id, entry.conjunct, entry.row] as const),
  )("%s: %s", async (_id, _conjunct, row) => {
    const commit = row.commit ?? CONFIG;
    const pullsPath = `${P}/commits/${commit}/pulls`;
    const reviewsPath = `${P}/pulls/${row.reviewsOf ?? 3}/reviews`;
    if (row.target !== undefined) {
      stub.on(PULL_PATH, { json: pullJson(into(row.target)) });
    }
    stub.on(COMMITS_PATH, {
      json: "commits" in row ? row.commits : [{ sha: commit }],
    });
    stub.on(
      pullsPath,
      row.pulls === "endless"
        ? endless(PULLS_OF, other(4))
        : { json: row.pulls ?? [mergedPull()] },
    );
    const reviews = row.reviews ?? [];
    stub.on(
      reviewsPath,
      reviews === "endless"
        ? endless(CONFIG_REVIEWS, ok("carol", D, 1))
        : Array.isArray(reviews)
          ? { json: reviews }
          : reviews,
    );
    const call = hostAt(stub).lastConfigCommit();
    if ("error" in row.expect) {
      expect((await failing(call)).message).toBe(row.expect.error);
    } else {
      expect(await giving(call)).toEqual({
        commit: "commit" in row.expect ? row.expect.commit : CONFIG,
        approver: row.expect.approver,
      });
    }
    if (row.askedCommits !== undefined) {
      expect(stub.hitsOf(COMMITS_PATH).map((hit) => hit.url)).toEqual([
        row.askedCommits,
      ]);
    }
    if (row.reviewsAsked !== undefined) {
      const asked = stub.hits.filter((hit) =>
        /\/pulls\/\d+\/reviews$/.test(hit.path),
      );
      expect(asked.length > 0).toBe(row.reviewsAsked);
    }
  });
});
