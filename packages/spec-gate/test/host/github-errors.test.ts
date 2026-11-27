import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  GITHUB_API_VERSION,
  GITHUB_MAX_BODY_BYTES,
  GITHUB_TIMEOUT_MS,
} from "../../src/host/index.js";
import { conjunctIds } from "./conjunct-mutants.js";
import {
  BASE,
  expectClean,
  failing,
  giving,
  HEAD,
  hostAt,
  P,
  produced,
  PROTECTION_PATH,
  PULL_PATH,
  pullJson,
  type Reply,
  reviewJson,
  REVIEWS_PATH,
  RULES_PATH,
  Stub,
  TOKEN,
} from "./stub.js";

let stub: Stub;
/** A second origin, for redirects that leave the API. */
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
afterEach(() => {
  vi.restoreAllMocks();
});

const AT = `github: GET ${PULL_PATH}`;

describe("errors: statuses", () => {
  it.each([
    [201],
    [202],
    [204],
    [206],
    [400],
    [401],
    [403],
    [404],
    [406],
    [409],
    [410],
    [422],
    [429],
    [451],
    [500],
    [502],
    [503],
  ])(
    "status %d throws with the method, the path and the status, and is not asked again",
    async (status) => {
      stub.on(PULL_PATH, {
        status,
        json: status === 204 ? undefined : pullJson(),
      });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} answered ${status}`);
      expect(stub.hits).toHaveLength(1);
    },
  );

  it.each([
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1714557600" }],
    [429, { "x-ratelimit-remaining": "0" }],
    [403, { "retry-after": "30" }],
    [429, { "retry-after": "30" }],
    [429, { "retry-after": "30", "x-ratelimit-remaining": "0" }],
  ])(
    "a rate limit (%d with %j) throws by name and is not retried",
    async (status, headers) => {
      stub.on(PULL_PATH, {
        status,
        headers,
        json: { message: "API rate limit exceeded" },
      });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} answered ${status} (rate limited)`);
      expect(stub.hits).toHaveLength(1);
    },
  );

  it.each([
    [403, { "x-ratelimit-remaining": "42" }],
    [403, { "x-ratelimit-remaining": "00" }],
    [429, { "x-ratelimit-remaining": "17" }],
    [500, { "retry-after": "30" }],
    [404, { "x-ratelimit-remaining": "0" }],
  ])("%d with %j is not named a rate limit", async (status, headers) => {
    stub.on(PULL_PATH, { status, headers, json: { message: "no" } });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`${AT} answered ${status}`);
  });
});

