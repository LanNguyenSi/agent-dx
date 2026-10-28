const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
// `test` is provided as a Vitest global (see vitest.config.mjs).

const {
  collectRepoStatus,
  collectUpstreamState,
  detectProtectedBranch,
  determineExitCode,
  discoverRepositories,
  main,
  parseArgs,
  printResults,
  resolveCliPath,
  runDirty,
  runFetch,
  runStatus,
  runSync
} = require("../src/cli");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupClonedRepo(workspaceRoot, repoName) {
  const originPath = path.join(workspaceRoot, `${repoName}-origin.git`);
  const seedPath = path.join(workspaceRoot, `${repoName}-seed`);
  const repoPath = path.join(workspaceRoot, repoName);

  fs.mkdirSync(originPath, { recursive: true });
  git(workspaceRoot, ["init", "--bare", originPath]);
  git(workspaceRoot, ["clone", originPath, seedPath]);
  git(seedPath, ["config", "user.name", "Test User"]);
  git(seedPath, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seedPath, "README.md"), `# ${repoName}\n`, "utf8");
  git(seedPath, ["add", "README.md"]);
  git(seedPath, ["commit", "-m", "init"]);
  git(seedPath, ["branch", "-M", "main"]);
  git(seedPath, ["push", "-u", "origin", "main"]);
  git(originPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(workspaceRoot, ["clone", originPath, repoPath]);
  git(repoPath, ["config", "user.name", "Test User"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["checkout", "main"]);

  return { originPath, repoPath, seedPath };
}

test("discoverRepositories finds only direct child repos", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-discover-"));
  const repoA = path.join(root, "repo-a");
  const nonRepo = path.join(root, "notes");
  const hiddenRepo = path.join(root, ".hidden-repo");

  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(nonRepo, { recursive: true });
  fs.mkdirSync(hiddenRepo, { recursive: true });
  fs.mkdirSync(path.join(repoA, ".git"));
  fs.mkdirSync(path.join(hiddenRepo, ".git"));

  const repos = discoverRepositories(root, {
    includeCurrent: false,
    includeHidden: false
  });

  assert.deepEqual(
    repos.map((repo) => repo.name),
    ["repo-a"]
  );
});

test("parseArgs treats a lone positional path as sync root", () => {
  const parsed = parseArgs(["/tmp/workspace"]);

  assert.equal(parsed.command, "sync");
  assert.equal(parsed.root, "/tmp/workspace");
});

test("parseArgs expands a home-relative root path", () => {
  const parsed = parseArgs(["--root=~/workspace"]);

  assert.equal(parsed.root, path.join(os.homedir(), "workspace"));
});

test("parseArgs accepts additional read-only commands", () => {
  const parsed = parseArgs(["dirty", "/tmp/workspace"]);

  assert.equal(parsed.command, "dirty");
  assert.equal(parsed.root, "/tmp/workspace");
});

test("parseArgs collects repository filters", () => {
  const parsed = parseArgs([
    "status",
    "/tmp/workspace",
    "--only",
    "api,web",
    "--exclude=/legacy/,sandbox"
  ]);

  assert.deepEqual(parsed.only, ["api", "web"]);
  assert.deepEqual(parsed.exclude, ["/legacy/", "sandbox"]);
});

test("parseArgs rejects invalid regex filters with a clear message", () => {
  assert.throws(
    () => parseArgs(["status", "/tmp/workspace", "--only", "/[invalid/"]),
    /Invalid value for --only: \/\[invalid\//
  );
});

test("parseArgs rejects unexpected extra positional arguments", () => {
  assert.throws(
    () => parseArgs(["status", "/tmp/workspace", "extra"]),
    /Unexpected positional arguments: extra/
  );
});

test("parseArgs marks explicitly configured protected branches", () => {
  const parsed = parseArgs(["sync", "/tmp/workspace", "--protected", "main,develop"]);

  assert.equal(parsed.protectedBranchesExplicit, true);
  assert.deepEqual(parsed.protectedBranches, ["main", "develop"]);
});

test("resolveCliPath keeps absolute paths stable", () => {
  assert.equal(resolveCliPath("/tmp/workspace"), "/tmp/workspace");
});

test("collectRepoStatus counts staged, unstaged and untracked changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-status-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(root, ["init", repo]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "user.email", "test@example.com"]);

  fs.writeFileSync(path.join(repo, "tracked.txt"), "v1\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "init"]);

  fs.writeFileSync(path.join(repo, "tracked.txt"), "v2\n", "utf8");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "tmp\n", "utf8");
  fs.writeFileSync(path.join(repo, "staged.txt"), "stage\n", "utf8");
  git(repo, ["add", "staged.txt"]);

  const status = collectRepoStatus(repo);

  assert.equal(status.clean, false);
  assert.equal(status.counts.staged, 1);
  assert.equal(status.counts.unstaged, 1);
  assert.equal(status.counts.untracked, 1);
});

test("discoverRepositories applies include and exclude filters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-filters-"));
  const names = ["api-core", "api-legacy", "web-app", "docs"];

  for (const name of names) {
    fs.mkdirSync(path.join(root, name, ".git"), { recursive: true });
  }

  const repos = discoverRepositories(root, {
    only: ["api", "web"],
    exclude: ["/legacy$/"],
    includeCurrent: false,
    includeHidden: false
  });

  assert.deepEqual(
    repos.map((repo) => repo.name),
    ["api-core", "web-app"]
  );
});

