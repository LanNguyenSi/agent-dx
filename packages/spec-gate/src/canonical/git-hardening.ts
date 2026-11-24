/**
 * What every `git` call of this package has in common, so the three places
 * that start git (lint, digest, intake) cannot drift apart: the `-c`
 * overrides that switch off the ways a repository's own configuration can
 * run a program or change what an id means, the environment variable that
 * switches off `info/grafts`, and the check that the git directory of a
 * repository is the one the `.git` entry of its work tree names.
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
 * - `protocol.allow=never`: no transport is started unless the repository
 *   names one in a `protocol.<name>.allow` of its own, which is why
 *   `applyGitSwitches` sets `GIT_ALLOW_PROTOCOL` as well. Left out for a call
 *   that fetches (`fetching: true`, the same option `applyGitSwitches`
 *   takes), which is the intake step only; the override is the default, so a
 *   new call site that forgets the option stays offline.
 */
export function gitConfigOverrides(
  options: { fetching?: boolean } = {},
): string[] {
  const pairs = [
    "safe.bareRepository=explicit",
    "core.fsmonitor=false",
    `core.hooksPath=${os.devNull}`,
  ];
  if (options.fetching !== true) pairs.push("protocol.allow=never");
  return pairs.flatMap((pair) => ["-c", pair]);
}

/**
 * Sets the switches every git call carries on top of a scrubbed
 * environment: no terminal prompt, no replace refs (a replace ref must not
 * swap the content of the object an id names), no lazy fetch in a partial
 * clone (git 2.45 and later; defence in depth, the transport switch below
 * is the one that holds on older versions), no optional locks, and no graft
 * file (`info/grafts` would make a commit appear to have other parents than
 * it has, so an ancestry answer would not be the one the object database
 * gives).
 *
 * By default it also sets `GIT_ALLOW_PROTOCOL` to the empty string: no
 * transport is allowed, and a repository's own `protocol.<name>.allow`
 * cannot widen that, which it can with the `protocol.allow=never` override
 * alone. Only a call that fetches (`fetching: true`, the intake step) leaves
 * the transports to the configuration; the safe setting is the default, so a
 * new call site that forgets the option stays offline.
 */
export function applyGitSwitches(
  env: NodeJS.ProcessEnv,
  options: { fetching?: boolean } = {},
): void {
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  env["GIT_NO_LAZY_FETCH"] = "1";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_GRAFT_FILE"] = os.devNull;
  if (options.fetching !== true) env["GIT_ALLOW_PROTOCOL"] = "";
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

/** A `.git` file above this size is not read; git refuses one too. */
export const MAX_GITFILE_BYTES = 1024 * 1024;

/**
 * Where the `.git` entry of the work tree `top` (a real path) leads: the
 * entry itself when it is a directory, the path a `gitdir: <path>` file
 * names (a relative one counts from `top`), or the reason it leads nowhere.
 * The entry is examined without following a link at that name.
 */
function dotGitTarget(top: string): { target: string } | { problem: string } {
  const entry = path.join(top, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entry);
  } catch {
    return { problem: "its work tree has no .git entry" };
  }
  if (stat.isSymbolicLink()) {
    return { problem: "the .git entry of its work tree is a symbolic link" };
  }
  if (stat.isDirectory()) return { target: entry };
  if (!stat.isFile()) {
    return {
      problem:
        "the .git entry of its work tree is neither a directory nor a file",
    };
  }
  const notGitfile = {
    problem: "the .git file of its work tree is not a gitdir file",
  };
  if (stat.size > MAX_GITFILE_BYTES) return notGitfile;
  let text: string;
  try {
    text = fs.readFileSync(entry, "utf8");
  } catch {
    return notGitfile;
  }
  // The form git reads: the prefix, then the path up to the line ends that
  // close the file.
  const prefix = "gitdir: ";
  if (!text.startsWith(prefix)) return notGitfile;
  let end = text.length;
  while (end > prefix.length && "\r\n".includes(text[end - 1]!)) end -= 1;
  const named = text.slice(prefix.length, end);
  if (named === "") return notGitfile;
  return { target: path.resolve(top, named) };
}

/**
 * Why the repository git found is not the one the work tree's own `.git`
 * entry names, or `null` when it is. The three paths are what `git rev-parse
 * --show-toplevel --absolute-git-dir --git-common-dir` printed for the
 * directory the lookup started from.
 *
 * One rule, in three parts that must all hold:
 *
 * 1. `<toplevel>/.git` exists, and is not a symbolic link.
 * 2. It leads to the git directory git reported: it is a directory whose
 *    real path is that git directory, or a regular file `gitdir: <path>`
 *    whose path (a relative one counts from `<toplevel>`) has that real path.
 * 3. The common directory is not inside the work tree, unless the git
 *    directory is `<toplevel>/.git` itself and the common directory is that
 *    same directory.
 *
 * Why this is enough: git refuses to check out an entry named `.git`, so
 * nothing a spec author commits can be the `.git` entry of a work tree. A
 * git directory that was found by walking up into committed files (a bare
 * layout with `HEAD`, `objects/` and `refs/` somewhere in the tree) is
 * therefore never what parts 1 and 2 ask for, whatever its `core.worktree`
 * says: the work tree it names either has no `.git` entry, or has one that
 * leads to another git directory. No list of forbidden positions of the two
 * directories relative to each other is needed, and a layout git itself
 * makes is accepted wherever it lies: a plain checkout, a linked worktree
 * (also one inside a bare repository or inside the main work tree), a
 * separate git directory outside the work tree, a submodule. Part 3 keeps
 * the object store out of the work tree, where a spec author writes: a
 * `.git` file that names a directory of the work tree itself is refused,
 * and so is a `commondir` that does.
 *
 * The check is only as good as the paths it is given: a caller must take
 * them from the lookup that starts at the directory it was handed (the spec
 * directory, or `--repo`), not from a second lookup at the top level that a
 * found layout names.
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
  const found = dotGitTarget(top);
  if ("problem" in found) return found.problem;
  if (real(found.target) !== dir) {
    return "the .git entry of its work tree does not lead to its git directory";
  }
  const own = dir === path.join(top, ".git") && common === dir;
  if (isInside(top, common) && !own) {
    return "its common git directory lies inside the work tree";
  }
  return null;
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
