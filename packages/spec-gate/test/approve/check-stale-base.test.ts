/**
 * Conditions 7 and 8 against a base commit that is older than a commit of
 * the default branch the head has merged. Both conditions measure from the
 * merge base with the default branch, so what the pull request does on top
 * of that merge shows whatever base the host reports. Condition 8 has its
 * cases in `check-repo.test.ts`; here are condition 7 and the merge base
 * that cannot be found.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { check, cond, failing, staleBase } from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** Called before `mergeBase` with its two commits; a value other than `undefined` is returned instead. */
  // eslint-disable-next-line no-unused-vars
  mergeBase: undefined as ((a: string, b: string) => unknown) | undefined,
}));

vi.mock("../../src/lint/git/index.js", async (original) => {
  const actual = await original<typeof import("../../src/lint/git/index.js")>();
  return {
    ...actual,
    mergeBase: (repo: string, a: string, b: string) => {
      const instead = seam.mergeBase?.(a, b);
      return instead === undefined
        ? actual.mergeBase(repo, a, b)
        : (instead as string | null);
    },
  };
});

beforeEach(() => {
  seam.mergeBase = undefined;
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
      // Between the stale base and the head nothing under .spec-gate/
      // differs, so the lint of condition 4, which keeps that base, is clean.
      expect(failing(report)).toEqual([7]);
      expect(report.approved).toBe(false);
    });

    it("the same pull request without a base commit: condition 7 fails as well", async () => {
      const s = await staleBase("config-restored");
      const report = await check(s);
      expect(cond(report, 7)).toMatchObject({
        ok: false,
        code: "spec-changes-config",
      });
      expect(report.approved).toBe(false);
    });

    it("a change of the settings the default branch made itself is not the pull request's: condition 7 holds after the merge", async () => {
      const s = await staleBase("config-merged");
      const held = {
        condition: 7,
        name: "config-untouched",
        ok: true,
        code: "ok",
        message:
          "no file under .spec-gate/ differs between the merge base with the default branch and the head",
      };
      const without = await check(s);
      expect(cond(without, 7)).toEqual(held);
      expect(without.approved).toBe(true);
      // With the stale base given, the lint of condition 4 measures from
      // that base and reports the default branch's own change; condition 7
      // does not.
      const withBase = await check(s, {}, { base: s.c1 });
      expect(cond(withBase, 7)).toEqual(held);
      expect(failing(withBase)).toEqual([4]);
    });
  },
);

describe(
  "conditions 7 and 8 when the merge base with the default branch cannot be found",
  { timeout: 60_000 },
  () => {
    it("no merge base: git-failed for both, a report and no approval", async () => {
      const s = await staleBase("merged-only");
      // With a base commit given, the git inputs ask for the merge base with
      // that base; only the two conditions ask for the one with the default
      // commit.
      seam.mergeBase = (_a, b) => (b === s.newer ? null : undefined);
      const report = await check(s, {}, { base: s.c1 });
      for (const condition of [7, 8] as const) {
        expect(cond(report, condition)).toMatchObject({
          ok: false,
          code: "git-failed",
        });
      }
      expect(failing(report)).toEqual([7, 8]);
      expect(report.approved).toBe(false);
    });

    it("a git failure while it is looked up: git-failed for both", async () => {
      const s = await staleBase("merged-only");
      const { LintGitError } = await import("../../src/lint/git/index.js");
      seam.mergeBase = (_a, b) => {
        if (b === s.newer) {
          throw new LintGitError(
            "git-failed",
            "git could not find a merge base",
          );
        }
        return undefined;
      };
      const report = await check(s, {}, { base: s.c1 });
      expect(failing(report)).toEqual([7, 8]);
      expect(report.approved).toBe(false);
    });
  },
);
