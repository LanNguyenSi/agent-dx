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

  it("keeps braces that are not an identifier in braces", () => {
    expect(
      codes({
        commands: {
          c: {
            argv: [
              "tool",
              '--a={"b":1}',
              "{}",
              "{1}",
              "{a b}",
              "x{y}",
              "{a-b}",
            ],
          },
        },
      }),
    ).toEqual([]);
  });

  it("rejects any whole element of the form {name} other than {selector}", () => {
    for (const element of [
      "{file}",
      "{select}",
      "{Selector}",
      "{SELECTOR}",
      "{ selector }",
      "{selector }",
      "{ file }",
      "{_x1}",
    ]) {
      expect(
        codes({ discovery, commands: { c: { argv: ["a", element] } } }),
        element,
      ).toEqual(["unknown-placeholder @ commands.c.argv[1]"]);
    }
  });

  it("rejects an unknown placeholder in the discovery command and as the program", () => {
    expect(
      codes({
        discovery: { argv: ["list", "{name}"] },
        commands: { c: { argv: ["a"] } },
      }),
    ).toEqual(["unknown-placeholder @ discovery.argv[1]"]);
    expect(codes({ commands: { c: { argv: ["{name}"] } } })).toEqual([
      "unknown-placeholder @ commands.c.argv[0]",
    ]);
  });

  it("rejects case and spacing variants of {selector} inside a longer element as embedded", () => {
    for (const element of [
      "--x={Selector}",
      "--x={ selector }",
      "{SELECTOR}x",
    ]) {
      expect(
        codes({ discovery, commands: { c: { argv: ["a", element] } } }),
        element,
      ).toEqual(["selector-embedded @ commands.c.argv[1]"]);
    }
  });

  it("rejects a variant of {selector} in the discovery command as a selector there", () => {
    expect(
      codes({
        discovery: { argv: ["list", "{Selector}"] },
        commands: { c: { argv: ["a"] } },
      }),
    ).toEqual(["selector-in-discovery @ discovery.argv[1]"]);
  });

  it("allows at most one command that uses {selector}", () => {
    const two = {
      discovery,
      commands: {
        unit: { argv: ["a", "{selector}"] },
        other: { argv: ["b"] },
        e2e: { argv: ["c", "{selector}"] },
        third: { argv: ["d", "{selector}"] },
      },
    };
    expect(codes(two)).toEqual([
      "multiple-selector-commands @ commands.e2e",
      "multiple-selector-commands @ commands.third",
    ]);
    const one = {
      discovery,
      commands: { unit: { argv: ["a", "{selector}"] }, other: { argv: ["b"] } },
    };
    expect(codes(one)).toEqual([]);
    expect(
      codes({
        discovery,
        commands: { a: { argv: ["x"] }, b: { argv: ["y"] } },
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
