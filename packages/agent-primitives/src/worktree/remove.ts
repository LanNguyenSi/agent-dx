import fs from "node:fs";
import path from "node:path";
import {
  WorktreeRefusal,
  git,
  gitFailure,
  ignoredSymlinks,
  isWithin,
  mergeVerdict,
  resolveDefaultBase,
  resolveRepo,
  type MergeVerdict,
} from "./git.js";

/**
 * `worktree remove`: the safe half of the worktree lifecycle. Every check
 * that can refuse runs before the first change, so a refusal leaves the
 * worktree, its branch and the repository exactly as they were.
 */

export interface RemoveWorktreeOptions {
  /** The invocation directory; `path` resolves against it. */
  cwd: string;
  /** The worktree to remove; relative to `cwd`. */
  path: string;
  /** Remove a dirty, unpushed or locked worktree anyway. */
  force?: boolean;
  /** Delete the worktree's branch after the worktree is gone. */
  deleteBranch?: boolean;
  /** Refuse unless the branch is merged into the default base. */
  requireMerged?: boolean;
}

export interface RemoveWorktreeResult {
  status: "ok";
  worktree: { path: string; branch?: string; head?: string };
  /** Ignored dependency links that were unlinked before the removal. */
  linksRemoved: string[];
  /** `null` when neither `--require-merged` nor `--delete-branch` asked. */
  merged: MergeVerdict | null;
  branch: { deleted: boolean; reason: string };
  /** `git worktree prune` ran and succeeded afterwards. */
  pruned: boolean;
  warnings: string[];
}

/** How many status lines a `worktree_dirty` refusal reports. */
const DIRTY_DETAIL_LINES = 20;

function statusLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when both spellings name the same directory. */
function sameDirectory(a: string, b: string): boolean {
  return isWithin(a, b) && isWithin(b, a);
}

/**
 * Removes one linked worktree: the locked, nested-worktree, submodule,
 * status, merged and unpushed checks first, each of the last three failing
 * closed so that a git command which cannot answer is a refusal rather than
 * a clean, unpushed or unmerged reading. Then the ignored dependency links
 * (unlinked, never followed), then `git worktree remove` and
 * `git worktree prune`, and finally the optional `git branch -D`.
 *
 * The main checkout is never modified: its HEAD, index, working tree and
 * stash are untouched, and `git stash`, `checkout`, `switch` and `reset`
 * are never run anywhere. Every git call that writes acts on the main
 * checkout's administrative directories only (`worktree remove`,
 * `worktree prune`, `branch -D`); everything else reads the worktree.
 */
