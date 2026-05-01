const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

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

test("runSync skips dirty repos and pulls clean repos to the protected branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-sync-"));
  const clean = setupClonedRepo(root, "clean-repo");
  const dirty = setupClonedRepo(root, "dirty-repo");

  fs.writeFileSync(path.join(dirty.repoPath, "local.txt"), "dirty\n", "utf8");

  fs.writeFileSync(path.join(clean.seedPath, "README.md"), "# clean-repo\n\nupdated\n", "utf8");
  git(clean.seedPath, ["commit", "-am", "update remote"]);
  git(clean.seedPath, ["push", "origin", "main"]);

  const results = runSync(
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

test("runSync skips repositories when explicit protected branches are local-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-batch-sync-local-only-"));
  const repo = setupClonedRepo(root, "local-only-repo");

  git(repo.repoPath, ["checkout", "-b", "develop"]);

  const [result] = runSync(
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
    "behind-repo: branch=main target=main upstream=origin/main ahead=0 behind=16 clean=true staged=0 unstaged=0 untracked=0",
    "no-upstream-repo: branch=feature/x target=main upstream=- ahead=- behind=- clean=true staged=0 unstaged=0 untracked=0"
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
    "offline-repo: branch=main target=main upstream=origin/main ahead=0 behind=0 clean=true staged=0 unstaged=0 untracked=0 outcome=fetch_failed"
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
