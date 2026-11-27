import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { instantOf } from "../../src/approve/facts.js";
import { GITHUB_MAX_PAGES, GITHUB_PAGE_SIZE } from "../../src/host/index.js";
import { conjunctIds } from "./conjunct-mutants.js";
import {
  failing,
  giving,
  HEAD,
  hostAt,
  FORBIDDEN_CHARACTERS,
  PULL,
  REPOSITORY,
  type Reply,
  reviewJson,
  REVIEWS_PATH,
  sha,
  Stub,
} from "./stub.js";

let stub: Stub;
/** A second origin: a link that points there leaves the API. */
let foreign: Stub;

beforeAll(async () => {
  stub = await Stub.start();
  foreign = await Stub.start();
});
afterAll(async () => {
  await stub.close();
  await foreign.close();
});
beforeEach(() => {
  stub.reset();
  foreign.reset();
});

const AT = `github: GET ${REVIEWS_PATH} answered 200`;
const page = (n: number): string =>
  `${REVIEWS_PATH}?per_page=${GITHUB_PAGE_SIZE}&page=${n}`;
/** A `Link` header value with one entry. */
const link = (target: string, rel = 'rel="next"'): string =>
  `<${target}>; ${rel}`;
/** The address of page `n` as the stub itself would name it. */
const next = (n: number): string => `${stub.url}${page(n)}`;

