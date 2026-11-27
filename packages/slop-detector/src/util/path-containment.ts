import fs from "node:fs";
import path from "node:path";

/**
 * True when `target` is `root` itself or lies below it, compared on whole
 * path segments: `/x/repo2` is not inside `/x/repo`. Both arguments are
 * taken as given (no resolving, no realpath), so callers that care about
 * symbolic links pass real paths, see `resolvesInside`.
 */
export function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

/** `fs.realpathSync.native`, or undefined when the path cannot be resolved. */
export function realPath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/**
 * True when `target` exists and its real path (every symbolic link along
 * the way followed) lies inside the real path of `root`. Resolving both
 * sides makes `/tmp` and `/private/tmp`, a symlinked root, and the letter
 * case macOS reports agree. A path that cannot be resolved (missing,
 * dangling link, no permission) is never inside.
 */
export function resolvesInside(root: string, target: string): boolean {
  const realRoot = realPath(root);
  if (realRoot === undefined) return false;
  const realTarget = realPath(path.resolve(root, target));
  if (realTarget === undefined) return false;
  return isInside(realRoot, realTarget);
}
