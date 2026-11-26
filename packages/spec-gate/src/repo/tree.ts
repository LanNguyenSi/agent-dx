/**
 * The whole tree of a commit as one listing, and blobs read by object id.
 * Both go through the lint's `runGit`, so the same hardening holds: an
 * argument list, a scrubbed environment, configuration overrides, a time
 * limit and an output cap. Nothing is read from the work tree.
 */
import { COMMIT_RE } from "../formats/validate.js";
import { LintGitError, MAX_OUTPUT_BYTES, runGit } from "../lint/git/exec.js";

/** The most entries a tree listing may hold before the check refuses to go on. */
export const MAX_TREE_ENTRIES = 50_000;

/** The cap on the bytes of one tree listing and of one blob: the output cap of every git call. */
export const MAX_LISTING_BYTES = MAX_OUTPUT_BYTES;

/** The modes of a regular file in a git tree. */
const FILE_MODES = new Set(["100644", "100755"]);

/** One entry of a recursive tree listing: a file, a link or a submodule. */
export interface TreeEntry {
  /** The six-digit mode, `100644` for a file, `120000` for a link, `160000` for a submodule. */
  mode: string;
  /** The object id the entry points at. */
  oid: string;
}

export interface TreeListing {
  /**
   * The entries by path. A key is the path's raw bytes as a `latin1` string,
   * so two paths that differ in any byte are two keys, also when they are
   * not valid UTF-8; `displayPath` turns a key into text.
   */
  entries: Map<string, TreeEntry>;
}

/** Thrown when a listing passes a cap; the check reports it as a finding. */
export class TreeTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeTooLargeError";
  }
}

/** A key of `TreeListing.entries` as UTF-8 text for a report. */
export function displayPath(key: string): string {
  return Buffer.from(key, "latin1").toString("utf8");
}

/** Whether the entry is a regular file. */
export function isRegular(entry: TreeEntry | undefined): entry is TreeEntry {
  return entry !== undefined && FILE_MODES.has(entry.mode);
}

function requireCommit(commit: string): void {
  if (!COMMIT_RE.test(commit)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
}

/**
 * Every entry of the tree of `commit`, recursively (`ls-tree -r`): trees
 * themselves are not listed, a link is listed as a link and never followed,
 * and a submodule is one entry whose content is not listed. More than
 * `MAX_TREE_ENTRIES` entries or more than `MAX_LISTING_BYTES` of output is a
 * `TreeTooLargeError`.
 */
export function listTree(repo: string, commit: string): TreeListing {
  requireCommit(commit);
  let out: Buffer;
  try {
    const run = runGit(repo, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      "--end-of-options",
      commit,
    ]);
    if (run.status !== 0) {
      throw new LintGitError(
        "object-unreadable",
        "the tree of a commit could not be read",
      );
    }
    out = run.stdout;
  } catch (err) {
    if (err instanceof LintGitError && err.code === "output-too-large") {
      throw new TreeTooLargeError(
        `the tree listing is larger than ${MAX_LISTING_BYTES} bytes`,
      );
    }
    throw err;
  }
  const entries = new Map<string, TreeEntry>();
  for (const raw of out.toString("latin1").split("\0")) {
    if (raw === "") continue;
    const m = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/s.exec(raw);
    if (m === null || !COMMIT_RE.test(m[3]!)) {
      throw new LintGitError(
        "object-unreadable",
        "the tree of a commit could not be read",
      );
    }
    entries.set(m[4]!, { mode: m[1]!, oid: m[3]! });
    if (entries.size > MAX_TREE_ENTRIES) {
      throw new TreeTooLargeError(
        `the tree holds more than ${MAX_TREE_ENTRIES} entries`,
      );
    }
  }
  return { entries };
}

/**
 * The bytes of the blob `oid`, or `null` when it is larger than the output
 * cap (no spec of that size parses). Any other failure is a `LintGitError`.
 */
export function readBlobById(repo: string, oid: string): Buffer | null {
  if (!COMMIT_RE.test(oid)) {
    throw new LintGitError("object-unreadable", "an object id is not valid");
  }
  try {
    const run = runGit(repo, ["cat-file", "blob", "--end-of-options", oid]);
    if (run.status !== 0) {
      throw new LintGitError(
        "object-unreadable",
        "a file of a commit could not be read",
      );
    }
    return run.stdout;
  } catch (err) {
    if (err instanceof LintGitError && err.code === "output-too-large") {
      return null;
    }
    throw err;
  }
}
