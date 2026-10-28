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
 * Environment variables that change how git parses a pathspec. Rules hand
 * git `:(literal)` pathspecs for `sources` entries; an inherited
 * GIT_LITERAL_PATHSPECS=1 (set, for example, for hooks run under
 * `git --literal-pathspecs commit`) would disable that magic and make every
 * source look untracked. GIT_ICASE_PATHSPECS changes how a `:(literal)`
 * pathspec matches; GIT_GLOB_PATHSPECS and GIT_NOGLOB_PATHSPECS leave it
 * alone, but git refuses them combined with each other or with the literal
 * variable. All four are dropped from the child environment so pathspec
 * interpretation does not depend on the caller. The global
 * `--literal-pathspecs` option is not used instead: git refuses it combined
 * with GIT_GLOB_PATHSPECS.
 */
const PATHSPEC_ENV_VARS = [
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
] as const;

/**
 * Copy of `env` without the pathspec-mode variables in PATHSPEC_ENV_VARS.
 */
function gitChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of PATHSPEC_ENV_VARS) {
    delete childEnv[name];
  }
  return childEnv;
}

/**
 * Runs `git <args>` and returns stdout exactly as git wrote it, or null on
 * any failure (non-zero exit, git missing, output past MAX_GIT_OUTPUT_BYTES).
 * stderr is discarded (git's own "fatal: not a git repository" etc. text is
 * an expected, silent signal here, not something to surface). The child runs
 * with gitChildEnv(), so pathspec parsing ignores the caller's pathspec-mode
 * variables.
 */
function execGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      env: gitChildEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
  } catch {
    return null;
  }
}

/**
 * Default RunGit implementation: shells out to the real `git` binary and
 * returns trimmed stdout (see `execGit` for the failure contract). Any
 * failure resolves to null instead of throwing.
 */
export const runGit: RunGit = (args, cwd) => execGit(args, cwd)?.trim() ?? null;

/**
 * Like `runGit`, but returns stdout UNTRIMMED. File content read through
 * `git show <rev>:<path>` needs it: trimming would drop the first line's
 * indentation and any trailing blank lines, and line numbers (which the
 * citation-drift check maps through `git diff -U0` hunks) must count every
 * line of the real file.
 */
export const runGitRaw: RunGit = (args, cwd) => execGit(args, cwd);

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