describe("errors: redirects", () => {
  it.each([[301], [302], [303], [307], [308]])(
    "a %d to another path of the API is refused, and the path is not asked",
    async (status) => {
      stub.on(PULL_PATH, {
        status,
        headers: { location: `${stub.url}/moved` },
      });
      stub.on("/moved", { json: pullJson() });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} answered ${status} (redirect refused)`);
      expect(stub.hits.map((hit) => hit.url)).toEqual([PULL_PATH]);
    },
  );

  it.each([[301], [302], [307], [308]])(
    "a %d to another origin is refused, and nothing is sent there",
    async (status) => {
      stub.on(PULL_PATH, {
        status,
        headers: { location: `${foreign.url}${PULL_PATH}` },
      });
      foreign.on(PULL_PATH, { json: pullJson() });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} answered ${status} (redirect refused)`);
      expect(foreign.hits).toEqual([]);
    },
  );

  it("a redirect on a list or on a source of the enforcement is refused too", async () => {
    stub.on(REVIEWS_PATH, {
      status: 302,
      headers: { location: `${foreign.url}${REVIEWS_PATH}` },
    });
    foreign.on(REVIEWS_PATH, { json: [reviewJson("alice", "APPROVED")] });
    await failing(hostAt(stub).reviews());

    stub.on(PULL_PATH, { json: pullJson() });
    stub.on(RULES_PATH, { json: [] });
    stub.on(PROTECTION_PATH, {
      status: 302,
      headers: { location: `${foreign.url}${PROTECTION_PATH}` },
    });
    const error = await failing(hostAt(stub).reviewEnforcement("specs/"));
    expect(error.message).toBe(
      `github: GET ${PROTECTION_PATH} answered 302 (redirect refused)`,
    );
    expect(foreign.hits).toEqual([]);
  });

  it.each([[300], [304], [305]])(
    "a %d is no answer either, and is not named a redirect",
    async (status) => {
      stub.on(PULL_PATH, { status });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} answered ${status}`);
    },
  );
});

describe("errors: time", () => {
  /** Makes every time limit of the adapter 150 ms and records what was asked for. */
  function shortTimeouts() {
    const real = AbortSignal.timeout.bind(AbortSignal);
    return vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(150));
  }

  it(
    "a host that never answers ends in the time limit",
    { timeout: 3000 },
    async () => {
      const spy = shortTimeouts();
      stub.on(PULL_PATH, { hang: "before-headers" });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} failed (timed out)`);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(GITHUB_TIMEOUT_MS);
    },
  );

  it(
    "a host that stops in the middle of a body ends in the same time limit",
    { timeout: 3000 },
    async () => {
      const spy = shortTimeouts();
      stub.on(PULL_PATH, { hang: "mid-body" });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} answered 200 (timed out)`);
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it("every request of a list gets a time limit of its own", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const page = (n: number) => `${REVIEWS_PATH}?per_page=100&page=${n}`;
    stub.on(page(1), {
      json: [reviewJson("alice", "APPROVED", HEAD, 1)],
      headers: { link: `<${stub.url}${page(2)}>; rel="next"` },
    });
    stub.on(page(2), { json: [] });
    await giving(hostAt(stub).reviews());
    expect(spy.mock.calls).toEqual([[GITHUB_TIMEOUT_MS], [GITHUB_TIMEOUT_MS]]);
  });

  it("a host that is not there fails without a status", async () => {
    const gone = http.createServer();
    await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
    const { port } = gone.address() as AddressInfo;
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    const error = await failing(
      hostAt(stub, { apiUrl: `http://127.0.0.1:${port}` }).pullRequest(),
    );
    expect(error.message).toBe(`${AT} failed (no answer)`);
  });

  it("a fetch that throws anything fails the same way, and what it threw is dropped", async () => {
    const fetch = (async () => {
      throw new Error(`connect failed with Bearer ${TOKEN}`);
    }) as typeof globalThis.fetch;
    const error = await failing(hostAt(stub, { fetch }).pullRequest());
    expect(error.message).toBe(`${AT} failed (no answer)`);
  });
});

describe("errors: bodies", () => {
  /** A JSON list padded with spaces to exactly `size` bytes. */
  const padded = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size).fill(0x20);
    bytes[0] = 0x5b;
    bytes[size - 1] = 0x5d;
    return bytes;
  };

  it("reads a body of exactly the size cap", async () => {
    stub.on(REVIEWS_PATH, { body: padded(GITHUB_MAX_BODY_BYTES) });
    expect(await giving(hostAt(stub).reviews())).toEqual([]);
  });

  it("throws on a body one byte over the size cap", async () => {
    stub.on(REVIEWS_PATH, { body: padded(GITHUB_MAX_BODY_BYTES + 1) });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(
      `github: GET ${REVIEWS_PATH} answered 200 (body over the size cap)`,
    );
  });

  it("throws on a body far over the size cap that is sent without a length", async () => {
    stub.on(REVIEWS_PATH, {
      body: padded(3 * GITHUB_MAX_BODY_BYTES),
      headers: { "transfer-encoding": "chunked" },
    });
    const error = await failing(hostAt(stub).reviews());
    expect(error.message).toBe(
      `github: GET ${REVIEWS_PATH} answered 200 (body over the size cap)`,
    );
  });

  it("throws on a body that ends with the connection", async () => {
    stub.on(PULL_PATH, { cut: true });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`${AT} answered 200 (body not readable)`);
  });

  it.each([
    ["no JSON", "<html>Bad gateway</html>"],
    ["cut JSON", '{"number": 7, "user": {"login": "dev"'],
    ["an empty body", ""],
    ["two values", "{}{}"],
    ["text that is not UTF-8", new Uint8Array([0x22, 0xff, 0xfe, 0x22])],
    ["a cut UTF-8 sequence", new Uint8Array([0x22, 0xe2, 0x82, 0x22])],
  ])("throws on a body with %s", async (_what, body) => {
    stub.on(PULL_PATH, { body });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`${AT} answered 200 (invalid JSON)`);
  });
});

