const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const DEFAULT_PROTECTED_BRANCHES = [
  "main",
  "master",
  "develop",
  "dev",
  "staging",
  "production",
  "trunk"
];
const DEFAULT_FETCH_CONCURRENCY = 8;

async function main(argv = process.argv.slice(2), io = defaultIo()) {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    io.out(helpText());
    return Promise.resolve(0);
  }

  const repos = discoverRepositories(parsed.root, {
    only: parsed.only,
    exclude: parsed.exclude,
    includeCurrent: parsed.includeCurrent,
    includeHidden: parsed.includeHidden
  });

  const actions = {
    sync: runSync,
    status: runStatus,
    fetch: runFetch,
    branches: runBranches,
    list: runList,
    dirty: runDirty
  };

  const action = actions[parsed.command];
  if (!action) {
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  // io.gitRunner / io.fetchRepo are test hooks: they let a caller observe or
  // delay the git calls the pool makes without global mocking.
  const actionOptions = { ...parsed };
  if (io.gitRunner) {
    actionOptions.gitRunner = io.gitRunner;
  }
  if (io.fetchRepo) {
    actionOptions.fetchRepo = io.fetchRepo;
  }
  const results = await action(repos, actionOptions);
  const exitCode = determineExitCode(parsed.command, results, parsed.strict);

  if (parsed.json) {
    io.out(
      JSON.stringify(
        {
          command: parsed.command,
          root: parsed.root,
          strict: parsed.strict,
          repoCount: repos.length,
          exitCode,
          results
        },
        null,
        2
      )
    );
    return exitCode;
  }

  printResults(parsed.command, results, io);
  return exitCode;
}

function defaultIo() {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line)
  };
}

function parseArgs(argv) {
  const parsed = {
    command: "sync",
    root: process.cwd(),
    protectedBranches: [...DEFAULT_PROTECTED_BRANCHES],
    protectedBranchesExplicit: false,
    only: [],
    exclude: [],
    includeCurrent: false,
    includeHidden: false,
    includeDirty: false,
    strict: false,
    dryRun: false,
    json: false,
    fetch: false,
    fetchConcurrency: undefined,
    help: false
  };

  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }

    if (token === "--include-current") {
      parsed.includeCurrent = true;
      continue;
    }

    if (token === "--include-hidden") {
      parsed.includeHidden = true;
      continue;
    }

    if (token === "--include-dirty") {
      parsed.includeDirty = true;
      continue;
    }

    if (token === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (token === "--strict") {
      parsed.strict = true;
      continue;
    }

    if (token === "--json") {
      parsed.json = true;
      continue;
    }

    if (token === "--fetch") {
      parsed.fetch = true;
      continue;
    }

    if (token === "--concurrency") {
      index += 1;
      parsed.fetchConcurrency = parseConcurrency(
        resolveRequiredValue(argv, index, "--concurrency")
      );
      continue;
    }

    if (token.startsWith("--concurrency=")) {
      parsed.fetchConcurrency = parseConcurrency(token.slice("--concurrency=".length));
      continue;
    }

    if (token === "--root") {
      index += 1;
      parsed.root = resolveRequiredValue(argv, index, "--root");
      continue;
    }

    if (token.startsWith("--root=")) {
      parsed.root = token.slice("--root=".length);
      continue;
    }

    if (token === "--protected") {
      index += 1;
      parsed.protectedBranches = splitCommaList(
        resolveRequiredValue(argv, index, "--protected")
      );
      parsed.protectedBranchesExplicit = true;
      continue;
    }

    if (token.startsWith("--protected=")) {
      parsed.protectedBranches = splitCommaList(
        token.slice("--protected=".length)
      );
      parsed.protectedBranchesExplicit = true;
      continue;
    }

    if (token === "--only") {
      index += 1;
      parsed.only.push(...splitCommaList(resolveRequiredValue(argv, index, "--only")));
      continue;
    }

    if (token.startsWith("--only=")) {
      parsed.only.push(...splitCommaList(token.slice("--only=".length)));
      continue;
    }

    if (token === "--exclude") {
      index += 1;
      parsed.exclude.push(
        ...splitCommaList(resolveRequiredValue(argv, index, "--exclude"))
      );
      continue;
    }

    if (token.startsWith("--exclude=")) {
      parsed.exclude.push(...splitCommaList(token.slice("--exclude=".length)));
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    }

    positionals.push(token);
  }

  const knownCommands = new Set([
    "sync",
    "status",
    "fetch",
    "branches",
    "list",
    "dirty"
  ]);

  if (positionals.length > 0) {
    if (knownCommands.has(positionals[0])) {
      parsed.command = positionals[0];
      if (positionals.length > 1) {
        parsed.root = positionals[1];
      }
      if (positionals.length > 2) {
        throw new Error(
          `Unexpected positional arguments: ${positionals.slice(2).join(" ")}`
        );
      }
    } else {
      parsed.root = positionals[0];
      if (positionals.length > 1) {
        throw new Error(
          `Unexpected positional arguments: ${positionals.slice(1).join(" ")}`
        );
      }
    }
  }

  parsed.root = resolveCliPath(parsed.root);
  validateFilterPatterns(parsed.only, "--only");
  validateFilterPatterns(parsed.exclude, "--exclude");
  return parsed;
}

