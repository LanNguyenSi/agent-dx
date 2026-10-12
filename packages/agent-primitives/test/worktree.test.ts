import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecResult } from "../src/exec.js";
import {
  branchSlug,
  normalizeLinkEntry,
  parseWorktreeList,
  smokeVerdict,
} from "../src/worktree/index.js";
import { excludePatternFor } from "../src/worktree/git.js";
import { spawnCli } from "./helpers/spawn-cli.js";

/**
 * Hermetic: every git call, in-process and inside the spawned CLI, runs
 * with no global or system git config, an identity from the environment,
 * and a local bare repository as `origin`. Nothing reaches the network.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

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

function gitStatus(cwd: string, args: string[]): number {
  try {
    execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      env: { PATH: process.env.PATH, ...GIT_ENV },
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
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

function makeFixture(
  options: { gitignore?: string; origin?: boolean } = {},
): Fixture {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-worktree-")),
  );
  tmpDirs.push(base);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(base, ["init", "-q", "-b", "main", repo]);
  // Pinned so the default of a developer's git cannot change what a
  // branch started from a remote ref tracks.
  git(repo, ["config", "branch.autoSetupMerge", "true"]);
  write(repo, "a.txt", "one\n");
  write(repo, ".gitignore", options.gitignore ?? ".ai/run\nnode_modules\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  if (options.origin !== false) {
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
  }
  const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();
  return { base, origin, repo, work, mainSha };
}

/** Pushes one more commit to `origin/main` from a scratch clone, so the
 * main checkout's `origin/main` is stale until a fetch. */
function advanceOrigin(f: Fixture): string {
  const clone = path.join(f.base, "other-clone");
  git(f.base, ["clone", "-q", f.origin, clone]);
  write(clone, "b.txt", "two\n");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-q", "-m", "second"]);
  git(clone, ["push", "-q", "origin", "main"]);
  return git(clone, ["rev-parse", "HEAD"]).trim();
}

interface Cli {
  code: number | null;
  json: Record<string, any>;
  stdout: string;
  stderr: string;
}

async function run(cwd: string, args: string[]): Promise<Cli> {
  const r = await spawnCli(["-C", cwd, "worktree", "create", ...args], {
    env: GIT_ENV,
  });
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(r.stdout.trim()) as Record<string, any>;
  } catch {
    json = {};
  }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
}

function listedWorktrees(repo: string): string[] {
  return parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"])).map(
    (w) => w.path,
  );
}

