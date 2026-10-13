import { spawnSync } from "node:child_process";
import { withoutPathspecEnv } from "../git-env.js";

/** Generous enough for a whole-repo diff or a doc file's contents without
 * truncating mid-line; this is a prototype tool run against one task-sized
 * range, not a bulk cross-repo scan. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs `git <args>` in `cwd`, synchronously. Never throws: a spawn
 * failure (git missing, cwd unreadable) comes back as `error` instead,
 * the same shape doctor's own `runWorktreeList` uses for its synchronous
 * git calls. */
export function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): GitRunResult {
  try {
    const result = spawnSync("git", args, {
      cwd,
      ...(env !== undefined ? { env } : {}),
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error !== undefined ? { error: result.error.message } : {}),
    };
  } catch (err) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** `runGit` with stdout kept as the bytes git wrote. */
export interface GitBytesResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  error?: string;
}

/**
 * `runGit`, except that stdout comes back as the bytes git wrote, not
 * decoded: a path or a ref name git prints is then the one the file system
 * holds, where decoding would turn a byte that is not UTF-8 into U+FFFD and
 * name another entry. `input`, when given, is the child's whole stdin.
 */
export function runGitBytes(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  input?: Buffer,
): GitBytesResult {
  try {
    const result = spawnSync("git", args, {
      cwd,
      ...(env !== undefined ? { env } : {}),
      ...(input !== undefined ? { input } : {}),
      maxBuffer: GIT_MAX_BUFFER,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
      ...(result.error !== undefined ? { error: result.error.message } : {}),
    };
  } catch (err) {
    return {
      status: null,
      stdout: Buffer.alloc(0),
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True only when `rev` resolves to a real commit in the repo at `cwd`.
 * Used to turn a bad `--base`/`--head` into a usage error before any diff
 * or grep runs, rather than letting git's own exit code surface as an
 * opaque `error`. */
export function revExists(cwd: string, rev: string): boolean {
  const result = runGit(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}^{commit}`,
  ]);
  return result.error === undefined && result.status === 0;
}

/** The full commit SHA `rev` resolves to, or `undefined` when it does not
 * resolve to a commit. */
export function resolveCommit(cwd: string, rev: string): string | undefined {
  const result = runGit(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}^{commit}`,
  ]);
  if (result.error !== undefined || result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha === "" ? undefined : sha;
}

/** Outcome of `git merge-base a b`: the SHA, or why there is none.
 * `no-common-ancestor` is git's exit 1; `error` is any other failure. */
export type MergeBaseResult =
  | { sha: string }
  | { sha?: undefined; reason: "no-common-ancestor" | "error"; detail: string };

/** The best common ancestor of two commits, or the reason there is none. */
export function mergeBase(cwd: string, a: string, b: string): MergeBaseResult {
  const result = runGit(cwd, ["merge-base", a, b]);
  if (result.error !== undefined) {
    return { reason: "error", detail: result.error };
  }
  if (result.status === 0) {
    const sha = result.stdout.trim();
    if (sha !== "") return { sha };
    return { reason: "no-common-ancestor", detail: "" };
  }
  if (result.status === 1) {
    return { reason: "no-common-ancestor", detail: result.stderr.trim() };
  }
  return {
    reason: "error",
    detail: `git exited ${String(result.status)}: ${result.stderr.trim()}`,
  };
}

/** True when the repository at `cwd` is a shallow clone. */
export function isShallowRepository(cwd: string): boolean {
  const result = runGit(cwd, ["rev-parse", "--is-shallow-repository"]);
  return (
    result.error === undefined &&
    result.status === 0 &&
    result.stdout.trim() === "true"
  );
}

/** `git diff --no-color -U0 base..head`: zero context lines, so every
 * line in a hunk is either removed or added, never carried context -
 * exactly what the line-number bookkeeping in `parseDiff.ts` assumes.
 * `drift()` passes the merge-base as `base`, so the diff is the change
 * the head side made, never the other side's later commits. */
export function diffText(
  cwd: string,
  base: string,
  head: string,
): GitRunResult {
  return runGit(cwd, ["diff", "--no-color", "-U0", `${base}..${head}`]);
}

/** The content of `filePath` as it existed at `rev`, or `undefined` when
 * the path does not exist there (or git could not read it for any other
 * reason). */
export function showFile(
  cwd: string,
  rev: string,
  filePath: string,
): string | undefined {
  const result = runGit(cwd, ["show", `${rev}:${filePath}`]);
  if (result.error !== undefined || result.status !== 0) return undefined;
  return result.stdout;
}

/**
 * `git grep -n -w -F -e <name> <rev> -- <pathspecs>`: every tracked line
 * at `rev` containing `name` as a whole word (never a substring of a
 * longer identifier), restricted to the given pathspecs. Only tracked
 * content at `rev` is ever visited, so untracked files and anything under
 * an ignored directory (`node_modules`, ...) are excluded without any
 * extra filtering here. Exit code `0` = at least one match, `1` = none
 * (both are a normal outcome, never a warning); anything else is a real
 * git error, reported by the caller.
 */
export function grepIdentifier(
  cwd: string,
  rev: string,
  name: string,
  pathspecs: readonly string[],
): GitRunResult {
  return runGit(
    cwd,
    ["grep", "-n", "-w", "-F", "-e", name, rev, "--", ...pathspecs],
    // The scan pathspecs are globs: an ambient GIT_*_PATHSPECS switch would
    // make git grep match none of them and exit 1, which reads as "no site".
    withoutPathspecEnv(),
  );
}
