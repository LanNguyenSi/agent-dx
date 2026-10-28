import fs from "node:fs";
import path from "node:path";
import {
  FETCH_TIMEOUT_MS,
  GIT_WALK_BOUND_MS,
  REPORT_TIMEOUT,
  REPORT_TIMEOUT_WALK,
  git,
  gitFailure,
  gitText,
  isGitTimeout,
  resolveDefaultBase,
} from "./git.js";

/**
 * `worktree remove --sync-main`: brings the main checkout up to date after a
 * worktree is gone. It fetches `origin` with `--prune` (so the remote
 * branch a merged pull request deleted disappears from the remote-tracking
 * refs) and `--no-prune-tags` (so a `fetch.pruneTags` setting cannot delete
 * a tag only this repository has), then fast-forwards the main checkout to
 * origin's default branch, but only where that cannot cost anything: no
 * merge, cherry-pick, revert, rebase, `am`, sequencer or bisect is in
 * progress, the main checkout is on the default branch, has no staged,
 * unstaged or untracked change, is not ahead of or diverged from the remote
 * branch, and no file the fast-forward would add is already in the way.
 * Anything else is a `skipped` result with the reason, never a forced one:
 * no `checkout`, `switch`, `reset`, `stash` or `--force` is run, and a
 * non-fast-forward is reported as it is. The merge itself runs with
 * `--no-overwrite-ignore`, so an ignored file or link anywhere on the way
 * (a parent path of a file the fast-forward adds, too) makes git refuse,
 * which is a `failed` result with git's message.
 *
 * Nothing here throws: it runs after the worktree was removed, where a
 * refusal would hide that the removal happened. Every outcome, a timeout
 * included, is a `SyncMainResult`.
 */

export interface SyncMainResult {
  /** `fast_forwarded`: the main checkout moved. `up_to_date`: it was
   * already at the remote branch. `skipped`: a guard held it back (see
   * `reason`). `failed`: the fetch or the fast-forward itself failed. */
  status: "fast_forwarded" | "up_to_date" | "skipped" | "failed";
  /** Why, in a sentence; for `skipped` and `failed` the guard or git's own
   * message. */
  reason: string;
  /** `fetched`, `failed` (the merge step is then not tried) or `skipped`
   * (no `origin` remote). */
  fetch: "fetched" | "failed" | "skipped";
  /** The branch the main checkout is on, when it has one. */
  branch?: string;
  /** The remote-tracking branch it was measured against. */
  base?: string;
  /** Commits only the main checkout has / only the remote branch has. */
  ahead?: number;
  behind?: number;
  /** The commit the main checkout was at, and is at now, when it moved. */
  from?: string;
  to?: string;
}

function result(
  status: SyncMainResult["status"],
  reason: string,
  fetch: SyncMainResult["fetch"],
  extra: Partial<SyncMainResult> = {},
): SyncMainResult {
  return { status, reason, fetch, ...extra };
}

/** What git keeps in the git directory while an operation is part way:
 * a fast-forward in the middle of one would move the branch under it. */
const IN_PROGRESS = [
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["rebase-apply", "a rebase or `git am`"],
  ["rebase-merge", "a rebase"],
  ["sequencer", "a cherry-pick or revert sequence"],
  ["BISECT_LOG", "a bisect"],
] as const;

/** The operation in progress in the main checkout, `undefined` when there
 * is none, or `unknown` when git cannot say where it would keep one. */
function operationInProgress(main: string): string | undefined {
  const r = git(
    main,
    ["rev-parse", ...IN_PROGRESS.flatMap(([name]) => ["--git-path", name])],
    REPORT_TIMEOUT,
  );
  const paths = r.stdout.split("\n").filter((line) => line.length > 0);
  if (
    r.error !== undefined ||
    r.status !== 0 ||
    paths.length !== IN_PROGRESS.length
  ) {
    return "unknown";
  }
  for (const [index, at] of paths.entries()) {
    let present = true;
    try {
      // lstat: a link there counts too, wherever it points.
      fs.lstatSync(path.resolve(main, at));
    } catch {
      present = false;
    }
    if (present) {
      const [name, what] = IN_PROGRESS[index] ?? ["?", "an operation"];
      return `${what} (${name})`;
    }
  }
  return undefined;
}

/** Paths the fast-forward from HEAD to `target` would add that already
 * exist in the work tree. The status check ran first, so such a file is
 * ignored by git, which `merge` would overwrite without a word. Only the
 * paths themselves are looked at; a parent path in the way is left to the
 * merge's `--no-overwrite-ignore`. */
function pathsInTheWay(main: string, target: string): string[] | undefined {
  const added = git(
    main,
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--diff-filter=A",
      "HEAD",
      target,
      "--",
    ],
    { ...REPORT_TIMEOUT_WALK, trustObjectsOnly: true },
  );
  if (added.error !== undefined || added.status !== 0) return undefined;
  const found: string[] = [];
  for (const rel of added.stdout.split("\0")) {
    if (rel.length === 0) continue;
    try {
      fs.lstatSync(path.join(main, rel));
      found.push(rel);
    } catch {
      // not there: nothing in the way
    }
  }
  return found;
}

