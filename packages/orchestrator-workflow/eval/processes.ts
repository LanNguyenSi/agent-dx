import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isInside } from "./isolation.js";

/* ------------------------------------------------------------------ */
/* One process group with a wall-clock bound                           */
/* ------------------------------------------------------------------ */

export interface GroupedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  stdoutFile: string;
  stderrFile: string;
  killGraceMs?: number;
}

export interface GroupedResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  wallMs: number;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs a command in its own process group with a wall-clock bound. On the
 * bound the whole group gets SIGTERM, then SIGKILL after a grace period; and
 * once the leader has exited, any group member it left behind is killed too.
 * This bounds `guard` itself; the tree sweep is `runGuarded`'s job.
 */
export function runGrouped(
  command: string,
  args: string[],
  options: GroupedOptions,
): Promise<GroupedResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = openSync(options.stdoutFile, "a");
    const err = openSync(options.stderrFile, "a");
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", out, err],
    });
    const pid = child.pid;

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (pid !== undefined) killGroup(pid, "SIGKILL");
      closeSync(out);
      closeSync(err);
      resolve({
        code,
        signal,
        timedOut,
        spawnError,
        wallMs: Date.now() - started,
      });
    };

    let hardTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killGroup(pid, "SIGTERM");
      hardTimer = setTimeout(() => {
        if (pid !== undefined) killGroup(pid, "SIGKILL");
      }, options.killGraceMs ?? 3000);
    }, options.timeoutMs);

    child.on("error", (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));

    child.stdin?.on("error", () => {
      // The child may exit before reading its input.
    });
    child.stdin?.end(options.stdin ?? "");
  });
}

/* ------------------------------------------------------------------ */
/* Sweep by working directory and open files                            */
/* ------------------------------------------------------------------ */

/** How a process was found inside a root. */
export type SweepVia = "cwd" | "open_file";

export interface SweptProcess {
  pid: number;
  /** Working directory of the process; it can lie outside every root when `via` is `open_file`. */
  cwd: string;
  /** What put the process inside a root: its working directory or a file it holds open. */
  via?: SweepVia;
  /** The open file that matched, for `via` `open_file`. */
  file?: string;
}

export interface SweepResult {
  /** Processes found with a working directory or an open file inside a root, and killed. */
  killed: SweptProcess[];
  /** Why the process table could not be read, or null. */
  unavailable: string | null;
}

/**
 * Descriptors lsof lists: the working directory and descriptors 0 to 31. A
 * wider range made lsof stall for ten seconds per call on macOS (measured with
 * 0-63), and a sweep runs after every command.
 */
const LSOF_DESCRIPTORS = "cwd,0-31";
const MAX_FD_LISTED = 32;

/** What the sweep knows about one process. */
export interface ProcessPlaces {
  /** Working directory, or null when it could not be read. */
  cwd: string | null;
  /** Absolute paths of files the process holds open (its standard streams included). */
  files: string[];
}

/**
 * Working directories and open files of the user's processes, from /proc or
 * lsof. Open files catch a process that changed its working directory out of
 * the root but still holds a log, a pipe target or a lock file inside it.
 */
