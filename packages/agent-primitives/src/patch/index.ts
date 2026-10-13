import fs from "node:fs";
import path from "node:path";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { UsageError } from "../envelope.js";
import { findGitRoot, isPathContained } from "../probe/containment.js";
import {
  applyRegionsToRaw,
  crlfToLf,
  detectLineEnding,
  rawMappingAgrees,
  resolveFileEdits,
  type EditResolution,
  type LineRange,
  type MatchTier,
  type Region,
} from "./engine.js";
import {
  fuzzySideEffectHint,
  notFoundHint,
  type FuzzySideEffectHint,
  type NotFoundHint,
} from "./hint.js";
import { unifiedDiff } from "./diff.js";

export { MATCH_TIERS, type MatchTier } from "./engine.js";
export { visualizeWhitespace } from "./hint.js";

/** One edit of a plan, as given. */
export interface PatchEditSpec {
  file: string;
  old: string;
  new: string;
  replaceAll?: boolean;
}

/** A usage error with a machine-readable reason (`plan_invalid`,
 * `empty_old`, ...), reported by the CLI as `status: "usage_error"`. */
export class PatchUsageError extends UsageError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}

const EDIT_KEYS = new Set(["file", "old", "new", "replaceAll"]);

/**
 * Parses and validates a plan: `{"edits":[{"file","old","new","replaceAll"?}]}`.
 * Unknown keys, a non-string field, an empty `edits` list or an empty
 * `old` are refused, so a misspelled key never silently does nothing.
 */
export function parsePatchPlan(text: string, source = "plan"): PatchEditSpec[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new PatchUsageError(
      `patch: ${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "plan_invalid",
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PatchUsageError(
      `patch: ${source} must be a JSON object with an "edits" array`,
      "plan_invalid",
    );
  }
  const extra = Object.keys(data).filter((k) => k !== "edits");
  if (extra.length > 0) {
    throw new PatchUsageError(
      `patch: ${source} has unknown key(s): ${extra.join(", ")} (only "edits" is allowed)`,
      "plan_invalid",
    );
  }
  const edits = (data as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new PatchUsageError(
      `patch: ${source} needs a non-empty "edits" array`,
      "plan_invalid",
    );
  }
  return edits.map((raw, i): PatchEditSpec => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}] must be an object`,
        "plan_invalid",
      );
    }
    const unknown = Object.keys(raw).filter((k) => !EDIT_KEYS.has(k));
    if (unknown.length > 0) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}] has unknown key(s): ${unknown.join(", ")} (allowed: file, old, new, replaceAll)`,
        "plan_invalid",
      );
    }
    const e = raw as Record<string, unknown>;
    for (const key of ["file", "old", "new"] as const) {
      if (typeof e[key] !== "string") {
        throw new PatchUsageError(
          `patch: edits[${String(i)}].${key} must be a string`,
          "plan_invalid",
        );
      }
    }
    if (e.replaceAll !== undefined && typeof e.replaceAll !== "boolean") {
      throw new PatchUsageError(
        `patch: edits[${String(i)}].replaceAll must be a boolean`,
        "plan_invalid",
      );
    }
    if ((e.file as string).length === 0) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}].file must not be empty`,
        "plan_invalid",
      );
    }
    const spec: PatchEditSpec = {
      file: e.file as string,
      old: e.old as string,
      new: e.new as string,
    };
    if (e.replaceAll === true) spec.replaceAll = true;
    return spec;
  });
}

/**
 * Per-edit status. `written`, `would_write` (dry run) and `unchanged` are
 * ok; `missing`, `ambiguous`, `overlap`, `fuzzy_side_effect` (a fuzzy
 * match whose lines would change outside the matched text) and
 * `not_editable` (a hard-linked or read-only file) are findings; `refused`
 * (a path outside the root or inside a git directory) is a usage error;
 * `error` is a file that could not be read, decoded or written;
 * `not_written` is an edit that resolved but was not written because the
 * plan was refused or a write failed.
 */
export type PatchEditStatus =
  | "written"
  | "would_write"
  | "unchanged"
  | "missing"
  | "ambiguous"
  | "overlap"
  | "fuzzy_side_effect"
  | "not_editable"
  | "refused"
  | "error"
  | "not_written";

export interface PatchEditResult {
  index: number;
  /** The path as given in the plan. */
  file: string;
  /** Root-relative path of the resolved target (absolute when outside). */
  path: string;
  status: PatchEditStatus;
  tier?: MatchTier;
  occurrences?: number;
  line_ranges?: LineRange[];
  match_lines?: number[];
  overlaps_with?: number[];
  reason?: string;
  detail?: string;
  hint?: NotFoundHint;
  side_effect?: FuzzySideEffectHint;
}

export type PatchFileStatus =
  | "written"
  | "would_write"
  | "unchanged"
  | "not_written"
  | "not_editable"
  | "refused"
  | "error";

export interface PatchFileResult {
  path: string;
  status: PatchFileStatus;
  edits: number[];
  line_ending?: "lf" | "crlf";
  bom?: boolean;
  diff?: string;
  reason?: string;
  detail?: string;
}

export type PatchStatus =
  | "written"
  | "would_write"
  | "unchanged"
  | "missing"
  | "ambiguous"
  | "overlap"
  | "fuzzy_side_effect"
  | "not_editable"
  | "usage_error"
  | "error";

export interface PatchResult {
  status: PatchStatus;
  reason?: string;
  message?: string;
  dryRun: boolean;
  root: string;
  edits: PatchEditResult[];
  files: PatchFileResult[];
  /** Files actually written, in write order (also after a write error). */
  writtenFiles: string[];
  /** Edit counts by status, plus the number of distinct files and of
   * files written. */
  counts: {
    edits: number;
    files: number;
    files_written: number;
    written: number;
    would_write: number;
    unchanged: number;
    missing: number;
    ambiguous: number;
    overlap: number;
    fuzzy_side_effect: number;
    not_editable: number;
    refused: number;
    errors: number;
  };
  warnings: string[];
}