describe("reviews: one page", () => {
  it("maps login, state, commit and time of every submitted review, in the order of the host", async () => {
    stub.on(REVIEWS_PATH, {
      json: [
        reviewJson("alice", "APPROVED", HEAD, 1),
        reviewJson("bob", "CHANGES_REQUESTED", sha("c"), 2),
        reviewJson("carol", "COMMENTED", HEAD, 3),
        reviewJson("dave", "DISMISSED", HEAD, 4),
      ],
    });
    const reviews = await giving(hostAt(stub).reviews());
    expect(reviews).toEqual([
      {
        login: "alice",
        state: "APPROVED",
        commit: HEAD,
        submittedAt: "2024-05-01T10:01:00Z",
      },
      {
        login: "bob",
        state: "CHANGES_REQUESTED",
        commit: sha("c"),
        submittedAt: "2024-05-01T10:02:00Z",
      },
      {
        login: "carol",
        state: "COMMENTED",
        commit: HEAD,
        submittedAt: "2024-05-01T10:03:00Z",
      },
      {
        login: "dave",
        state: "DISMISSED",
        commit: HEAD,
        submittedAt: "2024-05-01T10:04:00Z",
      },
    ]);
    expect(stub.hits.map((hit) => hit.url)).toEqual([page(1)]);
  });

  it("gives an empty list for a pull request without reviews", async () => {
    stub.on(REVIEWS_PATH, { json: [] });
    expect(await giving(hostAt(stub).reviews())).toEqual([]);
  });

  it("leaves out a pending review, which has no time and may have no commit", async () => {
    stub.on(REVIEWS_PATH, {
      json: [
        reviewJson("alice", "APPROVED", HEAD, 1),
        {
          id: 99,
          user: { login: "bob" },
          state: "PENDING",
          commit_id: null,
          body: "",
        },
      ],
    });
    const reviews = await giving(hostAt(stub).reviews());
    expect(reviews.map((review) => review.login)).toEqual(["alice"]);
  });

  it.each([
    ["a state the check does not know", { state: "REJECTED" }],
    ["a known state in lower case", { state: "approved" }],
    ["a known state with a space", { state: "APPROVED " }],
    ["an empty state", { state: "" }],
  ])("throws on %s instead of mapping it", async (_what, over) => {
    stub.on(REVIEWS_PATH, {
      json: [reviewJson("alice", "APPROVED", HEAD, 1, over)],
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (a review has an unknown state)`);
  });

  it.each([
    ["no state", { state: undefined }, "a review has no state"],
    ["a state that is no text", { state: 1 }, "a review has no state"],
    ["no user", { user: null }, "a review has no login"],
    ["a user without a login", { user: { id: 1 } }, "a review has no login"],
    [
      "a login with a line break",
      { user: { login: "ali\nce" } },
      "a review has no login",
    ],
    ["no commit", { commit_id: null }, "a review has no commit"],
    ["a short commit id", { commit_id: "abc1234" }, "a review has no commit"],
    [
      "no submission time",
      { submitted_at: undefined },
      "a review has no submission time",
    ],
    [
      "a submission time that is no text",
      { submitted_at: 1714557600 },
      "a review has no submission time",
    ],
  ])("throws on a review with %s", async (_what, over, reason) => {
    stub.on(REVIEWS_PATH, {
      json: [
        reviewJson("bob", "APPROVED", HEAD, 0),
        reviewJson("alice", "APPROVED", HEAD, 1, over),
      ],
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (${reason})`);
  });

  it.each([["a text"], [7], [null], [["nested"]]])(
    "throws on an entry that is %j",
    async (entry) => {
      stub.on(REVIEWS_PATH, { json: [entry] });
      const error = await failing(hostAt(stub).reviews());
      expect(error.message).toBe(`${AT} (a review is no object)`);
    },
  );

  it.each([
    ["an object", { reviews: [] }],
    ["null", null],
    ["a text", "[]"],
  ])("throws on a body that is %s", async (_what, json) => {
    stub.on(REVIEWS_PATH, { json });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (not a list)`);
  });

  // The adapter reads a time by the rule of the approval check. Each row is
  // checked against that rule itself, so the two cannot drift apart.
  it.each([
    ["2024-05-01T10:00:00Z"],
    ["2024-05-01T10:00:00.123Z"],
    ["2024-05-01T12:00:00+02:00"],
    ["2024-02-29T23:59:59-08:00"],
    ["2024-05-01T10:00:00"],
    ["2024-05-01 10:00:00Z"],
    ["2024-05-01T10:00Z"],
    ["2024-02-31T10:00:00Z"],
    ["2023-02-29T10:00:00Z"],
    ["2024-05-01T24:00:00Z"],
    ["2024-05-01T10:60:00Z"],
    ["2024-13-01T10:00:00Z"],
    ["2024-05-01T10:00:00z"],
    ["1714557600"],
    [""],
    ["yesterday"],
  ])("reads the time %j as the approval check does", async (submittedAt) => {
    stub.on(REVIEWS_PATH, {
      json: [
        reviewJson("alice", "APPROVED", HEAD, 0, { submitted_at: submittedAt }),
      ],
    });
    if (instantOf(submittedAt) === null) {
      const error = await failing(hostAt(stub).reviews());
      expect(error.message).toBe(`${AT} (a review has no submission time)`);
    } else {
      const reviews = await giving(hostAt(stub).reviews());
      expect(reviews[0]!.submittedAt).toBe(submittedAt);
    }
  });

  it("the table above holds times of both kinds", () => {
    expect(instantOf("2024-05-01T10:00:00Z")).not.toBeNull();
    expect(instantOf("2024-02-31T10:00:00Z")).toBeNull();
  });
});

describe("reviews: pages", () => {
  it("reads three pages through the next links and keeps a late request for changes", async () => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: {
        link: `${link(next(2))}, ${link(next(3), 'rel="last"')}`,
      },
    });
    stub.on(page(2), {
      json: [reviewJson("bob", "COMMENTED", HEAD, 2)],
      headers: {
        link: `${link(next(1), 'rel="prev"')}, ${link(next(3))}, ${link(next(3), 'rel="last"')}, ${link(next(1), 'rel="first"')}`,
      },
    });
    stub.on(page(3), {
      json: [reviewJson("alice", "CHANGES_REQUESTED", HEAD, 3)],
      headers: {
        link: `${link(next(2), 'rel="prev"')}, ${link(next(1), 'rel="first"')}`,
      },
    });
    const reviews = await giving(hostAt(stub).reviews());
    expect(reviews.map((review) => [review.login, review.state])).toEqual([
      ["alice", "APPROVED"],
      ["bob", "COMMENTED"],
      ["alice", "CHANGES_REQUESTED"],
    ]);
    expect(stub.hits.map((hit) => hit.url)).toEqual([
      page(1),
      page(2),
      page(3),
    ]);
  });

  it("stops at a page whose links name no next page", async () => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED")],
      headers: {
        link: `${link(next(1), 'rel="first"')}, ${link(next(1), 'rel="last"')}`,
      },
    });
    expect(await giving(hostAt(stub).reviews())).toHaveLength(1);
    expect(stub.hits).toHaveLength(1);
  });

  it.each([
    [
      "the repository by its numeric id",
      "/repositories/1300192/pulls/7/reviews",
    ],
    ["the repository in another case", "/repos/Acme/WIDGETS/pulls/7/reviews"],
  ])("accepts a next link that names %s", async (_what, path) => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: link(`${stub.url}${path}?per_page=100&page=2`) },
    });
    stub.on(page(2), { json: [reviewJson("bob", "DISMISSED", HEAD, 2)] });
    const reviews = await giving(hostAt(stub).reviews());
    expect(reviews.map((review) => review.login)).toEqual(["alice", "bob"]);
    // The next page is asked for at the adapter's own path, not at the link's.
    expect(stub.hits.map((hit) => hit.url)).toEqual([page(1), page(2)]);
  });

  it.each([
    ["without quotes", "rel=next"],
    ["among other relations", 'rel="prev next"'],
    ["in upper case", 'REL="NEXT"'],
    ["after another parameter", 'title="x"; rel="next"'],
    [
      "after a quoted value that reads like a relation",
      'title="; rel=prev"; rel="next"',
    ],
  ])("reads a next relation written %s", async (_what, rel) => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: link(next(2), rel) },
    });
    stub.on(page(2), { json: [reviewJson("bob", "APPROVED", HEAD, 2)] });
    expect(await giving(hostAt(stub).reviews())).toHaveLength(2);
  });

  it("reads the path prefix of the API root in a next link", async () => {
    const root = `${stub.url}/api/v3`;
    stub.on(`/api/v3${page(1)}`, {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: link(`${root}${page(2)}`) },
    });
    stub.on(`/api/v3${page(2)}`, {
      json: [reviewJson("bob", "APPROVED", HEAD, 2)],
    });
    const reviews = await giving(hostAt(stub, { apiUrl: root }).reviews());
    expect(reviews).toHaveLength(2);
    // The same link without the prefix names a path outside the API root.
    stub.reset();
    stub.on(`/api/v3${page(1)}`, {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: link(next(2)) },
    });
    const error = await failing(hostAt(stub, { apiUrl: root }).reviews());
    expect(error.message).toBe(`${AT} (next link names another path)`);
    // And so does a link under another prefix of the same length.
    stub.on(`/api/v3${page(1)}`, {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: link(`${stub.url}/api/v4${page(2)}`) },
    });
    const other = await failing(hostAt(stub, { apiUrl: root }).reviews());
    expect(other.message).toBe(`${AT} (next link names another path)`);
  });

  it("throws on a next link to another origin and sends nothing there", async () => {
    foreign.on(REVIEWS_PATH, { json: [] });
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: link(`${foreign.url}${page(2)}`) },
    });
    stub.on(page(2), {
      json: [reviewJson("alice", "CHANGES_REQUESTED", HEAD, 2)],
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (next link leaves the API origin)`);
    expect(foreign.hits).toEqual([]);
    expect(stub.hits.map((hit) => hit.url)).toEqual([page(1)]);
  });

  it.each([
    ["another scheme", "https://127.0.0.1:PORT"],
    ["another port", "http://127.0.0.1:1"],
    ["another host name", "http://localhost:PORT"],
    ["a user name", "http://user@127.0.0.1:PORT"],
    ["a password", "http://:pw@127.0.0.1:PORT"],
  ])("throws on a next link with %s", async (_what, origin) => {
    const target = origin.replace("PORT", new URL(stub.url).port) + page(2);
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED")],
      headers: { link: link(target) },
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (next link leaves the API origin)`);
    expect(stub.hits).toHaveLength(1);
  });

  it.each([
    [
      "the reviews of another pull request",
      "/repos/acme/widgets/pulls/8/reviews",
    ],
    ["another repository", "/repos/acme/gadgets/pulls/7/reviews"],
    ["another list", "/repos/acme/widgets/pulls/7/comments"],
    ["a longer path", "/repos/acme/widgets/pulls/7/reviews/1"],
    ["a path above the list", "/x/repos/acme/widgets/pulls/7/reviews"],
    ["an id that is no number", "/repositories/abc/pulls/7/reviews"],
    ["an id with more below it", "/repositories/1/2/pulls/7/reviews"],
    ["no repository", "/pulls/7/reviews"],
  ])("throws on a next link to %s", async (_what, path) => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED")],
      headers: { link: link(`${stub.url}${path}?per_page=100&page=2`) },
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (next link names another path)`);
    expect(stub.hits).toHaveLength(1);
  });

  it.each([
    ["the same page", "?per_page=100&page=1"],
    ["a page further on", "?per_page=100&page=3"],
    ["no page", "?per_page=100"],
    ["two pages", "?page=2&page=3"],
    ["a page that is no number", "?page=two"],
    ["a page with a sign", "?page=%2B2"],
  ])("throws on a next link that names %s", async (_what, query) => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED")],
      headers: { link: link(`${stub.url}${REVIEWS_PATH}${query}`) },
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (next link names another page)`);
    expect(stub.hits).toHaveLength(1);
  });

  it.each([
    ["a relative target", link(page(2))],
    ["an empty target", link("")],
    ["no angle brackets", `${"http://127.0.0.1"}${page(2)}; rel="next"`],
    ["an open bracket", `<http://127.0.0.1${page(2)}; rel="next"`],
    ["text after the entry", `${link("http://127.0.0.1/x")} trailing`],
    ["a parameter without a value", `<http://127.0.0.1/x>; rel`],
  ])("throws on a link header with %s", async (_what, header) => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED")],
      headers: { link: header },
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (next link not readable)`);
    expect(stub.hits).toHaveLength(1);
  });

  it("throws on a link header that names two next pages", async () => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED")],
      headers: { link: `${link(next(2))}, ${link(next(2))}` },
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (next link not readable)`);
  });

  it("asks for the next page after a full page without a link, so a missing header hides nothing", async () => {
    const full = Array.from({ length: GITHUB_PAGE_SIZE }, (_, i) =>
      reviewJson(`user${i}`, "APPROVED", HEAD, 1),
    );
    stub.on(page(1), { json: full });
    stub.on(page(2), {
      json: [reviewJson("user0", "CHANGES_REQUESTED", HEAD, 2)],
    });
    const reviews = await giving(hostAt(stub).reviews());
    expect(reviews).toHaveLength(GITHUB_PAGE_SIZE + 1);
    expect(reviews.at(-1)).toMatchObject({
      login: "user0",
      state: "CHANGES_REQUESTED",
    });
    expect(stub.hits.map((hit) => hit.url)).toEqual([page(1), page(2)]);
  });

  it("ends after a full page when the page behind it is empty", async () => {
    const full = Array.from({ length: GITHUB_PAGE_SIZE }, (_, i) =>
      reviewJson(`user${i}`, "APPROVED", HEAD, 1),
    );
    stub.on(page(1), { json: full });
    stub.on(page(2), { json: [] });
    expect(await giving(hostAt(stub).reviews())).toHaveLength(GITHUB_PAGE_SIZE);
    expect(stub.hits).toHaveLength(2);
  });

  it("does not ask again after a page that is one short of full and has no link", async () => {
    const short = Array.from({ length: GITHUB_PAGE_SIZE - 1 }, (_, i) =>
      reviewJson(`user${i}`, "APPROVED", HEAD, 1),
    );
    stub.on(page(1), { json: short });
    expect(await giving(hostAt(stub).reviews())).toHaveLength(
      GITHUB_PAGE_SIZE - 1,
    );
    expect(stub.hits).toHaveLength(1);
  });

  /** Answers every page with one review and a link to the page after it, up to `last`. */
  const endless =
    (last: number) =>
    (hit: { url: string }): Reply => {
      const n = Number(new URL(hit.url, stub.url).searchParams.get("page"));
      return {
        json: [reviewJson(`user${n}`, "APPROVED", HEAD, 1)],
        headers: n < last ? { link: link(next(n + 1)) } : {},
      };
    };

  it("reads a list of exactly the page cap", async () => {
    stub.on(REVIEWS_PATH, endless(GITHUB_MAX_PAGES));
    const reviews = await giving(hostAt(stub).reviews());
    expect(reviews).toHaveLength(GITHUB_MAX_PAGES);
    expect(stub.hits).toHaveLength(GITHUB_MAX_PAGES);
  });

  it("throws on a list longer than the page cap instead of cutting it", async () => {
    stub.on(REVIEWS_PATH, endless(GITHUB_MAX_PAGES + 1));
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`${AT} (more pages than the page cap)`);
    expect(stub.hits).toHaveLength(GITHUB_MAX_PAGES);
  });

  it("throws on a later page that fails, instead of returning the pages before it", async () => {
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: link(next(2)) },
    });
    stub.on(page(2), { status: 502 });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(`github: GET ${REVIEWS_PATH} answered 502`);
  });

  it.each([[403], [404], [500]])(
    "throws when the list answers %d",
    async (status) => {
      stub.on(REVIEWS_PATH, { status, json: { message: "no" } });
      const error = await failing(hostAt(stub).reviews());
      expect(error.message).toBe(
        `github: GET ${REVIEWS_PATH} answered ${status}`,
      );
    },
  );

  it("asks again on every call: reviews are not kept", async () => {
    stub.on(REVIEWS_PATH, { json: [] });
    const host = hostAt(stub);
    await host.reviews();
    await host.reviews();
    expect(stub.hits).toHaveLength(2);
  });
});

