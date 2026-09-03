import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/** The current uid, or `0` on a platform without `process.getuid` (only
 * Windows; this package's tests and target platforms are POSIX). */
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function defaultLockDir(): string {
  return path.join(os.tmpdir(), `agent-primitives-${currentUid()}`, "locks");
}

/**
 * Stable, out-of-repo directory for probe locks and in-flight markers.
 * Never inside the working tree: a probe must be able to find its own
 * lock/marker regardless of what isolation mode mutated the tree, and a
 * lock file must never show up as an untracked file in `git status`.
 * Uid-scoped by default (`agent-primitives-<uid>/locks` under the OS
 * temp dir) so a shared, world-writable `/tmp` cannot let another user
 * plant a lock or marker file that this process would then trust.
 */
export function lockDir(): string {
  return process.env.AGENT_PRIMITIVES_LOCK_DIR ?? defaultLockDir();
}

interface LockDirState {
  ok: boolean;
  detail?: string;
}

/** Test seam: lets a test inject a fake `statSync` to exercise a branch
 * (a created ancestor level owned by a different uid) that cannot be
 * reproduced for real without root. Defaults to the genuine `fs.statSync`. */
export interface LockDirDeps {
  stat?: (path: string) => fs.Stats;
}

/** Every directory `mkdirSync(dir, { recursive: true })` would have to
 * create on top of what already exists, from the outermost missing
 * level down to `dir` itself, in creation order. Returns just `[dir]`
 * when `dir` (or, for a nested override, its lowest missing ancestor)
 * already exists, so the leaf is still always checked. */
