import fs from "node:fs";
import path from "node:path";
import {
  WorktreeRefusal,
  git,
  gitText,
  ignoredSymlinks,
  isWithin,
  mergeVerdict,
  resolveDefaultBase,
  resolveExplicitBase,
  resolveRepo,
  type MergeVerdict,
  type RepoContext,
  type WorktreeEntry,
} from "./git.js";

/**
 * `worktree list`: the state of every worktree of one repository (or of
 * every work tree below one directory) in one report, so an orchestrator
 * can decide what to remove, what to push and which run a worktree
 * belongs to without running a dozen git commands itself.
 *
 * Read-only: the command runs no git command that writes.
 */

export interface ListWorktreesOptions {
  /** The invocation directory; `repo` and `root` resolve against it. */
  cwd: string;
  /** Repository to report; defaults to `cwd`. Exclusive with `root`. */
  repo?: string;
  /** Report the work trees that are direct children of this directory. */
  root?: string;
  /** Measure ahead, behind and merged against this revision instead of
   * origin's default branch. Applies to every repository of a `root`. */
  base?: string;
}

export interface ListedWorktree {
  path: string;
  /** `RepoContext.name`: the basename of the main checkout. */
  repo: string;
  /** The main checkout, which `remove` never touches. */
  main: boolean;
  branch?: string;
  head?: string;
  /** The base the ahead, behind and merged values are measured against:
   * the default base, for example `origin/main`, or the `--base` value. */
  base?: string;
  /** Trimmed content of `<path>/.ai/run`, `null` when it is absent. */
  runPointer: string | null;
  /** `null` when `git status` failed (a prunable entry, say). */
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  merged: MergeVerdict;
  /** Ignored symlinks, the dependency links `create` made. */
  links: string[];
  prunable: boolean;
  locked: boolean;
}

export interface ListWorktreesResult {
  status: "ok";
  worktrees: ListedWorktree[];
  warnings: string[];
}

function sameDirectory(a: string, b: string): boolean {
  return isWithin(a, b) && isWithin(b, a);
}

function readRunPointer(worktree: string): string | null {
  try {
    return fs.readFileSync(path.join(worktree, ".ai", "run"), "utf8").trim();
  } catch {
    return null;
  }
}

/** Ahead and behind of `HEAD` against `baseRef`, left side being the base. */
function counts(
  worktree: string,
  baseRef: string,
): { ahead: number | null; behind: number | null } {
  const out = gitText(worktree, [
    "rev-list",
    "--left-right",
    "--count",
    `${baseRef}...HEAD`,
  ]);
  if (out === undefined) return { ahead: null, behind: null };
  const [left, right] = out.split("\t");
  const behind = Number(left);
  const ahead = Number(right);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
    return { ahead: null, behind: null };
  }
  return { ahead, behind };
}

function describeEntry(
  entry: WorktreeEntry,
  repo: RepoContext,
  main: boolean,
  warnings: string[],
  baseFlag: string | undefined,
): ListedWorktree {
  const base =
    baseFlag === undefined
      ? resolveDefaultBase(repo.mainCheckout)
      : resolveExplicitBase(repo.mainCheckout, baseFlag);
  if (baseFlag !== undefined && base === undefined) {
    const warning = `--base ${baseFlag} does not name a commit in ${repo.mainCheckout}; the merge state of its worktrees is reported as unknown`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  const listed: ListedWorktree = {
    path: entry.path,
    repo: repo.name,
    main,
    ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
    ...(entry.head !== undefined ? { head: entry.head } : {}),
    ...(base !== undefined
      ? { base: base.ref }
      : baseFlag !== undefined
        ? { base: baseFlag }
        : {}),
    runPointer: null,
    dirty: null,
    ahead: null,
    behind: null,
    merged: {
      merged: "unknown",
      via: "none",
      reason: "prunable: the directory is gone",
    },
    links: [],
    prunable: entry.prunable,
    locked: entry.locked,
  };
  // A prunable entry has no directory to read: everything that needs one
  // stays null, and the merged verdict says why.
  if (entry.prunable) return listed;

  const status = git(entry.path, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status.error !== undefined || status.status !== 0) {
    warnings.push(
      `git status failed in ${entry.path}; its state is reported as unknown`,
    );
  } else {
    listed.dirty = status.stdout.trim().length > 0;
  }

  if (base !== undefined) {
    listed.merged = mergeVerdict(entry.path, "HEAD", entry.branch, base.ref);
    const countsOfBase = counts(entry.path, base.ref);
    listed.ahead = countsOfBase.ahead;
    listed.behind = countsOfBase.behind;
  } else {
    listed.merged = {
      merged: "unknown",
      via: "none",
      reason:
        baseFlag === undefined
          ? "origin's default branch cannot be resolved"
          : `--base ${baseFlag} does not name a commit in ${repo.mainCheckout}`,
    };
  }

  listed.links = ignoredSymlinks(entry.path);
  listed.runPointer = readRunPointer(entry.path);
  return listed;
}

/**
 * Reports every worktree of one repository, main checkout first, or (with
 * `root`) every work tree among the direct children of one directory.
 */
export async function listWorktrees(
  o: ListWorktreesOptions,
): Promise<ListWorktreesResult> {
  if (o.repo !== undefined && o.root !== undefined) {
    throw new WorktreeRefusal(
      "pass --repo or --root, not both",
      "option_invalid",
    );
  }
  const warnings: string[] = [];

  if (o.root === undefined) {
    const repo = resolveRepo(path.resolve(o.cwd, o.repo ?? "."));
    return {
      status: "ok",
      worktrees: repo.worktrees.map((entry, index) =>
        describeEntry(entry, repo, index === 0, warnings, o.base),
      ),
      warnings,
    };
  }

  const root = path.resolve(o.cwd, o.root);
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    throw new WorktreeRefusal(
      `--root ${root} is not a directory its entries can be listed`,
      "option_invalid",
    );
  }
  const worktrees: ListedWorktree[] = [];
  for (const name of names) {
    const child = path.join(root, name);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(child).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;
    // Only a work tree top: a subdirectory of some checkout resolves to
    // that checkout's top, which is another directory, and a plain
    // directory resolves to nothing. Both are skipped silently.
    const top = gitText(child, ["rev-parse", "--show-toplevel"]);
    if (top === undefined || top.length === 0) continue;
    if (!sameDirectory(top, child)) continue;
    // One child that cannot be resolved is a warning, not a failed report:
    // a work tree of a bare repository, say, has no main checkout to
    // describe, but its siblings still do.
    try {
      const repo = resolveRepo(child);
      const entry =
        repo.worktrees.find((w) => sameDirectory(w.path, child)) ??
        repo.worktrees[0];
      if (entry === undefined) continue;
      worktrees.push(
        describeEntry(
          entry,
          repo,
          entry === repo.worktrees[0],
          warnings,
          o.base,
        ),
      );
    } catch (err) {
      if (!(err instanceof WorktreeRefusal)) throw err;
      warnings.push(`skipped ${child}: ${err.message}`);
    }
  }
  return { status: "ok", worktrees, warnings };
}
