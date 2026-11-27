import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubHost } from "../../src/host/index.js";
import { conjunctIds } from "./conjunct-mutants.js";
import {
  failing,
  FORBIDDEN_CHARACTERS,
  giving,
  HEAD,
  hostAt,
  P,
  PULL,
  REPOSITORY,
  sha,
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

const RUN = "8123456789";
const RUN_PATH = `${P}/actions/runs/${RUN}`;

/** A workflow run as `GET /repos/{owner}/{repo}/actions/runs/{run_id}` gives it. */
function runJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(RUN),
    name: "ci",
    head_branch: "feature",
    head_sha: HEAD,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: "dev/widgets" },
    ...over,
  };
}

/**
 * An adapter on `apiUrl` (the API root of github.com when left out) whose
 * requests a fake fetch records and answers with the run.
 */
function onRoot(
  apiUrl?: string,
  reply: { status?: number; json?: unknown } = {},
  repository: string = REPOSITORY,
) {
  const asked: string[] = [];
  const fetch = (async (input: unknown) => {
    asked.push(String(input));
    return new Response(
      JSON.stringify("json" in reply ? reply.json : runJson()),
      { status: reply.status ?? 200 },
    );
  }) as typeof globalThis.fetch;
  const host = createGitHubHost({
    repository,
    pullRequest: PULL,
    token: TOKEN,
    apiUrl,
    fetch,
  });
  return { host, asked };
}

describe("ciRunStatus: verified", () => {
  it("a completed run of this repository at the commit, named by its id", async () => {
    stub.on(RUN_PATH, { json: runJson() });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, RUN))).toBe("verified");
    expect(stub.hits.map((hit) => hit.url)).toEqual([RUN_PATH]);
  });

  it.each([
    [`https://github.com/acme/widgets/actions/runs/${RUN}`],
    [`https://github.com/Acme/Widgets/actions/runs/${RUN}`],
  ])(
    "the same run named by its address %s, on the API root of github.com",
    async (run) => {
      const github = onRoot();
      expect(await giving(github.host.ciRunStatus(HEAD, run))).toBe("verified");
      expect(github.asked).toEqual([`https://api.github.com${RUN_PATH}`]);
    },
  );

  it("a run named by its id on another API root", async () => {
    const other = onRoot("https://ghe.example/api/v3");
    expect(await giving(other.host.ciRunStatus(HEAD, RUN))).toBe("verified");
    expect(other.asked).toEqual([`https://ghe.example/api/v3${RUN_PATH}`]);
  });

  it("says nothing about how the run ended: a failed run that completed is a run", async () => {
    stub.on(RUN_PATH, { json: runJson({ conclusion: "failure" }) });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, RUN))).toBe("verified");
  });

  it("accepts another spelling of the repository's case in the answer", async () => {
    stub.on(RUN_PATH, {
      json: runJson({ repository: { full_name: "Acme/Widgets" } }),
    });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, RUN))).toBe("verified");
  });
});

