import { execFileSync } from "node:child_process";
import type { RunGit } from "./types.js";

/**
 * Default RunGit implementation: shells out to the real `git` binary.
 * stderr is discarded (git's own "fatal: not a git repository" etc. text is
 * an expected, silent signal here, not something to surface), and any
 * failure (non-zero exit, git missing) resolves to null instead of
 * throwing.
 */
export const runGit: RunGit = (args, cwd) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Resolves the git work tree root containing `startDir`, or undefined when
 * `startDir` is not inside a git work tree (or git is unavailable). Used to
 * auto-fill --repo-root when the CLI flag is omitted.
 */
export function detectRepoRoot(
  startDir: string,
  git: RunGit = runGit,
): string | undefined {
  const result = git(["rev-parse", "--show-toplevel"], startDir);
  return result ? result : undefined;
}
