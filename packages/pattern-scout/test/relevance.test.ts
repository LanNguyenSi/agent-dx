import { describe, it, expect } from "vitest";
import {
  classifyMatchLine,
  classifyPath,
  exemplarRelevance,
  oracleRelevance,
} from "../src/relevance.js";

describe("classifyPath", () => {
  it("classifies implementation files", () => {
    expect(classifyPath("/cache/zod/4.4.3/src/types.ts")).toBe("impl");
    expect(classifyPath("lib/index.js")).toBe("impl");
  });
  it("classifies test files, even under src/", () => {
    expect(classifyPath("test/server/index.test.ts")).toBe("test");
    expect(classifyPath("src/foo.test.ts")).toBe("test");
    expect(classifyPath("packages/x/__tests__/a.ts")).toBe("test");
    expect(classifyPath("src/foo.spec.ts")).toBe("test");
  });
  it("classifies example, doc, and config files", () => {
    expect(classifyPath("examples/demo.ts")).toBe("example");
    expect(classifyPath("docs/guide.md")).toBe("doc");
    expect(classifyPath("README.md")).toBe("doc");
    expect(classifyPath("tsconfig.json")).toBe("config");
    expect(classifyPath(".github/workflows/ci.yml")).toBe("config");
    // .github wins on the segment alone, with no config extension
    expect(classifyPath(".github/CODEOWNERS")).toBe("config");
  });
  it("falls back to other when nothing matches", () => {
    expect(classifyPath("scripts/run")).toBe("other");
  });
});

describe("classifyMatchLine", () => {
  it("detects declarations across languages", () => {
    expect(classifyMatchLine("export function run() {")).toBe("definition");
    expect(classifyMatchLine("  class Foo {")).toBe("definition");
    expect(classifyMatchLine("pub fn parse() {")).toBe("definition");
    expect(classifyMatchLine("def handler(req):")).toBe("definition");
  });
  it("detects comments across markers", () => {
    expect(classifyMatchLine("// register the tool")).toBe("comment");
    expect(classifyMatchLine("  * @param name")).toBe("comment");
    expect(classifyMatchLine("/* block comment */")).toBe("comment");
  });
  it("counts exported bindings as definitions but bare bindings as usage", () => {
    expect(classifyMatchLine("export const Schema = obj;")).toBe("definition");
    expect(classifyMatchLine("pub const MAX: usize = 8;")).toBe("definition");
    expect(classifyMatchLine("const total = items.length;")).toBe("usage");
    expect(classifyMatchLine("  let count = 0;")).toBe("usage");
  });
  it("treats a plain call site as usage", () => {
    expect(classifyMatchLine("server.registerTool(name, def);")).toBe("usage");
    expect(classifyMatchLine("  return foo(bar);")).toBe("usage");
  });
});

describe("exemplarRelevance", () => {
  it("combines file category and match context into a reason", () => {
    const r = exemplarRelevance("src/engine.ts", "export function run() {");
    expect(r.reason).toBe("definition in an implementation file");
    expect(r.signals).toEqual(["impl-file", "definition"]);
  });
  it("flags a weak hit, e.g. a usage in test code", () => {
    const r = exemplarRelevance("test/x.test.ts", "  run();");
    expect(r.signals).toEqual(["test-file", "usage"]);
    expect(r.reason).toContain("test code");
  });
});

describe("oracleRelevance", () => {
  it("tags oracle hits as semantic", () => {
    const r = oracleRelevance("src/a.ts");
    expect(r.signals).toContain("semantic");
    expect(r.reason).toContain("semantic match");
  });
});
