/**
 * Condition 4 after the merge: the bindings at the tip of the default branch
 * are the ones the pull request was approved with.
 *
 * The final lint at the tip compares the tip with itself, so the
 * `bindings-log` rule is run once more, alone, from the head commit the
 * host reports (where the approving reviews stand) and the start of every
 * measured first-parent step (the first parent of the merge commit first).
 * The head commit must hold a `bindings.log` that parses. From each, every
 * log that commit holds for the spec must be extended by the log at the
 * tip, and the bindings at the tip must be the replay of the entries after
 * it.
 *
 * | case | verdict |
 * |---|---|
 * | tip log = head log + valid bind entries, bindings = replay | holds |
 * | the head holds no log that parses (absent, empty, truncated) | `bindings-after-merge` |
 * | tip log rewrites or drops an entry of the head's log | `bindings-after-merge` |
 * | squash carried other bindings / later default commit changed `bindings.yaml` without an entry | `bindings-after-merge` |
 * | the first parent holds a log the tip's log does not extend (draft and a second propose) | `bindings-after-merge` |
 * | the head commit is not in the repository | condition 3 `review-commit-unavailable`; condition 4 `head-unavailable` |
 * | a git read fails | `git-failed` |
 * | open mode | unchanged |
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LintGitError } from "../../src/lint/git/index.js";
import type { GitInputs } from "../../src/lint/types.js";
import { proposeSpecDir } from "../../src/state/index.js";
import { REMOTE_MAIN, SPEC_REL, cloneMain } from "../lint/git-helpers.js";
import { BIND_BINDINGS, bindOk, commitSpec } from "../state/helpers.js";
import {
  FILLERS,
  OTHER_BINDINGS,
  afterMerge,
  build,
  check,
  checkLanded,
  codes,
  cond,
  editSpec,
  failing,
  land,
  stepsOf,
  type Built,
  type Landed,
  type MergeHow,
} from "./helpers.js";

const seam = vi.hoisted(() => ({
  /** A commit at which `specDirsAt` throws a failed git read; `null` for none. */
  failAt: null as string | null,
  /** The git inputs of every run of the bindings-log rule alone. */
  runs: [] as unknown[],
  /** A commit at which the approval check is told no spec of the id is there; `null` for none. */
  noKinAt: null as string | null,
}));

vi.mock("../../src/lint/rules/bindings-log.js", async (original) => {
  const actual =
    await original<typeof import("../../src/lint/rules/bindings-log.js")>();
  return {
    ...actual,
    kinAtDiffBase: (repo: string, commit: string, id: string) =>
      commit === seam.noKinAt ? [] : actual.kinAtDiffBase(repo, commit, id),
  };
});

vi.mock("../../src/state/git.js", async (original) => {
  const actual = await original<typeof import("../../src/state/git.js")>();
  return {
    ...actual,
    specDirsAt: (repo: string, commit: string) => {
      if (commit === seam.failAt) {
        throw new LintGitError("git-failed", "git could not be run");
      }
      return actual.specDirsAt(repo, commit);
    },
  };
});

vi.mock("../../src/lint/run.js", async (original) => {
  const actual = await original<typeof import("../../src/lint/run.js")>();
  return {
    ...actual,
    checkBindingsLogAt: (dir: string, git: GitInputs) => {
      seam.runs.push(git);
      return actual.checkBindingsLogAt(dir, git);
    },
  };
});

beforeEach(() => {
  seam.failAt = null;
  seam.runs.length = 0;
  seam.noKinAt = null;
});

const ALL_OK = Array(8).fill("ok") as string[];
const FROM_HEAD = "from the head commit of the pull request";
const FROM_FIRST_PARENT = "from the first parent of the merge commit";
const LOG = `${SPEC_REL}/bindings.log`;
const BINDINGS = `${SPEC_REL}/bindings.yaml`;

/** The standard scenario, with one bind entry on the pull request after the propose. */
async function bound(): Promise<Built> {
  const s = await build();
  bindOk(s.repo, "TP-1", { status: "new", selector: "a new name" });
  const head = await commitSpec(s.repo, "bind on the pull request");
  return { ...s, head };
}

