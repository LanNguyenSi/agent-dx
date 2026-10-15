import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedCommand } from "../bounded-spawn.js";
import { isZombie, procKey, readProcesses, type ProcInfo } from "./ps.js";

/**
 * `guard`: run one command under a wall-clock timeout and a resident-memory
 * cap, in a process group of its own, and leave nothing of it running.
 *
 * How it works, and what it does not do:
 *
 * - The command is started through the same parent-death trampoline the
 *   other bounded runs use (`bounded-spawn.ts`), in its own process group
 *   (the group id is the trampoline's pid). If this process is killed, the
 *   kernel closes the pipe the trampoline's watcher waits on and the
 *   watcher kills the group.
 * - Memory is measured from outside, by polling `ps -A` every `pollMs`
 *   (default 200 ms), because `ulimit -v` does not bind children on macOS.
 *   The cap applies to the SUM of the resident set sizes of the group and of
 *   every process this module found below it (see the next point), not to
 *   the largest single process: a fuzz loop or test runner that forks N
 *   workers each under the cap can still exhaust the host. Shared pages are
 *   counted once per process, so the sum over-counts a forking command; the
 *   cap is a conservative backstop, not an exact accounting. A process that
 *   allocates faster than one poll interval can overshoot the cap before
 *   the next sample sees it.
 * - A descendant that calls `setsid` (or is started `detached`) leaves the
 *   group. Each poll therefore also follows the parent chain from the group
 *   (and from every process seen earlier), so such a process is found,
 *   counted against the cap, and killed by pid, as long as a poll saw it
 *   while its parent chain was still intact. One that started and was cut
 *   loose within a single poll interval is not found; that gap is
 *   documented, not closed.
 * - At a limit the whole group, and every escaped process found, is ended
 *   with SIGKILL at once: no SIGTERM grace, because a runaway allocation
 *   cannot be waited out.
 * - When the command ends on its own, whatever is still alive in the group
 *   or below it is a leftover: it is listed, killed, and reported with its
 *   own exit code. A zombie is dead and not counted.
 * - `ps` can fail exactly when it matters (a fork bomb leaves no pid to start
 *   it with). A failed read is retried a few times with a short backoff; when
 *   the table still cannot be read after the command ended, the group is
 *   killed without it (`kill(-pgid)` needs no table), what was alive cannot
 *   be listed, and the run is an error (`leftover_check_failed`), never a
 *   pass.
 */

/** Distinct exit codes of `guard`, chosen away from the codes common
 * commands use. 124 is coreutils `timeout`'s code for the same event. */
export const GUARD_EXIT_TIMEOUT = 124;
export const GUARD_EXIT_RSS_CAP = 123;
export const GUARD_EXIT_LEFTOVER = 122;
/** `leftover_check_failed` ends with 2, the "could not conclude" code of the
 * CLI: 122 would claim leftovers exist, and the point is that it is unknown. */
export const GUARD_EXIT_LEFTOVER_CHECK_FAILED = 2;
/** Exit code of a `guard` that was itself told to stop (SIGINT). */
export const GUARD_EXIT_ABORTED = 130;

export type GuardReason =
  | "none"
  | "child_exit"
  | "timeout"
  | "rss_cap"
  | "leftover"
  | "leftover_check_failed"
  | "aborted"
  | "ps_unavailable"
  | "spawn_failed"
  | "unsupported_platform";

export interface GuardOptions {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  maxRssMiB: number;
  /** How often the process table is sampled, in milliseconds. */
  pollMs: number;
  cwd: string;
  /** Directory the command's combined stdout and stderr log goes into. */
  logDir: string;
  runId: string;
  /** Aborting kills the group at once, like a limit does. */
  signal?: AbortSignal;
}

/** One process `guard` reports. */
export interface GuardProc {
  pid: number;
  pgid: number;
  rssMiB: number;
  /** False for a process that left the group (`setsid`, `detached`) and was
   * found by following the parent chain. */
  inGroup: boolean;
  command: string;
}

