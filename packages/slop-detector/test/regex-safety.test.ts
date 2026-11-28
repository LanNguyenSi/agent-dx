import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  MAX_GLOB_WILDCARDS,
  MAX_OUTER_REPEAT,
  MAX_REGEX_LENGTH,
  countWildcards,
  findRegexSafetyProblem,
} from "../src/util/regex-safety.js";
import { globToRegex } from "../src/util/file-kind.js";
import { checkText } from "../src/engine.js";
import { loadConfig, mergeConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

// Every scratch directory a test creates is removed again by its own path.
const scratchDirs: string[] = [];
function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("findRegexSafetyProblem", () => {
  describe("refuses nested quantifiers", () => {
    const refused: Array<[string, string]> = [
      ["a repeated group around a plus", "(a+)+"],
      ["a repeated group around a star", "(a*)*"],
      ["a dot star inside a plus group followed by more", "(.*)+x"],
      ["a word run with an optional space under a plus", "(\\w+\\s?)+$"],
      ["a group nested in a repeated group", "((ab)+)+"],
      ["an open-ended brace count under a plus", "(?:a{2,})+"],
      ["a named group", "(?<word>a+)+"],
      ["a lookahead body", "(?=a+)+"],
      ["an alternation branch with a repeat", "(a+|b)+"],
      ["a lazy inner repeat", "(a+?)+"],
      ["a lazy outer repeat", "(a+)+?"],
      ["a bounded variable range under a plus", "(a{1,16})+x"],
      ["a bounded variable range on a dot under a plus", "(.{1,16})+x"],
      ["a two-way range under a plus", "(a{1,2})+x"],
      ["a variable range under a star", "(a{0,3})*x"],
      ["two optional atoms under a plus", "(a?a?)+x"],
      ["a literal then an optional atom under a plus", "(aa?)+x"],
      ["two optional dots under a plus", "(.?.?)+x"],
      ["an optional atom with a delimiter under a plus", "(a?b)+"],
      ["a lazy optional atom under a plus", "(a??b)+"],
      ["a lookahead holding an optional atom", "(?=a?)+"],
      ["the literal outer bound plus one", "(a+){3}x"],
      [
        "an open repeat under a count above the outer bound",
        `(a+){${MAX_OUTER_REPEAT + 1}}x`,
      ],
      ["an open repeat under a large count", "(a+){16}x"],
      [
        "an open repeat under a range above the outer bound",
        `(a+){1,${MAX_OUTER_REPEAT + 1}}`,
      ],
      ["a repeat after an escaped bracket in a class", "([\\]a]+)+"],
      ["a repeat reached through a closed sibling group", "(x(a+)y)*"],
    ];
    it.each(refused)("%s: %s", (_label, pattern) => {
      expect(findRegexSafetyProblem(pattern)).toEqual({
        kind: "nested-quantifier",
      });
    });
  });

  describe("a group opener does not hide a later nested quantifier", () => {
    // The opener `?...` is skipped; a wrong skip would jump to the `:` (or,
    // for a lookbehind, the `>`) at the end and miss the refused group before
    // it.
    const openers: Array<[string, string]> = [
      ["a lookahead", "(?=a)(b+)+:"],
      ["a negative lookahead", "(?!a)(b+)+:"],
      ["a lookbehind", "(?<=a)(b+)+>"],
      ["a negative lookbehind", "(?<!a)(b+)+>"],
      ["a named group", "(?<n>a)(b+)+:"],
      ["a plain group", "(a)(b+)+:"],
      ["a modifier group", "(?i:a)(b+)+:"],
      ["a modifier group that is itself repeated", "(?i:a+)+"],
      // The body starts right after the `:`; a skip one character too far
      // would swallow the inner `(` and lose the group that holds the repeat.
      ["a modifier group whose body opens with a group", "(?i:(a+))+"],
    ];
    it.each(openers)("%s: %s", (_label, pattern) => {
      expect(findRegexSafetyProblem(pattern)).toEqual({
        kind: "nested-quantifier",
      });
    });
  });

  it("refuses a numbered backreference", () => {
    expect(findRegexSafetyProblem("(a)\\1")).toEqual({ kind: "backreference" });
  });

  it("refuses the highest numbered backreference, \\9", () => {
    expect(findRegexSafetyProblem("(a)(b)(c)(d)(e)(f)(g)(h)(i)\\9")).toEqual({
      kind: "backreference",
    });
  });

  it("refuses a named backreference", () => {
    expect(findRegexSafetyProblem("(?<n>a)\\k<n>")).toEqual({
      kind: "backreference",
    });
  });

  it("pins the documented lengths: 512 characters pass, 513 do not", () => {
    expect(findRegexSafetyProblem("a".repeat(512))).toBeNull();
    expect(findRegexSafetyProblem("a".repeat(513))).toEqual({
      kind: "too-long",
    });
  });

  it("refuses a pattern over the length cap and accepts one at the cap", () => {
    expect(findRegexSafetyProblem("a".repeat(MAX_REGEX_LENGTH + 1))).toEqual({
      kind: "too-long",
    });
    expect(findRegexSafetyProblem("a".repeat(MAX_REGEX_LENGTH))).toBeNull();
  });

  describe("accepts safe shapes", () => {
    const accepted: Array<[string, string]> = [
      ["adjacent repeats", "a+b+"],
      ["a repeated plain group", "(ab)+"],
      ["a plus inside a character class", "[a+]+"],
      ["an escaped class bracket inside a class", "[\\]a+]+"],
      ["an escaped bracket in a class inside a repeated group", "([\\]+])+"],
      ["a class holding repeat characters inside a repeated group", "([a+*])+"],
      ["a class holding a plus inside a repeated group", "([+])+"],
      ["a class holding parentheses", "[(]a+[)]"],
      ["escaped parentheses", "\\(a+\\)+"],
      ["a repeated alternation of literals", "(a|b)*"],
      ["a small bounded group repeat", "(a){1,3}"],
      [
        "an open repeat under a range up to the outer bound",
        `(a+){1,${MAX_OUTER_REPEAT}}`,
      ],
      ["a zero-or-one group around a plus", "(a+)?"],
      [
        "an open repeat under a count at the outer bound",
        `(a+){${MAX_OUTER_REPEAT}}`,
      ],
      ["a fixed count under a plus", "(?:a{2})+"],
      ["a lazy fixed count under a plus", "(?:a{2}?)+"],
      ["a named group opener under a plus", "(?<name>ab)+"],
      ["a modifier group opener under a plus", "(?i:ab)+"],
      ["a lookahead opener under a star", "(?=ab)*c"],
      ["a negative lookbehind opener without a repeat", "(?<!a)b+"],
      ["a literal count at the outer bound", "(a+){2}x"],
      ["a fixed count under a fixed count", "(a{2}){3}"],
      ["a fixed-width dotted-quad shape", "(\\d{3}\\.){3}"],
      ["an escaped plus then a plus", "\\++"],
      ["a literal brace that is not a quantifier", "(a+){x}"],
      ["a repeat after the group closed", "(a+)b+"],
      ["a non-capturing group without a repeat", "(?:a+b)c"],
      ["a lookbehind without a repeat", "(?<=a+)b"],
    ];
    // Modifier groups such as (?i:...) compile only on newer engines (not on
    // Node 22); the scanner verdict is engine-independent, so the compile
    // check is skipped where the engine rejects the syntax.
    let modifierGroupsCompile = true;
    try {
      new RegExp("(?i:a)");
    } catch {
      modifierGroupsCompile = false;
    }
    it.each(accepted)("%s: %s", (_label, pattern) => {
      if (modifierGroupsCompile || !pattern.startsWith("(?i:")) {
        expect(() => new RegExp(pattern)).not.toThrow();
      }
      expect(findRegexSafetyProblem(pattern)).toBeNull();
    });
  });

  it("accepts every pattern in the repo's own config files", () => {
    for (const name of ["slop.config.yml", "slop.bundle.config.yml"]) {
      const cfg = YAML.parse(
        fs.readFileSync(path.join(repoRoot, name), "utf8"),
      );
      const patterns: string[] = [
        ...(cfg.placement?.markers ?? []),
        ...(cfg.placement?.allow ?? []),
        ...(cfg.review?.allow ?? []),
      ];
      for (const p of patterns) {
        expect(findRegexSafetyProblem(p), `${name}: ${p}`).toBeNull();
      }
    }
  });

  it("loads the repo's own config files unchanged", () => {
    for (const name of ["slop.config.yml", "slop.bundle.config.yml"]) {
      expect(() => loadConfig(path.join(repoRoot, name))).not.toThrow();
    }
  });

  it("accepts every regex example in the package docs", () => {
    const docsDir = path.join(packageRoot, "docs");
    const fence = /```ya?ml\n([\s\S]*?)```/g;
    let seen = 0;
    for (const name of fs.readdirSync(docsDir)) {
      if (!name.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(docsDir, name), "utf8");
      for (const m of text.matchAll(fence)) {
        let doc: unknown;
        try {
          doc = YAML.parse(m[1]);
        } catch {
          continue;
        }
        const cfg = doc as {
          placement?: { markers?: string[]; allow?: string[] };
          review?: { allow?: string[] };
        } | null;
        const patterns = [
          ...(cfg?.placement?.markers ?? []),
          ...(cfg?.placement?.allow ?? []),
          ...(cfg?.review?.allow ?? []),
        ];
        for (const p of patterns) {
          seen++;
          expect(findRegexSafetyProblem(p), `${name}: ${p}`).toBeNull();
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("globs", () => {
  it("collapses a run of `**/` into one", () => {
    expect(globToRegex("**/**/**/x").source).toBe(globToRegex("**/x").source);
  });

  it("keeps the meaning of a collapsed glob", () => {
    const re = globToRegex("**/**/x");
    expect(re.test("x")).toBe(true);
    expect(re.test("a/b/x")).toBe(true);
    expect(re.test("a/b/y")).toBe(false);
    expect(re.test("a/SUBx")).toBe(false);
  });

  it("does not merge `**/` segments that a literal separates", () => {
    expect(globToRegex("a/**/b/**/c").source).not.toBe(
      globToRegex("a/**/b/c").source,
    );
    expect(globToRegex("a/**/b/**/c").test("a/x/b/y/z/c")).toBe(true);
  });

  it("pins the documented cap: 8 wildcards load, 9 do not", () => {
    const eight = "a*b*c*d*e*f*g*h*i";
    const nine = "a*b*c*d*e*f*g*h*i*j";
    expect(countWildcards(eight)).toBe(8);
    expect(countWildcards(nine)).toBe(9);
    expect(load(`treatAsProse:\n  - "${eight}"\n`)).not.toThrow();
    expect(load(`treatAsProse:\n  - "${nine}"\n`)).toThrow(
      /more than 8 wildcards/,
    );
  });

  it("counts wildcards the way globToRegex reads them", () => {
    expect(countWildcards("src/foo.ts")).toBe(0);
    expect(countWildcards("src/*.ts")).toBe(1);
    expect(countWildcards("**/a/**/b/**")).toBe(3);
    expect(countWildcards("****")).toBe(2);
    expect(countWildcards("***")).toBe(2);
    expect(countWildcards("*a*a*")).toBe(3);
  });

  const stacked = (n: number, wildcard: string) =>
    Array.from({ length: n }, () => wildcard).join("a");
  // Each case is [label, a glob over the cap, a glob at the cap].
  const capCases: Array<[string, string, string]> = [
    [
      "double stars",
      stacked(MAX_GLOB_WILDCARDS + 1, "**"),
      stacked(MAX_GLOB_WILDCARDS, "**"),
    ],
    [
      "single stars",
      stacked(MAX_GLOB_WILDCARDS + 1, "*"),
      stacked(MAX_GLOB_WILDCARDS, "*"),
    ],
    [
      "mixed stars",
      `${stacked(MAX_GLOB_WILDCARDS / 2, "*")}a${stacked(MAX_GLOB_WILDCARDS / 2 + 1, "**")}`,
      `${stacked(MAX_GLOB_WILDCARDS / 2, "*")}a${stacked(MAX_GLOB_WILDCARDS / 2, "**")}`,
    ],
  ];

  const fields: Array<[string, (glob: string) => string]> = [
    ["entrypointGlobs", (g) => `entrypointGlobs:\n  - "${g}"\n`],
    [
      "placement.instructionGlobs",
      (g) => `placement:\n  instructionGlobs:\n    - "${g}"\n`,
    ],
    ["review.allowPaths", (g) => `review:\n  allowPaths:\n    - "${g}"\n`],
    ["treatAsProse", (g) => `treatAsProse:\n  - "${g}"\n`],
    ["treatAsCode", (g) => `treatAsCode:\n  - "${g}"\n`],
    ["ignorePaths", (g) => `ignorePaths:\n  - "${g}"\n`],
  ];

  function load(yaml: string) {
    const tmp = scratchDir("slop-glob-");
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, yaml);
    return () => loadConfig(file);
  }

  describe.each(fields)("%s", (field, make) => {
    it.each(capCases)("refuses too many wildcards: %s", (_label, over) => {
      const run = load(make(over));
      // The zod issue list is JSON, so the quoted text appears escaped.
      const named = JSON.stringify(
        `${field} pattern has more than ${MAX_GLOB_WILDCARDS} wildcards ("*" or "**"): "${over}"`,
      ).slice(1, -1);
      expect(run).toThrow(named);
    });

    it.each(capCases)("accepts a glob at the cap: %s", (_label, _over, at) => {
      expect(load(make(at))).not.toThrow();
    });
  });
});

describe("regex patterns at config load", () => {
  const refused = [
    "(a+)+",
    "(a*)*",
    "(.*)+x",
    "(\\w+\\s?)+$",
    "((ab)+)+",
    "(?:a{2,})+",
    "(.{1,16})+x",
    "(a{1,2})+x",
    "(a+){16}x",
    "(a?a?)+x",
    "(aa?)+x",
  ];
  const fields: Array<[string, (p: string) => string]> = [
    [
      "placement.markers",
      (p) => `placement:\n  markers:\n    - ${JSON.stringify(p)}\n`,
    ],
    [
      "placement.allow",
      (p) => `placement:\n  allow:\n    - ${JSON.stringify(p)}\n`,
    ],
    ["review.allow", (p) => `review:\n  allow:\n    - ${JSON.stringify(p)}\n`],
  ];

  function load(yaml: string) {
    const tmp = scratchDir("slop-rx-");
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, yaml);
    return () => loadConfig(file);
  }

  function messageOf(run: () => unknown): string {
    try {
      run();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected loadConfig to throw");
  }

  describe.each(fields)("%s", (field, make) => {
    it.each(refused)(
      "refuses %s with a message naming the field and the pattern",
      (pattern) => {
        const msg = messageOf(load(make(pattern)));
        expect(msg).toContain(
          `Regular expression in ${field} can backtrack without bound (nested quantifier): `,
        );
        // The zod issue list is JSON, so the quoted pattern appears escaped.
        expect(msg).toContain(JSON.stringify(`"${pattern}"`).slice(1, -1));
        expect(msg.match(/can backtrack without bound/g)).toHaveLength(1);
      },
    );

    it("refuses a backreference", () => {
      const msg = messageOf(load(make("(a)\\1")));
      expect(msg).toContain(
        `Regular expression in ${field} uses a backreference, which can backtrack without bound: `,
      );
    });

    it("refuses a pattern over the length cap", () => {
      const msg = messageOf(load(make("a".repeat(MAX_REGEX_LENGTH + 1))));
      expect(msg).toContain(
        `Regular expression in ${field} is longer than ${MAX_REGEX_LENGTH} characters (${MAX_REGEX_LENGTH + 1})`,
      );
    });

    it("accepts safe patterns", () => {
      for (const p of [
        "a+b+",
        "(ab)+",
        "[a+]+",
        "\\(a+\\)+",
        "(a|b)*",
        "(a){1,3}",
      ]) {
        // `(a|b)*` and `(a){1,3}` need a non-empty anchor to avoid the
        // separate empty-match refusal.
        const safe =
          p === "(a|b)*" ? "(a|b)*c" : p === "(a){1,3}" ? "(a){1,3}c" : p;
        expect(load(make(safe)), safe).not.toThrow();
      }
    });
  });

  it("does not add a nested-quantifier message to a pattern that does not compile", () => {
    const msg = messageOf(load(make1("((a+)+")));
    expect(msg).toContain("Invalid regular expression in placement config");
    expect(msg).not.toContain("can backtrack");
  });

  function make1(p: string) {
    return `placement:\n  markers:\n    - ${JSON.stringify(p)}\n`;
  }

  it("reports a nested-quantifier pattern that also matches the empty string once", () => {
    const msg = messageOf(load(make1("(a*)*")));
    expect(msg.match(/can backtrack without bound/g)).toHaveLength(1);
    expect(msg).not.toContain("matches the empty string");
    expect(msg.match(/Regular expression in/g)).toHaveLength(1);
  });

  it("reports a backreference pattern that also matches the empty string once", () => {
    const msg = messageOf(load(make1("(a*)\\1")));
    expect(msg).toContain("uses a backreference");
    expect(msg).not.toContain("matches the empty string");
    expect(msg.match(/Regular expression in/g)).toHaveLength(1);
  });

  it("reports an over-long pattern that also matches the empty string once", () => {
    const long = "a?".repeat(MAX_REGEX_LENGTH);
    const msg = messageOf(load(make1(long)));
    expect(msg).toContain("is longer than");
    expect(msg).not.toContain("matches the empty string");
    expect(msg.match(/Regular expression in/g)).toHaveLength(1);
  });

  it("reports a nested-quantifier empty-matching pattern once in placement.allow", () => {
    const msg = messageOf(
      load(`placement:\n  allow:\n    - ${JSON.stringify("(a*)*")}\n`),
    );
    expect(msg).toContain("(nested quantifier)");
    expect(msg).not.toContain("matches the empty string");
    expect(msg.match(/Regular expression in/g)).toHaveLength(1);
  });

  it("accepts a safe non-empty pattern", () => {
    expect(load(make1("a+b"))).not.toThrow();
  });

  it("still reports the empty-match refusal for a safe pattern that matches nothing", () => {
    const msg = messageOf(load(make1("a*")));
    expect(msg).toContain("matches the empty string");
    expect(msg).not.toContain("can backtrack");
  });
});

describe("an accepted shape stays fast on a long adversarial line", () => {
  // The structural check cannot rule out every slow shape (see the module
  // header), so this pins that an accepted nested-safe pattern runs through
  // each pack on a 10,000-character line without blowing up. The pattern is
  // anchored, so a failed match costs one linear pass per pack run (a few
  // milliseconds in total) and the ceiling sits far above any loaded
  // machine. An unanchored alternation repeat would be quadratic here, and
  // an exponential shape would not finish at all; those are refused at load
  // before any pack runs them, which the last test pins.
  const CEILING_MS = 5000;
  const line = "ab".repeat(5000);
  const shape = "^(a|b)+c";

  it("placement.markers", () => {
    const config = mergeConfig({ placement: { markers: [shape] } });
    const t0 = performance.now();
    const v = checkText(line, "x/AGENTS.md", {
      packs: allPacks,
      config,
      packFilter: ["placement-slop"],
    });
    expect(performance.now() - t0).toBeLessThan(CEILING_MS);
    expect(v).toHaveLength(0);
  });

  it("placement.allow", () => {
    const config = mergeConfig({
      placement: { markers: ["ab"], allow: [shape] },
    });
    const t0 = performance.now();
    checkText(line, "x/AGENTS.md", {
      packs: allPacks,
      config,
      packFilter: ["placement-slop"],
    });
    expect(performance.now() - t0).toBeLessThan(CEILING_MS);
  });

  it("review.allow", () => {
    const config = mergeConfig({ review: { allow: [shape] } });
    const t0 = performance.now();
    checkText(`${line} F1`, "docs/NOTES.md", {
      packs: allPacks,
      config,
      packFilter: ["review-slop"],
    });
    expect(performance.now() - t0).toBeLessThan(CEILING_MS);
  });

  it("a refused pattern never reaches a pack: loadConfig fails first", () => {
    const tmp = scratchDir("slop-rx-");
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(
      file,
      `placement:\n  markers:\n    - "(a|b+)*c"\n  allow:\n    - "(.*)*x"\n`,
    );
    expect(() => loadConfig(file)).toThrow(/nested quantifier/);
  });
});
