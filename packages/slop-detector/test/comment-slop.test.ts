import { describe, it, expect } from "vitest";
import { commentSlopPack } from "../src/packs/comment-slop.js";
import type { FileTarget, ResolvedConfig, Rule } from "../src/types.js";

function code(text: string, fileName = "fixture.ts"): FileTarget {
  return { path: fileName, text, kind: "code" };
}

const config: ResolvedConfig = {
  packs: { "agent-tics": false, "prose-slop": false, "comment-slop": true, "code-slop": false, "ui-slop": false },
  ruleOverrides: {},
  ignorePaths: [],
  treatAsProse: [],
  treatAsCode: [],
};

function findRule(id: string): Rule {
  const r = commentSlopPack.rules.find((rule) => rule.id === id);
  if (!r) throw new Error(`Rule ${id} not in comment-slop pack`);
  return r;
}

function run(ruleId: string, file: FileTarget) {
  const rule = findRule(ruleId);
  return rule.appliesTo(file) ? rule.check({ file, config }) : [];
}

describe("comment-slop/jsdoc-on-trivial-accessor", () => {
  it("flags a JSDoc comment immediately before a trivial getter", () => {
    const v = run(
      "comment-slop/jsdoc-on-trivial-accessor",
      code(`
class C {
  /** Get the foo. */
  get foo() { return this._foo; }
  _foo = 1;
}
`),
    );
    expect(v).toHaveLength(1);
    expect(v[0].matched).toContain("Get the foo");
  });

  it("does not flag a JSDoc on a non-trivial method", () => {
    const v = run(
      "comment-slop/jsdoc-on-trivial-accessor",
      code(`
class C {
  /** Compute and cache the eigenvalue. */
  compute() {
    const x = this.matrix.solve();
    this.cache = x;
    return x;
  }
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a getter without leading JSDoc", () => {
    const v = run(
      "comment-slop/jsdoc-on-trivial-accessor",
      code(`
class C {
  get foo() { return this._foo; }
  _foo = 1;
}
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("comment-slop/comment-restates-next-line", () => {
  it("flags a `// loop over items` above a `for (const item of items)`", () => {
    const v = run(
      "comment-slop/comment-restates-next-line",
      code(`
function f(items: number[]) {
  // loop over items
  for (const item of items) console.log(item);
}
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a comment that explains why", () => {
    const v = run(
      "comment-slop/comment-restates-next-line",
      code(`
function f(items: number[]) {
  // Caller already validated the array is non-empty; bail on the empty case anyway for safety.
  for (const item of items) console.log(item);
}
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a comment whose words are all stopwords", () => {
    const v = run(
      "comment-slop/comment-restates-next-line",
      code(`
function f() {
  // and the
  return 42;
}
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("comment-slop/orphan-markers", () => {
  it("flags `// removed`", () => {
    const v = run("comment-slop/orphan-markers", code(`// removed\nfunction x() { return 1; }\n`));
    expect(v).toHaveLength(1);
  });

  it("flags `// kept for backcompat`", () => {
    const v = run(
      "comment-slop/orphan-markers",
      code(`function legacy() { return 1; }\n// kept for backcompat\n`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a real comment that mentions the word 'removed'", () => {
    const v = run(
      "comment-slop/orphan-markers",
      code(`// Items removed from the queue are returned to the caller.\nfunction pop() { return 1; }\n`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("comment-slop/comment-heavier-than-body", () => {
  it("flags a 4-line JSDoc on a 1-line helper", () => {
    const v = run(
      "comment-slop/comment-heavier-than-body",
      code(`
/**
 * This helper increments the counter by one. It is used in
 * many places throughout the codebase. The increment is
 * always a positive integer.
 */
function inc(x: number) { return x + 1; }
`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a short JSDoc", () => {
    const v = run(
      "comment-slop/comment-heavier-than-body",
      code(`
/** Increment by one. */
function inc(x: number) { return x + 1; }
`),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag a long JSDoc on a long function", () => {
    const v = run(
      "comment-slop/comment-heavier-than-body",
      code(`
/**
 * Walk the AST and collect violations.
 * Handles all three pack types.
 * Skips disabled rules.
 * Returns a sorted list.
 */
function walk(): number[] {
  const out: number[] = [];
  out.push(1);
  out.push(2);
  out.push(3);
  out.push(4);
  out.push(5);
  out.push(6);
  out.push(7);
  out.push(8);
  return out;
}
`),
    );
    expect(v).toHaveLength(0);
  });
});

describe("comment-slop/ascii-banner", () => {
  it("flags a `// ====...` banner", () => {
    const v = run(
      "comment-slop/ascii-banner",
      code(`// ============================\nfunction f() { return 1; }\n`),
    );
    expect(v).toHaveLength(1);
  });

  it("flags a `/* --- ... --- */` block banner", () => {
    const v = run(
      "comment-slop/ascii-banner",
      code(`/* ---------------------------- */\nfunction f() { return 1; }\n`),
    );
    expect(v).toHaveLength(1);
  });

  it("does not flag a short `// --` comment", () => {
    const v = run("comment-slop/ascii-banner", code(`// --\nfunction f() { return 1; }\n`));
    expect(v).toHaveLength(0);
  });
});

describe("comment-slop applies-to gating", () => {
  it("does not run on .md files", () => {
    const proseFile: FileTarget = { path: "a.md", text: "// removed\n", kind: "prose" };
    for (const rule of commentSlopPack.rules) {
      expect(rule.appliesTo(proseFile)).toBe(false);
    }
  });
});
