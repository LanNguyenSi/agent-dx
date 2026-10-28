import fs from "node:fs";
import path from "node:path";
import {
  GIT_WALK_BOUND_MS,
  REPORT_TIMEOUT,
  REPORT_TIMEOUT_WALK,
  WorktreeRefusal,
  commitSha,
  git,
  gitBytes,
  gitFailure,
  ignoredSymlinks,
  isWithin,
  mergeVerdict,
  parseWorktreeList,
  renderBytes,
  resolveDefaultBase,
  resolveRemoteBase,
  resolveRepo,
  stopIfInterrupted,
  unpushedCommits,
  type MergeVerdict,
} from "./git.js";
import { syncMainCheckout, type SyncMainResult } from "./sync.js";

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
  /** The revision the merge check runs against instead of origin's default
   * branch. Needs `requireMerged` or `deleteBranch`, the two options that
   * run the check; alone it is a usage error rather than a silent no-op. */
  base?: string;
  /** After a successful removal: `git fetch --prune origin` in the main
   * checkout, then a fast-forward to origin's default branch where that is
   * safe (see `syncMainCheckout`). Never part of a refusal: the removal
   * has happened by then, and the outcome is `sync` in the result. */
  syncMain?: boolean;
  /** Refuse (`no_own_commits`) a branch whose tip is its fork point with
   * the base (`merge-base HEAD <base>` is `HEAD`): it has no commit of its
   * own, which is what a worktree created a moment ago looks like, and an
   * ancestry verdict cannot tell it from finished work. Set by `worktree
   * sweep` only; a plain `remove` keeps taking such a branch. */
  requireOwnCommits?: boolean;
  /** Run every check that can refuse, then stop before the first change and
   * report what would have been removed (`dryRun: true` in the result). The
   * same code path as the real removal up to that point, so a dry run
   * refuses exactly where the removal would. */
  dryRun?: boolean;
  /** Aborted when the run is interrupted (SIGINT, SIGTERM): checked before
   * the first change, which then refuses with `interrupted`. */
  signal?: AbortSignal;
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
  /** `--sync-main`'s outcome; `null` when it was not asked for. */
  sync: SyncMainResult | null;
  /** Present (`true`) for a dry run: nothing was changed. */
  dryRun?: true;
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

/** What `deleteCheckedBranch` did. `warnings` names every way the result
 * falls short of a deleted branch with its configuration gone. */
interface BranchDeletion {
  deleted: boolean;
  reason: string;
  warnings: string[];
}

/**
 * Deletes the local `branch` once its worktree is gone, but only while it
 * still points at `checkedHead`: the commit `git worktree list` showed the
 * worktree at before the first check of the removal ran. `git update-ref
 * --no-deref -d refs/heads/<branch> <checkedHead>` compares and deletes in
 * one step, so a commit made on the branch after the checks (in the
 * worktree before it was removed, or from anywhere else) makes git refuse,
 * and the branch is kept with the commit on it. The rest is what `git
 * branch -D` does besides deleting the ref: a branch that another worktree
 * has checked out is kept, and the `branch.<name>` configuration (its
 * upstream, say) is removed with the branch, so a branch made later under
 * the same name does not inherit it.
 */
