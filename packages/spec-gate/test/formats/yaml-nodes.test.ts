/* The core no-unused-vars rule reports parameter names inside function types. */
/* eslint-disable no-unused-vars */
import { Document } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  isPlainValue,
  parseBindings,
  parseCommandSet,
  parseConfig,
  parseSpec,
  parseTestPlan,
  parseYamlText,
} from "../../src/formats/index.js";

type Position = "root" | "mapping value" | "sequence item" | "mapping key";
type Form =
  | "block mapping"
  | "flow mapping"
  | "block sequence"
  | "flow sequence"
  | "scalar";
type Decoration = "tag !!set" | "tag !!map" | "tag !custom" | "anchor";

const POSITIONS: Position[] = [
  "root",
  "mapping value",
  "sequence item",
  "mapping key",
];
const FORMS: Form[] = [
  "block mapping",
  "flow mapping",
  "block sequence",
  "flow sequence",
  "scalar",
];
const DECORATIONS: Decoration[] = [
  "tag !!set",
  "tag !!map",
  "tag !custom",
  "anchor",
];

const MARK: Record<Decoration, string> = {
  "tag !!set": "!!set",
  "tag !!map": "!!map",
  "tag !custom": "!custom",
  anchor: "&a",
};

const BODY: Record<Form, string[]> = {
  "block mapping": ["a:"],
  "flow mapping": ["{a}"],
  "block sequence": ["- a"],
  "flow sequence": ["[a, b]"],
  scalar: ["v"],
};

const isBlock = (form: Form) =>
  form === "block mapping" || form === "block sequence";

/** The text of one cell; `mark` is empty for the undecorated control. */
function build(position: Position, form: Form, mark: string): string {
  const lead = mark === "" ? "" : `${mark} `;
  const body = BODY[form];
  const block = isBlock(form);
  switch (position) {
    case "root":
      return block
        ? `${mark === "" ? "" : `${mark}\n`}${body.join("\n")}\n`
        : `${lead}${body[0]}\n`;
    case "mapping value":
      return block
        ? `k:${mark === "" ? "" : ` ${mark}`}\n${body.map((l) => `  ${l}`).join("\n")}\n`
        : `k: ${lead}${body[0]}\n`;
    case "sequence item":
      return block
        ? `-${mark === "" ? "" : ` ${mark}`}\n${body.map((l) => `  ${l}`).join("\n")}\n`
        : `- ${lead}${body[0]}\n`;
    case "mapping key":
      return block
        ? `?${mark === "" ? "" : ` ${mark}`}\n${body.map((l) => `  ${l}`).join("\n")}\n: v\n`
        : `${lead}${body[0]}: v\n`;
  }
}

/** An alias in each position. */
function aliasCell(position: Position): string {
  switch (position) {
    case "root":
      return "*x\n";
    case "mapping value":
      return "k: *x\n";
    case "sequence item":
      return "- *x\n";
    case "mapping key":
      return "*x : v\n";
  }
}

type Entry = (text: string) => { ok: boolean; errors?: { code: string }[] };

const frontmatter: Entry = (text) => parseSpec(`---\n${text}---\n`);

const ENTRY_POINTS: [string, Entry][] = [
  ["yaml text", parseYamlText],
  ["config", parseConfig],
  ["testplan", parseTestPlan],
  ["bindings", parseBindings],
  ["commands", parseCommandSet],
  ["spec frontmatter", frontmatter],
];

function firstCode(entry: Entry, text: string): string | undefined {
  const r = entry(text);
  return r.ok ? undefined : r.errors?.[0]?.code;
}

