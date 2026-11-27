/**
 * The git reads of the approval check that no other module has: the digest
 * of a spec as a commit holds it, whether the spec directory of the work
 * tree is the one a commit holds, every merge base of two commits, and the
 * parents of a commit.
 *
 * Every git call goes through `runGit` of the lint or through the digest's
 * own readers, so the hardening of `canonical/git-hardening.ts` applies:
 * argument list, scrubbed environment, configuration overrides, time limit,
 * output cap. Nothing here fetches or writes.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DigestError,
  assertCommit as assertCommandsRef,
  compareText,
  computeDigest,
  readCommandSet,
  referencedCommandNames,
  SPEC_FILE,
  TESTPLAN_FILE,
} from "../canonical/index.js";
import {
  parseSpec,
  parseTestPlan,
  type Spec,
  type SpecStatus,
} from "../formats/index.js";
import { COMMIT_RE } from "../formats/validate.js";
import { LintGitError, runGit } from "../lint/git/exec.js";
import {
  decodeUtf8,
  isRepoPath,
  readBlobBytes,
  repoPathOf,
} from "../state/git.js";

/** A git read failed, or a file of the commit is not what the format asks for. */
function isReadError(err: unknown): boolean {
  return err instanceof LintGitError || err instanceof DigestError;
}

