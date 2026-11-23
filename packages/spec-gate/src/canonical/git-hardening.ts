/**
 * What every `git` call of this package has in common, so the three places
 * that start git (lint, digest, intake) cannot drift apart: the `-c`
 * overrides that switch off the ways a repository's own configuration can
 * run a program or change what an id means, the environment variable that
 * switches off `info/grafts`, and the check that the git directory of a
 * repository is where a checkout puts it.
 *
 * A repository the spec author can write into (a pull request checkout) is
 * hostile input: its `.git/config` and any git directory it embeds must not
 * be able to start a process or move the ancestry the rules rely on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The `-c key=value` pairs that go before the subcommand.
 *
 * - `safe.bareRepository=explicit`: a bare repository is only used when it
 *   is named with `--git-dir`, never found by walking up from a directory.
 * - `core.fsmonitor=false`: no file system monitor program runs.
 * - `core.hooksPath=<null device>`: no hook runs, whatever the repository
 *   configures.
 * - `protocol.allow=never`: no transport is started. Left out for a call
 *   that talks to a remote (`network: true`), which is the intake step only.
 */
export function gitConfigOverrides(
  options: { network?: boolean } = {},
): string[] {
  const pairs = [
    "safe.bareRepository=explicit",
    "core.fsmonitor=false",
    `core.hooksPath=${os.devNull}`,
  ];
  if (options.network !== true) pairs.push("protocol.allow=never");
  return pairs.flatMap((pair) => ["-c", pair]);
}

/**
 * Sets the switches every git call carries on top of a scrubbed
 * environment: no terminal prompt, no replace refs (a replace ref must not
 * swap the content of the object an id names), no lazy fetch in a partial
 * clone, no optional locks, and no graft file (`info/grafts` would make a
 * commit appear to have other parents than it has, so an ancestry answer
 * would not be the one the object database gives).
 */
export function applyGitSwitches(env: NodeJS.ProcessEnv): void {
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  env["GIT_NO_LAZY_FETCH"] = "1";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_GRAFT_FILE"] = os.devNull;
}

function real(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Whether `inner` is `outer` or below it; both are real paths. */
export function isInside(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return !(
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  );
}

/**
 * Why the git directory of a work tree is not one a checkout makes, or
 * `null` when it is. The three paths are what `git rev-parse --show-toplevel
 * --absolute-git-dir --git-common-dir` printed.
 *
 * A git directory inside the work tree is only `<toplevel>/.git`: anything
 * else there (a bare layout committed into the tree, with `core.worktree`
 * pointing back) is content the author wrote. A git directory outside the
 * work tree (a linked worktree, a separate git directory, a submodule) must
 * have its common directory outside the work tree too.
 */
export function gitDirProblem(
  toplevel: string,
  gitDir: string,
  commonDir: string,
): string | null {
  const top = real(toplevel);
  const dir = real(gitDir);
  const common = real(commonDir);
  if (top === null || dir === null || common === null) {
    return "its git directory cannot be resolved";
  }
  if (isInside(top, dir)) {
    return dir === path.join(top, ".git")
      ? null
      : "its git directory lies inside the work tree and is not its .git";
  }
  return isInside(top, common)
    ? "its common git directory lies inside the work tree"
    : null;
}

/**
 * Splits the three lines `rev-parse --show-toplevel --absolute-git-dir
 * --path-format=absolute --git-common-dir` prints, or `null` when git
 * printed something else (not a work tree, a git too old for the option).
 */
export function parseRepoLayout(
  output: string,
): { toplevel: string; gitDir: string; commonDir: string } | null {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 3 || lines.some((l) => l === "")) return null;
  return { toplevel: lines[0]!, gitDir: lines[1]!, commonDir: lines[2]! };
}

/** The arguments of the `rev-parse` call `parseRepoLayout` reads. */
export const REPO_LAYOUT_ARGS: readonly string[] = [
  "rev-parse",
  "--show-toplevel",
  "--absolute-git-dir",
  "--path-format=absolute",
  "--git-common-dir",
];
