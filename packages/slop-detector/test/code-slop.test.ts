import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeSlopPack } from "../src/packs/code-slop.js";
import type { FileTarget, ResolvedConfig, Rule } from "../src/types.js";

function code(text: string, fileName = "fixture.ts"): FileTarget {
  return { path: fileName, text, kind: "code" };
}

const config: ResolvedConfig = {
  packs: { "agent-tics": false, "prose-slop": false, "comment-slop": false, "code-slop": true, "ui-slop": false },
  ruleOverrides: {},
  ignorePaths: [],
  treatAsProse: [],
  treatAsCode: [],
};

function findRule(id: string): Rule {
  const r = codeSlopPack.rules.find((rule) => rule.id === id);
  if (!r) throw new Error(`Rule ${id} not in code-slop pack`);
  return r;
}

function run(ruleId: string, file: FileTarget) {
  const rule = findRule(ruleId);
  return rule.appliesTo(file) ? rule.check({ file, config }) : [];
}

describe("code-slop/try-catch-cannot-throw", () => {
  it("flags a try/catch around pure arithmetic", () => {
    const v = run(
      "code-slop/try-catch-cannot-throw",
      code(`
function f(x: number) {
  try {
    const y = x + 1;
    return y;
  } catch (e) {
    return 0;
  }
}
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a try/catch around JSON.parse", () => {
    const v = run(
      "code-slop/try-catch-cannot-throw",
      code(`
function f(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a try/catch around an await", () => {
    const v = run(
      "code-slop/try-catch-cannot-throw",
      code(`
async function f(p: Promise<number>) {
  try {
    return await p;
  } catch {
    return 0;
  }
}
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("code-slop/default-on-required-param", () => {
  it("flags `name: string = 'default'`", () => {
    const v = run(
      "code-slop/default-on-required-param",
      code(`function f(name: string = "default") { return name; }`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("name");
  });

  it("does not flag `name?: string = 'default'`", () => {
    // optional with default is contradictory but TS already complains; not our job.
    const v = run(
      "code-slop/default-on-required-param",
      code(`function f(name?: string) { return name ?? "x"; }`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag `name: string | undefined = 'default'`", () => {
    const v = run(
      "code-slop/default-on-required-param",
      code(`function f(name: string | undefined = "default") { return name; }`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a parameter without a default", () => {
    const v = run(
      "code-slop/default-on-required-param",
      code(`function f(name: string) { return name; }`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("code-slop/empty-or-rethrow-catch", () => {
  it("flags `catch (e) { throw e; }`", () => {
    const v = run(
      "code-slop/empty-or-rethrow-catch",
      code(`
function f() {
  try { JSON.parse(""); }
  catch (e) { throw e; }
}
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("rethrow");
  });

  it("flags an empty catch block", () => {
    const v = run(
      "code-slop/empty-or-rethrow-catch",
      code(`
function f() {
  try { JSON.parse(""); }
  catch {}
}
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("Empty catch");
  });

  it("does not flag a catch that logs", () => {
    const v = run(
      "code-slop/empty-or-rethrow-catch",
      code(`
function f() {
  try { JSON.parse(""); }
  catch (e) { console.error(e); }
}
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("code-slop/async-without-await", () => {
  it("flags an async function with no await and no Promise return type", () => {
    const v = run(
      "code-slop/async-without-await",
      code(`async function f() { return 42; }`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag an async function that uses await", () => {
    const v = run(
      "code-slop/async-without-await",
      code(`async function f() { return await Promise.resolve(1); }`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag an async function with explicit Promise<T> return type", () => {
    const v = run(
      "code-slop/async-without-await",
      code(`async function f(): Promise<number> { return 42; }`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("code-slop/backcompat-shim-unreleased", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "slop-backcompat-"));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "fixture", version: "0.3.0" }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags `@deprecated since v0.5.0` when package is at 0.3.0", () => {
    const filePath = join(tmpDir, "x.ts");
    const text = `
/** @deprecated since v0.5.0 */
export function legacy() { return 1; }
`;
    writeFileSync(filePath, text);
    const v = run("code-slop/backcompat-shim-unreleased", { path: filePath, text, kind: "code" });
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].message).toContain("0.5.0");
  });

  it("does not flag `@deprecated since v0.1.0` when package is at 0.3.0", () => {
    const filePath = join(tmpDir, "x.ts");
    const text = `
/** @deprecated since v0.1.0 */
export function legacy() { return 1; }
`;
    writeFileSync(filePath, text);
    const v = run("code-slop/backcompat-shim-unreleased", { path: filePath, text, kind: "code" });
    expect(v).toHaveLength(0);
  });

  it("flags `// kept for backcompat` attached to a function", () => {
    const filePath = join(tmpDir, "x.ts");
    const text = `
// kept for backcompat
export function legacy() { return 1; }
`;
    writeFileSync(filePath, text);
    const v = run("code-slop/backcompat-shim-unreleased", { path: filePath, text, kind: "code" });
    expect(v.length).toBeGreaterThan(0);
  });
});

describe("code-slop applies-to gating", () => {
  it("does not run on .md files", () => {
    const proseFile: FileTarget = { path: "a.md", text: "try { 1 } catch {}", kind: "prose" };
    for (const rule of codeSlopPack.rules) {
      expect(rule.appliesTo(proseFile)).toBe(false);
    }
  });

  it("returns 0 violations when the file has a syntax error (parser fails gracefully)", () => {
    // Garbage that can't be parsed as TS/JS. The parser-cache wrapper
    // returns ok:false and rules opt out cleanly rather than throwing.
    const broken = code(`function ( {} { let x = 1`);
    for (const rule of codeSlopPack.rules) {
      expect(() => rule.check({ file: broken, config })).not.toThrow();
      expect(rule.check({ file: broken, config })).toEqual([]);
    }
  });
});