test("runSync skips dirty repos and fast-forwards clean repos to the protected branch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-sync-"));
  const clean = setupClonedRepo(root, "clean-repo");
  const dirty = setupClonedRepo(root, "dirty-repo");

  fs.writeFileSync(path.join(dirty.repoPath, "local.txt"), "dirty\n", "utf8");

  fs.writeFileSync(path.join(clean.seedPath, "README.md"), "# clean-repo\n\nupdated\n", "utf8");
  git(clean.seedPath, ["commit", "-am", "update remote"]);
  git(clean.seedPath, ["push", "origin", "main"]);

  const results = await runSync(
    discoverRepositories(root, {
      includeCurrent: false,
      includeHidden: false
    }),
    {
      protectedBranches: ["main", "master"],
      includeDirty: false,
      dryRun: false
    }
  );

  const cleanResult = results.find((entry) => entry.repo === "clean-repo");
  const dirtyResult = results.find((entry) => entry.repo === "dirty-repo");

  assert.equal(cleanResult.outcome, "ok");
  assert.equal(cleanResult.targetBranch, "main");
  assert.equal(dirtyResult.outcome, "skipped_dirty");
  assert.equal(dirtyResult.reason, "worktree_dirty");
  assert.match(fs.readFileSync(path.join(clean.repoPath, "README.md"), "utf8"), /updated/);
});

test("runSync skips repositories when explicit protected branches are local-only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-sync-local-only-"));
  const repo = setupClonedRepo(root, "local-only-repo");

  git(repo.repoPath, ["checkout", "-b", "develop"]);

  const [result] = await runSync(
    discoverRepositories(root, {
      includeCurrent: false,
      includeHidden: false
    }),
    {
      protectedBranches: ["develop"],
      protectedBranchesExplicit: true,
      includeDirty: false,
      dryRun: false
    }
  );

  assert.equal(result.outcome, "skipped_no_protected_branch");
  assert.equal(result.reason, "no_remote_protected_branch_detected");
  assert.equal(result.targetBranch, null);
});

test("detectProtectedBranch lets explicit protected branches override origin HEAD", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-protected-"));
  const repo = setupClonedRepo(root, "priority-repo");

  git(repo.seedPath, ["checkout", "-b", "develop"]);
  git(repo.seedPath, ["push", "-u", "origin", "develop"]);
  git(repo.originPath, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
  git(repo.repoPath, ["fetch", "--all", "--prune"]);
  git(repo.repoPath, ["remote", "set-head", "origin", "-a"]);

  assert.equal(
    detectProtectedBranch(repo.repoPath, ["main"], { preferConfigured: true }),
    "main"
  );
  assert.equal(
    detectProtectedBranch(repo.repoPath, ["main"], { preferConfigured: false }),
    "develop"
  );
});

test("detectProtectedBranch returns null when explicit protected branches are unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-protected-missing-"));
  const repo = setupClonedRepo(root, "missing-protected-repo");

  assert.equal(
    detectProtectedBranch(repo.repoPath, ["develop"], { preferConfigured: true }),
    null
  );
});

test("runDirty returns only repositories with local changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-dirty-"));
  const clean = setupClonedRepo(root, "clean-repo");
  const dirty = setupClonedRepo(root, "dirty-repo");

  fs.writeFileSync(path.join(dirty.repoPath, "notes.txt"), "dirty\n", "utf8");

  const results = runDirty(
    discoverRepositories(root, {
      includeCurrent: false,
      includeHidden: false
    }),
    {}
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].repo, "dirty-repo");
  assert.equal(results[0].counts.untracked, 1);
  assert.equal(fs.existsSync(path.join(clean.repoPath, "notes.txt")), false);
});

test("determineExitCode supports strict automation behavior", () => {
  assert.equal(
    determineExitCode("dirty", [{ repo: "api", outcome: "ok", clean: false }], true),
    1
  );
  assert.equal(
    determineExitCode("sync", [{ repo: "api", outcome: "ok", clean: true }], true),
    0
  );
  assert.equal(determineExitCode("status", [], true), 0);
});

test("main emits structured JSON and strict exit codes for agents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-main-"));
  const dirty = setupClonedRepo(root, "dirty-repo");
  const lines = [];

  fs.writeFileSync(path.join(dirty.repoPath, "local.txt"), "dirty\n", "utf8");

  const exitCode = await main(
    ["dirty", root, "--only", "/^dirty-repo$/", "--json", "--strict"],
    {
      out: (line) => lines.push(line),
      err: () => {}
    }
  );

  assert.equal(exitCode, 1);
  assert.equal(lines.length, 1);

  const payload = JSON.parse(lines[0]);
  assert.equal(payload.command, "dirty");
  assert.equal(payload.strict, true);
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.repoCount, 1);
  assert.equal(payload.results[0].repo, "dirty-repo");
});

test("printResults tolerates missing counts in text output", () => {
  const lines = [];

  assert.doesNotThrow(() =>
    printResults(
      "dirty",
      [
        {
          repo: "broken-repo",
          currentBranch: "main",
          outcome: "ok"
        }
      ],
      {
        out: (line) => lines.push(line)
      }
    )
  );

  assert.deepEqual(lines, [
    "broken-repo: branch=main staged=0 unstaged=0 untracked=0"
  ]);
});

test("collectUpstreamState reports ahead/behind distance against the tracking branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-upstream-"));
  const repo = setupClonedRepo(root, "tracked-repo");

  // Seed moves ahead by 2 commits on main and pushes; consumer clone
  // stays behind until it fetches.
  for (const label of ["second", "third"]) {
    fs.writeFileSync(path.join(repo.seedPath, `${label}.txt`), `${label}\n`, "utf8");
    git(repo.seedPath, ["add", `${label}.txt`]);
    git(repo.seedPath, ["commit", "-m", label]);
  }
  git(repo.seedPath, ["push", "origin", "main"]);
  git(repo.repoPath, ["fetch", "--quiet"]);

  const state = collectUpstreamState(repo.repoPath);
  assert.equal(state.upstream, "origin/main");
  assert.equal(state.ahead, 0);
  assert.equal(state.behind, 2);
});

test("collectUpstreamState reports ahead-only for local-only commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-ahead-"));
  const repo = setupClonedRepo(root, "ahead-repo");

  fs.writeFileSync(path.join(repo.repoPath, "local.txt"), "local\n", "utf8");
  git(repo.repoPath, ["add", "local.txt"]);
  git(repo.repoPath, ["commit", "-m", "local only"]);

  const state = collectUpstreamState(repo.repoPath);
  assert.equal(state.upstream, "origin/main");
  assert.equal(state.ahead, 1);
  assert.equal(state.behind, 0);
});

