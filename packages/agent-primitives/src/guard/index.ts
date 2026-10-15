import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedCommand } from "../bounded-spawn.js";
import {
  isZombie,
  procKey,
  PS_BOUND_MS,
  readProcesses,
  type ProcInfo,
} from "./ps.js";

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
 *
 * The terminal phase starts with the first terminal event: a limit (the
 * timeout or the cap), an abort, or the command's exit. One set of rules
 * covers all of them (`fire`, `onAbort` and `afterExit` in `supervise`):
 *
 * - Kill first. An event reads the process table at most once before it
 *   kills: at the cap it uses the poll's own table, at the timeout, at an
 *   abort before the exit, and after the exit it makes one fresh read. When
 *   that read fails the group is killed at once without it (`kill(-pgid)`
 *   needs no table); later reads only look for processes outside the group.
 *   There is no SIGTERM grace: a runaway allocation cannot be waited out.
 * - One read budget. Every read from the first terminal event on shares one
 *   deadline (`TERMINAL_READ_BUDGET_MS`), and each `ps` call is bounded by
 *   what is left of it (the one read a decision needs still gets
 *   `MIN_READ_MS` when it is spent); the kill at a limit, which is
 *   synchronous, reads for at most `LIMIT_READ_BUDGET_MS`. A poll's read is
 *   bounded by the time left to the timeout, so it cannot hold the timer
 *   back by more than `MIN_READ_MS`.
 * - Processes outside the group are killed by pid as a table read within the
 *   budget shows them; when none could be read, as the last table that could
 *   be read showed them, unless that table is older than
 *   `STALE_TABLE_MAX_MS` (a pid may have been reused since): then they are
 *   left alone and named in a warning.
 * - One accounting (`accountTerminal`): every process a table showed and a
 *   kill was aimed at is listed once, under `killed` after a limit or an
 *   abort and under `leftovers` after an exit of the command's own accord.
 *   Whenever a read the terminal phase needed failed for good,
 *   `leftoverCheckFailed` is set and the run is never a pass.
 * - An abort is honoured until `guard` returns. After the exit it kills the
 *   group, and whatever the last table showed outside it, at once without a
 *   read, and no further read is made.
 * - A zombie is dead and not counted.
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

/** The events that end a run early: the two limits and an abort. */
type LimitReason = "timeout" | "rss_cap" | "aborted";

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
  /** Aborting kills the group at once, like a limit does, even after the
   * command ended and until `guard` returns. */
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
  /** What was ended because of a limit or an abort, as a table showed it
   * (first entries only). */
  killed: GuardProc[];
  killedCount: number;
  /** What was still alive after the command ended on its own, and was
   * ended, as a table showed it (first entries only). */
  leftovers: GuardProc[];
  leftoverCount: number;
  /** Still alive in the last table read after the kill sweeps; killed once
   * more, not looked at again (first entries only). */
  survivors: GuardProc[];
  survivorCount: number;
  /** True when a read of the process table that the terminal phase needed
   * failed for good: at the limit, after the command ended, or after a kill
   * sweep. The group was killed anyway; the lists above may be incomplete. */
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
/** A read of the process table that fails is tried this many times in all,
 * the first try included, with a doubling pause (50, 100, 200 ms) before
 * each further try, as long as the budget leaves room for it. */
const TABLE_ATTEMPTS = 4;
const TABLE_BACKOFF_MS = 50;
/** Every read of the process table from the first terminal event on (a
 * limit, an abort, the command's exit) shares one deadline this far ahead. */
const TERMINAL_READ_BUDGET_MS = 2000;
/** The part of that budget the kill at a limit may spend reading. That kill
 * is synchronous (the CLI ends the process right after an abort), so this
 * is also how long it can hold up the thread. */
const LIMIT_READ_BUDGET_MS = 1000;
/** The least time one `ps` call is given. The one read a decision needs is
 * made even when the budget is spent; a further try is made only when this
 * much is left after its pause. */
