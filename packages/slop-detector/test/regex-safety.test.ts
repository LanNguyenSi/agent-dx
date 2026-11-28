import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  MAX_BOUNDED_REPEAT,
  MAX_GLOB_DOUBLE_STARS,
  MAX_REGEX_LENGTH,
  countDoubleStars,
  findRegexSafetyProblem,
} from "../src/util/regex-safety.js";
import { globToRegex } from "../src/util/file-kind.js";
import { checkText } from "../src/engine.js";
import { loadConfig, mergeConfig } from "../src/config.js";
import { allPacks } from "../src/packs/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

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
      ["a brace range above the bound", `(a{1,${MAX_BOUNDED_REPEAT + 1}})+`],
      ["a brace range above the bound on the outer group", "(a+){1,17}"],
      ["a repeat after an escaped bracket in a class", "([\\]a]+)+"],
      ["a repeat reached through a closed sibling group", "(x(a+)y)*"],
    ];
    it.each(refused)("%s: %s", (_label, pattern) => {
      expect(findRegexSafetyProblem(pattern)).toEqual({
        kind: "nested-quantifier",
      });
    });
  });

  it("refuses a numbered backreference", () => {
    expect(findRegexSafetyProblem("(a)\\1")).toEqual({ kind: "backreference" });
  });

  it("refuses a named backreference", () => {
    expect(findRegexSafetyProblem("(?<n>a)\\k<n>")).toEqual({
      kind: "backreference",
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
      ["a class holding repeat characters inside a repeated group", "([a+*])+"],
      ["a class holding a plus inside a repeated group", "([+])+"],
      ["a class holding parentheses", "[(]a+[)]"],
      ["escaped parentheses", "\\(a+\\)+"],
      ["a repeated alternation of literals", "(a|b)*"],
      ["a small bounded group repeat", "(a){1,3}"],
      ["a small bounded repeat around an open one", "(a+){1,3}"],
      ["a zero-or-one group around a plus", "(a+)?"],
      ["an exact count around a plus", "(a+){2}"],
      ["a dotted-quad shape", "(\\d{1,3}\\.){3}"],
      ["an escaped plus then a plus", "\\++"],
      ["a literal brace that is not a quantifier", "(a+){x}"],
      ["a repeat after the group closed", "(a+)b+"],
      ["a non-capturing group without a repeat", "(?:a+b)c"],
      ["a lookbehind without a repeat", "(?<=a+)b"],
    ];
    it.each(accepted)("%s: %s", (_label, pattern) => {
      expect(() => new RegExp(pattern)).not.toThrow();
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

  it("counts `**` segments the way globToRegex reads them", () => {
    expect(countDoubleStars("src/*.ts")).toBe(0);
    expect(countDoubleStars("**/a/**/b/**")).toBe(3);
    expect(countDoubleStars("****")).toBe(2);
    expect(countDoubleStars("***")).toBe(1);
  });

  const tooMany = Array.from(
    { length: MAX_GLOB_DOUBLE_STARS + 1 },
    () => "**",
  ).join("/a/");
  const atCap = Array.from({ length: MAX_GLOB_DOUBLE_STARS }, () => "**").join(
    "/a/",
  );

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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-glob-"));
    const file = path.join(tmp, "slop.config.yml");
    fs.writeFileSync(file, yaml);
    return () => loadConfig(file);
  }

  it.each(fields)(
    "%s refuses a glob with too many `**` segments",
    (field, make) => {
      const run = load(make(tooMany));
      // The zod issue list is JSON, so the quoted text appears escaped.
      const named = JSON.stringify(
        `${field} pattern has more than ${MAX_GLOB_DOUBLE_STARS} "**" segments: "${tooMany}"`,
      ).slice(1, -1);
      expect(run).toThrow(named);
    },
  );

  it.each(fields)("%s accepts a glob at the cap", (_field, make) => {
    expect(load(make(atCap))).not.toThrow();
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-rx-"));
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
  });

  it("still reports the empty-match refusal for a safe pattern that matches nothing", () => {
    const msg = messageOf(load(make1("a*")));
    expect(msg).toContain("matches the empty string");
    expect(msg).not.toContain("can backtrack");
  });
});

describe(
  "accepted shapes stay fast on a long adversarial line",
  { timeout: 60_000 },
  () => {
    // The structural check cannot rule out every slow shape (see the module
    // header), so this pins what an accepted worst case costs through the real
    // packs. The accepted alternation repeat is quadratic on this line: about
    // 0.15 s for one pass, up to a second where the pack runs it once per
    // rule. An exponential shape would not finish at all, and those are
    // refused at load before any pack runs them, so the budget only has to
    // sit far above the quadratic cost to stay stable on a loaded machine.
    const BUDGET_MS = 10_000;
    const line = "ab".repeat(5000);
    const shape = "(a|b)*c";

    it("placement.markers", () => {
      const config = mergeConfig({ placement: { markers: [shape] } });
      const t0 = performance.now();
      const v = checkText(line, "x/AGENTS.md", {
        packs: allPacks,
        config,
        packFilter: ["placement-slop"],
      });
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
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
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    });

    it("review.allow", () => {
      const config = mergeConfig({ review: { allow: [shape] } });
      const t0 = performance.now();
      checkText(`${line} F1`, "docs/NOTES.md", {
        packs: allPacks,
        config,
        packFilter: ["review-slop"],
      });
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    });

    it("a refused pattern never reaches a pack: loadConfig fails first", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-rx-"));
      const file = path.join(tmp, "slop.config.yml");
      fs.writeFileSync(
        file,
        `placement:\n  markers:\n    - "(a|b+)*c"\n  allow:\n    - "(.*)*x"\n`,
      );
      expect(() => loadConfig(file)).toThrow(/nested quantifier/);
    });
  },
);
