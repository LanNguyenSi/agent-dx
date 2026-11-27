/**
 * `landingOf`: where a merged pull request landed, from git and from the
 * head and the merge commit the host reports. The shapes git can tell give
 * ranges; every other shape gives none.
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MERGED_COMMITS,
  commitParents,
  commitsBetween,
  firstParentChain,
  isShallow,
  landingOf,
  type LandingResult,
} from "../../src/approve/index.js";
import { LintGitError } from "../../src/lint/git/index.js";
import { REMOTE_MAIN, Repo } from "../lint/git-helpers.js";
import { build, crissCross, land, type Built } from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** Called instead of `mergeBases`; a value other than `undefined` is returned in its place. */
  // eslint-disable-next-line no-unused-vars
  mergeBases: undefined as ((a: string, b: string) => unknown) | undefined,
  /** The arguments of every call of `mergeBases`. */
  asked: [] as [string, string][],
}));

vi.mock("../../src/approve/git.js", async (original) => {
  const actual = await original<typeof import("../../src/approve/git.js")>();
  return {
    ...actual,
    mergeBases: (repo: string, a: string, b: string) => {
      seam.asked.push([a, b]);
      const instead = seam.mergeBases?.(a, b);
      return instead === undefined
        ? actual.mergeBases(repo, a, b)
        : (instead as string[]);
    },
  };
});

beforeEach(() => {
  seam.mergeBases = undefined;
  seam.asked.length = 0;
});

const NOT_TOLD =
  "where the pull request begins on the default branch cannot be told from git, so nothing is measured";
const NO_COMMIT = "0".repeat(40);

/** A commit with the tree of `like` and the given parents, on no branch. */
async function craft(
  repo: Repo,
  like: string,
  parents: string[],
): Promise<string> {
  const tree = await repo.sh("rev-parse", `${like}^{tree}`);
  return repo.sh(
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    "crafted",
  );
}

const merged = (head: string, mergeCommit: string | null) => ({
  head,
  merged: true,
  mergeCommit,
});

const refusal = (result: LandingResult): { code: string; message: string } => {
  if (result.ok) throw new Error("a landing was derived");
  return { code: result.code, message: result.message };
};

describe("commitParents", { timeout: 60_000 }, () => {
  it("lists the parents of a merge commit, the first parent first, of a plain commit and of a root", async () => {
    const m = await land(await build(), "merge-commit");
    const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
    expect(commitParents(m.dir, m.merge)).toEqual([first, m.head]);
    expect(commitParents(m.dir, m.head)).toEqual([m.draft]);
    const root = await m.repo.sh("rev-list", "--max-parents=0", m.merge);
    expect(commitParents(m.dir, root)).toEqual([]);
  });

  it("lists three parents in their order", async () => {
    const s = await build();
    const octopus = await craft(s.repo, s.head, [s.c1, s.head, s.draft]);
    expect(commitParents(s.dir, octopus)).toEqual([s.c1, s.head, s.draft]);
  });

  it("throws for a value that is no full commit id, and for a commit the repository does not have", async () => {
    const s = await build();
    const thrown = (value: string): LintGitError => {
      try {
        commitParents(s.dir, value);
      } catch (err) {
        expect(err).toBeInstanceOf(LintGitError);
        return err as LintGitError;
      }
      throw new Error("nothing was thrown");
    };
    // A value git would resolve, such as `HEAD`, never reaches git.
    for (const value of ["HEAD", "--all", s.head.slice(0, 12), `${s.head}^`]) {
      expect(thrown(value).code).toBe("not-a-commit");
    }
    expect(thrown(NO_COMMIT).code).toBe("git-failed");
    expect(thrown(NO_COMMIT).message).toBe(
      "git could not list the parents of a commit",
    );
  });

  it("works in a SHA-256 repository", async () => {
    const repo = await Repo.create({ sha256: true });
    const one = await repo.commit({ "a.txt": "a\n" }, "one");
    const two = await repo.commit({ "a.txt": "b\n" }, "two");
    expect(two).toHaveLength(64);
    expect(commitParents(repo.dir, two)).toEqual([one]);
  });
});

