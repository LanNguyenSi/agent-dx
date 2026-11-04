import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { patch, PatchUsageError } from "../src/patch/index.js";
import {
  branchGuardEnv,
  protectedNameProblem,
} from "../src/patch/branch-guard.js";
import { CLI_PATH, spawnCli } from "./helpers/spawn-cli.js";

/**
 * The branch guard of `patch` (`src/patch/branch-guard.ts`): a write is
 * refused while the repository that holds the working directory sits on a
 * protected branch. The cases are written from the side of someone who
 * wants the write anyway: another spelling of the branch, a layout that
 * hides the repository, an environment that points git elsewhere, a git
 * that cannot be asked.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Every git of this file (the fixtures' and patch's own) ignores the
// machine's configuration, so `init.defaultBranch` and the like cannot
// change a branch name.
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
});

function tmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-branch-guard-")),
  );
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A work tree on `branch` (no commit yet) holding `a.txt`. */
function repoOn(branch: string, dir = tmpDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  return dir;
}

/** Commits `a.txt` (a branch needs a commit before it can be moved). */
function commitAll(dir: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

/** A clone of a bare origin whose default branch is `trunk`; the clone
 * sits on `onBranch` (`trunk` itself, or a new branch). */
function cloneOf(onBranch: string): string {
  const base = tmpDir();
  git(base, "init", "-q", "--bare", "origin.git");
  git(
    path.join(base, "origin.git"),
    "symbolic-ref",
    "HEAD",
    "refs/heads/trunk",
  );
  const seed = repoOn("trunk", path.join(base, "seed"));
  commitAll(seed);
  git(seed, "push", "-q", path.join(base, "origin.git"), "trunk");
  git(base, "clone", "-q", "origin.git", "clone");
  const clone = path.join(base, "clone");
  if (onBranch !== "trunk") git(clone, "checkout", "-q", "-b", onBranch);
  return clone;
}

const EDIT = [{ file: "a.txt", old: "a", new: "b" }];

function a(dir: string): string {
  return fs.readFileSync(path.join(dir, "a.txt"), "utf8");
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      out.push(path.relative(dir, path.join(d, e.name)));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

/** A patch that must have been refused by the guard, with nothing
 * written or left behind. */
function expectRefused(
  dir: string,
  r: ReturnType<typeof patch>,
  reason = "protected_branch",
): void {
  expect(r.status).toBe("usage_error");
  expect(r.reason).toBe(reason);
  expect(r.edits.map((e) => e.status)).toEqual(["refused"]);
  expect(r.edits[0].reason).toBe(reason);
  expect(r.writtenFiles).toEqual([]);
  expect(r.counts.files_written).toBe(0);
  expect(r.branchGuard.status).toBe("refused");
  expect(r.branchGuard.reason).toBe(reason);
  expect(r.branchGuard.detail).toContain("--allow-protected");
  expect(r.allowedProtected).toBe(false);
  expect(a(dir)).toBe("a\n");
  expect(tree(dir)).toEqual(["a.txt"]);
}

describe("patch branch guard: which branches are protected", () => {
  it("writes on a feature branch and reports the guard as allowed", () => {
    const dir = repoOn("task/feature");
    const r = patch({ cwd: dir, edits: EDIT });
    expect(r.status).toBe("written");
    expect(a(dir)).toBe("b\n");
    expect(r.branchGuard).toEqual({
      status: "allowed",
      branch: "task/feature",
      protected: ["main", "master"],
      sources: ["builtin"],
    });
    expect(r.allowedProtected).toBe(false);
  });

  it("refuses main and master by their built-in names when origin/HEAD is unset", () => {
    for (const branch of ["main", "master"]) {
      const dir = repoOn(branch);
      const r = patch({ cwd: dir, edits: EDIT });
      expectRefused(dir, r);
      expect(r.branchGuard.branch).toBe(branch);
      expect(r.branchGuard.sources).toEqual(["builtin"]);
      expect(r.branchGuard.detail).toContain("builtin");
    }
  });

  it("compares without regard to letter case: Master, MAIN", () => {
    for (const branch of ["Master", "MAIN", "mAiN"]) {
      const dir = repoOn(branch);
      expectRefused(dir, patch({ cwd: dir, edits: EDIT }));
    }
  });

  it("does not treat a branch that merely contains or extends a protected name as protected", () => {
    for (const branch of ["main2", "domain", "master/fix", "mainline"]) {
      const dir = repoOn(branch);
      expect(patch({ cwd: dir, edits: EDIT }).status, branch).toBe("written");
    }
  });

  it("refuses the branch origin/HEAD names, whatever it is called", () => {
    const dir = cloneOf("trunk");
    const r = patch({ cwd: dir, edits: EDIT });
    expectRefused(dir, r);
    expect(r.branchGuard.branch).toBe("trunk");
    expect(r.branchGuard.protected).toEqual(["trunk", "main", "master"]);
    expect(r.branchGuard.sources).toEqual(["origin-head", "builtin"]);
    expect(r.branchGuard.detail).toContain("origin-head");
  });

  it("writes on a feature branch of a clone, and still lists the origin default as protected", () => {
    const dir = cloneOf("task/x");
    const r = patch({ cwd: dir, edits: EDIT });
    expect(r.status).toBe("written");
    expect(r.branchGuard.status).toBe("allowed");
    expect(r.branchGuard.protected).toEqual(["trunk", "main", "master"]);
  });

  it("takes the origin default with a slash in its name", () => {
    const dir = cloneOf("task/x");
    git(
      dir,
      "update-ref",
      "refs/remotes/origin/release/1",
      git(dir, "rev-parse", "HEAD").trim(),
    );
    git(
      dir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/release/1",
    );
    git(dir, "checkout", "-q", "-b", "release/1");
    expectRefused(dir, patch({ cwd: dir, edits: EDIT }), "protected_branch");
  });

  it("ignores an origin/HEAD that points anywhere but at refs/remotes/origin/<name>", () => {
    const dir = cloneOf("trunk");
    git(
      dir,
      "update-ref",
      "refs/remotes/upstream/trunk",
      git(dir, "rev-parse", "HEAD").trim(),
    );
    git(
      dir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/upstream/trunk",
    );
    const r = patch({ cwd: dir, edits: EDIT });
    // trunk is protected by nothing now: no origin/HEAD name, not built in.
    expect(r.status).toBe("written");
    expect(r.branchGuard.sources).toEqual(["builtin"]);
    expect(r.branchGuard.protected).toEqual(["main", "master"]);
  });

  it("refuses a name from --protected, and writes on a branch that only starts with it", () => {
    const on = repoOn("release");
    const r = patch({
      cwd: on,
      edits: EDIT,
      protectedBranches: ["release"],
    });
    expectRefused(on, r);
    expect(r.branchGuard.sources).toEqual(["flag", "builtin"]);
    expect(r.branchGuard.protected).toEqual(["release", "main", "master"]);
    const near = repoOn("release2");
    expect(
      patch({ cwd: near, edits: EDIT, protectedBranches: ["release"] }).status,
    ).toBe("written");
    expect(a(near)).toBe("b\n");
    // Without the flag `release` is an ordinary branch.
    const plain = repoOn("release");
    expect(patch({ cwd: plain, edits: EDIT }).status).toBe("written");
  });

  it("compares a --protected name without regard to letter case, in either direction", () => {
    const upper = repoOn("release");
    expectRefused(
      upper,
      patch({ cwd: upper, edits: EDIT, protectedBranches: ["Release"] }),
    );
    const lower = repoOn("RELEASE");
    expectRefused(
      lower,
      patch({ cwd: lower, edits: EDIT, protectedBranches: ["release"] }),
    );
  });

  it("is the union of the flag, origin/HEAD and the built-in names: each alone refuses, and a name from one source is not lost to the others", () => {
    for (const branch of ["release", "trunk", "main"]) {
      const dir = cloneOf("task/x");
      git(dir, "checkout", "-q", "-B", branch);
      const r = patch({
        cwd: dir,
        edits: EDIT,
        protectedBranches: ["release"],
      });
      expectRefused(dir, r);
      expect(r.branchGuard.sources, branch).toEqual([
        "flag",
        "origin-head",
        "builtin",
      ]);
      expect(r.branchGuard.protected, branch).toEqual([
        "release",
        "trunk",
        "main",
        "master",
      ]);
    }
  });

  it("lists a name two sources agree on once, and keeps all sources", () => {
    const dir = cloneOf("trunk");
    const r = patch({
      cwd: dir,
      edits: EDIT,
      protectedBranches: ["TRUNK", "main"],
    });
    expectRefused(dir, r);
    expect(r.branchGuard.protected).toEqual(["TRUNK", "main", "master"]);
    expect(r.branchGuard.sources).toEqual(["flag", "origin-head", "builtin"]);
  });

  it("rejects a --protected name that is empty, padded or holds a control character", () => {
    const dir = repoOn("task");
    for (const bad of ["", " main", "main ", "ma\nin", "a\u0000b"]) {
      let thrown: unknown;
      try {
        patch({ cwd: dir, edits: EDIT, protectedBranches: [bad] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, JSON.stringify(bad)).toBeInstanceOf(PatchUsageError);
      expect((thrown as PatchUsageError).reason).toBe("protected_invalid");
    }
    expect(a(dir)).toBe("a\n");
    expect(protectedNameProblem("release/1")).toBeUndefined();
  });
});

describe("patch branch guard: how HEAD is read", () => {
  it("refuses main although a tag called main exists (git --short would say heads/main)", () => {
    const dir = repoOn("main");
    commitAll(dir);
    git(dir, "tag", "main");
    expect(git(dir, "symbolic-ref", "--short", "HEAD").trim()).toBe(
      "heads/main",
    );
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const r = patch({ cwd: dir, edits: EDIT });
    expectRefused(dir, r);
    expect(r.branchGuard.branch).toBe("main");
  });

  it("refuses on an unborn main, and on a main with commits", () => {
    const unborn = repoOn("main");
    expectRefused(unborn, patch({ cwd: unborn, edits: EDIT }));
    const born = repoOn("main");
    commitAll(born);
    expectRefused(born, patch({ cwd: born, edits: EDIT }));
  });

  it("writes on a detached HEAD and says so", () => {
    const dir = repoOn("main");
    commitAll(dir);
    git(dir, "checkout", "-q", "--detach");
    const r = patch({ cwd: dir, edits: EDIT });
    expect(r.status).toBe("written");
    expect(r.branchGuard).toMatchObject({
      status: "detached",
      branch: "HEAD",
    });
    expect(r.branchGuard.reason).toBeUndefined();
    expect(r.allowedProtected).toBe(false);
    expect(a(dir)).toBe("b\n");
  });

  it("refuses a detached HEAD under protectDetached, as protected_branch on branch HEAD", () => {
    const dir = repoOn("task");
    commitAll(dir);
    git(dir, "checkout", "-q", "--detach");
    const r = patch({ cwd: dir, edits: EDIT, protectDetached: true });
    expectRefused(dir, r);
    expect(r.branchGuard.branch).toBe("HEAD");
    expect(r.branchGuard.detail).toContain("detached");
  });

  it("protectDetached does nothing on a branch", () => {
    const dir = repoOn("task");
    const r = patch({ cwd: dir, edits: EDIT, protectDetached: true });
    expect(r.status).toBe("written");
    expect(r.branchGuard.status).toBe("allowed");
  });

  it("fails closed when HEAD names something outside refs/heads/", () => {
    const dir = repoOn("task");
    git(dir, "symbolic-ref", "HEAD", "refs/odd/place");
    const r = patch({ cwd: dir, edits: EDIT });
    expectRefused(dir, r, "protected_branch_unresolved");
    expect(r.branchGuard.branch).toBeUndefined();
    expect(r.branchGuard.detail).toContain("not a branch under refs/heads/");
  });
});

describe("patch branch guard: --allow-protected", () => {
  const cases: [string, () => { dir: string; extra: object }][] = [
    ["a built-in protected branch", () => ({ dir: repoOn("main"), extra: {} })],
    ["the origin default", () => ({ dir: cloneOf("trunk"), extra: {} })],
    [
      "a --protected name",
      () => ({
        dir: repoOn("release"),
        extra: { protectedBranches: ["release"] },
      }),
    ],
    [
      "a detached HEAD under protectDetached",
      () => {
        const dir = repoOn("task");
        commitAll(dir);
        git(dir, "checkout", "-q", "--detach");
        return { dir, extra: { protectDetached: true } };
      },
    ],
    [
      "a branch that cannot be resolved",
      () => {
        const dir = repoOn("task");
        git(dir, "symbolic-ref", "HEAD", "refs/odd/place");
        return { dir, extra: {} };
      },
    ],
  ];
  for (const [label, make] of cases) {
    it(`writes on ${label} and records the override twice`, () => {
      const { dir, extra } = make();
      const r = patch({
        cwd: dir,
        edits: EDIT,
        allowProtected: true,
        ...extra,
      });
      expect(r.status).toBe("written");
      expect(a(dir)).toBe("b\n");
      expect(r.branchGuard.status).toBe("allowed_protected");
      expect(r.branchGuard.reason).toMatch(/^protected_branch(_unresolved)?$/);
      expect(r.allowedProtected).toBe(true);
      expect(r.warnings.join("\n")).toContain("--allow-protected");
    });
  }

  it("leaves no trace of an override when nothing needed one", () => {
    const dir = repoOn("task");
    const r = patch({ cwd: dir, edits: EDIT, allowProtected: true });
    expect(r.status).toBe("written");
    expect(r.branchGuard.status).toBe("allowed");
    expect(r.allowedProtected).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("does not lift a path refusal: a .git file stays refused on a protected branch", () => {
    const dir = repoOn("main");
    const r = patch({
      cwd: dir,
      edits: [{ file: ".git/config", old: "[core]", new: "[x]" }],
      allowProtected: true,
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(r.branchGuard.status).toBe("allowed_protected");
  });
});

describe("patch branch guard: --dry-run", () => {
  it("reports would_refuse and the dry-run edits as they are, writing nothing", () => {
    const dir = repoOn("main");
    const r = patch({ cwd: dir, edits: EDIT, dryRun: true });
    expect(r.status).toBe("would_write");
    expect(r.edits[0].status).toBe("would_write");
    expect(r.files[0].diff).toContain("+b");
    expect(r.branchGuard).toMatchObject({
      status: "would_refuse",
      reason: "protected_branch",
      branch: "main",
    });
    expect(r.allowedProtected).toBe(false);
    expect(r.warnings.join("\n")).toContain("would be refused");
    expect(a(dir)).toBe("a\n");
  });

  it("reports would_refuse for an unresolved branch too", () => {
    const dir = repoOn("task");
    git(dir, "symbolic-ref", "HEAD", "refs/odd/place");
    const r = patch({ cwd: dir, edits: EDIT, dryRun: true });
    expect(r.status).toBe("would_write");
    expect(r.branchGuard).toMatchObject({
      status: "would_refuse",
      reason: "protected_branch_unresolved",
    });
  });

  it("still reports every other finding of the plan", () => {
    const dir = repoOn("main");
    const r = patch({
      cwd: dir,
      edits: [{ file: "a.txt", old: "zzz", new: "b" }],
      dryRun: true,
    });
    expect(r.status).toBe("missing");
    expect(r.branchGuard.status).toBe("would_refuse");
  });

  it("with --allow-protected is allowed_protected, not would_refuse", () => {
    const dir = repoOn("main");
    const r = patch({
      cwd: dir,
      edits: EDIT,
      dryRun: true,
      allowProtected: true,
    });
    expect(r.status).toBe("would_write");
    expect(r.branchGuard.status).toBe("allowed_protected");
    expect(r.allowedProtected).toBe(true);
  });

  it("is plain allowed on a feature branch", () => {
    const dir = repoOn("task");
    const r = patch({ cwd: dir, edits: EDIT, dryRun: true });
    expect(r.branchGuard.status).toBe("allowed");
    expect(r.warnings).toEqual([]);
  });
});

describe("patch branch guard: nothing is written when it refuses", () => {
  it("writes none of several files and leaves no temporary file", () => {
    const dir = repoOn("main");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "b\n");
    fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
    const before = tree(dir);
    const r = patch({
      cwd: dir,
      edits: [
        { file: "a.txt", old: "a", new: "A" },
        { file: "sub/b.txt", old: "b", new: "B" },
        { file: "c.txt", old: "c", new: "C" },
      ],
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(r.edits.map((e) => e.status)).toEqual([
      "refused",
      "refused",
      "refused",
    ]);
    expect(r.files.map((f) => f.status)).toEqual([
      "refused",
      "refused",
      "refused",
    ]);
    expect(r.counts).toMatchObject({
      refused: 3,
      written: 0,
      files_written: 0,
    });
    expect(r.writtenFiles).toEqual([]);
    expect(tree(dir)).toEqual(before);
    expect(a(dir)).toBe("a\n");
    expect(fs.readFileSync(path.join(dir, "sub", "b.txt"), "utf8")).toBe("b\n");
    expect(fs.readFileSync(path.join(dir, "c.txt"), "utf8")).toBe("c\n");
  });

  it("does not let an edit with another problem hide the refusal", () => {
    const dir = repoOn("main");
    const r = patch({
      cwd: dir,
      edits: [
        { file: "a.txt", old: "zzz", new: "b" },
        { file: "gone.txt", old: "a", new: "b" },
      ],
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(r.edits.map((e) => e.status)).toEqual(["refused", "refused"]);
  });

  it("keeps the reason of a path refusal that came first, and still writes nothing", () => {
    const dir = repoOn("main");
    const r = patch({
      cwd: dir,
      edits: [
        { file: ".git/config", old: "[core]", new: "[x]" },
        { file: "a.txt", old: "a", new: "b" },
      ],
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("git_dir");
    expect(r.edits.map((e) => e.status)).toEqual(["refused", "refused"]);
    expect(r.edits[1].reason).toBe("protected_branch");
    expect(r.branchGuard.status).toBe("refused");
    expect(a(dir)).toBe("a\n");
  });
});

describe("patch branch guard: layouts", () => {
  it("judges the repository root when -C is a subdirectory of a repository on main", () => {
    const dir = repoOn("main");
    fs.mkdirSync(path.join(dir, "deep", "er"), { recursive: true });
    fs.writeFileSync(path.join(dir, "deep", "er", "x.txt"), "x\n");
    const r = patch({
      cwd: path.join(dir, "deep", "er"),
      edits: [{ file: "x.txt", old: "x", new: "y" }],
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(r.branchGuard.branch).toBe("main");
    expect(fs.readFileSync(path.join(dir, "deep", "er", "x.txt"), "utf8")).toBe(
      "x\n",
    );
  });

  it("follows a .git symlink to the git directory it names", () => {
    const base = tmpDir();
    const real = repoOn("main", path.join(base, "real"));
    const link = path.join(base, "link");
    fs.mkdirSync(link);
    fs.symlinkSync(path.join(real, ".git"), path.join(link, ".git"));
    fs.writeFileSync(path.join(link, "a.txt"), "a\n");
    const r = patch({ cwd: link, edits: EDIT });
    expectRefused(link, r);
    expect(r.branchGuard.branch).toBe("main");
  });

  it("follows a .git file naming a separate git directory", () => {
    const base = tmpDir();
    const wt = path.join(base, "wt");
    fs.mkdirSync(wt);
    git(wt, "init", "-q", "--separate-git-dir", path.join(base, "gd"), ".");
    git(wt, "symbolic-ref", "HEAD", "refs/heads/main");
    fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
    expect(fs.statSync(path.join(wt, ".git")).isFile()).toBe(true);
    expectRefused(wt, patch({ cwd: wt, edits: EDIT }));
  });

  it("judges a linked worktree by its own branch: a task branch writes while the main checkout is on master", () => {
    const main = repoOn("master");
    commitAll(main);
    const wt = path.join(tmpDir(), "wt");
    git(main, "worktree", "add", "-q", "-b", "task/wt", wt);
    const r = patch({ cwd: wt, edits: EDIT });
    expect(r.status).toBe("written");
    expect(r.branchGuard.branch).toBe("task/wt");
    expect(a(wt)).toBe("b\n");
  });

  it("refuses a linked worktree that sits on main even when the main checkout is on a task branch", () => {
    const main = repoOn("task/main-checkout");
    commitAll(main);
    const wt = path.join(tmpDir(), "wt");
    git(main, "worktree", "add", "-q", "-b", "main", wt);
    const r = patch({ cwd: wt, edits: EDIT });
    expectRefused(wt, r);
    expect(r.branchGuard.branch).toBe("main");
    // The main checkout is not judged by the worktree's branch.
    expect(patch({ cwd: main, edits: EDIT }).status).toBe("written");
  });

  it("is not in a repository: writes, reports not_a_repo", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const r = patch({ cwd: dir, edits: EDIT });
    expect(r.status).toBe("written");
    expect(r.branchGuard).toEqual({
      status: "not_a_repo",
      protected: [],
      sources: [],
    });
    expect(r.allowedProtected).toBe(false);
  });

  it("treats a bare repository as no work tree: not_a_repo", () => {
    const base = tmpDir();
    git(base, "init", "-q", "--bare", "b.git");
    const bare = path.join(base, "b.git");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    const r = patch({
      cwd: bare,
      edits: [{ file: "description", old: "Unnamed", new: "Named" }],
      dryRun: true,
    });
    expect(r.branchGuard.status).toBe("not_a_repo");
  });

  it("an empty .git directory is no repository: with none around it git cannot be asked and the write is refused", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const r = patch({ cwd: dir, edits: EDIT });
    expectRefused(dir, r, "protected_branch_unresolved");
  });

  it("an empty .git directory inside a repository on main is judged as that repository", () => {
    const outer = repoOn("main");
    const inner = path.join(outer, "inner");
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
    fs.writeFileSync(path.join(inner, "a.txt"), "a\n");
    const r = patch({ cwd: inner, edits: EDIT });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(fs.readFileSync(path.join(inner, "a.txt"), "utf8")).toBe("a\n");
  });

  it("a hand-written .git directory with a valid layout and HEAD on main is the repository it looks like", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git", "refs"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    expectRefused(dir, patch({ cwd: dir, edits: EDIT }));
  });

  it("fails closed where git would read a commondir without bound (no git is run)", () => {
    const dir = repoOn("task");
    const file = path.join(dir, ".git", "commondir");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 128 * 1024);
    const r = patch({ cwd: dir, edits: EDIT });
    expectRefused(dir, r, "protected_branch_unresolved");
    expect(r.branchGuard.detail).toContain("git was not run");
  });

  it("limit: a file outside the root is not judged by its own repository", () => {
    // The root is the repository holding -C. A target in another
    // repository (--allow-outside) is judged by the root's branch only;
    // this test pins that documented limit so a change to it is deliberate.
    const base = tmpDir();
    const onMain = repoOn("main", path.join(base, "other"));
    const task = repoOn("task", path.join(base, "task"));
    const r = patch({
      cwd: task,
      edits: [{ file: "../other/a.txt", old: "a", new: "b" }],
      allowOutside: true,
    });
    expect(r.status).toBe("written");
    expect(a(onMain)).toBe("b\n");
    expect(r.branchGuard.branch).toBe("task");
  });
});

describe("patch branch guard: the environment cannot steer it", () => {
  function withEnv<T>(vars: Record<string, string>, body: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      return body();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("a GIT_DIR naming a repository on a feature branch does not hide main", () => {
    const main = repoOn("main");
    const other = repoOn("task", tmpDir());
    const r = withEnv({ GIT_DIR: path.join(other, ".git") }, () =>
      patch({ cwd: main, edits: EDIT }),
    );
    expectRefused(main, r);
    expect(r.branchGuard.branch).toBe("main");
  });

  it("a GIT_DIR naming a repository on main does not block a feature branch", () => {
    const task = repoOn("task");
    const other = repoOn("main", tmpDir());
    const r = withEnv({ GIT_DIR: path.join(other, ".git") }, () =>
      patch({ cwd: task, edits: EDIT }),
    );
    expect(r.status).toBe("written");
    expect(r.branchGuard.branch).toBe("task");
  });

  it("a GIT_WORK_TREE, GIT_COMMON_DIR or GIT_CEILING_DIRECTORIES does not change the answer", () => {
    const main = repoOn("main");
    const other = repoOn("task", tmpDir());
    const r = withEnv(
      {
        GIT_WORK_TREE: other,
        GIT_COMMON_DIR: path.join(other, ".git"),
        GIT_CEILING_DIRECTORIES: path.dirname(main),
      },
      () => patch({ cwd: main, edits: EDIT }),
    );
    expectRefused(main, r);
  });

  it("a GIT_NAMESPACE does not change the answer", () => {
    for (const [branch, status] of [
      ["main", "usage_error"],
      ["task", "written"],
    ] as const) {
      const dir = repoOn(branch);
      const r = withEnv({ GIT_NAMESPACE: "elsewhere" }, () =>
        patch({ cwd: dir, edits: EDIT }),
      );
      expect(r.status, branch).toBe(status);
    }
    const clone = cloneOf("trunk");
    const r = withEnv({ GIT_NAMESPACE: "elsewhere" }, () =>
      patch({ cwd: clone, edits: EDIT }),
    );
    expectRefused(clone, r);
    expect(r.branchGuard.sources).toContain("origin-head");
  });

  it("git's environment loses every variable that selects a repository, a ref store or configuration", () => {
    const env = branchGuardEnv({
      PATH: "/bin",
      HOME: "/h",
      GIT_DIR: "x",
      GIT_WORK_TREE: "x",
      GIT_COMMON_DIR: "x",
      GIT_INDEX_FILE: "x",
      GIT_OBJECT_DIRECTORY: "x",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "x",
      GIT_NAMESPACE: "x",
      GIT_PREFIX: "x",
      GIT_CEILING_DIRECTORIES: "x",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_REF_STORAGE_FORMAT: "reftable",
      GIT_REFERENCE_BACKEND: "reftable",
      GIT_CONFIG_PARAMETERS: "'a.b=c'",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
      GIT_CONFIG_KEY_17: "a.b",
      GIT_CONFIG_VALUE_17: "c",
      GIT_TERMINAL_PROMPT: "1",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("patch branch guard: the stand-in for git is not the repository", () => {
  it("a git that is not on PATH inside a repository refuses (CLI), and --allow-protected writes", () => {
    const dir = repoOn("task");
    const noGit = path.join(tmpDir(), "no-git-bin");
    const env = { PATH: noGit };
    const refused = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "--json",
        "-C",
        dir,
        "patch",
        "--file",
        "a.txt",
        "--old",
        "a",
        "--new",
        "b",
      ],
      { env, encoding: "utf8" },
    );
    expect(refused.status).toBe(2);
    const out = JSON.parse(refused.stdout) as {
      status: string;
      reason: string;
      branch_guard: { status: string; reason: string };
      warnings: string[];
    };
    expect(out.status).toBe("usage_error");
    expect(out.reason).toBe("protected_branch_unresolved");
    expect(out.branch_guard.status).toBe("refused");
    // The identity lookup keeps its own warn-only behaviour.
    expect(out.warnings.join("\n")).toContain("git could not be run");
    expect(a(dir)).toBe("a\n");
    const allowed = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "--json",
        "-C",
        dir,
        "patch",
        "--allow-protected",
        "--file",
        "a.txt",
        "--old",
        "a",
        "--new",
        "b",
      ],
      { env, encoding: "utf8" },
    );
    expect(allowed.status).toBe(0);
    expect(a(dir)).toBe("b\n");
  });
});

interface GuardJson {
  status: string;
  reason?: string;
  allowed_protected?: boolean;
  branch_guard: {
    status: string;
    branch?: string;
    protected: string[];
    sources: string[];
    reason?: string;
  };
  warnings: string[];
  edits: { status: string; reason?: string }[];
}

async function cli(
  dir: string,
  ...args: string[]
): Promise<{ code: number | null; out: GuardJson; stdout: string }> {
  const res = await spawnCli(
    [
      "--json",
      "-C",
      dir,
      "patch",
      "--file",
      "a.txt",
      "--old",
      "a",
      "--new",
      "b",
      ...args,
    ],
    { env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  return {
    code: res.code,
    out: JSON.parse(res.stdout) as GuardJson,
    stdout: res.stdout,
  };
}

describe("patch branch guard: the CLI", () => {
  it("refuses on a protected branch: exit 2, usage_error, the guard in the envelope, no override field", async () => {
    const dir = repoOn("main");
    const r = await cli(dir);
    expect(r.code).toBe(2);
    expect(r.out.status).toBe("usage_error");
    expect(r.out.reason).toBe("protected_branch");
    expect(r.out.edits[0]).toMatchObject({
      status: "refused",
      reason: "protected_branch",
    });
    expect(r.out.branch_guard).toEqual({
      status: "refused",
      branch: "main",
      protected: ["main", "master"],
      sources: ["builtin"],
      reason: "protected_branch",
      detail: expect.stringContaining("--allow-protected") as string,
    });
    expect(r.out.allowed_protected).toBeUndefined();
    expect(a(dir)).toBe("a\n");
  });

  it("--allow-protected writes and puts allowed_protected: true at the top level", async () => {
    const dir = repoOn("main");
    const r = await cli(dir, "--allow-protected");
    expect(r.code).toBe(0);
    expect(r.out.status).toBe("written");
    expect(r.out.allowed_protected).toBe(true);
    expect(r.out.branch_guard.status).toBe("allowed_protected");
    expect(a(dir)).toBe("b\n");
  });

  it("--protected is repeatable and needs a usable name", async () => {
    const one = repoOn("release");
    const r = await cli(one, "--protected", "hotfix", "--protected", "release");
    expect(r.code).toBe(2);
    expect(r.out.branch_guard.protected).toEqual([
      "hotfix",
      "release",
      "main",
      "master",
    ]);
    expect(r.out.branch_guard.sources).toEqual(["flag", "builtin"]);
    const two = repoOn("release2");
    expect((await cli(two, "--protected", "release")).code).toBe(0);
    const bad = await cli(two, "--protected", " ");
    expect(bad.code).toBe(2);
    expect(bad.out.reason).toBe("protected_invalid");
    expect(a(two)).toBe("b\n");
  });

  it("--protect-detached refuses a detached HEAD", async () => {
    const dir = repoOn("task");
    commitAll(dir);
    git(dir, "checkout", "-q", "--detach");
    const ok = await cli(dir, "--dry-run");
    expect(ok.out.branch_guard.status).toBe("detached");
    const r = await cli(dir, "--protect-detached");
    expect(r.code).toBe(2);
    expect(r.out.reason).toBe("protected_branch");
    expect(r.out.branch_guard.branch).toBe("HEAD");
    expect(a(dir)).toBe("a\n");
  });

  it("--dry-run on a protected branch exits 0 with would_refuse", async () => {
    const dir = repoOn("main");
    const r = await cli(dir, "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out.status).toBe("would_write");
    expect(r.out.branch_guard.status).toBe("would_refuse");
    expect(r.out.branch_guard.reason).toBe("protected_branch");
    expect(a(dir)).toBe("a\n");
  });

  it("keeps the guard whole when -m reduces the envelope", async () => {
    const dir = repoOn("main");
    const edits = Array.from({ length: 12 }, (_, n) => ({
      file: `f${String(n)}.txt`,
      old: "a",
      new: "b",
    }));
    for (const e of edits) fs.writeFileSync(path.join(dir, e.file), "a\n");
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ edits }));
    const res = await spawnCli(
      [
        "--json",
        "-m",
        "1800",
        "-C",
        dir,
        "patch",
        "--plan",
        "plan.json",
        "--allow-protected",
      ],
      { env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
    );
    const out = JSON.parse(res.stdout) as GuardJson & { truncated: boolean };
    // The edits and files were cut down; the guard and its audit field were not.
    expect(out.truncated).toBe(true);
    // Whole: a reduced object would name only some of its keys.
    expect(out.branch_guard).toEqual({
      status: "allowed_protected",
      branch: "main",
      protected: ["main", "master"],
      sources: ["builtin"],
      reason: "protected_branch",
      detail: expect.stringContaining("--allow-protected") as string,
    });
    expect(out.allowed_protected).toBe(true);
  });

  it("writes outside any repository", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const r = await cli(dir);
    expect(r.code).toBe(0);
    expect(r.out.branch_guard.status).toBe("not_a_repo");
  });
});
