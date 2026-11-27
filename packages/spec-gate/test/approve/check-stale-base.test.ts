/**
 * The measuring base: conditions 4, 7 and 8 measure what a pull request
 * changes from the one merge base of the head and the default commit.
 *
 * - A base commit older than a default commit the head has merged does not
 *   move it: the lint never gets the base, and conditions 7 and 8 do not
 *   read it. Condition 8 has its stale-base cases in `check-repo.test.ts`.
 * - With several merge bases there is none: all three fail closed.
 * - No merge base and a failed read fail closed as well.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeBases } from "../../src/approve/index.js";
import type { LintOptions } from "../../src/lint/index.js";
import type { GitInputs } from "../../src/lint/types.js";
import { REMOTE_MAIN } from "../lint/git-helpers.js";
import {
  check,
  codes,
  cond,
  crissCross,
  failing,
  relogged,
  staleBase,
} from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** Called instead of `mergeBases`; a value other than `undefined` is returned in its place. */
  // eslint-disable-next-line no-unused-vars
  mergeBases: undefined as ((a: string, b: string) => unknown) | undefined,
  /** The options of every run of the final lint. */
  lints: [] as unknown[],
  /** The git inputs of every run of the repository check. */
  repoChecks: [] as unknown[],
}));

vi.mock("../../src/approve/git.js", async (original) => {
  const actual = await original<typeof import("../../src/approve/git.js")>();
  return {
    ...actual,
    mergeBases: (repo: string, a: string, b: string) => {
      const instead = seam.mergeBases?.(a, b);
      return instead === undefined
        ? actual.mergeBases(repo, a, b)
        : (instead as string[]);
    },
  };
});

vi.mock("../../src/lint/run.js", async (original) => {
  const actual = await original<typeof import("../../src/lint/run.js")>();
  return {
    ...actual,
    lintSpecDir: (dir: string, options?: LintOptions) => {
      seam.lints.push(options);
      return actual.lintSpecDir(dir, options);
    },
  };
});

vi.mock("../../src/repo/index.js", async (original) => {
  const actual = await original<typeof import("../../src/repo/index.js")>();
  return {
    ...actual,
    checkRepository: (git: GitInputs) => {
      seam.repoChecks.push(git);
      return actual.checkRepository(git);
    },
  };
});

beforeEach(() => {
  seam.mergeBases = undefined;
  seam.lints.length = 0;
  seam.repoChecks.length = 0;
});

describe(
  "condition 7 with a base older than a merged default commit",
  { timeout: 60_000 },
  () => {
    it("settings put back to their text at the stale base are a change: spec-changes-config, with the base commit given", async () => {
      const s = await staleBase("config-restored");
      const report = await check(s, {}, { base: s.c1 });
      expect(report.reference).toBe(s.c1);
      expect(report.default_commit).toBe(s.newer);
      expect(cond(report, 7)).toMatchObject({
        ok: false,
        code: "spec-changes-config",
        message:
          "the pull request changes 1 path under .spec-gate/; a change there is a pull request of its own",
      });
      // The lint of condition 4 measures from the default branch too, and its
      // own rule reports the same change.
      expect(failing(report)).toEqual([4, 7]);
      expect(cond(report, 4).message).toContain("spec-changes-config");
      expect(report.approved).toBe(false);
    });

    it("the same pull request without a base commit: the same report", async () => {
      const s = await staleBase("config-restored");
      const withBase = await check(s, {}, { base: s.c1 });
      const without = await check(s);
      expect(without.conditions).toEqual(withBase.conditions);
      expect(failing(without)).toEqual([4, 7]);
      expect(without.approved).toBe(false);
    });

    it("a change of the settings the default branch made itself is not the pull request's: approved after the merge, with and without the stale base", async () => {
      const s = await staleBase("config-merged");
      for (const over of [{ base: s.c1 }, {}]) {
        const report = await check(s, {}, over);
        expect(cond(report, 7)).toEqual({
          condition: 7,
          name: "config-untouched",
          ok: true,
          code: "ok",
          message:
            "no file under .spec-gate/ differs between the merge base with the default branch and the head",
        });
        expect(codes(report)).toEqual(Array(8).fill("ok"));
        expect(report.approved).toBe(true);
      }
    });
  },
);

describe("the final lint and the base commit", { timeout: 60_000 }, () => {
  it("the lint is given the repository and the default ref, never the base commit", async () => {
    const s = await staleBase("merged-only");
    // Building the scenario proposed the spec, which lints too.
    seam.lints.length = 0;
    seam.repoChecks.length = 0;
    const expected = {
      final: true,
      git: { repo: s.dir, defaultRef: REMOTE_MAIN },
    };
    const withBase = await check(s, {}, { base: s.c1 });
    expect(withBase.approved).toBe(true);
    expect(withBase.reference).toBe(s.c1);
    const without = await check(s);
    expect(without.approved).toBe(true);
    // Equality, not a subset: a `base` key in the request fails here.
    expect(seam.lints).toEqual([expected, expected]);
    // The repository check measures from the same base in both runs.
    const measured = {
      repo: expect.any(String),
      reference: s.newer,
      diffBase: s.newer,
      head: s.head,
    };
    expect(seam.repoChecks).toEqual([measured, measured]);
  });

  it("a merged bindings.log replaced through draft and a second propose fails condition 4, whatever base is given", async () => {
    const s = await relogged();
    for (const over of [{ base: s.c1 }, {}]) {
      const report = await check(s, {}, over);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "lint-errors",
        message: expect.stringContaining("bindings-log"),
      });
      // Path, id, status and a log are all there at the head: conditions 7
      // and 8 hold, the lint is what sees the replaced log.
      expect(failing(report)).toEqual([4]);
      expect(report.approved).toBe(false);
    }
  });
});

