/* The core no-unused-vars rule reports parameter names inside function types. */
/* eslint-disable no-unused-vars */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_CATEGORIES,
  findForbiddenCharacter,
  parseBindings,
  parseCommandSet,
  parseConfig,
  parseQuestions,
  parseSpec,
  parseTestPlan,
  parseTriage,
} from "../../src/formats/index.js";

const cp = (n: number) => String.fromCodePoint(n);

/** Representative code points per general category. */
const BY_CATEGORY: Record<string, number[]> = {
  Cc: [0x0000, 0x0007, 0x001b, 0x007f, 0x0085, 0x009f],
  Cf: [
    0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
    0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xe0001, 0xe0041,
  ],
  Zl: [0x2028],
  Zp: [0x2029],
};

/** Control characters that are line breaks: they end a line, so a line-based format reports them differently. */
const ALL = Object.values(BY_CATEGORY).flat();

/** Ordinary text a person may write: it must always pass. */
const ORDINARY = [
  "plain ascii",
  "Grüße aus München",
  "日本語のテキスト",
  "emoji \u{1f600} \u{1f680}",
  "combining é accent",
  "hyphen ‐ and nbsp   and thin  ",
  "tab\tinside",
];

describe("forbidden characters, by Unicode category", () => {
  it("names the four categories", () => {
    expect([...FORBIDDEN_CATEGORIES]).toEqual(["Cc", "Cf", "Zl", "Zp"]);
  });

  it("finds every representative code point, with its position and label", () => {
    for (const [category, points] of Object.entries(BY_CATEGORY)) {
      expect(points.length, category).toBeGreaterThanOrEqual(1);
      for (const n of points) {
        const r = findForbiddenCharacter(`ab${cp(n)}cd`, { allowTab: false });
        expect(r, `${category} U+${n.toString(16)}`).not.toBeNull();
        expect(r!.codePoint).toBe(n);
        expect(r!.index).toBe(2);
        expect(r!.label).toBe(
          `U+${n.toString(16).toUpperCase().padStart(4, "0")}`,
        );
      }
    }
  });

  it("covers the code points the reviewer listed", () => {
    for (const n of [
      0x061c, 0xfeff, 0x2060, 0x00ad, 0x180e, 0x0085, 0xe0041, 0x202e, 0x200b,
      0x2028,
    ]) {
      expect(findForbiddenCharacter(cp(n)), n.toString(16)).not.toBeNull();
    }
  });

  it("allows a tab unless told otherwise, and always rejects the other whitespace controls", () => {
    expect(findForbiddenCharacter("a\tb")).toBeNull();
    expect(findForbiddenCharacter("a\tb", { allowTab: true })).toBeNull();
    expect(findForbiddenCharacter("a\tb", { allowTab: false })!.codePoint).toBe(
      9,
    );
    for (const n of [0x0a, 0x0d, 0x0b, 0x0c]) {
      expect(findForbiddenCharacter(`a${cp(n)}b`)!.codePoint).toBe(n);
    }
  });

  it("passes ordinary non-ASCII text", () => {
    for (const text of ORDINARY) {
      expect(findForbiddenCharacter(text), text).toBeNull();
    }
    expect(findForbiddenCharacter("")).toBeNull();
  });

  it("finds a character in the supplementary planes, not only in the BMP", () => {
    expect(findForbiddenCharacter(`x${cp(0xe0041)}`)!.index).toBe(1);
  });
});

// ---------------------------------------------------------------- formats

const specText = fs.readFileSync(
  fileURLToPath(
    new URL("../fixtures/formats/spec/valid/full.md", import.meta.url),
  ),
  "utf8",
);

interface Site {
  format: string;
  field: string;
  /** Parses the document built with `value` in the field; returns `codes at paths`. */
  run: (value: string) => string[];
}

function summary(r: {
  ok: boolean;
  errors?: { code: string; path: string }[];
}): string[] {
  return r.ok ? [] : (r.errors ?? []).map((e) => `${e.code} @ ${e.path}`);
}

const q = (over: Record<string, unknown> = {}) => ({
  id: "QN-1",
  target: "AC-1",
  class: "divergence",
  blocking: true,
  question: "q?",
  options: [{ label: "a", consequence: "ca" }],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  question: "QN-1",
  answer: "a",
  channel: "file",
  author: "alice",
  time: "2000-01-31T12:00:00Z",
  ...over,
});

const tpRow = (extra: Record<string, unknown>, kind: string) => {
  const base: Record<string, Record<string, unknown>> = {
    "red-first": { red_reason: "r", expected: "e", oracle: "o" },
    "stays-green": { probe_hint: "h" },
    measurement: { baseline: "1", threshold: "2", runs: 3 },
    static: { check_command_ref: "x" },
    manual: { verifier: "v", evidence_location: "l" },
    runtime: {
      environment: "e",
      steps: ["s"],
      expected: "e",
      evidence_location: "l",
    },
    "post-deploy": { check: "c", environment: "e" },
  };
  return {
    id: "TP-1",
    covers: ["AC-1"],
    kind,
    claim: "c",
    ...base[kind],
    ...extra,
  };
};