describe("errors: the token", () => {
  /** A reply that repeats the token wherever a reply can carry text. */
  const echo = (reply: Reply): Reply => ({
    ...reply,
    headers: {
      "x-echo": TOKEN,
      "x-github-request-id": TOKEN,
      location: `${stub.url}/moved?token=${TOKEN}`,
      link: `<${stub.url}/x?token=${TOKEN}>; rel="next"`,
      "www-authenticate": `Bearer realm="${TOKEN}"`,
      ...reply.headers,
    },
  });
  const said = { message: `Bad credentials: ${TOKEN}`, token: TOKEN };

  it.each([
    ["a client error", { status: 401, json: said }],
    ["a missing permission", { status: 403, json: said }],
    [
      "a rate limit",
      { status: 403, json: said, headers: { "retry-after": "1" } },
    ],
    ["a missing resource", { status: 404, json: said }],
    ["a server error", { status: 500, json: said }],
    ["a redirect", { status: 302, json: said }],
    ["a body that is no JSON", { body: `not json ${TOKEN}` }],
    ["a body of another shape", { json: [TOKEN, said] }],
    [
      "a body with the token as a login",
      { json: pullJson({ user: { login: TOKEN } }) },
    ],
    [
      "a body with the token as a branch",
      { json: pullJson({ base: { ref: TOKEN } }) },
    ],
    [
      "a body with the token in the text of the pull request",
      { json: pullJson({ title: `fix ${TOKEN}` }) },
    ],
  ] as [string, Reply][])(
    "%s that repeats the token gives an error without it",
    async (_what, reply) => {
      stub.on(PULL_PATH, echo(reply));
      await failing(hostAt(stub).pullRequest());
    },
  );

  it("a body that repeats the token is refused whole, so no value carries it", async () => {
    stub.on(PULL_PATH, { json: pullJson({ user: { login: TOKEN } }) });
    const pull = await failing(hostAt(stub).pullRequest());
    expect(pull.message).toBe(`${AT} answered 200 (body repeats the token)`);

    stub.on(REVIEWS_PATH, { json: [reviewJson(TOKEN, "APPROVED")] });
    const reviews = await failing(hostAt(stub).reviews());
    expect(reviews.message).toBe(
      `github: GET ${REVIEWS_PATH} answered 200 (body repeats the token)`,
    );
  });

  it.each([
    [
      "written with an escape",
      `{"number":7,"user":{"login":"\\u0073${TOKEN.slice(1)}"}}`,
    ],
    ["as a key", JSON.stringify({ ...pullJson(), [TOKEN]: 1 })],
    [
      "inside a longer text, deep in a list",
      JSON.stringify(pullJson({ labels: [[{ name: [`a${TOKEN}b`] }]] })),
    ],
  ])("a body that holds the token %s is refused", async (_what, body) => {
    expect(TOKEN.startsWith("s")).toBe(true);
    stub.on(PULL_PATH, { body });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`${AT} answered 200 (body repeats the token)`);
  });

  it("a reply that repeats the token in its headers only still gives clean values", async () => {
    stub.on(PULL_PATH, echo({ json: pullJson() }));
    stub.on(REVIEWS_PATH, {
      json: [reviewJson("alice", "APPROVED")],
      headers: { "x-echo": TOKEN },
    });
    stub.on(RULES_PATH, { json: [], headers: { "x-echo": TOKEN } });
    stub.on(PROTECTION_PATH, echo({ status: 403, json: said }));
    stub.on(`${P}/commits`, { json: [], headers: { "x-echo": TOKEN } });
    stub.on(`${P}/actions/runs/1`, echo({ status: 404, json: said }));
    const host = hostAt(stub);
    await giving(host.pullRequest());
    await giving(host.reviews());
    expect(await giving(host.reviewEnforcement("specs/"))).toBe("unknown");
    await giving(host.lastConfigCommit());
    expect(await giving(host.ciRunStatus(HEAD, "1"))).toBe("unverified");
  });

  it("no error of this file shows the token, whatever the host said", () => {
    expect(produced.length).toBeGreaterThan(40);
    for (const error of produced) expectClean(error);
  });
});

