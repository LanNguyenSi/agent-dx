import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Raised when a path the installer is about to read, write, or remove inside
 * a target repository is a symbolic link, or sits below one. A repository can
 * ship a link such as `AGENTS.md -> ~/.zshrc` (git preserves symlinks), and
 * every file operation would silently follow it to a file outside the
 * repository, or create one through a dangling link. The installer refuses
 * instead.
 */
export class SymlinkRefusedError extends Error {
  /** The symbolic link that was found, as a path inside the target. */
  readonly linkPath: string;
  /** The path the installer was working on when it met the link. */
  readonly requestedPath: string;

  constructor(linkPath: string, requestedPath: string, linkTarget?: string) {
    const pointsTo =
      linkTarget === undefined ? "" : ` (it points to ${linkTarget})`;
    const via =
      linkPath === requestedPath
        ? ""
        : ` while handling ${requestedPath}, which lies below it`;
    super(
      `Refusing to follow the symbolic link ${linkPath}${pointsTo}${via}. ` +
        "orchestrator-workflow never reads, writes, or removes through a symlink in the target repository, and nothing was changed. " +
        "Replace the link with a regular file or directory and run the command again.",
    );
    this.name = "SymlinkRefusedError";
    this.linkPath = linkPath;
    this.requestedPath = requestedPath;
  }
}

/** `O_NOFOLLOW` is absent on Windows; the lstat walk still applies there. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

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

/**
 * Every filesystem access the installer makes inside a target repository
 * goes through one of these. Each method first walks the path from the
 * target root down with `lstat` (never following a link) and throws
 * {@link SymlinkRefusedError} when any component, the leaf included and a
 * dangling link included, is a symbolic link. The target root itself, and any
 * link above it, is not examined: a user may run the installer on a symlinked
 * checkout, and `lstat` of a path below the root resolves such links on the
 * way, so only what lies below the root is checked.
 *
 * In `dryRun` mode the mutating methods perform the check and nothing else,
 * so a caller can validate every path of a run before the first write.
 */
export class TargetFs {
  readonly dryRun: boolean;
  private readonly root: string;

  constructor(targetDir: string, options: { dryRun?: boolean } = {}) {
    this.dryRun = options.dryRun ?? false;
    this.root = resolve(targetDir);
  }

  /** The same target in the other mode. */
  withDryRun(dryRun: boolean): TargetFs {
    return new TargetFs(this.root, { dryRun });
  }

  /**
   * Throws {@link SymlinkRefusedError} when `path` or any directory between
   * the target root and `path` is a symlink. Components that do not exist
   * yet end the walk: nothing below a missing component can be a link.
   */
  assertSafe(path: string): void {
    const absolute = resolve(path);
    const rel = relative(this.root, absolute);
    if (rel === "") return;
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `Refusing to touch ${absolute}: it is outside the target ${this.root}.`,
      );
    }
    let current = this.root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      let isLink: boolean;
      try {
        isLink = lstatSync(current).isSymbolicLink();
      } catch (error) {
        if (isUnreachable(error)) return;
        throw error;
      }
      if (isLink) {
        let linkTarget: string | undefined;
        try {
          linkTarget = readlinkSync(current);
        } catch {
          linkTarget = undefined;
        }
        throw new SymlinkRefusedError(current, absolute, linkTarget);
      }
    }
  }

  /** True when `path` exists (as a file or directory, never as a link). */
  exists(path: string): boolean {
    this.assertSafe(path);
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (isUnreachable(error)) return false;
      throw error;
    }
  }

  /** Kind of the entry at `path`, `undefined` when it does not exist. */
  kind(path: string): "file" | "directory" | "other" | undefined {
    this.assertSafe(path);
    try {
      const stat = lstatSync(path);
      if (stat.isFile()) return "file";
      return stat.isDirectory() ? "directory" : "other";
    } catch (error) {
      if (isUnreachable(error)) return undefined;
      throw error;
    }
  }

  readText(path: string): string {
    this.assertSafe(path);
    // The numeric flags make a link planted after the walk above fail with
    // ELOOP instead of being followed.
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    try {
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  /** Writes `content`, creating missing parent directories. */
  writeText(path: string, content: string): void {
    this.assertSafe(path);
    if (this.dryRun) return;
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
      0o666,
    );
    try {
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  removeFile(path: string): void {
    this.assertSafe(path);
    if (this.dryRun) return;
    unlinkSync(path);
  }

  removeDir(path: string): void {
    this.assertSafe(path);
    if (this.dryRun) return;
    rmdirSync(path);
  }
}
