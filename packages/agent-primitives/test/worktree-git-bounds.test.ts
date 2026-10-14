import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncOptions,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { boundedCommand, boundedSpawnOptions } from "../src/bounded-spawn.js";
import { runGit, runGitBytes } from "../src/drift/git.js";
import { createWorktree } from "../src/worktree/create.js";
import {
  GIT_BOUND_ENV,
  GIT_BOUND_MS,
  GIT_WALK_BOUND_MS,
  WorktreeRefusal,
  effectiveBoundMs,
  git,
  gitFailure,
  isGitTimeout,
  mergeVerdict,
  runGh,
  unpushedCommits,
} from "../src/worktree/git.js";
import { removeWorktree } from "../src/worktree/remove.js";
import { buildSpawnEnv, CLI_PATH, FIXED_BIN_DIR } from "./helpers/spawn-cli.js";

/**
 * Every git call of `worktree create`, `remove` and `list` is bounded. A git
 * that does not finish is killed together with everything it started, and
 * the command ends in a refusal (or, where the command has already changed
 * something, in a result that says so); it never reads the silence as an
 * empty answer.
 *
 * The cases here put a `git` first on the PATH of the spawned CLI that hangs
 * on one named call (a `sleep` it leaves running in the background, holding
 * the CLI's pipes, like the hook or the ssh a real git would have started),
 * and shorten every bound to two seconds through the seam the CLI offers for
 * exactly this. Each case also checks that the hang happened (so a pattern
 * that matches nothing cannot pass) and that neither the wrapper nor its
 * `sleep` is left alive. Every process a case starts is bounded and killed as
 * a group, so a case that fails cannot leave a hung git behind.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

vi.setConfig({ testTimeout: 90_000, maxConcurrency: 10 });

/** The bound every CLI case runs with, in milliseconds. It applies to the
 * healthy calls the stand-in passes on as well, so it is far above what a
 * healthy git needs even on a loaded machine; the hung call is simply waited
 * out. */
const SHORT_BOUND_MS = 6000;
/** How long a hung stand-in stays asleep if nothing kills it. */
const HANG_SECONDS = 120;
/** How long a slow stand-in delays one call that must still finish. */
const SLOW_SECONDS = 2;
/** The most a spawned CLI may run in a case before it is killed. */
const CLI_LIMIT_MS = 60_000;

// Cases run concurrently, so nothing is cleaned up between them.
const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git2(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...GIT_ENV },
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

interface Fixture {
  base: string;
  origin: string;
  repo: string;
  work: string;
}

function makeFixture(): Fixture {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-wt-bounds-")),
  );
  tmpDirs.push(base);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  git2(base, ["init", "-q", "--bare", "-b", "main", origin]);
  git2(base, ["init", "-q", "-b", "main", repo]);
  write(repo, "a.txt", "one\n");
  write(repo, ".gitignore", ".ai/run\nnode_modules\n");
  git2(repo, ["add", "-A"]);
  git2(repo, ["commit", "-q", "-m", "init"]);
  git2(repo, ["remote", "add", "origin", origin]);
  git2(repo, ["push", "-q", "origin", "main"]);
  git2(repo, ["remote", "set-head", "origin", "main"]);
  return { base, origin, repo, work };
}

/** A worktree of the fixture on `branch`, made by git directly. With
 * `ahead`, one commit that no remote has. */
function addWorktree(f: Fixture, branch: string, ahead = false): string {
  const dir = path.join(f.base, `wt-${branch}`);
  git2(f.repo, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    branch,
    dir,
    "origin/main",
  ]);
  if (ahead) {
    write(dir, "ahead.txt", "ahead\n");
    git2(dir, ["add", "-A"]);
    git2(dir, ["commit", "-q", "-m", "ahead"]);
  }
  return dir;
}

function listed(repo: string): string[] {
  return git2(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function branchExists(repo: string, branch: string): boolean {
  return git2(repo, ["branch", "--list", branch]).trim().length > 0;
}

/** Where a call is made to hang. `match` is a piece of the command line the
 * git wrapper sees (every call starts `-c maintenance.auto=false -c
 * gc.auto=0 <subcommand> ...`); `exact` anchors it at the end of the line;
 * `nth` picks the nth call that matches. */
interface Hang {
  match: string;
  nth?: number;
  exact?: boolean;
  /** Instead of waiting for its `sleep`, the stand-in prints nothing and
   * exits 0 at once while the `sleep` keeps the inherited pipes: a git that
   * is done but not finished as far as the pipes go. */
  exitsZero?: boolean;
}

interface Hanging {
  /** The PATH to hand the CLI. */
  PATH: string;
  /** The pids the hung stand-in recorded: the wrapper and its sleep. */
  pids: () => number[];
  /** The command line of every call the stand-in saw, in order. */
  calls?: () => string[];
}

/** A fresh directory of its own, outside every fixture (a stand-in kept
 * inside would show up as a child of a `--root` listing). */
function scratchDir(label: string): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `agent-primitives-${label}-`)),
  );
  tmpDirs.push(dir);
  return dir;
}

/** A directory with a `git` that hangs on the call `hang` names (the wrapper
 * and a `sleep` it starts in the background, which holds the pipes it
 * inherited) and passes every other call on to the real git. */
function hangingGit(hang: Hang, hangSeconds = HANG_SECONDS): Hanging {
  const dir = scratchDir("hang-git");
  const pidFile = path.join(dir, "pids");
  const counter = path.join(dir, "count");
  const callLog = path.join(dir, "calls");
  const tail = hang.exact === true ? "" : "*";
  fs.writeFileSync(
    path.join(dir, "git"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${callLog}'`,
      `case " $* " in`,
      `  *"${hang.match}"${tail})`,
      `    n=0`,
      `    [ -f '${counter}' ] && read n < '${counter}'`,
      `    n=$((n + 1))`,
      `    echo "$n" > '${counter}'`,
      `    if [ "$n" -eq ${String(hang.nth ?? 1)} ]; then`,
      `      echo $$ >> '${pidFile}'`,
      `      /bin/sleep ${String(hangSeconds)} &`,
      `      echo $! >> '${pidFile}'`,
      hang.exitsZero === true ? `      exit 0` : `      wait`,
      `    fi`,
      `    ;;`,
      `esac`,
      `exec '${path.join(FIXED_BIN_DIR, "git")}' "$@"`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    PATH: `${dir}${path.delimiter}${FIXED_BIN_DIR}`,
    pids: () => {
      if (!fs.existsSync(pidFile)) return [];
      return fs
        .readFileSync(pidFile, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map(Number);
    },
    calls: () =>
      fs.existsSync(callLog)
        ? fs
            .readFileSync(callLog, "utf8")
            .split("\n")
            .filter((l) => l !== "")
        : [],
  };
}

/** A directory with a `gh` that hangs like `hangingGit`'s stand-in. */
function hangingGh(): Hanging {
  const dir = scratchDir("hang-gh");
  const pidFile = path.join(dir, "pids");
  fs.writeFileSync(
    path.join(dir, "gh"),
    [
      "#!/bin/sh",
      `echo $$ >> '${pidFile}'`,
      `/bin/sleep ${String(HANG_SECONDS)} &`,
      `echo $! >> '${pidFile}'`,
      `wait`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    PATH: `${dir}${path.delimiter}${FIXED_BIN_DIR}`,
    pids: () =>
      fs.existsSync(pidFile)
        ? fs
            .readFileSync(pidFile, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map(Number)
        : [],
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `pid` is gone (a killed orphan is reaped a moment later). */
async function gone(pid: number, withinMs = 5000): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

interface CliResult {
  code: number | null;
  json: Record<string, any>;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}

/** The built CLI in its own process group with a hard limit; the group is
 * killed at the limit. */
async function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  limitMs = CLI_LIMIT_MS,
): Promise<CliResult> {
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [CLI_PATH, "-C", cwd, "worktree", ...args],
    {
      env: buildSpawnEnv({ ...GIT_ENV, ...env }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    stdout += c;
  });
  child.stderr.on("data", (c: string) => {
    stderr += c;
  });
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, limitMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => {
        resolve(c);
      });
    });
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(stdout.trim()) as Record<string, any>;
    } catch {
      json = {};
    }
    return {
      code,
      json,
      stdout,
      stderr,
      elapsedMs: Date.now() - started,
      timedOut,
    };
  } finally {
    // The group is not killed again once the CLI has exited: a process a
    // bounded git left behind lives in that group only when the CLI failed
    // to kill it, and the case has to see that, not have it cleaned up.
    clearTimeout(timer);
  }
}

function boundEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { [GIT_BOUND_ENV]: String(SHORT_BOUND_MS), ...extra };
}

/** Expects every pid to be gone soon; one that is not is killed here (it
 * was alive a moment ago, so it is still ours) before the test fails. */
async function expectGone(pids: number[]): Promise<void> {
  const alive: number[] = [];
  for (const pid of pids) {
    if (!(await gone(pid))) alive.push(pid);
  }
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It ended by itself in the meantime.
    }
  }
  expect(alive, "processes that outlived the command").toEqual([]);
}

/** What every hung case shares: the command ended on its own (not by the
 * limit of the helper), well under the stand-in's sleep, the stand-in did
 * hang, and neither it nor the process it started is alive any more. */
async function expectKilled(r: CliResult, hung: Hanging): Promise<void> {
  const label = `${r.stdout}${r.stderr}`;
  const pids = hung.pids();
  try {
    expect(r.timedOut, label).toBe(false);
    expect(r.elapsedMs, label).toBeLessThan(HANG_SECONDS * 1000);
    expect(pids, `the call never hung: ${label}`).toHaveLength(2);
  } finally {
    await expectGone(pids).catch(() => undefined);
  }
  await expectGone(pids);
}

const TIMEOUT_TEXT = `did not finish within ${String(SHORT_BOUND_MS / 1000)} s and was stopped`;

// ---------------------------------------------------------------------------
// remove

interface RemoveRow {
  name: string;
  hang: Hang;
  /** The wrapper hangs a git call; this is how the command must end. */
  reason: string;
  flags?: string[];
  /** The branch carries a commit that is not merged. */
  ahead?: boolean;
  /** Extra text the message holds. */
  message?: string;
}

const REMOVE_FLAGS = ["--require-merged", "--delete-branch"];

const REMOVE_REFUSALS: RemoveRow[] = [
  {
    name: "resolveRepo: rev-parse --show-toplevel",
    hang: { match: "gc.auto=0 rev-parse --show-toplevel" },
    reason: "git_timeout",
  },
  {
    name: "resolveRepo: worktree list",
    hang: { match: "gc.auto=0 worktree list" },
    reason: "git_timeout",
  },
  {
    name: "resolveRepo: rev-parse --git-common-dir",
    hang: { match: "gc.auto=0 rev-parse --git-common-dir", nth: 1 },
    reason: "git_timeout",
  },
  {
    name: "dirty check: status",
    hang: { match: "gc.auto=0 status --porcelain" },
    reason: "status_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "dirty check: status exits 0 while a descendant holds the pipes",
    hang: { match: "gc.auto=0 status --porcelain", exitsZero: true },
    reason: "status_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "default base: symbolic-ref origin/HEAD",
    hang: { match: "gc.auto=0 symbolic-ref --quiet refs/remotes/origin/HEAD" },
    reason: "git_timeout",
  },
  {
    name: "default base: remote",
    hang: { match: "gc.auto=0 remote ", exact: true },
    reason: "git_timeout",
  },
  {
    name: "default base: check-ref-format",
    hang: { match: "gc.auto=0 check-ref-format" },
    reason: "git_timeout",
  },
  {
    name: "default base: symbolic-ref of the base itself",
    hang: { match: "gc.auto=0 symbolic-ref --quiet refs/remotes/origin/main" },
    reason: "git_timeout",
  },
  {
    name: "default base: show-ref",
    hang: { match: "gc.auto=0 show-ref --verify --quiet" },
    reason: "git_timeout",
  },
  {
    name: "default base: rev-parse of the base commit",
    hang: { match: "gc.auto=0 rev-parse --verify --quiet", nth: 1 },
    reason: "git_timeout",
  },
  {
    name: "default base: for-each-ref of its display name",
    hang: { match: "gc.auto=0 for-each-ref --format=%(refname:short)" },
    reason: "git_timeout",
  },
  {
    name: "merge verdict: merge-base",
    hang: { match: "gc.auto=0 merge-base --is-ancestor" },
    reason: "merge_state_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "merge verdict: rev-parse of the worktree HEAD",
    hang: { match: "gc.auto=0 rev-parse --verify --quiet HEAD^{commit}" },
    reason: "merge_state_unknown",
    message: TIMEOUT_TEXT,
    ahead: true,
  },
  {
    name: "unpushed check: rev-parse --git-common-dir",
    hang: { match: "gc.auto=0 rev-parse --git-common-dir", nth: 2 },
    reason: "unpushed_state_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "unpushed check: config of the common directory",
    hang: { match: "gc.auto=0 config --file -" },
    reason: "unpushed_state_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "unpushed check: rev-parse --show-ref-format",
    hang: { match: "gc.auto=0 rev-parse --show-ref-format" },
    reason: "unpushed_state_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "unpushed check: for-each-ref of the remote-tracking refs",
    hang: { match: "gc.auto=0 for-each-ref --format=%(refname)%09%(symref)" },
    reason: "unpushed_state_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "unpushed check: rev-list",
    hang: { match: "gc.auto=0 rev-list HEAD --not" },
    reason: "unpushed_state_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "unpushed check: rev-list exits 0 while a descendant holds the pipes",
    hang: { match: "gc.auto=0 rev-list HEAD --not", exitsZero: true },
    reason: "unpushed_state_unknown",
    message: TIMEOUT_TEXT,
  },
  {
    name: "ignored links: ls-files",
    hang: { match: "gc.auto=0 ls-files" },
    reason: "git_timeout",
  },
  {
    name: "git worktree remove",
    hang: { match: "gc.auto=0 worktree remove" },
    reason: "worktree_remove_failed",
    message: "partly removed",
  },
  {
    name: "--base: remote",
    hang: { match: "gc.auto=0 remote ", exact: true, nth: 1 },
    reason: "git_timeout",
    flags: ["--require-merged", "--base", "origin/main"],
  },
];

