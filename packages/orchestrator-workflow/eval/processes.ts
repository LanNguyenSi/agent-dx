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
/* Sweep by working directory                                           */
/* ------------------------------------------------------------------ */

export interface SweptProcess {
  pid: number;
  cwd: string;
}

export interface SweepResult {
  /** Processes found with a working directory inside a root, and killed. */
  killed: SweptProcess[];
  /** Why the process table could not be read, or null. */
  unavailable: string | null;
}

/** Working directories of the user's processes, from /proc or lsof. */
function processCwds(env: NodeJS.ProcessEnv): Map<number, string> | string {
  const found = new Map<number, string>();
  if (process.platform === "linux" && existsSync("/proc/self/cwd")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        found.set(Number(name), readlinkSync(`/proc/${name}/cwd`));
      } catch {
        // Gone, or another user's process.
      }
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
        "cwd",
        "-u",
        String(process.getuid?.() ?? 0),
        "-F",
        "pn",
        "-w",
      ],
      {
        encoding: "utf8",
        env: { PATH: env.PATH ?? "/usr/sbin:/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
        maxBuffer: 64 * 1024 * 1024,
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
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null)
      found.set(pid, line.slice(1));
  }
  return found;
}

/**
 * Kills every process of this user whose working directory lies inside one
 * of `roots`, except this process. Catches what a session or a setup command
 * left running in its checkout even after it left its process group and its
 * parent chain (a `setsid` child of a short-lived parent), which a tree walk
 * from the group leader can no longer find.
 */
export function sweepByCwd(
  roots: string[],
  env: NodeJS.ProcessEnv,
): SweepResult {
  const table = processCwds(env);
  if (typeof table === "string") return { killed: [], unavailable: table };
  const killed: SweptProcess[] = [];
  for (const [pid, cwd] of table) {
    if (pid === process.pid || pid <= 1) continue;
    if (!roots.some((root) => isInside(cwd, root))) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push({ pid, cwd });
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
