import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BASE,
  failing,
  giving,
  HEAD,
  hostAt,
  PULL_PATH,
  pullJson,
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

const AT = `github: GET ${PULL_PATH} answered 200`;

describe("pullRequest", () => {
  it("maps the author, the head, the base and the target branch, and nothing of the text", async () => {
    stub.on(PULL_PATH, { json: pullJson() });
    const pull = await giving(hostAt(stub).pullRequest());
    expect(pull).toEqual({
      number: 7,
      author: "dev",
      head: HEAD,
      base: BASE,
      targetRef: "refs/heads/main",
    });
  });

  it("accepts a head in a fork, and a head whose repository is gone", async () => {
    stub.on(PULL_PATH, {
      json: pullJson({ head: { ref: "feature", sha: HEAD, repo: null } }),
    });
    expect((await giving(hostAt(stub).pullRequest())).head).toBe(HEAD);
  });

  it("accepts another spelling of the repository's case in the base", async () => {
    stub.on(PULL_PATH, {
      json: pullJson({
        base: { ref: "main", sha: BASE, repo: { full_name: "Acme/Widgets" } },
      }),
    });
    await giving(hostAt(stub).pullRequest());
    // The path is spelled as the caller spelled the repository.
    stub.on("/repos/ACME/widgets/pulls/7", { json: pullJson() });
    await giving(hostAt(stub, { repository: "ACME/widgets" }).pullRequest());
  });

  it("folds ASCII letters only: a letter that merely looks alike names another repository", async () => {
    // U+212A, the Kelvin sign, becomes "k" in lower case.
    stub.on("/repos/acme/kit/pulls/7", {
      json: pullJson({
        base: { ref: "main", sha: BASE, repo: { full_name: "acme/\u212Ait" } },
      }),
    });
    const error = await failing(
      hostAt(stub, { repository: "acme/kit" }).pullRequest(),
    );
    expect(error.message).toBe(
      "github: GET /repos/acme/kit/pulls/7 answered 200 (the base is in another repository)",
    );
  });

  it("reports a target branch with several segments", async () => {
    stub.on(PULL_PATH, {
      json: pullJson({
        base: {
          ref: "release/1.x",
          sha: BASE,
          repo: { full_name: "acme/widgets" },
        },
      }),
    });
    expect((await giving(hostAt(stub).pullRequest())).targetRef).toBe(
      "refs/heads/release/1.x",
    );
  });

  it.each([
    [
      "a base in another repository",
      {
        base: { ref: "main", sha: BASE, repo: { full_name: "evil/widgets" } },
      },
      "the base is in another repository",
    ],
    [
      "a base in a repository that only starts like this one",
      {
        base: {
          ref: "main",
          sha: BASE,
          repo: { full_name: "acme/widgets-fork" },
        },
      },
      "the base is in another repository",
    ],
    [
      "a base without a repository",
      { base: { ref: "main", sha: BASE, repo: null } },
      "the base is in another repository",
    ],
    [
      "a base repository without a name",
      { base: { ref: "main", sha: BASE, repo: { id: 1 } } },
      "the base is in another repository",
    ],
    ["another number", { number: 8 }, "another pull request number"],
    ["a number as text", { number: "7" }, "another pull request number"],
    ["no user", { user: null }, "no author login"],
    ["a login that is no text", { user: { login: 7 } }, "no author login"],
    [
      "a login with a space",
      { user: { login: "dev eloper" } },
      "no author login",
    ],
    ["an empty login", { user: { login: "" } }, "no author login"],
    [
      "a short head id",
      { head: { sha: "abc1234", repo: null } },
      "no head commit",
    ],
    [
      "a head id in upper case",
      { head: { sha: "A".repeat(40), repo: null } },
      "no head commit",
    ],
    ["no head", { head: undefined }, "no head commit"],
    [
      "no base id",
      { base: { ref: "main", repo: { full_name: "acme/widgets" } } },
      "no base commit",
    ],
    [
      "a base branch with a parent segment",
      {
        base: {
          ref: "a/../main",
          sha: BASE,
          repo: { full_name: "acme/widgets" },
        },
      },
      "no base branch",
    ],
    [
      "a base branch with an empty segment",
      {
        base: {
          ref: "a//main",
          sha: BASE,
          repo: { full_name: "acme/widgets" },
        },
      },
      "no base branch",
    ],
    [
      "a base branch with a query",
      {
        base: {
          ref: "main?x=1",
          sha: BASE,
          repo: { full_name: "acme/widgets" },
        },
      },
      "no base branch",
    ],
    [
      "an empty base branch",
      { base: { ref: "", sha: BASE, repo: { full_name: "acme/widgets" } } },
      "no base branch",
    ],
    [
      "a base branch that is no text",
      { base: { ref: 7, sha: BASE, repo: { full_name: "acme/widgets" } } },
      "no base branch",
    ],
  ])("throws on %s", async (_what, over, reason) => {
    stub.on(PULL_PATH, { json: pullJson(over) });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`${AT} (${reason})`);
  });

  it.each([
    ["a list", []],
    ["null", null],
    ["a text", "pull request"],
    ["a number", 7],
  ])("throws on a body that is %s", async (_what, json) => {
    stub.on(PULL_PATH, { json });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`${AT} (not an object)`);
  });

  it("throws on a pull request the host does not have", async () => {
    stub.on(PULL_PATH, { status: 404, json: { message: "Not Found" } });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`github: GET ${PULL_PATH} answered 404`);
  });

  it("asks once per adapter and hands out a copy each time", async () => {
    stub.on(PULL_PATH, { json: pullJson() });
    const host = hostAt(stub);
    const first = await host.pullRequest();
    first.author = "someone-else";
    const second = await host.pullRequest();
    expect(second.author).toBe("dev");
    expect(second).not.toBe(first);
    expect(stub.hits).toHaveLength(1);
  });

  it("keeps a failure too: the same adapter does not ask again", async () => {
    stub.on(PULL_PATH, { status: 500 });
    const host = hostAt(stub);
    await failing(host.pullRequest());
    stub.on(PULL_PATH, { json: pullJson() });
    await failing(host.pullRequest());
    expect(stub.hits).toHaveLength(1);
    // A new adapter is a new view.
    await giving(hostAt(stub).pullRequest());
    expect(stub.hits).toHaveLength(2);
  });
});