describe(
  "firstParentChain, commitsBetween, isShallow",
  { timeout: 60_000 },
  () => {
    it("lists a commit and its first parents, never the second parent of a merge, and stops at the count or at the root", async () => {
      const m = await land(await build(), "merge-commit");
      const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
      const below = await m.repo.sh("rev-parse", `${first}^1`);
      expect(firstParentChain(m.dir, m.merge, 1)).toEqual([m.merge]);
      expect(firstParentChain(m.dir, m.merge, 3)).toEqual([
        m.merge,
        first,
        below,
      ]);
      const all = firstParentChain(m.dir, m.merge, 99);
      expect(all).not.toContain(m.head);
      expect(all.at(-1)).toBe(
        await m.repo.sh("rev-list", "--max-parents=0", m.merge),
      );
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => firstParentChain(m.dir, m.merge, bad)).toThrow(
          LintGitError,
        );
      }
      expect(() => firstParentChain(m.dir, "HEAD", 2)).toThrow(LintGitError);
      expect(() => firstParentChain(m.dir, NO_COMMIT, 2)).toThrow(LintGitError);
    });

    it("counts the commits between two commits, merges included, up to the cap", async () => {
      const s = await build();
      expect(commitsBetween(s.dir, s.c1, s.head, 99)).toBe(2);
      expect(commitsBetween(s.dir, s.head, s.c1, 99)).toBe(0);
      expect(commitsBetween(s.dir, s.c1, s.head, 1)).toBe(1);
      await s.repo.checkout("main");
      const newer = await s.repo.commit({ "more.txt": "m\n" }, "main moves");
      await s.repo.checkout("pr");
      await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge main", newer);
      // The merge commit counts; the commit of main it merged does not.
      expect(commitsBetween(s.dir, newer, await s.repo.head(), 99)).toBe(3);
      for (const bad of [0, -1, 1.5]) {
        expect(() => commitsBetween(s.dir, s.c1, s.head, bad)).toThrow(
          LintGitError,
        );
      }
      expect(() => commitsBetween(s.dir, "main", s.head, 9)).toThrow(
        LintGitError,
      );
      expect(() => commitsBetween(s.dir, s.c1, "pr", 9)).toThrow(LintGitError);
      expect(() => commitsBetween(s.dir, NO_COMMIT, s.head, 9)).toThrow(
        LintGitError,
      );
    });

    it("tells a full repository from a shallow one", async () => {
      const s = await build();
      expect(isShallow(s.dir)).toBe(false);
      const clone = `${s.dir}-shallow`;
      await s.repo.sh("clone", "-q", "--depth", "1", `file://${s.dir}`, clone);
      try {
        expect(isShallow(clone)).toBe(true);
      } finally {
        fs.rmSync(clone, { recursive: true, force: true });
      }
    });
  },
);