const MIN_READ_MS = 250;
/** The oldest a process table may be for a kill by pid to be aimed from it
 * (`killFromLatest`): past this a pid may belong to an unrelated process. */
const STALE_TABLE_MAX_MS = 10_000;

const LIMIT_READ_FAILED =
  "the process table could not be read at the limit; the group was killed without it, so its members are not listed";
const AFTER_EXIT_READ_FAILED =
  "the process table could not be read after the command ended; its group was killed without it, so what was alive in it could not be listed";
const SWEEP_READ_FAILED =
  "the process table could not be read after a kill sweep; it is not known whether everything is gone";

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

/** The identities (pid plus start time) of `guard`'s own two processes in
 * the group, once tables have shown them: the trampoline, which leads the
 * group, and its parent-death watcher. `candidate` is a watcher seen in one
 * table so far. */
export interface OwnIdentities {
  leader?: string;
  /** The trampoline's full command line, as the first table that showed it
   * readable printed it; its watcher shows exactly the same text. */
  leaderCommand?: string;
  /** How every command line of the trampoline ends: the program and the
   * arguments `guard` handed to it, which `ps` prints after the script. For
   * when no table showed the trampoline readable (the first look often
   * catches it as `(bash)`, in the middle of a fork). A command with
   * characters `ps` escapes in its arguments does not match it. */
  commandTail?: string;
  watcher?: string;
  candidate?: string;
}

/**
 * Learns the identities of the trampoline and its watcher from the tables
 * that show them side by side: the leader alive with its command line
 * readable (`ps` shows a process it cannot read the arguments of, such as one
 * in the middle of a fork, as `(name)`), and exactly one direct child of it in
 * its group with that same command line (the watcher is a forked subshell, so
 * it shows the same text). The command itself shows that text too between its
 * fork and its exec, so a table with two such children teaches nothing, and
 * the watcher is recorded only once the same process was the one such child
 * in two tables: the command does not stay unexec'd from one poll to the
 * next. Writes only to `own`.
 */
export function captureOwn(
  table: readonly ProcInfo[],
  leaderPid: number,
  own: OwnIdentities,
): void {
  if (own.watcher !== undefined) return;
  const leader = table.find(
    (p) => p.pid === leaderPid && p.pgid === leaderPid && !isZombie(p),
  );
  if (leader === undefined) return;
  own.leader ??= procKey(leader);
  if (!leader.command.startsWith(TRAMPOLINE_COMMAND_PREFIX)) return;
  own.leaderCommand ??= leader.command;
  const watchers = table.filter(
    (p) =>
      p.ppid === leaderPid &&
      p.pgid === leaderPid &&
      p.command === leader.command &&
      !isZombie(p),
  );
  if (watchers.length !== 1) return;
  const key = procKey(watchers[0] as ProcInfo);
  if (own.candidate === key) own.watcher = key;
  else own.candidate = key;
}

/**
 * Learns the watcher's identity after the trampoline itself died of a signal
 * before any table showed the two side by side (a command that kills its
 * parent within its first milliseconds). The watcher then outlives it, still
 * in the group and waiting on its pipe, reparented to a process outside the
 * tree. It is taken to be the one group member whose parent is not in the
 * tree and whose command line is exactly the trampoline's, as an earlier
 * table showed it (`own.leaderCommand`); when no table showed it readable,
 * the trampoline's leading text and the end it must have (`commandTail`)
 * have to do. With none or more than one such process nothing is learned,
 * and all of them are reported. Only for a
 * trampoline that died of a signal: one that exits normally has already
 * stopped its watcher, so such a process could only be the caller's. Writes
 * only to `own`.
 */
