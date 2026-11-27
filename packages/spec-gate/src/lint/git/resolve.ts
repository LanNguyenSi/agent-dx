/**
 * Turns the git flags of `spec-gate lint` into the resolved inputs the rules
 * read: the repository, the reference commit, the diff base and the head,
 * all full commit ids, resolved once here and never by a rule.
 *
 * Offline and read-only: a ref the caller names is looked up, never
 * fetched. Without `--default-ref` and `--base` there are no git inputs and
 * every rule that needs git is skipped.
 *
 * The repository is the one `--repo` names and nothing else: it is never
 * discovered from the spec directory, which the spec author writes. A git
 * directory the author could have committed into the work tree is refused.
 */
import fs from "node:fs";
import {
  REPO_LAYOUT_ARGS,
  gitDirProblem,
  isInside,
  parseRepoLayout,
} from "../../canonical/git-hardening.js";
import { LintGitError, runGit } from "./exec.js";
import {
  assertCommit,
  isAncestor,
  mergeBase,
  resolveHead,
  resolveRef,
} from "./index.js";
import type { GitInputs } from "../types.js";

/** The git flags as the caller gave them. */
export interface GitRequest {
  /** `--repo`: the trusted checkout root; required with `--default-ref` and `--base`. */
  repo?: string;
  /** `--default-ref`: a full ref name under `refs/`. */
  defaultRef?: string;
  /** `--base`: the pull request base, a full commit id. */
  base?: string;
}

export type GitResolution =
  { ok: true; git: GitInputs | undefined } | { ok: false; message: string };

/** Whether the request carries a git input (`--repo` alone is not one). */
export function hasGitInputs(request: GitRequest | undefined): boolean {
  return (
    request !== undefined &&
    (request.defaultRef !== undefined || request.base !== undefined)
  );
}

function fail(message: string): GitResolution {
  return { ok: false, message };
}

function realpath(dir: string): string | null {
  try {
    // The native form so a spelling in another case on a case-insensitive
    // volume is compared with the case on disk.
    return fs.realpathSync.native(dir);
  } catch {
    return null;
  }
}

/**
 * Resolves the git inputs for `specDir`. A failure is a usage error: the
 * message names the flag, never git's output, an argument or a path.
 */
export function resolveGitInputs(
  specDir: string,
  request: GitRequest | undefined,
): GitResolution {
  if (request === undefined || !hasGitInputs(request)) {
    return { ok: true, git: undefined };
  }
  if (request.repo === undefined) {
    return fail(
      "--repo <dir> is required with --default-ref and --base: name the trusted checkout root; the repository is never discovered from the spec directory",
    );
  }
  if (request.repo.trim() === "") {
    return fail("--repo needs a path");
  }
  try {
    // A failed `rev-parse` prints nothing, so the layout check covers it.
    const found = runGit(request.repo, [...REPO_LAYOUT_ARGS]);
    const layout = parseRepoLayout(found.stdout.toString("utf8"));
    if (layout === null) {
      return fail("--repo is not inside a git work tree");
    }
    const problem = gitDirProblem(
      layout.toplevel,
      layout.gitDir,
      layout.commonDir,
    );
    if (problem !== null) {
      return fail(`--repo is not a plain git checkout: ${problem}`);
    }
    const toplevel = layout.toplevel;
    const spec = realpath(specDir);
    const root = realpath(toplevel);
    if (spec === null || root === null || !isInside(root, spec)) {
      return fail("the spec directory is not inside the repository");
    }

    // Both are validated even when --base wins, so a bad value never goes
    // unseen.
    const defaultCommit =
      request.defaultRef !== undefined
        ? resolveRefFlag(toplevel, request.defaultRef)
        : undefined;
    const baseCommit =
      request.base !== undefined
        ? resolveBaseFlag(toplevel, request.base)
        : undefined;
    if (
      defaultCommit !== undefined &&
      baseCommit !== undefined &&
      !isAncestor(toplevel, baseCommit, defaultCommit)
    ) {
      // A base the author could pick on a branch of their own would make
      // every ancestry check pass against history the author wrote.
      return fail("--base is not on --default-ref");
    }
    const reference = baseCommit ?? defaultCommit!;

    const head = resolveHead(toplevel);
    const diffBase = mergeBase(toplevel, head, reference);
    if (diffBase === null) {
      return fail("HEAD and the reference commit share no history");
    }
    return { ok: true, git: { repo: toplevel, reference, diffBase, head } };
  } catch (err) {
    if (err instanceof FlagError) return fail(err.message);
    if (err instanceof LintGitError) {
      return fail(
        err.code === "not-a-commit"
          ? "HEAD does not name a commit"
          : "git could not be read",
      );
    }
    throw err;
  }
}

class FlagError extends Error {}

function resolveRefFlag(repo: string, ref: string): string {
  try {
    return resolveRef(repo, ref);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    if (err.code === "ref-invalid") {
      throw new FlagError(
        "--default-ref is not a valid full ref name under refs/ (for example refs/remotes/origin/main)",
      );
    }
    if (err.code === "ref-unresolvable" || err.code === "not-a-commit") {
      throw new FlagError("--default-ref does not resolve to a commit");
    }
    throw err;
  }
}

function resolveBaseFlag(repo: string, base: string): string {
  try {
    assertCommit(repo, base);
    return base;
  } catch (err) {
    if (err instanceof LintGitError && err.code === "not-a-commit") {
      throw new FlagError(
        "--base is not the full id of a commit in the repository",
      );
    }
    throw err;
  }
}