const REPEATS = "answered 200 (body repeats the token)";
const LIMITED = { "retry-after": "30" };
const page = (n: number): string => `${REVIEWS_PATH}?per_page=100&page=${n}`;
const review = (login: string) => reviewJson(login, "APPROVED", HEAD, 1);
const PULL_TEXT = JSON.stringify(pullJson());

/** A fetch that answers 200 with a body that arrives in these pieces. */
const inPieces = (pieces: string[]) => async (): Promise<Response> =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(new TextEncoder().encode(piece));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
/** A fetch that fails by throwing `thrown`. */
const throwing = (thrown: unknown) => async (): Promise<Response> => {
  throw thrown;
};
/** A JSON list padded with spaces to exactly `size` bytes. */
const paddedList = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes[0] = 0x5b;
  bytes[size - 1] = 0x5d;
  return bytes;
};

interface ErrorRow {
  /** The method that is called: the pull request unless said otherwise. */
  call?: "reviews" | "enforcement";
  /**
   * What the stub answers: on the path of the pull request or of the
   * reviews, and for `enforcement` on the path of the classic protection
   * (the rules are an empty list). `pages` answers the pages of the reviews.
   */
  reply?: Reply;
  pages?: Reply[];
  /** A fetch in place of the stub. */
  seam?: () => Promise<Response>;
  /** The API root is a port nobody listens on. */
  gone?: true;
  /** Every time limit is 150 ms, so an answer that never comes ends the test. */
  shortLimits?: true;
  /** The whole message of the error, the value, or how many entries come back. */
  expect: { error: string } | { value: unknown } | { count: number };
  /** Headers the request carries. */
  sent?: Record<string, string>;
  /** The requests the stub gets, in order. */
  asked?: string[];
}

/**
 * Every conjunct of a request and of reading its answer: the headers, the
 * statuses, the body, the search for the token and what counts as a time
 * limit. One row each; the row of an id fails when the change of that id in
 * `conjunct-mutants.ts` is made to the source.
 */
