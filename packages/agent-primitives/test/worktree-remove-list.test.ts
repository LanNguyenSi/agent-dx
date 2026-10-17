import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ignoredSymlinks, parseWorktreeList } from "../src/worktree/index.js";
import {
  alteredCommitGraph,
  gitOutputLine,
  gitPathIn,
  resolveDefaultBase,
  resolveRemoteBase,
  unpushedCommits,
  untrustedFilesRefStore,
  plausibleRefTarget,
  privateStackRemoteRefs,
  untrustedReftableStore,
} from "../src/worktree/git.js";
import {
  buildSpawnEnv,
  CLI_PATH,
  FIXED_BIN_DIR,
  spawnCli,
} from "./helpers/spawn-cli.js";

/**
 * Hermetic, exactly as `test/worktree.test.ts` is: every git call, in
 * process and inside the spawned CLI, runs with no global or system git
 * config, an identity from the environment, and a local bare repository as
 * `origin`. Nothing reaches the network; a `gh` binary is absent unless a
 * test writes one (see `ghStub`).
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

// Worktrees, a spawned CLI per assertion group, and a stubbed `gh`: the
// default 5 s is too tight for a loaded CI runner.
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

/** git's stdout, or `undefined` when it exited non-zero: for a question
 * whose negative answer is an exit code rather than empty output. */
function gitTry(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

interface Fixture {
  /** Real path of the directory holding everything below. */
  base: string;
  origin: string;
  /** The main checkout, named `repo`. */
  repo: string;
  /** An unrelated directory to run the CLI from. */
  work: string;
  /** Sha of the commit `origin/main` points at after setup. */
  mainSha: string;
}

/** `refFormat` is handed to `git init --ref-format`; `gitDirName` puts the
 * main checkout's git directory at that name below `base` instead of
 * `repo/.git` (`git init --separate-git-dir`). */
function makeFixture(
  opts: { refFormat?: string; gitDirName?: string } = {},
): Fixture {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-remove-")),
  );
  tmpDirs.push(base);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(base, [
    "init",
    "-q",
    ...(opts.refFormat === undefined ? [] : [`--ref-format=${opts.refFormat}`]),
    ...(opts.gitDirName === undefined
      ? []
      : ["--separate-git-dir", path.join(base, opts.gitDirName)]),
    "-b",
    "main",
    repo,
  ]);
  write(repo, "a.txt", "one\n");
  write(repo, ".gitignore", ".ai/run\nnode_modules\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
  const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();
  return { base, origin, repo, work, mainSha };
}

/** A worktree of the fixture on a new branch, made by git directly rather
 * than through `worktree create`, so a test that needs no links, no pointer
 * and no fetch gets one in one call. */
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

/** One commit in `dir`, so its branch is ahead of the base. */
function commitHere(dir: string, file: string, message: string): void {
  write(dir, file, `${message}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

/** The absolute path one `git rev-parse <question>` names inside `dir`
 * (git answers a common dir relatively to the repository, a git dir of a
 * linked worktree absolutely). */
function absoluteGitPath(dir: string, question: string): string {
  return path.resolve(dir, git(dir, ["rev-parse", question]).trim());
}

/**
 * A worktree made through `worktree create` with a `node_modules` link into
 * the main checkout, which the fixture's `.gitignore` ignores. `create` is
 * the only way a link appears, so a test that needs one cannot use
 * `addWorktree`.
 */
async function createWithLink(
  f: Fixture,
  branch: string,
  dir: string,
): Promise<string> {
  fs.mkdirSync(path.join(f.repo, "node_modules", "pkg"), { recursive: true });
  write(f.repo, "node_modules/pkg/keep.txt", "x");
  const made = await cli(f.work, [
    "create",
    "--repo",
    f.repo,
    "--branch",
    branch,
    "--path",
    dir,
    "--link",
    "node_modules",
  ]);
  expect(made.code, made.stdout + made.stderr).toBe(0);
  return dir;
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

/**
 * Writes an executable `<base>/ghbin/gh` and returns the PATH to hand the
 * CLI so that `gh` is it, followed by the fixed bin dir. `json` is what the
 * stub prints on stdout; `null` stands for an installed `gh` that fails.
 * Without this, `gh` is absent: the spawned CLI sees only git, node, npm
 * and sh. With `recordArgs`, every call also appends its arguments as one
 * line to the file `ghArgs` reads, so a test can pin what was asked.
 */
function ghStub(
  f: Fixture,
  json: string | null,
  opts: { recordArgs?: boolean } = {},
): string {
  const dir = path.join(f.base, "ghbin");
  fs.mkdirSync(dir, { recursive: true });
  const record =
    opts.recordArgs === true ? `echo "$@" >> '${ghArgsFile(f)}'\n` : "";
  const script =
    json === null
      ? `#!/bin/sh\n${record}exit 1\n`
      : `#!/bin/sh\n${record}echo '${json}'\n`;
  fs.writeFileSync(path.join(dir, "gh"), script, { mode: 0o755 });
  return `${dir}${path.delimiter}${FIXED_BIN_DIR}`;
}

function ghArgsFile(f: Fixture): string {
  return path.join(f.base, "gh-args.log");
}

/** The argument lines a `ghStub` with `recordArgs` wrote, one per call. */
function ghArgs(f: Fixture): string[] {
  if (!fs.existsSync(ghArgsFile(f))) return [];
  return fs
    .readFileSync(ghArgsFile(f), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function listedWorktrees(repo: string): string[] {
  return parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"])).map(
    (w) => w.path,
  );
}

describe("worktree remove: what it refuses", () => {
  it("refuses a modified tracked file and changes nothing", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "dirty", path.join(f.base, "wt-dirty"));
    write(wt, "a.txt", "changed\n");
    const before = listedWorktrees(f.repo);

    const r = await cli(f.work, ["remove", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.status).toBe("usage_error");
    expect(r.json.command).toBe("worktree remove");
    expect(r.json.reason).toBe("worktree_dirty");
    expect(r.json.message).toContain(wt);
    expect(r.json.details.entries).toHaveLength(1);
    expect(r.json.details.entries[0]).toContain("a.txt");
    expect(listedWorktrees(f.repo)).toEqual(before);
    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("changed\n");
  });

  it("refuses a worktree whose only change is an untracked file", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "extra", path.join(f.base, "wt-extra"));
    write(wt, "scratch.txt", "s\n");

    const r = await cli(f.work, ["remove", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("worktree_dirty");
    expect(r.json.details.entries[0]).toContain("scratch.txt");
    expect(fs.existsSync(path.join(wt, "scratch.txt"))).toBe(true);
  });

  it("refuses commits that no remote branch has, counting them", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "local", path.join(f.base, "wt-local"));
    commitHere(wt, "local.txt", "not pushed");

    const r = await cli(f.work, ["remove", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
    expect(r.json.details.commits).toBe(1);
    expect(listedWorktrees(f.repo)).toContain(wt);
  });

  it("removes the main checkout never, nor a directory that is no worktree", async () => {
    const f = makeFixture();
    const before = listedWorktrees(f.repo);

    const main = await cli(f.work, ["remove", f.repo]);
    expect(main.code, main.stdout + main.stderr).toBe(2);
    expect(main.json.reason).toBe("remove_main_checkout");
    expect(main.json.details.mainCheckout).toBe(f.repo);
    expect(fs.existsSync(path.join(f.repo, "a.txt"))).toBe(true);

    const plain = path.join(f.repo, "not-a-worktree");
    fs.mkdirSync(plain);
    const notWorktree = await cli(f.work, ["remove", plain]);
    expect(notWorktree.code, notWorktree.stdout + notWorktree.stderr).toBe(2);
    expect(notWorktree.json.reason).toBe("not_a_worktree");
    expect(fs.existsSync(plain)).toBe(true);

    const missing = await cli(f.work, [
      "remove",
      path.join(f.base, "never-existed"),
    ]);
    expect(missing.code).toBe(2);
    expect(missing.json.reason).toBe("not_a_worktree");
    expect(listedWorktrees(f.repo)).toEqual(before);
  });

  it("refuses to read a failed rev-list as zero unpushed commits", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "stale", path.join(f.base, "wt-stale"));
    commitHere(wt, "local.txt", "not pushed");
    // A remote-tracking ref whose object does not exist makes
    // `git rev-list HEAD --not --remotes` fail, and an empty output would
    // otherwise be read as "everything is on a remote".
    const brokenRef = path.join(
      absoluteGitPath(f.repo, "--git-common-dir"),
      "refs",
      "remotes",
      "origin",
      "stale",
    );
    fs.mkdirSync(path.dirname(brokenRef), { recursive: true });
    fs.writeFileSync(brokenRef, "0123456789012345678901234567890123456789\n");
    try {
      const r = await cli(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.status).toBe("usage_error");
      expect(r.json.reason).toBe("unpushed_state_unknown");
      expect(r.json.message).toContain("--force");
      expect(fs.existsSync(wt)).toBe(true);
      expect(listedWorktrees(f.repo)).toContain(wt);
      // Neither the worktree nor its branch was touched.
      expect(git(f.repo, ["branch", "--list", "stale"]).trim()).not.toBe("");
    } finally {
      fs.rmSync(brokenRef, { force: true });
    }
  });

  it("refuses to read a failed git status as a clean worktree", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "badindex", path.join(f.base, "wt-badindex"));
    fs.writeFileSync(
      path.join(absoluteGitPath(wt, "--git-dir"), "index"),
      "garbage",
    );

    const r = await cli(f.work, ["remove", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.status).toBe("usage_error");
    expect(r.json.reason).toBe("status_unknown");
    expect(r.json.message).toContain(wt);
    expect(r.json.message).toContain("--force");
    expect(fs.existsSync(wt)).toBe(true);
    expect(listedWorktrees(f.repo)).toContain(wt);
  });

  it("refuses a worktree that contains another worktree", async () => {
    const f = makeFixture();
    const outer = addWorktree(f, "outer", path.join(f.base, "wt-outer"));
    git(outer, ["push", "-q", "origin", "outer"]);
    // The nested checkout lives under an ignored path, so the outer worktree
    // is not dirty: the nested worktree itself is what must stop the removal.
    const exclude = path.join(
      absoluteGitPath(f.repo, "--git-common-dir"),
      "info",
      "exclude",
    );
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, "/build/\n");
    const inner = path.join(outer, "build", "inner");
    git(f.repo, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      "inner",
      inner,
      "origin/main",
    ]);
    write(inner, "a.txt", "work of the inner worktree\n");

    const r = await cli(f.work, ["remove", outer]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.status).toBe("usage_error");
    expect(r.json.reason).toBe("nested_worktree");
    expect(r.json.details.worktree).toBe(inner);
    expect(r.json.message).toContain(outer);
    expect(fs.existsSync(path.join(inner, "a.txt"))).toBe(true);
    expect(listedWorktrees(f.repo)).toContain(outer);
  });

  it("refuses --delete-branch over unpushed commits when no gh is installed", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "savelocal", path.join(f.base, "wt-savelocal"));
    commitHere(wt, "keep.txt", "never pushed");

    const r = await cli(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
    expect(fs.existsSync(wt)).toBe(true);
    expect(git(f.repo, ["branch", "--list", "savelocal"]).trim()).not.toBe("");
  });

  it("refuses --delete-branch over unpushed commits when gh knows no pull request", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "savelocal2", path.join(f.base, "wt-savelocal2"));
    commitHere(wt, "keep.txt", "never pushed");

    const r = await cli(f.work, ["remove", wt, "--delete-branch"], {
      PATH: ghStub(f, "[]"),
    });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
    expect(fs.existsSync(wt)).toBe(true);
    expect(git(f.repo, ["branch", "--list", "savelocal2"]).trim()).not.toBe("");
  });

  it("does not count a stale entry whose directory is gone as a nested worktree", async () => {
    const f = makeFixture();
    const host = addWorktree(f, "host", path.join(f.base, "wt-host"));
    git(host, ["push", "-q", "origin", "host"]);
    const exclude = path.join(
      absoluteGitPath(f.repo, "--git-common-dir"),
      "info",
      "exclude",
    );
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, "/build/\n");
    const gone = path.join(host, "build", "gone");
    git(f.repo, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      "gone",
      gone,
      "origin/main",
    ]);
    // The directory is deleted behind git's back, so the entry is listed as
    // prunable: it has nothing left inside the host worktree to lose.
    fs.rmSync(gone, { recursive: true, force: true });
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).toContain(
      "prunable",
    );

    const r = await cli(f.work, ["remove", host]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(fs.existsSync(host)).toBe(false);
    expect(listedWorktrees(f.repo)).not.toContain(host);
  });

  it("still refuses a prunable nested entry whose directory is still there", async () => {
    const f = makeFixture();
    const host = addWorktree(f, "host", path.join(f.base, "wt-host"));
    git(host, ["push", "-q", "origin", "host"]);
    const exclude = path.join(
      absoluteGitPath(f.repo, "--git-common-dir"),
      "info",
      "exclude",
    );
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, "/build/\n");
    const kept = path.join(host, "build", "kept");
    git(f.repo, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      "kept",
      kept,
      "origin/main",
    ]);
    // Only the `.git` file goes, so git lists the entry as prunable while
    // its directory, and the work in it, is still inside the host worktree.
    fs.rmSync(path.join(kept, ".git"));
    write(kept, "work.txt", "work left in the nested directory\n");
    expect(fs.existsSync(kept)).toBe(true);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).toContain(
      "prunable",
    );

    const r = await cli(f.work, ["remove", host]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.status).toBe("usage_error");
    expect(r.json.reason).toBe("nested_worktree");
    expect(r.json.details.worktree).toBe(kept);
    expect(fs.existsSync(path.join(kept, "work.txt"))).toBe(true);
    expect(listedWorktrees(f.repo)).toContain(host);
  });

  it("refuses a locked worktree, and removes it while locked with --force", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "locked", path.join(f.base, "wt-locked"));
    git(f.repo, ["worktree", "lock", wt]);

    const refused = await cli(f.work, ["remove", wt]);
    expect(refused.code, refused.stdout + refused.stderr).toBe(2);
    expect(refused.json.reason).toBe("worktree_locked");
    expect(fs.existsSync(wt)).toBe(true);
    expect(listedWorktrees(f.repo)).toContain(wt);

    const forced = await cli(f.work, ["remove", wt, "--force"]);
    expect(forced.code, forced.stdout + forced.stderr).toBe(0);
    expect(forced.json.status).toBe("ok");
    expect(fs.existsSync(wt)).toBe(false);
    expect(listedWorktrees(f.repo)).not.toContain(wt);
  });

  it("refuses a worktree with submodules before unlinking its links", async () => {
    const f = makeFixture();
    const wt = await createWithLink(f, "subbed", path.join(f.base, "wt-sub"));
    write(wt, ".gitmodules", '[submodule "vendor/lib"]\n\tpath = vendor/lib\n');
    git(wt, ["add", ".gitmodules"]);
    git(wt, ["commit", "-qm", "sub"]);
    git(wt, ["push", "-q", "origin", "subbed"]);

    const r = await cli(f.work, ["remove", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.status).toBe("usage_error");
    expect(r.json.reason).toBe("has_submodules");
    expect(r.json.message).toContain("--force");
    // Nothing was changed: the worktree and its dependency link are intact,
    // so the worktree is still there to remove with `--force` or to fix.
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink()).toBe(
      true,
    );
    expect(listedWorktrees(f.repo)).toContain(wt);
  });
});

describe("worktree remove: what it does", () => {
  it("--force overrides the dirty and the unpushed checks", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "forced", path.join(f.base, "wt-forced"));
    commitHere(wt, "local.txt", "not pushed");
    write(wt, "a.txt", "changed\n");

    const r = await cli(f.work, ["remove", wt, "--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.worktree.path).toBe(wt);
    expect(r.json.worktree.branch).toBe("forced");
    expect(fs.existsSync(wt)).toBe(false);
    expect(listedWorktrees(f.repo)).not.toContain(wt);
  });

  it("keeps the branch by default, and deletes it with --delete-branch", async () => {
    const f = makeFixture();

    const kept = addWorktree(f, "kept", path.join(f.base, "wt-kept"));
    git(kept, ["push", "-q", "origin", "kept"]);
    const first = await cli(f.work, ["remove", kept]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.json.status).toBe("ok");
    expect(first.json.pruned).toBe(true);
    expect(first.json.merged).toBeNull();
    expect(first.json.branch.deleted).toBe(false);
    expect(first.json.branch.reason).toContain("--delete-branch");
    expect(listedWorktrees(f.repo)).not.toContain(kept);
    // The branch outlives the worktree.
    expect(git(f.repo, ["branch", "--list", "kept"]).trim()).not.toBe("");

    const gone = addWorktree(f, "gone", path.join(f.base, "wt-gone"));
    git(gone, ["push", "-q", "origin", "gone"]);
    const second = await cli(f.work, ["remove", gone, "--delete-branch"]);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.json.branch.deleted).toBe(true);
    expect(second.json.merged).toMatchObject({
      merged: "yes",
      via: "ancestry",
    });
    expect(git(f.repo, ["branch", "--list", "gone"]).trim()).toBe("");
    expect(listedWorktrees(f.repo)).not.toContain(gone);
  });

  it("never deletes the branch the default base names", async () => {
    const f = makeFixture();
    // `main` cannot be checked out twice, so the default base is moved to
    // another branch instead: a worktree on `release`, with origin/HEAD
    // pointed at it.
    const rel = addWorktree(f, "release", path.join(f.base, "wt-release"));
    git(rel, ["push", "-q", "origin", "release"]);
    git(f.repo, ["remote", "set-head", "origin", "release"]);

    const r = await cli(f.work, ["remove", rel, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("default_branch_delete");
    expect(r.json.details.branch).toBe("release");
    expect(listedWorktrees(f.repo)).toContain(rel);
    expect(git(f.repo, ["branch", "--list", "release"]).trim()).not.toBe("");
  });

  it("unlinks a dependency link without following it", async () => {
    const f = makeFixture();
    fs.mkdirSync(path.join(f.repo, "node_modules", "pkg"), { recursive: true });
    write(f.repo, "node_modules/pkg/keep.txt", "x");
    const target = path.join(f.base, "wt-links");
    const made = await cli(f.work, [
      "create",
      "--repo",
      f.repo,
      "--branch",
      "links",
      "--path",
      target,
      "--link",
      "node_modules",
    ]);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    expect(
      fs.lstatSync(path.join(target, "node_modules")).isSymbolicLink(),
    ).toBe(true);

    const r = await cli(f.work, ["remove", target]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.linksRemoved).toEqual(["node_modules"]);
    expect(fs.existsSync(target)).toBe(false);
    // What the link pointed at belongs to the main checkout and stays.
    expect(
      fs.readFileSync(
        path.join(f.repo, "node_modules", "pkg", "keep.txt"),
        "utf8",
      ),
    ).toBe("x");
  });

  it("accepts --path as an alias of the positional path", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "alias-one", path.join(f.base, "wt-alias-one"));
    const r = await cli(f.work, ["remove", "--path", wt]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(listedWorktrees(f.repo)).not.toContain(wt);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("accepts the positional path and --path together when they name the same directory", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "alias-two", path.join(f.base, "wt-alias-two"));
    const r = await cli(f.work, [
      "remove",
      path.relative(f.work, wt),
      "--path",
      wt,
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(listedWorktrees(f.repo)).not.toContain(wt);
  });

  it("refuses a positional path and a different --path, naming both, and removes nothing", async () => {
    const f = makeFixture();
    const one = addWorktree(f, "alias-three", path.join(f.base, "wt-a3"));
    const two = addWorktree(f, "alias-four", path.join(f.base, "wt-a4"));
    const r = await cli(f.work, ["remove", one, "--path", two]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("option_invalid");
    expect(r.json.message).toContain(one);
    expect(r.json.message).toContain(two);
    expect(listedWorktrees(f.repo)).toContain(one);
    expect(listedWorktrees(f.repo)).toContain(two);
  });

  it("refuses when neither a positional path nor --path is given", async () => {
    const f = makeFixture();
    const r = await cli(f.work, ["remove"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("option_invalid");
    expect(r.json.message).toContain("--path");
  });
});

describe("worktree remove --require-merged", () => {
  it("accepts an ancestry merge and a squash merge that gh reports, and refuses the rest", async () => {
    const f = makeFixture();

    // (a) merged by ancestry: the branch is pushed and main is fast
    // forwarded to it.
    const anc = addWorktree(f, "ancestry", path.join(f.base, "wt-ancestry"));
    commitHere(anc, "anc.txt", "ancestry work");
    git(anc, ["push", "-q", "origin", "ancestry"]);
    const ancSha = git(anc, ["rev-parse", "HEAD"]).trim();
    git(f.repo, ["merge", "-q", "--ff-only", "ancestry"]);
    git(f.repo, ["push", "-q", "origin", "main"]);
    git(f.repo, ["fetch", "-q", "origin"]);
    expect(git(f.repo, ["rev-parse", "origin/main"]).trim()).toBe(ancSha);

    const byAncestry = await cli(f.work, ["remove", anc, "--require-merged"]);
    expect(byAncestry.code, byAncestry.stdout + byAncestry.stderr).toBe(0);
    expect(byAncestry.json.merged).toMatchObject({
      merged: "yes",
      via: "ancestry",
    });
    expect(listedWorktrees(f.repo)).not.toContain(anc);

    // (b) a squash merge leaves no ancestry: gh decides it, for the pull
    // request whose head is this worktree's own commit.
    const sq = addWorktree(f, "squashed", path.join(f.base, "wt-squashed"));
    commitHere(sq, "sq.txt", "squashed work");
    git(sq, ["push", "-q", "origin", "squashed"]);
    const sqSha = git(sq, ["rev-parse", "HEAD"]).trim();
    const byGh = await cli(f.work, ["remove", sq, "--require-merged"], {
      PATH: ghStub(
        f,
        `[{"number":7,"headRefOid":"${sqSha}","baseRefName":"main"}]`,
      ),
    });
    expect(byGh.code, byGh.stdout + byGh.stderr).toBe(0);
    expect(byGh.json.merged).toMatchObject({
      merged: "yes",
      via: "gh",
      reason: `gh lists merged pull request #7 for squashed into main at ${sqSha}`,
    });
    expect(listedWorktrees(f.repo)).not.toContain(sq);

    // (c) unmerged, and gh knows it.
    const um = addWorktree(f, "unmerged", path.join(f.base, "wt-unmerged"));
    commitHere(um, "um.txt", "unmerged work");
    git(um, ["push", "-q", "origin", "unmerged"]);
    const noPr: NodeJS.ProcessEnv = { PATH: ghStub(f, "[]") };
    const refused = await cli(f.work, ["remove", um, "--require-merged"], noPr);
    expect(refused.code, refused.stdout + refused.stderr).toBe(2);
    expect(refused.json.reason).toBe("branch_not_merged");
    expect(refused.json.details.merged).toMatchObject({
      merged: "no",
      via: "gh",
    });
    expect(listedWorktrees(f.repo)).toContain(um);

    // (d) unmerged with no gh to ask: the state cannot be told at all.
    const unknown = await cli(f.work, ["remove", um, "--require-merged"]);
    expect(unknown.code, unknown.stdout + unknown.stderr).toBe(2);
    expect(unknown.json.reason).toBe("merge_state_unknown");
    expect(unknown.json.details.merged.merged).toBe("unknown");
    expect(unknown.json.details.merged.reason).toContain("gh");
    expect(listedWorktrees(f.repo)).toContain(um);

    // An installed gh that fails decides nothing either.
    const broken = await cli(f.work, ["remove", um, "--require-merged"], {
      PATH: ghStub(f, null),
    });
    expect(broken.code, broken.stdout + broken.stderr).toBe(2);
    expect(broken.json.reason).toBe("merge_state_unknown");
    expect(listedWorktrees(f.repo)).toContain(um);

    // --force overrides the merged check. The stub is one file, so the
    // failing one above is replaced by a fresh empty answer.
    const forcedAway = await cli(
      f.work,
      ["remove", um, "--require-merged", "--force"],
      { PATH: ghStub(f, "[]") },
    );
    expect(forcedAway.code, forcedAway.stdout + forcedAway.stderr).toBe(0);
    expect(forcedAway.json.merged).toMatchObject({ merged: "no", via: "gh" });
    expect(listedWorktrees(f.repo)).not.toContain(um);
  });

  it("refuses a merged pull request that merged a different commit", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "reused", path.join(f.base, "wt-reused"));
    commitHere(wt, "r.txt", "work after the merge");
    git(wt, ["push", "-q", "origin", "reused"]);

    const r = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: ghStub(
        f,
        '[{"number":7,"headRefOid":"1111111111111111111111111111111111111111","baseRefName":"main"}]',
      ),
    });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("branch_not_merged");
    expect(r.json.details.merged).toMatchObject({ merged: "no", via: "gh" });
    expect(r.json.details.merged.reason).toContain("none into main at");
    expect(listedWorktrees(f.repo)).toContain(wt);
  });

  it("does not count a merged branch as unpushed once its remote branch is gone", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "squashgone", path.join(f.base, "wt-squashgone"));
    commitHere(wt, "sg.txt", "squashed work");
    git(wt, ["push", "-q", "origin", "squashgone"]);
    const headSha = git(wt, ["rev-parse", "HEAD"]).trim();
    // The squash merge deleted the branch on the remote, and the next fetch
    // pruned the remote-tracking ref: the commit is on no remote branch now,
    // yet gh says the pull request that carried it was merged at this sha.
    git(f.repo, ["push", "-q", "origin", "--delete", "squashgone"]);
    git(f.repo, ["fetch", "-q", "--prune", "origin"]);
    expect(
      gitTry(wt, [
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/squashgone",
      ]),
    ).toBeUndefined();

    const r = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: ghStub(
        f,
        `[{"number":9,"headRefOid":"${headSha}","baseRefName":"main"}]`,
      ),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(
      (r.json.warnings as string[]).some((w) =>
        w.includes("not counted as unpushed"),
      ),
    ).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(listedWorktrees(f.repo)).not.toContain(wt);
  });

  it("refuses a pull request merged into another branch (a stacked PR)", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "stacked", path.join(f.base, "wt-stacked"));
    commitHere(wt, "st.txt", "stacked work");
    git(wt, ["push", "-q", "origin", "stacked"]);
    const headSha = git(wt, ["rev-parse", "HEAD"]).trim();
    // The commit is on no remote branch now, and gh reports a merged pull
    // request at it, but that pull request went into `feature-a`, not into
    // the default branch the verdict is about.
    git(f.repo, ["push", "-q", "origin", "--delete", "stacked"]);
    git(f.repo, ["fetch", "-q", "--prune", "origin"]);

    const r = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: ghStub(
        f,
        `[{"number":9,"headRefOid":"${headSha}","baseRefName":"feature-a"}]`,
        { recordArgs: true },
      ),
    });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("branch_not_merged");
    expect(r.json.details.merged).toMatchObject({ merged: "no", via: "gh" });
    expect(r.json.details.merged.reason).toContain("none into main");
    // The stub ignores its arguments, so the base filter gh was asked for is
    // pinned here: the lookup asks only for pull requests into the default
    // branch, with the fields the verdict reads.
    const calls = ghArgs(f);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--base main");
    expect(calls[0]).toContain("number,headRefOid,baseRefName");
    expect(fs.existsSync(wt)).toBe(true);
    expect(listedWorktrees(f.repo)).toContain(wt);
  });

  it("takes the one merged pull request that matches the commit from several", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "several", path.join(f.base, "wt-several"));
    commitHere(wt, "s.txt", "several work");
    git(wt, ["push", "-q", "origin", "several"]);
    const headSha = git(wt, ["rev-parse", "HEAD"]).trim();

    const r = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: ghStub(
        f,
        `[{"number":3,"headRefOid":"1111111111111111111111111111111111111111","baseRefName":"main"},{"number":4,"headRefOid":"${headSha}","baseRefName":"main"}]`,
      ),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(r.json.merged.reason).toContain("#4");
    expect(listedWorktrees(f.repo)).not.toContain(wt);
  });
});

