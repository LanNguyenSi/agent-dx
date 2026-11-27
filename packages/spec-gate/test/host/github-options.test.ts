import { inspect } from "node:util";
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
  createGitHubHost,
  GITHUB_API_URL,
  GITHUB_API_VERSION,
  GITHUB_MAX_BODY_BYTES,
  GITHUB_MAX_PAGES,
  GITHUB_PAGE_SIZE,
  GITHUB_TIMEOUT_MS,
  type GitHubHostOptions,
} from "../../src/host/index.js";
import {
  expectClean,
  giving,
  hostAt,
  PULL,
  PULL_PATH,
  pullJson,
  REPOSITORY,
  Stub,
  TOKEN,
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
});
afterEach(() => {
  vi.restoreAllMocks();
});

const OPTIONS: GitHubHostOptions = {
  repository: REPOSITORY,
  pullRequest: PULL,
  token: TOKEN,
};

/** A `fetch` that records what it was asked and answers with a pull request. */
function recorder() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(pullJson()), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

/** The refusal of a construction: an `Error` that shows no token. */
function refusal(options: unknown): Error {
  let made: unknown;
  try {
    made = createGitHubHost(options as GitHubHostOptions);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expectClean(error);
    expect((error as Error).message).toMatch(/^github: /);
    return error as Error;
  }
  throw new Error(`the construction was not refused: ${inspect(made)}`);
}

describe("createGitHubHost: the API root", () => {
  it.each([
    ["https://api.github.com"],
    ["https://ghe.example/api/v3"],
    ["https://ghe.example/api/v3/"],
    ["http://127.0.0.1:8080"],
    ["http://[::1]:8080"],
    ["http://localhost:8080"],
    ["HTTP://LOCALHOST:8080"],
  ])("accepts %s", (apiUrl) => {
    expect(() => createGitHubHost({ ...OPTIONS, apiUrl })).not.toThrow();
  });

  it.each([
    ["http://api.github.com"],
    ["http://ghe.example/api/v3"],
    ["http://127.0.0.2:8080"],
    ["http://0.0.0.0:8080"],
    ["http://localhost.example:8080"],
    ["http://127.0.0.1.example:8080"],
    ["http://[::2]:8080"],
  ])("refuses plain http to %s, and sends nothing there", async (apiUrl) => {
    const seam = recorder();
    const error = refusal({ ...OPTIONS, apiUrl, fetch: seam.fetch });
    expect(error.message).toBe(
      "github: apiUrl must be https (http only for a loopback host)",
    );
    expect(seam.calls).toEqual([]);
  });

  it.each([
    ["ftp://127.0.0.1/api"],
    ["file:///etc/hosts"],
    ["ws://127.0.0.1:1"],
  ])("refuses the scheme of %s", (apiUrl) => {
    expect(refusal({ ...OPTIONS, apiUrl }).message).toBe(
      "github: apiUrl must be https (http only for a loopback host)",
    );
  });

  it.each([
    ["", "github: apiUrl must be a URL"],
    ["api.github.com", "github: apiUrl must be a URL"],
    ["/api/v3", "github: apiUrl must be a URL"],
    [7, "github: apiUrl must be a URL"],
    [
      "https://api.github.com?x=1",
      "github: apiUrl must not carry credentials, a query or a fragment",
    ],
    [
      "https://api.github.com#x",
      "github: apiUrl must not carry credentials, a query or a fragment",
    ],
    [
      `https://user:${TOKEN}@api.github.com`,
      "github: apiUrl must not carry credentials, a query or a fragment",
    ],
    [
      "https://user@api.github.com",
      "github: apiUrl must not carry credentials, a query or a fragment",
    ],
    [
      "https://:secret@api.github.com",
      "github: apiUrl must not carry credentials, a query or a fragment",
    ],
  ])("refuses %j without repeating it", (apiUrl, message) => {
    expect(refusal({ ...OPTIONS, apiUrl }).message).toBe(message);
  });

  // The default and the option: which one wins, one case per combination.
  it("apiUrl absent: the default root is used", async () => {
    const seam = recorder();
    await createGitHubHost({ ...OPTIONS, fetch: seam.fetch }).pullRequest();
    expect(GITHUB_API_URL).toBe("https://api.github.com");
    expect(seam.calls.map((call) => call.url)).toEqual([
      `https://api.github.com${PULL_PATH}`,
    ]);
  });

  it("apiUrl undefined: the default root is used", async () => {
    const seam = recorder();
    await createGitHubHost({
      ...OPTIONS,
      apiUrl: undefined,
      fetch: seam.fetch,
    }).pullRequest();
    expect(seam.calls.map((call) => call.url)).toEqual([
      `https://api.github.com${PULL_PATH}`,
    ]);
  });

  it("apiUrl null: refused, not read as absent, and nothing is sent", () => {
    const seam = recorder();
    const error = refusal({ ...OPTIONS, apiUrl: null, fetch: seam.fetch });
    expect(error.message).toBe("github: apiUrl must be a URL");
    expect(seam.calls).toEqual([]);
  });

  it.each([
    ["a number", 7],
    ["a truth value", false],
    ["an object", { href: "https://ghe.example/api/v3" }],
    ["a parsed address", new URL("https://ghe.example/api/v3")],
  ])(
    "apiUrl that is %s: refused, only a text is an address",
    (_what, apiUrl) => {
      const seam = recorder();
      const error = refusal({ ...OPTIONS, apiUrl, fetch: seam.fetch });
      expect(error.message).toBe("github: apiUrl must be a URL");
      expect(seam.calls).toEqual([]);
    },
  );

  it("apiUrl given: it wins over the default, with its path prefix and without a doubled slash", async () => {
    const seam = recorder();
    await createGitHubHost({
      ...OPTIONS,
      apiUrl: "https://ghe.example/api/v3/",
      fetch: seam.fetch,
    }).pullRequest();
    expect(seam.calls.map((call) => call.url)).toEqual([
      `https://ghe.example/api/v3${PULL_PATH}`,
    ]);
  });

  it("apiUrl empty: refused, not replaced by the default", () => {
    const seam = recorder();
    refusal({ ...OPTIONS, apiUrl: "", fetch: seam.fetch });
    expect(seam.calls).toEqual([]);
  });
});

