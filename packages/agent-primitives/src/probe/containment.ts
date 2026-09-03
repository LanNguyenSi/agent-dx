import fs from "node:fs";
import path from "node:path";

/**
 * Walks up from `startDir` looking for a `.git` entry (directory or
 * file, the latter for a linked worktree) and returns that directory;
 * `undefined` when none is found before the filesystem root. Mirrors
 * doctor's own `isInsideGitWorkTree` walk, but returns the root path
 * instead of a boolean, since containment needs the root itself.
 */
export function findGitRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (dir === root) return undefined;
    dir = path.dirname(dir);
  }
}

/** The containment root for a probe run from `cwd`: the git work-tree
 * root when `cwd` is inside one, else `cwd` itself. */
export function containmentRoot(cwd: string): string {
  return findGitRoot(cwd) ?? path.resolve(cwd);
}

/** True when `absTarget` resolves to `root` itself or a path underneath
 * it. Both inputs must already be absolute, resolved paths. */
export function isPathContained(root: string, absTarget: string): boolean {
  const rel = path.relative(root, absTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves `p` to its realpath. When `p` itself does not exist yet (a
 * missing `--file`, or a marker naming a target that has since been
 * deleted), resolves as much of the path as does exist (walking up to the
 * deepest existing ancestor) and re-appends the missing tail verbatim,
 * instead of returning `p` unresolved: a symlinked ancestor (macOS's
 * `/tmp` -> `/private/tmp`, or any symlinked checkout path) would
 * otherwise make `isPathContained` compare a resolved root against an
 * unresolved file path, so the same file reads as inside the root under
 * one spelling and outside it under another. Falls back to `p` itself
 * only when nothing above it resolves either (the filesystem root, or a
 * whole ancestor chain that does not exist).
 *
 * Both consumers of `isPathContained` must pass paths through this
 * function on both sides, or the comparison is spelling-dependent again:
 * `probe`'s containment and lock/marker key, and `doctor`'s stale-marker
 * check.
 */
export function resolveDeepestExisting(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p; // filesystem root
    return path.join(resolveDeepestExisting(parent), path.basename(p));
  }
}
