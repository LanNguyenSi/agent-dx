import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeSlopPack, __resetCaches } from "../src/packs/code-slop.js";
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

describe("code-slop/phantom-import", () => {
  let tmpDir: string;

  beforeEach(() => {
    __resetCaches();
    tmpDir = mkdtempSync(join(tmpdir(), "slop-phantom-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Writes a package.json and a source file into tmpDir, returns the target.
  function withPackage(pkgJson: object, source: string): FileTarget {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify(pkgJson));
    const filePath = join(tmpDir, "x.ts");
    writeFileSync(filePath, source);
    return { path: filePath, text: source, kind: "code" };
  }

  it("does not flag an import of a declared dependency", () => {
    const f = withPackage(
      { name: "fixture", dependencies: { lodash: "^4.0.0" } },
      `import _ from "lodash";\n`,
    );
    expect(run("code-slop/phantom-import", f)).toHaveLength(0);
  });

  it("flags an import of an undeclared package", () => {
    const f = withPackage(
      { name: "fixture", dependencies: { lodash: "^4.0.0" } },
      `import x from "hallucinated-pkg";\n`,
    );
    const v = run("code-slop/phantom-import", f);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("hallucinated-pkg");
  });

  it("reduces a subpath import to its package name", () => {
    // `lodash/fp` resolves via the declared `lodash`; `missing/sub` does not.
    const f = withPackage(
      { name: "fixture", dependencies: { lodash: "^4.0.0" } },
      `import fp from "lodash/fp";\nimport s from "missing/sub";\n`,
    );
    const v = run("code-slop/phantom-import", f);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("`missing`");
  });

  it("reduces a scoped specifier to `@scope/pkg`", () => {
    const f = withPackage(
      { name: "fixture", devDependencies: { "@scope/declared": "^1.0.0" } },
      `import a from "@scope/declared/sub";\nimport b from "@scope/phantom";\n`,
    );
    const v = run("code-slop/phantom-import", f);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("@scope/phantom");
  });

  it("treats peerDependencies and optionalDependencies as declared", () => {
    const f = withPackage(
      {
        name: "fixture",
        peerDependencies: { react: "^18.0.0" },
        optionalDependencies: { fsevents: "^2.0.0" },
      },
      `import r from "react";\nconst fse = require("fsevents");\n`,
    );
    expect(run("code-slop/phantom-import", f)).toHaveLength(0);
  });

  it("does not flag node builtins (bare, `node:`-prefixed, or a subpath)", () => {
    const f = withPackage(
      { name: "fixture" },
      `import fs from "fs";\nimport path from "node:path";\nimport { readFile } from "fs/promises";\n`,
    );
    expect(run("code-slop/phantom-import", f)).toHaveLength(0);
  });

  it("does not flag relative imports or a self-import", () => {
    const f = withPackage(
      { name: "fixture" },
      `import a from "./local.js";\nimport b from "../sibling.js";\nimport c from "fixture";\n`,
    );
    expect(run("code-slop/phantom-import", f)).toHaveLength(0);
  });

  it("flags an undeclared `require()` call", () => {
    const f = withPackage({ name: "fixture" }, `const x = require("phantom-cjs");\n`);
    const v = run("code-slop/phantom-import", f);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("phantom-cjs");
  });

  it("flags a re-export and a dynamic import of undeclared packages", () => {
    const f = withPackage(
      { name: "fixture" },
      `export { thing } from "phantom-reexport";\nasync function load() { return import("phantom-dynamic"); }\n`,
    );
    const v = run("code-slop/phantom-import", f);
    expect(v).toHaveLength(2);
    const names = v.map((x) => x.message).join(" ");
    expect(names).toContain("phantom-reexport");
    expect(names).toContain("phantom-dynamic");
  });

  it("flags an undeclared `import = require()` declaration", () => {
    const f = withPackage({ name: "fixture" }, `import legacy = require("phantom-equals");\n`);
    const v = run("code-slop/phantom-import", f);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("phantom-equals");
  });

  it("is a no-op when no package.json is found above the file", () => {
    // A loose file written into the tmp root with no package.json anywhere.
    const filePath = join(tmpDir, "loose.ts");
    const source = `import x from "anything-at-all";\n`;
    writeFileSync(filePath, source);
    expect(
      run("code-slop/phantom-import", { path: filePath, text: source, kind: "code" }),
    ).toHaveLength(0);
  });

  it("does not flag a workspace sibling imported without a dependency entry (regression)", () => {
    // tmpDir/ is the workspace root; packages/sib is a sibling of packages/app.
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    );
    const sibDir = join(tmpDir, "packages", "sib");
    mkdirSync(sibDir, { recursive: true });
    writeFileSync(join(sibDir, "package.json"), JSON.stringify({ name: "@ws/sib" }));
    const appDir = join(tmpDir, "packages", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@ws/app" }));
    const filePath = join(appDir, "x.ts");
    // The sibling is excluded, but a genuinely undeclared import from inside
    // the same workspace package must still be flagged — the workspace logic
    // must not widen `known` to "anything".
    const source = `import s from "@ws/sib";\nimport q from "actually-phantom";\n`;
    writeFileSync(filePath, source);
    const v = run("code-slop/phantom-import", { path: filePath, text: source, kind: "code" });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("actually-phantom");
  });

  // ── Gap 1: pnpm-workspace.yaml ────────────────────────────────────────────

  it("resolves siblings declared in pnpm-workspace.yaml (positive + negative)", () => {
    // Root has only pnpm-workspace.yaml, no workspaces in package.json.
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", private: true }),
    );
    writeFileSync(
      join(tmpDir, "pnpm-workspace.yaml"),
      "packages:\n  - \"packages/*\"\n",
    );
    const sibDir = join(tmpDir, "packages", "sib");
    mkdirSync(sibDir, { recursive: true });
    writeFileSync(join(sibDir, "package.json"), JSON.stringify({ name: "@ws/sib" }));
    const appDir = join(tmpDir, "packages", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@ws/app" }));
    const filePath = join(appDir, "x.ts");
    const source = `import s from "@ws/sib";\nimport q from "actually-phantom";\n`;
    writeFileSync(filePath, source);
    const v = run("code-slop/phantom-import", { path: filePath, text: source, kind: "code" });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("actually-phantom");
  });

  // ── Gap 2: generalized glob handling ─────────────────────────────────────

  it("resolves siblings via nested glob `packages/*/*`", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*/*"] }),
    );
    const sibDir = join(tmpDir, "packages", "group", "sib");
    mkdirSync(sibDir, { recursive: true });
    writeFileSync(join(sibDir, "package.json"), JSON.stringify({ name: "@ws/sib" }));
    const appDir = join(tmpDir, "packages", "group", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@ws/app" }));
    const filePath = join(appDir, "x.ts");
    const source = `import s from "@ws/sib";\nimport q from "phantom-nested";\n`;
    writeFileSync(filePath, source);
    const v = run("code-slop/phantom-import", { path: filePath, text: source, kind: "code" });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("phantom-nested");
  });

  it("resolves siblings via globstar `apps/**`", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/**"] }),
    );
    const sibDir = join(tmpDir, "apps", "deep", "sib");
    mkdirSync(sibDir, { recursive: true });
    writeFileSync(join(sibDir, "package.json"), JSON.stringify({ name: "@ws/deep-sib" }));
    const appDir = join(tmpDir, "apps", "consumer");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@ws/consumer" }));
    const filePath = join(appDir, "x.ts");
    const source = `import s from "@ws/deep-sib";\nimport q from "phantom-globstar";\n`;
    writeFileSync(filePath, source);
    const v = run("code-slop/phantom-import", { path: filePath, text: source, kind: "code" });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("phantom-globstar");
  });

  it("resolves siblings via mid-segment star `packages/eslint-*`", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/eslint-*"] }),
    );
    const sibDir = join(tmpDir, "packages", "eslint-config-base");
    mkdirSync(sibDir, { recursive: true });
    writeFileSync(join(sibDir, "package.json"), JSON.stringify({ name: "@ws/eslint-config-base" }));
    const appDir = join(tmpDir, "packages", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "@ws/app" }));
    const filePath = join(appDir, "x.ts");
    const source = `import s from "@ws/eslint-config-base";\nimport q from "phantom-midseg";\n`;
    writeFileSync(filePath, source);
    const v = run("code-slop/phantom-import", { path: filePath, text: source, kind: "code" });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("phantom-midseg");
  });

  it("does not throw on a pathological workspace glob (fail-open)", () => {
    // A `?`-containing segment would build an invalid RegExp if unescaped; the
    // resolver must swallow it and still run the rule rather than abort the
    // scan of the whole repo.
    const appDir = join(tmpDir, "packages", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/?*"] }),
    );
    const filePath = join(appDir, "x.ts");
    const source = `import x from "definitely-phantom";\n`;
    writeFileSync(filePath, source);
    let v: ReturnType<typeof run>;
    expect(() => {
      v = run("code-slop/phantom-import", { path: filePath, text: source, kind: "code" });
    }).not.toThrow();
    expect(v!).toHaveLength(1);
    expect(v![0].message).toContain("definitely-phantom");
  });

  // ── Gap 3: require.resolve ────────────────────────────────────────────────

  it("flags `require.resolve` of a phantom package", () => {
    const f = withPackage(
      { name: "fixture" },
      `const p = require.resolve("phantom-resolve");\n`,
    );
    const v = run("code-slop/phantom-import", f);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("phantom-resolve");
  });

  it("does not flag `require.resolve` of a declared dependency", () => {
    const f = withPackage(
      { name: "fixture", dependencies: { lodash: "^4.0.0" } },
      `const p = require.resolve("lodash");\n`,
    );
    expect(run("code-slop/phantom-import", f)).toHaveLength(0);
  });

  // ── Gap 4: __resetCaches actually clears stale package context ─────────────

  it("__resetCaches lets an in-place package.json change be re-read", () => {
    // First run caches the package context for tmpDir: lodash is undeclared,
    // so the import is flagged.
    const f = withPackage({ name: "fixture", dependencies: {} }, `import _ from "lodash";\n`);
    expect(run("code-slop/phantom-import", f)).toHaveLength(1);

    // Declare lodash in place. Without a reset the cached (stale) context wins,
    // so the import is still flagged — proving the cache is consulted.
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { lodash: "^4.0.0" } }),
    );
    expect(run("code-slop/phantom-import", f)).toHaveLength(1);

    // After clearing the caches the fresh package.json is read and the import
    // is no longer phantom. If __resetCaches were inert this would still be 1.
    __resetCaches();
    expect(run("code-slop/phantom-import", f)).toHaveLength(0);
  });
});

describe("code-slop/stub-body", () => {
  it("flags a function whose body is a not-implemented throw", () => {
    const v = run(
      "code-slop/stub-body",
      code(`function fetchUser(id: string) { throw new Error("not implemented"); }`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("fetchUser");
  });

  it("flags a throw of a NotImplementedError constructor", () => {
    const v = run(
      "code-slop/stub-body",
      code(`function save() { throw new NotImplementedError(); }`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a throw with a non-placeholder message", () => {
    const v = run(
      "code-slop/stub-body",
      code(`function parse(s: string) { throw new Error("invalid input: " + s); }`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a real implementation", () => {
    const v = run(
      "code-slop/stub-body",
      code(`function add(a: number, b: number) { const sum = a + b; return sum; }`),
    );
    expect(v).toHaveLength(0);
  });

  it("flags an empty named function", () => {
    const v = run("code-slop/stub-body", code(`function setup() {}`));
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("empty body");
  });

  it("flags trivial placeholder returns (null, undefined, void 0, {}, [], bare)", () => {
    const v = run(
      "code-slop/stub-body",
      code(`
function a() { return null; }
function b() { return undefined; }
function c() { return {}; }
function d() { return []; }
function e() { return; }
function f() { return void 0; }
`),
    );
    expect(v).toHaveLength(6);
  });

  it("does not flag a return of a non-trivial value", () => {
    const v = run(
      "code-slop/stub-body",
      code(`
function a() { return 0; }
function b() { return computeResult(); }
function c() { return { id: 1 }; }
`),
    );
    expect(v).toHaveLength(0);
  });

  it("flags a class method whose body is a not-implemented throw or trivial return", () => {
    const v = run(
      "code-slop/stub-body",
      code(`
class Api {
  fetch() { throw new Error("not implemented yet"); }
  list() { return []; }
}
`),
    );
    expect(v).toHaveLength(2);
  });

  it("flags an empty class method but not an empty constructor or accessor", () => {
    const v = run(
      "code-slop/stub-body",
      code(`
class Service {
  constructor() {}
  get ready() { return null; }
  set ready(v: boolean) {}
  start() {}
}
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("start");
  });

  it("does not flag an abstract method or an interface member", () => {
    const v = run(
      "code-slop/stub-body",
      code(`
interface Repo {
  find(id: string): User;
}
abstract class Base {
  abstract load(): void;
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag an overload signature, only the stub implementation body", () => {
    const v = run(
      "code-slop/stub-body",
      code(`
function fmt(x: number): string;
function fmt(x: string): string;
function fmt(x: number | string): string { throw new Error("TODO"); }
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag an anonymous arrow function with an empty body", () => {
    const v = run(
      "code-slop/stub-body",
      code(`function withDefault(cb: () => void = () => {}) { cb(); }`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not run on .d.ts declaration files", () => {
    const dts: FileTarget = {
      path: "types.d.ts",
      text: `export function helper(): void;`,
      kind: "code",
    };
    const rule = codeSlopPack.rules.find((r) => r.id === "code-slop/stub-body")!;
    expect(rule.appliesTo(dts)).toBe(false);
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
