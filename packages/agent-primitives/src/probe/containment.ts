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

/**
 * Pulls every token out of `command` that LOOKS like an absolute path
 * (starts with `/`, once a leading quote and a trailing shell
 * metacharacter -- `;`, `&`, `|`, `)`, `,`, a closing quote -- are
 * stripped), whether it follows a `cd` or stands alone as a file/dir
 * argument. Deliberately not a shell parse: whitespace-splitting plus
 * this trim is enough to catch the D-033 shape (`cd /abs/... && npx
 * vitest run ...`) and any absolute file argument beside it, without
 * pulling in a shell grammar for a single probe-safety check. A
 * relative path that walks out of a directory via `..` is not a token
 * this function looks for at all (documented as a known limit).
 */
export function absolutePathTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const raw of command.split(/\s+/)) {
    let token = raw.replace(/^['"]/, "").replace(/['";&|),]+$/, "");
    if (token.startsWith("/") && token.length > 1) tokens.push(token);
  }
  return tokens;
}

/**
 * The subset of `absolutePathTokens(command)` that resolves (via
 * `resolveDeepestExisting`, so a symlinked root or a symlinked ancestor
 * of the token is walked through, not compared by spelling) under
 * `root` -- the real, already-resolved repository root a `-i worktree`
 * run never mutates. Used by `setup.ts` to refuse a test command that
 * would run against the real tree instead of the isolated copy: every
 * `-i worktree` run's isolation copy lives outside `root` by
 * construction, so any absolute path a test command names that DOES
 * resolve under `root` cannot be naming the isolation copy, whatever
 * that copy's own path turns out to be. `root` must already be an
 * absolute, resolved path (the same contract `isPathContained` has).
 */
export function escapingAbsolutePaths(command: string, root: string): string[] {
  const escaping: string[] = [];
  for (const token of absolutePathTokens(command)) {
    const resolved = resolveDeepestExisting(token);
    if (isPathContained(root, resolved)) escaping.push(token);
  }
  return escaping;
}
