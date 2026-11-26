/**
 * `spec-gate repo-check`: the repository-wide check that no protected spec
 * at the diff base disappears, changes its id or falls back to `draft`.
 *
 * The lint looks at one spec directory, the one it is run on, so it cannot
 * see a spec that has no directory at HEAD any more: a deleted directory, a
 * rename together with a new id, or a spec moved from anywhere into
 * `specs/` with a fresh log. This check starts at the diff base instead and
 * walks its whole tree, not only `specs/`:
 *
 * - Protected is every regular file named `spec.md` (ASCII case ignored)
 *   at the diff base that parses as a spec and either has a status other
 *   than `draft` or a regular sibling `bindings.log` (ASCII case ignored).
 * - For each, the tree of HEAD (read from git, never from the work tree)
 *   must hold a regular `spec.md` at the same path that parses
 *   (`spec-removed`), with the same id (`spec-id-changed`) and, when its
 *   status at the diff base was not `draft`, a status other than `draft`
 *   (`spec-status-reverted`), and a regular file at the
 *   path of every sibling log (`log-removed`). A protected spec that turns
 *   up at HEAD under another path is still `spec-removed` for its old one:
 *   a proposed spec keeps its directory.
 *
 * Caps: a tree of more than `MAX_TREE_ENTRIES` entries or more than
 * `MAX_LISTING_BYTES` of listing, or more than `MAX_SPEC_FILES` files named
 * `spec.md`, is the finding `tree-too-large` and the check stops there; it
 * never passes a tree it did not read in full.
 */
import { parseSpec } from "../formats/index.js";
import { decodeUtf8 } from "../state/git.js";
import { LintGitError } from "../lint/git/exec.js";
import {
  hasGitInputs,
  resolveGitInputs,
  type GitRequest,
} from "../lint/git/resolve.js";
import type { GitInputs } from "../lint/types.js";
import {
  MAX_LISTING_BYTES,
  MAX_TREE_ENTRIES,
  TreeTooLargeError,
  displayPath,
  isRegular,
  listTree,
  readBlobById,
  type TreeEntry,
  type TreeListing,
} from "./tree.js";

export { MAX_LISTING_BYTES, MAX_TREE_ENTRIES };

export const REPO_CHECK_FORMAT = "spec-gate-repo-check/1";

/** The most files named `spec.md` the diff base may hold. */
export const MAX_SPEC_FILES = 1_000;

const SPEC_NAME = "spec.md";
const LOG_NAME = "bindings.log";

export const REPO_CHECK_CODES = [
  "spec-removed",
  "spec-id-changed",
  "spec-status-reverted",
  "log-removed",
  "tree-too-large",
] as const;
export type RepoCheckCode = (typeof REPO_CHECK_CODES)[number];

export interface RepoCheckFinding {
  /** The repository path of the `spec.md` or `bindings.log` at the diff base; `.` for the tree. */
  path: string;
  code: RepoCheckCode;
  message: string;
}

export interface RepoCheckReport {
  format: typeof REPO_CHECK_FORMAT;
  ok: boolean;
  reference: string;
  diff_base: string;
  head: string;
  /** How many regular files named `spec.md` the diff base holds (0 after `tree-too-large`). */
  spec_files: number;
  findings: RepoCheckFinding[];
}

export type RepoCheckResult =
  { ok: true; report: RepoCheckReport } | { ok: false; message: string };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindings(a: RepoCheckFinding, b: RepoCheckFinding): number {
  return (
    compareText(a.path, b.path) ||
    compareText(a.code, b.code) ||
    compareText(a.message, b.message)
  );
}

/** `name` with ASCII upper case letters folded to lower case, nothing else changed. */
function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function splitKey(key: string): { dir: string; name: string } {
  const slash = key.lastIndexOf("/");
  return slash < 0
    ? { dir: "", name: key }
    : { dir: key.slice(0, slash + 1), name: key.slice(slash + 1) };
}

function sameEntry(
  a: TreeEntry | undefined,
  b: TreeEntry | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mode === b.mode && a.oid === b.oid;
}

/** The id and status of a spec given as bytes; `null` when it does not parse. */
function specOf(bytes: Buffer | null): { id: string; status: string } | null {
  const text = bytes === null ? null : decodeUtf8(bytes);
  const parsed = text === null ? null : parseSpec(text);
  if (parsed === null || !parsed.ok) return null;
  return {
    id: parsed.value.frontmatter.id,
    status: parsed.value.frontmatter.status,
  };
}

/** A regular `spec.md` at the diff base and the regular logs beside it. */
interface Candidate {
  key: string;
  entry: TreeEntry;
  logs: string[];
}

/**
 * Every regular file named `spec.md` (ASCII case ignored) in the listing,
 * with the regular `bindings.log` files (ASCII case ignored) in its
 * directory. A link, a submodule or a directory named `spec.md` is not one:
 * neither is a spec the lint would read.
 */
