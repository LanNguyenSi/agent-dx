import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { listWorktrees, type ListedWorktree } from "../src/worktree/list.js";
import { sweepWorktrees } from "../src/worktree/sweep.js";
import { FIXED_BIN_DIR } from "./helpers/spawn-cli.js";

/**
 * `worktree sweep` removes only what lies below `--root`, whatever the
 * listing hands it. A listing of `--root` cannot name an entry outside it
 * today (a symlinked child is not followed, see the sweep suite), so the
 * listing is wrapped here to hand the sweep such an entry, and the sweep's
 * own check is what must hold it back.
 */
const hooks = vi.hoisted(() => ({ inject: [] as ListedWorktree[] }));

vi.mock("../src/worktree/list.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/worktree/list.js")>();
  return {
    ...actual,
    listWorktrees: async (
      o: Parameters<typeof actual.listWorktrees>[0],
    ): ReturnType<typeof actual.listWorktrees> => {
      const r = await actual.listWorktrees(o);
      return { ...r, worktrees: [...r.worktrees, ...hooks.inject] };
    },
  };
});

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

vi.setConfig({ testTimeout: 60_000 });

// The sweep runs in this process: its git sees the fixed PATH and no
// global or system configuration, like a spawned CLI. In front of the
// fixed binaries sits a `gh` that reports a merged pull request into `main`
// at whatever commit the worktree it is asked in is at, so every entry is
// merged and only the sweep's own check can hold one back.
const saved: Record<string, string | undefined> = {};
let ghDir = "";
beforeAll(() => {
  ghDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-root-gh-")),
  );
  fs.writeFileSync(
    path.join(ghDir, "gh"),
    `#!/bin/sh\nprintf '[{"number":1,"headRefOid":"%s","baseRefName":"main"}]\\n' "$(git rev-parse HEAD)"\n`,
    { mode: 0o755 },
  );
  for (const [key, value] of Object.entries({
    ...GIT_ENV,
    PATH: `${ghDir}${path.delimiter}${FIXED_BIN_DIR}`,
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(ghDir, { recursive: true, force: true });
});

const tmpDirs: string[] = [];
afterEach(() => {
  hooks.inject.splice(0);
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: FIXED_BIN_DIR, ...GIT_ENV },
  });
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** A repository with a local bare origin and one worktree at `wtDir` on
 * branch `feat`, squash-merged on the server with its remote branch
 * deleted: merged by the pull request the `gh` stand-in reports, removable
 * by `remove`. */
function mergedWorktree(wtDir: (base: string) => string): {
  base: string;
  repo: string;
  wt: string;
} {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-root-")),
  );
  tmpDirs.push(base);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const other = path.join(base, "other");
  git(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git(base, ["init", "-q", "-b", "main", repo]);
  write(repo, "a.txt", "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
  const wt = wtDir(base);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, [
    "worktree",
    "add",
    "-q",
    "--no-track",
    "-b",
    "feat",
    wt,
    "origin/main",
  ]);
  write(wt, "feat.txt", "feat\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "feat"]);
  git(wt, ["push", "-q", "origin", "feat"]);
  git(base, ["clone", "-q", origin, other]);
  git(other, ["fetch", "-q", "origin", "feat"]);
  git(other, ["merge", "--squash", "origin/feat"]);
  git(other, ["commit", "-q", "-m", "squash feat"]);
  git(other, ["push", "-q", "origin", "main"]);
  git(other, ["push", "-q", "origin", "--delete", "feat"]);
  git(repo, ["fetch", "-q", "--prune", "origin"]);
  return { base, repo, wt };
}

/** The entry `list` reports for `wt`, merged by that pull request. */
async function describedEntry(
  repo: string,
  wt: string,
): Promise<ListedWorktree> {
  const listed = await listWorktrees({ cwd: repo, repo });
  const entry = listed.worktrees.find((w) => w.path === wt);
  expect(entry).toBeDefined();
  expect(entry?.merged).toMatchObject({ merged: "yes", via: "gh" });
  return entry as ListedWorktree;
}

describe("worktree sweep: an entry the listing hands it from outside --root", () => {
  it("skips a merged worktree whose real path is outside --root", async () => {
    const { base, repo, wt } = mergedWorktree((b) =>
      path.join(b, "elsewhere", "feat"),
    );
    const root = path.join(base, "root");
    fs.mkdirSync(root);
    hooks.inject.push(await describedEntry(repo, wt));

    const r = await sweepWorktrees({ cwd: base, root });
    expect(r.status).toBe("partial");
    const entry = r.entries.find((e) => e.path === wt);
    expect(entry).toMatchObject({ action: "skipped" });
    expect(entry?.reason).toContain("not below --root");
    expect(fs.existsSync(path.join(wt, "feat.txt"))).toBe(true);
    expect(git(repo, ["branch", "--list", "feat"]).trim()).toContain("feat");
  });

  it("skips a merged worktree that is --root itself", async () => {
    const { base, repo, wt } = mergedWorktree((b) => path.join(b, "root"));
    hooks.inject.push(await describedEntry(repo, wt));

    const r = await sweepWorktrees({ cwd: base, root: wt });
    expect(r.status).toBe("partial");
    const entry = r.entries.find((e) => e.path === wt);
    expect(entry).toMatchObject({ action: "skipped" });
    expect(entry?.reason).toContain("not below --root");
    expect(fs.existsSync(path.join(wt, "feat.txt"))).toBe(true);
    expect(git(repo, ["branch", "--list", "feat"]).trim()).toContain("feat");
  });

  it("still removes the same kind of entry below --root", async () => {
    const { base, repo, wt } = mergedWorktree((b) =>
      path.join(b, "root", "feat"),
    );
    const r = await sweepWorktrees({
      cwd: base,
      root: path.join(base, "root"),
    });
    expect(r.status).toBe("ok");
    expect(r.entries.find((e) => e.path === wt)).toMatchObject({
      action: "removed",
    });
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, ["branch", "--list", "feat"]).trim()).toBe("");
  });
});
