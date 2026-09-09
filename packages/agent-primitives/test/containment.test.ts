import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  absolutePathTokens,
  escapingAbsolutePaths,
  isPathContained,
  resolveDeepestExisting,
} from "../src/probe/containment.js";

/**
 * Direct unit tests for `absolutePathTokens`/`escapingAbsolutePaths`
 * (task 5bf16459, round 2): round 1's tokenizer only split on
 * whitespace and only looked at tokens starting with `/`, which read
 * three fail-open shapes as `survived` -- a quoted absolute path
 * containing a space, the `--key=/abs` token form, and (via
 * `setup.ts`'s caller, covered separately) any absolute path in
 * `--pre`. These tests pin the tokenizer's own contract directly,
 * beneath the full `probe()` harness `probe-refusal-contract.test.ts`
 * exercises.
 */

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-containment-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("absolutePathTokens()", () => {
  it("pulls a quoted absolute path containing whitespace out as one token", () => {
    expect(
      absolutePathTokens("cd '/abs/my repo' && node fixture.test.js"),
    ).toEqual(["/abs/my repo"]);
    expect(
      absolutePathTokens('cd "/abs/my repo" && node fixture.test.js'),
    ).toEqual(["/abs/my repo"]);
  });

  it("pulls the value half of a --key=/abs token, unquoted and quoted", () => {
    expect(absolutePathTokens("npm test --prefix=/abs/repo")).toEqual([
      "/abs/repo",
    ]);
    expect(absolutePathTokens("npm test --prefix='/abs/repo'")).toEqual([
      "/abs/repo",
    ]);
    expect(absolutePathTokens("npm test --prefix='/abs/my repo'")).toEqual([
      "/abs/my repo",
    ]);
  });

  it("trims a trailing shell metacharacter -- ; & | ) , -- off a bare token", () => {
    expect(absolutePathTokens("cd /abs/repo;")).toEqual(["/abs/repo"]);
    expect(absolutePathTokens("cd /abs/repo&")).toEqual(["/abs/repo"]);
    expect(absolutePathTokens("cd /abs/repo| cat")).toEqual(["/abs/repo"]);
    expect(absolutePathTokens("echo /abs/repo)")).toEqual(["/abs/repo"]);
    expect(absolutePathTokens("echo /abs/repo,")).toEqual(["/abs/repo"]);
  });

  it("does not treat a bare / as an absolute-path token", () => {
    expect(absolutePathTokens("cd / && node fixture.test.js")).toEqual([]);
  });

  it("still finds a plain absolute path with none of the above", () => {
    expect(absolutePathTokens("/usr/bin/env node fixture.test.js")).toEqual([
      "/usr/bin/env",
    ]);
  });

  it("finds nothing in a command with no absolute path at all", () => {
    expect(absolutePathTokens("node fixture.test.js")).toEqual([]);
  });
});

describe("escapingAbsolutePaths()", () => {
  it("an absolute path outside the root is not reported as escaping", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(
      escapingAbsolutePaths("/usr/bin/env node fixture.test.js", root),
    ).toEqual([]);
  });

  it("an absolute path under the root is reported as escaping", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const inside = path.join(root, "backend");
    fs.mkdirSync(inside);
    expect(
      escapingAbsolutePaths(`cd ${inside} && npx vitest run`, root),
    ).toEqual([inside]);
  });

  it("excludes a token that resolves under the given scratchRoot even though it is also under root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "aplogs");
    fs.mkdirSync(scratchRoot, { recursive: true });
    const copy = path.join(scratchRoot, "wt-1", "wt");
    fs.mkdirSync(copy, { recursive: true });
    const resolvedScratchRoot = resolveDeepestExisting(
      path.resolve(scratchRoot),
    );

    // Without a scratchRoot, this reads as an escape (it resolves under
    // root).
    expect(escapingAbsolutePaths(`cd ${copy} && node t.js`, root)).toEqual([
      copy,
    ]);
    // The scratchRoot exemption (the --log-dir-inside-the-repo case)
    // excludes it: this IS the isolation copy, not an escape.
    expect(
      escapingAbsolutePaths(
        `cd ${copy} && node t.js`,
        root,
        resolvedScratchRoot,
      ),
    ).toEqual([]);
    // A path under root but NOT under scratchRoot is still reported.
    const other = path.join(root, "backend");
    fs.mkdirSync(other);
    expect(
      escapingAbsolutePaths(
        `cd ${other} && node t.js`,
        root,
        resolvedScratchRoot,
      ),
    ).toEqual([other]);
  });

  it("a --pre-style token (--key=/abs under root) is reported the same as a bare one", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const inside = path.join(root, "repo");
    fs.mkdirSync(inside);
    expect(
      escapingAbsolutePaths(`npm run build --prefix=${inside}`, root),
    ).toEqual([inside]);
  });
});

describe("isPathContained() (sanity, unchanged by this task)", () => {
  it("is true for the root itself and a path underneath it, false otherwise", () => {
    expect(isPathContained("/a/b", "/a/b")).toBe(true);
    expect(isPathContained("/a/b", "/a/b/c")).toBe(true);
    expect(isPathContained("/a/b", "/a/bc")).toBe(false);
    expect(isPathContained("/a/b", "/a")).toBe(false);
  });
});