describe("worktree create: base, branch and path", () => {
  it("creates a worktree from the default base with a branch that has no upstream", async () => {
    const f = makeFixture();
    const target = path.join(f.base, "wt-default");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "feat/one",
      "--path",
      target,
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.command).toBe("worktree create");
    expect(r.json.status).toBe("ok");
    expect(r.json.worktree.path).toBe(target);
    expect(r.json.worktree.branch).toBe("feat/one");
    expect(r.json.worktree.repo).toBe("repo");
    expect(r.json.worktree.mainCheckout).toBe(f.repo);
    expect(r.json.base).toMatchObject({
      ref: "origin/main",
      sha: f.mainSha,
      source: "default",
    });
    expect(r.json.worktree.head).toBe(f.mainSha);
    expect(r.json.runBase).toBe(`run-base[repo] = ${f.mainSha}`);
    expect(r.json.fetch.status).toBe("fetched");
    expect(r.json.upstream).toBeNull();

    expect(git(target, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(
      "feat/one",
    );
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(f.mainSha);
    // No upstream: no tracking config on the branch and no @{upstream}.
    expect(
      gitStatus(f.repo, ["config", "--get", "branch.feat/one.remote"]),
    ).toBe(1);
    expect(
      gitStatus(f.repo, ["config", "--get", "branch.feat/one.merge"]),
    ).toBe(1);
    expect(
      gitStatus(target, ["rev-parse", "--verify", "@{upstream}"]),
    ).not.toBe(0);
    expect(listedWorktrees(f.repo)).toContain(target);
  });

  it("fetches origin first, and --no-fetch branches from the refs as they are", async () => {
    const f = makeFixture();
    const advanced = advanceOrigin(f);
    expect(advanced).not.toBe(f.mainSha);

    const stale = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "stale",
      "--path",
      path.join(f.base, "wt-stale"),
      "--no-fetch",
    ]);
    expect(stale.code, stale.stdout).toBe(0);
    expect(stale.json.fetch).toEqual({
      status: "skipped",
      reason: "--no-fetch",
    });
    expect(stale.json.base.sha).toBe(f.mainSha);

    const fresh = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "fresh",
      "--path",
      path.join(f.base, "wt-fresh"),
    ]);
    expect(fresh.code, fresh.stdout).toBe(0);
    expect(fresh.json.fetch.status).toBe("fetched");
    expect(fresh.json.base.sha).toBe(advanced);
    expect(fresh.json.runBase).toBe(`run-base[repo] = ${advanced}`);
  });

  it("creates from --base, with no upstream either", async () => {
    const f = makeFixture();
    git(f.repo, ["checkout", "-q", "-b", "develop"]);
    write(f.repo, "dev.txt", "dev\n");
    git(f.repo, ["add", "-A"]);
    git(f.repo, ["commit", "-q", "-m", "develop work"]);
    git(f.repo, ["push", "-q", "origin", "develop"]);
    const developSha = git(f.repo, ["rev-parse", "HEAD"]).trim();
    git(f.repo, ["checkout", "-q", "main"]);

    const target = path.join(f.base, "wt-develop");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "from-develop",
      "--base",
      "origin/develop",
      "--path",
      target,
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.base).toMatchObject({
      ref: "origin/develop",
      sha: developSha,
      source: "flag",
    });
    expect(fs.existsSync(path.join(target, "dev.txt"))).toBe(true);
    expect(
      gitStatus(target, ["rev-parse", "--verify", "@{upstream}"]),
    ).not.toBe(0);
    // The main checkout stayed on main.
    expect(git(f.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(
      "main",
    );

    const bySha = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "from-sha",
      "--base",
      developSha,
      "--path",
      path.join(f.base, "wt-sha"),
    ]);
    expect(bySha.code, bySha.stdout).toBe(0);
    expect(bySha.json.base.sha).toBe(developSha);
  });

  it("resolves a relative --path and --repo against the invocation directory, not the repository", async () => {
    const f = makeFixture();
    const r = await run(f.work, [
      "--repo",
      "../repo",
      "--branch",
      "relative",
      "--path",
      "nested/wt-relative",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const expected = path.join(f.work, "nested", "wt-relative");
    expect(path.isAbsolute(r.json.worktree.path)).toBe(true);
    expect(r.json.worktree.path).toBe(expected);
    expect(fs.existsSync(path.join(expected, "a.txt"))).toBe(true);
    // Nothing landed inside the repository.
    expect(fs.existsSync(path.join(f.repo, "nested"))).toBe(false);
    expect(listedWorktrees(f.repo)).toContain(expected);
  });

  it("names the directory after the branch under --root, and next to the main checkout by default", async () => {
    const f = makeFixture();
    const root = path.join(f.base, "roots");
    const underRoot = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "feat/two",
      "--root",
      root,
    ]);
    expect(underRoot.code, underRoot.stdout).toBe(0);
    expect(underRoot.json.worktree.path).toBe(path.join(root, "feat-two"));

    const byDefault = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "feat/three",
    ]);
    expect(byDefault.code, byDefault.stdout).toBe(0);
    expect(byDefault.json.worktree.path).toBe(
      path.join(f.base, "repo-worktrees", "feat-three"),
    );
  });

  it("works from a linked worktree and still reports the main checkout", async () => {
    const f = makeFixture();
    const first = path.join(f.base, "wt-first");
    await run(f.work, ["--repo", f.repo, "--branch", "first", "--path", first]);
    const second = await run(f.work, [
      "--repo",
      first,
      "--branch",
      "second",
      "--path",
      path.join(f.base, "wt-second"),
    ]);
    expect(second.code, second.stdout).toBe(0);
    expect(second.json.worktree.mainCheckout).toBe(f.repo);
    expect(second.json.worktree.repo).toBe("repo");
  });

  it("leaves the main checkout's HEAD, index, working tree and stash untouched", async () => {
    const f = makeFixture();
    write(f.repo, "a.txt", "stashed change\n");
    git(f.repo, ["stash", "push", "-q", "-m", "keep me"]);
    write(f.repo, "a.txt", "dirty change\n");
    git(f.repo, ["add", "a.txt"]);
    write(f.repo, "untracked.txt", "u\n");
    git(f.repo, ["checkout", "-q", "-b", "elsewhere"]);

    const snapshot = () => ({
      head: fs.readFileSync(path.join(f.repo, ".git", "HEAD"), "utf8"),
      index: fs.readFileSync(path.join(f.repo, ".git", "index")),
      stashRef: fs.readFileSync(
        path.join(f.repo, ".git", "refs", "stash"),
        "utf8",
      ),
      stashLog: fs.readFileSync(
        path.join(f.repo, ".git", "logs", "refs", "stash"),
        "utf8",
      ),
      files: ["a.txt", "untracked.txt"].map((n) =>
        fs.readFileSync(path.join(f.repo, n), "utf8"),
      ),
    });
    const before = snapshot();
    const stashListBefore = git(f.repo, ["stash", "list"]);

    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "untouched",
      "--path",
      path.join(f.base, "wt-untouched"),
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);

    const after = snapshot();
    expect(after.head).toBe(before.head);
    expect(after.head).toBe("ref: refs/heads/elsewhere\n");
    expect(after.index.equals(before.index)).toBe(true);
    expect(after.stashRef).toBe(before.stashRef);
    expect(after.stashLog).toBe(before.stashLog);
    expect(after.files).toEqual(before.files);
    expect(git(f.repo, ["stash", "list"])).toBe(stashListBefore);
    expect(stashListBefore).toContain("keep me");
  });
});