function processTable(
  env: NodeJS.ProcessEnv,
): Map<number, ProcessPlaces> | string {
  const found = new Map<number, ProcessPlaces>();
  if (process.platform === "linux" && existsSync("/proc/self/cwd")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const places: ProcessPlaces = { cwd: null, files: [] };
      try {
        places.cwd = readlinkSync(`/proc/${name}/cwd`);
      } catch {
        // Gone, or another user's process.
      }
      try {
        for (const fd of readdirSync(`/proc/${name}/fd`)) {
          if (Number(fd) >= MAX_FD_LISTED) continue;
          try {
            const target = readlinkSync(`/proc/${name}/fd/${fd}`);
            if (target.startsWith("/")) places.files.push(target);
          } catch {
            // The descriptor closed meanwhile.
          }
        }
      } catch {
        // Gone, or another user's process.
      }
      if (places.cwd !== null || places.files.length > 0)
        found.set(Number(name), places);
    }
    return found;
  }
  let text: string;
  try {
    text = execFileSync(
      "lsof",
      [
        "-a",
        "-d",
        LSOF_DESCRIPTORS,
        "-u",
        String(process.getuid?.() ?? 0),
        "-F",
        "pfn",
        "-w",
      ],
      {
        encoding: "utf8",
        env: { PATH: env.PATH ?? "/usr/sbin:/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
        maxBuffer: 256 * 1024 * 1024,
      },
    );
  } catch (error) {
    // lsof exits 1 when one of its filters matched nothing; the output still counts.
    const out = (error as { stdout?: unknown }).stdout;
    if (typeof out !== "string" || out.length === 0) {
      return `lsof failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    }
    text = out;
  }
  return parseLsofPlaces(text);
}

/** Parses `lsof -F pfn` output: `p<pid>`, then per descriptor `f<fd>` and `n<name>`. */
export function parseLsofPlaces(text: string): Map<number, ProcessPlaces> {
  const found = new Map<number, ProcessPlaces>();
  let pid: number | null = null;
  let fd: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      fd = null;
    } else if (line.startsWith("f")) {
      fd = line.slice(1);
    } else if (line.startsWith("n") && pid !== null && fd !== null) {
      const name = line.slice(1);
      let places = found.get(pid);
      if (places === undefined) {
        places = { cwd: null, files: [] };
        found.set(pid, places);
      }
      if (fd === "cwd") places.cwd = name;
      else if (name.startsWith("/")) places.files.push(name);
    }
  }
  return found;
}

/**
 * The processes of `table` that work inside one of `roots` or hold a file
 * open there, except this process and pid 1 and below. A working directory
 * match wins over an open file.
 */
export function placesInside(
  table: Map<number, ProcessPlaces>,
  roots: string[],
  selfPid: number = process.pid,
): SweptProcess[] {
  const hits: SweptProcess[] = [];
  for (const [pid, places] of table) {
    if (pid === selfPid || pid <= 1) continue;
    if (
      places.cwd !== null &&
      roots.some((root) => isInside(places.cwd!, root))
    ) {
      hits.push({ pid, cwd: places.cwd, via: "cwd" });
      continue;
    }
    const file = places.files.find((f) =>
      roots.some((root) => isInside(f, root)),
    );
    if (file !== undefined)
      hits.push({ pid, cwd: places.cwd ?? "", via: "open_file", file });
  }
  return hits;
}

/**
 * Kills every process of this user whose working directory lies inside one
 * of `roots` or that holds a file open inside one, except this process.
 * Catches what a session or a setup command left running in its checkout even
 * after it left its process group and its parent chain (a `setsid` child of a
 * short-lived parent), which a tree walk from the group leader can no longer
 * find; the open-file match also catches such a process after it changed its
 * working directory out of the root, as long as it keeps a stream or a file
 * there. A process that did both (closed everything, left the root, cleared
 * its environment) stays invisible to the sweep; it remains bound by the
 * sandbox the session ran under.
 */
export function sweepByCwd(
  roots: string[],
  env: NodeJS.ProcessEnv,
): SweepResult {
  const table = processTable(env);
  if (typeof table === "string") return { killed: [], unavailable: table };
  const killed: SweptProcess[] = [];
  for (const hit of placesInside(table, roots)) {
    try {
      process.kill(hit.pid, "SIGKILL");
      killed.push(hit);
    } catch {
      // Already gone.
    }
  }
  return { killed, unavailable: null };
}

/* ------------------------------------------------------------------ */
/* agent-primitives guard around a command                              */
/* ------------------------------------------------------------------ */

/** Runs the command with stdin, stdout and stderr redirected to files (appending). */
const REDIRECT =
  'in=$1; out=$2; err=$3; shift 3; exec "$@" <"$in" >>"$out" 2>>"$err"';

export interface GuardedOptions {
  /** The `agent-primitives` binary. */
  guardBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxRssMiB: number;
  /** File the command reads as stdin; null for /dev/null. */
  stdinFile: string | null;
  stdoutFile: string;
  stderrFile: string;
  /** Directory for guard's own envelope and log. */
  logDir: string;
  /** Directories whose resident processes are killed afterwards. */
  sweepRoots: string[];
}

/** The part of guard's report a run record keeps. */
export interface GuardReport {
  reason: string;
  exit_code: number | null;
  killed_count: number;
  leftover_count: number;
  survivor_count: number;
  leftover_check_failed: boolean;
  peak_rss_mib: number | null;
  /** First entries of guard's own lists: pid, whether it left the group, command. */
  processes: { pid: number; in_group: boolean; command: string }[];
}

export interface GuardedResult {
  /** The command's own exit code, as guard reports it. */
  code: number | null;
  timedOut: boolean;
  rssCapHit: boolean;
  /** The command, or guard, could not be run or reported nothing usable. */
  spawnError: string | null;
  wallMs: number;
  guard: GuardReport | null;
  swept: SweepResult;
}

const GUARD_MARGIN_MS = 60_000;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function procs(value: unknown): GuardReport["processes"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
    )
    .map((p) => ({
      pid: num(p.pid) ?? -1,
      in_group: p.inGroup === true,
      command: typeof p.command === "string" ? p.command : "",
    }));
}

/** Parses the JSON envelope `agent-primitives guard` prints. */
export function parseGuardEnvelope(text: string): GuardReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  if (e.command !== "guard" || typeof e.reason !== "string") return null;
  return {
    reason: e.reason,
    exit_code: num(e.childExitCode),
    killed_count: num(e.killedCount) ?? 0,
    leftover_count: num(e.leftoverCount) ?? 0,
    survivor_count: num(e.survivorCount) ?? 0,
    leftover_check_failed: e.leftoverCheckFailed === true,
    peak_rss_mib: num(e.peakRssMiB),
    processes: [
      ...procs(e.killed),
      ...procs(e.leftovers),
      ...procs(e.survivors),
    ],
  };
}

/**
 * Runs a command under `agent-primitives guard <timeout-s> <max-rss-MiB>`,
 * which runs it in a process group of its own, kills the whole group (and
 * the descendants it saw leave the group) at the wall-clock bound or the
 * memory cap, and reports what the command left running. The command's
 * streams go to files through a `/bin/sh` redirect, since guard itself keeps
 * a combined log. Afterwards every process still working inside one of
 * `sweepRoots` is killed as well (see `sweepByCwd`).
 */
export async function runGuarded(
  command: string,
  args: string[],
  options: GuardedOptions,
): Promise<GuardedResult> {
  mkdirSync(options.logDir, { recursive: true });
  const envelopeFile = join(options.logDir, "guard.json");
  const guardErr = join(options.logDir, "guard-stderr.log");
  // One envelope per call; the command's own streams append (setup commands share a log).
  writeFileSync(envelopeFile, "");
  for (const file of [options.stdoutFile, options.stderrFile]) {
    closeSync(openSync(file, "a"));
  }
  const guardArgs = [
    "--format",
    "json",
    "--log-dir",
    options.logDir,
    "guard",
    String(Math.max(options.timeoutMs, 1) / 1000),
    String(options.maxRssMiB),
    "--",
    "/bin/sh",
    "-c",
    REDIRECT,
    "sh",
    options.stdinFile ?? "/dev/null",
    options.stdoutFile,
    options.stderrFile,
    command,
    ...args,
  ];
  const outer = await runGrouped(options.guardBin, guardArgs, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs + GUARD_MARGIN_MS,
    stdoutFile: envelopeFile,
    stderrFile: guardErr,
  });
  const swept = sweepByCwd(options.sweepRoots, options.env);
  const report = parseGuardEnvelope(readFileSync(envelopeFile, "utf8"));
  if (outer.spawnError !== null || report === null) {
    return {
      code: null,
      timedOut: outer.timedOut,
      rssCapHit: false,
      spawnError:
        outer.spawnError !== null
          ? `${options.guardBin}: ${outer.spawnError}`
          : `${options.guardBin} reported no result (exit ${outer.code ?? outer.signal})`,
      wallMs: outer.wallMs,
      guard: null,
      swept,
    };
  }
  const notRun =
    report.reason === "spawn_failed" ||
    report.reason === "unsupported_platform";
  return {
    code: report.exit_code,
    timedOut: outer.timedOut || report.reason === "timeout",
    rssCapHit: report.reason === "rss_cap",
    spawnError: notRun
      ? `guard could not run the command (${report.reason})`
      : null,
    wallMs: outer.wallMs,
    guard: report,
    swept,
  };
}

/** Total of processes killed after the command: guard's leftovers, survivors and the cwd sweep. */
export function leftoverTotal(
  result: Pick<GuardedResult, "guard" | "swept">,
): number {
  return (
    (result.guard?.leftover_count ?? 0) +
    (result.guard?.survivor_count ?? 0) +
    result.swept.killed.length
  );
}
