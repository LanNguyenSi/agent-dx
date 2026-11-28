/**
 * The git reads of the closing check that the lint primitives do not
 * have, through the same hardened runner: an argument list, a scrubbed
 * environment, a timeout and an output cap. Nothing here fetches or
 * writes.
 */
import { COMMIT_RE } from "../formats/validate.js";
import { LintGitError, runGit } from "../lint/git/exec.js";

/** A repository path: `/` separated names, no `.` or `..`, no glob or option characters. */
const REPO_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function isRepoPath(repoPath: string): boolean {
  return (
    REPO_PATH_RE.test(repoPath) &&
    !repoPath.startsWith("-") &&
    !repoPath.split("/").some((part) => part === "." || part === "..")
  );
}

/**
 * The last commit along the first parents of `tip` whose change from its
 * first parent touches one of `paths`, or `null` when none does. The first
 * parents of the tip of the default branch are what that branch held, so
 * the answer is the commit that put the latest version of the paths on
 * the branch (for a merge commit the merge, not a commit of the merged
 * branch). `paths` are repository paths checked by `isRepoPath`, matched
 * literally.
 */
export function lastFirstParentChange(
  repo: string,
  tip: string,
  paths: readonly string[],
): string | null {
  if (!COMMIT_RE.test(tip) || paths.some((p) => !isRepoPath(p))) {
    throw new LintGitError("path-invalid", "a value is not valid");
  }
  const run = runGit(repo, [
    "--literal-pathspecs",
    "rev-list",
    "--first-parent",
    "--max-count=1",
    "--end-of-options",
    tip,
    "--",
    ...paths,
  ]);
  if (run.status !== 0) {
    throw new LintGitError("git-failed", "git could not list the history");
  }
  const text = run.stdout.toString("utf8");
  if (text === "") return null;
  const id = text.replace(/\n$/, "");
  if (!COMMIT_RE.test(id)) {
    throw new LintGitError("git-failed", "git could not list the history");
  }
  return id;
}