/** The first line of the log in the work tree of `m`: its propose entry. */
function proposeLine(m: Built): string {
  const text = fs.readFileSync(path.join(m.spec, "bindings.log"), "utf8");
  return `${text.split("\n")[0]!}\n`;
}

/**
 * Merges the branch `pr` into `main` as `how` does, but the merge commit
 * holds what `edit` makes of the merged work tree: an evil merge commit, or
 * a squash with other content. As in `land`, `main` first moves on by
 * unrelated commits, so the first-parent steps measured for the pull
 * request hold only unrelated commits of the default branch.
 */
async function landEdited(
  s: Built,
  how: "merge-commit" | "squash",
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  edit: (m: Built) => Record<string, string | null> | void,
): Promise<Built & Landed> {
  const head = await s.repo.sh("rev-parse", "pr");
  await s.repo.checkout("main");
  for (let i = 1; i <= FILLERS; i += 1) {
    await s.repo.commit({ [`filler-${i}.txt`]: `${i}\n` }, `filler ${i}`);
  }
  if (how === "squash") {
    await s.repo.sh("merge", "-q", "--squash", "pr");
  } else {
    await s.repo.sh("merge", "-q", "--no-ff", "--no-commit", "pr");
  }
  const merge = await s.repo.commit(edit(s) ?? {}, `${how} pr`);
  await s.repo.setRef(REMOTE_MAIN, merge);
  return { ...s, head, merge, landed: merge };
}

/**
 * Proposes the spec at `HEAD` of `s` measured from `c1`, where no log of the
 * spec exists, as master's `relogged` fixture does: the default ref is set
 * to `c1` for the propose and put back to `tip` afterwards. Measured from
 * the default branch the propose would see the log merged there.
 */
async function proposeFromC1(
  s: Built,
  tip: string,
): Promise<ReturnType<typeof proposeSpecDir>> {
  await s.repo.setRef(REMOTE_MAIN, s.c1);
  try {
    return proposeSpecDir(s.spec, {
      repo: s.dir,
      defaultRef: REMOTE_MAIN,
      base: s.c1,
    });
  } finally {
    await s.repo.setRef(REMOTE_MAIN, tip);
  }
}

/**
 * A spec that is merged with its log, and then a second pull request that
 * puts it back to draft without the log, edits its normative layer, and
 * proposes it again from the base `c1`, where no log exists to compare
 * with. That pull request is merged as `how` says. Its head holds a fresh
 * log, and the tip holds that log; the first parent holds the first one.
 */
async function reproposed(how: MergeHow): Promise<Built & Landed> {
  const first = await land(await build(), "merge-commit");
  const merged = await first.repo.head();
  await first.repo.checkout("pr2", merged);
  const file = path.join(first.spec, "spec.md");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(/^status: proposed$/m, "status: draft"),
  );
  editSpec(first.dir);
  await first.repo.commit({ [LOG]: null }, "back to draft, without the log");
  const result = await proposeFromC1(first, merged);
  if (result.kind !== "written") {
    throw new Error(
      `the second propose did not write: ${JSON.stringify(result)}`,
    );
  }
  const head = await commitSpec(first.repo, "propose again");
  await first.repo.checkout("main");
  for (let i = 1; i <= FILLERS; i += 1) {
    await first.repo.commit(
      { [`second-filler-${i}.txt`]: `${i}\n` },
      `second filler ${i}`,
    );
  }
  let merge: string;
  if (how === "merge-commit") {
    await first.repo.sh("merge", "-q", "--no-ff", "-m", "merge pr2", head);
    merge = await first.repo.head();
  } else if (how === "squash") {
    await first.repo.sh("merge", "-q", "--squash", "pr2");
    merge = await first.repo.commit({}, "squash pr2");
  } else {
    await first.repo.sh("rebase", "-q", "main", "pr2");
    await first.repo.checkout("main");
    await first.repo.sh("merge", "-q", "--ff-only", "pr2");
    merge = await first.repo.head();
  }
  await first.repo.setRef(REMOTE_MAIN, merge);
  return { ...first, head, merge, landed: merge };
}