export function captureOrphanedWatcher(
  table: readonly ProcInfo[],
  leaderPid: number,
  tracked: ReadonlySet<string>,
  own: OwnIdentities,
): void {
  if (own.watcher !== undefined) return;
  const tree = collectTree(table, leaderPid, tracked);
  const inTree = new Set(tree.map((p) => p.pid));
  const orphans = tree.filter(
    (p) =>
      p.pgid === leaderPid &&
      (own.leaderCommand === undefined
        ? p.command.startsWith(TRAMPOLINE_COMMAND_PREFIX) &&
          (own.commandTail === undefined || p.command.endsWith(own.commandTail))
        : p.command === own.leaderCommand) &&
      !inTree.has(p.ppid),
  );
  if (orphans.length === 1) own.watcher = procKey(orphans[0] as ProcInfo);
}

/**
 * True for the trampoline and its watcher. They are part of every run, not
 * something the caller started, so the reports leave them out (they still
 * count toward the memory sum and are killed with the group). Once learned
 * (`captureOwn`, `captureOrphanedWatcher`) they are known by identity, which
 * still holds after the watcher lost its parent (a command that kills the
 * trampoline reparents it). Before that, and only for the one whose identity
 * is not known, they are recognised by place: the group's leader, or a direct
 * child of it in its group, with the trampoline's command line. Any other
 * process that merely shows the same text (`exec -a`, a nested bounded run)
 * is the caller's and is reported.
 */
export function isOwnProcess(
  proc: ProcInfo,
  leaderPid: number,
  own: OwnIdentities,
): boolean {
  const key = procKey(proc);
  if (key === own.leader || key === own.watcher) return true;
  if (!proc.command.startsWith(TRAMPOLINE_COMMAND_PREFIX)) return false;
  if (own.leader === undefined && proc.pid === leaderPid) return true;
  return (
    own.watcher === undefined &&
    proc.ppid === leaderPid &&
    proc.pgid === leaderPid
  );
}

/** The process lists of a result. */
export interface TerminalAccount {
  killed: ProcInfo[];
  leftovers: ProcInfo[];
  survivors: ProcInfo[];
}

/**
 * The one accounting of the terminal phase. Every process in `atLimit` (what
 * the kill at a limit was aimed at) or in `after` (what was found and killed
 * after the command ended) is listed exactly once: under `killed` when a
 * limit fired or an abort came (`limited`), else under `leftovers`.
 * `survivors` are the processes still alive in the last table read after the
 * kill sweeps; each of them is also in one of the two lists. `guard`'s own
 * processes are left out of all three. Pure.
 */