function deleteCheckedBranch(
  mainCheckout: string,
  branch: string,
  checkedHead: string | undefined,
): BranchDeletion {
  const kept = (why: string): BranchDeletion => ({
    deleted: false,
    reason: `kept ${branch}: ${why}`,
    warnings: [`the branch ${branch} was not deleted: ${why}`],
  });
  if (
    checkedHead === undefined ||
    !/^[0-9a-f]{40,64}$/.test(checkedHead) ||
    /^0+$/.test(checkedHead)
  ) {
    return kept(
      "the commit the checks were made at is not known, so it is not deleted unchecked",
    );
  }
  const listing = git(
    mainCheckout,
    ["worktree", "list", "--porcelain"],
    REPORT_TIMEOUT,
  );
  if (listing.error !== undefined || listing.status !== 0) {
    return kept(
      `cannot tell whether another worktree has it checked out: ${gitFailure(listing)}`,
    );
  }
  const holder = parseWorktreeList(listing.stdout).find(
    (w) => w.branch === branch,
  );
  if (holder !== undefined) {
    return kept(`it is checked out in ${holder.path}`);
  }
  const ref = `refs/heads/${branch}`;
  const deleted = git(
    mainCheckout,
    ["update-ref", "--no-deref", "-d", ref, checkedHead],
    REPORT_TIMEOUT,
  );
  if (deleted.error !== undefined || deleted.status !== 0) {
    // The deletion is conditional on the checked commit, so a branch that
    // moved fails it; reading the branch again tells that from a git error.
    const now = git(
      mainCheckout,
      ["rev-parse", "--verify", "--quiet", ref],
      REPORT_TIMEOUT,
    );
    const nowSha =
      now.error === undefined && now.status === 0
        ? now.stdout.trim()
        : undefined;
    if (nowSha !== undefined && nowSha !== checkedHead) {
      return kept(
        `it points at ${nowSha} now, not at ${checkedHead} where the checks found it (a commit made while the removal ran, say), so it is kept with that commit`,
      );
    }
    if (nowSha === undefined && now.error === undefined) {
      const gone = `git update-ref -d ${ref} ${checkedHead} failed (${gitFailure(deleted)}), and ${branch} no longer exists`;
      return { deleted: false, reason: gone, warnings: [gone] };
    }
    return kept(
      `git update-ref -d ${ref} ${checkedHead} failed: ${gitFailure(deleted)}`,
    );
  }
  const result: BranchDeletion = {
    deleted: true,
    reason: `deleted ${branch} (was ${checkedHead})`,
    warnings: [],
  };
  const section = `branch.${branch}`;
  const config = git(
    mainCheckout,
    ["config", "--local", "--list", "--name-only", "-z"],
    REPORT_TIMEOUT,
  );
  if (config.error !== undefined || config.status !== 0) {
    result.warnings.push(
      `deleted ${branch}, but could not read the configuration to remove its \`${section}\` section: ${gitFailure(config)}`,
    );
    return result;
  }
  // The section of a key is everything before its last dot, so the
  // `branch.feat.x.remote` of a sibling branch `feat.x` is not `feat`'s.
  const hasSection = config.stdout
    .split("\0")
    .some((name) => name.slice(0, name.lastIndexOf(".")) === section);
  if (hasSection) {
    const dropped = git(
      mainCheckout,
      ["config", "--local", "--remove-section", section],
      REPORT_TIMEOUT,
    );
    if (dropped.error !== undefined || dropped.status !== 0) {
      result.warnings.push(
        `deleted ${branch}, but its \`${section}\` configuration is left: ${gitFailure(dropped)}`,
      );
    }
  }
  return result;
}

/** What `flaggedFiles` found: each tracked path flagged assume-unchanged or
 * skip-worktree that is present in the work tree, as `<path> is flagged
 * <flag>`, or why that could not be told. */
type FlaggedFiles =
  { ok: true; flagged: string[] } | { ok: false; why: string };

/**
 * Tracked paths whose edits `git status` does not show. A path flagged
 * assume-unchanged (`git ls-files -v` prints its tag in lowercase) or
 * skip-worktree (tag `S`, `s` with both flags) is not compared with the
 * work tree by status, so an edit to it would go with the worktree unseen.
 * Its content is not compared here either: every flagged path that is
 * present in the work tree (a file, a link, a directory, anything `lstat`
 * finds) is listed, edited or not. A flagged path that is absent (a sparse
 * checkout leaves it out) has nothing in it to lose and is not listed, nor
 * is a submodule entry (mode 160000), which git never compares with the
 * index. The paths are read from `git ls-files -s -v -z`; a listing that
 * cannot be read, or a path that cannot be inspected, is `ok: false`.
 */
