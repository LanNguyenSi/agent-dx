import { describe, expect, it } from "vitest";
import { readHostFacts } from "../../src/approve/index.js";
import type { HostAdapter } from "../../src/host/index.js";
import { hostFor, pullRequestOf, review, type Scenario } from "./helpers.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
/** No repository is read here: the facts are checked on their own. */
const S: Scenario = { dir: "", spec: "", c1: BASE, draft: BASE, head: HEAD };

const boom = () => {
  throw new Error("token=SECRET https://host.example/api");
};

describe("readHostFacts: a good host", () => {
  it("hands every fact on, the reviews with their time and position", async () => {
    const host = hostFor(S, {
      reviews: [
        review("alice", "APPROVED", HEAD, 1),
        {
          login: "bob",
          state: "COMMENTED",
          commit: BASE,
          submittedAt: "2024-05-01T12:00:00.250+02:00",
        },
      ],
      enforcement: { "specs/": "enforced", ".spec-gate/": "unknown" },
    });
    expect(await readHostFacts(host)).toEqual({
      pullRequest: {
        ok: true,
        value: {
          number: 7,
          author: "dev",
          head: HEAD,
          base: BASE,
          targetRef: "refs/heads/main",
        },
      },
      reviews: {
        ok: true,
        value: [
          {
            login: "alice",
            state: "APPROVED",
            commit: HEAD,
            submittedAt: "2024-05-01T10:01:00Z",
            at: Date.UTC(2024, 4, 1, 10, 1),
            index: 0,
          },
          {
            login: "bob",
            state: "COMMENTED",
            commit: BASE,
            submittedAt: "2024-05-01T12:00:00.250+02:00",
            at: Date.UTC(2024, 4, 1, 10, 0, 0, 250),
            index: 1,
          },
        ],
      },
      enforcement: {
        "specs/": { ok: true, value: "enforced" },
        ".spec-gate/": { ok: true, value: "unknown" },
      },
      configCommit: { ok: true, value: { commit: BASE, approver: "bob" } },
    });
  });

  it("asks in a fixed order and never for a CI run", async () => {
    const host = hostFor(S);
    await readHostFacts(host);
    expect(host.calls).toEqual([
      "pullRequest",
      "reviews",
      "reviewEnforcement specs/",
      "reviewEnforcement .spec-gate/",
      "lastConfigCommit",
    ]);
  });

  it("keeps only the fields of the type: an extra key of the host is dropped", async () => {
    const facts = await readHostFacts(
      hostFor(S, {
        pullRequest: pullRequestOf(S, { body: "digest: sha256:feed" }),
        configCommit: { commit: null, approver: null, note: "x" },
      }),
    );
    expect(facts.pullRequest).toEqual({
      ok: true,
      value: pullRequestOf(S),
    });
    expect(facts.configCommit).toEqual({
      ok: true,
      value: { commit: null, approver: null },
    });
  });

  it("an empty review list is a fact", async () => {
    const facts = await readHostFacts(hostFor(S, { reviews: [] }));
    expect(facts.reviews).toEqual({ ok: true, value: [] });
  });
});

describe("readHostFacts: a method that fails gives no fact", () => {
  it("a method that rejects", async () => {
    const facts = await readHostFacts(
      hostFor(S, {
        pullRequest: boom,
        reviews: boom,
        enforcement: boom,
        configCommit: boom,
      }),
    );
    expect(facts).toEqual({
      pullRequest: { ok: false },
      reviews: { ok: false },
      enforcement: { "specs/": { ok: false }, ".spec-gate/": { ok: false } },
      configCommit: { ok: false },
    });
    expect(JSON.stringify(facts)).not.toContain("SECRET");
  });

  it("a method that throws before it returns a promise, and a method that is missing", async () => {
    const good = hostFor(S);
    const host = {
      ...good,
      pullRequest: boom,
      reviews: undefined,
      reviewEnforcement: "enforced",
      lastConfigCommit: null,
    } as unknown as HostAdapter;
    expect(await readHostFacts(host)).toEqual({
      pullRequest: { ok: false },
      reviews: { ok: false },
      enforcement: { "specs/": { ok: false }, ".spec-gate/": { ok: false } },
      configCommit: { ok: false },
    });
  });

  it("a value whose fields throw when read", async () => {
    const trap = new Proxy(
      {},
      {
        get: boom,
        getOwnPropertyDescriptor: boom,
        has: boom,
        ownKeys: boom,
      },
    );
    const facts = await readHostFacts(
      hostFor(S, { pullRequest: trap, reviews: [trap], configCommit: trap }),
    );
    expect(facts.pullRequest).toEqual({ ok: false });
    expect(facts.reviews).toEqual({ ok: false });
    expect(facts.configCommit).toEqual({ ok: false });
  });

  it("one failed method leaves the facts of the others", async () => {
    const facts = await readHostFacts(
      hostFor(S, {
        reviews: boom,
        enforcement: { "specs/": "enforced", ".spec-gate/": boom },
      }),
    );
    expect(facts.pullRequest.ok).toBe(true);
    expect(facts.reviews).toEqual({ ok: false });
    expect(facts.enforcement).toEqual({
      "specs/": { ok: true, value: "enforced" },
      ".spec-gate/": { ok: false },
    });
    expect(facts.configCommit.ok).toBe(true);
  });
});

