import { describe, expect, it } from "vitest";
import {
  isZombie,
  parsePs,
  procKey,
  readProcesses,
  type ProcInfo,
} from "../src/guard/ps.js";
import {
  accountTerminal,
  captureOrphanedWatcher,
  captureOwn,
  collectTree,
  endsWithTail,
  guardExitCode,
  isOwnProcess,
  type OwnIdentities,
} from "../src/guard/index.js";

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
    expect(guardExitCode("leftover_check_failed", 0)).toBe(2);
    expect(guardExitCode("aborted", 137)).toBe(130);
    expect(guardExitCode("none", 0)).toBe(0);
    expect(guardExitCode("child_exit", 7)).toBe(7);
    expect(guardExitCode("child_exit", null)).toBe(1);
    expect(guardExitCode("ps_unavailable", null)).toBe(2);
    expect(guardExitCode("spawn_failed", null)).toBe(2);
  });
});

describe("captureOwn, captureOrphanedWatcher and isOwnProcess", () => {
  const leader = 100;
  const tramp = "/bin/sh -c { set +aemvx; } 2>/dev/null\\012unset -f command";
  const trampoline = proc(100, 50, 100, { command: tramp });
  const watcher = proc(101, 100, 100, { command: tramp });
  /** Learned from the same table seen twice. */
  function learned(table: ProcInfo[]): OwnIdentities {
    const own: OwnIdentities = {};
    captureOwn(table, leader, own);
    captureOwn(table, leader, own);
    return own;
  }

  it("learns the watcher once two tables showed it as the one child of the live leader with the leader's text", () => {
    const own: OwnIdentities = {};
    const table = [trampoline, watcher, proc(102, 100, 100)];
    captureOwn(table, leader, own);
    expect(own.watcher).toBeUndefined();
    captureOwn(table, leader, own);
    expect(own).toMatchObject({
      leader: procKey(trampoline),
      watcher: procKey(watcher),
    });
  });

  it("learns no watcher from a table with two such children (the command between fork and exec)", () => {
    const forked = proc(102, 100, 100, { command: tramp });
    expect(learned([trampoline, watcher, forked]).watcher).toBeUndefined();
  });

  it("does not confirm a candidate that a later table shows as another process", () => {
    const own: OwnIdentities = {};
    const forked = proc(102, 100, 100, { command: tramp });
    // The command caught alone before its exec, then the watcher alone.
    captureOwn([trampoline, forked], leader, own);
    captureOwn([trampoline, watcher], leader, own);
    expect(own.watcher).toBeUndefined();
    captureOwn([trampoline, watcher], leader, own);
    expect(own.watcher).toBe(procKey(watcher));
  });

  it("learns no watcher while the leader's own text cannot be read", () => {
    // ps shows a process it cannot read the arguments of as "(name)"; a child
    // caught between fork and exec shows the same.
    const unreadable = { ...trampoline, command: "(bash)" };
    const forked = proc(102, 100, 100, { command: "(bash)" });
    const own = learned([unreadable, watcher, forked]);
    expect(own.watcher).toBeUndefined();
    expect(own.leader).toBe(procKey(trampoline));
  });

  it("learns nothing without the live leader", () => {
    expect(learned([watcher])).toEqual({});
    expect(learned([{ ...trampoline, stat: "Z" }, watcher])).toEqual({});
  });

  it("learns the orphaned watcher of a killed trampoline: the one group member with its text and a parent outside the tree", () => {
    const orphan = { ...watcher, ppid: 1 };
    const own: OwnIdentities = {};
    captureOrphanedWatcher([orphan, proc(1, 0, 1)], leader, new Set(), own);
    expect(own.watcher).toBe(procKey(orphan));
    expect(isOwnProcess(orphan, leader, own)).toBe(true);
  });

  it("learns no orphaned watcher from two candidates, or from one whose parent is in the tree", () => {
    const orphan = { ...watcher, ppid: 1 };
    const decoy = proc(102, 1, 100, { command: `${tramp.slice(0, 26)} x` });
    const two: OwnIdentities = {};
    captureOrphanedWatcher([orphan, decoy], leader, new Set(), two);
    expect(two.watcher).toBeUndefined();
    const child = proc(103, 104, 100, { command: tramp });
    const parented: OwnIdentities = {};
    captureOrphanedWatcher(
      [child, proc(104, 1, 100)],
      leader,
      new Set(),
      parented,
    );
    expect(parented.watcher).toBeUndefined();
  });

  it("records the trampoline's full text from the first table that shows it readable", () => {
    const own: OwnIdentities = {};
    captureOwn([{ ...trampoline, command: "(sh)" }], leader, own);
    expect(own.leaderCommand).toBeUndefined();
    captureOwn([trampoline], leader, own);
    expect(own.leaderCommand).toBe(tramp);
    captureOwn([{ ...trampoline, command: `${tramp} later` }], leader, own);
    expect(own.leaderCommand).toBe(tramp);
  });

  it("takes an orphan for the watcher only if its text is exactly the recorded trampoline text", () => {
    const own: OwnIdentities = { leaderCommand: tramp };
    const impostor = proc(102, 1, 100, { command: `${tramp} impostor` });
    captureOrphanedWatcher([impostor], leader, new Set(), own);
    expect(own.watcher).toBeUndefined();
    // With the real watcher beside it the impostor does not make it two.
    const orphan = { ...watcher, ppid: 1 };
    captureOrphanedWatcher([impostor, orphan], leader, new Set(), own);
    expect(own.watcher).toBe(procKey(orphan));
    expect(isOwnProcess(impostor, leader, own)).toBe(false);
  });

  it("without a recorded text, an orphan has to end like the trampoline's command line too", () => {
    const tail = " sh sleep 5";
    const impostor = proc(102, 1, 100, { command: `${tramp} impostor` });
    const without: OwnIdentities = { commandTail: tail };
    captureOrphanedWatcher([impostor], leader, new Set(), without);
    expect(without.watcher).toBeUndefined();
    const orphan = proc(101, 1, 100, { command: `${tramp}${tail}` });
    captureOrphanedWatcher([impostor, orphan], leader, new Set(), without);
    expect(without.watcher).toBe(procKey(orphan));
  });

  it("takes an orphan whose arguments `ps` printed escaped for the watcher, on both platforms' escapes", () => {
    const base = "/bin/sh -c { set +aemvx; } 2>/dev/null\\012unset -f command";
    const tail = " sh sleep 5 \u00dcbung\n";
    for (const shown of [
      " sh sleep 5 M-CM^\\bung\\012", // macOS
      " sh sleep 5 ??bung ", // Linux
    ]) {
      const own: OwnIdentities = { commandTail: tail };
      const orphan = proc(101, 1, 100, { command: `${base}${shown}` });
      captureOrphanedWatcher([orphan], leader, new Set(), own);
      expect(own.watcher).toBe(procKey(orphan));
    }
  });

  it("knows the watcher by identity after it lost its parent", () => {
    const own = learned([trampoline, watcher]);
    const orphan = { ...watcher, ppid: 1 };
    expect(isOwnProcess(orphan, leader, own)).toBe(true);
    // Without the identity, its place no longer marks it.
    expect(isOwnProcess(orphan, leader, {})).toBe(false);
  });

  it("falls back to the place only while no identity is known", () => {
    expect(isOwnProcess(trampoline, leader, {})).toBe(true);
    expect(isOwnProcess(watcher, leader, {})).toBe(true);
    const decoy = proc(103, 100, 100, { command: `${tramp.slice(0, 26)} x` });
    expect(isOwnProcess(decoy, leader, {})).toBe(true);
    const own = learned([trampoline, watcher]);
    expect(isOwnProcess(decoy, leader, own)).toBe(false);
    // A pid reused after the trampoline is gone is not the trampoline.
    const reused = { ...trampoline, started: "Thu Oct 15 11:11:11 2026" };
    expect(isOwnProcess(reused, leader, own)).toBe(false);
  });

  it("never takes a process without the trampoline's text by place", () => {
    expect(isOwnProcess(proc(101, 100, 100), leader, {})).toBe(false);
  });
});