function syncSteps(main: string): SyncMainResult {
  const remote = gitText(main, ["remote", "get-url", "origin"], REPORT_TIMEOUT);
  if (remote === undefined) {
    return result("skipped", "the repository has no origin remote", "skipped");
  }
  const fetched = git(
    main,
    [
      "fetch",
      "--quiet",
      "--prune",
      "--no-prune-tags",
      "--no-recurse-submodules",
      "origin",
    ],
    { boundMs: FETCH_TIMEOUT_MS, onTimeout: "report" },
  );
  if (fetched.error !== undefined || fetched.status !== 0) {
    return result(
      "failed",
      `git fetch --prune origin failed: ${gitFailure(fetched)}`,
      "failed",
    );
  }

  const base = resolveDefaultBase(main);
  if (base === undefined) {
    return result(
      "skipped",
      "origin's default branch cannot be resolved",
      "fetched",
    );
  }
  const busy = operationInProgress(main);
  if (busy !== undefined) {
    return result(
      "skipped",
      busy === "unknown"
        ? "cannot tell whether an operation is in progress in the main checkout"
        : `${busy} is in progress in the main checkout`,
      "fetched",
      { base: base.ref },
    );
  }
  const onBranch = gitText(
    main,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    REPORT_TIMEOUT,
  );
  if (onBranch === undefined || onBranch.length === 0) {
    return result(
      "skipped",
      "the main checkout is on a detached HEAD, not on the default branch",
      "fetched",
      { base: base.ref },
    );
  }
  if (onBranch !== base.ghBase) {
    return result(
      "skipped",
      `the main checkout is on ${onBranch}, not on the default branch ${base.ghBase}`,
      "fetched",
      { branch: onBranch, base: base.ref },
    );
  }
  const known = { branch: onBranch, base: base.ref };

  const status = git(
    main,
    ["status", "--porcelain", "--untracked-files=all"],
    REPORT_TIMEOUT_WALK,
  );
  if (status.error !== undefined || status.status !== 0) {
    return result(
      "skipped",
      `cannot read the status of the main checkout: ${gitFailure(status)}`,
      "fetched",
      known,
    );
  }
  const dirty = status.stdout.split("\n").filter((line) => line.length > 0);
  if (dirty.length > 0) {
    return result(
      "skipped",
      `the main checkout has ${String(dirty.length)} staged, unstaged or untracked change(s)`,
      "fetched",
      known,
    );
  }

  const counted = git(
    main,
    ["rev-list", "--left-right", "--count", `HEAD...${base.fullRef}`],
    { ...REPORT_TIMEOUT_WALK, trustObjectsOnly: true },
  );
  const [left, right] = counted.stdout.trim().split("\t");
  const ahead = Number(left);
  const behind = Number(right);
  if (
    counted.error !== undefined ||
    counted.status !== 0 ||
    !Number.isInteger(ahead) ||
    !Number.isInteger(behind)
  ) {
    return result(
      "skipped",
      `cannot compare the main checkout with ${base.ref}: ${gitFailure(counted)}`,
      "fetched",
      known,
    );
  }
  const counts = { ...known, ahead, behind };
  if (ahead > 0 && behind > 0) {
    return result(
      "skipped",
      `the main checkout has diverged from ${base.ref} (${String(ahead)} ahead, ${String(behind)} behind); not a fast-forward, so nothing was changed`,
      "fetched",
      counts,
    );
  }
  if (ahead > 0) {
    return result(
      "skipped",
      `the main checkout is ${String(ahead)} commit(s) ahead of ${base.ref}; there is nothing to fast-forward`,
      "fetched",
      counts,
    );
  }
  if (behind === 0) {
    return result(
      "up_to_date",
      `the main checkout is at ${base.ref}`,
      "fetched",
      counts,
    );
  }

  const inTheWay = pathsInTheWay(main, base.fullRef);
  if (inTheWay === undefined) {
    return result(
      "skipped",
      "cannot tell whether the fast-forward would overwrite an ignored file",
      "fetched",
      counts,
    );
  }
  if (inTheWay.length > 0) {
    return result(
      "skipped",
      `the fast-forward would overwrite ${String(inTheWay.length)} ignored file(s) already in the work tree (${inTheWay.slice(0, 3).join(", ")}${inTheWay.length > 3 ? ", ..." : ""})`,
      "fetched",
      counts,
    );
  }

  const from = gitText(main, ["rev-parse", "HEAD"], REPORT_TIMEOUT);
  const merged = git(
    main,
    [
      "merge",
      "--ff-only",
      "--no-autostash",
      "--no-overwrite-ignore",
      "--quiet",
      base.fullRef,
    ],
    { boundMs: GIT_WALK_BOUND_MS, onTimeout: "report" },
  );
  if (merged.error !== undefined || merged.status !== 0) {
    return result(
      "failed",
      `git merge --ff-only ${base.ref} failed: ${gitFailure(merged)}`,
      "fetched",
      counts,
    );
  }
  const to = gitText(main, ["rev-parse", "HEAD"], REPORT_TIMEOUT);
  return result(
    "fast_forwarded",
    `fast-forwarded ${onBranch} to ${base.ref} (${String(behind)} commit(s))`,
    "fetched",
    {
      ...counts,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    },
  );
}

/** Fetches and fast-forwards the main checkout at `main`; see the header. */
export function syncMainCheckout(main: string): SyncMainResult {
  try {
    return syncSteps(main);
  } catch (err) {
    if (!isGitTimeout(err)) throw err;
    return result("failed", err.message, "failed");
  }
}
