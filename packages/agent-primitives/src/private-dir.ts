import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mode of every directory this tool creates for logs, backups and
 * scratch: readable and traversable by the invoking user only. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode of every file this tool creates in those directories. It applies
 * when a file is created; an existing file that is appended to keeps the
 * mode it already has. */
export const PRIVATE_FILE_MODE = 0o600;

/** Test seams: a fake `statSync` (a level owned by another uid cannot be
 * produced for real without root) and a fake temp directory. */
export interface PrivateDirDeps {
  stat?: (path: string) => fs.Stats;
  tmpdir?: () => string;
}

/** Thrown when an existing directory on the default log location is not
 * one this process can trust. The message names `-l` as the way out. */
export class PrivateDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateDirError";
  }
}

/** Every directory `mkdirSync(dir, { recursive: true })` would have to
 * create on top of what already exists, from the outermost missing level
 * down to `dir` itself, in creation order. Returns just `[dir]` when
 * `dir` (or, for a nested path, its lowest missing ancestor) already
 * exists, so the leaf is still always checked. */
export function levelsToCreate(dir: string): string[] {
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    if (fs.existsSync(cur)) break;
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
  missing.reverse();
  return missing.length > 0 ? missing : [dir];
}

/** Why `level` is not a directory this process can trust (a directory,
 * owned by the current uid, without group or other write), or
 * `undefined` when it is one. */
export function untrustedLevelDetail(
  level: string,
  stat: (path: string) => fs.Stats = fs.statSync,
): string | undefined {
  let levelStat: fs.Stats;
  try {
    levelStat = stat(level);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `could not stat ${level}: ${message}`;
  }
  if (!levelStat.isDirectory()) {
    return `${level} exists and is not a directory`;
  }
  if (
    typeof process.getuid === "function" &&
    levelStat.uid !== process.getuid()
  ) {
    return `${level} is not owned by the current user`;
  }
  if ((levelStat.mode & 0o022) !== 0) {
    return `${level} is group- or world-writable (mode ${(levelStat.mode & 0o777).toString(8)})`;
  }
  return undefined;
}

/** `<os tmpdir>/agent-primitives`: the shared parent of every default log
 * directory (`<parent>/<run id>`). */
export function defaultLogParent(deps: PrivateDirDeps = {}): string {
  return path.join((deps.tmpdir ?? os.tmpdir)(), "agent-primitives");
}

function isUnder(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root + path.sep);
}

/**
 * Creates `dir` and every missing level above it with mode `0700`, and
 * returns `dir`.
 *
 * On the default location (`dir` is `<tmpdir>/agent-primitives` or below
 * it) the parent sits under a tmpdir that other users can write to, so
 * every level from `<tmpdir>/agent-primitives` down to `dir`, existing or
 * freshly created, must be a directory owned by the current uid without
 * group or other write; anything else throws a `PrivateDirError` that
 * names `-l`. An existing directory is never chmod-ed.
 *
 * A directory outside that location was named by the caller (`-l`,
 * `AGENT_PRIMITIVES_LOG_DIR`): when it already exists it is used as given,
 * with no check and no chmod. Only the levels created here are checked
 * (they are this process's own) and carry mode `0700`.
 */
export function ensurePrivateDir(
  dir: string,
  deps: PrivateDirDeps = {},
): string {
  const stat = deps.stat ?? fs.statSync;
  const abs = path.resolve(dir);
  const parent = defaultLogParent(deps);
  const isDefault = isUnder(abs, parent);
  const refuse = (detail: string): never => {
    throw new PrivateDirError(
      `refusing to write logs under ${abs}: ${detail}; pass -l <dir> (or set AGENT_PRIMITIVES_LOG_DIR) to use a directory of your own`,
    );
  };
  const checkAll = (levels: Iterable<string>): void => {
    for (const level of levels) {
      const detail = untrustedLevelDetail(level, stat);
      if (detail !== undefined) refuse(detail);
    }
  };
  // On the default location, what exists is checked BEFORE anything is
  // created inside it: nothing may be made under a directory that
  // another user can write to.
  const existing: string[] = [];
  if (isDefault) {
    for (let cur = abs; isUnder(cur, parent); cur = path.dirname(cur)) {
      if (fs.existsSync(cur)) existing.push(cur);
    }
    checkAll(existing);
  }
  const created = levelsToCreate(abs).filter((level) => !fs.existsSync(level));
  fs.mkdirSync(abs, { recursive: true, mode: PRIVATE_DIR_MODE });
  checkAll(created);
  return abs;
}