describe("worktree list", () => {
  it("reports the state of every worktree of a repository", async () => {
    const f = makeFixture();
    // Set up first, because it moves `origin/main` ahead of the base the
    // other worktrees are then started from.
    const merged = addWorktree(f, "mergedanc", path.join(f.base, "wt-merged"));
    commitHere(merged, "merged.txt", "merged work");
    git(merged, ["push", "-q", "origin", "mergedanc"]);
    git(f.repo, ["merge", "-q", "--ff-only", "mergedanc"]);
    git(f.repo, ["push", "-q", "origin", "main"]);

    const clean = addWorktree(f, "clean", path.join(f.base, "wt-clean"));
    const dirty = addWorktree(f, "dirtyst", path.join(f.base, "wt-dirty"));
    write(dirty, "dirt.txt", "d\n");
    const ahead = addWorktree(f, "aheadb", path.join(f.base, "wt-ahead"));
    commitHere(ahead, "ahead.txt", "one commit ahead");
    const run = addWorktree(f, "pointered", path.join(f.base, "wt-run"));
    const runDir = path.join(f.base, "runs", "one");
    write(run, ".ai/run", `${runDir}\n`);

    const r = await cli(f.work, ["list", "--repo", f.repo]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.command).toBe("worktree list");
    expect(r.json.status).toBe("ok");
    const entries = r.json.worktrees as Record<string, any>[];
    const byPath = new Map(entries.map((w) => [w.path, w]));
    const entryAt = (p: string): Record<string, any> => {
      const found = byPath.get(p);
      if (found === undefined) throw new Error(`no entry for ${p}`);
      return found;
    };

    // The main checkout comes first and is the only `main: true`.
    expect(entries[0].path).toBe(f.repo);
    expect(entries[0].main).toBe(true);
    expect(entries[0].repo).toBe("repo");
    expect(entries.filter((w) => w.main)).toHaveLength(1);
    expect(entries.every((w) => w.base === "origin/main")).toBe(true);

    expect(entryAt(clean)).toMatchObject({
      main: false,
      branch: "clean",
      dirty: false,
      ahead: 0,
      behind: 0,
      runPointer: null,
      links: [],
      prunable: false,
      locked: false,
    });
    expect(entryAt(clean).merged).toMatchObject({
      merged: "yes",
      via: "ancestry",
    });
    expect(entryAt(dirty).dirty).toBe(true);
    expect(entryAt(ahead)).toMatchObject({ ahead: 1, behind: 0 });
    // Not an ancestor, and no gh to ask about a squash merge.
    expect(entryAt(ahead).merged.merged).toBe("unknown");
    expect(entryAt(merged)).toMatchObject({ dirty: false, ahead: 0 });
    expect(entryAt(merged).merged).toMatchObject({
      merged: "yes",
      via: "ancestry",
    });
    expect(entryAt(run)).toMatchObject({ runPointer: runDir, dirty: false });
  });

  it("with --root reports the work trees below a directory, and nothing else", async () => {
    const f = makeFixture();
    const wts = path.join(f.base, "wts");
    fs.mkdirSync(wts);
    const one = addWorktree(f, "one", path.join(wts, "wt-one"));
    const two = addWorktree(f, "two", path.join(wts, "wt-two"));
    fs.mkdirSync(path.join(wts, "plain-dir"));

    const r = await cli(f.work, ["list", "--root", wts]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entries = r.json.worktrees as Record<string, any>[];
    expect(entries.map((w) => w.path)).toEqual([one, two]);
    expect(entries.every((w) => w.repo === "repo" && !w.main)).toBe(true);

    const both = await cli(f.work, ["list", "--repo", f.repo, "--root", wts]);
    expect(both.code, both.stdout + both.stderr).toBe(2);
    expect(both.json.reason).toBe("option_invalid");
  });

  it("with --root skips a child whose repository it cannot resolve", async () => {
    const f = makeFixture();
    const wts = path.join(f.base, "wts");
    fs.mkdirSync(wts);
    const one = addWorktree(f, "one", path.join(wts, "wt-one"));
    const two = addWorktree(f, "two", path.join(wts, "wt-two"));
    // A work tree of a BARE repository: it is a work tree top, so the walk
    // reaches it, but it has no main checkout to describe it from.
    const bare = path.join(f.base, "bare.git");
    git(f.base, ["init", "-q", "--bare", "-b", "main", bare]);
    git(f.repo, ["push", "-q", bare, "main"]);
    const bareWt = path.join(wts, "bare-wt");
    git(f.base, ["--git-dir", bare, "worktree", "add", bareWt, "main"]);

    const r = await cli(f.work, ["list", "--root", wts]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    const entries = r.json.worktrees as Record<string, any>[];
    expect(entries.map((w) => w.path)).toEqual([one, two]);
    const warnings = r.json.warnings as string[];
    expect(warnings.some((w) => w.startsWith(`skipped ${bareWt}`))).toBe(true);
  });

  it("reports the dependency links a worktree was created with", async () => {
    const f = makeFixture();
    const wt = await createWithLink(
      f,
      "listed",
      path.join(f.base, "wt-listed"),
    );

    const r = await cli(f.work, ["list", "--repo", f.repo]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entries = r.json.worktrees as Record<string, any>[];
    const listed = entries.find((w) => w.path === wt);
    if (listed === undefined) throw new Error(`no entry for ${wt}`);
    expect(listed.links).toContain("node_modules");
  });
});

/** A hotfix branch the way a repository whose default branch is `main`
 * still ships one: `origin/hotfixbase` is a second long-lived branch, the
 * hotfix worktree is cut from it and carries one commit. Returns the
 * worktree and its head sha. */
function makeHotfix(f: Fixture): { wt: string; sha: string } {
  git(f.repo, ["push", "-q", "origin", "main:hotfixbase"]);
  git(f.repo, ["fetch", "-q", "origin"]);
  const wt = path.join(f.base, "wt-hotfix");
  git(f.repo, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    "hotfix/one",
    wt,
    "origin/hotfixbase",
  ]);
  commitHere(wt, "fix.txt", "hotfix work");
  git(wt, ["push", "-q", "origin", "hotfix/one"]);
  return { wt, sha: git(wt, ["rev-parse", "HEAD"]).trim() };
}

describe("worktree list --base", () => {
  it("measures against the given base, by ancestry and by the gh lookup", async () => {
    const f = makeFixture();
    const { wt, sha } = makeHotfix(f);
    const prStub = ghStub(
      f,
      `[{"number":9,"headRefOid":"${sha}","baseRefName":"hotfixbase"}]`,
      { recordArgs: true },
    );
    const entryAt = (r: Cli): Record<string, any> => {
      const found = (r.json.worktrees as Record<string, any>[]).find(
        (w) => w.path === wt,
      );
      if (found === undefined) throw new Error(`no entry for ${wt}`);
      return found;
    };

    // Unchanged without --base: measured against origin/main, where the
    // pull request into hotfixbase says nothing.
    const plain = await cli(f.work, ["list", "--repo", f.repo], {
      PATH: prStub,
    });
    expect(plain.code, plain.stdout + plain.stderr).toBe(0);
    expect(entryAt(plain)).toMatchObject({
      base: "origin/main",
      ahead: 1,
      behind: 0,
    });
    expect(entryAt(plain).merged).toMatchObject({ merged: "no", via: "gh" });

    // With --base, the gh lookup asks for the branch name without origin/.
    const based = await cli(
      f.work,
      ["list", "--repo", f.repo, "--base", "origin/hotfixbase"],
      { PATH: prStub },
    );
    expect(based.code, based.stdout + based.stderr).toBe(0);
    expect(entryAt(based)).toMatchObject({
      base: "origin/hotfixbase",
      ahead: 1,
      behind: 0,
    });
    expect(entryAt(based).merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(ghArgs(f).some((line) => line.includes("--base hotfixbase"))).toBe(
      true,
    );

    // Merged by ancestry once the base holds the commit.
    git(f.repo, ["push", "-q", "origin", `${sha}:refs/heads/hotfixbase`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const anc = await cli(f.work, [
      "list",
      "--repo",
      f.repo,
      "--base",
      "origin/hotfixbase",
    ]);
    expect(anc.code, anc.stdout + anc.stderr).toBe(0);
    expect(entryAt(anc)).toMatchObject({ ahead: 0, behind: 0 });
    expect(entryAt(anc).merged).toMatchObject({
      merged: "yes",
      via: "ancestry",
    });
  });

  it("reports an unresolvable base as unknown with a warning, per repository, without aborting", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const wts = path.join(f.base, "wts");
    fs.mkdirSync(wts);
    fs.renameSync(wt, path.join(wts, "moved"));
    git(f.repo, ["worktree", "repair", path.join(wts, "moved")]);
    // A second repository that does resolve a revision the first one lacks.
    const other = path.join(f.base, "other");
    git(f.base, ["clone", "-q", f.origin, other]);
    git(other, [
      "push",
      "-q",
      "origin",
      "origin/hotfixbase:refs/heads/onlyhere",
    ]);
    git(other, ["fetch", "-q", "origin"]);
    git(other, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      "o1",
      path.join(wts, "other-wt"),
      "origin/hotfixbase",
    ]);

    const mixed = await cli(f.work, [
      "list",
      "--root",
      wts,
      "--base",
      "origin/onlyhere",
    ]);
    expect(mixed.code, mixed.stdout + mixed.stderr).toBe(0);
    const entries = mixed.json.worktrees as Record<string, any>[];
    const resolved = entries.find((w) => w.repo === "other");
    const unresolved = entries.find((w) => w.repo === "repo");
    expect(resolved?.merged).toMatchObject({ merged: "yes", via: "ancestry" });
    expect(resolved?.base).toBe("origin/onlyhere");
    expect(unresolved?.merged.merged).toBe("unknown");
    expect(
      (mixed.json.warnings as string[]).filter((w) =>
        w.includes("origin/onlyhere"),
      ),
    ).toHaveLength(1);

    // Same call with a revision no repository knows.
    const none = await cli(f.work, [
      "list",
      "--root",
      wts,
      "--base",
      "origin/nope",
    ]);
    expect(none.code, none.stdout + none.stderr).toBe(0);
    const all = none.json.worktrees as Record<string, any>[];
    expect(all).toHaveLength(2);
    for (const w of all) {
      expect(w.base).toBe("origin/nope");
      expect(w.merged.merged).toBe("unknown");
      expect(w.merged.reason).toContain("--base origin/nope");
      expect(w.ahead).toBeNull();
    }
    const warnings = none.json.warnings as string[];
    expect(
      warnings.filter((w) => w.includes("--base origin/nope")),
    ).toHaveLength(2);
  });
});

describe("worktree remove --base", () => {
  it("checks the merge against the given base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeHotfix(f);
    const prStub = ghStub(
      f,
      `[{"number":9,"headRefOid":"${sha}","baseRefName":"hotfixbase"}]`,
    );

    const without = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: prStub,
    });
    expect(without.code, without.stdout + without.stderr).toBe(2);
    expect(without.json.reason).toBe("branch_not_merged");
    expect(listedWorktrees(f.repo)).toContain(wt);

    const withBase = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--base", "origin/hotfixbase"],
      { PATH: prStub },
    );
    expect(withBase.code, withBase.stdout + withBase.stderr).toBe(0);
    expect(withBase.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(listedWorktrees(f.repo)).not.toContain(wt);
  });

  it("applies to --delete-branch as well", async () => {
    const f = makeFixture();
    const { wt, sha } = makeHotfix(f);
    git(f.repo, ["push", "-q", "origin", `${sha}:refs/heads/hotfixbase`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    git(f.repo, ["push", "-q", "origin", "--delete", "hotfix/one"]);
    git(f.repo, ["fetch", "-q", "--prune", "origin"]);
    const r = await cli(f.work, [
      "remove",
      wt,
      "--delete-branch",
      "--base",
      "origin/hotfixbase",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "ancestry" });
    expect(r.json.branch.deleted).toBe(true);
  });

  it("refuses an unresolvable base with its own reason and removes nothing", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const cases: [string, string][] = [
      ["origin/nope", "base_not_found"],
      ["--upload-pack=x", "base_not_remote_branch"],
    ];
    for (const [bad, reason] of cases) {
      const r = await cli(f.work, [
        "remove",
        wt,
        "--require-merged",
        `--base=${bad}`,
        "--force",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe(reason);
      expect(r.json.details.base).toBe(bad);
      expect(listedWorktrees(f.repo)).toContain(wt);
      expect(fs.existsSync(wt)).toBe(true);
    }
  });

  it("treats --base without a merge check as a usage error", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const r = await cli(f.work, ["remove", wt, "--base", "origin/hotfixbase"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("option_invalid");
    expect(listedWorktrees(f.repo)).toContain(wt);
  });

  it("refuses a base that is no remote-tracking branch, even with --force, and keeps the worktree and its branch", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    // An unpushed commit on top: a merged verdict against a local base or a
    // relative rev must never excuse it.
    commitHere(wt, "more.txt", "unpushed work");
    git(f.repo, ["branch", "localbase", "hotfix/one"]);
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    git(f.repo, ["tag", "sometag", "hotfix/one"]);
    for (const bad of [
      "HEAD",
      "HEAD~1",
      "localbase",
      "hotfix/one",
      sha,
      "sometag",
      "@{u}",
      "refs/heads/localbase",
      "origin/HEAD",
      "origin",
    ]) {
      for (const extra of [[], ["--force"]]) {
        const r = await cli(f.work, [
          "remove",
          wt,
          "--delete-branch",
          `--base=${bad}`,
          ...extra,
        ]);
        expect(r.code, `${bad}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.json.reason, bad).toBe("base_not_remote_branch");
        expect(listedWorktrees(f.repo)).toContain(wt);
        expect(gitTry(f.repo, ["rev-parse", "--verify", "hotfix/one"])).toBe(
          `${sha}\n`,
        );
      }
    }
  });

  it("reads the remote-tracking ref by its full name when a local branch shadows the short spelling", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    commitHere(wt, "more.txt", "unpushed work");
    git(f.repo, ["branch", "origin/hotfixbase", "hotfix/one"]);
    const r = await cli(f.work, [
      "remove",
      wt,
      "--delete-branch",
      "--base",
      "origin/hotfixbase",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
    expect(listedWorktrees(f.repo)).toContain(wt);
    expect(
      gitTry(f.repo, ["rev-parse", "--verify", "hotfix/one"]),
    ).toBeDefined();
  });

  it("refuses rev syntax after a valid remote prefix, with and without --require-merged or --force", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    commitHere(wt, "more.txt", "unpushed work");
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    const bads = [
      "origin/hotfixbase@{1}",
      "refs/remotes/origin/hotfixbase@{1}",
      "origin/hotfixbase~0",
      "origin/hotfixbase^",
      "origin/hotfixbase^{commit}",
      "origin/hotfixbase..HEAD",
    ];
    const flagSets = [
      ["--delete-branch"],
      ["--require-merged"],
      ["--delete-branch", "--require-merged"],
      ["--delete-branch", "--force"],
      ["--require-merged", "--force"],
    ];
    for (const bad of bads) {
      for (const flags of flagSets) {
        const r = await cli(f.work, ["remove", wt, ...flags, `--base=${bad}`]);
        expect(
          r.code,
          `${bad} ${flags.join(" ")}: ${r.stdout}${r.stderr}`,
        ).toBe(2);
        expect(r.json.reason, bad).toBe("base_not_remote_branch");
        expect(listedWorktrees(f.repo)).toContain(wt);
      }
      const l = await cli(f.work, ["list", "--repo", f.repo, `--base=${bad}`]);
      expect(l.code, `${bad}: ${l.stdout}${l.stderr}`).toBe(2);
      expect(l.json.reason, bad).toBe("base_not_remote_branch");
    }
    expect(gitTry(f.repo, ["rev-parse", "--verify", "hotfix/one"])).toBe(
      `${sha}\n`,
    );
  });

  it("does not let a reflog entry of the remote-tracking branch excuse commits no ref holds", async () => {
    const f = makeFixture();
    const { wt, sha: c1 } = makeHotfix(f);
    commitHere(wt, "c2.txt", "second commit");
    const c2 = git(wt, ["rev-parse", "HEAD"]).trim();
    git(wt, ["push", "-q", "origin", "hotfix/one"]);
    git(wt, ["push", "-q", "--force", "origin", `${c1}:refs/heads/hotfix/one`]);
    // The reflog now says origin/hotfix/one@{1} is c2, while no ref holds it.
    expect(git(f.repo, ["rev-parse", "origin/hotfix/one@{1}"]).trim()).toBe(c2);
    for (const base of [
      "origin/hotfix/one@{1}",
      "refs/remotes/origin/hotfix/one@{1}",
    ]) {
      for (const flags of [
        ["--delete-branch"],
        ["--require-merged"],
        ["--delete-branch", "--require-merged", "--force"],
      ]) {
        const r = await cli(f.work, ["remove", wt, ...flags, `--base=${base}`]);
        expect(r.code, `${base}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.json.reason).toBe("base_not_remote_branch");
      }
    }
    expect(listedWorktrees(f.repo)).toContain(wt);
    expect(git(f.repo, ["rev-parse", "hotfix/one"]).trim()).toBe(c2);
  });

  it("refuses a base whose name only exists as a local branch or tag spelled like the remote ref", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    commitHere(wt, "more.txt", "unpushed work");
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    // `origin/ghost` is no remote-tracking ref, but git's rev lookup finds
    // these two under that spelling.
    git(f.repo, ["update-ref", "refs/heads/refs/remotes/origin/ghost", sha]);
    git(f.repo, ["update-ref", "refs/tags/refs/remotes/origin/ghost2", sha]);
    for (const ghost of ["origin/ghost", "origin/ghost2"]) {
      for (const flags of [
        ["--delete-branch"],
        ["--require-merged"],
        ["--delete-branch", "--require-merged"],
      ]) {
        const r = await cli(f.work, [
          "remove",
          wt,
          ...flags,
          `--base=${ghost}`,
        ]);
        expect(r.code, `${ghost}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.json.reason, ghost).toBe("base_not_found");
        expect(listedWorktrees(f.repo)).toContain(wt);
      }
      const l = await cli(f.work, [
        "list",
        "--repo",
        f.repo,
        `--base=${ghost}`,
      ]);
      expect(l.code, l.stdout + l.stderr).toBe(0);
      for (const w of l.json.worktrees as Record<string, any>[]) {
        expect(w.merged.merged).toBe("unknown");
      }
    }
    expect(git(f.repo, ["rev-parse", "hotfix/one"]).trim()).toBe(sha);
  });

  it("still refuses unpushed commits over a remote-tracking base that does not contain them", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    commitHere(wt, "more.txt", "unpushed work");
    const r = await cli(f.work, [
      "remove",
      wt,
      "--delete-branch",
      "--base",
      "origin/hotfixbase",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(listedWorktrees(f.repo)).toContain(wt);
  });

  it("refuses a symbolic remote-tracking ref that points at the worktree branch, with and without --force", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    commitHere(wt, "more.txt", "unpushed work");
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/self",
      "refs/heads/hotfix/one",
    ]);
    for (const extra of [[], ["--force"]]) {
      const r = await cli(f.work, [
        "remove",
        wt,
        "--require-merged",
        "--delete-branch",
        "--base",
        "origin/self",
        ...extra,
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("base_not_remote_branch");
      expect(listedWorktrees(f.repo)).toContain(wt);
      expect(git(f.repo, ["rev-parse", "hotfix/one"]).trim()).toBe(sha);
    }
  });

  it("refuses a symbolic remote-tracking ref that points at another local branch holding unpushed work", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    commitHere(wt, "more.txt", "unpushed work");
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    git(f.repo, ["branch", "elsewhere", "hotfix/one"]);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/other",
      "refs/heads/elsewhere",
    ]);
    for (const extra of [[], ["--force"]]) {
      const r = await cli(f.work, [
        "remove",
        wt,
        "--require-merged",
        "--delete-branch",
        "--base",
        "origin/other",
        ...extra,
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("base_not_remote_branch");
      expect(listedWorktrees(f.repo)).toContain(wt);
      expect(git(f.repo, ["rev-parse", "hotfix/one"]).trim()).toBe(sha);
    }
  });

  it("refuses a plain refs/remotes/origin/HEAD that is not symbolic", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    commitHere(wt, "more.txt", "unpushed work");
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    // Replace the symbolic remote HEAD by a plain ref at the worktree head.
    git(f.repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    git(f.repo, ["update-ref", "refs/remotes/origin/HEAD", sha]);
    expect(
      gitTry(f.repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
    ).toBeUndefined();
    for (const extra of [[], ["--force"]]) {
      const r = await cli(f.work, [
        "remove",
        wt,
        "--require-merged",
        "--delete-branch",
        "--base",
        "origin/HEAD",
        ...extra,
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("base_not_remote_branch");
      expect(listedWorktrees(f.repo)).toContain(wt);
      expect(git(f.repo, ["rev-parse", "hotfix/one"]).trim()).toBe(sha);
    }
  });
});

describe("worktree --base with a remote other than origin", () => {
  it("takes the longest configured remote name when one remote name prefixes another", async () => {
    const f = makeFixture();
    makeHotfix(f);
    // `git remote add` refuses a name nested in another remote's name, but
    // the configuration can hold both.
    git(f.repo, ["config", "remote.up.url", f.origin]);
    git(f.repo, ["config", "remote.up/stream.url", f.origin]);
    expect(git(f.repo, ["remote"]).split("\n")).toEqual(
      expect.arrayContaining(["up", "up/stream"]),
    );
    // At main, which the hotfix branch is ahead of: ancestry cannot decide,
    // so the gh lookup runs.
    git(f.repo, ["update-ref", "refs/remotes/up/stream/x", f.mainSha]);
    const stub = ghStub(f, "[]", { recordArgs: true });
    const r = await cli(
      f.work,
      ["list", "--repo", f.repo, "--base", "up/stream/x"],
      { PATH: stub },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const lines = ghArgs(f);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes("--base x"))).toBe(true);
    expect(lines.some((l) => l.includes("--base stream/x"))).toBe(false);
  });

  it("derives the gh base from the remote name, for short and full refs", async () => {
    const f = makeFixture();
    const { wt, sha } = makeHotfix(f);
    git(f.repo, ["remote", "add", "upstream", f.origin]);
    git(f.repo, ["fetch", "-q", "upstream"]);
    const stub = ghStub(
      f,
      `[{"number":9,"headRefOid":"${sha}","baseRefName":"hotfixbase"}]`,
      { recordArgs: true },
    );
    for (const base of [
      "upstream/hotfixbase",
      "refs/remotes/upstream/hotfixbase",
      "refs/remotes/origin/hotfixbase",
    ]) {
      const r = await cli(f.work, ["list", "--repo", f.repo, "--base", base], {
        PATH: stub,
      });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const entry = (r.json.worktrees as Record<string, any>[]).find(
        (w) => w.path === wt,
      );
      expect(entry?.base).toBe(base);
      expect(entry?.merged, base).toMatchObject({ merged: "yes", via: "gh" });
    }
    const lines = ghArgs(f);
    expect(lines.length).toBe(3);
    expect(lines.every((l) => l.includes("--base hotfixbase"))).toBe(true);
    expect(lines.some((l) => l.includes("upstream"))).toBe(false);

    const rm = await cli(
      f.work,
      ["remove", wt, "--require-merged", "--base", "upstream/hotfixbase"],
      { PATH: stub },
    );
    expect(rm.code, rm.stdout + rm.stderr).toBe(0);
    expect(ghArgs(f).at(-1)).toContain("--base hotfixbase");
  });
});

describe("worktree list --base resolution", () => {
  it("reports a well-formed base that does not exist as unknown with exactly one warning", async () => {
    const f = makeFixture();
    makeHotfix(f);
    const r = await cli(f.work, [
      "list",
      "--repo",
      f.repo,
      "--base",
      "origin/nope",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entries = r.json.worktrees as Record<string, any>[];
    expect(entries.length).toBeGreaterThan(1);
    for (const w of entries) {
      expect(w.base).toBe("origin/nope");
      expect(w.merged.merged).toBe("unknown");
    }
    expect(r.json.warnings as string[]).toHaveLength(1);
    expect((r.json.warnings as string[])[0]).toContain("origin/nope");
  });

  it("refuses a base that is no remote-tracking branch", async () => {
    const f = makeFixture();
    makeHotfix(f);
    for (const bad of ["HEAD", "HEAD~1", "main", "--x", "@{u}"]) {
      const r = await cli(f.work, ["list", "--repo", f.repo, `--base=${bad}`]);
      expect(r.code, `${bad}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.json.reason, bad).toBe("base_not_remote_branch");
    }
  });

  it("with --root, a repository that lacks the remote gives unknown and a warning", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const wts = path.join(f.base, "wts");
    fs.mkdirSync(wts);
    fs.renameSync(wt, path.join(wts, "moved"));
    git(f.repo, ["worktree", "repair", path.join(wts, "moved")]);
    const r = await cli(f.work, [
      "list",
      "--root",
      wts,
      "--base",
      "elsewhere/main",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entries = r.json.worktrees as Record<string, any>[];
    expect(entries).toHaveLength(1);
    expect(entries[0].merged.merged).toBe("unknown");
    expect(entries[0].ahead).toBeNull();
    expect((r.json.warnings as string[]).length).toBe(1);
  });

  it("measures against the full remote-tracking ref when a local branch shadows its short spelling", async () => {
    const f = makeFixture();
    const { wt, sha } = makeHotfix(f);
    const second = addWorktree(f, "second", path.join(f.base, "wt-second"));
    commitHere(second, "s.txt", "second");
    commitHere(second, "s2.txt", "second again");
    // A local branch that shadows the short spelling must not matter: the
    // remote-tracking ref is read by its full name.
    git(f.repo, ["branch", "origin/hotfixbase", "second"]);
    const r = await cli(f.work, [
      "list",
      "--repo",
      f.repo,
      "--base",
      "origin/hotfixbase",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entries = r.json.worktrees as Record<string, any>[];
    const hot = entries.find((w) => w.path === wt);
    const sec = entries.find((w) => w.path === second);
    expect(hot).toMatchObject({ ahead: 1, behind: 0 });
    // second was cut from origin/main, which is the hotfix base's commit.
    // The shadowing local branch sits at second's own HEAD, so measuring
    // against the short spelling would give 0 and 0 here.
    expect(sec).toMatchObject({ ahead: 2, behind: 0 });
    expect(sha).toHaveLength(40);
  });
});

describe("worktree list --root: a --base that can never be a remote-tracking branch", () => {
  it.each([
    ["empty", ""],
    ["leading dash", "-x"],
    ["leading dash with a slash", "-x/main"],
    ["HEAD", "HEAD"],
    ["a sha", "0123456789abcdef0123456789abcdef01234567"],
    ["remote HEAD", "origin/HEAD"],
    ["rev syntax", "origin/main~1"],
  ])("refuses %s up front, with no repository looked at", async (_n, bad) => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const wts = path.join(f.base, "wts");
    fs.mkdirSync(wts);
    fs.renameSync(wt, path.join(wts, "moved"));
    git(f.repo, ["worktree", "repair", path.join(wts, "moved")]);
    const r = await cli(f.work, ["list", "--root", wts, `--base=${bad}`]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("base_not_remote_branch");
  });

  it("refuses before --root is read, so a missing directory does not mask it", async () => {
    const f = makeFixture();
    const r = await cli(f.work, [
      "list",
      "--root",
      path.join(f.base, "no-such-dir"),
      "--base=HEAD",
    ]);
    expect(r.json.reason).toBe("base_not_remote_branch");
  });

  it("control: a well-formed value for a ref a repository lacks stays a warning", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const wts = path.join(f.base, "wts");
    fs.mkdirSync(wts);
    fs.renameSync(wt, path.join(wts, "moved"));
    git(f.repo, ["worktree", "repair", path.join(wts, "moved")]);
    const r = await cli(f.work, [
      "list",
      "--root",
      wts,
      "--base",
      "origin/nothere",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect((r.json.warnings as string[]).length).toBe(1);
  });
});

describe("worktree list: why an entry is prunable", () => {
  it("says the directory is gone when it is", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "gone", path.join(f.base, "wt-gone"));
    fs.rmSync(wt, { recursive: true, force: true });
    const r = await cli(f.work, ["list", "--repo", f.repo]);
    const entry = (r.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === wt,
    )!;
    expect(entry.prunable).toBe(true);
    expect(entry.merged.reason).toContain("prunable: the directory is gone");
  });

  it("does not say the directory is gone when it still exists", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "kept", path.join(f.base, "wt-kept"));
    fs.rmSync(path.join(wt, ".git"));
    write(wt, "work.txt", "work\n");
    const r = await cli(f.work, ["list", "--repo", f.repo]);
    const entry = (r.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === wt,
    )!;
    expect(entry.prunable).toBe(true);
    expect(entry.dirty).toBeNull();
    expect(entry.merged.merged).toBe("unknown");
    expect(entry.merged.reason).toContain("still exists");
    expect(entry.merged.reason).not.toContain("is gone");
    expect(fs.existsSync(path.join(wt, "work.txt"))).toBe(true);
  });
});

describe("resolveRemoteBase: defence-in-depth checks", () => {
  it("the control: origin/main resolves to its full remote-tracking ref", () => {
    const f = makeFixture();
    expect(resolveRemoteBase(f.repo, "origin/main")).toEqual({
      ok: true,
      base: {
        ref: "refs/remotes/origin/main",
        remote: "origin",
        branch: "main",
      },
    });
  });

  it("refuses a value starting with a dash even when a remote of that name exists", () => {
    const f = makeFixture();
    git(f.repo, ["config", "remote.-origin.url", f.origin]);
    git(f.repo, ["update-ref", "refs/remotes/-origin/x", f.mainSha]);
    // The ref itself is well-formed and exists, so only the leading-dash
    // check stands between this value and an ok result.
    expect(
      git(f.repo, ["show-ref", "--verify", "refs/remotes/-origin/x"]),
    ).toContain(f.mainSha);
    expect(resolveRemoteBase(f.repo, "-origin/x")).toEqual({
      ok: false,
      reason: "base_not_remote_branch",
    });
  });

  it("refuses a remote-tracking ref that points at a tree instead of a commit", () => {
    const f = makeFixture();
    const tree = git(f.repo, ["rev-parse", "HEAD^{tree}"]).trim();
    git(f.repo, ["update-ref", "refs/remotes/origin/tree", tree]);
    // show-ref accepts it, so only the commit check refuses it.
    expect(
      git(f.repo, ["show-ref", "--verify", "refs/remotes/origin/tree"]),
    ).toContain(tree);
    expect(resolveRemoteBase(f.repo, "origin/tree")).toEqual({
      ok: false,
      reason: "base_not_found",
    });
  });
});

describe("worktree list: the default base", () => {
  it("shows origin/main and measures a normal layout as before", async () => {
    const f = makeFixture();
    const ahead = addWorktree(f, "aheadb", path.join(f.base, "wt-ahead"));
    commitHere(ahead, "ahead.txt", "one commit ahead");
    const r = await cli(f.work, ["list", "--repo", f.repo]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entries = r.json.worktrees as Record<string, any>[];
    expect(entries.every((w) => w.base === "origin/main")).toBe(true);
    expect(entries.find((w) => w.path === ahead)).toMatchObject({
      ahead: 1,
      behind: 0,
    });
    expect(entries[0].merged).toMatchObject({
      reason: "HEAD is an ancestor of origin/main",
    });
  });

  it("shows git's unambiguous name and measures the remote-tracking ref when a local branch shadows it at the same commit", async () => {
    const f = makeFixture();
    const ahead = addWorktree(f, "aheadb", path.join(f.base, "wt-ahead"));
    commitHere(ahead, "ahead.txt", "one commit ahead");
    git(f.repo, ["branch", "origin/main", f.mainSha]);
    const r = await cli(f.work, ["list", "--repo", f.repo]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entries = r.json.worktrees as Record<string, any>[];
    expect(entries.every((w) => w.base === "remotes/origin/main")).toBe(true);
    expect(entries.find((w) => w.path === ahead)).toMatchObject({
      ahead: 1,
      behind: 0,
    });
    expect(entries.find((w) => w.path === ahead)?.merged).toMatchObject({
      merged: "unknown",
    });
    expect(entries[0].merged).toMatchObject({
      merged: "yes",
      reason: "HEAD is an ancestor of remotes/origin/main",
    });
  });

  it("measures the remote-tracking ref, not a shadowing local branch at another commit", async () => {
    const f = makeFixture();
    const second = addWorktree(f, "second", path.join(f.base, "wt-second"));
    commitHere(second, "s.txt", "second");
    commitHere(second, "s2.txt", "second again");
    // The shadow sits at second's own HEAD: measured against it, second
    // would be ahead by 0 and its merged state would be "yes".
    git(f.repo, ["branch", "origin/main", "second"]);
    const r = await cli(f.work, ["list", "--repo", f.repo]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entry = (r.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === second,
    );
    expect(entry).toMatchObject({
      base: "remotes/origin/main",
      ahead: 2,
      behind: 0,
    });
    expect(entry?.merged.merged).not.toBe("yes");
  });

  it("shows and measures origin/main when a local branch is spelled refs/remotes/origin/main", async () => {
    const f = makeFixture();
    const ahead = addWorktree(f, "aheadb", path.join(f.base, "wt-ahead"));
    commitHere(ahead, "ahead.txt", "one commit ahead");
    // A branch of this name makes the full ref ambiguous for every command
    // that resolves it as a name; git's listing of the exact ref is not.
    git(f.repo, [
      "update-ref",
      "refs/heads/refs/remotes/origin/main",
      commitOn(f, f.mainSha),
    ]);
    const r = await cli(f.work, ["list", "--repo", f.repo]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    const entries = r.json.worktrees as Record<string, any>[];
    expect(entries.every((w) => w.base === "origin/main")).toBe(true);
    expect(entries.find((w) => w.path === ahead)).toMatchObject({
      ahead: 1,
      behind: 0,
    });
    expect(entries[0].merged).toMatchObject({ merged: "yes" });
  });

  it.each([
    ["fails", "echo 'fatal: injected abbrev failure' >&2; exit 128"],
    ["prints nothing", "exit 0"],
  ])(
    "falls back to the full ref as the shown base when git's abbreviation %s",
    async (_name, action) => {
      const f = makeFixture();
      const PATH = gitWrapper(
        f,
        "git-no-abbrev",
        `for a in "$@"; do
  case "$a" in '--format=%(refname:short)') ${action};; esac
done`,
      );
      const r = await cli(f.work, ["list", "--repo", f.repo], { PATH });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const entries = r.json.worktrees as Record<string, any>[];
      expect(entries.every((w) => w.base === "refs/remotes/origin/main")).toBe(
        true,
      );
      expect(entries[0].merged).toMatchObject({ merged: "yes" });
    },
  );

  it("reads origin's default base once per repository, not once per worktree", async () => {
    const f = makeFixture();
    addWorktree(f, "one", path.join(f.base, "wt-one"));
    addWorktree(f, "two", path.join(f.base, "wt-two"));
    addWorktree(f, "three", path.join(f.base, "wt-three"));
    const log = path.join(f.base, "git-calls.log");
    const PATH = gitWrapper(f, "git-logging", `echo "$@" >> '${log}'`);
    const r = await cli(f.work, ["list", "--repo", f.repo], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.worktrees).toHaveLength(4);
    const calls = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.includes("refs/remotes/origin/HEAD"));
    expect(calls).toHaveLength(1);
  });
});

describe("ignoredSymlinks", () => {
  it("finds an excluded directory symlink and no other ignored path", () => {
    const f = makeFixture();
    const wt = addWorktree(f, "unit", path.join(f.base, "wt-unit"));
    fs.mkdirSync(path.join(wt, "real-dir"));
    write(wt, "real-dir/lib.txt", "l\n");
    write(wt, "ignored-file", "i\n");
    fs.appendFileSync(
      path.join(f.repo, ".git", "info", "exclude"),
      "/link-dir\n/ignored-file\n",
    );
    fs.symlinkSync(path.join(wt, "real-dir"), path.join(wt, "link-dir"));

    expect(ignoredSymlinks(wt)).toEqual(["link-dir"]);
  });
});

/** A worktree on `feat` carrying one commit that no remote has. Returns the
 * worktree and the commit. */
function makeUnpushed(f: Fixture): { wt: string; sha: string } {
  const wt = addWorktree(f, "feat", path.join(f.base, "wt-feat"));
  commitHere(wt, "feat.txt", "unpushed work");
  return { wt, sha: git(wt, ["rev-parse", "HEAD"]).trim() };
}

/** A commit on top of `parent` (same tree), made without touching any ref
 * or the work tree: the sha a shadowing local branch can sit at. */
function commitOn(f: Fixture, parent: string): string {
  return git(f.repo, [
    "commit-tree",
    `${parent}^{tree}`,
    "-p",
    parent,
    "-m",
    "elsewhere",
  ]).trim();
}

function commitShaOf(f: Fixture, rev: string): string {
  return git(f.repo, ["rev-parse", "--verify", `${rev}^{commit}`]).trim();
}

/**
 * A directory holding a `git` that runs `prelude` (a shell snippet that may
 * `exit`) before it hands every call on to the real git, and the PATH that
 * puts it first. The spawned CLI sees nothing else but the fixed bin dir.
 */
function gitWrapper(f: Fixture, name: string, prelude: string): string {
  const dir = path.join(f.base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/bin/sh\n${prelude}\nexec '${path.join(FIXED_BIN_DIR, "git")}' "$@"\n`,
    { mode: 0o755 },
  );
  return `${dir}${path.delimiter}${FIXED_BIN_DIR}`;
}

/** A `gitWrapper` PATH whose git fails like a broken ref store for
 * `for-each-ref` and passes every other call on. */
function failingForEachRef(f: Fixture): string {
  return gitWrapper(
    f,
    "git-no-for-each-ref",
    `for a in "$@"; do
  if [ "$a" = for-each-ref ]; then
    echo 'fatal: injected for-each-ref failure' >&2
    exit 128
  fi
done`,
  );
}

/** Runs `remove` without --base and without --force, once with
 * --delete-branch (refused as unpushed) and once with --require-merged
 * --delete-branch (refused as not provably merged: no `gh` is installed in
 * the spawned CLI), and asserts that every run leaves the worktree and the
 * branch at `sha` untouched. */
async function expectKept(
  f: Fixture,
  wt: string,
  branch: string,
  sha: string,
): Promise<void> {
  const runs: [string[], string][] = [
    [["--delete-branch"], "unpushed_commits"],
    [["--require-merged", "--delete-branch"], "merge_state_unknown"],
  ];
  for (const [flags, reason] of runs) {
    const r = await cli(f.work, ["remove", wt, ...flags]);
    expect(r.code, `${flags.join(" ")}: ${r.stdout}${r.stderr}`).toBe(2);
    expect(r.json.reason, flags.join(" ")).toBe(reason);
    expect(listedWorktrees(f.repo)).toContain(wt);
    expect(git(f.repo, ["rev-parse", branch]).trim()).toBe(sha);
  }
}

describe("worktree remove without --base: symbolic refs under refs/remotes", () => {
  it("keeps a branch that a symbolic remote-tracking ref points at", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    // `--remotes` follows this to the local branch and would call its
    // commit pushed; deleting the branch would then leave it on no ref.
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/self",
      "refs/heads/feat",
    ]);
    await expectKept(f, wt, "feat", sha);
    // Without --delete-branch the symref alone is refused as well.
    const plain = await cli(f.work, ["remove", wt]);
    expect(plain.code, plain.stdout + plain.stderr).toBe(2);
    expect(plain.json.reason).toBe("unpushed_commits");
    expect(plain.json.details.commits).toBe(1);
  });

  it("keeps a branch whose work is only reachable through a symbolic ref to another local branch", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, ["branch", "elsewhere", "feat"]);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/other",
      "refs/heads/elsewhere",
    ]);
    await expectKept(f, wt, "feat", sha);
  });

  it("keeps a branch at the end of a chain of symbolic remote-tracking refs", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/tail",
      "refs/heads/feat",
    ]);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/mid",
      "refs/remotes/origin/tail",
    ]);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/top",
      "refs/remotes/origin/mid",
    ]);
    await expectKept(f, wt, "feat", sha);
  });

  it("keeps a branch when the symbolic ref sits in packed state next to packed plain refs", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/self",
      "refs/heads/feat",
    ]);
    // Plain refs go into packed-refs; a symbolic ref cannot, and must still
    // be told apart from them.
    git(f.repo, ["pack-refs", "--all"]);
    expect(
      fs.readFileSync(
        path.join(absoluteGitPath(f.repo, "--git-common-dir"), "packed-refs"),
        "utf8",
      ),
    ).toContain("refs/remotes/origin/main");
    await expectKept(f, wt, "feat", sha);
  });

  it("keeps counting a plain remote-tracking ref beside a symbolic one as a push", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    git(wt, ["push", "-q", "origin", "feat"]);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/self",
      "refs/heads/feat",
    ]);
    // An alias of a real remote-tracking ref is harmless: the commit is on
    // the remote, so the branch goes as it always did.
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/alias",
      "refs/remotes/origin/feat",
    ]);
    git(f.repo, ["pack-refs", "--all"]);
    const r = await cli(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
    expect(git(f.repo, ["branch", "--list", "feat"]).trim()).toBe("");
  });

  it("keeps a branch whose only copy is a local branch spelled like a remote-tracking ref", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, ["update-ref", "refs/heads/refs/remotes/origin/ghost", sha]);
    await expectKept(f, wt, "feat", sha);
  });

  it("still lets --force remove the unpushed branch, as before", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/self",
      "refs/heads/feat",
    ]);
    const r = await cli(f.work, ["remove", wt, "--delete-branch", "--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(listedWorktrees(f.repo)).not.toContain(wt);
  });
});

describe("worktree remove without --base: a local branch named like the default base", () => {
  /** `origin/HEAD` removed, so only the short-name fallback is left. */
  function unsetOriginHead(f: Fixture): void {
    git(f.repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
  }

  it("keeps a branch that only a local branch called origin/main contains", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    unsetOriginHead(f);
    // `origin/main` now names this local branch, which holds the commit.
    git(f.repo, ["branch", "origin/main", "feat"]);
    expect(git(f.repo, ["rev-parse", "origin/main"]).trim()).toBe(sha);
    await expectKept(f, wt, "feat", sha);
    // With a gh that finds no merged pull request the verdict is a plain
    // "no", and names the ref it measured against.
    const merged = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: ghStub(f, "[]"),
    });
    expect(merged.code, merged.stdout + merged.stderr).toBe(2);
    expect(merged.json.reason).toBe("branch_not_merged");
    // git's own abbreviation of the full ref, which differs from the
    // `origin/main` the local branch is called.
    expect(merged.json.details.merged.reason).toContain(
      "not an ancestor of remotes/origin/main and",
    );
    expect(merged.json.message).toContain(
      "not merged into remotes/origin/main;",
    );
    expect(git(f.repo, ["rev-parse", "feat"]).trim()).toBe(sha);
  });

  it("keeps a branch that only a local branch called origin/master contains", async () => {
    const f = makeFixture();
    // A repository whose default branch is `master` on the remote.
    git(f.repo, ["push", "-q", "origin", "main:master"]);
    git(f.origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    git(f.repo, ["push", "-q", "origin", "--delete", "main"]);
    git(f.repo, ["fetch", "-q", "--prune", "origin"]);
    unsetOriginHead(f);
    expect(
      gitTry(f.repo, [
        "rev-parse",
        "--verify",
        "-q",
        "refs/remotes/origin/main",
      ]),
    ).toBeUndefined();
    const wt = path.join(f.base, "wt-feat");
    git(f.repo, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      "feat",
      wt,
      "origin/master",
    ]);
    commitHere(wt, "feat.txt", "unpushed work");
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    git(f.repo, ["branch", "origin/master", "feat"]);
    await expectKept(f, wt, "feat", sha);
  });

  it("keeps a branch contained by a tag spelled origin/main", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    unsetOriginHead(f);
    git(f.repo, ["tag", "origin/main", "feat"]);
    await expectKept(f, wt, "feat", sha);
  });

  it("measures against the remote-tracking ref when origin/HEAD is set and a local branch shadows it", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, ["branch", "origin/main", "feat"]);
    await expectKept(f, wt, "feat", sha);
  });

  it("still trusts a merged pull request that gh reports for a shadowed default base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    unsetOriginHead(f);
    git(f.repo, ["branch", "origin/main", "feat"]);
    const r = await cli(f.work, ["remove", wt, "--delete-branch"], {
      PATH: ghStub(
        f,
        `[{"number":9,"headRefOid":"${sha}","baseRefName":"main"}]`,
        { recordArgs: true },
      ),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes", via: "gh" });
    expect(r.json.branch.deleted).toBe(true);
    expect(ghArgs(f)).toHaveLength(1);
    expect(ghArgs(f)[0]).toContain("--base main");
  });

  it("keeps a branch when no default base can be told", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    unsetOriginHead(f);
    git(f.repo, ["branch", "origin/main", "feat"]);
    git(f.repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
    await expectKept(f, wt, "feat", sha);
  });
});

describe("worktree remove without --base: how the default base is named", () => {
  it("shows origin/main, not the full ref, in a normal layout", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    const refused = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: ghStub(f, "[]"),
    });
    expect(refused.code, refused.stdout + refused.stderr).toBe(2);
    expect(refused.json.reason).toBe("branch_not_merged");
    expect(refused.json.message).toContain("not merged into origin/main;");
    expect(refused.json.message).not.toContain("refs/remotes/");
    expect(refused.json.details.merged.reason).toBe(
      "not an ancestor of origin/main and gh lists no merged pull request for feat",
    );

    const clean = addWorktree(f, "clean", path.join(f.base, "wt-clean"));
    const ok = await cli(f.work, ["remove", clean, "--require-merged"]);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(ok.json.merged).toEqual({
      merged: "yes",
      via: "ancestry",
      reason: "HEAD is an ancestor of origin/main",
    });
  });

  it("shows origin/main in the warning about a merged branch's unpushed commits", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "squashed", path.join(f.base, "wt-squashed"));
    commitHere(wt, "sq.txt", "squashed work");
    const sha = git(wt, ["rev-parse", "HEAD"]).trim();
    const r = await cli(f.work, ["remove", wt, "--require-merged"], {
      PATH: ghStub(
        f,
        `[{"number":9,"headRefOid":"${sha}","baseRefName":"main"}]`,
      ),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.warnings).toEqual([
      "1 commit(s) are on no remote branch, but the branch is merged into origin/main (gh); not counted as unpushed",
    ]);
  });

  it("names a shadowed default base unambiguously, and does not mistake a shadow at the same commit for the base", async () => {
    const f = makeFixture();
    // origin/HEAD is set and a local branch of the same name as the
    // remote-tracking ref sits at its own commit.
    const clean = addWorktree(f, "clean", path.join(f.base, "wt-clean"));
    git(f.repo, ["branch", "origin/main", f.mainSha]);
    const r = await cli(f.work, ["remove", clean, "--require-merged"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged.reason).toBe(
      "HEAD is an ancestor of remotes/origin/main",
    );
  });
});

describe("worktree remove: symbolic refs and an explicit --base", () => {
  it("keeps a branch that a symbolic remote-tracking ref points at, with --base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/self",
      "refs/heads/feat",
    ]);
    const r = await cli(f.work, [
      "remove",
      wt,
      "--delete-branch",
      "--base",
      "origin/main",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
    expect(listedWorktrees(f.repo)).toContain(wt);
    expect(git(f.repo, ["rev-parse", "feat"]).trim()).toBe(sha);
  });
});

describe("worktree remove: a for-each-ref that fails", () => {
  it("refuses with unpushed_state_unknown and keeps the branch, though rev-list alone would call it pushed", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    // Without for-each-ref the symbolic ref cannot be excluded, and
    // `rev-list --remotes` follows it to the branch: the commit would look
    // pushed and the branch would be deleted.
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/self",
      "refs/heads/feat",
    ]);
    const PATH = failingForEachRef(f);
    const r = await cli(f.work, ["remove", wt, "--delete-branch"], { PATH });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_state_unknown");
    expect(r.json.message).toContain("--force");
    expect(listedWorktrees(f.repo)).toContain(wt);
    expect(git(f.repo, ["rev-parse", "feat"]).trim()).toBe(sha);
  });
});

describe("resolveDefaultBase", () => {
  const MAIN = "refs/remotes/origin/main";

  it("reads origin/HEAD and keeps the short name for display in a normal layout", () => {
    const f = makeFixture();
    expect(resolveDefaultBase(f.repo)).toEqual({
      ref: "origin/main",
      fullRef: MAIN,
      ghBase: "main",
      source: "origin/HEAD",
    });
  });

  it("falls back to origin/main, then origin/master, when origin/HEAD is unset", () => {
    const f = makeFixture();
    git(f.repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      ref: "origin/main",
      fullRef: MAIN,
      ghBase: "main",
      source: "origin/main (origin/HEAD is not set or not usable)",
    });
    git(f.repo, ["push", "-q", "origin", "main:master"]);
    git(f.repo, ["fetch", "-q", "origin"]);
    // main wins while both exist.
    expect(resolveDefaultBase(f.repo)?.fullRef).toBe(MAIN);
    git(f.repo, ["update-ref", "-d", MAIN]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      ref: "origin/master",
      fullRef: "refs/remotes/origin/master",
      ghBase: "master",
      source: "origin/master (origin/HEAD is not set or not usable)",
    });
  });

  it("reads origin/HEAD that names another branch", () => {
    const f = makeFixture();
    git(f.repo, ["push", "-q", "origin", "main:release/1"]);
    git(f.repo, ["fetch", "-q", "origin"]);
    git(f.repo, ["remote", "set-head", "origin", "release/1"]);
    expect(resolveDefaultBase(f.repo)).toEqual({
      ref: "origin/release/1",
      fullRef: "refs/remotes/origin/release/1",
      ghBase: "release/1",
      source: "origin/HEAD",
    });
  });

  it("names git's unambiguous abbreviation when a local branch or tag shadows the short name", () => {
    const f = makeFixture();
    git(f.repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    makeUnpushed(f);
    git(f.repo, ["branch", "origin/main", "feat"]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      ref: "remotes/origin/main",
      fullRef: MAIN,
    });
    git(f.repo, ["branch", "-D", "origin/main"]);
    git(f.repo, ["tag", "origin/main", "feat"]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      ref: "remotes/origin/main",
      fullRef: MAIN,
    });
  });

  it("names the abbreviation with origin/HEAD set, whether the shadow sits at the same commit or at another", () => {
    const f = makeFixture();
    // Same commit as the remote-tracking ref: `origin/main` would still be
    // ambiguous for git, so it must not be the name handed on.
    git(f.repo, ["branch", "origin/main", f.mainSha]);
    expect(resolveDefaultBase(f.repo)).toEqual({
      ref: "remotes/origin/main",
      fullRef: MAIN,
      ghBase: "main",
      source: "origin/HEAD",
    });
    git(f.repo, ["branch", "-D", "origin/main"]);
    const other = commitOn(f, f.mainSha);
    git(f.repo, ["branch", "origin/main", other]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      ref: "remotes/origin/main",
      fullRef: MAIN,
    });
    expect(commitShaOf(f, "remotes/origin/main")).toBe(f.mainSha);
  });

  it("skips an origin/HEAD that names a local branch, and uses the fallback", () => {
    const f = makeFixture();
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/heads/main",
    ]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      fullRef: MAIN,
      source: "origin/main (origin/HEAD is not set or not usable)",
    });
    git(f.repo, ["update-ref", "-d", MAIN]);
    expect(resolveDefaultBase(f.repo)).toBeUndefined();
  });

  it("skips an origin/HEAD that names a missing ref or another remote", () => {
    const f = makeFixture();
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/gone",
    ]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      fullRef: MAIN,
      source: "origin/main (origin/HEAD is not set or not usable)",
    });
    git(f.repo, ["remote", "add", "upstream", f.origin]);
    git(f.repo, ["fetch", "-q", "upstream"]);
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/upstream/main",
    ]);
    expect(resolveDefaultBase(f.repo)).toMatchObject({
      fullRef: MAIN,
      source: "origin/main (origin/HEAD is not set or not usable)",
    });
  });

  it("refuses an origin/main that is itself symbolic", () => {
    const f = makeFixture();
    makeUnpushed(f);
    git(f.repo, ["update-ref", "-d", MAIN]);
    git(f.repo, ["symbolic-ref", MAIN, "refs/heads/feat"]);
    expect(resolveDefaultBase(f.repo)).toBeUndefined();
    // Nor does origin/HEAD get around it.
    git(f.repo, ["symbolic-ref", "refs/remotes/origin/HEAD", MAIN]);
    expect(resolveDefaultBase(f.repo)).toBeUndefined();
  });

  it("refuses a ref of a remote whose name only starts with origin/", () => {
    const f = makeFixture();
    git(f.repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    git(f.repo, ["update-ref", "-d", MAIN]);
    // `origin/foo` is a remote of its own here, so this is its `main`, not
    // the branch `foo/main` of `origin`.
    git(f.repo, ["config", "remote.origin/foo.url", f.origin]);
    git(f.repo, ["update-ref", "refs/remotes/origin/foo/main", f.mainSha]);
    expect(resolveDefaultBase(f.repo)).toBeUndefined();
    git(f.repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/foo/main",
    ]);
    expect(resolveDefaultBase(f.repo)).toBeUndefined();
  });

  it("is undefined without any remote, and with a stale ref of a removed remote", () => {
    const f = makeFixture();
    git(f.repo, ["config", "--unset", "remote.origin.url"]);
    git(f.repo, ["config", "--unset-all", "remote.origin.fetch"]);
    expect(git(f.repo, ["remote"]).trim()).toBe("");
    // The refs are still there, but no configured remote owns them.
    expect(gitTry(f.repo, ["rev-parse", "--verify", "-q", MAIN])).toBeDefined();
    expect(resolveDefaultBase(f.repo)).toBeUndefined();
  });
});

describe("remove --delete-branch warns about a branch it deletes unmerged (#488)", () => {
  const warnsUnmerged = (warnings: string[]): boolean =>
    warnings.some(
      (w) =>
        w.includes("deleted branch hotfix/one") &&
        w.includes("pass --require-merged to refuse instead"),
    );

  it("warns for merged: no against --base and still deletes", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const r = await cli(
      f.work,
      ["remove", wt, "--delete-branch", "--base", "origin/main"],
      { PATH: ghStub(f, "[]") },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.merged).toMatchObject({ merged: "no" });
    expect(r.json.branch.deleted).toBe(true);
    expect(warnsUnmerged(r.json.warnings)).toBe(true);
    // An explicit --base is named by the full remote-tracking ref it
    // measures against, which is what the warning shows.
    expect(
      r.json.warnings.some((w: string) =>
        w.includes("not merged into refs/remotes/origin/main"),
      ),
    ).toBe(true);
  });

  it("warns for merged: no against the default base", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const r = await cli(f.work, ["remove", wt, "--delete-branch"], {
      PATH: ghStub(f, "[]"),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "no" });
    expect(r.json.branch.deleted).toBe(true);
    expect(warnsUnmerged(r.json.warnings)).toBe(true);
  });

  it("warns for merged: unknown", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const r = await cli(
      f.work,
      ["remove", wt, "--delete-branch", "--base", "origin/main"],
      { PATH: ghStub(f, null) },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "unknown" });
    expect(r.json.branch.deleted).toBe(true);
    expect(
      r.json.warnings.some(
        (w: string) =>
          w.includes("deleted branch hotfix/one") && w.includes("is unknown"),
      ),
    ).toBe(true);
  });

  it("does not warn for a merged branch", async () => {
    const f = makeFixture();
    const { wt, sha } = makeHotfix(f);
    git(f.repo, ["push", "-q", "origin", `${sha}:refs/heads/main`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const r = await cli(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "yes" });
    expect(r.json.branch.deleted).toBe(true);
    expect(warnsUnmerged(r.json.warnings)).toBe(false);
  });

  it("warns when --force overrides --require-merged", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const r = await cli(
      f.work,
      ["remove", wt, "--delete-branch", "--require-merged", "--force"],
      { PATH: ghStub(f, "[]") },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.merged).toMatchObject({ merged: "no" });
    expect(r.json.branch.deleted).toBe(true);
    expect(
      r.json.warnings.some(
        (w: string) =>
          w.includes("deleted branch hotfix/one") &&
          w.includes("--force overrode --require-merged"),
      ),
    ).toBe(true);
  });

  it("does not warn when the branch deletion itself fails", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const failingBranchDelete = gitWrapper(
      f,
      "git-no-branch-delete",
      `prev=
for a in "$@"; do
  if [ "$prev" = branch ] && [ "$a" = -D ]; then
    echo "error: injected branch -D failure" >&2
    exit 1
  fi
  prev=$a
done`,
    );
    const r = await cli(
      f.work,
      ["remove", wt, "--delete-branch", "--base", "origin/main"],
      { PATH: `${failingBranchDelete}${path.delimiter}${ghStub(f, "[]")}` },
    );
    expect(r.json.merged).toMatchObject({ merged: "no" });
    expect(r.json.branch.deleted).toBe(false);
    expect(r.json.branch.reason).toContain("injected branch -D failure");
    expect(
      r.json.warnings.some((w: string) => w.includes("deleted branch")),
    ).toBe(false);
  });

  it("does not warn when the branch is kept", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const r = await cli(f.work, ["remove", wt], { PATH: ghStub(f, "[]") });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(false);
    expect(
      r.json.warnings.some((w: string) => w.includes("deleted branch")),
    ).toBe(false);
  });
});

/** One line of git output as git printed it: only the final newline comes
 * off, so a directory name that ends in a space keeps it. */
function oneLine(out: string): string {
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}

interface Bounded {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The limit passed and the process group was killed. */
  timedOut: boolean;
  /** The memory of the run's processes (the group and every descendant)
   * passed `rssLimitKb` and they were killed. */
  rssExceeded: boolean;
}

interface ListedProcess {
  pid: number;
  ppid: number;
  pgid: number;
  rssKb: number;
}

/** The processes of one `ps -axo pid=,ppid=,pgid=,rss=` listing. */
function parseListing(listing: string): ListedProcess[] {
  const procs: ListedProcess[] = [];
  for (const line of listing.split("\n")) {
    const [pid, ppid, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || pgid === undefined) continue;
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!Number.isInteger(pgid)) continue;
    procs.push({ pid, ppid, pgid, rssKb: rss ?? 0 });
  }
  return procs;
}

/** The processes of one `ps` listing that belong to the run started as
 * `rootPid`: the root, every descendant found by following the parent pids
 * (a git the CLI started sits in a process group of its own, so the group
 * alone would miss it), and whatever else is left in the root's group (a
 * child whose parent has exited belongs to init now, not to the root). Each
 * comes with its process group, so a later kill can tell the process it
 * saw from another one that was given the same pid since. */
function treeOf(
  listing: string,
  rootPid: number,
): { pid: number; pgid: number; rssKb: number }[] {
  const procs = parseListing(listing);
  const inTree = new Set<number>([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) {
      if (!inTree.has(p.pid) && inTree.has(p.ppid)) {
        inTree.add(p.pid);
        grew = true;
      }
    }
  }
  return procs
    .filter((p) => inTree.has(p.pid) || p.pgid === rootPid)
    .map((p) => ({ pid: p.pid, pgid: p.pgid, rssKb: p.rssKb }));
}

/** Every process on the machine as `ps` lists it (the same call works on
 * macOS and Linux). Empty when `ps` cannot answer. */
async function listProcesses(): Promise<string> {
  return await new Promise<string>((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,rss="],
      { encoding: "utf8" },
      (err, stdout) => {
        resolve(err === null ? stdout : "");
      },
    );
  });
}

/** The processes of the run started as `rootPid` and their resident memory
 * in KiB. Empty when `ps` cannot answer, which the guard reads as "under the
 * limit": the time limit is the guard that cannot be skipped. */
async function runTree(
  rootPid: number,
): Promise<{ pid: number; pgid: number; rssKb: number }[]> {
  return treeOf(await listProcesses(), rootPid);
}

/**
 * Ends a guarded run: the process group of the root, and the processes the
 * memory sampler saw outside it (`seen`, pid to the group it was in). A pid
 * is a name that is given out again once its process has been reaped, so
 * nothing is signalled by a pid alone: a seen process is signalled only when
 * a fresh listing still shows that pid in the group it was seen in, and
 * never the root pid by itself. The group is signalled while the root has
 * not been reaped (its pid is then still ours) or while a member of it is
 * listed (the group id cannot be given out again before that member is
 * gone). Without a listing, only a root that is still unreaped is signalled.
 */
async function killRun(
  rootPid: number | undefined,
  rootReaped: boolean,
  seen: ReadonlyMap<number, number>,
): Promise<void> {
  const listed = parseListing(await listProcesses());
  const signal = (target: number): void => {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  if (
    rootPid !== undefined &&
    (!rootReaped || listed.some((p) => p.pgid === rootPid))
  ) {
    signal(-rootPid);
  }
  for (const [pid, pgid] of seen) {
    if (listed.some((p) => p.pid === pid && p.pgid === pgid)) signal(pid);
  }
}

/** How often a guarded run samples the memory of its processes. */
const RSS_POLL_MS = 100;

/**
 * Runs `command` in its own process group with a hard time limit. The whole
 * group is killed when the limit passes, and again once the command has
 * exited (anything it left behind, such as a git that outlived it), so a
 * layout that sends git into a long walk ends the test instead of the
 * machine's memory. The limits are far above a normal run and well below
 * the test timeout.
 */
async function spawnBounded(
  command: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
  limitMs: number,
  rssLimitKb?: number,
): Promise<Bounded> {
  const child = spawn(command, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // Processes of the run seen by the memory sampler, with the group each was
  // in, so a descendant in a group of its own (the CLI starts each git in
  // one) ends with the run, and only while it is still that process.
  const seen = new Map<number, number>();
  const killGroup = (): Promise<void> =>
    killRun(
      child.pid,
      child.exitCode !== null || child.signalCode !== null,
      seen,
    );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killGroup();
  }, limitMs);
  // The memory guard: sampled while the run lives, and the group and every
  // process seen are killed the first time the tree holds more than
  // `rssLimitKb`.
  let rssExceeded = false;
  let sampling = false;
  const sampler =
    rssLimitKb === undefined || child.pid === undefined
      ? undefined
      : setInterval(() => {
          if (sampling) return;
          sampling = true;
          void runTree(child.pid as number).then((tree) => {
            sampling = false;
            let kb = 0;
            for (const p of tree) {
              kb += p.rssKb;
              seen.set(p.pid, p.pgid);
            }
            if (kb > rssLimitKb && !rssExceeded) {
              rssExceeded = true;
              void killGroup();
            }
          });
        }, RSS_POLL_MS);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => {
        resolve(c);
      });
    });
    return { code, stdout, stderr, timedOut, rssExceeded };
  } finally {
    clearTimeout(timer);
    if (sampler !== undefined) clearInterval(sampler);
    await killGroup();
  }
}

/** `cli`, bounded by `spawnBounded`. */
async function cliBounded(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  limitMs = 45_000,
  rssLimitKb?: number,
): Promise<Cli> {
  const r = await spawnBounded(
    process.execPath,
    [CLI_PATH, "-C", cwd, "worktree", ...args],
    { env: buildSpawnEnv({ ...GIT_ENV, ...extraEnv }) },
    limitMs,
    rssLimitKb,
  );
  if (r.rssExceeded) {
    throw new Error(`worktree ${args.join(" ")} passed the memory limit`);
  }
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(r.stdout.trim()) as Record<string, any>;
  } catch {
    json = {};
  }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
}

/** `git`, bounded by `spawnBounded`: every git call a test makes once it
 * has made the ref store adversarial goes through here. Returns stdout; a
 * non-zero exit, a signal or the time limit fails the test. `extraEnv` is
 * added to the hermetic git environment. */
async function gitBounded(
  cwd: string,
  args: string[],
  limitMs = 20_000,
  extraEnv: NodeJS.ProcessEnv = {},
  rssLimitKb?: number,
): Promise<string> {
  const r = await spawnBounded(
    "git",
    args,
    { cwd, env: { PATH: process.env.PATH, ...GIT_ENV, ...extraEnv } },
    limitMs,
    rssLimitKb,
  );
  if (r.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} in ${cwd} exited ${String(r.code)}${r.timedOut ? " (time limit)" : ""}${r.rssExceeded ? " (memory limit)" : ""}: ${r.stderr}`,
    );
  }
  return r.stdout;
}

/** A `sh -c` script, bounded like `gitBounded`: for a git call whose
 * argument holds bytes that are not text (a spawn argument is a string). */
async function shBounded(cwd: string, script: string): Promise<string> {
  const r = await spawnBounded(
    "sh",
    ["-c", script],
    { cwd, env: { PATH: process.env.PATH, ...GIT_ENV } },
    20_000,
  );
  if (r.code !== 0) {
    throw new Error(
      `sh -c ${JSON.stringify(script)} in ${cwd} exited ${String(r.code)}${r.timedOut ? " (time limit)" : ""}: ${r.stderr}`,
    );
  }
  return r.stdout;
}

/** What git itself counts as unpushed on `rev`, asked with a bound. */
async function unpushedPerGit(
  repo: string,
  rev = "feat",
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return (
    await gitBounded(
      repo,
      ["rev-list", rev, "--not", "--remotes"],
      20_000,
      extraEnv,
    )
  ).trim();
}

/** The directory git keeps the shared refs in, exactly as git names it.
 * Called while a test builds its layout, before anything is planted. */
function commonDirOf(f: Fixture): string {
  return oneLine(
    git(f.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
}

/** Runs each flag set against the worktree and asserts the unknown-state
 * refusal, with the worktree and `branch` at `sha` still in place. */
async function expectUnknownState(
  f: Fixture,
  wt: string,
  sha: string,
  flagSets: string[][],
  env: NodeJS.ProcessEnv = {},
  branch = "feat",
  reasons: string[] = ["unpushed_state_unknown"],
): Promise<void> {
  for (const flags of flagSets) {
    const r = await cliBounded(f.work, ["remove", wt, ...flags], env);
    const label = `${flags.join(" ")}: ${r.stdout}${r.stderr}`;
    expect(r.code, label).toBe(2);
    expect(reasons, label).toContain(r.json.reason);
    const listed = parseWorktreeList(
      await gitBounded(f.repo, ["worktree", "list", "--porcelain"]),
    ).map((w) => w.path);
    expect(listed, label).toContain(wt);
    const at = await gitBounded(f.repo, [
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    ]);
    expect(at.trim(), label).toBe(sha);
  }
}

const SYMLINK_FLAG_SETS: string[][] = [
  [],
  ["--delete-branch"],
  ["--delete-branch", "--base", "origin/main"],
];

/**
 * What the git on this machine can do, probed once in a scratch repository
 * with one commit: a test of a feature an older git lacks skips rather
 * than fails (the git of a CI runner may trail the one a test was written
 * on). `check` throws or returns false when the feature is absent.
 */
function gitCan(check: (repo: string, scratch: string) => boolean): boolean {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-gitcan-"),
  );
  try {
    const repo = path.join(scratch, "repo");
    git(scratch, ["init", "-q", "-b", "main", "repo"]);
    write(repo, "a.txt", "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    return check(repo, scratch);
  } catch {
    return false;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A copy of the refs and HEAD of `repo` in `<scratch>/store`, with one
 * branch `marker` that exists only there: git lists `refs/heads/marker`
 * exactly when it reads the store a `files://<store>` value names. */
function markerStore(repo: string, scratch: string): string {
  const store = path.join(scratch, "store");
  fs.cpSync(path.join(repo, ".git/refs"), path.join(store, "refs"), {
    recursive: true,
  });
  fs.copyFileSync(path.join(repo, ".git/HEAD"), path.join(store, "HEAD"));
  fs.writeFileSync(
    path.join(store, "refs/heads/marker"),
    git(repo, ["rev-parse", "HEAD"]),
  );
  return store;
}

const MARKER_QUERY = [
  "for-each-ref",
  "--format=%(refname)",
  "refs/heads/marker",
];

/** `git rev-parse --show-ref-format` answers (git 2.45 and later). */
const SHOW_REF_FORMAT_SUPPORTED = gitCan(
  (repo) => oneLine(git(repo, ["rev-parse", "--show-ref-format"])) === "files",
);

/** `extensions.refStorage = files://<path>` makes git read that store. */
const REF_STORAGE_LOCATION_SUPPORTED = gitCan((repo, scratch) => {
  const store = markerStore(repo, scratch);
  git(repo, ["config", "core.repositoryformatversion", "1"]);
  git(repo, ["config", "extensions.refStorage", `files://${store}`]);
  return git(repo, MARKER_QUERY).trim() === "refs/heads/marker";
});

/** `GIT_REFERENCE_BACKEND=files://<path>` makes git read that store. */
const REFERENCE_BACKEND_ENV_SUPPORTED = gitCan((repo, scratch) => {
  const store = markerStore(repo, scratch);
  const out = execFileSync("git", MARKER_QUERY, {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...GIT_ENV,
      GIT_REFERENCE_BACKEND: `files://${store}`,
    },
  });
  return out.trim() === "refs/heads/marker";
});

/** The layout whose fifo a git may block on (git 2.54 lists the refs beside
 * a fifo under `refs` without opening it; git 2.39 blocks in `for-each-ref`
 * and `rev-list`, which the CLI runs before its own inspection). The CLI
 * bounds every git call, so on such a git the layout ends in the
 * `git_timeout` refusal instead of the `unpushed_state_unknown` one; the
 * test runs on every git, with a short bound, and accepts either. */
const FIFO_LAYOUT = "a fifo where a ref should be";

describe("worktree remove: a file system symlink under refs/remotes", () => {
  it("keeps a branch that a file symlink in refs/remotes aliases, with and without --base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    fs.symlinkSync(
      "../../heads/feat",
      path.join(commonDirOf(f), "refs/remotes/origin/self"),
    );
    // git itself reads the link as a plain remote-tracking ref of the
    // branch, which is the whole problem.
    expect(await unpushedPerGit(f.repo)).toBe("");
    await expectUnknownState(f, wt, sha, [
      ...SYMLINK_FLAG_SETS,
      // The link as the base itself: it resolves, and the branch is
      // "merged" into it.
      ["--delete-branch", "--base", "origin/self"],
      ["--require-merged", "--delete-branch", "--base", "origin/self"],
      ["--require-merged", "--base", "refs/remotes/origin/self"],
    ]);
  });

  it("names the link in the refusal", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    fs.symlinkSync(
      "../../heads/feat",
      path.join(commonDirOf(f), "refs/remotes/origin/self"),
    );
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.message).toContain(
      "refs/remotes/origin/self is a symbolic link",
    );
    expect(r.json.message).toContain("--force");
  });

  it("keeps a branch that a directory symlink in refs/remotes aliases, with and without --base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, ["config", "remote.mirror.url", f.origin]);
    fs.symlinkSync(
      "../heads",
      path.join(commonDirOf(f), "refs/remotes/mirror"),
    );
    expect(await unpushedPerGit(f.repo)).toBe("");
    await expectUnknownState(f, wt, sha, [
      ...SYMLINK_FLAG_SETS,
      ["--delete-branch", "--base", "mirror/feat"],
      ["--require-merged", "--delete-branch", "--base", "mirror/feat"],
    ]);
  });

  it("still lets --force remove the branch, as it does for any unknown state", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    fs.symlinkSync(
      "../../heads/feat",
      path.join(commonDirOf(f), "refs/remotes/origin/self"),
    );
    const r = await cliBounded(f.work, [
      "remove",
      wt,
      "--delete-branch",
      "--force",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const listed = parseWorktreeList(
      await gitBounded(f.repo, ["worktree", "list", "--porcelain"]),
    ).map((w) => w.path);
    expect(listed).not.toContain(wt);
  });

  const LAYOUTS: [string, (f: Fixture, sha: string) => void][] = [
    [
      "a link to a file outside the git directory that holds the commit",
      (f, sha) => {
        const outside = path.join(f.base, "outside-ref");
        fs.writeFileSync(outside, `${sha}\n`);
        fs.symlinkSync(
          outside,
          path.join(commonDirOf(f), "refs/remotes/origin/ext"),
        );
      },
    ],
    [
      "a chain of links ending at the branch",
      (f) => {
        const dir = path.join(commonDirOf(f), "refs/remotes/origin");
        fs.symlinkSync("../../heads/feat", path.join(dir, "first"));
        fs.symlinkSync("first", path.join(dir, "second"));
      },
    ],
    [
      "a link in a nested directory of refs/remotes",
      (f) => {
        const dir = path.join(commonDirOf(f), "refs/remotes/origin/deep/er");
        fs.mkdirSync(dir, { recursive: true });
        fs.symlinkSync("../../../../heads/feat", path.join(dir, "self"));
      },
    ],
    [
      "a directory link below a remote",
      (f) => {
        fs.symlinkSync(
          "../../heads",
          path.join(commonDirOf(f), "refs/remotes/origin/sub"),
        );
      },
    ],
    [
      "a dangling link",
      (f) => {
        fs.symlinkSync(
          "../../heads/gone",
          path.join(commonDirOf(f), "refs/remotes/origin/gone"),
        );
      },
    ],
    [
      "a link that shadows a packed ref of the same name",
      (f, sha) => {
        git(f.repo, ["update-ref", "refs/remotes/origin/dup", f.mainSha]);
        git(f.repo, ["pack-refs", "--all"]);
        // pack-refs took the branch with it; write it back as a loose ref
        // so the link has something to alias.
        const common = commonDirOf(f);
        fs.writeFileSync(path.join(common, "refs/heads/feat"), `${sha}\n`);
        fs.symlinkSync(
          "../../heads/feat",
          path.join(common, "refs/remotes/origin/dup"),
        );
      },
    ],
    [
      "refs/remotes itself being a link",
      (f) => {
        const common = commonDirOf(f);
        fs.renameSync(
          path.join(common, "refs/remotes"),
          path.join(common, "remotes-real"),
        );
        fs.symlinkSync("../remotes-real", path.join(common, "refs/remotes"));
      },
    ],
    [
      "refs being a link",
      (f) => {
        const common = commonDirOf(f);
        fs.renameSync(
          path.join(common, "refs"),
          path.join(common, "refs-real"),
        );
        fs.symlinkSync("refs-real", path.join(common, "refs"));
      },
    ],
    [
      FIFO_LAYOUT,
      (f) => {
        execFileSync("mkfifo", [
          path.join(commonDirOf(f), "refs/remotes/origin/pipe"),
        ]);
      },
    ],
    [
      "the branch's own ref file being a link to a file under refs/remotes",
      (f) => {
        const common = commonDirOf(f);
        fs.mkdirSync(path.join(common, "refs/remotes/mirror"));
        fs.renameSync(
          path.join(common, "refs/heads/feat"),
          path.join(common, "refs/remotes/mirror/feat"),
        );
        fs.symlinkSync(
          "../remotes/mirror/feat",
          path.join(common, "refs/heads/feat"),
        );
      },
    ],
    [
      "a link in another namespace of the refs tree (refs/tags)",
      (f) => {
        fs.symlinkSync(
          "../heads/feat",
          path.join(commonDirOf(f), "refs/tags/alias"),
        );
      },
    ],
  ];

  it.each(LAYOUTS)("keeps the branch next to %s", async (name, build) => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    build(f, sha);
    const mayBlockGit = name === FIFO_LAYOUT;
    await expectUnknownState(
      f,
      wt,
      sha,
      [["--delete-branch"]],
      mayBlockGit ? { AGENT_PRIMITIVES_WORKTREE_GIT_BOUND_MS: "8000" } : {},
      "feat",
      mayBlockGit
        ? ["unpushed_state_unknown", "git_timeout"]
        : ["unpushed_state_unknown"],
    );
  });

  it("is not fooled by GIT_COMMON_DIR or GIT_DIR in the caller's environment", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    fs.symlinkSync(
      "../../heads/feat",
      path.join(commonDirOf(f), "refs/remotes/origin/self"),
    );
    const clean = makeFixture();
    const elsewhere = absoluteGitPath(clean.repo, "--git-common-dir");
    await expectUnknownState(f, wt, sha, [["--delete-branch"]], {
      GIT_COMMON_DIR: elsewhere,
      GIT_DIR: elsewhere,
    });
  });

  it("ignores a link in a worktree's private refs/remotes, which git does not read either", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    const privateDir = absoluteGitPath(wt, "--git-dir");
    const common = commonDirOf(f);
    expect(privateDir).not.toBe(common);
    fs.mkdirSync(path.join(privateDir, "refs/remotes/origin"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(common, "refs/heads/feat"),
      path.join(privateDir, "refs/remotes/origin/self"),
    );
    // Asked in the worktree, whose private directory holds the link.
    expect(await unpushedPerGit(wt)).toBe(sha);
    // Unchanged: the branch is plainly unpushed, not an unknown state.
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
  });
});

describe("worktree remove: local branches stored under refs/remotes through a link", () => {
  it("keeps a branch whose refs/heads is a link into refs/remotes, with and without --base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    git(f.repo, ["config", "remote.mirror.url", f.origin]);
    const common = commonDirOf(f);
    // Every branch file now really lives under refs/remotes/mirror.
    fs.renameSync(
      path.join(common, "refs/heads"),
      path.join(common, "refs/remotes/mirror"),
    );
    fs.symlinkSync("remotes/mirror", path.join(common, "refs/heads"));
    expect(await unpushedPerGit(f.repo)).toBe("");
    await expectUnknownState(f, wt, sha, [
      ...SYMLINK_FLAG_SETS,
      ["--delete-branch", "--base", "mirror/feat"],
      ["--require-merged", "--delete-branch", "--base", "mirror/feat"],
    ]);
  });

  it("keeps a branch in a directory of refs/heads that is a link into refs/remotes, with and without --base", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    git(f.repo, ["config", "remote.mirror.url", f.origin]);
    const common = commonDirOf(f);
    fs.mkdirSync(path.join(common, "refs/remotes/mirror"));
    fs.symlinkSync("../remotes/mirror", path.join(common, "refs/heads/team"));
    await gitBounded(wt, ["branch", "-m", "feat", "team/feat"]);
    // The branch file was written through the link.
    expect(
      fs.lstatSync(path.join(common, "refs/remotes/mirror/feat")).isFile(),
    ).toBe(true);
    const sha = (
      await gitBounded(f.repo, [
        "rev-parse",
        "--verify",
        "refs/heads/team/feat",
      ])
    ).trim();
    expect(await unpushedPerGit(f.repo, "refs/heads/team/feat")).toBe("");
    await expectUnknownState(
      f,
      wt,
      sha,
      [...SYMLINK_FLAG_SETS, ["--delete-branch", "--base", "mirror/feat"]],
      {},
      "team/feat",
    );
  });
});