describe("several merge bases", { timeout: 120_000 }, () => {
  const AMBIGUOUS = {
    ok: false,
    code: "ambiguous-merge-base",
    message:
      "the head and the tip of the default branch have 2 merge bases; the pull request is not measured from one of several. Merge the tip of the default branch into the pull request branch, or rebase onto it, so that one remains",
  };

  it.each([
    ["spec-deleted", "side"],
    ["spec-deleted", "default"],
    ["config-restored", "side"],
    ["config-restored", "default"],
  ] as const)(
    "%s, the %s commit committed last: conditions 4, 7 and 8 are ambiguous-merge-base and nothing is measured",
    async (kind, later) => {
      const s = await crissCross(kind, later);
      expect([...mergeBases(s.dir, s.head, s.newer)].sort()).toEqual(
        [...s.bases].sort(),
      );
      for (const over of [{}, { base: s.c1 }]) {
        seam.lints.length = 0;
        seam.repoChecks.length = 0;
        const report = await check(s, {}, over);
        for (const condition of [4, 7, 8] as const) {
          expect(cond(report, condition)).toMatchObject(AMBIGUOUS);
        }
        expect(failing(report)).toEqual([4, 7, 8]);
        expect(report.approved).toBe(false);
        expect(report.approve_reported).toBe(false);
        // Neither the lint nor the repository check ran from a pick.
        expect(seam.lints).toEqual([]);
        expect(seam.repoChecks).toEqual([]);
      }
    },
  );

  it("names the number of merge bases", async () => {
    const s = await staleBase("merged-only");
    seam.mergeBases = () => ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const report = await check(s);
    expect(cond(report, 8).message).toContain("have 3 merge bases");
    expect(failing(report)).toEqual([4, 7, 8]);
  });

  it("the pull request that merges the tip of the default branch has one again, and is then measured", async () => {
    const s = await crissCross("spec-deleted", "side");
    await s.repo.sh("merge", "-q", "--no-ff", "-m", "merge the tip", s.newer);
    const head = await s.repo.head();
    expect(mergeBases(s.dir, head, s.newer)).toEqual([s.newer]);
    const report = await check({ ...s, head });
    // Measured from the tip, the deleted spec shows.
    expect(cond(report, 8)).toMatchObject({
      ok: false,
      code: "repo-check-findings",
    });
    expect(failing(report)).toEqual([8]);
  });
});

describe("the measuring base cannot be found", { timeout: 60_000 }, () => {
  it("no merge base: git-failed for conditions 4, 7 and 8, a report and no approval", async () => {
    const s = await staleBase("merged-only");
    seam.lints.length = 0;
    seam.mergeBases = () => [];
    const report = await check(s, {}, { base: s.c1 });
    for (const condition of [4, 7, 8] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "git-failed",
        message: expect.stringContaining("share no history"),
      });
    }
    expect(failing(report)).toEqual([4, 7, 8]);
    expect(report.approved).toBe(false);
    expect(seam.lints).toEqual([]);
    expect(seam.repoChecks).toEqual([]);
  });

  it("a git failure while it is looked up: git-failed for all three", async () => {
    const s = await staleBase("merged-only");
    const { LintGitError } = await import("../../src/lint/git/index.js");
    seam.mergeBases = () => {
      throw new LintGitError(
        "git-failed",
        "git could not find the merge bases",
      );
    };
    const report = await check(s);
    for (const condition of [4, 7, 8] as const) {
      expect(cond(report, condition)).toMatchObject({
        ok: false,
        code: "git-failed",
        message: expect.stringContaining("(git-failed)"),
      });
    }
    expect(failing(report)).toEqual([4, 7, 8]);
    expect(report.approved).toBe(false);
  });

  it("any other exception is not turned into a condition: the check rejects", async () => {
    const s = await staleBase("merged-only");
    seam.mergeBases = () => {
      throw new TypeError("a bug");
    };
    await expect(check(s)).rejects.toThrow("a bug");
  });

  it("the merge bases are asked for the head and the default commit, once", async () => {
    const s = await staleBase("merged-only");
    const asked: string[][] = [];
    seam.mergeBases = (a, b) => {
      asked.push([a, b]);
      return undefined;
    };
    await check(s, {}, { base: s.c1 });
    expect(asked).toEqual([[s.head, s.newer]]);
  });
});