describe("worktree create: refusals", () => {
  async function expectRefusal(
    f: Fixture,
    args: string[],
    reason: string,
    cwd = f.work,
  ): Promise<Cli> {
    const worktreesBefore = listedWorktrees(f.repo);
    const branchesBefore = git(f.repo, ["branch", "--list"]);
    const r = await run(cwd, args);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.json.status).toBe("usage_error");
    expect(r.json.command).toBe("worktree create");
    expect(r.json.reason).toBe(reason);
    expect(typeof r.json.message).toBe("string");
    // A refusal changes nothing.
    expect(listedWorktrees(f.repo)).toEqual(worktreesBefore);
    expect(git(f.repo, ["branch", "--list"])).toBe(branchesBefore);
    return r;
  }

  it("refuses an existing branch", async () => {
    const f = makeFixture();
    git(f.repo, ["branch", "taken"]);
    const r = await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "taken", "--path", path.join(f.base, "w")],
      "branch_exists",
    );
    expect(r.json.message).toContain("taken");
    expect(fs.existsSync(path.join(f.base, "w"))).toBe(false);
  });

  it("refuses a branch checked out in another worktree, naming it", async () => {
    const f = makeFixture();
    const holder = path.join(f.base, "wt-holder");
    const first = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "held",
      "--path",
      holder,
    ]);
    expect(first.code, first.stdout).toBe(0);
    const r = await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "held", "--path", path.join(f.base, "w2")],
      "branch_checked_out",
    );
    expect(r.json.message).toContain(holder);
    expect(r.json.details.worktree).toBe(holder);
  });

  it("refuses the branch the main checkout is on", async () => {
    const f = makeFixture();
    const r = await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "main", "--path", path.join(f.base, "w3")],
      "branch_checked_out",
    );
    expect(r.json.details.worktree).toBe(f.repo);
  });

  it("refuses a target that exists, empty directory included", async () => {
    const f = makeFixture();
    const existing = path.join(f.base, "already-there");
    fs.mkdirSync(existing);
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "x", "--path", existing],
      "target_exists",
    );
  });

  it("refuses a target inside the main checkout, also when given relative to the invocation directory", async () => {
    const f = makeFixture();
    const inside = path.join(f.repo, "sub", "wt");
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "x", "--path", inside],
      "target_inside_checkout",
    );
    expect(fs.existsSync(path.join(f.repo, "sub"))).toBe(false);
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "y", "--path", "wt-in-repo"],
      "target_inside_checkout",
      f.repo,
    );
    expect(fs.existsSync(path.join(f.repo, "wt-in-repo"))).toBe(false);
  });

  it("refuses a --repo that is not a git repository, or does not exist", async () => {
    const f = makeFixture();
    const plain = path.join(f.base, "plain");
    fs.mkdirSync(plain);
    const notRepo = await run(f.work, [
      "--repo",
      plain,
      "--branch",
      "x",
      "--path",
      path.join(f.base, "w4"),
    ]);
    expect(notRepo.code).toBe(2);
    expect(notRepo.json.reason).toBe("not_a_git_repo");
    const missing = await run(f.work, [
      "--repo",
      path.join(f.base, "nope"),
      "--branch",
      "x",
      "--path",
      path.join(f.base, "w5"),
    ]);
    expect(missing.code).toBe(2);
    expect(missing.json.reason).toBe("not_a_git_repo");
    expect(fs.existsSync(path.join(f.base, "w4"))).toBe(false);
  });

  it("gives each of the five required refusals its own code", () => {
    const codes = [
      "branch_exists",
      "branch_checked_out",
      "target_exists",
      "target_inside_checkout",
      "not_a_git_repo",
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("refuses an invalid branch name, an unknown base and conflicting options", async () => {
    const f = makeFixture();
    const t = path.join(f.base, "w6");
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "a..b", "--path", t],
      "branch_invalid",
    );
    await expectRefusal(
      f,
      [
        "--repo",
        f.repo,
        "--branch",
        "ok",
        "--base",
        "no-such-rev",
        "--path",
        t,
      ],
      "base_not_found",
    );
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "ok", "--base", "--detach", "--path", t],
      "base_not_found",
    );
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "ok", "--path", t, "--root", f.base],
      "path_and_root_conflict",
    );
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "ok", "--path", t, "--pass-regex", "x"],
      "option_invalid",
    );
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "ok", "--path", t, "--setup", "  "],
      "option_invalid",
    );
    await expectRefusal(
      f,
      [
        "--repo",
        f.repo,
        "--branch",
        "ok",
        "--path",
        t,
        "--run",
        path.join(f.base, "no-run-dir"),
      ],
      "run_dir_missing",
    );
  });

  it("asks for --base when the default branch cannot be told, and skips the fetch without an origin", async () => {
    const f = makeFixture({ origin: false });
    const t = path.join(f.base, "w7");
    await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "x", "--path", t],
      "default_branch_unresolved",
    );
    const ok = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "x",
      "--base",
      "main",
      "--path",
      t,
    ]);
    expect(ok.code, ok.stdout).toBe(0);
    expect(ok.json.fetch.status).toBe("skipped");
    expect(ok.json.fetch.reason).toContain("no origin");
    expect(ok.json.warnings.join("\n")).toContain("fetch skipped");
  });

  it("refuses when the fetch fails, and says how to go on", async () => {
    const f = makeFixture();
    git(f.repo, ["remote", "set-url", "origin", path.join(f.base, "gone.git")]);
    const r = await expectRefusal(
      f,
      ["--repo", f.repo, "--branch", "x", "--path", path.join(f.base, "w8")],
      "fetch_failed",
    );
    expect(r.json.message).toContain("--no-fetch");
    const ok = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "x",
      "--path",
      path.join(f.base, "w8"),
      "--no-fetch",
    ]);
    expect(ok.code, ok.stdout).toBe(0);
  });
});