describe("worktree remove: the common directory is taken as the bytes git printed", () => {
  it("inspects the directory git named, not a decoy spelled with its decoded name, with and without --base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    const common = commonDirOf(f);
    fs.symlinkSync(
      "../../heads/feat",
      path.join(common, "refs/remotes/origin/self"),
    );
    expect(await unpushedPerGit(wt)).toBe("");
    // A clean copy of the git directory at the name that decoding git's
    // answer (`<base>/gd` and the byte 0xff) would give: a check that
    // decoded the answer would inspect this copy and trust the store.
    const decoy = path.join(f.base, `gd${DECODED_NAME.slice(1)}`);
    fs.cpSync(common, decoy, { recursive: true });
    fs.rmSync(path.join(decoy, "refs/remotes/origin/self"));
    expect(untrustedFilesRefStore(decoy)).toBeUndefined();
    const fake = gitWrapper(
      f,
      "git-bytes-common-dir",
      `for a in "$@"; do
  if [ "$a" = --git-common-dir ]; then printf '%s/gd\\377\\n' '${f.base}'; exit 0; fi
done`,
    );
    await expectUnknownState(
      f,
      wt,
      sha,
      [["--delete-branch"], ["--delete-branch", "--base", "origin/main"]],
      { PATH: fake },
    );
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
      PATH: fake,
    });
    // The name as git printed it, with the byte rendered.
    expect(r.json.message).toContain("gd\\xff");
  });
});