/** A review by `login`, approved on the head at minute 1 unless `over` says otherwise. */
const by = (login: string, over: Record<string, unknown> = {}) =>
  reviewJson(login, "APPROVED", HEAD, 1, over);
const NEXT = '<{P:2}>; rel="next"';

interface PageOf {
  /** The entries of the page; `fill` is that many reviews of made-up accounts. */
  reviews?: unknown[];
  fill?: number;
  /** A body sent as it is, in place of the entries. */
  body?: string;
  /**
   * The `Link` header. `{P:n}` is the address of page n of this list,
   * `{page:n}` its path and query, `{root}` the root of the stub, `{foreign}`
   * the root of another origin, `{host}` the host and port of the stub.
   */
  link?: string;
}

interface ReviewsRow {
  /** The path prefix of the API root. */
  prefix?: string;
  pages: PageOf[];
  /** Answer every page up to this one with one review and a next link. */
  endless?: number;
  /** The logins in order, how many reviews, or the reason of the error. */
  expect: { logins: string[] } | { count: number } | { error: string };
  /** The pages that are asked for, in order. */
  asked: number[];
  /** The pull request the adapter is made for; 7 when left out. */
  number?: number;
  /** The repository the adapter is made for; acme/widgets when left out. */
  repository?: string;
}

