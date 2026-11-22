import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANSWER_CHANNELS,
  MAX_INPUT_LENGTH,
  OPEN_POINT_CLASSES,
  OWNER_NONE,
  SPEC_SECTION_TITLES,
  SPEC_SOURCE_PATH,
  SPEC_STATUSES,
  contextHeadingLookalike,
  parseSpec,
  reduceHeadingText,
} from "../../src/formats/index.js";
import type { Spec } from "../../src/formats/index.js";

// A byte order mark, spelled out so editors and formatters keep it visible.
const BOM = String.fromCharCode(0xfeff);

function readFixture(name: string): string {
  return fs.readFileSync(
    fileURLToPath(
      new URL(`../fixtures/formats/spec/valid/${name}.md`, import.meta.url),
    ),
    "utf8",
  );
}

const fixture = fs.readFileSync(
  fileURLToPath(
    new URL("../fixtures/formats/spec/valid/full.md", import.meta.url),
  ),
  "utf8",
);

/** 1-based line of the first line of the full example that starts with `prefix`. */
function lineOf(prefix: string): number {
  return fixture.split("\n").findIndex((l) => l.startsWith(prefix)) + 1;
}

function parseOk(text: string): Spec {
  const r = parseSpec(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r.value;
}

function errorsOf(text: string): string[] {
  const r = parseSpec(text);
  return r.ok ? [] : r.errors.map((e) => `${e.code} @ ${e.path}`);
}

const MIN = `---
id: tiny
source: source/meta.json
base_commit: ${"a".repeat(40)}
commands_ref: ${"b".repeat(40)}
status: draft
---

## Goal

- GOAL: Be tiny.
`;

describe("spec.md grammar", () => {
  it("names the constants the docs and later steps share", () => {
    expect([...SPEC_STATUSES]).toEqual(["draft", "proposed", "superseded"]);
    expect([...SPEC_SECTION_TITLES]).toEqual([
      "Goal",
      "Context",
      "Acceptance",
      "Non-goals",
      "Defaults",
      "Decisions",
      "Residuals",
      "Source ledger",
    ]);
    expect([...ANSWER_CHANNELS]).toEqual(["file", "chat", "comment"]);
    expect([...OPEN_POINT_CLASSES]).toEqual([
      "divergence",
      "blind-spot",
      "untestable",
    ]);
    expect(OWNER_NONE).toBe("none");
  });

  it("parses the full example into typed lines with their file lines", () => {
    const spec = parseOk(fixture);
    expect(spec.frontmatter).toEqual({
      id: "password-change-logout",
      source: "source/meta.json",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      commands_ref: "0123456789abcdef0123456789abcdef01234567",
      status: "draft",
      retired_ids: ["AC-9", "NG-4"],
    });
    expect(spec.goal).toMatchObject({ id: "GOAL", line: 14 });
    expect(spec.acceptance.map((a) => [a.id, a.source, a.owner])).toEqual([
      ["AC-1", ["SL-1", "SL-2"], "alice"],
      ["AC-2", ["SL-3"], "none"],
    ]);
    expect(spec.nonGoals.map((n) => [n.id, n.paths])).toEqual([
      ["NG-1", ["src/auth/token.ts", "src/auth/**"]],
      ["NG-2", []],
    ]);
    expect(spec.defaults.map((d) => [d.id, d.affects_behavior])).toEqual([
      ["DF-1", true],
      ["DF-2", false],
    ]);
    expect(spec.decisions[0]).toMatchObject({
      id: "DC-1",
      question: "QN-1",
      provenance: {
        channel: "comment",
        author: "alice",
        time: "2000-01-31T12:00:00Z",
        comment_url: "https://example.com/issues/1#comment-2",
      },
    });
    expect(spec.residuals[0]).toMatchObject({
      id: "RS-1",
      class: "blind-spot",
      status: "open",
      question: "QN-2",
    });
    expect(
      spec.ledger.map((l) => [l.id, l.sourceLine, l.targets, l.out]),
    ).toEqual([
      ["SL-1", "L1-0123456789ab", ["AC-1"], false],
      ["SL-2", "L2-123456789abc", ["AC-1", "NG-1"], false],
      ["SL-3", "L3-23456789abcd", ["AC-2"], false],
      ["SL-4", "L4-3456789abcde", [], true],
    ]);
    expect(spec.ledger[3]!.reason).toBe("Greeting, carries no requirement.");
    expect(spec.ledger[0]!.reason).toBeUndefined();
    expect(spec.sections).toEqual([...SPEC_SECTION_TITLES]);
    expect(spec.ids).toEqual([
      "GOAL",
      "AC-1",
      "AC-2",
      "NG-1",
      "NG-2",
      "DF-1",
      "DF-2",
      "DC-1",
      "RS-1",
      "SL-1",
      "SL-2",
      "SL-3",
      "SL-4",
    ]);
  });

  it("reports the file line of the item an error belongs to", () => {
    const r = parseSpec(fixture.replace("  - owner: alice\n", ""));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({
      code: "missing-attribute",
      path: "AC-1.owner",
      line: lineOf("- AC-1:"),
    });
  });

  it("accepts a minimal spec: only a goal", () => {
    const spec = parseOk(MIN);
    expect(spec.goal?.text).toBe("Be tiny.");
    expect(spec.acceptance).toEqual([]);
    expect(spec.sections).toEqual(["Goal"]);
    expect(spec.frontmatter.retired_ids).toEqual([]);
  });

  it("leaves cardinality to lint: no goal, two goals' absence is not a parse error", () => {
    const noGoal = parseOk(MIN.replace("## Goal\n\n- GOAL: Be tiny.\n", ""));
    expect(noGoal.goal).toBeNull();
  });

  it("accepts superseded with its target, and proposed", () => {
    const sup = parseOk(
      MIN.replace(
        "status: draft",
        "status: superseded\nsuperseded_by: next-spec",
      ),
    );
    expect(sup.frontmatter).toMatchObject({
      status: "superseded",
      superseded_by: "next-spec",
    });
    expect(
      parseOk(MIN.replace("status: draft", "status: proposed")).frontmatter
        .status,
    ).toBe("proposed");
  });

  it("accepts CRLF line breaks and a byte order mark", () => {
    const crlf = MIN.replace(/\n/g, "\r\n");
    expect(parseOk(crlf)).toEqual(parseOk(MIN));
    expect(parseOk(BOM + MIN)).toEqual(parseOk(MIN));
  });

  it("accepts a title line before the first section and rejects other text there", () => {
    expect(
      parseOk(MIN.replace("## Goal", "# A title\n\n## Goal")).goal,
    ).not.toBeNull();
    expect(errorsOf(MIN.replace("## Goal", "prose\n\n## Goal"))).toEqual([
      "unexpected-line @ $",
    ]);
    expect(errorsOf(MIN.replace("## Goal", "#NoSpace\n\n## Goal"))).toEqual([
      "unexpected-line @ $",
    ]);
  });

  it("accepts sections in any order", () => {
    const text = `${MIN}
## Acceptance

- AC-1: x
  - source: SL-1
  - owner: a
`;
    const swapped =
      text.replace(/## Goal[\s\S]*?(?=## Acceptance)/, "") +
      "\n## Goal\n\n- GOAL: Be tiny.\n";
    expect(parseOk(swapped).sections).toEqual(["Acceptance", "Goal"]);
  });

  it("does not depend on Context prose", () => {
    const strip = (s: Spec) =>
      JSON.stringify(s, (key, value: unknown) =>
        key === "line" ? undefined : value,
      );
    const base = parseOk(fixture);
    const contexts = [
      "",
      "Plain words.",
      "- AC-1: hijack\n  - source: SL-9\n  - owner: eve",
      "```\n- GOAL: second\n```",
      "```npm test``` runs the suite.",
      " ## Acceptance criteria\n- AC-9: hidden in prose",
      "Acceptance criteria\n----------\n- AC-9: hidden in prose",
      "```\nnever closed\n- AC-9: x",
      "### Sub heading\n\n- GOAL: not a goal\n\n    - paths: nowhere\n",
      "<!-- - AC-5: hidden -->",
      "- [ ] a task list item\n- DC-9: note",
    ];
    for (const context of contexts) {
      const text = fixture.replace(
        /## Context\n[\s\S]*?(?=\n## Acceptance)/,
        `## Context\n\n${context}\n`,
      );
      expect(strip(parseOk(text)), context).toBe(strip(base));
    }
  });

  it("ends Context at a column-0 '## ' line even inside what looks like a code block", () => {
    for (const fence of ["```", "~~~", "````"]) {
      const text = fixture.replace(
        "### A deeper heading is fine here",
        `${fence}\n## Bogus\n${fence}\n\n### A deeper heading`,
      );
      expect(errorsOf(text), fence).toEqual([
        "unknown-section @ section.Bogus",
      ]);
    }
    const known = fixture.replace(
      "### A deeper heading is fine here",
      "```\n## Defaults\n```\n",
    );
    expect(errorsOf(known)).toContain("duplicate-section @ section.Defaults");
  });

  it("reads every section after a Context line that looks like a fence opener", () => {
    for (const name of [
      "context-inline-backticks",
      "context-open-fence-lookalike",
    ]) {
      const spec = parseOk(readFixture(name));
      expect(spec.ids, name).toEqual(["GOAL", "NG-1", "DF-1", "RS-1"]);
      expect(spec.sections, name).toEqual([
        "Goal",
        "Non-goals",
        "Context",
        "Defaults",
        "Residuals",
      ]);
      expect(spec.residuals[0], name).toMatchObject({
        class: "divergence",
        status: "open",
      });
    }
  });

  it("refuses an indented or setext heading with a known title in Context, and reads one with other words as prose", () => {
    for (const name of [
      "context-lookalike-indented-heading",
      "context-lookalike-setext-heading",
    ]) {
      const text = fs.readFileSync(
        fileURLToPath(
          new URL(
            `../fixtures/formats/spec/invalid/${name}.md`,
            import.meta.url,
          ),
        ),
        "utf8",
      );
      expect(errorsOf(text), name).toEqual([
        "context-heading-lookalike @ section.Acceptance",
      ]);
      // With one more word the same line is prose, and the real section
      // below is read.
      const spec = parseOk(text.replace("Acceptance\n", "Acceptance notes\n"));
      expect(spec.ids, name).toEqual(["GOAL", "NG-1", "DF-1", "RS-1", "AC-1"]);
      expect(
        spec.acceptance.map((a) => [a.id, a.owner]),
        name,
      ).toEqual([["AC-1", "alice"]]);
    }
  });

  it("does not lose a line that sits under a real heading after a fence in Context", () => {
    const text = fixture.replace(
      "### A deeper heading is fine here",
      "```\nunclosed\n",
    );
    const spec = parseOk(text);
    expect(spec.acceptance.map((a) => a.id)).toEqual(["AC-1", "AC-2"]);
    expect(spec.defaults).toHaveLength(2);
  });

  it("stops reading below an unknown heading but still reads later known ones", () => {
    const text = fixture.replace(
      "## Residuals",
      "## Evidence\n\n- AC-8: smuggled\n  - source: SL-1\n  - owner: x\n\n## Residuals",
    );
    expect(errorsOf(text)).toEqual(["unknown-section @ section.Evidence"]);
  });

  it("allows only the heading title exactly", () => {
    for (const heading of [
      "## goal",
      "## Goal ",
      "## Source Ledger",
      "## GOAL",
    ]) {
      const text = MIN.replace("## Goal", heading);
      const codes = errorsOf(text);
      if (heading === "## Goal ") expect(codes, heading).toEqual([]);
      else
        expect(codes, heading).toContain(
          "unknown-section @ section." + heading.slice(2).trim(),
        );
    }
  });

  it("rejects a retired ID that is live and keeps retired IDs that are not", () => {
    expect(errorsOf(fixture.replace("[AC-9, NG-4]", "[NG-1]"))).toEqual([
      "retired-id-live @ NG-1",
    ]);
    expect(errorsOf(fixture.replace("[AC-9, NG-4]", "[]"))).toEqual([]);
    expect(
      errorsOf(fixture.replace("[AC-9, NG-4]", "[TP-1, QN-3, SL-9]")),
    ).toEqual([]);
  });

  it("rejects the same ID twice in one file, in any sections", () => {
    expect(errorsOf(fixture.replace("- NG-2: Login", "- NG-1: Login"))).toEqual(
      ["duplicate-id @ NG-1"],
    );
  });

  it("takes only text on one line and trims it", () => {
    const spec = parseOk(
      MIN.replace("- GOAL: Be tiny.", "- GOAL:    Be tiny.   "),
    );
    expect(spec.goal?.text).toBe("Be tiny.");
  });

  it("keeps a colon inside the text", () => {
    const spec = parseOk(MIN.replace("Be tiny.", "Be tiny: really."));
    expect(spec.goal?.text).toBe("Be tiny: really.");
  });

  it("rejects an oversized input without reading it", () => {
    const r = parseSpec(`---\n${"x".repeat(MAX_INPUT_LENGTH + 1)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toEqual(["input-too-large"]);
  });

  it("returns errors instead of throwing for hostile input", () => {
    for (const text of [
      "",
      "---",
      "---\n---\n",
      "\0",
      "---\n{{{\n---\n",
      "- AC-1:",
      "\n\n\n",
    ]) {
      expect(() => parseSpec(text)).not.toThrow();
      expect(parseSpec(text).ok).toBe(false);
    }
  });

  it("requires both an item text and a goal text", () => {
    expect(errorsOf(MIN.replace("- GOAL: Be tiny.", "- GOAL:"))).toEqual([
      "empty-value @ GOAL.text",
    ]);
  });

  it("rejects attributes on a goal", () => {
    expect(errorsOf(MIN + "  - owner: x\n")).toEqual([
      "unknown-attribute @ GOAL.owner",
    ]);
  });

  it("accepts only true and false as affects_behavior", () => {
    for (const bad of ["yes", "no", "True", "False", "1", "0", "maybe"]) {
      expect(
        errorsOf(
          fixture.replace("affects_behavior: true", `affects_behavior: ${bad}`),
        ),
        bad,
      ).toEqual(["invalid-value @ DF-1.affects_behavior"]);
    }
  });

  it("puts every bad NG path on the paths line", () => {
    const r = parseSpec(
      fixture.replace(
        "paths: src/auth/token.ts, src/auth/**",
        "paths: ../a, /b",
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => [e.code, e.path, e.line])).toEqual([
      ["invalid-value", "NG-1.paths", lineOf("  - paths:")],
      ["invalid-value", "NG-1.paths", lineOf("  - paths:")],
    ]);
  });

  it("accepts a decision provenance without a url and every channel", () => {
    for (const channel of ANSWER_CHANNELS) {
      const text = fixture
        .replace("channel: comment", `channel: ${channel}`)
        .replace(
          "    - comment_url: https://example.com/issues/1#comment-2\n",
          "",
        );
      expect(
        parseOk(text).decisions[0]!.provenance.comment_url,
        channel,
      ).toBeUndefined();
    }
  });

  it("accepts a residual with and without a question and each class and status", () => {
    for (const cls of OPEN_POINT_CLASSES) {
      for (const status of ["open", "resolved"]) {
        const text = fixture
          .replace("class: blind-spot", `class: ${cls}`)
          .replace("status: open", `status: ${status}`)
          .replace("  - question: QN-2\n", "");
        const r = parseOk(text).residuals[0]!;
        expect([r.class, r.status, r.question]).toEqual([
          cls,
          status,
          undefined,
        ]);
      }
    }
  });

  it("accepts only source/meta.json as the frontmatter source", () => {
    expect(SPEC_SOURCE_PATH).toBe("source/meta.json");
    expect(parseOk(fixture).frontmatter.source).toBe("source/meta.json");
    for (const other of [
      "other/meta.json",
      "source/meta.json/",
      "/source/meta.json",
      "source/../source/meta.json",
      "meta.json",
    ]) {
      expect(
        errorsOf(
          fixture.replace("source: source/meta.json", `source: ${other}`),
        ),
        other,
      ).toEqual(["invalid-value @ frontmatter.source"]);
    }
  });

  it("uses comment_url for a decision's link, as an answer record does", () => {
    const spec = parseOk(fixture);
    expect(spec.decisions[0]!.provenance.comment_url).toBe(
      "https://example.com/issues/1#comment-2",
    );
    expect(
      errorsOf(fixture.replace("    - comment_url:", "    - url:")),
    ).toEqual(["unknown-attribute @ DC-1.provenance.url"]);
  });

  it("rejects control, zero-width and bidirectional characters in item text and attribute values", () => {
    const chars = [
      "\u0000",
      "\u0007",
      "\u001b",
      "\u007f",
      "\u200b",
      "\u200c",
      "\u200d",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ];
    for (const ch of chars) {
      const label = `U+${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      expect(
        errorsOf(fixture.replace("- NG-2: Login", `- NG-2: Lo${ch}gin`)),
        label,
      ).toEqual(["forbidden-character @ NG-2.text"]);
      expect(
        errorsOf(fixture.replace("owner: alice", `owner: al${ch}ice`)),
        label,
      ).toEqual(["forbidden-character @ AC-1.owner"]);
      expect(
        errorsOf(
          fixture.replace("    - author: alice", `    - author: al${ch}ice`),
        ),
        label,
      ).toEqual(["forbidden-character @ DC-1.provenance.author"]);
    }
  });

  it("rejects a lone carriage return and a line separator inside an item line", () => {
    const cr = errorsOf(fixture.replace("- NG-2: Login", "- NG-2: Lo\rgin"));
    expect(cr).toContain("forbidden-character @ NG-2.text");
    expect(
      errorsOf(fixture.replace("- NG-2: Login", "- NG-2: Lo\u2029gin")).length,
    ).toBeGreaterThan(0);
  });

  it("accepts a tab and ordinary non-ASCII text inside item text", () => {
    expect(
      errorsOf(
        fixture.replace("- NG-2: Login", "- NG-2: Lo\tgin \u00e9\u4e2d"),
      ),
    ).toEqual([]);
    for (const ch of ["\u2010", "\u00a0", "\u2009", "\u0301", "\u4e2d"]) {
      expect(
        errorsOf(fixture.replace("- NG-2: Login", `- NG-2: Lo${ch}gin`)),
        ch.charCodeAt(0).toString(16),
      ).toEqual([]);
    }
  });

  it("checks Context for forbidden characters like any other section", () => {
    expect(
      errorsOf(fixture.replace("Free prose.", "Free \u202e prose.")),
    ).toEqual(["forbidden-character @ $"]);
    expect(
      errorsOf(fixture.replace("Free prose.", "Free \u00e9\u4e2d\tprose.")),
    ).toEqual([]);
  });
});

// ------------------------------------------------- characters on every line

const cp = (n: number) => String.fromCodePoint(n);
const label = (n: number) =>
  `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

/** Code points of every refused category; none of them is a line feed. */
const REFUSED = [
  // Cc
  0x0000, 0x0007, 0x000b, 0x000c, 0x000d, 0x001b, 0x007f, 0x0085, 0x009f,
  // Cf
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200d, 0x200e, 0x202a, 0x202e, 0x2060,
  0x2066, 0xfeff, 0xe0001,
  // Zl, Zp
  0x2028, 0x2029,
  // Cs: a high and a low surrogate, each without its partner
  0xd800, 0xdc00,
];

/** The errors of a parse as `[code, path, line]`. */
function located(text: string): [string, string, number | undefined][] {
  const r = parseSpec(text);
  return r.ok ? [] : r.errors.map((e) => [e.code, e.path, e.line]);
}

/** 1-based line of the first line of `text` that contains `needle`. */
function lineWith(text: string, needle: string): number {
  return text.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

/**
 * A spec whose Context is followed by two more sections. With the two real
 * headings it has a default and an open divergence; a heading line that is
 * not a heading for the parser would leave both as Context prose.
 */
function withSections(defaultsHeading: string, residualsHeading: string) {
  return `${MIN}
## Non-goals

- NG-1: Nothing else changes.

## Context

Some prose about the request.

${defaultsHeading}

- DF-1: A default.
  - reason: because
  - affects_behavior: true

${residualsHeading}

- RS-1: Something open.
  - class: divergence
  - status: open
`;
}

describe("spec.md: the character rule on every line", () => {
  it("reads both sections when the headings are plain", () => {
    const spec = parseOk(withSections("## Defaults", "## Residuals"));
    expect(spec.ids).toEqual(["GOAL", "NG-1", "DF-1", "RS-1"]);
    expect(spec.residuals[0]).toMatchObject({
      class: "divergence",
      status: "open",
    });
  });

  it.each([
    ["a zero-width space before the hashes", `${cp(0x200b)}## Defaults`],
    ["a byte order mark before the hashes", `${cp(0xfeff)}## Defaults`],
    ["a soft hyphen before the hashes", `${cp(0x00ad)}## Defaults`],
    ["a right-to-left override before the hashes", `${cp(0x202e)}## Defaults`],
    ["a line separator before the hashes", `${cp(0x2028)}## Defaults`],
    ["a zero-width space between the hashes", `#${cp(0x200b)}# Defaults`],
    ["a word joiner after the hashes", `##${cp(0x2060)} Defaults`],
    ["a lone carriage return before the hashes", "\r## Defaults"],
    ["a lone surrogate before the hashes", "\ud800## Defaults"],
  ])("refuses a Context line that reads as a heading: %s", (_name, heading) => {
    // Two rules see the line: the character rule, and the rule against a
    // line that reads like a known heading.
    const text = withSections(heading, "## Residuals");
    const line = lineWith(text, "Defaults");
    expect(located(text)).toEqual([
      ["forbidden-character", "$", line],
      ["context-heading-lookalike", "section.Defaults", line],
    ]);
  });

  it("reports each such line when two headings are hidden that way", () => {
    const text = withSections(
      `${cp(0x200b)}## Defaults`,
      `${cp(0x200b)}## Residuals`,
    );
    expect(lineWith(text, "Defaults")).toBe(21);
    expect(located(text)).toEqual([
      ["forbidden-character", "$", 21],
      ["context-heading-lookalike", "section.Defaults", 21],
      ["forbidden-character", "$", 27],
      ["context-heading-lookalike", "section.Residuals", 27],
    ]);
  });

  it.each([
    ["before the hashes", (c: string) => `${c}## Defaults`],
    ["between the hashes", (c: string) => `#${c}# Defaults`],
    ["after the hashes", (c: string) => `##${c} Defaults`],
    ["inside the title", (c: string) => `## Def${c}aults`],
  ])("refuses every category in a Context line, %s", (_name, build) => {
    for (const n of REFUSED) {
      const text = withSections(build(cp(n)), "## Residuals");
      const errors = located(text);
      expect(errors, label(n)).toContainEqual([
        "forbidden-character",
        "$",
        lineWith(text, "aults"),
      ]);
      expect(
        errors.filter((e) => e[0] === "forbidden-character"),
        label(n),
      ).toHaveLength(1);
    }
  });

  it("refuses a character at the end of a real heading line", () => {
    // These three are removed by trimming the title, so the heading is
    // still read as the section it names.
    for (const n of [0xfeff, 0x000b, 0x000c]) {
      for (const title of ["Goal", "Non-goals", "Context", "Residuals"]) {
        const text = withSections("## Defaults", "## Residuals").replace(
          `## ${title}\n`,
          `## ${title}${cp(n)}\n`,
        );
        expect(located(text), `${title} ${label(n)}`).toEqual([
          ["forbidden-character", "$", lineWith(text, `## ${title}`)],
        ]);
      }
    }
    // Any other one also makes the title unknown.
    for (const n of [0x200b, 0x202e, 0x00ad]) {
      const errors = located(MIN.replace("## Goal\n", `## Goal${cp(n)}\n`));
      expect(errors, label(n)).toContainEqual(["forbidden-character", "$", 9]);
      expect(
        errors.map((e) => e[0]),
        label(n),
      ).toContain("unknown-section");
    }
  });

  it("refuses a line that holds nothing but a character trimming removes", () => {
    for (const n of [0xfeff, 0x000b, 0x000c, 0x2028, 0x2029]) {
      const c = cp(n);
      // Between two items of a section.
      expect(located(`${MIN}${c}\n- GOAL: Twice.\n`), label(n)).toContainEqual([
        "forbidden-character",
        "$",
        12,
      ]);
      // As the last line of the file, with and without a line feed.
      expect(located(`${MIN}${c}\n`), label(n)).toEqual([
        ["forbidden-character", "$", 12],
      ]);
      expect(located(`${MIN}${c}`), label(n)).toEqual([
        ["forbidden-character", "$", 12],
      ]);
      // Before the first section.
      expect(
        located(MIN.replace("## Goal", `${c}\n\n## Goal`)),
        label(n),
      ).toEqual([["forbidden-character", "$", 9]]);
      // In Context.
      const inContext = fixture.replace("Free prose.", `Free prose.\n${c}`);
      expect(located(inContext), label(n)).toEqual([
        ["forbidden-character", "$", lineOf("Free prose.") + 1],
      ]);
    }
  });

  it("refuses a character below an unknown heading, where no line is read", () => {
    const text = `${MIN}\n## Bogus\n\n- AC-1: te${cp(0x200b)}xt\n`;
    expect(located(text)).toEqual([
      ["unknown-section", "section.Bogus", 13],
      ["forbidden-character", "$", 15],
    ]);
  });

  it("reports a Context line at the document, even when it is shaped like an item", () => {
    const text = fixture.replace(
      "- AC-77: this line",
      `- AC-77: th${cp(0x200b)}is line`,
    );
    expect(located(text)).toEqual([
      ["forbidden-character", "$", lineOf("- AC-77")],
    ]);
  });

  it("reports every Context line that holds one, each once", () => {
    const text = fixture.replace(
      "Free prose.",
      `Free${cp(0x200b)} prose${cp(0x200b)}.\nMore${cp(0x202e)} prose.\nClean.\nLast${cp(0x2060)}.`,
    );
    const first = lineOf("Free prose.");
    expect(located(text)).toEqual([
      ["forbidden-character", "$", first],
      ["forbidden-character", "$", first + 1],
      ["forbidden-character", "$", first + 3],
    ]);
  });

  it("names the code point in the message", () => {
    const r = parseSpec(
      fixture.replace("Free prose.", `Free ${cp(0xe0041)} prose.`),
    );
    expect(r.ok === false && r.errors[0]!.message).toContain("U+E0041");
  });

  it("checks the frontmatter lines, comments included", () => {
    expect(
      located(MIN.replace("status: draft", "status: draft # a comment")),
    ).toEqual([]);
    // A comment that a viewer may show as one more line of frontmatter.
    expect(
      located(
        MIN.replace(
          "status: draft",
          `status: draft # see${cp(0x2028)}retired_ids: [AC-3]`,
        ),
      ),
    ).toEqual([["forbidden-character", "frontmatter", 6]]);
    for (const n of REFUSED) {
      expect(
        located(MIN.replace("id: tiny\n", `id: tiny\n# no${cp(n)}te\n`)),
        label(n),
      ).toEqual([["forbidden-character", "frontmatter", 3]]);
    }
  });

  it("reports a character written into a frontmatter value once, at its line", () => {
    expect(located(MIN.replace("id: tiny", `id: "ti${cp(0x200b)}ny"`))).toEqual(
      [["forbidden-character", "frontmatter", 2]],
    );
    // An escape sequence is clean text; the decoded value is not.
    expect(located(MIN.replace("id: tiny", 'id: "ti\\u200bny"'))).toEqual([
      ["forbidden-character", "frontmatter.id", undefined],
    ]);
  });

  it("refuses a carriage return that is not part of a line end, in the frontmatter and at the end of the file", () => {
    expect(located(MIN.replace(/\n/g, "\r\n"))).toEqual([]);
    // The first and the last frontmatter line.
    expect(located(MIN.replace("id: tiny\n", "id: tiny\r\r\n"))).toEqual([
      ["forbidden-character", "frontmatter", 2],
    ]);
    expect(
      located(MIN.replace("status: draft\n", "status: draft\r\r\n")),
    ).toEqual([["forbidden-character", "frontmatter", 6]]);
    // The item line no longer fits the grammar either; the character is
    // reported on its own.
    expect(located(`${MIN.trimEnd()}\r`)).toContainEqual([
      "forbidden-character",
      "GOAL.text",
      11,
    ]);
  });

  it("accepts ordinary non-ASCII text and tabs in Context, the title, items and frontmatter comments", () => {
    const text = readFixture("context-non-ascii");
    // The fixture really holds these; an editor has not replaced them.
    for (const n of [0x00a0, 0x3000, 0x0009, 0x0301, 0x1f600, 0x65e5]) {
      expect(text.includes(cp(n)), label(n)).toBe(true);
    }
    const spec = parseOk(text);
    expect(spec.ids).toEqual(["GOAL", "NG-1"]);
    expect(spec.sections).toEqual(["Goal", "Context", "Non-goals"]);
    expect(
      located(MIN.replace("status: draft", "status: draft # Grüße 日本語\t.")),
    ).toEqual([]);
  });
});