describe("worktree remove: a symbolic ref whose name is not UTF-8", () => {
  it("refuses, since an --exclude of the decoded name would match nothing and git would follow the ref, with and without --base", async () => {
    const f = makeFixture();
    const { wt, sha } = makePushed(f);
    // What git prints for `git symbolic-ref refs/remotes/origin/<x 0xff>
    // refs/heads/feat` on a file system that allows the name; the Linux
    // tests make the real one.
    const fake = gitWrapper(
      f,
      "git-bytes-symref",
      `for a in "$@"; do
  if [ "$a" = '--format=%(refname)%09%(symref)' ]; then printf 'refs/remotes/origin/x\\377\\trefs/heads/feat\\n'; exit 0; fi
done`,
    );
    await expectUnknownState(
      f,
      wt,
      sha,
      [["--delete-branch"], ["--delete-branch", "--base", "origin/main"]],
      { PATH: fake },
    );
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
      PATH: fake,
    });
    expect(r.json.message).toContain(
      "the symbolic ref refs/remotes/origin/x\\xff has a name that is not UTF-8",
    );
  });
});

const REFTABLE_SUPPORTED = (() => {
  try {
    const probe = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-rt-"),
    );
    try {
      git(probe, ["init", "-q", "--ref-format=reftable", "probe"]);
      return true;
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
})();

describe.skipIf(!REFTABLE_SUPPORTED)(
  "worktree remove: a symbolic ref of a reftable common stack whose name is not ASCII",
  () => {
    // The same visible name in both Unicode normalization forms. git converts
    // a command-line argument to NFC where core.precomposeunicode is on (macOS
    // sets it at init) but a reftable record keeps the bytes it was written
    // with, so a decomposed name could never be matched by an `--exclude`
    // argument and the walk would follow the ref to the branch.
    const NFD_NAME = "cafe\u0301";
    const NFC_NAME = "caf\u00e9";

    /** Writes `refs/remotes/origin/<name>` as a symbolic ref (or, when
     * `symbolic` is false, a plain one at the sha `to`) with precompose off,
     * so the stored bytes are the ones in `name` on every platform. */
    function writeRef(f: Fixture, name: string, symbolic: boolean, to: string) {
      git(f.repo, [
        "-c",
        "core.precomposeunicode=false",
        symbolic ? "symbolic-ref" : "update-ref",
        `refs/remotes/origin/${name}`,
        to,
      ]);
    }

    it.each([
      ["decomposed (NFD)", NFD_NAME],
      ["precomposed (NFC)", NFC_NAME],
    ])(
      "keeps the branch a symbolic ref with a %s name points at, with and without --base",
      async (_form, name) => {
        const f = makeFixture({ refFormat: "reftable" });
        const { wt, sha } = makeUnpushed(f);
        writeRef(f, name, true, "refs/heads/feat");
        // The stored name is the one written, in the form written.
        const stored = execFileSync(
          "git",
          [
            "-c",
            "core.precomposeunicode=false",
            "for-each-ref",
            "--format=%(refname)",
            "refs/remotes",
          ],
          {
            cwd: f.repo,
            encoding: "utf8",
            env: { ...process.env, ...GIT_ENV },
          },
        );
        expect(stored.split("\n")).toContain(`refs/remotes/origin/${name}`);
        await expectUnknownState(f, wt, sha, SYMLINK_FLAG_SETS);
        const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
        expect(r.json.message).toContain("non-ASCII character");
        expect(fs.existsSync(wt)).toBe(true);
        // Every refusal can be overridden, as for any unknown state.
        const forced = await cliBounded(f.work, [
          "remove",
          wt,
          "--delete-branch",
          "--force",
        ]);
        expect(forced.code, forced.stdout + forced.stderr).toBe(0);
        expect(forced.json.branch.deleted).toBe(true);
      },
    );

    it("still reports the unpushed commits behind a symbolic ref with an ASCII name", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      git(f.repo, [
        "symbolic-ref",
        "refs/remotes/origin/self",
        "refs/heads/feat",
      ]);
      for (const flags of SYMLINK_FLAG_SETS.filter((s) => s.length > 0)) {
        const r = await cliBounded(f.work, ["remove", wt, ...flags]);
        expect(r.code, r.stdout + r.stderr).toBe(2);
        expect(r.json.reason).toBe("unpushed_commits");
      }
      expect(git(f.repo, ["rev-parse", "refs/heads/feat"]).trim()).toBe(sha);
      expect(fs.existsSync(wt)).toBe(true);
    });

    it.each([
      ["decomposed (NFD)", NFD_NAME],
      ["precomposed (NFC)", NFC_NAME],
    ])(
      "removes a pushed branch beside a plain remote-tracking ref with a %s non-ASCII name",
      async (_form, name) => {
        const f = makeFixture({ refFormat: "reftable" });
        const { wt, sha } = makeUnpushed(f);
        // A plain ref is not excluded, so `--remotes` counts it as the push it
        // is, and the commit is on a remote-tracking ref.
        writeRef(f, name, false, sha);
        const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.json.branch.deleted).toBe(true);
        expect(fs.existsSync(wt)).toBe(false);
      },
    );
  },
);

