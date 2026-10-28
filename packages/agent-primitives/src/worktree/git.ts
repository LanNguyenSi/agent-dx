import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  boundedCommand,
  boundedSpawnOptions,
  endGroupIfAbnormal,
  isTimeoutError,
} from "../bounded-spawn.js";
import { UsageError } from "../envelope.js";
import {
  runGit,
  runGitBytes,
  type GitBytesResult,
  type GitRunResult,
} from "../drift/git.js";
import { REF_FORMAT_ENV_VARS, withoutRepoSelectionEnv } from "../git-env.js";
import { probeGitArgv } from "../probe/git.js";
import { isRelContained } from "../probe/containment.js";

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
  | "base_not_remote_branch"
  | "default_branch_unresolved"
  | "fetch_failed"
  | "run_dir_missing"
  | "link_invalid"
  | "links_file_unreadable"
  | "links_file_inside_repo"
  | "option_invalid"
  | "worktree_add_failed"
  | "git_timeout"
  | "interrupted"
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
  | "no_own_commits"
  | "worktree_remove_failed";

/** A precondition that was not met. Nothing has been changed when one is
 * thrown, with the exceptions of `worktree_add_failed`, `fetch_failed` and
 * `worktree_remove_failed`, which name git's own failure (a git that did not
 * finish in time is one of them). Reported as `status: "usage_error"`
 * (exit 2) with the `reason` and, when present, the structured `details`. */
