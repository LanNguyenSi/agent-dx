/**
 * Helpers for a synchronous child that must not outlive a time bound.
 *
 * `spawnSync` honours `timeout`, but only for the direct child: whatever that
 * child started (git runs ssh, a credential helper, a hook, a filter driver)
 * keeps running, and keeps holding the child's pipes. So a bounded run puts
 * the child in a process group of its own (`detached`, which `spawnSync`
 * passes on to libuv though the typings list it for `spawn` only), ends the
 * direct child with SIGKILL at the bound, and then kills the whole group.
 * `spawnSync` returns once the direct child is gone, whether or not a
 * descendant still holds the pipes.
 *
 * The own group also means the child has no controlling terminal (libuv
 * starts a detached child in a new session), so a prompt that git or ssh
 * would put on the terminal fails instead of waiting for someone to answer.
 */

/** The spawn options that bound a run to `timeoutMs`. */
export function boundedSpawnOptions(timeoutMs: number): {
  timeout: number;
  killSignal: "SIGKILL";
  detached: boolean;
} {
  return {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    detached: process.platform !== "win32",
  };
}

/** True when `error` is `spawnSync`'s report that the time bound passed. */
export function isTimeoutError(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

/**
 * Ends every process left in the group of the bounded child `pid`. Called
 * when the run ended in an error or a signal (the bound, the output limit);
 * a child that exited by itself is not followed up, since whatever it left
 * behind on purpose, a daemon that detached itself, is not ours to end. A
 * pid of 0 or none (the child never started) must not reach `kill`: `-0` is
 * this process's own group. The group id is the child's pid; once the child
 * and all its descendants are gone the id could in principle belong to a new
 * group, but only a process that makes itself a group leader can own it, and
 * the window is the time between `spawnSync` returning and this call.
 *
 * Not available on Windows, where the child gets no group and only the direct
 * child is stopped at the bound.
 */
export function endProcessGroup(pid: number | undefined): void {
  if (process.platform === "win32" || pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}
