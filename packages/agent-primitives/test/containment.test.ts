import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  escapingRootMentions,
  isPathContained,
  resolveDeepestExisting,
} from "../src/probe/containment.js";

/**
 * Direct unit tests for `escapingRootMentions` (task 5bf16459, round 3
 * redesign): rounds 1 and 2 tokenized the command string and each round's
 * reviewer found a fresh quoting/escaping/wrapper shape the tokenizer had
 * not enumerated (a quoted absolute path containing whitespace, a
 * `--key=/abs` form, `--pre` never scanned, then `sh -c "cd /abs && ..."`
 * read as one opaque quoted token and a backslash-escaped space splitting
 * a path in two). Round 3 replaces the tokenizer with a substring rule:
 * an absolute path under the real repository root contains that root as
 * a substring under every quoting/escaping/wrapper shape, so the rule
 * needs no shape enumeration. These tests pin the substring rule's own
 * contract directly, beneath the full `probe()` harness
 * `probe-refusal-contract.test.ts` and `plan.test.ts` exercise.
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

describe("escapingRootMentions()", () => {
  it("a plain absolute path under the root is reported as escaping", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const inside = path.join(root, "backend");
    fs.mkdirSync(inside);
    expect(
      escapingRootMentions(`cd ${inside} && npx vitest run`, root),
    ).toEqual([root]);
  });

  it("a single- or double-quoted absolute path containing whitespace is reported", () => {
    const parent = makeTmpDir();
    const root = resolveDeepestExisting(
      path.resolve(fs.mkdtempSync(path.join(parent, "my repo-"))),
    );
    expect(
      escapingRootMentions(`cd '${root}' && node fixture.test.js`, root),
    ).toEqual([root]);
    expect(
      escapingRootMentions(`cd "${root}" && node fixture.test.js`, root),
    ).toEqual([root]);
  });

  it("a backslash-escaped space in the path is reported (the round-2 survivor)", () => {
    const parent = makeTmpDir();
    const root = resolveDeepestExisting(
      path.resolve(fs.mkdtempSync(path.join(parent, "my repo-"))),
    );
    const escaped = root.replace(/ /g, "\\ ");
    expect(
      escapingRootMentions(`cd ${escaped} && node fixture.test.js`, root),
    ).toEqual([escaped]);
  });

  it("the --key=/abs token form is reported", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(escapingRootMentions(`npm test --prefix=${root}`, root)).toEqual([
      root,
    ]);
  });

  it('a quoted --key="/abs/x y" token form is reported', () => {
    const parent = makeTmpDir();
    const root = resolveDeepestExisting(
      path.resolve(fs.mkdtempSync(path.join(parent, "my repo-"))),
    );
    expect(escapingRootMentions(`npm test --prefix="${root}"`, root)).toEqual([
      root,
    ]);
  });

  it("a sh -c wrapper is reported, even though the whole command is one quoted token", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(
      escapingRootMentions(`sh -c "cd ${root} && node t.js"`, root),
    ).toEqual([root]);
    expect(
      escapingRootMentions(`bash -lc 'cd ${root} && node t.js'`, root),
    ).toEqual([root]);
  });

  it("treats a symlinked root and its realpath as the same spelling set", () => {
    const target = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const parent = makeTmpDir();
    const link = path.join(parent, "linked-root");
    fs.symlinkSync(target, link, "dir");
    // root given AS the symlink: a command using the symlink spelling
    // itself is reported.
    expect(escapingRootMentions(`cd ${link} && npx vitest run`, link)).toEqual([
      link,
    ]);
    // the same root (given as the symlink) is ALSO reported when the
    // command instead spells it via its realpath.
    expect(
      escapingRootMentions(`cd ${target} && npx vitest run`, link),
    ).toEqual([target]);
  });

  it("an absolute path OUTSIDE the root is not reported", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const outside = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(
      escapingRootMentions(`cd ${outside} && node fixture.test.js`, root),
    ).toEqual([]);
    expect(
      escapingRootMentions("/usr/bin/env node fixture.test.js", root),
    ).toEqual([]);
  });

  it("excludes a mention that resolves under the given scratchRoot even though it is also under root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "aplogs");
    fs.mkdirSync(scratchRoot, { recursive: true });
    const copy = path.join(scratchRoot, "wt-1", "wt");
    fs.mkdirSync(copy, { recursive: true });

    // Without a scratchRoot, this reads as an escape (it contains root).
    expect(escapingRootMentions(`cd ${copy} && node t.js`, root)).toEqual([
      root,
    ]);
    // The scratchRoot exemption (the --log-dir-inside-the-repo case)
    // excludes it: this IS the isolation copy, not an escape.
    expect(
      escapingRootMentions(`cd ${copy} && node t.js`, root, scratchRoot),
    ).toEqual([]);
    // A path under root but NOT under scratchRoot is still reported.
    const other = path.join(root, "backend");
    fs.mkdirSync(other);
    expect(
      escapingRootMentions(`cd ${other} && node t.js`, root, scratchRoot),
    ).toEqual([root]);
  });

  it("an --env value carrying the root is reported the same as a bare command mention", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(escapingRootMentions(root, root)).toEqual([root]);
    expect(escapingRootMentions(`REPO=${root}`, root)).toEqual([root]);
  });

  it("an --env value naming a path OUTSIDE the root is not reported", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const outside = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(escapingRootMentions(outside, root)).toEqual([]);
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
