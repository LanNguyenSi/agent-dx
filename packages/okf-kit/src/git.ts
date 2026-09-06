import { execFileSync } from "node:child_process";
import type { RunGit } from "./types.js";

/**
 * Output cap (bytes) for a single git invocation. Node's own default for
 * `execFileSync` is 1 MiB, and exceeding it does not throw a distinguishable
 * error here -- it lands in the catch below and resolves to null, i.e. the
 * caller sees "git failed" for a perfectly healthy repository. `sources-fresh`
 * reads whole doc blobs (`git show <sha>:<path>`) to compare frontmatter
 * timestamps, and an OKF doc larger than 1 MiB is unusual but entirely legal,
 * so the cap is raised well past any plausible doc size. It is deliberately
 * still a cap and not `Infinity`: a runaway git invocation should fail loudly
 * (as null, which every caller treats as "not assessable") rather than grow
 * the process heap without bound.
 */
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Default RunGit implementation: shells out to the real `git` binary.
 * stderr is discarded (git's own "fatal: not a git repository" etc. text is
 * an expected, silent signal here, not something to surface), and any
 * failure (non-zero exit, git missing, output past MAX_GIT_OUTPUT_BYTES)
 * resolves to null instead of throwing.
 */
export const runGit: RunGit = (args, cwd) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
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
