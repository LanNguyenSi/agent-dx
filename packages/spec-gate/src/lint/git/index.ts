/**
 * Read-only git primitives for the lint rules. Every call is an argument
 * list (no shell) through `runGit`, every value that came from outside goes
 * behind `--end-of-options` and is checked before it is passed on, and only
 * full commit ids travel between the primitives: a ref name is resolved to
 * one id once, and from then on only the id is used.
 *
 * Nothing here fetches or writes. A primitive throws `LintGitError` with a
 * fixed message; it never carries git's stderr, an argument or a path.
 */
import { COMMIT_RE } from "../../formats/validate.js";
import { LintGitError, runGit } from "./exec.js";

export {
  GIT_TIMEOUT_MS,
  LintGitError,
  MAX_OUTPUT_BYTES,
  gitEnv,
  type GitRun,
  type LintGitCode,
} from "./exec.js";

/** A full ref name: under `refs/`, never starting with a dash. */
const REF_NAME_RE = /^refs\/[A-Za-z0-9._+/-]+$/;

/** A repository path: `/` separated names, no `.` or `..`, no glob or option characters. */
const REPO_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** The modes of a regular file in a git tree. */
const FILE_MODES = new Set(["100644", "100755"]);

function text(out: Buffer): string {
  return out.toString("utf8").trim();
}

function requireId(id: string): void {
  if (!COMMIT_RE.test(id)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
}

function requirePath(repoPath: string): void {
  if (
    !REPO_PATH_RE.test(repoPath) ||
    repoPath.startsWith("-") ||
    repoPath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new LintGitError("path-invalid", "a repository path is not valid");
  }
}

/**
 * Whether `id` is the full id of a commit object in `repo`. An abbreviation
 * and the id of an annotated tag are not: `rev-parse` peels a tag and
 * resolves an abbreviation (a 40-digit prefix in a SHA-256 repository, for
 * one), and either prints an id that differs from the one it was given.
 */
export function isCommit(repo: string, id: string): boolean {
  if (!COMMIT_RE.test(id)) return false;
  const run = runGit(repo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${id}^{commit}`,
  ]);
  return run.status === 0 && text(run.stdout) === id;
}

/** Throws `not-a-commit` unless `id` is the full id of a commit object in `repo`. */
export function assertCommit(repo: string, id: string): void {
  if (!isCommit(repo, id)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not the full id of a commit in the repository",
    );
  }
}

/**
 * The full id of the commit `rev` peels to, `rev` being a full object id or
 * `HEAD`. A failed `rev-parse` prints nothing, so the id check covers it.
 */
function peel(repo: string, rev: string): string {
  const run = runGit(repo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${rev}^{commit}`,
  ]);
  const id = text(run.stdout);
  if (!COMMIT_RE.test(id)) {
    throw new LintGitError("not-a-commit", "a value does not name a commit");
  }
  return id;
}

/** The full id of the commit `HEAD` points at. */
export function resolveHead(repo: string): string {
  return peel(repo, "HEAD");
}

/**
 * Resolves a full ref name (`refs/remotes/origin/main`) to the full id of a
 * commit, offline and exactly: a short name is refused, so a branch cannot
 * stand in for a tag of the same name, and an annotated tag peels to its
 * commit. `ref-invalid` for a value that is not a valid full ref name,
 * `ref-unresolvable` for one that names no ref in `repo`, `not-a-commit` for
 * a ref that does not lead to a commit.
 */
export function resolveRef(repo: string, ref: string): string {
  if (
    !REF_NAME_RE.test(ref) ||
    runGit(repo, ["check-ref-format", ref]).status !== 0
  ) {
    throw new LintGitError(
      "ref-invalid",
      "a value is not a valid full ref name under refs/",
    );
  }
  // `show-ref --verify` matches the full name exactly; `rev-parse` would
  // also try the short-name search rules.
  const shown = runGit(repo, [
    "show-ref",
    "--verify",
    "--hash",
    "--end-of-options",
    ref,
  ]);
  const id = text(shown.stdout);
  // A failed `show-ref` prints nothing, so the id check covers it.
  if (!COMMIT_RE.test(id)) {
    throw new LintGitError("ref-unresolvable", "a ref does not exist");
  }
  return peel(repo, id);
}

/**
 * Whether `ancestor` is an ancestor of `descendant` (or the same commit):
 * `merge-base --is-ancestor`, never "the commit exists" and never "reachable
 * from HEAD". Both are full commit ids.
 */
export function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): boolean {
  requireId(ancestor);
  requireId(descendant);
  const run = runGit(repo, [
    "merge-base",
    "--is-ancestor",
    "--end-of-options",
    ancestor,
    descendant,
  ]);
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  throw new LintGitError("git-failed", "git could not compare two commits");
}

