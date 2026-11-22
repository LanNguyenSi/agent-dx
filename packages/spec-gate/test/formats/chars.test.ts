/* The core no-unused-vars rule reports parameter names inside function types. */
/* eslint-disable no-unused-vars */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ErrorSink,
  FORBIDDEN_CATEGORIES,
  findForbiddenCharacter,
  findForbiddenLines,
  parseBindings,
  parseCommandSet,
  parseConfig,
  parseEvidenceEnvelope,
  parseQuestions,
  parseSpec,
  parseTestPlan,
  parseTriage,
  parseYamlText,
  scanForbiddenLines,
  splitSourceLines,
} from "../../src/formats/index.js";

const cp = (n: number) => String.fromCodePoint(n);

const label = (n: number) =>
  `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * A value as YAML text in which every character outside printable ASCII is
 * an escape sequence. The raw text is then clean, and a forbidden character
 * exists only in the decoded value, where the field check has to find it.
 */
const yamlText = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Representative code points per general category. */
const BY_CATEGORY: Record<string, number[]> = {
  Cc: [0x0000, 0x0007, 0x001b, 0x007f, 0x0085, 0x009f],
  Cf: [
    0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
    0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xe0001, 0xe0041,
  ],
  Zl: [0x2028],
  Zp: [0x2029],
  // Lone surrogates: the first and last high one, the first and last low one.
  Cs: [0xd800, 0xdbff, 0xdc00, 0xdfff],
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
  it("names the five categories", () => {
    expect([...FORBIDDEN_CATEGORIES]).toEqual(["Cc", "Cf", "Zl", "Zp", "Cs"]);
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

  it("finds a format, control or separator character that is the whole text", () => {
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
      summary(parseTestPlan(yamlText([tpRow({ [field]: `a${v}b` }, kind)]))),
  })),
  {
    format: "testplan",
    field: "steps entry",
    run: (v) =>
      summary(
        parseTestPlan(yamlText([tpRow({ steps: [`a${v}b`] }, "runtime")])),
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
        parseBindings(yamlText({ "TP-1": { status: "new", notes: `a${v}b` } })),
      ),
  },
  {
    format: "bindings",
    field: "selector",
    run: (v) =>
      summary(
        parseBindings(
          yamlText({ "TP-1": { status: "new", selector: `a${v}b` } }),
        ),
      ),
  },
  {
    format: "config",
    field: "approver",
    run: (v) => summary(parseConfig(yamlText({ approvers: [`a${v}b`] }))),
  },
  {
    format: "commands",
    field: "argv element",
    run: (v) =>
      summary(
        parseCommandSet(
          yamlText({ commands: { c: { argv: ["tool", `a${v}b`] } } }),
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
        parseCommandSet(yamlText({ commands: { c: { argv: ["a\tb"] } } })),
      ),
    ).toEqual(["forbidden-character @ commands.c.argv[0]"]);
  });

  it("reports one forbidden-character error per field, however many it holds", () => {
    const codes = summary(
      parseTestPlan(
        yamlText([
          tpRow({ claim: `a${cp(0x202e)}${cp(0x200b)}b` }, "red-first"),
        ]),
      ),
    );
    expect(codes).toEqual(["forbidden-character @ TP-1.claim"]);
  });

  it("reports each field that holds one, not only the first", () => {
    const codes = summary(
      parseTestPlan(
        yamlText([
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
      yamlText([tpRow({ claim: `a${cp(0xe0041)}` }, "red-first")]),
    );
    expect(r.ok === false && r.errors[0]!.message).toContain("U+E0041");
  });

  it("allows a newline in no string field: the fields are single-line", () => {
    const codes = summary(
      parseTestPlan(yamlText([tpRow({ claim: "a\nb" }, "red-first")])),
    );
    expect(codes).toEqual(["forbidden-character @ TP-1.claim"]);
    expect(
      summary(parseTestPlan(yamlText([tpRow({ claim: "a\tb" }, "red-first")]))),
    ).toEqual([]);
  });

  it("checks a Context line like every other line, for every code point", () => {
    for (const n of ALL) {
      expect(
        summary(
          parseSpec(specText.replace("Free prose.", `Free ${cp(n)} prose.`)),
        ),
        label(n),
      ).toEqual(["forbidden-character @ $"]);
    }
  });

  it("accepts ordinary non-ASCII text and a tab in Context", () => {
    for (const text of ORDINARY) {
      expect(
        summary(parseSpec(specText.replace("Free prose.", `Free ${text}.`))),
        text,
      ).toEqual([]);
    }
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

// ------------------------------------------------------------ lone surrogates

describe("lone surrogates", () => {
  it("finds a surrogate without its partner and passes a well-formed pair", () => {
    expect(findForbiddenCharacter("a\ud800b")).toEqual({
      codePoint: 0xd800,
      index: 1,
      label: "U+D800",
    });
    expect(findForbiddenCharacter("a\udc00b")).toEqual({
      codePoint: 0xdc00,
      index: 1,
      label: "U+DC00",
    });
    // Low before high: neither has its partner.
    expect(findForbiddenCharacter("\udc00\ud800")!.index).toBe(0);
    // A pair, then a high surrogate alone: the pair is passed over.
    expect(findForbiddenCharacter("\u{1f600}\ud83d")).toEqual({
      codePoint: 0xd83d,
      index: 2,
      label: "U+D83D",
    });
    expect(findForbiddenCharacter("a\u{1f600}b")).toBeNull();
    expect(
      findForbiddenCharacter("a\u{1f600}b", { allowTab: false }),
    ).toBeNull();
    expect(
      findForbiddenCharacter("a\ud800b", { allowTab: false })!.codePoint,
    ).toBe(0xd800);
  });

  it("refuses two strings that differ in memory and are the same UTF-8 bytes", () => {
    const one = "a\ud800b";
    const other = "a\ud801b";
    expect(one).not.toBe(other);
    expect(new TextEncoder().encode(one)).toEqual(
      new TextEncoder().encode(other),
    );
    expect(findForbiddenCharacter(one)!.label).toBe("U+D800");
    expect(findForbiddenCharacter(other)!.label).toBe("U+D801");
  });

  it("refuses one in a test-plan string, at the field", () => {
    const text = JSON.stringify([tpRow({ claim: "a\ud800b" }, "red-first")]);
    // JSON.stringify writes a lone surrogate as an escape sequence.
    expect(text).toContain("\\ud800");
    expect(summary(parseTestPlan(text))).toEqual([
      "forbidden-character @ TP-1.claim",
    ]);
  });

  it("refuses one in a spec item, at the item", () => {
    expect(
      summary(
        parseSpec(specText.replace("- NG-2: Login", "- NG-2: Lo\udc00gin")),
      ),
    ).toEqual(["forbidden-character @ NG-2.text"]);
  });

  it("refuses one in a question, at the field", () => {
    expect(
      summary(
        parseQuestions(
          JSON.stringify({ questions: [q({ question: "why \ud800?" })] }),
        ),
      ),
    ).toEqual(["forbidden-character @ QN-1.question"]);
  });

  it("accepts a well-formed pair in the same three places", () => {
    const pair = "\u{1f680}";
    expect(
      summary(
        parseTestPlan(yamlText([tpRow({ claim: `a${pair}b` }, "red-first")])),
      ),
    ).toEqual([]);
    expect(
      summary(
        parseSpec(specText.replace("- NG-2: Login", `- NG-2: Lo${pair}gin`)),
      ),
    ).toEqual([]);
    expect(
      summary(
        parseQuestions(
          JSON.stringify({ questions: [q({ question: `why ${pair}?` })] }),
        ),
      ),
    ).toEqual([]);
  });
});

// ------------------------------------------------------- lines of a raw text

describe("findForbiddenLines", () => {
  it("returns nothing for a clean text", () => {
    expect(findForbiddenLines("")).toEqual([]);
    expect(findForbiddenLines("a\nb\tc\n")).toEqual([]);
    for (const text of ORDINARY) {
      expect(findForbiddenLines(`${text}\n${text}`), text).toEqual([]);
    }
  });

  it("reports the first character of every line that has one, with its line", () => {
    expect(
      findForbiddenLines(
        `a\nb${cp(0x200b)}c\n\nd${cp(0x202e)}e${cp(0x200b)}\nf`,
      ),
    ).toEqual([
      { line: 2, index: 1, codePoint: 0x200b, label: "U+200B" },
      { line: 4, index: 1, codePoint: 0x202e, label: "U+202E" },
    ]);
  });

  it("takes a line feed, alone or after a carriage return, as the only line end", () => {
    expect(findForbiddenLines("a\r\nb\r\n")).toEqual([]);
    expect(findForbiddenLines("\r\n")).toEqual([]);
    // A carriage return inside a line.
    expect(findForbiddenLines("a\rb\n")).toEqual([
      { line: 1, index: 1, codePoint: 0x0d, label: "U+000D" },
    ]);
    // Two before a line feed: only the last one belongs to the line end.
    expect(findForbiddenLines("a\r\r\nb")).toEqual([
      { line: 1, index: 1, codePoint: 0x0d, label: "U+000D" },
    ]);
    // One at the end of the text, with no line feed after it.
    expect(findForbiddenLines("a\nb\r")).toEqual([
      { line: 2, index: 1, codePoint: 0x0d, label: "U+000D" },
    ]);
    // The other characters a viewer may break a line at stay inside a line.
    for (const n of [0x0b, 0x0c, 0x85, 0x2028, 0x2029]) {
      expect(findForbiddenLines(`a\nb${cp(n)}c`), label(n)).toEqual([
        { line: 2, index: 1, codePoint: n, label: label(n) },
      ]);
    }
  });
});

// -------------------------------------------------------------- raw YAML text

interface RawDoc {
  format: string;
  parse: (text: string) => {
    ok: boolean;
    errors?: { code: string; path: string; line?: number; message: string }[];
  };
  /** The lines of a valid document. */
  lines: string[];
}

const RAW_DOCS: RawDoc[] = [
  { format: "yaml text", parse: parseYamlText, lines: ["a: 1", "b: [1, 2]"] },
  {
    format: "testplan",
    parse: parseTestPlan,
    lines: [
      "- id: TP-1",
      "  covers: [AC-1]",
      "  kind: manual",
      "  claim: c",
      "  verifier: v",
      "  evidence_location: l",
    ],
  },
  {
    format: "bindings",
    parse: parseBindings,
    lines: ["TP-1:", "  status: new"],
  },
  {
    format: "config",
    parse: parseConfig,
    lines: ["approvers: [alice]", "agent_identities: [bot]"],
  },
  {
    format: "commands",
    parse: parseCommandSet,
    lines: ["commands:", "  typecheck:", "    argv: [npm, run, typecheck]"],
  },
];

/** Where a comment can sit; each returns the text and the comment's line. */
const COMMENT_POSITIONS: Record<
  string,
  (lines: string[], comment: string) => [string, number]
> = {
  "before the document": (lines, c) => [[c, ...lines].join("\n") + "\n", 1],
  "on a line of its own": (lines, c) => [
    [lines[0], c, ...lines.slice(1)].join("\n") + "\n",
    2,
  ],
  "after a value": (lines, c) => [
    [...lines.slice(0, -1), `${lines[lines.length - 1]} ${c}`].join("\n") +
      "\n",
    lines.length,
  ],
};

describe("the raw text of a YAML file", () => {
  for (const doc of RAW_DOCS) {
    it(`${doc.format}: the document without a comment is valid`, () => {
      expect(doc.parse(doc.lines.join("\n") + "\n").ok).toBe(true);
    });

    for (const [position, build] of Object.entries(COMMENT_POSITIONS)) {
      it(`${doc.format}: refuses every forbidden category in a comment ${position}`, () => {
        for (const n of ALL) {
          const [text, line] = build(doc.lines, `# note${cp(n)}more`);
          const r = doc.parse(text);
          expect(r.ok, label(n)).toBe(false);
          expect(
            (r.errors ?? []).map((e) => [e.code, e.path, e.line]),
            label(n),
          ).toEqual([["forbidden-character", "$", line]]);
          expect(r.errors![0]!.message, label(n)).toContain(label(n));
        }
      });

      it(`${doc.format}: accepts ordinary non-ASCII text and a tab in a comment ${position}`, () => {
        for (const words of ORDINARY) {
          const [text] = build(doc.lines, `# ${words}`);
          expect(doc.parse(text).ok, words).toBe(true);
        }
      });
    }
  }

  it("refuses a comment that a viewer may show as a row the parser never reads", () => {
    const row = RAW_DOCS[1]!.lines.join("\n");
    const phantom = "- id: TP-2";
    expect(summary(parseTestPlan(`${row}\n# next row\n`))).toEqual([]);
    for (const n of [0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029]) {
      const r = parseTestPlan(`${row}\n# next row${cp(n)}${phantom}\n`);
      expect(r.ok === false && r.errors, label(n)).toMatchObject([
        { code: "forbidden-character", path: "$", line: 7 },
      ]);
    }
  });

  it("refuses a character in the comment of a block scalar header", () => {
    const text = `a: >- # note${cp(0x200b)}\n  folded\n  text\nb: 1\n`;
    expect(parseYamlText(text.replace(cp(0x200b), ""))).toEqual({
      ok: true,
      value: { a: "folded text", b: 1 },
    });
    expect(parseYamlText(text)).toMatchObject({
      ok: false,
      errors: [{ code: "forbidden-character", path: "$", line: 1 }],
    });
  });

  it("reports every line that holds one", () => {
    const r = parseYamlText(
      `a: 1 # x${cp(0x200b)}\nb: 2\nc: 3 # y${cp(0x202e)}\n`,
    );
    expect(r.ok === false && r.errors.map((e) => [e.code, e.line])).toEqual([
      ["forbidden-character", 1],
      ["forbidden-character", 3],
    ]);
  });

  it("finds a character written into a value at its line, and an escaped one at its field", () => {
    const rows = [tpRow({ claim: `a${cp(0x200b)}b` }, "red-first")];
    const literal = parseTestPlan(JSON.stringify(rows, null, 1));
    expect(literal.ok === false && literal.errors).toMatchObject([
      { code: "forbidden-character", path: "$", line: 8 },
    ]);
    expect(JSON.stringify(rows, null, 1).split("\n")[7]).toContain('"claim"');
    expect(summary(parseTestPlan(yamlText(rows)))).toEqual([
      "forbidden-character @ TP-1.claim",
    ]);
  });

  it("accepts CRLF line ends and refuses any other carriage return", () => {
    expect(parseYamlText("a: 1\r\nb: 2\r\n")).toEqual(
      parseYamlText("a: 1\nb: 2\n"),
    );
    expect(parseYamlText("a: 1\nb: 2\n").ok).toBe(true);
    for (const [text, line] of [
      ["a: 1 # x\ry: 2\nb: 2\n", 1],
      ["a: 1\r\r\nb: 2\r\n", 1],
      ["a: 1\nb: 2\r", 2],
    ] as [string, number][]) {
      expect(parseYamlText(text), JSON.stringify(text)).toMatchObject({
        ok: false,
        errors: [{ code: "forbidden-character", path: "$", line }],
      });
    }
  });

  it("accepts one byte order mark at the start of a YAML file and refuses it anywhere else", () => {
    const bom = cp(0xfeff);
    expect(parseYamlText(`${bom}a: 1\n`)).toEqual({
      ok: true,
      value: { a: 1 },
    });
    // A list, which the YAML library alone misreads after a byte order mark.
    for (const doc of RAW_DOCS) {
      const text = doc.lines.join("\n") + "\n";
      expect(doc.parse(bom + text), doc.format).toEqual(doc.parse(text));
      expect(doc.parse(bom + text).ok, doc.format).toBe(true);
    }
    for (const [text, line] of [
      [`${bom}${bom}a: 1\n`, 1],
      [`a: 1\n${bom}b: 2\n`, 2],
      [`a: 1 ${bom}\n`, 1],
    ] as [string, number][]) {
      expect(parseYamlText(text), JSON.stringify(text)).toMatchObject({
        ok: false,
        errors: [{ code: "forbidden-character", path: "$", line }],
      });
    }
  });
});

