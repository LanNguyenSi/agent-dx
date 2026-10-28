import path from "node:path";
import { WorktreeRefusal, type MergeVerdict } from "./git.js";
import { listWorktrees, type ListedWorktree } from "./list.js";
import { removeWorktree } from "./remove.js";

/**
 * `worktree sweep`: removes, in one call, every linked worktree among the
 * direct children of one directory whose work is in origin's default
 * branch, together with its local branch.
 *
 * It adds no rule of its own. A worktree is looked at by `listWorktrees`
 * (the same dirty state and the same merge verdict `list` and `remove
 * --require-merged` report), and only one that is clean and merged is handed
 * to `removeWorktree` with `deleteBranch` and `requireMerged`, so every guard
 * of that command (locked, nested worktree, submodules, unpushed commits not
 * covered by the merge verdict, the default branch and the main checkout's
 * branch never deleted) holds here too. A refusal of `removeWorktree` is a
 * skipped entry with its reason, never a failed sweep. `--force` does not
 * exist for a sweep.
 */

export interface SweepWorktreesOptions {
  /** The invocation directory; `root` resolves against it. */
  cwd: string;
  /** The directory whose direct children are looked at. */
  root: string;
  /** Decide and report, change nothing: each removable entry is checked by
   * `removeWorktree` in its dry-run mode, which stops before its first
   * change. */
  dryRun?: boolean;
  /** Aborted when the run is interrupted; handed to each removal. */
  signal?: AbortSignal;
}

export type SweepAction = "removed" | "would_remove" | "skipped" | "ignored";

export interface SweepEntry {
  path: string;
  /** The basename of the main checkout the entry belongs to. */
  repo: string;
  branch?: string;
  action: SweepAction;
  /** Why, in a sentence: the removal done, or the guard that held it back. */
  reason: string;
  /** The machine-readable cause of a skip made by `removeWorktree`
   * (`worktree_dirty`, `unpushed_commits`, ...); absent otherwise. */
  refusal?: string;
  /** The merge verdict the decision rests on. */
  merged: MergeVerdict;
  /** The local branch was deleted along with the worktree. */
  branchDeleted?: boolean;
}

export interface SweepWorktreesResult {
  /** `ok`: nothing was skipped (an `ignored` main checkout does not count).
   * `partial`: at least one worktree was skipped. */
  status: "ok" | "partial";
  dryRun: boolean;
  root: string;
  summary: {
    removed: number;
    wouldRemove: number;
    skipped: number;
    ignored: number;
  };
  entries: SweepEntry[];
  warnings: string[];
}

function entryOf(
  w: ListedWorktree,
  action: SweepAction,
  reason: string,
  extra: Partial<SweepEntry> = {},
): SweepEntry {
  return {
    path: w.path,
    repo: w.repo,
    ...(w.branch !== undefined ? { branch: w.branch } : {}),
    action,
    reason,
    merged: w.merged,
    ...extra,
  };
}

/** Why `w` is not handed to the removal, or `undefined` when it is. The
 * checks `removeWorktree` repeats (locked, ...) are listed here too so the
 * reason is the plain one and the removal is not attempted. */
function notEligible(w: ListedWorktree): string | undefined {
  if (w.prunable) {
    return `prunable entry, the directory is gone or no longer a worktree (${w.merged.reason})`;
  }
  if (w.locked) {
    return "locked; `git worktree unlock` it first";
  }
  if (w.branch === undefined) {
    return "detached HEAD: there is no branch to delete with it";
  }
  if (w.dirty === null) {
    return "its dirty state could not be read";
  }
  if (w.dirty) {
    return "has uncommitted or untracked changes";
  }
  if (w.merged.merged !== "yes") {
    return `not merged into ${w.base ?? "the default branch"}: ${w.merged.reason}`;
  }
  return undefined;
}

export async function sweepWorktrees(
  o: SweepWorktreesOptions,
): Promise<SweepWorktreesResult> {
  const listed = await listWorktrees({ cwd: o.cwd, root: o.root });
  const dryRun = o.dryRun === true;
  const entries: SweepEntry[] = [];

  for (const w of listed.worktrees) {
    if (w.main) {
      entries.push(
        entryOf(w, "ignored", "main checkout; a sweep never removes it"),
      );
      continue;
    }
    const why = notEligible(w);
    if (why !== undefined) {
      entries.push(entryOf(w, "skipped", why));
      continue;
    }
    try {
      const r = await removeWorktree({
        cwd: o.cwd,
        path: w.path,
        deleteBranch: true,
        requireMerged: true,
        dryRun,
        signal: o.signal,
      });
      if (dryRun) {
        entries.push(
          entryOf(
            w,
            "would_remove",
            `clean and merged (${r.merged?.via ?? "none"}); the worktree and its branch would be removed`,
          ),
        );
        continue;
      }
      entries.push(
        entryOf(w, "removed", r.branch.reason, {
          merged: r.merged ?? w.merged,
          branchDeleted: r.branch.deleted,
        }),
      );
    } catch (err) {
      if (!(err instanceof WorktreeRefusal) || err.reason === "interrupted") {
        throw err;
      }
      entries.push(entryOf(w, "skipped", err.message, { refusal: err.reason }));
    }
  }

  const count = (action: SweepAction): number =>
    entries.filter((e) => e.action === action).length;
  const summary = {
    removed: count("removed"),
    wouldRemove: count("would_remove"),
    skipped: count("skipped"),
    ignored: count("ignored"),
  };
  return {
    status: summary.skipped > 0 ? "partial" : "ok",
    dryRun,
    root: path.resolve(o.cwd, o.root),
    summary,
    entries,
    warnings: listed.warnings,
  };
}