describe("worktree create: run pointer", () => {
  it("writes .ai/run with the absolute run directory when git ignores it", async () => {
    const f = makeFixture({ gitignore: ".ai/run\n" });
    const runDir = path.join(f.base, "runs", "one");
    fs.mkdirSync(runDir, { recursive: true });
    const target = path.join(f.base, "wt-pointer");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "pointer",
      "--path",
      target,
      "--run",
      "../runs/one",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.pointer.status).toBe("written");
    expect(r.json.pointer.target).toBe(runDir);
    expect(fs.readFileSync(path.join(target, ".ai", "run"), "utf8")).toBe(
      `${runDir}\n`,
    );
    // The pointer is invisible to git, which is why it was allowed.
    expect(git(target, ["status", "--porcelain"])).toBe("");
  });

  it("skips the pointer, with the reason, when .ai/run is not ignored", async () => {
    const f = makeFixture({ gitignore: "node_modules\n" });
    const runDir = path.join(f.base, "runs", "two");
    fs.mkdirSync(runDir, { recursive: true });
    const target = path.join(f.base, "wt-no-pointer");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "no-pointer",
      "--path",
      target,
      "--run",
      runDir,
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.pointer.status).toBe("skipped");
    expect(r.json.pointer.reason).toContain("not ignored");
    expect(fs.existsSync(path.join(target, ".ai", "run"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".ai"))).toBe(false);
  });

  it("reports the pointer as not requested without --run", async () => {
    const f = makeFixture();
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "plain",
      "--path",
      path.join(f.base, "wt-plain"),
    ]);
    expect(r.json.pointer).toEqual({ status: "not_requested" });
  });
});

