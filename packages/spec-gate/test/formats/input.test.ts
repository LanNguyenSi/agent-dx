import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_INPUT_LENGTH,
  parseBindings,
  parseCommandSet,
  parseConfig,
  parseJsonText,
  parseSpec,
  parseTestPlan,
  parseYamlText,
} from "../../src/formats/index.js";

function yamlErr(text: string): string {
  const r = parseYamlText(text);
  if (r.ok) throw new Error("expected an error");
  return r.errors[0]!.code;
}

describe("YAML input settings", () => {
  it("keeps yes, no, on and off as strings and timestamps as strings", () => {
    const r = parseYamlText(
      "a: yes\nb: no\nc: on\nd: off\ne: 2000-01-31\nf: 2000-01-31T12:00:00Z\ng: true\n",
    );
    expect(r).toEqual({
      ok: true,
      value: {
        a: "yes",
        b: "no",
        c: "on",
        d: "off",
        e: "2000-01-31",
        f: "2000-01-31T12:00:00Z",
        g: true,
      },
    });
  });

  it("rejects duplicate keys, also nested", () => {
    expect(yamlErr("a: 1\na: 2\n")).toBe("duplicate-key");
    expect(yamlErr("a:\n  b: 1\n  b: 2\n")).toBe("duplicate-key");
  });

  it("rejects an anchor, an alias and either alone", () => {
    expect(yamlErr("a: &x 1\nb: *x\n")).toBe("yaml-alias");
    expect(yamlErr("a: &x 1\n")).toBe("yaml-alias");
  });

  it("rejects explicit tags, standard or custom", () => {
    expect(yamlErr("a: !!str 1\n")).toBe("yaml-tag");
    expect(yamlErr("a: !custom x\n")).toBe("yaml-tag");
    expect(yamlErr("a: !!binary aGk=\n")).toBe("yaml-tag");
  });

  it("does not merge a merge key", () => {
    expect(parseYamlText("<<: {a: 1}\nb: 2\n")).toEqual({
      ok: true,
      value: { "<<": { a: 1 }, b: 2 },
    });
  });

  it("rejects more than one document and an empty document", () => {
    expect(yamlErr("a: 1\n---\nb: 2\n")).toBe("invalid-yaml");
    expect(yamlErr("")).toBe("empty-document");
    expect(yamlErr("# comment only\n")).toBe("empty-document");
    expect(yamlErr("~\n")).toBe("empty-document");
    expect(yamlErr("null\n")).toBe("empty-document");
  });

  it("reports a syntax error with its line", () => {
    const r = parseYamlText("a: 1\nb: [2\n");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe("invalid-yaml");
      expect(r.errors[0]!.line).toBeGreaterThan(0);
    }
  });

  it("accepts a block scalar and a flow list", () => {
    expect(parseYamlText("a: |\n  x\n  y\nb: [1, 2]\n")).toEqual({
      ok: true,
      value: { a: "x\ny\n", b: [1, 2] },
    });
  });

  it("rejects an input over the size limit", () => {
    expect(yamlErr(`a: ${"x".repeat(MAX_INPUT_LENGTH)}`)).toBe(
      "input-too-large",
    );
    expect(parseYamlText(`a: ${"x".repeat(1000)}`).ok).toBe(true);
  });
});

describe("JSON input settings", () => {
  const jsonErr = (text: string): string => {
    const r = parseJsonText(text);
    if (r.ok) throw new Error("expected an error");
    return r.errors[0]!.code;
  };

  it("parses strict JSON", () => {
    expect(parseJsonText('{"a": [1, null, "x"]}')).toEqual({
      ok: true,
      value: { a: [1, null, "x"] },
    });
  });

  it("rejects what JSON.parse rejects, YAML-isms included", () => {
    expect(jsonErr("{a: 1}")).toBe("invalid-json");
    expect(jsonErr("{'a': 1}")).toBe("invalid-json");
    expect(jsonErr('{"a": 1,}')).toBe("invalid-json");
    expect(jsonErr("")).toBe("invalid-json");
    expect(jsonErr("{} {}")).toBe("invalid-json");
  });

  it("rejects duplicate keys, also nested and inside arrays", () => {
    expect(jsonErr('{"a": 1, "a": 2}')).toBe("duplicate-key");
    expect(jsonErr('{"a": {"b": 1, "b": 2}}')).toBe("duplicate-key");
    expect(jsonErr('[{"a": 1, "a": 2}]')).toBe("duplicate-key");
  });

  it("rejects an input over the size limit", () => {
    expect(jsonErr(`"${"x".repeat(MAX_INPUT_LENGTH)}"`)).toBe(
      "input-too-large",
    );
  });
});

