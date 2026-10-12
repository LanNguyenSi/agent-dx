import fs from "node:fs";
import path from "node:path";
import { runGit } from "../drift/git.js";
import { withoutRepoSelectionEnv } from "../git-env.js";
import { probeGitArgv } from "./git.js";
import { linkEntryUsageError, type LinkSourceGroup } from "./link-list.js";

/**
 * The record `worktree create` leaves of the dependency links it made, and
 * the one place `probe` learns that those links are the operator's own.
 *
 * Both halves live in this module so that where the record is written, where
 * it is read, and what shape it has cannot drift apart.
 *
 * Trust is by location, the same idea `linkSourceIsOperatorInput` applies to
 * a plan file: the manifest sits in the new worktree's private git
 * administration directory (`<common git dir>/worktrees/<id>/`), never in
 * the working tree. Everything a commit can write ends up in the working
 * tree; a checkout cannot write into the administration directory, so a
 * repository cannot grant itself a link by shipping a file of this name.
 * The location is found by asking git (with the repository-selection
 * environment removed), and only a linked worktree's administration
 * directory counts: a plain clone, a submodule and a bare layout have no
 * manifest. Absence is not an error; anything present that cannot be shown
 * to be what `create` wrote is rejected as a whole (never partly trusted)
 * with a warning.
 */

/** File name inside the worktree's git administration directory. */
export const LINK_MANIFEST_FILE = "agent-primitives-links.json";

export const LINK_MANIFEST_VERSION = 1;

/** A manifest is a short list of paths; anything larger is the wrong file. */
export const LINK_MANIFEST_MAX_BYTES = 64 * 1024;

/** Upper bound on entries, so a hostile file cannot make the probe stat
 * thousands of paths. */
export const LINK_MANIFEST_MAX_ENTRIES = 256;

const MANIFEST_KEYS = ["version", "toolVersion", "links"] as const;
const ENTRY_KEYS = ["path", "target", "createdAt"] as const;

/** One link `create` made. */
export interface ManifestLink {
  /** Repository-relative POSIX path of the symlink in the worktree. */
  path: string;
  /** Absolute path the symlink was created to point at (its readlink text). */
  target: string;
  /** ISO timestamp of the creation. */
  createdAt: string;
}

export interface LinkManifest {
  version: typeof LINK_MANIFEST_VERSION;
  toolVersion: string;
  links: ManifestLink[];
}

export type AdminDirResult =
  { ok: true; dir: string } | { ok: false; reason: string };

/**
 * The git administration directory of `root` when `root` is the top level
 * of a LINKED worktree, else `ok: false`. The shape is checked, not just
 * "the two git dirs differ": the administration directory must be
 * `<common git dir>/worktrees/<id>`, which is what `git worktree add`
 * makes and what a submodule's `.git/modules/<name>` is not.
 */
export function linkedWorktreeAdminDir(root: string): AdminDirResult {
  const run = runGit(
    root,
    probeGitArgv(["rev-parse", "--absolute-git-dir", "--git-common-dir"]),
    withoutRepoSelectionEnv(),
  );
  if (run.error !== undefined || run.status !== 0) {
    return { ok: false, reason: "git could not report the git directory" };
  }
  const lines = run.stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length !== 2) {
    return { ok: false, reason: "unexpected git rev-parse output" };
  }
  let gitDir: string;
  let commonDir: string;
  try {
    gitDir = fs.realpathSync(lines[0]!);
    commonDir = fs.realpathSync(path.resolve(root, lines[1]!));
  } catch {
    return { ok: false, reason: "the git directory cannot be resolved" };
  }
  const parent = path.dirname(gitDir);
  if (
    path.basename(parent) !== "worktrees" ||
    path.dirname(parent) !== commonDir
  ) {
    return { ok: false, reason: "not a linked worktree" };
  }
  return { ok: true, dir: gitDir };
}

export type ManifestWriteResult =
  | { status: "written"; path: string }
  | { status: "failed"; path?: string; reason: string };

/**
 * Writes the manifest into the administration directory of the freshly
 * created worktree at `worktree`. `wx`: an existing file is never
 * replaced, and mode 0600 keeps it from being group- or world-writable
 * whatever the umask. A failure is reported, never thrown: the worktree
 * and its links are already in place, and a missing manifest only means
 * the probe will not trust them without `--link`.
 */