describe("worktree create: dependency links", () => {
  it("links to the main checkout and excludes the link through the shared exclude file", async () => {
    const f = makeFixture();
    write(f.repo, "vendor/lib.txt", "lib\n");
    write(f.repo, "project/docroot/core/index.txt", "core\n");
    const target = path.join(f.base, "wt-links");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "links",
      "--path",
      target,
      "--link",
      "vendor,./project/docroot/core/",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.links.skipped).toEqual([]);
    expect(
      r.json.links.made.map((l: { path: string }) => l.path).sort(),
    ).toEqual(["project/docroot/core", "vendor"]);

    for (const rel of ["vendor", "project/docroot/core"]) {
      const link = path.join(target, rel);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join(f.repo, rel));
    }
    expect(
      fs.readFileSync(path.join(target, "vendor", "lib.txt"), "utf8"),
    ).toBe("lib\n");
    // Excluded in the common git dir, so the main checkout and every
    // other worktree agree, and git status stays clean in the new one.
    const exclude = fs.readFileSync(
      path.join(f.repo, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude.split("\n")).toContain("/vendor");
    expect(exclude.split("\n")).toContain("/project/docroot/core");
    expect(
      r.json.links.made.map((l: { exclude: string }) => l.exclude),
    ).toEqual(["added", "added"]);
    expect(git(target, ["status", "--porcelain"])).toBe("");
  });

  it("skips a missing source, an existing destination and a path below a link, each with a reason", async () => {
    const f = makeFixture();
    write(f.repo, "vendor/lib.txt", "lib\n");
    write(f.repo, "vendor/inner/x.txt", "x\n");
    const target = path.join(f.base, "wt-skips");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "skips",
      "--path",
      target,
      "--link",
      "missing,a.txt,vendor,vendor/inner",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const reasons = Object.fromEntries(
      r.json.links.skipped.map((s: { path: string; reason: string }) => [
        s.path,
        s.reason,
      ]),
    );
    expect(reasons).toEqual({
      missing: "source_missing",
      "a.txt": "destination_exists",
      "vendor/inner": "parent_is_symlink",
    });
    expect(r.json.links.made.map((l: { path: string }) => l.path)).toEqual([
      "vendor",
    ]);
    // Nothing was written through the link into the main checkout.
    expect(
      fs.lstatSync(path.join(f.repo, "vendor", "inner")).isDirectory(),
    ).toBe(true);
    expect(fs.existsSync(path.join(target, "missing"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "a.txt"), "utf8")).toBe("one\n");
  });

  it("does not add an exclude line for a path git already ignores", async () => {
    const f = makeFixture({ gitignore: ".ai/run\nnode_modules\n" });
    write(f.repo, "node_modules/pkg/index.js", "x\n");
    const before = fs.readFileSync(
      path.join(f.repo, ".git", "info", "exclude"),
      "utf8",
    );
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "ignored",
      "--path",
      path.join(f.base, "wt-ignored"),
      "--link",
      "node_modules",
    ]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.json.links.made[0]).toMatchObject({
      path: "node_modules",
      exclude: "already_ignored",
    });
    expect(
      fs.readFileSync(path.join(f.repo, ".git", "info", "exclude"), "utf8"),
    ).toBe(before);
  });

  it("excludes a link a directory-only pattern does not cover, because git sees a symlink as a file", async () => {
    const f = makeFixture({ gitignore: ".ai/run\nvendor/\n" });
    write(f.repo, "vendor/lib.txt", "lib\n");
    const target = path.join(f.base, "wt-dirpattern");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "dirpattern",
      "--path",
      target,
      "--link",
      "vendor",
    ]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.json.links.made[0].exclude).toBe("added");
    expect(git(target, ["status", "--porcelain"])).toBe("");
  });

  it("accepts a config file outside the repository, with comments and blank lines, next to --link", async () => {
    const f = makeFixture();
    write(f.repo, "vendor/lib.txt", "lib\n");
    write(f.repo, "bin/tool", "t\n");
    write(f.repo, "extra/x.txt", "x\n");
    const config = path.join(f.base, "operator", "links.txt");
    write(
      f.base,
      "operator/links.txt",
      "# shared with the main checkout\n\nvendor\n  bin  \nvendor\n",
    );
    const target = path.join(f.base, "wt-config");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "config",
      "--path",
      target,
      "--links-from",
      config,
      "--link",
      "extra",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(
      r.json.links.made.map((l: { path: string }) => l.path).sort(),
    ).toEqual(["bin", "extra", "vendor"]);
    expect(fs.lstatSync(path.join(target, "bin")).isSymbolicLink()).toBe(true);
  });

  it("refuses a config file inside the repository, an unreadable one, and an unusable entry", async () => {
    const f = makeFixture();
    const t = path.join(f.base, "wt-badlinks");
    write(f.repo, "links.txt", "vendor\n");
    const inside = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "x",
      "--path",
      t,
      "--links-from",
      path.join(f.repo, "links.txt"),
    ]);
    expect(inside.code).toBe(2);
    expect(inside.json.reason).toBe("links_file_inside_repo");

    const unreadable = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "x",
      "--path",
      t,
      "--links-from",
      path.join(f.base, "no-such-file"),
    ]);
    expect(unreadable.json.reason).toBe("links_file_unreadable");

    for (const bad of [
      "../escape",
      "/etc",
      ".git/hooks",
      "a/../../b",
      "$(id)",
    ]) {
      const r = await run(f.work, [
        "--repo",
        f.repo,
        "--branch",
        "x",
        "--path",
        t,
        "--link",
        bad,
      ]);
      expect(r.code, bad).toBe(2);
      expect(r.json.reason, bad).toBe("link_invalid");
    }
    expect(fs.existsSync(t)).toBe(false);
  });
});

