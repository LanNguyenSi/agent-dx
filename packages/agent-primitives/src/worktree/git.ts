import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../envelope.js";
import { runGit, type GitRunResult } from "../drift/git.js";
import { withoutRepoSelectionEnv } from "../git-env.js";
import { resolveDeepestExisting } from "../probe/containment.js";
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
  | "path_and_root_conflict"
  | "base_not_found"
  | "default_branch_unresolved"
  | "fetch_failed"
  | "run_dir_missing"
  | "link_invalid"
  | "links_file_unreadable"
  | "links_file_inside_repo"
  | "option_invalid"
  | "worktree_add_failed";

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

/** True when `candidate` is `root` or lies below it. Both sides are run
 * through `resolveDeepestExisting` first, so a symlinked spelling of
 * either cannot flip the answer. */
export function isWithin(root: string, candidate: string): boolean {
  const r = resolveDeepestExisting(path.resolve(root));
  const c = resolveDeepestExisting(path.resolve(candidate));
  const rel = path.relative(r, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
