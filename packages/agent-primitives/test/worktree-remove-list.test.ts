import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ignoredSymlinks, parseWorktreeList } from "../src/worktree/index.js";
import { FIXED_BIN_DIR, spawnCli } from "./helpers/spawn-cli.js";

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

function makeFixture(): Fixture {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-remove-")),
  );
  tmpDirs.push(base);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(base, ["init", "-q", "-b", "main", repo]);
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
    git(other, ["branch", "onlyhere", "origin/hotfixbase"]);
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
      "onlyhere",
    ]);
    expect(mixed.code, mixed.stdout + mixed.stderr).toBe(0);
    const entries = mixed.json.worktrees as Record<string, any>[];
    const resolved = entries.find((w) => w.repo === "other");
    const unresolved = entries.find((w) => w.repo === "repo");
    expect(resolved?.merged).toMatchObject({ merged: "yes", via: "ancestry" });
    expect(resolved?.base).toBe("onlyhere");
    expect(unresolved?.merged.merged).toBe("unknown");
    expect(
      (mixed.json.warnings as string[]).filter((w) => w.includes("onlyhere")),
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
    for (const bad of ["origin/nope", "--upload-pack=x"]) {
      const r = await cli(f.work, [
        "remove",
        wt,
        "--require-merged",
        `--base=${bad}`,
        "--force",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("base_not_found");
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