export function writeLinkManifest(
  worktree: string,
  links: readonly ManifestLink[],
  toolVersion: string,
): ManifestWriteResult {
  const admin = linkedWorktreeAdminDir(worktree);
  if (!admin.ok) return { status: "failed", reason: admin.reason };
  const file = path.join(admin.dir, LINK_MANIFEST_FILE);
  const manifest: LinkManifest = {
    version: LINK_MANIFEST_VERSION,
    toolVersion,
    links: [...links],
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (err) {
    return {
      status: "failed",
      path: file,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { status: "written", path: file };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `rel` is already in the exact form `create` records: relative,
 * POSIX, normalized, below the root and not below `.git`. */
function recordedPathProblem(rel: unknown): string | undefined {
  const shape = linkEntryUsageError(rel);
  if (shape !== undefined) return shape;
  const value = rel as string;
  if (value.includes("\0") || value.includes("\n") || value.includes("\\")) {
    return "contains a NUL, a newline or a backslash";
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    return "is not a normalized relative path";
  }
  if (value === "." || value === ".." || value.startsWith("../")) {
    return "leaves the repository";
  }
  if (value.endsWith("/")) return "ends with a slash";
  if (value.split("/")[0]!.toLowerCase() === ".git") {
    return "points into .git";
  }
  return undefined;
}

export type ParsedManifest =
  { ok: true; manifest: LinkManifest } | { ok: false; reason: string };

/** Validates parsed JSON against the manifest schema: exact keys, no
 * extras, every entry well formed, no duplicate paths. */
export function parseManifest(parsed: unknown): ParsedManifest {
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const extra = Object.keys(parsed).find(
    (key) => !(MANIFEST_KEYS as readonly string[]).includes(key),
  );
  if (extra !== undefined)
    return { ok: false, reason: `unknown key "${extra}"` };
  if (parsed.version !== LINK_MANIFEST_VERSION) {
    return { ok: false, reason: "unsupported version" };
  }
  if (typeof parsed.toolVersion !== "string") {
    return { ok: false, reason: '"toolVersion" must be a string' };
  }
  if (!Array.isArray(parsed.links)) {
    return { ok: false, reason: '"links" must be an array' };
  }
  if (parsed.links.length > LINK_MANIFEST_MAX_ENTRIES) {
    return { ok: false, reason: "too many entries" };
  }
  const seen = new Set<string>();
  const links: ManifestLink[] = [];
  for (const [index, raw] of parsed.links.entries()) {
    const at = `links[${String(index)}]`;
    if (!isPlainObject(raw)) {
      return { ok: false, reason: `${at} is not an object` };
    }
    const extraEntryKey = Object.keys(raw).find(
      (key) => !(ENTRY_KEYS as readonly string[]).includes(key),
    );
    if (extraEntryKey !== undefined) {
      return { ok: false, reason: `${at}: unknown key "${extraEntryKey}"` };
    }
    const problem = recordedPathProblem(raw.path);
    if (problem !== undefined) {
      return { ok: false, reason: `${at}.path ${problem}` };
    }
    const rel = raw.path as string;
    if (typeof raw.target !== "string" || !path.isAbsolute(raw.target)) {
      return { ok: false, reason: `${at}.target must be an absolute path` };
    }
    if (
      typeof raw.createdAt !== "string" ||
      Number.isNaN(Date.parse(raw.createdAt))
    ) {
      return { ok: false, reason: `${at}.createdAt must be a timestamp` };
    }
    if (seen.has(rel))
      return { ok: false, reason: `${at}.path is a duplicate` };
    seen.add(rel);
    links.push({ path: rel, target: raw.target, createdAt: raw.createdAt });
  }
  return {
    ok: true,
    manifest: {
      version: LINK_MANIFEST_VERSION,
      toolVersion: parsed.toolVersion,
      links,
    },
  };
}

export type ManifestReadResult =
  | { status: "absent" }
  | { status: "rejected"; path: string; reason: string }
  | { status: "ok"; path: string; manifest: LinkManifest };

/**
 * Reads the manifest of the linked worktree whose top level is `root`.
 * The file is opened once, without following a symlink in its last
 * component (`O_NOFOLLOW`; `O_NONBLOCK` keeps a FIFO from hanging the
 * open), and every check is made on that descriptor: a regular file with
 * one hard link, within the size cap, owned by the current user and not
 * writable by group or others (where the platform has those notions). The
 * bytes read are bounded by the size the cap was checked against.
 */
export function readLinkManifest(root: string): ManifestReadResult {
  const admin = linkedWorktreeAdminDir(root);
  if (!admin.ok) return { status: "absent" };
  const file = path.join(admin.dir, LINK_MANIFEST_FILE);
  const rejected = (reason: string): ManifestReadResult => ({
    status: "rejected",
    path: file,
    reason,
  });
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY |
        fs.constants.O_NONBLOCK |
        (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent" };
    return rejected(
      code === "ELOOP"
        ? "it is a symbolic link"
        : `it cannot be opened (${code ?? "unknown error"})`,
    );
  }
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return rejected("it is not a regular file");
    if (stat.nlink !== 1) return rejected("it has more than one hard link");
    if (stat.size > LINK_MANIFEST_MAX_BYTES) {
      return rejected(
        `it is over the ${String(LINK_MANIFEST_MAX_BYTES)}-byte cap`,
      );
    }
    if (process.platform !== "win32") {
      if ((stat.mode & 0o022) !== 0) {
        return rejected("it is writable by group or others");
      }
      if (
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid()
      ) {
        return rejected("it is not owned by the current user");
      }
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const chunk = fs.readSync(fd, buffer, read, stat.size - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    text = buffer.subarray(0, read).toString("utf8");
  } catch (err) {
    return rejected(
      `it cannot be read (${err instanceof Error ? err.message : String(err)})`,
    );
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // A descriptor this process cannot close is released at exit.
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rejected("it is not valid JSON");
  }
  const checked = parseManifest(parsed);
  if (!checked.ok) return rejected(checked.reason);
  return { status: "ok", path: file, manifest: checked.manifest };
}

export type LinkHolds =
  { holds: true } | { holds: false; reason: string; quiet?: true };

/**
 * Whether the recorded link still stands in the working tree of `root`
 * exactly as `create` made it: every parent below the root is a real
 * directory, the entry itself is a symbolic link, its readlink text is
 * the recorded target, and that target is (still) a directory.
 *
 * A checkout can replace a link (git overwrites an ignored path), and
 * anyone can retarget one; a link that is no longer what `create` made
 * is not the operator's act any more, so it is not trusted. A target that
 * is not a directory is not an error but is not a `probe --link` source
 * either (`quiet`).
 */
export function recordedLinkStillHolds(
  root: string,
  link: ManifestLink,
): LinkHolds {
  const segments = link.path.split("/");
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cursor);
    } catch {
      return { holds: false, reason: `${cursor} is missing` };
    }
    // lstat: a symbolic link is not a directory here, so one is refused.
    if (!st.isDirectory()) {
      return {
        holds: false,
        reason: `${cursor} is not a plain directory any more`,
      };
    }
  }
  const dest = path.join(cursor, segments[segments.length - 1]!);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dest);
  } catch {
    return { holds: false, reason: "it no longer exists" };
  }
  if (!st.isSymbolicLink()) {
    return { holds: false, reason: "it is no longer a symbolic link" };
  }
  let pointsTo: string;
  try {
    pointsTo = fs.readlinkSync(dest);
  } catch {
    return { holds: false, reason: "its target cannot be read" };
  }
  if (pointsTo !== link.target) {
    return {
      holds: false,
      reason: `it now points at ${JSON.stringify(pointsTo)}, not at the recorded ${JSON.stringify(link.target)}`,
    };
  }
  let targetStat: fs.Stats;
  try {
    targetStat = fs.statSync(dest);
  } catch {
    return { holds: false, reason: "the recorded target no longer exists" };
  }
  if (!targetStat.isDirectory()) {
    return {
      holds: false,
      reason: "its target is not a directory",
      quiet: true,
    };
  }
  return { holds: true };
}

