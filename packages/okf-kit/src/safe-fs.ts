import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors.js";

/** `O_NOFOLLOW` is absent on Windows; the lstat walk still applies there. */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** Keeps an open of a FIFO from blocking when something else swapped one in after the check. */
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/** How many links in the filesystem root one walk follows before it refuses. */
export const MAX_ROOT_LINK_HOPS = 8;

const NOTHING_WRITTEN = "Nothing was written.";

/** Where the walk starts and whether links that are direct entries of that directory are followed. */
export interface WalkStart {
  root: string;
  followLinksInRoot: boolean;
}

/**
 * The walk start for a real run: the filesystem root of the target. Links in
 * it are followed only when that root is the POSIX `/`, where creating an
 * entry needs administrator rights (macOS `/tmp`, `/var`, `/etc`). A Windows
 * drive or share root can be writable by anyone, so nothing is followed there.
 */
export function systemWalkStart(
  target: string,
  parse: (p: string) => { root: string } = path.parse,
): WalkStart {
  const root = parse(target).root;
  return { root, followLinksInRoot: root === "/" };
}

export interface PhysicalTarget {
  /** The target's location; no component of it was a symbolic link when it was checked. */
  physical: string;
  /** What exists at `physical`. */
  kind: "missing" | "directory" | "other";
  /** The directories that do not exist yet, outermost first; empty unless `kind` is `missing`. */
  missing: string[];
}