const triageDoc = (over: Record<string, unknown>) => {
  const d: Record<string, unknown> = {};
  for (const f of [
    "single_goal",
    "code_related",
    "core_is_decision",
    "scope_within_request",
    "multiple_repos",
    "trivial",
  ]) {
    d[f] = { value: "yes", evidence: "e" };
  }
  d["blocking_unknowns"] = [];
  return { ...d, ...over };
};

const SITES: Site[] = [
  // spec.md: every normative line and attribute value, and the title line
  {
    format: "spec",
    field: "title line",
    run: (v) =>
      summary(
        parseSpec(
          specText.replace("# Password change", `# Password ${v} change`),
        ),
      ),
  },
  {
    format: "spec",
    field: "goal text",
    run: (v) =>
      summary(
        parseSpec(specText.replace("- GOAL: After", `- GOAL: Af${v}ter`)),
      ),
  },
  {
    format: "spec",
    field: "item text",
    run: (v) =>
      summary(
        parseSpec(specText.replace("- NG-2: Login", `- NG-2: Lo${v}gin`)),
      ),
  },
  {
    format: "spec",
    field: "attribute value",
    run: (v) =>
      summary(parseSpec(specText.replace("owner: alice", `owner: al${v}ice`))),
  },
  {
    format: "spec",
    field: "nested attribute value",
    run: (v) =>
      summary(
        parseSpec(specText.replace("- author: alice", `- author: al${v}ice`)),
      ),
  },
  {
    format: "spec",
    field: "ledger reason",
    run: (v) =>
      summary(
        parseSpec(
          specText.replace("Greeting, carries", `Gre${v}eting, carries`),
        ),
      ),
  },
  {
    format: "spec",
    field: "frontmatter id",
    run: (v) =>
      summary(
        parseSpec(
          specText.replace("id: password-change-logout", `id: "pass${v}word"`),
        ),
      ),
  },
  // testplan.yaml: every string field of a row
  ...(
    [
      ["claim", "red-first"],
      ["input", "red-first"],
      ["expected", "red-first"],
      ["oracle", "red-first"],
      ["level", "red-first"],
      ["seam", "red-first"],
      ["notes", "red-first"],
      ["red_reason", "red-first"],
      ["fail_match", "red-first"],
      ["probe_hint", "stays-green"],
      ["verifier", "manual"],
      ["evidence_location", "manual"],
      ["check", "post-deploy"],
      ["environment", "post-deploy"],
      ["baseline", "measurement"],
      ["threshold", "measurement"],
    ] as [string, string][]
  ).map(([field, kind]) => ({
    format: "testplan",
    field,
    run: (v: string) =>
      summary(
        parseTestPlan(JSON.stringify([tpRow({ [field]: `a${v}b` }, kind)])),
      ),
  })),
  {
    format: "testplan",
    field: "steps entry",
    run: (v) =>
      summary(
        parseTestPlan(
          JSON.stringify([tpRow({ steps: [`a${v}b`] }, "runtime")]),
        ),
      ),
  },
  // questions.json
  {
    format: "questions",
    field: "question",
    run: (v) =>
      summary(
        parseQuestions(
          JSON.stringify({ questions: [q({ question: `a${v}b` })] }),
        ),
      ),
  },
  {
    format: "questions",
    field: "option label",
    run: (v) =>
      summary(
        parseQuestions(
          JSON.stringify({
            questions: [
              q({ options: [{ label: `a${v}b`, consequence: "c" }] }),
            ],
          }),
        ),
      ),
  },
  {
    format: "questions",
    field: "option consequence",
    run: (v) =>
      summary(
        parseQuestions(
          JSON.stringify({
            questions: [
              q({ options: [{ label: "a", consequence: `a${v}b` }] }),
            ],
          }),
        ),
      ),
  },
  {
    format: "questions",
    field: "evidence",
    run: (v) =>
      summary(
        parseQuestions(
          JSON.stringify({ questions: [q({ evidence: `a${v}b` })] }),
        ),
      ),
  },
  {
    format: "questions",
    field: "answer text",
    run: (v) =>
      summary(
        parseQuestions(
          JSON.stringify({
            questions: [q()],
            answers: [answer({ answer: `a${v}b` })],
          }),
        ),
      ),
  },
  {
    format: "questions",
    field: "answer author",
    run: (v) =>
      summary(
        parseQuestions(
          JSON.stringify({
            questions: [q()],
            answers: [answer({ author: `a${v}b` })],
          }),
        ),
      ),
  },
  // triage.json
  {
    format: "triage",
    field: "field evidence",
    run: (v) =>
      summary(
        parseTriage(
          JSON.stringify(
            triageDoc({ single_goal: { value: "yes", evidence: `a${v}b` } }),
          ),
        ),
      ),
  },
  {
    format: "triage",
    field: "blocking unknown",
    run: (v) =>
      summary(
        parseTriage(
          JSON.stringify(triageDoc({ blocking_unknowns: [`a${v}b`] })),
        ),
      ),
  },
  // bindings, config, commands
  {
    format: "bindings",
    field: "notes",
    run: (v) =>
      summary(
        parseBindings(
          JSON.stringify({ "TP-1": { status: "new", notes: `a${v}b` } }),
        ),
      ),
  },
  {
    format: "bindings",
    field: "selector",
    run: (v) =>
      summary(
        parseBindings(
          JSON.stringify({ "TP-1": { status: "new", selector: `a${v}b` } }),
        ),
      ),
  },
  {
    format: "config",
    field: "approver",
    run: (v) => summary(parseConfig(JSON.stringify({ approvers: [`a${v}b`] }))),
  },
  {
    format: "commands",
    field: "argv element",
    run: (v) =>
      summary(
        parseCommandSet(
          JSON.stringify({ commands: { c: { argv: ["tool", `a${v}b`] } } }),
        ),
      ),
  },
];