describe("the bindings after the merge hold", { timeout: 60_000 }, () => {
  it.each(["merge-commit", "squash", "rebase"] as const)(
    "%s: the tip holds the head's log as it is, measured from the head commit only",
    async (how) => {
      const m = await land(await bound(), how);
      const report = await checkLanded(m);
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
      const run = (diffBase: string) => ({
        repo: fs.realpathSync(m.dir),
        reference: m.landed,
        diffBase,
        head: m.landed,
      });
      // A step of the default branch whose start holds no log of the spec
      // is not asked. After a rebase merge the first parent is the
      // replayed propose commit, which holds the head's log without the
      // bind entry, and is asked.
      const steps = await stepsOf(m.dir, m.merge, report.merge!.commits);
      const withLog = how === "rebase" ? steps.slice(0, 1) : [];
      expect(seam.runs).toEqual([
        run(m.head),
        ...withLog.map((step) => run(step.from)),
      ]);
    },
  );

  it.each(["merge-commit", "squash", "rebase"] as const)(
    "%s: a valid bind entry on the default branch after the merge, the bindings its replay",
    async (how) => {
      const merged = await land(await bound(), how);
      bindOk(merged.repo, "TP-2", {
        status: "existing",
        selector: "login still works",
      });
      const m = await afterMerge(merged, {}, "bind after the merge");
      const report = await checkLanded(m);
      expect(codes(report)).toEqual(ALL_OK);
      expect(report.approved).toBe(true);
    },
  );
});

describe(
  "the tip's log does not extend the head's log",
  { timeout: 60_000 },
  () => {
    it("merge-commit: the merge commit drops the bind entry of the head and puts the bindings back", async () => {
      const s = await bound();
      const m = await landEdited(s, "merge-commit", (w) => ({
        [LOG]: proposeLine(w),
        [BINDINGS]: fs
          .readFileSync(path.join(w.spec, "bindings.yaml"), "utf8")
          .replace("selector: a new name", "selector: rejects old token"),
      }));
      const report = await checkLanded(m);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "bindings-after-merge",
      });
      expect(cond(report, 4).message).toContain(`${FROM_HEAD}: log-rewritten`);
      expect(cond(report, 4).message).not.toContain(FROM_FIRST_PARENT);
      expect(failing(report)).toEqual([4]);
    });

    it("squash: the squash rewrites the bind entry with a recomputed chain", async () => {
      const s = await bound();
      const m = await landEdited(s, "squash", (w) => {
        fs.writeFileSync(path.join(w.spec, "bindings.log"), proposeLine(w));
        fs.writeFileSync(
          path.join(w.spec, "bindings.yaml"),
          fs
            .readFileSync(path.join(w.spec, "bindings.yaml"), "utf8")
            .replace("selector: a new name", "selector: rejects old token"),
        );
        bindOk(w.repo, "TP-1", { status: "new", selector: "another name" });
      });
      const report = await checkLanded(m);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "bindings-after-merge",
      });
      expect(cond(report, 4).message).toContain(`${FROM_HEAD}: log-rewritten`);
      expect(failing(report)).toEqual([4]);
    });

    it("rebase: a later commit of the default branch drops the bind entry", async () => {
      const merged = await land(await bound(), "rebase");
      const m = await afterMerge(merged, {
        [LOG]: proposeLine(merged),
        [BINDINGS]: fs
          .readFileSync(path.join(merged.spec, "bindings.yaml"), "utf8")
          .replace("selector: a new name", "selector: rejects old token"),
      });
      const report = await checkLanded(m);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "bindings-after-merge",
      });
      expect(cond(report, 4).message).toContain(`${FROM_HEAD}: log-rewritten`);
      expect(failing(report)).toEqual([4]);
    });
  },
);

