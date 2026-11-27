/**
 * The git reads of the merged mode, with git replaced: what each asks git
 * for, and that an answer of another form than the one it expects is an
 * error and never a list, a count or a full history.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitParents,
  commitsBetween,
  firstParentChain,
  isShallow,
} from "../../src/approve/index.js";
import { LintGitError } from "../../src/lint/git/index.js";

const seam = vi.hoisted(() => ({
  /** What git answers. */
  answer: { status: 0, stdout: "" },
  /** The argument lists git was started with. */
  calls: [] as string[][],
}));

vi.mock("../../src/lint/git/exec.js", async (original) => {
  const actual = await original<typeof import("../../src/lint/git/exec.js")>();
  return {
    ...actual,
    runGit: (_cwd: string, args: readonly string[]) => {
      seam.calls.push([...args]);
      return {
        status: seam.answer.status,
        stdout: Buffer.from(seam.answer.stdout, "utf8"),
      };
    },
  };
});

beforeEach(() => {
  seam.answer = { status: 0, stdout: "" };
  seam.calls.length = 0;
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const LONG = "d".repeat(64);

describe("commitParents: the answer of git", () => {
  it("asks for one commit with its parents, the id behind the end of the options", () => {
    seam.answer = { status: 0, stdout: `${A} ${B}\n` };
    expect(commitParents("/repo", A)).toEqual([B]);
    expect(seam.calls).toEqual([
      ["rev-list", "--parents", "--max-count=1", "--end-of-options", A],
    ]);
  });

  it.each([
    ["no parent", `${A}\n`, []],
    ["one parent", `${A} ${B}\n`, [B]],
    ["two parents, in their order", `${A} ${C} ${B}\n`, [C, B]],
    ["a parent with a long id", `${A} ${LONG}\n`, [LONG]],
  ])("reads %s", (_what, stdout, parents) => {
    seam.answer = { status: 0, stdout };
    expect(commitParents("/repo", A)).toEqual(parents);
  });

  it.each([
    ["an exit status other than 0, whatever was printed", 1, `${A} ${B}\n`],
    ["nothing printed", 0, ""],
    ["another commit than the one asked for", 0, `${B} ${C}\n`],
    ["a parent that is no full commit id", 0, `${A} ${B.slice(0, 12)}\n`],
    ["a parent in upper case", 0, `${A} ${B.toUpperCase()}\n`],
    ["a second line", 0, `${A} ${B}\n${A} ${C}\n`],
    ["a space at the end of the line", 0, `${A} ${B} \n`],
    ["two spaces between the ids", 0, `${A}  ${B}\n`],
  ])("throws on %s", (_what, status, stdout) => {
    seam.answer = { status, stdout };
    let error: unknown;
    try {
      commitParents("/repo", A);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(LintGitError);
    expect((error as LintGitError).code).toBe("git-failed");
    expect((error as LintGitError).message).toBe(
      "git could not list the parents of a commit",
    );
  });

  it("does not start git for a value that is no full commit id", () => {
    seam.answer = { status: 0, stdout: `HEAD ${B}\n` };
    for (const value of ["HEAD", "--all", A.slice(0, 39), `${A}^`, ""]) {
      expect(() => commitParents("/repo", value)).toThrow(LintGitError);
    }
    expect(seam.calls).toEqual([]);
  });
});

describe("firstParentChain: the answer of git", () => {
  it("asks for the first parents only, up to the count, the id behind the end of the options", () => {
    seam.answer = { status: 0, stdout: `${A}\n${B}\n` };
    expect(firstParentChain("/repo", A, 3)).toEqual([A, B]);
    expect(seam.calls).toEqual([
      ["rev-list", "--first-parent", "--max-count=3", "--end-of-options", A],
    ]);
  });

  it.each([
    ["an exit status other than 0", 1, `${A}\n${B}\n`],
    ["nothing printed", 0, ""],
    ["another commit first", 0, `${B}\n${A}\n`],
    ["more commits than were asked for", 0, `${A}\n${B}\n${C}\n${A}\n`],
    ["a line that is no full commit id", 0, `${A}\n${B.slice(0, 12)}\n`],
    ["two ids on a line", 0, `${A} ${B}\n`],
    ["an empty line", 0, `${A}\n\n${B}\n`],
  ])("throws on %s", (_what, status, stdout) => {
    seam.answer = { status, stdout };
    expect(() => firstParentChain("/repo", A, 3)).toThrow(
      "git could not list the first parents of a commit",
    );
  });

  it("does not start git for a value that is no full commit id or a count that is no positive integer", () => {
    seam.answer = { status: 0, stdout: `${A}\n` };
    expect(() => firstParentChain("/repo", "HEAD", 2)).toThrow(LintGitError);
    for (const count of [0, -2, 1.5, Number.NaN, Infinity]) {
      expect(() => firstParentChain("/repo", A, count)).toThrow(LintGitError);
    }
    expect(seam.calls).toEqual([]);
  });
});

describe("commitsBetween: the answer of git", () => {
  it("asks for a count of the commits of one history that are not in another, up to the cap", () => {
    seam.answer = { status: 0, stdout: "4\n" };
    expect(commitsBetween("/repo", A, B, 51)).toBe(4);
    expect(seam.calls).toEqual([
      [
        "rev-list",
        "--count",
        "--max-count=51",
        "--end-of-options",
        `${A}..${B}`,
      ],
    ]);
    seam.answer = { status: 0, stdout: "0\n" };
    expect(commitsBetween("/repo", A, B, 51)).toBe(0);
  });

  it.each([
    ["an exit status other than 0", 1, "4\n"],
    ["nothing printed", 0, ""],
    ["no number", 0, "four\n"],
    ["a negative number", 0, "-4\n"],
    ["a number with a leading zero", 0, "04\n"],
    ["a fraction", 0, "4.5\n"],
    ["two lines", 0, "4\n5\n"],
    ["no line end", 0, "4"],
    ["a number of ten digits", 0, "1234567890\n"],
  ])("throws on %s", (_what, status, stdout) => {
    seam.answer = { status, stdout };
    expect(() => commitsBetween("/repo", A, B, 51)).toThrow(
      "git could not count commits",
    );
  });

  it("does not start git for values that are no full commit ids or a cap that is no positive integer", () => {
    seam.answer = { status: 0, stdout: "1\n" };
    expect(() => commitsBetween("/repo", "main", B, 5)).toThrow(LintGitError);
    expect(() => commitsBetween("/repo", A, "--all", 5)).toThrow(LintGitError);
    for (const cap of [0, -1, 2.5, Number.NaN]) {
      expect(() => commitsBetween("/repo", A, B, cap)).toThrow(LintGitError);
    }
    expect(seam.calls).toEqual([]);
  });
});

describe("isShallow: the answer of git", () => {
  it("reads true and false, and asks git that one question", () => {
    seam.answer = { status: 0, stdout: "true\n" };
    expect(isShallow("/repo")).toBe(true);
    seam.answer = { status: 0, stdout: "false\n" };
    expect(isShallow("/repo")).toBe(false);
    expect(seam.calls).toEqual([
      ["rev-parse", "--is-shallow-repository"],
      ["rev-parse", "--is-shallow-repository"],
    ]);
  });

  it.each([
    ["an exit status other than 0 with false printed", 1, "false\n"],
    ["nothing printed", 0, ""],
    ["another word", 0, "no\n"],
    ["false in upper case", 0, "FALSE\n"],
    ["false without a line end", 0, "false"],
    [
      "the option echoed, as a git that does not know it does",
      0,
      "--is-shallow-repository\n",
    ],
  ])(
    "throws on %s: an answer that is not false is never read as a full history",
    (_what, status, stdout) => {
      seam.answer = { status, stdout };
      expect(() => isShallow("/repo")).toThrow(
        "git could not say whether the repository is shallow",
      );
    },
  );
});
