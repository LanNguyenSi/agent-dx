import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_PATHS, type ReviewPath } from "../../src/host/index.js";
import {
  BASE,
  failing,
  giving,
  hostAt,
  P,
  PROTECTION_PATH,
  protectionJson,
  PULL_PATH,
  pullJson,
  pullRequestRule,
  type Reply,
  RULES_PATH,
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
  stub.on(PULL_PATH, { json: pullJson() });
});

const DENIED = { message: "Resource not accessible by integration" };
const MISSING = { message: "Not Found" };

/** What the rules of rulesets answer, by name. */
const RULES: Record<string, Reply> = {
  "one approval": { json: [pullRequestRule(1)] },
  "two approvals": { json: [{ type: "deletion" }, pullRequestRule(2)] },
  "no rule": { json: [] },
  "other rules only": {
    json: [
      { type: "deletion" },
      { type: "required_linear_history" },
      { type: "update", parameters: { update_allows_fetch_and_merge: true } },
    ],
  },
  "a pull request rule without approvals": { json: [pullRequestRule(0)] },
  "code owners only": {
    json: [pullRequestRule(0, { require_code_owner_review: true })],
  },
  "a pull request rule without parameters": {
    json: [{ type: "pull_request" }],
  },
  "403": { status: 403, json: DENIED },
  "404": { status: 404, json: MISSING },
};

/** What the classic branch protection answers, by name. */
const PROTECTION: Record<string, Reply> = {
  "one approval": {
    json: protectionJson({ required_approving_review_count: 1 }),
  },
  "six approvals": {
    json: protectionJson({ required_approving_review_count: 6 }),
  },
  "no review settings": { json: protectionJson() },
  "review settings null": {
    json: { ...protectionJson(), required_pull_request_reviews: null },
  },
  "no approvals": {
    json: protectionJson({ required_approving_review_count: 0 }),
  },
  "no approval count": { json: protectionJson({}) },
  "code owners only": {
    json: protectionJson({
      required_approving_review_count: 0,
      require_code_owner_reviews: true,
    }),
  },
  "code owners without a count": {
    json: protectionJson({ require_code_owner_reviews: true }),
  },
  "403": { status: 403, json: DENIED },
  "404": { status: 404, json: { message: "Branch not protected" } },
  "404 not found": { status: 404, json: MISSING },
};

async function enforcement(
  rules: Reply,
  protection: Reply,
  path: ReviewPath = "specs/",
) {
  stub.on(RULES_PATH, rules);
  stub.on(PROTECTION_PATH, protection);
  return giving(hostAt(stub).reviewEnforcement(path));
}

describe("reviewEnforcement: the combinations of the two sources", () => {
  it.each([["one approval"], ["two approvals"]])(
    "rulesets with %s: enforced, and the classic protection is not asked",
    async (rules) => {
      expect(await enforcement(RULES[rules]!, PROTECTION["403"]!)).toBe(
        "enforced",
      );
      expect(stub.hitsOf(PROTECTION_PATH)).toEqual([]);
    },
  );

  it.each([
    ["no rule", "one approval", "enforced"],
    ["no rule", "six approvals", "enforced"],
    ["other rules only", "one approval", "enforced"],
    ["a pull request rule without approvals", "one approval", "enforced"],
    ["403", "one approval", "enforced"],
    ["404", "one approval", "enforced"],
    ["no rule", "no review settings", "not-enforced"],
    ["no rule", "review settings null", "not-enforced"],
    ["no rule", "no approvals", "not-enforced"],
    ["no rule", "no approval count", "not-enforced"],
    ["other rules only", "no review settings", "not-enforced"],
    ["a pull request rule without approvals", "no approvals", "not-enforced"],
    [
      "a pull request rule without parameters",
      "no review settings",
      "not-enforced",
    ],
    ["no rule", "403", "unknown"],
    ["no rule", "404", "unknown"],
    ["no rule", "404 not found", "unknown"],
    ["a pull request rule without approvals", "403", "unknown"],
    ["403", "no review settings", "unknown"],
    ["403", "no approvals", "unknown"],
    ["404", "no review settings", "unknown"],
    ["404", "no approvals", "unknown"],
    ["403", "403", "unknown"],
    ["403", "404", "unknown"],
    ["404", "403", "unknown"],
    ["404", "404", "unknown"],
  ])(
    "rulesets: %s, classic protection: %s gives %s",
    async (rules, protection, expected) => {
      expect(await enforcement(RULES[rules]!, PROTECTION[protection]!)).toBe(
        expected,
      );
      expect(stub.hitsOf(RULES_PATH)).toHaveLength(1);
      expect(stub.hitsOf(PROTECTION_PATH)).toHaveLength(1);
    },
  );

  it.each([
    ["code owners only", "code owners only"],
    ["code owners only", "code owners without a count"],
    ["code owners only", "no review settings"],
    ["no rule", "code owners only"],
    ["no rule", "code owners without a count"],
  ])(
    "a code-owner review alone is not an approving review (rulesets: %s, classic: %s): not-enforced",
    async (rules, protection) => {
      expect(await enforcement(RULES[rules]!, PROTECTION[protection]!)).toBe(
        "not-enforced",
      );
    },
  );

  it("code owners only in the rulesets and an unreadable classic protection: unknown, not enforced", async () => {
    expect(
      await enforcement(RULES["code owners only"]!, PROTECTION["403"]!),
    ).toBe("unknown");
  });
});