// ------------------------------------------------------- single-line fields

describe("single-line string fields in YAML", () => {
  const plan = (claim: string) =>
    `- id: TP-1\n  covers: [AC-1]\n  kind: manual\n  ${claim}\n  verifier: v\n  evidence_location: l\n`;

  it.each([
    ["a literal block scalar", "claim: |\n    one line"],
    [
      "a literal block scalar with two lines, stripped",
      "claim: |-\n    one\n    two",
    ],
    ["a folded block scalar", "claim: >\n    one\n    two"],
    ["a folded block scalar that keeps its line ends", "claim: >+\n    one"],
    [
      "a folded, stripped block scalar with a blank line",
      "claim: >-\n    one\n\n    two",
    ],
    ["an escaped line feed", 'claim: "one\\ntwo"'],
  ])("refuses %s: the value holds a line feed", (_name, claim) => {
    expect(summary(parseTestPlan(plan(claim)))).toEqual([
      "forbidden-character @ TP-1.claim",
    ]);
  });

  it.each([
    [
      "a folded, stripped block scalar",
      "claim: >-\n    one\n    two",
      "one two",
    ],
    [
      "a literal, stripped block scalar of one line",
      "claim: |-\n    one line",
      "one line",
    ],
    [
      "a plain scalar continued on the next line",
      "claim: one\n    two",
      "one two",
    ],
    [
      "a quoted scalar continued on the next line",
      'claim: "one\n    two"',
      "one two",
    ],
  ])("accepts %s: the value is one line", (_name, claim, value) => {
    const r = parseTestPlan(plan(claim));
    expect(r.ok && r.value[0]!.claim).toBe(value);
  });
});