describe("every YAML node is checked, whatever its position and form", () => {
  it("controls: the undecorated cells parse (a collection key is the one rejection)", () => {
    for (const position of POSITIONS) {
      for (const form of FORMS) {
        const r = parseYamlText(build(position, form, ""));
        const collectionKey = position === "mapping key" && form !== "scalar";
        if (collectionKey) {
          expect(
            r.ok === false && r.errors[0]!.code,
            `${position} ${form}`,
          ).toBe("invalid-yaml");
        } else {
          expect(r.ok, `${position} ${form}`).toBe(true);
        }
      }
    }
  });

  for (const [name, entry] of ENTRY_POINTS) {
    describe(name, () => {
      for (const position of POSITIONS) {
        for (const form of FORMS) {
          for (const decoration of DECORATIONS) {
            const expected = decoration.startsWith("tag")
              ? "yaml-tag"
              : "yaml-alias";
            it(`${position}, ${form}, ${decoration} -> ${expected}`, () => {
              const text = build(position, form, MARK[decoration]);
              expect(firstCode(entry, text), text).toBe(expected);
            });
          }
        }
        it(`${position}, alias -> yaml-alias`, () => {
          const text = aliasCell(position);
          expect(firstCode(entry, text), text).toBe("yaml-alias");
        });
      }
    });
  }

  it("rejects a tag that decodes to a JavaScript Set at the root", () => {
    for (const text of ["!!set {a, b}\n", "!!set\n? a\n? b\n"]) {
      expect(parseYamlText(text).ok, text).toBe(false);
      expect(firstCode(parseConfig, text), text).toBe("yaml-tag");
      expect(firstCode(parseBindings, text), text).toBe("yaml-tag");
    }
  });

  it("rejects a tag or an anchor on a mapping, at the root and as a value or sequence item", () => {
    const cases: [Entry, string, string][] = [
      [parseConfig, "approvers: !!set {a, b}\n", "yaml-tag"],
      [parseConfig, "questions: !custom {warn_above: 3}\n", "yaml-tag"],
      [parseConfig, "!!map {approvers: [a]}\n", "yaml-tag"],
      [parseBindings, "TP-1: !foo\n  status: new\n", "yaml-tag"],
      [parseConfig, "questions: &q {warn_above: 3}\n", "yaml-alias"],
      [parseBindings, "TP-1: &a\n  status: new\n", "yaml-alias"],
      [parseTestPlan, "- &m {id: TP-1}\n", "yaml-alias"],
    ];
    for (const [entry, text, code] of cases) {
      expect(firstCode(entry, text), text).toBe(code);
    }
  });

  it("reports the first of several problems of the same rank", () => {
    const tags = parseYamlText("a: !x 1\nb: !y 2\n");
    expect(tags.ok === false && tags.errors[0]).toMatchObject({
      code: "yaml-tag",
      line: 1,
    });
    const mixed = parseYamlText("a: !x 1\nb: &z 2\n");
    expect(mixed.ok === false && mixed.errors[0]).toMatchObject({
      code: "yaml-tag",
      line: 1,
    });
    const later = parseYamlText("a: &z 1\nb: !x 2\n");
    expect(later.ok === false && later.errors[0]).toMatchObject({
      code: "yaml-alias",
      line: 1,
    });
  });

  it("reports a tag or alias before a duplicate or collection key, wherever they sit", () => {
    expect(firstCode(parseYamlText, "? [a]\n: b\nc: !x 1\n")).toBe("yaml-tag");
    expect(firstCode(parseYamlText, "a: 1\na: 2\nc: &z 1\n")).toBe(
      "yaml-alias",
    );
  });

  it("refuses a decoded value that is not plain data, even if the node check let it through", () => {
    const spy = vi
      .spyOn(Document.prototype, "toJS")
      .mockReturnValue(new Set(["a"]));
    try {
      const r = parseYamlText("a: 1\n");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.errors[0]!.code).toBe("yaml-tag");
    } finally {
      spy.mockRestore();
    }
    expect(parseYamlText("a: 1\n").ok).toBe(true);
  });

  it("pins yaml-alias for an alias used as a mapping key", () => {
    expect(firstCode(parseYamlText, "*x : 1\n")).toBe("yaml-alias");
    expect(firstCode(parseConfig, "*x : 1\n")).toBe("yaml-alias");
  });

  it("walks a document nested far deeper than the call stack allows", () => {
    const depth = 200_000;
    const text = `${"[".repeat(depth)}${"]".repeat(depth)}\n`;
    expect(() => parseYamlText(text)).not.toThrow();
    const alias = `${"[".repeat(depth)}*x${"]".repeat(depth)}\n`;
    expect(() => parseYamlText(alias)).not.toThrow();
  });
});

describe("isPlainValue, the second net", () => {
  class Thing {
    x = 1;
  }

  it("accepts plain objects, arrays, strings, numbers, booleans and null, nested", () => {
    for (const v of [
      null,
      "a",
      1,
      Number.NaN,
      Infinity,
      true,
      [],
      {},
      Object.create(null),
      { a: [1, { b: null }], c: "d" },
      [[[]]],
    ]) {
      expect(isPlainValue(v), typeof v).toBe(true);
    }
  });

  it("rejects every other type, at any depth", () => {
    const bad: unknown[] = [
      new Set([1]),
      new Map(),
      new Date(0),
      new Uint8Array(2),
      new Thing(),
      () => 1,
      undefined,
      1n,
      Symbol("s"),
      /x/,
    ];
    for (const v of bad) {
      expect(isPlainValue(v), String(typeof v)).toBe(false);
      expect(isPlainValue({ a: v }), "in object").toBe(false);
      expect(isPlainValue([1, [v]]), "in array").toBe(false);
    }
  });
});