describe("worktree create: setup and smoke", () => {
  it("runs setup in the new worktree, after the links exist", async () => {
    const f = makeFixture();
    write(f.repo, "vendor/lib.txt", "lib\n");
    const target = path.join(f.base, "wt-setup");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "setup",
      "--path",
      target,
      "--link",
      "vendor",
      "--setup",
      "test -L vendor && pwd -P > where.txt",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.status).toBe("ok");
    expect(r.json.setup).toMatchObject({ status: "ok", exitCode: 0 });
    expect(fs.readFileSync(path.join(target, "where.txt"), "utf8").trim()).toBe(
      target,
    );
    expect(r.json.smoke).toEqual({ status: "not_requested" });
  });

  it("reports a failing setup, skips the smoke run, and keeps the worktree", async () => {
    const f = makeFixture();
    const target = path.join(f.base, "wt-setup-fail");
    const r = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "setup-fail",
      "--path",
      target,
      "--setup",
      "echo broken >&2; exit 3",
      "--smoke",
      "echo should-not-run > smoke-ran.txt",
    ]);
    expect(r.code).toBe(1);
    expect(r.json.status).toBe("fail");
    expect(r.json.setup.status).toBe("failed");
    expect(r.json.setup.exitCode).toBe(3);
    expect(r.json.setup.reason).toContain("exited with code 3");
    expect(r.json.setup.outputTail).toContain("broken");
    expect(r.json.smoke.status).toBe("not_run");
    expect(fs.existsSync(path.join(target, "smoke-ran.txt"))).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("is ready when the smoke command exits 0 and not ready, with the reason, when it does not", async () => {
    const f = makeFixture();
    const ready = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "ready",
      "--path",
      path.join(f.base, "wt-ready"),
      "--smoke",
      "test -f a.txt",
    ]);
    expect(ready.code, ready.stdout).toBe(0);
    expect(ready.json.smoke.status).toBe("ready");

    const notReady = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "not-ready",
      "--path",
      path.join(f.base, "wt-not-ready"),
      "--smoke",
      "echo autoload missing; exit 1",
    ]);
    expect(notReady.code).toBe(1);
    expect(notReady.json.status).toBe("fail");
    expect(notReady.json.smoke.status).toBe("not_ready");
    expect(notReady.json.smoke.reason).toContain("exited with code 1");
    expect(notReady.json.smoke.outputTail).toContain("autoload missing");
    expect(fs.existsSync(path.join(f.base, "wt-not-ready"))).toBe(true);
  });

  it("lets --pass-regex overrule the exit code, as verify does", async () => {
    const f = makeFixture();
    const greenButNonZero = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "regex-ready",
      "--path",
      path.join(f.base, "wt-regex-ready"),
      "--smoke",
      "echo 'OK (3 tests)'; exit 1",
      "--pass-regex",
      "^OK \\(",
    ]);
    expect(greenButNonZero.code, greenButNonZero.stdout).toBe(0);
    expect(greenButNonZero.json.smoke.status).toBe("ready");
    expect(greenButNonZero.json.smoke.exitCode).toBe(1);
    expect(greenButNonZero.json.warnings.join("\n")).toContain(
      "non-zero exit code",
    );

    const zeroButNoMatch = await run(f.work, [
      "--repo",
      f.repo,
      "--branch",
      "regex-not-ready",
      "--path",
      path.join(f.base, "wt-regex-not-ready"),
      "--smoke",
      "echo nothing useful",
      "--pass-regex",
      "^OK \\(",
    ]);
    expect(zeroButNoMatch.code).toBe(1);
    expect(zeroButNoMatch.json.smoke.status).toBe("not_ready");
    expect(zeroButNoMatch.json.smoke.reason).toContain("did not match");
  });

  it("renders a readable summary with -f text", async () => {
    const f = makeFixture();
    const r = await spawnCli(
      [
        "-C",
        f.work,
        "-f",
        "text",
        "worktree",
        "create",
        "--repo",
        f.repo,
        "--branch",
        "texty",
        "--path",
        path.join(f.base, "wt-text"),
      ],
      { env: GIT_ENV },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status: ok");
    expect(r.stdout).toContain(`run-base[repo] = ${f.mainSha}`);
    expect(r.stdout).toContain("no upstream");
  });
});