describe.skipIf(process.platform !== "linux")(
  "worktree remove: ref names that are not UTF-8, which a Linux file system allows",
  () => {
    it("keeps a branch that a file link with such a name aliases next to a decoy at the decoded name, with and without --base", async () => {
      const f = makeFixture();
      const { wt, sha } = makeUnpushed(f);
      const origin = path.join(commonDirOf(f), "refs/remotes/origin");
      fs.symlinkSync("../../heads/feat", bytePathIn(origin, BAD_NAME));
      fs.writeFileSync(path.join(origin, DECODED_NAME), `${f.mainSha}\n`);
      expect(await unpushedPerGit(wt)).toBe("");
      await expectUnknownState(f, wt, sha, SYMLINK_FLAG_SETS);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain(
        "refs/remotes/origin/x\\xff is a symbolic link",
      );
    });

    it("keeps a branch that a directory link with such a name aliases next to a file decoy, with and without --base", async () => {
      const f = makeFixture();
      const { wt, sha } = makeUnpushed(f);
      const remotes = path.join(commonDirOf(f), "refs/remotes");
      const dirName = Buffer.from([0x6d, 0xfe]);
      fs.symlinkSync("../heads", bytePathIn(remotes, dirName));
      fs.writeFileSync(path.join(remotes, "m�"), `${f.mainSha}\n`);
      expect(await unpushedPerGit(wt)).toBe("");
      await expectUnknownState(f, wt, sha, SYMLINK_FLAG_SETS);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain(
        "refs/remotes/m\\xfe is a symbolic link",
      );
    });

    it("keeps a branch that a symbolic ref with such a name points at, with and without --base", async () => {
      const f = makeFixture();
      const { wt, sha } = makeUnpushed(f);
      await shBounded(
        f.repo,
        `git symbolic-ref "refs/remotes/origin/$(printf 'x\\377')" refs/heads/feat`,
      );
      expect(await unpushedPerGit(wt)).toBe("");
      await expectUnknownState(f, wt, sha, SYMLINK_FLAG_SETS);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain(
        "the symbolic ref refs/remotes/origin/x\\xff has a name that is not UTF-8",
      );
    });
  },
);

describe("worktree remove: the ref backend is the one git reports", () => {
  /** A `gitWrapper` PATH whose git answers `rev-parse --show-ref-format`
   * with the `FAKE_REF_FORMAT` line, or fails it when that is unset. */
  function fakeRefFormat(f: Fixture): string {
    return gitWrapper(
      f,
      "git-fake-ref-format",
      `for a in "$@"; do
  if [ "$a" = --show-ref-format ]; then
    if [ -z "\${FAKE_REF_FORMAT+set}" ]; then echo 'fatal: injected' >&2; exit 3; fi
    printf '%s\\n' "$FAKE_REF_FORMAT"; exit 0
  fi
done`,
    );
  }

  it("walks the store for every answer that is not exactly reftable", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    const common = commonDirOf(f);
    fs.symlinkSync(
      "../../heads/feat",
      path.join(common, "refs/remotes/origin/self"),
    );
    // A stray, clean reftable stack beside the files store: an answer read
    // as `reftable` would inspect this empty stack, trust it, and never
    // reach the link under refs.
    fs.mkdirSync(path.join(common, "reftable"));
    fs.writeFileSync(path.join(common, "reftable/tables.list"), "");
    expect(untrustedReftableStore(common)).toBeUndefined();
    const fake = fakeRefFormat(f);
    // An older git that does not know the option echoes it back.
    for (const answer of [
      "--show-ref-format",
      "bogus",
      "reftable ",
      " reftable",
      "Reftable",
    ]) {
      await expectUnknownState(f, wt, sha, [["--delete-branch"]], {
        PATH: fake,
        FAKE_REF_FORMAT: answer,
      });
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
        PATH: fake,
        FAKE_REF_FORMAT: answer,
      });
      expect(r.json.message, answer).toContain(
        "refs/remotes/origin/self is a symbolic link",
      );
    }
  });

  it("refuses when git cannot name the format", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    await expectUnknownState(f, wt, sha, [["--delete-branch"]], {
      PATH: fakeRefFormat(f),
    });
  });

  it("is not told 'reftable' by an environment config that the repository does not carry", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    fs.symlinkSync(
      "../../heads/feat",
      path.join(commonDirOf(f), "refs/remotes/origin/self"),
    );
    await expectUnknownState(f, wt, sha, [["--delete-branch"]], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "extensions.refStorage",
      GIT_CONFIG_VALUE_0: "reftable",
    });
  });

  const CONFIG_SAYS_REFTABLE: [
    string,
    (f: Fixture, wt: string) => Promise<void>,
  ][] = [
    [
      "the repository config without format version 1",
      async (f) => {
        await gitBounded(f.repo, [
          "config",
          "--unset",
          "core.repositoryformatversion",
        ]);
        await gitBounded(f.repo, [
          "config",
          "extensions.refStorage",
          "reftable",
        ]);
      },
    ],
    [
      "an included config file",
      async (f) => {
        const inc = path.join(f.base, "reftable.cfg");
        fs.writeFileSync(inc, "[extensions]\n\trefStorage = reftable\n");
        await gitBounded(f.repo, [
          "config",
          "core.repositoryformatversion",
          "1",
        ]);
        await gitBounded(f.repo, ["config", "include.path", inc]);
      },
    ],
    [
      "the worktree's own config",
      async (f, wt) => {
        await gitBounded(f.repo, [
          "config",
          "core.repositoryformatversion",
          "1",
        ]);
        await gitBounded(f.repo, [
          "config",
          "extensions.worktreeConfig",
          "true",
        ]);
        await gitBounded(wt, [
          "config",
          "--worktree",
          "extensions.refStorage",
          "reftable",
        ]);
      },
    ],
  ];

  it.each(CONFIG_SAYS_REFTABLE)(
    "walks the loose store git keeps using when %s names reftable, with and without --base",
    async (_name, configure) => {
      const f = makeFixture();
      const { wt, sha } = makeUnpushed(f);
      const common = commonDirOf(f);
      await configure(f, wt);
      fs.symlinkSync(
        "../../heads/feat",
        path.join(common, "refs/remotes/origin/self"),
      );
      if (SHOW_REF_FORMAT_SUPPORTED) {
        expect(
          oneLine(await gitBounded(wt, ["rev-parse", "--show-ref-format"])),
        ).toBe("files");
      }
      expect(await unpushedPerGit(f.repo)).toBe("");
      await expectUnknownState(f, wt, sha, [
        ...SYMLINK_FLAG_SETS,
        ["--delete-branch", "--base", "origin/self"],
      ]);
    },
  );
});

describe("worktree remove: the common directory is git's own answer, byte for byte", () => {
  it("walks a common directory whose name ends in a space, with and without --base", async () => {
    const f = makeFixture({ gitDirName: "gd " });
    const { wt, sha } = makeUnpushed(f);
    const common = commonDirOf(f);
    expect(common).toBe(path.join(f.base, "gd "));
    fs.symlinkSync(
      "../../heads/feat",
      path.join(common, "refs/remotes/origin/self"),
    );
    expect(await unpushedPerGit(f.repo)).toBe("");
    await expectUnknownState(f, wt, sha, [
      ...SYMLINK_FLAG_SETS,
      ["--delete-branch", "--base", "origin/self"],
    ]);
  });

  it("removes a pushed branch of such a repository as before", async () => {
    const f = makeFixture({ gitDirName: "gd " });
    const { wt } = makeUnpushed(f);
    git(wt, ["push", "-q", "origin", "feat"]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });

  it("removes a pushed branch of a worktree linked with relative paths", async (ctx) => {
    const f = makeFixture();
    const wt = path.join(f.base, "wt-rel");
    // `--relative-paths` is newer than some git this suite runs on.
    if (
      gitTry(f.repo, [
        "worktree",
        "add",
        "-q",
        "--relative-paths",
        "-b",
        "feat",
        wt,
      ]) === undefined
    ) {
      ctx.skip();
    }
    commitHere(wt, "feat.txt", "pushed work");
    git(wt, ["push", "-q", "origin", "feat"]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });
});

/** A pushed branch: what a check that refuses for no reason would keep. */
function makePushed(f: Fixture): { wt: string; sha: string } {
  const made = makeUnpushed(f);
  git(made.wt, ["push", "-q", "origin", "feat"]);
  git(f.repo, ["fetch", "-q", "origin"]);
  return made;
}

describe("worktree remove: packed-refs is read as git reads it", () => {
  it("keeps a branch whose remote-tracking ref sits in a packed-refs link to a file inside the worktree, with and without --base", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    const common = commonDirOf(f);
    git(f.repo, ["pack-refs", "--all"]);
    // An ignored file in the worktree: `git worktree remove` deletes it,
    // and with it every ref git read through the link.
    fs.mkdirSync(path.join(common, "info"), { recursive: true });
    fs.appendFileSync(path.join(common, "info/exclude"), "\nstore.txt\n");
    const store = path.join(wt, "store.txt");
    // The header promises sorted lines (git looks single refs up by
    // bisection), so the added ref goes in at its place. The fixture has no
    // annotated tags, hence no peeled `^` lines.
    const [header = "", ...lines] = fs
      .readFileSync(path.join(common, "packed-refs"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    lines.push(`${sha} refs/remotes/origin/feat`);
    lines.sort((a, b) =>
      a.slice(a.indexOf(" ")) < b.slice(b.indexOf(" ")) ? -1 : 1,
    );
    fs.writeFileSync(store, `${[header, ...lines].join("\n")}\n`);
    fs.rmSync(path.join(common, "packed-refs"));
    fs.symlinkSync(store, path.join(common, "packed-refs"));
    expect(await unpushedPerGit(f.repo)).toBe("");
    await expectUnknownState(f, wt, sha, [
      ...SYMLINK_FLAG_SETS,
      ["--delete-branch", "--base", "origin/feat"],
    ]);
  });

  it("removes a pushed branch whose refs are all packed, as before", async () => {
    const f = makeFixture();
    const { wt } = makePushed(f);
    git(f.repo, ["pack-refs", "--all"]);
    expect(
      fs.lstatSync(path.join(commonDirOf(f), "packed-refs")).isFile(),
    ).toBe(true);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });
});

describe("worktree remove: a ref store git was told to keep elsewhere", () => {
  /** A copy of the refs of `f` in `<base>/store`, as git reads a store
   * that `extensions.refStorage = files://<store>` or the same value in
   * `GIT_REFERENCE_BACKEND` names, with a link in it that makes `feat`
   * read as a remote-tracking ref. Set up before anything is moved. */
  function storeElsewhere(f: Fixture, wt: string): string {
    const common = commonDirOf(f);
    const privateDir = absoluteGitPath(wt, "--git-dir");
    const store = path.join(f.base, "store");
    fs.cpSync(path.join(common, "refs"), path.join(store, "refs"), {
      recursive: true,
    });
    fs.copyFileSync(path.join(common, "HEAD"), path.join(store, "HEAD"));
    // git reads the worktree's own HEAD from the store as well.
    const own = path.join(store, "worktrees", path.basename(privateDir));
    fs.mkdirSync(own, { recursive: true });
    fs.copyFileSync(path.join(privateDir, "HEAD"), path.join(own, "HEAD"));
    fs.symlinkSync(
      "../../heads/feat",
      path.join(store, "refs/remotes/origin/self"),
    );
    return store;
  }

  it.skipIf(!REF_STORAGE_LOCATION_SUPPORTED)(
    "keeps a branch when extensions.refStorage puts the refs in another directory, with and without --base",
    async () => {
      const f = makeFixture();
      const { wt, sha } = makeUnpushed(f);
      const common = commonDirOf(f);
      const store = storeElsewhere(f, wt);
      await gitBounded(f.repo, ["config", "core.repositoryformatversion", "1"]);
      await gitBounded(f.repo, [
        "config",
        "extensions.refStorage",
        `files://${store}`,
      ]);
      // git reads the link in the other store, and the common directory's own
      // refs tree holds nothing the walk would refuse.
      expect(await unpushedPerGit(f.repo)).toBe("");
      expect(fs.existsSync(path.join(common, "refs/remotes/origin/self"))).toBe(
        false,
      );
      await expectUnknownState(f, wt, sha, [
        ...SYMLINK_FLAG_SETS,
        ["--delete-branch", "--base", "origin/self"],
      ]);
    },
  );

  it.skipIf(!REF_STORAGE_LOCATION_SUPPORTED)(
    "keeps a branch when GIT_CONFIG hides the repository config from git config, since git still reads the store that config names, with and without --base",
    async () => {
      const hiding = path.join(os.tmpdir(), "agent-primitives-hiding.cfg");
      fs.writeFileSync(hiding, "[extensions]\n\trefStorage = files\n");
      tmpDirs.push(hiding);
      for (const env of [
        { GIT_CONFIG: "/dev/null" },
        // A config of the caller's that names a bare format: an all-scope
        // read would answer `files` and nothing else.
        { GIT_CONFIG: hiding },
      ]) {
        const f = makeFixture();
        const { wt, sha } = makeUnpushed(f);
        const store = storeElsewhere(f, wt);
        await gitBounded(f.repo, [
          "config",
          "core.repositoryformatversion",
          "1",
        ]);
        await gitBounded(f.repo, [
          "config",
          "extensions.refStorage",
          `files://${store}`,
        ]);
        // git's own reading of the format is untouched by the variable.
        expect(await unpushedPerGit(wt, "feat", env)).toBe("");
        expect(
          oneLine(
            await gitBounded(
              wt,
              ["config", "--get-all", "extensions.refStorage"],
              20_000,
              env,
            ).catch(() => "\n"),
          ),
        ).not.toContain("files://");
        await expectUnknownState(
          f,
          wt,
          sha,
          [...SYMLINK_FLAG_SETS, ["--delete-branch", "--base", "origin/self"]],
          env,
        );
      }
    },
  );

  it("removes a pushed branch whose config includes a file naming a store elsewhere, which git's format reader does not follow", async () => {
    const f = makeFixture();
    const { wt } = makePushed(f);
    const inc = path.join(f.base, "elsewhere.cfg");
    fs.writeFileSync(
      inc,
      `[extensions]\n\trefStorage = files://${path.join(f.base, "no-such-store")}\n`,
    );
    await gitBounded(f.repo, ["config", "core.repositoryformatversion", "1"]);
    await gitBounded(f.repo, ["config", "include.path", inc]);
    // git keeps reading the common directory: the branch is pushed there.
    expect(await unpushedPerGit(wt)).toBe("");
    if (SHOW_REF_FORMAT_SUPPORTED) {
      expect(
        oneLine(await gitBounded(wt, ["rev-parse", "--show-ref-format"])),
      ).toBe("files");
    }
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });

  it("fails closed when the repository config cannot be inspected or read, or is past the size bound", () => {
    // A config git can open but this process cannot is not a layout a test
    // can lay down (git itself refuses a repository without one), so the
    // file system calls are faked for exactly that path.
    const f = makeFixture();
    const { wt } = makePushed(f);
    const configPath = path.join(commonDirOf(f), "config");
    const control = unpushedCommits(wt);
    expect(control.error, control.stderr).toBeUndefined();
    expect(control.status).toBe(0);
    expect(control.stdout.trim()).toBe("");
    const realStat = fs.statSync.bind(fs) as (
      p: fs.PathLike,
      o?: fs.StatSyncOptions,
    ) => fs.Stats | fs.BigIntStats;
    const denied = vi.spyOn(fs, "statSync").mockImplementation(((
      p: fs.PathLike,
      o?: fs.StatSyncOptions,
    ) => {
      if (String(p) === configPath) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
      return realStat(p, o);
    }) as typeof fs.statSync);
    try {
      expect(unpushedCommits(wt).error).toBe(
        `the repository config ${JSON.stringify(configPath)} cannot be inspected: EACCES: permission denied`,
      );
    } finally {
      denied.mockRestore();
    }
    const notAFile = vi.spyOn(fs, "statSync").mockImplementation(((
      p: fs.PathLike,
      o?: fs.StatSyncOptions,
    ) =>
      // The common directory's own stats stand in: a directory, not a file.
      String(p) === configPath
        ? realStat(path.dirname(configPath), o)
        : realStat(p, o)) as typeof fs.statSync);
    try {
      expect(unpushedCommits(wt).error).toBe(
        `the repository config ${JSON.stringify(configPath)} is not a regular file`,
      );
    } finally {
      notAFile.mockRestore();
    }
    const oversized = vi.spyOn(fs, "statSync").mockImplementation(((
      p: fs.PathLike,
      o?: fs.StatSyncOptions,
    ) => {
      const st = realStat(p, o);
      if (String(p) !== configPath) return st;
      return Object.assign(
        Object.create(Object.getPrototypeOf(st) as object) as object,
        st,
        { size: BigInt(16 * 1024 * 1024 + 1) },
      );
    }) as typeof fs.statSync);
    try {
      expect(unpushedCommits(wt).error).toContain(
        `the repository config ${JSON.stringify(configPath)} is larger than`,
      );
    } finally {
      oversized.mockRestore();
    }
    const realRead = fs.readFileSync.bind(fs) as (
      p: fs.PathLike | number,
      o?: unknown,
    ) => unknown;
    const unreadable = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathLike | number,
      o?: unknown,
    ) => {
      if (String(p) === configPath) {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      }
      return realRead(p, o);
    }) as typeof fs.readFileSync);
    try {
      expect(unpushedCommits(wt).error).toBe(
        `the repository config ${JSON.stringify(configPath)} cannot be read: EIO: i/o error`,
      );
    } finally {
      unreadable.mockRestore();
    }
    expect(unpushedCommits(wt).error).toBeUndefined();
  });

  it.skipIf(!REFERENCE_BACKEND_ENV_SUPPORTED)(
    "keeps a branch when GIT_REFERENCE_BACKEND puts the refs in another directory, with and without --base",
    async () => {
      const f = makeFixture();
      const { wt, sha } = makeUnpushed(f);
      const common = commonDirOf(f);
      const env = { GIT_REFERENCE_BACKEND: `files://${storeElsewhere(f, wt)}` };
      for (const flags of [
        ...SYMLINK_FLAG_SETS,
        ["--delete-branch", "--base", "origin/self"],
      ]) {
        const r = await cliBounded(f.work, ["remove", wt, ...flags], env);
        const label = `${flags.join(" ")}: ${r.stdout}${r.stderr}`;
        expect(r.code, label).toBe(2);
        expect(r.json.reason, label).toBe("unpushed_state_unknown");
        expect(r.json.message, label).toContain("GIT_REFERENCE_BACKEND");
      }
      // Neither store lost the worktree or the branch.
      const listed = parseWorktreeList(
        await gitBounded(f.repo, ["worktree", "list", "--porcelain"]),
      ).map((w) => w.path);
      expect(listed).toContain(wt);
      expect(
        fs.readFileSync(path.join(common, "refs/heads/feat"), "utf8"),
      ).toBe(`${sha}\n`);
      expect(
        fs.readFileSync(path.join(f.base, "store/refs/heads/feat"), "utf8"),
      ).toBe(`${sha}\n`);
    },
  );

  it("keeps a branch when GIT_REF_STORAGE_FORMAT names a store, with and without --base", async () => {
    // Not gated: newer git reads this variable first (released git ignores
    // it), and the guard refuses on the value alone.
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    const env = {
      GIT_REF_STORAGE_FORMAT: `files://${storeElsewhere(f, wt)}`,
    };
    for (const flags of SYMLINK_FLAG_SETS) {
      const r = await cliBounded(f.work, ["remove", wt, ...flags], env);
      const label = `${flags.join(" ")}: ${r.stdout}${r.stderr}`;
      expect(r.code, label).toBe(2);
      expect(r.json.reason, label).toBe("unpushed_state_unknown");
      expect(r.json.message, label).toContain("GIT_REF_STORAGE_FORMAT");
    }
    expect(
      fs.readFileSync(path.join(commonDirOf(f), "refs/heads/feat"), "utf8"),
    ).toBe(`${sha}\n`);
  });

  it("refuses when GIT_REF_STORAGE_FORMAT and GIT_REFERENCE_BACKEND name different formats", async () => {
    const f = makeFixture();
    const { wt } = makePushed(f);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
      GIT_REF_STORAGE_FORMAT: "reftable",
      GIT_REFERENCE_BACKEND: "files",
    });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_state_unknown");
    expect(r.json.message).toContain("name different ref formats");
  });

  it("removes a pushed branch when both ref-format variables say files", async () => {
    const f = makeFixture();
    const { wt } = makePushed(f);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
      GIT_REF_STORAGE_FORMAT: "files",
      GIT_REFERENCE_BACKEND: "files",
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });

  it("removes a pushed branch when GIT_REFERENCE_BACKEND or the config names a format alone", async () => {
    for (const env of [
      { GIT_REFERENCE_BACKEND: "files" },
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "extensions.refStorage",
        GIT_CONFIG_VALUE_0: "files",
      },
    ]) {
      const f = makeFixture();
      const { wt } = makePushed(f);
      const r = await cliBounded(
        f.work,
        ["remove", wt, "--delete-branch"],
        env,
      );
      expect(r.code, JSON.stringify(env) + r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
    }
  });

  /** A `gitWrapper` PATH whose git answers the config read of
   * `extensions.refStorage` with `FAKE_STORAGE` (printf format, so `\0`
   * separates values) and exit status `FAKE_STORAGE_STATUS`. It reads the
   * config bytes on stdin to the end first, as git does: exiting before the
   * CLI has written them makes the write fail with EPIPE, which the check
   * rightly reads as unknown, so the outcome would hang on scheduling. The
   * loop is a shell builtin because the fixed PATH holds no `cat`. */
  function fakeStorageConfig(f: Fixture): string {
    return gitWrapper(
      f,
      "git-fake-storage",
      `for a in "$@"; do
  if [ "$a" = extensions.refStorage ]; then
    while IFS= read -r line || [ -n "$line" ]; do :; done
    printf "$FAKE_STORAGE"; echo 'fatal: injected' >&2; exit "$FAKE_STORAGE_STATUS"
  fi
done`,
    );
  }

  it("refuses a pushed branch for every configured value that is more than a format name", async () => {
    const f = makeFixture();
    const { wt, sha } = makePushed(f);
    const fake = fakeStorageConfig(f);
    for (const value of [
      "files://elsewhere\\0",
      "reftable:///elsewhere\\0",
      "files\\0files://elsewhere\\0",
      "Files\\0",
      "\\0",
      "",
    ]) {
      await expectUnknownState(f, wt, sha, [["--delete-branch"]], {
        PATH: fake,
        FAKE_STORAGE: value,
        FAKE_STORAGE_STATUS: "0",
      });
    }
  });

  it("removes a pushed branch whose config names formats alone", async () => {
    for (const value of ["files\\0", "reftable\\0", "files\\0reftable\\0"]) {
      const f = makeFixture();
      const { wt } = makePushed(f);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
        PATH: fakeStorageConfig(f),
        FAKE_STORAGE: value,
        FAKE_STORAGE_STATUS: "0",
      });
      expect(r.code, value + r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
    }
  });

  it("refuses a pushed branch when the config read fails, whatever it printed", async () => {
    const f = makeFixture();
    const { wt, sha } = makePushed(f);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
      PATH: fakeStorageConfig(f),
      FAKE_STORAGE: "files\\0",
      FAKE_STORAGE_STATUS: "3",
    });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_state_unknown");
    // git's own failure, not a judgement of the value it printed.
    expect(r.json.message).toContain("fatal: injected");
    expect(
      (await gitBounded(f.repo, ["rev-parse", "--verify", "feat"])).trim(),
    ).toBe(sha);
  });
});

