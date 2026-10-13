import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitRunResult } from "../src/drift/git.js";

// `runGit` is the one place that runs git for the worktree commands. This
// file replaces it with a wrapper that can hand back what `spawnSync` returns
// for output past its limit, which no real git run produces on demand: git
// has exited with status 0, `error` is ENOBUFS, and `stdout` is cut short.
const cut = vi.hoisted(() => ({ on: false, failing: "", empty: "" }));

vi.mock("../src/drift/git.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/drift/git.js")>();
  return {
    ...real,
    runGit: (...args: Parameters<typeof real.runGit>): GitRunResult => {
      const result = real.runGit(...args);
      // One named git call that exits 0 and prints nothing.
      if (cut.empty !== "" && args[1].includes(cut.empty)) {
        return { ...result, stdout: "" };
      }
      // The same exit-0-with-error shape for one named git call.
      if (cut.failing !== "" && args[1].includes(cut.failing)) {
        return { ...result, error: "spawnSync git ETIMEDOUT" };
      }
      if (!cut.on || !args[1].includes("for-each-ref")) return result;
      // Only the first line is kept, so refs/remotes/zzz/self is lost.
      const kept = result.stdout.slice(0, result.stdout.indexOf("\n", 0) + 1);
      return {
        ...result,
        stdout: kept,
        error: "spawnSync git ENOBUFS",
      };
    },
  };
});

const { unpushedCommits } = await import("../src/worktree/git.js");

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
  cut.on = false;
  cut.failing = "";
  cut.empty = "";
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

/** A repository on `feat` with one commit that no remote has, and a
 * symbolic ref `refs/remotes/zzz/self` to `feat` that sorts after every
 * other remote-tracking ref. */
function makeRepo(): { repo: string; sha: string } {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-listing-")),
  );
  tmpDirs.push(base);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(base, ["init", "-q", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
  git(repo, ["checkout", "-q", "-b", "feat"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "work\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "unpushed"]);
  git(repo, ["symbolic-ref", "refs/remotes/zzz/self", "refs/heads/feat"]);
  return { repo, sha: git(repo, ["rev-parse", "HEAD"]).trim() };
}

describe("unpushedCommits: a ref listing that comes back cut short", () => {
  it("control: the whole listing excludes the symbolic ref and names the unpushed commit", () => {
    const { repo, sha } = makeRepo();
    const r = unpushedCommits(repo);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(sha);
  });

  it("fails on the error alone, though git exited with status 0 and the part it got has no symbolic ref", () => {
    const { repo } = makeRepo();
    cut.on = true;
    const r = unpushedCommits(repo);
    // The cut listing lacks refs/remotes/zzz/self, so a rev-list over it
    // would follow that ref to `feat` and report nothing unpushed.
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/ENOBUFS/);
    expect(r.stdout).not.toContain("zzz");
  });
});

describe("unpushedCommits: the lookups that come before the ref listing", () => {
  it("fails outside a repository with git's own status", () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-norepo-")),
    );
    tmpDirs.push(dir);
    const r = unpushedCommits(dir);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails on the error alone when naming the common directory, though git exited with status 0", () => {
    const { repo } = makeRepo();
    cut.failing = "--git-common-dir";
    const r = unpushedCommits(repo);
    expect(r.error).toMatch(/ETIMEDOUT/);
  });

  it("fails when git names no common directory, rather than reading the working directory", () => {
    const { repo } = makeRepo();
    cut.empty = "--git-common-dir";
    const r = unpushedCommits(repo);
    expect(r.error).toMatch(/did not name the common git directory/);
  });

  it("fails on the error alone when reading the ref storage, though git exited with status 0", () => {
    const { repo } = makeRepo();
    cut.failing = "extensions.refStorage";
    const r = unpushedCommits(repo);
    expect(r.error).toMatch(/ETIMEDOUT/);
  });
});