describe("worktree remove: a git call that does not finish ends in a refusal", () => {
  it.concurrent.each(REMOVE_REFUSALS.map((row) => [row.name, row] as const))(
    "%s",
    async (_name, { hang, reason, flags, ahead, message }) => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat", ahead === true);
      const sha = git2(wt, ["rev-parse", "HEAD"]).trim();
      const hung = hangingGit(hang);
      const r = await runCli(
        f.work,
        ["remove", wt, ...(flags ?? REMOVE_FLAGS)],
        {
          ...boundEnv(),
          PATH: hung.PATH,
        },
      );
      await expectKilled(r, hung);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.status).toBe("usage_error");
      expect(r.json.reason, r.stdout).toBe(reason);
      expect(r.json.message, r.stdout).toContain(message ?? TIMEOUT_TEXT);
      if (reason === "worktree_remove_failed") {
        // The stand-in hung before git ran: the worktree is as it was.
        expect(listed(f.repo)).toContain(wt);
      } else {
        // Nothing was changed: the worktree and its branch are still there.
        expect(listed(f.repo)).toContain(wt);
        expect(git2(f.repo, ["rev-parse", "refs/heads/feat"]).trim()).toBe(sha);
      }
    },
  );

  it.concurrent(
    "a gh lookup that does not finish leaves the verdict unknown",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat", true);
      const hung = hangingGh();
      const r = await runCli(f.work, ["remove", wt, ...REMOVE_FLAGS], {
        ...boundEnv(),
        PATH: hung.PATH,
      });
      await expectKilled(r, hung);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason, r.stdout).toBe("merge_state_unknown");
      expect(r.json.message).toContain(
        `gh pr list did not finish within ${String(SHORT_BOUND_MS / 1000)} s`,
      );
      expect(listed(f.repo)).toContain(wt);
    },
  );

  it.concurrent(
    "a gh that is not installed leaves the verdict unknown and says why",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat", true);
      // The fixed PATH of a spawned CLI holds git but no gh.
      const r = await runCli(f.work, ["remove", wt, "--require-merged"], {
        ...boundEnv(),
      });
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason, r.stdout).toBe("merge_state_unknown");
      expect(r.json.message).toContain("gh is not available");
      expect(listed(f.repo)).toContain(wt);
    },
  );

  it.concurrent(
    "a status that does not finish is overridden by --force like any unknown state",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat");
      const hung = hangingGit({ match: "gc.auto=0 status --porcelain" });
      const r = await runCli(f.work, ["remove", wt, "--force"], {
        ...boundEnv(),
        PATH: hung.PATH,
      });
      await expectKilled(r, hung);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(listed(f.repo)).not.toContain(wt);
    },
  );

  it.concurrent(
    "--force does not override a default base that cannot be read in time",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat");
      const hung = hangingGit({
        match: "gc.auto=0 for-each-ref --format=%(refname:short)",
      });
      const r = await runCli(f.work, ["remove", wt, "--force"], {
        ...boundEnv(),
        PATH: hung.PATH,
      });
      await expectKilled(r, hung);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.json.reason).toBe("git_timeout");
      expect(listed(f.repo)).toContain(wt);
    },
  );

  it.concurrent(
    "a prune that does not finish is a warning after the removal",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat");
      const hung = hangingGit({ match: "gc.auto=0 worktree prune" });
      const r = await runCli(f.work, ["remove", wt, ...REMOVE_FLAGS], {
        ...boundEnv(),
        PATH: hung.PATH,
      });
      await expectKilled(r, hung);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.pruned).toBe(false);
      expect(r.json.warnings.join("\n")).toContain(TIMEOUT_TEXT);
      expect(listed(f.repo)).not.toContain(wt);
    },
  );

  it.concurrent(
    "a branch deletion that does not finish is reported, not assumed",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat");
      const hung = hangingGit({ match: "gc.auto=0 branch -D" });
      const r = await runCli(f.work, ["remove", wt, ...REMOVE_FLAGS], {
        ...boundEnv(),
        PATH: hung.PATH,
      });
      await expectKilled(r, hung);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.branch.deleted).toBe(false);
      expect(r.json.branch.reason).toContain(TIMEOUT_TEXT);
      expect(branchExists(f.repo, "feat")).toBe(true);
    },
  );

  it.concurrent(
    "a merge check that does not finish does not stop --delete-branch from reporting it",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat");
      const hung = hangingGit({ match: "gc.auto=0 merge-base --is-ancestor" });
      const r = await runCli(f.work, ["remove", wt, "--delete-branch"], {
        ...boundEnv(),
        PATH: hung.PATH,
      });
      await expectKilled(r, hung);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json.merged.merged).toBe("unknown");
      expect(r.json.merged.reason).toContain(TIMEOUT_TEXT);
      expect(r.json.warnings.join("\n")).toContain("is unknown");
    },
  );

  it.concurrent("a slow but finishing git is not refused", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "feat");
    // One second on the status, under the 2 s bound.
    const slow = hangingGit(
      { match: "gc.auto=0 status --porcelain" },
      SLOW_SECONDS,
    );
    const r = await runCli(f.work, ["remove", wt, ...REMOVE_FLAGS], {
      ...boundEnv(),
      PATH: slow.PATH,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(listed(f.repo)).not.toContain(wt);
  });
});

// ---------------------------------------------------------------------------
// create

interface CreateRow {
  name: string;
  hang: Hang;
  /** `refuse`: nothing is created. `degrade`: the worktree exists and the
   * command reports the call it could not finish. */
  outcome: "refuse" | "degrade";
  reason?: string;
  message?: string;
  flags?: string[];
}

function createArgs(f: Fixture, target: string, run: string): string[] {
  return [
    "create",
    "--repo",
    f.repo,
    "--branch",
    "b-new",
    "--path",
    target,
    "--run",
    run,
    "--link",
    "node_modules",
  ];
}