export class WorktreeRefusal extends UsageError {
  constructor(
    message: string,
    public readonly reason: WorktreeRefusalReason,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The bound of one git call that reads refs, config or one object: five
 * minutes. A healthy repository answers in milliseconds, a very large one
 * on a cold disk in seconds; a git that is still silent after this long is
 * blocked (a fifo under `refs`, a hook or a credential helper waiting for
 * input), not slow. */
export const GIT_BOUND_MS = 300_000;

/** The bound of one git call that walks a whole work tree or the history
 * (`status`, `ls-files`, `rev-list`, `merge-base`) or writes one
 * (`worktree add`, `worktree remove`): thirty minutes, since a checkout or a
 * status of a very large repository on a cold or remote file system can take
 * minutes. */
export const GIT_WALK_BOUND_MS = 1_800_000;

/** One generous bound for the network step so a dead remote cannot hang
 * the command for good. */
export const FETCH_TIMEOUT_MS = 120_000;

/** The bound of the `gh` lookup of a merged pull request. */
export const GH_TIMEOUT_MS = 30_000;

/** Documented as a test seam only: a number of milliseconds that
 * shortens every bound above to at most that value. It can only shorten (a
 * value at or above a bound, or one that is not a positive integer, changes
 * nothing), so setting it can make the commands refuse sooner but never wait
 * longer. */
export const GIT_BOUND_ENV = "AGENT_PRIMITIVES_WORKTREE_GIT_BOUND_MS";

/** `boundMs`, or the value of `GIT_BOUND_ENV` when that is shorter. */
export function effectiveBoundMs(boundMs: number): number {
  const raw = process.env[GIT_BOUND_ENV];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return boundMs;
  const shorter = Number(raw);
  return Number.isSafeInteger(shorter) && shorter < boundMs ? shorter : boundMs;
}

/** What a git call does when its bound passes. */
export interface GitCallOptions {
  /** The bound of this call; `GIT_BOUND_MS` when absent. */
  boundMs?: number;
  /** `refuse` (the default) throws the `git_timeout` refusal, so no caller
   * can read a git that never answered as an empty answer, a missing ref or a
   * clean state. `report` comes back as a result with `timedOut` and an
   * `error`, for a caller that maps a failed call to a refusal of its own
   * (`status_unknown`, `unpushed_state_unknown`, `fetch_failed`, ...) or runs
   * after the first change and cannot refuse. Its `status` is null, or git's
   * own when git had already exited and only a process it started still held
   * the pipes (0 included), so a timeout is told by `timedOut` or `error`,
   * never by `status`. */
  onTimeout?: "refuse" | "report";
  /** Run git with its top-level `--no-replace-objects` option and
   * `-c core.useReplaceRefs=false`, so no replace ref (`git replace`, in
   * `refs/replace/` or wherever `GIT_REPLACE_REF_BASE` points) changes the
   * commit graph or an object the call reads, whatever the caller's
   * configuration or environment says: the option alone loses to a
   * `core.useReplaceRefs=true` that an older git reads after it, and a
   * `-c` on the command line is applied last. It also carries
   * `-c core.commitGraph=false`, so git reads parents from the commit
   * objects and not from the `objects/info/commit-graph` file, which holds
   * parents of its own and is trusted without being checked against the
   * objects: the call reads the objects the repository holds, only those,
   * and trusts nothing derived from them, which is what the name says. For
   * a call whose answer decides whether commits are on a remote or in a
   * base. It does not switch off `info/grafts` (see `alteredCommitGraph`). */
  trustObjectsOnly?: true;
}

/** git's top-level option that ignores every replace ref. */
export const NO_REPLACE_OBJECTS_FLAG = "--no-replace-objects";

/** The setting that keeps the option above in force: some git versions read
 * a `core.useReplaceRefs=true` from the configuration or the environment
 * after the option and turn replace refs back on, and a `-c` is applied
 * after both. */
export const NO_REPLACE_REFS_CONFIG = [
  "-c",
  "core.useReplaceRefs=false",
] as const;

/** The setting that makes git ignore the commit-graph file
 * (`objects/info/commit-graph`, or the chain below `commit-graphs/`) and
 * read each commit's parents from the commit object. git trusts the file's
 * parent data without checking it against the objects, so a forged file can
 * make an unpushed commit an ancestor of a remote-tracking ref; as a `-c` on
 * the command line it also wins over a `core.commitGraph=true` from the
 * configuration or the environment. */
export const NO_COMMIT_GRAPH_CONFIG = ["-c", "core.commitGraph=false"] as const;

/** The argv of one call: the replace-ref settings and the commit-graph
 * setting when the call asks for them, then the probe-wide settings, then
 * `args`. */
function callArgv(args: readonly string[], options: GitCallOptions): string[] {
  const argv = probeGitArgv(args);
  return options.trustObjectsOnly === true
    ? [
        NO_REPLACE_OBJECTS_FLAG,
        ...NO_REPLACE_REFS_CONFIG,
        ...NO_COMMIT_GRAPH_CONFIG,
        ...argv,
      ]
    : argv;
}

/** The two options of a call that reports a timeout instead of refusing. */
export const REPORT_TIMEOUT: GitCallOptions = { onTimeout: "report" };
export const REPORT_TIMEOUT_WALK: GitCallOptions = {
  onTimeout: "report",
  boundMs: GIT_WALK_BOUND_MS,
};

/** `git <first two words>` of an argv, for a message. */
function describeGit(args: readonly string[]): string {
  let at = 0;
  while (args[at] === "-c") at += 2;
  return `git ${args.slice(at, at + 2).join(" ")}`;
}

function describeBound(ms: number): string {
  return ms % 1000 === 0 ? `${String(ms / 1000)} s` : `${String(ms)} ms`;
}

/** The sentence a timed out call is reported with. */
function timeoutMessage(what: string, boundMs: number): string {
  return `${what} did not finish within ${describeBound(boundMs)} and was stopped, together with the processes it started`;
}

/** Applies `onTimeout` to the result of a bounded git call. */
function settleTimeout<T extends { timedOut?: true; error?: string }>(
  result: T,
  cwd: string,
  args: readonly string[],
  boundMs: number,
  onTimeout: "refuse" | "report",
): T {
  if (result.timedOut !== true) return result;
  const message = timeoutMessage(describeGit(args), boundMs);
  if (onTimeout === "report") return { ...result, error: message };
  throw new WorktreeRefusal(
    `${message}; the repository is broken, or something in it blocks git (a fifo among the refs, a hook or a credential helper waiting for input)`,
    "git_timeout",
    { git: describeGit(args), boundMs, cwd },
  );
}

/**
 * Gives a SIGINT or SIGTERM that arrived while the synchronous git calls ran
 * the chance to be handled, before a command makes its first change. Those
 * calls block the event loop, so the CLI's signal handler cannot run during
 * them; this yields to the loop once, where a signal that is pending runs the
 * handler, which ends the CLI with 130 or 143 like every other command. A
 * caller that handles the signal itself sees it as `signal` aborted, and the
 * command refuses with `interrupted` and `message`, having changed nothing.
 */
export async function stopIfInterrupted(
  signal: AbortSignal | undefined,
  message: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  if (signal?.aborted === true) {
    throw new WorktreeRefusal(message, "interrupted");
  }
}

/** The refusal a git call that did not finish ends in. */
export type GitTimeoutRefusal = WorktreeRefusal & { reason: "git_timeout" };

/** True for the refusal a git call that did not finish ends in. */
export function isGitTimeout(err: unknown): err is GitTimeoutRefusal {
  return err instanceof WorktreeRefusal && err.reason === "git_timeout";
}

/** Runs `git <args>` in `cwd` with the repository-selection environment
 * removed, bounded: a git that has not finished when the bound passes is
 * killed with every process it started and ends in the `git_timeout`
 * refusal, or (`onTimeout: "report"`) in a result with `timedOut`.
 * Process-wide maintenance is switched off for the call (the same settings
 * `probe` uses), so a fetch or an add cannot leave a background `gc`
 * touching a repository while the caller reads it. */
export function git(
  cwd: string,
  args: readonly string[],
  options: GitCallOptions = {},
): GitRunResult {
  const boundMs = effectiveBoundMs(options.boundMs ?? GIT_BOUND_MS);
  const result = runGit(
    cwd,
    callArgv(args, options),
    withoutRepoSelectionEnv(),
    boundMs,
  );
  return settleTimeout(
    result,
    cwd,
    args,
    boundMs,
    options.onTimeout ?? "refuse",
  );
}

/** Trimmed stdout of a successful git call, otherwise `undefined` (a
 * timeout is the `git_timeout` refusal, never `undefined`, unless `options`
 * ask for it to be reported). */
export function gitText(
  cwd: string,
  args: readonly string[],
  options: GitCallOptions = {},
): string | undefined {
  const r = git(cwd, args, options);
  if (r.error !== undefined || r.status !== 0) return undefined;
  return r.stdout.trim();
}

/** The message to show for a failed git call: its stderr, or its spawn
 * error, or the exit status. A call that did not finish says so first,
 * whatever it had printed by then. */
export function gitFailure(r: GitRunResult): string {
  const text = r.stderr.trim();
  if (r.timedOut === true && r.error !== undefined) {
    return text.length > 0 ? `${r.error} (stderr: ${text})` : r.error;
  }
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
  /** git considers the entry stale: its directory is gone, or it no longer
   * holds a usable link back to the repository (see `describePrunable`). */
  prunable: boolean;
  /** git's own reason for `prunable`, when it printed one. */
  prunableReason?: string;
  locked: boolean;
}

/**
 * Says why git lists `entry` as prunable. git marks an entry prunable when
 * its directory is gone, but also when the directory is still there and
 * only its `.git` file is missing or points elsewhere, so the wording
 * follows the file system, not the flag: a directory that still exists may
 * hold work.
 */
export function describePrunable(entry: WorktreeEntry): string {
  const reason =
    entry.prunableReason !== undefined && entry.prunableReason.length > 0
      ? ` (git: ${entry.prunableReason})`
      : "";
  return fs.existsSync(entry.path)
    ? `the directory still exists but git no longer treats it as a worktree${reason}; check it for work before running \`git worktree prune\``
    : `the directory is gone${reason}`;
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
      else if (line === "prunable" || line.startsWith("prunable ")) {
        entry.prunable = true;
        const reason = line.slice("prunable".length).trim();
        if (reason.length > 0) entry.prunableReason = reason;
      } else if (line.startsWith("locked")) entry.locked = true;
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
  // Byte-exact: only git's own line ending comes off (`gitOutputLine`),
  // never trailing white space, so a checkout whose name ends in a space
  // resolves to the path the file system holds, not a trimmed lookalike.
  const top = git(repoPath, ["rev-parse", "--show-toplevel"]);
  if (
    top.error !== undefined ||
    top.status !== 0 ||
    gitOutputLine(top.stdout).length === 0
  ) {
    throw new WorktreeRefusal(
      `${repoPath} is not inside a git working tree`,
      "not_a_git_repo",
    );
  }
  const topLevel = gitOutputLine(top.stdout);
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
  const common = git(repoPath, ["rev-parse", "--git-common-dir"]);
  if (
    common.error !== undefined ||
    common.status !== 0 ||
    gitOutputLine(common.stdout).length === 0
  ) {
    throw new WorktreeRefusal(
      `cannot resolve the git directory of ${repoPath}`,
      "not_a_git_repo",
    );
  }
  const mainCheckout = realOrSelf(main.path);
  return {
    repoRoot: realOrSelf(topLevel),
    mainCheckout,
    commonDir: realOrSelf(path.resolve(repoPath, gitOutputLine(common.stdout))),
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

/** True when `a` and `b` spell the same path once each is resolved through
 * its deepest existing prefix (see `canonicalDeepest`). */
export function samePath(a: string, b: string): boolean {
  return (
    canonicalDeepest(path.resolve(a)) === canonicalDeepest(path.resolve(b))
  );
}

function lexicallyWithin(root: string, candidate: string): boolean {
  return isRelContained(path.relative(root, candidate));
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

/** The default branch of `origin`, resolved to one exact remote-tracking
 * ref. */
export interface DefaultBase {
  /** The name to show, and to hand to commands that only display it or
   * start a branch from it: git's own unambiguous abbreviation of
   * `fullRef` (`origin/main` in a normal layout, `remotes/origin/main` when
   * a local branch or tag of the name `origin/main` exists), and `fullRef`
   * itself when git gives no abbreviation. */
  ref: string;
  /** The full ref, `refs/remotes/origin/<branch>`: what every check that
   * decides whether work may be discarded measures against, so a local
   * `origin/<branch>` branch cannot stand in for it. */
  fullRef: string;
  /** The branch part after `origin/`: the base a pull request names. */
  ghBase: string;
  source: string;
}

/** `fullRef` as a default base, or `undefined` when it is not a plain,
 * existing remote-tracking branch of the remote `origin` (the same guard
 * `--base` goes through, so a symbolic ref, a local branch, a missing ref
 * and a remote whose name merely starts with `origin/` are all refused). */
function defaultBaseOf(
  cwd: string,
  fullRef: string,
  source: string,
): DefaultBase | undefined {
  const resolved = resolveRemoteBase(cwd, fullRef);
  if (!resolved.ok) return undefined;
  if (resolved.base.remote !== "origin") return undefined;
  // `%(refname:short)` is git's unambiguous abbreviation of exactly this
  // ref: a local branch or tag called `origin/main` makes it
  // `remotes/origin/main`. Unlike `rev-parse --abbrev-ref`, it does not
  // resolve a name, so a ref spelled `refs/heads/refs/remotes/origin/main`
  // cannot make the lookup ambiguous. Should git not answer, the full ref is
  // shown; where even the full name is ambiguous as a revision, `create`
  // refuses instead of starting from another ref.
  const listed = gitText(cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    resolved.base.ref,
  ]);
  const display =
    listed !== undefined && listed.length > 0 ? listed : resolved.base.ref;
  return {
    ref: display,
    fullRef: resolved.base.ref,
    ghBase: resolved.base.branch,
    source,
  };
}

/** The remote's default branch as `origin/<name>` resolves it, or
 * `undefined` when it cannot be told without asking the remote. Reads
 * `refs/remotes/origin/HEAD` first, then falls back to
 * `refs/remotes/origin/main` and `refs/remotes/origin/master`, in that
 * order. Only a plain remote-tracking branch of `origin` qualifies: an
 * `origin/HEAD` that points at a local branch, at a symbolic ref or at
 * nothing is skipped, and a local branch named `origin/main` is never read
 * for it. */
export function resolveDefaultBase(cwd: string): DefaultBase | undefined {
  const head = gitText(cwd, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (head !== undefined && head.length > 0) {
    const found = defaultBaseOf(cwd, head, "origin/HEAD");
    if (found !== undefined) return found;
  }
  for (const candidate of ["main", "master"]) {
    const found = defaultBaseOf(
      cwd,
      `refs/remotes/origin/${candidate}`,
      `origin/${candidate} (origin/HEAD is not set or not usable)`,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Upper bounds of the inspection of the ref store: a hostile or broken
 * tree under `refs`, or a reftable stack past them, ends the inspection as
 * "unknown" instead of running on. */
export interface LooseRefBounds {
  maxEntries: number;
  maxDepth: number;
}
const LOOSE_REF_BOUNDS: LooseRefBounds = { maxEntries: 500_000, maxDepth: 64 };

/** The largest `config` or `tables.list` the inspection reads: git has no
 * bound of its own, and a file this large is not one git writes. */
const MAX_INSPECTED_FILE_BYTES = 16 * 1024 * 1024;

/**
 * A path as the file system and git hold it: bytes, never a string. On
 * Linux a name need not be UTF-8, and decoding one that is not replaces the
 * offending bytes with U+FFFD, which names a different entry (or none): an
 * inspection that walked decoded names would `lstat` a decoy named with
 * U+FFFD twice and never the link beside it. So names are listed, joined
 * and inspected as bytes, and rendered only for messages.
 */
export type BytePath = Buffer;

const SEP = Buffer.from(path.sep);
const SLASH = Buffer.from("/");

function bytePath(p: BytePath | string): BytePath {
  return typeof p === "string" ? Buffer.from(p) : p;
}

/** `<dir><sep><name>`, joined as bytes, never normalised. */
function below(dir: BytePath, name: BytePath | string): BytePath {
  return Buffer.concat([dir, SEP, bytePath(name)]);
}

/** `bytes` decoded as UTF-8 when the decoding is exact (encoding the text
 * again gives the same bytes), otherwise `undefined`. */
export function exactUtf8(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/** `bytes` for a message: the text when it is UTF-8, otherwise every byte
 * outside printable ASCII as `\xNN`, so the entry is named exactly either
 * way. */
export function renderBytes(bytes: Buffer): string {
  const exact = exactUtf8(bytes);
  if (exact !== undefined) return exact;
  let out = "";
  for (const byte of bytes) {
    out +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** The pieces of `bytes` between occurrences of `separator`, exactly as
 * `String.prototype.split` cuts text: an empty input is one empty piece,
 * and a trailing separator ends with one, so a value that is empty is seen
 * and not dropped. */
function splitBytes(bytes: Buffer, separator: number): Buffer[] {
  const pieces: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === separator) {
      pieces.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  pieces.push(bytes.subarray(start));
  return pieces;
}

/** `bytes` quoted for a message: JSON-quoted text when it is UTF-8,
 * otherwise the rendered bytes between plain quotes, so a `\xNN` is not
 * escaped a second time. */
function quoteBytes(bytes: Buffer): string {
  const exact = exactUtf8(bytes);
  return exact !== undefined
    ? JSON.stringify(exact)
    : `"${renderBytes(bytes)}"`;
}

/** One line of git output exactly as git printed it: only the newline git
 * ends the line with comes off, so a path whose name ends in white space
 * (or holds a newline of its own) keeps it. */
export function gitOutputLine(stdout: string): string;
export function gitOutputLine(stdout: Buffer): Buffer;
export function gitOutputLine(stdout: string | Buffer): string | Buffer {
  if (typeof stdout === "string") {
    return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  }
  return stdout.length > 0 && stdout[stdout.length - 1] === 0x0a
    ? stdout.subarray(0, -1)
    : stdout;
}

/**
 * The path git printed in `cwd` (`rev-parse --git-common-dir` answers
 * relative to the directory it ran in), as the file system reads it from
 * there: the bytes git wrote, joined to the bytes of `cwd` (the same bytes
 * the git child was started in). Joined as text, never normalised:
 * `path.resolve` and `path.join` fold `..` against the preceding name,
 * while git and the kernel step through whatever that name really is, a
 * symlink included.
 */
export function gitPathIn(cwd: string, printed: Buffer): BytePath {
  // latin1 maps every byte to one character, so `isAbsolute` judges the
  // bytes as they are.
  if (path.isAbsolute(printed.toString("latin1"))) return printed;
  return below(Buffer.from(cwd), printed);
}

/** Why the common git directory `dir` cannot be inspected, or `undefined`.
 * The directory itself is followed: a link to the whole git directory moves
 * every ref with it and makes no two names meet. */
function untrustedCommonDir(dir: BytePath): string | undefined {
  let top: fs.BigIntStats;
  try {
    top = fs.statSync(dir, { bigint: true });
  } catch (err) {
    return `the common git directory ${quoteBytes(dir)} cannot be inspected: ${messageOf(err)}`;
  }
  if (!top.isDirectory()) {
    return `the common git directory ${quoteBytes(dir)} is not a directory`;
  }
  return undefined;
}

/**
 * Inspects the ref store of the files backend in `commonDir` with `lstat`,
 * following nothing below the common directory, and returns why it cannot
 * be trusted, or `undefined` when it holds only plain files and
 * directories. git takes every path in the `refs` tree for a ref name, so
 * two names that reach the same file are one ref: a link
 * `refs/remotes/origin/self -> ../../heads/feat`, a directory link
 * `refs/remotes/mirror -> ../heads`, and `refs/heads` (or a directory below
 * it, such as `refs/heads/team`) linked into `refs/remotes` all make a local
 * branch read as a remote-tracking ref, and deleting the branch deletes
 * that "remote" copy with it. Anywhere in the whole tree, then, these make
 * the store untrusted: a symbolic link; a directory reached a second time
 * (the same device and inode, which a bind mount or a directory hard link
 * gives); a directory on another device than `refs` (a mount point); a
 * special file (fifo, socket, device); an entry that cannot be read; a tree
 * past the entry or depth bound. `packed-refs` must be absent or a regular
 * file: git reads a link there like the file it names, so a link to a file
 * that removing the worktree deletes takes the remote-tracking refs listed
 * in it along. The common directory and `refs` must both exist: a path git
 * named that cannot be found is not "no refs". A missing `refs/remotes` is
 * the ordinary layout of a repository whose remote refs are all packed, and
 * simply not part of the tree. Every name is listed and inspected as bytes
 * (`BytePath`), so a name that is not UTF-8 is the entry git reads, not a
 * decoy spelled with U+FFFD. Nothing is opened, so a fifo cannot block the
 * walk.
 */
export function untrustedFilesRefStore(
  commonDir: BytePath | string,
  bounds: LooseRefBounds = LOOSE_REF_BOUNDS,
): string | undefined {
  const dir = bytePath(commonDir);
  const top = untrustedCommonDir(dir);
  if (top !== undefined) return top;
  let root: fs.BigIntStats;
  try {
    root = fs.lstatSync(below(dir, "refs"), { bigint: true });
  } catch (err) {
    return `refs cannot be inspected: ${messageOf(err)}`;
  }
  if (root.isSymbolicLink()) return "refs is a symbolic link";
  if (!root.isDirectory()) return "refs is not a directory";
  let packed: fs.BigIntStats | undefined;
  try {
    packed = fs.lstatSync(below(dir, "packed-refs"), { bigint: true });
  } catch (err) {
    // No packed refs at all is an ordinary layout.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return `packed-refs cannot be inspected: ${messageOf(err)}`;
    }
  }
  if (packed !== undefined) {
    if (packed.isSymbolicLink()) return "packed-refs is a symbolic link";
    if (!packed.isFile()) return "packed-refs is not a regular file";
  }
  // Directories already walked, by device and inode (exact as bigints).
  const seen = new Set<string>([`${String(root.dev)}:${String(root.ino)}`]);
  let entries = 0;
  const pending: { rel: BytePath; depth: number }[] = [
    { rel: Buffer.from("refs"), depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let names: Buffer[];
    try {
      names = fs.readdirSync(below(dir, next.rel), { encoding: "buffer" });
    } catch (err) {
      return `${renderBytes(next.rel)} cannot be read: ${messageOf(err)}`;
    }
    for (const name of names) {
      entries += 1;
      if (entries > bounds.maxEntries) {
        return `refs holds more than ${String(bounds.maxEntries)} entries`;
      }
      const rel = Buffer.concat([next.rel, SLASH, name]);
      // A name that readdir listed and lstat then cannot find is a ref
      // being rewritten: unreadable, like any other lstat failure.
      let st: fs.BigIntStats;
      try {
        st = fs.lstatSync(below(dir, rel), { bigint: true });
      } catch (err) {
        return `${renderBytes(rel)} cannot be inspected: ${messageOf(err)}`;
      }
      if (st.isSymbolicLink()) return `${renderBytes(rel)} is a symbolic link`;
      if (st.isDirectory()) {
        if (st.dev !== root.dev) {
          return `${renderBytes(rel)} is on another device than refs (a mount point)`;
        }
        const id = `${String(st.dev)}:${String(st.ino)}`;
        if (seen.has(id)) {
          return `${renderBytes(rel)} is a directory already reached under another name`;
        }
        seen.add(id);
        if (next.depth + 1 > bounds.maxDepth) {
          return `${renderBytes(rel)} is nested deeper than ${String(bounds.maxDepth)} levels`;
        }
        pending.push({ rel, depth: next.depth + 1 });
      } else if (!st.isFile()) {
        return `${renderBytes(rel)} is neither a regular file nor a directory`;
      }
    }
  }
  return undefined;
}

/** True when `name` is one plain file name: not empty, no `/` (nor `\`,
 * which Windows also takes for a separator), no NUL, and neither `.` nor
 * `..`. */
function plainFileName(name: Buffer): boolean {
  if (name.length === 0) return false;
  if (name.equals(Buffer.from(".")) || name.equals(Buffer.from(".."))) {
    return false;
  }
  return !name.some((byte) => byte === 0x2f || byte === 0x5c || byte === 0);
}

/**
 * Inspects the reftable stack git reads in `commonDir` with `lstat`,
 * following nothing below the common directory, and returns why it cannot
 * be trusted, or `undefined` when it is made of plain files alone. git opens
 * `<common-dir>/reftable/tables.list` and every table it lists (one name
 * per line, taken relative to the `reftable` directory, empty lines
 * skipped) through whatever is there, a link included: a table linked to an
 * ignored file inside the worktree is the whole ref store until the removal
 * deletes that file, and every ref with it. So `reftable` must be a real
 * directory, `tables.list` and every listed table a regular file (no link,
 * no special file, nothing missing) on the device of `reftable`, every
 * name a plain file name (a name with a `/`, or an absolute one, which git
 * would open as well, is not one git writes), and the list within the
 * entry bound. `tables.list` is the one file opened, and only after `lstat`
 * found it a regular file within the size bound, so nothing can block the
 * inspection. The stray `refs` directory of such a repository is not read
 * by git for refs and not walked.
 */
export function untrustedReftableStore(
  commonDir: BytePath | string,
  bounds: LooseRefBounds = LOOSE_REF_BOUNDS,
): string | undefined {
  const dir = bytePath(commonDir);
  const top = untrustedCommonDir(dir);
  if (top !== undefined) return top;
  const stackDir = below(dir, "reftable");
  let stack: fs.BigIntStats;
  try {
    stack = fs.lstatSync(stackDir, { bigint: true });
  } catch (err) {
    return `reftable cannot be inspected: ${messageOf(err)}`;
  }
  if (stack.isSymbolicLink()) return "reftable is a symbolic link";
  if (!stack.isDirectory()) return "reftable is not a directory";
  const listPath = below(stackDir, "tables.list");
  let list: fs.BigIntStats;
  try {
    list = fs.lstatSync(listPath, { bigint: true });
  } catch (err) {
    return `reftable/tables.list cannot be inspected: ${messageOf(err)}`;
  }
  if (list.isSymbolicLink()) return "reftable/tables.list is a symbolic link";
  if (!list.isFile()) return "reftable/tables.list is not a regular file";
  if (list.dev !== stack.dev) {
    return "reftable/tables.list is on another device than reftable (a mount point)";
  }
  if (list.size > BigInt(MAX_INSPECTED_FILE_BYTES)) {
    return `reftable/tables.list is larger than ${String(MAX_INSPECTED_FILE_BYTES)} bytes`;
  }
  let listed: Buffer;
  try {
    listed = fs.readFileSync(listPath);
  } catch (err) {
    return `reftable/tables.list cannot be read: ${messageOf(err)}`;
  }
  let tables = 0;
  for (const name of splitBytes(listed, 0x0a)) {
    if (name.length === 0) continue;
    tables += 1;
    if (tables > bounds.maxEntries) {
      return `reftable/tables.list names more than ${String(bounds.maxEntries)} tables`;
    }
    if (!plainFileName(name)) {
      return `reftable/tables.list names ${quoteBytes(name)}, which is not a plain file name`;
    }
    const rel = `reftable/${renderBytes(name)}`;
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(below(stackDir, name), { bigint: true });
    } catch (err) {
      return `${rel} cannot be inspected: ${messageOf(err)}`;
    }
    if (st.isSymbolicLink()) return `${rel} is a symbolic link`;
    if (!st.isFile()) return `${rel} is not a regular file`;
    if (st.dev !== stack.dev) {
      return `${rel} is on another device than reftable (a mount point)`;
    }
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A result that stands for "the unpushed state cannot be told": no git
 * status, so the caller treats it like a failed listing. */
function unknownUnpushed(message: string): GitRunResult {
  return { status: null, stdout: "", stderr: "", error: message };
}

/** `gitBytes` with the bytes of stdout decoded, for a caller that only
 * reports the failure. */
function textResult(r: GitBytesResult): GitRunResult {
  return {
    status: r.status,
    stdout: r.stdout.toString("utf8"),
    stderr: r.stderr,
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.timedOut === true ? { timedOut: true as const } : {}),
  };
}

/** `git`, with stdout as the bytes git wrote (`runGitBytes`), bounded and
 * settled the way `git` is; `input`, when given, is the child's whole
 * stdin. */
export function gitBytes(
  cwd: string,
  args: readonly string[],
  options: GitCallOptions & { input?: Buffer } = {},
): GitBytesResult {
  const boundMs = effectiveBoundMs(options.boundMs ?? GIT_BOUND_MS);
  const result = runGitBytes(
    cwd,
    callArgv(args, options),
    withoutRepoSelectionEnv(),
    options.input,
    boundMs,
  );
  return settleTimeout(
    result,
    cwd,
    args,
    boundMs,
    options.onTimeout ?? "refuse",
  );
}

/** The unknown result for a repository config the inspection could not
 * take as git takes it: `what` says why, `err` the file system error. */
function configUnreadable(
  configPath: BytePath,
  what: string,
  err?: unknown,
): GitRunResult {
  const cause = err === undefined ? "" : `: ${messageOf(err)}`;
  return unknownUnpushed(
    `the repository config ${quoteBytes(configPath)} ${what}${cause}`,
  );
}

/** `extensions.refStorage` and `GIT_REFERENCE_BACKEND` values that name a
 * format and nothing else, so the refs stay in the common directory. */
const PLAIN_REF_FORMATS: ReadonlySet<string> = new Set(["files", "reftable"]);

/**
 * A failed result when the refs git reads might live somewhere other than
 * the common directory, otherwise `undefined`. git takes a location next to
 * the format, `extensions.refStorage = files://<path>` or the same value in
 * `GIT_REFERENCE_BACKEND`, and resolves a relative one from `$GIT_DIR`,
 * which the worktree this check reads and the main checkout that deletes
 * the branch do not share. No git command names that location, so any
 * value that is more than a format name makes the answer unknown.
 *
 * The setting is read the way git's own repository-format reader reads it:
 * from `<commonDir>/config` alone, parsed by `git config` itself from the
 * file's bytes on stdin (`--file -`), without includes and without any
 * other scope. `git config` asked across its scopes would answer from
 * whatever `GIT_CONFIG`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` or an
 * included file say, and `GIT_CONFIG=/dev/null` in the caller's
 * environment would hide the repository's own value, while git keeps
 * reading the store it names. A config that cannot be inspected, read, or
 * parsed is unknown. Nothing the config says ever skips the inspection of
 * the store; this read only adds refusals.
 */
function refStoreElsewhere(
  cwd: string,
  commonDir: BytePath,
): GitRunResult | undefined {
  // Newer git reads GIT_REF_STORAGE_FORMAT first and keeps
  // GIT_REFERENCE_BACKEND as a deprecated alias, so both are checked, and
  // two different values are refused as well: which one wins depends on
  // the git version. Read from the caller's environment, not from the
  // stripped child environment: `withoutRepoSelectionEnv()` removes these
  // names, so no git of this run is ever redirected by one; the refusal
  // stays, fail closed, because the caller says its git reads its refs
  // somewhere else than the common directory this check inspects.
  const seen = new Set<string>();
  for (const name of REF_FORMAT_ENV_VARS) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (!PLAIN_REF_FORMATS.has(value)) {
      return unknownUnpushed(
        `${name} is ${JSON.stringify(value)}, which can put the refs git reads outside the common git directory`,
      );
    }
    seen.add(value);
  }
  if (seen.size > 1) {
    return unknownUnpushed(
      `${REF_FORMAT_ENV_VARS.join(" and ")} name different ref formats, so which store git reads depends on its version`,
    );
  }
  const configPath = below(commonDir, "config");
  let st: fs.BigIntStats;
  try {
    // Followed, as git opens it.
    st = fs.statSync(configPath, { bigint: true });
  } catch (err) {
    return configUnreadable(configPath, "cannot be inspected", err);
  }
  if (!st.isFile())
    return configUnreadable(configPath, "is not a regular file");
  if (st.size > BigInt(MAX_INSPECTED_FILE_BYTES)) {
    return configUnreadable(
      configPath,
      `is larger than ${String(MAX_INSPECTED_FILE_BYTES)} bytes`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(configPath);
  } catch (err) {
    return configUnreadable(configPath, "cannot be read", err);
  }
  const config = gitBytes(
    cwd,
    [
      "config",
      "--file",
      "-",
      "--no-includes",
      "--null",
      "--get-all",
      "extensions.refStorage",
    ],
    { ...REPORT_TIMEOUT, input: bytes },
  );
  // Exit status 1 is "no such key": the refs are in the common directory.
  if (config.error === undefined && config.status === 1) return undefined;
  if (config.error !== undefined || config.status !== 0) {
    return textResult(config);
  }
  // Each value ends in a NUL; only that last terminator comes off, so an
  // answer without any value reads as the empty name, which is refused.
  const text =
    config.stdout.length > 0 && config.stdout[config.stdout.length - 1] === 0
      ? config.stdout.subarray(0, -1)
      : config.stdout;
  for (const value of splitBytes(text, 0)) {
    const name = exactUtf8(value);
    if (name === undefined || !PLAIN_REF_FORMATS.has(name)) {
      return unknownUnpushed(
        `extensions.refStorage is ${quoteBytes(value)}, which can put the refs git reads outside the common git directory`,
      );
    }
  }
  return undefined;
}

/** The value `GIT_REPLACE_REF_BASE` has when it is not set. */
const DEFAULT_REPLACE_REF_BASE = "refs/replace/";

/**
 * Why the commit graph git reads in this repository cannot be taken as the
 * real one, or `undefined`. Three things change what `git rev-list` and
 * `git merge-base` see without touching a ref or a commit, so a commit that
 * no remote holds can read as pushed (or as merged into the base):
 *
 * - replace refs (`git replace --graft`, `git replace`): switched off for the
 *   calls that decide, by `--no-replace-objects` together with
 *   `-c core.useReplaceRefs=false` (`trustObjectsOnly`), whatever the
 *   caller's `GIT_NO_REPLACE_OBJECTS`, `core.useReplaceRefs` and
 *   `GIT_REPLACE_REF_BASE` say. A `GIT_REPLACE_REF_BASE` other
 *   than the default is refused as well: it says the caller's git reads
 *   replacements from somewhere else, and the answer is not worth a guess.
 * - the commit-graph file (`objects/info/commit-graph`): git reads parents
 *   from it without checking them against the commit objects, so a forged
 *   file can make an unpushed commit an ancestor of a remote-tracking ref.
 *   The calls that decide switch it off with `-c core.commitGraph=false`
 *   (`trustObjectsOnly`), whatever the caller's configuration or environment
 *   says, and read the parents from the commit objects.
 * - the grafts file, `info/grafts` in the common git directory (not the
 *   private directory of a linked worktree, which git does not read), or the
 *   file `GIT_GRAFT_FILE` names. git still reads both, with a deprecation
 *   hint, and `--no-replace-objects` does not switch them off, so their
 *   presence makes the answer unknown. Any entry named `info/grafts` counts,
 *   an empty file, a link or a directory included; only its absence does
 *   not, and an entry that cannot be inspected is not absent.
 */
export function alteredCommitGraph(grafts: BytePath): string | undefined {
  const env = withoutRepoSelectionEnv();
  const graftFile = env.GIT_GRAFT_FILE;
  if (graftFile !== undefined) {
    return `GIT_GRAFT_FILE is set (${JSON.stringify(graftFile)}), so git reads the commit graph with the grafts that file lists`;
  }
  const refBase = env.GIT_REPLACE_REF_BASE;
  if (refBase !== undefined && refBase !== DEFAULT_REPLACE_REF_BASE) {
    return `GIT_REPLACE_REF_BASE is ${JSON.stringify(refBase)}, so git reads replace refs from somewhere other than refs/replace/`;
  }
  try {
    fs.lstatSync(grafts);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No grafts file is the ordinary layout; a missing `info` directory is
    // the same.
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return `${quoteBytes(grafts)} cannot be inspected: ${messageOf(err)}`;
  }
  return `${quoteBytes(grafts)} exists, so git reads the commit graph with the grafts it lists`;
}

/** What `git for-each-ref` prints per remote-tracking ref when two views of
 * the refs are compared: the name, what it points at and what it is a
 * symbolic ref to. Nothing is left out of either view before the byte
 * comparison, symbolic refs included: a symbolic ref that one view resolves
 * differently from the other (a target of `HEAD`, or a ref under
 * `refs/worktree`) is a difference and is refused. The comparison is a
 * tripwire that fails closed, not what keeps the private stack out of the
 * walk: for a private record that shadows a symbolic ref of the common
 * stack, git can print a symbolic ref target in the worktree's listing that
 * is not the record's, so the two listings can agree although the private
 * stack shadows a ref (see `unpushedInCommonStack`). */
const REMOTE_REF_VIEW = "--format=%(refname)%09%(objectname)%09%(symref)";

/**
 * A failed result when the remote-tracking refs git lists in `cwd` are not
 * the ones the common reftable stack holds, otherwise `undefined`. Under the
 * reftable backend a linked worktree has a ref stack of its own,
 * `<common-dir>/worktrees/<name>/reftable`, and git merges it into every
 * ref listing made in that worktree, `refs/remotes/*` entries included
 * (the files backend never reads `worktrees/<name>/refs/remotes`). git
 * writes remote-tracking refs to the common stack alone, so a table in the
 * private stack that names one is not something a push or a fetch made:
 * `rev-list --remotes` in the worktree would count the commit it points at
 * as pushed, and removing the worktree deletes the private stack and that
 * ref with it. The listing in `cwd` is therefore compared byte for byte
 * with the listing of the common directory alone (`--git-dir`), and any
 * difference, an added, a hidden or a re-pointed ref, is unknown. Listings
 * that agree do not prove that the private stack holds no remote-tracking
 * ref (git can print an unreliable symbolic ref target in the worktree's
 * listing), so the walk does not read the private stack either
 * (`unpushedInCommonStack`). The common directory is an argument, so one
 * whose name is not UTF-8 cannot be handed over exactly and is unknown as
 * well, and so is one that holds an entry named `commondir`: git never
 * writes one there, and with it `--git-dir=<common-dir>` reads the refs of
 * another directory as the common stack, so the comparison and the walk
 * would be made against that stack.
 */
export function privateStackRemoteRefs(
  cwd: string,
  commonDir: BytePath,
): GitRunResult | undefined {
  const commonText = exactUtf8(commonDir);
  if (commonText === undefined) {
    return unknownUnpushed(
      `the common git directory ${quoteBytes(commonDir)} has a name that is not UTF-8, so the remote-tracking refs of the worktree cannot be compared with the ones in the common reftable stack`,
    );
  }
  const redirect = below(commonDir, "commondir");
  try {
    fs.lstatSync(redirect);
    return unknownUnpushed(
      `${quoteBytes(redirect)} exists, which git never writes in a common git directory and which makes git read the refs of another directory as the common reftable stack`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return unknownUnpushed(
        `${quoteBytes(redirect)} cannot be inspected: ${messageOf(err)}`,
      );
    }
  }
  const own = gitBytes(
    cwd,
    ["for-each-ref", REMOTE_REF_VIEW, "refs/remotes"],
    REPORT_TIMEOUT,
  );
  if (own.error !== undefined || own.status !== 0) return textResult(own);
  const common = gitBytes(
    cwd,
    [
      `--git-dir=${commonText}`,
      "for-each-ref",
      REMOTE_REF_VIEW,
      "refs/remotes",
    ],
    REPORT_TIMEOUT,
  );
  if (common.error !== undefined || common.status !== 0) {
    return textResult(common);
  }
  if (own.stdout.equals(common.stdout)) return undefined;
  return unknownUnpushed(
    "the remote-tracking refs git lists in this worktree are not the ones the common reftable stack holds, so its own reftable stack (worktrees/<name>/reftable) adds, hides or re-points a ref that no push or fetch wrote there, and a commit could look pushed that only that stack's ref holds, which the removal deletes",
  );
}

/** The characters `git check-ref-format` never allows in a ref name, next
 * to the control characters, the space and DEL. */
const FORBIDDEN_REF_CHARACTERS: ReadonlySet<number> = new Set(
  Array.from("~^:?*[\\", (c) => c.charCodeAt(0)),
);

/**
 * True when `target`, what git printed as the symbolic ref target of a
 * remote-tracking ref of the common stack, has the shape of a name git
 * prints there: a name below `refs/` that `git check-ref-format` accepts,
 * or a name at the top level such as `HEAD` or `FETCH_HEAD` (upper case
 * letters, `_` and `-` only; a symbolic ref to a detached `HEAD` resolves
 * to `HEAD`). Bytes outside ASCII are allowed, as git allows them in a ref
 * name. Anything else (a control byte, the tail of another name such as
 * `gin/main`, an empty part) is no name git wrote for that ref, and a
 * listing that holds one cannot be trusted to tell the symbolic refs from
 * the plain ones.
 */
export function plausibleRefTarget(target: Buffer): boolean {
  // One character per byte, so the checks below read the bytes git printed.
  const text = target.toString("latin1");
  if (/^[A-Z_-]+$/.test(text)) return true;
  if (!text.startsWith("refs/")) return false;
  for (const byte of target) {
    if (byte <= 0x20 || byte === 0x7f || FORBIDDEN_REF_CHARACTERS.has(byte)) {
      return false;
    }
  }
  if (text.includes("..") || text.includes("@{") || text.endsWith(".")) {
    return false;
  }
  return text
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
    );
}

/**
 * `unpushedCommits` for a reftable store, whose linked worktrees have a ref
 * stack of their own that git merges into every ref listing made in the
 * worktree, `refs/remotes/*` included. The walk reads nothing of that stack
 * but the commit the worktree's `HEAD` points at:
 *
 * - `git rev-parse --verify HEAD^{commit}` in `cwd` names the commit (an
 *   unborn branch, or an answer that is not an object name, is unknown);
 * - the symbolic refs to leave out come from
 *   `git --git-dir=<common-dir> for-each-ref refs/remotes`, the common
 *   stack alone, since git can print a symbolic ref target in the
 *   worktree's own listing that is not the record's (a private record that
 *   shadows a symbolic ref of the common stack), empty included, which
 *   would let the walk follow that record; a line of the common listing
 *   that is not a name with a plausible target (`plausibleRefTarget`) is
 *   unknown rather than read as a plain ref;
 * - `git --git-dir=<common-dir> rev-list <commit> --not --exclude=<each
 *   symbolic ref> --remotes` counts the commits no remote-tracking ref of
 *   the common stack holds, with the settings the files walk has
 *   (`trustObjectsOnly`, the walk bound).
 *
 * The comparison of the two listings (`privateStackRemoteRefs`) runs first
 * and refuses any difference, as a tripwire that fails closed.
 */
function unpushedInCommonStack(cwd: string, commonDir: BytePath): GitRunResult {
  const leaked = privateStackRemoteRefs(cwd, commonDir);
  if (leaked !== undefined) return leaked;
  // Exact: `privateStackRemoteRefs` refuses a name that is not UTF-8.
  const commonText = commonDir.toString("utf8");
  const head = git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], {
    ...REPORT_TIMEOUT,
    trustObjectsOnly: true,
  });
  if (head.error !== undefined || head.status !== 0) {
    return unknownUnpushed(
      `git cannot name the commit HEAD points at in this worktree (an unborn branch has none): ${gitFailure(head)}`,
    );
  }
  const oid = gitOutputLine(head.stdout);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    return unknownUnpushed(
      `git named ${JSON.stringify(oid)} as the commit HEAD points at in this worktree, which is not an object name`,
    );
  }
  const refs = gitBytes(
    cwd,
    [
      `--git-dir=${commonText}`,
      "for-each-ref",
      "--format=%(refname)%09%(symref)",
      "refs/remotes",
    ],
    REPORT_TIMEOUT,
  );
  if (refs.error !== undefined || refs.status !== 0) return textResult(refs);
  const excludes: string[] = [];
  for (const line of splitBytes(refs.stdout, 0x0a)) {
    // The end of the output; every line git prints has a tab.
    if (line.length === 0) continue;
    const tab = line.indexOf(0x09);
    if (tab < 0) {
      return unknownUnpushed(
        `git listed ${quoteBytes(line)} among the remote-tracking refs of the common reftable stack, which is not a ref name and a symbolic ref target, so the symbolic refs cannot be told from the plain ones`,
      );
    }
    // Nothing after the tab means a plain ref.
    if (tab === line.length - 1) continue;
    const name = line.subarray(0, tab);
    const target = line.subarray(tab + 1);
    const text = exactUtf8(name);
    if (text === undefined) {
      return unknownUnpushed(
        `the symbolic ref ${renderBytes(name)} has a name that is not UTF-8, which cannot be excluded exactly from the remote-tracking refs`,
      );
    }
    if (!plausibleRefTarget(target)) {
      return unknownUnpushed(
        `git named ${quoteBytes(target)} as the target of the symbolic ref ${text} in the common reftable stack, which is no ref name, so the listing cannot be trusted to tell the symbolic refs from the plain ones`,
      );
    }
    // A byte at or above 0x80 cannot be handed to git in an exact
    // `--exclude` on every platform: git converts a command-line argument
    // to the composed form when `core.precomposeunicode` is on (macOS sets
    // it at init), while a reftable record keeps the bytes it was written
    // with, so a stored name in the other form is never matched and
    // `--remotes` follows the symbolic ref to the branch. The pattern is
    // kept pure ASCII instead: every byte at or above 0x80 of the name
    // becomes a `?`, which wildmatch matches against the stored bytes one
    // for one and which git has no reason to convert. A `?` can also match
    // an ASCII byte, so the pattern may exclude one ref more than this
    // name: an over-excluded remote-tracking ref only ever keeps a branch
    // (it reads as unpushed), and ref names hold no glob character that
    // the ASCII part could mean.
    let pattern = "";
    for (const byte of name) {
      pattern += byte >= 0x80 ? "?" : String.fromCharCode(byte);
    }
    // Ref names cannot hold glob characters, so the ASCII parts of the
    // name are literal and the pattern excludes this ref; for `--remotes`
    // it is relative to `refs/remotes/`.
    excludes.push(`--exclude=${pattern.replace(/^refs\/remotes\//, "")}`);
  }
  return git(
    cwd,
    [
      `--git-dir=${commonText}`,
      "rev-list",
      oid,
      "--not",
      ...excludes,
      "--remotes",
    ],
    { ...REPORT_TIMEOUT_WALK, trustObjectsOnly: true },
  );
}

/**
 * `git rev-list HEAD --not <every real remote-tracking ref>` in `cwd`: the
 * commits no remote branch holds. A symbolic ref under `refs/remotes`
 * (`git symbolic-ref refs/remotes/origin/self refs/heads/feat`) is left
 * out, because `--remotes` would follow it to a local branch and count that
 * branch's commits as pushed, although deleting the branch leaves them on no
 * ref at all. A file system link in the ref store does the same without
 * git reporting anything as symbolic (a link under `refs/remotes` to a
 * branch, `refs/heads` linked into `refs/remotes`, a `packed-refs` link to
 * a file inside the worktree, a reftable table linked there), so the store
 * in the common directory is inspected first, the files store
 * (`untrustedFilesRefStore`: the whole `refs` tree and `packed-refs`)
 * unless git itself reports the reftable backend, the reftable stack
 * (`untrustedReftableStore`: `tables.list` and every table it names) when
 * it does, and any link, or other layout git does not write, makes the
 * answer unknown rather than a guess. The backend, the common directory and
 * the ref listing are git's own answers in `cwd`, taken byte for byte
 * (`gitBytes`), a replaced or grafted commit graph
 * (`alteredCommitGraph`; the walk itself runs with `--no-replace-objects`)
 * is unknown, and a store git was told to keep anywhere else
 * (`refStoreElsewhere`, read as git's format reader reads it) is unknown
 * too, so what is inspected is the store git reads. For a reftable store
 * the listing and the walk run in the common directory instead, with the
 * commit the worktree's `HEAD` points at (`unpushedInCommonStack`), since
 * a linked worktree's own reftable stack is merged into every listing made
 * in the worktree. A symbolic ref whose
 * name is not UTF-8 cannot be handed to `--exclude` exactly (an argument is
 * text) and is unknown as well; one of the common reftable stack with such
 * a name is excluded through a pure-ASCII pattern in which every non-ASCII
 * byte of the name is a `?`, which git cannot re-normalize and wildmatch
 * matches against the stored bytes. Fails (non-zero
 * status or `error`) when the refs cannot be listed, so the caller treats
 * the state as unknown. `error`
 * counts even with a status of 0: a listing that outgrows the output limit
 * of `runGit` comes back cut short, with `error` set, when git has already
 * exited. A git call that does not finish within its bound is killed with
 * the processes it started and comes back the same way, with `timedOut` and
 * an `error` that says so, never as an empty listing; its `status` can be
 * git's own, 0 included (git had exited and only a process it started still
 * held the pipes), so a caller tells it by `error`, never by `status`.
 */
export function unpushedCommits(cwd: string): GitRunResult {
  const commonDirResult = gitBytes(
    cwd,
    ["rev-parse", "--git-common-dir"],
    REPORT_TIMEOUT,
  );
  if (commonDirResult.error !== undefined || commonDirResult.status !== 0) {
    return textResult(commonDirResult);
  }
  const printed = gitOutputLine(commonDirResult.stdout);
  if (printed.length === 0) {
    return unknownUnpushed("git did not name the common git directory");
  }
  const commonDir = gitPathIn(cwd, printed);
  const altered = alteredCommitGraph(below(below(commonDir, "info"), "grafts"));
  if (altered !== undefined) {
    return unknownUnpushed(
      `${altered}; the commits git counts as pushed come from that graph, not from the commits themselves, so an unpushed commit could look pushed`,
    );
  }
  const elsewhere = refStoreElsewhere(cwd, commonDir);
  if (elsewhere !== undefined) return elsewhere;
  // The backend git really runs on, not a config value read beside it: git
  // ignores `extensions.refStorage` in a repository without format version
  // 1 and keeps reading loose files. An older git that does not know the
  // option echoes it back, and anything but exactly `reftable` is walked
  // as a files store.
  const format = git(cwd, ["rev-parse", "--show-ref-format"], REPORT_TIMEOUT);
  if (format.error !== undefined || format.status !== 0) return format;
  const reftable = gitOutputLine(format.stdout) === "reftable";
  const untrusted = reftable
    ? untrustedReftableStore(commonDir)
    : untrustedFilesRefStore(commonDir);
  if (untrusted !== undefined) {
    return unknownUnpushed(
      `${untrusted}; git reads the ref store as it finds it, so a link or another entry git does not write there can make a local branch and a remote-tracking ref one file, or keep a remote-tracking ref where removing the worktree deletes it, and the branch could look pushed`,
    );
  }
  if (reftable) return unpushedInCommonStack(cwd, commonDir);
  const refs = gitBytes(
    cwd,
    ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes"],
    REPORT_TIMEOUT,
  );
  if (refs.error !== undefined || refs.status !== 0) return textResult(refs);
  const excludes: string[] = [];
  for (const line of splitBytes(refs.stdout, 0x0a)) {
    // A ref name holds neither a tab nor a newline, so the first tab ends
    // the name; nothing after it means a plain ref.
    const tab = line.indexOf(0x09);
    if (tab < 0 || tab === line.length - 1) continue;
    const name = line.subarray(0, tab);
    const text = exactUtf8(name);
    if (text === undefined) {
      return unknownUnpushed(
        `the symbolic ref ${renderBytes(name)} has a name that is not UTF-8, which cannot be excluded exactly from the remote-tracking refs`,
      );
    }
    // Ref names cannot hold glob characters, so the name is its own exact
    // `--exclude` pattern; for `--remotes` it is relative to `refs/remotes/`.
    excludes.push(`--exclude=${text.replace(/^refs\/remotes\//, "")}`);
  }
  return git(cwd, ["rev-list", "HEAD", "--not", ...excludes, "--remotes"], {
    ...REPORT_TIMEOUT_WALK,
    trustObjectsOnly: true,
  });
}

/** A `--base` value resolved to a remote-tracking branch. */
export interface RemoteBase {
  /** The full ref, `refs/remotes/<remote>/<branch>`: what every git
   * command measures against, so no worktree re-reads a relative rev. */
  ref: string;
  remote: string;
  /** The branch part after `<remote>/`: the base a pull request names. */
  branch: string;
}

export type RemoteBaseResolution =
  | { ok: true; base: RemoteBase }
  | {
      ok: false;
      /** `base_not_remote_branch`: the value is not a remote-tracking
       * branch of a configured remote at all; `base_not_found`: it has that
       * shape but the ref does not exist in this repository. */
      reason: "base_not_remote_branch" | "base_not_found";
    };

/**
 * Resolves `--base <rev>` once, in the repository at `cwd`, to a
 * remote-tracking branch: `<remote>/<branch>` or
 * `refs/remotes/<remote>/<branch>` for a configured remote. Anything else
 * (`HEAD`, `HEAD~1`, `origin/x@{1}`, `origin/x^`, `@{u}`, a local branch, a
 * sha, a tag, an option-like value, a symbolic remote `HEAD`) is `base_not_remote_branch`. The match is
 * on the exact ref, never on git's rev syntax.
 */
export function resolveRemoteBase(
  cwd: string,
  rev: string,
): RemoteBaseResolution {
  const notRemote = { ok: false, reason: "base_not_remote_branch" } as const;
  if (rev.length === 0 || rev.startsWith("-")) return notRemote;
  const full = rev.startsWith("refs/remotes/") ? rev : `refs/remotes/${rev}`;
  const rest = full.slice("refs/remotes/".length);
  const remotes = (gitText(cwd, ["remote"]) ?? "")
    .split("\n")
    .filter((name) => name.length > 0)
    // The longest name first: remote names may contain a slash.
    .sort((x, y) => y.length - x.length);
  const remote = remotes.find((name) => rest.startsWith(`${name}/`));
  if (remote === undefined) return notRemote;
  const branch = rest.slice(remote.length + 1);
  if (branch.length === 0 || branch === "HEAD") return notRemote;
  // The value must be one exact ref name: `check-ref-format` rejects every
  // piece of rev syntax (`@{1}`, `~n`, `^`, `^{commit}`, `..`, `:`), so a
  // reflog entry or an ancestor of a remote-tracking branch is never taken
  // for the branch itself.
  if (git(cwd, ["check-ref-format", full]).status !== 0) return notRemote;
  if (git(cwd, ["symbolic-ref", "--quiet", full]).status === 0) {
    return notRemote;
  }
  if (git(cwd, ["show-ref", "--verify", "--quiet", full]).status !== 0) {
    return { ok: false, reason: "base_not_found" };
  }
  if (commitSha(cwd, full) === undefined) {
    return { ok: false, reason: "base_not_found" };
  }
  return { ok: true, base: { ref: full, remote, branch } };
}

/**
 * True when `rev` can never be the `--base` of a remote-tracking branch in
 * any repository: option-like, not `<remote>/<branch>` in shape
 * (no slash after an optional `refs/remotes/`: empty, `HEAD`, a sha, a local
 * branch without a slash), a `<name>/HEAD` pair, or no valid ref name
 * (rev syntax). Needs no repository; a missing remote or ref is a per
 * repository matter and not decided here.
 */
export function baseNeverRemoteBranch(cwd: string, rev: string): boolean {
  if (rev.startsWith("-")) return true;
  const full = rev.startsWith("refs/remotes/") ? rev : `refs/remotes/${rev}`;
  const rest = full.slice("refs/remotes/".length);
  const parts = rest.split("/");
  if (parts.length < 2) return true;
  if (parts.length === 2 && parts[1] === "HEAD") return true;
  return git(cwd, ["check-ref-format", full]).status !== 0;
}

/** True when `rev` names a commit in the repository at `cwd`. */
export function refExists(cwd: string, rev: string): boolean {
  return commitSha(cwd, rev) !== undefined;
}

/** The full commit sha `rev` resolves to, or `undefined`. */
export function commitSha(
  cwd: string,
  rev: string,
  options: GitCallOptions = {},
): string | undefined {
  const out = gitText(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
    options,
  );
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
 * git could not answer (exit 128 or a spawn failure, or, with
 * `onTimeout: "report"`, a git that did not finish).
 */
export function isIgnored(
  cwd: string,
  rel: string,
  options: GitCallOptions = {},
): boolean | undefined {
  const r = git(cwd, ["check-ignore", "--no-index", "-q", "--", rel], options);
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
  /** `ancestry`: the branch tip is an ancestor of the base. `content`: the
   * tip is no ancestor, but everything the branch changed since it forked
   * is in the base exactly as the branch has it, and that is first true at
   * the tip (a squash merge, a rebase merge or a cherry-pick leaves no
   * ancestry; see `contentRule`). `gh`:
   * GitHub lists a merged pull request for the branch. `none`: none of them
   * could decide. */
  via: "ancestry" | "content" | "gh" | "none";
  reason: string;
}

/** What `runGh` reports. */
export interface GhRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** `gh` did not finish within its bound and was stopped with the
   * processes it started; `status` is null. */
  timedOut?: true;
}

/** Runs `gh` with a bound, in a process group of its own that is killed
 * with it; `undefined` when it cannot be started. */
export function runGh(cwd: string, args: readonly string[]): GhRun | undefined {
  const boundMs = effectiveBoundMs(GH_TIMEOUT_MS);
  const run = boundedCommand("gh", args);
  const r = spawnSync(run.command, run.args, {
    cwd,
    encoding: "utf8",
    env: withoutRepoSelectionEnv(),
    ...boundedSpawnOptions(boundMs),
  } as SpawnSyncOptions & { encoding: "utf8" });
  endGroupIfAbnormal(r);
  if (isTimeoutError(r.error)) {
    return { status: null, stdout: "", stderr: "", timedOut: true };
  }
  if (r.error !== undefined) return undefined;
  // The trampoline's shell could not find or run `gh` (127, 126), which is
  // how a missing `gh` shows now that it is not the spawned file itself.
  if (r.status === 127 || r.status === 126) return undefined;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Merged into `baseRef`? Ancestry first (`git merge-base --is-ancestor`);
 * then the content rule (`contentRule`), which needs no network and
 * catches a squash merge whose pull request `gh` cannot be asked about;
 * when neither decides and the worktree has a branch, asks `gh` for a merged
 * pull request whose head is the branch and whose base is the branch the
 * verdict is about, which also catches a squash merge. `baseBranchName` is
 * that branch when it cannot be read off `baseRef` (a remote other than
 * `origin`, a full `refs/remotes/...` ref); by default `origin/` is stripped.
 * `baseLabel` is how the reasons name the base (default `baseRef`): the
 * measurement is always against `baseRef`. `options.contentRule: false`
 * leaves the content rule out (ancestry, then `gh`).
 */
export function mergeVerdict(
  cwd: string,
  head: string,
  branch: string | undefined,
  baseRef: string,
  baseBranchName?: string,
  baseLabel: string = baseRef,
  options: { contentRule?: boolean } = {},
): MergeVerdict {
  try {
    return decideMerge(
      cwd,
      head,
      branch,
      baseRef,
      baseBranchName,
      baseLabel,
      options.contentRule !== false,
    );
  } catch (err) {
    // A git call that did not finish cannot say whether the branch is
    // merged: the verdict is unknown, which `remove --require-merged`
    // refuses (`merge_state_unknown`) and `list` reports as it is.
    if (!isGitTimeout(err)) throw err;
    return { merged: "unknown", via: "none", reason: err.message };
  }
}

/** The most first-parent commits between the fork point and `HEAD` that
 * the content rule reads; a branch with more is not decided by it. */
export const CONTENT_RULE_MAX_COMMITS = 50;

/** What the content rule found: `yes` with the sentence for the reason
 * when it decides, otherwise nothing, with a `note` when the rule held at
 * `HEAD` but is not trusted (an earlier commit of the branch already held
 * it, or the branch has more commits than the rule reads). */
export interface ContentRuleAnswer {
  yes?: string;
  note?: string;
}

/** The first-parent commits of `head ^fork`, newest first, each with the
 * paths it changed against its first parent (`--no-renames`, so a rename
 * lists both paths). At most `max` commits are read; `undefined` when git
 * fails or prints something this parser does not expect. */
function branchCommits(
  cwd: string,
  head: string,
  fork: string,
  max: number,
  opts: GitCallOptions,
): { sha: string; paths: string[] }[] | undefined {
  // `%x00%H` starts every commit with an empty field, which no path can
  // be, so a path that looks like a commit name is never read as one. `-m`
  // with `--first-parent` diffs a merge against its first parent only.
  const r = git(
    cwd,
    [
      "log",
      "--first-parent",
      "-m",
      `--max-count=${String(max)}`,
      "--no-show-signature",
      "--format=%x00%H",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--ignore-submodules=none",
      head,
      `^${fork}`,
      "--",
    ],
    opts,
  );
  if (r.error !== undefined || r.status !== 0) return undefined;
  const commits: { sha: string; paths: string[] }[] = [];
  let expectSha = false;
  let firstPath = false;
  for (const field of r.stdout.split("\0")) {
    if (field.length === 0) {
      expectSha = true;
      continue;
    }
    if (expectSha) {
      if (!/^[0-9a-f]{40,64}$/.test(field)) return undefined;
      commits.push({ sha: field, paths: [] });
      expectSha = false;
      firstPath = true;
      continue;
    }
    const current = commits[commits.length - 1];
    if (current === undefined) return undefined;
    // git separates the name list from the commit line with a newline.
    current.paths.push(
      firstPath && field.startsWith("\n") ? field.slice(1) : field,
    );
    firstPath = false;
  }
  return commits;
}

/**
 * The content rule for work whose commits never became ancestors of the
 * base. Where a repository squash-merges (or rebase-merges) and the host
 * deletes the remote branch on merge, the branch's commits are never
 * ancestors of the base and `gh` is the only other witness; this rule asks
 * the question a squash answers instead.
 *
 * With `fork` = `merge-base head baseRef`, it reads the first-parent
 * commits of `head ^fork` and the set of paths any of them changed
 * against its first parent (`--no-renames`, so a rename lists both of its
 * paths). A commit "holds" when, on every path of that set, it has exactly
 * what `baseRef` has: the same blob and mode, or absent on both sides. The
 * answer is yes only when `HEAD` holds, the branch changed something since
 * the fork (an empty or net-zero branch has nothing to compare), and no
 * earlier commit of the branch holds already. That last part is what keeps
 * commits made after a squash merge from being counted as merged: work
 * added after the squash and then taken back (add a file, delete it again)
 * leaves `HEAD` holding, but so does the commit the squash was made from,
 * and the commits that follow it are not in the base. A normal
 * multi-commit pull request first holds at its last commit, because an
 * earlier commit lacks what a later one added. Where an earlier commit
 * holds for another reason (a pull request that took back its own last
 * change), the rule does not decide either; the next rule is asked.
 *
 * Work added after the squash fails at `HEAD` already, because its paths
 * differ from the base; so does a path the base changed again since. A
 * branch with more than `CONTENT_RULE_MAX_COMMITS` first-parent commits
 * since the fork is not decided. Read only: `merge-base`, `log` and `diff`
 * write nothing, and they run without replace refs and without the commit
 * graph like the ancestry check. A git call that fails leaves the question
 * to the next rule; every "not decided" is a fall through, never a yes.
 */
export function contentRule(
  cwd: string,
  head: string,
  baseRef: string,
): ContentRuleAnswer {
  const opts = { boundMs: GIT_WALK_BOUND_MS, trustObjectsOnly: true } as const;
  const fork = git(cwd, ["merge-base", head, baseRef], opts);
  if (fork.error !== undefined || fork.status !== 0) return {};
  const forkSha = fork.stdout.trim();
  if (forkSha.length === 0) return {};
  const commits = branchCommits(
    cwd,
    head,
    forkSha,
    CONTENT_RULE_MAX_COMMITS + 1,
    opts,
  );
  if (commits === undefined || commits.length === 0) return {};
  const touched = new Set(commits.flatMap((c) => c.paths));
  const names = (a: string, b: string): Set<string> | undefined => {
    const r = git(
      cwd,
      [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--ignore-submodules=none",
        a,
        b,
        "--",
      ],
      opts,
    );
    if (r.error !== undefined || r.status !== 0) return undefined;
    return new Set(r.stdout.split("\0").filter((entry) => entry.length > 0));
  };
  /** `commit` has what the base has on every path the branch touched;
   * `undefined` when git cannot tell. */
  const holdsAt = (commit: string): boolean | undefined => {
    const differing = names(commit, baseRef);
    if (differing === undefined) return undefined;
    for (const entry of touched) {
      if (differing.has(entry)) return false;
    }
    return true;
  };
  if (holdsAt(head) !== true) return {};
  if (commits.length > CONTENT_RULE_MAX_COMMITS) {
    return {
      note: `the branch has more than ${String(CONTENT_RULE_MAX_COMMITS)} commits since it forked, more than the rule reads`,
    };
  }
  const changed = names(forkSha, head);
  if (changed === undefined || changed.size === 0) return {};
  // Oldest first: the first commit that holds is where the base already
  // had everything the branch touched.
  const earlier = commits.slice(1).reverse();
  for (const [index, commit] of earlier.entries()) {
    const held = holdsAt(commit.sha);
    if (held === undefined) return {};
    if (held) {
      return {
        note: `the base already had what the branch touched at its commit ${commit.sha}, and the ${String(earlier.length - index)} commit(s) after it are not counted as merged`,
      };
    }
  }
  return {
    yes: `all ${String(changed.size)} path(s) the branch changed since it forked are in the base exactly as the branch has them, first at its last commit (a squash or rebase merge)`,
  };
}

/** The content rule's sentence for the reason when it says yes, otherwise
 * `undefined`; see `contentRule`. */
export function contentInBase(
  cwd: string,
  head: string,
  baseRef: string,
): string | undefined {
  return contentRule(cwd, head, baseRef).yes;
}

function decideMerge(
  cwd: string,
  head: string,
  branch: string | undefined,
  baseRef: string,
  baseBranchName: string | undefined,
  baseLabel: string,
  withContentRule: boolean,
): MergeVerdict {
  // A grafted graph can make a branch look merged, and neither the
  // ancestry nor a pull request can be weighed against a graph that is not
  // the real one: the verdict is unknown. Replace refs are switched off for
  // the calls below instead.
  const graftsAt = gitBytes(cwd, ["rev-parse", "--git-path", "info/grafts"]);
  const printed = gitOutputLine(graftsAt.stdout);
  if (
    graftsAt.error !== undefined ||
    graftsAt.status !== 0 ||
    printed.length === 0
  ) {
    return {
      merged: "unknown",
      via: "none",
      reason: `cannot tell whether the commit graph is altered: ${gitFailure(textResult(graftsAt))}`,
    };
  }
  const altered = alteredCommitGraph(gitPathIn(cwd, printed));
  if (altered !== undefined) {
    return {
      merged: "unknown",
      via: "none",
      reason: `${altered}; ancestry read from that graph could call an unmerged branch merged`,
    };
  }
  const anc = git(cwd, ["merge-base", "--is-ancestor", head, baseRef], {
    boundMs: GIT_WALK_BOUND_MS,
    trustObjectsOnly: true,
  });
  if (anc.error === undefined && anc.status === 0) {
    return {
      merged: "yes",
      via: "ancestry",
      reason: `${head} is an ancestor of ${baseLabel}`,
    };
  }
  const content: ContentRuleAnswer = withContentRule
    ? contentRule(cwd, head, baseRef)
    : {};
  if (content.yes !== undefined) {
    return {
      merged: "yes",
      via: "content",
      reason: `${head} is no ancestor of ${baseLabel}, but ${content.yes}`,
    };
  }
  const byPullRequest = decideByPullRequest(
    cwd,
    head,
    branch,
    baseRef,
    baseBranchName,
    baseLabel,
  );
  return content.note === undefined || byPullRequest.merged === "yes"
    ? byPullRequest
    : {
        ...byPullRequest,
        reason: `${byPullRequest.reason}; the content rule did not decide: ${content.note}`,
      };
}

/** The last rule of `decideMerge`: a merged pull request that `gh` reports
 * for `branch` into the base at the worktree's HEAD commit. */
function decideByPullRequest(
  cwd: string,
  head: string,
  branch: string | undefined,
  baseRef: string,
  baseBranchName: string | undefined,
  baseLabel: string,
): MergeVerdict {
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
  const headSha = commitSha(cwd, head, { trustObjectsOnly: true });
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
  const baseBranch = baseBranchName ?? baseRef.replace(/^origin\//, "");
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
  if (gh.timedOut === true) {
    return {
      merged: "unknown",
      via: "none",
      reason: `not an ancestor of the base, and ${timeoutMessage("gh pr list", effectiveBoundMs(GH_TIMEOUT_MS))}`,
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
    reason: `not an ancestor of ${baseLabel} and gh lists no merged pull request for ${branch}`,
  };
}

/**
 * Ignored symlinks in the work tree at `cwd` (the dependency links
 * `create` makes are ignored through info/exclude). git does not descend
 * into a symlink, so a link to a large directory costs one entry.
 * Repository-relative paths.
 */
export function ignoredSymlinks(cwd: string): string[] {
  const r = git(
    cwd,
    [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ],
    { boundMs: GIT_WALK_BOUND_MS },
  );
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