export interface PatchOptions {
  cwd: string;
  edits: readonly PatchEditSpec[];
  dryRun?: boolean;
  allowOutside?: boolean;
  /** Edit a file with more than one hard link anyway: the rename that
   * writes it gives the edited name a new inode, so the other names keep
   * the old content. Refused (`not_editable`, `hard_link`) otherwise. */
  breakHardLinks?: boolean;
  /** Test seam: replaces the rename that commits a written file. */
  renameFile?: (from: string, to: string) => void;
  /** Test seam: how long git's identity lookup may run before it is
   * stopped (default `GIT_LOOKUP_TIMEOUT_MS`). */
  gitTimeoutMs?: number;
}

interface FileState {
  key: string;
  display: string;
  real: string;
  /** Every absolute spelling of the file the plan used. */
  lexicals: string[];
  edits: number[];
  status?: PatchFileStatus;
  reason?: string;
  detail?: string;
  buffer?: Buffer;
  raw?: string;
  bom?: boolean;
  lf?: string;
  ending?: "\r\n" | "\n";
  mode?: number;
  regions?: Region[];
  newRaw?: string;
  diff?: string;
}

/** A `.git` path component by its name, lower-cased (`.GIT`, `.Git`).
 * `hasGitEntry` asks the filesystem instead, for every other spelling it
 * folds or normalises to `.git`. */
function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]+/).some((seg) => seg.toLowerCase() === ".git");
}

/** `dev:ino` of a path (following symlinks); undefined when it cannot be
 * stated. Names one file whatever its spelling: letter case, Unicode
 * normalisation, a symlink or another hard link. */
function identityOf(p: string): string | undefined {
  try {
    const st = fs.statSync(p, { bigint: true });
    return `${String(st.dev)}:${String(st.ino)}`;
  } catch {
    return undefined;
  }
}

/** `dev:ino` of a directory entry itself: a symlink is not followed. */
function entryIdentityOf(p: string): string | undefined {
  try {
    const st = fs.lstatSync(p, { bigint: true });
    return `${String(st.dev)}:${String(st.ino)}`;
  } catch {
    return undefined;
  }
}

/** True when a component of `full` below `from` (an ancestor of `full`,
 * or the filesystem root for the whole path) is the entry the filesystem
 * finds as `.git` in that component's parent directory. That is decided
 * by the filesystem, not by a case map: whatever spelling the volume
 * folds or normalises to `.git` (and a hard link of a `.git` file in the
 * same directory) counts. */
function hasGitEntry(from: string, full: string): boolean {
  const rel = path.relative(from, full);
  if (rel === "") return false;
  let parent = from;
  for (const seg of rel.split(path.sep)) {
    const entry = path.join(parent, seg);
    const id = entryIdentityOf(entry);
    if (id !== undefined && id === entryIdentityOf(path.join(parent, ".git"))) {
      return true;
    }
    parent = entry;
  }
  return false;
}

/** Environment variables that steer git's repository discovery. They are
 * removed from git's environment for the identity lookup, so that it
 * answers for the root itself, not for a repository the caller named or
 * a ceiling the caller set, and so that git's discovery runs over the
 * layout the pre-check (`gitDiscoveryHazard`, which reads no
 * environment) modelled: `GIT_OBJECT_DIRECTORY` stands in for
 * `objects` in git's test of a git directory, so a value that does not
 * exist fails every directory and sends discovery past the root's
 * repository. */
const GIT_DISCOVERY_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

/** How long git's identity lookup may run. It answers in milliseconds;
 * a layout that makes it wait (a FIFO it opens) ends here, and so does
 * one that makes it grow (a configuration value of gigabytes, taken in
 * at its parser's pace), so this time, times that pace, bounds git's
 * memory. */
const GIT_LOOKUP_TIMEOUT_MS = 3_000;

/** The most output taken from git's identity lookup (two paths). */
const GIT_LOOKUP_MAX_OUTPUT = 64 * 1024;

/** The largest `commondir` file git may meet during its repository
 * discovery for patch to run it: git reads the whole file
 * (`get_common_dir_noenv` in git's `setup.c`), so a device, a FIFO or a
 * large (also sparse) file there makes git wait or grow without bound,
 * faster than a timeout can stop it. */
const COMMONDIR_MAX = 64 * 1024;

/** git's own limit on the size of a `.git` file (`read_gitfile_raw`). */
const GITFILE_MAX = 1024 * 1024;

/** Why git would read `<dir>/commondir` without bound, or undefined.
 * git reads the file when an `lstat` finds it (`file_exists`), through
 * a symlink; one that then cannot be opened stops git with an error.
 * `dir` is a real path (the root, a directory above it, or one from
 * `physicalPath`), so joining the name to it folds nothing. */
function commondirHazard(dir: string): string | undefined {
  const file = path.join(dir, "commondir");
  let st: fs.Stats;
  try {
    fs.lstatSync(file);
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!st.isFile()) {
    return `git would read ${file} whole, and it is not a regular file`;
  }
  if (st.size > COMMONDIR_MAX) {
    return `git would read ${file} whole, and it holds ${String(st.size)} bytes`;
  }
  return undefined;
}

/** The path a `.git` file names, read as git reads it
 * (`read_gitfile_raw`): after `gitdir: `, without trailing CR and LF,
 * up to a NUL (git reads it as a C string; an empty result names the
 * file's own directory). Undefined when git finds no path there; null
 * when the bytes are not UTF-8, which this check cannot follow. */
function gitfilePath(content: Buffer | undefined): string | null | undefined {
  if (content === undefined) return undefined;
  if (!content.subarray(0, 8).equals(Buffer.from("gitdir: "))) {
    return undefined;
  }
  let end = content.length;
  while (end > 0 && (content[end - 1] === 0x0a || content[end - 1] === 0x0d)) {
    end--;
  }
  if (end < 9) return undefined;
  let named = content.subarray(8, end);
  const nul = named.indexOf(0);
  if (nul >= 0) named = named.subarray(0, nul);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      named,
    );
  } catch {
    return null;
  }
}

