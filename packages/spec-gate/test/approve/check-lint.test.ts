/**
 * The outcomes of the check that a repository on disk cannot be made to
 * produce: the final lint refusing to run after the git inputs resolved,
 * `HEAD` moving while it runs, and a git read failing in the middle of a
 * condition. The lint and the git primitives are wrapped so a test can act in
 * that moment; without a hook every wrapped function is the real one.
 */
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkApproval } from "../../src/approve/index.js";
import type { LintRunResult } from "../../src/lint/index.js";
import type { RuleContext, RuleFinding } from "../../src/lint/types.js";
import { build, check, cond, failing, hostFor, requestFor } from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** Replaces the result of the final lint. */
  // eslint-disable-next-line no-unused-vars
  afterLint: undefined as ((result: unknown) => unknown) | undefined,
  /** Called before `isAncestor`; may throw. */
  // eslint-disable-next-line no-unused-vars
  onAncestor: undefined as ((a: string, b: string) => void) | undefined,
  /** Called before `resolveRef` with the number of the call; may throw. */
  // eslint-disable-next-line no-unused-vars
  onResolveRef: undefined as ((call: number) => void) | undefined,
  resolveRefCalls: 0,
  /** Replaces the findings of the `.spec-gate/` rule for a call without inputs. */
  configFindings: undefined as unknown[] | undefined,
}));

vi.mock("../../src/lint/run.js", async (original) => {
  const actual = await original<typeof import("../../src/lint/run.js")>();
  return {
    ...actual,
    lintSpecDir: (...args: Parameters<typeof actual.lintSpecDir>) => {
      const result = actual.lintSpecDir(...args);
      return seam.afterLint === undefined ? result : seam.afterLint(result);
    },
  };
});

vi.mock("../../src/lint/git/index.js", async (original) => {
  const actual = await original<typeof import("../../src/lint/git/index.js")>();
  return {
    ...actual,
    isAncestor: (repo: string, a: string, b: string) => {
      seam.onAncestor?.(a, b);
      return actual.isAncestor(repo, a, b);
    },
    resolveRef: (repo: string, ref: string) => {
      seam.resolveRefCalls += 1;
      seam.onResolveRef?.(seam.resolveRefCalls);
      return actual.resolveRef(repo, ref);
    },
  };
});

vi.mock("../../src/lint/rules/refs.js", async (original) => {
  const actual =
    await original<typeof import("../../src/lint/rules/refs.js")>();
  return {
    ...actual,
    checkSpecChangesConfig: (ctx: RuleContext) =>
      seam.configFindings !== undefined && ctx.inputs.spec.state === "absent"
        ? (seam.configFindings as RuleFinding[])
        : actual.checkSpecChangesConfig(ctx),
  };
});

beforeEach(() => {
  seam.afterLint = undefined;
  seam.onAncestor = undefined;
  seam.onResolveRef = undefined;
  seam.resolveRefCalls = 0;
  seam.configFindings = undefined;
});

/** The error the git primitives throw; taken from the wrapped module. */
async function gitError(): Promise<Error> {
  const { LintGitError } = await import("../../src/lint/git/index.js");
  return new LintGitError("git-failed", "git could not compare two commits");
}

describe("condition 4 and the final lint", { timeout: 60_000 }, () => {
  it("holds when the lint ran untouched: the final lint, with git inputs, nothing skipped", async () => {
    const s = await build();
    let seen: LintRunResult | undefined;
    seam.afterLint = (result) => {
      seen = result as LintRunResult;
      return result;
    };
    const report = await check(s);
    expect(seen).toMatchObject({
      ok: true,
      report: { mode: "final", ok: true, skipped: [] },
    });
    expect(cond(report, 4)).toMatchObject({ ok: true, code: "ok" });
    expect(report.approved).toBe(true);
  });

  it("the lint could not run: lint-failed", async () => {
    const s = await build();
    seam.afterLint = () => ({ ok: false, message: "usage" });
    const report = await check(s);
    expect(cond(report, 4)).toMatchObject({ ok: false, code: "lint-failed" });
    expect(report.approved).toBe(false);
    expect(failing(report)).toEqual([4]);
  });

  it("HEAD moved while the lint ran: head-moved", async () => {
    const s = await build();
    seam.afterLint = (result) => {
      execFileSync(
        "git",
        ["-C", s.dir, "checkout", "-q", "--detach", s.draft],
        { stdio: "ignore" },
      );
      return result;
    };
    const report = await check(s);
    expect(cond(report, 4)).toMatchObject({ ok: false, code: "head-moved" });
    expect(report.head).toBe(s.head);
    expect(report.approved).toBe(false);
    expect(failing(report)).toEqual([4]);
  });
});

describe(
  "a git read fails in the middle of the check",
  { timeout: 60_000 },
  () => {
    it("inside a condition: git-failed for that condition, a report and no exception", async () => {
      const s = await build();
      const error = await gitError();
      // The comparison of the head with the reference commit, which only
      // condition 2 makes.
      seam.onAncestor = (a, b) => {
        if (a === s.head && b === s.c1) throw error;
      };
      const report = await check(s);
      expect(cond(report, 2)).toMatchObject({ ok: false, code: "git-failed" });
      expect(report.approved).toBe(false);
      expect(failing(report)).toEqual([2]);
    });

    it("the comparison under .spec-gate/ could not be made: git-failed for condition 7", async () => {
      const s = await build();
      seam.configFindings = [
        {
          file: "repo:.spec-gate",
          path: "$",
          code: "git-failed",
          message: "x",
        },
      ];
      const report = await check(s);
      expect(cond(report, 7)).toMatchObject({ ok: false, code: "git-failed" });
      expect(report.approved).toBe(false);
      expect(failing(report)).toEqual([7]);
    });

    it("a failed comparison beside a changed path is git-failed, not a count of paths", async () => {
      const s = await build();
      seam.configFindings = [
        {
          file: "repo:.spec-gate/a",
          path: "$",
          code: "spec-changes-config",
          message: "x",
        },
        {
          file: "repo:.spec-gate",
          path: "$",
          code: "git-failed",
          message: "x",
        },
      ];
      const report = await check(s);
      expect(cond(report, 7)).toMatchObject({ ok: false, code: "git-failed" });
    });

    it("the default ref no longer resolves after the git inputs did: refused", async () => {
      const s = await build();
      const error = await gitError();
      // Building the repository resolved refs too; count from here. The
      // first call is the resolution of the git inputs, the second the
      // check's own.
      seam.resolveRefCalls = 0;
      seam.onResolveRef = (call) => {
        if (call === 2) throw error;
      };
      const host = hostFor(s);
      const result = await checkApproval(requestFor(s, host));
      expect(result).toEqual({
        kind: "refused",
        message: "approve-check: the default ref does not resolve to a commit",
      });
      expect(host.calls).toEqual([]);
    });
  },
);
