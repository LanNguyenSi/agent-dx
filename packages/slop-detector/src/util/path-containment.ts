import fs from "node:fs";
import path from "node:path";

/**
 * True when `target` is `root` itself or lies below it, compared on whole
 * path segments: `/x/repo2` is not inside `/x/repo`. Both arguments are
 * normalised with `path.resolve` first (a relative one against the process
 * working directory), so `..` segments and a trailing separator cannot
 * change the answer; no symbolic link is followed, so callers that care
 * about links pass real paths, see `resolvesInside`.
 */
export function isInside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(prefix);
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