/** The real path of the directory git reaches by `named`, a path read
 * from a file in `dir` (a `.git` file's `gitdir:` line, a `commondir`
 * line) or from git's output. git keeps such bytes as they are, prefixed
 * with `<dir>/` when relative (`read_gitfile_gently` and
 * `get_common_dir_noenv` in git's `setup.c`), and lets the filesystem
 * resolve them, so a `..` after a symlink applies to the symlink's
 * target; `path.resolve` or `path.join` would fold it lexically and name
 * another directory. Every path taken from on-disk content passes
 * through here before a name is appended to it. Undefined when the
 * filesystem cannot resolve it (a missing directory, a dangling symlink,
 * a loop): git's own `lstat` of `<named>/HEAD` fails there the same
 * way, so git reads nothing behind such a path. */
function physicalPath(dir: string, named: string): string | undefined {
  const joined = path.isAbsolute(named) ? named : `${dir}/${named}`;
  try {
    return fs.realpathSync.native(joined);
  } catch {
    return undefined;
  }
}

/**
 * Follows git's repository discovery from `root` (`setup.c`,
 * `repo_discovery_find_dir`) to the `commondir` files git would read
 * on the way and names the first one that is not a regular file of at
 * most `COMMONDIR_MAX` bytes. In each directory from `root` up: a `.git`
 * directory (its `commondir`, and the walk ends when it passes git's
 * test), a `.git` file (the `commondir` of the directory it names, that
 * path resolved by the filesystem as git resolves it, `physicalPath`;
 * git ends there either way, and a path the filesystem cannot resolve
 * is named as a hazard, since this check cannot follow it), then the
 * directory itself as a bare
 * repository. It ends no earlier than git 2.39 or newer does: past a
 * `.git` entry that is neither a file nor a directory, or one that
 * cannot be stated, it goes on (git 2.39 does, newer git stops there
 * with an error), and it does not stop at a filesystem boundary.
 */
function gitDiscoveryHazard(root: string): string | undefined {
  let dir = root;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotGit);
    } catch {
      // No .git here, or one that cannot be stated: look further up.
    }
    if (st?.isDirectory() === true) {
      const hazard = commondirHazard(dotGit);
      if (hazard !== undefined) return hazard;
      if (isGitDirectory(dotGit, true)) return undefined;
    } else if (st?.isFile() === true) {
      // git refuses a larger .git file.
      if (st.size > GITFILE_MAX) return undefined;
      const named = gitfilePath(readRegular(dotGit, GITFILE_MAX));
      if (named === undefined) return undefined;
      if (named === null) {
        return `${dotGit} names its git directory by a path that is not UTF-8, which this check cannot follow`;
      }
      const target = physicalPath(dir, named);
      if (target === undefined) {
        return `${dotGit} names its git directory by a path that does not resolve, which this check cannot follow`;
      }
      return commondirHazard(target);
    }
    const hazard = commondirHazard(dir);
    if (hazard !== undefined) return hazard;
    if (isGitDirectory(dir, true)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Identities of the git directory and common directory (they differ in a
 * linked worktree) git finds from `root`, whatever they are named. Asked
 * also when `root` has no work tree: inside a bare repository or a git
 * directory, git answers with that directory. The set is empty when git
 * finds no repository there, and then also carries a warning when the
 * check could not be made: git is not run because its discovery would
 * read a `commondir` without bound (`gitDiscoveryHazard`), git cannot be
 * run, does not finish within `timeoutMs`, writes more than
 * `GIT_LOOKUP_MAX_OUTPUT` bytes or is ended by a signal, or `root` is a
 * git work tree (`inWorkTree`) and git fails there. A directory git names
 * is left out, with a warning, when it cannot be stated or is laid out
 * neither like a git directory nor like a common directory; and an
 * answer with a line break inside a name always warns.
 *
 * git runs in a process group of its own; when it does not end by
 * itself, that whole group is sent SIGKILL, so no process of it outlives
 * this call.
 */
function gitDirIdentities(
  root: string,
  inWorkTree: boolean,
  timeoutMs: number,
): { ids: Set<string>; warning?: string } {
  const ids = new Set<string>();
  const env = { ...process.env };
  for (const key of GIT_DISCOVERY_ENV) delete env[key];
  const skipped = (why: string): { ids: Set<string>; warning: string } => ({
    ids,
    warning: `the git directory check by identity was skipped (${why}); a .git path component and a directory laid out like a git directory are still refused`,
  });
  const hazard = gitDiscoveryHazard(root);
  if (hazard !== undefined) return skipped(`git was not run: ${hazard}`);
  // `detached` gives git a process group of its own. spawnSync honours it
  // (Node's normalizeSpawnArguments passes it on to libuv), though the
  // typings list it for spawn only; the process-group test pins it.
  const spawnOptions: SpawnSyncOptionsWithStringEncoding & {
    detached: boolean;
  } = {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: GIT_LOOKUP_MAX_OUTPUT,
    detached: process.platform !== "win32",
  };
  const res = spawnSync(
    "git",
    ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
    spawnOptions,
  );
  if (res.error !== undefined || res.signal !== null) {
    // spawnSync has killed git itself; end the rest of its group. A pid
    // of 0 (git never started) must not reach kill: -0 is this process's
    // own group.
    if (process.platform !== "win32" && res.pid > 0) {
      try {
        process.kill(-res.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    }
    const e = res.error as NodeJS.ErrnoException | undefined;
    if (e?.code === "ETIMEDOUT") {
      return skipped(
        `git rev-parse did not finish within ${String(timeoutMs)} ms and was stopped`,
      );
    }
    if (e?.code === "ENOBUFS") {
      return skipped(
        `git rev-parse wrote more than ${String(GIT_LOOKUP_MAX_OUTPUT)} bytes and was stopped`,
      );
    }
    if (res.error !== undefined) {
      return skipped(`git could not be run: ${errnoDetail(res.error)}`);
    }
    return skipped(`git rev-parse was ended by ${String(res.signal)}`);
  }
  if (res.status !== 0) {
    // Outside any repository git exits non-zero: nothing to refuse.
    if (!inWorkTree) return { ids };
    return skipped(
      `git rev-parse failed with exit code ${String(res.status)} in the work tree ${root}`,
    );
  }
  const out = res.stdout;
  // One path per line, each as git spells it (a name may end in
  // whitespace); only the final line break is dropped. Git answers with
  // exactly two lines, so any other count means a line break inside a
  // name: then each piece is only a guess at a directory.
  const lines = out.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const problems: string[] = [];
  if (lines.length !== 2) {
    problems.push(
      "git named a directory with a line break in its name, which cannot be read line by line",
    );
  }
  for (const line of lines) {
    if (line.length === 0) continue;
    const named = physicalPath(root, line);
    const id = named === undefined ? undefined : identityOf(named);
    if (named === undefined || id === undefined) {
      problems.push(`git named ${line}, which cannot be stated`);
      continue;
    }
    // A piece of a name split at a line break can name an unrelated
    // directory; only one laid out like what git names is taken.
    if (
      !isGitDirectory(named, false) &&
      !isWorktreeAdminDir(named) &&
      !holdsObjectsAndRefs(named)
    ) {
      problems.push(
        `git named ${line}, which is not laid out like a git directory or a common directory`,
      );
      continue;
    }
    ids.add(id);
  }
  if (problems.length > 0) {
    return {
      ids,
      warning: `the git directory check by identity was skipped for part of git's answer (${problems.join("; ")}); a .git path component and a directory laid out like a git directory are still refused`,
    };
  }
  return { ids };
}

/** The bytes of a file, up to `max` (default: the whole file, if it is
 * at most 64 KiB); undefined when it cannot be read or is larger. It is
 * opened non-blocking, so a FIFO in a place the checks look at (any
 * directory above a target) reads as empty instead of stalling the
 * command. */
function readRegular(p: string, max?: number): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = fs.fstatSync(fd);
    if (max === undefined && st.size > 65536) return undefined;
    const buf = Buffer.alloc(max ?? st.size);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** git's test of a `HEAD` entry (setup.c, `validate_headref`): a symlink
 * into `refs/`, or a file whose first 255 bytes hold `ref:`, optional
 * whitespace and a name under `refs/`, or start with a hexadecimal object
 * id. `strict` takes whitespace as git's `isspace` does (space, tab, LF,
 * CR); otherwise form feed and vertical tab count too. */
function validHeadRef(p: string, strict: boolean): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    try {
      return fs.readlinkSync(p).startsWith("refs/");
    } catch {
      return false;
    }
  }
  const head = readRegular(p, 255)?.toString("latin1");
  if (head === undefined) return false;
  if (head.startsWith("ref:")) {
    return (
      strict ? /^ref:[ \t\n\r]*refs\// : /^ref:[ \t\n\r\f\v]*refs\//
    ).test(head);
  }
  return /^[0-9a-fA-F]{40}/.test(head);
}

