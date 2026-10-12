import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../envelope.js";
import { runGit, type GitRunResult } from "../drift/git.js";
import { withoutRepoSelectionEnv } from "../git-env.js";
import { probeGitArgv } from "../probe/git.js";

/**
 * Helpers shared by every `worktree` subcommand: how git is run, how the
 * main checkout of a repository is found, how the default branch is
 * resolved, and how ignore state is asked. Kept apart from `create.ts` so
 * the subcommands that follow it (`remove`, `list`) can reuse them
 * instead of growing a second copy.
 */

/** The stable machine-readable code of a refusal, carried as `reason` in
 * the envelope. One code per distinct cause, so a caller can branch on it
 * without parsing the message. */
export type WorktreeRefusalReason =
  | "not_a_git_repo"
  | "bare_repository"
  | "branch_invalid"
  | "branch_exists"
  | "branch_checked_out"
  | "target_exists"
  | "target_inside_checkout"
  | "target_inside_worktree"
  | "path_and_root_conflict"
  | "base_not_found"
  | "default_branch_unresolved"
  | "fetch_failed"
  | "run_dir_missing"
  | "link_invalid"
  | "links_file_unreadable"
  | "links_file_inside_repo"
  | "option_invalid"
  | "worktree_add_failed"
  | "not_a_worktree"
  | "remove_main_checkout"
  | "worktree_locked"
  | "worktree_dirty"
  | "status_unknown"
  | "unpushed_state_unknown"
  | "nested_worktree"
  | "has_submodules"
  | "unpushed_commits"
  | "branch_not_merged"
  | "merge_state_unknown"
  | "default_branch_delete"
  | "worktree_remove_failed";

/** A precondition that was not met. Nothing has been changed when one is
 * thrown, with the single exception of `worktree_add_failed` and
 * `fetch_failed`, which name git's own failure. Reported as
 * `status: "usage_error"` (exit 2) with the `reason` and, when present,
 * the structured `details`. */