function candidatesOf(base: TreeListing): Candidate[] {
  const logsByDir = new Map<string, string[]>();
  const specs: Array<{ key: string; entry: TreeEntry; dir: string }> = [];
  for (const [key, entry] of base.entries) {
    if (!isRegular(entry)) continue;
    const { dir, name } = splitKey(key);
    const lower = asciiLower(name);
    if (lower === SPEC_NAME) specs.push({ key, entry, dir });
    else if (lower === LOG_NAME) {
      const list = logsByDir.get(dir) ?? [];
      list.push(key);
      logsByDir.set(dir, list);
    }
  }
  if (specs.length > MAX_SPEC_FILES) {
    throw new TreeTooLargeError(
      `the diff base holds more than ${MAX_SPEC_FILES} files named ${SPEC_NAME}`,
    );
  }
  return specs.map(({ key, entry, dir }) => ({
    key,
    entry,
    logs: (logsByDir.get(dir) ?? []).sort(),
  }));
}

/**
 * The findings for one candidate. Only a candidate whose `spec.md` or a
 * sibling log differs between the diff base and HEAD is read: with every
 * entry the same object, nothing can be reported for it.
 */
function checkCandidate(
  repo: string,
  candidate: Candidate,
  base: TreeListing,
  head: TreeListing,
): RepoCheckFinding[] {
  const headSpec = head.entries.get(candidate.key);
  if (
    sameEntry(candidate.entry, headSpec) &&
    candidate.logs.every((log) =>
      sameEntry(base.entries.get(log), head.entries.get(log)),
    )
  ) {
    return [];
  }
  const at = specOf(readBlobById(repo, candidate.entry.oid));
  if (at === null || (at.status === "draft" && candidate.logs.length === 0)) {
    return [];
  }
  const path = displayPath(candidate.key);
  const why = at.status !== "draft" ? `status ${at.status}` : `a ${LOG_NAME}`;
  const findings: RepoCheckFinding[] = [];
  const add = (code: RepoCheckCode, message: string, where = path): void => {
    findings.push({ path: where, code, message });
  };
  if (!isRegular(headSpec)) {
    add(
      "spec-removed",
      `the spec ${at.id} (${why} at the diff base) has no regular ${SPEC_NAME} at this path at HEAD; a spec that is protected keeps its directory`,
    );
  } else {
    const now = specOf(readBlobById(repo, headSpec.oid));
    if (now === null) {
      add(
        "spec-removed",
        `the spec ${at.id} (${why} at the diff base) no longer parses at HEAD; a spec that is protected keeps a valid ${SPEC_NAME}`,
      );
    } else {
      if (now.id !== at.id) {
        add(
          "spec-id-changed",
          `the spec at this path had the id ${at.id} at the diff base and has ${now.id} at HEAD; a spec that is protected keeps its id`,
        );
      }
      if (now.status === "draft" && at.status !== "draft") {
        add(
          "spec-status-reverted",
          `the spec ${at.id} (${why} at the diff base) is draft at HEAD; a spec that is protected never goes back to draft`,
        );
      }
    }
  }
  for (const log of candidate.logs) {
    if (!isRegular(head.entries.get(log))) {
      add(
        "log-removed",
        `the ${LOG_NAME} of the spec ${at.id} exists at the diff base and is not a regular file at this path at HEAD; a merged log is never removed`,
        displayPath(log),
      );
    }
  }
  return findings;
}

/** Runs the check over resolved git inputs. */
export function checkRepository(git: GitInputs): RepoCheckReport {
  const findings: RepoCheckFinding[] = [];
  let specFiles = 0;
  try {
    const base = listTree(git.repo, git.diffBase);
    const head = listTree(git.repo, git.head);
    const candidates = candidatesOf(base);
    specFiles = candidates.length;
    for (const candidate of candidates) {
      findings.push(...checkCandidate(git.repo, candidate, base, head));
    }
  } catch (err) {
    if (!(err instanceof TreeTooLargeError)) throw err;
    // Only listing and collecting throw this, before a spec is counted or
    // checked; nothing is reported for a tree that was not read in full.
    findings.length = 0;
    findings.push({ path: ".", code: "tree-too-large", message: err.message });
  }
  findings.sort(compareFindings);
  return {
    format: REPO_CHECK_FORMAT,
    ok: findings.length === 0,
    reference: git.reference,
    diff_base: git.diffBase,
    head: git.head,
    spec_files: specFiles,
    findings,
  };
}

/**
 * Resolves the git flags as the lint does (`--repo` is the trusted checkout
 * root, never discovered; `--default-ref` or `--base` names the reference;
 * the diff base is the merge base of HEAD and the reference) and runs the
 * check. A usage error or a git failure is `ok: false` with a message that
 * names no path and holds none of git's output.
 */
export function repoCheck(request: GitRequest): RepoCheckResult {
  if (request.repo === undefined) {
    return { ok: false, message: "repo-check needs --repo <dir>" };
  }
  if (!hasGitInputs(request)) {
    return {
      ok: false,
      message: "repo-check needs --default-ref <ref> or --base <commit>",
    };
  }
  const resolved = resolveGitInputs(request.repo, request);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  if (resolved.git === undefined) {
    return {
      ok: false,
      message: "repo-check needs --default-ref <ref> or --base <commit>",
    };
  }
  try {
    return { ok: true, report: checkRepository(resolved.git) };
  } catch (err) {
    if (err instanceof LintGitError) {
      return { ok: false, message: "git could not be read" };
    }
    throw err;
  }
}
