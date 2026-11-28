/**
 * Repositories for the measuring base of lint, propose and repo-check: the
 * one merge base of HEAD and the default commit. Each builder starts from
 * `plainHistory` (the default branch `main` at `c1`, the branch `pr`
 * checked out from it) with `files(c1)` committed on `pr`, and shapes the
 * history so that there is one merge base, several, none, or a shallow
 * clone that hides where the histories meet.
 */
import path from "node:path";
import { git } from "../canonical/helpers.js";
import { REMOTE_MAIN, Repo, plainHistory } from "./git-helpers.js";
import { scratch } from "./helpers.js";

/** The files the branch commits, given the default commit `c1`. */
// eslint-disable-next-line no-unused-vars
export type Files = (c1: string) => Record<string, string>;

export interface Shaped {
  repo: Repo;
  c0: string;
  c1: string;
  /** The checkout the verb runs in: `repo.dir` or a shallow clone of it. */
  dir: string;
}

/** `files` on `pr` on top of the default commit `c1`: one merge base, `c1`. */
export async function oneBase(files: Files): Promise<Shaped> {
  const { repo, c0, c1 } = await plainHistory();
  await repo.commit(files(c1), "the branch");
  return { repo, c0, c1, dir: repo.dir };
}

/**
 * Crossed histories: the default branch makes `a1` and merges the branch
 * commit `b1`, the branch merges `a1`. HEAD and the default ref then have
 * two merge bases, `a1` and `b1`, and git's plain `merge-base` names one.
 */
export async function twoBases(
  files: Files,
): Promise<Shaped & { bases: string[] }> {
  const { repo, c0, c1 } = await plainHistory();
  const b1 = await repo.commit(files(c1), "the branch");
  await repo.checkout("main");
  const a1 = await repo.commit({ "a.txt": "a\n" }, "the default branch");
  await repo.sh("merge", "-q", "--no-ff", "-m", "the default merges b1", b1);
  await repo.setRef(REMOTE_MAIN, await repo.head());
  await repo.checkout("pr");
  await repo.sh("merge", "-q", "--no-ff", "-m", "the branch merges a1", a1);
  const bases = (
    await repo.sh("merge-base", "--all", "HEAD", REMOTE_MAIN)
  ).split("\n");
  if (bases.length !== 2) throw new Error("the histories did not cross");
  return { repo, c0, c1, dir: repo.dir, bases: [a1, b1] };
}

/** `files` on an orphan branch: HEAD shares no history with the default commit. */
export async function noBase(files: Files): Promise<Shaped> {
  const { repo, c0, c1 } = await plainHistory();
  await repo.sh("checkout", "-q", "--orphan", "island");
  await repo.commit(files(c1), "unrelated");
  return { repo, c0, c1, dir: repo.dir };
}

/**
 * A clone of `oneBase` two commits deep over `file://`: the default commit
 * `c1` is the parent of HEAD there, so git still finds the one merge base,
 * but the history ends at a boundary.
 */
export async function shallow(files: Files): Promise<Shaped> {
  const shaped = await oneBase(files);
  const dir = path.join(scratch(), "shallow");
  await git(scratch(), [
    "clone",
    "-q",
    "--depth",
    "2",
    "--no-single-branch",
    `file://${shaped.repo.dir}`,
    dir,
  ]);
  const flag = await git(dir, ["rev-parse", "--is-shallow-repository"]);
  if (flag !== "true") throw new Error("the clone is not shallow");
  return { ...shaped, dir };
}

/**
 * The default branch moves on after the pull request base `c1` with
 * `gained`, and the branch merges it and then commits `after`. Measured from
 * `c1` the branch changes only what `after` changes against `c1`; measured
 * from the merge base with the default branch it also undoes `gained`.
 */
export async function staleBase(
  files: Files,
  gained: Record<string, string>,
  after: Record<string, string | null>,
): Promise<Shaped & { newer: string }> {
  const { repo, c0, c1 } = await plainHistory();
  await repo.commit(files(c1), "the branch");
  await repo.checkout("main");
  const newer = await repo.commit(gained, "the default branch moves on");
  await repo.setRef(REMOTE_MAIN, newer);
  await repo.checkout("pr");
  await repo.sh("merge", "-q", "--no-ff", "-m", "merge the default", newer);
  await repo.commit(after, "after the merge");
  return { repo, c0, c1, dir: repo.dir, newer };
}

/** The usage error of a run that measures from one of several merge bases. */
export const SEVERAL =
  "HEAD and the --default-ref commit have 2 merge bases; nothing is measured from one of several. Merge the default branch into the branch, or rebase onto it, so that one remains";
export const NONE = "HEAD and the reference commit share no history";
export const SHALLOW =
  "the repository is shallow: a merge base can be older than the true one, from which a change can fail to show; nothing is measured, check out the full history";
export const BASE_ALONE =
  "--base needs --default-ref <ref>: the change is measured from the merge base of HEAD and the --default-ref commit, never from --base";
export const BASE_OFF = "--base is not on --default-ref";