describe("landingOf: the shapes git can tell", { timeout: 60_000 }, () => {
  it("a merge commit whose second parent is the head: one range, from the first parent", async () => {
    const m = await land(await build(), "merge-commit");
    const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
    expect(landingOf(m.dir, merged(m.head, m.merge), m.landed)).toEqual({
      ok: true,
      landing: {
        merge: m.merge,
        firstParent: first,
        shape: "merge-commit",
        reviewedBase: null,
        commits: 1,
        landedFrom: first,
        ranges: [{ from: first, to: m.merge }],
      },
    });
    // No merge base is asked for: the one range holds the whole merge.
    expect(seam.asked).toEqual([]);
  });

  it("a squash merge of two commits: two first-parent steps below the merge commit, and the reviewed commits from their merge base with its parent", async () => {
    const m = await land(await build(), "squash");
    const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
    const second = await m.repo.sh("rev-parse", `${m.merge}~2`);
    expect(landingOf(m.dir, merged(m.head, m.merge), m.landed)).toEqual({
      ok: true,
      landing: {
        merge: m.merge,
        firstParent: first,
        shape: "single-commit",
        reviewedBase: m.c1,
        commits: 2,
        landedFrom: second,
        ranges: [
          { from: first, to: m.merge },
          { from: second, to: first },
          { from: m.c1, to: m.head },
        ],
      },
    });
    expect(seam.asked).toEqual([[m.head, first]]);
  });

  it("a pull request of one commit: one step", async () => {
    const s = await build({ propose: false });
    const m = await land(s, "squash");
    const result = landingOf(m.dir, merged(m.head, m.merge), m.landed);
    expect(result).toMatchObject({
      ok: true,
      landing: {
        commits: 1,
        landedFrom: await m.repo.sh("rev-parse", `${m.merge}~1`),
      },
    });
    expect(result.ok && result.landing.ranges).toHaveLength(2);
  });

  it("a pull request with more commits than the cap: merge-shape-unknown, at the cap it is measured", async () => {
    const m = await land(await build(), "squash");
    expect(MAX_MERGED_COMMITS).toBe(50);
    expect(
      refusal(landingOf(m.dir, merged(m.head, m.merge), m.landed, 1)),
    ).toEqual({
      code: "merge-shape-unknown",
      message:
        "the pull request holds more than 1 commits; a squash or rebase merge of that many is not measured",
    });
    expect(landingOf(m.dir, merged(m.head, m.merge), m.landed, 2).ok).toBe(
      true,
    );
  });

  it("a first-parent history below the merge commit that is shorter than the pull request: merge-shape-unknown", async () => {
    const s = await build();
    await s.repo.commit({ "notes.txt": "n\n" }, "notes");
    const head = await s.repo.head();
    // main holds two commits; the squash is its third, the pull request has three.
    await s.repo.checkout("main");
    await s.repo.sh("merge", "-q", "--squash", "pr");
    const merge = await s.repo.commit({}, "squash pr");
    expect(commitsBetween(s.dir, s.c1, head, 99)).toBe(3);
    expect(firstParentChain(s.dir, merge, 99)).toHaveLength(3);
    expect(refusal(landingOf(s.dir, merged(head, merge), merge))).toEqual({
      code: "merge-shape-unknown",
      message: `the first-parent history of the merge commit holds fewer than the 3 commits of the pull request; ${NOT_TOLD}`,
    });
    // One commit less in the pull request and the history is just long enough.
    expect(landingOf(s.dir, merged(s.head, merge), merge).ok).toBe(true);
  });

  it("a rebase merge: the parent of the merge commit is a replayed commit, the reviewed base is where the branch started", async () => {
    const m = await land(await build(), "rebase");
    const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
    const result = landingOf(m.dir, merged(m.head, m.merge), m.landed);
    expect(result).toMatchObject({
      ok: true,
      landing: {
        firstParent: first,
        shape: "single-commit",
        reviewedBase: m.c1,
      },
    });
    // The first parent is not on the reviewed branch and not its base.
    expect(first).not.toBe(m.draft);
    expect(first).not.toBe(m.c1);
  });

  it("a branch that merged the default branch before the squash: the reviewed base is that default commit", async () => {
    const s = await build();
    await s.repo.checkout("main");
    const newer = await s.repo.commit({ "more.txt": "more\n" }, "main moves");
    await s.repo.setRef(REMOTE_MAIN, newer);
    await s.repo.checkout("pr");
    await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge main", newer);
    const m = await land(s, "squash");
    const result = landingOf(m.dir, merged(m.head, m.merge), m.landed);
    expect(result).toMatchObject({
      ok: true,
      landing: { shape: "single-commit", reviewedBase: newer },
    });
  });

  it("the merge commit may lie below the tip of the default branch", async () => {
    const m = await land(await build(), "squash");
    await m.repo.checkout("main");
    const later = await m.repo.commit({ "later.txt": "later\n" }, "later");
    const result = landingOf(m.dir, merged(m.head, m.merge), later);
    expect(result).toMatchObject({ ok: true, landing: { merge: m.merge } });
  });
});

