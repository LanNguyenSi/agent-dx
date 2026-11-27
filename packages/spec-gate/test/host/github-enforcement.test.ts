import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_PATHS, type ReviewPath } from "../../src/host/index.js";
import { conjunctIds } from "./conjunct-mutants.js";
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

  it("throws on rules that go on past the page cap, instead of reading them as not readable", async () => {
    stub.on(RULES_PATH, (hit) => {
      const n = Number(new URL(hit.url, stub.url).searchParams.get("page"));
      return {
        json: [{ type: "deletion" }],
        headers: {
          link: `<${stub.url}${RULES_PATH}?per_page=100&page=${n + 1}>; rel="next"`,
        },
      };
    });
    stub.on(PROTECTION_PATH, PROTECTION["no review settings"]!);
    const error = await failing(hostAt(stub).reviewEnforcement("specs/"));
    expect(error.message).toBe(
      `github: GET ${RULES_PATH} answered 200 (more pages than the page cap)`,
    );
    expect(stub.hitsOf(PROTECTION_PATH)).toEqual([]);
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

/** A rule that is no pull request rule, and a pull request rule without parameters. */
const OTHER = { type: "deletion" };
const BARE = { type: "pull_request" };
const REQUIRING = pullRequestRule(1);
/** What the classic protection can answer. */
const PROTECTED = {
  json: protectionJson({ required_approving_review_count: 1 }),
};
const UNPROTECTED = { json: protectionJson() };
const settings = (reviews: unknown): Reply => ({
  json: { ...protectionJson(), required_pull_request_reviews: reviews },
});
const COUNT = "a pull request rule has no review count";

interface EnforcementRow {
  /** The target branch of the pull request; main when left out. */
  branch?: string;
  /** The rules of that branch: a list, or the status the host answers with. */
  rules: unknown[] | number;
  /** The classic protection of that branch; no route when left out. */
  protection?: Reply;
  /** The paths asked for, in order; `specs/` when left out. */
  paths?: string[];
  /** The answer for every path, the reason of an error, or the refusal. */
  expect:
    | "enforced"
    | "not-enforced"
    | "unknown"
    | { error: string }
    | { refused: string };
  /** Whether the classic protection is asked at all. */
  protectionAsked?: boolean;
  /** How often the rules are asked for. */
  rulesAsked?: number;
}

/**
 * Every conjunct of the review enforcement: the rules of rulesets, the
 * classic protection and how the two combine. One row each; the row of an
 * id fails when the change of that id in `conjunct-mutants.ts` is made to
 * the source.
 */
const CONJUNCTS: {
  id: string;
  function: string;
  conjunct: string;
  row: EnforcementRow;
}[] = [
  {
    id: "C-RUL-01",
    function: "rulesetEvidence",
    conjunct: "rules that answer 403 are not readable, not an error",
    row: { rules: 403, protection: PROTECTED, expect: "enforced" },
  },
  {
    id: "C-RUL-02",
    function: "rulesetEvidence",
    conjunct: "rules that answer 404 are not readable, not an error",
    row: { rules: 404, protection: PROTECTED, expect: "enforced" },
  },
  {
    id: "C-RUL-03",
    function: "rulesetEvidence",
    conjunct: "rules that answer 401 are an error, not 'not readable'",
    row: {
      rules: 401,
      protection: PROTECTED,
      expect: { error: `github: GET ${RULES_PATH} answered 401` },
    },
  },
  {
    id: "C-RUL-04",
    function: "rulesetEvidence",
    conjunct: "rules that are not readable are not read as 'no rule'",
    row: { rules: 403, protection: UNPROTECTED, expect: "unknown" },
  },
  {
    id: "C-RUL-05",
    function: "rulesetEvidence",
    conjunct: "rules that are not readable prove nothing",
    row: { rules: 404, protection: UNPROTECTED, expect: "unknown" },
  },
  {
    id: "C-RUL-06",
    function: "rulesetEvidence",
    conjunct: "no rule at all requires nothing",
    row: { rules: [], protection: UNPROTECTED, expect: "not-enforced" },
  },
  {
    id: "C-RUL-07",
    function: "rulesetEvidence",
    conjunct: "a requiring rule is found when it is the last rule",
    row: {
      rules: [OTHER, REQUIRING],
      protection: { status: 403 },
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-08",
    function: "rulesetEvidence",
    conjunct: "a requiring rule is found when it is the first rule",
    row: {
      rules: [REQUIRING, OTHER],
      protection: { status: 403 },
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-09",
    function: "rulesetEvidence",
    conjunct: "a requiring rule is found between other rules",
    row: {
      rules: [OTHER, REQUIRING, OTHER],
      protection: { status: 403 },
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-10",
    function: "rulesetEvidence",
    conjunct:
      "a rule that is no object after a requiring rule is an error, not skipped",
    row: {
      rules: [REQUIRING, "pull_request"],
      expect: {
        error: `github: GET ${RULES_PATH} answered 200 (a rule is no object)`,
      },
    },
  },
  {
    id: "C-RUL-11",
    function: "rulesetEvidence",
    conjunct:
      "a rule without a type after a requiring rule is an error, not skipped",
    row: {
      rules: [REQUIRING, { parameters: {} }],
      expect: {
        error: `github: GET ${RULES_PATH} answered 200 (a rule has no type)`,
      },
    },
  },
  {
    id: "C-RUL-12",
    function: "rulesetEvidence",
    conjunct:
      "a rule of another type does not count, whatever its parameters say",
    row: {
      rules: [
        {
          type: "merge_queue",
          parameters: { required_approving_review_count: 1 },
        },
      ],
      protection: UNPROTECTED,
      expect: "not-enforced",
    },
  },
  {
    id: "C-RUL-13",
    function: "rulesetEvidence",
    conjunct:
      "a rule of another type before a requiring rule is skipped: the search goes on",
    row: {
      rules: [OTHER, OTHER, REQUIRING],
      protection: UNPROTECTED,
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-14",
    function: "rulesetEvidence",
    conjunct: "the type of a rule is compared with its case",
    row: {
      rules: [{ ...REQUIRING, type: "PULL_REQUEST" }],
      protection: UNPROTECTED,
      expect: "not-enforced",
    },
  },
  {
    id: "C-RUL-15",
    function: "rulesetEvidence",
    conjunct:
      "a pull request rule without parameters requires nothing and is no error",
    row: { rules: [BARE], protection: UNPROTECTED, expect: "not-enforced" },
  },
  {
    id: "C-RUL-16",
    function: "rulesetEvidence",
    conjunct:
      "a pull request rule without parameters before a requiring rule is skipped: the search goes on",
    row: {
      rules: [BARE, REQUIRING],
      protection: { status: 403 },
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-17",
    function: "rulesetEvidence",
    conjunct: "parameters that are no object have no review count",
    row: {
      rules: [{ type: "pull_request", parameters: "1" }],
      protection: UNPROTECTED,
      expect: { error: `github: GET ${RULES_PATH} answered 200 (${COUNT})` },
    },
  },
  {
    id: "C-RUL-18",
    function: "rulesetEvidence",
    conjunct: "a review count that is no integer is an error",
    row: {
      rules: [pullRequestRule(1.5)],
      protection: UNPROTECTED,
      expect: { error: `github: GET ${RULES_PATH} answered 200 (${COUNT})` },
    },
  },
  {
    id: "C-RUL-19",
    function: "rulesetEvidence",
    conjunct: "a review count of 0 requires nothing",
    row: {
      rules: [pullRequestRule(0)],
      protection: UNPROTECTED,
      expect: "not-enforced",
    },
  },
  {
    id: "C-RUL-20",
    function: "rulesetEvidence",
    conjunct: "a review count of 1 requires a review",
    row: {
      rules: [pullRequestRule(1)],
      protection: { status: 403 },
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-21",
    function: "rulesetEvidence",
    conjunct: "a later rule with count 0 does not take a requiring rule back",
    row: {
      rules: [REQUIRING, pullRequestRule(0)],
      protection: { status: 403 },
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-22",
    function: "rulesetEvidence",
    conjunct:
      "the rules after a requiring rule are still read: an unreadable one is an error",
    row: {
      rules: [REQUIRING, pullRequestRule("1" as unknown as number)],
      expect: { error: `github: GET ${RULES_PATH} answered 200 (${COUNT})` },
    },
  },
  {
    id: "C-RUL-23",
    function: "rulesetEvidence",
    conjunct: "a requiring rule is evidence, and no requiring rule is none",
    row: {
      rules: [pullRequestRule(2)],
      expect: "enforced",
      protectionAsked: false,
    },
  },
  {
    id: "C-RUL-24",
    function: "rulesetEvidence",
    conjunct: "the rules asked for are those of the target branch",
    row: { branch: "release/1.x", rules: [REQUIRING], expect: "enforced" },
  },
  {
    id: "C-PRT-01",
    function: "protectionEvidence",
    conjunct: "a protection that answers 403 is not readable, not an error",
    row: { rules: [], protection: { status: 403 }, expect: "unknown" },
  },
  {
    id: "C-PRT-02",
    function: "protectionEvidence",
    conjunct: "a protection that answers 404 is not readable, not an error",
    row: { rules: [], protection: { status: 404 }, expect: "unknown" },
  },
  {
    id: "C-PRT-03",
    function: "protectionEvidence",
    conjunct: "a protection that answers 401 is an error, not 'not readable'",
    row: {
      rules: [],
      protection: { status: 401 },
      expect: { error: `github: GET ${PROTECTION_PATH} answered 401` },
    },
  },
  {
    id: "C-PRT-04",
    function: "protectionEvidence",
    conjunct:
      "a protection that is not readable is not read as 'no requirement'",
    row: { rules: [OTHER], protection: { status: 404 }, expect: "unknown" },
  },
  {
    id: "C-PRT-05",
    function: "protectionEvidence",
    conjunct: "a protection that is not readable proves nothing",
    row: { rules: [OTHER], protection: { status: 403 }, expect: "unknown" },
  },
  {
    id: "C-PRT-06",
    function: "protectionEvidence",
    conjunct:
      "a protection that is no object is an error, not 'no requirement'",
    row: {
      rules: [],
      protection: { json: [] },
      expect: {
        error: `github: GET ${PROTECTION_PATH} answered 200 (not an object)`,
      },
    },
  },
  {
    id: "C-PRT-07",
    function: "protectionEvidence",
    conjunct:
      "a protection without review settings requires nothing and is no error",
    row: { rules: [], protection: UNPROTECTED, expect: "not-enforced" },
  },
  {
    id: "C-PRT-08",
    function: "protectionEvidence",
    conjunct: "review settings that are null require nothing and are no error",
    row: { rules: [], protection: settings(null), expect: "not-enforced" },
  },
  {
    id: "C-PRT-09",
    function: "protectionEvidence",
    conjunct: "a protection without review settings is no evidence",
    row: { rules: [BARE], protection: UNPROTECTED, expect: "not-enforced" },
  },
  {
    id: "C-PRT-10",
    function: "protectionEvidence",
    conjunct: "review settings that are no object are an error",
    row: {
      rules: [],
      protection: settings(true),
      expect: {
        error: `github: GET ${PROTECTION_PATH} answered 200 (the review settings are no object)`,
      },
    },
  },
  {
    id: "C-PRT-11",
    function: "protectionEvidence",
    conjunct:
      "review settings without a count require nothing and are no error",
    row: { rules: [], protection: settings({}), expect: "not-enforced" },
  },
  {
    id: "C-PRT-12",
    function: "protectionEvidence",
    conjunct: "code-owner reviews without a count are no evidence",
    row: {
      rules: [],
      protection: settings({ require_code_owner_reviews: true }),
      expect: "not-enforced",
    },
  },
  {
    id: "C-PRT-13",
    function: "protectionEvidence",
    conjunct: "a count that is no integer is an error",
    row: {
      rules: [],
      protection: settings({ required_approving_review_count: 0.5 }),
      expect: {
        error: `github: GET ${PROTECTION_PATH} answered 200 (the review count is no integer)`,
      },
    },
  },
  {
    id: "C-PRT-14",
    function: "protectionEvidence",
    conjunct: "a count of 0 requires nothing",
    row: {
      rules: [],
      protection: settings({ required_approving_review_count: 0 }),
      expect: "not-enforced",
    },
  },
  {
    id: "C-PRT-15",
    function: "protectionEvidence",
    conjunct: "a count of 1 requires a review",
    row: { rules: [], protection: PROTECTED, expect: "enforced" },
  },
  {
    id: "C-PRT-16",
    function: "protectionEvidence",
    conjunct: "the protection asked for is that of the target branch",
    row: {
      branch: "release/1.x",
      rules: [],
      protection: PROTECTED,
      expect: "enforced",
    },
  },
  {
    id: "C-ENF-01",
    function: "readEnforcement",
    conjunct: "the rules are asked for the branch the pull request targets",
    row: { branch: "release", rules: [REQUIRING], expect: "enforced" },
  },
  {
    id: "C-ENF-02",
    function: "readEnforcement",
    conjunct: "the protection is asked for the branch the pull request targets",
    row: {
      branch: "release",
      rules: [],
      protection: PROTECTED,
      expect: "enforced",
    },
  },
  {
    id: "C-ENF-03",
    function: "readEnforcement",
    conjunct:
      "a requiring ruleset is enough, whatever the protection would say",
    row: {
      rules: [REQUIRING],
      protection: { status: 403 },
      expect: "enforced",
    },
  },
  {
    id: "C-ENF-04",
    function: "readEnforcement",
    conjunct:
      "the protection is not asked when the rulesets require the review",
    row: {
      rules: [REQUIRING],
      protection: PROTECTED,
      expect: "enforced",
      protectionAsked: false,
    },
  },
  {
    id: "C-ENF-05",
    function: "readEnforcement",
    conjunct:
      "a requiring protection is enough when the rulesets require nothing",
    row: { rules: [], protection: PROTECTED, expect: "enforced" },
  },
  {
    id: "C-ENF-06",
    function: "readEnforcement",
    conjunct: "not-enforced needs readable rules",
    row: { rules: 403, protection: UNPROTECTED, expect: "unknown" },
  },
  {
    id: "C-ENF-07",
    function: "readEnforcement",
    conjunct: "not-enforced needs a readable protection",
    row: { rules: [], protection: { status: 403 }, expect: "unknown" },
  },
  {
    id: "C-ENF-08",
    function: "readEnforcement",
    conjunct:
      "one readable source without a requirement is not enough for not-enforced",
    row: { rules: 404, protection: UNPROTECTED, expect: "unknown" },
  },
  {
    id: "C-ENF-09",
    function: "readEnforcement",
    conjunct: "two readable sources without a requirement are not-enforced",
    row: { rules: [OTHER], protection: UNPROTECTED, expect: "not-enforced" },
  },
  {
    id: "C-ENF-10",
    function: "readEnforcement",
    conjunct: "two sources that are not readable are unknown",
    row: { rules: 403, protection: { status: 404 }, expect: "unknown" },
  },
  {
    id: "C-ENF-11",
    function: "reviewEnforcement",
    conjunct: "a path the check does not know is refused",
    row: {
      rules: [REQUIRING],
      paths: ["src/"],
      expect: {
        refused: "github: reviewEnforcement was asked for another path",
      },
      rulesAsked: 0,
    },
  },
  {
    id: "C-ENF-12",
    function: "reviewEnforcement",
    conjunct: "the second path of the check is answered like the first",
    row: { rules: [REQUIRING], paths: [".spec-gate/"], expect: "enforced" },
  },
  {
    id: "C-ENF-13",
    function: "reviewEnforcement",
    conjunct: "both paths are answered from one read",
    row: {
      rules: [REQUIRING],
      paths: ["specs/", ".spec-gate/"],
      expect: "enforced",
      rulesAsked: 1,
    },
  },
  {
    id: "C-ENF-14",
    function: "readEnforcement",
    conjunct: "a requiring ruleset gives enforced",
    row: { rules: [pullRequestRule(3)], expect: "enforced" },
  },
  {
    id: "C-ENF-15",
    function: "readEnforcement",
    conjunct: "a requiring protection gives enforced",
    row: {
      rules: [BARE],
      protection: settings({ required_approving_review_count: 2 }),
      expect: "enforced",
    },
  },
  {
    id: "C-RUL-25",
    function: "rulesetEvidence",
    conjunct:
      "parameters that are null have no review count, and that is no crash",
    row: {
      rules: [{ type: "pull_request", parameters: null }],
      protection: UNPROTECTED,
      expect: { error: `github: GET ${RULES_PATH} answered 200 (${COUNT})` },
    },
  },
  {
    id: "C-RUL-26",
    function: "list",
    conjunct: "the statuses a caller maps reach the request of a page",
    row: { rules: 404, protection: PROTECTED, expect: "enforced" },
  },
];

describe("CONJUNCTS: the review enforcement", () => {
  it("the table and the list of changes name the same conjuncts, each once", () => {
    const ids = CONJUNCTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(conjunctIds("github-enforcement"));
  });

  it.each(
    CONJUNCTS.map((entry) => [entry.id, entry.conjunct, entry.row] as const),
  )("%s: %s", async (_id, _conjunct, row) => {
    const branch = row.branch ?? "main";
    const rulesPath = `${P}/rules/branches/${branch}`;
    const protectionPath = `${P}/branches/${branch}/protection`;
    stub.on(PULL_PATH, {
      json: pullJson({
        base: { ref: branch, sha: BASE, repo: { full_name: "acme/widgets" } },
      }),
    });
    stub.on(
      rulesPath,
      typeof row.rules === "number"
        ? { status: row.rules }
        : { json: row.rules },
    );
    if (row.protection !== undefined) stub.on(protectionPath, row.protection);
    const host = hostAt(stub);
    for (const path of row.paths ?? ["specs/"]) {
      const call = host.reviewEnforcement(path as ReviewPath);
      if (typeof row.expect === "string") {
        expect(await giving(call)).toBe(row.expect);
      } else if ("refused" in row.expect) {
        await expect(call).rejects.toThrow(row.expect.refused);
      } else {
        expect((await failing(call)).message).toBe(row.expect.error);
      }
    }
    if (row.protectionAsked !== undefined) {
      expect(stub.hitsOf(protectionPath).length > 0).toBe(row.protectionAsked);
    }
    if (row.rulesAsked !== undefined) {
      expect(stub.hitsOf(rulesPath)).toHaveLength(row.rulesAsked);
    }
  });
});