function specAt(repo: string, commit: string, specPath: string): Spec | null {
  const bytes = readBlobBytes(repo, commit, repoPathOf(specPath, SPEC_FILE));
  const text = bytes === null ? null : decodeUtf8(bytes);
  const parsed = text === null ? null : parseSpec(text);
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/**
 * The frontmatter `id` and `status` of the spec at `specPath` in `commit`,
 * read from the object database. `null` when `spec.md` is not a regular
 * file there, does not parse or cannot be read.
 */
export function specStateAt(
  repo: string,
  commit: string,
  specPath: string,
): { id: string; status: SpecStatus } | null {
  try {
    const spec = specAt(repo, commit, specPath);
    return spec === null
      ? null
      : { id: spec.frontmatter.id, status: spec.frontmatter.status };
  } catch (err) {
    if (!isReadError(err)) throw err;
    return null;
  }
}

/**
 * The digest of the spec at `specPath` as `commit` holds it: `spec.md` and
 * `testplan.yaml` read from the tree of that commit, the commands from
 * `commands_ref`, the same parts `computeSpecDigest` takes from a spec
 * directory. The work tree is never read. `null` when no digest exists for
 * that commit (a file is missing, does not parse or names a command that is
 * not in the set) or a read failed.
 */
export function specDigestAt(
  repo: string,
  commit: string,
  specPath: string,
): string | null {
  try {
    const spec = specAt(repo, commit, specPath);
    if (spec === null) return null;
    const planBytes = readBlobBytes(
      repo,
      commit,
      repoPathOf(specPath, TESTPLAN_FILE),
    );
    const planText = planBytes === null ? null : decodeUtf8(planBytes);
    const plan = planText === null ? null : parseTestPlan(planText);
    if (plan === null || !plan.ok) return null;
    const ref = spec.frontmatter.commands_ref;
    assertCommandsRef(repo, ref);
    const commands: Record<string, readonly string[]> = {};
    const names = referencedCommandNames(plan.value);
    if (names.length > 0) {
      const set = readCommandSet(repo, ref);
      for (const name of names) {
        // A name the set lacks is left out; `computeDigest` refuses it.
        const entry = set.commands.find((c) => c.name === name);
        if (entry !== undefined) commands[name] = entry.argv;
      }
    }
    return computeDigest({ spec, testPlan: plan.value, commands });
  } catch (err) {
    if (!isReadError(err)) throw err;
    return null;
  }
}

/** The commands of a spec, or the reason they cannot be listed. */
export type SpecCommands =
  | { ok: true; commands: { name: string; argv: string[] }[] }
  /** `problem` is a fixed code: one of this module's own or a code of the digest's readers. */
  | { ok: false; problem: string };

/**
 * The commands a runner may start for the spec at `specPath` as `commit`
 * holds it, sorted by name: every command a test-plan row names
 * (`check_command_ref`), and the command of the set that carries
 * `{selector}` when the set has one. That one is listed whatever the
 * bindings say: it is what a runner starts for every row bound to a
 * selector, and a binding can gain a selector after the approval.
 *
 * `spec.md` and `testplan.yaml` are read from the tree of `commit`, the
 * command set from git at the `commands_ref` of that spec, through the
 * readers of the digest: never at the tip of the default branch, never at
 * `commit` itself and never from the work tree. A set that cannot be read
 * there (no such commit, no regular file, a file that does not parse) and a
 * row that names a command the set lacks are a problem, not an empty list.
 */
export function specCommandsAt(
  repo: string,
  commit: string,
  specPath: string,
): SpecCommands {
  try {
    const spec = specAt(repo, commit, specPath);
    if (spec === null) return { ok: false, problem: "spec-unreadable" };
    const planBytes = readBlobBytes(
      repo,
      commit,
      repoPathOf(specPath, TESTPLAN_FILE),
    );
    const planText = planBytes === null ? null : decodeUtf8(planBytes);
    const plan = planText === null ? null : parseTestPlan(planText);
    if (plan === null || !plan.ok) {
      return { ok: false, problem: "testplan-unreadable" };
    }
    const ref = spec.frontmatter.commands_ref;
    const set = readCommandSet(repo, ref);
    const argvOf = new Map<string, string[]>();
    for (const name of referencedCommandNames(plan.value)) {
      const entry = set.commands.find((c) => c.name === name);
      if (entry === undefined) {
        return { ok: false, problem: "command-ref-unknown" };
      }
      argvOf.set(name, entry.argv);
    }
    for (const entry of set.commands) {
      if (entry.usesSelector) argvOf.set(entry.name, entry.argv);
    }
    return {
      ok: true,
      commands: [...argvOf.keys()]
        .sort(compareText)
        .map((name) => ({ name, argv: [...argvOf.get(name)!] })),
    };
  } catch (err) {
    if (err instanceof DigestError) return { ok: false, problem: err.code };
    if (err instanceof LintGitError)
      return { ok: false, problem: "git-failed" };
    throw err;
  }
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
 * The parents of `commit` as full commit ids, the first parent first; no
 * entry for a commit without one. The first parent of a commit on a branch
 * is what the branch held before that commit.
 *
 * The answer is the one git's history walk gives: in a shallow repository a
 * commit at the boundary has no parent here, whatever its object says.
 */
export function commitParents(repo: string, commit: string): string[] {
  if (!COMMIT_RE.test(commit)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  const run = runGit(repo, [
    "rev-list",
    "--parents",
    "--max-count=1",
    "--end-of-options",
    commit,
  ]);
  // One line: the commit itself, then its parents. An id that is not one
  // (a second line would be part of the last) is no answer.
  const ids = run.stdout.toString("utf8").replace(/\n$/, "").split(" ");
  if (
    run.status !== 0 ||
    ids[0] !== commit ||
    ids.some((id) => !COMMIT_RE.test(id))
  ) {
    throw new LintGitError(
      "git-failed",
      "git could not list the parents of a commit",
    );
  }
  return ids.slice(1);
}

/**
 * `commit` and the commits below it along first parents, `commit` first, at
 * most `count` of them; fewer when the history ends before. The first-parent
 * chain of a commit on a branch is what the branch held, step by step.
 */
export function firstParentChain(
  repo: string,
  commit: string,
  count: number,
): string[] {
  if (!COMMIT_RE.test(commit) || !Number.isSafeInteger(count) || count < 1) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  const run = runGit(repo, [
    "rev-list",
    "--first-parent",
    `--max-count=${count}`,
    "--end-of-options",
    commit,
  ]);
  const ids = run.stdout.toString("utf8").replace(/\n$/, "").split("\n");
  if (
    run.status !== 0 ||
    ids.length > count ||
    ids[0] !== commit ||
    ids.some((id) => !COMMIT_RE.test(id))
  ) {
    throw new LintGitError(
      "git-failed",
      "git could not list the first parents of a commit",
    );
  }
  return ids;
}

/**
 * How many commits are in the history of `to` and not in the history of
 * `from`, counted up to `cap`: the answer `cap` means "that many or more".
 */
export function commitsBetween(
  repo: string,
  from: string,
  to: string,
  cap: number,
): number {
  if (
    !COMMIT_RE.test(from) ||
    !COMMIT_RE.test(to) ||
    !Number.isSafeInteger(cap) ||
    cap < 1
  ) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  const run = runGit(repo, [
    "rev-list",
    "--count",
    `--max-count=${cap}`,
    "--end-of-options",
    `${from}..${to}`,
  ]);
  const text = run.stdout.toString("utf8");
  if (run.status !== 0 || !/^(0|[1-9][0-9]{0,8})\n$/.test(text)) {
    throw new LintGitError("git-failed", "git could not count commits");
  }
  return Number(text);
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

/** The modes of a regular file in a git tree. */
const FILE_MODES = new Set(["100644", "100755"]);

/**
 * The regular files below `specPath` in the tree of `commit`, by path
 * relative to `specPath`, each with the id of its blob. `null` when the tree
 * holds an entry there that is not a regular file (a link, a submodule).
 */
function committedFiles(
  repo: string,
  commit: string,
  specPath: string,
): Map<string, string> | null {
  if (!COMMIT_RE.test(commit)) {
    throw new LintGitError(
      "not-a-commit",
      "a value is not a full commit id (40 or 64 lower-case hex digits)",
    );
  }
  if (!isRepoPath(specPath)) {
    throw new LintGitError("path-invalid", "a repository path is not valid");
  }
  const prefix = `${specPath}/`;
  const run = runGit(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "--end-of-options",
    commit,
    "--",
    prefix,
  ]);
  if (run.status !== 0) {
    throw new LintGitError(
      "object-unreadable",
      "the tree of a commit could not be read",
    );
  }
  const files = new Map<string, string>();
  for (const entry of run.stdout.toString("utf8").split("\0")) {
    if (entry === "") continue;
    const m = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (m === null || !COMMIT_RE.test(m[3]!) || !m[4]!.startsWith(prefix)) {
      throw new LintGitError(
        "object-unreadable",
        "the tree of a commit could not be read",
      );
    }
    if (!FILE_MODES.has(m[1]!)) return null;
    files.set(m[4]!.slice(prefix.length), m[3]!);
  }
  return files;
}

/**
 * The regular files below `dir` in the work tree, by `/` separated relative
 * path. No link is followed. `null` when the directory holds anything that
 * is neither a directory nor a regular file, or cannot be listed.
 */
function workFiles(dir: string): string[] | null {
  const files: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const sub = pending.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, sub));
    } catch {
      return null;
    }
    for (const name of names) {
      const rel = sub === "" ? name : `${sub}/${name}`;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path.join(dir, rel));
      } catch {
        return null;
      }
      if (stat.isDirectory()) pending.push(rel);
      else if (stat.isFile()) files.push(rel);
      else return null;
    }
  }
  return files;
}

