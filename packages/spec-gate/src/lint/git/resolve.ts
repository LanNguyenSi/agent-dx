/**
 * Turns the git flags of `spec-gate lint` into the resolved inputs the rules
 * read: the repository, the reference commit, the diff base and the head,
 * all full commit ids, resolved once here and never by a rule.
 *
 * Offline and read-only: a ref the caller names is looked up, never
 * fetched. Without `--default-ref` and `--base` there are no git inputs and
 * every rule that needs git is skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { LintGitError, runGit } from "./exec.js";
import { assertCommit, mergeBase, resolveHead, resolveRef } from "./index.js";
import type { GitInputs } from "../types.js";

/** The git flags as the caller gave them. */
export interface GitRequest {
  /** `--repo`: a directory inside the work tree; default the spec directory. */
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
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/** Whether `inner` is `outer` or below it; both are real paths. */
function isInside(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return !(
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  );
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
  if (request.repo !== undefined && request.repo.trim() === "") {
    return fail("--repo needs a path");
  }
  try {
    const where = request.repo ?? specDir;
    // A failed `rev-parse` prints nothing, so the empty check covers it.
    const top = runGit(where, ["rev-parse", "--show-toplevel"]);
    const toplevel = top.stdout.toString("utf8").trim();
    if (toplevel === "") {
      return fail(
        request.repo === undefined
          ? "the spec directory is not inside a git work tree; pass --repo <dir>"
          : "--repo is not inside a git work tree",
      );
    }
    const spec = realpath(specDir);
    const root = realpath(toplevel);
    if (spec === null || root === null || !isInside(root, spec)) {
      return fail("the spec directory is not inside the repository");
    }

    if (request.defaultRef !== undefined) {
      // Validated even when --base wins, so a bad value never goes unseen.
      resolveRefFlag(toplevel, request.defaultRef);
    }
    const reference =
      request.base !== undefined
        ? resolveBaseFlag(toplevel, request.base)
        : resolveRefFlag(toplevel, request.defaultRef!);

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
