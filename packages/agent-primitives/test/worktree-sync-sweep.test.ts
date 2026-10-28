import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_RULE_MAX_COMMITS,
  contentInBase,
  contentRule,
} from "../src/worktree/git.js";
import { FIXED_BIN_DIR, spawnCli } from "./helpers/spawn-cli.js";

/**
 * `worktree remove --sync-main`, `worktree sweep` and the content rule of the
 * merged verdict. Hermetic like the other worktree suites: no global or
 * system git config, an identity from the environment, and a local bare
 * repository as `origin`. A merge on the "server" is made by a second clone
 * pushing a squash commit, so the fixture's main checkout is behind origin
 * exactly as it is after a real pull request merge.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

vi.setConfig({ testTimeout: 60_000 });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...GIT_ENV },
  });
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

interface Fixture {
  base: string;
  origin: string;
  /** The main checkout, on `main`. */
  repo: string;
  /** A second clone that plays the server side of a merge. */
  other: string;
  /** The directory the sweep tests use as --root. */
  root: string;
  /** An unrelated directory to run the CLI from. */
  work: string;
}

function makeFixture(): Fixture {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-sweep-")),
  );
  tmpDirs.push(base);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const other = path.join(base, "other");
  const root = path.join(base, "root");
  const work = path.join(base, "work");
  fs.mkdirSync(root);
  fs.mkdirSync(work);
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(base, ["init", "-q", "-b", "main", repo]);
  write(repo, "a.txt", "one\n");
  write(repo, "shared.txt", "base\n");
  write(repo, ".gitignore", "*.log\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
  git(base, ["clone", "-q", origin, other]);
  return { base, origin, repo, other, root, work };
}

function addWorktree(f: Fixture, branch: string, dir: string): string {
  git(f.repo, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    branch,
    dir,
    "origin/main",
  ]);
  return dir;
}

function commitHere(dir: string, file: string, message: string): void {
  write(dir, file, `${message}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

/** A feature branch in a worktree below `f.root`, with two commits, pushed. */
function featureWorktree(f: Fixture, branch: string): string {
  const dir = addWorktree(f, branch, path.join(f.root, branch));
  commitHere(dir, `${branch}-1.txt`, `${branch} one`);
  commitHere(dir, `${branch}-2.txt`, `${branch} two`);
  git(dir, ["push", "-q", "origin", branch]);
  return dir;
}

/**
 * What GitHub does on a squash merge, done by the second clone: one new
 * commit on `main` with the branch's combined change, then the remote
 * branch is deleted. The fixture's main checkout is left behind, and its
 * remote-tracking refs are stale until something fetches.
 */
function squashMergeOnServer(f: Fixture, branch: string): void {
  git(f.other, ["pull", "-q", "--ff-only", "origin", "main"]);
  git(f.other, ["fetch", "-q", "origin", branch]);
  git(f.other, ["merge", "--squash", `origin/${branch}`]);
  git(f.other, ["commit", "-q", "-m", `squash ${branch}`]);
  git(f.other, ["push", "-q", "origin", "main"]);
  git(f.other, ["push", "-q", "origin", "--delete", branch]);
}

/** A commit on `main` made on the server side that touches `file` only. */
function serverCommit(f: Fixture, file: string, content: string): void {
  git(f.other, ["pull", "-q", "--ff-only", "origin", "main"]);
  write(f.other, file, content);
  git(f.other, ["add", "-A"]);
  git(f.other, ["commit", "-q", "-m", `server ${file}`]);
  git(f.other, ["push", "-q", "origin", "main"]);
}

function fetchPrune(f: Fixture): void {
  git(f.repo, ["fetch", "-q", "--prune", "origin"]);
}

function branchExists(f: Fixture, name: string): boolean {
  return gitOk(f.repo, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${name}`,
  ]);
}

