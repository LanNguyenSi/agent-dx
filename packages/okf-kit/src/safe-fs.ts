import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";

/** `O_NOFOLLOW` is absent on Windows; the lstat walk still applies there. */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** Keeps an open of a FIFO from blocking when something else swapped one in after the check. */
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * lstat failures that mean "nothing reachable here": a missing component, a
 * file where a directory was expected, or a directory the process may not
 * search (nothing can be followed through it either).
 */
function isUnreachable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM"
  );
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (isUnreachable(error)) return undefined;
    throw error;
  }
}

function sameEntry(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

function isRealDirectory(p: string): boolean {
  return lstatOrUndefined(p)?.isDirectory() === true;
}

function hasGitEntry(dir: string): boolean {
  return lstatOrUndefined(path.join(dir, ".git")) !== undefined;
}

/**
 * The directory the symlink walk starts from; it and everything above it is
 * trusted, everything below it down to the target is checked. In order:
 *
 * 1. The nearest ancestor of the target (the target itself included) that
 *    holds a `.git` entry, file or directory. When one exists it is always
 *    used, whatever `cwd` is, so a deeper working directory cannot shorten
 *    the walk.
 * 2. Otherwise `cwd`, when the target lies under it. The match is by identity
 *    (device and inode) of an ancestor of the target, so a differently cased
 *    spelling on a case-insensitive volume still matches.
 * 3. Otherwise the target's parent directory, so the target itself is checked.
 *
 * A candidate for 1 or 2 must itself be a real directory (`lstat`), never a
 * link, so `docs -> .` is walked and refused, not taken as the root.
 */
export function findWalkRoot(resolvedTarget: string, cwd: string): string {
  const ancestors: string[] = [];
  for (let current = resolvedTarget; ;) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of ancestors) {
    if (isRealDirectory(candidate) && hasGitEntry(candidate)) return candidate;
  }
  for (const candidate of ancestors) {
    if (
      isRealDirectory(candidate) &&
      (candidate === cwd || sameEntry(candidate, cwd))
    ) {
      return candidate;
    }
  }
  return path.dirname(resolvedTarget);
}

function refuseLink(
  linkPath: string,
  requestedPath: string,
  ruleRoot: string,
  targetIsDirectory: boolean,
): never {
  let pointsTo = "";
  try {
    pointsTo = ` (it points to ${fs.readlinkSync(linkPath)})`;
  } catch {
    // Unreadable link text: the refusal still names the link.
  }
  const via =
    linkPath === requestedPath ? "" : `, and ${requestedPath} lies below it`;
  const hint =
    targetIsDirectory && linkPath === requestedPath
      ? " The target directory itself is a link; pass its real path instead."
      : "";
  throw new UsageError(
    `Refusing to write through the symbolic link ${linkPath}${pointsTo}${via}. ` +
      `okf-kit init never creates, truncates or writes a file through a symlink below ${ruleRoot}; nothing was written.${hint} ` +
      "Replace the link with a regular file or directory, or remove it, and run the command again.",
  );
}

/**
 * Throws a UsageError when `target`, or any directory between `root` and
 * `target`, is a symbolic link (a dangling link included). Components that do
 * not exist yet end the walk: nothing below a missing component can be a link.
 */
export function assertNoSymlinkBelow(
  root: string,
  target: string,
  targetIsDirectory = false,
): void {
  const rel = path.relative(root, target);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${target} is outside the walk root ${root}`);
  }
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = lstatOrUndefined(current);
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) {
      refuseLink(current, target, root, targetIsDirectory);
    }
  }
}

/**
 * Refuses an existing scaffold target that is not a regular file (a
 * directory, FIFO, socket or device); a link is refused by
 * {@link assertNoSymlinkBelow}. Returns normally when nothing exists there.
 */
export function assertRegularOrMissing(file: string): void {
  const stat = lstatOrUndefined(file);
  if (stat === undefined) return;
  if (stat.isFile()) {
    if (stat.nlink > 1) {
      throw new UsageError(
        `Refusing to write ${file}: it is a regular file with ${stat.nlink} hard links, so writing it would also change the other names. Nothing was written. ` +
          "Remove it and run the command again.",
      );
    }
    return;
  }
  const kind = stat.isDirectory()
    ? "a directory"
    : stat.isFIFO()
      ? "a FIFO"
      : stat.isSocket()
        ? "a socket"
        : "not a regular file";
  throw new UsageError(
    `Refusing to write ${file}: it exists and is ${kind}, not a regular file. Nothing was written. ` +
      "Remove it and run the command again.",
  );
}

/**
 * Creates `dir` and every missing ancestor, one level at a time, so no
 * `recursive` call walks through a component planted after the symlink check.
 */
export function ensureDirectories(dir: string): void {
  const missing: string[] = [];
  let current = dir;
  while (lstatOrUndefined(current) === undefined) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const level of missing.reverse()) {
    fs.mkdirSync(level);
  }
}

/**
 * Writes `content` to `file` without ever following a link at the leaf.
 * `overwrite` truncates an existing regular file (`O_TRUNC`); otherwise the
 * file must not exist (`O_EXCL`). A link, a non-regular file or an existing
 * file where none may be fails with a UsageError, whatever happened after the
 * earlier checks.
 */
export function writeFileNoFollow(
  file: string,
  content: string,
  overwrite: boolean,
): void {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    NOFOLLOW |
    NONBLOCK |
    (overwrite ? fs.constants.O_TRUNC : fs.constants.O_EXCL);
  let fd: number;
  try {
    fd = fs.openSync(file, flags, 0o666);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EEXIST" || code === "ENXIO") {
      throw new UsageError(
        `Refusing to write ${file}: it is a symbolic link, a non-regular file or already exists (${code}). ` +
          "Remove it and run the command again.",
      );
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new UsageError(
        `Refusing to write ${file}: it is not a regular file.`,
      );
    }
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}