export class WorktreeRefusal extends UsageError {
  constructor(
    message: string,
    public readonly reason: WorktreeRefusalReason,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** One generous bound for the network step so a dead remote cannot hang
 * the command for good. */
export const FETCH_TIMEOUT_MS = 120_000;

/** Runs `git <args>` in `cwd` with the repository-selection environment
 * removed. Process-wide maintenance is switched off for the call (the
 * same settings `probe` uses), so a fetch or an add cannot leave a
 * background `gc` touching a repository while the caller reads it. */
export function git(
  cwd: string,
  args: readonly string[],
  timeoutMs?: number,
): GitRunResult {
  return runGit(cwd, probeGitArgv(args), withoutRepoSelectionEnv(), timeoutMs);
}

/** Trimmed stdout of a successful git call, otherwise `undefined`. */
export function gitText(
  cwd: string,
  args: readonly string[],
): string | undefined {
  const r = git(cwd, args);
  if (r.error !== undefined || r.status !== 0) return undefined;
  return r.stdout.trim();
}

/** The message to show for a failed git call: its stderr, or its spawn
 * error, or the exit status. */
export function gitFailure(r: GitRunResult): string {
  const text = r.stderr.trim();
  if (text.length > 0) return text;
  if (r.error !== undefined) return r.error;
  return `git exited with status ${String(r.status)}`;
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  head?: string;
  /** Short branch name, absent when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  /** git considers the entry stale (its directory is gone). */
  prunable: boolean;
  locked: boolean;
}

/** Parses `git worktree list --porcelain`. The first entry is always the
 * main working tree (or the bare repository). */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const entry: WorktreeEntry = {
      path: "",
      bare: false,
      detached: false,
      prunable: false,
      locked: false,
    };
    for (const line of lines) {
      if (line.startsWith("worktree ")) entry.path = line.slice(9);
      else if (line.startsWith("HEAD ")) entry.head = line.slice(5);
      else if (line.startsWith("branch ")) {
        entry.branch = line.slice(7).replace(/^refs\/heads\//, "");
      } else if (line === "bare") entry.bare = true;
      else if (line === "detached") entry.detached = true;
      else if (line.startsWith("prunable")) entry.prunable = true;
      else if (line.startsWith("locked")) entry.locked = true;
    }
    if (entry.path.length > 0) entries.push(entry);
  }
  return entries;
}

/** The repository a `--repo` path names. */
export interface RepoContext {
  /** Real path of the top level of the checkout `--repo` points into
   * (a linked worktree when that is what was given). */
  repoRoot: string;
  /** Real path of the main working tree: the first `worktree list`
   * entry. The one checkout these commands never modify. */
  mainCheckout: string;
  /** Absolute path of the git directory every worktree shares. */
  commonDir: string;
  /** Basename of the main checkout, the `<repo>` of a `run-base` marker. */
  name: string;
  /** Every worktree git knows, main checkout first. */
  worktrees: WorktreeEntry[];
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolves `repoPath` to its repository, or refuses with
 * `not_a_git_repo` / `bare_repository`. */
export function resolveRepo(repoPath: string): RepoContext {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    stat = undefined;
  }
  if (stat === undefined || !stat.isDirectory()) {
    throw new WorktreeRefusal(
      `--repo ${repoPath} is not an existing directory`,
      "not_a_git_repo",
    );
  }
  const top = gitText(repoPath, ["rev-parse", "--show-toplevel"]);
  if (top === undefined || top.length === 0) {
    throw new WorktreeRefusal(
      `${repoPath} is not inside a git working tree`,
      "not_a_git_repo",
    );
  }
  const listing = git(repoPath, ["worktree", "list", "--porcelain"]);
  if (listing.error !== undefined || listing.status !== 0) {
    throw new WorktreeRefusal(
      `cannot list the worktrees of ${repoPath}: ${gitFailure(listing)}`,
      "not_a_git_repo",
    );
  }
  const worktrees = parseWorktreeList(listing.stdout);
  const main = worktrees[0];
  if (main === undefined || main.bare) {
    throw new WorktreeRefusal(
      `${repoPath} belongs to a bare repository; there is no main checkout to branch from`,
      "bare_repository",
    );
  }
  const common = gitText(repoPath, ["rev-parse", "--git-common-dir"]);
  if (common === undefined || common.length === 0) {
    throw new WorktreeRefusal(
      `cannot resolve the git directory of ${repoPath}`,
      "not_a_git_repo",
    );
  }
  const mainCheckout = realOrSelf(main.path);
  return {
    repoRoot: realOrSelf(top),
    mainCheckout,
    commonDir: realOrSelf(path.resolve(repoPath, common)),
    name: path.basename(mainCheckout),
    worktrees,
  };
}

/**
 * Resolves `p` through its deepest existing prefix with the platform's own
 * `realpath`, which reports the spelling the filesystem stores (so
 * `Repo` and `repo` become one string on a case-insensitive volume), and
 * puts the missing tail back unchanged. JavaScript's `realpathSync` keeps
 * the case it was given and would leave the two spellings apart.
 */
function canonicalDeepest(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(canonicalDeepest(parent), path.basename(p));
  }
}

function lexicallyWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when `a` and `b` are the same filesystem object (device and inode),
 * whatever spelling reached them. */
function sameObject(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;
}

/**
 * True when `candidate` is `root` or lies below it. Both sides are
 * canonicalised by the platform `realpath` first, so a symlinked or
 * differently cased spelling of either cannot flip the answer. As a
 * second check that does not depend on any spelling, every existing
 * ancestor of the candidate is compared with the root by device and
 * inode, which also covers a case-insensitive volume whose `realpath`
 * reports the spelling it was given.
 */