export interface TrustedManifestLinks {
  /** Repository-relative paths to offer as operator-typed `--link`
   * values, in manifest order. */
  values: string[];
  warnings: string[];
}

/**
 * The links of `root`'s manifest that probe may treat as operator input:
 * none unless `root` is a linked worktree whose administration directory
 * holds a valid manifest, and of its entries only those that still stand
 * as recorded (`recordedLinkStillHolds`). A manifest that is present but
 * rejected, and an entry that no longer holds, each leave one warning and
 * grant nothing.
 */
export function trustedManifestLinks(root: string): TrustedManifestLinks {
  const read = readLinkManifest(root);
  if (read.status === "absent") return { values: [], warnings: [] };
  if (read.status === "rejected") {
    return {
      values: [],
      warnings: [
        `ignoring the worktree link manifest ${read.path}: ${read.reason}`,
      ],
    };
  }
  const values: string[] = [];
  const warnings: string[] = [];
  for (const link of read.manifest.links) {
    const verdict = recordedLinkStillHolds(root, link);
    if (verdict.holds) {
      values.push(link.path);
    } else if (verdict.quiet !== true) {
      warnings.push(
        `not trusting recorded worktree link ${link.path} (${read.path}): ${verdict.reason}`,
      );
    }
  }
  return { values, warnings };
}

/**
 * The `link` source for the verified manifest entries: relative to the
 * repository root like a plan's, but with no `namedIn`, so each value is
 * judged exactly like an operator-typed `--link` (no `namedBy`). That is
 * the whole effect of a trusted manifest, and why it is decided by
 * `trustedManifestLinks` and nowhere else.
 */
export function manifestLinkGroup(
  root: string,
  values: readonly string[],
): LinkSourceGroup {
  return {
    base: root,
    basePhrase: "the repository root",
    values,
    remedy: "remove the link from the worktree",
  };
}