function levelsToCreate(dir: string): string[] {
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

/**
 * Creates `dir` (mode `0700`) if missing, then confirms every level
 * `mkdirSync(..., { recursive: true })` actually had to create (plus the
 * leaf itself) is a directory this process owns, with no group/other
 * write bit set. Checking only the leaf is not enough: this directory's
 * own parent (by default `<tmpdir>/agent-primitives-<uid>`) sits
 * directly under a shared, world-writable `/tmp`, so a level above the
 * leaf that is owned by another uid (or left group/other-writable) is
 * exactly as untrustworthy as the leaf itself would be -- its lock and
 * marker files would otherwise be read as if they were this process's
 * own.
 */
function ensureLockDir(dir: string, deps: LockDirDeps = {}): LockDirState {
  const stat = deps.stat ?? fs.statSync;
  const levels = levelsToCreate(dir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not create ${dir}: ${message}` };
  }
  for (const level of levels) {
    let levelStat: fs.Stats;
    try {
      levelStat = stat(level);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `could not stat ${level}: ${message}` };
    }
    if (!levelStat.isDirectory()) {
      return { ok: false, detail: `${level} exists and is not a directory` };
    }
    if (
      typeof process.getuid === "function" &&
      levelStat.uid !== process.getuid()
    ) {
      return { ok: false, detail: `${level} is not owned by the current user` };
    }
    if ((levelStat.mode & 0o022) !== 0) {
      return {
        ok: false,
        detail: `${level} is group- or world-writable (mode ${(levelStat.mode & 0o777).toString(8)})`,
      };
    }
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { ok: false, detail: `${dir} is not writable` };
  }
  return { ok: true };
}

/** Lock/marker files are named by the sha256 of the absolute target path,
 * so two probes on the same file always collide on the same name and two
 * probes on different files never do. */
export function lockKey(absTargetPath: string): string {
  return createHash("sha256").update(absTargetPath).digest("hex");
}

function lockFilePath(absTargetPath: string): string {
  return path.join(lockDir(), `${lockKey(absTargetPath)}.lock`);
}

function markerFilePath(absTargetPath: string): string {
  return path.join(lockDir(), `${lockKey(absTargetPath)}.marker.json`);
}

/** Public form of `markerFilePath`, for a caller that needs to name the
 * marker file itself (e.g. the manual-delete escape when its backup is
 * gone and automatic recovery is not possible). */
export function markerFilePathFor(absTargetPath: string): string {
  return markerFilePath(absTargetPath);
}

/**
 * True when `pid` names a live process this user can at least signal.
 * `ESRCH` (no such process) is the only case treated as dead; `EPERM`
 * (a process that exists but is owned by someone else) is treated as
 * alive, since we have no way to tell it apart from "still running" and
 * reclaiming a lock we cannot prove is dead would be unsafe.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

interface LockFileData {
  pid: number;
  timestamp: string;
}

function readLockFile(lockPath: string): LockFileData | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFileData>;
    if (typeof parsed.pid !== "number") return undefined;
    return { pid: parsed.pid, timestamp: String(parsed.timestamp ?? "") };
  } catch {
    return undefined;
  }
}

export type AcquireLockResult =
  | { ok: true; lockPath: string; reclaimed: boolean; release: () => void }
  | { ok: false; reason: "probe_in_progress"; lockPath: string }
  | { ok: false; reason: "lock_unavailable"; lockPath: string; detail: string };

/**
 * Acquires the per-target lock via an `O_EXCL` create (`fs.openSync(...,
 * "wx")`): the create itself either succeeds (nobody else holds the lock)
 * or fails with `EEXIST` (somebody does), with no window in between for
 * a second process to also observe "no lock" and also create one. A lock
 * whose recorded pid is no longer alive is reclaimed (removed, then
 * retried) instead of blocking forever on a crashed probe. When the lock
 * directory itself cannot be trusted (wrong owner, unwritable, or simply
 * fails to create), this returns `lock_unavailable` instead of letting a
 * raw `EACCES`/`EPERM` escape as an uncaught error.
 */
export function acquireLock(
  absTargetPath: string,
  deps: LockDirDeps = {},
): AcquireLockResult {
  const dir = lockDir();
  const lockPath = lockFilePath(absTargetPath);
  const dirState = ensureLockDir(dir, deps);
  if (!dirState.ok) {
    return {
      ok: false,
      reason: "lock_unavailable",
      lockPath,
      detail: dirState.detail ?? `${dir} is unusable`,
    };
  }
  let reclaimed = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readLockFile(lockPath);
      if (existing && !isPidAlive(existing.pid)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Another process may have reclaimed it first; the retry
          // below will surface whatever state wins the race.
        }
        reclaimed = true;
        continue;
      }
      return { ok: false, reason: "probe_in_progress", lockPath };
    }
    const data: LockFileData = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };
    fs.writeSync(fd, JSON.stringify(data));
    fs.closeSync(fd);
    let released = false;
    return {
      ok: true,
      lockPath,
      reclaimed,
      release: () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Best-effort: a missing lock file at release time is not a
          // failure worth surfacing.
        }
      },
    };
  }
  return { ok: false, reason: "probe_in_progress", lockPath };
}

export interface MarkerData {
  targetPath: string;
  backupPath: string;
  preHash: string;
  mutatedHash: string;
  pid: number;
  timestamp: string;
}

export function writeMarker(absTargetPath: string, data: MarkerData): void {
  fs.mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(markerFilePath(absTargetPath), JSON.stringify(data));
}

export function readMarkerFor(absTargetPath: string): MarkerData | undefined {
  try {
    const raw = fs.readFileSync(markerFilePath(absTargetPath), "utf8");
    return JSON.parse(raw) as MarkerData;
  } catch {
    return undefined;
  }
}

export function removeMarkerFor(absTargetPath: string): void {
  try {
    fs.rmSync(markerFilePath(absTargetPath), { force: true });
  } catch {
    // Best-effort.
  }
}

/** A marker as `listMarkers` returns it: the parsed data plus the
 * marker file's own path on disk, so a caller (e.g. `doctor`'s hint, or
 * the manual-delete escape) can name exactly the file to act on without
 * re-deriving it from `targetPath` (which may not be the same value the
 * marker was originally keyed by, e.g. across a symlink). */
export interface MarkerEntry extends MarkerData {
  markerPath: string;
}

/** Every marker currently on disk in `lockDir()` (or `dirOverride`),
 * skipping any file that fails to parse as a marker (never lets a
 * corrupt file crash a caller that just wants to list what is there). */
export function listMarkers(dirOverride?: string): MarkerEntry[] {
  const dir = dirOverride ?? lockDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const markers: MarkerEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".marker.json")) continue;
    try {
      const markerPath = path.join(dir, entry);
      const raw = fs.readFileSync(markerPath, "utf8");
      markers.push({ ...(JSON.parse(raw) as MarkerData), markerPath });
    } catch {
      // Skip a corrupt or half-written marker file.
    }
  }
  return markers;
}