export function isWithin(root: string, candidate: string): boolean {
  const r = canonicalDeepest(path.resolve(root));
  const c = canonicalDeepest(path.resolve(candidate));
  if (lexicallyWithin(r, c)) return true;
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(r);
  } catch {
    return false;
  }
  let dir = c;
  for (;;) {
    try {
      if (sameObject(fs.statSync(dir), rootStat)) return true;
    } catch {
      // A missing component has no identity to compare; keep climbing.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The short name of the remote's default branch as `origin/<name>`
 * resolves it, or `undefined` when it cannot be told without asking the
 * remote. Reads `refs/remotes/origin/HEAD` first, then falls back to
 * `origin/main` and `origin/master`, in that order. */
export function resolveDefaultBase(
  cwd: string,
): { ref: string; source: string } | undefined {
  const head = gitText(cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (head !== undefined && head.length > 0 && refExists(cwd, head)) {
    return { ref: head, source: "origin/HEAD" };
  }
  for (const candidate of ["origin/main", "origin/master"]) {
    if (refExists(cwd, candidate)) {
      return {
        ref: candidate,
        source: `${candidate} (origin/HEAD is not set)`,
      };
    }
  }
  return undefined;
}

/** The base `--base <rev>` asks for, or `undefined` when `rev` does not
 * name a commit in the repository at `cwd` (a value starting with `-` never
 * does, so it cannot be read as a git option). The ref is `rev` as given. */
export function resolveExplicitBase(
  cwd: string,
  rev: string,
): { ref: string; source: string } | undefined {
  if (rev.startsWith("-") || !refExists(cwd, rev)) return undefined;
  return { ref: rev, source: "flag" };
}

/** True when `rev` names a commit in the repository at `cwd`. */
export function refExists(cwd: string, rev: string): boolean {
  return commitSha(cwd, rev) !== undefined;
}

/** The full commit sha `rev` resolves to, or `undefined`. */
export function commitSha(cwd: string, rev: string): string | undefined {
  const out = gitText(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}^{commit}`,
  ]);
  return out !== undefined && /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
}

/** True when the local branch `name` exists. */
export function branchExists(cwd: string, name: string): boolean {
  const r = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  return r.error === undefined && r.status === 0;
}

/**
 * Whether git ignores `rel` in the work tree at `cwd`, asked with
 * `--no-index` so a tracked path is judged by the ignore patterns alone,
 * the way a freshly created untracked path would be. `undefined` when
 * git could not answer (exit 128 or a spawn failure).
 */
export function isIgnored(cwd: string, rel: string): boolean | undefined {
  const r = git(cwd, ["check-ignore", "--no-index", "-q", "--", rel]);
  if (r.error !== undefined) return undefined;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return undefined;
}

/** Escapes the characters a gitignore pattern would read as syntax, and
 * anchors the pattern at the top of the work tree. */
export function excludePatternFor(rel: string): string {
  const escaped = rel
    .replace(/[\\*?[\]]/g, (c) => `\\${c}`)
    .replace(/^[#!]/, (c) => `\\${c}`)
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
  return `/${escaped}`;
}

/**
 * Appends `pattern` to `<commonDir>/info/exclude` (the one exclude file
 * every worktree of the repository reads) unless a line already equals
 * it. Returns whether the file changed. The newline before a pattern is
 * written in the same append, so two concurrent creators cannot glue
 * their patterns together.
 */
export function addToExclude(commonDir: string, pattern: string): boolean {
  const file = path.join(commonDir, "info", "exclude");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  if (existing.split("\n").includes(pattern)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lead = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${lead}${pattern}\n`);
  return true;
}

/** Whether `branch` is merged into `baseRef`, and how that was decided. */
export interface MergeVerdict {
  merged: "yes" | "no" | "unknown";
  /** `ancestry`: the branch tip is an ancestor of the base. `gh`: GitHub
   * lists a merged pull request for the branch (a squash merge leaves no
   * ancestry). `none`: neither could decide. */
  via: "ancestry" | "gh" | "none";
  reason: string;
}

/** Runs `gh` with a bound; `undefined` when it cannot be started. */
export function runGh(
  cwd: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } | undefined {
  const r = spawnSync("gh", [...args], {
    cwd,
    encoding: "utf8",
    env: withoutRepoSelectionEnv(),
    timeout: 30_000,
  });
  if (r.error !== undefined) return undefined;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Merged into `baseRef`? Ancestry first (`git merge-base --is-ancestor`);
 * when that says no and the worktree has a branch, asks `gh` for a merged
 * pull request whose head is the branch and whose base is the branch the
 * verdict is about, which also catches a squash merge.
 */
export function mergeVerdict(
  cwd: string,
  head: string,
  branch: string | undefined,
  baseRef: string,
): MergeVerdict {
  const anc = git(cwd, ["merge-base", "--is-ancestor", head, baseRef]);
  if (anc.error === undefined && anc.status === 0) {
    return {
      merged: "yes",
      via: "ancestry",
      reason: `${head} is an ancestor of ${baseRef}`,
    };
  }
  if (branch === undefined) {
    return {
      merged: "unknown",
      via: "none",
      reason:
        "detached HEAD is not an ancestor of the base and has no branch to look up",
    };
  }
  // The commit a merged pull request must be at: a branch whose name was
  // reused, or that gained commits after the merge, is not covered by a
  // pull request that merged an older head of it.
  const headSha = commitSha(cwd, head);
  if (headSha === undefined) {
    return {
      merged: "unknown",
      via: "none",
      reason: "cannot resolve the worktree HEAD",
    };
  }
  // The branch the pull request must have been merged into: a pull request
  // merged into another branch (a stacked PR into its parent, say) says
  // nothing about this base.
  const baseBranch = baseRef.replace(/^origin\//, "");
  const gh = runGh(cwd, [
    "pr",
    "list",
    "--state",
    "merged",
    "--head",
    branch,
    "--base",
    baseBranch,
    "--json",
    "number,headRefOid,baseRefName",
    "--limit",
    "20",
  ]);
  if (gh === undefined) {
    return {
      merged: "unknown",
      via: "none",
      reason:
        "not an ancestor of the base, and gh is not available to check for a squash merge",
    };
  }
  if (gh.status !== 0) {
    return {
      merged: "unknown",
      via: "none",
      reason: `not an ancestor of the base, and gh failed: ${gh.stderr.trim() || `exit ${String(gh.status)}`}`,
    };
  }
  let prs: unknown;
  try {
    prs = JSON.parse(gh.stdout);
  } catch {
    return {
      merged: "unknown",
      via: "none",
      reason: "gh returned output that is not JSON",
    };
  }
  if (Array.isArray(prs)) {
    for (const pr of prs) {
      if (typeof pr !== "object" || pr === null) continue;
      const { number, headRefOid, baseRefName } = pr as Record<string, unknown>;
      if (typeof headRefOid !== "string" || headRefOid !== headSha) continue;
      if (typeof baseRefName !== "string" || baseRefName !== baseBranch) {
        continue;
      }
      return {
        merged: "yes",
        via: "gh",
        reason: `gh lists merged pull request #${String(number)} for ${branch} into ${baseBranch} at ${headSha}`,
      };
    }
    if (prs.length > 0) {
      return {
        merged: "no",
        via: "gh",
        reason: `gh lists merged pull requests for ${branch}, but none into ${baseBranch} at ${headSha} (the branch has commits after the merge, was merged into another branch, or the name was reused)`,
      };
    }
  }
  return {
    merged: "no",
    via: "gh",
    reason: `not an ancestor of ${baseRef} and gh lists no merged pull request for ${branch}`,
  };
}

/**
 * Ignored symlinks in the work tree at `cwd` (the dependency links
 * `create` makes are ignored through info/exclude). git does not descend
 * into a symlink, so a link to a large directory costs one entry.
 * Repository-relative paths.
 */
export function ignoredSymlinks(cwd: string): string[] {
  const r = git(cwd, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (r.error !== undefined || r.status !== 0) return [];
  const out: string[] = [];
  for (const entry of r.stdout.split("\0")) {
    if (entry.length === 0 || entry.endsWith("/")) continue;
    try {
      if (fs.lstatSync(path.join(cwd, entry)).isSymbolicLink()) out.push(entry);
    } catch {
      // vanished between listing and lstat
    }
  }
  return out;
}
