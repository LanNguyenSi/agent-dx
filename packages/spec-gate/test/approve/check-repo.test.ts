/**
 * Condition 8: the repository check, run by the approval check over the
 * git inputs the lint got. The check itself is covered in `test/repo/`;
 * here it is the wiring: which commits it is given, that the work tree is
 * not asked, what a finding does to the report.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LISTED_FINDINGS } from "../../src/approve/index.js";
import type { GitInputs } from "../../src/lint/types.js";
import type { RepoCheckReport } from "../../src/repo/index.js";
import { REMOTE_MAIN } from "../lint/git-helpers.js";
import {
  build,
  check,
  codes,
  cond,
  failing,
  keep,
  otherSpec,
  type Built,
  type Scenario,
} from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** The git inputs of every call of the repository check. */
  seen: [] as unknown[],
  /** Called instead of the repository check; may throw. */
  // eslint-disable-next-line no-unused-vars
  instead: undefined as ((git: unknown) => unknown) | undefined,
}));

vi.mock("../../src/repo/index.js", async (original) => {
  const actual = await original<typeof import("../../src/repo/index.js")>();
  return {
    ...actual,
    checkRepository: (git: GitInputs) => {
      seam.seen.push(git);
      return seam.instead === undefined
        ? actual.checkRepository(git)
        : (seam.instead(git) as RepoCheckReport);
    },
  };
});

beforeEach(() => {
  seam.seen.length = 0;
  seam.instead = undefined;
});

const OTHER = "specs/other/spec.md";

/** A repository whose default branch holds a second, proposed spec beside the settings. */
function withOther(merged: Record<string, string> = {}): Promise<Built> {
  return build({ merged: { [OTHER]: otherSpec("other-spec"), ...merged } });
}

/** `s` after one more commit on the pull request branch, approved there. */
async function after(
  s: Built,
  files: Record<string, string | null>,
): Promise<Scenario> {
  const head = await s.repo.commit(files, "one more commit");
  return { ...s, head };
}

/** The standard repository: proposed spec at the head, nothing else protected. */
let S: Scenario;

beforeAll(async () => {
  S = keep(await build());
}, 60_000);

describe("condition 8: the repository check", { timeout: 60_000 }, () => {
  it("holds when no protected spec changed, and is given the git inputs of the check", async () => {
    const report = await check(S);
    expect(cond(report, 8)).toEqual({
      condition: 8,
      name: "repo-check-clean",
      ok: true,
      code: "ok",
      message:
        "no protected spec of the diff base disappears, changes its id, goes back to draft or loses its log at the head",
    });
    expect(report.approved).toBe(true);
    expect(seam.seen).toEqual([
      {
        repo: fs.realpathSync(S.dir),
        reference: S.c1,
        diffBase: S.c1,
        head: S.head,
      },
    ]);
  });

  it("a pull request that deletes another, proposed spec: repo-check-findings, and nothing is approved", async () => {
    const s = await after(await withOther(), { [OTHER]: null });
    const report = await check(s);
    expect(cond(report, 8)).toEqual({
      condition: 8,
      name: "repo-check-clean",
      ok: false,
      code: "repo-check-findings",
      message: `the repository check reports 1 finding: spec-removed "${OTHER}"`,
    });
    // Every other condition holds: the spec under check is untouched.
    expect(failing(report)).toEqual([8]);
    expect(report.approved).toBe(false);
    expect(report.approve_reported).toBe(false);
  });

  it("holds while the other spec stays", async () => {
    const s = await after(await withOther(), { "README.md": "two\n" });
    const report = await check(s);
    expect(codes(report)).toEqual(Array(8).fill("ok"));
    expect(report.approved).toBe(true);
  });

  it("a protected spec outside specs/ counts: the whole tree is walked", async () => {
    const elsewhere = "docs/old/spec.md";
    const s = await after(
      await build({ merged: { [elsewhere]: otherSpec("old-spec") } }),
      { [elsewhere]: null },
    );
    const report = await check(s);
    expect(cond(report, 8)).toMatchObject({
      ok: false,
      code: "repo-check-findings",
      message: `the repository check reports 1 finding: spec-removed "${elsewhere}"`,
    });
    expect(failing(report)).toEqual([8]);
    expect(report.approved).toBe(false);
  });

  it("a deleted spec restored in the work tree without a commit stays deleted: the trees are read from git", async () => {
    const s = await after(await withOther(), { [OTHER]: null });
    const restored = path.join(s.dir, OTHER);
    fs.mkdirSync(path.dirname(restored), { recursive: true });
    fs.writeFileSync(restored, otherSpec("other-spec"));
    const report = await check(s);
    expect(cond(report, 8)).toMatchObject({
      ok: false,
      code: "repo-check-findings",
    });
    expect(failing(report)).toEqual([8]);
    expect(report.approved).toBe(false);
  });

  it("a spec the head holds but the work tree lacks is not a finding: the head is judged", async () => {
    const s = await withOther();
    fs.rmSync(path.join(s.dir, OTHER));
    const report = await check(s);
    expect(cond(report, 8)).toMatchObject({ ok: true, code: "ok" });
    expect(report.approved).toBe(true);
  });

  it("a spec id changed and a status put back to draft are named with their codes, sorted by path", async () => {
    const second = "specs/another/spec.md";
    const s = await after(
      await withOther({ [second]: otherSpec("another-spec") }),
      {
        [OTHER]: otherSpec("renamed-spec"),
        [second]: otherSpec("another-spec", "draft"),
      },
    );
    const report = await check(s);
    expect(cond(report, 8)).toMatchObject({
      ok: false,
      code: "repo-check-findings",
      message: `the repository check reports 2 findings: spec-status-reverted "${second}", spec-id-changed "${OTHER}"`,
    });
    expect(report.approved).toBe(false);
  });

  it("a path is quoted as a JSON text, so its end is never a guess", async () => {
    const odd = 'docs/a", spec-removed "b/spec.md';
    const s = await after(
      await build({ merged: { [odd]: otherSpec("odd-spec") } }),
      { [odd]: null },
    );
    const report = await check(s);
    expect(cond(report, 8).message).toBe(
      `the repository check reports 1 finding: spec-removed ${JSON.stringify(odd)}`,
    );
  });

  it("the diff base is the merge base, not the tip of the default branch: a spec merged there after the fork is not missed", async () => {
    const s = await build();
    await s.repo.checkout("main");
    const tip = await s.repo.commit(
      { "specs/merged-later/spec.md": otherSpec("merged-later") },
      "another pull request is merged",
    );
    await s.repo.setRef(REMOTE_MAIN, tip);
    await s.repo.checkout("pr");
    const report = await check(s);
    expect(seam.seen).toEqual([
      {
        repo: fs.realpathSync(s.dir),
        reference: tip,
        diffBase: s.c1,
        head: s.head,
      },
    ]);
    expect(cond(report, 8)).toMatchObject({ ok: true, code: "ok" });
    expect(report.approved).toBe(true);
  });

  it("with a base commit given, the check runs from that base", async () => {
    const s = await after(await withOther(), { [OTHER]: null });
    const report = await check(s, {}, { base: s.c1 });
    expect(seam.seen).toEqual([
      {
        repo: fs.realpathSync(s.dir),
        reference: s.c1,
        diffBase: s.c1,
        head: s.head,
      },
    ]);
    expect(failing(report)).toEqual([8]);
  });
});