function flaggedFiles(target: string): FlaggedFiles {
  const listing = gitBytes(target, ["ls-files", "-s", "-v", "-z"], {
    ...REPORT_TIMEOUT_WALK,
  });
  if (listing.error !== undefined || listing.status !== 0) {
    return {
      ok: false,
      why: `git ls-files -s -v failed: ${gitFailure({ ...listing, stdout: "" })}`,
    };
  }
  const flagged: string[] = [];
  const records = listing.stdout.toString("latin1").split("\0");
  let offset = 0;
  for (const record of records) {
    const bytes = listing.stdout.subarray(offset, offset + record.length);
    offset += record.length + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const fields = (tab < 0 ? "" : record.slice(0, tab)).split(" ");
    const [tag = "", mode = "", oid = ""] = fields;
    if (
      fields.length !== 4 ||
      !/^[A-Za-z?]$/.test(tag) ||
      !/^[0-7]{6}$/.test(mode) ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)
    ) {
      return {
        ok: false,
        why: `git ls-files -s -v printed a line it cannot be read from: ${JSON.stringify(record.slice(0, 120))}`,
      };
    }
    const assumeUnchanged = tag !== tag.toUpperCase();
    const skipWorktree = tag.toUpperCase() === "S";
    if (!assumeUnchanged && !skipWorktree) continue;
    if (mode === "160000") continue;
    const rel = bytes.subarray(tab + 1);
    const label = `${renderBytes(rel)} is flagged ${[
      ...(assumeUnchanged ? ["assume-unchanged"] : []),
      ...(skipWorktree ? ["skip-worktree"] : []),
    ].join(" and ")}`;
    try {
      fs.lstatSync(
        Buffer.concat([Buffer.from(target), Buffer.from(path.sep), rel]),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { ok: false, why: `cannot inspect ${label}: ${messageOf(err)}` };
    }
    flagged.push(label);
  }
  return { ok: true, flagged };
}

/**
 * Removes one linked worktree: the locked, nested-worktree, submodule,
 * status (with the flagged files whose edits status does not show,
 * `flaggedFiles`), merged and unpushed checks first, each of the last three
 * failing closed so that a git command which cannot answer is a refusal
 * rather than a clean,
 * unpushed or unmerged reading. Then, once a SIGINT or SIGTERM that arrived
 * during the checks has had its chance to stop the command
 * (`stopIfInterrupted`), HEAD is read again and the removal refuses
 * (`head_moved`) unless it is still the commit `git worktree list` showed
 * before the first check. Then the ignored dependency links (unlinked, never
 * followed), then `git worktree remove` and `git worktree prune`, and finally
 * the optional deletion of the branch, only while it still points at that
 * listed commit (`deleteCheckedBranch`).
 *
 * The main checkout is not modified by the removal: its HEAD, index,
 * working tree and stash are untouched, and `git stash`, `checkout`,
 * `switch` and `reset` are never run anywhere. Every git call that writes
 * acts on the main checkout's administrative directories only (`worktree
 * remove`, `worktree prune`, and for the branch `update-ref -d` and `config
 * --remove-section`); everything else reads the worktree. The one exception is `syncMain`, which may fast-forward the main
 * checkout when it is clean and on the default branch (see `sync.ts`).
 */