// ---------------------------------------------------------- order of checks

describe("the character rule comes before the emptiness test", () => {
  const codes = (question: string) =>
    summary(parseQuestions(JSON.stringify({ questions: [q({ question })] })));

  it("reports a value made only of forbidden characters as forbidden", () => {
    for (const n of [0xfeff, 0x2028, 0x2029, 0x0b, 0x0c, 0x0a, 0x0d, 0x200b]) {
      expect(codes(cp(n)), label(n)).toEqual([
        "forbidden-character @ QN-1.question",
      ]);
      expect(codes(` ${cp(n)} `), label(n)).toEqual([
        "forbidden-character @ QN-1.question",
      ]);
    }
  });

  it("reports a value of spaces, tabs or nothing as empty", () => {
    for (const text of ["", " ", "\t", " \t ", " "]) {
      expect(codes(text), JSON.stringify(text)).toEqual([
        "empty-value @ QN-1.question",
      ]);
    }
  });
});

// ------------------------------------------------------------- error sink

describe("one forbidden-character report per path and line", () => {
  const lines = (sink: ErrorSink) =>
    sink.errors.map((e) => `${e.code} @ ${e.path}:${e.line ?? "-"}`);

  it("drops a second report for the same path and line", () => {
    const sink = new ErrorSink();
    sink.add("forbidden-character", "AC-1.owner", "m", 3);
    sink.add("forbidden-character", "AC-1.owner", "m", 3);
    expect(lines(sink)).toEqual(["forbidden-character @ AC-1.owner:3"]);
  });

  it("keeps reports for the same path on different lines", () => {
    const sink = new ErrorSink();
    sink.add("forbidden-character", "$", "m", 3);
    sink.add("forbidden-character", "$", "m", 9);
    sink.add("forbidden-character", "$", "m", 3);
    sink.add("forbidden-character", "$", "m", 9);
    expect(lines(sink)).toEqual([
      "forbidden-character @ $:3",
      "forbidden-character @ $:9",
    ]);
  });

  it("keeps reports for different paths on the same line", () => {
    const sink = new ErrorSink();
    sink.add("forbidden-character", "TP-1.claim", "m", 3);
    sink.add("forbidden-character", "TP-1.input", "m", 3);
    expect(lines(sink)).toHaveLength(2);
  });

  it("treats a report without a line as a repeat of any report on its path, in either order", () => {
    const lineFirst = new ErrorSink();
    lineFirst.add("forbidden-character", "DC-1.provenance.author", "m", 7);
    lineFirst.add("forbidden-character", "DC-1.provenance.author", "m");
    expect(lines(lineFirst)).toEqual([
      "forbidden-character @ DC-1.provenance.author:7",
    ]);
    const fieldFirst = new ErrorSink();
    fieldFirst.add("forbidden-character", "TP-1.claim", "m");
    fieldFirst.add("forbidden-character", "TP-1.claim", "m", 7);
    fieldFirst.add("forbidden-character", "TP-1.claim", "m");
    expect(lines(fieldFirst)).toEqual(["forbidden-character @ TP-1.claim:-"]);
  });

  it("uses the line hint as the line of a report that names none", () => {
    const sink = new ErrorSink();
    sink.lineHint = 5;
    sink.add("forbidden-character", "NG-1.paths", "m");
    sink.add("forbidden-character", "NG-1.paths", "m", 5);
    sink.add("forbidden-character", "NG-1.paths", "m", 6);
    expect(lines(sink)).toEqual([
      "forbidden-character @ NG-1.paths:5",
      "forbidden-character @ NG-1.paths:6",
    ]);
  });

  it("does not drop a repeated error of another code", () => {
    const sink = new ErrorSink();
    sink.add("empty-value", "AC-1.owner", "m", 3);
    sink.add("empty-value", "AC-1.owner", "m", 3);
    expect(lines(sink)).toHaveLength(2);
  });
});