/** lstat that tells "nothing there" (`undefined`) apart from "cannot tell", which is refused. */
function lstatOrRefuse(p: string, requested: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return undefined;
    throw new UsageError(
      `Refusing to write to ${visible(requested)}: ${visible(p)} cannot be examined (${code ?? "unknown error"}), so it cannot be shown to be free of symbolic links. ${NOTHING_WRITTEN}`,
    );
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A path or a link text as it is safe to print: every control character (C0,
 * DEL, C1) becomes a visible `\xNN`. A tree chooses the names and the link
 * texts a refusal quotes, and a raw escape sequence or newline in one could
 * redraw the terminal line the refusal is printed on.
 */
function visible(text: string): string {
  return text.replace(
    CONTROL_CHARACTERS,
    (character) =>
      `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function pointsTo(link: string): string {
  try {
    return ` (it points to ${visible(fs.readlinkSync(link))})`;
  } catch {
    // Unreadable link text: the refusal still names the link.
    return "";
  }
}

function refuseLink(link: string, requested: string): never {
  throw new UsageError(
    `Refusing to write to ${visible(requested)}: ${visible(link)} is a symbolic link${pointsTo(link)}, and okf-kit init never creates, truncates or writes a file through one. ${NOTHING_WRITTEN} ` +
      "If the link is yours and you mean the directory it leads to, pass that directory's real path instead (for example the output of `realpath`); otherwise remove the link or replace it with a real directory.",
  );
}

function refuseRootLink(link: string, requested: string, root: string): never {
  throw new UsageError(
    `Refusing to write to ${visible(requested)}: ${visible(link)} is a symbolic link in ${root}${pointsTo(link)} that cannot be followed: it must lead to an existing directory, through at most ${MAX_ROOT_LINK_HOPS} such links. ${NOTHING_WRITTEN} ` +
      "Pass the real path of the directory instead (for example the output of `realpath`).",
  );
}

function leadsToDirectory(link: string): boolean {
  try {
    return fs.statSync(link).isDirectory();
  } catch {
    return false;
  }
}

function componentsBelow(root: string, p: string): string[] {
  const rel = path.relative(root, p);
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    throw new Error(`${p} is not below the walk root ${root}`);
  }
  return rel.split(path.sep);
}

/**
 * Walks the absolute path `target` from the filesystem root down, one
 * component at a time with `lstat`, and returns where it physically is.
 *
 * The rule has no trusted directory to guess. Every existing component must be
 * a real directory; the last one may be missing or, for the caller to refuse,
 * something else. A missing component ends the walk, because nothing below it
 * exists. A symbolic link is refused wherever it sits and whatever it points
 * to, with one exception: a link that is a direct entry of the POSIX root `/`
 * and leads to an existing directory is followed. Its text is resolved against
 * `/` and walked under this same rule, so the only links ever followed are
 * entries of `/`. A component that cannot be examined, or an existing
 * non-directory above the last component, is refused as well.
 *
 * `start` exists for tests, which cannot create entries in the real root.
 */
export function resolvePhysicalTarget(
  target: string,
  start: WalkStart = systemWalkStart(target),
): PhysicalTarget {
  const root = start.root;
  let pending = componentsBelow(root, target);
  let physical = root;
  let hops = 0;
  while (pending.length > 0) {
    const candidate = path.join(physical, pending[0]);
    const rest = pending.slice(1);
    const stat = lstatOrRefuse(candidate, target);
    if (stat === undefined) {
      const missing = [candidate];
      for (const part of rest) {
        missing.push(path.join(missing[missing.length - 1], part));
      }
      return {
        physical: missing[missing.length - 1],
        kind: "missing",
        missing,
      };
    }
    if (stat.isSymbolicLink()) {
      if (!start.followLinksInRoot || physical !== root) {
        refuseLink(candidate, target);
      }
      hops += 1;
      if (hops > MAX_ROOT_LINK_HOPS || !leadsToDirectory(candidate)) {
        refuseRootLink(candidate, target, root);
      }
      const destination = path.resolve(root, fs.readlinkSync(candidate));
      pending = [...componentsBelow(root, destination), ...rest];
      continue;
    }
    if (!stat.isDirectory()) {
      if (rest.length > 0) {
        throw new UsageError(
          `Refusing to write to ${visible(target)}: ${visible(candidate)} exists and is not a directory. ${NOTHING_WRITTEN}`,
        );
      }
      return { physical: candidate, kind: "other", missing: [] };
    }
    physical = candidate;
    pending = rest;
  }
  return { physical, kind: "directory", missing: [] };
}

/**
 * Refuses an existing scaffold target that is anything but a regular file
 * with a single name: a symbolic link (dangling ones included), a directory,
 * FIFO, socket or device, or a file with more than one hard link. Returns
 * normally when nothing exists there.
 */
export function assertScaffoldFileWritable(file: string): void {
  const stat = lstatOrRefuse(file, file);
  if (stat === undefined) return;
  const shown = visible(file);
  if (stat.isSymbolicLink()) {
    throw new UsageError(
      `Refusing to write ${shown}: it is a symbolic link${pointsTo(file)}, and okf-kit init never creates, truncates or writes a file through one. ${NOTHING_WRITTEN} ` +
        "Remove the link or replace it with a regular file, and run the command again.",
    );
  }
  if (stat.isFile()) {
    if (stat.nlink > 1) {
      throw new UsageError(
        `Refusing to write ${shown}: it is a regular file with ${stat.nlink} hard links, so writing it would also change the other names. ${NOTHING_WRITTEN} ` +
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
        : "a device or other special file";
  throw new UsageError(
    `Refusing to write ${shown}: it exists and is ${kind}, not a regular file. ${NOTHING_WRITTEN} ` +
      "Remove it and run the command again.",
  );
}

/**
 * Creates the directories the walk reported missing, outermost first, one
 * level per call and never `recursive`: a recursive call accepts a link to a
 * directory that appeared at a level after the walk and creates below it.
 * When a level cannot be created, the levels this call created are removed
 * again, innermost first, so a failed run leaves no directories behind.
 */
export function createDirectories(missing: readonly string[]): void {
  const created: string[] = [];
  for (const level of missing) {
    try {
      fs.mkdirSync(level);
    } catch (error) {
      for (const made of created.reverse()) {
        try {
          fs.rmdirSync(made);
        } catch {
          // No longer empty, or gone: left as it is.
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UsageError(
          `Refusing to continue: ${visible(level)} did not exist when the path was checked and exists now. No file was written, and the directories this run created were removed again.`,
        );
      }
      throw error;
    }
    created.push(level);
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
        `Refusing to write ${visible(file)}: it is a symbolic link, a non-regular file or already exists (${code}). ` +
          "Remove it and run the command again.",
      );
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new UsageError(
        `Refusing to write ${visible(file)}: it is not a regular file.`,
      );
    }
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}
