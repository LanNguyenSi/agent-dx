import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/cli.js";
import type { RunGit } from "../src/types.js";
import { writeDoc } from "./git-helpers.js";

// Unit-level coverage of runCheck()'s auto-detect wiring, without a real git
// process: a stub RunGit stands in for `git rev-parse --show-toplevel`, so
// this test is fast and deterministic regardless of the ambient repo state.
describe("runCheck repo-root auto-detection (stubbed git)", () => {
  let bundleDir: string;
  let fakeRepoRoot: string;

  beforeEach(() => {
    bundleDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-kit-runcheck-bundle-"),
    );
    fakeRepoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "okf-kit-runcheck-root-"),
    );
  });

  afterEach(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
  });

  it("fills repoRoot from an injected runGit stub instead of a real git subprocess", () => {
    // The referenced source only exists under the stub's fake root, not
    // anywhere near the real filesystem tree containing this test file.
    fs.writeFileSync(
      path.join(fakeRepoRoot, "source.ts"),
      "export const a = 1;\n",
    );
    writeDoc(bundleDir, "doc.md", {
      type: "concept",
      sources: ["source.ts"],
    });

    const revParseCalls: Array<{ args: string[]; cwd: string }> = [];
    const stubRunGit: RunGit = (args, cwd) => {
      revParseCalls.push({ args, cwd });
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return fakeRepoRoot;
      return null;
    };

    const result = runCheck(bundleDir, { runGit: stubRunGit });

    // detectRepoRoot was invoked from the bundle dir, via the stub, not a
    // real git process.
    expect(revParseCalls).toHaveLength(1);
    expect(revParseCalls[0]).toEqual({
      args: ["rev-parse", "--show-toplevel"],
      cwd: path.resolve(bundleDir),
    });

    // sources-shape's existence check only runs when repoRoot is set; no
    // "does not exist" finding here proves repoRoot was filled in from the
    // stub's fake root (where source.ts really does exist), not left
    // undefined.
    expect(
      result.findings.some(
        (f) =>
          f.ruleId === "sources-shape" && f.message.includes("does not exist"),
      ),
    ).toBe(false);
  });

  it("leaves repoRoot unset when the stub reports no git work tree, still without a real git process", () => {
    writeDoc(bundleDir, "doc.md", {
      type: "concept",
      sources: ["source.ts"],
    });

    const stubRunGit: RunGit = () => null; // simulates "not a git work tree"

    const result = runCheck(bundleDir, { runGit: stubRunGit });

    expect(
      result.findings.some(
        (f) =>
          f.ruleId === "sources-fresh" &&
          f.message.includes("not inside a git work tree"),
      ),
    ).toBe(true);
  });
});