// ------------------------------------------- heading lookalikes in Context

const LIKE = "context-heading-lookalike";

/** 1-based line of the first line of `text` that is exactly `line`. */
function lineThatIs(text: string, line: string): number {
  return text.split("\n").indexOf(line) + 1;
}

/** A known title in fullwidth letters. */
const fullwidth = (word: string) =>
  [...word].map((ch) => cp(ch.charCodeAt(0) + 0xfee0)).join("");

/**
 * Characters that render blank or not at all. The first two are plain; the
 * character rule refuses none of them.
 */
const BLANKS: [string, string][] = [
  ["a space", " "],
  ["a tab", "\t"],
  ["a no-break space (U+00A0)", cp(0x00a0)],
  ["an ideographic space (U+3000)", cp(0x3000)],
  ["a hair space (U+200A)", cp(0x200a)],
  ["a variation selector (U+FE0F)", cp(0xfe0f)],
  ["a combining grapheme joiner (U+034F)", cp(0x034f)],
  ["a Hangul filler (U+3164)", cp(0x3164)],
  ["a private-use character (U+E000)", cp(0xe000)],
];

const POSITIONS = [
  ["before the hashes", (c: string) => `${c}## Defaults`],
  ["between the hashes", (c: string) => `#${c}# Defaults`],
  ["in place of the space after the hashes", (c: string) => `##${c}Defaults`],
  ["inside the title", (c: string) => ` ## Def${c}aults`],
  ["after the title", (c: string) => ` ## Defaults${c}`],
] as const;

