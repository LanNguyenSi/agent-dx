import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Stable, out-of-repo directory for probe locks and in-flight markers.
 * Never inside the working tree: a probe must be able to find its own
 * lock/marker regardless of what isolation mode mutated the tree, and a
 * lock file must never show up as an untracked file in `git status`.
 */
export function lockDir(): string {
  return (
    process.env.AGENT_PRIMITIVES_LOCK_DIR ??
    path.join(os.tmpdir(), "agent-primitives", "locks")
  );
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
  | { ok: false; reason: "probe_in_progress"; lockPath: string };

/**
 * Acquires the per-target lock via an `O_EXCL` create (`fs.openSync(...,
 * "wx")`): the create itself either succeeds (nobody else holds the lock)
 * or fails with `EEXIST` (somebody does), with no window in between for
 * a second process to also observe "no lock" and also create one. A lock
 * whose recorded pid is no longer alive is reclaimed (removed, then
 * retried) instead of blocking forever on a crashed probe.
 */
export function acquireLock(absTargetPath: string): AcquireLockResult {
  const dir = lockDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = lockFilePath(absTargetPath);
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
  fs.mkdirSync(lockDir(), { recursive: true });
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

/** Every marker currently on disk in `lockDir()` (or `dirOverride`),
 * skipping any file that fails to parse as a marker (never lets a
 * corrupt file crash a caller that just wants to list what is there). */
export function listMarkers(dirOverride?: string): MarkerData[] {
  const dir = dirOverride ?? lockDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const markers: MarkerData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".marker.json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, entry), "utf8");
      markers.push(JSON.parse(raw) as MarkerData);
    } catch {
      // Skip a corrupt or half-written marker file.
    }
  }
  return markers;
}