function parseConcurrency(value) {
  if (!/^\d+$/.test(String(value).trim())) {
    throw new Error(`Invalid value for --concurrency: ${value}`);
  }
  const numeric = Number.parseInt(String(value).trim(), 10);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`Invalid value for --concurrency: ${value}`);
  }
  return numeric;
}

function resolveRequiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function resolveCliPath(value) {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }

  return path.resolve(value);
}

function splitCommaList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function helpText() {
  return [
    "git-batch",
    "",
    "Batch commands for all git repositories directly below a folder.",
    "",
    "Usage:",
    "  git-batch [command] [root] [options]",
    "",
    "Commands:",
    "  sync       Check for local changes, switch to a protected branch, fast-forward",
    "  status     Show branch and worktree status for each repository",
    "  fetch      Run git fetch --all --prune for each repository",
    "  branches   Show current branch and detected protected branch",
    "  list       List discovered repositories on the current level",
    "  dirty      Show only repositories with local changes",
    "",
    "Options:",
    "  --root <path>             Root folder to scan, defaults to cwd",
    "  --protected <a,b,c>       Preferred protected branches",
    "  --only <a,b,c>            Include only matching repository names",
    "  --exclude <a,b,c>         Exclude matching repository names",
    "  --include-current         Include the current folder if it is a git repo",
    "  --include-hidden          Include hidden child directories",
    "  --include-dirty           Allow sync for dirty repositories",
    "  --strict                  Return non-zero for actionable problem states",
    "  --dry-run                 Print planned git actions without executing them",
    "  --json                    Emit JSON instead of text",
    "  --fetch                   (status) Run git fetch --quiet per repo first",
    "  --concurrency <n>         Repositories processed in parallel by sync, fetch and",
    "                            status --fetch (default 8)",
    "  --help                    Show this help",
    "",
    "Examples:",
    "  git-batch sync ~/git",
    "  git-batch status ~/git/pandora",
    "  git-batch fetch --include-current",
    "  git-batch sync --protected main,develop --dry-run",
    "  git-batch sync ~/git --only api,web",
    "  git-batch dirty ~/git --exclude '/^archive-/'",
    "  git-batch list ~/git",
    "  git-batch dirty ~/git"
  ].join("\n");
}