describe("reviewEnforcement: what it asks and keeps", () => {
  it("gives the same answer for both paths from one read", async () => {
    stub.on(RULES_PATH, RULES["no rule"]!);
    stub.on(PROTECTION_PATH, PROTECTION["one approval"]!);
    const host = hostAt(stub);
    for (const path of REVIEW_PATHS) {
      expect(await giving(host.reviewEnforcement(path))).toBe("enforced");
    }
    expect(stub.hits.map((hit) => hit.url)).toEqual([
      PULL_PATH,
      `${RULES_PATH}?per_page=100&page=1`,
      PROTECTION_PATH,
    ]);
  });

  it("asks for the branch the pull request targets, segments and all", async () => {
    stub.on(PULL_PATH, {
      json: pullJson({
        base: {
          ref: "release/1.x",
          sha: BASE,
          repo: { full_name: "acme/widgets" },
        },
      }),
    });
    stub.on(`${P}/rules/branches/release/1.x`, RULES["no rule"]!);
    stub.on(
      `${P}/branches/release/1.x/protection`,
      PROTECTION["one approval"]!,
    );
    expect(await giving(hostAt(stub).reviewEnforcement("specs/"))).toBe(
      "enforced",
    );
    expect(stub.hitsOf(RULES_PATH)).toEqual([]);
  });

  it("finds a pull request rule on a later page of the rules", async () => {
    const filler = Array.from({ length: 100 }, () => ({ type: "deletion" }));
    stub.on(`${RULES_PATH}?per_page=100&page=1`, {
      json: filler,
      headers: {
        link: `<${stub.url}${RULES_PATH}?per_page=100&page=2>; rel="next"`,
      },
    });
    stub.on(`${RULES_PATH}?per_page=100&page=2`, {
      json: [pullRequestRule(1)],
    });
    stub.on(PROTECTION_PATH, PROTECTION["403"]!);
    expect(await giving(hostAt(stub).reviewEnforcement("specs/"))).toBe(
      "enforced",
    );
    expect(stub.hitsOf(RULES_PATH)).toHaveLength(2);
  });

  it("rules that cannot be read on a later page are not read as none", async () => {
    stub.on(`${RULES_PATH}?per_page=100&page=1`, {
      json: [{ type: "deletion" }],
      headers: {
        link: `<${stub.url}${RULES_PATH}?per_page=100&page=2>; rel="next"`,
      },
    });
    stub.on(`${RULES_PATH}?per_page=100&page=2`, { status: 403, json: DENIED });
    stub.on(PROTECTION_PATH, PROTECTION["no review settings"]!);
    expect(await giving(hostAt(stub).reviewEnforcement("specs/"))).toBe(
      "unknown",
    );
  });

  it("throws for a path the check does not ask for, and asks the host nothing", async () => {
    const host = hostAt(stub);
    await expect(host.reviewEnforcement("src/" as ReviewPath)).rejects.toThrow(
      "github: reviewEnforcement was asked for another path",
    );
    expect(stub.hits).toEqual([]);
  });

  it("fails when the pull request cannot be read, and keeps the failure", async () => {
    stub.on(PULL_PATH, { status: 500 });
    const host = hostAt(stub);
    const error = await failing(host.reviewEnforcement("specs/"));
    expect(error.message).toBe(`github: GET ${PULL_PATH} answered 500`);
    await failing(host.reviewEnforcement(".spec-gate/"));
    expect(stub.hits).toHaveLength(1);
  });
});