/** The directory holding `objects` and `refs` for the git directory
 * `dir`, as git finds it (setup.c, `get_common_dir_noenv`): the one its
 * `commondir` file names (a linked worktree's administrative directory
 * names the repository's), relative to `dir` and resolved by real path,
 * so a symlink on it is followed before a `..` after it applies
 * (`strbuf_add_real_path`); else `dir` itself. Where git would stop (a
 * `commondir` entry that is empty, unreadable or names a path that does
 * not resolve), `strict` gives undefined; otherwise an unreadable or
 * empty file reads as none and an unresolvable path is taken lexically. */
function commonDirOf(dir: string, strict: boolean): string | undefined {
  const file = path.join(dir, "commondir");
  try {
    fs.lstatSync(file);
  } catch {
    return dir;
  }
  const content = readRegular(file);
  if (content === undefined || content.length === 0) {
    return strict ? undefined : dir;
  }
  // As `get_common_dir_noenv`: trailing CR and LF go first, then the path
  // ends at the first NUL (git hands it on as a C string).
  let end = content.length;
  while (end > 0 && (content[end - 1] === 0x0a || content[end - 1] === 0x0d)) {
    end--;
  }
  let bytes = content.subarray(0, end);
  const nul = bytes.indexOf(0);
  if (nul >= 0) bytes = bytes.subarray(0, nul);
  const named = bytes.toString("utf8");
  const resolved = physicalPath(dir, named);
  if (resolved !== undefined) return resolved;
  return strict ? undefined : path.resolve(dir, named);
}

function entryExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** git's `access(path, X_OK)`: the entry exists and may be searched. */
function isSearchable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `objects` and `refs` in `dir`: the half of git's test that a common
 * directory has to pass. */
function holdsObjectsAndRefs(dir: string): boolean {
  return (
    entryExists(path.join(dir, "objects")) &&
    entryExists(path.join(dir, "refs"))
  );
}

/** git's own test of a git directory (setup.c, `is_git_directory`): a
 * valid `HEAD`, plus `objects` and `refs` in the common directory.
 *
 * `strict` applies it as git does without any `GIT_*` variable: `objects`
 * and `refs` must be searchable, and a `commondir` git would stop at
 * fails the test. It decides whether git opens a root as a work tree,
 * which grants an exception (see `gitDirAbove`), so it must not be wider
 * than git.
 *
 * Otherwise the test refuses, so it may be wider than git, never
 * narrower: `objects` and `refs` only have to exist, and when the caller
 * set them, `GIT_COMMON_DIR` adds a second place to look and
 * `GIT_OBJECT_DIRECTORY` makes `objects` optional, as git looks there. */
function isGitDirectory(dir: string, strict: boolean): boolean {
  if (!validHeadRef(path.join(dir, "HEAD"), strict)) return false;
  const own = commonDirOf(dir, strict);
  const commons = own === undefined ? [] : [own];
  let objectsElsewhere = false;
  if (!strict) {
    const envCommon = process.env.GIT_COMMON_DIR ?? "";
    if (envCommon.length > 0) commons.push(path.resolve(envCommon));
    objectsElsewhere = (process.env.GIT_OBJECT_DIRECTORY ?? "").length > 0;
  }
  const has = strict ? isSearchable : entryExists;
  return commons.some(
    (common) =>
      (objectsElsewhere || has(path.join(common, "objects"))) &&
      has(path.join(common, "refs")),
  );
}