test("collectUpstreamState reports diverged counts when both sides moved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-diverged-"));
  const repo = setupClonedRepo(root, "diverged-repo");

  fs.writeFileSync(path.join(repo.seedPath, "remote.txt"), "remote\n", "utf8");
  git(repo.seedPath, ["add", "remote.txt"]);
  git(repo.seedPath, ["commit", "-m", "remote commit"]);
  git(repo.seedPath, ["push", "origin", "main"]);

  fs.writeFileSync(path.join(repo.repoPath, "local.txt"), "local\n", "utf8");
  git(repo.repoPath, ["add", "local.txt"]);
  git(repo.repoPath, ["commit", "-m", "local commit"]);
  git(repo.repoPath, ["fetch", "--quiet"]);

  const state = collectUpstreamState(repo.repoPath);
  assert.equal(state.upstream, "origin/main");
  assert.equal(state.ahead, 1);
  assert.equal(state.behind, 1);
});

test("collectUpstreamState returns null fields when the branch has no upstream", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-no-upstream-"));
  const repo = setupClonedRepo(root, "untracked-branch-repo");

  git(repo.repoPath, ["checkout", "-b", "feature/untracked"]);

  const state = collectUpstreamState(repo.repoPath);
  assert.equal(state.upstream, null);
  assert.equal(state.ahead, null);
  assert.equal(state.behind, null);
});

test("collectUpstreamState preserves upstream name when counts can't be computed", () => {
  // Rare edge case: upstream is configured and the remote-tracking ref
  // exists, but the commit it points at isn't reachable in the local
  // object store (e.g. object pruned by GC, interrupted fetch, manually
  // edited ref). rev-parse still resolves the upstream name from
  // config, but rev-list chokes on the dangling SHA.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-dangling-"));
  const repo = setupClonedRepo(root, "dangling-ref-repo");
  const bogusSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  fs.writeFileSync(
    path.join(repo.repoPath, ".git", "refs", "remotes", "origin", "main"),
    `${bogusSha}\n`,
    "utf8"
  );

  const state = collectUpstreamState(repo.repoPath);
  assert.equal(state.upstream, "origin/main");
  assert.equal(state.ahead, null);
  assert.equal(state.behind, null);
});

test("collectUpstreamState returns null fields when HEAD is detached", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-detached-"));
  const repo = setupClonedRepo(root, "detached-repo");

  const headSha = git(repo.repoPath, ["rev-parse", "HEAD"]).trim();
  git(repo.repoPath, ["checkout", "--detach", headSha]);

  const state = collectUpstreamState(repo.repoPath);
  assert.equal(state.upstream, null);
  assert.equal(state.ahead, null);
  assert.equal(state.behind, null);
});

test("runStatus includes upstream distance and honours --fetch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-status-fetch-"));
  const repo = setupClonedRepo(root, "drift-repo");

  fs.writeFileSync(path.join(repo.seedPath, "second.txt"), "second\n", "utf8");
  git(repo.seedPath, ["add", "second.txt"]);
  git(repo.seedPath, ["commit", "-m", "remote"]);
  git(repo.seedPath, ["push", "origin", "main"]);

  // Without --fetch the clone still thinks it's up-to-date.
  const [beforeFetch] = await runStatus(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: ["main", "master"] }
  );
  assert.equal(beforeFetch.outcome, "ok");
  assert.equal(beforeFetch.upstream, "origin/main");
  assert.equal(beforeFetch.behind, 0);

  const [afterFetch] = await runStatus(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: ["main", "master"], fetch: true }
  );
  assert.equal(afterFetch.outcome, "ok");
  assert.equal(afterFetch.upstream, "origin/main");
  assert.equal(afterFetch.behind, 1);
  assert.equal(afterFetch.ahead, 0);
  assert.equal(afterFetch.repo, "drift-repo");
});

test("runStatus surfaces fetch_failed without aborting the batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-status-fetchfail-"));
  const repoA = setupClonedRepo(root, "healthy-repo-a");
  const repoB = setupClonedRepo(root, "broken-remote-repo");
  const repoC = setupClonedRepo(root, "healthy-repo-c");

  // Point origin at a path that doesn't exist so `git fetch` fails.
  git(repoB.repoPath, ["remote", "set-url", "origin", path.join(root, "does-not-exist.git")]);

  const results = await runStatus(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: ["main", "master"], fetch: true }
  );

  const byRepo = Object.fromEntries(results.map((entry) => [entry.repo, entry]));
  assert.equal(byRepo["broken-remote-repo"].outcome, "fetch_failed");
  assert.equal(byRepo["healthy-repo-a"].outcome, "ok");
  assert.equal(byRepo["healthy-repo-c"].outcome, "ok");
  // Local refs still resolve, so upstream is reported even when the
  // fetch itself failed — the point is that the call didn't throw and
  // other repos still completed normally.
  assert.equal(byRepo["broken-remote-repo"].upstream, "origin/main");
  assert.equal(typeof byRepo["broken-remote-repo"].behind, "number");
});

 test("runStatus honours fetch concurrency cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-fetch-concurrency-"));
  for (const name of ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"]) {
    setupClonedRepo(root, name);
  }

  const repos = discoverRepositories(root, { includeCurrent: false, includeHidden: false });
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await runStatus(repos, {
    protectedBranches: ["main", "master"],
    fetch: true,
    fetchConcurrency: 2,
    fetchRepo: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(25);
      inFlight -= 1;
      return true;
    }
  });

  assert.equal(maxInFlight, 2);
  assert.ok(results.every((entry) => entry.outcome === "ok"));
});

test("parseArgs accepts --fetch flag", () => {
  const parsed = parseArgs(["status", "/tmp/ws", "--fetch"]);
  assert.equal(parsed.fetch, true);
});