// --------------------------------------------------------- documented limits

describe("what the rule leaves out, as documented", () => {
  /** Characters that render blank or not at all and belong to no refused category. */
  const BLANK_ELSEWHERE: [string, number][] = [
    ["no-break space (Zs)", 0x00a0],
    ["thin space (Zs)", 0x2009],
    ["hair space (Zs)", 0x200a],
    ["ideographic space (Zs)", 0x3000],
    ["Hangul filler (Lo)", 0x3164],
    ["Hangul choseong filler (Lo)", 0x115f],
    ["variation selector 16 (Mn)", 0xfe0f],
    ["combining grapheme joiner (Mn)", 0x034f],
    ["private-use character (Co)", 0xe000],
  ];

  it.each(BLANK_ELSEWHERE)("accepts a %s", (_name, n) => {
    expect(findForbiddenCharacter(`a${cp(n)}b`)).toBeNull();
    expect(
      findForbiddenCharacter(`a${cp(n)}b`, { allowTab: false }),
    ).toBeNull();
    expect(findForbiddenLines(`a\n${cp(n)}b`)).toEqual([]);
  });

  it("does not apply to the free strings of an evidence envelope or to the raw request", () => {
    const envelope = JSON.parse(
      fs.readFileSync(
        fileURLToPath(
          new URL(
            "../fixtures/formats/evidence/valid/single.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const zwsp = cp(0x200b);
    for (const over of [
      { selector: `a${zwsp}b` },
      { command: ["npx", `a${zwsp}b`] },
      { producer: "ci", ci_run: `run${zwsp}1` },
    ]) {
      expect(
        parseEvidenceEnvelope(JSON.stringify({ ...envelope, ...over })).ok,
        JSON.stringify(over),
      ).toBe(true);
    }
    const request = splitSourceLines(`Hello${zwsp} world\n${cp(0x202e)}Second`);
    expect(request.ok && request.value).toHaveLength(2);
  });
});

// ------------------------------------------------------------ error limits

describe("at most 100 forbidden-character errors per document", () => {
  const bad = `# no${cp(0x200b)}te\n`;

  it("keeps the first lines and counts them all", () => {
    const text = `a${cp(0x200b)}\n`.repeat(5);
    expect(scanForbiddenLines(text, 2)).toEqual({
      found: findForbiddenLines(text).slice(0, 2),
      total: 5,
    });
    expect(scanForbiddenLines(text, 0)).toEqual({ found: [], total: 5 });
    expect(scanForbiddenLines(text, 9).found).toHaveLength(5);
    expect(scanForbiddenLines("clean\n", 2)).toEqual({ found: [], total: 0 });
  });

  it("lists a YAML file's lines up to the limit and adds nothing", () => {
    const r = parseYamlText(`${bad.repeat(100)}a: 1\n`);
    expect(r.ok === false && r.errors.map((e) => e.code)).toEqual(
      Array(100).fill("forbidden-character"),
    );
  });

  it("stops a YAML file's list at the limit and states the total in one more error", () => {
    for (const doc of RAW_DOCS) {
      const r = doc.parse(`${bad.repeat(101)}${doc.lines.join("\n")}\n`);
      expect(r.errors, doc.format).toHaveLength(101);
      expect(r.errors![99], doc.format).toMatchObject({
        code: "forbidden-character",
        line: 100,
      });
      expect(r.errors![100], doc.format).toEqual({
        code: "too-many-errors",
        path: "$",
        message:
          "101 forbidden-character errors in total; the first 100 are listed",
      });
    }
    const many = parseYamlText(bad.repeat(5000));
    expect(many.ok === false && many.errors).toHaveLength(101);
    expect(many.ok === false && many.errors[100]!.message).toBe(
      "5000 forbidden-character errors in total; the first 100 are listed",
    );
  });

  it("limits the errors of decoded values the same way", () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      ...tpRow({ claim: `a${cp(0x200b)}b` }, "red-first"),
      id: `TP-${i + 1}`,
    }));
    const r = parseTestPlan(yamlText(rows));
    expect(r.ok === false && r.errors).toHaveLength(101);
    expect(r.ok === false && r.errors.at(-1)).toEqual({
      code: "too-many-errors",
      path: "$",
      message:
        "150 forbidden-character errors in total; the first 100 are listed",
    });
  });

  it("counts a repeated report once and limits no other code", () => {
    const sink = new ErrorSink();
    for (let i = 0; i < 200; i++) {
      sink.add("forbidden-character", "AC-1.owner", "m", 3);
    }
    expect(sink.errors).toHaveLength(1);
    const other = new ErrorSink();
    for (let i = 0; i < 200; i++) other.add("empty-value", `[${i}]`, "m");
    expect(other.errors).toHaveLength(200);
    const mixed = new ErrorSink();
    for (let i = 0; i < 150; i++) {
      mixed.add("forbidden-character", "$", "m", i + 1);
      mixed.add("context-heading-lookalike", "$", "m", i + 1);
    }
    expect(mixed.errors.map((e) => e.code).slice(-3)).toEqual([
      "context-heading-lookalike",
      "too-many-errors",
      "too-many-errors",
    ]);
    expect(mixed.errors).toHaveLength(202);
    expect(
      mixed.errors
        .filter((e) => e.code === "too-many-errors")
        .map((e) => e.message),
    ).toEqual([
      "150 forbidden-character errors in total; the first 100 are listed",
      "150 context-heading-lookalike errors in total; the first 100 are listed",
    ]);
  });
});