/** A linked worktree's administrative directory (`<git dir>/worktrees/
 * <name>`), by the two files `git worktree add` writes there: `gitdir`,
 * naming the work tree, and `commondir`, naming the repository. */
function isWorktreeAdminDir(dir: string): boolean {
  return (
    isRegularFile(path.join(dir, "gitdir")) &&
    isRegularFile(path.join(dir, "commondir"))
  );
}

/** Why a directory counts as a git directory: git named it from the
 * root, or it is laid out like one. */
type GitDirEvidence = "named" | "layout" | "worktree_admin";

/** The layout test (the wide form, which refuses), cached per directory
 * for one `patch` call. */
function gitDirLayout(
  dir: string,
  cache: Map<string, GitDirEvidence | null>,
): GitDirEvidence | null {
  const known = cache.get(dir);
  if (known !== undefined) return known;
  const result: GitDirEvidence | null = isGitDirectory(dir, false)
    ? "layout"
    : isWorktreeAdminDir(dir)
      ? "worktree_admin"
      : null;
  cache.set(dir, result);
  return result;
}

/** The git directory that makes `root` a work tree git opens: its `.git`
 * directory, or the directory its `.git` file names (`gitdir: <path>`,
 * read as git reads it, `gitfilePath`, and resolved by the filesystem
 * from `root` as git resolves it, `physicalPath`; setup.c,
 * `read_gitfile_gently`), when that passes git's own test as git applies
 * it. Undefined when `.git` is neither, names nothing, names a path that
 * cannot be followed or resolved, or names a directory git would not
 * open: git then stops (a `.git` file) or looks further up for another
 * repository (a `.git` directory), so `root` has no git directory of its
 * own. */