describe("condition 8: many findings", { timeout: 120_000 }, () => {
  const name = (n: number) => `specs/p${String(n).padStart(2, "0")}`;
  const numbers = Array.from({ length: MAX_LISTED_FINDINGS }, (_, i) => i + 1);

  it("lists the first findings by path and counts the rest", async () => {
    const merged: Record<string, string> = {
      [`${name(1)}/bindings.log`]: "a merged log line\n",
    };
    for (const n of numbers) {
      merged[`${name(n)}/spec.md`] = otherSpec(`p-${n}`);
    }
    const s = await build({ merged });
    const gone = Object.fromEntries(
      numbers.map((n) => [`${name(n)}/spec.md`, null]),
    );
    // As many findings as a message lists: every one is named.
    const full = await check(await after(s, gone));
    expect(cond(full, 8).message).toBe(
      `the repository check reports ${MAX_LISTED_FINDINGS} findings: ${numbers
        .map((n) => `spec-removed "${name(n)}/spec.md"`)
        .join(", ")}`,
    );
    // One more: the log sorts first, the last spec is counted, not named.
    const over = await check(
      await after(s, { [`${name(1)}/bindings.log`]: null }),
    );
    expect(cond(over, 8).message).toBe(
      `the repository check reports ${MAX_LISTED_FINDINGS + 1} findings: log-removed "${name(1)}/bindings.log", ${numbers
        .slice(0, -1)
        .map((n) => `spec-removed "${name(n)}/spec.md"`)
        .join(", ")} (and 1 more)`,
    );
    expect(over.approved).toBe(false);
  });
});

describe("condition 8: a tree that was not read", { timeout: 60_000 }, () => {
  it("a tree over a cap: tree-too-large, never a pass", async () => {
    seam.instead = (git) => ({
      format: "spec-gate-repo-check/1",
      ok: false,
      reference: (git as GitInputs).reference,
      diff_base: (git as GitInputs).diffBase,
      head: (git as GitInputs).head,
      spec_files: 0,
      findings: [
        { path: ".", code: "tree-too-large", message: "over the cap" },
      ],
    });
    const report = await check(S);
    expect(cond(report, 8)).toMatchObject({
      ok: false,
      code: "tree-too-large",
    });
    expect(cond(report, 8).message).not.toContain("over the cap");
    expect(failing(report)).toEqual([8]);
    expect(report.approved).toBe(false);
  });

  it("a git read that fails: git-failed for condition 8, a report and no exception", async () => {
    const { LintGitError } = await import("../../src/lint/git/index.js");
    seam.instead = () => {
      throw new LintGitError("object-unreadable", "a tree could not be read");
    };
    const report = await check(S);
    expect(cond(report, 8)).toMatchObject({ ok: false, code: "git-failed" });
    expect(failing(report)).toEqual([8]);
    expect(report.approved).toBe(false);
  });

  it("any other exception is not turned into a condition: the check rejects", async () => {
    seam.instead = () => {
      throw new TypeError("a bug");
    };
    await expect(check(S)).rejects.toThrow("a bug");
  });
});