export async function removeWorktree(
  o: RemoveWorktreeOptions,
): Promise<RemoveWorktreeResult> {
  if (
    o.base !== undefined &&
    o.requireMerged !== true &&
    o.deleteBranch !== true
  ) {
    throw new WorktreeRefusal(
      "--base only applies to the merge check; pass it with --require-merged or --delete-branch",
      "option_invalid",
    );
  }
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

  // --base must be a remote-tracking branch, resolved once here to a full
  // ref; anything else refuses before anything is read or changed.
  let explicitBase: { ref: string; ghBase: string; label: string } | undefined;
  if (o.base !== undefined) {
    const resolved = resolveRemoteBase(repo.mainCheckout, o.base);
    if (!resolved.ok) {
      throw new WorktreeRefusal(
        resolved.reason === "base_not_found"
          ? `--base ${o.base} does not name an existing remote-tracking branch in ${repo.mainCheckout}`
          : `--base ${o.base} is not a remote-tracking branch; pass <remote>/<branch> or refs/remotes/<remote>/<branch> of a configured remote`,
        resolved.reason,
        { base: o.base },
      );
    }
    explicitBase = {
      ref: resolved.base.ref,
      ghBase: resolved.base.branch,
      label: resolved.base.ref,
    };
  }

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

  // A status that did not finish is a failed status: `status_unknown`
  // below, which `--force` overrides like any other unknown state.
  const status = git(
    target,
    ["status", "--porcelain", "--untracked-files=all"],
    REPORT_TIMEOUT_WALK,
  );
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
  if (o.force !== true) {
    const flags = flaggedFiles(target);
    if (!flags.ok) {
      throw new WorktreeRefusal(
        `cannot tell whether ${target} has tracked files flagged assume-unchanged or skip-worktree, whose edits git status does not show: ${flags.why}; pass --force to remove it anyway`,
        "worktree_dirty",
      );
    }
    if (flags.flagged.length > 0) {
      const one = flags.flagged.length === 1;
      const more = flags.flagged.length - 3;
      throw new WorktreeRefusal(
        `${target}: ${flags.flagged.slice(0, 3).join(", ")}${more > 0 ? `, and ${String(more)} more` : ""}, so git status does not show edits to ${one ? "it" : "them"}; clear the flag (\`git update-index --no-assume-unchanged\` or \`--no-skip-worktree\`) or pass --force to remove the worktree with ${one ? "it" : "them"}`,
        "worktree_dirty",
        { flagged: flags.flagged.slice(0, DIRTY_DETAIL_LINES) },
      );
    }
  }

  const defaultBase = resolveDefaultBase(repo.mainCheckout);
  // resolveRemoteBase is the single guard for a base: it only ever yields
  // an existing, plain remote-tracking ref, which is what lets a merged
  // verdict excuse commits no remote has (below). An explicit --base goes
  // through it above; the default base does inside resolveDefaultBase, and
  // is measured by its full `refs/remotes/origin/<branch>` ref so that a
  // local branch named `origin/<branch>` cannot stand in for it. What the
  // messages show is `label`, git's own unambiguous abbreviation of that ref
  // (`origin/main` in a normal layout).
  const base: { ref: string; ghBase: string; label: string } | undefined =
    explicitBase ??
    (defaultBase === undefined
      ? undefined
      : {
          ref: defaultBase.fullRef,
          ghBase: defaultBase.ghBase,
          label: defaultBase.ref,
        });
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
        : mergeVerdict(
            target,
            "HEAD",
            entry.branch,
            base.ref,
            base.ghBase,
            base.label,
          );
  if (o.requireMerged === true && o.force !== true && merged !== null) {
    if (merged.merged === "no") {
      throw new WorktreeRefusal(
        `${entry.branch ?? "HEAD"} is not merged into ${base?.label ?? "the default branch"}; merge it first, or pass --force to remove the worktree anyway`,
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

  const unpushed = unpushedCommits(target);
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

  const defaultBranch = defaultBase?.ghBase;
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

  if (o.requireOwnCommits === true) {
    // Fails closed: a fork point or a tip that cannot be read is a refusal.
    const tip = commitSha(target, "HEAD", { trustObjectsOnly: true });
    const fork =
      base === undefined
        ? undefined
        : git(target, ["merge-base", "HEAD", base.ref], {
            boundMs: GIT_WALK_BOUND_MS,
            trustObjectsOnly: true,
          });
    const forkSha =
      fork !== undefined && fork.error === undefined && fork.status === 0
        ? fork.stdout.trim()
        : undefined;
    if (tip === undefined || forkSha === undefined || forkSha.length === 0) {
      throw new WorktreeRefusal(
        `cannot tell whether ${entry.branch ?? "HEAD"} has commits of its own since it forked from ${base?.label ?? "the default branch"}, so it is left alone`,
        "no_own_commits",
      );
    }
    if (forkSha === tip) {
      throw new WorktreeRefusal(
        `${entry.branch ?? "HEAD"} has no commits of its own: its tip is its fork point with ${base?.label ?? "the default branch"}, as for a worktree that was just created, so it is left alone (remove it with \`worktree remove --require-merged --delete-branch\` when it is done)`,
        "no_own_commits",
        { head: tip },
      );
    }
  }

  const warnings: string[] = [];
  if (unpushedLines.length > 0 && mergedIntoBase) {
    warnings.push(
      `${String(unpushedLines.length)} commit(s) are on no remote branch, but the branch is merged into ${base?.label ?? "the default branch"} (${merged.via}); not counted as unpushed`,
    );
  }
  const links = ignoredSymlinks(target);

  // Everything above only read. A SIGINT or SIGTERM that arrived while it
  // ran is handled here, before the first change; after this point the
  // removal runs to its end.
  await stopIfInterrupted(
    o.signal,
    `worktree remove of ${target} was interrupted (SIGINT or SIGTERM) before its first change; nothing was removed`,
  );

  // The last read before the first change: the worktree's HEAD must still
  // be the commit `git worktree list` showed before the first check, which
  // is also the one the branch deletion compares against. A HEAD that can
  // be read and moved while the checks ran, and is still moved, refuses
  // here, with or without --force; one moved away and back before this read
  // is not seen. When the listing showed no commit (an unborn branch is the
  // zero id) or HEAD names none now (unborn, or a commit object that is
  // missing), whether it moved cannot be told: a refusal without --force,
  // which fails closed, and nothing to refuse with it.
  const listedHead =
    entry.head !== undefined &&
    /^[0-9a-f]{40,64}$/.test(entry.head) &&
    !/^0+$/.test(entry.head)
      ? entry.head
      : undefined;
  const headNow = commitSha(target, "HEAD", { trustObjectsOnly: true });
  if (
    headNow !== undefined &&
    listedHead !== undefined &&
    headNow !== listedHead
  ) {
    throw new WorktreeRefusal(
      `the HEAD of ${target} is at ${headNow} now, not at ${listedHead} where \`git worktree list\` showed it before the checks (something committed, checked out or reset there while they ran), so nothing is removed, with or without --force; run the command again`,
      "head_moved",
      { head: headNow, listed: listedHead },
    );
  }
  if ((headNow === undefined || listedHead === undefined) && o.force !== true) {
    const unreadable = [
      ...(listedHead === undefined
        ? [
            "`git worktree list` showed no commit for it before the checks (an unborn branch)",
          ]
        : []),
      ...(headNow === undefined
        ? [
            "HEAD names no commit that can be read now (an unborn branch, or a commit object that is missing)",
          ]
        : []),
    ];
    throw new WorktreeRefusal(
      `whether the HEAD of ${target} moved while the checks ran cannot be told: ${unreadable.join("; ")}; nothing is removed. Pass --force to remove the worktree anyway`,
      "head_moved",
      { head: headNow ?? null, listed: listedHead ?? null },
    );
  }

  if (o.dryRun === true) {
    return {
      status: "ok",
      worktree: {
        path: target,
        ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
        ...(entry.head !== undefined ? { head: entry.head } : {}),
      },
      linksRemoved: [],
      merged,
      branch: {
        deleted: false,
        reason:
          o.deleteBranch === true
            ? "dry run: nothing was changed, the branch would be deleted"
            : "dry run: nothing was changed",
      },
      pruned: false,
      sync:
        o.syncMain === true
          ? {
              status: "skipped",
              reason: "dry run: nothing was changed",
              fetch: "skipped",
            }
          : null,
      dryRun: true,
      warnings,
    };
  }

  const linksRemoved: string[] = [];
  for (const rel of links) {
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
  const removed = git(
    repo.mainCheckout,
    ["worktree", "remove", ...forceFlags, target],
    REPORT_TIMEOUT_WALK,
  );
  if (removed.error !== undefined || removed.status !== 0) {
    throw new WorktreeRefusal(
      `git worktree remove failed: ${gitFailure(removed)}${
        removed.timedOut === true
          ? `. It was stopped part way, so ${target} may be partly removed; check \`git worktree list\` and the directory before trying again`
          : ""
      }`,
      "worktree_remove_failed",
      { path: target },
    );
  }

  const prune = git(repo.mainCheckout, ["worktree", "prune"], REPORT_TIMEOUT);
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
      // The deletion cannot lose work here: an unpushed branch was already
      // refused above, unless `--force` said otherwise or the verdict said
      // the branch is merged into the base, which warned about those
      // commits; and it only deletes the branch at the commit the worktree
      // list showed before those checks ran.
      const deletion = deleteCheckedBranch(
        repo.mainCheckout,
        entry.branch,
        entry.head,
      );
      const ok = deletion.deleted;
      branch = { deleted: ok, reason: deletion.reason };
      warnings.push(...deletion.warnings);
      if (ok && merged !== null) {
        const where = base?.label ?? "the default branch";
        const hint =
          o.requireMerged === true
            ? "--force overrode --require-merged"
            : "pass --require-merged to refuse instead";
        if (merged.merged === "no") {
          warnings.push(
            `deleted branch ${entry.branch}, which is not merged into ${where} (${merged.via}: ${merged.reason}); ${hint}`,
          );
        } else if (merged.merged === "unknown") {
          warnings.push(
            `deleted branch ${entry.branch}, but whether it is merged into ${where} is unknown (${merged.reason}); ${hint}`,
          );
        }
      }
    }
  }

  let sync: SyncMainResult | null = null;
  if (o.syncMain === true) {
    sync = syncMainCheckout(repo.mainCheckout);
    if (sync.status === "failed") {
      warnings.push(`--sync-main: ${sync.reason}`);
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
    sync,
    warnings,
  };
}
