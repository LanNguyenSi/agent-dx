import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  failing,
  giving,
  HEAD,
  hostAt,
  P,
  REPOSITORY,
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

describe("ciRunStatus: verified", () => {
  it("a completed run of this repository at the commit, named by its id", async () => {
    stub.on(RUN_PATH, { json: runJson() });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, RUN))).toBe("verified");
    expect(stub.hits.map((hit) => hit.url)).toEqual([RUN_PATH]);
  });

  it.each([
    [`https://github.com/acme/widgets/actions/runs/${RUN}`],
    [`https://github.com/Acme/Widgets/actions/runs/${RUN}`],
  ])("the same run named by its address %s", async (run) => {
    stub.on(RUN_PATH, { json: runJson() });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, run))).toBe("verified");
    expect(stub.hits.map((hit) => hit.url)).toEqual([RUN_PATH]);
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
    stub.on(RUN_PATH, { json: runJson() });
    expect(await giving(hostAt(stub).ciRunStatus(HEAD, run as string))).toBe(
      "unverified",
    );
    expect(stub.hits).toEqual([]);
  });

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