describe("reviewEnforcement: answers it does not guess from", () => {
  it.each([
    ["a rule that is no object", ["pull_request"], "a rule is no object"],
    ["a rule without a type", [{ parameters: {} }], "a rule has no type"],
    [
      "a pull request rule whose parameters are no object",
      [{ type: "pull_request", parameters: "1" }],
      "a pull request rule has no review count",
    ],
    [
      "a pull request rule without a count",
      [{ type: "pull_request", parameters: {} }],
      "a pull request rule has no review count",
    ],
    [
      "a count as text",
      [pullRequestRule("1" as unknown as number)],
      "a pull request rule has no review count",
    ],
    [
      "a count that is no integer",
      [pullRequestRule(1.5)],
      "a pull request rule has no review count",
    ],
    ["a body that is no list", { rules: [] }, "not a list"],
  ])("throws on %s in the rules", async (_what, json, reason) => {
    stub.on(RULES_PATH, { json });
    stub.on(PROTECTION_PATH, PROTECTION["one approval"]!);
    const error = await failing(hostAt(stub).reviewEnforcement("specs/"));
    expect(error.message).toBe(
      `github: GET ${RULES_PATH} answered 200 (${reason})`,
    );
  });

  it.each([
    ["a body that is no object", [], "not an object"],
    [
      "review settings that are no object",
      { required_pull_request_reviews: true },
      "the review settings are no object",
    ],
    [
      "a count as text",
      {
        required_pull_request_reviews: { required_approving_review_count: "1" },
      },
      "the review count is no integer",
    ],
    [
      "a count that is no integer",
      {
        required_pull_request_reviews: { required_approving_review_count: 0.5 },
      },
      "the review count is no integer",
    ],
    [
      "a count that is null",
      {
        required_pull_request_reviews: {
          required_approving_review_count: null,
        },
      },
      "the review count is no integer",
    ],
  ])("throws on %s in the classic protection", async (_what, json, reason) => {
    stub.on(RULES_PATH, RULES["no rule"]!);
    stub.on(PROTECTION_PATH, { json });
    const error = await failing(hostAt(stub).reviewEnforcement("specs/"));
    expect(error.message).toBe(
      `github: GET ${PROTECTION_PATH} answered 200 (${reason})`,
    );
  });

  it.each([
    [403, { "x-ratelimit-remaining": "0" }],
    [403, { "retry-after": "60" }],
    [429, { "retry-after": "60" }],
    [429, { "x-ratelimit-remaining": "0" }],
  ])(
    "a rate limit (%d %j) on either source throws and is not read as a missing permission",
    async (status, headers) => {
      stub.on(RULES_PATH, RULES["no rule"]!);
      stub.on(PROTECTION_PATH, { status, headers, json: DENIED });
      const classic = await failing(hostAt(stub).reviewEnforcement("specs/"));
      expect(classic.message).toBe(
        `github: GET ${PROTECTION_PATH} answered ${status} (rate limited)`,
      );
      stub.on(RULES_PATH, { status, headers, json: DENIED });
      const rules = await failing(hostAt(stub).reviewEnforcement("specs/"));
      expect(rules.message).toBe(
        `github: GET ${RULES_PATH} answered ${status} (rate limited)`,
      );
    },
  );

  it.each([[401], [429], [500], [503]])(
    "status %d on either source throws",
    async (status) => {
      stub.on(RULES_PATH, RULES["no rule"]!);
      stub.on(PROTECTION_PATH, { status });
      const classic = await failing(hostAt(stub).reviewEnforcement("specs/"));
      expect(classic.message).toBe(
        `github: GET ${PROTECTION_PATH} answered ${status}`,
      );
      stub.on(RULES_PATH, { status });
      const rules = await failing(hostAt(stub).reviewEnforcement("specs/"));
      expect(rules.message).toBe(
        `github: GET ${RULES_PATH} answered ${status}`,
      );
    },
  );
});
