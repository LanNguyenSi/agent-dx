import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  acquireLock,
  isPidAlive,
  listMarkers,
  lockKey,
  readMarkerFor,
  removeMarkerFor,
  writeMarker,
  type MarkerData,
} from "../src/lock.js";
import type { Stats } from "node:fs";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-lock-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

/** Spawns a trivial process and waits for it to exit, returning a pid
 * that is guaranteed dead by the time this function returns. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = result.pid;
  if (!pid)
    throw new Error("failed to spawn a throwaway process for a dead pid");
  return pid;
}

let savedLockDir: string | undefined;
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

describe("isPidAlive", () => {
  it("is true for this process's own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false for a pid known to have already exited", () => {
    expect(isPidAlive(deadPid())).toBe(false);
  });

  it("is false for a non-positive or non-integer pid", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe("acquireLock", () => {
  it("acquires the lock, writes pid/timestamp, and release() removes the file", () => {
    const lockDir = useLockDir();
    const target = path.join(makeTmpDir(), "target.js");
    const result = acquireLock(target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reclaimed).toBe(false);
    expect(fs.existsSync(result.lockPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(result.lockPath, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(typeof data.timestamp).toBe("string");
    expect(path.dirname(result.lockPath)).toBe(lockDir);

    result.release();
    expect(fs.existsSync(result.lockPath)).toBe(false);
  });

  it("names the lock file by the sha256 of the absolute target path", () => {
    useLockDir();
    const target = path.join(makeTmpDir(), "target.js");
    const result = acquireLock(target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.basename(result.lockPath)).toBe(`${lockKey(target)}.lock`);
    result.release();
  });

  it("returns probe_in_progress when a live process already holds the lock", () => {
    useLockDir();
    const target = path.join(makeTmpDir(), "target.js");
    const first = acquireLock(target);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = acquireLock(target);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("probe_in_progress");

    first.release();
    const third = acquireLock(target);
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  it("release() is idempotent (a second call does not throw)", () => {
    useLockDir();
    const target = path.join(makeTmpDir(), "target.js");
    const result = acquireLock(target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.release();
    expect(() => result.release()).not.toThrow();
  });

  it("reclaims a lock left behind by a pid that is no longer alive", () => {
    const lockDir = useLockDir();
    const target = path.join(makeTmpDir(), "target.js");
    const staleLockPath = path.join(lockDir, `${lockKey(target)}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      staleLockPath,
      JSON.stringify({ pid: deadPid(), timestamp: new Date().toISOString() }),
    );

    const result = acquireLock(target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reclaimed).toBe(true);
    const data = JSON.parse(fs.readFileSync(result.lockPath, "utf8"));
    expect(data.pid).toBe(process.pid);
    result.release();
  });

  it("creates a freshly-needed lock dir with mode 0700", () => {
    savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
    const fresh = path.join(makeTmpDir(), "not-yet-created", "locks");
    process.env.AGENT_PRIMITIVES_LOCK_DIR = fresh;
    const target = path.join(makeTmpDir(), "target.js");

    const result = acquireLock(target);
    expect(result.ok).toBe(true);
    if (result.ok) result.release();

    const stat = fs.statSync(fresh);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("returns lock_unavailable (never throws) when a created ancestor level is owned by a different uid, via the injectable stat seam", () => {
    savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
    const parent = makeTmpDir();
    // Two levels under `parent` that acquireLock's mkdirSync(...,
    // {recursive:true}) has to create: neither exists yet.
    const foreignLevel = path.join(parent, "agent-primitives-test-uid");
    const fresh = path.join(foreignLevel, "locks");
    process.env.AGENT_PRIMITIVES_LOCK_DIR = fresh;
    const target = path.join(makeTmpDir(), "target.js");

    const result = acquireLock(target, {
      stat: (p: string) => {
        if (p === foreignLevel) {
          return {
            isDirectory: () => true,
            uid: (process.getuid?.() ?? 0) + 999_999,
            mode: 0o40700,
          } as Stats;
        }
        return fs.statSync(p);
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("lock_unavailable");
    if (result.reason === "lock_unavailable") {
      expect(result.detail).toContain(foreignLevel);
      expect(result.detail).toContain("not owned by the current user");
    }
  });

  // Permission bits are meaningless to root (bypasses them entirely), so
  // this only discriminates as a non-root user.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)(
    "returns lock_unavailable, never a raw error, when the lock dir exists but is not writable",
    () => {
      const parent = makeTmpDir();
      const unwritable = path.join(parent, "locks");
      fs.mkdirSync(unwritable, { mode: 0o500 });
      savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
      process.env.AGENT_PRIMITIVES_LOCK_DIR = unwritable;
      const target = path.join(makeTmpDir(), "target.js");

      let result: ReturnType<typeof acquireLock> | undefined;
      try {
        result = acquireLock(target);
      } finally {
        // Restore write access so afterEach's rmSync can clean it up.
        fs.chmodSync(unwritable, 0o700);
      }
      expect(result?.ok).toBe(false);
      if (!result || result.ok) return;
      expect(result.reason).toBe("lock_unavailable");
      if (result.reason === "lock_unavailable") {
        expect(result.detail.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("marker read/write/remove", () => {
  function sampleMarker(targetPath: string): MarkerData {
    return {
      targetPath,
      backupPath: `${targetPath}.backup`,
      preHash: "a".repeat(64),
      mutatedHash: "b".repeat(64),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };
  }

  it("round-trips a marker through writeMarker/readMarkerFor", () => {
    useLockDir();
    const target = path.join(makeTmpDir(), "target.js");
    const marker = sampleMarker(target);
    expect(readMarkerFor(target)).toBeUndefined();
    writeMarker(target, marker);
    expect(readMarkerFor(target)).toEqual(marker);
  });

  it("removeMarkerFor deletes the marker; a missing marker is a no-op", () => {
    useLockDir();
    const target = path.join(makeTmpDir(), "target.js");
    writeMarker(target, sampleMarker(target));
    expect(readMarkerFor(target)).toBeDefined();
    removeMarkerFor(target);
    expect(readMarkerFor(target)).toBeUndefined();
    expect(() => removeMarkerFor(target)).not.toThrow();
  });

  it("listMarkers returns every marker in the lock dir, skipping non-marker files", () => {
    const lockDir = useLockDir();
    const t1 = path.join(makeTmpDir(), "a.js");
    const t2 = path.join(makeTmpDir(), "b.js");
    writeMarker(t1, sampleMarker(t1));
    writeMarker(t2, sampleMarker(t2));
    fs.writeFileSync(path.join(lockDir, "not-a-marker.txt"), "hello");
    const markers = listMarkers(lockDir);
    expect(markers.map((m) => m.targetPath).sort()).toEqual([t1, t2].sort());
  });

  it("listMarkers on a missing directory returns an empty array instead of throwing", () => {
    const missing = path.join(makeTmpDir(), "does-not-exist");
    expect(listMarkers(missing)).toEqual([]);
  });
});