describe(
  "the bindings at the tip are not the replay of the head's log",
  { timeout: 60_000 },
  () => {
    it("squash: the squash carried other bindings than the head's, without an entry", async () => {
      const m = await landEdited(await build(), "squash", () => ({
        [BINDINGS]: OTHER_BINDINGS,
      }));
      const report = await checkLanded(m);
      expect(cond(report, 4)).toEqual({
        condition: 4,
        name: "proposed-and-clean",
        ok: false,
        code: "bindings-after-merge",
        message: `the bindings log at the tip of the default branch does not hold measured ${FROM_HEAD}: replay-mismatch. The log at the tip must extend every log these commits hold for this spec, and the bindings at the tip must be the replay of the entries after it: the bindings on the default branch are not the ones that were approved`,
      });
      expect(failing(report)).toEqual([4]);
      // The message names codes only, never file content.
      expect(cond(report, 4).message).not.toContain("login still works");
    });

    it("merge-commit: the merge commit carried other bindings than the head's, without an entry", async () => {
      const m = await landEdited(await build(), "merge-commit", () => ({
        [BINDINGS]: OTHER_BINDINGS,
      }));
      const report = await checkLanded(m);
      expect(cond(report, 4).code).toBe("bindings-after-merge");
      expect(cond(report, 4).message).toContain(
        `${FROM_HEAD}: replay-mismatch`,
      );
      expect(failing(report)).toEqual([4]);
    });

    it.each(["merge-commit", "squash"] as const)(
      "%s: a later commit of the default branch changed bindings.yaml without an entry",
      async (how) => {
        const merged = await land(await build(), how);
        const m = await afterMerge(merged, { [BINDINGS]: OTHER_BINDINGS });
        const report = await checkLanded(m);
        expect(cond(report, 4).code).toBe("bindings-after-merge");
        expect(cond(report, 4).message).toContain(
          `${FROM_HEAD}: replay-mismatch`,
        );
        expect(failing(report)).toEqual([4]);
      },
    );

    it("the head commit is asked whatever the search for the spec there says", async () => {
      const m = await landEdited(await build(), "squash", () => ({
        [BINDINGS]: OTHER_BINDINGS,
      }));
      seam.noKinAt = m.head;
      const report = await checkLanded(m);
      expect(cond(report, 4).code).toBe("bindings-after-merge");
      expect(cond(report, 4).message).toContain(
        `${FROM_HEAD}: replay-mismatch`,
      );
    });

    it("a testplan.yaml at the tip that does not parse: the rule does not run, and that is no pass", async () => {
      const merged = await land(await build(), "squash");
      const m = await afterMerge(merged, {
        [`${SPEC_REL}/testplan.yaml`]: "- id: [\n",
      });
      const report = await checkLanded(m);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "bindings-after-merge",
        message: `the bindings log at the tip of the default branch is not checked ${FROM_HEAD}: the input testplan of the spec directory did not load`,
      });
    });

    it("a bindings.yaml at the tip that does not parse: the rule does not run, and that is no pass", async () => {
      const merged = await land(await build(), "squash");
      const m = await afterMerge(merged, { [BINDINGS]: "TP-1: [\n" });
      const report = await checkLanded(m);
      expect(cond(report, 4)).toMatchObject({
        ok: false,
        code: "bindings-after-merge",
        message: `the bindings log at the tip of the default branch is not checked ${FROM_HEAD}: the input bindings of the spec directory did not load`,
      });
    });
  },
);

describe(
  "the default branch before the merge holds a log the tip's log does not extend",
  { timeout: 60_000 },
  () => {
    it.each(["merge-commit", "squash", "rebase"] as const)(
      "%s: a merged spec put back to draft and proposed again",
      async (how) => {
        const m = await reproposed(how);
        const report = await checkLanded(m);
        expect(cond(report, 4)).toMatchObject({
          ok: false,
          code: "bindings-after-merge",
        });
        // After a rebase merge the first parent is the replayed draft
        // without a log; the default branch before the merge is the start
        // of the second step, below the replayed commits.
        const where =
          how === "rebase"
            ? "from the commit 2 first-parent steps below the merge commit"
            : FROM_FIRST_PARENT;
        expect(cond(report, 4).message).toContain(`${where}: log-rewritten`);
        expect(cond(report, 4).message).not.toContain(FROM_HEAD);
        // The rebase replays the draft commit: the repository check sees
        // the spec go back to draft over a step of the merge.
        expect(failing(report)).toEqual(how === "rebase" ? [4, 8] : [4]);
      },
    );
  },
);