function head(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

interface Cli {
  code: number | null;
  json: Record<string, any>;
  stdout: string;
  stderr: string;
}

async function cli(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Cli> {
  const r = await spawnCli(["-C", cwd, "worktree", ...args], {
    env: { ...GIT_ENV, ...extraEnv },
  });
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(r.stdout.trim()) as Record<string, any>;
  } catch {
    json = {};
  }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
}

function entryFor(r: Cli, dir: string): Record<string, any> {
  const found = (r.json.entries as Record<string, any>[]).find(
    (e) => e.path === dir,
  );
  expect(found, `no entry for ${dir} in ${r.stdout}`).toBeDefined();
  return found as Record<string, any>;
}

describe("worktree remove --sync-main", () => {
  it("fetches with --prune and fast-forwards a clean main checkout on the default branch", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(r.json.sync.status).toBe("fast_forwarded");
    expect(r.json.sync.fetch).toBe("fetched");
    expect(r.json.sync.branch).toBe("main");
    expect(r.json.sync.from).toBe(before);
    const originMain = git(f.origin, ["rev-parse", "main"]).trim();
    expect(head(f.repo)).toBe(originMain);
    expect(r.json.sync.to).toBe(originMain);
    expect(fs.existsSync(path.join(f.repo, "feat-1.txt"))).toBe(true);
    // --prune: the deleted remote branch is gone from the tracking refs.
    expect(
      gitOk(f.repo, [
        "show-ref",
        "--verify",
        "--quiet",
        "refs/remotes/origin/feat",
      ]),
    ).toBe(false);
  });

  it("reports up_to_date when the main checkout already is at origin", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("up_to_date");
  });

  it("does not touch the main checkout or the remote refs without --sync-main", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    const before = head(f.repo);
    const refsBefore = git(f.repo, ["show-ref"]);

    const r = await cli(f.work, ["remove", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect("sync" in r.json).toBe(false);
    expect(head(f.repo)).toBe(before);
    expect(git(f.repo, ["show-ref"])).toBe(refsBefore);
  });

  const dirtyKinds: [string, (repo: string) => void][] = [
    ["an unstaged change", (repo) => write(repo, "a.txt", "edited\n")],
    [
      "a staged change",
      (repo) => {
        write(repo, "a.txt", "staged\n");
        git(repo, ["add", "a.txt"]);
      },
    ],
    ["an untracked file", (repo) => write(repo, "new.txt", "new\n")],
  ];
  it.each(dirtyKinds)(
    "skips a main checkout with %s, with the reason, and changes nothing",
    async (_label, makeDirty) => {
      const f = makeFixture();
      const wt = featureWorktree(f, "feat");
      squashMergeOnServer(f, "feat");
      makeDirty(f.repo);
      const before = head(f.repo);
      const statusBefore = git(f.repo, ["status", "--porcelain"]);

      const r = await cli(f.work, ["remove", wt, "--sync-main", "--force"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(fs.existsSync(wt)).toBe(false);
      expect(r.json.sync.status).toBe("skipped");
      expect(r.json.sync.reason).toContain("staged, unstaged or untracked");
      expect(head(f.repo)).toBe(before);
      expect(git(f.repo, ["status", "--porcelain"])).toBe(statusBefore);
    },
  );

  it("skips a main checkout that is on another branch and leaves it there", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    git(f.repo, ["checkout", "-q", "-b", "scratch"]);
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main", "--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("skipped");
    expect(r.json.sync.reason).toContain("scratch");
    expect(r.json.sync.reason).toContain("not on the default branch");
    expect(git(f.repo, ["branch", "--show-current"]).trim()).toBe("scratch");
    expect(head(f.repo)).toBe(before);
  });

  it("skips a detached main checkout", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    git(f.repo, ["checkout", "-q", "--detach"]);
    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("skipped");
    expect(r.json.sync.reason).toContain("detached HEAD");
  });

  it("skips a main checkout that is ahead of origin and does not move it", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    commitHere(f.repo, "local.txt", "local only");
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("skipped");
    expect(r.json.sync.ahead).toBe(1);
    expect(r.json.sync.behind).toBe(0);
    expect(r.json.sync.reason).toContain("ahead of");
    expect(head(f.repo)).toBe(before);
  });

  it("reports a diverged main checkout as not fast-forwardable and never forces it", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    commitHere(f.repo, "local.txt", "local only");
    serverCommit(f, "remote.txt", "remote\n");
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("skipped");
    expect(r.json.sync.ahead).toBe(1);
    expect(r.json.sync.behind).toBe(1);
    expect(r.json.sync.reason).toContain("diverged");
    expect(head(f.repo)).toBe(before);
    expect(fs.existsSync(path.join(f.repo, "remote.txt"))).toBe(false);
  });

  it("skips rather than overwrite an ignored file the fast-forward would add", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    write(f.repo, "build.log", "precious local log\n");
    git(f.other, ["pull", "-q", "--ff-only", "origin", "main"]);
    write(f.other, "build.log", "tracked upstream\n");
    git(f.other, ["add", "-f", "build.log"]);
    git(f.other, ["commit", "-q", "-m", "track a log"]);
    git(f.other, ["push", "-q", "origin", "main"]);
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("skipped");
    expect(r.json.sync.reason).toContain("build.log");
    expect(head(f.repo)).toBe(before);
    expect(fs.readFileSync(path.join(f.repo, "build.log"), "utf8")).toBe(
      "precious local log\n",
    );
  });

  it("reports a failed fetch as a warning and keeps the removal", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    git(f.repo, ["remote", "set-url", "origin", path.join(f.base, "gone.git")]);
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(r.json.sync.status).toBe("failed");
    expect(r.json.sync.fetch).toBe("failed");
    expect(r.json.sync.reason).toContain("git fetch --prune origin failed");
    expect(
      (r.json.warnings as string[]).some((w) => w.includes("--sync-main")),
    ).toBe(true);
    expect(head(f.repo)).toBe(before);
  });

  it("skips the sync for a repository without an origin remote", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    // Detach the branch's remote-tracking base first, then drop the remote.
    git(f.repo, ["remote", "remove", "origin"]);
    const r = await cli(f.work, ["remove", wt, "--sync-main", "--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("skipped");
    expect(r.json.sync.fetch).toBe("skipped");
    expect(r.json.sync.reason).toContain("no origin remote");
  });

  it("does not fetch or move anything when the removal itself is refused", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    write(wt, "dirty.txt", "x\n");
    const before = head(f.repo);
    const trackingBefore = git(f.repo, [
      "rev-parse",
      "refs/remotes/origin/main",
    ]);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("worktree_dirty");
    expect("sync" in r.json).toBe(false);
    expect(head(f.repo)).toBe(before);
    expect(git(f.repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(
      trackingBefore,
    );
    expect(fs.existsSync(wt)).toBe(true);
  });
});

