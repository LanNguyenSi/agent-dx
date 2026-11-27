/**
 * `commitParents`, with git replaced: what it asks git for, and that an
 * answer of another form than one line of full commit ids is an error and
 * never a list of parents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitParents } from "../../src/approve/index.js";
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