describe("createGitHubHost: the fetch seam", () => {
  it("fetch absent: the global fetch is used", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    stub.on(PULL_PATH, { json: pullJson() });
    await giving(hostAt(stub).pullRequest());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(stub.hits).toHaveLength(1);
  });

  it("fetch given: it wins, and the global fetch is not called", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const seam = recorder();
    stub.on(PULL_PATH, { json: pullJson() });
    await hostAt(stub, { fetch: seam.fetch }).pullRequest();
    expect(seam.calls).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    expect(stub.hits).toEqual([]);
  });

  it("fetch that is no function: refused", () => {
    expect(refusal({ ...OPTIONS, fetch: "fetch" }).message).toBe(
      "github: no fetch is available",
    );
  });
});

describe("createGitHubHost: repository, pull request and token", () => {
  it.each([["acme/widgets"], ["a/b"], ["A-b_c/x.y_z-1"], ["acme/.github"]])(
    "accepts the repository %s",
    (repository) => {
      expect(() => createGitHubHost({ ...OPTIONS, repository })).not.toThrow();
    },
  );

  it.each([
    ["acme"],
    ["acme/"],
    ["/widgets"],
    ["acme/widgets/extra"],
    ["acme/.."],
    ["acme/."],
    ["../widgets"],
    ["ac me/widgets"],
    ["acme/wid gets"],
    ["acme/widgets?x=1"],
    ["acme/widgets#x"],
    ["acme/wid%2fgets"],
    ["acme\\widgets"],
    ["-acme/widgets"],
    [`${"a".repeat(40)}/widgets`],
    [`acme/${"w".repeat(101)}`],
    ["acme/widgets\n"],
    [""],
    [7],
    [undefined],
  ])("refuses the repository %j", (repository) => {
    expect(refusal({ ...OPTIONS, repository }).message).toBe(
      "github: repository must be <owner>/<name>",
    );
  });

  it.each([[1], [7], [Number.MAX_SAFE_INTEGER]])(
    "accepts the pull request number %d",
    (pullRequest) => {
      expect(() => createGitHubHost({ ...OPTIONS, pullRequest })).not.toThrow();
    },
  );

  it.each([
    [0],
    [-1],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [2 ** 53],
    ["7"],
    [null],
    [undefined],
  ])("refuses the pull request number %j", (pullRequest) => {
    expect(refusal({ ...OPTIONS, pullRequest }).message).toBe(
      "github: pullRequest must be a positive integer",
    );
  });

  it.each([
    [""],
    ["with space"],
    ["line\nbreak"],
    ["carriage\rreturn"],
    ["töken"],
    ["x".repeat(4097)],
    [7],
    [undefined],
  ])("refuses the token %j without repeating it", (token) => {
    const error = refusal({ ...OPTIONS, token });
    expect(error.message).toBe(
      "github: token must be printable ASCII without a space",
    );
    if (typeof token === "string" && token.length > 0) {
      expect(inspect(error)).not.toContain(token);
    }
  });

  it.each([[null], [undefined], ["acme/widgets"], [[OPTIONS]]])(
    "refuses options that are %j",
    (options) => {
      expect(refusal(options).message).toBe(
        "github: options must be an object",
      );
    },
  );
});