describe("the content rule of the merged verdict", () => {
  it("calls a multi-commit squash merge merged when the base moved on elsewhere, without gh", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    serverCommit(f, "elsewhere.txt", "before the squash\n");
    squashMergeOnServer(f, "feat");
    serverCommit(f, "later.txt", "after the squash\n");
    fetchPrune(f);

    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toContain(
      "2 path(s)",
    );
    const listed = await cli(f.work, ["list", "--repo", f.repo]);
    const entry = (listed.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === wt,
    );
    expect(entry?.merged).toMatchObject({ merged: "yes", via: "content" });
  });

  it("does not call a branch merged that gained a commit after the squash", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    commitHere(wt, "after.txt", "work after the squash");

    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toBe(
      undefined,
    );
    const listed = await cli(f.work, ["list", "--repo", f.repo]);
    const entry = (listed.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === wt,
    );
    // No gh in the CLI's PATH: not merged by content, so unknown.
    expect(entry?.merged.merged).toBe("unknown");
    const refused = await cli(f.work, ["remove", wt, "--require-merged"]);
    expect(refused.code).toBe(2);
    expect(refused.json.reason).toBe("merge_state_unknown");
  });

  it("does not call a branch merged when the base changed the same file again", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    serverCommit(f, "feat-1.txt", "rewritten on main\n");
    fetchPrune(f);
    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toBe(
      undefined,
    );
  });

  it("counts a rename as a change of both paths", () => {
    const f = makeFixture();
    const wt = addWorktree(f, "mv", path.join(f.root, "mv"));
    git(wt, ["mv", "a.txt", "renamed.txt"]);
    git(wt, ["commit", "-q", "-am", "rename a"]);
    // The base got the new file but kept the old one: the branch deleted
    // a.txt, so its work is not all in the base.
    git(f.other, ["pull", "-q", "--ff-only", "origin", "main"]);
    write(f.other, "renamed.txt", "one\n");
    git(f.other, ["add", "-A"]);
    git(f.other, ["commit", "-q", "-m", "copy a"]);
    git(f.other, ["push", "-q", "origin", "main"]);
    fetchPrune(f);
    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toBe(
      undefined,
    );
    // The base that also dropped the old path has all of it.
    git(f.other, ["rm", "-q", "a.txt"]);
    git(f.other, ["commit", "-q", "-m", "drop a"]);
    git(f.other, ["push", "-q", "origin", "main"]);
    fetchPrune(f);
    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toContain(
      "2 path(s)",
    );
  });

  it("does not decide a branch that changed nothing since it forked", () => {
    const f = makeFixture();
    const wt = addWorktree(f, "empty", path.join(f.root, "empty"));
    git(wt, ["commit", "-q", "--allow-empty", "-m", "nothing"]);
    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toBe(
      undefined,
    );
  });

  it("does not call a branch with unmerged work merged", () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    serverCommit(f, "elsewhere.txt", "unrelated\n");
    fetchPrune(f);
    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toBe(
      undefined,
    );
  });

  it("does not ask gh when the content rule decides", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const bin = path.join(f.base, "ghbin");
    fs.mkdirSync(bin);
    const log = path.join(f.base, "gh.log");
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\necho "$@" >> '${log}'\necho '[]'\n`,
      { mode: 0o755 },
    );
    const r = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: `${bin}${path.delimiter}${FIXED_BIN_DIR}`,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "content" });
    expect(fs.existsSync(log)).toBe(false);
  });

  it("lets remove --require-merged --delete-branch take a squash-merged branch whose remote branch is gone", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);

    const r = await cli(f.work, [
      "remove",
      wt,
      "--require-merged",
      "--delete-branch",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
    expect(branchExists(f, "feat")).toBe(false);
    expect(
      (r.json.warnings as string[]).some((w) =>
        w.includes("not counted as unpushed"),
      ),
    ).toBe(true);
  });
});

describe("worktree sweep", () => {
  it("removes merged worktrees and their branches, lists the rest with reasons, and exits 1", async () => {
    const f = makeFixture();
    const squashed = featureWorktree(f, "squashed");
    // An ancestry merge: the branch was fast-forwarded into main. Its tip
    // is its fork point with the base now, which is what a worktree created
    // a moment ago looks like too, so a sweep leaves it.
    const ff = addWorktree(f, "ff", path.join(f.root, "ff"));
    commitHere(ff, "ff.txt", "ff work");
    git(ff, ["push", "-q", "origin", "ff"]);
    git(f.repo, ["merge", "-q", "--ff-only", "ff"]);
    git(f.repo, ["push", "-q", "origin", "main"]);
    const dirty = featureWorktree(f, "dirty");
    squashMergeOnServer(f, "squashed");
    squashMergeOnServer(f, "dirty");
    write(dirty, "scratch.txt", "x\n");
    const open = featureWorktree(f, "open");
    const unpushed = addWorktree(f, "unpushed", path.join(f.root, "unpushed"));
    commitHere(unpushed, "u.txt", "never pushed");
    const locked = featureWorktree(f, "locked");
    squashMergeOnServer(f, "locked");
    git(f.repo, ["worktree", "lock", locked]);
    fetchPrune(f);

    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.status).toBe("partial");
    expect(r.json.dryRun).toBe(false);

    expect(entryFor(r, squashed)).toMatchObject({
      action: "removed",
      branchDeleted: true,
    });
    expect(entryFor(r, ff)).toMatchObject({
      action: "skipped",
      refusal: "no_own_commits",
    });
    expect(entryFor(r, ff).merged).toMatchObject({
      merged: "yes",
      via: "ancestry",
    });
    expect(fs.existsSync(squashed)).toBe(false);
    expect(fs.existsSync(ff)).toBe(true);
    expect(branchExists(f, "squashed")).toBe(false);
    expect(branchExists(f, "ff")).toBe(true);

    expect(entryFor(r, dirty)).toMatchObject({ action: "skipped" });
    expect(entryFor(r, dirty).reason).toContain("uncommitted");
    // Held back by the sweep's own check, before any removal was tried.
    expect(entryFor(r, dirty).refusal).toBeUndefined();
    expect(entryFor(r, open).action).toBe("skipped");
    expect(entryFor(r, open).reason).toContain("not merged");
    expect(entryFor(r, open).refusal).toBeUndefined();
    expect(entryFor(r, unpushed).action).toBe("skipped");
    expect(entryFor(r, unpushed).reason).toContain("not merged");
    expect(entryFor(r, unpushed).refusal).toBeUndefined();
    expect(entryFor(r, locked).action).toBe("skipped");
    expect(entryFor(r, locked).reason).toContain("locked");
    expect(entryFor(r, locked).refusal).toBeUndefined();
    for (const kept of [dirty, open, unpushed, locked]) {
      expect(fs.existsSync(kept)).toBe(true);
    }
    for (const name of ["dirty", "open", "unpushed", "locked"]) {
      expect(branchExists(f, name)).toBe(true);
    }
    expect(r.json.summary).toEqual({
      removed: 1,
      wouldRemove: 0,
      skipped: 5,
      ignored: 0,
    });
  });

  it("exits 0 when nothing is skipped", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.summary.removed).toBe(1);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("executes nothing with --dry-run and lists what it would remove", async () => {
    const f = makeFixture();
    const merged = featureWorktree(f, "merged");
    const open = featureWorktree(f, "open");
    squashMergeOnServer(f, "merged");
    fetchPrune(f);
    const refsBefore = git(f.repo, ["show-ref"]);
    const listBefore = git(f.repo, ["worktree", "list", "--porcelain"]);

    const r = await cli(f.work, ["sweep", "--root", f.root, "--dry-run"]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.dryRun).toBe(true);
    expect(entryFor(r, merged).action).toBe("would_remove");
    expect(entryFor(r, open).action).toBe("skipped");
    expect(r.json.summary).toMatchObject({ removed: 0, wouldRemove: 1 });
    expect(fs.existsSync(merged)).toBe(true);
    expect(branchExists(f, "merged")).toBe(true);
    expect(git(f.repo, ["show-ref"])).toBe(refsBefore);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).toBe(listBefore);
  });

  it("exits 0 for a dry run that skips nothing", async () => {
    const f = makeFixture();
    featureWorktree(f, "merged");
    squashMergeOnServer(f, "merged");
    fetchPrune(f);
    const r = await cli(f.work, ["sweep", "--root", f.root, "--dry-run"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.summary.wouldRemove).toBe(1);
  });

  it("ignores a worktree outside --root", async () => {
    const f = makeFixture();
    const inside = featureWorktree(f, "inside");
    const outside = addWorktree(f, "outside", path.join(f.base, "outside"));
    commitHere(outside, "o.txt", "outside work");
    git(outside, ["push", "-q", "origin", "outside"]);
    squashMergeOnServer(f, "inside");
    squashMergeOnServer(f, "outside");
    fetchPrune(f);

    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(branchExists(f, "outside")).toBe(true);
    expect(
      (r.json.entries as Record<string, any>[]).some((e) => e.path === outside),
    ).toBe(false);
  });

  it("never removes a main checkout that sits among the children, and does not count it as skipped", async () => {
    const f = makeFixture();
    // The main checkout itself is a direct child of the swept directory.
    const r = await cli(f.work, ["sweep", "--root", f.base]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(entryFor(r, f.repo)).toMatchObject({ action: "ignored" });
    expect(entryFor(r, f.repo).reason).toContain("main checkout");
    expect(r.json.summary).toMatchObject({ removed: 0, ignored: 2 });
    expect(fs.existsSync(path.join(f.repo, ".git"))).toBe(true);
    expect(branchExists(f, "main")).toBe(true);
  });

  it("never deletes the default branch, even from a clean worktree that is merged by ancestry", async () => {
    const f = makeFixture();
    // The main checkout leaves `main`, so a linked worktree can have it.
    git(f.repo, ["checkout", "-q", "-b", "scratch"]);
    const onMain = path.join(f.root, "onmain");
    git(f.repo, ["worktree", "add", "-q", onMain, "main"]);

    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(entryFor(r, onMain)).toMatchObject({
      action: "skipped",
      refusal: "default_branch_delete",
    });
    expect(fs.existsSync(onMain)).toBe(true);
    expect(branchExists(f, "main")).toBe(true);
  });

  it("does not sweep a branch that gained unpushed commits after its squash merge", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    commitHere(wt, "extra.txt", "extra work after the squash");

    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(entryFor(r, wt).action).toBe("skipped");
    expect(fs.existsSync(path.join(wt, "extra.txt"))).toBe(true);
    expect(branchExists(f, "feat")).toBe(true);
  });

  it("skips a branch that is pushed but not merged", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(entryFor(r, wt)).toMatchObject({ action: "skipped" });
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("skips a detached worktree", async () => {
    const f = makeFixture();
    const wt = path.join(f.root, "detached");
    git(f.repo, ["worktree", "add", "-q", "--detach", wt, "origin/main"]);
    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(entryFor(r, wt).reason).toContain("detached HEAD");
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("refuses without --root and for a --root that is not a directory", async () => {
    const f = makeFixture();
    const none = await cli(f.work, ["sweep"]);
    expect(none.code).toBe(2);
    expect(none.json.reason).toBe("option_invalid");
    const missing = await cli(f.work, [
      "sweep",
      "--root",
      path.join(f.base, "no-such-dir"),
    ]);
    expect(missing.code).toBe(2);
    expect(missing.json.reason).toBe("option_invalid");
  });
});

/**
 * The guards added after an adversarial review of the commands above:
 * every case is a way a sweep, a removal or the sync could lose work, and
 * each one checks that the work is still there afterwards.
 */
describe("worktree sweep: what it must never remove", () => {
  it("does not follow a symlinked child of --root to a merged worktree outside it", async () => {
    const f = makeFixture();
    const outsideDir = path.join(f.base, "outside");
    fs.mkdirSync(outsideDir);
    const outsider = featureWorktree(f, "outsider");
    // Move the worktree out of --root and leave a link in its place.
    git(f.repo, [
      "worktree",
      "move",
      outsider,
      path.join(outsideDir, "outsider"),
    ]);
    const moved = path.join(outsideDir, "outsider");
    squashMergeOnServer(f, "outsider");
    fetchPrune(f);
    const link = path.join(f.root, "link");
    fs.symlinkSync(moved, link);

    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.status).toBe("partial");
    expect(entryFor(r, link)).toMatchObject({ action: "skipped" });
    expect(entryFor(r, link).reason).toContain("symbolic link");
    expect(fs.existsSync(path.join(moved, "outsider-1.txt"))).toBe(true);
    expect(branchExists(f, "outsider")).toBe(true);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).toContain(moved);
    // `list --root` still follows the link, as it always has.
    const listed = await cli(f.work, ["list", "--root", f.root]);
    expect(
      (listed.json.worktrees as Record<string, any>[]).map((w) => w.path),
    ).toContain(moved);
  });

  it("counts a child it cannot describe as skipped, so the status is partial", async () => {
    const f = makeFixture();
    const bare = path.join(f.base, "bare.git");
    git(f.base, ["clone", "-q", "--bare", f.origin, bare]);
    const child = path.join(f.root, "of-bare");
    git(bare, ["worktree", "add", "-q", child, "main"]);

    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.status).toBe("partial");
    expect(entryFor(r, child)).toMatchObject({ action: "skipped" });
    expect(entryFor(r, child).reason).toContain("bare repository");
    expect(r.json.summary.skipped).toBe(1);
    expect(fs.existsSync(path.join(child, "a.txt"))).toBe(true);
  });

  it("skips a worktree just created, whose branch has no commits of its own, with its ignored files", async () => {
    const f = makeFixture();
    const runDir = path.join(f.base, "run");
    fs.mkdirSync(runDir);
    // The run pointer is written only where git ignores it.
    fs.appendFileSync(
      path.join(f.repo, ".git", "info", "exclude"),
      ".ai/run\n",
    );
    const fresh = path.join(f.root, "fresh");
    const created = await spawnCli(
      [
        "-C",
        f.work,
        "worktree",
        "create",
        "--repo",
        f.repo,
        "--branch",
        "fresh",
        "--path",
        fresh,
        "--run",
        runDir,
        "--no-fetch",
      ],
      { env: GIT_ENV },
    );
    expect(created.code, created.stdout + created.stderr).toBe(0);
    // Ignored work of a task in flight.
    write(fresh, "build.log", "ignored output\n");

    for (const dryRun of [true, false]) {
      const r = await cli(f.work, [
        "sweep",
        "--root",
        f.root,
        ...(dryRun ? ["--dry-run"] : []),
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(entryFor(r, fresh)).toMatchObject({
        action: "skipped",
        refusal: "no_own_commits",
      });
      expect(entryFor(r, fresh).reason).toContain("no commits of its own");
    }
    expect(fs.readFileSync(path.join(fresh, "build.log"), "utf8")).toBe(
      "ignored output\n",
    );
    expect(fs.existsSync(path.join(fresh, ".ai", "run"))).toBe(true);
    expect(branchExists(f, "fresh")).toBe(true);
    // A plain remove keeps taking such a worktree.
    const removed = await cli(f.work, ["remove", fresh, "--delete-branch"]);
    expect(removed.code, removed.stdout + removed.stderr).toBe(0);
  });

  it("does not sweep a squash-merged branch that gained unpushed commits adding and then deleting a file", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "sq", path.join(f.root, "sq"));
    commitHere(wt, "s.txt", "s1");
    git(wt, ["push", "-q", "origin", "sq"]);
    squashMergeOnServer(f, "sq");
    fetchPrune(f);
    // After the squash, never pushed: the second commit takes the file
    // back, so the branch's net change is still all in the base.
    commitHere(wt, "notes.md", "important notes");
    git(wt, ["rm", "-q", "notes.md"]);
    git(wt, ["commit", "-q", "-m", "move the notes elsewhere"]);

    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toBe(
      undefined,
    );
    const listed = await cli(f.work, ["list", "--repo", f.repo]);
    const entry = (listed.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === wt,
    );
    expect(entry?.merged.merged).not.toBe("yes");
    expect(entry?.merged.reason).toContain("2 commit(s) after it");

    const refused = await cli(f.work, [
      "remove",
      wt,
      "--require-merged",
      "--delete-branch",
    ]);
    expect(refused.code, refused.stdout + refused.stderr).toBe(2);
    expect(refused.json.reason).toBe("merge_state_unknown");

    const r = await cli(f.work, ["sweep", "--root", f.root]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(entryFor(r, wt).action).toBe("skipped");
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists(f, "sq")).toBe(true);
    expect(git(wt, ["log", "--format=%s", "-1", "HEAD~1"]).trim()).toBe(
      "important notes",
    );
  });

  it("carries the removal's warnings into the entry and the top-level warnings, in a dry run too", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    for (const dryRun of [true, false]) {
      const r = await cli(f.work, [
        "sweep",
        "--root",
        f.root,
        ...(dryRun ? ["--dry-run"] : []),
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const entry = entryFor(r, wt);
      expect(entry.action).toBe(dryRun ? "would_remove" : "removed");
      expect(
        (entry.warnings as string[]).some((w) =>
          w.includes("not counted as unpushed"),
        ),
      ).toBe(true);
      expect(
        (r.json.warnings as string[]).some(
          (w) =>
            w.startsWith(`${wt}: `) && w.includes("not counted as unpushed"),
        ),
      ).toBe(true);
    }
    expect(fs.existsSync(wt)).toBe(false);
  });
});

describe("the content rule: commits after the point where the base had it all", () => {
  it("calls a squash of commits that rewrote the same file merged", () => {
    const f = makeFixture();
    const wt = addWorktree(f, "iter", path.join(f.root, "iter"));
    write(wt, "f.txt", "draft\n");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "draft"]);
    write(wt, "f.txt", "final\n");
    git(wt, ["commit", "-q", "-am", "final"]);
    git(wt, ["push", "-q", "origin", "iter"]);
    squashMergeOnServer(f, "iter");
    fetchPrune(f);
    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toContain(
      "1 path(s)",
    );
  });

  it("does not decide a branch whose commits cancel out", () => {
    const f = makeFixture();
    const wt = addWorktree(f, "undo", path.join(f.root, "undo"));
    write(wt, "a.txt", "changed\n");
    git(wt, ["commit", "-q", "-am", "change"]);
    write(wt, "a.txt", "one\n");
    git(wt, ["commit", "-q", "-am", "take it back"]);
    serverCommit(f, "elsewhere.txt", "unrelated\n");
    fetchPrune(f);
    expect(contentRule(wt, "HEAD", "refs/remotes/origin/main")).toEqual({});
  });

  it("decides a branch of up to the commit bound, and does not decide one past it", () => {
    const f = makeFixture();
    const wt = addWorktree(f, "long", path.join(f.root, "long"));
    // Every commit rewrites the same file, so no commit before the last
    // has what the base gets.
    execFileSync(
      "sh",
      [
        "-c",
        `i=1; while [ $i -le ${String(CONTENT_RULE_MAX_COMMITS)} ]; do echo $i > f.txt; git add f.txt; git commit -q -m c$i; i=$((i+1)); done`,
      ],
      { cwd: wt, env: { PATH: process.env.PATH, ...GIT_ENV } },
    );
    serverCommit(f, "f.txt", `${String(CONTENT_RULE_MAX_COMMITS)}\n`);
    fetchPrune(f);
    expect(contentInBase(wt, "HEAD", "refs/remotes/origin/main")).toContain(
      "1 path(s)",
    );

    commitHere(wt, "f.txt", "one more");
    serverCommit(f, "f.txt", "one more\n");
    fetchPrune(f);
    const answer = contentRule(wt, "HEAD", "refs/remotes/origin/main");
    expect(answer.yes).toBe(undefined);
    expect(answer.note).toContain(
      `more than ${String(CONTENT_RULE_MAX_COMMITS)} commits`,
    );
  });
});

describe("worktree remove: what a content verdict excuses", () => {
  it("keeps refusing never-pushed commits with --delete-branch alone, and takes them with --require-merged", async () => {
    for (const requireMerged of [false, true]) {
      const f = makeFixture();
      const wt = addWorktree(f, "np", path.join(f.root, "np"));
      write(wt, "a.txt", "changed\n");
      git(wt, ["commit", "-q", "-am", "only here"]);
      // The same change reached the base on its own.
      serverCommit(f, "a.txt", "changed\n");
      fetchPrune(f);

      const r = await cli(f.work, [
        "remove",
        wt,
        "--delete-branch",
        ...(requireMerged ? ["--require-merged"] : []),
      ]);
      if (requireMerged) {
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.json.merged).toMatchObject({ merged: "yes", via: "content" });
        expect(fs.existsSync(wt)).toBe(false);
        expect(branchExists(f, "np")).toBe(false);
      } else {
        expect(r.code, r.stdout + r.stderr).toBe(2);
        expect(r.json.reason).toBe("unpushed_commits");
        expect(fs.existsSync(wt)).toBe(true);
        expect(branchExists(f, "np")).toBe(true);
      }
    }
  });

  it("lets a merged pull request excuse them for --delete-branch alone, as before the content rule", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const bin = path.join(f.base, "ghbin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\necho '[{"number":7,"headRefOid":"${head(wt)}","baseRefName":"main"}]'\n`,
      { mode: 0o755 },
    );
    const r = await cli(f.work, ["remove", wt, "--delete-branch"], {
      PATH: `${bin}${path.delimiter}${FIXED_BIN_DIR}`,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(branchExists(f, "feat")).toBe(false);
  });

  it("never excuses the unpushed commits of a detached worktree by content", async () => {
    const f = makeFixture();
    const wt = path.join(f.root, "det");
    git(f.repo, ["worktree", "add", "-q", "--detach", wt, "origin/main"]);
    write(wt, "a.txt", "changed\n");
    git(wt, ["commit", "-q", "-am", "detached work"]);
    serverCommit(f, "a.txt", "changed\n");
    fetchPrune(f);
    const sha = head(wt);

    // `list` reports what the content rule sees ...
    const listed = await cli(f.work, ["list", "--repo", f.repo]);
    expect(
      (listed.json.worktrees as Record<string, any>[]).find(
        (w) => w.path === wt,
      )?.merged,
    ).toMatchObject({ merged: "yes", via: "content" });
    // ... but a removal does not weigh it for a detached HEAD.
    const r = await cli(f.work, ["remove", wt, "--require-merged"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("merge_state_unknown");
    expect(fs.existsSync(wt)).toBe(true);
    expect(head(wt)).toBe(sha);
  });
});

