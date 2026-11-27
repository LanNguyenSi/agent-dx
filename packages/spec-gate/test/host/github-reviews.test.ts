import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { instantOf } from "../../src/approve/facts.js";
import { GITHUB_MAX_PAGES, GITHUB_PAGE_SIZE } from "../../src/host/index.js";
import {
  failing,
  giving,
  HEAD,
  hostAt,
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