describe("landingOf: not merged, or not on the default branch", () => {
  let m: Built & { merge: string; landed: string };

  beforeEach(async () => {
    m = await land(await build(), "squash");
  }, 60_000);

  it.each([
    ["false", false],
    ["a text that reads as true", "true"],
    ["the number 1", 1],
    ["nothing", undefined],
  ])(
    "merged given as %s: not-merged, whatever merge commit is named",
    (_what, flag) => {
      const result = landingOf(
        m.dir,
        { head: m.head, merged: flag as never, mergeCommit: m.merge },
        m.landed,
      );
      expect(refusal(result)).toEqual({
        code: "not-merged",
        message:
          "the host does not report the pull request as merged; the check after the merge judges a merged pull request only",
      });
    },
  );

  it("no merge commit: merge-not-on-default", () => {
    expect(refusal(landingOf(m.dir, merged(m.head, null), m.landed))).toEqual({
      code: "merge-not-on-default",
      message:
        "the host reports no merge commit for the merged pull request; there is no commit to look for on the default branch",
    });
  });

  it("a merge commit the repository does not have: merge-not-on-default", () => {
    expect(
      refusal(landingOf(m.dir, merged(m.head, NO_COMMIT), m.landed)).code,
    ).toBe("merge-not-on-default");
  });

  it("a merge commit that is a commit but not on the default branch: merge-not-on-default, naming it", () => {
    expect(refusal(landingOf(m.dir, merged(m.head, m.head), m.landed))).toEqual(
      {
        code: "merge-not-on-default",
        message: `the merge commit ${m.head} the host reports is not the commit the default ref names or an ancestor of it; the default branch may need to be fetched by the job`,
      },
    );
  });

  it("a merge commit that is a descendant of the default commit, not an ancestor: merge-not-on-default", async () => {
    const before = await m.repo.sh("rev-parse", `${m.merge}^`);
    expect(
      refusal(landingOf(m.dir, merged(m.head, m.merge), before)).code,
    ).toBe("merge-not-on-default");
  });

  it("a default commit that is no commit id is a git error, not a verdict", () => {
    expect(() => landingOf(m.dir, merged(m.head, m.merge), "main")).toThrow(
      LintGitError,
    );
  });
});

