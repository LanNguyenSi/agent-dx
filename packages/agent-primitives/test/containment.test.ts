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

  it("the exemption window is half-open: a root mention starting exactly where the scratch mention ENDS is still reported", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "aplogs");
    fs.mkdirSync(scratchRoot, { recursive: true });
    // `<scratchRoot><root>/pkg` puts a second, independent mention of
    // the root at exactly the index the scratch mention ends at. It
    // names a real directory under the repository root that is NOT the
    // isolation copy, so it must still be reported; an exemption whose
    // upper bound included its own end index would swallow it. The
    // first mention (the root's own leading spelling, inside the
    // scratch mention) stays exempt either way, which is what makes
    // this pin the END of the window rather than its start.
    expect(
      escapingRootMentions(
        `cd ${scratchRoot}${root}/pkg && node t.js`,
        root,
        scratchRoot,
      ),
    ).toEqual([`${root}/pkg`]);
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

  /** `<root>` with the separator before its last component escaped
   * (`\/`), so the escape sits INSIDE the root prefix. A shell reads
   * `\/` as `/`, so this reaches exactly the directory `<root>` does. */
  function escapedSeparator(root: string): string {
    return `${path.dirname(root)}\\/${path.basename(root)}`;
  }

  it("an escaped separator right AFTER the root is a boundary, so `<root>\\/pkg` is a mention of the root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    // `\/` is `/` to the shell, so this command reaches `<root>/pkg`.
    // The match ends at the `\`, which only counts as the end of the
    // path because a `/` follows it.
    expect(escapingRootMentions(`cd ${root}\\/pkg && node t.js`, root)).toEqual(
      [`${root}\\/pkg`],
    );
    // Quoted and in a bare (env-shaped) value, the same way.
    expect(
      escapingRootMentions(`cd '${root}\\/pkg' && node t.js`, root),
    ).toEqual([`${root}\\/pkg`]);
    expect(escapingRootMentions(`${root}\\/.cache`, root)).toEqual([
      `${root}\\/.cache`,
    ]);
  });

  it("an escaped separator INSIDE the root prefix is still a mention of the root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const noisy = `${escapedSeparator(root)}/pkg`;
    expect(escapingRootMentions(`cd '${noisy}' && node t.js`, root)).toEqual([
      noisy,
    ]);
  });

  it("a BARE backslash after the root is not a boundary: a sibling spelled with an escaped space is not a mention of the root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    // `<root>\ backup` is one token naming a SIBLING whose name ends in
    // a space and `backup`, not the root followed by a separator. The
    // `\/` boundary above must not widen to every backslash.
    expect(
      escapingRootMentions(`ls ${root}\\ backup; node t.js`, root),
    ).toEqual([]);
    // The escaped-space spelling of the ROOT itself is still reported
    // (it is the root, not a sibling), which is what distinguishes the
    // two: the escaped space sits INSIDE the root's own name there.
    const spacedParent = makeTmpDir();
    const spacedRoot = resolveDeepestExisting(
      path.resolve(fs.mkdtempSync(path.join(spacedParent, "my repo-"))),
    );
    const escaped = spacedRoot.replace(/ /g, "\\ ");
    expect(
      escapingRootMentions(`cd ${escaped} && node t.js`, spacedRoot),
    ).toEqual([escaped]);
  });

  // --- The boundary rule as a TOTAL classification. The rule
  // enumerates what CONTINUES a path word (a component NAME character,
  // a `/`, or a backslash pair) instead of enumerating what terminates
  // one, so every character has an answer and there is no third state.
  // The two tables below walk that whole alphabet, so a neighbouring
  // spelling cannot sit unclassified between two enumerated ones. ---

  /** The characters that continue a component NAME, stated here
   * independently of the implementation: the POSIX portable filename
   * character set. `/` is deliberately NOT in here -- it continues the
   * WORD, but as a further component, so it leaves the match a mention
   * of the root (`<root>/pkg` names the root). */
  const NAME_CHARACTERS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";

  /** Every printable ASCII character (0x20..0x7e) plus TAB, LF, CR, VT,
   * FF and DEL: the alphabet a scanned `-t`/`--pre`/`--env` string
   * realistically carries right after a path. None of the three
   * control characters added on top of the original TAB/LF/CR set is a
   * name character, so both tables below already classify them
   * correctly; they are included so the exhaustive walk actually
   * exercises them instead of silently skipping them. */
  function scannedCharacters(): string[] {
    const chars: string[] = ["\t", "\n", "\r", "\v", "\f", "\x7f"];
    for (let code = 0x20; code <= 0x7e; code++) {
      chars.push(String.fromCharCode(code));
    }
    return chars;
  }

  it("every printable ASCII character, TAB, LF and CR after the root spelling is either a name continuation (NOT a mention) or a boundary (a mention), with no third state", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const wrong: string[] = [];
    for (const ch of scannedCharacters()) {
      const continuesName = NAME_CHARACTERS.includes(ch);
      // Case folding is injected rather than measured, so the table
      // reads the same on a case-sensitive and a case-insensitive
      // runner; the case rule has its own test above.
      const mentions = escapingRootMentions(
        `${root}${ch}`,
        root,
        undefined,
        false,
      );
      if (mentions.length > 0 === continuesName) {
        wrong.push(
          `${JSON.stringify(ch)}: expected ${
            continuesName ? "no mention" : "a mention"
          }, got ${JSON.stringify(mentions)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a non-ASCII character continues the name too, so a sibling spelled with one is not a mention", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    expect(
      escapingRootMentions(`ls ${root}ä; node t.js`, root, undefined, false),
    ).toEqual([]);
    expect(
      escapingRootMentions(`ls ${root}中; node t.js`, root, undefined, false),
    ).toEqual([]);
  });

  it("a `\\` plus each of those characters after the root spelling is a mention only for `\\/`, `\\`+newline, and an ANSI-C numeric-escape starter (`x`, `u`, `U`, `0`-`7`)", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const wrong: string[] = [];
    const isAnsiCNumericEscapeStarter = (ch: string): boolean =>
      ch === "x" || ch === "u" || ch === "U" || (ch >= "0" && ch <= "7");
    for (const ch of scannedCharacters()) {
      // `\/` is a separator (every POSIX shell reads it as `/`), a
      // `\`+newline pair is DELETED before the word is lexed, so what
      // follows the pair decides -- here nothing follows, which ends
      // the word -- and `\x`/`\u`/`\U`/`\0`-`\7` start an ANSI-C
      // (`$'...'`) numeric escape that CAN decode to a separator, so
      // the scan ends the word there too (over-refusing in the safe
      // direction, since most of those escapes decode to something
      // else). Every other `\X` escapes a character inside the SAME
      // word, so the spelling is a different path's prefix.
      const expectMention =
        ch === "/" || ch === "\n" || isAnsiCNumericEscapeStarter(ch);
      const mentions = escapingRootMentions(
        `${root}\\${ch}`,
        root,
        undefined,
        false,
      );
      if (mentions.length > 0 !== expectMention) {
        wrong.push(
          `${JSON.stringify(`\\${ch}`)}: expected ${
            expectMention ? "a mention" : "no mention"
          }, got ${JSON.stringify(mentions)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("what follows a `\\`+newline pair decides, since the shell deletes the pair", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    // A separator after the pair: still the root, one component deeper.
    expect(
      escapingRootMentions(`node ${root}\\\n/pkg/t.js`, root, undefined, false),
    ).toEqual([`${root}\\\n/pkg/t.js`]);
    // A name character after the pair: a SIBLING, not the root.
    expect(
      escapingRootMentions(
        `ls ${root}\\\n-backup; node t.js`,
        root,
        undefined,
        false,
      ),
    ).toEqual([]);
    // Two pairs in a row are deleted just the same.
    expect(
      escapingRootMentions(
        `node ${root}\\\n\\\n/pkg/t.js`,
        root,
        undefined,
        false,
      ),
    ).toEqual([`${root}\\\n\\\n/pkg/t.js`]);
  });

  // --- ANSI-C (`$'...'`) numeric escapes. bash/dash decode `\xHH`,
  // `\uHHHH`/`\UHHHHHHHH` and `\NNN` (octal) by numeric value inside a
  // `$'...'` word, and `/` (0x2f) is reachable through any of them:
  // `$'<root>\x2fpkg'`, `$'<root>\057pkg'` and `$'<root>/pkg'` all
  // reach `<root>/pkg` exactly as `$'<root>/pkg'` does. Classifying `\`
  // followed by `x` (or `u`/`U`/an octal digit) as an in-word escape
  // left these ANSI-C forms reading as a different path's prefix, so
  // they were NOT refused while the shell still reached the real
  // tree. ---

  it("the ANSI-C forms that decode to a separator are mentions, same as the un-escaped control", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    for (const text of [
      `cd $'${root}\\x2fpkg' && node t.js`,
      `cd $'${root}\\057pkg' && node t.js`,
      `cd $'${root}\\u002fpkg' && node t.js`,
    ]) {
      // The region ends right before the ANSI-C escape: the scan does
      // not decode it, so it cannot report `<root>/pkg` as the region,
      // only the bare root that is actually matched literally.
      expect({ text, mentions: escapingRootMentions(text, root) }).toEqual({
        text,
        mentions: [root],
      });
    }
    // The control: an un-escaped `/` inside the same `$'...'` quoting
    // is a mention as usual, region extended through `/pkg`.
    const control = `cd $'${root}/pkg' && node t.js`;
    expect(escapingRootMentions(control, root)).toEqual([`${root}/pkg`]);
    // The sibling control is unaffected: a bare backslash-escaped space
    // still does not end the root's spelling.
    expect(
      escapingRootMentions(`ls ${root}\\ backup; node t.js`, root),
    ).toEqual([]);
  });

  it("the scratch-root exemption match uses the NARROW boundary rule: an ANSI-C starter right after the scratch spelling does not manufacture an exempt region that lets a --log-dir escape at the junction slip through unrefused", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    // `$'<root>/l\x69b/fixture.test.js'`: the scratch spelling
    // `<root>/l` ends right at the `\`+`x`. Under the (wrong) wide
    // rule that reads as a boundary, the resulting exempt region sits
    // at the same start index as the ROOT's own mention, so the root
    // mention gets skipped too. Under the narrow rule the scratch
    // match is rejected outright, so the root mention -- reported with
    // the ANSI-C truncation the un-exempted case already pins above,
    // extended through the `/l` component that precedes the escape --
    // still comes through.
    const text = `node $'${root}/l\\x69b/fixture.test.js'`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      `${root}/l`,
    ]);
  });

  it("the ANSI-C analogue of the scratchRoot boundary property: a real path that merely starts with the scratch spelling, spelled with an ANSI-C escape, still reports the root", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "logs");
    fs.mkdirSync(scratchRoot);
    // `\x72` decodes to `r`, so the shell reads this as
    // `<root>/logsrc/x.js` -- the same sibling shape the plain-text
    // pin above covers, spelled with an ANSI-C escape instead of a
    // literal `r`. The scan does not decode the escape, so it cannot
    // report the sibling path; what it reports is the ROOT match,
    // truncated (by `pathRegionEnd`) right before the escape.
    const text = `node $'${root}/logs\\x72c/x.js'`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      `${root}/logs`,
    ]);
    // The genuine exemption (a real path under the scratch root, no
    // escape involved) still works.
    const copy = path.join(scratchRoot, "wt-1", "wt");
    expect(
      escapingRootMentions(`cd ${copy} && node t.js`, root, scratchRoot),
    ).toEqual([]);
  });

  it("a longer path that merely CONTAINS the root's spelling is refused too: no boundary is required at the match's START (by-design over-refusal)", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    // `/mnt/backup<root>/pkg` and `x<root>/pkg` are not the root, and
    // not paths under it either, but the scan matches the root's
    // SPELLING wherever it occurs, with no requirement that a boundary
    // (whitespace, a separator, the start of the string) precede it.
    // The reported region starts at the root's own spelling, not at
    // the start of the longer path -- a bind mount or backup mirror
    // such as `/mnt/host<root>/...` reaches the real tree exactly the
    // same way.
    expect(
      escapingRootMentions(`cd /mnt/backup${root}/pkg && node t.js`, root),
    ).toEqual([`${root}/pkg`]);
    expect(escapingRootMentions(`cd x${root}/pkg && node t.js`, root)).toEqual([
      `${root}/pkg`,
    ]);
  });

  it("the sibling controls stay siblings and the deeper-path and word-ending controls stay mentions", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    for (const text of [
      `ls ${root}2; node t.js`,
      `ls ${root}-backup; node t.js`,
      `ls ${root}\\ backup; node t.js`,
      `ls ${root}\\\n-backup; node t.js`,
    ]) {
      expect({ text, mentions: escapingRootMentions(text, root) }).toEqual({
        text,
        mentions: [],
      });
    }
    for (const [text, region] of [
      [`cd ${root} && node t.js`, root],
      [`cd ${root}/pkg && node t.js`, `${root}/pkg`],
      [`cd ${root}\\/pkg && node t.js`, `${root}\\/pkg`],
      [`cd ${root}\\\n/pkg && node t.js`, `${root}\\\n/pkg`],
      // A POSIX operator ends the word with no whitespace at all, so
      // the path IS the root in each of these three.
      [`cd ${root}>/dev/null; node pkg/t.js`, root],
      [`cd ${root}<&-; node pkg/t.js`, root],
      ["node `echo " + root + "`/pkg/t.js", root],
    ] as [string, string][]) {
      expect({ text, mentions: escapingRootMentions(text, root) }).toEqual({
        text,
        mentions: [region],
      });
    }
  });

  it("a line continuation INSIDE the root prefix is tolerated on either side of the separator", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const parent = path.dirname(root);
    const base = path.basename(root);
    // Before the separator ...
    const before = `${parent}\\\n/${base}/pkg`;
    expect(escapingRootMentions(`cd ${before} && node t.js`, root)).toEqual([
      before,
    ]);
    // ... and after it.
    const after = `${parent}/\\\n${base}/pkg`;
    expect(escapingRootMentions(`cd ${after} && node t.js`, root)).toEqual([
      after,
    ]);
    // Combined with the `/./` noise the rule already tolerated.
    const both = `${parent}\\\n/.\\\n/${base}/pkg`;
    expect(escapingRootMentions(`cd ${both} && node t.js`, root)).toEqual([
      both,
    ]);
  });

  it("an ANSI-C escape decoding the separator INSIDE the root's own prefix is NOT tolerated (documented residual): the widened rule only ends a match at the boundary AFTER a spelling, never inside one", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const parent = path.dirname(root);
    const base = path.basename(root);
    // `\x2f` decodes to `/`, so a shell reads this as
    // `${parent}/${base}/pkg`, i.e. `${root}/pkg` -- but the literal
    // text never contains that spelling contiguously (the separator
    // between `parent` and `base` is spelled `\x2f`, not `/`), and the
    // boundary rule that treats `\`+ANSI-C-starter specially only ever
    // fires at the END of an already-matched spelling, not while
    // still trying to match one. So this is a residual, the same as
    // the plain-text `/x/re\po` split-from-the-inside case, and stays
    // unmatched rather than silently starting to match (or silently
    // stopping to match) without a test noticing.
    const interior = `${parent}\\x2f${base}/pkg`;
    expect(
      escapingRootMentions(`cd $'${interior}' && node t.js`, root),
    ).toEqual([]);
  });

  it("a `..` segment is NOT tolerated: it names a different directory, and normalising is outside this rule (documented residual)", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const walked = `${path.dirname(root)}/x/../${path.basename(root)}/pkg`;
    expect(escapingRootMentions(`cd '${walked}' && node t.js`, root)).toEqual(
      [],
    );
    // The discriminating case: this spelling differs from the matching
    // `<parent>/./<base>/pkg` in the `..` and NOTHING else, so a
    // separator pattern that tolerated `..` alongside `.` would report
    // it (and would report `<parent>/../<base>` as an escape into a
    // root the command never reaches).
    const onlyDots = `${path.dirname(root)}/../${path.basename(root)}/pkg`;
    expect(escapingRootMentions(`cd '${onlyDots}' && node t.js`, root)).toEqual(
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

describe("escapingRootMentions(): the SCRATCH spelling's own boundary rule", () => {
  it("a `@` sibling of the --log-dir is reported, not exempted: the exclusion's match must not read `@` as ending the log dir's spelling", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    // `<root>/l@2/y.js` names a SIBLING of the log dir (`<root>/l@2`),
    // not the log dir itself, so it must not be excluded along with
    // it; the root mention it also contains (the `<root>/l` prefix it
    // shares with the log dir's own spelling) must survive.
    const text = `node ${scratchRoot}@2/y.js`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      scratchRoot,
    ]);
  });

  it("a `~` sibling of the --log-dir is reported, not exempted", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    const text = `node ${scratchRoot}~2/y.js`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      scratchRoot,
    ]);
  });

  it("a `$`-expansion suffix right after the --log-dir spelling is reported: `$` starts an expansion this scan does not model, so it must not end the exclusion's match either", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    const text = `node ${scratchRoot}$SUFFIX/y.js`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      scratchRoot,
    ]);
  });

  it("the other filename-legal word terminators from the same sibling shape (`,`, `=`, `{`, `?`) are reported too", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    for (const suffix of [",2/y.js", "=2/y.js", "{2}/y.js", "?2/y.js"]) {
      const text = `node ${scratchRoot}${suffix}`;
      expect({
        suffix,
        mentions: escapingRootMentions(text, root, scratchRoot),
      }).toEqual({ suffix, mentions: [scratchRoot] });
    }
  });

  it("the real exemption still holds: a genuine isolation-copy path under the --log-dir is excluded, not reported", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    const copy = path.join(scratchRoot, "wt-1", "wt");
    expect(
      escapingRootMentions(`cd ${copy} && node t.js`, root, scratchRoot),
    ).toEqual([]);
  });

  it("the exact-name sibling `<root>/l2` stays refused (unaffected control): a portable-set character right after the log dir's spelling never validated the exclusion's match, before or after this change", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    // `<root>/l2/y.js` is itself a path under the repository root (not
    // merely a prefix collision with the log dir), so it is a genuine
    // root mention and must stay refused; "2" never validated the
    // scratch match as ending at the log dir's spelling either, under
    // the old narrow rule or the new one, so this control is
    // unaffected by the boundary change.
    const text = `node ${scratchRoot}2/y.js`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      text.slice(5),
    ]);
  });
});

