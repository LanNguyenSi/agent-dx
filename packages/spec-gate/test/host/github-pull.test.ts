import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { conjunctIds } from "./conjunct-mutants.js";
import {
  BASE,
  failing,
  FORBIDDEN_CHARACTERS,
  giving,
  HEAD,
  hostAt,
  PULL_PATH,
  pullJson,
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
      merged: false,
      mergeCommit: null,
    });
  });

  it("reports a merged pull request with the commit the merge put on the target branch", async () => {
    stub.on(PULL_PATH, { json: pullJson(mergedAt(MERGE)) });
    const pull = await giving(hostAt(stub).pullRequest());
    expect(pull).toEqual({
      number: 7,
      author: "dev",
      head: HEAD,
      base: BASE,
      targetRef: "refs/heads/main",
      merged: true,
      mergeCommit: MERGE,
    });
  });

  it("never reports the trial merge of an open pull request as a merge commit, closed or not", async () => {
    for (const state of ["open", "closed"]) {
      stub.on(PULL_PATH, {
        json: pullJson({ state, merged: false, merge_commit_sha: MERGE }),
      });
      const pull = await giving(hostAt(stub).pullRequest());
      expect(pull).toMatchObject({ merged: false, mergeCommit: null });
    }
  });

  it("does not take a merge time or a closed state for the word of the host that it is merged", async () => {
    stub.on(PULL_PATH, {
      json: pullJson({
        state: "closed",
        merged: false,
        merged_at: "2024-05-01T11:00:00Z",
        merge_commit_sha: MERGE,
      }),
    });
    const pull = await giving(hostAt(stub).pullRequest());
    expect(pull).toMatchObject({ merged: false, mergeCommit: null });
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
    ["no merged state", { merged: undefined }, "no merged state"],
    ["a merged state that is null", { merged: null }, "no merged state"],
    [
      "a merged state as text",
      { merged: "true", merge_commit_sha: sha("c") },
      "no merged state",
    ],
    [
      "a merged state as a number",
      { merged: 1, merge_commit_sha: sha("c") },
      "no merged state",
    ],
    [
      "a merged pull request without a merge commit",
      { merged: true, merge_commit_sha: null },
      "no merge commit",
    ],
    [
      "a merged pull request whose merge commit is left out",
      { merged: true, merge_commit_sha: undefined },
      "no merge commit",
    ],
    [
      "a merged pull request with a short merge commit id",
      { merged: true, merge_commit_sha: "ccccccc" },
      "no merge commit",
    ],
    [
      "a merged pull request with a merge commit id in upper case",
      { merged: true, merge_commit_sha: "C".repeat(40) },
      "no merge commit",
    ],
    [
      "a merged pull request whose merge commit is a list",
      { merged: true, merge_commit_sha: [sha("c")] },
      "no merge commit",
    ],
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
      "a short base id",
      {
        base: {
          ref: "main",
          sha: "bbbbbbb",
          repo: { full_name: "acme/widgets" },
        },
      },
      "no base commit",
    ],
    [
      "a base id in upper case",
      {
        base: {
          ref: "main",
          sha: "B".repeat(40),
          repo: { full_name: "acme/widgets" },
        },
      },
      "no base commit",
    ],
    ...[
      ["an encoded slash", "a%2fb"],
      ["a number sign", "main#x"],
      ["a space", "a b"],
      ["a backslash", "a\\b"],
      ["a reflog selector", "a@{b"],
      ["an at sign", "a@b"],
      ["a colon", "a:b"],
      ["a tilde", "main~1"],
      ["a caret", "main^"],
    ].map(
      ([what, ref]) =>
        [
          `a base branch with ${what}`,
          { base: { ref, sha: BASE, repo: { full_name: "acme/widgets" } } },
          "no base branch",
        ] as [string, Record<string, unknown>, string],
    ),
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

/** The base of the pull request with one field changed. */
const base = (over: Record<string, unknown>) => ({
  base: { ref: "main", sha: BASE, repo: { full_name: REPOSITORY }, ...over },
});
/** The head of the pull request with another commit id. */
const head = (id: unknown) => ({
  head: { ref: "feature", sha: id, repo: null },
});
/** The commit a merge put on the target branch. */
const MERGE = sha("c");
/** The fields of a merged pull request whose merge commit is `id`. */
function mergedAt(id: unknown): Record<string, unknown> {
  return {
    state: "closed",
    merged: true,
    merged_at: "2024-05-01T11:00:00Z",
    merge_commit_sha: id,
  };
}
const HEX39 = "a".repeat(39);

interface PullRow {
  /** The repository and the number the adapter is made for, when not acme/widgets and 7. */
  repository?: string;
  number?: number;
  /** Fields of the answer that differ from a well-formed pull request, or the whole body. */
  over?: Record<string, unknown>;
  body?: unknown;
  /** Ask twice, and change the first result in between. */
  twice?: true;
  /** Fields of the result, or the reason of the error. */
  expect: Record<string, unknown> | { error: string };
}

/**
 * Every conjunct of reading the pull request: the answer, the form of a
 * commit id and of a branch name, what counts as an object. One row each;
 * the row of an id fails when the change of that id in
 * `conjunct-mutants.ts` is made to the source.
 */
const CONJUNCTS: {
  id: string;
  function: string;
  conjunct: string;
  row: PullRow;
}[] = [
  {
    id: "C-PUL-01",
    function: "readPullRequest",
    conjunct: "the pull request asked for is the one the adapter was made for",
    row: { number: 9, expect: { number: 9 } },
  },
  {
    id: "C-PUL-02",
    function: "readPullRequest",
    conjunct: "a body that is a list is no pull request, even with one in it",
    row: { body: [pullJson()], expect: { error: "not an object" } },
  },
  {
    id: "C-PUL-03",
    function: "readPullRequest",
    conjunct: "a user that is no object has no login",
    row: { over: { user: "dev" }, expect: { error: "no author login" } },
  },
  {
    id: "C-PUL-04",
    function: "readPullRequest",
    conjunct: "a head that is no object has no commit",
    row: { over: { head: HEAD }, expect: { error: "no head commit" } },
  },
  {
    id: "C-PUL-05",
    function: "readPullRequest",
    conjunct: "a base that is no object has no commit",
    row: { over: { base: BASE }, expect: { error: "no base commit" } },
  },
  {
    id: "C-PUL-06",
    function: "readPullRequest",
    conjunct: "an answer with another number is not the pull request",
    row: {
      over: { number: 8 },
      expect: { error: "another pull request number" },
    },
  },
  {
    id: "C-PUL-07",
    function: "readPullRequest",
    conjunct: "the author must have the form of a login",
    row: {
      over: { user: { login: "dev eloper" } },
      expect: { error: "no author login" },
    },
  },
  {
    id: "C-PUL-08",
    function: "readPullRequest",
    conjunct: "the head must be a full commit id",
    row: { over: head("abc1234"), expect: { error: "no head commit" } },
  },
  {
    id: "C-PUL-09",
    function: "readPullRequest",
    conjunct: "the base must be a full commit id",
    row: {
      over: base({ sha: "bbbbbbb" }),
      expect: { error: "no base commit" },
    },
  },
  {
    id: "C-PUL-10",
    function: "readPullRequest",
    conjunct: "the target must have the form of a branch name",
    row: { over: base({ ref: "a b" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-PUL-11",
    function: "readPullRequest",
    conjunct: "a base without a repository is not in this repository",
    row: {
      over: base({ repo: null }),
      expect: { error: "the base is in another repository" },
    },
  },
  {
    id: "C-PUL-12",
    function: "readPullRequest",
    conjunct: "a base in another repository is an error",
    row: {
      over: base({ repo: { full_name: "evil/widgets" } }),
      expect: { error: "the base is in another repository" },
    },
  },
  {
    id: "C-PUL-13",
    function: "sameRepository",
    conjunct:
      "a repository name that is no text is another repository, not a crash",
    row: {
      over: base({ repo: { full_name: 7 } }),
      expect: { error: "the base is in another repository" },
    },
  },
  {
    id: "C-PUL-14",
    function: "sameRepository",
    conjunct: "the repository of the base may be spelled in another case",
    row: {
      over: base({ repo: { full_name: "Acme/Widgets" } }),
      expect: { author: "dev" },
    },
  },
  {
    id: "C-PUL-15",
    function: "asciiLower",
    conjunct:
      "only ASCII letters are folded: a letter that merely looks alike is another name",
    row: {
      repository: "acme/kit",
      over: base({ repo: { full_name: "acme/Kit" } }),
      expect: { error: "the base is in another repository" },
    },
  },
  {
    id: "C-PUL-16",
    function: "createGitHubHost",
    conjunct:
      "the repository the adapter was made for may be spelled in another case",
    row: { repository: "ACME/Widgets", expect: { author: "dev" } },
  },
  {
    id: "C-PUL-17",
    function: "readPullRequest",
    conjunct: "the target is reported as the full name of the branch",
    row: { expect: { targetRef: "refs/heads/main" } },
  },
  {
    id: "C-PUL-18",
    function: "readPullRequest",
    conjunct: "the head is the head commit, not the base",
    row: { expect: { head: HEAD } },
  },
  {
    id: "C-PUL-19",
    function: "readPullRequest",
    conjunct: "the base is the base commit, not the head",
    row: { expect: { base: BASE } },
  },
  {
    id: "C-PUL-20",
    function: "pullRequestOnce",
    conjunct: "the pull request is asked for once per adapter",
    row: { twice: true, expect: { number: 7 } },
  },
  {
    id: "C-PUL-21",
    function: "pullRequest",
    conjunct:
      "a caller gets a copy: changing it does not change the next answer",
    row: { twice: true, expect: { author: "dev" } },
  },
  {
    id: "C-PUL-22",
    function: "createGitHubHost",
    conjunct: "requests spell the repository as the caller did",
    row: { repository: "ACME/Widgets", expect: { number: 7 } },
  },
  {
    id: "C-REC-01",
    function: "isRecord",
    conjunct: "a list is no object",
    row: { body: [], expect: { error: "not an object" } },
  },
  {
    id: "C-REC-02",
    function: "isRecord",
    conjunct: "null is no object",
    row: { body: null, expect: { error: "not an object" } },
  },
  {
    id: "C-REC-03",
    function: "isRecord",
    conjunct: "a text is no object",
    row: { body: "pull request", expect: { error: "not an object" } },
  },
  {
    id: "C-BRN-01",
    function: "isBranch",
    conjunct: "a branch name holds only the characters of the pattern",
    row: { over: base({ ref: "main#x" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-02",
    function: "isBranch",
    conjunct: "the first segment is checked",
    row: { over: base({ ref: "../x" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-03",
    function: "isBranch",
    conjunct: "the last segment is checked",
    row: { over: base({ ref: "x/.." }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-04",
    function: "isBranch",
    conjunct: "a segment between the first and the last is checked",
    row: { over: base({ ref: "a/../b" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-05",
    function: "isBranch",
    conjunct: "every segment must pass, one good segment is not enough",
    row: { over: base({ ref: ".x/y" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-06",
    function: "isBranch",
    conjunct: "an empty first segment is refused",
    row: { over: base({ ref: "/x" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-07",
    function: "isBranch",
    conjunct: "an empty last segment is refused",
    row: { over: base({ ref: "x/" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-08",
    function: "isBranch",
    conjunct: "an empty segment in the middle is refused",
    row: { over: base({ ref: "a//b" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-09",
    function: "isBranch",
    conjunct: "a parent segment is refused",
    row: { over: base({ ref: ".." }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-10",
    function: "isBranch",
    conjunct:
      "a segment that starts with a dot is refused, not only the parent segment",
    row: {
      over: base({ ref: ".hidden/x" }),
      expect: { error: "no base branch" },
    },
  },
  {
    id: "C-BRN-11",
    function: "isBranch",
    conjunct: "a segment that is one dot is refused",
    row: { over: base({ ref: "a/./b" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-12",
    function: "isBranch",
    conjunct: "a percent sign is no character of a branch name",
    row: { over: base({ ref: "a%2fb" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-13",
    function: "isBranch",
    conjunct: "nothing stands before the name",
    row: { over: base({ ref: " main" }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-14",
    function: "isBranch",
    conjunct: "nothing follows the name",
    row: { over: base({ ref: "main " }), expect: { error: "no base branch" } },
  },
  {
    id: "C-BRN-15",
    function: "isBranch",
    conjunct: "a branch that is no text is no branch, not a crash",
    row: { over: base({ ref: 7 }), expect: { error: "no base branch" } },
  },
  {
    id: "C-CMT-01",
    function: "isCommitId",
    conjunct: "a commit id is a text: a list that prints like one is none",
    row: { over: head([HEAD]), expect: { error: "no head commit" } },
  },
  {
    id: "C-CMT-02",
    function: "isCommitId",
    conjunct: "39 digits are no commit id",
    row: { over: head(HEX39), expect: { error: "no head commit" } },
  },
  {
    id: "C-CMT-03",
    function: "isCommitId",
    conjunct: "41 digits are no commit id",
    row: { over: head(`${HEX39}aa`), expect: { error: "no head commit" } },
  },
  {
    id: "C-CMT-04",
    function: "isCommitId",
    conjunct: "64 digits are a commit id",
    row: { over: head("a".repeat(64)), expect: { head: "a".repeat(64) } },
  },
  {
    id: "C-CMT-05",
    function: "isCommitId",
    conjunct: "upper case digits are no commit id",
    row: { over: head(sha("A")), expect: { error: "no head commit" } },
  },
  {
    id: "C-CMT-06",
    function: "isCommitId",
    conjunct: "nothing stands before the digits",
    row: { over: head(`x${HEAD}`), expect: { error: "no head commit" } },
  },
  {
    id: "C-CMT-07",
    function: "isCommitId",
    conjunct: "nothing follows the digits",
    row: { over: head(`${HEAD}x`), expect: { error: "no head commit" } },
  },
  {
    id: "C-CMT-08",
    function: "isCommitId",
    conjunct: "a letter past f is no digit",
    row: { over: head(`${HEX39}g`), expect: { error: "no head commit" } },
  },
  {
    id: "C-PUL-23",
    function: "readPullRequest",
    conjunct: "a base that is null has no branch, and that is no crash",
    row: { over: { base: null }, expect: { error: "no base commit" } },
  },
  {
    id: "C-PUL-24",
    function: "readPullRequest",
    conjunct:
      "a base repository that is null is another repository, and that is no crash",
    row: {
      over: { base: { ref: "main", sha: BASE, repo: null } },
      expect: { error: "the base is in another repository" },
    },
  },
  {
    id: "C-PUL-25",
    function: "readPullRequest",
    conjunct: "an author that is null has no login, and that is no crash",
    row: { over: { user: null }, expect: { error: "no author login" } },
  },
  {
    id: "C-PUL-26",
    function: "readPullRequest",
    conjunct: "a head that is null has no commit, and that is no crash",
    row: { over: { head: null }, expect: { error: "no head commit" } },
  },
  {
    id: "C-PUL-27",
    function: "readPullRequest",
    conjunct: "a base that is null has no commit, and that is no crash",
    row: { over: { base: null }, expect: { error: "no base commit" } },
  },
  {
    id: "C-PUL-28",
    function: "readPullRequest",
    conjunct: "a base that is null has no repository, and that is no crash",
    row: { over: { base: null }, expect: { error: "no base commit" } },
  },
  {
    id: "C-CMT-09",
    function: "isCommitId",
    conjunct: "a text that is no commit id is no commit id",
    row: {
      over: { head: { sha: "main" } },
      expect: { error: "no head commit" },
    },
  },
  {
    id: "C-PUL-29",
    function: "readPullRequest",
    conjunct:
      "an answer without a merged state is an error, not an open pull request",
    row: {
      over: { merged: undefined },
      expect: { error: "no merged state" },
    },
  },
  {
    id: "C-PUL-30",
    function: "readPullRequest",
    conjunct: "a merged state that only reads as true is none",
    row: {
      over: { ...mergedAt(MERGE), merged: 1 },
      expect: { error: "no merged state" },
    },
  },
  {
    id: "C-PUL-31",
    function: "readPullRequest",
    conjunct:
      "the merge commit is read for a merged pull request only: the trial merge of an open one is not reported",
    row: {
      over: { merged: false, merge_commit_sha: MERGE },
      expect: { merged: false, mergeCommit: null },
    },
  },
  {
    id: "C-PUL-32",
    function: "readPullRequest",
    conjunct: "a merged pull request reports its merge commit",
    row: {
      over: mergedAt(MERGE),
      expect: { merged: true, mergeCommit: MERGE },
    },
  },
  {
    id: "C-PUL-33",
    function: "readPullRequest",
    conjunct: "the merge commit must be a full commit id",
    row: {
      over: mergedAt("ccccccc"),
      expect: { error: "no merge commit" },
    },
  },
  {
    id: "C-PUL-34",
    function: "readPullRequest",
    conjunct: "a merged pull request without a merge commit is an error",
    row: { over: mergedAt(null), expect: { error: "no merge commit" } },
  },
  {
    id: "C-PUL-35",
    function: "readPullRequest",
    conjunct:
      "merged is what the host says: an open pull request is not merged",
    row: { expect: { merged: false } },
  },
  {
    id: "C-PUL-36",
    function: "readPullRequest",
    conjunct: "the merge commit is the merge commit, not the head",
    row: { over: mergedAt(MERGE), expect: { mergeCommit: MERGE } },
  },
  {
    id: "C-PUL-37",
    function: "readPullRequest",
    conjunct: "merged is the host's own word, not a merge time that is set",
    row: {
      over: { merged: false, merged_at: "2024-05-01T11:00:00Z" },
      expect: { merged: false, mergeCommit: null },
    },
  },
  {
    id: "C-PUL-38",
    function: "readPullRequest",
    conjunct: "the merge commit is read from the field of that name",
    row: { over: mergedAt(MERGE), expect: { mergeCommit: MERGE } },
  },
];

describe("CONJUNCTS: reading the pull request", () => {
  it("the table and the list of changes name the same conjuncts, each once", () => {
    const ids = CONJUNCTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(conjunctIds("github-pull"));
  });

  it.each(
    CONJUNCTS.map((entry) => [entry.id, entry.conjunct, entry.row] as const),
  )("%s: %s", async (_id, _conjunct, row) => {
    const repository = row.repository ?? REPOSITORY;
    const number = row.number ?? 7;
    const path = `/repos/${repository}/pulls/${number}`;
    stub.on(path, {
      json: "body" in row ? row.body : pullJson({ number, ...row.over }),
    });
    const host = hostAt(stub, { repository, pullRequest: number });
    if ("error" in row.expect) {
      const error = await failing(host.pullRequest());
      expect(error.message).toBe(
        `github: GET ${path} answered 200 (${String(row.expect.error)})`,
      );
    } else {
      let pull = await giving(host.pullRequest());
      if (row.twice === true) {
        pull.author = "someone-else";
        pull = await giving(host.pullRequest());
      }
      expect(pull).toMatchObject(row.expect);
    }
    expect(stub.hits.map((hit) => hit.url)).toEqual([path]);
  });

  // The characters a branch name, a commit id and a login may not hold, one
  // row each: a pattern that lets one of them in fails its row.
  const FORBIDDEN = FORBIDDEN_CHARACTERS;

  it.each(FORBIDDEN)("a branch name with %j in it is refused", async (char) => {
    stub.on(PULL_PATH, { json: pullJson(base({ ref: `a${char}b` })) });
    const error = await failing(hostAt(stub).pullRequest());
    expect(error.message).toBe(`${AT} (no base branch)`);
  });

  it.each([...FORBIDDEN, ".", "_", "+", "/", "-", "g", "A"])(
    "a commit id with %j in it is refused",
    async (char) => {
      stub.on(PULL_PATH, { json: pullJson(head(`${HEX39}${char}`)) });
      const error = await failing(hostAt(stub).pullRequest());
      expect(error.message).toBe(`${AT} (no head commit)`);
      stub.on(PULL_PATH, { json: pullJson(head(`${char}${HEX39}`)) });
      const front = await failing(hostAt(stub).pullRequest());
      expect(front.message).toBe(`${AT} (no head commit)`);
    },
  );

  it.each([...FORBIDDEN, ".", "_", "+", "/", "-", "g", "A"])(
    "a long commit id with %j in its second part is refused",
    async (char) => {
      for (const id of [
        `${"a".repeat(40)}${char}${"a".repeat(23)}`,
        `${"a".repeat(63)}${char}`,
      ]) {
        stub.on(PULL_PATH, { json: pullJson(head(id)) });
        const error = await failing(hostAt(stub).pullRequest());
        expect(error.message).toBe(`${AT} (no head commit)`);
      }
    },
  );
});