describe("YAML entry points never throw and never write to stderr", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function parseFrontmatter(text: string) {
    return parseSpec(`---\n${text}\n---\n`);
  }

  const entryPoints: [
    string,
    (
      | typeof parseConfig
      | typeof parseTestPlan
      | typeof parseBindings
      | typeof parseCommandSet
      | typeof parseSpec
      | typeof parseYamlText
    ),
  ][] = [
    ["config", parseConfig],
    ["testplan", parseTestPlan],
    ["bindings", parseBindings],
    ["commands", parseCommandSet],
    ["spec frontmatter", parseFrontmatter],
    ["yaml text", parseYamlText],
  ];

  const hostile = [
    ["a lone alias", "a: *x"],
    ["a lone alias as the document", "*x"],
    ["an alias in a list", "- *x"],
    ["an alias as a key", "*x : 1"],
    ["a collection key", "? [a]\n: b"],
    ["a mapping as a key", "? {a: 1}\n: b"],
    ["an anchor on a key", "&k a: 1"],
    ["an unknown tag", "a: !custom x"],
    ["a tag on a key", "!custom a: 1"],
  ];

  for (const [name, parse] of entryPoints) {
    for (const [label, text] of hostile) {
      it(`${name}: ${label} gives a result`, () => {
        const err = vi.spyOn(process.stderr, "write");
        const warn = vi.spyOn(process, "emitWarning");
        let result: { ok: boolean } | undefined;
        expect(() => {
          result = parse(text);
        }).not.toThrow();
        expect(result?.ok).toBe(false);
        expect(err).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      });
    }
  }

  it("reports a lone alias as yaml-alias and a collection key as invalid-yaml", () => {
    const alias = parseYamlText("a: *x");
    expect(alias.ok === false && alias.errors[0]!.code).toBe("yaml-alias");
    const key = parseYamlText("? [a]\n: b");
    expect(key.ok === false && key.errors[0]!.code).toBe("invalid-yaml");
  });

  it("puts the line of an alias in the error", () => {
    const r = parseYamlText("a: 1\nb: *x\n");
    expect(r.ok === false && r.errors[0]!.line).toBe(2);
  });
});

describe("duplicate keys are found with one pass", () => {
  it("finds a duplicate among many keys, YAML and JSON", () => {
    const n = 30_000;
    const yaml = Array.from({ length: n }, (_, i) => `k${i}: 1`).join("\n");
    expect(parseYamlText(yaml).ok).toBe(true);
    const dup = parseYamlText(`${yaml}\nk17: 2`);
    expect(dup.ok === false && dup.errors[0]!.code).toBe("duplicate-key");
    const json = `{${Array.from({ length: n }, (_, i) => `"k${i}": 1`).join(",")}}`;
    expect(parseJsonText(json).ok).toBe(true);
    const jdup = parseJsonText(json.slice(0, -1) + ',"k17": 2}');
    expect(jdup.ok === false && jdup.errors[0]!.code).toBe("duplicate-key");
  });

  it('compares keys the way the resulting object does: 1 and "1" collide', () => {
    const r = parseYamlText('1: a\n"1": b\n');
    expect(r.ok === false && r.errors[0]!.code).toBe("duplicate-key");
  });

  it("reports the line of the second key", () => {
    const r = parseYamlText("a: 1\nb: 2\na: 3\n");
    expect(r.ok === false && r.errors[0]).toMatchObject({
      code: "duplicate-key",
      line: 3,
    });
  });

  it("does not use the library's quadratic check", () => {
    // 'uniqueKeys' is off; the walk in input.ts is the only duplicate check.
    // A document the library would reject as a duplicate must still be
    // rejected, with this module's own message.
    const r = parseYamlText("a: 1\na: 2\n");
    expect(r.ok === false && r.errors[0]!.message).toBe(
      'duplicate mapping key "a"',
    );
  });
});