test("printResults renders upstream and distance columns for status", () => {
  const lines = [];

  printResults(
    "status",
    [
      {
        repo: "behind-repo",
        currentBranch: "main",
        targetBranch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 16,
        clean: true,
        counts: { staged: 0, unstaged: 0, untracked: 0 },
        outcome: "ok"
      },
      {
        repo: "no-upstream-repo",
        currentBranch: "feature/x",
        targetBranch: "main",
        upstream: null,
        ahead: null,
        behind: null,
        clean: true,
        counts: { staged: 0, unstaged: 0, untracked: 0 },
        outcome: "ok"
      }
    ],
    {
      out: (line) => lines.push(line)
    }
  );

  assert.deepEqual(lines, [
    "behind-repo: branch=main target=main upstream=origin/main ahead=0 behind=16 clean=true staged=0 unstaged=0 untracked=0 target_ref=- target_sha=- head_sha=- ahead_of_target=- behind_target=- worktree=false common_dir=-",
    "no-upstream-repo: branch=feature/x target=main upstream=- ahead=- behind=- clean=true staged=0 unstaged=0 untracked=0 target_ref=- target_sha=- head_sha=- ahead_of_target=- behind_target=- worktree=false common_dir=-"
  ]);
});

test("printResults tags status rows with non-ok outcome", () => {
  const lines = [];

  printResults(
    "status",
    [
      {
        repo: "offline-repo",
        currentBranch: "main",
        targetBranch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        clean: true,
        counts: { staged: 0, unstaged: 0, untracked: 0 },
        outcome: "fetch_failed"
      }
    ],
    {
      out: (line) => lines.push(line)
    }
  );

  assert.deepEqual(lines, [
    "offline-repo: branch=main target=main upstream=origin/main ahead=0 behind=0 clean=true staged=0 unstaged=0 untracked=0 outcome=fetch_failed target_ref=- target_sha=- head_sha=- ahead_of_target=- behind_target=- worktree=false common_dir=-"
  ]);
});

test("printResults includes skip reasons for sync output", () => {
  const lines = [];

  printResults(
    "sync",
    [
      {
        repo: "dirty-repo",
        currentBranch: "feature/test",
        targetBranch: "-",
        clean: false,
        counts: { staged: 0, unstaged: 1, untracked: 0 },
        outcome: "skipped_dirty",
        reason: "worktree_dirty",
        actions: []
      }
    ],
    {
      out: (line) => lines.push(line)
    }
  );

  assert.deepEqual(lines, [
    "dirty-repo: outcome=skipped_dirty current=feature/test target=- clean=false staged=0 unstaged=1 untracked=0 reason=worktree_dirty"
  ]);
});

function slowFetchRunner(delays, tracker) {
  const { runGitAsyncForTest } = tracker;
  return async (repoPath, args, extra) => {
    const isFetch = args[0] === "fetch";
    if (isFetch) {
      tracker.inFlight += 1;
      tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
      await sleep(delays[path.basename(repoPath)] || 20);
      tracker.inFlight -= 1;
      tracker.finished.push(path.basename(repoPath));
    }
    tracker.commands.push(`${path.basename(repoPath)}: ${args.join(" ")}`);
    return runGitAsyncForTest(repoPath, args, extra);
  };
}

function makeTracker() {
  const { spawn } = require("node:child_process");
  const runGitAsyncForTest = (repoPath, args) =>
    new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ code, stdout, stderr });
        else reject(new Error(stderr.trim() || stdout.trim() || "git failed"));
      });
    });
  return { inFlight: 0, maxInFlight: 0, finished: [], commands: [], runGitAsyncForTest };
}

function setupFiveRepos(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const name of ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"]) {
    setupClonedRepo(root, name);
  }
  return {
    root,
    repos: discoverRepositories(root, {
      includeCurrent: false,
      includeHidden: false,
      only: ["/^repo-[a-e]$/"]
    })
  };
}

test("runSync overlaps fetches up to the concurrency cap", async () => {
  const { repos } = setupFiveRepos("git-batch-sync-overlap-");
  const tracker = makeTracker();
  const results = await runSync(repos, {
    protectedBranches: ["main", "master"],
    fetchConcurrency: 3,
    gitRunner: slowFetchRunner({}, tracker)
  });
  assert.equal(tracker.maxInFlight, 3);
  assert.ok(results.every((entry) => entry.outcome === "ok"));
});

test("runFetch overlaps fetches with the default concurrency", async () => {
  const { repos } = setupFiveRepos("git-batch-fetch-overlap-");
  const tracker = makeTracker();
  const results = await runFetch(repos, {
    gitRunner: slowFetchRunner({}, tracker)
  });
  assert.equal(tracker.maxInFlight, 5);
  assert.ok(results.every((entry) => entry.outcome === "ok"));
  assert.equal(results[0].actions[0].command, "git fetch --all --prune");
});

test("runFetch and runSync keep sorted repo order when later repos finish first", async () => {
  const { repos } = setupFiveRepos("git-batch-order-");
  const delays = { "repo-a": 150, "repo-b": 100, "repo-c": 50 };

  const fetchTracker = makeTracker();
  const fetched = await runFetch(repos, { gitRunner: slowFetchRunner(delays, fetchTracker) });
  assert.notEqual(fetchTracker.finished[0], "repo-a");
  assert.deepEqual(fetched.map((entry) => entry.repo), repos.map((repo) => repo.name));

  const syncTracker = makeTracker();
  const synced = await runSync(repos, {
    protectedBranches: ["main", "master"],
    gitRunner: slowFetchRunner(delays, syncTracker)
  });
  assert.notEqual(syncTracker.finished[0], "repo-a");
  assert.deepEqual(synced.map((entry) => entry.repo), repos.map((repo) => repo.name));
});