const CONJUNCTS: {
  id: string;
  function: string;
  conjunct: string;
  row: ErrorRow;
}[] = [
  {
    id: "C-GET-01",
    function: "get",
    conjunct: "a request names the media type of the API",
    row: {
      expect: { value: { author: "dev" } },
      sent: { accept: "application/vnd.github+json" },
    },
  },
  {
    id: "C-GET-02",
    function: "get",
    conjunct: "the token is sent as a bearer token",
    row: {
      expect: { value: { author: "dev" } },
      sent: { authorization: `Bearer ${TOKEN}` },
    },
  },
  {
    id: "C-GET-03",
    function: "get",
    conjunct: "a request names its client",
    row: {
      expect: { value: { author: "dev" } },
      sent: { "user-agent": "spec-gate" },
    },
  },
  {
    id: "C-GET-04",
    function: "get",
    conjunct: "a request pins the version of the API",
    row: {
      expect: { value: { author: "dev" } },
      sent: { "x-github-api-version": GITHUB_API_VERSION },
    },
  },
  {
    id: "C-GET-05",
    function: "get",
    conjunct: "a redirect is not followed",
    row: {
      reply: { status: 302, headers: { location: "/moved" } },
      expect: { error: `${AT} answered 302 (redirect refused)` },
      asked: [PULL_PATH],
    },
  },
  {
    id: "C-GET-06",
    function: "get",
    conjunct: "a request carries a time limit",
    row: {
      reply: { hang: "before-headers" },
      shortLimits: true,
      expect: { error: `${AT} failed (timed out)` },
    },
  },
  {
    id: "C-GET-07",
    function: "get",
    conjunct: "the query is part of the address",
    row: {
      call: "reviews",
      reply: { json: [] },
      expect: { count: 0 },
      asked: [page(1)],
    },
  },
  {
    id: "C-GET-08",
    function: "get",
    conjunct: "a host that is not there is 'no answer', not a time limit",
    row: { gone: true, expect: { error: `${AT} failed (no answer)` } },
  },
  {
    id: "C-GET-09",
    function: "get",
    conjunct: "an answer that never comes is named a time limit",
    row: {
      reply: { hang: "before-headers" },
      shortLimits: true,
      expect: { error: `${AT} failed (timed out)` },
    },
  },
  {
    id: "C-GET-10",
    function: "get",
    conjunct:
      "only 200 is read as an answer: another success status is an error",
    row: {
      reply: { status: 201, json: pullJson() },
      expect: { error: `${AT} answered 201` },
    },
  },
  {
    id: "C-GET-11",
    function: "get",
    conjunct: "the Link header of an answer is handed on",
    row: {
      call: "reviews",
      pages: [
        { json: [review("alice")], headers: { link: '<{P:2}>; rel="next"' } },
        { json: [review("bob")] },
      ],
      expect: { count: 2 },
      asked: [page(1), page(2)],
    },
  },
  ...[301, 302, 303, 307, 308].map((status, i) => ({
    id: `C-GET-${12 + i}`,
    function: "get",
    conjunct: `status ${status} is named a redirect`,
    row: {
      reply: { status, headers: { location: "/moved" } },
      expect: { error: `${AT} answered ${status} (redirect refused)` },
    } as ErrorRow,
  })),
  {
    id: "C-GET-17",
    function: "get",
    conjunct: "another status of the 300s is not named a redirect",
    row: { reply: { status: 304 }, expect: { error: `${AT} answered 304` } },
  },
  {
    id: "C-GET-18",
    function: "get",
    conjunct: "a 403 with a rate-limit header is a rate limit",
    row: {
      reply: { status: 403, headers: LIMITED },
      expect: { error: `${AT} answered 403 (rate limited)` },
    },
  },
  {
    id: "C-GET-19",
    function: "get",
    conjunct: "a 429 with a rate-limit header is a rate limit",
    row: {
      reply: { status: 429, headers: LIMITED },
      expect: { error: `${AT} answered 429 (rate limited)` },
    },
  },
  {
    id: "C-GET-20",
    function: "get",
    conjunct: "another status with a rate-limit header is not a rate limit",
    row: {
      reply: { status: 500, headers: LIMITED },
      expect: { error: `${AT} answered 500` },
    },
  },
  {
    id: "C-GET-21",
    function: "get",
    conjunct: "no requests left is a rate limit without a retry-after header",
    row: {
      reply: { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      expect: { error: `${AT} answered 403 (rate limited)` },
    },
  },
  {
    id: "C-GET-22",
    function: "get",
    conjunct: "requests left is no rate limit",
    row: {
      reply: { status: 403, headers: { "x-ratelimit-remaining": "42" } },
      expect: { error: `${AT} answered 403` },
    },
  },
  {
    id: "C-GET-23",
    function: "get",
    conjunct: "a retry-after header is a rate limit without the other header",
    row: {
      reply: { status: 429, headers: { "retry-after": "1" } },
      expect: { error: `${AT} answered 429 (rate limited)` },
    },
  },
  {
    id: "C-GET-24",
    function: "get",
    conjunct:
      "a rate limit comes before a mapped status: it is not read as 'not readable'",
    row: {
      call: "enforcement",
      reply: { status: 403, headers: LIMITED },
      expect: {
        error: `github: GET ${PROTECTION_PATH} answered 403 (rate limited)`,
      },
    },
  },
  {
    id: "C-GET-25",
    function: "get",
    conjunct: "a mapped status is an answer, not an error",
    row: {
      call: "enforcement",
      reply: { status: 404 },
      expect: { value: "unknown" },
    },
  },
  {
    id: "C-GET-26",
    function: "get",
    conjunct: "another status is an error that says nothing but the status",
    row: { reply: { status: 500 }, expect: { error: `${AT} answered 500` } },
  },
  {
    id: "C-GET-27",
    function: "get",
    conjunct:
      "a status that is not mapped is an error for a caller that maps others",
    row: {
      call: "enforcement",
      reply: { status: 500 },
      expect: { error: `github: GET ${PROTECTION_PATH} answered 500` },
    },
  },
  {
    id: "C-FAL-01",
    function: "failure",
    conjunct: "an answer with a status says 'answered', not 'failed'",
    row: { reply: { status: 502 }, expect: { error: `${AT} answered 502` } },
  },
  {
    id: "C-FAL-02",
    function: "failure",
    conjunct: "an error without a reason has no parentheses",
    row: { reply: { status: 418 }, expect: { error: `${AT} answered 418` } },
  },
  {
    id: "C-FAL-03",
    function: "failure",
    conjunct: "an error without a status names the path",
    row: { gone: true, expect: { error: `${AT} failed (no answer)` } },
  },
  {
    id: "C-FAL-04",
    function: "failure",
    conjunct: "an error with a status names the status",
    row: { reply: { status: 503 }, expect: { error: `${AT} answered 503` } },
  },
  {
    id: "C-BOD-01",
    function: "bodyOf",
    conjunct: "an answer without a body is no JSON, not a crash",
    row: {
      seam: async () => new Response(null, { status: 200 }),
      expect: { error: `${AT} answered 200 (invalid JSON)` },
    },
  },
  {
    id: "C-BOD-02",
    function: "bodyOf",
    conjunct: "a body that breaks off is 'not readable', not a time limit",
    row: {
      reply: { cut: true },
      expect: { error: `${AT} answered 200 (body not readable)` },
    },
  },
  {
    id: "C-BOD-03",
    function: "bodyOf",
    conjunct: "a body that stops coming is named a time limit",
    row: {
      reply: { hang: "mid-body" },
      shortLimits: true,
      expect: { error: `${AT} answered 200 (timed out)` },
    },
  },
  {
    id: "C-BOD-04",
    function: "bodyOf",
    conjunct: "a body of exactly the size cap is read",
    row: {
      call: "reviews",
      reply: { body: paddedList(GITHUB_MAX_BODY_BYTES) },
      expect: { count: 0 },
    },
  },
  {
    id: "C-BOD-05",
    function: "bodyOf",
    conjunct: "a body one byte over the size cap is an error",
    row: {
      call: "reviews",
      reply: { body: paddedList(GITHUB_MAX_BODY_BYTES + 1) },
      expect: {
        error: `github: GET ${REVIEWS_PATH} answered 200 (body over the size cap)`,
      },
    },
  },
  {
    id: "C-BOD-06",
    function: "bodyOf",
    conjunct: "the pieces after the first belong to the body",
    row: {
      seam: inPieces([
        PULL_TEXT.slice(0, 10),
        PULL_TEXT.slice(10, 50),
        PULL_TEXT.slice(50),
      ]),
      expect: { value: { author: "dev" } },
    },
  },
  {
    id: "C-BOD-07",
    function: "bodyOf",
    conjunct: "the pieces before the last belong to the body",
    row: {
      seam: inPieces([
        PULL_TEXT.slice(0, 30),
        PULL_TEXT.slice(30, 31),
        PULL_TEXT.slice(31),
      ]),
      expect: { value: { number: 7 } },
    },
  },
  {
    id: "C-BOD-08",
    function: "bodyOf",
    conjunct: "a piece between the first and the last belongs to the body",
    row: {
      seam: inPieces(["{", PULL_TEXT.slice(1, -1), "}"]),
      expect: { value: { head: HEAD } },
    },
  },
  {
    id: "C-BOD-09",
    function: "bodyOf",
    conjunct: "the pieces are joined one after the other",
    row: {
      seam: inPieces([PULL_TEXT.slice(0, 5), PULL_TEXT.slice(5)]),
      expect: { value: { author: "dev" } },
    },
  },
  {
    id: "C-BOD-10",
    function: "bodyOf",
    conjunct: "bytes that are no UTF-8 are no JSON, not replaced",
    row: {
      reply: { body: new Uint8Array([0x22, 0xff, 0xfe, 0x22]) },
      expect: { error: `${AT} answered 200 (invalid JSON)` },
    },
  },
  {
    id: "C-BOD-11",
    function: "bodyOf",
    conjunct: "a body that holds the token is refused",
    row: {
      reply: { json: pullJson({ user: { login: TOKEN } }) },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-BOD-12",
    function: "bodyOf",
    conjunct: "the size of the body is the sum of its pieces",
    row: {
      seam: inPieces([PULL_TEXT.slice(0, 100), PULL_TEXT.slice(100)]),
      expect: { value: { base: BASE } },
    },
  },
  {
    id: "C-BOD-13",
    function: "bodyOf",
    conjunct: "reading goes on until the body ends, not until the first piece",
    row: {
      seam: inPieces([PULL_TEXT.slice(0, 1), PULL_TEXT.slice(1)]),
      expect: { value: { targetRef: "refs/heads/main" } },
    },
  },
  {
    id: "C-TXT-01",
    function: "holdsText",
    conjunct: "the token inside a longer text is found",
    row: {
      reply: { json: pullJson({ title: `fix ${TOKEN} now` }) },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-02",
    function: "holdsText",
    conjunct: "the token in the last entry of a list is found",
    row: {
      call: "reviews",
      reply: { json: [review("alice"), review("bob"), review(TOKEN)] },
      expect: { error: `github: GET ${REVIEWS_PATH} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-03",
    function: "holdsText",
    conjunct: "the token in the first entry of a list is found",
    row: {
      call: "reviews",
      reply: { json: [review(TOKEN), review("alice"), review("bob")] },
      expect: { error: `github: GET ${REVIEWS_PATH} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-04",
    function: "holdsText",
    conjunct: "the token in an entry between the first and the last is found",
    row: {
      call: "reviews",
      reply: { json: [review("alice"), review(TOKEN), review("bob")] },
      expect: { error: `github: GET ${REVIEWS_PATH} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-05",
    function: "holdsText",
    conjunct: "the token under the last key of an object is found",
    row: {
      reply: { json: { ...pullJson(), zzz: TOKEN } },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-06",
    function: "holdsText",
    conjunct: "the token under the first key of an object is found",
    row: {
      reply: { json: { aaa: TOKEN, ...pullJson() } },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-07",
    function: "holdsText",
    conjunct: "the token under a key between the first and the last is found",
    row: {
      reply: { json: { aaa: 1, mid: TOKEN, ...pullJson() } },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-08",
    function: "holdsText",
    conjunct: "the token as a key is found",
    row: {
      reply: { json: { ...pullJson(), [TOKEN]: 1 } },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-09",
    function: "holdsText",
    conjunct: "the token below an object in a list in an object is found",
    row: {
      reply: { json: pullJson({ labels: [{ name: { text: TOKEN } }] }) },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-10",
    function: "holdsText",
    conjunct: "a body without the token is not refused",
    row: { reply: { json: pullJson() }, expect: { value: { author: "dev" } } },
  },
  {
    id: "C-TXT-11",
    function: "holdsText",
    conjunct: "the token at the end of a long text is found",
    row: {
      reply: { json: pullJson({ body: `${"x".repeat(60)}${TOKEN}` }) },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-12",
    function: "holdsText",
    conjunct: "a list with several entries is searched",
    row: {
      call: "reviews",
      reply: { json: [review("alice"), review(TOKEN)] },
      expect: { error: `github: GET ${REVIEWS_PATH} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-13",
    function: "holdsText",
    conjunct: "an object with several keys is searched",
    row: {
      reply: { json: { number: 7, note: TOKEN } },
      expect: { error: `${AT} ${REPEATS}` },
    },
  },
  {
    id: "C-TXT-14",
    function: "holdsText",
    conjunct: "a body that is one text is searched",
    row: { reply: { json: TOKEN }, expect: { error: `${AT} ${REPEATS}` } },
  },
  {
    id: "C-TMO-01",
    function: "isTimeout",
    conjunct: "a failure that is no object is no time limit, and no crash",
    row: {
      seam: throwing(undefined),
      expect: { error: `${AT} failed (no answer)` },
    },
  },
  {
    id: "C-TMO-02",
    function: "isTimeout",
    conjunct: "a failure that is null is no time limit, and no crash",
    row: {
      seam: throwing(null),
      expect: { error: `${AT} failed (no answer)` },
    },
  },
  {
    id: "C-TMO-03",
    function: "isTimeout",
    conjunct: "a failure with another name is no time limit",
    row: {
      seam: throwing(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
      expect: { error: `${AT} failed (no answer)` },
    },
  },
  {
    id: "C-TMO-04",
    function: "isTimeout",
    conjunct: "the name of a time limit is compared with its case",
    row: {
      seam: throwing({ name: "timeouterror" }),
      expect: { error: `${AT} failed (no answer)` },
    },
  },
  {
    id: "C-BOD-14",
    function: "get",
    conjunct: "an error of the body names the path that was asked for",
    row: {
      call: "reviews",
      reply: { cut: true },
      expect: {
        error: `github: GET ${REVIEWS_PATH} answered 200 (body not readable)`,
      },
    },
  },
  {
    id: "C-BOD-15",
    function: "bodyOf",
    conjunct: "the text that is searched for is the token, not a part of it",
    row: { reply: { json: pullJson() }, expect: { value: { author: "dev" } } },
  },
  {
    id: "C-GET-28",
    function: "get",
    conjunct:
      "a caller that maps no status gets an error for every status but 200",
    row: { reply: { status: 404 }, expect: { error: `${AT} answered 404` } },
  },
];

describe("CONJUNCTS: a request and the reading of its answer", () => {
  it("the table and the list of changes name the same conjuncts, each once", () => {
    const ids = CONJUNCTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(conjunctIds("github-errors"));
  });

  it.each(
    CONJUNCTS.map((entry) => [entry.id, entry.conjunct, entry.row] as const),
  )("%s: %s", { timeout: 4000 }, async (_id, _conjunct, row) => {
    if (row.shortLimits === true) {
      const real = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(150));
    }
    const expand = (reply: Reply): Reply =>
      reply.headers?.link === undefined
        ? reply
        : {
            ...reply,
            headers: {
              ...reply.headers,
              link: reply.headers.link.replace(
                /\{P:(\d+)\}/g,
                (_, n) => `${stub.url}${page(Number(n))}`,
              ),
            },
          };
    const reply = row.reply ?? { json: pullJson() };
    stub.on("/moved", { json: pullJson() });
    if (row.call === "enforcement") {
      stub.on(PULL_PATH, { json: pullJson() });
      stub.on(RULES_PATH, { json: [] });
      stub.on(PROTECTION_PATH, reply);
    } else if (row.call === "reviews") {
      stub.on(REVIEWS_PATH, reply);
      (row.pages ?? []).forEach((of, i) => stub.on(page(i + 1), expand(of)));
    } else {
      stub.on(PULL_PATH, reply);
    }
    let apiUrl = stub.url;
    if (row.gone === true) {
      const gone = http.createServer();
      await new Promise<void>((resolve) =>
        gone.listen(0, "127.0.0.1", resolve),
      );
      apiUrl = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
      await new Promise<void>((resolve) => gone.close(() => resolve()));
    }
    const host = hostAt(stub, {
      apiUrl,
      ...(row.seam === undefined
        ? {}
        : { fetch: row.seam as unknown as typeof globalThis.fetch }),
    });
    const call: Promise<unknown> =
      row.call === "enforcement"
        ? host.reviewEnforcement("specs/")
        : row.call === "reviews"
          ? host.reviews()
          : host.pullRequest();
    if ("error" in row.expect) {
      expect((await failing(call)).message).toBe(row.expect.error);
    } else {
      const value = await giving(call);
      if ("count" in row.expect) expect(value).toHaveLength(row.expect.count);
      else if (typeof row.expect.value === "object") {
        expect(value).toMatchObject(row.expect.value as object);
      } else expect(value).toBe(row.expect.value);
    }
    if (row.sent !== undefined) {
      expect(stub.hits[0]!.headers).toMatchObject(row.sent);
    }
    if (row.asked !== undefined) {
      expect(stub.hits.map((hit) => hit.url)).toEqual(row.asked);
    }
    expect(foreign.hits).toEqual([]);
  });
});
