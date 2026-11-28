/**
 * Turns the git flags of `spec-gate lint` into the resolved inputs the rules
 * read: the repository, the reference commit, the diff base and the head,
 * all full commit ids, resolved once here and never by a rule.
 *
 * The reference commit is the one `--default-ref` names, and the diff base
 * is the measuring base: the one merge base of HEAD and that commit. `--base`
 * is validated (a commit on `--default-ref`) and moves neither. Several merge
 * bases, none, and a shallow repository are refused: from one of several, or
 * from an older commit a shallow boundary leaves, a change can fail to show.
 * A caller that measures the change itself (the approval check, the closing
 * check) asks for the earlier resolution instead, see `ResolveOptions`.
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
  isShallow,
  mergeBase,
  mergeBases,
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

/**
 * How the inputs are resolved. `callerMeasures` is for a caller that derives
 * its own measuring base and history check and reads only the repository,
 * the commits and the head from here (the approval check, the closing
 * check): the reference is then `--base` when given, else the `--default-ref`
 * commit, the diff base the merge base git names first, and neither several
 * merge bases nor a shallow repository is refused. Lint, propose and
 * repo-check never set it.
 */
export interface ResolveOptions {
  callerMeasures?: boolean;
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
  options: ResolveOptions = {},
): GitResolution {
  if (request === undefined || !hasGitInputs(request)) {
    return { ok: true, git: undefined };
  }
  const measured = options.callerMeasures !== true;
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

    // Both are validated, so a bad value never goes unseen.
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
    if (measured && defaultCommit === undefined) {
      // The change is measured from the default branch; a base alone names
      // no default branch, and measured from it a pull request would pick
      // where its own change starts.
      return fail(
        "--base needs --default-ref <ref>: the change is measured from the merge base of HEAD and the --default-ref commit, never from --base",
      );
    }
    const head = resolveHead(toplevel);
    if (!measured) {
      const reference = baseCommit ?? defaultCommit!;
      const diffBase = mergeBase(toplevel, head, reference);
      if (diffBase === null) {
        return fail("HEAD and the reference commit share no history");
      }
      return { ok: true, git: { repo: toplevel, reference, diffBase, head } };
    }

    // Checked before the merge bases: behind a shallow boundary git can
    // name an older commit as the one merge base.
    if (isShallow(toplevel)) {
      return fail(
        "the repository is shallow: a merge base can be older than the true one, from which a change can fail to show; nothing is measured, check out the full history",
      );
    }
    const reference = defaultCommit!;
    const bases = mergeBases(toplevel, head, reference);
    if (bases.length === 0) {
      return fail("HEAD and the reference commit share no history");
    }
    if (bases.length > 1) {
      return fail(
        `HEAD and the --default-ref commit have ${bases.length} merge bases; nothing is measured from one of several. Merge the default branch into the branch, or rebase onto it, so that one remains`,
      );
    }
    return {
      ok: true,
      git: { repo: toplevel, reference, diffBase: bases[0]!, head },
    };
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
