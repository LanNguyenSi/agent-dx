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
  parseSpec,
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
      " ## Acceptance\n- AC-9: hidden in prose",
      "Acceptance\n----------\n- AC-9: hidden in prose",
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

  it("treats an indented or setext heading in Context as prose and parses the real section below", () => {
    for (const name of ["context-indented-heading", "context-setext-heading"]) {
      const spec = parseOk(readFixture(name));
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
    for (const ch of ["\u2010", "\u2060", "\u2065", "\u206a"]) {
      expect(
        errorsOf(fixture.replace("- NG-2: Login", `- NG-2: Lo${ch}gin`)),
        ch.charCodeAt(0).toString(16),
      ).toEqual([]);
    }
  });

  it("does not check Context for forbidden characters", () => {
    expect(
      errorsOf(fixture.replace("Free prose.", "Free \u202e prose.")),
    ).toEqual([]);
  });
});