describe("worktree remove --sync-main: what the fast-forward must not touch", () => {
  /** A worktree to remove, and a commit on the server that adds
   * `<parent>/inside.txt`, forced past the fixture's `*.log` ignore rule. */
  function parentFixture(parent: string): { f: Fixture; wt: string } {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    git(f.other, ["pull", "-q", "--ff-only", "origin", "main"]);
    write(f.other, `${parent}/inside.txt`, "tracked upstream\n");
    git(f.other, ["add", "-f", `${parent}/inside.txt`]);
    git(f.other, ["commit", "-q", "-m", `track ${parent}`]);
    git(f.other, ["push", "-q", "origin", "main"]);
    return { f, wt };
  }

  it("leaves an ignored file at a parent path of a file the fast-forward adds", async () => {
    const { f, wt } = parentFixture("cache.log");
    write(f.repo, "cache.log", "precious ignored file\n");
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(r.json.sync.status).toBe("failed");
    expect(r.json.sync.reason).toContain("git merge --ff-only");
    expect(r.json.sync.reason).toContain("cache.log");
    expect(head(f.repo)).toBe(before);
    expect(fs.readFileSync(path.join(f.repo, "cache.log"), "utf8")).toBe(
      "precious ignored file\n",
    );
  });

  it("leaves an ignored symbolic link at a parent path, and what it points at", async () => {
    const { f, wt } = parentFixture("linked.log");
    const target = path.join(f.base, "elsewhere");
    write(target, "keep.txt", "keep\n");
    fs.symlinkSync(target, path.join(f.repo, "linked.log"));
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("failed");
    expect(head(f.repo)).toBe(before);
    expect(fs.lstatSync(path.join(f.repo, "linked.log")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
  });

  it("skips the fast-forward while a git am is paused in the main checkout", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    serverCommit(f, "n.txt", "new\n");
    const patch = path.join(f.base, "p.patch");
    fs.writeFileSync(
      patch,
      [
        "From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001",
        "From: t <t@example.com>",
        "Subject: [PATCH] p",
        "",
        "---",
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-no such line",
        "+zzz",
        "--",
        "2.0",
        "",
      ].join("\n"),
    );
    expect(gitOk(f.repo, ["am", patch])).toBe(false);
    expect(fs.existsSync(path.join(f.repo, ".git", "rebase-apply"))).toBe(true);
    const before = head(f.repo);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("skipped");
    expect(r.json.sync.reason).toContain("git am");
    expect(r.json.sync.reason).toContain("in progress");
    expect(head(f.repo)).toBe(before);
    expect(fs.existsSync(path.join(f.repo, ".git", "rebase-apply"))).toBe(true);
  });

  it("does not prune a tag only the main checkout has, even with fetch.pruneTags", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "idle", path.join(f.root, "idle"));
    serverCommit(f, "n.txt", "new\n");
    git(f.repo, ["tag", "local-only"]);
    git(f.repo, ["config", "fetch.pruneTags", "true"]);

    const r = await cli(f.work, ["remove", wt, "--sync-main"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.sync.status).toBe("fast_forwarded");
    expect(git(f.repo, ["tag", "--list"]).trim()).toBe("local-only");
  });
});