test("runSync fast-forwards with git merge instead of git pull", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-sync-merge-"));
  const repo = setupClonedRepo(root, "merge-repo");
  fs.writeFileSync(path.join(repo.seedPath, "upstream.txt"), "upstream\n", "utf8");
  git(repo.seedPath, ["add", "upstream.txt"]);
  git(repo.seedPath, ["commit", "-m", "upstream"]);
  git(repo.seedPath, ["push", "origin", "main"]);

  const [result] = await runSync(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: ["main"], dryRun: false }
  );

  assert.equal(result.outcome, "ok");
  const commands = result.actions.map((action) => action.command);
  assert.deepEqual(commands, ["git fetch --all --prune", "git merge --ff-only refs/remotes/origin/main"]);
  assert.ok(!commands.some((command) => command.includes("pull")));
  assert.equal(fs.readFileSync(path.join(repo.repoPath, "upstream.txt"), "utf8"), "upstream\n");
});

test("runSync reports non-fast-forward merges as errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-sync-nonff-"));
  const repo = setupClonedRepo(root, "diverged-repo");
  fs.writeFileSync(path.join(repo.seedPath, "remote.txt"), "remote\n", "utf8");
  git(repo.seedPath, ["add", "remote.txt"]);
  git(repo.seedPath, ["commit", "-m", "remote"]);
  git(repo.seedPath, ["push", "origin", "main"]);
  fs.writeFileSync(path.join(repo.repoPath, "local.txt"), "local\n", "utf8");
  git(repo.repoPath, ["add", "local.txt"]);
  git(repo.repoPath, ["commit", "-m", "local"]);

  const [result] = await runSync(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: ["main"], dryRun: false }
  );

  assert.equal(result.outcome, "error");
  assert.match(result.error, /not possible to fast-forward|diverging|fatal/i);
});

test("runSync dry-run records the merge command and executes nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-sync-dry-"));
  setupClonedRepo(root, "dry-repo");
  const tracker = makeTracker();
  const [result] = await runSync(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: ["main"], dryRun: true, gitRunner: slowFetchRunner({}, tracker) }
  );
  assert.equal(result.outcome, "ok");
  assert.equal(tracker.commands.length, 0);
  assert.equal(result.actions.at(-1).command, "git merge --ff-only refs/remotes/origin/main");
});

test("parseArgs --concurrency: absent, valid, equals form", () => {
  assert.equal(parseArgs(["fetch", "/tmp/ws"]).fetchConcurrency, undefined);
  assert.equal(parseArgs(["fetch", "/tmp/ws", "--concurrency", "3"]).fetchConcurrency, 3);
  assert.equal(parseArgs(["fetch", "/tmp/ws", "--concurrency=5"]).fetchConcurrency, 5);
});

test("parseArgs --concurrency rejects 0, negatives and non-numeric values", () => {
  for (const bad of ["0", "-2", "abc", "1.5", ""]) {
    assert.throws(
      () => parseArgs(["sync", "/tmp/ws", `--concurrency=${bad}`]),
      /Invalid value for --concurrency/
    );
  }
  assert.throws(
    () => parseArgs(["sync", "/tmp/ws", "--concurrency", "0"]),
    /Invalid value for --concurrency/
  );
  assert.throws(
    () => parseArgs(["sync", "/tmp/ws", "--concurrency", "abc"]),
    /Invalid value for --concurrency/
  );
});

test("--concurrency reaches the pool through main", async () => {
  const { root } = setupFiveRepos("git-batch-main-concurrency-");
  const tracker = makeTracker();
  const out = [];
  const code = await main(["fetch", root, "--only", "/^repo-[a-e]$/", "--concurrency", "2", "--json"], {
    out: (line) => out.push(line),
    err: () => {},
    gitRunner: slowFetchRunner({}, tracker)
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out[0]).results.length, 5);
  assert.equal(tracker.maxInFlight, 2);
});

// Reviewer-style fixture: a clone with linked worktrees next to it, all
// sharing one ref store, plus a remote that moves ahead.
function setupWorktreeGroup(prefix, worktreeCount, extraBranches = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = setupClonedRepo(root, "main-wt");
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  fs.renameSync(repo.repoPath, path.join(ws, "main-wt"));
  // repoint the clone's origin is unchanged (absolute path), so no fixup needed
  for (let i = 1; i <= worktreeCount; i += 1) {
    git(path.join(ws, "main-wt"), ["worktree", "add", "-q", path.join(ws, `wt${i}`), "-b", `local${i}`]);
  }
  for (let i = 1; i <= extraBranches; i += 1) {
    git(repo.seedPath, ["checkout", "-q", "-b", `feature${i}`, "main"]);
    git(repo.seedPath, ["push", "-q", "origin", `feature${i}`]);
  }
  git(repo.seedPath, ["checkout", "-q", "main"]);
  // fetch once so every branch is tracked, then move every branch ahead
  git(path.join(ws, "main-wt"), ["fetch", "-q", "--all"]);
  for (let i = 1; i <= extraBranches; i += 1) {
    git(repo.seedPath, ["checkout", "-q", `feature${i}`]);
    fs.writeFileSync(path.join(repo.seedPath, `f${i}.txt`), `${i}\n`, "utf8");
    git(repo.seedPath, ["add", `f${i}.txt`]);
    git(repo.seedPath, ["commit", "-q", "-m", `f${i}`]);
  }
  git(repo.seedPath, ["checkout", "-q", "main"]);
  fs.writeFileSync(path.join(repo.seedPath, "upstream.txt"), "upstream\n", "utf8");
  git(repo.seedPath, ["add", "upstream.txt"]);
  git(repo.seedPath, ["commit", "-m", "upstream"]);
  git(repo.seedPath, ["push", "-q", "--all", "origin"]);
  return { root, ws, repo, repos: discoverRepositories(ws, { includeCurrent: false, includeHidden: false }) };
}

