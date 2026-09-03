import fs from "node:fs";
import path from "node:path";

export interface InplaceSession {
  backupPath: string;
  targetPath: string;
  /**
   * Restores `targetPath` from the backup made at `beginInplace` time.
   * Synchronous and exception-safe (returns `false` instead of
   * throwing) so it can run from a signal handler as well as from the
   * normal async control flow. This is the single mutation-probed
   * function for the whole restore guarantee: a no-op here must fail
   * both the SIGTERM test and every post-run hash assertion.
   */
  restore(): boolean;
}

/** Test seam: lets a test inject an `open` that makes the backup name
 * appear on disk exactly in the window between choosing that name and
 * opening it, which is the race the `O_EXCL` create below exists to
 * close and which cannot be produced reliably from outside. Defaults to
 * the genuine `fs.openSync`. */
export interface InplaceDeps {
  open?: (filePath: string, flags: string) => number;
}

/**
 * Begins an `inplace` probe session: copies the target file to a backup
 * path under `logDir` before anything mutates it. The backup name
 * includes the original basename (for a human skimming the log dir) and
 * a counter to stay unique across repeated calls with the same target
 * inside one log dir (e.g. the stale-marker recovery path re-uses the
 * same log dir as the probe that recovers it). The name itself is
 * claimed atomically via an `O_EXCL` create (`wx`): a check-then-copy
 * (`existsSync` then `copyFileSync`) would leave a window for two
 * concurrent sessions in the same log dir to both observe a name as free
 * and both write to it, silently clobbering one session's backup with
 * the other's. The atomicity is the create's own, not a check before it:
 * an `EEXIST` here means somebody else won the name, whether they took
 * it an hour ago or between this line and the previous one.
 */
export function beginInplace(
  targetPath: string,
  logDir: string,
  deps: InplaceDeps = {},
): InplaceSession {
  const open = deps.open ?? fs.openSync;
  fs.mkdirSync(logDir, { recursive: true });
  const base = path.basename(targetPath);
  let backupPath = path.join(logDir, `backup-${base}`);
  let n = 0;
  let fd: number;
  for (;;) {
    try {
      fd = open(backupPath, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      n += 1;
      backupPath = path.join(logDir, `backup-${n}-${base}`);
    }
  }
  const data = fs.readFileSync(targetPath);
  fs.writeSync(fd, data);
  fs.closeSync(fd);
  return {
    backupPath,
    targetPath,
    restore(): boolean {
      try {
        fs.copyFileSync(backupPath, targetPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}