export async function removeWorktree(
  o: RemoveWorktreeOptions,
): Promise<RemoveWorktreeResult> {
  const target = path.resolve(o.cwd, o.path);
  let exists = true;
  try {
    exists = fs.statSync(target).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    throw new WorktreeRefusal(
      `${target} is not an existing directory, so there is no worktree to remove`,
      "not_a_worktree",
      { path: target },
    );
  }
  const repo = resolveRepo(target);

  const entry = repo.worktrees.find((w) => sameDirectory(w.path, target));
  if (entry === undefined) {
    throw new WorktreeRefusal(
      `${target} is not a worktree of the repository it belongs to; pass the path of a worktree this command or \`git worktree add\` created`,
      "not_a_worktree",
      { path: target },
    );
  }
  if (entry === repo.worktrees[0]) {
    throw new WorktreeRefusal(
      `${target} is the main checkout of the repository; this command never removes it`,
      "remove_main_checkout",
      { path: target, mainCheckout: repo.mainCheckout },
    );
  }
  if (entry.locked && o.force !== true) {
    throw new WorktreeRefusal(
      `the worktree ${target} is locked (\`git worktree unlock\` it first, or pass --force to remove it while locked)`,
      "worktree_locked",
      { path: target },
    );
  }

  // A prunable entry whose directory is already gone has nothing inside to
  // lose, so it is not a nested worktree here; a prunable entry whose
  // directory is still there keeps refusing.
  const nested = repo.worktrees.find(
    (w) =>
      w !== entry &&
      !(w.prunable && !fs.existsSync(w.path)) &&
      isWithin(target, w.path),
  );
  if (nested !== undefined && o.force !== true) {
    throw new WorktreeRefusal(
      `${nested.path} is a worktree inside ${target}; remove it first, or pass --force`,
      "nested_worktree",
      { worktree: nested.path },
    );
  }
  if (fs.existsSync(path.join(target, ".gitmodules")) && o.force !== true) {
    throw new WorktreeRefusal(
      `${target} has submodules, which git cannot remove without --force`,
      "has_submodules",
    );
  }

  const status = git(target, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if ((status.error !== undefined || status.status !== 0) && o.force !== true) {
    throw new WorktreeRefusal(
      `cannot read the status of ${target}: ${gitFailure(status)}; pass --force to remove it anyway`,
      "status_unknown",
    );
  }
  const dirty = statusLines(status.stdout);
  if (dirty.length > 0 && o.force !== true) {
    throw new WorktreeRefusal(
      `${target} has ${String(dirty.length)} uncommitted change(s), tracked or untracked; commit, stash or discard them first, or pass --force to remove the worktree with them`,
      "worktree_dirty",
      { entries: dirty.slice(0, DIRTY_DETAIL_LINES) },
    );
  }

  const base = resolveDefaultBase(repo.mainCheckout);
  // Asked only when a flag needs the answer: the `gh` lookup of a verdict is
  // a network call where `gh` happens to be installed. Computed before the
  // unpushed check, because a branch that is merged into the base has no
  // work left to lose even when no remote branch holds its commits.
  const merged: MergeVerdict | null =
    o.requireMerged !== true && o.deleteBranch !== true
      ? null
      : base === undefined
        ? {
            merged: "unknown",
            via: "none",
            reason: "origin's default branch cannot be resolved",
          }
        : mergeVerdict(target, "HEAD", entry.branch, base.ref);
  if (o.requireMerged === true && o.force !== true && merged !== null) {
    if (merged.merged === "no") {
      throw new WorktreeRefusal(
        `${entry.branch ?? "HEAD"} is not merged into ${base?.ref ?? "the default branch"}; merge it first, or pass --force to remove the worktree anyway`,
        "branch_not_merged",
        { merged },
      );
    }
    if (merged.merged === "unknown") {
      throw new WorktreeRefusal(
        `cannot tell whether ${entry.branch ?? "HEAD"} is merged: ${merged.reason}. Merge it first, or pass --force to remove the worktree anyway`,
        "merge_state_unknown",
        { merged },
      );
    }
  }

  const unpushed = git(target, ["rev-list", "HEAD", "--not", "--remotes"]);
  if (
    (unpushed.error !== undefined || unpushed.status !== 0) &&
    o.force !== true
  ) {
    throw new WorktreeRefusal(
      `cannot tell which commits of ${target} are on a remote: ${gitFailure(unpushed)}; pass --force to remove it anyway`,
      "unpushed_state_unknown",
    );
  }
  const unpushedLines = statusLines(unpushed.stdout);
  const mergedIntoBase = merged !== null && merged.merged === "yes";
  if (unpushedLines.length > 0 && o.force !== true && !mergedIntoBase) {
    throw new WorktreeRefusal(
      `${target} has ${String(unpushedLines.length)} commit(s) that no remote branch has; push them first, or pass --force to remove the worktree and lose them`,
      "unpushed_commits",
      { commits: unpushedLines.length },
    );
  }

  const defaultBranch =
    base === undefined ? undefined : base.ref.replace(/^origin\//, "");
  const mainBranch = repo.worktrees[0]?.branch;
  if (o.deleteBranch === true && entry.branch !== undefined) {
    const protectedName =
      (defaultBranch !== undefined && entry.branch === defaultBranch) ||
      (mainBranch !== undefined && entry.branch === mainBranch);
    if (protectedName) {
      throw new WorktreeRefusal(
        `${target} is checked out on ${entry.branch}, the branch the default base names or the one the main checkout is on; that branch is never deleted`,
        "default_branch_delete",
        { branch: entry.branch, defaultBranch: defaultBranch ?? null },
      );
    }
  }

  const warnings: string[] = [];
  if (unpushedLines.length > 0 && merged !== null && merged.merged === "yes") {
    warnings.push(
      `${String(unpushedLines.length)} commit(s) are on no remote branch, but the branch is merged into ${base?.ref ?? "the default branch"} (${merged.via}); not counted as unpushed`,
    );
  }
  const linksRemoved: string[] = [];
  for (const rel of ignoredSymlinks(target)) {
    // `unlink` removes the link itself and never follows it, so the shared
    // directory it points at in the main checkout is left alone.
    try {
      fs.unlinkSync(path.join(target, rel));
      linksRemoved.push(rel);
    } catch (err) {
      warnings.push(`could not unlink ${rel}: ${messageOf(err)}`);
    }
  }

  const forceFlags: string[] = [];
  if (o.force === true) {
    forceFlags.push("--force");
    // git needs the flag twice to remove a locked worktree.
    if (entry.locked) forceFlags.push("--force");
  }
  const removed = git(repo.mainCheckout, [
    "worktree",
    "remove",
    ...forceFlags,
    target,
  ]);
  if (removed.error !== undefined || removed.status !== 0) {
    throw new WorktreeRefusal(
      `git worktree remove failed: ${gitFailure(removed)}`,
      "worktree_remove_failed",
      { path: target },
    );
  }

  const prune = git(repo.mainCheckout, ["worktree", "prune"]);
  const pruned = prune.error === undefined && prune.status === 0;
  if (!pruned) {
    warnings.push(`git worktree prune failed: ${gitFailure(prune)}`);
  }

  let branch: RemoveWorktreeResult["branch"] = {
    deleted: false,
    reason: "kept (pass --delete-branch to delete it)",
  };
  if (o.deleteBranch === true) {
    if (entry.branch === undefined) {
      branch = { deleted: false, reason: "detached HEAD, no branch" };
    } else {
      // `-D` cannot lose work here: an unpushed branch was already refused
      // above, unless `--force` said otherwise or the verdict said the
      // branch is merged into the base, which warned about those commits.
      const deleted = git(repo.mainCheckout, ["branch", "-D", entry.branch]);
      const ok = deleted.error === undefined && deleted.status === 0;
      const text = [deleted.stdout.trim(), deleted.stderr.trim()]
        .filter((part) => part.length > 0)
        .join(" ");
      branch = {
        deleted: ok,
        reason:
          text.length > 0
            ? text
            : ok
              ? `deleted ${entry.branch}`
              : `git branch -D ${entry.branch} failed`,
      };
    }
  }

  return {
    status: "ok",
    worktree: {
      path: target,
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      ...(entry.head !== undefined ? { head: entry.head } : {}),
    },
    linksRemoved,
    merged,
    branch,
    pruned,
    warnings,
  };
}
