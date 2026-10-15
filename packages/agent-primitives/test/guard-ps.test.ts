import { describe, expect, it } from "vitest";
import {
  isZombie,
  parsePs,
  procKey,
  readProcesses,
  type ProcInfo,
} from "../src/guard/ps.js";
import { collectTree, guardExitCode } from "../src/guard/index.js";

function proc(
  pid: number,
  ppid: number,
  pgid: number,
  extra: Partial<ProcInfo> = {},
): ProcInfo {
  return {
    pid,
    ppid,
    pgid,
    rssKiB: 1024,
    stat: "S",
    started: "Thu Oct 15 10:00:00 2026",
    command: `cmd-${pid}`,
    ...extra,
  };
}

describe("parsePs", () => {
  it("reads a BSD ps row and a procps row, command with spaces last", () => {
    const text = [
      "  501     1   501  20480 Ss   Thu Oct 15 10:00:01 2026 /bin/sh -c echo hi there",
      "    7     1     7   1024 S+   Thu Oct  1 09:05:09 2026 node -e 'a  b'",
    ].join("\n");
    const rows = parsePs(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pid: 501,
      ppid: 1,
      pgid: 501,
      rssKiB: 20480,
      stat: "Ss",
      started: "Thu Oct 15 10:00:01 2026",
      command: "/bin/sh -c echo hi there",
    });
    expect(rows[1]?.started).toBe("Thu Oct 1 09:05:09 2026");
    expect(rows[1]?.command).toBe("node -e 'a  b'");
  });

  it("skips lines that do not have the expected shape", () => {
    expect(parsePs("garbage\n\n  PID PPID\n")).toEqual([]);
  });

  it("the live process table contains this process, with a start time", () => {
    const rows = readProcesses();
    expect(rows).toBeDefined();
    const me = rows?.find((p) => p.pid === process.pid);
    expect(me).toBeDefined();
    expect(me?.rssKiB).toBeGreaterThan(0);
    expect(me?.started).toMatch(
      /^[A-Za-z]{3} [A-Za-z]{3} \d+ \d\d:\d\d:\d\d \d{4}$/,
    );
  });
});

describe("isZombie", () => {
  it("is true for a Z state only", () => {
    expect(isZombie(proc(1, 1, 1, { stat: "Z+" }))).toBe(true);
    expect(isZombie(proc(1, 1, 1, { stat: "S" }))).toBe(false);
  });
});

describe("collectTree", () => {
  const leader = 100;

  it("takes the process group and everything below it", () => {
    const table = [
      proc(100, 1, 100),
      proc(101, 100, 100),
      proc(102, 101, 100),
      proc(500, 1, 500),
    ];
    const tree = collectTree(table, leader, new Set());
    expect(tree.map((p) => p.pid).sort()).toEqual([100, 101, 102]);
  });

  it("follows the parent chain out of the group (setsid)", () => {
    const table = [
      proc(100, 1, 100),
      proc(101, 100, 101), // escaped: own group
      proc(102, 101, 101), // below the escaped one
      proc(500, 1, 500),
    ];
    const tree = collectTree(table, leader, new Set());
    expect(tree.map((p) => p.pid).sort()).toEqual([100, 101, 102]);
  });

  it("keeps a process seen earlier after its parent is gone", () => {
    const escaped = proc(101, 1, 101);
    const table = [escaped, proc(500, 1, 500)];
    expect(collectTree(table, leader, new Set()).map((p) => p.pid)).toEqual([]);
    expect(
      collectTree(table, leader, new Set([procKey(escaped)])).map((p) => p.pid),
    ).toEqual([101]);
  });

  it("does not take a reused pid: the start time is part of the identity", () => {
    const seen = proc(101, 1, 101);
    const reused = proc(101, 1, 101, { started: "Thu Oct 15 11:11:11 2026" });
    expect(collectTree([reused], leader, new Set([procKey(seen)]))).toEqual([]);
  });

  it("leaves zombies out", () => {
    const table = [proc(100, 1, 100), proc(101, 100, 100, { stat: "Z" })];
    expect(collectTree(table, leader, new Set()).map((p) => p.pid)).toEqual([
      100,
    ]);
  });
});

describe("guardExitCode", () => {
  it("maps each outcome to its own code and passes the command's code through", () => {
    expect(guardExitCode("timeout", 137)).toBe(124);
    expect(guardExitCode("rss_cap", 137)).toBe(123);
    expect(guardExitCode("leftover", 0)).toBe(122);
    expect(guardExitCode("aborted", 137)).toBe(130);
    expect(guardExitCode("none", 0)).toBe(0);
    expect(guardExitCode("child_exit", 7)).toBe(7);
    expect(guardExitCode("child_exit", null)).toBe(1);
    expect(guardExitCode("ps_unavailable", null)).toBe(2);
    expect(guardExitCode("spawn_failed", null)).toBe(2);
  });
});
