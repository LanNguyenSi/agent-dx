import fs from "node:fs";
import path from "node:path";
import {
  GIT_WALK_BOUND_MS,
  WorktreeRefusal,
  baseNeverRemoteBranch,
  describePrunable,
  type DefaultBase,
  git,
  gitText,
  ignoredSymlinks,
  isGitTimeout,
  isWithin,
  mergeVerdict,
  resolveDefaultBase,
  resolveRemoteBase,
  type RemoteBaseResolution,
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
   * origin's default branch; must be a remote-tracking branch. Applies to
   * every repository of a `root`. */
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
  const out = gitText(
    worktree,
    ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`],
    { boundMs: GIT_WALK_BOUND_MS },
  );
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
  resolutions: Map<string, RemoteBaseResolution>,
  defaultBases: Map<string, DefaultBase | undefined>,
): ListedWorktree {
  // `ref` is what is measured against, `label` what is shown.
  let base: { ref: string; ghBase: string; label: string } | undefined;
  let baseProblem: string | undefined;
  if (baseFlag === undefined) {
    // Resolved once per repository: it costs several git processes.
    if (!defaultBases.has(repo.mainCheckout)) {
      defaultBases.set(
        repo.mainCheckout,
        resolveDefaultBase(repo.mainCheckout),
      );
    }
    const found = defaultBases.get(repo.mainCheckout);
    base =
      found === undefined
        ? undefined
        : { ref: found.fullRef, ghBase: found.ghBase, label: found.ref };
  } else {
    // Resolved once per repository, in its main checkout, to a full ref:
    // every worktree is measured against the same full ref.
    let resolved = resolutions.get(repo.mainCheckout);
    if (resolved === undefined) {
      resolved = resolveRemoteBase(repo.mainCheckout, baseFlag);
      resolutions.set(repo.mainCheckout, resolved);
      if (!resolved.ok) {
        const warning =
          resolved.reason === "base_not_found"
            ? `--base ${baseFlag} does not name an existing remote-tracking branch in ${repo.mainCheckout}; the merge state of its worktrees is reported as unknown`
            : `--base ${baseFlag} is not a remote-tracking branch (<remote>/<branch>) of ${repo.mainCheckout}; the merge state of its worktrees is reported as unknown`;
        warnings.push(warning);
      }
    }
    if (resolved.ok) {
      base = {
        ref: resolved.base.ref,
        ghBase: resolved.base.branch,
        label: resolved.base.ref,
      };
    } else {
      baseProblem =
        resolved.reason === "base_not_found"
          ? `--base ${baseFlag} does not name an existing remote-tracking branch in ${repo.mainCheckout}`
          : `--base ${baseFlag} is not a remote-tracking branch (<remote>/<branch>) of ${repo.mainCheckout}`;
    }
  }
  const listed: ListedWorktree = {
    path: entry.path,
    repo: repo.name,
    main,
    ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
    ...(entry.head !== undefined ? { head: entry.head } : {}),
    ...(baseFlag !== undefined
      ? { base: baseFlag }
      : base !== undefined
        ? { base: base.label }
        : {}),
    runPointer: null,
    dirty: null,
    ahead: null,
    behind: null,
    merged: {
      merged: "unknown",
      via: "none",
      reason: "not measured yet",
    },
    links: [],
    prunable: entry.prunable,
    locked: entry.locked,
  };
  // A prunable entry has no directory git can read (it is gone, or its
  // `.git` file is): everything that needs one stays null, and the merged
  // verdict says which of the two it is.
  if (entry.prunable) {
    listed.merged = {
      merged: "unknown",
      via: "none",
      reason: `prunable: ${describePrunable(entry)}`,
    };
    return listed;
  }

  const status = git(
    entry.path,
    ["status", "--porcelain", "--untracked-files=all"],
    { boundMs: GIT_WALK_BOUND_MS },
  );
  if (status.error !== undefined || status.status !== 0) {
    warnings.push(
      `git status failed in ${entry.path}; its state is reported as unknown`,
    );
  } else {
    listed.dirty = status.stdout.trim().length > 0;
  }

  if (base !== undefined) {
    listed.merged = mergeVerdict(
      entry.path,
      "HEAD",
      entry.branch,
      base.ref,
      base.ghBase,
      base.label,
    );
    const countsOfBase = counts(entry.path, base.ref);
    listed.ahead = countsOfBase.ahead;
    listed.behind = countsOfBase.behind;
  } else {
    listed.merged = {
      merged: "unknown",
      via: "none",
      reason: baseProblem ?? "origin's default branch cannot be resolved",
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
  const resolutions = new Map<string, RemoteBaseResolution>();
  const defaultBases = new Map<string, DefaultBase | undefined>();

  if (o.root === undefined) {
    const repo = resolveRepo(path.resolve(o.cwd, o.repo ?? "."));
    if (o.base !== undefined) {
      const resolved = resolveRemoteBase(repo.mainCheckout, o.base);
      // Only a good resolution is cached: a failed one is resolved again
      // when the first entry is described, which is what emits its warning.
      if (resolved.ok) resolutions.set(repo.mainCheckout, resolved);
      if (!resolved.ok && resolved.reason === "base_not_remote_branch") {
        throw new WorktreeRefusal(
          `--base ${o.base} is not a remote-tracking branch; pass <remote>/<branch> or refs/remotes/<remote>/<branch> of a configured remote`,
          "base_not_remote_branch",
          { base: o.base },
        );
      }
    }
    return {
      status: "ok",
      worktrees: repo.worktrees.map((entry, index) =>
        describeEntry(
          entry,
          repo,
          index === 0,
          warnings,
          o.base,
          resolutions,
          defaultBases,
        ),
      ),
      warnings,
    };
  }

  // A value that can never be a remote-tracking branch is refused before
  // any repository is looked at, as it is without --root; only a missing
  // remote or ref is left to a per-repository warning.
  if (o.base !== undefined && baseNeverRemoteBranch(o.cwd, o.base)) {
    throw new WorktreeRefusal(
      `--base ${o.base} is not a remote-tracking branch; pass <remote>/<branch> or refs/remotes/<remote>/<branch> of a configured remote`,
      "base_not_remote_branch",
      { base: o.base },
    );
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
          resolutions,
          defaultBases,
        ),
      );
    } catch (err) {
      if (!(err instanceof WorktreeRefusal)) throw err;
      // A child whose git did not answer is not a child that cannot be
      // described (a bare repository, say): leaving it out of the report
      // with a warning would read as a listing that is complete.
      if (isGitTimeout(err)) throw err;
      warnings.push(`skipped ${child}: ${err.message}`);
    }
  }
  return { status: "ok", worktrees, warnings };
}
