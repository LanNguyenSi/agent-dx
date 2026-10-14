import type { StdioOptions } from "node:child_process";

/**
 * Helpers for a synchronous child that must not outlive a time bound.
 *
 * `spawnSync` honours `timeout`, but only for the direct child: whatever that
 * child started (git runs ssh, a credential helper, a hook, a filter driver)
 * keeps running, and keeps holding the child's pipes. So a bounded run puts
 * the child in a process group of its own (`detached`, which `spawnSync`
 * passes on to libuv though the typings list it for `spawn` only), ends the
 * direct child with SIGKILL at the bound, and then kills the whole group.
 * At the bound `spawnSync` closes its ends of the pipes and returns once the
 * direct child is gone, whether or not a descendant still holds them; before
 * it, `spawnSync` waits for the child and for every pipe to reach its end.
 *
 * The own group also means the child has no controlling terminal (libuv
 * starts a detached child in a new session), so a prompt that git or ssh
 * would put on the terminal fails instead of waiting for someone to answer.
 *
 * It also means that no signal sent to the caller's process group reaches
 * the child: when the caller is killed (SIGKILL, SIGHUP, a harness timeout),
 * a child blocked on a fifo would run on with nobody left to enforce the
 * bound. So the child is started through `boundedCommand`, a `/bin/sh`
 * trampoline that runs a parent-death watcher inside the child's group. The
 * watcher blocks reading one end of an extra pipe, fd 3, which
 * `boundedSpawnOptions` asks `spawnSync` for; the caller holds the other end
 * and never writes to it. The read returns only when the caller's end is
 * closed: when the caller exits or is killed (the kernel closes a process's
 * files as it dies, before anyone reaps it, so an unreaped caller counts as
 * gone too), or when `spawnSync` gives up on the child at the bound or the
 * output limit. The watcher then kills the group at once. Nothing polls, and
 * no other program is run for it.
 */

/** The spawn options that bound a run to `timeoutMs`, for a command started
 * through `boundedCommand`. */
export function boundedSpawnOptions(timeoutMs: number): {
  timeout: number;
  killSignal: "SIGKILL";
  detached: boolean;
  stdio: StdioOptions;
} {
  return {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    detached: process.platform !== "win32",
    // fd 3 is the watcher's pipe (see `TRAMPOLINE`), so this and
    // `boundedCommand` go together. `spawnSync` keeps reading its end until
    // every copy of the other end is closed, which is why the command does
    // not get one and the watcher is stopped when the command ends.
    stdio:
      process.platform === "win32" ? "pipe" : ["pipe", "pipe", "pipe", "pipe"],
  };
}

/**
 * The trampoline, run as `sh -c TRAMPOLINE sh <command> <args...>`.
 *
 * - The shell options a `/bin/sh` that is bash takes from an exported
 *   `SHELLOPTS` are switched off first: `errexit` would end the trampoline
 *   at a failing command with the watcher still running (the call would
 *   then wait for its bound), `monitor` would start the command in a
 *   process group of its own, out of reach of the watcher and of the kill
 *   at the bound, and `xtrace`, `verbose` and `allexport` would add to the
 *   command's stderr or environment. The command still gets the
 *   variable. (`noexec` there runs nothing at all; no line of the
 *   trampoline can switch it off. `verbose` prints each line before it
 *   runs, so with it the first line itself still reaches the command's
 *   stderr; stdout and the exit status are not affected.)
 * - `unset -f command`: a `/bin/sh` that is bash also imports the functions
 *   exported in its environment (`BASH_FUNC_git%%`), and every name below is
 *   run through `command`, which skips them; `unset` itself cannot be
 *   replaced by one.
 * - The watcher is a background subshell with no stdin, stdout or stderr (so
 *   it never holds the caller's pipes) that reads fd 3. When the read
 *   returns, the caller's end is gone, and the watcher kills the process
 *   group whose id is the trampoline's pid (`$$`), which is the command's
 *   group: `detached` makes the trampoline the leader of a new one. Started
 *   without `detached`, the trampoline leads no group, and the kill finds
 *   nothing instead of ending the caller's own group.
 * - The trampoline then closes its own fd 3 with `exec`, so the command
 *   inherits no copy of the pipe and nothing it starts can hold it. (A
 *   redirection on the command line itself would not do: `command` is a
 *   builtin, and bash keeps a copy of a redirected descriptor of a builtin
 *   that the command it starts inherits.)
 * - The command runs in the foreground, so its stdin, stdout, stderr,
 *   environment and exit status pass through.
 * - When the command ends, the watcher is stopped and reaped (a watcher left
 *   for the first process of the system to reap stays a zombie where that
 *   process reaps nothing, one per call), and the trampoline exits with the
 *   command's status (128 plus the signal number for a command that a
 *   signal ended).
 */
const TRAMPOLINE = [
  "{ set +aemvx; } 2>/dev/null",
  "unset -f command",
  "(command read -r x <&3; command kill -s KILL -- -$$) </dev/null >/dev/null 2>&1 & w=$!",
  "exec 3<&-",
  'command "$@"; s=$?',
  'command kill "$w" 2>/dev/null',
  'command wait "$w" 2>/dev/null',
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
    args: ["-c", TRAMPOLINE, "sh", command, ...args],
  };
}

/** True when `error` is `spawnSync`'s report that the time bound passed. */
export function isTimeoutError(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

/** What `endGroupIfAbnormal` reads of a `spawnSync` result. */
export interface BoundedRunEnd {
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/**
 * Ends every process left in the group of the bounded child when the run did
 * not end normally: it ended in an error (the bound, the output limit), in a
 * signal, or with a status above 128, which is how the trampoline's shell
 * reports a command that a signal ended (a git that exits 129 by itself, its
 * usage error, reads the same and only finds nothing left to end). A child
 * that exited by itself is not followed up, since whatever it left behind on
 * purpose is not ours to end.
 */
export function endGroupIfAbnormal(result: BoundedRunEnd): void {
  if (
    result.error !== undefined ||
    result.signal !== null ||
    (result.status !== null && result.status > 128)
  ) {
    endProcessGroup(result.pid);
  }
}

/**
 * Ends every process left in the group of the bounded child `pid`. A pid of
 * 0 or none (the child never started) must not reach `kill`: `-0` is this
 * process's own group. The group id is the child's pid; once the child and
 * all its descendants are gone the id could in principle belong to a new
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