export interface GuardResult {
  status: "pass" | "fail" | "error";
  reason: GuardReason;
  /** The exit code `guard` itself should end with. */
  exitCode: number;
  /** The wrapped command's own code (128 + signal number for a signal), or
   * null when it never ran. */
  childExitCode: number | null;
  durationMs: number;
  limits: { timeoutMs: number; maxRssMiB: number; pollMs: number };
  /** Highest summed resident size of the tree seen at a poll, MiB. */
  peakRssMiB: number;
  /** Highest resident size of any single process seen at a poll, MiB. */
  peakProcessRssMiB: number;
  polls: number;
  /** Polls where `ps` failed; the cap was not checked for those. */
  failedPolls: number;
  /** The tree that was alive when a limit fired (first entries only). */
  killed: GuardProc[];
  killedCount: number;
  /** What was still alive after the command ended on its own. */
  leftovers: GuardProc[];
  leftoverCount: number;
  /** Alive even after the kill sweeps (first entries only). */
  survivors: GuardProc[];
  survivorCount: number;
  /** True when the process table could not be read after the command ended
   * (or during the kill sweeps), so what was alive could not be checked. The
   * group was killed anyway; the lists above may be incomplete. */
  leftoverCheckFailed: boolean;
  logPath: string;
  outputTail: string;
  warnings: string[];
}

const LIST_LIMIT = 20;
const COMMAND_CHARS = 160;
const TAIL_BYTES = 4000;
const TAIL_LINES = 40;
const SWEEP_ROUNDS = 10;
const SWEEP_WAIT_MS = 50;
/** A failed read of the process table is tried this many times in all, with
 * a doubling pause (50, 100, 200 ms) between tries. */
const TABLE_ATTEMPTS = 4;
const TABLE_BACKOFF_MS = 50;

const SIGNAL_NUMBERS = os.constants.signals as Record<string, number>;

/** The guard exit code for an outcome. A command that ends on its own and
 * leaves nothing behind passes its own exit code through. */
export function guardExitCode(
  reason: GuardReason,
  childExitCode: number | null,
): number {
  switch (reason) {
    case "timeout":
      return GUARD_EXIT_TIMEOUT;
    case "rss_cap":
      return GUARD_EXIT_RSS_CAP;
    case "leftover":
      return GUARD_EXIT_LEFTOVER;
    case "leftover_check_failed":
      return GUARD_EXIT_LEFTOVER_CHECK_FAILED;
    case "aborted":
      return GUARD_EXIT_ABORTED;
    case "none":
    case "child_exit":
      return childExitCode ?? 1;
    default:
      return 2;
  }
}

/**
 * Every live process of the tree under `leaderPid`: the members of its
 * process group, every process whose identity is in `tracked` (seen earlier,
 * possibly cut loose from its parent since), and everything below those by
 * parent pid. Zombies are left out. Pure: takes the table it is given.
 */
export function collectTree(
  table: readonly ProcInfo[],
  leaderPid: number,
  tracked: ReadonlySet<string>,
): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const proc of table) {
    const list = children.get(proc.ppid);
    if (list === undefined) children.set(proc.ppid, [proc]);
    else list.push(proc);
  }
  const queue: ProcInfo[] = [];
  for (const proc of table) {
    if (proc.pgid === leaderPid || tracked.has(procKey(proc))) {
      queue.push(proc);
    }
  }
  const seen = new Map<string, ProcInfo>();
  while (queue.length > 0) {
    const proc = queue.pop() as ProcInfo;
    const key = procKey(proc);
    if (seen.has(key)) continue;
    seen.set(key, proc);
    for (const child of children.get(proc.pid) ?? []) queue.push(child);
  }
  return [...seen.values()].filter((proc) => !isZombie(proc));
}

