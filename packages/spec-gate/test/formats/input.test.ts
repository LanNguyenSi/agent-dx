import { describe, expect, it } from "vitest";
import {
  MAX_INPUT_LENGTH,
  parseJsonText,
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
