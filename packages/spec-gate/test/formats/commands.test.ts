import { describe, expect, it } from "vitest";
import {
  SELECTOR_PLACEHOLDER,
  parseCommandSet,
  validateCommandSet,
} from "../../src/formats/index.js";

function codes(doc: unknown): string[] {
  const r = validateCommandSet(doc);
  return r.ok ? [] : r.errors.map((e) => `${e.code} @ ${e.path}`);
}

const discovery = { argv: ["list"] };

describe("commands.yaml", () => {
  it("uses the literal placeholder {selector}", () => {
    expect(SELECTOR_PLACEHOLDER).toBe("{selector}");
  });

  it("returns entries in file order with their selector use", () => {
    const r = validateCommandSet({
      discovery,
      commands: {
        unit: { argv: ["npx", "vitest", "run", "-t", "{selector}"] },
        lint: { argv: ["npm", "run", "lint"] },
      },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        discovery: ["list"],
        commands: [
          {
            name: "unit",
            argv: ["npx", "vitest", "run", "-t", "{selector}"],
            usesSelector: true,
          },
          { name: "lint", argv: ["npm", "run", "lint"], usesSelector: false },
        ],
      },
    });
  });

  it("accepts the placeholder as a whole element in any position but the first, and more than once", () => {
    for (const argv of [
      ["a", "{selector}"],
      ["a", "{selector}", "b"],
      ["a", "{selector}", "{selector}"],
    ]) {
      expect(
        codes({ discovery, commands: { c: { argv } } }),
        argv.join(" "),
      ).toEqual([]);
    }
  });

  it("rejects the placeholder inside a longer element, before, after or around it", () => {
    for (const element of [
      "--grep={selector}",
      "x{selector}",
      "{selector}x",
      "{{selector}}",
      " {selector}",
      "{selector} ",
    ]) {
      expect(
        codes({ discovery, commands: { c: { argv: ["a", element] } } }),
        element,
      ).toEqual(["selector-embedded @ commands.c.argv[1]"]);
    }
  });

  it("rejects the placeholder as the program", () => {
    expect(
      codes({ discovery, commands: { c: { argv: ["{selector}"] } } }),
    ).toEqual(["selector-as-program @ commands.c.argv[0]"]);
  });

  it("keeps braces that are not the placeholder", () => {
    expect(
      codes({
        commands: {
          c: { argv: ["tool", "{file}", '--a={"b":1}', "{select}"] },
        },
      }),
    ).toEqual([]);
  });

  it("requires a discovery command once a command uses the placeholder, and not before", () => {
    expect(codes({ commands: { c: { argv: ["a", "{selector}"] } } })).toEqual([
      "discovery-required @ discovery",
    ]);
    expect(codes({ commands: { c: { argv: ["a"] } } })).toEqual([]);
    expect(codes({ discovery, commands: { c: { argv: ["a"] } } })).toEqual([]);
    expect(
      codes({ discovery, commands: { c: { argv: ["a", "{selector}"] } } }),
    ).toEqual([]);
  });

  it("keeps discovery out of the output when it is absent", () => {
    const r = validateCommandSet({ commands: { c: { argv: ["a"] } } });
    expect(r.ok && "discovery" in r.value).toBe(false);
  });

  it("rejects the placeholder in the discovery command, even embedded", () => {
    for (const element of ["{selector}", "x{selector}"]) {
      expect(
        codes({
          discovery: { argv: ["list", element] },
          commands: { c: { argv: ["a"] } },
        }),
        element,
      ).toEqual(["selector-in-discovery @ discovery.argv[1]"]);
    }
  });

  it("rejects a shell string wherever an argv list belongs", () => {
    expect(codes({ commands: { c: "npm test" } })).toEqual([
      "shell-string @ commands.c",
    ]);
    expect(codes({ commands: { c: { argv: "npm test" } } })).toEqual([
      "shell-string @ commands.c.argv",
    ]);
    expect(
      codes({ discovery: "npm test", commands: { c: { argv: ["a"] } } }),
    ).toEqual(["shell-string @ discovery"]);
    expect(
      codes({
        discovery: { argv: "npm test" },
        commands: { c: { argv: ["a"] } },
      }),
    ).toEqual(["shell-string @ discovery.argv"]);
  });

  it("allows an empty string among the arguments but not as the program", () => {
    expect(
      codes({ commands: { c: { argv: ["tool", "--flag", ""] } } }),
    ).toEqual([]);
    expect(codes({ commands: { c: { argv: ["", "x"] } } })).toEqual([
      "empty-value @ commands.c.argv[0]",
    ]);
    expect(codes({ commands: { c: { argv: [" ", "x"] } } })).toEqual([
      "empty-value @ commands.c.argv[0]",
    ]);
  });

  it("accepts command names of lower-case letters, digits, dot, underscore and hyphen", () => {
    for (const name of ["a", "unit-1", "a.b_c", "0x"]) {
      expect(codes({ commands: { [name]: { argv: ["a"] } } }), name).toEqual(
        [],
      );
    }
    for (const name of ["A", "-a", "a b", ".a", "a/b", "a".repeat(65)]) {
      expect(
        codes({ commands: { [name]: { argv: ["a"] } } }).length,
        name,
      ).toBe(1);
    }
  });

  it("reports every bad entry", () => {
    expect(
      codes({
        commands: { a: { argv: [] }, b: "x", c: { argv: ["ok"] }, d: {} },
      }).sort(),
    ).toEqual([
      "empty-value @ commands.a.argv",
      "missing-field @ commands.d.argv",
      "shell-string @ commands.b",
    ]);
  });

  it("parses text", () => {
    expect(parseCommandSet("commands:\n  a:\n    argv: [x]\n").ok).toBe(true);
    expect(parseCommandSet("").ok).toBe(false);
  });
});
