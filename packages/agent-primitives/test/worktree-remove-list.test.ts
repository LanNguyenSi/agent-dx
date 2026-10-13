import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ignoredSymlinks, parseWorktreeList } from "../src/worktree/index.js";
import {
  resolveDefaultBase,
  resolveRemoteBase,
  untrustedLooseRemoteRef,
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

function makeFixture(refFormat?: string): Fixture {
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
    ...(refFormat === undefined ? [] : [`--ref-format=${refFormat}`]),
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

  it("with --root, a repository where the value is no remote-tracking branch gives unknown and a warning", async () => {
    const f = makeFixture();
    const { wt } = makeHotfix(f);
    const wts = path.join(f.base, "wts");
    fs.mkdirSync(wts);
    fs.renameSync(wt, path.join(wts, "moved"));
    git(f.repo, ["worktree", "repair", path.join(wts, "moved")]);
    const r = await cli(f.work, ["list", "--root", wts, "--base", "HEAD"]);
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

/**
 * `cli`, bounded: the CLI runs in its own process group with a hard time
 * limit, and the whole group is killed when the limit passes, so a layout
 * that sends git into a long walk ends the test instead of the machine's
 * memory. The limit is far above a normal run and well below the test
 * timeout.
 */
async function cliBounded(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  limitMs = 45_000,
): Promise<Cli> {
  const child = spawn(
    process.execPath,
    [CLI_PATH, "-C", cwd, "worktree", ...args],
    {
      env: buildSpawnEnv({ ...GIT_ENV, ...extraEnv }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
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
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  const timer = setTimeout(killGroup, limitMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => {
      resolve(c);
    });
  });
  clearTimeout(timer);
  // Anything the CLI left behind in its group (a git that outlived it).
  killGroup();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(stdout.trim()) as Record<string, any>;
  } catch {
    json = {};
  }
  return { code, json, stdout, stderr };
}

/** The directory git keeps the shared refs in. */
function commonDirOf(f: Fixture): string {
  return absoluteGitPath(f.repo, "--git-common-dir");
}

/** Runs each flag set against the worktree and asserts the unknown-state
 * refusal, with the worktree and the branch at `sha` still in place. */
async function expectUnknownState(
  f: Fixture,
  wt: string,
  sha: string,
  flagSets: string[][],
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  for (const flags of flagSets) {
    const r = await cliBounded(f.work, ["remove", wt, ...flags], env);
    const label = `${flags.join(" ")}: ${r.stdout}${r.stderr}`;
    expect(r.code, label).toBe(2);
    expect(r.json.reason, label).toBe("unpushed_state_unknown");
    expect(listedWorktrees(f.repo), label).toContain(wt);
    expect(git(f.repo, ["rev-parse", "feat"]).trim(), label).toBe(sha);
  }
}

const SYMLINK_FLAG_SETS: string[][] = [
  [],
  ["--delete-branch"],
  ["--delete-branch", "--base", "origin/main"],
];

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
    expect(git(f.repo, ["rev-list", "feat", "--not", "--remotes"]).trim()).toBe(
      "",
    );
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
    expect(git(f.repo, ["rev-list", "feat", "--not", "--remotes"]).trim()).toBe(
      "",
    );
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
    expect(listedWorktrees(f.repo)).not.toContain(wt);
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
        fs.writeFileSync(
          path.join(commonDirOf(f), "refs/heads/feat"),
          `${sha}\n`,
        );
        fs.symlinkSync(
          "../../heads/feat",
          path.join(commonDirOf(f), "refs/remotes/origin/dup"),
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
      "a fifo where a ref should be",
      (f) => {
        execFileSync("mkfifo", [
          path.join(commonDirOf(f), "refs/remotes/origin/pipe"),
        ]);
      },
    ],
  ];

  it.each(LAYOUTS)("keeps the branch next to %s", async (_name, build) => {
    const f = makeFixture();
    const { wt, sha } = makeUnpushed(f);
    build(f, sha);
    await expectUnknownState(f, wt, sha, [["--delete-branch"]]);
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
    expect(privateDir).not.toBe(commonDirOf(f));
    fs.mkdirSync(path.join(privateDir, "refs/remotes/origin"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(commonDirOf(f), "refs/heads/feat"),
      path.join(privateDir, "refs/remotes/origin/self"),
    );
    expect(git(f.repo, ["rev-list", "feat", "--not", "--remotes"]).trim()).toBe(
      sha,
    );
    // Unchanged: the branch is plainly unpushed, not an unknown state.
    const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.reason).toBe("unpushed_commits");
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
  "worktree remove: a reftable repository has no loose refs to walk",
  () => {
    it("behaves as before: a pushed branch goes, an unpushed one stays", async () => {
      const f = makeFixture("reftable");
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
      const f = makeFixture("reftable");
      const { wt, sha } = makeUnpushed(f);
      const dir = path.join(commonDirOf(f), "refs/remotes/origin");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync("../../heads/feat", path.join(dir, "self"));
      expect(
        git(f.repo, ["rev-list", "feat", "--not", "--remotes"]).trim(),
      ).toBe(sha);
      const r = await cliBounded(f.work, ["remove", wt, "--delete-branch"]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("unpushed_commits");
    });
  },
);

describe("untrustedLooseRemoteRef: the walk", () => {
  function tree(): string {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-walk-")),
    );
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, "refs/remotes/origin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "refs/remotes/origin/main"), "x\n");
    return dir;
  }

  it("accepts plain files and directories, and a repository without loose remote refs", () => {
    const dir = tree();
    expect(untrustedLooseRemoteRef(dir)).toBeUndefined();
    fs.rmSync(path.join(dir, "refs/remotes"), { recursive: true });
    expect(untrustedLooseRemoteRef(dir)).toBeUndefined();
  });

  it("names a link and never descends into a looping directory link", () => {
    const dir = tree();
    fs.symlinkSync(".", path.join(dir, "refs/remotes/loop"));
    expect(untrustedLooseRemoteRef(dir)).toBe(
      "refs/remotes/loop is a symbolic link",
    );
  });

  it("stops at the entry bound", () => {
    const dir = tree();
    for (const name of ["a", "b", "c", "d"]) {
      fs.writeFileSync(path.join(dir, "refs/remotes/origin", name), "x\n");
    }
    const bounds = { maxEntries: 4, maxDepth: 8 };
    // origin, main, a, b, c, d: six entries.
    expect(untrustedLooseRemoteRef(dir, bounds)).toContain("more than 4");
    expect(
      untrustedLooseRemoteRef(dir, { ...bounds, maxEntries: 6 }),
    ).toBeUndefined();
  });

  it("stops at the depth bound", () => {
    const dir = tree();
    fs.mkdirSync(path.join(dir, "refs/remotes/origin/a/b/c"), {
      recursive: true,
    });
    const bounds = { maxEntries: 100, maxDepth: 3 };
    // origin is level 1, a 2, b 3, c 4.
    expect(untrustedLooseRemoteRef(dir, bounds)).toContain("deeper than 3");
    expect(
      untrustedLooseRemoteRef(dir, { ...bounds, maxDepth: 4 }),
    ).toBeUndefined();
  });
});