function execResult(partial: Partial<ExecResult>): ExecResult {
  return {
    exitCode: 0,
    durationMs: 1,
    stdoutTail: "",
    stderrTail: "",
    logPath: "/log",
    timedOut: false,
    aborted: false,
    logWriteFailed: false,
    outputMayBeIncomplete: false,
    stdioClosed: true,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...partial,
  };
}

describe("smokeVerdict", () => {
  it("decides by exit code without a pattern", () => {
    expect(smokeVerdict(execResult({}), undefined).status).toBe("ready");
    expect(smokeVerdict(execResult({ exitCode: 1 }), undefined)).toMatchObject({
      status: "not_ready",
      reason: "the smoke command exited with code 1",
    });
    expect(smokeVerdict(execResult({ exitCode: 127 }), undefined).status).toBe(
      "not_ready",
    );
    expect(
      smokeVerdict(execResult({ exitCode: null, timedOut: true }), undefined)
        .reason,
    ).toContain("timed out");
    expect(
      smokeVerdict(execResult({ aborted: true, exitCode: null }), undefined)
        .status,
    ).toBe("not_ready");
  });

  it("decides by the pattern when one is given, except for a run that never concluded", () => {
    const re = /^OK/m;
    expect(
      smokeVerdict(execResult({ exitCode: 1, stdoutTail: "OK 1" }), re).status,
    ).toBe("ready");
    expect(
      smokeVerdict(execResult({ exitCode: 0, stdoutTail: "nope" }), re).status,
    ).toBe("not_ready");
    const concluded = smokeVerdict(
      execResult({ exitCode: 127, stdoutTail: "OK" }),
      re,
    );
    expect(concluded.status).toBe("not_ready");
    expect(concluded.warnings.join("\n")).toContain("never consulted");
  });
});