describe("landingOf: a shape git cannot tell", { timeout: 60_000 }, () => {
  it("the head is the merge commit (a fast-forward): merge-shape-unknown", async () => {
    const s = await build();
    const result = landingOf(s.dir, merged(s.head, s.head), s.head);
    expect(refusal(result)).toEqual({
      code: "merge-shape-unknown",
      message: `the head commit of the pull request is on the default branch without a merge commit of its own (a fast-forward, or a push of the branch); ${NOT_TOLD}`,
    });
    expect(seam.asked).toEqual([]);
  });

  it("the head lies below a later plain commit the host names: merge-shape-unknown", async () => {
    const s = await build();
    const later = await s.repo.commit({ "later.txt": "later\n" }, "later");
    const result = landingOf(s.dir, merged(s.head, later), later);
    expect(refusal(result).code).toBe("merge-shape-unknown");
    expect(refusal(result).message).toContain("without a merge commit");
  });

  it("a merge commit whose second parent is the head, which the first parent already held: merge-shape-unknown", async () => {
    // The branch reached the default branch by fast-forward; a merge commit
    // on top names it as second parent again and changes nothing.
    const s = await build();
    const later = await s.repo.commit({ "later.txt": "later\n" }, "later");
    const laundered = await craft(s.repo, later, [later, s.head]);
    expect(commitParents(s.dir, laundered)).toEqual([later, s.head]);
    const result = landingOf(s.dir, merged(s.head, laundered), laundered);
    expect(refusal(result)).toEqual({
      code: "merge-shape-unknown",
      message: `the head commit of the pull request was on the default branch before its merge commit; ${NOT_TOLD}`,
    });
  });

  it("a merge commit whose first parent is the head: merge-shape-unknown", async () => {
    const m = await land(await build(), "merge-commit");
    const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
    const swapped = await craft(m.repo, m.merge, [m.head, first]);
    const result = landingOf(m.dir, merged(m.head, swapped), swapped);
    expect(refusal(result)).toEqual({
      code: "merge-shape-unknown",
      message: `the merge commit has 2 parents and is not a merge of the head commit of the pull request into the default branch; ${NOT_TOLD}`,
    });
  });

  it("a merge commit of another branch than the head: merge-shape-unknown", async () => {
    const m = await land(await build(), "merge-commit");
    // The host names the draft commit as the head; the merge merged its child.
    const result = landingOf(m.dir, merged(m.draft, m.merge), m.landed);
    expect(refusal(result).code).toBe("merge-shape-unknown");
    expect(refusal(result).message).toContain("has 2 parents");
  });

  it("a merge commit with three parents, the head among them: merge-shape-unknown", async () => {
    const m = await land(await build(), "merge-commit");
    const first = await m.repo.sh("rev-parse", `${m.merge}^1`);
    const octopus = await craft(m.repo, m.merge, [first, m.head, m.c1]);
    const result = landingOf(m.dir, merged(m.head, octopus), octopus);
    expect(refusal(result).code).toBe("merge-shape-unknown");
    expect(refusal(result).message).toContain("has 3 parents");
  });

  it("a merge commit without a parent: merge-shape-unknown", async () => {
    const m = await land(await build(), "squash");
    const root = await m.repo.sh("rev-list", "--max-parents=0", m.merge);
    const result = landingOf(m.dir, merged(m.head, root), m.landed);
    expect(refusal(result).code).toBe("merge-shape-unknown");
    expect(refusal(result).message).toContain("has 0 parents");
  });

  it("a head the repository does not have, below a single commit: head-unavailable", async () => {
    const m = await land(await build(), "squash");
    const result = landingOf(m.dir, merged(NO_COMMIT, m.merge), m.landed);
    expect(refusal(result)).toEqual({
      code: "head-unavailable",
      message:
        "the head commit of the pull request is not in the repository; the check never fetches, so the job has to bring that commit in before it runs",
    });
    expect(seam.asked).toEqual([]);
  });

  it("two merge bases of the head and the first parent: ambiguous-merge-base, and none is picked", async () => {
    const s = await crissCross("config-restored", "side");
    const m = await land(s, "squash");
    const result = landingOf(m.dir, merged(m.head, m.merge), m.landed);
    expect(refusal(result)).toEqual({
      code: "ambiguous-merge-base",
      message:
        "the head commit of the pull request and the first parent of its merge commit have 2 merge bases; the reviewed change is not measured from one of several",
    });
  });

  it("no merge base of the head and the first parent: git-failed", async () => {
    const m = await land(await build(), "squash");
    seam.mergeBases = () => [];
    const result = landingOf(m.dir, merged(m.head, m.merge), m.landed);
    expect(refusal(result)).toEqual({
      code: "git-failed",
      message:
        "the head commit of the pull request and the default branch share no history; there is no commit to measure the reviewed change from",
    });
  });

  it("a read of the merge bases that fails is a git error, not a verdict", async () => {
    const m = await land(await build(), "squash");
    seam.mergeBases = () => {
      throw new LintGitError(
        "git-failed",
        "git could not find the merge bases",
      );
    };
    expect(() => landingOf(m.dir, merged(m.head, m.merge), m.landed)).toThrow(
      LintGitError,
    );
  });
});