describe("ciRunStatus: unverified", () => {
  it("a run the repository does not have", async () => {
    stub.on(RUN_PATH, { status: 404, json: { message: "Not Found" } });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, RUN))).toBe(
      "unverified",
    );
    expect(stub.hits).toHaveLength(1);
  });

  it.each([
    ["at another commit", { head_sha: sha("c") }],
    ["at the commit in upper case", { head_sha: HEAD.toUpperCase() }],
    ["of another repository", { repository: { full_name: "evil/widgets" } }],
    [
      "of a repository that only starts like this one",
      { repository: { full_name: "acme/widgets2" } },
    ],
    ["with another id", { id: Number(RUN) + 1 }],
    ["still in progress", { status: "in_progress", conclusion: null }],
    ["still queued", { status: "queued", conclusion: null }],
    ["without a status", { status: null }],
    ["with a status in another case", { status: "Completed" }],
  ])("a run %s", async (_what, over) => {
    stub.on(RUN_PATH, { json: runJson(over) });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, RUN))).toBe(
      "unverified",
    );
  });

  it.each([
    [
      "the address of a run of another repository",
      `https://github.com/evil/widgets/actions/runs/${RUN}`,
    ],
    [
      "the address of a run of another owner",
      `https://github.com/acme2/widgets/actions/runs/${RUN}`,
    ],
    [
      "an address on another host",
      `https://github.example/acme/widgets/actions/runs/${RUN}`,
    ],
    [
      "an address on a host that only ends like the host",
      `https://evilgithub.com/acme/widgets/actions/runs/${RUN}`,
    ],
    [
      "an address over http",
      `http://github.com/acme/widgets/actions/runs/${RUN}`,
    ],
    [
      "an address with credentials",
      `https://user@github.com/acme/widgets/actions/runs/${RUN}`,
    ],
    [
      "an address with more below the run",
      `https://github.com/acme/widgets/actions/runs/${RUN}/attempts/2`,
    ],
    [
      "an address with a query",
      `https://github.com/acme/widgets/actions/runs/${RUN}?check_suite_focus=true`,
    ],
    [
      "an address with a fragment",
      `https://github.com/acme/widgets/actions/runs/${RUN}#summary`,
    ],
    [
      "an address with a parent segment",
      `https://github.com/acme/widgets/x/../actions/runs/${RUN}`,
    ],
    [
      "an address of the API",
      `https://api.github.com/repos/acme/widgets/actions/runs/${RUN}`,
    ],
    ["an id with a leading zero", `0${RUN}`],
    ["zero", "0"],
    ["a negative id", `-${RUN}`],
    ["an id with a sign", `+${RUN}`],
    ["an id with a space", `${RUN} `],
    ["an id with a path", `${RUN}/../../pulls/7`],
    ["an id in hex", "0x1F"],
    ["an id with an exponent", "8e9"],
    ["an id past the safe range", "9007199254740993"],
    ["an id of seventeen digits", "12345678901234567"],
    ["a name", "ci"],
    ["an empty text", ""],
    ["a number", 8123456789],
    ["nothing", undefined],
  ])("%s, without asking the host", async (_what, run) => {
    // An address is read on the API root of github.com only, so every row
    // is also asked there: it must be refused for its own form.
    const github = onRoot();
    stub.on(RUN_PATH, { json: runJson() });
    for (const host of [hostAt(stub), github.host]) {
      expect(await giving(host.ciRunStatus(HEAD, run as string))).toBe(
        "unverified",
      );
    }
    expect(stub.hits).toEqual([]);
    expect(github.asked).toEqual([]);
  });

  it.each([
    ["a loopback root", undefined],
    ["an enterprise root", "https://ghe.example/api/v3"],
    ["a root on another host of github.com", "https://uploads.github.com"],
    [
      "a root that only starts like the API of github.com",
      "https://api.github.com.example",
    ],
  ])(
    "the address of a run on github.com is not read on %s: the run there is another run",
    async (_what, apiUrl) => {
      const other = onRoot(apiUrl ?? stub.url);
      const address = `https://github.com/acme/widgets/actions/runs/${RUN}`;
      expect(await giving(other.host.ciRunStatus(HEAD, address))).toBe(
        "unverified",
      );
      expect(other.asked).toEqual([]);
    },
  );

  it.each([
    ["a short commit id", "aaaaaaa"],
    ["a commit id in upper case", HEAD.toUpperCase()],
    ["a branch name", "main"],
    ["an empty text", ""],
    ["nothing", undefined],
  ])("%s as the commit, without asking the host", async (_what, commit) => {
    stub.on(RUN_PATH, { json: runJson({ head_sha: commit }) });
    expect(await giving(hostAt(stub).ciRunStatus(commit as string, RUN))).toBe(
      "unverified",
    );
    expect(stub.hits).toEqual([]);
  });

  it("accepts the largest safe id as an id", async () => {
    const id = String(Number.MAX_SAFE_INTEGER);
    stub.on(`${P}/actions/runs/${id}`, {
      json: runJson({ id: Number.MAX_SAFE_INTEGER }),
    });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, id))).toBe("verified");
  });
});

describe("ciRunStatus: failures", () => {
  it.each([[401], [403], [500], [503]])(
    "throws on status %d: only a missing run is unverified",
    async (status) => {
      stub.on(RUN_PATH, { status, json: { message: "no" } });
      const error = await failing(hostAt(stub).ciRunStatus(HEAD, RUN));
      expect(error.message).toBe(`github: GET ${RUN_PATH} answered ${status}`);
    },
  );

  it.each([
    ["a body that is no object", [runJson()], "not an object"],
    ["an id as text", runJson({ id: RUN })],
    ["no id", runJson({ id: undefined })],
    ["no commit", runJson({ head_sha: undefined })],
    ["a status that is no text", runJson({ status: 1 })],
    ["no repository", runJson({ repository: undefined })],
    ["a repository without a name", runJson({ repository: {} })],
  ])(
    "throws on a run with %s",
    async (_what, json, reason = "a run has an unexpected shape") => {
      stub.on(RUN_PATH, { json });
      const error = await failing(hostAt(stub).ciRunStatus(HEAD, RUN));
      expect(error.message).toBe(
        `github: GET ${RUN_PATH} answered 200 (${reason})`,
      );
    },
  );
});

