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
import { conjunctIds } from "./conjunct-mutants.js";
import {
  expectClean,
  FORBIDDEN_CHARACTERS,
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

/** Marks a row whose options have no `apiUrl` key at all. */
const ABSENT = Symbol("no apiUrl");
const NOT_A_URL = "github: apiUrl must be a URL";
const NOT_HTTPS =
  "github: apiUrl must be https (http only for a loopback host)";
const CARRIES_MORE =
  "github: apiUrl must not carry credentials, a query or a fragment";

interface ApiUrlRow {
  /** The apiUrl option; left out of the options when the row has none. */
  apiUrl?: unknown;
  /** Other options that differ from the usual ones. */
  over?: Record<string, unknown>;
  /** A value in place of the whole options object. */
  options?: unknown;
  /** No fetch is given: the request goes through the global one to the stub. */
  global?: true;
  /** The address the first request goes to, or the refusal. */
  expect: { asked: string } | { refused: string };
}

const REPOSITORY_FORM = "github: repository must be <owner>/<name>";
const NUMBER_FORM = "github: pullRequest must be a positive integer";
const TOKEN_FORM = "github: token must be printable ASCII without a space";
const USUAL = { asked: `https://api.github.com${PULL_PATH}` };
const repository = (value: unknown): ApiUrlRow => ({
  over: { repository: value },
  expect: { refused: REPOSITORY_FORM },
});
const token = (value: unknown): ApiUrlRow => ({
  over: { token: value },
  expect: { refused: TOKEN_FORM },
});

/**
 * Every conjunct of the apiUrl check, one row each. The row of an id fails
 * when the change of that id in `conjunct-mutants.ts` is made to the source.
 */
const CONJUNCTS: {
  id: string;
  function: string;
  conjunct: string;
  row: ApiUrlRow;
}[] = [
  {
    id: "C-API-01",
    function: "createGitHubHost",
    conjunct: "without the option the root is the API of github.com",
    row: {
      apiUrl: ABSENT,
      expect: { asked: `https://api.github.com${PULL_PATH}` },
    },
  },
  {
    id: "C-API-02",
    function: "createGitHubHost",
    conjunct: "an option that is undefined is read as left out",
    row: {
      apiUrl: undefined,
      expect: { asked: `https://api.github.com${PULL_PATH}` },
    },
  },
  {
    id: "C-API-03",
    function: "createGitHubHost",
    conjunct: "null is refused, not read as left out",
    row: { apiUrl: null, expect: { refused: NOT_A_URL } },
  },
  {
    id: "C-API-04",
    function: "createGitHubHost",
    conjunct: "a value that is no text is refused even when it would parse",
    row: {
      apiUrl: new URL("https://ghe.example/api/v3"),
      expect: { refused: NOT_A_URL },
    },
  },
  {
    id: "C-API-05",
    function: "createGitHubHost",
    conjunct: "a text wins over the default",
    row: {
      apiUrl: "https://ghe.example",
      expect: { asked: `https://ghe.example${PULL_PATH}` },
    },
  },
  {
    id: "C-API-06",
    function: "createGitHubHost",
    conjunct: "an empty text is refused, not replaced by the default",
    row: { apiUrl: "", expect: { refused: NOT_A_URL } },
  },
  {
    id: "C-API-07",
    function: "apiRootOf",
    conjunct: "a text that does not parse is refused, not replaced",
    row: { apiUrl: "api.github.com", expect: { refused: NOT_A_URL } },
  },
  {
    id: "C-API-08",
    function: "apiRootOf",
    conjunct: "http to a host that is not loopback is refused",
    row: { apiUrl: "http://ghe.example", expect: { refused: NOT_HTTPS } },
  },
  {
    id: "C-API-09",
    function: "apiRootOf",
    conjunct: "another scheme is refused for a loopback host too",
    row: { apiUrl: "ftp://127.0.0.1/api", expect: { refused: NOT_HTTPS } },
  },
  {
    id: "C-API-10",
    function: "apiRootOf",
    conjunct: "https is accepted for a host that is not loopback",
    row: {
      apiUrl: "https://ghe.example:8443",
      expect: { asked: `https://ghe.example:8443${PULL_PATH}` },
    },
  },
  {
    id: "C-API-11",
    function: "apiRootOf",
    conjunct: "http is accepted for 127.0.0.1",
    row: {
      apiUrl: "http://127.0.0.1:8080",
      expect: { asked: `http://127.0.0.1:8080${PULL_PATH}` },
    },
  },
  {
    id: "C-API-12",
    function: "apiRootOf",
    conjunct: "http is accepted for [::1]",
    row: {
      apiUrl: "http://[::1]:8080",
      expect: { asked: `http://[::1]:8080${PULL_PATH}` },
    },
  },
  {
    id: "C-API-13",
    function: "apiRootOf",
    conjunct: "http is accepted for localhost",
    row: {
      apiUrl: "http://localhost:8080",
      expect: { asked: `http://localhost:8080${PULL_PATH}` },
    },
  },
  {
    id: "C-API-14",
    function: "apiRootOf",
    conjunct: "another address of the loopback net is not a loopback host",
    row: { apiUrl: "http://127.0.0.2:8080", expect: { refused: NOT_HTTPS } },
  },
  {
    id: "C-API-15",
    function: "apiRootOf",
    conjunct: "a user name is refused",
    row: {
      apiUrl: "https://user@ghe.example",
      expect: { refused: CARRIES_MORE },
    },
  },
  {
    id: "C-API-16",
    function: "apiRootOf",
    conjunct: "a password without a user name is refused",
    row: {
      apiUrl: "https://:secret@ghe.example",
      expect: { refused: CARRIES_MORE },
    },
  },
  {
    id: "C-API-17",
    function: "apiRootOf",
    conjunct: "a query is refused",
    row: {
      apiUrl: "https://ghe.example?x=1",
      expect: { refused: CARRIES_MORE },
    },
  },
  {
    id: "C-API-18",
    function: "apiRootOf",
    conjunct: "a fragment is refused",
    row: { apiUrl: "https://ghe.example#x", expect: { refused: CARRIES_MORE } },
  },
  {
    id: "C-API-19",
    function: "createGitHubHost",
    conjunct: "a slash at the end of the root is not doubled",
    row: {
      apiUrl: "https://ghe.example/",
      expect: { asked: `https://ghe.example${PULL_PATH}` },
    },
  },
  {
    id: "C-API-20",
    function: "createGitHubHost",
    conjunct: "the path of the root stays in front of every request",
    row: {
      apiUrl: "https://ghe.example/api/v3",
      expect: { asked: `https://ghe.example/api/v3${PULL_PATH}` },
    },
  },
  {
    id: "C-OPT-01",
    function: "createGitHubHost",
    conjunct: "options that are null are refused by name, not with a crash",
    row: {
      options: null,
      expect: { refused: "github: options must be an object" },
    },
  },
  {
    id: "C-OPT-02",
    function: "createGitHubHost",
    conjunct:
      "a repository that is no text is refused, even when it prints like one",
    row: repository(["acme/widgets"]),
  },
  {
    id: "C-OPT-03",
    function: "createGitHubHost",
    conjunct: "a repository without a name is refused",
    row: repository("acme"),
  },
  {
    id: "C-OPT-04",
    function: "createGitHubHost",
    conjunct: "a repository with a third segment is refused",
    row: repository("acme/widgets/extra"),
  },
  {
    id: "C-OPT-05",
    function: "createGitHubHost",
    conjunct: "the owner must match its pattern",
    row: repository("ac me/widgets"),
  },
  {
    id: "C-OPT-06",
    function: "createGitHubHost",
    conjunct: "an owner does not start with a hyphen",
    row: repository("-acme/widgets"),
  },
  {
    id: "C-OPT-07",
    function: "createGitHubHost",
    conjunct: "an owner has at most 39 characters",
    row: repository(`${"a".repeat(40)}/widgets`),
  },
  {
    id: "C-OPT-08",
    function: "createGitHubHost",
    conjunct: "a dot is no character of an owner",
    row: repository("ac.me/widgets"),
  },
  {
    id: "C-OPT-09",
    function: "createGitHubHost",
    conjunct: "nothing follows the owner",
    row: repository("acme!/widgets"),
  },
  {
    id: "C-OPT-10",
    function: "createGitHubHost",
    conjunct: "nothing stands before the owner",
    row: repository("!acme/widgets"),
  },
  {
    id: "C-OPT-11",
    function: "createGitHubHost",
    conjunct: "the name must match its pattern",
    row: repository("acme/wid gets"),
  },
  {
    id: "C-OPT-12",
    function: "createGitHubHost",
    conjunct: "a name has at most 100 characters",
    row: repository(`acme/${"w".repeat(101)}`),
  },
  {
    id: "C-OPT-13",
    function: "createGitHubHost",
    conjunct: "a name is not empty",
    row: repository("acme/"),
  },
  {
    id: "C-OPT-14",
    function: "createGitHubHost",
    conjunct: "a percent sign is no character of a name",
    row: repository("acme/wid%2fgets"),
  },
  {
    id: "C-OPT-15",
    function: "createGitHubHost",
    conjunct: "nothing stands before the name",
    row: repository("acme/!widgets"),
  },
  {
    id: "C-OPT-16",
    function: "createGitHubHost",
    conjunct: "nothing follows the name",
    row: repository("acme/widgets!"),
  },
  {
    id: "C-OPT-17",
    function: "createGitHubHost",
    conjunct: "a name that is one dot is refused",
    row: repository("acme/."),
  },
  {
    id: "C-OPT-18",
    function: "createGitHubHost",
    conjunct: "a name that is two dots is refused",
    row: repository("acme/.."),
  },
  {
    id: "C-OPT-19",
    function: "createGitHubHost",
    conjunct: "a pull request number is an integer",
    row: { over: { pullRequest: 1.5 }, expect: { refused: NUMBER_FORM } },
  },
  {
    id: "C-OPT-20",
    function: "createGitHubHost",
    conjunct: "a pull request number lies in the safe range",
    row: { over: { pullRequest: 2 ** 53 }, expect: { refused: NUMBER_FORM } },
  },
  {
    id: "C-OPT-21",
    function: "createGitHubHost",
    conjunct: "a pull request number is at least 1",
    row: { over: { pullRequest: 0 }, expect: { refused: NUMBER_FORM } },
  },
  {
    id: "C-OPT-22",
    function: "createGitHubHost",
    conjunct:
      "a token that is no text is refused, even when it prints like one",
    row: token(7),
  },
  {
    id: "C-OPT-23",
    function: "createGitHubHost",
    conjunct: "the token must match its pattern",
    row: token("line\nbreak"),
  },
  {
    id: "C-OPT-24",
    function: "createGitHubHost",
    conjunct: "a space is no character of a token",
    row: token("with space"),
  },
  {
    id: "C-OPT-25",
    function: "createGitHubHost",
    conjunct: "a character past ASCII is no character of a token",
    row: token("t\u00f6ken"),
  },
  {
    id: "C-OPT-26",
    function: "createGitHubHost",
    conjunct: "a token has at most 4096 characters",
    row: token("x".repeat(4097)),
  },
  {
    id: "C-OPT-27",
    function: "createGitHubHost",
    conjunct: "a token is not empty",
    row: token(""),
  },
  {
    id: "C-OPT-28",
    function: "createGitHubHost",
    conjunct: "nothing follows the token",
    row: token("abc\n"),
  },
  {
    id: "C-OPT-29",
    function: "createGitHubHost",
    conjunct: "nothing stands before the token",
    row: token("\nabc"),
  },
  {
    id: "C-OPT-30",
    function: "createGitHubHost",
    conjunct: "a fetch that is no function is refused",
    row: {
      over: { fetch: "fetch" },
      expect: { refused: "github: no fetch is available" },
    },
  },
  {
    id: "C-OPT-31",
    function: "createGitHubHost",
    conjunct: "a given fetch wins over the global one",
    row: {
      apiUrl: "http://127.0.0.1:9",
      expect: { asked: `http://127.0.0.1:9${PULL_PATH}` },
    },
  },
  {
    id: "C-OPT-32",
    function: "createGitHubHost",
    conjunct: "without a given fetch the global one is used",
    row: { global: true, expect: USUAL },
  },
  {
    id: "C-OPT-33",
    function: "createGitHubHost",
    conjunct:
      "the character after the last printable one is no character of a token",
    row: token("ab\x7f"),
  },
  {
    id: "C-OPT-34",
    function: "createGitHubHost",
    conjunct:
      "the first printable character after the space is a character of a token",
    row: { over: { token: "a!b" }, expect: USUAL },
  },
  {
    id: "C-OPT-35",
    function: "createGitHubHost",
    conjunct: "the last printable character is a character of a token",
    row: { over: { token: "a~b" }, expect: USUAL },
  },
];

describe("CONJUNCTS: the options of the adapter", () => {
  it("the table and the list of changes name the same conjuncts, each once", () => {
    const ids = CONJUNCTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(conjunctIds("github-options"));
  });

  it.each(
    CONJUNCTS.map((entry) => [entry.id, entry.conjunct, entry.row] as const),
  )("%s: %s", async (_id, _conjunct, row) => {
    const seam = recorder();
    if (row.global === true) {
      stub.on(PULL_PATH, { json: pullJson() });
      await giving(hostAt(stub).pullRequest());
      expect(stub.hits.map((hit) => hit.url)).toEqual([PULL_PATH]);
      return;
    }
    const options =
      "options" in row
        ? row.options
        : {
            ...OPTIONS,
            fetch: seam.fetch,
            ...(!("apiUrl" in row) || row.apiUrl === ABSENT
              ? {}
              : { apiUrl: row.apiUrl }),
            ...row.over,
          };
    if ("refused" in row.expect) {
      expect(refusal(options).message).toBe(row.expect.refused);
      expect(seam.calls).toEqual([]);
    } else {
      await createGitHubHost(options as GitHubHostOptions).pullRequest();
      expect(seam.calls.map((call) => call.url)).toEqual([row.expect.asked]);
    }
  });

  it.each([...FORBIDDEN_CHARACTERS, ".", "+"])(
    "an owner with %j in it is refused",
    (char) => {
      for (const owner of [`${char}acme`, `ac${char}me`, `acme${char}`]) {
        const options = { ...OPTIONS, repository: `${owner}/widgets` };
        expect(refusal(options).message).toBe(REPOSITORY_FORM);
      }
    },
  );

  it.each([...FORBIDDEN_CHARACTERS, "+"])(
    "a name with %j in it is refused",
    (char) => {
      for (const name of [
        `${char}widgets`,
        `wid${char}gets`,
        `widgets${char}`,
      ]) {
        const options = { ...OPTIONS, repository: `acme/${name}` };
        expect(refusal(options).message).toBe(REPOSITORY_FORM);
      }
    },
  );
});