describe("accountTerminal", () => {
  const own = (p: ProcInfo): boolean => p.pid === 100;
  const a = proc(201, 100, 100);
  const b = proc(202, 1, 202);
  const c = proc(203, 202, 202);

  it("after a limit: everything killed is listed once under killed, nothing under leftovers", () => {
    const r = accountTerminal({
      limited: true,
      atLimit: [proc(100, 1, 100), a, b],
      after: [b, c],
      survivors: [],
      isOwn: own,
    });
    expect(r.killed.map((p) => p.pid)).toEqual([201, 202, 203]);
    expect(r.leftovers).toEqual([]);
  });

  it("after an exit of the command's own accord: what was found is listed under leftovers", () => {
    const r = accountTerminal({
      limited: false,
      atLimit: [],
      after: [a, b, a],
      survivors: [b],
      isOwn: own,
    });
    expect(r.killed).toEqual([]);
    expect(r.leftovers.map((p) => p.pid)).toEqual([201, 202]);
    expect(r.survivors.map((p) => p.pid)).toEqual([202]);
  });

  it("leaves guard's own processes out of every list", () => {
    const mine = proc(100, 1, 100);
    const r = accountTerminal({
      limited: false,
      atLimit: [],
      after: [mine],
      survivors: [mine],
      isOwn: own,
    });
    expect(r).toEqual({ killed: [], leftovers: [], survivors: [] });
  });
});

describe("endsWithTail", () => {
  it("is an exact ending when the tail is printable ASCII", () => {
    expect(endsWithTail("x -c script sh sleep 5", " sh sleep 5")).toBe(true);
    expect(endsWithTail("x -c script sh sleep 50", " sh sleep 5")).toBe(false);
    expect(endsWithTail("x -c script sh sleep 5 more", " sh sleep 5")).toBe(
      false,
    );
    expect(endsWithTail("x sh sleep 5", ".*")).toBe(false);
  });

  it("lets a run of characters outside printable ASCII stand for what `ps` printed for it", () => {
    const tail = " sh cmd \u00dcbung\n";
    // macOS (octal and meta escapes) and Linux (`?` per byte, a space).
    expect(endsWithTail("x sh cmd M-CM^\\bung\\012", tail)).toBe(true);
    expect(endsWithTail("x sh cmd ??bung ", tail)).toBe(true);
    // Nothing printed for it at all (a trimmed line).
    expect(endsWithTail("x sh cmd bung", tail)).toBe(true);
    // The printable characters around the run still have to match.
    expect(endsWithTail("x sh cmd ??bunk ", tail)).toBe(false);
    expect(endsWithTail("x sh cmd2 ??bung ", tail)).toBe(false);
    expect(endsWithTail("x sh cmd ??bung and more", tail)).toBe(false);
  });

  it("allows four characters per byte of the run and no more", () => {
    // One newline is one byte: up to four characters, such as `\\012`.
    expect(endsWithTail("sh a \\012", "sh a \n")).toBe(true);
    expect(endsWithTail("sh a \\0123", "sh a \n")).toBe(false);
    // A two-byte character: up to eight.
    expect(endsWithTail("sh a M-CM^\\", "sh a \u00dc")).toBe(true);
    expect(endsWithTail("sh a 123456789", "sh a \u00dc")).toBe(false);
  });
});