describe("createGitHubHost: what a request carries", () => {
  it("sends one GET with the token in the Authorization header only, the media type and the pinned version", async () => {
    stub.on(PULL_PATH, { json: pullJson() });
    await giving(hostAt(stub).pullRequest());
    expect(stub.hits).toHaveLength(1);
    const hit = stub.hits[0]!;
    expect(hit.method).toBe("GET");
    expect(hit.url).toBe(PULL_PATH);
    expect(hit.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(hit.headers.accept).toBe("application/vnd.github+json");
    expect(hit.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(hit.headers["user-agent"]).toBe("spec-gate");
    expect(GITHUB_API_VERSION).toBe("2022-11-28");
    const elsewhere = Object.entries(hit.headers).filter(
      ([name, value]) =>
        name !== "authorization" && String(value).includes(TOKEN),
    );
    expect(elsewhere).toEqual([]);
    expect(hit.url).not.toContain(TOKEN);
  });

  it("asks without following redirects and with a time limit", async () => {
    const seam = recorder();
    await createGitHubHost({ ...OPTIONS, fetch: seam.fetch }).pullRequest();
    const init = seam.calls[0]!.init!;
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });

  it("keeps the path prefix of the API root in every request", async () => {
    stub.on(`/api/v3${PULL_PATH}`, { json: pullJson() });
    await giving(hostAt(stub, { apiUrl: `${stub.url}/api/v3` }).pullRequest());
    expect(stub.hits.map((hit) => hit.url)).toEqual([`/api/v3${PULL_PATH}`]);
  });

  it("the adapter object does not hold the token", () => {
    const host = hostAt(stub);
    expectClean(host);
    expect(Object.keys(host).sort()).toEqual([
      "ciRunStatus",
      "lastConfigCommit",
      "pullRequest",
      "reviewEnforcement",
      "reviews",
    ]);
    for (const method of Object.values(host)) {
      expect(String(method)).not.toContain(TOKEN);
    }
  });

  it("has the documented limits", () => {
    expect(GITHUB_TIMEOUT_MS).toBe(10_000);
    expect(GITHUB_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
    expect(GITHUB_PAGE_SIZE).toBe(100);
    expect(GITHUB_MAX_PAGES).toBe(30);
  });
});