describe("worktree remove: plain layouts under refs/remotes are unchanged", () => {
  it("removes a pushed branch with nested remote branches and packed refs, with and without --base", async () => {
    for (const base of [[], ["--base", "origin/main"]]) {
      const f = makeFixture();
      const { wt } = makeUnpushed(f);
      git(wt, ["push", "-q", "origin", "feat:team/feat"]);
      git(f.repo, ["fetch", "-q", "origin"]);
      git(f.repo, ["pack-refs", "--all"]);
      git(wt, ["push", "-q", "origin", "feat:team/more/feat"]);
      git(f.repo, ["fetch", "-q", "origin"]);
      const r = await cliBounded(f.work, [
        "remove",
        wt,
        "--delete-branch",
        ...base,
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
    }
  });

  it("still refuses an unpushed branch as unpushed commits", async () => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
    expect(git(f.repo, ["rev-parse", "feat"]).trim()).toBe(sha);
  });

  it("removes a pushed branch next to tags, nested branches and a stash", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    git(f.repo, ["tag", "v1"]);
    git(f.repo, ["tag", "-a", "-m", "annotated", "v2"]);
    git(f.repo, ["branch", "team/one"]);
    git(f.repo, ["branch", "team/deep/two"]);
    write(f.repo, "a.txt", "stashed\n");
    git(f.repo, ["stash", "-q"]);
    git(wt, ["push", "-q", "origin", "feat"]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });
});

describe.skipIf(!REFTABLE_SUPPORTED)(
  "worktree remove: a reftable repository has no loose refs to walk",
  () => {
    it("behaves as before: a pushed branch goes, an unpushed one stays", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      expect(git(f.repo, ["config", "extensions.refStorage"]).trim()).toBe(
        "reftable",
      );
      const { wt, sha } = makeUnpushed(f);
      const refused = await cliBounded(f.work, [
        "remove",
        wt,
        "--delete-branch",
      ]);
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      expect(refused.json.reason).toBe("unpushed_commits");
      expect(git(f.repo, ["rev-parse", "feat"]).trim()).toBe(sha);
      git(wt, ["push", "-q", "origin", "feat"]);
      git(f.repo, ["fetch", "-q", "origin"]);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
    });

    it("does not read a stray file system symlink under refs/remotes, which git ignores too", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      const dir = path.join(commonDirOf(f), "refs/remotes/origin");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync("../../heads/feat", path.join(dir, "self"));
      expect(await unpushedPerGit(f.repo)).toBe(sha);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("unpushed_commits");
    });

    /** The one table of the fixture's stack after compaction, with a
     * remote-tracking ref at `sha` in it, so git calls the branch pushed
     * and the table holds every ref there is. */
    function oneTable(
      f: Fixture,
      sha: string,
    ): { common: string; table: string } {
      const common = commonDirOf(f);
      git(f.repo, ["update-ref", "refs/remotes/origin/feat", sha]);
      git(f.repo, ["pack-refs", "--all"]);
      const tables = fs
        .readFileSync(path.join(common, "reftable/tables.list"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(tables).toHaveLength(1);
      const [table = ""] = tables;
      return { common, table };
    }

    it("keeps a branch whose table is a link to an ignored file inside the worktree, with and without --base", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      const { common, table } = oneTable(f, sha);
      // The removal deletes the ignored file, and with it every ref.
      fs.mkdirSync(path.join(common, "info"), { recursive: true });
      fs.appendFileSync(path.join(common, "info/exclude"), "\nstash.ref\n");
      const stash = path.join(wt, "stash.ref");
      fs.renameSync(path.join(common, "reftable", table), stash);
      fs.symlinkSync(stash, path.join(common, "reftable", table));
      expect(await unpushedPerGit(wt)).toBe("");
      expect(
        oneLine(await gitBounded(wt, ["rev-parse", "--show-ref-format"])),
      ).toBe("reftable");
      await expectUnknownState(f, wt, sha, [
        ...SYMLINK_FLAG_SETS,
        ["--delete-branch", "--base", "origin/feat"],
      ]);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain(`reftable/${table} is a symbolic link`);
    });

    it("keeps a branch whose tables.list is a link to a file inside the worktree, with and without --base", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      const { common } = oneTable(f, sha);
      fs.mkdirSync(path.join(common, "info"), { recursive: true });
      fs.appendFileSync(path.join(common, "info/exclude"), "\nlist.txt\n");
      const list = path.join(wt, "list.txt");
      fs.renameSync(path.join(common, "reftable/tables.list"), list);
      fs.symlinkSync(list, path.join(common, "reftable/tables.list"));
      expect(await unpushedPerGit(wt)).toBe("");
      await expectUnknownState(f, wt, sha, [
        ...SYMLINK_FLAG_SETS,
        ["--delete-branch", "--base", "origin/feat"],
      ]);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain(
        "reftable/tables.list is a symbolic link",
      );
    });

    it("removes a pushed branch after a compaction, as before", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      oneTable(f, sha);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
    });

    /** What `git for-each-ref refs/remotes` lists from the common stack
     * alone (`--git-dir`), asked with a bound. */
    async function commonRemoteRefs(f: Fixture): Promise<string> {
      return gitBounded(f.repo, [
        `--git-dir=${commonDirOf(f)}`,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/remotes",
      ]);
    }

    /** What `git for-each-ref refs/remotes` lists in the worktree, whose
     * own reftable stack git merges in. */
    async function worktreeRemoteRefs(wt: string): Promise<string> {
      return gitBounded(wt, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/remotes",
      ]);
    }

    /**
     * Writes `refs` (name, sha) into the linked worktree's own reftable
     * stack, which no git command does for a remote-tracking ref: the tables
     * come from a scratch repository that reads the fixture's objects
     * through an alternate, and are listed after the tables the stack
     * holds. Returns the worktree's private git directory.
     */
    function forgePrivateStack(
      f: Fixture,
      wt: string,
      refs: { name: string; sha: string }[],
    ): string {
      return forgePrivateStackWith(f, wt, (donor) => {
        for (const ref of refs) {
          git(donor, ["update-ref", ref.name, ref.sha]);
        }
      });
    }

    /** `forgePrivateStack` with the donor repository left to `fill`. */
    function forgePrivateStackWith(
      f: Fixture,
      wt: string,
      fill: (donor: string) => void,
    ): string {
      const privateDir = absoluteGitPath(wt, "--git-dir");
      expect(privateDir).not.toBe(commonDirOf(f));
      expect(fs.statSync(path.join(privateDir, "reftable")).isDirectory()).toBe(
        true,
      );
      const donor = path.join(f.base, "donor");
      git(f.base, ["init", "-q", "--ref-format=reftable", donor]);
      fs.writeFileSync(
        path.join(donor, ".git/objects/info/alternates"),
        `${path.join(commonDirOf(f), "objects")}\n`,
      );
      // The donor's tables carry its HEAD, which would replace the
      // worktree's own: point it where the worktree's already points.
      git(donor, ["symbolic-ref", "HEAD", "refs/heads/feat"]);
      fill(donor);
      const listed = fs
        .readFileSync(path.join(donor, ".git/reftable/tables.list"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(listed.length).toBeGreaterThan(0);
      for (const table of listed) {
        fs.copyFileSync(
          path.join(donor, ".git/reftable", table),
          path.join(privateDir, "reftable", table),
        );
      }
      fs.appendFileSync(
        path.join(privateDir, "reftable/tables.list"),
        `${listed.join("\n")}\n`,
      );
      return privateDir;
    }

    it("keeps a branch whose only remote-tracking ref sits in the worktree's own reftable stack, with and without --base", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      forgePrivateStack(f, wt, [{ name: "refs/remotes/origin/feat", sha }]);
      // The premise: git lists the ref in the worktree and counts the commit
      // as pushed, while the common stack holds no such ref, so removing the
      // worktree would drop the only ref that holds the commit.
      expect(await worktreeRemoteRefs(wt)).toContain(
        `refs/remotes/origin/feat ${sha}`,
      );
      expect(await commonRemoteRefs(f)).not.toContain("origin/feat");
      expect(await unpushedPerGit(wt)).toBe("");
      await expectUnknownState(f, wt, sha, [
        ...SYMLINK_FLAG_SETS,
        ["--delete-branch", "--base", "origin/main"],
      ]);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain("worktrees/<name>/reftable");
    });

    it("keeps a branch when the worktree's own reftable stack re-points a remote-tracking ref of the common stack", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      forgePrivateStack(f, wt, [{ name: "refs/remotes/origin/main", sha }]);
      // Both stacks name origin/main, at different commits.
      expect(await commonRemoteRefs(f)).toContain(
        `refs/remotes/origin/main ${f.mainSha}`,
      );
      expect(await worktreeRemoteRefs(wt)).not.toBe(await commonRemoteRefs(f));
      await expectUnknownState(f, wt, sha, [
        ["--delete-branch"],
        ["--delete-branch", "--base", "origin/main"],
      ]);
    });

    /** What one remote-tracking ref lists as in the worktree (`own`) and in
     * the common stack alone, with the symbolic ref's target in brackets. */
    async function listedAs(
      f: Fixture,
      wt: string,
      ref: string,
    ): Promise<{ own: string; common: string }> {
      const view = (dir: string, before: string[]): Promise<string> =>
        gitBounded(dir, [
          ...before,
          "for-each-ref",
          "--format=%(refname) %(objectname) [%(symref)]",
          ref,
        ]);
      return {
        own: (await view(wt, [])).trim(),
        common: (await view(wt, [`--git-dir=${commonDirOf(f)}`])).trim(),
      };
    }

    it("keeps a branch when the worktree's own reftable stack shadows a symbolic remote-tracking ref of the common stack with a plain one at the same commit", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      // The common stack holds origin/feat as a symbolic ref to the local
      // branch; the private stack forges a plain ref of that name at the
      // branch tip. The names and the object names of both listings agree,
      // only the symbolic ref column tells them apart.
      git(f.repo, [
        "symbolic-ref",
        "refs/remotes/origin/feat",
        "refs/heads/feat",
      ]);
      forgePrivateStack(f, wt, [{ name: "refs/remotes/origin/feat", sha }]);
      const seen = await listedAs(f, wt, "refs/remotes/origin/feat");
      expect(seen.own).toBe(`refs/remotes/origin/feat ${sha} []`);
      expect(seen.common).toBe(
        `refs/remotes/origin/feat ${sha} [refs/heads/feat]`,
      );
      // git counts the commit as pushed in the worktree, because the plain
      // ref is no symbolic ref to leave out of the walk.
      expect(await unpushedPerGit(wt)).toBe("");
      await expectUnknownState(f, wt, sha, [
        ["--delete-branch"],
        ["--delete-branch", "--base", "origin/main"],
      ]);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain("worktrees/<name>/reftable");
    });

    it("refuses, fail closed, when the common stack holds symbolic remote-tracking refs that resolve differently in the worktree, and --force removes", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      git(wt, ["push", "-q", "origin", "feat"]);
      // `HEAD` resolves to the branch the asking worktree is on, and a ref
      // under `refs/worktree` exists in the worktree's own stack alone:
      // nothing is forged, yet the two listings differ in what these
      // symbolic refs resolve to and in whether the second one is listed.
      // The comparison leaves nothing out, so the layout is a documented
      // false refusal rather than a hole.
      git(f.repo, ["symbolic-ref", "refs/remotes/origin/self", "HEAD"]);
      git(f.repo, [
        "symbolic-ref",
        "refs/remotes/origin/wtx",
        "refs/worktree/x",
      ]);
      git(wt, ["update-ref", "refs/worktree/x", sha]);
      const self = await listedAs(f, wt, "refs/remotes/origin/self");
      expect(self.own).toBe(
        `refs/remotes/origin/self ${sha} [refs/heads/feat]`,
      );
      expect(self.common).toBe(
        `refs/remotes/origin/self ${f.mainSha} [refs/heads/main]`,
      );
      expect((await listedAs(f, wt, "refs/remotes/origin/wtx")).own).toContain(
        "[refs/worktree/x]",
      );
      expect((await listedAs(f, wt, "refs/remotes/origin/wtx")).common).toBe(
        "",
      );
      await expectUnknownState(f, wt, sha, [
        ["--delete-branch"],
        ["--delete-branch", "--base", "origin/main"],
      ]);
      const forced = await cliBounded(f.work, [
        "remove",
        wt,
        "--delete-branch",
        "--force",
      ]);
      expect(forced.code, forced.stdout + forced.stderr).toBe(0);
      expect(forced.json.branch.deleted).toBe(true);
      expect(fs.existsSync(wt)).toBe(false);
    });

    // git does not show a private record that shadows a symbolic ref of the
    // common stack the same way on every run (the symbolic ref target of the
    // listing is unreliable), so one attempt cannot show that the removal is
    // refused every time: the refusal is asserted over a loop.
    it.each([
      [
        "a symbolic ref to HEAD, shadowed by a private record that points at the branch",
        ["symbolic-ref", "refs/remotes/origin/self", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/self", "refs/heads/feat"],
      ],
      [
        "a symbolic ref to a ref of the worktree, shadowed by a private record that points at HEAD",
        ["symbolic-ref", "refs/remotes/origin/selfself", "refs/worktree/x"],
        ["symbolic-ref", "refs/remotes/origin/selfself", "HEAD"],
      ],
    ])(
      "never removes the unpushed branch of a worktree whose private stack holds a symbolic record that shadows %s",
      async (_what, common, forged) => {
        const f = makeFixture({ refFormat: "reftable" });
        const { wt, sha } = makeUnpushed(f);
        git(wt, ["update-ref", "refs/worktree/x", sha]);
        git(f.repo, common);
        forgePrivateStackWith(f, wt, (donor) => git(donor, forged));
        for (let attempt = 1; attempt <= 20; attempt += 1) {
          const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
          const label = `attempt ${attempt}: ${r.stdout}${r.stderr}`;
          expect(r.code, label).toBe(2);
          expect(r.json.reason, label).toBe("unpushed_state_unknown");
          expect(fs.existsSync(wt), label).toBe(true);
          expect(
            git(f.repo, ["rev-parse", "--verify", "refs/heads/feat"]).trim(),
            label,
          ).toBe(sha);
        }
      },
      120_000,
    );

    it("keeps a branch when the common git directory holds a commondir entry that points git at another stack", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      const privateDir = forgePrivateStack(f, wt, [
        { name: "refs/remotes/origin/feat", sha },
      ]);
      // A copy of the common directory that holds the forged ref in the
      // stack git reads as the common one, named by a `commondir` file in
      // the real common directory: `--git-dir=<common-dir>` then lists the
      // forged ref too, and the two listings agree.
      const common = commonDirOf(f);
      const shadow = path.join(f.base, "shadow.git");
      fs.cpSync(common, shadow, { recursive: true });
      const stack = path.join(privateDir, "reftable");
      const shadowList = path.join(shadow, "reftable/tables.list");
      const have = fs.readFileSync(shadowList, "utf8").split("\n");
      for (const table of fs.readdirSync(stack)) {
        if (table === "tables.list") continue;
        fs.copyFileSync(
          path.join(stack, table),
          path.join(shadow, "reftable", table),
        );
        if (!have.includes(table)) {
          fs.appendFileSync(shadowList, `${table}\n`);
        }
      }
      fs.writeFileSync(path.join(common, "commondir"), `${shadow}\n`);
      const seen = await listedAs(f, wt, "refs/remotes/origin/feat");
      expect(seen.own).toBe(`refs/remotes/origin/feat ${sha} []`);
      expect(seen.common).toBe(seen.own);
      expect(await unpushedPerGit(wt)).toBe("");
      for (const flags of [
        ["--delete-branch"],
        ["--delete-branch", "--base", "origin/main"],
      ]) {
        const r = await cliBounded(f.work, ["remove", wt, ...flags]);
        expect(r.code, r.stdout + r.stderr).toBe(2);
        expect(r.json.reason).toBe("unpushed_state_unknown");
        expect(r.json.message).toContain("commondir");
        expect(fs.existsSync(wt)).toBe(true);
      }
    });

    it("is unknown when either listing of the comparison fails, with and without --base", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      // The listing of the common stack alone is told apart by `--git-dir`;
      // the first listing of the remote-tracking refs made without it is
      // the worktree's own (a marker file lets the later listings pass, so
      // a comparison that ignored the failure would go on and show it).
      const marker = path.join(f.base, "git-own-listing-fails", "failed-once");
      const failOwn = gitWrapper(
        f,
        "git-own-listing-fails",
        `case " $* " in
  *' --git-dir='*) ;;
  *' for-each-ref '*' refs/remotes '*)
    marker='${marker}'
    if [ ! -e "$marker" ]; then
      : > "$marker"
      echo 'fatal: own listing' >&2
      exit 128
    fi;;
esac`,
      );
      const failCommon = gitWrapper(
        f,
        "git-common-listing-fails",
        `case " $* " in
  *' --git-dir='*' for-each-ref '*' refs/remotes '*)
    echo 'fatal: common listing' >&2
    exit 128;;
esac`,
      );
      for (const [fake, why] of [
        [failOwn, "own listing"],
        [failCommon, "common listing"],
      ] as const) {
        for (const flags of [
          ["--delete-branch"],
          ["--delete-branch", "--base", "origin/main"],
        ]) {
          fs.rmSync(marker, { force: true });
          await expectUnknownState(f, wt, sha, [flags], { PATH: fake });
        }
        fs.rmSync(marker, { force: true });
        const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"], {
          PATH: fake,
        });
        expect(r.json.message, why).toContain(why);
      }
    });

    it("writes the remote-tracking refs of a linked worktree to the common stack, where removal keeps them", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      // The ways a linked worktree gets a remote-tracking ref: a push that
      // updates the tracking ref, a fetch, and a ref written by hand.
      git(wt, ["push", "-q", "origin", "feat"]);
      git(wt, ["fetch", "-q", "origin"]);
      git(wt, ["update-ref", "refs/remotes/origin/by-hand", sha]);
      git(wt, ["update-ref", "refs/worktree/private", sha]);
      const common = await commonRemoteRefs(f);
      expect(common).toContain(`refs/remotes/origin/feat ${sha}`);
      expect(common).toContain(`refs/remotes/origin/by-hand ${sha}`);
      // The worktree-private namespace is the one the private stack holds.
      expect(await gitBounded(f.repo, ["for-each-ref", "refs/worktree"])).toBe(
        "",
      );
      expect(await worktreeRemoteRefs(wt)).toBe(common);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
    });

    /** The git the wrappers below hand every other call on to. */
    const realGit = path.join(FIXED_BIN_DIR, "git");

    /**
     * A `gitWrapper` PATH that changes what git prints in the worktree (a
     * call without `--git-dir`) for the two listings of the remote-tracking
     * refs, standing in for the symbolic ref targets git can print there
     * for a private record that shadows a symbolic ref of the common stack.
     * With `blindComparison` the listing the comparison makes in the
     * worktree is answered from the common stack alone, so the comparison
     * sees no difference whatever the private stack holds; with
     * `emptyOwnTargets` the listing of the symbolic refs made in the
     * worktree comes back with every target taken off, so read there no ref
     * is symbolic. A call with `--git-dir` passes unchanged.
     */
    function worktreeListings(
      f: Fixture,
      name: string,
      opts: { blindComparison: boolean; emptyOwnTargets: boolean },
    ): string {
      const blind = opts.blindComparison
        ? `  *' for-each-ref --format=%(refname)%09%(objectname)%09%(symref) refs/remotes '*)
    exec '${realGit}' '--git-dir=${commonDirOf(f)}' "$@";;
`
        : "";
      const empty = opts.emptyOwnTargets
        ? `  *' for-each-ref --format=%(refname)%09%(symref) refs/remotes '*)
    out=$('${realGit}' "$@") || exit $?
    tab=$(printf '\\t')
    printf '%s\\n' "$out" | while IFS= read -r line; do
      printf '%s\\t\\n' "\${line%%"$tab"*}"
    done
    exit 0;;
`
        : "";
      return gitWrapper(
        f,
        name,
        `case " $* " in
  *' --git-dir='*) ;;
${blind}${empty}esac`,
      );
    }

    /** Runs `remove --delete-branch`, with and without --base, and asserts
     * the `unpushed_commits` refusal with `commits` counted, the worktree
     * kept and `feat` still at `sha`. */
    async function expectUnpushed(
      f: Fixture,
      wt: string,
      sha: string,
      commits: number,
      env: NodeJS.ProcessEnv = {},
      flagSets: string[][] = [
        ["--delete-branch"],
        ["--delete-branch", "--base", "origin/main"],
      ],
    ): Promise<void> {
      for (const flags of flagSets) {
        const r = await cliBounded(f.work, ["remove", wt, ...flags], env);
        const label = `${flags.join(" ")}: ${r.stdout}${r.stderr}`;
        expect(r.code, label).toBe(2);
        expect(r.json.reason, label).toBe("unpushed_commits");
        expect(r.json.details.commits, label).toBe(commits);
        expect(fs.existsSync(wt), label).toBe(true);
        expect(
          git(f.repo, ["rev-parse", "--verify", "refs/heads/feat"]).trim(),
          label,
        ).toBe(sha);
      }
    }

    // git can print, in the worktree, a symbolic ref target for a private
    // record that shadows a symbolic ref of the common stack that is not
    // the record's (empty included), and on some runs the two listings of
    // the comparison then agree. The wrapper makes that deterministic: the
    // comparison sees no difference, and what decides is the walk, which
    // reads the common stack alone from the commit the worktree's HEAD
    // points at.
    it.each([
      [
        "a private symbolic record to HEAD shadows a symbolic ref of the common stack to the branch",
        (f: Fixture, wt: string, _sha: string): void => {
          git(f.repo, [
            "symbolic-ref",
            "refs/remotes/origin/self",
            "refs/heads/feat",
          ]);
          forgePrivateStackWith(f, wt, (donor) =>
            git(donor, ["symbolic-ref", "refs/remotes/origin/self", "HEAD"]),
          );
        },
        { blindComparison: true, emptyOwnTargets: true },
      ],
      [
        "a private plain remote-tracking ref holds the branch tip",
        (f: Fixture, wt: string, sha: string): void => {
          forgePrivateStack(f, wt, [{ name: "refs/remotes/origin/feat", sha }]);
        },
        { blindComparison: true, emptyOwnTargets: false },
      ],
    ])(
      "keeps the unpushed branch when %s and the comparison of the listings sees no difference",
      async (_what, plant, listings) => {
        const f = makeFixture({ refFormat: "reftable" });
        const { wt, sha } = makeUnpushed(f);
        plant(f, wt, sha);
        // The premise: a walk in the worktree counts the commit as pushed.
        expect(await unpushedPerGit(wt)).toBe("");
        await expectUnpushed(f, wt, sha, 1, {
          PATH: worktreeListings(f, "git-worktree-listings", listings),
        });
      },
    );

    it("walks from the commit the worktree's HEAD points at, not from the HEAD of the common directory, which is the main checkout's", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt } = makeUnpushed(f);
      commitHere(wt, "more.txt", "more unpushed work");
      const tip = git(wt, ["rev-parse", "HEAD"]).trim();
      // The premise: read in the common directory, HEAD is the main
      // checkout's, on main, which origin has.
      expect(
        await gitBounded(wt, [
          `--git-dir=${commonDirOf(f)}`,
          "rev-list",
          "HEAD",
          "--not",
          "--remotes",
        ]),
      ).toBe("");
      await expectUnpushed(f, wt, tip, 2, {}, [
        [],
        ["--delete-branch"],
        ["--delete-branch", "--base", "origin/main"],
      ]);
    });

    it.each([
      ["as git lists them", false],
      [
        "when the listing made in the worktree shows no symbolic ref targets",
        true,
      ],
    ])(
      "keeps a branch that a symbolic remote-tracking ref of the common stack points at, excluding the symbolic refs of the common listing %s",
      async (_what, emptyOwnTargets) => {
        const f = makeFixture({ refFormat: "reftable" });
        const { wt, sha } = makeUnpushed(f);
        git(f.repo, [
          "symbolic-ref",
          "refs/remotes/origin/self",
          "refs/heads/feat",
        ]);
        // The premise: a walk that follows the symbolic ref counts the
        // commit as pushed.
        expect(await unpushedPerGit(wt)).toBe("");
        const env: NodeJS.ProcessEnv = {};
        if (emptyOwnTargets) {
          env.PATH = worktreeListings(f, "git-own-targets-empty", {
            blindComparison: false,
            emptyOwnTargets: true,
          });
          expect(
            await gitBounded(
              wt,
              [
                "for-each-ref",
                "--format=%(refname)%09%(symref)",
                "refs/remotes",
              ],
              20_000,
              env,
            ),
          ).toContain("refs/remotes/origin/self\t\n");
        }
        await expectUnpushed(f, wt, sha, 1, env);
      },
    );

    /** A `gitWrapper` PATH whose git prints `printed` (a `printf` format)
     * in place of the line of refs/remotes/origin/self in the listing of
     * the symbolic refs made in the common directory (`--git-dir`). */
    function garbledCommonListing(f: Fixture, printed: string): string {
      return gitWrapper(
        f,
        "git-common-listing-garbled",
        `case " $* " in
  *' --git-dir='*' for-each-ref --format=%(refname)%09%(symref) refs/remotes '*)
    out=$('${realGit}' "$@") || exit $?
    tab=$(printf '\\t')
    printf '%s\\n' "$out" | while IFS= read -r line; do
      case "$line" in
        "refs/remotes/origin/self$tab"*) printf '${printed}' ;;
        *) printf '%s\\n' "$line" ;;
      esac
    done
    exit 0;;
esac`,
      );
    }

    it.each([
      [
        "the tail of another name as its target",
        "refs/remotes/origin/self\\tgin/main\\n",
        'git named "gin/main" as the target of the symbolic ref refs/remotes/origin/self',
      ],
      [
        "a control byte as its target",
        "refs/remotes/origin/self\\t\\003\\n",
        'git named "\\u0003" as the target of the symbolic ref refs/remotes/origin/self',
      ],
      [
        "no target column at all",
        "refs/remotes/origin/self\\n",
        'git listed "refs/remotes/origin/self" among the remote-tracking refs of the common reftable stack',
      ],
    ])(
      "is unknown when the listing of the common stack shows refs/remotes/origin/self with %s",
      async (_what, printed, message) => {
        const f = makeFixture({ refFormat: "reftable" });
        const { wt, sha } = makeUnpushed(f);
        git(f.repo, [
          "symbolic-ref",
          "refs/remotes/origin/self",
          "refs/heads/feat",
        ]);
        const env = { PATH: garbledCommonListing(f, printed) };
        await expectUnknownState(
          f,
          wt,
          sha,
          [["--delete-branch"], ["--delete-branch", "--base", "origin/main"]],
          env,
        );
        const r = await cliBounded(
          f.work,
          ["remove", wt, "--delete-branch"],
          env,
        );
        expect(r.json.message).toContain(message);
      },
    );

    it("is unknown for a symbolic ref of the common stack whose name is not UTF-8, which no --exclude names exactly", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      // A reftable table holds any ref name git accepts, whatever the file
      // system allows.
      await shBounded(
        f.repo,
        `git symbolic-ref "refs/remotes/origin/$(printf 'x\\377')" refs/heads/feat`,
      );
      expect(await unpushedPerGit(wt)).toBe("");
      await expectUnknownState(f, wt, sha, [
        ["--delete-branch"],
        ["--delete-branch", "--base", "origin/main"],
      ]);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.json.message).toContain(
        "the symbolic ref refs/remotes/origin/x\\xff has a name that is not UTF-8",
      );
    });

    it("is unknown for a worktree on an unborn branch, whose HEAD names no commit", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const wt = path.join(f.base, "wt-lonely");
      git(f.repo, ["worktree", "add", "-q", "--orphan", "-b", "lonely", wt]);
      const r = await cliBounded(f.work, ["remove", wt]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("unpushed_state_unknown");
      expect(r.json.message).toContain(
        "git cannot name the commit HEAD points at in this worktree",
      );
      expect(listedWorktrees(f.repo)).toContain(wt);
    });

    it("is unknown when git names something other than an object name for the commit HEAD points at", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      // An answer the walk would read as an option that selects no commit,
      // so a walk from it would count nothing as unpushed.
      const env = {
        PATH: gitWrapper(
          f,
          "git-head-not-an-oid",
          `case " $* " in
  *' rev-parse --verify HEAD^{commit} '*)
    printf '%s\\n' '--branches=no-such-branch'
    exit 0;;
esac`,
        ),
      };
      await expectUnknownState(
        f,
        wt,
        sha,
        [["--delete-branch"], ["--delete-branch", "--base", "origin/main"]],
        env,
      );
      const r = await cliBounded(
        f.work,
        ["remove", wt, "--delete-branch"],
        env,
      );
      expect(r.json.message).toContain(
        'git named "--branches=no-such-branch" as the commit HEAD points at in this worktree',
      );
    });

    it("removes a pushed branch of a worktree with the symbolic origin/HEAD, fetched refs, a ref under refs/worktree and a bisect ref", async () => {
      const f = makeFixture({ refFormat: "reftable" });
      const { wt, sha } = makeUnpushed(f);
      git(wt, ["push", "-q", "origin", "feat"]);
      git(wt, ["fetch", "-q", "origin"]);
      git(wt, ["update-ref", "refs/worktree/x", sha]);
      git(wt, ["update-ref", "refs/bisect/bad", sha]);
      // The premise: origin/HEAD is a symbolic ref of the common stack, and
      // the worktree's own stack holds the refs only that worktree lists.
      expect(
        oneLine(
          await gitBounded(f.repo, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
          ]),
        ),
      ).toBe("refs/remotes/origin/main");
      expect(
        await gitBounded(f.repo, [
          "for-each-ref",
          "refs/bisect",
          "refs/worktree",
        ]),
      ).toBe("");
      expect(
        await gitBounded(wt, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/bisect",
          "refs/worktree",
        ]),
      ).toBe("refs/bisect/bad\nrefs/worktree/x\n");
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
      expect(fs.existsSync(wt)).toBe(false);
      expect(
        await gitBounded(f.repo, ["for-each-ref", "refs/heads/feat"]),
      ).toBe("");
    });
  },
);

