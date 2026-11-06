import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { patch, PatchUsageError, type RepoGuard } from "../src/patch/index.js";
import {
  branchGuardEnv,
  combineGuards,
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

/** A work tree on `branch` (no commit yet) holding `a.txt`, staged: the
 * guard refuses a tracked target, and one in the index is tracked. */
function repoOn(branch: string, dir = tmpDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
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

/** The one repository entry of a plan that touches one repository. */
function g(r: ReturnType<typeof patch>): RepoGuard {
  expect(r.branchGuard.repos).toHaveLength(1);
  return r.branchGuard.repos[0];
}

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
  expect(r.edits[0].detail).toContain("--allow-protected");
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
      repos: [
        {
          root: dir,
          status: "allowed",
          branch: "task/feature",
          protected: ["main", "master"],
          sources: ["builtin"],
        },
      ],
    });
    expect(r.allowedProtected).toBe(false);
  });

  it("refuses main and master by their built-in names when origin/HEAD is unset", () => {
    for (const branch of ["main", "master"]) {
      const dir = repoOn(branch);
      const r = patch({ cwd: dir, edits: EDIT });
      expectRefused(dir, r);
      expect(g(r).branch).toBe(branch);
      expect(g(r).sources).toEqual(["builtin"]);
      expect(r.edits[0].detail).toContain("builtin");
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
    expect(g(r).branch).toBe("trunk");
    expect(g(r).protected).toEqual(["trunk", "main", "master"]);
    expect(g(r).sources).toEqual(["origin-head", "builtin"]);
    expect(r.edits[0].detail).toContain("origin-head");
  });

  it("writes on a feature branch of a clone, and still lists the origin default as protected", () => {
    const dir = cloneOf("task/x");
    const r = patch({ cwd: dir, edits: EDIT });
    expect(r.status).toBe("written");
    expect(r.branchGuard.status).toBe("allowed");
    expect(g(r).protected).toEqual(["trunk", "main", "master"]);
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
    expect(g(r).sources).toEqual(["builtin"]);
    expect(g(r).protected).toEqual(["main", "master"]);
  });

  it("refuses a name from --protected, and writes on a branch that only starts with it", () => {
    const on = repoOn("release");
    const r = patch({
      cwd: on,
      edits: EDIT,
      protectedBranches: ["release"],
    });
    expectRefused(on, r);
    expect(g(r).sources).toEqual(["flag", "builtin"]);
    expect(g(r).protected).toEqual(["release", "main", "master"]);
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
      expect(g(r).sources, branch).toEqual(["flag", "origin-head", "builtin"]);
      expect(g(r).protected, branch).toEqual([
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
    expect(g(r).protected).toEqual(["TRUNK", "main", "master"]);
    expect(g(r).sources).toEqual(["flag", "origin-head", "builtin"]);
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
    expect(g(r).branch).toBe("main");
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
    expect(r.branchGuard.status).toBe("detached");
    expect(g(r)).toMatchObject({ status: "detached", branch: "HEAD" });
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
    expect(g(r).branch).toBe("HEAD");
    expect(r.edits[0].detail).toContain("detached");
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
    expect(g(r).branch).toBeUndefined();
    expect(r.edits[0].detail).toContain("not a branch under refs/heads/");
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
    expect(r.branchGuard.status).toBe("would_refuse");
    expect(r.branchGuard.reason).toBe("protected_branch");
    expect(g(r)).toMatchObject({ status: "would_refuse", branch: "main" });
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

/** A repository on `branch` with one tracked file (`a.txt`, committed), an
 * untracked `run/notes.md`, a tracked-by-force `kept.log` that an ignore
 * rule also names, and an ignored `.cache/note.txt`. */
function mixedRepo(branch = "main"): string {
  const dir = repoOn(branch);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".cache/\n*.log\n");
  fs.writeFileSync(path.join(dir, "kept.log"), "k\n");
  git(dir, "add", ".gitignore");
  git(dir, "add", "-f", "kept.log");
  commitAll(dir);
  fs.mkdirSync(path.join(dir, "run"));
  fs.writeFileSync(path.join(dir, "run", "notes.md"), "n\n");
  fs.mkdirSync(path.join(dir, ".cache"));
  fs.writeFileSync(path.join(dir, ".cache", "note.txt"), "c\n");
  return dir;
}

const NOTES = { file: "run/notes.md", old: "n", new: "N" };
const CACHED = { file: ".cache/note.txt", old: "c", new: "C" };
const TRACKED = { file: "a.txt", old: "a", new: "A" };

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

/** Runs `fn` with a `git` first on PATH that answers `body` for the calls
 * it matches and hands every other call to the real git. */
function withGitShim<T>(shimBody: string, fn: () => T): T {
  const real = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const bin = tmpDir();
  const script = path.join(bin, "git");
  fs.writeFileSync(
    script,
    `#!/bin/sh\n${shimBody}\nexec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o755 },
  );
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

describe("patch branch guard: untracked and ignored targets", () => {
  it("edits an untracked and an ignored file on main and records each", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [NOTES, CACHED] });
    expect(r.status).toBe("written");
    expect(read(dir, "run/notes.md")).toBe("N\n");
    expect(read(dir, ".cache/note.txt")).toBe("C\n");
    expect(r.allowedProtected).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(g(r)).toMatchObject({
      status: "allowed_untracked",
      branch: "main",
      protected: ["main", "master"],
      targets: [
        {
          path: "run/notes.md",
          status: "allowed_untracked",
          tracking: "untracked",
        },
        {
          path: ".cache/note.txt",
          status: "allowed_ignored",
          tracking: "ignored",
        },
      ],
    });
    expect(g(r).reason).toBeUndefined();
    expect(r.branchGuard.status).toBe("allowed_untracked");
    expect(r.branchGuard.reason).toBeUndefined();
  });

  it("an ignored target alone is allowed_ignored", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [CACHED] });
    expect(r.status).toBe("written");
    expect(g(r).status).toBe("allowed_ignored");
    expect(g(r).targets).toEqual([
      {
        path: ".cache/note.txt",
        status: "allowed_ignored",
        tracking: "ignored",
      },
    ]);
    expect(r.branchGuard.status).toBe("allowed_ignored");
  });

  it("an untracked target alone is allowed_untracked", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [NOTES] });
    expect(r.status).toBe("written");
    expect(g(r).status).toBe("allowed_untracked");
    expect(r.branchGuard.status).toBe("allowed_untracked");
  });

  it("the order of the targets does not change the repository's status", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [CACHED, NOTES] });
    expect(g(r).status).toBe("allowed_untracked");
    expect(g(r).targets?.map((t) => t.status)).toEqual([
      "allowed_ignored",
      "allowed_untracked",
    ]);
  });

  it("classifies a name with glob characters as that name", () => {
    const dir = mixedRepo();
    fs.writeFileSync(path.join(dir, "n1.md"), "n\n");
    git(dir, "add", "n1.md");
    fs.writeFileSync(path.join(dir, "n[1].md"), "n\n");
    const r = patch({
      cwd: dir,
      edits: [{ file: "n[1].md", old: "n", new: "N" }],
    });
    expect(r.status).toBe("written");
    expect(g(r).targets).toEqual([
      { path: "n[1].md", status: "allowed_untracked", tracking: "untracked" },
    ]);
  });

  it("an untracked target in a subdirectory of an ignored directory is ignored", () => {
    const dir = mixedRepo();
    fs.mkdirSync(path.join(dir, ".cache", "deep", "er"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cache", "deep", "er", "x.txt"), "c\n");
    const r = patch({
      cwd: dir,
      edits: [{ file: ".cache/deep/er/x.txt", old: "c", new: "C" }],
    });
    expect(r.status).toBe("written");
    expect(g(r).targets?.[0]).toMatchObject({
      status: "allowed_ignored",
      tracking: "ignored",
    });
  });

  it("a tracked file that an ignore rule names is still tracked and refused", () => {
    const dir = mixedRepo();
    const r = patch({
      cwd: dir,
      edits: [{ file: "kept.log", old: "k", new: "K" }],
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(read(dir, "kept.log")).toBe("k\n");
    expect(g(r).targets).toEqual([
      {
        path: "kept.log",
        status: "refused",
        tracking: "tracked",
        reason: "protected_branch",
      },
    ]);
  });

  it("a tracked target is refused: exit-2 reason, nothing written", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [TRACKED] });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(r.edits.map((e) => e.status)).toEqual(["refused"]);
    expect(r.writtenFiles).toEqual([]);
    expect(r.branchGuard.status).toBe("refused");
    expect(read(dir, "a.txt")).toBe("a\n");
  });

  it("one tracked target refuses the whole plan and the detail names it", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [NOTES, TRACKED, CACHED] });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(r.edits.map((e) => e.status)).toEqual([
      "refused",
      "refused",
      "refused",
    ]);
    expect(r.writtenFiles).toEqual([]);
    expect(r.counts.files_written).toBe(0);
    expect(read(dir, "run/notes.md")).toBe("n\n");
    expect(read(dir, ".cache/note.txt")).toBe("c\n");
    expect(read(dir, "a.txt")).toBe("a\n");
    // The tracked file is named by its own edit's refusal; the files that
    // would have been allowed say that the plan goes down with it.
    expect(r.edits[1].detail).toContain('"a.txt"');
    expect(r.edits[1].detail).not.toContain("refused as a whole");
    for (const i of [0, 2]) {
      expect(r.edits[i].detail).toContain("refused as a whole");
      expect(r.edits[i].detail).toContain('"a.txt"');
      expect(r.edits[i].detail).not.toContain("notes.md");
      expect(r.edits[i].detail).not.toContain("note.txt");
    }
    expect(g(r).status).toBe("refused");
    expect(g(r).targets?.map((t) => [t.path, t.status, t.tracking])).toEqual([
      ["run/notes.md", "allowed_untracked", "untracked"],
      ["a.txt", "refused", "tracked"],
      [".cache/note.txt", "allowed_ignored", "ignored"],
    ]);
    expect(tree(dir)).toEqual(tree(dir).slice().sort());
  });

  it("a refusal still names the tracked targets when two are tracked", () => {
    const dir = mixedRepo();
    const r = patch({
      cwd: dir,
      edits: [TRACKED, NOTES, { file: ".gitignore", old: ".cache", new: "x" }],
    });
    expect(r.status).toBe("usage_error");
    const detail = r.edits[1].detail ?? "";
    expect(detail).toContain('"a.txt"');
    expect(detail).toContain('".gitignore"');
    expect(read(dir, "run/notes.md")).toBe("n\n");
  });

  it("--dry-run: tracked would_refuse, the others keep their own status", () => {
    const dir = mixedRepo();
    const r = patch({
      cwd: dir,
      edits: [NOTES, TRACKED, CACHED],
      dryRun: true,
    });
    expect(r.status).toBe("would_write");
    expect(g(r).status).toBe("would_refuse");
    expect(r.branchGuard.status).toBe("would_refuse");
    expect(g(r).targets?.map((t) => t.status)).toEqual([
      "allowed_untracked",
      "would_refuse",
      "allowed_ignored",
    ]);
    expect(g(r).targets?.[1].reason).toBe("protected_branch");
    expect(r.warnings.join("\n")).toContain("would be refused");
    expect(read(dir, "a.txt")).toBe("a\n");
  });

  it("--dry-run with only untracked targets has nothing to refuse", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [NOTES, CACHED], dryRun: true });
    expect(r.status).toBe("would_write");
    expect(r.branchGuard.status).toBe("allowed_untracked");
    expect(r.warnings).toEqual([]);
  });

  it("--allow-protected lifts only the tracked target and leaves the others' status", () => {
    const dir = mixedRepo();
    const r = patch({
      cwd: dir,
      edits: [NOTES, TRACKED, CACHED],
      allowProtected: true,
    });
    expect(r.status).toBe("written");
    expect(r.allowedProtected).toBe(true);
    expect(read(dir, "a.txt")).toBe("A\n");
    expect(g(r).status).toBe("allowed_protected");
    expect(r.branchGuard.status).toBe("allowed_protected");
    expect(g(r).targets?.map((t) => t.status)).toEqual([
      "allowed_untracked",
      "allowed_protected",
      "allowed_ignored",
    ]);
  });

  it("--allow-protected with only untracked targets records no override", () => {
    const dir = mixedRepo();
    const r = patch({ cwd: dir, edits: [NOTES], allowProtected: true });
    expect(r.status).toBe("written");
    expect(r.allowedProtected).toBe(false);
    expect(r.branchGuard.status).toBe("allowed_untracked");
    expect(r.warnings).toEqual([]);
  });

  it("an unprotected branch lists no targets and runs no classification", () => {
    const dir = mixedRepo("task");
    const r = patch({ cwd: dir, edits: [NOTES, TRACKED] });
    expect(r.status).toBe("written");
    expect(g(r).status).toBe("allowed");
    expect(g(r).targets).toBeUndefined();
  });

  it("a branch that cannot be resolved still refuses an untracked target", () => {
    const dir = mixedRepo("task");
    git(dir, "symbolic-ref", "HEAD", "refs/odd/place");
    const r = patch({ cwd: dir, edits: [NOTES] });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch_unresolved");
    expect(read(dir, "run/notes.md")).toBe("n\n");
    expect(g(r).targets).toBeUndefined();
  });

  describe("detached HEAD under --protect-detached", () => {
    function detached(): string {
      const dir = mixedRepo("task");
      git(dir, "checkout", "-q", "--detach");
      return dir;
    }

    it("allows untracked and ignored targets", () => {
      const dir = detached();
      const r = patch({
        cwd: dir,
        edits: [NOTES, CACHED],
        protectDetached: true,
      });
      expect(r.status).toBe("written");
      expect(g(r)).toMatchObject({
        status: "allowed_untracked",
        branch: "HEAD",
      });
      expect(g(r).targets?.map((t) => t.status)).toEqual([
        "allowed_untracked",
        "allowed_ignored",
      ]);
    });

    it("refuses a tracked target and with it the whole plan", () => {
      const dir = detached();
      const r = patch({
        cwd: dir,
        edits: [NOTES, TRACKED],
        protectDetached: true,
      });
      expect(r.status).toBe("usage_error");
      expect(r.reason).toBe("protected_branch");
      expect(r.edits[1].detail).toContain("detached HEAD");
      expect(r.edits[1].detail).toContain('"a.txt"');
      expect(read(dir, "run/notes.md")).toBe("n\n");
      expect(read(dir, "a.txt")).toBe("a\n");
    });

    it("without --protect-detached nothing is classified", () => {
      const dir = detached();
      const r = patch({ cwd: dir, edits: [NOTES, TRACKED] });
      expect(r.status).toBe("written");
      expect(g(r).status).toBe("detached");
      expect(g(r).targets).toBeUndefined();
    });
  });

  describe("when git cannot classify a target", () => {
    const FAIL_IGNORE =
      '[ "$1" = check-ignore ] && { echo boom >&2; exit 128; }';
    const FAIL_LS = '[ "$1" = ls-files ] && { echo boom >&2; exit 128; }';

    it("treats a failing check-ignore as tracked: refused, with a warning", () => {
      const dir = mixedRepo();
      const r = withGitShim(FAIL_IGNORE, () =>
        patch({ cwd: dir, edits: [NOTES] }),
      );
      expect(r.status).toBe("usage_error");
      expect(r.reason).toBe("protected_branch");
      expect(read(dir, "run/notes.md")).toBe("n\n");
      expect(g(r).targets).toEqual([
        {
          path: "run/notes.md",
          status: "refused",
          tracking: "unknown",
          reason: "protected_branch",
        },
      ]);
      const warned = r.warnings.filter((w) => w.includes("could not tell"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("run/notes.md");
      expect(warned[0]).toContain("check-ignore");
      expect(warned[0]).toContain("treated as tracked");
    });

    it("treats a failing ls-files as tracked", () => {
      const dir = mixedRepo();
      const r = withGitShim(FAIL_LS, () => patch({ cwd: dir, edits: [NOTES] }));
      expect(r.status).toBe("usage_error");
      expect(g(r).targets?.[0].tracking).toBe("unknown");
      expect(r.warnings.join("\n")).toContain("ls-files");
    });

    it("a classification that fails does not hide the one that worked", () => {
      const dir = mixedRepo();
      const r = withGitShim(
        `case "$*" in *notes.md*) [ "$1" = check-ignore ] && exit 128 ;; esac`,
        () => patch({ cwd: dir, edits: [NOTES, CACHED] }),
      );
      expect(r.status).toBe("usage_error");
      expect(g(r).targets?.map((t) => [t.tracking, t.status])).toEqual([
        ["unknown", "refused"],
        ["ignored", "allowed_ignored"],
      ]);
      expect(read(dir, ".cache/note.txt")).toBe("c\n");
    });

    it("treats a call that outlives the guard's timeout as tracked", () => {
      const dir = mixedRepo();
      const r = withGitShim('[ "$1" = check-ignore ] && exec sleep 20', () =>
        patch({ cwd: dir, edits: [NOTES], gitTimeoutMs: 400 }),
      );
      expect(r.status).toBe("usage_error");
      expect(r.reason).toBe("protected_branch");
      expect(g(r).targets?.[0].tracking).toBe("unknown");
      expect(r.warnings.join("\n")).toContain("did not finish within 400 ms");
    });

    it("--allow-protected writes the unclassifiable target and records the override", () => {
      const dir = mixedRepo();
      const r = withGitShim(FAIL_IGNORE, () =>
        patch({ cwd: dir, edits: [NOTES], allowProtected: true }),
      );
      expect(r.status).toBe("written");
      expect(r.allowedProtected).toBe(true);
      expect(g(r).targets?.[0]).toMatchObject({
        status: "allowed_protected",
        tracking: "unknown",
      });
    });

    it("--dry-run reports would_refuse for it", () => {
      const dir = mixedRepo();
      const r = withGitShim(FAIL_IGNORE, () =>
        patch({ cwd: dir, edits: [NOTES], dryRun: true }),
      );
      expect(g(r).targets?.[0].status).toBe("would_refuse");
    });
  });
});

/** A repository on `main` with the given case and Unicode settings. */
function spellingRepo(settings: Record<string, string | undefined>): string {
  const dir = tmpDir();
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const [k, v] of Object.entries(settings)) {
    if (v === undefined) git(dir, "config", "--unset", k);
    else git(dir, "config", k, v);
  }
  return dir;
}

/** Renames `from` to `to` through a temporary name, so that a volume that
 * folds letter case or Unicode form takes the new spelling. */
function respell(dir: string, from: string, to: string): void {
  const tmp = path.join(path.dirname(path.join(dir, from)), ".respell-tmp");
  fs.renameSync(path.join(dir, from), tmp);
  fs.renameSync(tmp, path.join(dir, to));
}

function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

/** The edit that `file` carries in the spelling tests. */
const hi = (file: string) => ({ file, old: "hi", new: "Z" });

/** A patch that the guard must have refused as tracked, with the file
 * unchanged. */
function expectTrackedRefusal(
  dir: string,
  r: ReturnType<typeof patch>,
  rel: string,
): void {
  expect(r.status).toBe("usage_error");
  expect(r.reason).toBe("protected_branch");
  expect(r.writtenFiles).toEqual([]);
  expect(read(dir, rel)).toBe("hi\n");
  expect(g(r).targets?.[0]).toMatchObject({
    status: "refused",
    tracking: "tracked",
  });
}

describe("patch branch guard: another spelling of a tracked file is tracked", () => {
  const foldsCase = (dir: string, spelling: string): boolean => {
    const other =
      spelling === spelling.toLowerCase()
        ? spelling.toUpperCase()
        : spelling.toLowerCase();
    return other !== spelling && fs.existsSync(path.join(dir, other));
  };

  describe("with core.ignorecase=true", () => {
    it("refuses the on-disk spelling of an index entry that differs in letter case", () => {
      const dir = spellingRepo({ "core.ignorecase": "true" });
      write(dir, "Bar.md", "hi\n");
      git(dir, "add", "Bar.md");
      commitAll(dir);
      respell(dir, "Bar.md", "bar.md");
      expectTrackedRefusal(
        dir,
        patch({ cwd: dir, edits: [hi("bar.md")] }),
        "bar.md",
      );
      if (foldsCase(dir, "bar.md")) {
        // The volume folds case: the name in the index reaches the file too.
        expectTrackedRefusal(
          dir,
          patch({ cwd: dir, edits: [hi("Bar.md")] }),
          "bar.md",
        );
      }
    });

    it("refuses a tracked file below a directory that differs in letter case", () => {
      const dir = spellingRepo({ "core.ignorecase": "true" });
      write(dir, "Dir/Sub/a.md", "hi\n");
      git(dir, "add", "-A");
      commitAll(dir);
      respell(dir, "Dir", "dir");
      expectTrackedRefusal(
        dir,
        patch({ cwd: dir, edits: [hi("dir/Sub/a.md")] }),
        "dir/Sub/a.md",
      );
    });

    it("refuses the ignored variant: a tracked file that an ignore rule names", () => {
      const dir = spellingRepo({ "core.ignorecase": "true" });
      write(dir, ".gitignore", "*.log\n");
      write(dir, "Bar.log", "hi\n");
      git(dir, "add", ".gitignore");
      git(dir, "add", "-f", "Bar.log");
      commitAll(dir);
      respell(dir, "Bar.log", "bar.log");
      expectTrackedRefusal(
        dir,
        patch({ cwd: dir, edits: [hi("bar.log")] }),
        "bar.log",
      );
    });

    it("still allows an untracked file whose name only resembles a tracked one", () => {
      const dir = spellingRepo({ "core.ignorecase": "true" });
      write(dir, "Bar.md", "hi\n");
      write(dir, "Bar.md.bak", "hi\n");
      git(dir, "add", "-A");
      commitAll(dir);
      write(dir, "Bar.mdx", "hi\n");
      write(dir, "Bar", "hi\n");
      for (const f of ["Bar.mdx", "Bar"]) {
        const r = patch({ cwd: dir, edits: [hi(f)], dryRun: true });
        expect(g(r).targets?.[0]).toMatchObject({
          status: "allowed_untracked",
          tracking: "untracked",
        });
      }
    });

    it("a name with glob characters stays literal under icase", () => {
      const dir = spellingRepo({ "core.ignorecase": "true" });
      write(dir, "g[1]*/t.md", "hi\n");
      write(dir, "g1x/t.md", "hi\n");
      git(dir, "add", "-A");
      commitAll(dir);
      write(dir, "g[1]*/u.md", "hi\n");
      const tracked = patch({ cwd: dir, edits: [hi("g[1]*/t.md")] });
      expectTrackedRefusal(dir, tracked, "g[1]*/t.md");
      const free = patch({ cwd: dir, edits: [hi("g[1]*/u.md")] });
      expect(free.status).toBe("written");
      expect(g(free).targets?.[0].tracking).toBe("untracked");
    });

    it("an untracked and an ignored file beside tracked ones keep their allowed statuses", () => {
      const dir = spellingRepo({ "core.ignorecase": "true" });
      write(dir, ".gitignore", "*.log\n");
      write(dir, "d/t.md", "hi\n");
      write(dir, "d/u.md.bak", "hi\n");
      write(dir, "dd/u.md", "hi\n");
      git(dir, "add", "-A");
      commitAll(dir);
      write(dir, "d/u.md", "hi\n");
      write(dir, "d/i.log", "hi\n");
      const r = patch({ cwd: dir, edits: [hi("d/u.md"), hi("d/i.log")] });
      expect(r.status).toBe("written");
      expect(g(r).targets?.map((t) => [t.tracking, t.status])).toEqual([
        ["untracked", "allowed_untracked"],
        ["ignored", "allowed_ignored"],
      ]);
    });

    it("fails closed when core.ignorecase cannot be read: the case variant is refused", () => {
      const dir = spellingRepo({ "core.ignorecase": "true" });
      write(dir, "Bar.md", "hi\n");
      git(dir, "add", "Bar.md");
      commitAll(dir);
      respell(dir, "Bar.md", "bar.md");
      const r = withGitShim(
        '[ "$1" = config ] && { echo boom >&2; exit 2; }',
        () => patch({ cwd: dir, edits: [hi("bar.md")] }),
      );
      expectTrackedRefusal(dir, r, "bar.md");
    });
  });

  describe("with core.ignorecase=false or unset", () => {
    // git itself then treats the two spellings as two files. The case
    // variant that is not in the index is untracked here and is allowed;
    // the setting is wrong for a volume that folds case, which git init
    // detects, and the guard goes by what the repository says.
    for (const [label, setting] of [
      ["false", "false"],
      ["unset", undefined],
    ] as const) {
      it(`${label}: a case variant that is not in the index is untracked`, () => {
        const dir = spellingRepo({ "core.ignorecase": setting });
        write(dir, "Bar.md", "hi\n");
        git(dir, "add", "Bar.md");
        commitAll(dir);
        write(dir, "bar.md.new", "hi\n");
        respell(dir, "bar.md.new", "Baz.md");
        const r = patch({ cwd: dir, edits: [hi("Baz.md")], dryRun: true });
        expect(g(r).targets?.[0]).toMatchObject({
          status: "allowed_untracked",
          tracking: "untracked",
        });
        // The same name as the index carries is tracked either way.
        const tracked = patch({ cwd: dir, edits: [hi("Bar.md")] });
        expectTrackedRefusal(dir, tracked, "Bar.md");
      });
    }
  });

  describe("Unicode form", () => {
    const NFC = "café.md";
    const NFD = "café.md";

    function nfdRepo(): string {
      const dir = spellingRepo({
        "core.ignorecase": "false",
        "core.precomposeunicode": "false",
      });
      write(dir, NFC, "hi\n");
      git(dir, "add", "-A");
      commitAll(dir);
      respell(dir, NFC, NFD);
      return dir;
    }

    it("refuses an NFD on-disk name of an NFC index entry", () => {
      const dir = nfdRepo();
      expect(fs.readdirSync(dir)).toContain(NFD);
      expectTrackedRefusal(dir, patch({ cwd: dir, edits: [hi(NFD)] }), NFD);
    });

    it("refuses an NFD directory component of an NFC index entry", () => {
      const dir = spellingRepo({
        "core.ignorecase": "false",
        "core.precomposeunicode": "false",
      });
      write(dir, "déjà/a.md", "hi\n");
      git(dir, "add", "-A");
      commitAll(dir);
      respell(dir, "déjà", "déjà");
      expectTrackedRefusal(
        dir,
        patch({ cwd: dir, edits: [hi("déjà/a.md")] }),
        "déjà/a.md",
      );
    });

    it("refuses an NFC on-disk name of an NFD index entry", () => {
      const dir = spellingRepo({
        "core.ignorecase": "false",
        "core.precomposeunicode": "false",
      });
      write(dir, NFD, "hi\n");
      git(dir, "add", "-A");
      commitAll(dir);
      respell(dir, NFD, NFC);
      expectTrackedRefusal(dir, patch({ cwd: dir, edits: [hi(NFC)] }), NFC);
    });

    it("allows an untracked file with a combining character that no entry has", () => {
      const dir = nfdRepo();
      write(dir, "naïve.md", "hi\n");
      const r = patch({ cwd: dir, edits: [hi("naïve.md")], dryRun: true });
      expect(g(r).targets?.[0].tracking).toBe("untracked");
    });
  });
});

describe("patch branch guard: git's pathspec switches in the environment", () => {
  for (const name of [
    "GIT_ICASE_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_LITERAL_PATHSPECS",
  ]) {
    it(`${name}=1 does not break the classification of an untracked target`, async () => {
      const dir = mixedRepo();
      const res = await spawnCli(
        [
          "--json",
          "-C",
          dir,
          "patch",
          "--file",
          "run/notes.md",
          "--old",
          "n",
          "--new",
          "N",
        ],
        {
          env: {
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            [name]: "1",
          },
        },
      );
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout) as {
        status: string;
        warnings: string[];
        branch_guard: { repos: { targets: { status: string }[] }[] };
      };
      expect(out.status).toBe("written");
      expect(out.branch_guard.repos[0].targets[0].status).toBe(
        "allowed_untracked",
      );
      expect(out.warnings).toEqual([]);
    });
  }
});

describe("patch branch guard: the overall status of a plan", () => {
  const entry = (status: RepoGuard["status"]): RepoGuard => ({
    status,
    protected: [],
    sources: [],
  });
  const overall = (...statuses: RepoGuard["status"][]): string =>
    combineGuards(statuses.map(entry)).status;

  it("takes the most severe status of the repositories", () => {
    expect(overall("allowed", "allowed_ignored")).toBe("allowed_ignored");
    expect(overall("allowed_ignored", "allowed_untracked")).toBe(
      "allowed_untracked",
    );
    expect(overall("allowed_untracked", "allowed_ignored")).toBe(
      "allowed_untracked",
    );
    expect(overall("allowed_untracked", "allowed")).toBe("allowed_untracked");
    expect(overall("not_a_repo", "allowed_ignored")).toBe("allowed_ignored");
    expect(overall("detached", "allowed_untracked")).toBe("detached");
    expect(overall("allowed_untracked", "allowed_protected")).toBe(
      "allowed_protected",
    );
    expect(overall("allowed_protected", "would_refuse")).toBe("would_refuse");
    expect(overall("would_refuse", "refused")).toBe("refused");
    expect(overall("allowed_untracked", "refused")).toBe("refused");
  });

  it("is not_a_repo for no repository at all", () => {
    expect(combineGuards([])).toEqual({ status: "not_a_repo", repos: [] });
  });

  it("a plan over two repositories: one untracked on main, one on a task branch", () => {
    const main = mixedRepo();
    const task = repoOn("task");
    const r = patch({
      cwd: main,
      allowOutside: true,
      edits: [NOTES, { file: path.join(task, "a.txt"), old: "a", new: "b" }],
    });
    expect(r.status).toBe("written");
    expect(r.branchGuard.repos.map((x) => x.status)).toEqual([
      "allowed_untracked",
      "allowed",
    ]);
    expect(r.branchGuard.status).toBe("allowed_untracked");
  });
});

describe("patch branch guard: layouts", () => {
  it("judges the repository root when -C is a subdirectory of a repository on main", () => {
    const dir = repoOn("main");
    fs.mkdirSync(path.join(dir, "deep", "er"), { recursive: true });
    fs.writeFileSync(path.join(dir, "deep", "er", "x.txt"), "x\n");
    git(dir, "add", "deep/er/x.txt");
    const r = patch({
      cwd: path.join(dir, "deep", "er"),
      edits: [{ file: "x.txt", old: "x", new: "y" }],
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(g(r).branch).toBe("main");
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
    expect(g(r).branch).toBe("main");
  });

  it("follows a .git file naming a separate git directory", () => {
    const base = tmpDir();
    const wt = path.join(base, "wt");
    fs.mkdirSync(wt);
    git(wt, "init", "-q", "--separate-git-dir", path.join(base, "gd"), ".");
    git(wt, "symbolic-ref", "HEAD", "refs/heads/main");
    fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
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
    expect(g(r).branch).toBe("task/wt");
    expect(a(wt)).toBe("b\n");
  });

  it("refuses a linked worktree that sits on main even when the main checkout is on a task branch", () => {
    const main = repoOn("task/main-checkout");
    commitAll(main);
    const wt = path.join(tmpDir(), "wt");
    git(main, "worktree", "add", "-q", "-b", "main", wt);
    const r = patch({ cwd: wt, edits: EDIT });
    expectRefused(wt, r);
    expect(g(r).branch).toBe("main");
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
      repos: [{ status: "not_a_repo", protected: [], sources: [] }],
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
    git(outer, "add", "inner/a.txt");
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
    git(dir, "add", "a.txt");
    expectRefused(dir, patch({ cwd: dir, edits: EDIT }));
  });

  it("fails closed where git would read a commondir without bound (no git is run)", () => {
    const dir = repoOn("task");
    const file = path.join(dir, ".git", "commondir");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 128 * 1024);
    const r = patch({ cwd: dir, edits: EDIT });
    expectRefused(dir, r, "protected_branch_unresolved");
    expect(r.edits[0].detail).toContain("git was not run");
  });
});

describe("patch branch guard: every repository that holds a target", () => {
  /** A directory that is no repository, holding the named repositories. */
  function workspace(repos: Record<string, string>): {
    base: string;
    dirs: Record<string, string>;
  } {
    const base = tmpDir();
    const dirs: Record<string, string> = {};
    for (const [name, branch] of Object.entries(repos)) {
      dirs[name] = repoOn(branch, path.join(base, name));
    }
    return { base, dirs };
  }

  const inRepo = (name: string) => ({
    file: `${name}/a.txt`,
    old: "a",
    new: "b",
  });

  it("refuses a checkout on master reached from a directory that is no repository", () => {
    const { base, dirs } = workspace({ proj: "master" });
    const r = patch({ cwd: base, edits: [inRepo("proj")] });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(r.edits[0].status).toBe("refused");
    expect(r.edits[0].detail).toContain(dirs.proj);
    expect(r.branchGuard.repos).toHaveLength(1);
    expect(r.branchGuard.repos[0]).toMatchObject({
      root: dirs.proj,
      status: "refused",
      branch: "master",
    });
    expect(a(dirs.proj)).toBe("a\n");
  });

  it("writes a checkout on a task branch reached from a directory that is no repository", () => {
    const { base, dirs } = workspace({ proj: "task/x" });
    const r = patch({ cwd: base, edits: [inRepo("proj")] });
    expect(r.status).toBe("written");
    expect(r.branchGuard.repos.map((x) => x.root)).toEqual([dirs.proj]);
    expect(a(dirs.proj)).toBe("b\n");
  });

  it("refuses an --allow-outside target in a second repository on master, from a repository on a task branch", () => {
    const { base, dirs } = workspace({ task: "task/a", other: "master" });
    const r = patch({
      cwd: dirs.task,
      edits: [{ file: "../other/a.txt", old: "a", new: "b" }],
      allowOutside: true,
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(a(dirs.other)).toBe("a\n");
    expect(r.branchGuard.repos.map((x) => [x.root, x.status])).toEqual([
      [dirs.task, "allowed"],
      [dirs.other, "refused"],
    ]);
    void base;
  });

  it("writes an --allow-outside target in a second repository on a feature branch", () => {
    const { dirs } = workspace({ task: "task/a", other: "task/b" });
    const r = patch({
      cwd: dirs.task,
      edits: [{ file: "../other/a.txt", old: "a", new: "b" }],
      allowOutside: true,
    });
    expect(r.status).toBe("written");
    expect(a(dirs.other)).toBe("b\n");
    expect(r.branchGuard.repos).toHaveLength(2);
  });

  it("judges the repository at -C even when no target lies in it", () => {
    const { dirs } = workspace({ main: "main", other: "task/b" });
    const r = patch({
      cwd: dirs.main,
      edits: [{ file: "../other/a.txt", old: "a", new: "b" }],
      allowOutside: true,
    });
    expect(r.status).toBe("usage_error");
    expect(a(dirs.other)).toBe("a\n");
    expect(r.branchGuard.repos[0]).toMatchObject({
      root: dirs.main,
      status: "refused",
    });
  });

  it("refuses a submodule on master under a superproject on a task branch", () => {
    const { base, src } = (() => {
      const b = tmpDir();
      const s0 = repoOn("master", path.join(b, "src"));
      commitAll(s0);
      return { base: b, src: s0 };
    })();
    const sup = repoOn("task/super", path.join(base, "super"));
    fs.writeFileSync(path.join(sup, "s.txt"), "s\n");
    commitAll(sup);
    git(
      sup,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      src,
      "sub",
    );
    const sub = path.join(sup, "sub");
    expect(git(sub, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/master");
    const r = patch({
      cwd: sup,
      edits: [
        inRepo("sub").file === ""
          ? EDIT[0]
          : { file: "sub/a.txt", old: "a", new: "b" },
      ],
    });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch");
    expect(r.branchGuard.repos.map((x) => [x.root, x.status])).toEqual([
      [sup, "allowed"],
      [fs.realpathSync(sub), "refused"],
    ]);
    expect(a(sub)).toBe("a\n");
    // A file of the superproject itself is still fine.
    const own = patch({
      cwd: sup,
      edits: [{ file: "s.txt", old: "s", new: "t" }],
    });
    expect(own.status).toBe("written");
  });

  it("refuses a plan of two repositories when one is protected, and writes neither", () => {
    const { base, dirs } = workspace({ one: "task/one", two: "main" });
    for (const order of [
      [inRepo("one"), inRepo("two")],
      [inRepo("two"), inRepo("one")],
    ]) {
      const r = patch({ cwd: base, edits: order });
      expect(r.status).toBe("usage_error");
      expect(r.reason).toBe("protected_branch");
      expect(r.edits.map((e) => e.status)).toEqual(["refused", "refused"]);
      expect(r.writtenFiles).toEqual([]);
      expect(a(dirs.one)).toBe("a\n");
      expect(a(dirs.two)).toBe("a\n");
      const clean = order.find((e) => e.file.startsWith("one"));
      const i = order.indexOf(clean as (typeof order)[number]);
      expect(r.edits[i].detail).toContain("refused as a whole");
      expect(r.edits[1 - i].detail).toContain(dirs.two);
    }
  });

  it("names each repository's own root on its own edits when several refuse", () => {
    const { base, dirs } = workspace({ one: "main", two: "master" });
    const r = patch({ cwd: base, edits: [inRepo("one"), inRepo("two")] });
    expect(r.status).toBe("usage_error");
    expect(r.edits[0].detail).toContain(dirs.one);
    expect(r.edits[0].detail).not.toContain(dirs.two);
    expect(r.edits[1].detail).toContain(dirs.two);
    expect(r.edits[1].detail).not.toContain(dirs.one);
    expect(
      r.warnings.filter((w) => w.startsWith("branch guard: refused in")),
    ).toEqual([
      "branch guard: refused in 2 repositories (protected_branch); pass --allow-protected to edit anyway",
    ]);
    expect(r.branchGuard.repos.map((x) => x.status)).toEqual([
      "refused",
      "refused",
    ]);
    expect(a(dirs.one)).toBe("a\n");
    expect(a(dirs.two)).toBe("a\n");
  });

  it("writes a plan of two unprotected repositories and lists both", () => {
    const { base, dirs } = workspace({ one: "task/one", two: "task/two" });
    const r = patch({ cwd: base, edits: [inRepo("one"), inRepo("two")] });
    expect(r.status).toBe("written");
    expect(r.branchGuard.status).toBe("allowed");
    expect(r.branchGuard.repos.map((x) => [x.root, x.branch])).toEqual([
      [dirs.one, "task/one"],
      [dirs.two, "task/two"],
    ]);
    expect(a(dirs.one)).toBe("b\n");
    expect(a(dirs.two)).toBe("b\n");
  });

  it("lists a repository once however many targets lie in it", () => {
    const { base, dirs } = workspace({ one: "task/one" });
    fs.writeFileSync(path.join(dirs.one, "b.txt"), "b\n");
    const r = patch({
      cwd: base,
      edits: [inRepo("one"), { file: "one/b.txt", old: "b", new: "c" }],
    });
    expect(r.status).toBe("written");
    expect(r.branchGuard.repos).toHaveLength(1);
  });

  it("--allow-protected lifts every refusing repository and lists them all", () => {
    const { base, dirs } = workspace({
      one: "main",
      two: "master",
      three: "task/three",
    });
    const r = patch({
      cwd: base,
      edits: [inRepo("one"), inRepo("two"), inRepo("three")],
      allowProtected: true,
    });
    expect(r.status).toBe("written");
    expect(r.allowedProtected).toBe(true);
    expect(r.branchGuard.status).toBe("allowed_protected");
    expect(r.branchGuard.repos.map((x) => [x.root, x.status])).toEqual([
      [dirs.one, "allowed_protected"],
      [dirs.two, "allowed_protected"],
      [dirs.three, "allowed"],
    ]);
    const lifted = r.warnings.filter((w) => w.includes("--allow-protected"));
    expect(lifted).toHaveLength(1);
    expect(lifted[0]).toContain("2 repositories");
    expect(a(dirs.one)).toBe("b\n");
    expect(a(dirs.two)).toBe("b\n");
  });

  it("reports would_refuse for the protected one of two repositories in a dry run", () => {
    const { base, dirs } = workspace({ one: "task/one", two: "main" });
    const r = patch({
      cwd: base,
      edits: [inRepo("one"), inRepo("two")],
      dryRun: true,
    });
    expect(r.status).toBe("would_write");
    expect(r.branchGuard.status).toBe("would_refuse");
    expect(r.branchGuard.repos.map((x) => x.status)).toEqual([
      "allowed",
      "would_refuse",
    ]);
    expect(a(dirs.two)).toBe("a\n");
  });

  it("a repository that cannot be resolved refuses the plan and names its root", () => {
    const { base, dirs } = workspace({ one: "task/one", two: "task/two" });
    const file = path.join(dirs.two, ".git", "commondir");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 128 * 1024);
    const r = patch({ cwd: base, edits: [inRepo("one"), inRepo("two")] });
    expect(r.status).toBe("usage_error");
    expect(r.reason).toBe("protected_branch_unresolved");
    expect(r.edits[1].detail).toContain(dirs.two);
    expect(a(dirs.one)).toBe("a\n");
  });

  it("lists a target in no repository as not_a_repo beside the judged repository", () => {
    const { base, dirs } = workspace({ one: "task/one" });
    fs.mkdirSync(path.join(base, "plain"));
    fs.writeFileSync(path.join(base, "plain", "x.txt"), "x\n");
    const r = patch({
      cwd: base,
      edits: [{ file: "plain/x.txt", old: "x", new: "y" }, inRepo("one")],
    });
    expect(r.status).toBe("written");
    expect(r.branchGuard.status).toBe("allowed");
    // The repository entries first, the entry for the targets in none last.
    expect(r.branchGuard.repos).toEqual([
      {
        root: dirs.one,
        status: "allowed",
        branch: "task/one",
        protected: ["main", "master"],
        sources: ["builtin"],
      },
      { status: "not_a_repo", protected: [], sources: [] },
    ]);
  });

  it("a not_a_repo target does not lift the refusal of a repository beside it", () => {
    const { base, dirs } = workspace({ one: "main" });
    fs.mkdirSync(path.join(base, "plain"));
    fs.writeFileSync(path.join(base, "plain", "x.txt"), "x\n");
    const r = patch({
      cwd: base,
      edits: [{ file: "plain/x.txt", old: "x", new: "y" }, inRepo("one")],
    });
    expect(r.status).toBe("usage_error");
    expect(fs.readFileSync(path.join(base, "plain", "x.txt"), "utf8")).toBe(
      "x\n",
    );
    expect(a(dirs.one)).toBe("a\n");
  });

  it("judges the repository a symlink leads into, not the one the link lies in", () => {
    const { dirs } = workspace({ task: "task/a", other: "main" });
    fs.symlinkSync(
      path.join(dirs.other, "a.txt"),
      path.join(dirs.task, "via.txt"),
    );
    const r = patch({
      cwd: dirs.task,
      edits: [{ file: "via.txt", old: "a", new: "b" }],
      allowOutside: true,
    });
    expect(r.status).toBe("usage_error");
    expect(a(dirs.other)).toBe("a\n");
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
    expect(g(r).branch).toBe("main");
  });

  it("a GIT_DIR naming a repository on main does not block a feature branch", () => {
    const task = repoOn("task");
    const other = repoOn("main", tmpDir());
    const r = withEnv({ GIT_DIR: path.join(other, ".git") }, () =>
      patch({ cwd: task, edits: EDIT }),
    );
    expect(r.status).toBe("written");
    expect(g(r).branch).toBe("task");
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
    expect(g(r).sources).toContain("origin-head");
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
  message?: string;
  allowed_protected?: boolean;
  counts?: { files_written: number; refused: number };
  written_files?: string[];
  truncated?: boolean;
  branch_guard: {
    status: string;
    reason?: string;
    repos: {
      root?: string;
      status: string;
      branch?: string;
      protected: string[];
      sources: string[];
      reason?: string;
      targets: {
        path: string;
        status: string;
        tracking: string;
        reason?: string;
      }[];
    }[];
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
      reason: "protected_branch",
      repos: [
        {
          root: dir,
          status: "refused",
          branch: "main",
          protected: ["main", "master"],
          sources: ["builtin"],
          reason: "protected_branch",
          targets: [
            {
              path: "a.txt",
              status: "refused",
              tracking: "tracked",
              reason: "protected_branch",
            },
          ],
        },
      ],
    });
    expect(r.out.message).toContain("--allow-protected");
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
    expect(r.out.branch_guard.repos[0].protected).toEqual([
      "hotfix",
      "release",
      "main",
      "master",
    ]);
    expect(r.out.branch_guard.repos[0].sources).toEqual(["flag", "builtin"]);
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
    expect(r.out.branch_guard.repos[0].branch).toBe("HEAD");
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

  describe("under a tight -m budget", () => {
    /** A 12-file plan in a repository on main, run with `-m <budget>`. */
    async function tight(
      budget: string,
      ...flags: string[]
    ): Promise<GuardJson> {
      const dir = repoOn("main");
      const edits = Array.from({ length: 12 }, (_, n) => ({
        file: `f${String(n)}.txt`,
        old: "a",
        new: "b",
      }));
      for (const e of edits) fs.writeFileSync(path.join(dir, e.file), "a\n");
      fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ edits }));
      git(dir, "add", "-A");
      const res = await spawnCli(
        [
          "--json",
          "-m",
          budget,
          "-C",
          dir,
          "patch",
          "--plan",
          "plan.json",
          ...flags,
        ],
        { env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
      );
      return JSON.parse(res.stdout) as GuardJson;
    }

    it("keeps written_files, counts and allowed_protected when --allow-protected wrote", async () => {
      const out = await tight("1300", "--allow-protected");
      // The edits and files were cut down; the audit fields were not.
      expect(out.truncated).toBe(true);
      expect(out.written_files).toHaveLength(12);
      expect(out.counts?.files_written).toBe(12);
      expect(out.allowed_protected).toBe(true);
    });

    it("keeps reason, counts and written_files of a refusal", async () => {
      const out = await tight("1300");
      expect(out.truncated).toBe(true);
      expect(out.status).toBe("usage_error");
      expect(out.reason).toBe("protected_branch");
      expect(out.counts?.refused).toBe(12);
      expect(out.counts?.files_written).toBe(0);
      expect(out.written_files).toEqual([]);
    });

    // The warnings are fixed fields: `-m` never cuts them, so the outcome
    // is named even where nothing else of the guard is left.
    for (const budget of ["1000", "1200"]) {
      it(`names a refusal in a warning at -m ${budget}`, async () => {
        const out = await tight(budget);
        expect(out.status).toBe("usage_error");
        const named = out.warnings.filter((w) =>
          w.startsWith("branch guard: refused in"),
        );
        expect(named).toEqual([
          "branch guard: refused in 1 repository (protected_branch); pass --allow-protected to edit anyway",
        ]);
      });

      it(`names an override in a warning at -m ${budget}`, async () => {
        const out = await tight(budget, "--allow-protected");
        expect(out.status).toBe("written");
        expect(
          out.warnings.some((w) => w.startsWith("--allow-protected:")),
        ).toBe(true);
      });
    }
  });

  it("carries no free text in branch_guard", async () => {
    const dir = repoOn("main");
    const r = await cli(dir, "--allow-protected");
    expect(Object.keys(r.out.branch_guard.repos[0]).sort()).toEqual([
      "branch",
      "protected",
      "reason",
      "root",
      "sources",
      "status",
      "targets",
    ]);
    expect(Object.keys(r.out.branch_guard.repos[0].targets[0]).sort()).toEqual([
      "path",
      "reason",
      "status",
      "tracking",
    ]);
    expect(Object.keys(r.out.branch_guard).sort()).toEqual([
      "reason",
      "repos",
      "status",
    ]);
  });

  it("writes outside any repository", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const r = await cli(dir);
    expect(r.code).toBe(0);
    expect(r.out.branch_guard.status).toBe("not_a_repo");
  });

  it("lists one entry per repository that holds a target", async () => {
    const base = tmpDir();
    const one = repoOn("task/one", path.join(base, "one"));
    const two = repoOn("task/two", path.join(base, "two"));
    fs.writeFileSync(
      path.join(base, "plan.json"),
      JSON.stringify({
        edits: [
          { file: "one/a.txt", old: "a", new: "b" },
          { file: "two/a.txt", old: "a", new: "b" },
        ],
      }),
    );
    const run2 = await spawnCli(
      ["--json", "-C", base, "patch", "--plan", "plan.json"],
      { env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
    );
    const out = JSON.parse(run2.stdout) as GuardJson;
    expect(run2.code).toBe(0);
    expect(out.branch_guard.repos.map((r) => r.root)).toEqual([one, two]);
    expect(out.branch_guard.repos.map((r) => r.branch)).toEqual([
      "task/one",
      "task/two",
    ]);
  });
});