describe("worktree helpers", () => {
  it("normalizes link entries and refuses ones that leave the worktree", () => {
    expect(normalizeLinkEntry("./a//b/")).toEqual({ rel: "a/b" });
    expect(normalizeLinkEntry("vendor").rel).toBe("vendor");
    for (const bad of [
      "",
      ".",
      "..",
      "../x",
      "a/../../x",
      "/abs",
      ".git",
      ".GIT/x",
      "x`y`",
    ]) {
      expect(normalizeLinkEntry(bad).error, bad).toBeTypeOf("string");
    }
  });

  it("derives a path-safe directory name from a branch", () => {
    expect(branchSlug("feat/one")).toBe("feat-one");
    expect(branchSlug("b119/T02-worktree")).toBe("b119-T02-worktree");
    expect(branchSlug("..//")).toBe("worktree");
  });

  it("escapes gitignore syntax in an exclude pattern", () => {
    expect(excludePatternFor("vendor")).toBe("/vendor");
    expect(excludePatternFor("a*b[c]")).toBe("/a\\*b\\[c\\]");
    expect(excludePatternFor("#hash")).toBe("/\\#hash");
    expect(excludePatternFor("!bang")).toBe("/\\!bang");
  });

  it("parses git's porcelain worktree listing", () => {
    const parsed = parseWorktreeList(
      [
        "worktree /r",
        "HEAD aaaa",
        "branch refs/heads/main",
        "",
        "worktree /w",
        "HEAD bbbb",
        "detached",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ path: "/r", branch: "main" });
    expect(parsed[1]).toMatchObject({
      path: "/w",
      detached: true,
      prunable: true,
    });
  });
});
