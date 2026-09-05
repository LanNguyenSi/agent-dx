import { spawnSync } from "node:child_process";

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
export function runGit(cwd: string, args: string[]): GitRunResult {
  try {
    const result = spawnSync("git", args, {
      cwd,
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

/** `git diff --no-color -U0 base..head`: zero context lines, so every
 * line in a hunk is either removed or added, never carried context -
 * exactly what the line-number bookkeeping in `parseDiff.ts` assumes. */
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
  return runGit(cwd, [
    "grep",
    "-n",
    "-w",
    "-F",
    "-e",
    name,
    rev,
    "--",
    ...pathspecs,
  ]);
}