test("fetch and sync share one fetch across linked worktrees of one repository", async () => {
  const { repos } = setupWorktreeGroup("git-batch-worktrees-", 3);
  assert.equal(repos.length, 4);

  const fetchTracker = makeTracker();
  const fetched = await runFetch(repos, { gitRunner: slowFetchRunner({}, fetchTracker) });
  assert.ok(fetched.every((entry) => entry.outcome === "ok"), JSON.stringify(fetched));
  assert.equal(fetchTracker.commands.filter((command) => command.includes("fetch")).length, 1);
  const skipped = fetched.filter((entry) => entry.actions[0].skipped);
  assert.equal(skipped.length, 3);
  assert.ok(skipped.every((entry) => entry.actions[0].sharedWith === "main-wt"));
  assert.equal(fetched.find((entry) => entry.repo === "main-wt").actions[0].skipped, undefined);

  const syncTracker = makeTracker();
  const synced = await runSync(repos, {
    protectedBranches: ["main"],
    protectedBranchesExplicit: true,
    includeDirty: true,
    gitRunner: slowFetchRunner({}, syncTracker)
  });
  // Siblings cannot check out main while main-wt holds it; that is not a fetch problem.
  assert.equal(synced.find((entry) => entry.repo === "main-wt").outcome, "ok");
  assert.ok(synced.every((entry) => !/lock/.test(entry.error || "")));
  assert.equal(syncTracker.commands.filter((command) => command.includes(" fetch ")).length, 1);
});

test("fetch and sync of linked worktrees succeed with real git at default concurrency", async () => {
  const { repos } = setupWorktreeGroup("git-batch-worktrees-real-", 7, 30);
  const fetched = await runFetch(repos, {});
  assert.ok(fetched.every((entry) => entry.outcome === "ok"), JSON.stringify(fetched.map((e) => e.error)));
  const synced = await runSync(repos, { protectedBranches: ["main"], protectedBranchesExplicit: true });
  // A sibling cannot check out a branch another worktree holds; that git
  // error is expected, a ref-lock race is not.
  assert.ok(
    synced.every((entry) => !/cannot lock ref|Unable to create .*\.lock/.test(entry.error || "")),
    JSON.stringify(synced.map((e) => e.error))
  );
  assert.equal(synced.find((entry) => entry.repo === "main-wt").outcome, "ok");
  // Real git with 8 worktrees and 30 branches exceeds the 5 s default under load.
}, 30000);

test("status --fetch shares one fetch across linked worktrees", async () => {
  const { repos } = setupWorktreeGroup("git-batch-worktrees-status-", 3);
  const calls = [];
  const results = await runStatus(repos, {
    fetch: true,
    fetchRepo: async (repoPath) => {
      calls.push(path.basename(repoPath));
      await sleep(20);
      return true;
    }
  });
  assert.deepEqual(calls, ["main-wt"]);
  assert.ok(results.every((entry) => entry.outcome !== "fetch_failed"), JSON.stringify(results.map((e) => e.outcome)));
});

function setupEdgeRemote(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = setupClonedRepo(root, "edge-repo");
  git(repo.seedPath, ["checkout", "-b", "develop"]);
  git(repo.seedPath, ["push", "origin", "develop"]);
  git(repo.seedPath, ["checkout", "main"]);
  git(repo.repoPath, ["fetch", "--all"]);
  return { root, repo };
}

function advanceRemote(repo, branch) {
  git(repo.seedPath, ["checkout", branch]);
  fs.writeFileSync(path.join(repo.seedPath, `${branch}.txt`), `${branch}\n`, "utf8");
  git(repo.seedPath, ["add", `${branch}.txt`]);
  git(repo.seedPath, ["commit", "-m", `advance ${branch}`]);
  git(repo.seedPath, ["push", "origin", branch]);
  return git(repo.seedPath, ["rev-parse", "HEAD"]).trim();
}

async function syncOne(root, branch) {
  const [result] = await runSync(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: [branch], protectedBranchesExplicit: true }
  );
  return result;
}

test("runSync fast-forwards when remote.origin.skipFetchAll is set", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-skipall-");
  git(repo.repoPath, ["config", "remote.origin.skipFetchAll", "true"]);
  const head = advanceRemote(repo, "main");
  const result = await syncOne(root, "main");
  assert.equal(result.outcome, "ok", result.error);
  assert.equal(git(repo.repoPath, ["rev-parse", "HEAD"]).trim(), head);
  assert.ok(result.actions.some((action) => action.command.startsWith("git fetch origin ")));
});

test("runSync fast-forwards when the fetch refspec does not cover the target branch", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-narrow-");
  git(repo.repoPath, ["checkout", "develop"]);
  git(repo.repoPath, ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
  const head = advanceRemote(repo, "develop");
  const result = await syncOne(root, "develop");
  assert.equal(result.outcome, "ok", result.error);
  assert.equal(git(repo.repoPath, ["rev-parse", "HEAD"]).trim(), head);
  assert.ok(result.actions.some((action) => action.command.startsWith("git fetch origin ")));
});

const TARGETED_FETCH = "git fetch origin +refs/heads/main:refs/remotes/origin/main";

test("runSync runs the targeted fetch when a negative refspec excludes the target branch", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-negspec-");
  git(repo.repoPath, ["config", "--add", "remote.origin.fetch", "^refs/heads/main"]);
  const head = advanceRemote(repo, "main");
  const result = await syncOne(root, "main");
  assert.equal(result.outcome, "ok", result.error);
  assert.equal(git(repo.repoPath, ["rev-parse", "HEAD"]).trim(), head);
  assert.ok(result.actions.some((action) => action.command === TARGETED_FETCH), JSON.stringify(result.actions));
});