const upTo = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => i + 1);

/**
 * Every conjunct of reading a list of reviews: the entries, the pages, the
 * entries and parameters of a `Link` header, and what a next link must be.
 * One row each; the row of an id fails when the change of that id in
 * `conjunct-mutants.ts` is made to the source.
 */
const CONJUNCTS: {
  id: string;
  function: string;
  conjunct: string;
  row: ReviewsRow;
}[] = [
  {
    id: "C-REV-01",
    function: "readReviews",
    conjunct:
      "an entry that is no object, first in the list, makes the list unreadable",
    row: {
      pages: [{ reviews: ["text", by("alice")] }],
      expect: { error: "a review is no object" },
      asked: [1],
    },
  },
  {
    id: "C-REV-02",
    function: "readReviews",
    conjunct:
      "an entry without a state, in the middle, makes the list unreadable",
    row: {
      pages: [
        {
          reviews: [by("alice"), by("bob", { state: undefined }), by("carol")],
        },
      ],
      expect: { error: "a review has no state" },
      asked: [1],
    },
  },
  {
    id: "C-REV-03",
    function: "readReviews",
    conjunct: "a pending review, last in the list, is left out",
    row: {
      pages: [{ reviews: [by("alice"), by("bob", { state: "PENDING" })] }],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-REV-04",
    function: "readReviews",
    conjunct:
      "a pending review, first in the list, is skipped and does not end the list",
    row: {
      pages: [
        {
          reviews: [by("alice", { state: "PENDING" }), by("bob"), by("carol")],
        },
      ],
      expect: { logins: ["bob", "carol"] },
      asked: [1],
    },
  },
  {
    id: "C-REV-05",
    function: "readReviews",
    conjunct:
      "a pending review, in the middle, is skipped and does not end the list",
    row: {
      pages: [
        {
          reviews: [by("alice"), by("bob", { state: "PENDING" }), by("carol")],
        },
      ],
      expect: { logins: ["alice", "carol"] },
      asked: [1],
    },
  },
  {
    id: "C-REV-06",
    function: "readReviews",
    conjunct:
      "a pending review is left out before its user, commit and time are looked at",
    row: {
      pages: [
        {
          reviews: [
            { id: 1, state: "PENDING", user: null, commit_id: null },
            by("alice"),
          ],
        },
      ],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-REV-07",
    function: "readReviews",
    conjunct: "an unknown state, last in the list, makes the list unreadable",
    row: {
      pages: [{ reviews: [by("alice"), by("bob", { state: "LGTM" })] }],
      expect: { error: "a review has an unknown state" },
      asked: [1],
    },
  },
  {
    id: "C-REV-08",
    function: "readReviews",
    conjunct: "a user that is no object has no login",
    row: {
      pages: [{ reviews: [by("alice", { user: "alice" })] }],
      expect: { error: "a review has no login" },
      asked: [1],
    },
  },
  {
    id: "C-REV-09",
    function: "readReviews",
    conjunct: "a login must have the form of a login",
    row: {
      pages: [{ reviews: [by("alice", { user: { login: "ali ce" } })] }],
      expect: { error: "a review has no login" },
      asked: [1],
    },
  },
  {
    id: "C-REV-10",
    function: "readReviews",
    conjunct: "a commit must be a full commit id",
    row: {
      pages: [{ reviews: [by("alice", { commit_id: "abc1234" })] }],
      expect: { error: "a review has no commit" },
      asked: [1],
    },
  },
  {
    id: "C-REV-11",
    function: "readReviews",
    conjunct: "a time must be a text",
    row: {
      pages: [{ reviews: [by("alice", { submitted_at: 1714557600 })] }],
      expect: { error: "a review has no submission time" },
      asked: [1],
    },
  },
  {
    id: "C-REV-12",
    function: "readReviews",
    conjunct: "a time must name an instant that exists",
    row: {
      pages: [
        { reviews: [by("alice", { submitted_at: "2024-02-31T10:00:00Z" })] },
      ],
      expect: { error: "a review has no submission time" },
      asked: [1],
    },
  },
  {
    id: "C-REV-13",
    function: "readReviews",
    conjunct: "the reviews keep the order of the host",
    row: {
      pages: [{ reviews: [by("zed"), by("alice"), by("mike")] }],
      expect: { logins: ["zed", "alice", "mike"] },
      asked: [1],
    },
  },
  {
    id: "C-REV-14",
    function: "readReviews",
    conjunct: "an unreadable entry on a later page is not dropped either",
    row: {
      pages: [
        { reviews: [by("alice")], link: NEXT },
        { reviews: [by("bob", { state: "LGTM" })] },
      ],
      expect: { error: "a review has an unknown state" },
      asked: [1, 2],
    },
  },
  {
    id: "C-REV-15",
    function: "reviews",
    conjunct: "an unreadable list is an error, never a shorter list",
    row: {
      pages: [{ reviews: [by("alice"), by("bob", { user: null })] }],
      expect: { error: "a review has no login" },
      asked: [1],
    },
  },
  {
    id: "C-REV-16",
    function: "readReviews",
    conjunct: "a list past the page cap is unreadable, never an empty list",
    row: {
      pages: [],
      endless: GITHUB_MAX_PAGES + 1,
      expect: { error: "more pages than the page cap" },
      asked: upTo(GITHUB_MAX_PAGES),
    },
  },
  {
    id: "C-REV-17",
    function: "readReviews",
    conjunct: "the last entry is read",
    row: {
      pages: [{ reviews: [by("alice"), by("bob", { state: "LGTM" })] }],
      expect: { error: "a review has an unknown state" },
      asked: [1],
    },
  },
  {
    id: "C-REV-18",
    function: "readReviews",
    conjunct: "the first entry is read",
    row: {
      pages: [{ reviews: [by("alice", { state: "LGTM" }), by("bob")] }],
      expect: { error: "a review has an unknown state" },
      asked: [1],
    },
  },
  {
    id: "C-REV-19",
    function: "readReviews",
    conjunct: "an entry between the first and the last is read",
    row: {
      pages: [
        { reviews: [by("alice"), by("bob", { state: "LGTM" }), by("carol")] },
      ],
      expect: { error: "a review has an unknown state" },
      asked: [1],
    },
  },
  {
    id: "C-LST-01",
    function: "list",
    conjunct: "a body that is no list is an error, not an empty list",
    row: {
      pages: [{ body: '{"reviews":[]}' }],
      expect: { error: "not a list" },
      asked: [1],
    },
  },
  {
    id: "C-LST-02",
    function: "list",
    conjunct: "the pages are joined in the order they were asked for",
    row: {
      pages: [
        { reviews: [by("alice")], link: NEXT },
        { reviews: [by("bob")], link: '<{P:3}>; rel="next"' },
        { reviews: [by("carol")] },
      ],
      expect: { logins: ["alice", "bob", "carol"] },
      asked: [1, 2, 3],
    },
  },
  {
    id: "C-LST-03",
    function: "list",
    conjunct: "a next link on a short page asks for the next page",
    row: {
      pages: [{ reviews: [by("alice")], link: NEXT }, { reviews: [by("bob")] }],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LST-04",
    function: "list",
    conjunct: "a full page without a link asks for the next page",
    row: {
      pages: [{ fill: GITHUB_PAGE_SIZE }, { reviews: [by("bob")] }],
      expect: { count: GITHUB_PAGE_SIZE + 1 },
      asked: [1, 2],
    },
  },
  {
    id: "C-LST-05",
    function: "list",
    conjunct: "a page one short of full without a link is the last one",
    row: {
      pages: [{ fill: GITHUB_PAGE_SIZE - 1 }],
      expect: { count: GITHUB_PAGE_SIZE - 1 },
      asked: [1],
    },
  },
  {
    id: "C-LST-06",
    function: "list",
    conjunct: "a first page without a link that is not full is the last one",
    row: {
      pages: [{ reviews: [by("alice")] }],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-LST-07",
    function: "list",
    conjunct: "a list of exactly the page cap is read",
    row: {
      pages: [],
      endless: GITHUB_MAX_PAGES,
      expect: { count: GITHUB_MAX_PAGES },
      asked: upTo(GITHUB_MAX_PAGES),
    },
  },
  {
    id: "C-LST-08",
    function: "list",
    conjunct: "a list one page past the cap is not cut",
    row: {
      pages: [],
      endless: GITHUB_MAX_PAGES + 1,
      expect: { error: "more pages than the page cap" },
      asked: upTo(GITHUB_MAX_PAGES),
    },
  },
  {
    id: "C-LST-09",
    function: "list",
    conjunct: "the page after page n is page n + 1",
    row: {
      pages: [
        { reviews: [by("alice")], link: NEXT },
        { reviews: [by("bob")], link: '<{P:3}>; rel="next"' },
        { reviews: [by("carol")] },
      ],
      expect: { count: 3 },
      asked: [1, 2, 3],
    },
  },
  {
    id: "C-LST-10",
    function: "list",
    conjunct: "the entries after the first of a page are kept",
    row: {
      pages: [{ reviews: [by("alice"), by("bob"), by("carol")] }],
      expect: { logins: ["alice", "bob", "carol"] },
      asked: [1],
    },
  },
  {
    id: "C-LST-11",
    function: "list",
    conjunct: "the entries before the last of a page are kept",
    row: {
      pages: [{ reviews: [by("dave"), by("erin"), by("frank")] }],
      expect: { logins: ["dave", "erin", "frank"] },
      asked: [1],
    },
  },
  {
    id: "C-LNK-01",
    function: "nextTarget",
    conjunct: "no Link header means no next page, not an unreadable header",
    row: {
      pages: [{ reviews: [by("alice")] }, { reviews: [by("bob")] }],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-LNK-02",
    function: "nextTarget",
    conjunct: "a header that is no list of links is unreadable, not empty",
    row: {
      pages: [{ reviews: [by("alice")], link: "garbage" }],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-03",
    function: "nextTarget",
    conjunct:
      "an unreadable entry after a next entry still makes the header unreadable",
    row: {
      pages: [
        { reviews: [by("alice")], link: `${NEXT}, garbage` },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-04",
    function: "nextTarget",
    conjunct: "the last entry of a header is read",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: `<{P:1}>; rel="first", <{P:1}>; rel="prev", ${NEXT}`,
        },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-05",
    function: "nextTarget",
    conjunct: "an entry without next after the next entry does not undo it",
    row: {
      pages: [
        { reviews: [by("alice")], link: `${NEXT}, <{P:9}>; rel="last"` },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-06",
    function: "nextTarget",
    conjunct:
      "an entry without next before the next entry is skipped and does not end the search",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: `<{P:1}>; rel="prev", ${NEXT}, <{P:9}>; rel="last"`,
        },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-07",
    function: "nextTarget",
    conjunct:
      "two next entries side by side make the header unreadable: the first does not win",
    row: {
      pages: [
        { reviews: [by("alice")], link: `${NEXT}, ${NEXT}` },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-08",
    function: "nextTarget",
    conjunct:
      "two next entries with another between them make the header unreadable: the last does not win",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: `${NEXT}, <{P:9}>; rel="last", ${NEXT}`,
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-09",
    function: "nextTarget",
    conjunct:
      "of two rel parameters the first decides: next first reads the next page",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rel="next"; rel="prev"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-10",
    function: "nextTarget",
    conjunct:
      "of two rel parameters the first decides: prev first ends the list",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rel="prev"; rel="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-LNK-11",
    function: "nextTarget",
    conjunct: "the name of the rel parameter is read without its case",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; REL="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-12",
    function: "nextTarget",
    conjunct:
      "a parameter with another name is not the relation, however alike",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rev="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-LNK-13",
    function: "nextTarget",
    conjunct: "a parameter before rel is not the relation",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; title="next"; rel="prev"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-LNK-14",
    function: "nextTarget",
    conjunct: "a quoted relation is read",
    row: {
      pages: [{ reviews: [by("alice")], link: NEXT }, { reviews: [by("bob")] }],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-15",
    function: "nextTarget",
    conjunct: "a relation without quotes is read",
    row: {
      pages: [
        { reviews: [by("alice")], link: "<{P:2}>; rel=next" },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-16",
    function: "nextTarget",
    conjunct:
      "text inside the quoted value of another parameter is no parameter",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{P:2}>; title="; rel=prev"; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-17",
    function: "nextTarget",
    conjunct: "the relation is read without its case",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rel="NEXT"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-18",
    function: "nextTarget",
    conjunct: "next as the last of several relations counts",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rel="prev next"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-19",
    function: "nextTarget",
    conjunct: "next as the first of several relations counts",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rel="next last"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-20",
    function: "nextTarget",
    conjunct:
      "next between other relations counts: relations are split at spaces",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rel="first next last"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-21",
    function: "nextTarget",
    conjunct: "a target stands in angle brackets",
    row: {
      pages: [{ reviews: [by("alice")], link: '{P:2}; rel="next"' }],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-22",
    function: "nextTarget",
    conjunct: "a parameter has a value",
    row: {
      pages: [{ reviews: [by("alice")], link: "<{P:2}>; rel" }],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-23",
    function: "nextTarget",
    conjunct: "entries are separated by a comma",
    row: {
      pages: [
        { reviews: [by("alice")], link: `${NEXT} <{P:9}>; rel="last"` },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-24",
    function: "nextTarget",
    conjunct: "an entry without a rel parameter is not a next entry",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; title="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-NXT-01",
    function: "hasNext",
    conjunct: "without a next entry no further page is asked for",
    row: {
      pages: [{ reviews: [by("alice")], link: '<{P:1}>; rel="last"' }],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-NXT-02",
    function: "hasNext",
    conjunct:
      "a target that is no full address is an error, not completed from the root",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{page:2}>; rel="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-03",
    function: "hasNext",
    conjunct: "an unreadable header is an error, not the end of the list",
    row: {
      pages: [{ reviews: [by("alice")], link: "<unclosed; rel=next" }],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-04",
    function: "hasNext",
    conjunct: "a next link to another origin is an error",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{foreign}{page:2}>; rel="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link leaves the API origin" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-05",
    function: "hasNext",
    conjunct: "a next link with a user name is an error",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<http://user@{host}{page:2}>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link leaves the API origin" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-06",
    function: "hasNext",
    conjunct: "a next link with a password alone is an error",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<http://:pw@{host}{page:2}>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link leaves the API origin" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-07",
    function: "hasNext",
    conjunct: "a next link outside the path of the API root is an error",
    row: {
      prefix: "/api/v3",
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/api/v4{page:2}>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-08",
    function: "hasNext",
    conjunct: "a next link to another list of the repository is an error",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repos/acme/widgets/pulls/8/reviews?per_page=100&page=2>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-09",
    function: "hasNext",
    conjunct: "a next link to the same list of another repository is an error",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repos/acme/gadgets/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-10",
    function: "hasNext",
    conjunct: "a next link may spell the repository in another case",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repos/Acme/WIDGETS/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-NXT-11",
    function: "hasNext",
    conjunct: "a next link may name the repository by its numeric id",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repositories/1300192/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-NXT-12",
    function: "hasNext",
    conjunct: "the numeric id is one segment of digits",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repositories/1/2/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-13",
    function: "hasNext",
    conjunct: "a next link names one page, not two",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: `<{root}${REVIEWS_PATH}?page=2&page=3>; rel="next"`,
        },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link names another page" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-14",
    function: "hasNext",
    conjunct: "a next link that skips a page is an error",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:3}>; rel="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link names another page" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-15",
    function: "hasNext",
    conjunct: "a next link to the same page is an error",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:1}>; rel="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link names another page" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-16",
    function: "hasNext",
    conjunct:
      "the next link of a later page is checked like the one of the first",
    row: {
      pages: [
        { reviews: [by("alice")], link: NEXT },
        { reviews: [by("bob")], link: '<{foreign}{page:3}>; rel="next"' },
        { reviews: [by("carol")] },
      ],
      expect: { error: "next link leaves the API origin" },
      asked: [1, 2],
    },
  },
  {
    id: "C-LST-12",
    function: "list",
    conjunct:
      "the next link of a full page is checked too, not only that of a short page",
    row: {
      pages: [
        { fill: GITHUB_PAGE_SIZE, link: '<{foreign}{page:2}>; rel="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { error: "next link leaves the API origin" },
      asked: [1],
    },
  },
  {
    id: "C-REV-20",
    function: "readReviews",
    conjunct: "pending in another case is not pending: the list is unreadable",
    row: {
      pages: [{ reviews: [by("alice"), by("bob", { state: "pending" })] }],
      expect: { error: "a review has an unknown state" },
      asked: [1],
    },
  },
  {
    id: "C-REV-21",
    function: "readReviews",
    conjunct: "a known state in another case is an unknown state",
    row: {
      pages: [{ reviews: [by("alice", { state: "approved" })] }],
      expect: { error: "a review has an unknown state" },
      asked: [1],
    },
  },
  ...(
    [
      [
        "C-TIM-01",
        "a time in another notation is no time, even when a date parser reads it",
        "May 1, 2024 10:00:00 GMT",
        false,
      ],
      [
        "C-TIM-02",
        "a day that does not exist is not rolled over",
        "2024-02-31T10:00:00Z",
        false,
      ],
      [
        "C-TIM-03",
        "a zone that does not exist is no time",
        "2024-05-01T10:00:00+99:99",
        false,
      ],
      ["C-TIM-04", "a time needs a zone", "2024-05-01T10:00:00", false],
      [
        "C-TIM-05",
        "a fraction of a second is allowed",
        "2024-05-01T10:00:00.123Z",
        true,
      ],
      [
        "C-TIM-06",
        "date and time are joined by a T",
        "2024-05-01 10:00:00Z",
        false,
      ],
      [
        "C-TIM-07",
        "the letters of a time are upper case",
        "2024-05-01t10:00:00z",
        false,
      ],
      [
        "C-TIM-08",
        "the day, month and year must come back as written",
        "2024-02-30T10:00:00Z",
        false,
      ],
      [
        "C-TIM-09",
        "a fraction has at most nine digits",
        "2024-05-01T10:00:00.1234567890Z",
        false,
      ],
      [
        "C-TIM-10",
        "an hour that does not exist is not rolled over",
        "2024-05-01T24:00:00Z",
        false,
      ],
    ] as const
  ).map(([id, conjunct, time, read]) => ({
    id,
    function: "instantOf",
    conjunct,
    row: {
      pages: [{ reviews: [by("alice", { submitted_at: time })] }],
      expect: read
        ? { logins: ["alice"] }
        : { error: "a review has no submission time" },
      asked: [1],
    } as ReviewsRow,
  })),
  {
    id: "C-NXT-17",
    function: "hasNext",
    conjunct:
      "a next link below another path is named as that, and that is no crash",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repos/acme/widgets/pulls/7/comments?per_page=100&page=2>; rel="next"',
        },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-18",
    function: "hasNext",
    conjunct: "the Link header that is read is the one of the answer",
    row: {
      pages: [{ reviews: [by("alice")], link: NEXT }, { reviews: [by("bob")] }],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LST-13",
    function: "list",
    conjunct: "a next link is compared with the list that was asked for",
    row: {
      pages: [{ reviews: [by("alice")], link: NEXT }, { reviews: [by("bob")] }],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LST-14",
    function: "list",
    conjunct: "a next link is compared with the page that was asked for",
    row: {
      pages: [
        { reviews: [by("alice")], link: NEXT },
        { reviews: [by("bob")], link: '<{P:3}>; rel="next"' },
        { reviews: [by("carol")] },
      ],
      expect: { logins: ["alice", "bob", "carol"] },
      asked: [1, 2, 3],
    },
  },
  {
    id: "C-REV-22",
    function: "readReviews",
    conjunct:
      "a submission time that is no text is no time, even when it prints like one",
    row: {
      pages: [
        { reviews: [by("alice", { submitted_at: ["2024-05-01T10:00:00Z"] })] },
      ],
      expect: { error: "a review has no submission time" },
      asked: [1],
    },
  },
  {
    id: "C-REV-23",
    function: "readReviews",
    conjunct: "a reviewer that is null has no login, and that is no crash",
    row: {
      pages: [{ reviews: [by("alice", { user: null })] }],
      expect: { error: "a review has no login" },
      asked: [1],
    },
  },
  {
    id: "C-REV-24",
    function: "reviews",
    conjunct:
      "the reviews read are those of the pull request the adapter was made for",
    row: {
      number: 12,
      pages: [{ reviews: [by("alice")] }],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
  {
    id: "C-LNK-25",
    function: "nextTarget",
    conjunct: "a target holds no opening angle bracket",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<<https://other.example/list>; rel="prev"',
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-26",
    function: "nextTarget",
    conjunct: "a target holds no closing angle bracket",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<https://other.example/list>x>; rel="prev"',
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-27",
    function: "nextTarget",
    conjunct: "a parameter has a name",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<https://other.example/list>; ="prev"',
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-28",
    function: "nextTarget",
    conjunct: "a value without quotes is not empty",
    row: {
      pages: [
        { reviews: [by("alice")], link: "<https://other.example/list>; rel=" },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-29",
    function: "nextTarget",
    conjunct: "a value without quotes holds no quote",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<https://other.example/list>; rel=pre"v',
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-30",
    function: "nextTarget",
    conjunct:
      "a value without quotes ends at a comma, and what follows must be an entry",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: "<https://other.example/list>; rel=prev,x",
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-31",
    function: "nextTarget",
    conjunct:
      "a value without quotes ends at a semicolon, and what follows must be a parameter",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: "<https://other.example/list>; rel=prev;x",
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-32",
    function: "nextTarget",
    conjunct:
      "a value without quotes ends at a space, and nothing but a separator follows",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: "<https://other.example/list>; rel=prev x",
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-LNK-33",
    function: "nextTarget",
    conjunct:
      "a value without quotes before the relation ends at its semicolon",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; type=list; rel="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-34",
    function: "nextTarget",
    conjunct:
      "a space before the equals sign is not part of the name of a parameter",
    row: {
      pages: [
        { reviews: [by("alice")], link: '<{P:2}>; rel ="next"' },
        { reviews: [by("bob")] },
      ],
      expect: { logins: ["alice", "bob"] },
      asked: [1, 2],
    },
  },
  {
    id: "C-LNK-35",
    function: "nextTarget",
    conjunct: "the name of a parameter is letters and the asterisk",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<https://other.example/list>; re%l="prev"',
        },
      ],
      expect: { error: "next link not readable" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-19",
    function: "hasNext",
    conjunct: "the path of a repository by its id is compared with its case",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/REPOSITORIES/1300192/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-20",
    function: "hasNext",
    conjunct: "nothing stands before the path of a repository by its id",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/x/repositories/1300192/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-21",
    function: "hasNext",
    conjunct:
      "the prefix of the API root stands at the start of the path, not somewhere in it",
    row: {
      prefix: "/repos",
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/abcde/repos/acme/widgets/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-22",
    function: "hasNext",
    conjunct: "the list stands at the end of the path, not somewhere in it",
    row: {
      repository: "pulls/7",
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repos/pulls/7/reviewsAAAAAAAA?per_page=100&page=2>; rel="next"',
        },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-NXT-23",
    function: "hasNext",
    conjunct: "the id of a repository is digits",
    row: {
      pages: [
        {
          reviews: [by("alice")],
          link: '<{root}/repositories/13%/pulls/7/reviews?per_page=100&page=2>; rel="next"',
        },
      ],
      expect: { error: "next link names another path" },
      asked: [1],
    },
  },
  {
    id: "C-LST-15",
    function: "list",
    conjunct: "a page is asked for at the path of the list",
    row: {
      pages: [{ reviews: [by("alice")] }],
      expect: { logins: ["alice"] },
      asked: [1],
    },
  },
];

describe("CONJUNCTS: reading a list of reviews and its Link headers", () => {
  it("the table and the list of changes name the same conjuncts, each once", () => {
    const ids = CONJUNCTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(conjunctIds("github-reviews"));
  });

  it.each(
    CONJUNCTS.map((entry) => [entry.id, entry.conjunct, entry.row] as const),
  )("%s: %s", async (_id, _conjunct, row) => {
    const prefix = row.prefix ?? "";
    const list = `/repos/${row.repository ?? REPOSITORY}/pulls/${row.number ?? PULL}/reviews`;
    const pageOf = (n: number): string => `${list}?per_page=100&page=${n}`;
    const expand = (text: string): string =>
      text
        .replace(
          /\{P:(\d+)\}/g,
          (_, n) => `${stub.url}${prefix}${pageOf(Number(n))}`,
        )
        .replace(/\{page:(\d+)\}/g, (_, n) => pageOf(Number(n)))
        .replaceAll("{root}", stub.url)
        .replaceAll("{foreign}", foreign.url)
        .replaceAll("{host}", new URL(stub.url).host);
    if (row.endless !== undefined) {
      const last = row.endless;
      stub.on(REVIEWS_PATH, (hit): Reply => {
        const n = Number(new URL(hit.url, stub.url).searchParams.get("page"));
        return {
          json: [by(`user${n}`)],
          headers:
            n < last ? { link: expand(`<{P:${n + 1}}>; rel="next"`) } : {},
        };
      });
    }
    row.pages.forEach((of, i) => {
      const reviews =
        of.fill === undefined
          ? (of.reviews ?? [])
          : Array.from({ length: of.fill }, (_, k) => by(`user${k}`));
      stub.on(`${prefix}${pageOf(i + 1)}`, {
        ...(of.body === undefined ? { json: reviews } : { body: of.body }),
        headers: of.link === undefined ? {} : { link: expand(of.link) },
      });
    });
    foreign.on(REVIEWS_PATH, { json: [by("mallory")] });
    const host = hostAt(stub, {
      ...(prefix === "" ? {} : { apiUrl: `${stub.url}${prefix}` }),
      ...(row.number === undefined ? {} : { pullRequest: row.number }),
      ...(row.repository === undefined ? {} : { repository: row.repository }),
    });
    if ("error" in row.expect) {
      const error = await failing(host.reviews());
      expect(error.message).toBe(
        `github: GET ${list} answered 200 (${row.expect.error})`,
      );
    } else {
      const logins = (await giving(host.reviews())).map((r) => r.login);
      if ("logins" in row.expect) expect(logins).toEqual(row.expect.logins);
      else expect(logins).toHaveLength(row.expect.count);
    }
    expect(stub.hits.map((hit) => hit.url)).toEqual(
      row.asked.map((n) => `${prefix}${pageOf(n)}`),
    );
    expect(foreign.hits).toEqual([]);
  });

  // What the name of a parameter and the id of a repository may not hold,
  // one test each. The asterisk is a character of a name.
  it.each(FORBIDDEN_CHARACTERS.filter((char) => char !== "*"))(
    "a parameter name with %j in it makes the header unreadable",
    async (char) => {
      stub.on(page(1), {
        json: [by("alice")],
        headers: {
          link: `<https://other.example/list>; a${char}b="x", <${stub.url}${page(2)}>; rel="next"`,
        },
      });
      const error = await failing(hostAt(stub).reviews());
      expect(error.message).toBe(`${AT} (next link not readable)`);
      expect(stub.hits.map((hit) => hit.url)).toEqual([page(1)]);
    },
  );

  it.each(FORBIDDEN_CHARACTERS.filter((char) => !"<>".includes(char)))(
    "a repository id with %j in it is another path",
    async (char) => {
      for (const id of [`13${char}`, `1${char}3`]) {
        stub.reset();
        stub.on(page(1), {
          json: [by("alice")],
          headers: {
            link: `<${stub.url}/repositories/${id}/pulls/7/reviews?per_page=100&page=2>; rel="next"`,
          },
        });
        const error = await failing(hostAt(stub).reviews());
        expect(error.message).toBe(`${AT} (next link names another path)`);
        expect(stub.hits.map((hit) => hit.url)).toEqual([page(1)]);
      }
    },
  );
});