/** The merge base of two commits, or `null` when their histories share none. */
export function mergeBase(repo: string, a: string, b: string): string | null {
  requireId(a);
  requireId(b);
  const run = runGit(repo, ["merge-base", "--end-of-options", a, b]);
  if (run.status === 1) return null;
  const id = text(run.stdout);
  if (run.status !== 0 || !COMMIT_RE.test(id)) {
    throw new LintGitError("git-failed", "git could not find a merge base");
  }
  return id;
}

/**
 * Every merge base of the commits `a` and `b`: each common ancestor that no
 * other common ancestor descends from, as full commit ids in the order git
 * lists them. No entry when the two share no history. Histories that
 * crossed (each side merged a commit of the other that the other reached on
 * its own) have more than one, and git's plain `merge-base` then prints one
 * of them; a caller that needs one commit to measure a change from must
 * know that there are several.
 */
export function mergeBases(repo: string, a: string, b: string): string[] {
  if (!COMMIT_RE.test(a) || !COMMIT_RE.test(b)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  const run = runGit(repo, ["merge-base", "--all", "--end-of-options", a, b]);
  // Exit 1 with no output is git's answer for two histories without a
  // common commit.
  if (run.status === 1 && run.stdout.length === 0) return [];
  const ids = run.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
  if (
    run.status !== 0 ||
    ids.length === 0 ||
    ids.some((id) => !COMMIT_RE.test(id))
  ) {
    throw new LintGitError("git-failed", "git could not find the merge bases");
  }
  return ids;
}

/**
 * Whether the repository is shallow: its history ends at a boundary below
 * which git holds no commits. There a commit shows no parents, and a merge
 * base can be an older commit than the one the full history has.
 */
export function isShallow(repo: string): boolean {
  const run = runGit(repo, ["rev-parse", "--is-shallow-repository"]);
  const text = run.stdout.toString("utf8");
  if (run.status !== 0 || (text !== "true\n" && text !== "false\n")) {
    throw new LintGitError(
      "git-failed",
      "git could not say whether the repository is shallow",
    );
  }
  return text === "true\n";
}

/**
 * The paths that differ between the trees of two commits, relative to the
 * repository root. Rename detection is off (a rename is a delete and an add,
 * so both paths show), and no textconv or external diff program runs:
 * `diff-tree` is plumbing and the flags say so. The list is not narrowed by
 * a pathspec: git matches a pathspec byte for byte or with ASCII case
 * folding, and a caller that must match a directory the way a case- and
 * normalisation-insensitive file system does filters the list itself.
 */
export function changedPaths(repo: string, from: string, to: string): string[] {
  requireId(from);
  requireId(to);
  const run = runGit(repo, [
    "diff-tree",
    "-r",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--end-of-options",
    from,
    to,
  ]);
  if (run.status !== 0) {
    throw new LintGitError("git-failed", "git could not compare two trees");
  }
  return run.stdout
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "");
}

/**
 * The text of the regular file `repoPath` in the tree of the commit
 * `commit`, read from the object database; the working tree and the branch
 * heads are never read. The entry is looked up with `ls-tree` first and must
 * be a regular file (mode 100644 or 100755): a link would bind the text of
 * the link, not the file it points at, and a submodule or a directory is not
 * a file at all. A path below a link is not found.
 *
 * `path-missing` when no entry exists, `path-not-regular` for another mode,
 * `path-not-utf8` for bytes that are not UTF-8, `output-too-large` over the
 * output cap, `object-unreadable` when the object database lacks the tree
 * or the blob.
 */
export function readBlobAtCommit(
  repo: string,
  commit: string,
  repoPath: string,
): string {
  requireId(commit);
  requirePath(repoPath);
  const tree = runGit(repo, [
    "ls-tree",
    "-z",
    "--full-tree",
    "--end-of-options",
    commit,
    "--",
    repoPath,
  ]);
  if (tree.status !== 0) {
    throw new LintGitError(
      "object-unreadable",
      "the tree of a commit could not be read",
    );
  }
  const own = tree.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.split("\t")[1] === repoPath);
  if (own.length !== 1) {
    throw new LintGitError("path-missing", "a path does not exist in a commit");
  }
  const m = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t/.exec(own[0]!);
  if (m === null || !COMMIT_RE.test(m[3]!)) {
    throw new LintGitError(
      "object-unreadable",
      "the tree of a commit could not be read",
    );
  }
  // Mode 100644 and 100755 are always blobs; a link, a submodule and a tree
  // have other modes.
  if (!FILE_MODES.has(m[1]!)) {
    throw new LintGitError(
      "path-not-regular",
      "a path is not a regular file in a commit",
    );
  }
  const blob = runGit(repo, ["cat-file", "blob", "--end-of-options", m[3]!]);
  if (blob.status !== 0) {
    throw new LintGitError(
      "object-unreadable",
      "a file of a commit could not be read",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(blob.stdout);
  } catch {
    throw new LintGitError("path-not-utf8", "a file is not valid UTF-8");
  }
}