function workTreeGitDir(root: string): string | undefined {
  const entry = path.join(root, ".git");
  let st: fs.Stats;
  try {
    st = fs.statSync(entry);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return isGitDirectory(entry, true) ? entry : undefined;
  if (!st.isFile() || st.size > GITFILE_MAX) return undefined;
  const named = gitfilePath(readRegular(entry, GITFILE_MAX));
  if (named === undefined || named === null) return undefined;
  const gitDir = physicalPath(root, named);
  if (gitDir === undefined) return undefined;
  return isGitDirectory(gitDir, true) ? gitDir : undefined;
}

/** Identities of the git directory `gitDir` and of its common directory
 * (the same directory unless a `commondir` file names another). */
function ownGitDirs(gitDir: string): Set<string> {
  const ids = new Set<string>();
  for (const dir of [gitDir, commonDirOf(gitDir, true)]) {
    const id = dir === undefined ? undefined : identityOf(dir);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/** Directories git keeps inside a git directory (`gitrepository-layout`,
 * plus the reftable store and the state of a rebase, cherry-pick or
 * revert in progress). */
const GIT_DIR_SUBDIRS = new Set([
  "objects",
  "refs",
  "hooks",
  "info",
  "logs",
  "worktrees",
  "modules",
  "branches",
  "remotes",
  "rr-cache",
  "reftable",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
]);

/**
 * True when `root`, below the git directory `dir`, lies in one of git's
 * own directories there. Decided by the filesystem: for each reserved
 * name, the entry it finds as `<dir>/<name>` (a symlink there followed)
 * is compared by device and inode with `root` and every directory above
 * it. So a spelling the filesystem folds to a reserved name (letter case,
 * U+017F on APFS, a Unicode normalisation variant) counts, and so does a
 * reserved entry that is a symlink to the root or above it. The first
 * component's name, lower-cased, is compared too; on a case-sensitive
 * filesystem that only adds refusals.
 */
function underGitSubdir(dir: string, root: string): boolean {
  const first = path.relative(dir, root).split(path.sep)[0];
  if (GIT_DIR_SUBDIRS.has(first.toLowerCase())) return true;
  const reserved = new Set<string>();
  for (const name of GIT_DIR_SUBDIRS) {
    const id = identityOf(path.join(dir, name));
    if (id !== undefined) reserved.add(id);
  }
  for (let d = root; ; d = path.dirname(d)) {
    const id = identityOf(d);
    if (id !== undefined && reserved.has(id)) return true;
    if (path.dirname(d) === d) return false;
  }
}

interface GitDirChecks {
  /** Identities of the git and common directories git names from the
   * root. */
  ids: ReadonlySet<string>;
  root: string;
  /** Identities of the root's own git directory and common directory
   * (`workTreeGitDir`); empty when the root is no work tree git opens. */
  own: ReadonlySet<string>;
  layout: Map<string, GitDirEvidence | null>;
}

/**
 * The nearest directory above `real` that is a git directory: one git
 * named from the root (compared by identity, so under any name), or one
 * laid out like a git directory, whatever git says or is allowed to say.
 * The walk goes on to the filesystem root for every target. The one
 * exception, for a target inside the root and only above the root: the
 * root's own git directory and common directory are passed over, so a
 * work tree checked out inside its own repository is editable; but not
 * when the root lies in one of git's own directories there (a work tree
 * made of `<repo>/hooks` stays refused).
 */
function gitDirAbove(
  real: string,
  checks: GitDirChecks,
): { dir: string; evidence: GitDirEvidence } | undefined {
  let dir = path.dirname(real);
  let aboveRoot = false;
  for (;;) {
    const id = identityOf(dir);
    const ownRepository =
      aboveRoot &&
      id !== undefined &&
      checks.own.has(id) &&
      !underGitSubdir(dir, checks.root);
    if (!ownRepository) {
      if (id !== undefined && checks.ids.has(id)) {
        return { dir, evidence: "named" };
      }
      const layout = gitDirLayout(dir, checks.layout);
      if (layout !== null) return { dir, evidence: layout };
    }
    // The walk from a target inside the root passes the root itself.
    if (dir === checks.root) aboveRoot = true;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function gitDirDetail(
  file: string,
  above: { dir: string; evidence: GitDirEvidence } | undefined,
): string {
  if (above === undefined) {
    return `${file} has a .git path component; patch never writes into a git directory`;
  }
  const how =
    above.evidence === "named"
      ? "which git names as its git directory or common directory"
      : above.evidence === "layout"
        ? "which looks like a git directory (HEAD, objects and refs)"
        : "which looks like a git directory (a linked worktree's gitdir and commondir files)";
  return `${file} is inside ${above.dir}, ${how}; patch never writes into a git directory`;
}

/** Decodes a file for editing, or names why it cannot be edited. */
function decodeFile(
  buffer: Buffer,
):
  | { ok: true; raw: string; bom: boolean }
  | { ok: false; reason: string; detail: string } {
  if (buffer.includes(0)) {
    return {
      ok: false,
      reason: "binary",
      detail: "file contains a NUL byte; binary files are not edited",
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch {
    return {
      ok: false,
      reason: "not_utf8",
      detail: "file is not valid UTF-8; only UTF-8 text files are edited",
    };
  }
  if (text.startsWith("\uFEFF"))
    return { ok: true, raw: text.slice(1), bom: true };
  return { ok: true, raw: text, bom: false };
}

function errnoDetail(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e instanceof Error ? e.message : String(err);
}

/**
 * Applies a plan of exact-text edits. Every edit is resolved against the
 * current content of every file before anything is written: a missing,
 * ambiguous, overlapping or side-effecting edit, a refused path, a file
 * that is not editable as is, or an unreadable file refuses the whole plan
 * and nothing is written. Then each changed file is written through a
 * temporary file in its own directory and a rename, in plan order; a file
 * whose path or bytes changed since they were read, or a write error,
 * stops the write phase and the result names the files already written.
 */
export function patch(options: PatchOptions): PatchResult {
  const dryRun = options.dryRun === true;
  const cwd = path.resolve(options.cwd);
  const gitRoot = findGitRoot(cwd);
  const rootLexical = gitRoot ?? cwd;
  let root: string;
  try {
    // The native realpath returns each component as it is stored, so a
    // case or Unicode-normalisation variant of the root reads as the root.
    root = fs.realpathSync.native(rootLexical);
  } catch (err) {
    throw new UsageError(
      `patch: cannot resolve root ${rootLexical}: ${errnoDetail(err)}`,
    );
  }
  // Asked whether or not a work tree was found: `-C` may lie in a bare
  // repository or a git directory, which has no work tree.
  const gitDirs = gitDirIdentities(
    root,
    gitRoot !== undefined,
    options.gitTimeoutMs ?? GIT_LOOKUP_TIMEOUT_MS,
  );
  const ownGitDir = workTreeGitDir(root);
  const checks: GitDirChecks = {
    ids: gitDirs.ids,
    root,
    own: ownGitDir !== undefined ? ownGitDirs(ownGitDir) : new Set(),
    layout: new Map(),
  };
  const warnings: string[] =
    gitDirs.warning !== undefined ? [gitDirs.warning] : [];
  const rename =
    options.renameFile ?? ((a: string, b: string) => fs.renameSync(a, b));

  for (let i = 0; i < options.edits.length; i++) {
    if (options.edits[i].old.length === 0) {
      throw new PatchUsageError(
        `patch: edits[${String(i)}].old must not be empty`,
        "empty_old",
      );
    }
  }

  // Resolve every target path; group edits per file identity (dev:ino),
  // so every spelling of one file shares one state and one write.
  const files = new Map<string, FileState>();
  const order: FileState[] = [];
  const editResults: PatchEditResult[] = [];
  for (let i = 0; i < options.edits.length; i++) {
    const spec = options.edits[i];
    const lexical = path.resolve(cwd, spec.file);
    let real: string | undefined;
    let identity: string | undefined;
    let pathError:
      | {
          reason: string;
          detail: string;
          status: "refused" | "error" | "not_editable";
        }
      | undefined;
    try {
      real = fs.realpathSync.native(lexical);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      pathError =
        code === "ENOENT" || code === "ENOTDIR"
          ? {
              status: "error",
              reason: "not_found",
              detail: `${spec.file}: file does not exist; patch only edits existing files (it never creates one)`,
            }
          : {
              status: "error",
              reason: "unreadable",
              detail: `cannot resolve ${spec.file}: ${errnoDetail(err)}`,
            };
    }
    let st: fs.Stats | undefined;
    if (real !== undefined) {
      try {
        st = fs.statSync(real);
        identity = identityOf(real);
      } catch (err) {
        pathError = {
          status: "error",
          reason: "unreadable",
          detail: errnoDetail(err),
        };
      }
    }
    const contained = real !== undefined && isPathContained(root, real);
    const display =
      real === undefined
        ? spec.file
        : contained
          ? path.relative(root, real)
          : real;
    if (real !== undefined && pathError === undefined) {
      const lexicalRel = path.relative(rootLexical, lexical);
      const lexicalContained = isPathContained(rootLexical, lexical);
      // By name, and by what the filesystem finds as `.git` in each
      // component's directory; both on the same part of each path.
      const gitSegment =
        hasGitSegment(contained ? path.relative(root, real) : real) ||
        hasGitSegment(lexicalContained ? lexicalRel : lexical) ||
        hasGitEntry(contained ? root : path.parse(real).root, real) ||
        hasGitEntry(
          lexicalContained ? rootLexical : path.parse(lexical).root,
          lexical,
        );
      const above = gitSegment ? undefined : gitDirAbove(real, checks);
      if (gitSegment || above !== undefined) {
        pathError = {
          status: "refused",
          reason: "git_dir",
          detail: gitDirDetail(spec.file, above),
        };
      } else if (!contained && options.allowOutside !== true) {
        pathError = {
          status: "refused",
          reason: "outside_root",
          detail: `${spec.file} resolves to ${real}, outside the root ${root} (pass --allow-outside to permit)`,
        };
      } else if (st !== undefined && !st.isFile()) {
        pathError = {
          status: "error",
          reason: "not_a_file",
          detail: `${spec.file} is not a regular file`,
        };
      } else if (
        st !== undefined &&
        st.nlink > 1 &&
        options.breakHardLinks !== true
      ) {
        pathError = {
          status: "not_editable",
          reason: "hard_link",
          detail: `${spec.file} has ${String(st.nlink)} hard links; writing it would leave the other names with the old content (pass --break-hard-links to accept that)`,
        };
      } else if (!isWritable(real)) {
        pathError = {
          status: "not_editable",
          reason: "read_only",
          detail: `${spec.file} is not writable; patch does not change a read-only file`,
        };
      }
    }
    const key = identity ?? `missing:${lexical}`;
    let state = files.get(key);
    if (state === undefined) {
      state = { key, display, real: real ?? lexical, lexicals: [], edits: [] };
      files.set(key, state);
      order.push(state);
    }
    state.lexicals.push(lexical);
    state.edits.push(i);
    if (pathError !== undefined && state.status === undefined) {
      state.status = pathError.status;
      state.reason = pathError.reason;
      state.detail = pathError.detail;
    }
    editResults.push({
      index: i,
      file: spec.file,
      path: state.display,
      status: "not_written",
    });
  }

  // Read and resolve every file that passed the path checks. An exception
  // inside the engine is that file's error, never the whole command's.
  for (const state of order) {
    if (state.status !== undefined) continue;
    try {
      resolveState(state, options.edits, editResults);
    } catch (err) {
      state.status = "error";
      state.reason = "internal";
      state.detail = `internal error while resolving the edits: ${errnoDetail(err)}; nothing written`;
    }
  }

  // Path, IO and editability errors on the edits of an unusable file.
  for (const state of order) {
    if (
      state.status === "refused" ||
      state.status === "error" ||
      state.status === "not_editable"
    ) {
      for (const i of state.edits) {
        editResults[i].status = state.status;
        editResults[i].reason = state.reason;
        editResults[i].detail = state.detail;
      }
    }
  }

  const has = (s: PatchEditStatus): boolean =>
    editResults.some((e) => e.status === s);
  const refusedPlan =
    has("refused") ||
    has("error") ||
    has("missing") ||
    has("ambiguous") ||
    has("overlap") ||
    has("fuzzy_side_effect") ||
    has("not_editable");

  const writtenFiles: string[] = [];
  let writeFailure:
    { file: string; detail: string; reason: string } | undefined;

  if (!refusedPlan) {
    for (const state of order) {
      const unchanged = state.newRaw === state.raw;
      if (unchanged) {
        state.status = "unchanged";
        continue;
      }
      if (dryRun) {
        state.status = "would_write";
        continue;
      }
      if (writeFailure !== undefined) {
        state.status = "not_written";
        continue;
      }
      const failure = writeFile(state, rename);
      if (failure === undefined) {
        state.status = "written";
        writtenFiles.push(state.display);
      } else {
        state.status = "error";
        state.reason = failure.reason;
        state.detail = failure.detail;
        writeFailure = { file: state.display, ...failure };
      }
    }
    for (const state of order) {
      for (const i of state.edits) {
        const s = state.status;
        editResults[i].status =
          s === "written" ||
          s === "would_write" ||
          s === "unchanged" ||
          s === "error"
            ? s
            : "not_written";
        if (s === "error") {
          editResults[i].reason = state.reason;
          editResults[i].detail = state.detail;
        }
      }
    }
  } else {
    for (const state of order) {
      if (state.status === undefined) state.status = "not_written";
    }
  }

  const count = (s: PatchEditStatus): number =>
    editResults.filter((e) => e.status === s).length;
  let status: PatchStatus;
  let reason: string | undefined;
  let message: string | undefined;
  const firstWith = (s: PatchEditStatus): PatchEditResult | undefined =>
    editResults.find((e) => e.status === s);
  if (has("refused")) {
    status = "usage_error";
    const first = firstWith("refused");
    reason = first?.reason;
    message =
      first !== undefined ? `${first.path}: ${first.detail ?? ""}` : undefined;
  } else if (has("error")) {
    status = "error";
    const first = firstWith("error");
    reason = writeFailure !== undefined ? "write_failed" : first?.reason;
    message =
      writeFailure !== undefined
        ? `writing ${writeFailure.file} failed (${writeFailure.detail}); already written: ${writtenFiles.length > 0 ? writtenFiles.join(", ") : "none"}`
        : first !== undefined
          ? `${first.path}: ${first.detail ?? ""}`
          : undefined;
  } else if (has("missing")) {
    status = "missing";
  } else if (has("ambiguous")) {
    status = "ambiguous";
  } else if (has("overlap")) {
    status = "overlap";
  } else if (has("fuzzy_side_effect")) {
    status = "fuzzy_side_effect";
  } else if (has("not_editable")) {
    status = "not_editable";
    reason = firstWith("not_editable")?.reason;
  } else if (dryRun) {
    status = order.some((s) => s.status === "would_write")
      ? "would_write"
      : "unchanged";
  } else {
    status = writtenFiles.length > 0 ? "written" : "unchanged";
  }
  if (refusedPlan && status !== "usage_error" && status !== "error") {
    message = "plan refused: nothing was written";
  }
  if (
    editResults.some(
      (e) =>
        e.tier !== undefined &&
        e.tier !== "exact" &&
        e.status !== "fuzzy_side_effect",
    )
  ) {
    warnings.push(
      "a fuzzy tier matched: the old text matched only after normalization (trailing whitespace ignored; under the unicode tier also NFKC, typographic quotes, dashes and special spaces), so the replaced text in the file differs from old; every character outside the match is kept",
    );
  }

  const fileResults: PatchFileResult[] = order.map((s) => {
    const out: PatchFileResult = {
      path: s.display,
      status: s.status ?? "not_written",
      edits: s.edits,
    };
    if (s.ending !== undefined)
      out.line_ending = s.ending === "\r\n" ? "crlf" : "lf";
    if (s.bom !== undefined) out.bom = s.bom;
    if (s.diff !== undefined && s.diff.length > 0) out.diff = s.diff;
    if (s.reason !== undefined) out.reason = s.reason;
    if (s.detail !== undefined) out.detail = s.detail;
    return out;
  });

  return {
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(message !== undefined ? { message } : {}),
    dryRun,
    root,
    edits: editResults,
    files: fileResults,
    writtenFiles,
    counts: {
      edits: editResults.length,
      files: order.length,
      files_written: writtenFiles.length,
      written: count("written"),
      would_write: count("would_write"),
      unchanged: count("unchanged"),
      missing: count("missing"),
      ambiguous: count("ambiguous"),
      overlap: count("overlap"),
      fuzzy_side_effect: count("fuzzy_side_effect"),
      not_editable: count("not_editable"),
      refused: count("refused"),
      errors: count("error"),
    },
    warnings,
  };
}

/** True when the current process may write `p`. */
function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads, decodes and resolves the edits of one file into `state`. */
function resolveState(
  state: FileState,
  edits: readonly PatchEditSpec[],
  editResults: PatchEditResult[],
): void {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(state.real);
    state.mode = fs.statSync(state.real).mode & 0o7777;
  } catch (err) {
    state.status = "error";
    state.reason = "unreadable";
    state.detail = errnoDetail(err);
    return;
  }
  const decoded = decodeFile(buffer);
  if (!decoded.ok) {
    state.status = "error";
    state.reason = decoded.reason;
    state.detail = decoded.detail;
    return;
  }
  state.buffer = buffer;
  state.raw = decoded.raw;
  state.bom = decoded.bom;
  state.ending = detectLineEnding(decoded.raw);
  const lf = crlfToLf(decoded.raw);
  state.lf = lf;
  const resolution = resolveFileEdits(
    lf,
    state.edits.map((i) => ({
      index: i,
      old: crlfToLf(edits[i].old),
      new: crlfToLf(edits[i].new),
      replaceAll: edits[i].replaceAll === true,
    })),
  );
  for (const r of resolution.edits) {
    const target = editResults[r.index];
    applyResolution(target, r);
    if (r.status === "missing") {
      target.hint = notFoundHint(
        lf,
        crlfToLf(edits[r.index].old),
        crlfToLf(edits[r.index].new),
      );
    } else if (r.status === "fuzzy_side_effect") {
      target.side_effect = fuzzySideEffectHint(
        lf,
        r.affectedLines,
        r.tier,
        crlfToLf(edits[r.index].old),
      );
      target.detail = target.side_effect.message;
    }
  }
  if (resolution.newContent !== undefined) {
    state.regions = resolution.regions;
    // Every raw range the write replaces or keeps must read as the LF
    // view does, or the raw splice would not be the change the LF view
    // (and the diff) shows.
    if (!rawMappingAgrees(decoded.raw, lf, resolution.regions)) {
      state.status = "error";
      state.reason = "internal";
      state.detail =
        "line-ending mapping disagreed with the LF view; nothing written";
      return;
    }
    state.newRaw = applyRegionsToRaw(
      decoded.raw,
      resolution.regions,
      state.ending,
    );
    state.diff = unifiedDiff(state.display, lf, resolution.regions);
  }
}

function applyResolution(target: PatchEditResult, r: EditResolution): void {
  switch (r.status) {
    case "resolved":
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.line_ranges = r.lineRanges;
      break;
    case "missing":
      target.status = "missing";
      break;
    case "ambiguous":
      target.status = "ambiguous";
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.match_lines = r.matchLines;
      target.detail = `old text matches ${String(r.occurrences)} times (${r.tier} tier) at lines ${r.matchLines.join(", ")}; add surrounding context or set replaceAll`;
      break;
    case "overlap":
      target.status = "overlap";
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.line_ranges = r.lineRanges;
      target.overlaps_with = r.overlapsWith;
      target.detail = `overlaps edits ${r.overlapsWith.map((i) => `[${String(i)}]`).join(", ")} in the same file (a fuzzy-tier match covers whole lines); merge them into one edit or target disjoint text`;
      break;
    case "fuzzy_side_effect":
      target.status = "fuzzy_side_effect";
      target.tier = r.tier;
      target.occurrences = r.occurrences;
      target.line_ranges = r.lineRanges;
      break;
  }
}

/** Writes one file through a temporary file in the same directory plus a
 * rename, keeping the file mode and BOM. Right before, every spelling of
 * the file must still resolve to the path that was read (a directory
 * swapped for a symlink in between is refused) and the bytes must be the
 * ones that were read. Returns a failure or undefined. */
function writeFile(
  state: FileState,
  rename: (from: string, to: string) => void,
): { reason: string; detail: string } | undefined {
  // The resolved path must still resolve to itself (no directory on it
  // was swapped for a symlink), and every spelling the plan used must
  // still name the same file.
  let now: string;
  try {
    now = fs.realpathSync.native(state.real);
  } catch (err) {
    return {
      reason: "path_changed",
      detail: `${state.real} no longer resolves (${errnoDetail(err)}); not written`,
    };
  }
  if (now !== state.real) {
    return {
      reason: "path_changed",
      detail: `${state.real} now resolves to ${now}; not written`,
    };
  }
  for (const spelling of state.lexicals) {
    if (identityOf(spelling) !== state.key) {
      return {
        reason: "path_changed",
        detail: `${spelling} no longer names the file that was read; not written`,
      };
    }
  }
  let current: Buffer;
  try {
    current = fs.readFileSync(state.real);
  } catch (err) {
    return { reason: "unreadable", detail: errnoDetail(err) };
  }
  if (state.buffer === undefined || !current.equals(state.buffer)) {
    return {
      reason: "changed_since_read",
      detail: "the file changed after it was read; not overwritten",
    };
  }
  const dir = path.dirname(state.real);
  const tmp = path.join(
    dir,
    `.${path.basename(state.real)}.${randomBytes(6).toString("hex")}.agent-primitives-patch.tmp`,
  );
  const content = (state.bom === true ? "\uFEFF" : "") + (state.newRaw ?? "");
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: state.mode ?? 0o644 });
    // writeFileSync's mode is filtered by the umask; set it exactly.
    fs.chmodSync(tmp, state.mode ?? 0o644);
    rename(tmp, state.real);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temporary file is reported below if it could not be removed.
    }
    return {
      reason: "write_failed",
      detail: `${errnoDetail(err)}${fs.existsSync(tmp) ? `; temporary file left at ${tmp}` : ""}`,
    };
  }
  return undefined;
}