const ADDRESS = `https://github.com/acme/widgets/actions/runs/${RUN}`;
const GHE = "https://ghe.example/api/v3";
const SHAPE = `github: GET ${RUN_PATH} answered 200 (a run has an unexpected shape)`;

interface RunRow {
  /** The API root; the one of github.com when left out. */
  root?: string;
  run: unknown;
  /** The commit asked for; the head when left out. */
  commit?: string;
  /** The status the host answers with; 200 when left out. */
  status?: number;
  /** The body the host answers with: the run, changed by `over`, or `json`. */
  over?: Record<string, unknown>;
  json?: unknown;
  expect: "verified" | "unverified" | { error: string };
  /** How many requests the host gets. */
  asked: number;
  /** The repository the adapter is made for; acme/widgets when left out. */
  repository?: string;
  /** The one request the host gets. */
  askedFor?: string;
}

/**
 * Every conjunct of the run name and of the run check, one row each. The
 * row of an id fails when the change of that id in `conjunct-mutants.ts` is
 * made to the source.
 */
const CONJUNCTS: {
  id: string;
  function: string;
  conjunct: string;
  row: RunRow;
}[] = [
  {
    id: "C-RUN-01",
    function: "runIdOf",
    conjunct: "a run name that is no text names no run",
    row: { run: 8123456789, expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-02",
    function: "runIdOf",
    conjunct: "a bare id names a run",
    row: { run: RUN, expect: "verified", asked: 1 },
  },
  {
    id: "C-RUN-03",
    function: "runIdOf",
    conjunct: "a bare id names a run on every API root",
    row: { root: GHE, run: RUN, expect: "verified", asked: 1 },
  },
  {
    id: "C-RUN-04",
    function: "runIdOf",
    conjunct: "an id does not start with a zero",
    row: { run: `0${RUN}`, expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-05",
    function: "runIdOf",
    conjunct: "an id holds digits only",
    row: { run: "8e9", expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-06",
    function: "runIdOf",
    conjunct: "an id past the safe range names no run",
    row: { run: "9007199254740993", expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-07",
    function: "runIdOf",
    conjunct: "nothing follows the digits of an id",
    row: { run: `${RUN} `, expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-08",
    function: "runIdOf",
    conjunct: "nothing stands before the digits of an id",
    row: { run: `+${RUN}`, expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-09",
    function: "ciRunStatus",
    conjunct: "an address is read on the API root of github.com",
    row: { run: ADDRESS, expect: "verified", asked: 1 },
  },
  {
    id: "C-RUN-10",
    function: "runIdOf",
    conjunct: "an address is not read when the root is another one",
    row: { root: GHE, run: ADDRESS, expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-11",
    function: "ciRunStatus",
    conjunct: "https alone does not make a root the one of github.com",
    row: {
      root: "https://ghe.example",
      run: ADDRESS,
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-12",
    function: "ciRunStatus",
    conjunct:
      "a root that only starts like the API of github.com is another root",
    row: {
      root: "https://api.github.com.example",
      run: ADDRESS,
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-13",
    function: "ciRunStatus",
    conjunct: "a loopback root is another root",
    row: {
      root: "http://127.0.0.1:9",
      run: ADDRESS,
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-14",
    function: "runIdOf",
    conjunct: "nothing stands before an address",
    row: { run: `see ${ADDRESS}`, expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-15",
    function: "runIdOf",
    conjunct: "nothing follows the id of an address",
    row: { run: `${ADDRESS}/attempts/2`, expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-16",
    function: "runIdOf",
    conjunct: "an address is https",
    row: {
      run: ADDRESS.replace("https:", "http:"),
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-17",
    function: "runIdOf",
    conjunct: "the host of an address is github.com, dot and all",
    row: {
      run: ADDRESS.replace("github.com", "githubxcom"),
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-18",
    function: "runIdOf",
    conjunct: "a text that is neither an id nor an address names no run",
    row: { run: "ci", expect: "unverified", asked: 0 },
  },
  {
    id: "C-RUN-19",
    function: "runIdOf",
    conjunct: "an address of another repository names no run of this one",
    row: {
      run: ADDRESS.replace("acme/widgets", "evil/gadgets"),
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-20",
    function: "runIdOf",
    conjunct: "the owner of an address counts, not only the name",
    row: {
      run: ADDRESS.replace("acme/widgets", "evil/widgets"),
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-21",
    function: "runIdOf",
    conjunct: "the name of an address counts, not only the owner",
    row: {
      run: ADDRESS.replace("acme/widgets", "acme/gadgets"),
      expect: "unverified",
      asked: 0,
    },
  },
  {
    id: "C-RUN-22",
    function: "runIdOf",
    conjunct:
      "the repository of an address is compared without the case of ASCII letters",
    row: {
      run: ADDRESS.replace("acme/widgets", "Acme/Widgets"),
      expect: "verified",
      asked: 1,
    },
  },
  {
    id: "C-CI-01",
    function: "ciRunStatus",
    conjunct: "a commit that is no full id is unverified without a request",
    row: { run: RUN, commit: "aaaaaaa", expect: "unverified", asked: 0 },
  },
  {
    id: "C-CI-02",
    function: "ciRunStatus",
    conjunct: "a run name that names no run is unverified without a request",
    row: { run: "", expect: "unverified", asked: 0 },
  },
  {
    id: "C-CI-03",
    function: "ciRunStatus",
    conjunct: "a run the repository does not have is an answer, not an error",
    row: { run: RUN, status: 404, expect: "unverified", asked: 1 },
  },
  {
    id: "C-CI-04",
    function: "ciRunStatus",
    conjunct: "a run the repository does not have is unverified, not unknown",
    row: { run: RUN, status: 404, json: {}, expect: "unverified", asked: 1 },
  },
  {
    id: "C-CI-05",
    function: "ciRunStatus",
    conjunct: "a run that may not be read is an error, not unverified",
    row: {
      run: RUN,
      status: 403,
      expect: { error: `github: GET ${RUN_PATH} answered 403` },
      asked: 1,
    },
  },
  {
    id: "C-CI-06",
    function: "ciRunStatus",
    conjunct: "a body that is no object is an error",
    row: {
      run: RUN,
      json: [runJson()],
      expect: {
        error: `github: GET ${RUN_PATH} answered 200 (not an object)`,
      },
      asked: 1,
    },
  },
  {
    id: "C-CI-07",
    function: "ciRunStatus",
    conjunct: "an id that is no number is an error",
    row: { run: RUN, over: { id: RUN }, expect: { error: SHAPE }, asked: 1 },
  },
  {
    id: "C-CI-08",
    function: "ciRunStatus",
    conjunct: "a run without a commit is an error",
    row: {
      run: RUN,
      over: { head_sha: undefined },
      expect: { error: SHAPE },
      asked: 1,
    },
  },
  {
    id: "C-CI-09",
    function: "ciRunStatus",
    conjunct: "a status of another type is an error",
    row: { run: RUN, over: { status: 1 }, expect: { error: SHAPE }, asked: 1 },
  },
  {
    id: "C-CI-10",
    function: "ciRunStatus",
    conjunct: "a repository without a name is an error",
    row: {
      run: RUN,
      over: { repository: {} },
      expect: { error: SHAPE },
      asked: 1,
    },
  },
  {
    id: "C-CI-11",
    function: "ciRunStatus",
    conjunct: "a repository that is no object has no name",
    row: {
      run: RUN,
      over: { repository: REPOSITORY },
      expect: { error: SHAPE },
      asked: 1,
    },
  },
  {
    id: "C-CI-12",
    function: "ciRunStatus",
    conjunct: "a run without a status is a run, and unverified",
    row: {
      run: RUN,
      over: { status: null, conclusion: null },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-CI-13",
    function: "ciRunStatus",
    conjunct: "the run the host answers with must be the run asked for",
    row: {
      run: RUN,
      over: { id: Number(RUN) + 1 },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-CI-14",
    function: "ciRunStatus",
    conjunct: "the run must belong to this repository",
    row: {
      run: RUN,
      over: { repository: { full_name: "evil/widgets" } },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-CI-15",
    function: "ciRunStatus",
    conjunct: "the run must have run at the commit",
    row: {
      run: RUN,
      over: { head_sha: sha("c") },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-CI-16",
    function: "ciRunStatus",
    conjunct: "the run must have completed",
    row: {
      run: RUN,
      over: { status: "in_progress", conclusion: null },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-CI-17",
    function: "ciRunStatus",
    conjunct: "a run that meets all four is verified",
    row: { run: RUN, expect: "verified", asked: 1 },
  },
  {
    id: "C-CI-18",
    function: "ciRunStatus",
    conjunct: "a run that misses one is unverified, not unknown",
    row: {
      run: RUN,
      over: { status: "queued", conclusion: null },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-RUN-23",
    function: "ciRunStatus",
    conjunct:
      "an address is compared with the repository the adapter was made for",
    row: {
      repository: "octo/cat",
      run: `https://github.com/octo/cat/actions/runs/${RUN}`,
      over: { repository: { full_name: "octo/cat" } },
      expect: "verified",
      asked: 1,
    },
  },
  {
    id: "C-RUN-24",
    function: "ciRunStatus",
    conjunct: "the run asked for is the run that was named",
    row: {
      run: "555",
      over: { id: 555 },
      expect: "verified",
      asked: 1,
      askedFor: `https://api.github.com${P}/actions/runs/555`,
    },
  },
  {
    id: "C-CI-19",
    function: "ciRunStatus",
    conjunct: "the status of a run is compared with its case",
    row: {
      run: RUN,
      over: { status: "Completed" },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-CI-20",
    function: "sameRepository",
    conjunct:
      "a repository whose name only starts like this one is another repository",
    row: {
      run: RUN,
      over: { repository: { full_name: "acme/widgets-fork" } },
      expect: "unverified",
      asked: 1,
    },
  },
  {
    id: "C-CI-21",
    function: "ciRunStatus",
    conjunct: "a repository that is null is an unexpected shape, and no crash",
    row: {
      run: RUN,
      over: { repository: null },
      expect: { error: SHAPE },
      asked: 1,
    },
  },
  {
    id: "C-RUN-25",
    function: "ciRunStatus",
    conjunct: "the id is read from the name that was given",
    row: { run: "555", over: { id: 555 }, expect: "verified", asked: 1 },
  },
  {
    id: "C-RUN-26",
    function: "runIdOf",
    conjunct: "an address is compared with its case",
    row: {
      run: ADDRESS.replace("github.com", "GitHub.com"),
      expect: "unverified",
      asked: 0,
    },
  },
];

describe("CONJUNCTS: the name of a run and what makes it verified", () => {
  it("the table and the list of changes name the same conjuncts, each once", () => {
    const ids = CONJUNCTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(conjunctIds("github-ci"));
  });

  it.each(
    CONJUNCTS.map((entry) => [entry.id, entry.conjunct, entry.row] as const),
  )("%s: %s", async (_id, _conjunct, row) => {
    const root = onRoot(
      row.root,
      {
        status: row.status,
        json: "json" in row ? row.json : runJson(row.over),
      },
      row.repository,
    );
    const call = root.host.ciRunStatus(row.commit ?? HEAD, row.run as string);
    if (typeof row.expect === "string") {
      expect(await giving(call)).toBe(row.expect);
    } else {
      expect((await failing(call)).message).toBe(row.expect.error);
    }
    expect(root.asked).toHaveLength(row.asked);
    if (row.askedFor !== undefined) {
      expect(root.asked).toEqual([row.askedFor]);
    }
  });

  // What the id of a run may not hold, one test each: no request is made
  // for a name that only a lenient reader of numbers would take as an id.
  it.each([...FORBIDDEN_CHARACTERS, ".", "e", "+", "-", "_", "x"])(
    "a run id with %j in it names no run",
    async (char) => {
      for (const run of [
        `8${char}1`,
        `81${char}`,
        `${char}81`,
        `${ADDRESS}${char}`,
        ADDRESS.replace(RUN, `8${char}1`),
      ]) {
        const root = onRoot();
        expect(await giving(root.host.ciRunStatus(HEAD, run))).toBe(
          "unverified",
        );
        expect(root.asked).toEqual([]);
      }
    },
  );
});
