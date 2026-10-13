import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithin } from "../src/worktree/git.js";

describe("isWithin: lexical containment for paths that do not exist", () => {
  const root = path.join(os.tmpdir(), "agent-primitives-iswithin-missing", "r");
  it("a ..foo entry and a nested ..foo/x under a missing root are inside", () => {
    expect(isWithin(root, path.join(root, "..foo"))).toBe(true);
    expect(isWithin(root, path.join(root, "..foo", "x"))).toBe(true);
  });
  it("../x next to a missing root is outside", () => {
    expect(isWithin(root, path.join(root, "..", "x"))).toBe(false);
  });
});