const CREATE_ROWS: CreateRow[] = [
  {
    name: "resolveRepo: rev-parse --show-toplevel",
    hang: { match: "gc.auto=0 rev-parse --show-toplevel" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "resolveRepo: worktree list",
    hang: { match: "gc.auto=0 worktree list" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "resolveRepo: rev-parse --git-common-dir",
    hang: { match: "gc.auto=0 rev-parse --git-common-dir" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "branch name: check-ref-format --branch",
    hang: { match: "gc.auto=0 check-ref-format --branch" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "branch exists: show-ref",
    hang: { match: "gc.auto=0 show-ref --verify --quiet refs/heads/b-new" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "fetch: remote get-url origin",
    hang: { match: "gc.auto=0 remote get-url origin" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "fetch: git fetch origin",
    hang: { match: "gc.auto=0 fetch " },
    outcome: "refuse",
    reason: "fetch_failed",
    message: TIMEOUT_TEXT,
  },
  {
    name: "default base: symbolic-ref origin/HEAD",
    hang: { match: "gc.auto=0 symbolic-ref --quiet refs/remotes/origin/HEAD" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "default base: for-each-ref of its display name",
    hang: { match: "gc.auto=0 for-each-ref --format=%(refname:short)" },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "default base: the sha of the base",
    hang: { match: "gc.auto=0 rev-parse --verify --quiet", nth: 2 },
    outcome: "refuse",
    reason: "git_timeout",
  },
  {
    name: "--base: rev-parse of the commit",
    hang: { match: "gc.auto=0 rev-parse --verify --quiet" },
    outcome: "refuse",
    reason: "git_timeout",
    flags: ["--base", "origin/main", "--no-fetch"],
  },
  {
    name: "git worktree add",
    hang: { match: "gc.auto=0 worktree add" },
    outcome: "refuse",
    reason: "worktree_add_failed",
    message: "stopped part way",
  },
  {
    name: "after the add: rev-parse HEAD",
    hang: { match: "gc.auto=0 rev-parse HEAD" },
    outcome: "degrade",
    message: "could not read HEAD of the new worktree",
  },
  {
    name: "after the add: the upstream of the branch",
    hang: { match: "gc.auto=0 rev-parse --abbrev-ref" },
    outcome: "degrade",
    message: "could not tell whether branch b-new tracks an upstream",
  },
  {
    name: "after the add: check-ignore of the run pointer",
    hang: { match: "gc.auto=0 check-ignore", nth: 1 },
    outcome: "degrade",
    message: "git could not tell whether .ai/run is ignored",
  },
  {
    name: "after the add: check-ignore of a link",
    hang: { match: "gc.auto=0 check-ignore", nth: 2 },
    outcome: "degrade",
  },
  {
    name: "after the add: the git directory for the link manifest",
    hang: { match: "gc.auto=0 rev-parse --absolute-git-dir" },
    outcome: "degrade",
    message: "did not report the git directory in time",
  },
];

describe("worktree create: a git call that does not finish ends in a refusal or a warning", () => {
  it.concurrent.each(CREATE_ROWS.map((row) => [row.name, row] as const))(
    "%s",
    async (_name, { hang, outcome, reason, message, flags }) => {
      const f = makeFixture();
      fs.mkdirSync(path.join(f.repo, "node_modules", "pkg"), {
        recursive: true,
      });
      write(f.repo, "node_modules/pkg/x.txt", "x");
      const run = path.join(f.base, "run");
      fs.mkdirSync(run);
      const target = path.join(f.base, "wt-new");
      const hung = hangingGit(hang);
      const r = await runCli(
        f.work,
        [...createArgs(f, target, run), ...(flags ?? [])],
        { ...boundEnv(), PATH: hung.PATH },
      );
      await expectKilled(r, hung);
      if (outcome === "refuse") {
        expect(r.code, r.stdout + r.stderr).toBe(2);
        expect(r.json.reason, r.stdout).toBe(reason);
        expect(r.json.message, r.stdout).toContain(message ?? TIMEOUT_TEXT);
        // Nothing was created.
        expect(fs.existsSync(target)).toBe(false);
        expect(git2(f.repo, ["branch", "--list", "b-new"]).trim()).toBe("");
        expect(listed(f.repo)).not.toContain(target);
      } else {
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(fs.existsSync(target)).toBe(true);
        expect(listed(f.repo)).toContain(target);
        if (message !== undefined) {
          expect(JSON.stringify(r.json), r.stdout).toContain(message);
        }
      }
    },
  );

  it.concurrent("a slow but finishing fetch is not refused", async () => {
    const f = makeFixture();
    const target = path.join(f.base, "wt-new");
    const slow = hangingGit({ match: "gc.auto=0 fetch " }, SLOW_SECONDS);
    const r = await runCli(
      f.work,
      ["create", "--repo", f.repo, "--branch", "b-new", "--path", target],
      { ...boundEnv(), PATH: slow.PATH },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list

interface ListRow {
  name: string;
  hang: Hang;
  /** `refuse` ends the command; `unknown` reports the merge state as it is. */
  outcome: "refuse" | "unknown";
  args?: string[];
}

const LIST_ROWS: ListRow[] = [
  {
    name: "resolveRepo: rev-parse --show-toplevel",
    hang: { match: "gc.auto=0 rev-parse --show-toplevel" },
    outcome: "refuse",
  },
  {
    name: "resolveRepo: worktree list",
    hang: { match: "gc.auto=0 worktree list" },
    outcome: "refuse",
  },
  {
    name: "resolveRepo: rev-parse --git-common-dir",
    hang: { match: "gc.auto=0 rev-parse --git-common-dir" },
    outcome: "refuse",
  },
  {
    name: "default base: symbolic-ref origin/HEAD",
    hang: { match: "gc.auto=0 symbolic-ref --quiet refs/remotes/origin/HEAD" },
    outcome: "refuse",
  },
  {
    name: "default base: for-each-ref of its display name",
    hang: { match: "gc.auto=0 for-each-ref --format=%(refname:short)" },
    outcome: "refuse",
  },
  {
    name: "--base: remote",
    hang: { match: "gc.auto=0 remote ", exact: true },
    outcome: "refuse",
    args: ["--base", "origin/main"],
  },
  {
    name: "status of a worktree",
    hang: { match: "gc.auto=0 status --porcelain" },
    outcome: "refuse",
  },
  {
    name: "ahead and behind: rev-list --left-right",
    hang: { match: "gc.auto=0 rev-list --left-right" },
    outcome: "refuse",
  },
  {
    name: "ignored links: ls-files",
    hang: { match: "gc.auto=0 ls-files" },
    outcome: "refuse",
  },
  {
    name: "merge verdict: merge-base",
    hang: { match: "gc.auto=0 merge-base --is-ancestor" },
    outcome: "unknown",
  },
  {
    name: "--root: rev-parse --show-toplevel of a child",
    hang: { match: "gc.auto=0 rev-parse --show-toplevel", nth: 2 },
    outcome: "refuse",
    args: ["--root"],
  },
  {
    name: "--root: worktree list of a child (not a skipped child)",
    hang: { match: "gc.auto=0 worktree list" },
    outcome: "refuse",
    args: ["--root"],
  },
];

describe("worktree list: a git call that does not finish ends the report", () => {
  it.concurrent.each(LIST_ROWS.map((row) => [row.name, row] as const))(
    "%s",
    async (_name, { hang, outcome, args }) => {
      const f = makeFixture();
      addWorktree(f, "feat", true);
      const hung = hangingGit(hang);
      const argv =
        args?.[0] === "--root"
          ? ["list", "--root", f.base]
          : ["list", "--repo", f.repo, ...(args ?? [])];
      const r = await runCli(f.work, argv, { ...boundEnv(), PATH: hung.PATH });
      await expectKilled(r, hung);
      if (outcome === "refuse") {
        expect(r.code, r.stdout + r.stderr).toBe(2);
        expect(r.json.reason, r.stdout).toBe("git_timeout");
        expect(r.json.message, r.stdout).toContain(TIMEOUT_TEXT);
        // No partial report: nothing about a listing that is not complete.
        expect(r.json.worktrees).toBeUndefined();
      } else {
        expect(r.code, r.stdout + r.stderr).toBe(0);
        // The main checkout comes first, and is the entry whose verdict hung.
        const main = (r.json.worktrees as Record<string, any>[])[0]!;
        expect(main.main, r.stdout).toBe(true);
        expect(main.merged.merged, r.stdout).toBe("unknown");
        expect(main.merged.reason).toContain(TIMEOUT_TEXT);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// the CLI is signalled while git hangs

interface LiveCli {
  child: ReturnType<typeof spawn>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** The built CLI in a process group of its own, left running so that a case
 * can signal it. The group is killed by the case's `finally`. */
function startCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): LiveCli {
  const child = spawn(
    process.execPath,
    [CLI_PATH, "-C", cwd, "worktree", ...args],
    {
      env: buildSpawnEnv({ ...GIT_ENV, ...env }),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    },
  );
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, closed };
}

/** Waits until the stand-in has hung (it recorded its two pids). */
async function untilHung(hung: Hanging, withinMs = 30_000): Promise<number[]> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    const pids = hung.pids();
    if (pids.length === 2) return pids;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the git call never hung");
}

function killGroup(live: LiveCli, signal: NodeJS.Signals): void {
  try {
    if (live.child.pid !== undefined) process.kill(-live.child.pid, signal);
  } catch {
    // Already gone.
  }
}

describe("a CLI that is signalled while its git hangs", () => {
  // git runs in a group of its own, so a signal to the CLI's group never
  // reaches it. A watcher in git's group ends it once the CLI is gone: the
  // watcher reads a pipe the CLI holds, which the kernel closes when the CLI
  // dies.
  it.each(["SIGKILL", "SIGHUP"] as const)(
    "%s of the CLI's group does not leave git behind",
    async (signal) => {
      const f = makeFixture();
      const hung = hangingGit({ match: "gc.auto=0 worktree list" });
      // The real bounds: the bound does not end the hang here.
      const live = startCli(f.work, ["list", "--repo", f.repo], {
        PATH: hung.PATH,
      });
      let pids: number[] = [];
      try {
        pids = await untilHung(hung);
        expect(isAlive(live.child.pid ?? 0)).toBe(true);
        killGroup(live, signal);
        const ended = await live.closed;
        expect(ended.code === null ? ended.signal : ended.code).not.toBeNull();
        // The stand-in is in the group of its own: still there right now,
        // gone as soon as the watcher sees the pipe close.
        await expectGone(pids);
      } finally {
        killGroup(live, "SIGKILL");
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Gone.
          }
        }
      }
    },
  );

  it("SIGTERM waits for the call to end, here at its bound, and leaves nothing", async () => {
    const f = makeFixture();
    const hung = hangingGit({ match: "gc.auto=0 worktree list" });
    const live = startCli(f.work, ["list", "--repo", f.repo], {
      ...boundEnv(),
      PATH: hung.PATH,
    });
    let pids: number[] = [];
    try {
      pids = await untilHung(hung);
      killGroup(live, "SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      // The handler cannot run while the CLI waits for git, and git does not
      // see the signal: both are still there a second later.
      expect(live.child.exitCode).toBeNull();
      expect(pids.every(isAlive)).toBe(true);
      await live.closed;
      await expectGone(pids);
    } finally {
      killGroup(live, "SIGKILL");
    }
  });
});

/** The state `ps` reports for `pid` (`Z` for a zombie), or `undefined`
 * when there is no such process. */
function processState(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

describe("a CLI that is killed and never reaped while its git hangs", () => {
  it("does not leave git behind", async () => {
    const f = makeFixture();
    const hung = hangingGit({ match: "gc.auto=0 worktree list" });
    const pidFile = path.join(scratchDir("cli-pid"), "pid");
    // The intermediary starts the CLI in the background, notes its pid and
    // becomes a sleep that never waits for it: once killed, the CLI stays a
    // zombie, so whatever asks whether its pid exists is told yes until the
    // sleep ends (a container whose first process does not reap, a parent
    // that never waits).
    const parent = spawn(
      "/bin/sh",
      [
        "-c",
        '"$@" & echo $! > "$CLI_PID_FILE"; exec /bin/sleep 60',
        "sh",
        process.execPath,
        CLI_PATH,
        "-C",
        f.work,
        "worktree",
        "list",
        "--repo",
        f.repo,
      ],
      {
        env: buildSpawnEnv({
          ...GIT_ENV,
          PATH: hung.PATH,
          CLI_PID_FILE: pidFile,
        }),
        stdio: "ignore",
        detached: true,
      },
    );
    let pids: number[] = [];
    try {
      pids = await untilHung(hung);
      const cli = Number(fs.readFileSync(pidFile, "utf8").trim());
      process.kill(cli, "SIGKILL");
      const until = Date.now() + 5000;
      while (processState(cli)?.startsWith("Z") !== true) {
        if (Date.now() > until) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(processState(cli), "the CLI is a zombie").toMatch(/^Z/);
      await expectGone(pids);
    } finally {
      try {
        if (parent.pid !== undefined) process.kill(-parent.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone.
        }
      }
    }
  });
});

/** The exit code of a CLI that a signal stopped before its first change. */
const SIGNAL_CODE = { SIGINT: 130, SIGTERM: 143 } as const;

describe("a SIGINT or SIGTERM before the first change", () => {
  // git calls are synchronous, so the CLI's handler cannot run while one
  // does; the commands give it its turn before the first change. A slow but
  // finishing git keeps the signal pending until then.
  it.each(["SIGINT", "SIGTERM"] as const)(
    "remove: %s while the status runs removes nothing",
    async (signal) => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat");
      // An ignored dependency link: unlinking it is the first change.
      const link = path.join(wt, "node_modules");
      fs.symlinkSync(path.join(f.repo, "a.txt"), link);
      const slow = hangingGit(
        { match: "gc.auto=0 status --porcelain" },
        SLOW_SECONDS,
      );
      const live = startCli(f.work, ["remove", wt, ...REMOVE_FLAGS], {
        ...boundEnv(),
        PATH: slow.PATH,
      });
      let pids: number[] = [];
      try {
        pids = await untilHung(slow);
        killGroup(live, signal);
        const ended = await live.closed;
        expect(ended.code).toBe(SIGNAL_CODE[signal]);
        expect(listed(f.repo)).toContain(wt);
        expect(branchExists(f.repo, "feat")).toBe(true);
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        const writes = slow.calls!().filter((c) =>
          / (worktree remove|worktree prune|branch -D) /.test(` ${c} `),
        );
        expect(writes).toEqual([]);
        await expectGone(pids);
      } finally {
        killGroup(live, "SIGKILL");
      }
    },
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "create: %s while the fetch runs creates nothing",
    async (signal) => {
      const f = makeFixture();
      const target = path.join(f.base, "wt-new");
      const slow = hangingGit({ match: "gc.auto=0 fetch " }, SLOW_SECONDS);
      const live = startCli(
        f.work,
        ["create", "--repo", f.repo, "--branch", "b-new", "--path", target],
        { ...boundEnv(), PATH: slow.PATH },
      );
      let pids: number[] = [];
      try {
        pids = await untilHung(slow);
        killGroup(live, signal);
        const ended = await live.closed;
        expect(ended.code).toBe(SIGNAL_CODE[signal]);
        expect(fs.existsSync(target)).toBe(false);
        expect(branchExists(f.repo, "b-new")).toBe(false);
        expect(slow.calls!().filter((c) => c.includes("worktree add"))).toEqual(
          [],
        );
        await expectGone(pids);
      } finally {
        killGroup(live, "SIGKILL");
      }
    },
  );

  it("create: a SIGTERM while a check before the fetch runs stops it before the fetch", async () => {
    const f = makeFixture();
    const target = path.join(f.base, "wt-new");
    const slow = hangingGit(
      { match: "gc.auto=0 show-ref --verify --quiet refs/heads/b-new" },
      SLOW_SECONDS,
    );
    const live = startCli(
      f.work,
      ["create", "--repo", f.repo, "--branch", "b-new", "--path", target],
      { ...boundEnv(), PATH: slow.PATH },
    );
    let pids: number[] = [];
    try {
      pids = await untilHung(slow);
      killGroup(live, "SIGTERM");
      const ended = await live.closed;
      expect(ended.code).toBe(143);
      expect(fs.existsSync(target)).toBe(false);
      expect(slow.calls!().filter((c) => / fetch /.test(` ${c} `))).toEqual([]);
      await expectGone(pids);
    } finally {
      killGroup(live, "SIGKILL");
    }
  });
});

describe("removeWorktree and createWorktree called with an aborted signal", () => {
  async function withGitEnv<T>(fn: () => Promise<T>): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(GIT_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("refuse with interrupted and change nothing", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "feat");
    const link = path.join(wt, "node_modules");
    fs.symlinkSync(path.join(f.repo, "a.txt"), link);
    const aborted = AbortSignal.abort();
    const removed = await withGitEnv(() =>
      removeWorktree({ cwd: f.work, path: wt, signal: aborted }).then(
        () => undefined,
        (err: unknown) => err,
      ),
    );
    expect(removed).toBeInstanceOf(WorktreeRefusal);
    expect((removed as WorktreeRefusal).reason).toBe("interrupted");
    expect((removed as WorktreeRefusal).message).toContain(
      "nothing was removed",
    );
    expect(listed(f.repo)).toContain(wt);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

    const target = path.join(f.base, "wt-new");
    const created = await withGitEnv(() =>
      createWorktree({
        cwd: f.work,
        repo: f.repo,
        branch: "b-new",
        path: target,
        fetch: false,
        logDir: scratchDir("create-log"),
        signal: aborted,
      }).then(
        () => undefined,
        (err: unknown) => err,
      ),
    );
    expect(created).toBeInstanceOf(WorktreeRefusal);
    expect((created as WorktreeRefusal).reason).toBe("interrupted");
    expect(fs.existsSync(target)).toBe(false);
    expect(branchExists(f.repo, "b-new")).toBe(false);

    // The control: a signal that is not aborted changes nothing about the
    // commands.
    const live = new AbortController().signal;
    const done = await withGitEnv(() =>
      removeWorktree({ cwd: f.work, path: wt, signal: live }),
    );
    expect(done.status).toBe("ok");
    expect(listed(f.repo)).not.toContain(wt);
  });
});

// ---------------------------------------------------------------------------
// a fifo among the refs

/** Whether this host can create a fifo. */
function canMkfifo(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-fifo-"));
  try {
    execFileSync("mkfifo", [path.join(dir, "f")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("worktree remove: a fifo among the refs", () => {
  // Not gated on the git version: a git that skips the fifo reaches the
  // inspection of the ref store and refuses there, a git that blocks on it
  // (2.39 does in for-each-ref and rev-list) is stopped at the bound and
  // refuses as a timeout. Either way the worktree and its branch stay.
  it.skipIf(!canMkfifo())(
    "refuses within the bound whether or not git blocks on it",
    async () => {
      const f = makeFixture();
      const wt = addWorktree(f, "feat", true);
      const sha = git2(wt, ["rev-parse", "HEAD"]).trim();
      const common = path.resolve(
        f.repo,
        git2(f.repo, ["rev-parse", "--git-common-dir"]).trim(),
      );
      execFileSync("mkfifo", [path.join(common, "refs/remotes/origin/pipe")]);
      const r = await runCli(
        f.work,
        ["remove", wt, "--delete-branch"],
        boundEnv({ [GIT_BOUND_ENV]: "8000" }),
        30_000,
      );
      expect(r.timedOut, r.stdout + r.stderr).toBe(false);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(["unpushed_state_unknown", "git_timeout"]).toContain(
        r.json.reason,
      );
      expect(listed(f.repo)).toContain(wt);
      expect(git2(f.repo, ["rev-parse", "refs/heads/feat"]).trim()).toBe(sha);
    },
  );
});

// ---------------------------------------------------------------------------
// the bound itself

describe("the bound", () => {
  it("is generous by default and written down", () => {
    expect(GIT_BOUND_MS).toBe(300_000);
    expect(GIT_WALK_BOUND_MS).toBe(1_800_000);
  });

  it("the test seam can only shorten a bound", () => {
    const saved = process.env[GIT_BOUND_ENV];
    try {
      delete process.env[GIT_BOUND_ENV];
      expect(effectiveBoundMs(300_000)).toBe(300_000);
      process.env[GIT_BOUND_ENV] = "1500";
      expect(effectiveBoundMs(300_000)).toBe(1500);
      for (const lengthening of ["300000", "900000", "99999999999999999999"]) {
        process.env[GIT_BOUND_ENV] = lengthening;
        expect(effectiveBoundMs(300_000), lengthening).toBe(300_000);
      }
      for (const junk of ["0", "-5", "abc", "1e3", "1.5", " 5", "5 ", ""]) {
        process.env[GIT_BOUND_ENV] = junk;
        expect(effectiveBoundMs(300_000), JSON.stringify(junk)).toBe(300_000);
      }
    } finally {
      if (saved === undefined) delete process.env[GIT_BOUND_ENV];
      else process.env[GIT_BOUND_ENV] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// the runner, in process

/** A directory with a `git` that starts a background `sleep` (holding the
 * pipes it inherited) and waits for it; it records both pids. */
function sleepingGitDir(exitsZero = false): {
  dir: string;
  pids: () => number[];
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-slow-"));
  tmpDirs.push(dir);
  const pidFile = path.join(dir, "pids");
  fs.writeFileSync(
    path.join(dir, "git"),
    [
      "#!/bin/sh",
      `echo $$ >> '${pidFile}'`,
      `/bin/sleep ${String(HANG_SECONDS)} &`,
      `echo $! >> '${pidFile}'`,
      exitsZero ? `exit 0` : `wait`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    dir,
    pids: () =>
      fs.existsSync(pidFile)
        ? fs
            .readFileSync(pidFile, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map(Number)
        : [],
  };
}

describe("the bounded git runner", () => {
  it("kills the whole process group at the bound and says so", async () => {
    const slow = sleepingGitDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-cwd-"));
    tmpDirs.push(cwd);
    const started = Date.now();
    const r = runGit(cwd, ["status"], { PATH: slow.dir }, 700);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull();
    expect(r.error).toBeDefined();
    expect(slow.pids()).toHaveLength(2);
    await expectGone(slow.pids());
  });

  it("does the same for the variant that keeps the bytes", async () => {
    const slow = sleepingGitDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-cwd-"));
    tmpDirs.push(cwd);
    const r = runGitBytes(
      cwd,
      ["config", "--file", "-"],
      { PATH: slow.dir },
      Buffer.from("[a]\n"),
      700,
    );
    expect(r.timedOut).toBe(true);
    expect(r.status).toBeNull();
    expect(slow.pids()).toHaveLength(2);
    await expectGone(slow.pids());
  });

  it("kills the group of a git that exited 0 while a descendant holds the pipes", async () => {
    const slow = sleepingGitDir(true);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-cwd-"));
    tmpDirs.push(cwd);
    const r = runGit(cwd, ["status"], { PATH: slow.dir }, 700);
    // The shell the trampoline runs git in has exited 0 by the time the
    // bound passes: no signal, a status of 0, and still a timeout.
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(0);
    expect(r.error).toBeDefined();
    expect(slow.pids()).toHaveLength(2);
    await expectGone(slow.pids());
  });

  it("does the same for the bytes variant", async () => {
    const slow = sleepingGitDir(true);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-cwd-"));
    tmpDirs.push(cwd);
    const r = runGitBytes(
      cwd,
      ["config", "--file", "-"],
      { PATH: slow.dir },
      Buffer.from("[a]\n"),
      700,
    );
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(0);
    expect(slow.pids()).toHaveLength(2);
    await expectGone(slow.pids());
  });

  it("passes git's exit status, stdout and stdin through the trampoline", () => {
    const f = makeFixture();
    const env = { PATH: process.env.PATH, ...GIT_ENV };
    const ok = runGit(
      f.repo,
      ["rev-parse", "--is-inside-work-tree"],
      env,
      30_000,
    );
    expect(ok).toMatchObject({ status: 0, stdout: "true\n" });
    expect(ok.timedOut).toBeUndefined();
    const failed = runGit(
      f.repo,
      ["rev-parse", "--verify", "nope"],
      env,
      30_000,
    );
    expect(failed.status).toBe(128);
    expect(failed.stderr).toContain("fatal");
    // `git config --file -` reads its stdin: the bytes come through, a NUL
    // included, and the exit status is git's own.
    const config = runGitBytes(
      f.repo,
      ["config", "--file", "-", "--null", "--get-all", "a.b"],
      env,
      Buffer.from("[a]\n\tb = one\n\tb = two\n"),
      30_000,
    );
    expect(config.status).toBe(0);
    expect(config.stdout.toString("utf8")).toBe("one\0two\0");
    const none = runGitBytes(
      f.repo,
      ["config", "--file", "-", "--get-all", "a.c"],
      env,
      Buffer.from("[a]\n\tb = one\n"),
      30_000,
    );
    expect(none.status).toBe(1);
  });

  it("leaves a run without a bound as it was", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-cwd-"));
    tmpDirs.push(cwd);
    execFileSync("git", ["init", "-q", cwd], {
      env: { PATH: process.env.PATH },
    });
    const r = runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
      PATH: process.env.PATH,
    });
    expect(r.timedOut).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });

  it("a git that finishes in time is returned untouched", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-cwd-"));
    tmpDirs.push(cwd);
    execFileSync("git", ["init", "-q", cwd], {
      env: { PATH: process.env.PATH },
    });
    const r = runGit(
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      { PATH: process.env.PATH },
      30_000,
    );
    expect(r.timedOut).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });
});

/** Whether a process of the group `pgid` is still there, waiting up to
 * `withinMs` for the last one to go (an exited watcher can linger as a
 * zombie for a moment before it is reaped). */
async function groupLingers(pgid: number, withinMs = 3000): Promise<boolean> {
  const until = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return false;
    }
    if (Date.now() > until) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the trampoline", () => {
  it("stops its watcher when the command ends, so a finished call leaves nothing", async () => {
    const f = makeFixture();
    const env = { PATH: process.env.PATH, ...GIT_ENV };
    // A watcher still running would hold the call open until its bound.
    const boundMs = 15_000;
    for (const args of [
      ["rev-parse", "--is-inside-work-tree"],
      ["rev-parse", "--verify", "nope"],
      ["status", "--porcelain"],
    ]) {
      const run = boundedCommand("git", args);
      const started = Date.now();
      const r = spawnSync(run.command, run.args, {
        cwd: f.repo,
        env,
        encoding: "utf8",
        ...boundedSpawnOptions(boundMs),
      } as SpawnSyncOptions & { encoding: "utf8" });
      expect(r.error, args.join(" ")).toBeUndefined();
      expect(Date.now() - started, args.join(" ")).toBeLessThan(boundMs / 2);
      expect(r.pid).toBeGreaterThan(0);
      expect(await groupLingers(r.pid), args.join(" ")).toBe(false);
    }
    // The same through `runGit`, the path every worktree call takes.
    for (let i = 0; i < 3; i++) {
      const r = runGit(f.repo, ["rev-parse", "HEAD"], env, boundMs);
      expect(r.timedOut).toBeUndefined();
      expect(r.status).toBe(0);
    }
  });

  it("gives the command no copy of its pipe, so what the command leaves running does not hold the call", () => {
    const dir = scratchDir("daemon-git");
    const pidFile = path.join(dir, "pid");
    fs.writeFileSync(
      path.join(dir, "git"),
      [
        "#!/bin/sh",
        "/bin/sleep 30 </dev/null >/dev/null 2>&1 &",
        `echo $! > '${pidFile}'`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const started = Date.now();
    const r = runGit(
      dir,
      ["status"],
      { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
      20_000,
    );
    const elapsed = Date.now() - started;
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    try {
      expect(r.timedOut).toBeUndefined();
      expect(r.status).toBe(0);
      expect(elapsed).toBeLessThan(10_000);
      // git exited by itself, so what it left behind on purpose is not
      // ended.
      expect(isAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  });

  // bash, which /bin/sh is on macOS and on some Linux systems, imports the
  // functions exported in its environment; dash does not.
  const shImportsFunctions =
    spawnSync("/bin/sh", ["-c", "probe_fn"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        "BASH_FUNC_probe_fn%%": "() { echo imported; }",
      },
    }).stdout?.trim() === "imported";

  it.skipIf(!shImportsFunctions)(
    "runs git and its own builtins past shell functions exported in the environment",
    () => {
      const f = makeFixture();
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...GIT_ENV };
      for (const name of ["git", "command", "read", "kill"]) {
        env[`BASH_FUNC_${name}%%`] = "() { echo function; }";
      }
      const r = runGit(
        f.repo,
        ["rev-parse", "--is-inside-work-tree"],
        env,
        20_000,
      );
      expect(r.timedOut).toBeUndefined();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("true\n");
    },
  );

  it("is not changed by shell options exported in SHELLOPTS", () => {
    const f = makeFixture();
    // bash takes these from the environment at startup; dash ignores them.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...GIT_ENV,
      SHELLOPTS: "errexit:monitor:xtrace",
    };
    const started = Date.now();
    const failed = runGit(
      f.repo,
      ["rev-parse", "--verify", "nope"],
      env,
      15_000,
    );
    // errexit would end the trampoline at git's failure with the watcher
    // still holding the call open until the bound.
    expect(failed.timedOut).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(7500);
    expect(failed.status).toBe(128);
    // xtrace would add the trampoline's own commands to git's stderr.
    expect(failed.stderr).not.toMatch(/^\+ /m);
    const ok = runGit(
      f.repo,
      ["rev-parse", "--is-inside-work-tree"],
      env,
      15_000,
    );
    expect(ok).toMatchObject({ status: 0, stdout: "true\n", stderr: "" });
  });

  it("kills the command's group at the bound with SHELLOPTS=monitor too", async () => {
    // monitor (job control) would start git in a group of its own, which
    // neither the watcher nor the kill at the bound would reach.
    const slow = sleepingGitDir();
    const r = runGit(
      slow.dir,
      ["status"],
      { PATH: slow.dir, SHELLOPTS: "monitor" },
      1000,
    );
    expect(r.timedOut).toBe(true);
    expect(slow.pids()).toHaveLength(2);
    await expectGone(slow.pids());
  });

  it("ends what a git that a signal ended had started", async () => {
    const dir = scratchDir("killed-git");
    const pidFile = path.join(dir, "pid");
    fs.writeFileSync(
      path.join(dir, "git"),
      [
        "#!/bin/sh",
        "/bin/sleep 120 </dev/null >/dev/null 2>&1 &",
        `echo $! > '${pidFile}'`,
        "kill -KILL $$",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const r = runGit(
      dir,
      ["status"],
      { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
      20_000,
    );
    // The shell reports a command a signal ended as 128 plus its number.
    expect(r.status).toBe(137);
    expect(r.timedOut).toBeUndefined();
    await expectGone([Number(fs.readFileSync(pidFile, "utf8").trim())]);
  });
});

describe("git() in a worktree command", () => {
  function withBound<T>(ms: string, fn: () => T): T {
    const saved = process.env[GIT_BOUND_ENV];
    process.env[GIT_BOUND_ENV] = ms;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env[GIT_BOUND_ENV];
      else process.env[GIT_BOUND_ENV] = saved;
    }
  }

  function withPath<T>(dir: string, fn: () => T): T {
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      return fn();
    } finally {
      process.env.PATH = saved;
    }
  }

  it("refuses with git_timeout by default and reports on request", async () => {
    const slow = sleepingGitDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-cwd-"));
    tmpDirs.push(cwd);
    const refused = withPath(slow.dir, () =>
      withBound("700", () => {
        try {
          git(cwd, ["for-each-ref"]);
          return undefined;
        } catch (err) {
          return err;
        }
      }),
    );
    expect(isGitTimeout(refused)).toBe(true);
    if (!isGitTimeout(refused)) return;
    expect(refused.message).toContain(
      "git for-each-ref did not finish within 700 ms and was stopped",
    );
    expect(refused.details).toMatchObject({
      git: "git for-each-ref",
      boundMs: 700,
    });
    const reported = withPath(slow.dir, () =>
      withBound("700", () =>
        git(cwd, ["for-each-ref"], { onTimeout: "report" }),
      ),
    );
    expect(reported.timedOut).toBe(true);
    expect(reported.status).toBeNull();
    expect(reported.error).toContain("did not finish within 700 ms");
    // One stand-in and its sleep for the refused call, one pair for this.
    expect(slow.pids()).toHaveLength(4);
    await expectGone(slow.pids());
  });

  it("names the timeout before what git had printed", () => {
    expect(
      gitFailure({
        status: null,
        stdout: "",
        stderr: "warning: something\n",
        error: "git status did not finish within 2 s and was stopped",
        timedOut: true,
      }),
    ).toBe(
      "git status did not finish within 2 s and was stopped (stderr: warning: something)",
    );
    expect(gitFailure({ status: 128, stdout: "", stderr: "fatal: no\n" })).toBe(
      "fatal: no",
    );
  });

  it("runGh reports a gh that is not installed as one it cannot start", () => {
    const f = makeFixture();
    const wt = addWorktree(f, "feat", true);
    // git is there, gh is not: the trampoline's shell exits 127 for it.
    const verdict = withPath(FIXED_BIN_DIR, () => {
      expect(runGh(wt, ["--version"])).toBeUndefined();
      return mergeVerdict(
        wt,
        "HEAD",
        "feat",
        "refs/remotes/origin/main",
        "main",
        "origin/main",
      );
    });
    expect(verdict.merged).toBe("unknown");
    expect(verdict.reason).toContain("gh is not available");
  });

  it("unpushedCommits reports a timeout instead of an empty listing", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "feat", true);
    const hung = hangingGit({ match: "gc.auto=0 for-each-ref" });
    const r = withPath(hung.PATH, () =>
      withBound("3000", () => unpushedCommits(wt)),
    );
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain("did not finish within 3 s");
    expect(r.stdout).toBe("");
    expect(hung.pids()).toHaveLength(2);
    await expectGone(hung.pids());
  });
});

// The control for the hang cases: the wrapper with a call that never
// matches changes nothing, so the refusals above come from the hang.
describe("the stand-in git", () => {
  it.concurrent("passes every call on when none matches", async () => {
    const f = makeFixture();
    const wt = addWorktree(f, "feat");
    const pass = hangingGit({ match: "gc.auto=0 no-such-subcommand" });
    const r = await runCli(f.work, ["remove", wt, ...REMOVE_FLAGS], {
      ...boundEnv(),
      PATH: pass.PATH,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(pass.pids()).toEqual([]);
  });
});
