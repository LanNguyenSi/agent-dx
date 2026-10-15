import { spawnSync } from "node:child_process";

/**
 * One row of the process table, as `ps` reports it. `started` is the
 * process's start time as `ps` prints it (`lstart`); together with the pid it
 * identifies one process for as long as it lives, so a pid the system has
 * reused for an unrelated process is never mistaken for one this module
 * saw earlier.
 */
export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  rssKiB: number;
  stat: string;
  started: string;
  command: string;
}

/** The columns asked of `ps`: the same names and meanings on macOS (BSD
 * `ps`) and on Linux (procps). `command` is last because it has spaces. */
export const PS_ARGS: readonly string[] = [
  "-A",
  "-o",
  "pid=,ppid=,pgid=,rss=,stat=,lstart=,command=",
];

// pid ppid pgid rss stat <lstart: Www Mmm dd hh:mm:ss yyyy> command
const ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;

/**
 * Parses the output of `ps` run with `PS_ARGS`. A line that does not have the
 * expected shape is skipped; the caller decides whether an empty table is an
 * error (it always is: the table holds at least the caller itself).
 */
export function parsePs(text: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of text.split("\n")) {
    const m = ROW.exec(line);
    if (m === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      rssKiB: Number(m[4]),
      stat: m[5] as string,
      started: (m[6] as string).replace(/\s+/g, " "),
      command: m[7] as string,
    });
  }
  return rows;
}

/** How long one `ps` call may take before it is killed. */
const PS_BOUND_MS = 5000;

/**
 * The process table, or `undefined` when `ps` is missing, fails, times out or
 * prints nothing parseable. Bounded, and run in the C locale so the start
 * time is parsed the same way everywhere.
 */
export function readProcesses(): ProcInfo[] | undefined {
  const result = spawnSync("ps", [...PS_ARGS], {
    encoding: "utf8",
    timeout: PS_BOUND_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const rows = parsePs(result.stdout);
  return rows.length > 0 ? rows : undefined;
}

/** A zombie is dead and holds no memory: it is waiting for its parent to
 * collect it, and cannot be killed. */
export function isZombie(proc: ProcInfo): boolean {
  return proc.stat.startsWith("Z");
}

/** The identity of one process: pid plus start time. */
export function procKey(proc: Pick<ProcInfo, "pid" | "started">): string {
  return `${proc.pid}|${proc.started}`;
}