/**
 * The id git gives the blob that holds the bytes of `file`, in the object
 * format the id `like` has, or `null` when `file` cannot be read as a
 * regular file. The file is hashed as it is read, so its size does not
 * matter, and no link is followed at the open: a path swapped for a link
 * after it was listed fails here.
 */
function workBlobId(file: string, like: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const hash = createHash(like.length === 64 ? "sha256" : "sha1");
    hash.update(`blob ${stat.size}\0`);
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether the spec directory `dir` of the work tree holds exactly the files
 * the tree of `commit` holds at `specPath`, byte for byte: no file more, no
 * file less, none changed, and nothing but regular files and directories on
 * either side. The lint reads the spec directory from the work tree, so its
 * verdict is about the commit only when the two are the same.
 *
 * The comparison is on bytes: a checkout that rewrites line ends, or a file
 * the repository ignores, makes the two differ. A tree that cannot be read
 * is a `LintGitError`.
 */
export function specDirMatchesCommit(
  repo: string,
  commit: string,
  specPath: string,
  dir: string,
): boolean {
  const committed = committedFiles(repo, commit, specPath);
  const work = workFiles(dir);
  if (committed === null || work === null) return false;
  if (work.length !== committed.size) return false;
  for (const rel of work) {
    const id = committed.get(rel);
    if (id === undefined) return false;
    if (workBlobId(path.join(dir, rel), id) !== id) return false;
  }
  return true;
}