function discoverRepositories(root, options) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const repos = [];
  const includePatterns = compilePatterns(options.only || [], "--only");
  const excludePatterns = compilePatterns(options.exclude || [], "--exclude");

  if (options.includeCurrent && looksLikeGitRepo(root)) {
    repos.push(buildRepoDescriptor(root));
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (!options.includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    const repoPath = path.join(root, entry.name);
    if (!looksLikeGitRepo(repoPath)) {
      continue;
    }

    repos.push(buildRepoDescriptor(repoPath));
  }

  return repos
    .filter((repo) =>
      matchesRepoFilters(repo.name, {
        includePatterns,
        excludePatterns
      })
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function looksLikeGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
}

function buildRepoDescriptor(repoPath) {
  return {
    name: path.basename(repoPath),
    path: repoPath
  };
}

function matchesRepoFilters(repoName, options) {
  const includePatterns = options.includePatterns || [];
  const excludePatterns = options.excludePatterns || [];

  if (
    includePatterns.length > 0 &&
    !includePatterns.some((pattern) => pattern.test(repoName))
  ) {
    return false;
  }

  if (excludePatterns.some((pattern) => pattern.test(repoName))) {
    return false;
  }

  return true;
}

function compilePatterns(values) {
  return values.map((value) => compilePattern(value));
}

function compilePattern(value) {
  const regexLiteral = value.match(/^\/(.+)\/([a-z]*)$/i);
  try {
    if (regexLiteral) {
      return new RegExp(regexLiteral[1], regexLiteral[2]);
    }

    return new RegExp(escapeRegex(value), "i");
  } catch (error) {
    throw new Error(`Invalid repository filter pattern: ${value}`);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateFilterPatterns(values, optionName) {
  for (const value of values) {
    try {
      compilePattern(value);
    } catch (error) {
      throw new Error(`Invalid value for ${optionName}: ${value}`);
    }
  }
}

async function runStatus(repos, options) {
  const context = createRunContext();
  const fetchFailures = options.fetch
    ? await fetchReposQuiet(repos, options, context)
    : new Map();

  return repos.map((repo) => {
    try {
      const status = collectRepoStatus(repo.path);
      const upstream = collectUpstreamState(repo.path);
      const targetBranch = detectProtectedBranch(repo.path, options.protectedBranches, {
        preferConfigured: options.protectedBranchesExplicit
      });
      const target = collectTargetState(repo.path, targetBranch);
      const location = collectWorktreeLocation(repo.path, context);
      return {
        repo: repo.name,
        path: repo.path,
        currentBranch: status.branch,
        targetBranch,
        upstream: upstream.upstream,
        ahead: upstream.ahead,
        behind: upstream.behind,
        clean: status.clean,
        counts: status.counts,
        outcome: fetchFailures.get(repo.path) ? "fetch_failed" : "ok",
        targetRef: target.targetRef,
        targetSha: target.targetSha,
        headSha: target.headSha,
        aheadOfTarget: target.aheadOfTarget,
        behindTarget: target.behindTarget,
        commonDir: location.commonDir,
        worktree: location.worktree
      };
    } catch (error) {
      return repoError(repo, error);
    }
  });
}

async function fetchReposQuiet(repos, options, context = createRunContext()) {
  const fetchRepo = options.fetchRepo || fetchRepoQuiet;
  const fetchConcurrency = normalizeFetchConcurrency(options.fetchConcurrency);
  const fetchFailures = new Map();

  await runParallelLimit(repos, fetchConcurrency, async (repo) => {
    // Linked worktrees of one repository share a ref store; fetch it once
    // and let the siblings reuse that outcome instead of racing on ref locks.
    const key = resolveCommonDir(repo.path, context);
    let entry = context.shared.get(key);
    if (!entry) {
      entry = { owner: repo.name, promise: Promise.resolve(fetchRepo(repo.path, options)) };
      context.shared.set(key, entry);
    }
    const fetched = await entry.promise;
    fetchFailures.set(repo.path, !fetched);
  });

  return fetchFailures;
}

// HEAD against refs/remotes/origin/<target branch>, independent of the
// branch upstream. Everything stays null when there is no target or its
// remote-tracking ref is missing; headSha is null only for an unborn HEAD.
function collectTargetState(repoPath, targetBranch) {
  const empty = {
    targetRef: null,
    targetSha: null,
    headSha: null,
    aheadOfTarget: null,
    behindTarget: null
  };
  const SHA = /^[0-9a-f]{40,64}$/;
  const targetRef = targetBranch ? `refs/remotes/origin/${targetBranch}` : null;

  // Common case, one call: HEAD and the target ref both resolve.
  if (targetRef) {
    const both = runGit(repoPath, ["rev-parse", "HEAD^{commit}", `${targetRef}^{commit}`], {
      allowFailure: true
    });
    const lines = both.stdout.split("\n").map((l) => l.trim());
    if (both.code === 0 && SHA.test(lines[0]) && SHA.test(lines[1])) {
      const [headSha, targetSha] = lines;
      if (headSha === targetSha) {
        return { targetRef, targetSha, headSha, aheadOfTarget: 0, behindTarget: 0 };
      }
      const counts = runGit(
        repoPath,
        ["rev-list", "--left-right", "--count", `HEAD...${targetRef}`],
        { allowFailure: true }
      );
      const match = counts.code === 0 ? counts.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
      return {
        targetRef,
        targetSha,
        headSha,
        aheadOfTarget: match ? Number(match[1]) : null,
        behindTarget: match ? Number(match[2]) : null
      };
    }
  }

  const head = runGit(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    allowFailure: true
  });
  const headSha = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null;
  if (!targetRef) {
    return { ...empty, headSha };
  }
  const resolved = runGit(
    repoPath,
    ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`],
    { allowFailure: true }
  );
  const targetSha = resolved.code === 0 && resolved.stdout.trim() ? resolved.stdout.trim() : null;
  if (!targetSha) {
    return { ...empty, headSha };
  }
  if (headSha) {
    const counts = runGit(
      repoPath,
      ["rev-list", "--left-right", "--count", `HEAD...${targetRef}`],
      { allowFailure: true }
    );
    const match = counts.code === 0 ? counts.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
    return {
      targetRef,
      targetSha,
      headSha,
      aheadOfTarget: match ? Number(match[1]) : null,
      behindTarget: match ? Number(match[2]) : null
    };
  }
  // Unborn HEAD: the target is known, there is no distance to measure.
  return { ...empty, targetRef, targetSha };
}

// commonDir is shared by a repository and its linked worktrees; worktree is
// true for a linked worktree and false for the main checkout.
function collectWorktreeLocation(repoPath, context) {
  const { gitDir, commonDir } = resolveGitLocation(repoPath, context);
  return { commonDir, worktree: gitDir !== null && gitDir !== commonDir };
}

function collectUpstreamState(repoPath) {
  const upstreamRef = runGit(
    repoPath,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true }
  );
  if (upstreamRef.code !== 0) {
    return { upstream: null, ahead: null, behind: null };
  }
  const upstream = upstreamRef.stdout.trim();
  if (!upstream) {
    return { upstream: null, ahead: null, behind: null };
  }

  const counts = runGit(
    repoPath,
    ["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
    { allowFailure: true }
  );
  if (counts.code !== 0) {
    // Rare: upstream branch config points at a remote-tracking ref
    // whose commits are no longer reachable locally (object pruned by
    // aggressive GC, interrupted fetch, manually deleted ref). The
    // common `upstream configured but never fetched` case fails one
    // step earlier, at the `@{upstream}` resolution above. Report the
    // configured name so callers can at least see a tracking branch
    // was requested, distinct from `null` which means "no upstream at
    // all".
    return { upstream, ahead: null, behind: null };
  }
  const match = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return { upstream, ahead: null, behind: null };
  }
  return {
    upstream,
    ahead: Number.parseInt(match[1], 10),
    behind: Number.parseInt(match[2], 10)
  };
}

// Status fetch, in this order, so the target distance reflects the remote:
// 1. plain `git fetch` (the branch's own remote through its configured refspec);
// 2. `git fetch origin` when the branch tracks another remote (a fork), since
//    plain fetch never touches origin then;
// 3. an explicit refspec for refs/remotes/origin/<target> when origin's
//    configured refspec does not map the detected target branch. The target
//    is detected after steps 1 and 2 so it sees the refreshed refs.
// A target missing on the remote is not a fetch failure.
async function fetchRepoQuiet(repoPath, options = {}) {
  const plain = await runGitAsync(repoPath, ["fetch", "--quiet"], { allowFailure: true });
  if (plain.code !== 0) {
    return false;
  }
  const hasOrigin =
    runGit(repoPath, ["config", "--get", "remote.origin.url"], { allowFailure: true }).code === 0;
  if (!hasOrigin) {
    return true;
  }

  const head = runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowFailure: true
  });
  const current = head.code === 0 ? head.stdout.trim() : "";
  const remote = current
    ? runGit(repoPath, ["config", "--get", `branch.${current}.remote`], { allowFailure: true })
    : { code: 1, stdout: "" };
  const trackedRemote = remote.code === 0 ? remote.stdout.trim() : "";
  if (trackedRemote && trackedRemote !== "origin" && trackedRemote !== ".") {
    const viaOrigin = await runGitAsync(repoPath, ["fetch", "--quiet", "origin"], {
      allowFailure: true
    });
    if (viaOrigin.code !== 0) {
      return false;
    }
  }

  const targetBranch = detectProtectedBranch(repoPath, options.protectedBranches || [], {
    preferConfigured: options.protectedBranchesExplicit
  });
  if (targetBranch && targetRefspecMissing(repoPath, targetBranch)) {
    const targeted = await runGitAsync(
      repoPath,
      [
        "fetch",
        "--quiet",
        "origin",
        `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`
      ],
      { allowFailure: true }
    );
    if (targeted.code !== 0 && !/couldn't find remote ref/i.test(targeted.stderr || "")) {
      return false;
    }
  }
  return true;
}

function runBranches(repos, options) {
  return repos.map((repo) => {
    try {
      return {
        repo: repo.name,
        path: repo.path,
        currentBranch: safeBranch(repo.path),
        targetBranch: detectProtectedBranch(repo.path, options.protectedBranches, {
          preferConfigured: options.protectedBranchesExplicit
        }),
        outcome: "ok"
      };
    } catch (error) {
      return repoError(repo, error);
    }
  });
}

async function runFetch(repos, options) {
  const context = createRunContext();
  return runParallelLimit(repos, normalizeFetchConcurrency(options.fetchConcurrency), async (repo) => {
    const result = {
      repo: repo.name,
      path: repo.path,
      actions: [],
      outcome: "ok"
    };

    try {
      await executeSharedGitCommand(repo, ["fetch", "--all", "--prune"], options, result, context);
      return result;
    } catch (error) {
      return repoError(repo, error, result.actions);
    }
  });
}

function runList(repos) {
  return repos.map((repo) => ({
    repo: repo.name,
    path: repo.path,
    outcome: "ok"
  }));
}

function runDirty(repos, options) {
  return repos
    .map((repo) => {
      try {
        const status = collectRepoStatus(repo.path);
        return {
          repo: repo.name,
          path: repo.path,
          currentBranch: status.branch,
          clean: status.clean,
          counts: status.counts,
          outcome: "ok"
        };
      } catch (error) {
        return repoError(repo, error);
      }
    })
    .filter((entry) => entry.outcome === "error" || !entry.clean);
}

async function runSync(repos, options) {
  const context = createRunContext();
  return runParallelLimit(repos, normalizeFetchConcurrency(options.fetchConcurrency), async (repo) => {
    try {
      return await syncRepository(repo, options, context);
    } catch (error) {
      return repoError(repo, error);
    }
  });
}

async function syncRepository(repo, options, context = createRunContext()) {
  const status = collectRepoStatus(repo.path);
  const result = {
    repo: repo.name,
    path: repo.path,
    currentBranch: status.branch,
    clean: status.clean,
    counts: status.counts,
    targetBranch: null,
    reason: null,
    outcome: "ok",
    actions: []
  };

  if (!status.clean && !options.includeDirty) {
    result.outcome = "skipped_dirty";
    result.reason = "worktree_dirty";
    return result;
  }

  await executeSharedGitCommand(repo, ["fetch", "--all", "--prune"], options, result, context);

  const targetBranch = detectProtectedBranch(repo.path, options.protectedBranches, {
    preferConfigured: options.protectedBranchesExplicit,
    requireRemote: true
  });
  result.targetBranch = targetBranch;

  if (!targetBranch) {
    result.outcome = "skipped_no_protected_branch";
    result.reason = "no_remote_protected_branch_detected";
    return result;
  }

  // `fetch --all` only refreshes origin/<target> when origin is not skipped
  // and its fetch refspec maps the branch. Otherwise fetch just that branch,
  // as the old `git pull` implicitly did.
  if (needsTargetFetch(repo.path, targetBranch)) {
    await executeSharedGitCommand(
      repo,
      ["fetch", "origin", `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`],
      options,
      result,
      context
    );
  }

  await ensureCheckedOut(repo.path, status.branch, targetBranch, options, result);
  // The fetch above already updated origin/<target>; merging the local
  // remote-tracking ref avoids a second network roundtrip that
  // `git pull` would make. The fully qualified ref cannot be shadowed by a
  // local branch or tag named origin/<target>.
  await executeGitCommand(
    repo.path,
    ["merge", "--ff-only", `refs/remotes/origin/${targetBranch}`],
    options,
    result
  );

  result.currentBranch = targetBranch;
  return result;
}

function collectRepoStatus(repoPath) {
  const raw = runGit(repoPath, ["status", "--short", "--branch"]);
  const lines = raw.stdout.trim() ? raw.stdout.trim().split("\n") : [];
  const branchLine = lines.shift() || "";
  const branch = parseBranchLine(branchLine);
  const counts = {
    staged: 0,
    unstaged: 0,
    untracked: 0
  };

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.startsWith("??")) {
      counts.untracked += 1;
      continue;
    }

    const stagedCode = line[0];
    const unstagedCode = line[1];

    if (stagedCode && stagedCode !== " ") {
      counts.staged += 1;
    }

    if (unstagedCode && unstagedCode !== " ") {
      counts.unstaged += 1;
    }
  }

  return {
    branch,
    counts,
    clean:
      counts.staged === 0 && counts.unstaged === 0 && counts.untracked === 0
  };
}

function parseBranchLine(branchLine) {
  if (!branchLine.startsWith("## ")) {
    return "unknown";
  }

  const branchText = branchLine.slice(3);
  if (branchText.startsWith("No commits yet on ")) {
    return branchText.slice("No commits yet on ".length);
  }

  if (branchText.startsWith("HEAD (no branch)")) {
    return "detached";
  }

  return branchText.split("...")[0];
}

function detectProtectedBranch(repoPath, protectedBranches, options = {}) {
  const configuredBranch = findConfiguredProtectedBranch(
    repoPath,
    protectedBranches,
    options
  );
  const originHead = options.preferConfigured
    ? null
    : resolveOriginHeadBranch(repoPath, options);

  if (options.preferConfigured && configuredBranch) {
    return configuredBranch;
  }

  if (options.preferConfigured) {
    return null;
  }

  if (originHead) {
    return originHead;
  }

  if (configuredBranch) {
    return configuredBranch;
  }

  return null;
}

function findConfiguredProtectedBranch(repoPath, protectedBranches, options = {}) {
  for (const branch of protectedBranches) {
    if (hasProtectedBranch(repoPath, branch, options)) {
      return branch;
    }
  }

  return null;
}

function hasProtectedBranch(repoPath, branch, options = {}) {
  if (options.requireRemote) {
    return hasRemoteBranch(repoPath, branch);
  }

  return hasLocalBranch(repoPath, branch) || hasRemoteBranch(repoPath, branch);
}

function resolveOriginHeadBranch(repoPath, options = {}) {
  const result = runGit(
    repoPath,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    {
      allowFailure: true
    }
  );

  if (result.code !== 0) {
    return null;
  }

  const ref = result.stdout.trim();
  if (!ref.startsWith("origin/")) {
    return null;
  }

  const branch = ref.slice("origin/".length);
  if (options.requireRemote && !hasRemoteBranch(repoPath, branch)) {
    return null;
  }

  return branch;
}

function hasLocalBranch(repoPath, branch) {
  return (
    runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      allowFailure: true
    }).code === 0
  );
}

function hasRemoteBranch(repoPath, branch) {
  return (
    runGit(
      repoPath,
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      {
        allowFailure: true
      }
    ).code === 0
  );
}

async function ensureCheckedOut(repoPath, currentBranch, targetBranch, options, result) {
  if (currentBranch === targetBranch) {
    return;
  }

  if (hasLocalBranch(repoPath, targetBranch)) {
    await executeGitCommand(repoPath, ["checkout", targetBranch], options, result);
    return;
  }

  if (hasRemoteBranch(repoPath, targetBranch)) {
    await executeGitCommand(
      repoPath,
      ["checkout", "-b", targetBranch, "--track", `origin/${targetBranch}`],
      options,
      result
    );
    return;
  }

  throw new Error(`Branch ${targetBranch} does not exist in ${repoPath}`);
}

async function executeGitCommand(repoPath, args, options, result) {
  result.actions.push({
    command: ["git", ...args].join(" "),
    dryRun: options.dryRun
  });

  if (options.dryRun) {
    return;
  }

  // Network-touching and mutating calls run through the async runner so
  // the parallel pool can overlap them; options.gitRunner lets tests
  // observe or delay them.
  const runner = options.gitRunner || runGitAsync;
  const execution = await runner(repoPath, args);
  if (execution.code !== 0) {
    const stderr = execution.stderr.trim() || execution.stdout.trim();
    throw new Error(`${path.basename(repoPath)}: ${stderr}`);
  }
}

function createRunContext() {
  return { shared: new Map(), locations: new Map() };
}

// Realpath of the git common dir: linked worktrees of one repository share
// it (and so the ref store). Falls back to the repo path when git cannot say.
function resolveCommonDir(repoPath, context) {
  return resolveGitLocation(repoPath, context).commonDir;
}

// One rev-parse call for the git dir and the common dir, cached per repo path
// in the run context. gitDir is null when git cannot say.
function resolveGitLocation(repoPath, context) {
  if (context.locations.has(repoPath)) {
    return context.locations.get(repoPath);
  }
  let location = { gitDir: null, commonDir: repoPath };
  try {
    const out = runGit(repoPath, ["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
      allowFailure: true
    });
    const lines = out.code === 0 ? out.stdout.split("\n").map((l) => l.trim()) : [];
    if (lines.length >= 2 && lines[0] && lines[1]) {
      location = {
        gitDir: fs.realpathSync(lines[0]),
        commonDir: fs.realpathSync(path.resolve(repoPath, lines[1]))
      };
    }
  } catch (error) {
    location = { gitDir: null, commonDir: repoPath };
  }
  context.locations.set(repoPath, location);
  return location;
}

// Runs a network git command once per git common dir and run. The first repo
// to ask executes it; siblings record a skipped action naming that repo and
// wait for its outcome, so their checkout/merge happens after the fetch and
// a failed fetch fails them too.
async function executeSharedGitCommand(repo, args, options, result, context) {
  const key = `${resolveCommonDir(repo.path, context)}\0${args.join(" ")}`;
  const existing = context.shared.get(key);
  if (!existing) {
    const entry = { owner: repo.name, promise: null };
    context.shared.set(key, entry);
    entry.promise = executeGitCommand(repo.path, args, options, result);
    await entry.promise;
    return;
  }

  result.actions.push({
    command: ["git", ...args].join(" "),
    dryRun: options.dryRun,
    skipped: true,
    sharedWith: existing.owner
  });
  await existing.promise;
}

// True when `git fetch --all` will not refresh refs/remotes/origin/<branch>.
function needsTargetFetch(repoPath, branch) {
  const skipAll = runGit(repoPath, ["config", "--type=bool", "--get", "remote.origin.skipFetchAll"], {
    allowFailure: true
  });
  if (skipAll.code === 0 && skipAll.stdout.trim() === "true") {
    return true;
  }
  return targetRefspecMissing(repoPath, branch);
}

// True when origin's configured fetch refspecs do not map the branch onto
// refs/remotes/origin/<branch> (no mapping, or an exclusion matches).
function targetRefspecMissing(repoPath, branch) {
  const refspecs = runGit(repoPath, ["config", "--get-all", "remote.origin.fetch"], {
    allowFailure: true
  });
  const specs = refspecs.code === 0 ? refspecs.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  const ref = `refs/heads/${branch}`;
  const excluded = specs.some(
    (spec) => spec.startsWith("^") && matchRefPattern(spec.slice(1), ref) !== null
  );
  if (excluded) {
    return true;
  }
  return !specs.some((spec) => refspecMapsBranch(spec, branch));
}

function matchRefPattern(pattern, ref) {
  const star = pattern.indexOf("*");
  if (star === -1) {
    return pattern === ref ? "" : null;
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (ref.length < prefix.length + suffix.length || !ref.startsWith(prefix) || !ref.endsWith(suffix)) {
    return null;
  }
  return ref.slice(prefix.length, ref.length - suffix.length);
}

function refspecMapsBranch(refspec, branch) {
  let spec = refspec.trim();
  if (!spec || spec.startsWith("^")) {
    return false;
  }
  if (spec.startsWith("+")) {
    spec = spec.slice(1);
  }
  const colon = spec.indexOf(":");
  if (colon === -1) {
    return false;
  }
  const captured = matchRefPattern(spec.slice(0, colon), `refs/heads/${branch}`);
  if (captured === null) {
    return false;
  }
  return spec.slice(colon + 1).replace("*", captured) === `refs/remotes/origin/${branch}`;
}

function safeBranch(repoPath) {
  try {
    return collectRepoStatus(repoPath).branch;
  } catch (error) {
    return "unknown";
  }
}

function runGit(repoPath, args, extraOptions = {}) {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    return {
      code: 0,
      stdout,
      stderr: ""
    };
  } catch (error) {
    if (extraOptions.allowFailure) {
      return {
        code: typeof error.status === "number" ? error.status : 1,
        stdout: error.stdout ? String(error.stdout) : "",
        stderr: error.stderr ? String(error.stderr) : ""
      };
    }

    const stderr = error.stderr ? String(error.stderr).trim() : "";
    const stdout = error.stdout ? String(error.stdout).trim() : "";
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }
}

function runGitAsync(repoPath, args, extraOptions = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (extraOptions.allowFailure) {
        resolve({ code: 1, stdout, stderr: stderr || String(error) });
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : 1;
      if (exitCode === 0 || extraOptions.allowFailure) {
        resolve({ code: exitCode, stdout, stderr });
        return;
      }

      const stderrText = stderr.trim();
      const stdoutText = stdout.trim();
      reject(new Error(stderrText || stdoutText || `git ${args.join(" ")} failed`));
    });
  });
}

function normalizeFetchConcurrency(value) {
  const numeric = Number.isInteger(value) ? value : Number.parseInt(String(value || ""), 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return DEFAULT_FETCH_CONCURRENCY;
}

async function runParallelLimit(items, limit, worker) {
  if (items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}

function normalizeCounts(counts) {
  return {
    staged: counts && typeof counts.staged === "number" ? counts.staged : 0,
    unstaged: counts && typeof counts.unstaged === "number" ? counts.unstaged : 0,
    untracked: counts && typeof counts.untracked === "number" ? counts.untracked : 0
  };
}

function printResults(command, results, io) {
  if (results.length === 0) {
    io.out("No git repositories found on this level.");
    return;
  }

  if (command === "status") {
    for (const entry of results) {
      if (entry.outcome === "error") {
        io.out(`${entry.repo}: outcome=error message=${entry.error}`);
        continue;
      }
      const counts = normalizeCounts(entry.counts);
      const outcomeSuffix = entry.outcome && entry.outcome !== "ok"
        ? ` outcome=${entry.outcome}`
        : "";
      io.out(
        `${entry.repo}: branch=${entry.currentBranch} target=${entry.targetBranch || "-"} upstream=${entry.upstream || "-"} ahead=${formatCount(entry.ahead)} behind=${formatCount(entry.behind)} clean=${entry.clean} staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}${outcomeSuffix} target_ref=${entry.targetRef || "-"} target_sha=${shortSha(entry.targetSha)} head_sha=${shortSha(entry.headSha)} ahead_of_target=${formatCount(entry.aheadOfTarget)} behind_target=${formatCount(entry.behindTarget)} worktree=${entry.worktree === true} common_dir=${formatTextValue(entry.commonDir)}`
      );
    }
    return;
  }

  if (command === "branches") {
    for (const entry of results) {
      if (entry.outcome === "error") {
        io.out(`${entry.repo}: outcome=error message=${entry.error}`);
        continue;
      }
      io.out(
        `${entry.repo}: current=${entry.currentBranch} target=${entry.targetBranch || "-"}`
      );
    }
    return;
  }

  if (command === "fetch") {
    for (const entry of results) {
      if (entry.outcome === "error") {
        io.out(`${entry.repo}: outcome=error message=${entry.error}`);
        continue;
      }
      io.out(`${entry.repo}: ${renderActions(entry.actions)}`);
    }
    return;
  }

  if (command === "list") {
    for (const entry of results) {
      if (entry.outcome === "error") {
        io.out(`${entry.repo}: outcome=error message=${entry.error}`);
        continue;
      }
      io.out(`${entry.repo}: ${entry.path}`);
    }
    return;
  }

  if (command === "dirty") {
    if (results.length === 0) {
      io.out("No repositories with local changes found.");
      return;
    }

    for (const entry of results) {
      if (entry.outcome === "error") {
        io.out(`${entry.repo}: outcome=error message=${entry.error}`);
        continue;
      }
      const counts = normalizeCounts(entry.counts);
      io.out(
        `${entry.repo}: branch=${entry.currentBranch} staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`
      );
    }
    return;
  }

  for (const entry of results) {
    if (entry.outcome === "error") {
      io.out(`${entry.repo}: outcome=error message=${entry.error}`);
      continue;
    }
    const counts = normalizeCounts(entry.counts);
    const reasonText = entry.reason ? ` reason=${entry.reason}` : "";
    io.out(
      `${entry.repo}: outcome=${entry.outcome} current=${entry.currentBranch} target=${entry.targetBranch || "-"} clean=${entry.clean} staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}${reasonText}`
    );
    if (entry.actions && entry.actions.length > 0) {
      io.out(`  ${renderActions(entry.actions)}`);
    }
  }
}

function repoError(repo, error, actions = []) {
  return {
    repo: repo.name,
    path: repo.path,
    outcome: "error",
    error: error && error.message ? error.message : String(error),
    actions
  };
}

function determineExitCode(command, results, strict) {
  if (results.some((entry) => entry.outcome === "error")) {
    return 1;
  }

  if (!strict) {
    return 0;
  }

  if (results.length === 0) {
    return 0;
  }

  if (command === "sync") {
    return results.some((entry) => entry.outcome !== "ok") ? 1 : 0;
  }

  if (command === "status") {
    return results.some((entry) => entry.clean === false) ? 1 : 0;
  }

  if (command === "dirty") {
    return results.length > 0 ? 1 : 0;
  }

  if (command === "branches") {
    return results.some((entry) => !entry.targetBranch) ? 1 : 0;
  }

  return 0;
}

function renderActions(actions) {
  return actions
    .map((action) => (action.skipped ? `${action.command} (shared with ${action.sharedWith})` : action.command))
    .join(" -> ");
}

// A value containing whitespace is double-quoted (JSON string escaping) so
// the row still splits into key=value pairs on whitespace outside quotes.
function formatTextValue(value) {
  if (!value) {
    return "-";
  }
  return /\s|"/.test(value) ? JSON.stringify(value) : value;
}

function shortSha(value) {
  return value ? value.slice(0, 7) : "-";
}

function formatCount(value) {
  return value === null || value === undefined ? "-" : String(value);
}

module.exports = {
  DEFAULT_PROTECTED_BRANCHES,
  collectRepoStatus,
  collectUpstreamState,
  detectProtectedBranch,
  determineExitCode,
  discoverRepositories,
  helpText,
  main,
  parseArgs,
  printResults,
  resolveCliPath,
  runDirty,
  runFetch,
  runList,
  runStatus,
  runSync
};