describe("escapingRootMentions(): closing isHardWordEnder's non-ASCII-whitespace and quote/backtick gaps (round 2)", () => {
  it("siblings named with a non-ASCII whitespace code point (U+00A0, U+3000, U+FEFF) right after the --log-dir spelling are reported, not exempted", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    // None of these is a shell IFS separator and all are legal
    // filename characters, so `/\s/` (the regex class the ender check
    // shipped with) wrongly treated each as ending the scratch match;
    // a `$` right after the whitespace char stops the reported
    // region's own extension so the expectation stays a single
    // appended character.
    for (const ws of [" ", "　", "﻿"]) {
      const text = `node ${scratchRoot}${ws}$X`;
      expect({
        ws,
        mentions: escapingRootMentions(text, root, scratchRoot),
      }).toEqual({ ws, mentions: [`${scratchRoot}${ws}`] });
    }
  });

  it("a sibling named with a CR right after the --log-dir spelling is reported, not exempted", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    // CR is not a shell IFS separator either and is a legal filename
    // character; unlike the non-ASCII cases above, `continuesComponentName`
    // already rejects it (it is ASCII and outside the portable set), so
    // the reported region stops right at it rather than absorbing it.
    const text = `node ${scratchRoot}\r2/y.js`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      scratchRoot,
    ]);
  });

  it("siblings continued by a quote or a backtick right after the --log-dir spelling are reported, not exempted: the shell re-joins the word across the quoted or substituted segment", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    // `/x/l"2"/y.js` lexes as the single shell word `/x/l2/y.js`, and a
    // backtick command substitution re-joins the same way, so treating
    // the quote or backtick as ending the scratch match wrongly
    // exempted the real sibling `<root>/l2` along with the log dir.
    for (const suffix of ['"2"/y.js', "'2'/y.js", "`2`/y.js"]) {
      const text = `node ${scratchRoot}${suffix}`;
      expect({
        suffix,
        mentions: escapingRootMentions(text, root, scratchRoot),
      }).toEqual({ suffix, mentions: [scratchRoot] });
    }
  });

  it("a BARE quoted --log-dir mention that ends exactly at its own closing quote is now reported: the documented over-refusal fix 2 trades for closing the quote/backtick sibling gap above", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    const text = `cd '${scratchRoot}' && node t.js`;
    expect(escapingRootMentions(text, root, scratchRoot)).toEqual([
      scratchRoot,
    ]);
  });

  it("the genuine exemption still holds, unquoted and inside quotes, when a further path segment follows", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    const copy = path.join(scratchRoot, "wt-1", "wt");
    expect(
      escapingRootMentions(`cd ${copy} && node t.js`, root, scratchRoot),
    ).toEqual([]);
    // Wrapping the same genuine mention in quotes does not disturb the
    // exemption: it is decided by the character right after the
    // literal --log-dir spelling (here `/`, checked before
    // `isHardWordEnder` is even consulted), not by whether a quote
    // encloses the whole thing.
    expect(
      escapingRootMentions(`cd '${copy}' && node t.js`, root, scratchRoot),
    ).toEqual([]);
  });

  it("a miscased sibling named with a non-ASCII whitespace code point is reported under an injected caseInsensitive flag", () => {
    const root = resolveDeepestExisting(path.resolve(makeTmpDir()));
    const scratchRoot = path.join(root, "l");
    fs.mkdirSync(scratchRoot);
    const miscased = scratchRoot.toUpperCase();
    expect(miscased).not.toBe(scratchRoot);
    const text = `node ${miscased} $X`;
    expect(
      escapingRootMentions(text, root, scratchRoot, true),
    ).toEqual([`${miscased} `]);
  });
});
