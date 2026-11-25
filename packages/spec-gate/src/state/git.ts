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

/** Where specs live: `specs/<name>/` (see the layout in docs/formats.md). */
export const SPECS_DIR = "specs";

/**
 * Whether `specPath`, a path as `specPathIn` gives it, is a spec directory of
 * the layout: exactly one level below the top-level `specs/`. The top level,
 * `specs` itself, a directory elsewhere and one deeper inside `specs/` are
 * not.
 */
export function isSpecLayoutPath(specPath: string): boolean {
  const parts = specPath.split("/");
  return parts.length === 2 && parts[0] === SPECS_DIR && parts[1] !== "";
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
 * What the tree of `commit` holds at `repoPath`, read from the object
 * database, never from the working tree: the raw bytes of a regular file
 * (mode 100644 or 100755), `"not-regular"` for a link, a submodule or a
 * directory, `null` when the commit has no entry at that path. The entry is
 * looked up with `ls-tree` before the blob is read, as the lint's own reader
 * does.
 */
function blobAt(
  repo: string,
  commit: string,
  repoPath: string,
): Buffer | "not-regular" | null {
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
  if (!FILE_MODES.has(m[1]!)) return "not-regular";
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
 * The raw bytes of the regular file `repoPath` in the tree of `commit`;
 * `null` when the commit has no entry at that path. An entry that is not a
 * regular file is `path-not-regular`.
 */
export function readBlobBytes(
  repo: string,
  commit: string,
  repoPath: string,
): Buffer | null {
  const found = blobAt(repo, commit, repoPath);
  if (found === "not-regular") {
    throw new LintGitError(
      "path-not-regular",
      "a path is not a regular file in a commit",
    );
  }
  return found;
}

/**
 * As `readBlobBytes`, for a path nobody vouches for: an entry that is not a
 * regular file reads as absent, `null`, instead of failing the run.
 */
export function regularBlobBytes(
  repo: string,
  commit: string,
  repoPath: string,
): Buffer | null {
  const found = blobAt(repo, commit, repoPath);
  return found === "not-regular" ? null : found;
}

/**
 * The directories directly inside the top-level `specs/` in the tree of
 * `commit`, as repository paths, read from the object database. One level is
 * listed and nothing below it, so the output grows with the number of spec
 * directories, never with what they hold (evidence files, for one). An entry
 * that is not a directory, or whose path the git reads would not accept, is
 * left out; a commit without `specs/` gives none.
 */
export function specDirsAt(repo: string, commit: string): string[] {
  if (!COMMIT_RE.test(commit)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  const run = runGit(repo, [
    "ls-tree",
    "-z",
    "--full-tree",
    "--end-of-options",
    commit,
    "--",
    `${SPECS_DIR}/`,
  ]);
  if (run.status !== 0) {
    throw new LintGitError(
      "object-unreadable",
      "the tree of a commit could not be read",
    );
  }
  const dirs: string[] = [];
  for (const entry of run.stdout.toString("utf8").split("\0")) {
    const m = /^040000 tree [0-9a-f]+\t(.+)$/s.exec(entry);
    if (m !== null && isRepoPath(m[1]!)) dirs.push(m[1]!);
  }
  return dirs.sort();
}

/** Decodes bytes as UTF-8, fatally; `null` for bytes that are not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