test("runSync runs the targeted fetch when the refspec maps to a different remote-tracking namespace", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-otherns-");
  git(repo.repoPath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/upstream/*"]);
  const head = advanceRemote(repo, "main");
  const result = await syncOne(root, "main");
  assert.equal(result.outcome, "ok", result.error);
  assert.equal(git(repo.repoPath, ["rev-parse", "HEAD"]).trim(), head);
  assert.ok(result.actions.some((action) => action.command === TARGETED_FETCH), JSON.stringify(result.actions));
});

test("printResults marks a shared fetch action in text output", () => {
  const lines = [];
  printResults(
    "fetch",
    [
      {
        repo: "wt-a",
        outcome: "ok",
        actions: [{ command: "git fetch --all --prune", skipped: true, sharedWith: "main-wt" }]
      },
      { repo: "main-wt", outcome: "ok", actions: [{ command: "git fetch --all --prune" }] }
    ],
    { out: (line) => lines.push(line) }
  );
  assert.deepEqual(lines, [
    "wt-a: git fetch --all --prune (shared with main-wt)",
    "main-wt: git fetch --all --prune"
  ]);
});

test("runSync does not run the extra fetch for a default refspec", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-default-spec-");
  advanceRemote(repo, "main");
  const result = await syncOne(root, "main");
  assert.equal(result.outcome, "ok", result.error);
  assert.deepEqual(
    result.actions.map((action) => action.command),
    ["git fetch --all --prune", "git merge --ff-only refs/remotes/origin/main"]
  );
});

test("runSync merges the remote-tracking ref even when a local branch is named origin/main", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-ambig-");
  git(repo.repoPath, ["branch", "origin/main", "HEAD"]);
  const head = advanceRemote(repo, "main");
  const result = await syncOne(root, "main");
  assert.equal(result.outcome, "ok", result.error);
  assert.equal(git(repo.repoPath, ["rev-parse", "HEAD"]).trim(), head);
});

// Fleet snapshot fields: HEAD against origin/<target>, never the upstream.
function commitFile(repoPath, name, message) {
  fs.writeFileSync(path.join(repoPath, name), `${name}\n`, "utf8");
  git(repoPath, ["add", name]);
  git(repoPath, ["commit", "-q", "-m", message]);
}

async function statusOf(root, extra = {}) {
  const results = await runStatus(
    discoverRepositories(root, { includeCurrent: false, includeHidden: false }),
    { protectedBranches: ["main", "master"], ...extra }
  );
  return results;
}

test("status target fields: on target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-on-"));
  const repo = setupClonedRepo(root, "r");
  const [entry] = await statusOf(root);
  const sha = git(repo.repoPath, ["rev-parse", "HEAD"]).trim();
  assert.equal(entry.targetRef, "refs/remotes/origin/main");
  assert.equal(entry.targetSha, sha);
  assert.equal(entry.headSha, sha);
  assert.equal(entry.aheadOfTarget, 0);
  assert.equal(entry.behindTarget, 0);
  assert.equal(entry.worktree, false);
  assert.equal(entry.commonDir, fs.realpathSync(path.join(repo.repoPath, ".git")));
});

test("status target fields: ahead, behind and diverged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-drift-"));
  const repo = setupClonedRepo(root, "r");

  commitFile(repo.repoPath, "local1.txt", "local1");
  commitFile(repo.repoPath, "local2.txt", "local2");
  let [entry] = await statusOf(root);
  assert.equal(entry.aheadOfTarget, 2);
  assert.equal(entry.behindTarget, 0);

  git(repo.repoPath, ["reset", "-q", "--hard", "origin/main"]);
  advanceRemote(repo, "main");
  [entry] = await statusOf(root, { fetch: true });
  assert.equal(entry.aheadOfTarget, 0);
  assert.equal(entry.behindTarget, 1);
  assert.equal(entry.targetSha, git(repo.seedPath, ["rev-parse", "HEAD"]).trim());

  commitFile(repo.repoPath, "local3.txt", "local3");
  [entry] = await statusOf(root);
  assert.equal(entry.aheadOfTarget, 1);
  assert.equal(entry.behindTarget, 1);
});

test("status target fields are computed against the target, not the upstream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-upstream-"));
  const repo = setupClonedRepo(root, "r");
  // Branch tracks origin/develop, which is 2 commits ahead of origin/main.
  git(repo.seedPath, ["checkout", "-q", "-b", "develop"]);
  commitFile(repo.seedPath, "d1.txt", "d1");
  commitFile(repo.seedPath, "d2.txt", "d2");
  git(repo.seedPath, ["push", "-q", "origin", "develop"]);
  git(repo.repoPath, ["fetch", "-q", "--all"]);
  git(repo.repoPath, ["checkout", "-q", "-b", "work", "--track", "origin/develop"]);
  commitFile(repo.repoPath, "w1.txt", "w1");

  const [entry] = await statusOf(root);
  assert.equal(entry.upstream, "origin/develop");
  assert.equal(entry.ahead, 1);
  assert.equal(entry.behind, 0);
  assert.equal(entry.targetRef, "refs/remotes/origin/main");
  assert.equal(entry.aheadOfTarget, 3);
  assert.equal(entry.behindTarget, 0);
});

test("status target fields are null without a target or a remote-tracking ref", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-null-"));
  const repoPath = path.join(root, "bare-local");
  fs.mkdirSync(repoPath);
  git(repoPath, ["init", "-q", "-b", "feature"]);
  git(repoPath, ["config", "user.name", "Test User"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  commitFile(repoPath, "a.txt", "a");
  // A remote-tracking ref literally named "null" must not be mistaken for a target.
  git(repoPath, ["update-ref", "refs/remotes/origin/null", "HEAD"]);

  let [entry] = await statusOf(root);
  assert.equal(entry.targetBranch, null);
  assert.equal(entry.targetRef, null);
  assert.equal(entry.targetSha, null);
  assert.equal(entry.aheadOfTarget, null);
  assert.equal(entry.behindTarget, null);
  assert.equal(entry.headSha, git(repoPath, ["rev-parse", "HEAD"]).trim());

  // A local-only main is a target branch for status, but has no origin ref.
  git(repoPath, ["branch", "main"]);
  [entry] = await statusOf(root);
  assert.equal(entry.targetBranch, "main");
  assert.equal(entry.targetRef, null);
  assert.equal(entry.targetSha, null);
  assert.equal(entry.aheadOfTarget, null);
  assert.equal(entry.behindTarget, null);
});

test("status target fields on a detached HEAD", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-detached-"));
  const repo = setupClonedRepo(root, "r");
  commitFile(repo.repoPath, "local.txt", "local");
  git(repo.repoPath, ["checkout", "-q", "--detach"]);

  const [entry] = await statusOf(root);
  assert.equal(entry.currentBranch, "detached");
  assert.equal(entry.upstream, null);
  assert.equal(entry.headSha, git(repo.repoPath, ["rev-parse", "HEAD"]).trim());
  assert.equal(entry.aheadOfTarget, 1);
  assert.equal(entry.behindTarget, 0);
});

test("status marks linked worktree siblings with the same commonDir", async () => {
  const { repos } = setupWorktreeGroup("git-batch-target-wt-", 2);
  const results = await runStatus(repos, { protectedBranches: ["main"] });
  assert.equal(results.length, 3);
  assert.equal(new Set(results.map((entry) => entry.commonDir)).size, 1);
  assert.equal(results.find((entry) => entry.repo === "main-wt").worktree, false);
  assert.ok(results.filter((entry) => entry.repo !== "main-wt").every((entry) => entry.worktree === true));
  assert.ok(results.every((entry) => entry.targetRef === "refs/remotes/origin/main"));
});

test("status text output appends the target columns with short SHAs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-text-"));
  const repo = setupClonedRepo(root, "r");
  const results = await statusOf(root);
  const lines = [];
  printResults("status", results, { out: (line) => lines.push(line) });
  const sha = git(repo.repoPath, ["rev-parse", "HEAD"]).trim();
  assert.match(lines[0], /^r: branch=main target=main upstream=origin\/main ahead=0 behind=0 clean=true /);
  assert.ok(lines[0].includes(` target_ref=refs/remotes/origin/main target_sha=${sha.slice(0, 7)} head_sha=${sha.slice(0, 7)} ahead_of_target=0 behind_target=0 worktree=false common_dir=`));
  assert.ok(!lines[0].includes(sha));
});

test("status --fetch refreshes the target when the branch tracks a non-origin remote", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-target-fork-");
  git(repo.repoPath, ["remote", "add", "up", repo.originPath]);
  git(repo.repoPath, ["fetch", "-q", "up"]);
  git(repo.repoPath, ["checkout", "-q", "-b", "work", "--track", "up/develop"]);
  const remoteMain = advanceRemote(repo, "main");

  const [entry] = await statusOf(root, { fetch: true });
  assert.equal(entry.upstream, "up/develop");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.targetSha, remoteMain);
  assert.equal(entry.behindTarget, 1);
});

test("status --fetch refreshes the target when the branch tracks a local branch", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-target-dot-");
  git(repo.repoPath, ["checkout", "-q", "-b", "feat", "--track", "main"]);
  assert.equal(git(repo.repoPath, ["config", "--get", "branch.feat.remote"]).trim(), ".");
  const remoteMain = advanceRemote(repo, "main");

  const [entry] = await statusOf(root, { fetch: true });
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.targetSha, remoteMain);
  assert.equal(entry.behindTarget, 1);
});

test("status --fetch refreshes a target that a negative refspec excludes", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-target-negative-");
  git(repo.repoPath, ["config", "--add", "remote.origin.fetch", "^refs/heads/main"]);
  const remoteMain = advanceRemote(repo, "main");

  const [entry] = await statusOf(root, { fetch: true });
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.targetSha, remoteMain);
  assert.equal(entry.behindTarget, 1);
});

test("status --fetch refreshes a target that origin's refspec does not map", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-target-refspec-");
  git(repo.repoPath, [
    "config",
    "--replace-all",
    "remote.origin.fetch",
    "+refs/heads/develop:refs/remotes/origin/develop"
  ]);
  const remoteMain = advanceRemote(repo, "main");

  const [entry] = await statusOf(root, { fetch: true });
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.targetSha, remoteMain);
  assert.equal(entry.behindTarget, 1);
});

test("status --fetch refreshes the target when remote.origin.skipFetchAll is set", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-target-skipall-");
  git(repo.repoPath, ["config", "remote.origin.skipFetchAll", "true"]);
  const remoteMain = advanceRemote(repo, "main");

  const [entry] = await statusOf(root, { fetch: true });
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.targetSha, remoteMain);
});

test("status --fetch does not fail when the detected target is missing on the remote", async () => {
  const { root, repo } = setupEdgeRemote("git-batch-target-gone-");
  git(repo.repoPath, [
    "config",
    "--replace-all",
    "remote.origin.fetch",
    "+refs/heads/develop:refs/remotes/origin/develop"
  ]);
  git(repo.repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone"]);

  const [entry] = await statusOf(root, { fetch: true });
  assert.equal(entry.targetBranch, "gone");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.targetRef, null);
});

test("status target fields on an unborn HEAD with origin/<target> present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-unborn-"));
  const seeded = setupClonedRepo(root, "seeded");
  const repoPath = path.join(root, "unborn");
  fs.mkdirSync(repoPath);
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["remote", "add", "origin", seeded.originPath]);
  git(repoPath, ["fetch", "-q", "origin"]);

  const entry = (await statusOf(root)).find((e) => e.repo === "unborn");
  assert.equal(entry.targetRef, "refs/remotes/origin/main");
  assert.equal(entry.targetSha, git(seeded.seedPath, ["rev-parse", "HEAD"]).trim());
  assert.equal(entry.headSha, null);
  assert.equal(entry.aheadOfTarget, null);
  assert.equal(entry.behindTarget, null);
});

test("status text output quotes a common_dir that contains whitespace", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-target-space-"));
  const root = path.join(base, "with space");
  fs.mkdirSync(root);
  const repo = setupClonedRepo(root, "r");
  const results = await statusOf(root);
  const lines = [];
  printResults("status", results, { out: (line) => lines.push(line) });
  const expected = fs.realpathSync(path.join(repo.repoPath, ".git"));
  assert.ok(expected.includes(" "));
  assert.ok(lines[0].endsWith(` common_dir=${JSON.stringify(expected)}`), lines[0]);
  // Splitting on whitespace outside quotes yields exactly one common_dir pair.
  const pairs = lines[0].match(/[a-z_]+=(?:"(?:[^"\\]|\\.)*"|\S*)/g);
  assert.equal(pairs[pairs.length - 1], `common_dir=${JSON.stringify(expected)}`);
});