function sumRssMiB(tree: readonly ProcInfo[]): number {
  let kib = 0;
  for (const proc of tree) kib += proc.rssKiB;
  return kib / 1024;
}

const TRAMPOLINE_COMMAND_PREFIX = "/bin/sh -c { set +aemvx; }";

/** The trampoline (the leader of the group) and its parent-death watcher (a
 * subshell of it, same command line, same group) are part of every run; they
 * are not something the caller started, so the reports leave them out. They
 * are still counted in the memory sum. They are identified by where they sit,
 * not by the command line alone: any other process that merely shows the same
 * text (`exec -a`, a nested bounded run) is the caller's and is reported. */
function isTrampoline(proc: ProcInfo, leaderPid: number): boolean {
  if (!proc.command.startsWith(TRAMPOLINE_COMMAND_PREFIX)) return false;
  return (
    proc.pid === leaderPid ||
    (proc.ppid === leaderPid && proc.pgid === leaderPid)
  );
}

function toGuardProc(proc: ProcInfo, leaderPid: number): GuardProc {
  return {
    pid: proc.pid,
    pgid: proc.pgid,
    rssMiB: Math.round((proc.rssKiB / 1024) * 10) / 10,
    inGroup: proc.pgid === leaderPid,
    command:
      proc.command.length > COMMAND_CHARS
        ? `${proc.command.slice(0, COMMAND_CHARS)}...`
        : proc.command,
  };
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Ends the whole group. Needs no process table. */
function killGroup(leaderPid: number): void {
  try {
    process.kill(-leaderPid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

function killTree(leaderPid: number, tree: readonly ProcInfo[]): void {
  killGroup(leaderPid);
  for (const proc of tree) {
    if (proc.pgid !== leaderPid) killPid(proc.pid);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Blocks the thread for `ms`; `fire` must finish its kills before it returns
 * (the CLI ends the process right after an abort), so it cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The process table, read again (after a short pause) when a read fails. */
async function readProcessesRetrying(
  attempts: number = TABLE_ATTEMPTS,
): Promise<ProcInfo[] | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(TABLE_BACKOFF_MS * 2 ** (attempt - 1));
    const table = readProcesses();
    if (table !== undefined) return table;
  }
  return undefined;
}

/** `readProcessesRetrying` for code that cannot await. `tried` is the number
 * of reads already made by the caller. */
function readProcessesRetryingSync(tried: number): ProcInfo[] | undefined {
  for (let attempt = tried; attempt < TABLE_ATTEMPTS; attempt++) {
    sleepSync(TABLE_BACKOFF_MS * 2 ** (attempt - 1));
    const table = readProcesses();
    if (table !== undefined) return table;
  }
  return undefined;
}

function readTail(logPath: string): string {
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return lines.slice(-TAIL_LINES).join("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function emptyResult(
  options: GuardOptions,
  logPath: string,
  reason: GuardReason,
  warning: string,
  started: number,
): GuardResult {
  return {
    status: "error",
    reason,
    exitCode: 2,
    childExitCode: null,
    durationMs: Date.now() - started,
    limits: {
      timeoutMs: options.timeoutMs,
      maxRssMiB: options.maxRssMiB,
      pollMs: options.pollMs,
    },
    peakRssMiB: 0,
    peakProcessRssMiB: 0,
    polls: 0,
    failedPolls: 0,
    killed: [],
    killedCount: 0,
    leftovers: [],
    leftoverCount: 0,
    survivors: [],
    survivorCount: 0,
    leftoverCheckFailed: false,
    logPath,
    outputTail: "",
    warnings: [warning],
  };
}

type Outcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; message: string };

/** Runs the command under the limits; see the module comment. */
export async function guard(options: GuardOptions): Promise<GuardResult> {
  const started = Date.now();
  const logPath = path.join(options.logDir, `guard-${options.runId}.log`);
  if (process.platform === "win32") {
    return emptyResult(
      options,
      logPath,
      "unsupported_platform",
      "guard needs process groups and ps; it does not run on Windows",
      started,
    );
  }
  if (readProcesses() === undefined) {
    return emptyResult(
      options,
      logPath,
      "ps_unavailable",
      "guard measures memory with `ps -A -o pid=,ppid=,pgid=,rss=,stat=,lstart=,command=`, which did not answer; nothing was run",
      started,
    );
  }

  fs.mkdirSync(options.logDir, { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const wrapped = boundedCommand(options.command, options.args);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: options.cwd,
    detached: true,
    // fd 3 is the trampoline's parent-death pipe; the command's output goes
    // to the log file, so no pipe of ours can be held open by a leftover.
    stdio: ["ignore", logFd, logFd, "pipe"],
  });
  fs.closeSync(logFd);

  const warnings: string[] = [];
  const tracked = new Set<string>();
  const limits = {
    timeoutMs: options.timeoutMs,
    maxRssMiB: options.maxRssMiB,
    pollMs: options.pollMs,
  };
  let peakRssMiB = 0;
  let peakProcessRssMiB = 0;
  let polls = 0;
  let failedPolls = 0;
  let limitReason: "timeout" | "rss_cap" | "aborted" | undefined;
  let killedTree: ProcInfo[] = [];
  let pollTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let exited = false;

  const leaderPid = child.pid;

  const outcomePromise = new Promise<Outcome>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ kind: "exit", code, signal });
    });
    child.once("error", (error) => {
      exited = true;
      resolve({ kind: "error", message: error.message });
    });
  });

  const stopTimers = (): void => {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    pollTimer = undefined;
    timeoutTimer = undefined;
  };

  const observe = (tree: readonly ProcInfo[]): number => {
    for (const proc of tree) tracked.add(procKey(proc));
    const total = sumRssMiB(tree);
    if (total > peakRssMiB) peakRssMiB = total;
    for (const proc of tree) {
      const mib = proc.rssKiB / 1024;
      if (mib > peakProcessRssMiB) peakProcessRssMiB = mib;
    }
    return total;
  };

  const fire = (reason: "timeout" | "rss_cap" | "aborted"): void => {
    if (limitReason !== undefined || leaderPid === undefined) return;
    limitReason = reason;
    stopTimers();
    let table = readProcesses();
    if (table === undefined) {
      // The group needs no table: end it first (which also frees the pids a
      // fork bomb was holding, so the table can be read again), then try
      // again to find what escaped it.
      killGroup(leaderPid);
      table = readProcessesRetryingSync(1);
    }
    if (table !== undefined) {
      killedTree = collectTree(table, leaderPid, tracked);
    } else {
      warnings.push(
        "the process table could not be read at the limit; escaped processes are looked for once the group has ended",
      );
    }
    killTree(leaderPid, killedTree);
  };

  const poll = (): void => {
    pollTimer = undefined;
    if (exited || limitReason !== undefined || leaderPid === undefined) return;
    const table = readProcesses();
    if (table === undefined) {
      failedPolls += 1;
    } else {
      polls += 1;
      const tree = collectTree(table, leaderPid, tracked);
      const total = observe(tree);
      if (total > options.maxRssMiB) {
        killedTree = tree;
        fire("rss_cap");
        return;
      }
    }
    pollTimer = setTimeout(poll, options.pollMs);
  };

  const onAbort = (): void => fire("aborted");

  if (leaderPid !== undefined) {
    timeoutTimer = setTimeout(() => fire("timeout"), options.timeoutMs);
    pollTimer = setTimeout(poll, 0);
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const outcome = await outcomePromise;
  stopTimers();
  options.signal?.removeEventListener("abort", onAbort);

  // Fd 3 stays open until the sweep is done. If the command killed the
  // trampoline, the watcher is still waiting on it, and closing it earlier
  // would have the watcher end the group before the leftovers were listed.
  try {
    if (outcome.kind === "error" || leaderPid === undefined) {
      const message =
        outcome.kind === "error" ? outcome.message : "no process was started";
      return {
        ...emptyResult(
          options,
          logPath,
          "spawn_failed",
          `could not start the command: ${message}`,
          started,
        ),
        outputTail: readTail(logPath),
      };
    }

    const childExitCode =
      outcome.code ??
      (outcome.signal !== null
        ? 128 + (SIGNAL_NUMBERS[outcome.signal] ?? 0)
        : 1);

    // Whatever is alive now: after a limit it is what survived the kill, after
    // an exit of the command's own accord it is what the command left behind.
    // The sweep kills it and looks again until nothing is left. A table that
    // cannot be read is no reason to leave the group running: it is ended
    // regardless, and the run is then not a pass.
    let leftoverCheckFailed = false;
    let found: ProcInfo[] = [];
    let remaining: ProcInfo[] = [];
    let table = await readProcessesRetrying();
    if (table === undefined) {
      leftoverCheckFailed = true;
      warnings.push(
        "the process table could not be read after the command ended; its group was killed without it and what was alive could not be listed",
      );
      killGroup(leaderPid);
      // The group is gone, which may have made room for `ps` to run again:
      // one more look for processes that had left it.
      table = await readProcessesRetrying();
    }
    if (table !== undefined) {
      remaining = collectTree(table, leaderPid, tracked);
      found = remaining;
      for (
        let round = 0;
        round < SWEEP_ROUNDS && remaining.length > 0;
        round++
      ) {
        killTree(leaderPid, remaining);
        await sleep(SWEEP_WAIT_MS);
        table = await readProcessesRetrying();
        if (table === undefined) {
          leftoverCheckFailed = true;
          warnings.push(
            "the process table could not be read during the kill sweeps; it is not known whether everything is gone",
          );
          killGroup(leaderPid);
          break;
        }
        remaining = collectTree(table, leaderPid, tracked);
      }
    }

    const callers = (list: readonly ProcInfo[]): ProcInfo[] =>
      list.filter((p) => !isTrampoline(p, leaderPid));
    if (callers(remaining).length > 0) {
      warnings.push(
        `${callers(remaining).length} process(es) were still alive after the kill sweeps (see survivors)`,
      );
    }
    if (failedPolls > 0) {
      warnings.push(
        `${failedPolls} of ${polls + failedPolls} memory polls could not read the process table; the cap was not checked at those polls`,
      );
    }

    const killed = limitReason !== undefined ? callers(killedTree) : [];
    const leftovers = limitReason === undefined ? callers(found) : [];
    const survivors = callers(remaining);

    let reason: GuardReason;
    if (limitReason !== undefined) reason = limitReason;
    else if (leftovers.length > 0) reason = "leftover";
    else if (leftoverCheckFailed) reason = "leftover_check_failed";
    else reason = childExitCode === 0 ? "none" : "child_exit";

    const asProcs = (list: readonly ProcInfo[]): GuardProc[] =>
      list.slice(0, LIST_LIMIT).map((proc) => toGuardProc(proc, leaderPid));

    return {
      status:
        reason === "none"
          ? "pass"
          : reason === "leftover_check_failed"
            ? "error"
            : "fail",
      reason,
      exitCode: guardExitCode(reason, childExitCode),
      childExitCode,
      durationMs: Date.now() - started,
      limits,
      peakRssMiB: Math.round(peakRssMiB * 10) / 10,
      peakProcessRssMiB: Math.round(peakProcessRssMiB * 10) / 10,
      polls,
      failedPolls,
      killed: asProcs(killed),
      killedCount: killed.length,
      leftovers: asProcs(leftovers),
      leftoverCount: leftovers.length,
      survivors: asProcs(survivors),
      survivorCount: survivors.length,
      leftoverCheckFailed,
      logPath,
      outputTail: readTail(logPath),
      warnings,
    };
  } finally {
    child.stdio[3]?.destroy();
  }
}
