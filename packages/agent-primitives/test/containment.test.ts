import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  escapingRootMentions,
  isCaseInsensitiveFilesystem,
  isPathContained,
  resolveDeepestExisting,
} from "../src/probe/containment.js";

/**
 * Direct unit tests for `escapingRootMentions`: the rule matches a
 * LITERAL spelling of the real repository root in the scanned text
 * rather than tokenising or shell-parsing the command, so an absolute
 * path under the root is caught whatever quoting, escaping, `=`-form,
 * wrapper or separator noise surrounds it, and everything that reaches
 * the root without spelling it that way is a residual (the scope
 * statement and the residual list live on the function itself, in the
 * README and in the CHANGELOG entry). These tests pin that contract
 * directly -- which spellings count, where a match ends, what the
 * scratch-root exemption covers -- beneath the full `probe()` harness
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
  it("a plain absolute path under the root is reported as escaping, as the region actually matched", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const inside = path.join(root, "backend");
    fs.mkdirSync(inside);
    // The reported string is the whole path the command names, not the
    // bare root: a message saying only `<root>` reads as if the command
    // had named the root itself.
    expect(
      escapingRootMentions(`cd ${inside} && npx vitest run`, root),
    ).toEqual([inside]);
  });

  it("the reported region stops at the end of the path, not at the end of the command", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(escapingRootMentions(`cd ${root}/a/b.js;node t.js`, root)).toEqual([
      `${root}/a/b.js`,
    ]);
    expect(
      escapingRootMentions(`node --prefix="${root}/a" t.js`, root),
    ).toEqual([`${root}/a`]);
    // A backslash-escaped space belongs to the path, so the region does
    // not stop at it.
    expect(escapingRootMentions(`cd ${root}/a\\ b && node t.js`, root)).toEqual(
      [`${root}/a\\ b`],
    );
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

  it("a backslash-escaped space in the path is reported", () => {
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
      copy,
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
    ).toEqual([other]);
  });

  // --- The exemption's own boundary, the case rule, and the path
  // boundary after a match. ---

  it("does NOT strip when the scratchRoot IS the root itself: the exemption would otherwise erase every mention", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const inside = path.join(root, "pkg");
    fs.mkdirSync(inside);
    // `--log-dir <root>`: `isPathContained(root, root)` is true, so a
    // containment test alone would exempt the root's own spelling and
    // pass this escape.
    expect(
      escapingRootMentions(`cd '${inside}' && node t.js`, root, root),
    ).toEqual([inside]);
  });

  it("does NOT strip when the scratchRoot is an ANCESTOR of the root", () => {
    const parent = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const root = path.join(parent, "repo");
    fs.mkdirSync(root);
    const inside = path.join(root, "pkg");
    fs.mkdirSync(inside);
    expect(
      escapingRootMentions(`cd '${inside}' && node t.js`, root, parent),
    ).toEqual([inside]);
  });

  it("strips the scratchRoot only at a path boundary: a real path that merely starts with its spelling survives the strip", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "logs");
    fs.mkdirSync(scratchRoot);
    const sibling = path.join(root, "logsrc", "x.js");
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    // `<root>/logsrc/x.js` starts with `<root>/logs` as a string but is
    // NOT under it; a plain string removal would erase the prefix and
    // hide the escape.
    expect(escapingRootMentions(`node ${sibling}`, root, scratchRoot)).toEqual([
      sibling,
    ]);
    // The genuine copy path under the scratch root is still exempt.
    const copy = path.join(scratchRoot, "wt-1", "wt");
    expect(
      escapingRootMentions(`cd ${copy} && node t.js`, root, scratchRoot),
    ).toEqual([]);
  });

  it("a sibling directory whose name merely starts with the root is not a mention of the root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(escapingRootMentions(`ls '${root}2'; node t.js`, root)).toEqual([]);
    expect(escapingRootMentions(`ls ${root}-backup; node t.js`, root)).toEqual(
      [],
    );
    // The same command naming the root itself (a real boundary after
    // the spelling) still is one.
    expect(escapingRootMentions(`ls '${root}'; node t.js`, root)).toEqual([
      root,
    ]);
  });

  it("case-folds both sides only when told the filesystem is case-insensitive", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const miscased = root.toUpperCase();
    expect(miscased).not.toBe(root);
    // Injected flag rather than the ambient filesystem, so both branches
    // are exercised on every runner (the probe-level test in
    // probe-refusal-contract.test.ts covers the measured path).
    expect(
      escapingRootMentions(
        `cd '${miscased}/pkg' && node t.js`,
        root,
        undefined,
        true,
      ),
    ).toEqual([`${miscased}/pkg`]);
    expect(
      escapingRootMentions(
        `cd '${miscased}/pkg' && node t.js`,
        root,
        undefined,
        false,
      ),
    ).toEqual([]);
    // An exactly-spelled mention is reported either way.
    expect(
      escapingRootMentions(`cd '${root}' && node t.js`, root, undefined, false),
    ).toEqual([root]);
  });

  it("the case-insensitivity measurement answers for the filesystem the root sits on", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const insensitive = isCaseInsensitiveFilesystem(root);
    // Whatever this filesystem answers, the answer must be consistent
    // with what the flipped-case spelling actually resolves to.
    let flippedResolves = false;
    try {
      const own = fs.statSync(root);
      const other = fs.statSync(
        root.replace(/[A-Za-z]/g, (c) =>
          c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
        ),
      );
      flippedResolves = own.dev === other.dev && own.ino === other.ino;
    } catch {
      flippedResolves = false;
    }
    expect(insensitive).toBe(flippedResolves);
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

  // --- Separator noise INSIDE the root prefix. `<root>//pkg` and
  // `<root>/./pkg` reach exactly the directory `<root>/pkg` does, so a
  // needle matched character for character let the shell walk back
  // into the real tree while the run still produced a verdict. ---

  /** `<root>` with the separator before its last component doubled, so
   * the noise sits INSIDE the root prefix rather than after it. */
  function doubledSeparator(root: string): string {
    return `${path.dirname(root)}//${path.basename(root)}`;
  }

  /** `<root>` with a `.` ("this directory") segment before its last
   * component, again inside the root prefix. */
  function dotSegment(root: string): string {
    return `${path.dirname(root)}/./${path.basename(root)}`;
  }

  it("a duplicated separator inside the root prefix is still a mention of the root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const noisy = `${doubledSeparator(root)}/pkg`;
    expect(escapingRootMentions(`cd '${noisy}' && node t.js`, root)).toEqual([
      noisy,
    ]);
  });

  it("a `/./` segment inside the root prefix is still a mention of the root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const noisy = `${dotSegment(root)}/pkg`;
    expect(escapingRootMentions(`cd '${noisy}' && node t.js`, root)).toEqual([
      noisy,
    ]);
  });

  it("separator noise is tolerated in a --pre-shaped and an --env-shaped value too, and in a root spelled with a space", () => {
    const parent = makeTmpDir();
    const root = resolveDeepestExisting(
      path.resolve(fs.mkdtempSync(path.join(parent, "my repo-"))),
    );
    // The scan is channel-agnostic: `--pre` is another command string,
    // an `--env` value is the bare path, and both go through this same
    // function (`setup.ts`), so the noise tolerance holds for all
    // three.
    const pre = `cd ${dotSegment(root).replace(/ /g, "\\ ")} && npm ci`;
    expect(escapingRootMentions(pre, root)).toEqual([
      dotSegment(root).replace(/ /g, "\\ "),
    ]);
    const envValue = `${doubledSeparator(root)}/.cache`;
    expect(escapingRootMentions(envValue, root)).toEqual([envValue]);
  });

  it("the scratch-root exemption tolerates the same separator noise, so a noisy isolation-copy path stays exempt", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "aplogs");
    fs.mkdirSync(scratchRoot, { recursive: true });
    const noisyCopy = `${doubledSeparator(scratchRoot)}/wt-1/wt`;
    // The noisy spelling names the isolation copy just as the exact
    // spelling does, so the exemption has to see it the same way the
    // detection sees the root.
    expect(
      escapingRootMentions(`cd ${noisyCopy} && node t.js`, root, scratchRoot),
    ).toEqual([]);
    // ... and still only for the scratch root: noise does not exempt a
    // sibling of it.
    const sibling = `${doubledSeparator(root)}/aplogsrc/x.js`;
    expect(escapingRootMentions(`node ${sibling}`, root, scratchRoot)).toEqual([
      sibling,
    ]);
  });

  it("a `..` segment is NOT tolerated: it names a different directory, and normalising is outside this rule (documented residual)", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const walked = `${path.dirname(root)}/x/../${path.basename(root)}/pkg`;
    expect(escapingRootMentions(`cd '${walked}' && node t.js`, root)).toEqual(
      [],
    );
  });

  it("a root containing regex metacharacters matches only itself: a sibling differing at one of them is not a mention, and the root's own spelling still is", () => {
    const parent = resolveDeepestExisting(path.resolve(makeTmpDir()));
    // A false POSITIVE if `.` reaches the matcher unescaped: it would
    // match ANY character there, so a sibling differing exactly at the
    // dot would read as a mention of the root.
    const dotted = path.join(parent, "re.po");
    fs.mkdirSync(dotted);
    expect(
      escapingRootMentions(`cd ${dotted}/pkg && node t.js`, dotted),
    ).toEqual([`${dotted}/pkg`]);
    expect(
      escapingRootMentions(
        `cd ${path.join(parent, "reXpo")}/pkg && node t.js`,
        dotted,
      ),
    ).toEqual([]);
    // A false NEGATIVE (or an outright crash) if the others do: `+`
    // would quantify the character before it, `(` would open a group,
    // and an unterminated `[` does not compile at all, so the root
    // would stop matching its own literal spelling.
    const meta = path.join(parent, "a+b(c)[d");
    fs.mkdirSync(meta);
    expect(escapingRootMentions(`cd '${meta}' && node t.js`, meta)).toEqual([
      meta,
    ]);
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
