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
 * Splits `command` on whitespace, except that a quote (`'` or `"`) opens
 * a run that does not end until its OWN matching quote, whitespace
 * inside included -- so `cd '/abs/my repo' && ...` yields the single
 * token `'/abs/my repo'`, not two. Still not a shell parse: no
 * variables, no `$(...)`, no escaped quotes, and an unterminated quote
 * simply runs to the end of the string. Good enough for the token shapes
 * `absolutePathTokens` below looks for.
 */
function splitCommandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of command) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Strips a leading quote and a trailing shell metacharacter run
 * (`;`, `&`, `|`, `)`, `,`, a closing quote) off one raw token or
 * candidate substring. */
function trimTokenEdges(raw: string): string {
  return raw.replace(/^['"]/, "").replace(/['";&|),]+$/, "");
}

/**
 * Pulls every token out of `command` that LOOKS like an absolute path
 * (starts with `/`), whether it follows a `cd`, stands alone as a
 * file/dir argument, sits inside a quoted run that itself contains
 * whitespace (`cd '/abs/my repo' && ...`), or follows the first `=` of
 * an option token (`--prefix=/abs/repo`, including a quoted value:
 * `--pre='/abs/repo'`). Deliberately not a shell parse: quote-aware
 * splitting plus an `=`-split and the edge trim above is enough to
 * catch the D-033 shape (`cd /abs/... && npx vitest run ...`) and the
 * quoted and `--key=` variants of it, without pulling in a shell
 * grammar for a single probe-safety check. A relative path that walks
 * out of a directory via `..` is not a token this function looks for at
 * all (documented as a known limit), and neither is a path indirected
 * through a shell variable, `$(...)`, or a wrapper script that itself
 * `cd`s (same limit: no shell parse, no variable expansion).
 */
export function absolutePathTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const raw of splitCommandTokens(command)) {
    const candidates = [trimTokenEdges(raw)];
    const eq = raw.indexOf("=");
    if (eq !== -1) candidates.push(trimTokenEdges(raw.slice(eq + 1)));
    for (const candidate of candidates) {
      if (candidate.startsWith("/") && candidate.length > 1) {
        tokens.push(candidate);
      }
    }
  }
  return tokens;
}

/**
 * The subset of `absolutePathTokens(command)` that resolves (via
 * `resolveDeepestExisting`, so a symlinked root or a symlinked ancestor
 * of the token is walked through, not compared by spelling) under
 * `root` -- the real, already-resolved repository root a `-i worktree`
 * run never mutates -- and that does NOT resolve under `scratchRoot`
 * when one is given. Used by `setup.ts` to refuse a test/`--pre`
 * command that would run against the real tree instead of the isolated
 * copy: a `-i worktree` run's isolation copy lives outside `root` by
 * construction UNLESS the run's own `--log-dir` was pointed inside the
 * repository, in which case the copy sits under `<root>/<log-dir
 * subpath>/wt-<uuid>/wt` -- still inside `root`, but it IS the
 * isolation copy, so it must not be flagged as an escape. `scratchRoot`
 * (the run's own resolved log dir, the same value `cleanupWorktree`
 * checks worktree removals against) is the caller's way of excluding
 * that one legitimate case; any other absolute path that DOES resolve
 * under `root` cannot be naming the isolation copy, whatever that
 * copy's own path turns out to be. `root` and `scratchRoot` must
 * already be absolute, resolved paths (the same contract
 * `isPathContained` has).
 */
export function escapingAbsolutePaths(
  command: string,
  root: string,
  scratchRoot?: string,
): string[] {
  const escaping: string[] = [];
  for (const token of absolutePathTokens(command)) {
    const resolved = resolveDeepestExisting(token);
    if (scratchRoot !== undefined && isPathContained(scratchRoot, resolved)) {
      continue;
    }
    if (isPathContained(root, resolved)) escaping.push(token);
  }
  return escaping;
}
