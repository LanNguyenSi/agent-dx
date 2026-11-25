/**
 * The git reads of the spec state verbs and of the bindings-log rule that
 * the lint's git module has no primitive for: the raw bytes of a file at a
 * commit (the lint's `readBlobAtCommit` decodes UTF-8 and drops a byte order
 * mark, and a hash binds bytes) and the path of a spec directory in its
 * repository. Every call goes through the lint's `runGit`, so the same
 * hardening holds: argument list, scrubbed environment, configuration
 * overrides, time limit and output cap.
 */
import fs from "node:fs";
import path from "node:path";
import { COMMIT_RE } from "../formats/validate.js";
import { LintGitError, runGit } from "../lint/git/exec.js";

/** A repository path: `/` separated names, no `.` or `..`, no glob or option characters. */
const REPO_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const FILE_MODES = new Set(["100644", "100755"]);

/** Whether `p` is a repository path the git reads accept. */
export function isRepoPath(p: string): boolean {
  return (
    REPO_PATH_RE.test(p) &&
    !p.startsWith("-") &&
    !p.split("/").some((part) => part === "." || part === "..")
  );
}

/**
 * The path of `specDir` relative to the repository top level, `/`
 * separated, or `""` when the spec directory is the top level. Both are
 * compared as real paths. `null` when the directory is not inside the
 * repository or cannot be resolved.
 */
export function specPathIn(toplevel: string, specDir: string): string | null {
  let root: string;
  let spec: string;
  try {
    root = fs.realpathSync(toplevel);
    spec = fs.realpathSync(specDir);
  } catch {
    return null;
  }
  const rel = path.relative(root, spec);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/** `name` inside the spec directory at `specPath`, as a repository path. */
export function repoPathOf(specPath: string, name: string): string {
  return specPath === "" ? name : `${specPath}/${name}`;
}

/**
 * The raw bytes of the regular file `repoPath` in the tree of `commit`,
 * read from the object database, never from the working tree; `null` when
 * the commit has no entry at that path. The entry must be a regular file
 * (mode 100644 or 100755), looked up with `ls-tree` before the blob is read,
 * as the lint's own reader does: a link, a submodule or a directory is
 * `path-not-regular`.
 */
export function readBlobBytes(
  repo: string,
  commit: string,
  repoPath: string,
): Buffer | null {
  if (!COMMIT_RE.test(commit)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  if (!isRepoPath(repoPath)) {
    throw new LintGitError("path-invalid", "a repository path is not valid");
  }
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
  if (own.length === 0) return null;
  const m = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t/.exec(own[0]!);
  if (own.length !== 1 || m === null || !COMMIT_RE.test(m[3]!)) {
    throw new LintGitError(
      "object-unreadable",
      "the tree of a commit could not be read",
    );
  }
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
  return blob.stdout;
}

/**
 * The directories below `scopes` (repository paths, `""` for the top level
 * alone) that hold a regular file named `name` in the tree of `commit`, read
 * from the object database. `ls-tree` is narrowed to the scopes, so the
 * listing stays small whatever else the repository holds; an entry that is a
 * link, a submodule or a directory, or whose path the git reads would not
 * accept, is left out.
 */
export function dirsHolding(
  repo: string,
  commit: string,
  scopes: readonly string[],
  name: string,
): string[] {
  if (!COMMIT_RE.test(commit)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  const specs = [...new Set(scopes)]
    .filter((scope) => scope === "" || isRepoPath(scope))
    .map((scope) => (scope === "" ? name : `${scope}/`));
  if (specs.length === 0) return [];
  const run = runGit(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "--end-of-options",
    commit,
    "--",
    ...specs,
  ]);
  if (run.status !== 0) {
    throw new LintGitError(
      "object-unreadable",
      "the tree of a commit could not be read",
    );
  }
  const dirs = new Set<string>();
  for (const entry of run.stdout.toString("utf8").split("\0")) {
    const m = /^([0-7]{6}) [a-z]+ [0-9a-f]+\t(.+)$/s.exec(entry);
    if (m === null || !FILE_MODES.has(m[1]!) || !isRepoPath(m[2]!)) continue;
    const p = m[2]!;
    if (p === name) dirs.add("");
    else if (p.endsWith(`/${name}`)) dirs.add(p.slice(0, -name.length - 1));
  }
  return [...dirs].sort();
}

/** Decodes bytes as UTF-8, fatally; `null` for bytes that are not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
