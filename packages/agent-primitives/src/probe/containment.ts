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