describe("plausibleRefTarget: what the listing of the common stack may name as a symbolic ref target", () => {
  it("accepts a name below refs/ that git allows, bytes outside ASCII included, and a name at the top level such as HEAD", () => {
    for (const target of [
      "refs/heads/feat",
      "refs/remotes/origin/main",
      "refs/worktree/x",
      "refs/heads/team/a-b_c.d",
      "HEAD",
      "FETCH_HEAD",
      "ORIG_HEAD",
    ]) {
      expect(plausibleRefTarget(Buffer.from(target)), target).toBe(true);
    }
    expect(
      plausibleRefTarget(
        Buffer.concat([Buffer.from("refs/heads/x"), Buffer.from([0xff])]),
      ),
    ).toBe(true);
  });

  it("refuses what git never prints as a symbolic ref target", () => {
    for (const target of [
      "",
      "gin/main",
      "main",
      "Head",
      "\x03",
      "refs/heads/a b",
      "refs/heads/a\tb",
      "refs/heads/a\x7f",
      "refs/heads/a~1",
      "refs/heads/a^",
      "refs/heads/a:b",
      "refs/heads/a?",
      "refs/heads/a*",
      "refs/heads/a[",
      "refs/heads/a\\b",
      "refs/heads/a..b",
      "refs/heads/a@{1}",
      "refs/heads/a.",
      "refs/heads/",
      "refs/",
      "refs//x",
      "refs/heads/.x",
      "refs/heads/x.lock",
    ]) {
      expect(
        plausibleRefTarget(Buffer.from(target)),
        JSON.stringify(target),
      ).toBe(false);
    }
  });
});

/** `fs.lstatSync` with the device, inode or size of the entries `fake`
 * names replaced: a bind mount, a directory hard link or an oversized
 * file, which a test cannot make without privileges or disk, as the
 * inspection sees it. The path is matched as text (a byte path decoded). */
function fakeIdentity(
  fake: (p: string) => Partial<Pick<fs.BigIntStats, "dev" | "ino" | "size">>,
): { mockRestore: () => void } {
  const real = fs.lstatSync.bind(fs) as (
    p: fs.PathLike,
    o?: fs.StatSyncOptions,
  ) => fs.Stats | fs.BigIntStats;
  return vi.spyOn(fs, "lstatSync").mockImplementation(((
    p: fs.PathLike,
    o?: fs.StatSyncOptions,
  ) => {
    const st = real(p, o);
    const patch = fake(String(p));
    if (Object.keys(patch).length === 0) return st;
    return Object.assign(
      Object.create(Object.getPrototypeOf(st) as object) as object,
      st,
      patch,
    );
  }) as typeof fs.lstatSync);
}

/** `<dir>/<name>` with `name` as bytes: the one way to address an entry
 * whose name is not UTF-8. */
function bytePathIn(dir: string, name: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${dir}${path.sep}`), name]);
}

/** A name that is not UTF-8 (`x` and the byte 0xff), and the name its
 * lossy decoding gives, which a decoy can carry on any file system. */
const BAD_NAME = Buffer.from([0x78, 0xff]);
const DECODED_NAME = "x�";

describe("untrustedFilesRefStore: the walk", () => {
  function tree(name = "store"): string {
    const parent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-walk-")),
    );
    tmpDirs.push(parent);
    const dir = path.join(parent, name);
    fs.mkdirSync(path.join(dir, "refs/remotes/origin"), { recursive: true });
    fs.mkdirSync(path.join(dir, "refs/heads"));
    fs.writeFileSync(path.join(dir, "refs/remotes/origin/main"), "x\n");
    return dir;
  }

  it("accepts plain files and directories, and a repository without loose remote refs", () => {
    const dir = tree();
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
    fs.rmSync(path.join(dir, "refs/remotes"), { recursive: true });
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
  });

  it("names refs/remotes or refs when it is a link, and refs when it is not a directory", () => {
    const dir = tree();
    fs.renameSync(
      path.join(dir, "refs/remotes"),
      path.join(dir, "remotes-real"),
    );
    fs.symlinkSync("../remotes-real", path.join(dir, "refs/remotes"));
    expect(untrustedFilesRefStore(dir)).toBe("refs/remotes is a symbolic link");
    // A plain file named refs/remotes is a ref named refs/remotes to git,
    // outside every remote: it aliases nothing.
    fs.rmSync(path.join(dir, "refs/remotes"));
    fs.writeFileSync(path.join(dir, "refs/remotes"), "x\n");
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
    fs.rmSync(path.join(dir, "refs"), { recursive: true });
    fs.symlinkSync("remotes-real", path.join(dir, "refs"));
    expect(untrustedFilesRefStore(dir)).toBe("refs is a symbolic link");
    fs.rmSync(path.join(dir, "refs"));
    fs.writeFileSync(path.join(dir, "refs"), "x\n");
    expect(untrustedFilesRefStore(dir)).toBe("refs is not a directory");
  });

  it("walks the whole refs tree, not only refs/remotes", () => {
    const heads = tree();
    fs.symlinkSync("remotes/origin", path.join(heads, "refs/heads/team"));
    expect(untrustedFilesRefStore(heads)).toBe(
      "refs/heads/team is a symbolic link",
    );
    const whole = tree();
    fs.rmSync(path.join(whole, "refs/heads"), { recursive: true });
    fs.symlinkSync("remotes/origin", path.join(whole, "refs/heads"));
    expect(untrustedFilesRefStore(whole)).toBe("refs/heads is a symbolic link");
    const tags = tree();
    fs.mkdirSync(path.join(tags, "refs/tags"));
    fs.symlinkSync("../heads/feat", path.join(tags, "refs/tags/alias"));
    expect(untrustedFilesRefStore(tags)).toBe(
      "refs/tags/alias is a symbolic link",
    );
  });

  it("fails closed when the common directory or refs cannot be found", () => {
    const dir = tree("gd ");
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
    // The name with its trailing space cut off, as a trimmed answer
    // would have it, does not exist: that is not "no loose refs".
    const cut = dir.slice(0, -1);
    expect(untrustedFilesRefStore(cut)).toBe(
      `the common git directory ${JSON.stringify(cut)} cannot be inspected: ENOENT: no such file or directory, stat '${cut}'`,
    );
    const file = path.join(path.dirname(dir), "a-file");
    fs.writeFileSync(file, "x\n");
    expect(untrustedFilesRefStore(file)).toBe(
      `the common git directory ${JSON.stringify(file)} is not a directory`,
    );
    fs.rmSync(path.join(dir, "refs"), { recursive: true });
    expect(untrustedFilesRefStore(dir)).toContain(
      "refs cannot be inspected: ENOENT",
    );
  });

  it("names a special file", () => {
    const dir = tree();
    execFileSync("mkfifo", [path.join(dir, "refs/remotes/origin/pipe")]);
    expect(untrustedFilesRefStore(dir)).toBe(
      "refs/remotes/origin/pipe is neither a regular file nor a directory",
    );
  });

  it("accepts packed-refs as a regular file or absent, and names any other kind", () => {
    const dir = tree();
    const packed = path.join(dir, "packed-refs");
    fs.writeFileSync(packed, "# pack-refs with: peeled fully-peeled sorted \n");
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
    // A hard link is a second name of a file git replaces as a whole on
    // every write: deleting the other name leaves this one intact.
    fs.linkSync(packed, path.join(dir, "packed-copy"));
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
    fs.rmSync(packed);
    fs.symlinkSync("packed-copy", packed);
    expect(untrustedFilesRefStore(dir)).toBe("packed-refs is a symbolic link");
    fs.rmSync(packed);
    fs.symlinkSync("gone", packed);
    expect(untrustedFilesRefStore(dir)).toBe("packed-refs is a symbolic link");
    fs.rmSync(packed);
    fs.mkdirSync(packed);
    expect(untrustedFilesRefStore(dir)).toBe(
      "packed-refs is not a regular file",
    );
    fs.rmSync(packed, { recursive: true });
    execFileSync("mkfifo", [packed]);
    expect(untrustedFilesRefStore(dir)).toBe(
      "packed-refs is not a regular file",
    );
  });

  it("fails closed when packed-refs cannot be inspected", () => {
    const dir = tree();
    const real = fs.lstatSync.bind(fs) as (
      p: fs.PathLike,
      o?: fs.StatSyncOptions,
    ) => fs.Stats | fs.BigIntStats;
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
      p: fs.PathLike,
      o?: fs.StatSyncOptions,
    ) => {
      if (String(p).endsWith(`${path.sep}packed-refs`)) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
      return real(p, o);
    }) as typeof fs.lstatSync);
    try {
      expect(untrustedFilesRefStore(dir)).toBe(
        "packed-refs cannot be inspected: EACCES: permission denied",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "treats a directory or entry it cannot read as untrusted",
    () => {
      const dir = tree();
      const origin = path.join(dir, "refs/remotes/origin");
      try {
        // Listed but not searchable: readdir works, lstat of the entries not.
        fs.chmodSync(origin, 0o444);
        expect(untrustedFilesRefStore(dir)).toContain(
          "refs/remotes/origin/main cannot be inspected",
        );
        // Not even listable.
        fs.chmodSync(origin, 0o000);
        expect(untrustedFilesRefStore(dir)).toContain(
          "refs/remotes/origin cannot be read",
        );
        // refs itself cannot be listed.
        fs.chmodSync(path.join(dir, "refs"), 0o000);
        expect(untrustedFilesRefStore(dir)).toContain("refs cannot be read");
      } finally {
        fs.chmodSync(path.join(dir, "refs"), 0o755);
        fs.chmodSync(origin, 0o755);
      }
    },
  );

  it("names a link and never descends into a looping directory link", () => {
    const dir = tree();
    fs.symlinkSync(".", path.join(dir, "refs/remotes/loop"));
    expect(untrustedFilesRefStore(dir)).toBe(
      "refs/remotes/loop is a symbolic link",
    );
  });

  it("refuses a directory reached a second time under another name", () => {
    const dir = tree();
    fs.mkdirSync(path.join(dir, "refs/remotes/mirror"));
    const heads = fs.lstatSync(path.join(dir, "refs/heads"), { bigint: true });
    const spy = fakeIdentity((p) =>
      p.endsWith(`${path.sep}refs${path.sep}remotes${path.sep}mirror`) ||
      p.endsWith("refs/remotes/mirror")
        ? { dev: heads.dev, ino: heads.ino }
        : {},
    );
    try {
      expect(untrustedFilesRefStore(dir)).toMatch(
        /^refs\/(heads|remotes\/mirror) is a directory already reached under another name$/,
      );
    } finally {
      spy.mockRestore();
    }
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
  });

  it("refuses a directory that is refs itself, reached again below it", () => {
    const dir = tree();
    // An empty directory standing in for a bind mount of refs onto
    // refs/remotes/self: nothing below it would give the loop away.
    fs.mkdirSync(path.join(dir, "refs/remotes/self"));
    const root = fs.lstatSync(path.join(dir, "refs"), { bigint: true });
    const spy = fakeIdentity((p) =>
      p.endsWith("refs/remotes/self") ? { dev: root.dev, ino: root.ino } : {},
    );
    try {
      expect(untrustedFilesRefStore(dir)).toBe(
        "refs/remotes/self is a directory already reached under another name",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a directory on another device than refs", () => {
    const dir = tree();
    fs.mkdirSync(path.join(dir, "refs/remotes/mnt"));
    const root = fs.lstatSync(path.join(dir, "refs"), { bigint: true });
    const spy = fakeIdentity((p) =>
      p.endsWith("refs/remotes/mnt") ? { dev: root.dev + 1n } : {},
    );
    try {
      expect(untrustedFilesRefStore(dir)).toBe(
        "refs/remotes/mnt is on another device than refs (a mount point)",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("stops at the entry bound", () => {
    const dir = tree();
    for (const name of ["a", "b", "c", "d"]) {
      fs.writeFileSync(path.join(dir, "refs/remotes/origin", name), "x\n");
    }
    const bounds = { maxEntries: 4, maxDepth: 8 };
    // heads, remotes, origin, main, a, b, c, d: eight entries.
    expect(untrustedFilesRefStore(dir, bounds)).toContain("more than 4");
    expect(untrustedFilesRefStore(dir, { ...bounds, maxEntries: 7 })).toContain(
      "more than 7",
    );
    expect(
      untrustedFilesRefStore(dir, { ...bounds, maxEntries: 8 }),
    ).toBeUndefined();
  });

  it("stops at the depth bound", () => {
    const dir = tree();
    fs.mkdirSync(path.join(dir, "refs/remotes/origin/a/b/c"), {
      recursive: true,
    });
    const bounds = { maxEntries: 100, maxDepth: 4 };
    // remotes is level 1, origin 2, a 3, b 4, c 5.
    expect(untrustedFilesRefStore(dir, bounds)).toContain("deeper than 4");
    expect(
      untrustedFilesRefStore(dir, { ...bounds, maxDepth: 5 }),
    ).toBeUndefined();
  });

  it("inspects a name that is not UTF-8 as its own bytes, not as the decoy its decoding names", () => {
    const dir = tree();
    const origin = path.join(dir, "refs/remotes/origin");
    // The decoy: a plain ref at the name the lossy decoding gives. A walk
    // over decoded names would lstat it twice and never see the link.
    fs.writeFileSync(path.join(origin, DECODED_NAME), "x\n");
    // The link is listed by a faked readdir and answered by a faked lstat
    // keyed on its exact bytes, since not every file system (APFS) can
    // hold such a name; on one that can, the Linux CLI tests make it.
    fs.symlinkSync("../../heads/feat", path.join(dir, "a-link"));
    const linkStat = fs.lstatSync(path.join(dir, "a-link"), { bigint: true });
    const badPath = bytePathIn(origin, BAD_NAME);
    const realReaddir = fs.readdirSync.bind(fs) as (
      p: fs.PathLike,
      o?: unknown,
    ) => unknown;
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(((
      p: fs.PathLike,
      o?: unknown,
    ) => {
      const names = realReaddir(p, o) as (Buffer | string)[];
      const first = names[0];
      if (
        String(p) === origin &&
        first !== undefined &&
        Buffer.isBuffer(first)
      ) {
        return [...names, BAD_NAME];
      }
      return names;
    }) as typeof fs.readdirSync);
    const realLstat = fs.lstatSync.bind(fs) as (
      p: fs.PathLike,
      o?: fs.StatSyncOptions,
    ) => fs.Stats | fs.BigIntStats;
    const lstat = vi
      .spyOn(fs, "lstatSync")
      .mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) =>
        Buffer.isBuffer(p) && p.equals(badPath)
          ? linkStat
          : realLstat(p, o)) as typeof fs.lstatSync);
    try {
      expect(untrustedFilesRefStore(dir)).toBe(
        "refs/remotes/origin/x\\xff is a symbolic link",
      );
    } finally {
      lstat.mockRestore();
      readdir.mockRestore();
    }
    // Without the link, the decoy is a plain ref and the store is fine.
    expect(untrustedFilesRefStore(dir)).toBeUndefined();
  });
});

describe("privateStackRemoteRefs: the common directory is an argument", () => {
  it("is unknown for a common directory whose name is not UTF-8, before any git call", () => {
    // A directory that does not exist: the name is judged first, so no git
    // is asked about it, and the answer carries the byte as git printed it.
    const result = privateStackRemoteRefs(
      os.tmpdir(),
      Buffer.concat([Buffer.from("/gone/gd"), Buffer.from([0xff])]),
    );
    expect(result?.status).toBeNull();
    expect(result?.error).toContain("/gone/gd\\xff");
    expect(result?.error).toContain("has a name that is not UTF-8");
  });
});

describe("privateStackRemoteRefs: an entry named commondir", () => {
  function scratchDir(): string {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-wt-commondir-"),
    );
    tmpDirs.push(dir);
    return dir;
  }

  it.each([
    ["a file", (at: string) => fs.writeFileSync(at, "elsewhere\n")],
    ["a directory", (at: string) => fs.mkdirSync(at)],
    ["a dangling link", (at: string) => fs.symlinkSync("/gone/nowhere", at)],
  ])(
    "is unknown when the common directory holds %s of that name, before any git call",
    (_what, plant) => {
      const common = scratchDir();
      plant(path.join(common, "commondir"));
      const result = privateStackRemoteRefs(common, Buffer.from(common));
      expect(result?.status).toBeNull();
      expect(result?.error).toContain("commondir");
      expect(result?.error).toContain("exists");
    },
  );

  it("is unknown when the entry cannot be inspected, before any git call", () => {
    const dir = scratchDir();
    const notADirectory = path.join(dir, "file");
    fs.writeFileSync(notADirectory, "x\n");
    const result = privateStackRemoteRefs(dir, Buffer.from(notADirectory));
    expect(result?.status).toBeNull();
    expect(result?.error).toContain("commondir");
    expect(result?.error).toContain("cannot be inspected");
  });
});

describe("untrustedReftableStore: the stack", () => {
  const TABLE = "0x000000000001-0x000000000003-ab086889.ref";

  function stack(): string {
    const parent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-stack-")),
    );
    tmpDirs.push(parent);
    const dir = path.join(parent, "store");
    fs.mkdirSync(path.join(dir, "reftable"), { recursive: true });
    fs.writeFileSync(path.join(dir, "reftable", TABLE), "REFT");
    fs.writeFileSync(path.join(dir, "reftable/tables.list"), `${TABLE}\n`);
    return dir;
  }

  it("accepts a stack of regular files, blank lines in the list, a table listed twice and an empty list", () => {
    const dir = stack();
    expect(untrustedReftableStore(dir)).toBeUndefined();
    const list = path.join(dir, "reftable/tables.list");
    fs.writeFileSync(list, `\n${TABLE}\n\n${TABLE}\n`);
    expect(untrustedReftableStore(dir)).toBeUndefined();
    fs.writeFileSync(list, "");
    expect(untrustedReftableStore(dir)).toBeUndefined();
  });

  it("fails closed when the common directory, reftable or tables.list cannot be found", () => {
    const dir = stack();
    expect(untrustedReftableStore(path.join(dir, "gone"))).toContain(
      "cannot be inspected: ENOENT",
    );
    fs.rmSync(path.join(dir, "reftable/tables.list"));
    expect(untrustedReftableStore(dir)).toContain(
      "reftable/tables.list cannot be inspected: ENOENT",
    );
    fs.rmSync(path.join(dir, "reftable"), { recursive: true });
    expect(untrustedReftableStore(dir)).toContain(
      "reftable cannot be inspected: ENOENT",
    );
  });

  it("names reftable, tables.list or a table that is a link", () => {
    const dir = stack();
    const rt = path.join(dir, "reftable");
    const table = path.join(rt, TABLE);
    fs.renameSync(table, path.join(dir, "elsewhere.ref"));
    fs.symlinkSync("../elsewhere.ref", table);
    expect(untrustedReftableStore(dir)).toBe(
      `reftable/${TABLE} is a symbolic link`,
    );
    fs.rmSync(table);
    fs.symlinkSync("gone", table);
    expect(untrustedReftableStore(dir)).toBe(
      `reftable/${TABLE} is a symbolic link`,
    );
    fs.rmSync(table);
    fs.renameSync(path.join(dir, "elsewhere.ref"), table);
    const list = path.join(rt, "tables.list");
    fs.renameSync(list, path.join(dir, "list-real"));
    fs.symlinkSync("../list-real", list);
    expect(untrustedReftableStore(dir)).toBe(
      "reftable/tables.list is a symbolic link",
    );
    fs.rmSync(list);
    fs.renameSync(path.join(dir, "list-real"), list);
    fs.renameSync(rt, path.join(dir, "rt-real"));
    fs.symlinkSync("rt-real", rt);
    expect(untrustedReftableStore(dir)).toBe("reftable is a symbolic link");
  });

  it("names tables.list or a table that is not a regular file, and a table that is missing", () => {
    const dir = stack();
    const rt = path.join(dir, "reftable");
    const table = path.join(rt, TABLE);
    fs.rmSync(table);
    expect(untrustedReftableStore(dir)).toContain(
      `reftable/${TABLE} cannot be inspected: ENOENT`,
    );
    fs.mkdirSync(table);
    expect(untrustedReftableStore(dir)).toBe(
      `reftable/${TABLE} is not a regular file`,
    );
    fs.rmSync(table, { recursive: true });
    execFileSync("mkfifo", [table]);
    expect(untrustedReftableStore(dir)).toBe(
      `reftable/${TABLE} is not a regular file`,
    );
    fs.rmSync(table);
    fs.writeFileSync(table, "REFT");
    const list = path.join(rt, "tables.list");
    fs.rmSync(list);
    fs.mkdirSync(list);
    expect(untrustedReftableStore(dir)).toBe(
      "reftable/tables.list is not a regular file",
    );
    fs.rmSync(list, { recursive: true });
    execFileSync("mkfifo", [list]);
    // Nothing is opened before lstat said "regular file": a fifo cannot
    // block the inspection.
    expect(untrustedReftableStore(dir)).toBe(
      "reftable/tables.list is not a regular file",
    );
    fs.rmSync(rt, { recursive: true });
    fs.writeFileSync(rt, "x\n");
    expect(untrustedReftableStore(dir)).toBe("reftable is not a directory");
  });

  it("names a listed table name that is not a plain file name, which git would open all the same", () => {
    const dir = stack();
    const list = path.join(dir, "reftable/tables.list");
    for (const name of [
      "sub/t.ref",
      "../t.ref",
      "/abs/t.ref",
      "a\\b.ref",
      "nul\u0000.ref",
      ".",
      "..",
    ]) {
      fs.writeFileSync(list, `${name}\n`);
      expect(untrustedReftableStore(dir), name).toBe(
        `reftable/tables.list names ${JSON.stringify(name)}, which is not a plain file name`,
      );
    }
    // A name that is not UTF-8 is inspected by its bytes and rendered.
    fs.writeFileSync(list, Buffer.concat([BAD_NAME, Buffer.from("\n")]));
    expect(untrustedReftableStore(dir)).toContain(
      "reftable/x\\xff cannot be inspected",
    );
  });

  it("names a table or tables.list on another device than reftable", () => {
    const dir = stack();
    const rt = fs.lstatSync(path.join(dir, "reftable"), { bigint: true });
    const table = fakeIdentity((p) =>
      p.endsWith(TABLE) ? { dev: rt.dev + 1n } : {},
    );
    try {
      expect(untrustedReftableStore(dir)).toBe(
        `reftable/${TABLE} is on another device than reftable (a mount point)`,
      );
    } finally {
      table.mockRestore();
    }
    const list = fakeIdentity((p) =>
      p.endsWith("tables.list") ? { dev: rt.dev + 1n } : {},
    );
    try {
      expect(untrustedReftableStore(dir)).toBe(
        "reftable/tables.list is on another device than reftable (a mount point)",
      );
    } finally {
      list.mockRestore();
    }
  });

  it("fails closed when tables.list cannot be read although it looked regular", () => {
    const dir = stack();
    const realRead = fs.readFileSync.bind(fs) as (
      p: fs.PathLike | number,
      o?: unknown,
    ) => unknown;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathLike | number,
      o?: unknown,
    ) => {
      if (String(p).endsWith("tables.list")) {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      }
      return realRead(p, o);
    }) as typeof fs.readFileSync);
    try {
      expect(untrustedReftableStore(dir)).toBe(
        "reftable/tables.list cannot be read: EIO: i/o error",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a tables.list past the size bound without reading it", () => {
    const dir = stack();
    const spy = fakeIdentity((p) =>
      p.endsWith("tables.list") ? { size: BigInt(16 * 1024 * 1024 + 1) } : {},
    );
    try {
      expect(untrustedReftableStore(dir)).toContain(
        "reftable/tables.list is larger than",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("stops at the entry bound", () => {
    const dir = stack();
    fs.writeFileSync(
      path.join(dir, "reftable/tables.list"),
      `${TABLE}\n${TABLE}\n${TABLE}\n`,
    );
    const bounds = { maxEntries: 2, maxDepth: 8 };
    expect(untrustedReftableStore(dir, bounds)).toContain(
      "names more than 2 tables",
    );
    expect(
      untrustedReftableStore(dir, { ...bounds, maxEntries: 3 }),
    ).toBeUndefined();
  });
});

describe("the path git names, read byte for byte", () => {
  it("takes off only the newline git ends the line with", () => {
    expect(gitOutputLine("/r/.git\n")).toBe("/r/.git");
    expect(gitOutputLine("/r/gd \n")).toBe("/r/gd ");
    expect(gitOutputLine("/r/gd\t\n")).toBe("/r/gd\t");
    expect(gitOutputLine("/r/gd\nnl\n")).toBe("/r/gd\nnl");
    expect(gitOutputLine("/r/gd\n\n")).toBe("/r/gd\n");
    expect(gitOutputLine("/r/.git")).toBe("/r/.git");
    expect(gitOutputLine("\n")).toBe("");
  });

  it("takes off only that newline from bytes as well, keeping a byte that is not UTF-8", () => {
    expect(gitOutputLine(Buffer.from("/r/gd \n"))).toEqual(
      Buffer.from("/r/gd "),
    );
    expect(gitOutputLine(Buffer.from("/r/gd\n\n"))).toEqual(
      Buffer.from("/r/gd\n"),
    );
    expect(gitOutputLine(Buffer.from([0x2f, 0x67, 0xff, 0x0a]))).toEqual(
      Buffer.from([0x2f, 0x67, 0xff]),
    );
    expect(gitOutputLine(Buffer.from("/r/.git"))).toEqual(
      Buffer.from("/r/.git"),
    );
    expect(gitOutputLine(Buffer.from("\n"))).toEqual(Buffer.alloc(0));
    expect(gitOutputLine(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  });

  it("joins a relative answer to the directory git ran in without folding it, byte for byte", () => {
    expect(gitPathIn("/x/link", Buffer.from("../.git"))).toEqual(
      Buffer.from(`/x/link${path.sep}../.git`),
    );
    expect(gitPathIn("/x/wt", Buffer.from(".git "))).toEqual(
      Buffer.from(`/x/wt${path.sep}.git `),
    );
    expect(gitPathIn("/x/wt", Buffer.from("/abs/gd "))).toEqual(
      Buffer.from("/abs/gd "),
    );
    // A name holding a byte that is not UTF-8: decoding it would turn the
    // byte into U+FFFD, three other bytes, and name another directory.
    const absolute = Buffer.from([0x2f, 0x61, 0x2f, 0x67, 0x64, 0xff]);
    expect(Buffer.from(absolute.toString("utf8"))).not.toEqual(absolute);
    expect(gitPathIn("/x/wt", absolute)).toEqual(absolute);
    const relative = Buffer.from([0x67, 0x64, 0xff]);
    expect(gitPathIn("/x/wt", relative)).toEqual(
      Buffer.concat([Buffer.from(`/x/wt${path.sep}`), relative]),
    );
  });
});

/** The most resident memory a guarded run may hold, in KiB: far above what
 * git and the CLI use on these fixtures, far below what a runaway walk of a
 * looping graph would take before the machine felt it. */
const GRAPH_RSS_LIMIT_KB = 1_048_576;

/** `ps` finds nothing of `pid` any more (a signalled child may be a zombie
 * for a moment before init reaps it). */
async function processGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

/** `git` for the graph fixtures: bounded, in a group of its own, and under
 * the memory limit. */
function gg(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return gitBounded(cwd, args, 20_000, extraEnv, GRAPH_RSS_LIMIT_KB);
}

describe("the guards every adversarial graph fixture runs under", () => {
  const ENV = { PATH: process.env.PATH };

  it("kills the whole process group at the time limit, background children included", async () => {
    const r = await spawnBounded(
      "sh",
      ["-c", "sleep 60 & echo $!; wait"],
      { env: ENV },
      700,
    );
    expect(r.timedOut).toBe(true);
    expect(r.rssExceeded).toBe(false);
    const pid = Number(r.stdout.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await processGone(pid)).toBe(true);
  });

  it("kills what a finished command left behind in its group", async () => {
    const r = await spawnBounded(
      "sh",
      ["-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!"],
      { env: ENV },
      10_000,
    );
    expect(r.timedOut).toBe(false);
    const pid = Number(r.stdout.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await processGone(pid)).toBe(true);
  });

  it("kills the group once its resident memory passes the limit, well before the time limit", async () => {
    const started = Date.now();
    const r = await spawnBounded(
      process.execPath,
      [
        "-e",
        "const b = Buffer.alloc(300 * 1024 * 1024, 1); console.log(b.length); setTimeout(() => {}, 60000);",
      ],
      { env: ENV },
      30_000,
      100 * 1024,
    );
    expect(r.rssExceeded).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it("counts the memory of a descendant that sits in a process group of its own", async () => {
    // The CLI starts each git in a group of its own: its memory is not the
    // group's. The parent stays small; its detached child holds 300 MiB.
    const started = Date.now();
    const r = await spawnBounded(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "const b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(() => {}, 60000);"], { detached: true, stdio: "ignore" });
console.log(c.pid);
setTimeout(() => {}, 60000);`,
      ],
      { env: ENV },
      12_000,
      200 * 1024,
    );
    const pid = Number(r.stdout.trim());
    try {
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.rssExceeded).toBe(true);
      expect(Date.now() - started).toBeLessThan(11_000);
      // The child outside the group ends with the run.
      expect(await processGone(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone, as it should be.
      }
    }
  });

  it("counts a descendant through its parent pids, and what is left in the group of the root", () => {
    const listing = [
      "100 1 100 50", // root
      "101 100 100 60", // child in the group
      "102 100 102 70", // child in a group of its own
      "103 102 103 80", // its child, in another group again
      "104 1 100 90", // left in the group, parent gone
      "105 1 105 999", // unrelated
    ].join("\n");
    const tree = treeOf(listing, 100);
    expect(tree.map((p) => p.pid).sort()).toEqual([100, 101, 102, 103, 104]);
    expect(tree.reduce((sum, p) => sum + p.rssKb, 0)).toBe(350);
  });

  describe("ending a run signals only a process that is still the one that was seen", () => {
    const sleepers: ChildProcess[] = [];
    afterEach(() => {
      vi.restoreAllMocks();
      for (const c of sleepers.splice(0)) {
        try {
          if (c.pid !== undefined) process.kill(c.pid, "SIGKILL");
        } catch {
          // Gone, as it should be.
        }
      }
    });

    /** A `sleep` in a process group of its own, as the CLI starts a git. */
    function sleeper(): number {
      const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      sleepers.push(c);
      if (c.pid === undefined) throw new Error("sleep did not start");
      return c.pid;
    }

    /** The pid of a process that has exited and been reaped. */
    async function reapedPid(): Promise<number> {
      const c = spawn("true", [], { detached: true, stdio: "ignore" });
      const pid = c.pid;
      await new Promise<void>((resolve) => {
        c.on("close", () => {
          resolve();
        });
      });
      if (pid === undefined) throw new Error("true did not start");
      return pid;
    }

    function alive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it("never signals a pid that is not in the group it was seen in, nor the root pid alone", async () => {
      const root = await reapedPid();
      const member = sleeper();
      // A process that is listed under a pid the sampler saw, but in
      // another group than the one it was seen in: what a recycled pid
      // looks like.
      const recycled = sleeper();
      expect(alive(member) && alive(recycled)).toBe(true);
      const kill = vi.spyOn(process, "kill");
      await killRun(
        root,
        true,
        new Map([
          [member, member],
          [recycled, root],
        ]),
      );
      const targets = kill.mock.calls
        .filter(([, sig]) => sig === "SIGKILL")
        .map(([pid]) => pid);
      // The root is reaped and nothing is left in its group: no group
      // signal, and no signal to the root pid by itself.
      expect(targets).toEqual([member]);
      expect(await processGone(member)).toBe(true);
      expect(alive(recycled)).toBe(true);
    });

    it("signals the group of a root that has not been reaped, and a seen process still in its group", async () => {
      const root = sleeper();
      const other = sleeper();
      await killRun(root, false, new Map([[other, other]]));
      expect(await processGone(root)).toBe(true);
      expect(await processGone(other)).toBe(true);
    });
  });

  it("leaves a run under both limits alone", async () => {
    const r = await spawnBounded(
      process.execPath,
      ["-e", "console.log('fine')"],
      { env: ENV },
      30_000,
      GRAPH_RSS_LIMIT_KB,
    );
    expect(r).toMatchObject({
      code: 0,
      stdout: "fine\n",
      timedOut: false,
      rssExceeded: false,
    });
  });
});