describe("readHostFacts: a value that is not of the type gives no fact", () => {
  it.each([
    ["null", null],
    ["a string", "pull request 7"],
    ["an array", [pullRequestOf(S)]],
    ["an array that carries the fields", Object.assign([], pullRequestOf(S))],
    ["no number", pullRequestOf(S, { number: undefined })],
    ["a number as text", pullRequestOf(S, { number: "7" })],
    ["the number 0", pullRequestOf(S, { number: 0 })],
    ["a fraction as number", pullRequestOf(S, { number: 1.5 })],
    ["no author", pullRequestOf(S, { author: undefined })],
    ["an empty author", pullRequestOf(S, { author: "" })],
    ["an author with a space", pullRequestOf(S, { author: "de v" })],
    ["a short head", pullRequestOf(S, { head: HEAD.slice(0, 12) })],
    ["an upper-case head", pullRequestOf(S, { head: HEAD.toUpperCase() })],
    ["a branch name as head", pullRequestOf(S, { head: "pr" })],
    ["no base", pullRequestOf(S, { base: undefined })],
    ["a ref name as base", pullRequestOf(S, { base: "refs/heads/main" })],
    ["a short target ref", pullRequestOf(S, { targetRef: "main" })],
    ["a tag as target ref", pullRequestOf(S, { targetRef: "refs/tags/v1" })],
    [
      "a target ref with a space",
      pullRequestOf(S, { targetRef: "refs/heads/ma in" }),
    ],
    [
      "fields that are inherited, not own",
      Object.create(pullRequestOf(S)) as unknown,
    ],
  ])("the pull request: %s", async (_what, value) => {
    const facts = await readHostFacts(hostFor(S, { pullRequest: value }));
    expect(facts.pullRequest).toEqual({ ok: false });
  });

  const good = review("alice", "APPROVED", HEAD, 1);
  it.each([
    ["null", null],
    ["an object", { 0: good, length: 1 }],
    ["an entry that is null", [good, null]],
    ["an entry that is a string", [good, "APPROVED"]],
    [
      "an entry that is an array carrying the fields",
      [Object.assign([], good)],
    ],
    ["a login with a line end", [{ ...good, login: "alice\nbob" }]],
    ["no login", [{ ...good, login: undefined }]],
    ["a state the check does not know", [{ ...good, state: "PENDING" }]],
    ["a lower-case state", [{ ...good, state: "approved" }]],
    ["a state from the prototype", [{ ...good, state: "toString" }]],
    ["no commit", [{ ...good, commit: null }]],
    ["a short commit", [{ ...good, commit: HEAD.slice(0, 7) }]],
    ["no time", [{ ...good, submittedAt: null }]],
    [
      "a time without a zone",
      [{ ...good, submittedAt: "2024-05-01T10:00:00" }],
    ],
    ["a date without a time", [{ ...good, submittedAt: "2024-05-01" }]],
    ["a time as number", [{ ...good, submittedAt: 1714557600000 }]],
    ["a month 13", [{ ...good, submittedAt: "2024-13-01T10:00:00Z" }]],
    ["31 February", [{ ...good, submittedAt: "2024-02-31T10:00:00Z" }]],
    [
      "30 February in a year that is no leap year",
      [{ ...good, submittedAt: "2023-02-30T10:00:00Z" }],
    ],
    [
      "29 February in a year that is no leap year",
      [{ ...good, submittedAt: "2023-02-29T10:00:00Z" }],
    ],
    ["the hour 24", [{ ...good, submittedAt: "2024-05-01T24:00:00Z" }]],
    ["the minute 60", [{ ...good, submittedAt: "2024-05-01T10:60:00Z" }]],
    ["a day 0", [{ ...good, submittedAt: "2024-05-00T10:00:00Z" }]],
    [
      "an offset that is no offset",
      [{ ...good, submittedAt: "2024-05-01T10:00:00+99:99" }],
    ],
    ["one bad entry after good ones", [good, good, { ...good, state: 1 }]],
  ])("the reviews: %s", async (_what, value) => {
    const facts = await readHostFacts(hostFor(S, { reviews: value }));
    expect(facts.reviews).toEqual({ ok: false });
  });

  it.each([
    ["null", null],
    ["true", true],
    ["upper case", "ENFORCED"],
    ["another word", "required"],
    ["a word from the prototype", "constructor"],
    ["the empty string", ""],
  ])("the enforcement: %s", async (_what, value) => {
    const facts = await readHostFacts(hostFor(S, { enforcement: () => value }));
    expect(facts.enforcement).toEqual({
      "specs/": { ok: false },
      ".spec-gate/": { ok: false },
    });
  });

  it.each([
    ["null", null],
    ["the word unknown", "unknown"],
    [
      "an array that carries the fields",
      Object.assign([], { commit: BASE, approver: "bob" }),
    ],
    ["no commit key", { approver: "bob" }],
    ["no approver key", { commit: BASE }],
    ["a short commit", { commit: BASE.slice(0, 7), approver: "bob" }],
    ["an approver with a space", { commit: BASE, approver: "b ob" }],
    ["an empty approver", { commit: BASE, approver: "" }],
  ])("the last config commit: %s", async (_what, value) => {
    const facts = await readHostFacts(hostFor(S, { configCommit: value }));
    expect(facts.configCommit).toEqual({ ok: false });
  });

  it("the last config commit: unknown is null, for either field alone too", async () => {
    for (const value of [
      { commit: null, approver: null },
      { commit: BASE, approver: null },
      { commit: null, approver: "bob" },
    ]) {
      const facts = await readHostFacts(hostFor(S, { configCommit: value }));
      expect(facts.configCommit).toEqual({ ok: true, value });
    }
  });

  it("a leap day is a day, and the instant is the one written, offset and fraction included", async () => {
    const facts = await readHostFacts(
      hostFor(S, {
        reviews: [
          { ...good, submittedAt: "2024-02-29T10:00:00Z" },
          { ...good, submittedAt: "2024-02-29T23:59:59.5-01:00" },
          { ...good, submittedAt: "2024-12-31T23:59:59Z" },
        ],
      }),
    );
    expect(facts.reviews.ok && facts.reviews.value.map((r) => r.at)).toEqual([
      Date.UTC(2024, 1, 29, 10),
      Date.UTC(2024, 2, 1, 0, 59, 59, 500),
      Date.UTC(2024, 11, 31, 23, 59, 59),
    ]);
  });

  it("a review dated on a day that does not exist does not move in the order: the list is no fact", async () => {
    // Rolled over, 31 February would land after the request for changes of
    // 29 February and stand as the latest review.
    const facts = await readHostFacts(
      hostFor(S, {
        reviews: [
          {
            ...good,
            state: "CHANGES_REQUESTED",
            submittedAt: "2024-02-29T10:00:00Z",
          },
          { ...good, submittedAt: "2024-02-31T10:00:00Z" },
        ],
      }),
    );
    expect(facts.reviews).toEqual({ ok: false });
  });

  it("a SHA-256 commit id is a commit id", async () => {
    const long = "c".repeat(64);
    const facts = await readHostFacts(
      hostFor(S, {
        pullRequest: pullRequestOf(S, { head: long }),
        reviews: [review("alice", "APPROVED", long)],
      }),
    );
    expect(facts.pullRequest.ok).toBe(true);
    expect(facts.reviews.ok).toBe(true);
  });
});
