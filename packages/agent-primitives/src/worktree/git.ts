import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  boundedCommand,
  boundedSpawnOptions,
  endProcessGroup,
  isTimeoutError,
} from "../bounded-spawn.js";
import { UsageError } from "../envelope.js";
import {
  runGit,
  runGitBytes,
  type GitBytesResult,
  type GitRunResult,
} from "../drift/git.js";
import { withoutRepoSelectionEnv } from "../git-env.js";
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
   * clean state. `report` comes back as a result with `timedOut`, a null
   * `status` and an `error`, for a caller that maps a failed call to a
   * refusal of its own (`status_unknown`, `unpushed_state_unknown`,
   * `fetch_failed`, ...) or runs after the first change and cannot refuse. */
  onTimeout?: "refuse" | "report";
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
    probeGitArgv(args),
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
    probeGitArgv(args),
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
/** Environment variables git reads for the ref storage format, newest name
 * first. */
export const REF_STORAGE_ENV_VARS = [
  "GIT_REF_STORAGE_FORMAT",
  "GIT_REFERENCE_BACKEND",
] as const;

function refStoreElsewhere(
  cwd: string,
  commonDir: BytePath,
): GitRunResult | undefined {
  // Newer git reads GIT_REF_STORAGE_FORMAT first and keeps
  // GIT_REFERENCE_BACKEND as a deprecated alias, so both are checked, and
  // two different values are refused as well: which one wins depends on
  // the git version.
  const env = withoutRepoSelectionEnv();
  const seen = new Set<string>();
  for (const name of REF_STORAGE_ENV_VARS) {
    const value = env[name];
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
      `${REF_STORAGE_ENV_VARS.join(" and ")} name different ref formats, so which store git reads depends on its version`,
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
 * (`gitBytes`), and a store git was told to keep anywhere else
 * (`refStoreElsewhere`, read as git's format reader reads it) is unknown
 * too, so what is inspected is the store git reads. A symbolic ref whose
 * name is not UTF-8 cannot be handed to `--exclude` exactly (an argument is
 * text) and is unknown as well. Fails (non-zero status or `error`) when the
 * refs cannot be listed, so the caller treats the state as unknown. `error`
 * counts even with a status of 0: a listing that outgrows the output limit
 * of `runGit` comes back cut short, with `error` set, when git has already
 * exited. A git call that does not finish within its bound is killed with
 * the processes it started and comes back the same way (`timedOut`, no
 * status, an `error` that says so), never as an empty listing.
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
  return git(
    cwd,
    ["rev-list", "HEAD", "--not", ...excludes, "--remotes"],
    REPORT_TIMEOUT_WALK,
  );
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
  /** `ancestry`: the branch tip is an ancestor of the base. `gh`: GitHub
   * lists a merged pull request for the branch (a squash merge leaves no
   * ancestry). `none`: neither could decide. */
  via: "ancestry" | "gh" | "none";
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
  if (r.error !== undefined || r.signal !== null) endProcessGroup(r.pid);
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
 * when that says no and the worktree has a branch, asks `gh` for a merged
 * pull request whose head is the branch and whose base is the branch the
 * verdict is about, which also catches a squash merge. `baseBranchName` is
 * that branch when it cannot be read off `baseRef` (a remote other than
 * `origin`, a full `refs/remotes/...` ref); by default `origin/` is stripped.
 * `baseLabel` is how the reasons name the base (default `baseRef`): the
 * measurement is always against `baseRef`.
 */
export function mergeVerdict(
  cwd: string,
  head: string,
  branch: string | undefined,
  baseRef: string,
  baseBranchName?: string,
  baseLabel: string = baseRef,
): MergeVerdict {
  try {
    return decideMerge(cwd, head, branch, baseRef, baseBranchName, baseLabel);
  } catch (err) {
    // A git call that did not finish cannot say whether the branch is
    // merged: the verdict is unknown, which `remove --require-merged`
    // refuses (`merge_state_unknown`) and `list` reports as it is.
    if (!isGitTimeout(err)) throw err;
    return { merged: "unknown", via: "none", reason: err.message };
  }
}

function decideMerge(
  cwd: string,
  head: string,
  branch: string | undefined,
  baseRef: string,
  baseBranchName: string | undefined,
  baseLabel: string,
): MergeVerdict {
  const anc = git(cwd, ["merge-base", "--is-ancestor", head, baseRef], {
    boundMs: GIT_WALK_BOUND_MS,
  });
  if (anc.error === undefined && anc.status === 0) {
    return {
      merged: "yes",
      via: "ancestry",
      reason: `${head} is an ancestor of ${baseLabel}`,
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
