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
 *
 * It also means that no signal sent to the caller's process group reaches
 * the child: when the caller is killed (SIGKILL, SIGHUP, a harness timeout),
 * a child blocked on a fifo would run on with nobody left to enforce the
 * bound. So the child is started through `boundedCommand`, a `/bin/sh`
 * trampoline that runs a parent-death watcher inside the child's group: when
 * the calling process is gone, the watcher kills the group, within half a
 * second.
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

/**
 * The watcher half of the trampoline runs in a subshell with no stdin, stdout
 * or stderr (so it never holds the caller's pipes): it polls the caller's pid
 * every half second and, once the caller is gone, kills its own process group,
 * which is the child's group. The command itself runs in the foreground, so
 * its stdin, stdout, stderr, environment and exit status pass through
 * unchanged; the watcher is stopped when the command ends. A `sleep` that
 * cannot be run ends the watcher without killing anything.
 */
const TRAMPOLINE = [
  "p=$1; shift",
  "(trap 'kill $sp 2>/dev/null; exit 0' TERM;" +
    ' while kill -0 "$p" 2>/dev/null; do' +
    " /bin/sleep 0.5 & sp=$!; wait $sp || exit 0; done; kill -KILL 0)" +
    " </dev/null >/dev/null 2>&1 & w=$!",
  '"$@"; s=$?',
  'kill "$w" 2>/dev/null',
  "exit $s",
].join("\n");

/**
 * `command args` run through the parent-death trampoline (see above) on
 * platforms that have `/bin/sh`; unchanged on Windows, where the child has no
 * group of its own either.
 */
export function boundedCommand(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (process.platform === "win32") return { command, args: [...args] };
  return {
    command: "/bin/sh",
    args: ["-c", TRAMPOLINE, "sh", String(process.pid), command, ...args],
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
