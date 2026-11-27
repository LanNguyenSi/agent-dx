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
  GITHUB_MAX_BODY_BYTES,
  GITHUB_TIMEOUT_MS,
} from "../../src/host/index.js";
import {
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