/** Where each site reports the error; the path is the part after `@`. */
function hasForbidden(codes: string[]): boolean {
  return codes.some((c) => c.startsWith("forbidden-character @ "));
}

describe("every string field rejects every forbidden category", () => {
  for (const site of SITES) {
    describe(`${site.format}: ${site.field}`, () => {
      for (const [category, points] of Object.entries(BY_CATEGORY)) {
        for (const n of points) {
          it(`${category} U+${n.toString(16).toUpperCase().padStart(4, "0")}`, () => {
            // Tab-free: a forbidden character that is also a line break is
            // fine to report as forbidden alongside a grammar error.
            const codes = site.run(cp(n));
            expect(hasForbidden(codes), codes.join("; ")).toBe(true);
          });
        }
      }
    });
  }

  for (const site of SITES) {
    it(`${site.format}: ${site.field} accepts ordinary non-ASCII text`, () => {
      for (const text of ORDINARY) {
        // An argv element takes no tab; every other field does.
        if (site.field === "argv element" && text.includes("\t")) continue;
        const codes = site.run(text);
        expect(hasForbidden(codes), `${text}: ${codes.join("; ")}`).toBe(false);
      }
    });
  }

  it("rejects a tab in an argv element, as the one field that takes none", () => {
    expect(
      summary(
        parseCommandSet(
          JSON.stringify({ commands: { c: { argv: ["a\tb"] } } }),
        ),
      ),
    ).toEqual(["forbidden-character @ commands.c.argv[0]"]);
  });

  it("reports one forbidden-character error per field, however many it holds", () => {
    const codes = summary(
      parseTestPlan(
        JSON.stringify([
          tpRow({ claim: `a${cp(0x202e)}${cp(0x200b)}b` }, "red-first"),
        ]),
      ),
    );
    expect(codes).toEqual(["forbidden-character @ TP-1.claim"]);
  });

  it("reports each field that holds one, not only the first", () => {
    const codes = summary(
      parseTestPlan(
        JSON.stringify([
          tpRow(
            { claim: `a${cp(0x202e)}b`, input: `c${cp(0x200b)}d` },
            "red-first",
          ),
        ]),
      ),
    );
    expect(codes.sort()).toEqual([
      "forbidden-character @ TP-1.claim",
      "forbidden-character @ TP-1.input",
    ]);
  });

  it("names the code point in the message", () => {
    const r = parseTestPlan(
      JSON.stringify([tpRow({ claim: `a${cp(0xe0041)}` }, "red-first")]),
    );
    expect(r.ok === false && r.errors[0]!.message).toContain("U+E0041");
  });

  it("allows a newline in no string field: the fields are single-line", () => {
    const codes = summary(
      parseTestPlan(JSON.stringify([tpRow({ claim: "a\nb" }, "red-first")])),
    );
    expect(codes).toEqual(["forbidden-character @ TP-1.claim"]);
    expect(
      summary(
        parseTestPlan(JSON.stringify([tpRow({ claim: "a\tb" }, "red-first")])),
      ),
    ).toEqual([]);
  });

  it("does not check Context", () => {
    expect(
      summary(
        parseSpec(specText.replace("Free prose.", `Free ${cp(0x202e)} prose.`)),
      ),
    ).toEqual([]);
  });

  it("checks every code point in one list against one spec line", () => {
    for (const n of ALL) {
      const codes = summary(
        parseSpec(specText.replace("- NG-2: Login", `- NG-2: Lo${cp(n)}gin`)),
      );
      expect(codes, n.toString(16)).toContain(
        "forbidden-character @ NG-2.text",
      );
    }
  });
});
