import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXED_BIN_DIR, spawnCli } from "./helpers/spawn-cli.js";

/**
 * `worktree remove --sync-main`, `worktree sweep` and the merged verdict
 * they rest on. Hermetic like the other worktree suites: no global or
 * system git config, an identity from the environment, and a local bare
 * repository as `origin`. A merge on the "server" is made by a second clone
 * pushing a squash commit, so the fixture's main checkout is behind origin
 * exactly as it is after a real pull request merge. A squash merge leaves no
 * ancestry, so only `gh` can vouch for it: the CLI's PATH has no `gh` unless
 * a test puts the stand-in of `ghStub` there.
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

/**
 * A `gh` stand-in, returned as the PATH that puts it in front of the fixed
 * binaries. `gh pr list ... --head <branch>` prints the merged pull requests
 * `mergedPr` recorded for that branch and `[]` for any other, the way GitHub
 * filters by the head branch; every call is appended to `<base>/gh.log`.
 * With `<base>/commit-on-call` holding a number N, the N-th call first
 * commits `late.txt` in its working directory, which is the worktree the
 * verdict is about: a commit made after the removal's checks began.
 */
function ghStub(f: Fixture): string {
  const bin = path.join(f.base, "ghbin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(f.base, "prs"), { recursive: true });
  fs.writeFileSync(
    path.join(bin, "gh"),
    [
      // Shell built-ins and git only: the fixed PATH has no `cat`.
      "#!/bin/sh",
      "n=0",
      `if [ -f '${f.base}/gh.count' ]; then read -r n < '${f.base}/gh.count'; fi`,
      "n=$((n + 1))",
      `echo "$n" > '${f.base}/gh.count'`,
      `echo "$*" >> '${f.base}/gh.log'`,
      "at=",
      `if [ -f '${f.base}/commit-on-call' ]; then read -r at < '${f.base}/commit-on-call'; fi`,
      'if [ "$at" = "$n" ]; then',
      '  echo late > late.txt && git add late.txt && git commit -q -m "late commit" || exit 3',
      "fi",
      "head=",
      "prev=",
      'for a in "$@"; do',
      '  if [ "$prev" = --head ]; then head=$a; fi',
      "  prev=$a",
      "done",
      "json='[]'",
      `if [ -n "$head" ] && [ -f '${f.base}/prs/'"$head"'.json' ]; then read -r json < '${f.base}/prs/'"$head"'.json'; fi`,
      "printf '%s\\n' \"$json\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return `${bin}${path.delimiter}${FIXED_BIN_DIR}`;
}

/** Records a merged pull request of `branch` into `main` whose head was
 * `headRefOid`, for `ghStub` to report. */
function mergedPr(f: Fixture, branch: string, headRefOid: string): void {
  fs.mkdirSync(path.join(f.base, "prs"), { recursive: true });
  fs.writeFileSync(
    path.join(f.base, "prs", `${branch}.json`),
    `${JSON.stringify([{ number: 7, headRefOid, baseRefName: "main" }])}\n`,
  );
}

/** A `gh` that the trampoline cannot run (exit 127), as on a machine
 * without it; returned as a PATH like `ghStub`'s. */
function noGh(f: Fixture): string {
  const bin = path.join(f.base, "noghbin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 127\n", {
    mode: 0o755,
  });
  return `${bin}${path.delimiter}${FIXED_BIN_DIR}`;
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

describe("the merged verdict of a squash merge: ancestry, or gh at the tip", () => {
  it("does not call a branch merged that gained a commit after the squash", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    commitHere(wt, "after.txt", "work after the squash");

    const listed = await cli(f.work, ["list", "--repo", f.repo]);
    const entry = (listed.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === wt,
    );
    // No gh in the CLI's PATH: not an ancestor, and nothing else can say.
    expect(entry?.merged.merged).toBe("unknown");
    const refused = await cli(f.work, ["remove", wt, "--require-merged"]);
    expect(refused.code).toBe(2);
    expect(refused.json.reason).toBe("merge_state_unknown");
    expect(fs.existsSync(path.join(wt, "after.txt"))).toBe(true);
  });

  it("lets remove --require-merged --delete-branch take a squash-merged branch whose pull request gh reports at its tip", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const PATH = ghStub(f);
    mergedPr(f, "feat", head(wt));

    const r = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--delete-branch"],
      { PATH },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(r.json.branch.deleted).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists(f, "feat")).toBe(false);
    expect(
      (r.json.warnings as string[]).some((w) =>
        w.includes("not counted as unpushed"),
      ),
    ).toBe(true);
  });

  it("refuses a squash-merged branch with a commit after the pull request's head, which gh reports at the older tip", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    const prHead = head(wt);
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    commitHere(wt, "extra.txt", "never pushed, after the squash");
    const PATH = ghStub(f);
    mergedPr(f, "feat", prHead);

    const r = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--delete-branch"],
      { PATH },
    );
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("branch_not_merged");
    expect(r.json.details.merged).toMatchObject({ merged: "no", via: "gh" });
    expect(fs.existsSync(path.join(wt, "extra.txt"))).toBe(true);
    expect(branchExists(f, "feat")).toBe(true);
  });

  it("without gh, leaves a squash-merged branch unknown, so remove --require-merged refuses it", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);

    const r = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--delete-branch"],
      { PATH: noGh(f) },
    );
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("merge_state_unknown");
    expect(r.json.details.merged.reason).toContain("gh is not available");
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists(f, "feat")).toBe(true);
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
    // GitHub's view: the three squash-merged branches have a merged pull
    // request at their tips; `open` and `unpushed` have none.
    const PATH = ghStub(f);
    for (const [name, dir] of [
      ["squashed", squashed],
      ["dirty", dirty],
      ["locked", locked],
    ] as const) {
      mergedPr(f, name, head(dir));
    }

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.status).toBe("partial");
    expect(r.json.dryRun).toBe(false);

    expect(entryFor(r, squashed)).toMatchObject({
      action: "removed",
      branchDeleted: true,
    });
    expect(entryFor(r, squashed).merged).toMatchObject({
      merged: "yes",
      via: "gh",
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
    const PATH = ghStub(f);
    mergedPr(f, "feat", head(wt));
    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.summary.removed).toBe(1);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("removes a squash-merged branch whose pull request gh reports at its tip, with the branch's configuration", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "feat", path.join(f.root, "feat"));
    commitHere(wt, "feat.txt", "feat work");
    // An upstream, as `git push -u` sets it.
    git(wt, ["push", "-q", "-u", "origin", "feat"]);
    expect(git(f.repo, ["config", "branch.feat.remote"]).trim()).toBe("origin");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const PATH = ghStub(f);
    mergedPr(f, "feat", head(wt));

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(entryFor(r, wt)).toMatchObject({
      action: "removed",
      branchDeleted: true,
    });
    expect(entryFor(r, wt).merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists(f, "feat")).toBe(false);
    expect(gitOk(f.repo, ["config", "--get-regexp", "^branch\\.feat\\."])).toBe(
      false,
    );
  });

  it("skips a squash-merged branch without gh, with the reason, and reports partial", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);

    const r = await cli(f.work, ["sweep", "--root", f.root], {
      PATH: noGh(f),
    });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.status).toBe("partial");
    expect(entryFor(r, wt).action).toBe("skipped");
    expect(entryFor(r, wt).reason).toContain("gh is not available");
    expect(entryFor(r, wt).merged).toMatchObject({
      merged: "unknown",
      via: "none",
    });
    expect(fs.existsSync(path.join(wt, "feat-1.txt"))).toBe(true);
    expect(branchExists(f, "feat")).toBe(true);
  });

  it("executes nothing with --dry-run and lists what it would remove", async () => {
    const f = makeFixture();
    const merged = featureWorktree(f, "merged");
    const open = featureWorktree(f, "open");
    squashMergeOnServer(f, "merged");
    fetchPrune(f);
    const PATH = ghStub(f);
    mergedPr(f, "merged", head(merged));
    const refsBefore = git(f.repo, ["show-ref"]);
    const listBefore = git(f.repo, ["worktree", "list", "--porcelain"]);

    const r = await cli(f.work, ["sweep", "--root", f.root, "--dry-run"], {
      PATH,
    });
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
    const merged = featureWorktree(f, "merged");
    squashMergeOnServer(f, "merged");
    fetchPrune(f);
    const PATH = ghStub(f);
    mergedPr(f, "merged", head(merged));
    const r = await cli(f.work, ["sweep", "--root", f.root, "--dry-run"], {
      PATH,
    });
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
    const PATH = ghStub(f);
    mergedPr(f, "inside", head(inside));
    mergedPr(f, "outside", head(outside));

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
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

  it("does not sweep a branch that gained unpushed commits after its squash merge, though gh reports the pull request at the older tip", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    const prHead = head(wt);
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    commitHere(wt, "extra.txt", "extra work after the squash");
    const PATH = ghStub(f);
    mergedPr(f, "feat", prHead);

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(entryFor(r, wt).action).toBe("skipped");
    expect(entryFor(r, wt).merged).toMatchObject({ merged: "no", via: "gh" });
    expect(entryFor(r, wt).reason).toContain(`none into main at ${head(wt)}`);
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
    // Merged as far as gh can tell, so only the link check holds it back.
    const PATH = ghStub(f);
    mergedPr(f, "outsider", head(moved));
    const link = path.join(f.root, "link");
    fs.symlinkSync(moved, link);

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
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

  /** A branch `sq` whose one commit `s1` was pushed and squash-merged,
   * with the remote branch deleted, and then two commits that were never
   * pushed: one adds `notes.md`, the next deletes it again, so the
   * branch's net change is still all in the base. */
  function netZeroAfterSquash(): { f: Fixture; wt: string; s1: string } {
    const f = makeFixture();
    const wt = addWorktree(f, "sq", path.join(f.root, "sq"));
    commitHere(wt, "s.txt", "s1");
    git(wt, ["push", "-q", "origin", "sq"]);
    const s1 = head(wt);
    squashMergeOnServer(f, "sq");
    fetchPrune(f);
    commitHere(wt, "notes.md", "important notes");
    git(wt, ["rm", "-q", "notes.md"]);
    git(wt, ["commit", "-q", "-m", "move the notes elsewhere"]);
    return { f, wt, s1 };
  }

  it("does not sweep a squash-merged branch that gained unpushed commits adding and then deleting a file", async () => {
    const { f, wt, s1 } = netZeroAfterSquash();

    // Without gh nothing can vouch for it.
    const listed = await cli(f.work, ["list", "--repo", f.repo]);
    const entry = (listed.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === wt,
    );
    expect(entry?.merged.merged).toBe("unknown");
    const unknown = await cli(f.work, [
      "remove",
      wt,
      "--require-merged",
      "--delete-branch",
    ]);
    expect(unknown.code, unknown.stdout + unknown.stderr).toBe(2);
    expect(unknown.json.reason).toBe("merge_state_unknown");

    // With gh, the pull request was merged at s1, not at the tip.
    const PATH = ghStub(f);
    mergedPr(f, "sq", s1);
    const refused = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--delete-branch"],
      { PATH },
    );
    expect(refused.code, refused.stdout + refused.stderr).toBe(2);
    expect(refused.json.reason).toBe("branch_not_merged");

    for (const env of [{}, { PATH }]) {
      const r = await cli(f.work, ["sweep", "--root", f.root], env);
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(entryFor(r, wt).action).toBe("skipped");
    }
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists(f, "sq")).toBe(true);
    expect(git(wt, ["log", "--format=%s", "-1", "HEAD~1"]).trim()).toBe(
      "important notes",
    );
  });

  it("does not sweep net-zero commits after a squash followed by a cherry-pick of a base commit", async () => {
    const { f, wt, s1 } = netZeroAfterSquash();
    // A later change on the base, taken onto the branch as well.
    serverCommit(f, "a.txt", "moved\n");
    fetchPrune(f);
    const baseCommit = git(f.repo, ["rev-parse", "origin/main"]).trim();
    git(wt, ["cherry-pick", baseCommit]);
    const PATH = ghStub(f);
    mergedPr(f, "sq", s1);

    for (const dryRun of [true, false]) {
      const r = await cli(
        f.work,
        ["sweep", "--root", f.root, ...(dryRun ? ["--dry-run"] : [])],
        { PATH },
      );
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(entryFor(r, wt).action).toBe("skipped");
      expect(entryFor(r, wt).merged).toMatchObject({
        merged: "no",
        via: "gh",
      });
    }
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists(f, "sq")).toBe(true);
    expect(git(f.repo, ["log", "--format=%s", "sq"])).toContain(
      "important notes",
    );
  });

  it("refuses net-zero commits after a squash followed by taking a base file in a commit of its own", async () => {
    const { f, wt, s1 } = netZeroAfterSquash();
    serverCommit(f, "a.txt", "moved\n");
    fetchPrune(f);
    git(wt, ["checkout", "-q", "origin/main", "--", "a.txt"]);
    git(wt, ["commit", "-q", "-m", "take a.txt from main"]);
    const PATH = ghStub(f);
    mergedPr(f, "sq", s1);

    const r = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--delete-branch"],
      { PATH },
    );
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("branch_not_merged");
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists(f, "sq")).toBe(true);
    expect(git(f.repo, ["log", "--format=%s", "sq"])).toContain(
      "important notes",
    );
  });

  it("skips an orphan branch, which has no fork point with the base to tell its own commits by, though gh reports its merged pull request at its tip", async () => {
    const f = makeFixture();
    const wt = path.join(f.root, "orph");
    git(f.repo, ["worktree", "add", "-q", "--detach", wt, "origin/main"]);
    git(wt, ["switch", "-q", "--orphan", "orph"]);
    commitHere(wt, "o.txt", "orphan work");
    git(wt, ["push", "-q", "origin", "orph"]);
    const tip = head(wt);
    mergedPr(f, "orph", tip);
    git(f.repo, ["push", "-q", "origin", "--delete", "orph"]);
    fetchPrune(f);
    expect(gitOk(wt, ["merge-base", "HEAD", "origin/main"])).toBe(false);
    const PATH = ghStub(f);

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    const entry = entryFor(r, wt);
    expect(entry).toMatchObject({
      action: "skipped",
      refusal: "no_own_commits",
    });
    expect(entry.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(entry.reason).toContain("cannot tell whether");
    expect(fs.readFileSync(path.join(wt, "o.txt"), "utf8")).toBe(
      "orphan work\n",
    );
    expect(git(f.repo, ["rev-parse", "refs/heads/orph"]).trim()).toBe(tip);
  });

  it("does not sweep a branch stacked on a squash-merged branch, which has no merged pull request of its own", async () => {
    const f = makeFixture();
    const featx = addWorktree(f, "featx", path.join(f.root, "featx"));
    commitHere(featx, "fx1.txt", "fx one");
    commitHere(featx, "fx2.txt", "fx two");
    git(featx, ["push", "-q", "origin", "featx"]);
    fetchPrune(f);
    fs.appendFileSync(
      path.join(f.repo, ".git", "info", "exclude"),
      ".ai/run\n.env\n",
    );
    const runDir = path.join(f.base, "run");
    fs.mkdirSync(runDir);
    const featy = path.join(f.root, "featy");
    const created = await spawnCli(
      [
        "-C",
        f.work,
        "worktree",
        "create",
        "--repo",
        f.repo,
        "--branch",
        "featy",
        "--base",
        "origin/featx",
        "--path",
        featy,
        "--run",
        runDir,
        "--no-fetch",
      ],
      { env: GIT_ENV },
    );
    expect(created.code, created.stdout + created.stderr).toBe(0);
    // The stacked task is in flight: ignored local configuration.
    write(featy, ".env", "SECRET=in-flight\n");
    squashMergeOnServer(f, "featx");
    fetchPrune(f);
    // gh knows the parent's pull request only.
    const PATH = ghStub(f);
    mergedPr(f, "featx", head(featx));

    for (const dryRun of [true, false]) {
      const r = await cli(
        f.work,
        ["sweep", "--root", f.root, ...(dryRun ? ["--dry-run"] : [])],
        { PATH },
      );
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(entryFor(r, featx).action).toBe(
        dryRun ? "would_remove" : "removed",
      );
      expect(entryFor(r, featy).action).toBe("skipped");
      expect(entryFor(r, featy).reason).toContain(
        "gh lists no merged pull request for featy",
      );
    }
    expect(fs.readFileSync(path.join(featy, ".env"), "utf8")).toBe(
      "SECRET=in-flight\n",
    );
    expect(fs.existsSync(path.join(featy, ".ai", "run"))).toBe(true);
    expect(branchExists(f, "featy")).toBe(true);
    expect(branchExists(f, "featx")).toBe(false);
  });

  it("carries the removal's warnings into the entry and the top-level warnings, in a dry run too", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const PATH = ghStub(f);
    mergedPr(f, "feat", head(wt));
    for (const dryRun of [true, false]) {
      const r = await cli(
        f.work,
        ["sweep", "--root", f.root, ...(dryRun ? ["--dry-run"] : [])],
        { PATH },
      );
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

/**
 * The branch is deleted only at the commit the checks were made at. The
 * `gh` stand-in commits on the branch from inside the merge check, which
 * is a commit made after the checks began and before the deletion.
 */
describe("worktree remove and sweep: a branch that moves after the checks", () => {
  /** A squash-merged `feat` whose pull request gh reports at its tip. With
   * `commitOnCall`, the gh stand-in commits in the worktree on that call
   * (during the checks); otherwise a `git` stand-in in front of it commits
   * there right before running `git worktree remove`, after the removal's
   * last read of HEAD. */
  function raceFixture(commitOnCall?: number): {
    f: Fixture;
    wt: string;
    checked: string;
    PATH: string;
  } {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    const checked = head(wt);
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const ghPath = ghStub(f);
    mergedPr(f, "feat", checked);
    if (commitOnCall !== undefined) {
      fs.writeFileSync(
        path.join(f.base, "commit-on-call"),
        String(commitOnCall),
      );
      return { f, wt, checked, PATH: ghPath };
    }
    const bin = path.join(f.base, "gitbin");
    fs.mkdirSync(bin);
    const realGit = path.join(FIXED_BIN_DIR, "git");
    fs.writeFileSync(
      path.join(bin, "git"),
      [
        "#!/bin/sh",
        'case " $* " in',
        '  *" worktree remove "*)',
        `    if [ ! -f '${f.base}/committed' ]; then`,
        `      : > '${f.base}/committed'`,
        `      (cd '${wt}' && echo late > late.txt && '${realGit}' add late.txt && '${realGit}' commit -q -m "late commit") || exit 3`,
        "    fi",
        "    ;;",
        "esac",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { f, wt, checked, PATH: `${bin}${path.delimiter}${ghPath}` };
  }

  function expectLateCommitKept(f: Fixture, checked: string): void {
    expect(branchExists(f, "feat")).toBe(true);
    expect(git(f.repo, ["rev-parse", "feat~1"]).trim()).toBe(checked);
    expect(git(f.repo, ["show", "feat:late.txt"])).toBe("late\n");
  }

  it("remove --delete-branch refuses (head_moved) when the worktree's HEAD moved during the checks, and keeps the worktree and the new commit", async () => {
    // The removal's one gh call is the merge check.
    const { f, wt, checked, PATH } = raceFixture(1);

    const r = await cli(f.work, ["remove", wt, "--delete-branch"], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("head_moved");
    expect(r.json.message).toContain(`not at ${checked}`);
    expect(r.json.details.listed).toBe(checked);
    expect(r.json.details.head).toBe(head(wt));
    expect(fs.existsSync(path.join(wt, "late.txt"))).toBe(true);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).toContain(
      `worktree ${wt}\n`,
    );
    expectLateCommitKept(f, checked);
  });

  it("sweep skips (head_moved) a worktree whose HEAD moved during the removal's checks", async () => {
    // The listing asks gh first, the removal second.
    const { f, wt, checked, PATH } = raceFixture(2);

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.status).toBe("partial");
    expect(entryFor(r, wt)).toMatchObject({
      action: "skipped",
      refusal: "head_moved",
    });
    expect(fs.existsSync(path.join(wt, "late.txt"))).toBe(true);
    expectLateCommitKept(f, checked);
  });

  it("remove --delete-branch keeps the branch with the new commit and warns", async () => {
    // The commit lands after the last read of HEAD, while the worktree is
    // removed.
    const { f, wt, checked, PATH } = raceFixture();

    const r = await cli(f.work, ["remove", wt, "--delete-branch"], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(fs.existsSync(wt)).toBe(false);
    expect(r.json.branch.deleted).toBe(false);
    expect(r.json.branch.reason).toContain(`not at ${checked}`);
    expect(
      (r.json.warnings as string[]).some((w) =>
        w.includes("the branch feat was not deleted"),
      ),
    ).toBe(true);
    expectLateCommitKept(f, checked);
    expect(fs.existsSync(path.join(f.base, "committed"))).toBe(true);
  });

  it("sweep keeps the branch with the new commit, warns on the entry and reports partial", async () => {
    const { f, wt, checked, PATH } = raceFixture();

    const r = await cli(f.work, ["sweep", "--root", f.root], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.json.status).toBe("partial");
    const entry = entryFor(r, wt);
    expect(entry).toMatchObject({ action: "removed", branchDeleted: false });
    expect(
      (entry.warnings as string[]).some((w) =>
        w.includes("the branch feat was not deleted"),
      ),
    ).toBe(true);
    expect(
      (r.json.warnings as string[]).some(
        (w) =>
          w.startsWith(`${wt}: `) &&
          w.includes("the branch feat was not deleted"),
      ),
    ).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expectLateCommitKept(f, checked);
    expect(fs.readFileSync(path.join(f.base, "gh.count"), "utf8").trim()).toBe(
      "2",
    );
    expect(fs.existsSync(path.join(f.base, "committed"))).toBe(true);
  });

  it("keeps a branch that another worktree has checked out", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    const twin = path.join(f.base, "twin");
    git(f.repo, ["worktree", "add", "-q", "--force", twin, "feat"]);

    const r = await cli(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(r.json.branch.deleted).toBe(false);
    expect(r.json.branch.reason).toContain(`checked out in ${twin}`);
    expect(branchExists(f, "feat")).toBe(true);
    expect(git(twin, ["branch", "--show-current"]).trim()).toBe("feat");
  });

  it("remove --force takes a worktree on an unborn branch, which the listing shows at no commit", async () => {
    const f = makeFixture();
    const wt = path.join(f.root, "orphan");
    git(f.repo, ["worktree", "add", "--orphan", "-b", "orphan", wt]);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).toContain(
      `worktree ${wt}\nHEAD 0000000000000000000000000000000000000000\n`,
    );

    const r = await cli(f.work, ["remove", wt, "--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).not.toContain(
      `worktree ${wt}\n`,
    );
  });

  it("remove --force takes a worktree whose branch points at a commit object that is missing", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "gone", path.join(f.root, "gone"));
    const missing = "1111111111111111111111111111111111111111";
    fs.writeFileSync(
      path.join(f.repo, ".git", "refs", "heads", "gone"),
      `${missing}\n`,
    );
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).toContain(
      `worktree ${wt}\nHEAD ${missing}\n`,
    );

    const r = await cli(f.work, ["remove", wt, "--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).not.toContain(
      `worktree ${wt}\n`,
    );
  });
});

describe("worktree remove and sweep: files whose edits git status does not show", () => {
  const flags = ["assume-unchanged", "skip-worktree"] as const;

  /** A squash-merged `feat`, pushed, whose pull request gh reports at its
   * tip, with the tracked `shared.txt` flagged `flag` in its worktree. */
  function flaggedFixture(flag: (typeof flags)[number]): {
    f: Fixture;
    wt: string;
    PATH: string;
  } {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    mergedPr(f, "feat", head(wt));
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const PATH = ghStub(f);
    git(wt, ["update-index", `--${flag}`, "shared.txt"]);
    return { f, wt, PATH };
  }

  function hide(wt: string): void {
    write(wt, "shared.txt", "uncommitted local work\n");
    expect(git(wt, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      "",
    );
  }

  /** The worktree, its file, its flag and its branch are all still there. */
  function expectKept(
    f: Fixture,
    wt: string,
    flag: (typeof flags)[number],
    content: string,
  ): void {
    expect(fs.readFileSync(path.join(wt, "shared.txt"), "utf8")).toBe(content);
    expect(git(wt, ["ls-files", "-v", "shared.txt"])).toMatch(
      flag === "assume-unchanged" ? /^h shared\.txt$/m : /^S shared\.txt$/m,
    );
    expect(branchExists(f, "feat")).toBe(true);
  }

  it.each(flags)(
    "remove refuses an edit to a file flagged %s, with and without --require-merged, and keeps it",
    async (flag) => {
      const { f, wt, PATH } = flaggedFixture(flag);
      hide(wt);
      for (const args of [[], ["--require-merged", "--delete-branch"]]) {
        const r = await cli(f.work, ["remove", wt, ...args], { PATH });
        expect(r.code, r.stdout + r.stderr).toBe(2);
        expect(r.json.reason).toBe("worktree_dirty");
        expect(r.json.message).toContain(`shared.txt is flagged ${flag}`);
        expect(r.json.details.flagged).toEqual([
          `shared.txt is flagged ${flag}`,
        ]);
      }
      expectKept(f, wt, flag, "uncommitted local work\n");
    },
  );

  it.each(flags)(
    "sweep skips a worktree with an edit to a file flagged %s, in a dry run and a real one, and keeps it",
    async (flag) => {
      const { f, wt, PATH } = flaggedFixture(flag);
      hide(wt);
      for (const dryRun of [true, false]) {
        const r = await cli(
          f.work,
          ["sweep", "--root", f.root, ...(dryRun ? ["--dry-run"] : [])],
          { PATH },
        );
        expect(r.code, r.stdout + r.stderr).toBe(1);
        const entry = entryFor(r, wt);
        expect(entry).toMatchObject({
          action: "skipped",
          refusal: "worktree_dirty",
        });
        expect(entry.reason).toContain(`shared.txt is flagged ${flag}`);
      }
      expectKept(f, wt, flag, "uncommitted local work\n");
    },
  );

  it.each(flags)(
    "remove refuses a worktree with a file flagged %s that is not edited, without comparing it, and keeps it",
    async (flag) => {
      const { f, wt, PATH } = flaggedFixture(flag);
      const original = fs.readFileSync(path.join(wt, "shared.txt"), "utf8");
      const r = await cli(
        f.work,
        ["remove", wt, "--require-merged", "--delete-branch"],
        { PATH },
      );
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("worktree_dirty");
      expect(r.json.message).toContain(`shared.txt is flagged ${flag}`);
      expect(r.json.message).toContain("--force");
      expect(r.json.details.flagged).toEqual([`shared.txt is flagged ${flag}`]);
      expectKept(f, wt, flag, original);
    },
  );

  it.each(flags)(
    "sweep skips a worktree with a file flagged %s that is not edited, in a dry run and a real one, and keeps it",
    async (flag) => {
      const { f, wt, PATH } = flaggedFixture(flag);
      const original = fs.readFileSync(path.join(wt, "shared.txt"), "utf8");
      for (const dryRun of [true, false]) {
        const r = await cli(
          f.work,
          ["sweep", "--root", f.root, ...(dryRun ? ["--dry-run"] : [])],
          { PATH },
        );
        expect(r.code, r.stdout + r.stderr).toBe(1);
        const entry = entryFor(r, wt);
        expect(entry).toMatchObject({
          action: "skipped",
          refusal: "worktree_dirty",
        });
        expect(entry.reason).toContain(`shared.txt is flagged ${flag}`);
      }
      expectKept(f, wt, flag, original);
    },
  );

  it.each(flags)(
    "remove --force removes a worktree with an edited file flagged %s",
    async (flag) => {
      const { f, wt, PATH } = flaggedFixture(flag);
      hide(wt);
      const r = await cli(f.work, ["remove", wt, "--force"], { PATH });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(fs.existsSync(wt)).toBe(false);
    },
  );

  it("does not count a skip-worktree file that is absent from the work tree, as in a sparse checkout", async () => {
    const { f, wt, PATH } = flaggedFixture("skip-worktree");
    fs.unlinkSync(path.join(wt, "shared.txt"));
    const r = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--delete-branch"],
      { PATH },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("refuses a flagged symbolic link, retargeted or not, and a flagged path with a directory in its place", async () => {
    const f = makeFixture();
    const dirs: string[] = [];
    for (const name of ["kept", "moved", "dir"]) {
      const wt = addWorktree(f, name, path.join(f.root, name));
      fs.symlinkSync("a.txt", path.join(wt, "ln"));
      git(wt, ["add", "ln"]);
      git(wt, ["commit", "-q", "-m", `link ${name}`]);
      git(wt, ["push", "-q", "origin", name]);
      git(wt, ["update-index", "--assume-unchanged", "ln"]);
      dirs.push(wt);
    }
    const [kept, moved, dir] = dirs as [string, string, string];
    fs.unlinkSync(path.join(moved, "ln"));
    fs.symlinkSync("shared.txt", path.join(moved, "ln"));
    fs.unlinkSync(path.join(dir, "ln"));
    fs.mkdirSync(path.join(dir, "ln"));
    for (const wt of dirs) {
      expect(git(wt, ["status", "--porcelain"])).toBe("");
      const r = await cli(f.work, ["remove", wt]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("worktree_dirty");
      expect(r.json.details.flagged).toEqual([
        "ln is flagged assume-unchanged",
      ]);
      expect(fs.existsSync(wt)).toBe(true);
    }
    expect(fs.readlinkSync(path.join(kept, "ln"))).toBe("a.txt");
    expect(fs.readlinkSync(path.join(moved, "ln"))).toBe("shared.txt");
    expect(fs.statSync(path.join(dir, "ln")).isDirectory()).toBe(true);
  });

  /** A pushed `feat` worktree below `f.root` whose files `setup` adds and
   * commits, so that a plain `remove` has nothing unpushed to refuse. */
  function pushedWorktree(setup: (wt: string) => void): {
    f: Fixture;
    wt: string;
  } {
    const f = makeFixture();
    const wt = addWorktree(f, "feat", path.join(f.root, "feat"));
    setup(wt);
    git(wt, ["push", "-q", "origin", "feat"]);
    return { f, wt };
  }

  it("names each flagged file whose name holds a newline, a carriage return, a leading double quote or a backslash, edited or not", async () => {
    const names = [
      "nl\nname.txt",
      "cr\rname.txt",
      '"lead.txt',
      "back\\slash.txt",
    ];
    const { f, wt } = pushedWorktree((dir) => {
      for (const name of names) write(dir, name, "v\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "names"]);
    });
    git(wt, ["update-index", "--assume-unchanged", "--", ...names]);
    const expected = names
      .map((name) => `${name} is flagged assume-unchanged`)
      .sort();
    for (const content of ["v\n", "EDIT\n"]) {
      for (const name of names) write(wt, name, content);
      expect(git(wt, ["status", "--porcelain"])).toBe("");
      const refused = await cli(f.work, ["remove", wt]);
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      expect(refused.json.reason).toBe("worktree_dirty");
      expect([...(refused.json.details.flagged as string[])].sort()).toEqual(
        expected,
      );
      for (const name of names) {
        expect(fs.readFileSync(path.join(wt, name), "utf8")).toBe(content);
      }
    }
  });

  it("does not count a flagged submodule entry, and removes the worktree with an empty directory in its place", async () => {
    const { f, wt } = pushedWorktree((dir) => {
      git(dir, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head(dir)},sub`,
      ]);
      git(dir, ["commit", "-q", "-m", "gitlink"]);
    });
    fs.mkdirSync(path.join(wt, "sub"));
    git(wt, ["update-index", "--assume-unchanged", "sub"]);
    expect(git(wt, ["ls-files", "-s", "-v", "sub"])).toMatch(/^h 160000 /);
    expect(git(wt, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      "",
    );

    const r = await cli(f.work, ["remove", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
  });
});

describe("worktree remove --delete-branch: the branch's configuration", () => {
  it("does not take the section of a dotted sibling branch for the deleted branch's own", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    const PATH = ghStub(f);
    mergedPr(f, "feat", head(wt));
    // `feat` has no configuration of its own; its sibling `feat.x` does.
    expect(gitOk(f.repo, ["config", "--get-regexp", "^branch\\.feat\\."])).toBe(
      false,
    );
    git(f.repo, ["config", "branch.feat.x.remote", "origin"]);
    git(f.repo, ["config", "branch.feat.x.merge", "refs/heads/feat.x"]);

    const r = await cli(f.work, ["remove", wt, "--delete-branch"], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
    expect(r.json.warnings).toEqual([]);
    expect(branchExists(f, "feat")).toBe(false);
    expect(git(f.repo, ["config", "branch.feat.x.remote"]).trim()).toBe(
      "origin",
    );
    expect(git(f.repo, ["config", "branch.feat.x.merge"]).trim()).toBe(
      "refs/heads/feat.x",
    );
  });
});

describe("worktree remove: what a merged verdict excuses", () => {
  it("refuses never-pushed commits whose change reached the base on its own, with --delete-branch alone and with --require-merged", async () => {
    for (const requireMerged of [false, true]) {
      const f = makeFixture();
      const wt = addWorktree(f, "np", path.join(f.root, "np"));
      write(wt, "a.txt", "changed\n");
      git(wt, ["commit", "-q", "-am", "only here"]);
      // The same change reached the base on its own.
      serverCommit(f, "a.txt", "changed\n");
      fetchPrune(f);
      const sha = head(wt);

      const r = await cli(f.work, [
        "remove",
        wt,
        "--delete-branch",
        ...(requireMerged ? ["--require-merged"] : []),
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe(
        requireMerged ? "merge_state_unknown" : "unpushed_commits",
      );
      expect(fs.existsSync(wt)).toBe(true);
      expect(branchExists(f, "np")).toBe(true);
      expect(head(wt)).toBe(sha);
    }
  });

  it("lets a merged pull request excuse them for --delete-branch alone", async () => {
    const f = makeFixture();
    const wt = featureWorktree(f, "feat");
    squashMergeOnServer(f, "feat");
    fetchPrune(f);
    const PATH = ghStub(f);
    mergedPr(f, "feat", head(wt));
    const r = await cli(f.work, ["remove", wt, "--delete-branch"], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(branchExists(f, "feat")).toBe(false);
  });

  it("never excuses the unpushed commits of a detached worktree whose change reached the base", async () => {
    const f = makeFixture();
    const wt = path.join(f.root, "det");
    git(f.repo, ["worktree", "add", "-q", "--detach", wt, "origin/main"]);
    write(wt, "a.txt", "changed\n");
    git(wt, ["commit", "-q", "-am", "detached work"]);
    serverCommit(f, "a.txt", "changed\n");
    fetchPrune(f);
    const sha = head(wt);

    // No ancestry and no branch to ask gh about: unknown, in `list` ...
    const listed = await cli(f.work, ["list", "--repo", f.repo]);
    expect(
      (listed.json.worktrees as Record<string, any>[]).find(
        (w) => w.path === wt,
      )?.merged,
    ).toMatchObject({ merged: "unknown", via: "none" });
    // ... and in a removal, which refuses.
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