/**
 * `gitCan` for a probe that plants a grafts file: its git calls run bounded,
 * in a process group of their own and under the memory limit, like the
 * fixtures that follow, because a graph that loops is what git may walk
 * without end.
 */
async function gitCanBounded(
  check: (repo: string) => Promise<boolean>,
): Promise<boolean> {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-gitcan-"),
  );
  try {
    const repo = path.join(scratch, "repo");
    const run = (cwd: string, args: string[]): Promise<string> =>
      gitBounded(cwd, args, 20_000, {}, GRAPH_RSS_LIMIT_KB);
    await run(scratch, ["init", "-q", "-b", "main", "repo"]);
    write(repo, "a.txt", "one\n");
    await run(repo, ["add", "-A"]);
    await run(repo, ["commit", "-q", "-m", "init"]);
    return await check(repo);
  } catch {
    return false;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** git reads `info/grafts` (a deprecated file, still read by newer git with
 * a hint): the tests of a grafted graph skip on a git that no longer does. */
const GRAFTS_SUPPORTED = await gitCanBounded(async (repo) => {
  const run = (args: string[]): Promise<string> =>
    gitBounded(repo, args, 20_000, {}, GRAPH_RSS_LIMIT_KB);
  await run(["commit", "-q", "--allow-empty", "-m", "two"]);
  const tip = oneLine(await run(["rev-parse", "HEAD"]));
  fs.mkdirSync(path.join(repo, ".git/info"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/info/grafts"), `${tip}\n`);
  return oneLine(await run(["rev-list", "HEAD"])).split("\n").length === 1;
});

describe("the grafts capability gate", () => {
  it("agrees with what this git does with a grafts file, so the grafts tests never skip by mistake", async () => {
    // `gitCanBounded` reads any failure (a bound hit under load included)
    // as "no grafts", which would skip the grafts tests silently. This test
    // is never skipped and asks git again, through GIT_GRAFT_FILE, without
    // swallowing a failure.
    const scratch = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-primitives-gitcan-check-"),
    );
    try {
      const repo = path.join(scratch, "repo");
      const run = (
        cwd: string,
        args: string[],
        env: NodeJS.ProcessEnv = {},
      ): Promise<string> =>
        gitBounded(cwd, args, 20_000, env, GRAPH_RSS_LIMIT_KB);
      await run(scratch, ["init", "-q", "-b", "main", "repo"]);
      write(repo, "a.txt", "one\n");
      await run(repo, ["add", "-A"]);
      await run(repo, ["commit", "-q", "-m", "init"]);
      await run(repo, ["commit", "-q", "--allow-empty", "-m", "two"]);
      const tip = oneLine(await run(repo, ["rev-parse", "HEAD"]));
      const graftFile = path.join(scratch, "grafts");
      fs.writeFileSync(graftFile, `${tip}\n`);
      const listed = oneLine(
        await run(repo, ["rev-list", "HEAD"], { GIT_GRAFT_FILE: graftFile }),
      ).split("\n").length;
      expect(GRAFTS_SUPPORTED).toBe(listed === 1);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * A branch `feat` whose one commit no remote branch holds, in a worktree,
 * while `origin/main` has moved on by a commit that is not a parent of it:
 *
 *   M0 (base of feat)  - U (feat, unpushed)
 *   M0 - M1 (origin/main)
 *
 * A graph that gives M1 the parent U makes U an ancestor of `origin/main`
 * and of every remote-tracking ref, which is what the git commands under
 * the verdicts then read as "pushed" and "merged".
 */
interface Graph {
  f: Fixture;
  wt: string;
  /** U, the unpushed commit `feat` points at. */
  sha: string;
  /** M1, the tip of `origin/main`. */
  m1: string;
}

function makeGraph(): Graph {
  const f = makeFixture();
  commitHere(f.repo, "m1.txt", "main moves on");
  git(f.repo, ["push", "-q", "origin", "main"]);
  const m1 = oneLine(git(f.repo, ["rev-parse", "HEAD"]));
  const wt = path.join(f.base, "wt-feat");
  git(f.repo, ["worktree", "add", "--no-track", "-b", "feat", wt, f.mainSha]);
  commitHere(wt, "feat.txt", "unpushed work");
  return { f, wt, sha: oneLine(git(wt, ["rev-parse", "HEAD"])), m1 };
}

/** What `worktree remove` must answer for each flag set when the graph is
 * not the real one and the unpushed state cannot be told: the unknown state
 * for a plain remove and for `--delete-branch`, the unknown merge state as
 * soon as a merge is required. */
const UNKNOWN_GRAPH_CASES: [string[], string][] = [
  [[], "unpushed_state_unknown"],
  [["--delete-branch"], "unpushed_state_unknown"],
  [["--delete-branch", "--base", "origin/main"], "unpushed_state_unknown"],
  [["--require-merged"], "merge_state_unknown"],
  [["--require-merged", "--base", "origin/main"], "merge_state_unknown"],
  [["--require-merged", "--delete-branch"], "merge_state_unknown"],
];

/** What it must answer when replace refs are in play and the real graph is
 * read instead: the branch has a commit no remote holds. */
const REAL_GRAPH_CASES: [string[], string][] = [
  [[], "unpushed_commits"],
  [["--delete-branch"], "unpushed_commits"],
  [["--delete-branch", "--base", "origin/main"], "unpushed_commits"],
  [["--require-merged"], "merge_state_unknown"],
  [["--require-merged", "--base", "origin/main"], "merge_state_unknown"],
  [["--require-merged", "--delete-branch"], "merge_state_unknown"],
];

/** Runs each case against the worktree of `g`, under the process-group,
 * time and memory guards, and asserts the refusal with the worktree and the
 * branch still in place. */
async function expectRefusals(
  g: Graph,
  cases: [string[], string][],
  env: NodeJS.ProcessEnv = {},
  messageIncludes?: string,
): Promise<void> {
  for (const [flags, reason] of cases) {
    const r = await cliBounded(
      g.f.work,
      ["remove", g.wt, ...flags],
      env,
      45_000,
      GRAPH_RSS_LIMIT_KB,
    );
    const label = `${flags.join(" ")}: ${r.stdout}${r.stderr}`;
    expect(r.code, label).toBe(2);
    expect(r.json.reason, label).toBe(reason);
    if (messageIncludes !== undefined && reason !== "unpushed_commits") {
      expect(r.json.message, label).toContain(messageIncludes);
    }
    const listed = parseWorktreeList(
      await gg(g.f.repo, ["worktree", "list", "--porcelain"]),
    ).map((w) => w.path);
    expect(listed, label).toContain(g.wt);
    const at = await gg(
      g.f.repo,
      ["rev-parse", "--verify", "refs/heads/feat"],
      {},
    );
    expect(at.trim(), label).toBe(g.sha);
  }
}

/** What git itself counts as unpushed on `feat`, under the guards. */
async function guardedUnpushed(
  g: Graph,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return (
    await gg(g.f.repo, ["rev-list", "feat", "--not", "--remotes"], extraEnv)
  ).trim();
}

describe("worktree remove: replace refs", () => {
  async function plantGraft(g: Graph): Promise<void> {
    await gg(g.f.repo, ["replace", "--graft", g.m1, g.sha], {});
    // The premise: with the replacement git reads, no remote lacks U.
    expect(await guardedUnpushed(g)).toBe("");
  }

  it("refuses a branch whose commit a replace --graft hides under origin/main, with and without --base", async () => {
    const g = makeGraph();
    await plantGraft(g);
    await expectRefusals(g, REAL_GRAPH_CASES);
  });

  it("refuses a branch whose pushed ancestor a plain replace object gives the unpushed commit as its parent", async () => {
    const g = makeGraph();
    // The object `git replace --graft` builds, made by hand and installed
    // with the plain form: M1's tree, with U as its parent.
    const swapped = oneLine(
      await gg(g.f.repo, [
        "commit-tree",
        `${g.m1}^{tree}`,
        "-p",
        g.sha,
        "-m",
        "replacement",
      ]),
    );
    await gg(g.f.repo, ["replace", g.m1, swapped]);
    expect(await guardedUnpushed(g)).toBe("");
    await expectRefusals(g, REAL_GRAPH_CASES);
  });

  // Each way a caller can set `core.useReplaceRefs=true`. A git that reads
  // that value after `--no-replace-objects` turns replace refs back on, so
  // each case holds only while the call also carries
  // `-c core.useReplaceRefs=false`.
  const TURNED_BACK_ON: [string, (g: Graph) => Promise<NodeJS.ProcessEnv>][] = [
    [
      "core.useReplaceRefs=true in the repository configuration",
      async (g) => {
        await gg(g.f.repo, ["config", "core.useReplaceRefs", "true"], {});
        return {};
      },
    ],
    [
      "core.useReplaceRefs=true in GIT_CONFIG_PARAMETERS",
      () =>
        Promise.resolve({
          GIT_CONFIG_PARAMETERS: "'core.usereplacerefs'='true'",
        }),
    ],
    [
      "core.useReplaceRefs=true in GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0 and GIT_CONFIG_VALUE_0",
      () =>
        Promise.resolve({
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.useReplaceRefs",
          GIT_CONFIG_VALUE_0: "true",
        }),
    ],
  ];

  it.each(TURNED_BACK_ON)(
    "refuses the same graph when the caller sets %s, with and without --base",
    async (_name, turnOn) => {
      const g = makeGraph();
      await plantGraft(g);
      const env = await turnOn(g);
      // The premise: git without the call's own settings still reads the
      // replacement.
      expect(await guardedUnpushed(g, env)).toBe("");
      await expectRefusals(g, REAL_GRAPH_CASES, env);
    },
  );

  it("removes the branch with --force like any unknown state, though it counts the commit", async () => {
    const g = makeGraph();
    await plantGraft(g);
    const r = await cliBounded(
      g.f.work,
      ["remove", g.wt, "--delete-branch", "--force"],
      {},
      45_000,
      GRAPH_RSS_LIMIT_KB,
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });

  it("refuses a GIT_REPLACE_REF_BASE other than the default, with and without --base", async () => {
    const g = makeGraph();
    await plantGraft(g);
    // Move the replacement to refs/x/: only a caller that sets the variable
    // reads it.
    const replacement = oneLine(
      await gg(g.f.repo, ["rev-parse", `refs/replace/${g.m1}`]),
    );
    await gg(g.f.repo, ["update-ref", `refs/x/${g.m1}`, replacement]);
    await gg(g.f.repo, ["update-ref", "-d", `refs/replace/${g.m1}`]);
    const env = { GIT_REPLACE_REF_BASE: "refs/x/" };
    expect(await guardedUnpushed(g, env)).toBe("");
    expect(await guardedUnpushed(g)).toBe(g.sha);
    await expectRefusals(g, UNKNOWN_GRAPH_CASES, env, "GIT_REPLACE_REF_BASE");
  });

  it("refuses an empty GIT_REPLACE_REF_BASE too", async () => {
    const g = makeGraph();
    await expectRefusals(
      g,
      [[[], "unpushed_state_unknown"]],
      { GIT_REPLACE_REF_BASE: "" },
      "GIT_REPLACE_REF_BASE",
    );
  });

  it("removes a pushed branch as before when the environment names the default replace base", async () => {
    const f = makeFixture();
    const { wt } = makeUnpushed(f);
    git(wt, ["push", "-q", "origin", "feat"]);
    const r = await cliBounded(
      f.work,
      ["remove", wt, "--delete-branch"],
      { GIT_REPLACE_REF_BASE: "refs/replace/" },
      45_000,
      GRAPH_RSS_LIMIT_KB,
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });
});

/**
 * Rewrites the commit-graph file `file` so that its entry for `child` names
 * `parent` as its first parent, leaving the commit objects alone. git reads
 * parents from this file without checking them against the objects, so the
 * commits then read as parent and child to `rev-list` and `merge-base`. Only
 * the first parent of the entry is changed; the file's checksum is not
 * updated (git checks it only in `commit-graph verify`).
 */
function forgeCommitGraphParent(
  file: string,
  child: string,
  parent: string,
): void {
  const data = fs.readFileSync(file);
  expect(data.subarray(0, 4).toString("latin1")).toBe("CGPH");
  const hashLen = data[5] === 1 ? 20 : 32;
  const chunkCount = data[6] ?? 0;
  const chunks = new Map<string, number>();
  for (let i = 0; i <= chunkCount; i += 1) {
    const at = 8 + 12 * i;
    chunks.set(
      data.subarray(at, at + 4).toString("latin1"),
      Number(data.readBigUInt64BE(at + 4)),
    );
  }
  const fanout = chunks.get("OIDF");
  const oids = chunks.get("OIDL");
  const commitData = chunks.get("CDAT");
  if (fanout === undefined || oids === undefined || commitData === undefined) {
    throw new Error("the commit-graph file has no OIDF, OIDL or CDAT chunk");
  }
  const count = data.readUInt32BE(fanout + 255 * 4);
  const indexOf = (sha: string): number => {
    for (let i = 0; i < count; i += 1) {
      const at = oids + i * hashLen;
      if (data.subarray(at, at + hashLen).toString("hex") === sha) return i;
    }
    throw new Error(`${sha} is not in the commit-graph file`);
  };
  const entry = commitData + indexOf(child) * (hashLen + 16);
  data.writeUInt32BE(indexOf(parent), entry + hashLen);
  fs.writeFileSync(file, data);
}

describe("worktree remove: a forged commit-graph file", () => {
  /** The commit-graph file `git commit-graph write` makes in the common
   * directory, with M1 given the parent U, so that U reads as an ancestor
   * of `origin/main`. */
  async function plantForgedGraph(g: Graph): Promise<void> {
    await gg(g.f.repo, [
      "-c",
      "commitGraph.generationVersion=1",
      "commit-graph",
      "write",
      "--reachable",
      "--no-progress",
    ]);
    const file = path.join(commonDirOf(g.f), "objects/info/commit-graph");
    fs.chmodSync(file, 0o644);
    forgeCommitGraphParent(file, g.m1, g.sha);
    // The premise: git reads the forged parent, and reads the real one
    // without the file.
    expect(await guardedUnpushed(g)).toBe("");
    expect(
      (
        await gg(g.f.repo, [
          "-c",
          "core.commitGraph=false",
          "rev-list",
          "feat",
          "--not",
          "--remotes",
        ])
      ).trim(),
    ).toBe(g.sha);
  }

  it("refuses a branch whose commit a forged commit-graph file hides under origin/main, with and without --base", async () => {
    const g = makeGraph();
    await plantForgedGraph(g);
    await expectRefusals(g, REAL_GRAPH_CASES);
  });

  // Each way a caller can set `core.commitGraph=true`. The call's own
  // `-c core.commitGraph=false` is applied after all of them.
  const GRAPH_TURNED_ON: [string, (g: Graph) => Promise<NodeJS.ProcessEnv>][] =
    [
      [
        "core.commitGraph=true in the repository configuration",
        async (g) => {
          await gg(g.f.repo, ["config", "core.commitGraph", "true"], {});
          return {};
        },
      ],
      [
        "core.commitGraph=true in GIT_CONFIG_PARAMETERS",
        () =>
          Promise.resolve({
            GIT_CONFIG_PARAMETERS: "'core.commitgraph'='true'",
          }),
      ],
      [
        "core.commitGraph=true in GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0 and GIT_CONFIG_VALUE_0",
        () =>
          Promise.resolve({
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.commitGraph",
            GIT_CONFIG_VALUE_0: "true",
          }),
      ],
    ];

  it.each(GRAPH_TURNED_ON)(
    "refuses the same graph when the caller sets %s",
    async (_name, turnOn) => {
      const g = makeGraph();
      await plantForgedGraph(g);
      const env = await turnOn(g);
      expect(await guardedUnpushed(g, env)).toBe("");
      await expectRefusals(g, REAL_GRAPH_CASES, env);
    },
  );

  it("does not call the branch merged in list because of the forged parent", async () => {
    const g = makeGraph();
    await plantForgedGraph(g);
    const r = await cliBounded(
      g.f.work,
      ["list", "--repo", g.f.repo],
      {},
      45_000,
      GRAPH_RSS_LIMIT_KB,
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entry = (r.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === g.wt,
    );
    if (entry === undefined) throw new Error(`no entry for ${g.wt}`);
    expect(entry.merged.merged).toBe("unknown");
    expect(entry.merged.via).toBe("none");
  });

  it.each([
    [["--delete-branch"]],
    [["--delete-branch", "--base", "origin/main"]],
  ])(
    "removes a pushed branch as before when a genuine commit-graph file is there (%j)",
    async (flags) => {
      const f = makeFixture();
      const { wt } = makeUnpushed(f);
      git(wt, ["push", "-q", "origin", "feat"]);
      await gg(f.repo, [
        "commit-graph",
        "write",
        "--reachable",
        "--no-progress",
      ]);
      expect(
        fs.existsSync(
          path.join(
            absoluteGitPath(f.repo, "--git-common-dir"),
            "objects/info/commit-graph",
          ),
        ),
      ).toBe(true);
      const r = await cliBounded(
        f.work,
        ["remove", wt, ...flags],
        {},
        45_000,
        GRAPH_RSS_LIMIT_KB,
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(true);
    },
  );
});

describe.skipIf(!GRAFTS_SUPPORTED)("worktree remove: a grafts file", () => {
  /** M1 gets the parent U in `info/grafts` of `gitDir`. */
  function plantGrafts(g: Graph, file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${g.m1} ${g.sha}\n`);
  }

  it("refuses a branch that info/grafts of the common directory hides under origin/main, with and without --base", async () => {
    const g = makeGraph();
    plantGrafts(g, path.join(commonDirOf(g.f), "info/grafts"));
    expect(await guardedUnpushed(g)).toBe("");
    await expectRefusals(g, UNKNOWN_GRAPH_CASES, {}, "info/grafts");
  });

  it("refuses an info/grafts that is empty, a directory or a dangling link as well", async () => {
    for (const make of [
      (file: string) => {
        fs.writeFileSync(file, "");
      },
      (file: string) => {
        fs.mkdirSync(file);
      },
      (file: string) => {
        fs.symlinkSync("nowhere", file);
      },
    ]) {
      const g = makeGraph();
      const dir = path.join(commonDirOf(g.f), "info");
      fs.mkdirSync(dir, { recursive: true });
      make(path.join(dir, "grafts"));
      await expectRefusals(
        g,
        UNKNOWN_GRAPH_CASES.slice(0, 2),
        {},
        "info/grafts",
      );
    }
  });

  it("refuses the file GIT_GRAFT_FILE names, with and without --base", async () => {
    const g = makeGraph();
    const file = path.join(g.f.base, "elsewhere-grafts");
    plantGrafts(g, file);
    const env = { GIT_GRAFT_FILE: file };
    expect(await guardedUnpushed(g, env)).toBe("");
    expect(await guardedUnpushed(g)).toBe(g.sha);
    await expectRefusals(g, UNKNOWN_GRAPH_CASES, env, "GIT_GRAFT_FILE");
  });

  it("refuses GIT_GRAFT_FILE whatever it names, an empty file and /dev/null included", async () => {
    const g = makeGraph();
    const empty = path.join(g.f.base, "empty-grafts");
    fs.writeFileSync(empty, "");
    for (const value of [empty, "/dev/null", path.join(g.f.base, "none")]) {
      await expectRefusals(
        g,
        UNKNOWN_GRAPH_CASES.slice(0, 2),
        { GIT_GRAFT_FILE: value },
        "GIT_GRAFT_FILE",
      );
    }
  });

  it("does not take the private info/grafts of a linked worktree for the one git reads", async () => {
    const g = makeGraph();
    const privateDir = oneLine(git(g.wt, ["rev-parse", "--absolute-git-dir"]));
    expect(privateDir).not.toBe(commonDirOf(g.f));
    plantGrafts(g, path.join(privateDir, "info/grafts"));
    // git ignores it, so the real graph is read and the commit is unpushed.
    expect(await guardedUnpushed(g)).toBe(g.sha);
    await expectRefusals(g, REAL_GRAPH_CASES);
  });

  it("removes the branch with --force like any unknown state", async () => {
    const g = makeGraph();
    plantGrafts(g, path.join(commonDirOf(g.f), "info/grafts"));
    const r = await cliBounded(
      g.f.work,
      ["remove", g.wt, "--delete-branch", "--force"],
      {},
      45_000,
      GRAPH_RSS_LIMIT_KB,
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.branch.deleted).toBe(true);
  });
});

describe("worktree list: a replaced or grafted commit graph", () => {
  async function feat(
    g: Graph,
    env: NodeJS.ProcessEnv = {},
  ): Promise<Record<string, any>> {
    const r = await cliBounded(
      g.f.work,
      ["list", "--repo", g.f.repo],
      env,
      45_000,
      GRAPH_RSS_LIMIT_KB,
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const entry = (r.json.worktrees as Record<string, any>[]).find(
      (w) => w.path === g.wt,
    );
    if (entry === undefined) throw new Error(`no entry for ${g.wt}`);
    return entry;
  }

  it("does not call a branch merged because a replace --graft puts it under origin/main", async () => {
    const g = makeGraph();
    const before = (await feat(g)).merged;
    expect(before.merged).toBe("unknown");
    await gg(g.f.repo, ["replace", "--graft", g.m1, g.sha], {});
    // The verdict is the one the real graph gives, not "merged".
    expect((await feat(g)).merged).toEqual(before);
  });

  it.skipIf(!GRAFTS_SUPPORTED)(
    "reports the merge state unknown, naming the grafts file, rather than trusting a grafted ancestry",
    async () => {
      const g = makeGraph();
      fs.mkdirSync(path.join(commonDirOf(g.f), "info"), { recursive: true });
      fs.writeFileSync(
        path.join(commonDirOf(g.f), "info/grafts"),
        `${g.m1} ${g.sha}\n`,
      );
      const merged = (await feat(g)).merged;
      expect(merged).toMatchObject({ merged: "unknown", via: "none" });
      expect(merged.reason).toContain("info/grafts");
      const viaEnv = (await feat(g, { GIT_GRAFT_FILE: "/dev/null" })).merged;
      expect(viaEnv.reason).toContain("GIT_GRAFT_FILE");
    },
  );
});

describe("alteredCommitGraph", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function scratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-alt-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("is undefined for a missing grafts file, a missing info directory and a file where info should be", () => {
    const dir = scratch();
    expect(alteredCommitGraph(Buffer.from(path.join(dir, "info/grafts")))).toBe(
      undefined,
    );
    fs.writeFileSync(path.join(dir, "info"), "not a directory");
    expect(alteredCommitGraph(Buffer.from(path.join(dir, "info/grafts")))).toBe(
      undefined,
    );
  });

  it("names a grafts file that exists, whatever it is", () => {
    const dir = scratch();
    const file = path.join(dir, "grafts");
    fs.writeFileSync(file, "");
    expect(alteredCommitGraph(Buffer.from(file))).toContain("exists");
  });

  it("refuses an entry it cannot inspect instead of reading it as absent", () => {
    if (process.getuid?.() === 0) return;
    const dir = scratch();
    const locked = path.join(dir, "info");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "grafts"), "");
    fs.chmodSync(locked, 0o000);
    try {
      expect(
        alteredCommitGraph(Buffer.from(path.join(locked, "grafts"))),
      ).toContain("cannot be inspected");
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it("refuses GIT_GRAFT_FILE when set to anything, and a non-default GIT_REPLACE_REF_BASE", () => {
    const none = Buffer.from(path.join(scratch(), "info/grafts"));
    vi.stubEnv("GIT_GRAFT_FILE", "");
    expect(alteredCommitGraph(none)).toContain("GIT_GRAFT_FILE");
    vi.unstubAllEnvs();
    for (const value of ["refs/x/", "refs/replace", "", "refs/heads/"]) {
      vi.stubEnv("GIT_REPLACE_REF_BASE", value);
      expect(alteredCommitGraph(none), value).toContain("GIT_REPLACE_REF_BASE");
    }
    vi.stubEnv("GIT_REPLACE_REF_BASE", "refs/replace/");
    expect(alteredCommitGraph(none)).toBe(undefined);
  });
});