/** Every blank at every position, except the one combination that is the real heading. */
const BLANK_CASES: [string, string][] = POSITIONS.flatMap(([where, build]) =>
  BLANKS.filter(([, c]) => build(c) !== "## Defaults").map(
    ([what, c]) => [`${what} ${where}`, build(c)] as [string, string],
  ),
);

/** The result of a spec in which the line under test stayed Context prose. */
function expectProse(text: string): void {
  const spec = parseOk(text);
  expect(spec.sections).toEqual(["Goal", "Non-goals", "Context", "Residuals"]);
  expect(spec.ids).toEqual(["GOAL", "NG-1", "RS-1"]);
}

describe("spec.md: a Context line that reads like a known heading", () => {
  it("has one combination per blank and position, less the real heading", () => {
    expect(BLANK_CASES).toHaveLength(BLANKS.length * POSITIONS.length - 1);
  });

  it.each(BLANK_CASES)("refuses %s", (_name, heading) => {
    const text = withSections(heading, "## Residuals");
    expect(located(text)).toEqual([
      [LIKE, "section.Defaults", lineWith(text, "aults")],
    ]);
  });

  it.each([
    ["indented by one space", " ## Defaults"],
    ["indented by three spaces", "   ## Defaults"],
    ["indented by four spaces", "    ## Defaults"],
    ["indented by a tab", "\t## Defaults"],
    ["without the space after the hashes", "##Defaults"],
    ["with one hash and no space", "#Defaults"],
    [
      "with fullwidth number signs and a fullwidth letter",
      `${cp(0xff03)}${cp(0xff03)} ${cp(0xff24)}efaults`,
    ],
    [
      "with the whole title in fullwidth letters",
      ` ## ${fullwidth("Defaults")}`,
    ],
    ["with small number signs", `${cp(0xfe5f)}${cp(0xfe5f)} Defaults`],
    ["with a mathematical bold letter", ` ## ${cp(0x1d403)}efaults`],
    ["in lower case", " ## defaults"],
    ["in upper case", " ## DEFAULTS"],
    ["in mixed case without a space", "##dEfAuLtS"],
    ["with closing hashes", " ## Defaults ##"],
    ["with closing hashes and no spaces", "###Defaults###"],
    ["with a colon", " ## Defaults:"],
    ["in bold", " ## **Defaults**"],
    ["with a number", " ## 2. Defaults"],
    ["in a block quote", "> ## Defaults"],
    ["in a list item", "- ## Defaults"],
  ])("refuses a heading %s", (_name, heading) => {
    const text = withSections(heading, "## Residuals");
    expect(located(text)).toEqual([
      [LIKE, "section.Defaults", lineThatIs(text, heading)],
    ]);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "refuses an indented heading of %i hashes",
    (count) => {
      const heading = ` ${"#".repeat(count)} Defaults`;
      const text = withSections(heading, "## Residuals");
      expect(located(text)).toEqual([
        [LIKE, "section.Defaults", lineThatIs(text, heading)],
      ]);
    },
  );

  it.each([1, 3, 4, 5, 6])(
    "refuses a column-0 heading of %i hashes, which does not end Context",
    (count) => {
      const heading = `${"#".repeat(count)} Defaults`;
      const text = withSections(heading, "## Residuals");
      expect(located(text)).toEqual([
        [LIKE, "section.Defaults", lineThatIs(text, heading)],
      ]);
    },
  );

  it.each([...SPEC_SECTION_TITLES])(
    "refuses an indented heading and an underlined line for the title %s",
    (title) => {
      const atx = withSections(`  ## ${title}`, "## Residuals");
      expect(located(atx)).toEqual([
        [LIKE, `section.${title}`, lineThatIs(atx, `  ## ${title}`)],
      ]);
      const setext = withSections(`${title}\n---`, "## Residuals");
      expect(located(setext)).toEqual([
        [LIKE, `section.${title}`, lineThatIs(setext, title)],
      ]);
    },
  );

  it.each([
    ["a row of hyphens", "----------"],
    ["one hyphen", "-"],
    ["a row of equals signs", "=========="],
    ["one equals sign", "="],
    ["hyphens with spaces around them", "  ---  "],
    ["hyphens after a tab", "\t---"],
    ["hyphens after a no-break space", `${cp(0x00a0)}---`],
    ["hyphens before an ideographic space", `---${cp(0x3000)}`],
    ["fullwidth hyphens", cp(0xff0d).repeat(3)],
    ["fullwidth equals signs", cp(0xff1d).repeat(3)],
    ["hyphens after a variation selector", `${cp(0xfe0f)}---`],
    ["hyphens after a Hangul filler", `${cp(0x3164)}---`],
    ["hyphens after a Braille blank", `${cp(0x2800)}---`],
    ["hyphens after a private-use character", `${cp(0xe000)}---`],
    ["hyphens with spaces between them", "- - -"],
  ])("refuses a known title over %s", (_name, underline) => {
    const text = withSections(`Defaults\n${underline}`, "## Residuals");
    expect(located(text)).toEqual([
      [LIKE, "section.Defaults", lineThatIs(text, "Defaults")],
    ]);
  });

  it.each([
    ["indented", "  Defaults"],
    ["in upper case", "DEFAULTS"],
    ["in bold", "**Defaults**"],
    ["with a colon", "Defaults:"],
    ["after a no-break space", `${cp(0x00a0)}Defaults`],
    ["after a variation selector", `${cp(0xfe0f)}Defaults`],
    ["in fullwidth letters", fullwidth("Defaults")],
  ])("refuses an underlined title %s", (_name, title) => {
    const text = withSections(`${title}\n=====`, "## Residuals");
    expect(located(text)).toEqual([
      [LIKE, "section.Defaults", lineThatIs(text, title)],
    ]);
  });

  it.each([
    ["an indented heading with other words", " ## notes on goals"],
    ["an indented heading with a plural", " ## Goals"],
    ["an indented heading with part of a title", " ## Default"],
    ["an indented heading with a title and more", " ## Defaults and decisions"],
    ["seven hashes, which is no heading", "####### Defaults"],
    ["seven hashes, indented", " ####### Defaults"],
    ["hashes inside a sentence", "The ## Defaults marker is described below."],
    ["hashes after the title only", "Defaults ##"],
    ["a deeper heading with other words", "### Open points"],
    ["a title alone, with a blank line below", "Defaults"],
    ["a title with a blank line before the hyphens", "Defaults\n\n----------"],
    ["a title over mixed hyphens and equals signs", "Defaults\n-=-=-=-="],
    ["a title over a list item", "Defaults\n- a first point"],
    [
      "a title over a list item in another script",
      `Defaults\n- ${cp(0x76ee)}${cp(0x6a19)}`,
    ],
    ["a title over a list item that is a digit", `Defaults\n- ${cp(0x0663)}`],
    [
      "a title over hyphens after an unassigned code point",
      `Defaults\n${cp(0xfdd0)}---`,
    ],
    ["a title over hyphens and a word", "Defaults\n--- and more"],
    [
      "other words over a line that is no underline",
      "Goal-setting matters\nand so does the next line.",
    ],
    ["other words over hyphens", "Goal-setting matters\n--------------------"],
  ])("leaves prose alone: %s", (_name, lines) => {
    expectProse(withSections(lines, "## Residuals"));
  });

  it.each([
    [
      "a title with a Cyrillic letter that looks like a Latin one",
      `${cp(0x00a0)}## D${cp(0x0435)}faults`,
    ],
    ["a title with a capital I for a small l", " ## DefauIts"],
    [
      "an unknown title after a no-break space",
      `${cp(0x00a0)}## Open questions`,
    ],
    ["a title over box-drawing lines", `Defaults\n${cp(0x2500).repeat(5)}`],
    ["a title over long dashes", `Defaults\n${cp(0x2014).repeat(3)}`],
    ["a title over underscores", "Defaults\n_______"],
  ])("does not recognise, as documented: %s", (_name, lines) => {
    expectProse(withSections(lines, "## Residuals"));
  });

  it("leaves prose alone in the fixture of heading-like prose", () => {
    const text = readFixture("context-heading-like-prose");
    for (const line of [
      " ## notes on goals",
      "####### Goal",
      "Goal-setting matters",
      "Goal",
      "-=-=-=-=",
    ]) {
      expect(lineThatIs(text, line), line).toBeGreaterThan(0);
    }
    expectProse(text);
  });

  it("accepts a known title as the last line of the file, where no line follows", () => {
    for (const last of ["Defaults", "Goal", "prose"]) {
      const spec = parseOk(`${MIN}\n## Context\n\n${last}`);
      expect(spec.sections, last).toEqual(["Goal", "Context"]);
    }
  });

  it("keeps the handling of real column-0 headings", () => {
    // The heading that starts Context.
    expect(parseOk(`${MIN}\n## Context\n\nprose\n`).sections).toEqual([
      "Goal",
      "Context",
    ]);
    // A known heading ends Context and is read.
    expect(parseOk(withSections("## Defaults", "## Residuals")).ids).toEqual([
      "GOAL",
      "NG-1",
      "DF-1",
      "RS-1",
    ]);
    // A second Context heading and an unknown heading are what they were.
    expect(located(`${MIN}\n## Context\n\nprose\n\n## Context\n`)).toEqual([
      ["duplicate-section", "section.Context", 17],
    ]);
    expect(located(`${MIN}\n## Context\n\n## notes on goals\n`)).toEqual([
      ["unknown-section", "section.notes on goals", 15],
    ]);
  });

  it("applies in Context only: elsewhere such a line keeps its own error", () => {
    // In a normative section.
    expect(located(`${MIN} ## Defaults\n`)).toEqual([
      ["unexpected-line", "$", 12],
    ]);
    // Before the first section.
    expect(located(MIN.replace("## Goal", " ## Defaults\n\n## Goal"))).toEqual([
      ["unexpected-line", "$", 9],
    ]);
    // Below an unknown heading, where no line is read.
    expect(
      located(`${MIN}\n## Bogus\n\n ## Defaults\nDefaults\n---\n`),
    ).toEqual([["unknown-section", "section.Bogus", 13]]);
  });

  it("names the section and how to write its heading in the message", () => {
    const r = parseSpec(withSections(" ## Source ledger", "## Residuals"));
    expect(r.ok === false && r.errors[0]!.message).toContain(
      "write '## Source ledger' at column 0",
    );
  });
});

describe("heading lookalike helpers", () => {
  it.each([
    [" ## Non-goals ", "##nongoals"],
    ["Source ledger", "sourceledger"],
    [`${cp(0xff03)}${cp(0xff03)} ${fullwidth("Goal")}`, "##goal"],
    ["#1 Goal!", "#goal"],
    [`${cp(0x65e5)}${cp(0x672c)}`, ""],
    ["", ""],
  ])("reduces %j to %j", (text, reduced) => {
    expect(reduceHeadingText(text)).toBe(reduced);
  });

  it("does not turn a letter of another script into an ASCII letter", () => {
    // A Cyrillic letter that looks like a Latin one is dropped, not mapped.
    expect(reduceHeadingText(`G${cp(0x043e)}al`)).toBe("gal");
    expect(
      contextHeadingLookalike(` ## G${cp(0x043e)}al`, undefined),
    ).toBeNull();
  });

  it("names the title for both shapes and nothing otherwise", () => {
    expect(contextHeadingLookalike("  ## Goal", undefined)).toBe("Goal");
    expect(contextHeadingLookalike("  ## source LEDGER", "x")).toBe(
      "Source ledger",
    );
    expect(contextHeadingLookalike("Goal", "---")).toBe("Goal");
    expect(contextHeadingLookalike("Goal", "===")).toBe("Goal");
    expect(contextHeadingLookalike("Goal", undefined)).toBeNull();
    expect(contextHeadingLookalike("Goal", "")).toBeNull();
    expect(contextHeadingLookalike("Goal", "text")).toBeNull();
    expect(contextHeadingLookalike("Goals", "---")).toBeNull();
    expect(contextHeadingLookalike("## Goals", "---")).toBeNull();
  });
});