describe("what cannot be read is not a pass", { timeout: 60_000 }, () => {
  it("the head commit is not in the repository: review-commit-unavailable, and condition 4 has no landing to measure from", async () => {
    const m = await land(await bound(), "squash");
    const clone = await cloneMain(m.repo);
    const report = await checkLanded({
      ...m,
      dir: clone,
      spec: path.join(clone, SPEC_REL),
    });
    expect(cond(report, 3).code).toBe("review-commit-unavailable");
    expect(cond(report, 4)).toMatchObject({
      ok: false,
      code: "head-unavailable",
    });
    expect(seam.runs).toEqual([]);
  });

  it("a git read at the head commit fails: git-failed", async () => {
    const m = await land(await bound(), "squash");
    seam.failAt = m.head;
    const report = await checkLanded(m);
    expect(cond(report, 4)).toMatchObject({
      ok: false,
      code: "git-failed",
      message:
        "the repository could not be read (git-failed); the condition is not verified",
    });
  });

  it("a git read at the first parent fails: git-failed", async () => {
    const m = await reproposed("squash");
    const parent = await m.repo.sh("rev-parse", `${m.merge}^`);
    seam.failAt = parent;
    const report = await checkLanded(m);
    expect(cond(report, 4)).toMatchObject({
      ok: false,
      code: "git-failed",
    });
  });
});

describe("the open mode is unchanged", { timeout: 60_000 }, () => {
  it("before the merge the rule is not run again: the lint measures from the measuring base", async () => {
    const s = await bound();
    const report = await check(s);
    expect(codes(report)).toEqual(ALL_OK);
    expect(seam.runs).toEqual([]);
  });
});

/** What the head of the pull request holds as its `bindings.log`. */
type HeadLog = "absent" | "empty" | "truncated";

/**
 * The spec is a draft on the default branch at `draft`; the head of the
 * pull request sets it to proposed by hand, with other bindings and the
 * log `headLog`. After the merge, as `how` says, a later commit of the
 * default branch writes a valid log whose propose entry names `draft` and
 * puts the bindings back to the ones at `draft`, with no bind entry. The
 * replay from that propose commit matches the tip.
 */
async function proposedByHand(
  how: MergeHow,
  headLog: HeadLog,
): Promise<Built & Landed> {
  const s = await build({ propose: false });
  await s.repo.checkout("main");
  await s.repo.sh("merge", "-q", "--ff-only", "pr");
  const draft = await s.repo.head();
  await s.repo.setRef(REMOTE_MAIN, draft);
  await s.repo.checkout("side", draft);
  const result = await proposeFromC1(s, draft);
  if (result.kind !== "written") {
    throw new Error(`the propose did not write: ${JSON.stringify(result)}`);
  }
  const log = fs.readFileSync(path.join(s.spec, "bindings.log"), "utf8");
  const proposed = fs.readFileSync(path.join(s.spec, "spec.md"), "utf8");
  await commitSpec(s.repo, "propose on a side branch");
  await s.repo.checkout("pr2", draft);
  const head = await s.repo.commit(
    {
      [`${SPEC_REL}/spec.md`]: proposed,
      [BINDINGS]: OTHER_BINDINGS,
      [LOG]:
        headLog === "absent"
          ? null
          : headLog === "empty"
            ? ""
            : log.slice(0, Math.floor(log.length / 2)),
    },
    "proposed by hand, other bindings",
  );
  // `land` merges the branch `pr`.
  await s.repo.sh("branch", "-f", "pr", head);
  const merged = await land({ ...s, head }, how);
  return afterMerge(merged, { [LOG]: log, [BINDINGS]: BIND_BINDINGS });
}

describe(
  "the head commit holds no bindings.log that parses",
  { timeout: 60_000 },
  () => {
    const cases = (["merge-commit", "squash", "rebase"] as const).flatMap(
      (how) =>
        (["absent", "empty", "truncated"] as const).map(
          (headLog) => [how, headLog] as const,
        ),
    );
    it.each(cases)(
      "%s, head log %s: a log written later on the default branch anchors nothing",
      async (how, headLog) => {
        const m = await proposedByHand(how, headLog);
        const report = await checkLanded(m);
        expect(cond(report, 4)).toEqual({
          condition: 4,
          name: "proposed-and-clean",
          ok: false,
          code: "bindings-after-merge",
          message:
            "the head commit of the pull request holds no bindings.log for this spec that parses; the bindings at the tip of the default branch have no approved log to be measured from",
        });
        expect(failing(report)).toEqual([4]);
        expect(seam.runs).toEqual([]);
      },
    );
  },
);