export function accountTerminal(input: {
  limited: boolean;
  atLimit: readonly ProcInfo[];
  after: readonly ProcInfo[];
  survivors: readonly ProcInfo[];
  isOwn: (proc: ProcInfo) => boolean;
}): TerminalAccount {
  const ended = new Map<string, ProcInfo>();
  for (const proc of [...input.atLimit, ...input.after]) {
    const key = procKey(proc);
    if (!ended.has(key) && !input.isOwn(proc)) ended.set(key, proc);
  }
  const list = [...ended.values()];
  return {
    killed: input.limited ? list : [],
    leftovers: input.limited ? [] : list,
    survivors: input.survivors.filter((proc) => !input.isOwn(proc)),
  };
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

/** Sends SIGKILL to one process; false when there was no such process. */
function killPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
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

/** Blocks the thread for `ms`; the kill at a limit must be done before it
 * returns (the CLI ends the process right after an abort), so it cannot
 * await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long a `ps` call that has to be done by `stopAt` may take: what is
 * left until then, but never less than `MIN_READ_MS`. */
function readBound(stopAt: number): number {
  return Math.min(PS_BOUND_MS, Math.max(MIN_READ_MS, stopAt - Date.now()));
}

/** The pause before try number `attempt + 1` of a read whose earlier tries
 * failed, or undefined when no further try is left or fits before `stopAt`. */
function retryPause(attempt: number, stopAt: number): number | undefined {
  if (attempt >= TABLE_ATTEMPTS) return undefined;
  const pause = TABLE_BACKOFF_MS * 2 ** (attempt - 1);
  return stopAt - Date.now() >= pause + MIN_READ_MS ? pause : undefined;
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
  try {
    return await supervise(child, options, logPath, started);
  } finally {
    // Fd 3 stays open until here. If the command killed the trampoline, the
    // watcher is still waiting on it, and closing it earlier would have the
    // watcher end the group before the leftovers were listed.
    child.stdio[3]?.destroy();
  }
}

/** The run itself, from the spawn to the result. */
async function supervise(
  child: ChildProcess,
  options: GuardOptions,
  logPath: string,
  started: number,
): Promise<GuardResult> {
  let exited = false;
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
  const spawnFailed = (outcome: Outcome): GuardResult => ({
    ...emptyResult(
      options,
      logPath,
      "spawn_failed",
      `could not start the command: ${outcome.kind === "error" ? outcome.message : "no process was started"}`,
      started,
    ),
    outputTail: readTail(logPath),
  });

  const leaderPid = child.pid;
  if (leaderPid === undefined) return spawnFailed(await outcomePromise);

  const warnings: string[] = [];
  const limits = {
    timeoutMs: options.timeoutMs,
    maxRssMiB: options.maxRssMiB,
    pollMs: options.pollMs,
  };
  const timeoutAt = Date.now() + options.timeoutMs;

  // What the process table has shown.
  const tracked = new Set<string>();
  const own: OwnIdentities = {
    commandTail: ` sh ${[options.command, ...options.args].join(" ")}`,
  };
  let latest: ProcInfo[] | undefined;
  let latestAt = 0;
  let peakRssMiB = 0;
  let peakProcessRssMiB = 0;
  let polls = 0;
  let failedPolls = 0;
  let pollTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  // The terminal phase.
  let limitReason: LimitReason | undefined;
  let deadline: number | undefined;
  let atLimit: ProcInfo[] = [];
  const after = new Map<string, ProcInfo>();
  let survivors: ProcInfo[] = [];
  let checkFailed = false;
  let abortedAfterExit = false;

  /** Every read of the table goes through here: it keeps the last table that
   * could be read and learns the identities of guard's own processes. */
  const readTable = (boundMs: number): ProcInfo[] | undefined => {
    const table = readProcesses(boundMs);
    if (table !== undefined) {
      latest = table;
      latestAt = Date.now();
      captureOwn(table, leaderPid, own);
    }
    return table;
  };

  /** The tree in `table`; its processes are followed from now on. */
  const treeOf = (table: readonly ProcInfo[]): ProcInfo[] => {
    const tree = collectTree(table, leaderPid, tracked);
    for (const proc of tree) tracked.add(procKey(proc));
    return tree;
  };

  const observe = (tree: readonly ProcInfo[]): number => {
    const total = sumRssMiB(tree);
    if (total > peakRssMiB) peakRssMiB = total;
    for (const proc of tree) {
      const mib = proc.rssKiB / 1024;
      if (mib > peakProcessRssMiB) peakProcessRssMiB = mib;
    }
    return total;
  };

  const stopTimers = (): void => {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    pollTimer = undefined;
    timeoutTimer = undefined;
  };

  /** The deadline every read of the terminal phase shares, set by the first
   * terminal event. */
  const terminalDeadline = (): number => {
    deadline ??= Date.now() + TERMINAL_READ_BUDGET_MS;
    return deadline;
  };

  /** A read the terminal phase needed failed for good: the lists may be
   * incomplete, and the run is not a pass. */
  const readFailed = (warning: string): void => {
    checkFailed = true;
    warnings.push(warning);
  };

  /** The further tries of a read whose first try failed, for the kill at a
   * limit, which cannot await. */
  const retryReadSync = (stopAt: number): ProcInfo[] | undefined => {
    for (let attempt = 1; ; attempt++) {
      const pause = retryPause(attempt, stopAt);
      if (pause === undefined) return undefined;
      sleepSync(pause);
      const table = readTable(readBound(stopAt));
      if (table !== undefined) return table;
    }
  };

  /** The same, awaiting the pauses. Stops when an abort came after the exit:
   * the abort has already killed what can be killed without a table. */
  const retryRead = async (stopAt: number): Promise<ProcInfo[] | undefined> => {
    for (let attempt = 1; ; attempt++) {
      const pause = retryPause(attempt, stopAt);
      if (pause === undefined) return undefined;
      await sleep(pause);
      if (abortedAfterExit) return undefined;
      const table = readTable(readBound(stopAt));
      if (table !== undefined) return table;
    }
  };

  /** Ends the group, and by pid every process outside it that the last table
   * read showed: for when no table can be read now. A table older than
   * `STALE_TABLE_MAX_MS` is not trusted for that (its pids may be reused by
   * now): the group is still killed, the run says it could not check, and the
   * warning names what was not killed. Returns the processes outside the
   * group the kill reached (one that was gone is left out). */
  const killFromLatest = (): ProcInfo[] => {
    killGroup(leaderPid);
    if (latest === undefined) return [];
    const outside = collectTree(latest, leaderPid, tracked).filter(
      (proc) => proc.pgid !== leaderPid,
    );
    if (outside.length === 0) return [];
    const ageMs = Date.now() - latestAt;
    if (ageMs > STALE_TABLE_MAX_MS) {
      checkFailed = true;
      const named = outside
        .slice(0, 5)
        .map((proc) => `${proc.pid} (${toGuardProc(proc, leaderPid).command})`);
      warnings.push(
        `${outside.length} process(es) outside the group were NOT killed: the last table that could be read is ${ageMs} ms old, older than ${STALE_TABLE_MAX_MS} ms, and their pids may belong to other processes by now: ${named.join(", ")}`,
      );
      return [];
    }
    const reached = outside.filter((proc) => killPid(proc.pid));
    if (reached.length > 0) {
      warnings.push(
        `${reached.length} process(es) outside the group were killed by pid as the last table that could be read showed them, ${ageMs} ms earlier`,
      );
    }
    return reached;
  };

  /** A limit, or an abort before the command ended: one read at most (none
   * at the cap, where the poll's table is fresh), then the kill; without a
   * table the group is killed first and the tries that follow only look for
   * what left it. Synchronous. */
  const fire = (reason: LimitReason, polled?: ProcInfo[]): void => {
    if (limitReason !== undefined) return;
    limitReason = reason;
    stopTimers();
    const stopAt = Math.min(
      terminalDeadline(),
      Date.now() + LIMIT_READ_BUDGET_MS,
    );
    let table = polled ?? readTable(readBound(stopAt));
    if (table === undefined) {
      readFailed(LIMIT_READ_FAILED);
      killGroup(leaderPid);
      table = retryReadSync(stopAt);
    }
    if (table === undefined) {
      atLimit = killFromLatest();
      return;
    }
    atLimit = treeOf(table);
    killTree(leaderPid, atLimit);
  };

  const poll = (): void => {
    pollTimer = undefined;
    if (exited || limitReason !== undefined) return;
    // Bounded by the time left to the timeout as well, so a slow `ps` holds
    // the timer back by `MIN_READ_MS` at most.
    const table = readTable(readBound(timeoutAt));
    if (table === undefined) {
      failedPolls += 1;
    } else {
      polls += 1;
      if (observe(treeOf(table)) > options.maxRssMiB) {
        fire("rss_cap", table);
        return;
      }
    }
    pollTimer = setTimeout(poll, options.pollMs);
  };

  /** An abort is honoured until `guard` returns. Before the exit it is a
   * limit like the others. After it there is no time for a read: the group,
   * and whatever the last table showed outside it, are killed at once, and
   * the reads still pending are dropped. */
  const onAbort = (): void => {
    if (!exited) {
      fire("aborted");
      return;
    }
    limitReason ??= "aborted";
    abortedAfterExit = true;
    for (const proc of killFromLatest()) after.set(procKey(proc), proc);
  };

  /** After the command ended, on its own or killed at a limit: one read to
   * list and kill what is still alive (without it, the group is killed at
   * once and the tries that follow only look for what left it), then kill
   * sweeps, each looked at again, until nothing is left. */
  const afterExit = async (trampolineKilled: boolean): Promise<void> => {
    const stopAt = terminalDeadline();
    let table = readTable(readBound(stopAt));
    if (table !== undefined && trampolineKilled) {
      captureOrphanedWatcher(table, leaderPid, tracked, own);
    }
    if (table === undefined) {
      readFailed(AFTER_EXIT_READ_FAILED);
      killGroup(leaderPid);
      table = await retryRead(stopAt);
      if (table === undefined) {
        if (!abortedAfterExit) {
          for (const proc of killFromLatest()) after.set(procKey(proc), proc);
        }
        return;
      }
    }
    let tree = treeOf(table);
    for (let round = 1; tree.length > 0; round++) {
      for (const proc of tree) after.set(procKey(proc), proc);
      killTree(leaderPid, tree);
      await sleep(SWEEP_WAIT_MS);
      if (abortedAfterExit) return;
      const next = readTable(readBound(stopAt)) ?? (await retryRead(stopAt));
      if (next === undefined) {
        if (!abortedAfterExit) readFailed(SWEEP_READ_FAILED);
        return;
      }
      tree = treeOf(next);
      if (tree.length > 0 && (round >= SWEEP_ROUNDS || Date.now() >= stopAt)) {
        survivors = tree;
        for (const proc of tree) after.set(procKey(proc), proc);
        killTree(leaderPid, tree);
        return;
      }
    }
  };

  timeoutTimer = setTimeout(() => fire("timeout"), options.timeoutMs);
  pollTimer = setTimeout(poll, 0);
  if (options.signal !== undefined) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const outcome = await outcomePromise;
    stopTimers();
    if (outcome.kind === "error") return spawnFailed(outcome);
    const childExitCode =
      outcome.code ??
      (outcome.signal !== null
        ? 128 + (SIGNAL_NUMBERS[outcome.signal] ?? 0)
        : 1);

    // A trampoline that died of a signal (the command killed it, or the kill
    // at a limit did) leaves its watcher behind until fd 3 is closed.
    await afterExit(outcome.signal !== null);

    const account = accountTerminal({
      limited: limitReason !== undefined,
      atLimit,
      after: [...after.values()],
      survivors,
      isOwn: (proc) => isOwnProcess(proc, leaderPid, own),
    });
    if (account.survivors.length > 0) {
      warnings.push(
        `${account.survivors.length} process(es) were still alive after the kill sweeps (see survivors)`,
      );
    }
    if (failedPolls > 0) {
      warnings.push(
        `${failedPolls} of ${polls + failedPolls} memory polls could not read the process table; the cap was not checked at those polls`,
      );
    }

    let reason: GuardReason;
    if (limitReason !== undefined) reason = limitReason;
    else if (account.leftovers.length > 0) reason = "leftover";
    else if (checkFailed) reason = "leftover_check_failed";
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
      killed: asProcs(account.killed),
      killedCount: account.killed.length,
      leftovers: asProcs(account.leftovers),
      leftoverCount: account.leftovers.length,
      survivors: asProcs(account.survivors),
      survivorCount: account.survivors.length,
      leftoverCheckFailed: checkFailed,
      logPath,
      outputTail: readTail(logPath),
      warnings,
    };
  } finally {
    stopTimers();
    options.signal?.removeEventListener("abort", onAbort);
  }
}
