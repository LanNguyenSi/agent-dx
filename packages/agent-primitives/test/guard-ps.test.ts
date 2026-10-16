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
  TAIL_MAX_RUNS,
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

  it("lets the spaces that end the tail be missing: Linux `ps` drops the empty last arguments, separators included", () => {
    // An empty last argument leaves the tail ending in a space; procps prints
    // the command line without it, BSD `ps` with it.
    const tail = " sh sleep 5 ";
    expect(endsWithTail("x sh sleep 5 ", tail)).toBe(true);
    expect(endsWithTail("x sh sleep 5", tail)).toBe(true);
    // Two empty last arguments: both separators may be missing, or only one.
    const two = " sh sleep 5  ";
    expect(endsWithTail("x sh sleep 5  ", two)).toBe(true);
    expect(endsWithTail("x sh sleep 5 ", two)).toBe(true);
    expect(endsWithTail("x sh sleep 5", two)).toBe(true);
    // A last argument that ends in a space keeps it; only the separators of
    // the empty arguments after it go.
    const spaced = " sh sleep 5 x  ";
    expect(endsWithTail("y sh sleep 5 x ", spaced)).toBe(true);
    expect(endsWithTail("y sh sleep 5 x", spaced)).toBe(true);
    // The text before the spaces still has to match, and no more spaces than
    // the tail has are accepted.
    expect(endsWithTail("x sh sleep 6", tail)).toBe(false);
    expect(endsWithTail("x sh sleep 5  ", tail)).toBe(false);
    expect(endsWithTail("x sh sleep 55", tail)).toBe(false);
    expect(endsWithTail("x sh sleep 5x", tail)).toBe(false);
    expect(endsWithTail("x sh sleep 5", " sh sleep 5")).toBe(true);
    expect(endsWithTail("x sh sleep 5 ", " sh sleep 5")).toBe(false);
    // Next to a run of characters outside printable ASCII.
    const run = " sh cmd x\n ";
    expect(endsWithTail("x sh cmd x ", run)).toBe(true);
    expect(endsWithTail("x sh cmd x", run)).toBe(true);
    expect(endsWithTail("x sh cmd y", run)).toBe(false);
  });

  it("takes time linear in the command line when the tail ends in many spaces: many empty last arguments", () => {
    const tail = ` sh cmd ${"a".repeat(100_000)}${" ".repeat(100_000)}`;
    const command = `x sh cmd ${"a".repeat(100_000)}`;
    const started = performance.now();
    expect(endsWithTail(command, tail)).toBe(true);
    expect(endsWithTail(`${command}b`, tail)).toBe(false);
    expect(endsWithTail(`${command}${" ".repeat(100_000)}`, tail)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("takes time linear in the command line, whatever the number of runs: a `?` per byte rendering of 200 runs", () => {
    // Linux prints one `?` per byte: a two-byte letter becomes `??`. A
    // back-tracking matcher takes seconds at 34 such runs.
    const tail = ` sh cmd ${"\u00e9a".repeat(200)}`;
    const command = `x sh cmd ${"??a".repeat(200)}`;
    const started = performance.now();
    expect(endsWithTail(command, tail)).toBe(true);
    expect(endsWithTail(`${command}b`, tail)).toBe(false);
    expect(endsWithTail(command.replace(/a$/, "b"), tail)).toBe(false);
    // The same size, and no ending that matches: every window is tried.
    expect(endsWithTail(`x sh cmd ${"??b".repeat(200)}`, tail)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("matches runs next to each other, at the start of the tail, and across several windows", () => {
    // A tail that starts with a run: the match may start anywhere.
    expect(endsWithTail("anything ??ab", "\u00dcab")).toBe(true);
    expect(endsWithTail("ab", "\u00dcab")).toBe(true);
    expect(endsWithTail("aXb", "\u00dcab")).toBe(false);
    // Runs are told apart by the literals between them, each with a window.
    const two = "a\u00dcb\u00dcc";
    expect(endsWithTail("a??b??c", two)).toBe(true);
    expect(endsWithTail("a??bc", two)).toBe(true);
    expect(endsWithTail("a??d??c", two)).toBe(false);
    expect(endsWithTail("a??b??d", two)).toBe(false);
    // A one-byte run takes four characters at most, each of its windows.
    const one = "a\nb\nc";
    expect(endsWithTail("a1234b9c", one)).toBe(true);
    expect(endsWithTail("a12345b9c", one)).toBe(false);
    expect(endsWithTail("a1b1234c", one)).toBe(true);
    expect(endsWithTail("a1b12345c", one)).toBe(false);
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

/** The whole comparison, one pass over the command line per part of the tail:
 * what `endsWithTail` computed before it was bounded, with the spaces that end
 * the tail allowed to be missing (any number of them up to its own: `ps` on
 * Linux drops the empty last arguments, separators included). Kept here as
 * the oracle; it takes time quadratic in the lengths, so only small inputs. */
function wholeTailMatch(command: string, tail: string): boolean {
  let trailing = 0;
  while (trailing < tail.length && tail[tail.length - 1 - trailing] === " ") {
    trailing++;
  }
  for (let missing = 0; missing <= trailing; missing++) {
    if (exactTailMatch(command, tail.slice(0, tail.length - missing))) {
      return true;
    }
  }
  return false;
}

function exactTailMatch(command: string, tail: string): boolean {
  const parts = tail.split(/([^\x20-\x7e]+)/);
  if (parts.length === 1) return command.endsWith(tail);
  const size = command.length;
  let reachable = new Uint8Array(size + 1);
  reachable[size] = 1;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] as string;
    const next = new Uint8Array(size + 1);
    if (index % 2 === 0) {
      for (let at = part.length; at <= size; at++) {
        if (reachable[at] === 1 && command.startsWith(part, at - part.length)) {
          next[at - part.length] = 1;
        }
      }
    } else {
      const window = 4 * Buffer.byteLength(part);
      for (let at = 0; at <= size; at++) {
        for (let to = at; to <= Math.min(at + window, size); to++) {
          if (reachable[to] === 1) {
            next[at] = 1;
            break;
          }
        }
      }
    }
    reachable = next;
  }
  return reachable.includes(1);
}

/** Small deterministic generator, so a failure repeats. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function runCount(tail: string): number {
  return (tail.match(/[^\x20-\x7e]+/g) ?? []).length;
}

/** What `endsWithTail` is specified to compare: the tail itself, or, past
 * `TAIL_MAX_RUNS` runs, its end from the literal after the run that is one
 * too many. */
function comparedTail(tail: string): string {
  const parts = tail.split(/([^\x20-\x7e]+)/);
  return parts.length <= 2 * TAIL_MAX_RUNS + 1
    ? tail
    : parts.slice(-(2 * TAIL_MAX_RUNS + 1)).join("");
}

describe("endsWithTail: equivalence with the whole comparison", () => {
  // Characters of the tail: printable (two letters, so that literals repeat
  // and overlap), a space, and the non-printable kinds that make a run: a
  // newline, a tab, a two-byte, a three-byte and a four-byte character.
  const tailChars = [
    "a",
    "a",
    "b",
    " ",
    "\n",
    "\t",
    "\u00e9",
    "\u20ac",
    "\u{1f600}",
  ];
  // What `ps` can print for a byte or a run, and plain noise.
  const renderings = [
    (n: number) => "?".repeat(n),
    (n: number) => "M-C".repeat(Math.ceil(n / 2)),
    (n: number) => "\\012".repeat(n),
    () => "M^\\",
    () => "",
    () => " ",
    (n: number) => "a".repeat(n),
    (n: number) => "ab".repeat(n),
  ];

  function render(tail: string, pick: () => number): string {
    return tail.replace(/[^\x20-\x7e]+/g, (run) => {
      const fn = renderings[Math.floor(pick() * renderings.length)] as (
        n: number,
      ) => string;
      return fn(Buffer.byteLength(run));
    });
  }

  function mutate(text: string, pick: () => number): string {
    if (text.length === 0) return "a";
    const at = Math.floor(pick() * text.length);
    switch (Math.floor(pick() * 4)) {
      case 0:
        return text.slice(0, at) + text.slice(at + 1);
      case 1:
        return text.slice(0, at) + "a" + text.slice(at + 1);
      case 2:
        return text.slice(0, at) + "b" + text.slice(at);
      default:
        return text.slice(0, at) + "?" + text.slice(at);
    }
  }

  it("gives the whole comparison's answer on random tails and command lines, with every kind of rendering and one change anywhere", () => {
    const pick = lcg(20261016);
    let matches = 0;
    let misses = 0;
    for (let round = 0; round < 6000; round++) {
      const length = 1 + Math.floor(pick() * 14);
      let tail = "";
      for (let i = 0; i < length; i++) {
        tail += tailChars[Math.floor(pick() * tailChars.length)];
      }
      let command = `${"x".repeat(Math.floor(pick() * 3))}${render(tail, pick)}`;
      if (pick() < 0.7) command = mutate(command, pick);
      const expected = wholeTailMatch(command, tail);
      expect(
        endsWithTail(command, tail),
        JSON.stringify({ command, tail }),
      ).toBe(expected);
      if (expected) matches++;
      else misses++;
    }
    // Both answers occur in numbers, so the comparison tests something.
    expect(matches).toBeGreaterThan(500);
    expect(misses).toBeGreaterThan(500);
  });

  it("gives the whole comparison's answer on repeated characters, where literals overlap and many positions are reachable", () => {
    const pick = lcg(7);
    const sizes = [0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 17, 33];
    for (const left of sizes) {
      for (const right of [0, 1, 2, 5]) {
        for (const run of ["\n", "\u00e9", "\u20ac\n"]) {
          const tail = `${"a".repeat(left)}${run}${"a".repeat(right)}`;
          for (const size of sizes) {
            for (const noise of ["", "b", "?"]) {
              const command = `${"a".repeat(size)}${noise}${"a".repeat(
                Math.floor(pick() * 3),
              )}`;
              expect(
                endsWithTail(command, tail),
                JSON.stringify({ command, tail }),
              ).toBe(wholeTailMatch(command, tail));
            }
          }
        }
      }
    }
    // A literal that is its own prefix, against text that nearly matches it.
    for (const tail of [
      "aab\n",
      "aab\naab",
      "ab\u00e9ab\u00e9ab",
      "aaab\naaab",
    ]) {
      for (const command of [
        "aaab",
        "aaaab??aab",
        "aab?aab",
        "aabaab",
        "aaabaaab",
        "aaaabaaab",
        "ab??ab??ab",
        "ab??abab",
        "aab\\012aab",
      ]) {
        expect(
          endsWithTail(command, tail),
          JSON.stringify({ command, tail }),
        ).toBe(wholeTailMatch(command, tail));
      }
    }
  });

  it("compares the end of a tail with more than the cap of runs, and a match of the whole tail is always a match", () => {
    const pick = lcg(99);
    const cap = TAIL_MAX_RUNS;
    let past = 0;
    for (let round = 0; round < 400; round++) {
      // From a few runs below the cap to well above it.
      const runs = cap - 3 + Math.floor(pick() * 12);
      let tail = ` sh ${"q".repeat(Math.floor(pick() * 3))}`;
      for (let i = 0; i < runs; i++) {
        tail += `${pick() < 0.5 ? "\u00e9" : "\n"}${pick() < 0.5 ? "a" : "ab"}`;
      }
      expect(runCount(tail)).toBe(runs);
      let command = `x sh ${render(tail.slice(4), pick)}`;
      if (pick() < 0.5) command = mutate(command, pick);
      const answer = endsWithTail(command, tail);
      // The answer is the whole comparison's on the part of the tail that is
      // compared, and so it is `true` wherever the whole tail matches.
      expect(answer, JSON.stringify({ command, tail })).toBe(
        wholeTailMatch(command, comparedTail(tail)),
      );
      if (wholeTailMatch(command, tail)) expect(answer).toBe(true);
      if (runs <= cap) {
        expect(answer, JSON.stringify({ command, tail })).toBe(
          wholeTailMatch(command, tail),
        );
      } else past++;
    }
    expect(past).toBeGreaterThan(100);
  });

  for (const [label, runFirst, runChars] of [
    ["a run and then a letter, runs of one character", true, 1],
    ["a letter and then a run, runs of one character", false, 1],
    ["a run and then a letter, runs of three characters", true, 3],
    ["a letter and then a run, runs of three characters", false, 3],
  ] as const) {
    it(`compares exactly the last TAIL_MAX_RUNS runs, for ${label}: a difference before them is not seen, one inside them is`, () => {
      const letter = (i: number) => String.fromCharCode(97 + (i % 20));
      const run = "\u00e9".repeat(runChars);
      const shown = "?".repeat(2 * runChars);
      const unitLength = shown.length + 1;
      const letterAt = runFirst ? shown.length : 0;
      const body = (to: number) => {
        let text = "";
        for (let i = 0; i < to; i++) {
          text += runFirst ? `${run}${letter(i)}` : `${letter(i)}${run}`;
        }
        return text;
      };
      const rendered = (to: number) => {
        let text = "";
        for (let i = 0; i < to; i++) {
          text += runFirst ? `${shown}${letter(i)}` : `${letter(i)}${shown}`;
        }
        return text;
      };
      // `Z` for the letter of unit `at`.
      const broken = (to: number, at: number) => {
        const good = rendered(to);
        const pos = at * unitLength + letterAt;
        return `x sh ${good.slice(0, pos)}Z${good.slice(pos + 1)}`;
      };
      const total = TAIL_MAX_RUNS + 5;
      const tail = ` sh ${body(total)}`;
      expect(runCount(tail)).toBe(total);
      expect(endsWithTail(`x sh ${rendered(total)}`, tail)).toBe(true);
      // The comparison starts at the first literal after the run that is one
      // too many: with the run first, the letter of the unit before the first
      // one that is kept; with the letter first, the letter of that unit.
      const first = total - TAIL_MAX_RUNS;
      const lastUnseen = runFirst ? first - 2 : first - 1;
      expect(endsWithTail(broken(total, 0), tail)).toBe(true);
      expect(endsWithTail(broken(total, lastUnseen), tail)).toBe(true);
      expect(endsWithTail(broken(total, lastUnseen + 1), tail)).toBe(false);
      expect(endsWithTail(broken(total, total - 1), tail)).toBe(false);
      // The whole comparison tells the broken one apart; this is the limit.
      expect(wholeTailMatch(broken(total, lastUnseen), tail)).toBe(false);
      // At the cap itself nothing is left out.
      const atCap = ` sh ${body(TAIL_MAX_RUNS)}`;
      expect(runCount(atCap)).toBe(TAIL_MAX_RUNS);
      expect(endsWithTail(broken(TAIL_MAX_RUNS, 0), atCap)).toBe(false);
      expect(endsWithTail(`x sh ${rendered(TAIL_MAX_RUNS)}`, atCap)).toBe(true);
      // One run more than the cap leaves out the first literal.
      const over = ` sh ${body(TAIL_MAX_RUNS + 1)}`;
      expect(endsWithTail(broken(TAIL_MAX_RUNS + 1, 0), over)).toBe(!runFirst);
    });
  }

  it("counts a space or a tilde as printable and a control character or DEL as not, whatever its place in the tail: the boundaries of what makes a run", () => {
    // `ps` prints a command line as `x sh other ...`; the tail says `prog`.
    // The difference is before the last TAIL_MAX_RUNS runs when the
    // separators make runs, and inside the part that is compared when they
    // do not (a printable separator is no run, however many there are).
    const printed = (tail: string) =>
      `x${tail
        .replace(/[^\x20-\x7e]+/g, (run) => "?".repeat(Buffer.byteLength(run)))
        .replace("prog", "other")}`;
    for (const [label, separator, makesRuns] of [
      ["a space", " ", false],
      ["a tilde", "~", false],
      ["a character below the space", "\u001f", true],
      ["DEL", "\u007f", true],
    ] as const) {
      let tail = " sh prog \u00e9";
      for (let i = 0; i < 2 * TAIL_MAX_RUNS + 8; i++) {
        tail += `${separator}w${i}`;
      }
      const command = printed(tail);
      expect(runCount(tail) <= TAIL_MAX_RUNS, label).toBe(!makesRuns);
      // The whole comparison sees the difference in every one of them.
      expect(wholeTailMatch(command, tail), label).toBe(false);
      expect(endsWithTail(command, tail), label).toBe(makesRuns);
      // The same tail with the difference removed matches, as it must.
      expect(endsWithTail(printed(tail).replace("other", "prog"), tail)).toBe(
        true,
      );
    }
    // The table case that found the boundary: one run, more than the cap of
    // spaces after it.
    const words = Array.from({ length: 40 }, (_, i) => `w${i + 1}`).join(" ");
    expect(
      endsWithTail(`x sh other ?? ${words}`, ` sh prog \u00e9 ${words}`),
    ).toBe(false);
    expect(
      endsWithTail(`x sh prog ?? ${words}`, ` sh prog \u00e9 ${words}`),
    ).toBe(true);
  });

  it("ends a run at the character after it, whatever that character is, as long as it is printable: a space or a tilde after each of more runs than the cap", () => {
    for (const next of [" ", "~", "w"]) {
      let tail = " sh prog ";
      for (let i = 0; i < TAIL_MAX_RUNS + 8; i++) tail += `\u00e9${next}`;
      expect(runCount(tail)).toBe(TAIL_MAX_RUNS + 8);
      const command = `x sh other ${"??"}${next}`.concat(
        `??${next}`.repeat(TAIL_MAX_RUNS + 7),
      );
      expect(wholeTailMatch(command, tail), JSON.stringify(next)).toBe(false);
      expect(endsWithTail(command, tail), JSON.stringify(next)).toBe(true);
      // A difference in the printable character after the last run is seen.
      // A space there may be missing, so changing it is no difference.
      const inside = `${command.slice(0, -1)}!`;
      expect(endsWithTail(inside, tail), JSON.stringify(next)).toBe(
        next === " ",
      );
    }
  });

  it("gives the answer of the compared end of a long tail, on tails of up to 120 characters with many spaces and tildes, a change anywhere", () => {
    const pick = lcg(424242);
    const printable = ["a", "b", " ", " ", " ", "~", "~"];
    const unprintable = ["\n", "\u00e9", "\u001f", "\u007f"];
    let manyPrintable = 0;
    let past = 0;
    let matches = 0;
    let misses = 0;
    for (let round = 0; round < 5000; round++) {
      const length = 1 + Math.floor(pick() * 120);
      const units = pick() < 0.4;
      // How many of the characters are outside printable ASCII varies from
      // round to round, so that both many spaces and many runs occur; in
      // some rounds every run is followed by one or two printable ones, so
      // that the runs do not merge and there can be more than the cap.
      const share = 0.05 + pick() * 0.6;
      let tail = "";
      while (tail.length < length) {
        if (units) {
          tail += unprintable[Math.floor(pick() * unprintable.length)];
          for (let n = 1 + Math.floor(pick() * 2); n > 0; n--) {
            tail += printable[Math.floor(pick() * printable.length)];
          }
          continue;
        }
        const kinds = pick() < share ? unprintable : printable;
        tail += kinds[Math.floor(pick() * kinds.length)];
      }
      // Mostly changes in the first half, which the cap can leave out.
      let command = `${"x".repeat(Math.floor(pick() * 3))}${render(tail, pick)}`;
      if (pick() < 0.7) command = mutate(command, pick);
      const answer = endsWithTail(command, tail);
      expect(answer, JSON.stringify({ command, tail })).toBe(
        wholeTailMatch(command, comparedTail(tail)),
      );
      if (wholeTailMatch(command, tail)) expect(answer).toBe(true);
      if (runCount(tail) <= TAIL_MAX_RUNS) {
        expect(answer, JSON.stringify({ command, tail })).toBe(
          wholeTailMatch(command, tail),
        );
        if ((tail.match(/[ ~]/g) ?? []).length > TAIL_MAX_RUNS) manyPrintable++;
      } else past++;
      if (answer) matches++;
      else misses++;
    }
    // The cases that matter occur: more spaces and tildes than the cap but
    // not more runs, and more runs than the cap; and both answers.
    expect(manyPrintable).toBeGreaterThan(100);
    expect(past).toBeGreaterThan(100);
    expect(matches).toBeGreaterThan(200);
    expect(misses).toBeGreaterThan(200);
  });

  it("finds a literal wherever it occurs, however it overlaps itself", () => {
    // Letters from two, so that a literal is its own prefix and its own
    // suffix in many ways, and the text has near matches everywhere.
    const pick = lcg(31);
    const word = (max: number, letters: string) => {
      let text = "";
      for (let i = 1 + Math.floor(pick() * max); i > 0; i--) {
        text += letters[Math.floor(pick() * letters.length)];
      }
      return text;
    };
    let hits = 0;
    for (let round = 0; round < 6000; round++) {
      const tail = `${word(9, "ab")}\n${word(3, "ab")}\u00e9${word(9, "ab")}`;
      // Half of them are the tail as `ps` could print it, with letters of
      // the same two kinds in front, the other half are noise.
      const command =
        pick() < 0.5
          ? word(40, "aab?")
          : `${word(12, "ab")}${tail.replace(/[^\x20-\x7e]+/g, () =>
              "?".repeat(Math.floor(pick() * 4)),
            )}`;
      const expected = wholeTailMatch(command, tail);
      expect(
        endsWithTail(command, tail),
        JSON.stringify({ command, tail }),
      ).toBe(expected);
      if (expected) hits++;
    }
    expect(hits).toBeGreaterThan(100);
  });
});

describe("endsWithTail: cost", () => {
  // Arguments from a reported case: a letter outside ASCII followed by a
  // letter, repeated; two-byte letters make 3 bytes a pair, so 16000 pairs
  // are 48 KB and 32000 are 96 KB. The bound is generous: the work takes
  // milliseconds, and the quadratic comparison took seconds.
  for (const pairs of [16_000, 32_000]) {
    it(`matches the ending of ${pairs * 3} bytes of non-ASCII arguments, as macOS and as Linux print them, and rejects a wrong one, each in well under a second`, () => {
      const tail = ` sh sleep ${"\u00e9a".repeat(pairs)}`;
      const mac = `/bin/sh -c script sh sleep ${"M-CM-)a".repeat(pairs)}`;
      const linux = `/bin/sh -c script sh sleep ${"??a".repeat(pairs)}`;
      const cases: [string, boolean][] = [
        [mac, true],
        [linux, true],
        [`${linux}b`, false],
        [linux.replace(/a$/, "b"), false],
        [linux.replace(/\?\?a$/, "?a"), true],
        [`x sh sleep ${"??b".repeat(pairs)}`, false],
        // The text before the compared end is not looked at.
        [`/bin/sh -c script sh sleep Z${linux.slice(25)}`, true],
      ];
      for (const [command, expected] of cases) {
        const started = performance.now();
        expect(endsWithTail(command, tail)).toBe(expected);
        expect(performance.now() - started).toBeLessThan(1000);
      }
    });
  }

  it("takes no time for runs that are each followed by a space: more than the cap of them, 20000 of them", () => {
    const tail = ` sh prog ${"\u00e9 ".repeat(20_000)}`;
    const mac = `x sh prog ${"M-CM-) ".repeat(20_000)}`;
    const linux = `x sh prog ${"?? ".repeat(20_000)}`;
    const started = performance.now();
    expect(endsWithTail(mac, tail)).toBe(true);
    expect(endsWithTail(linux, tail)).toBe(true);
    expect(endsWithTail(`${linux}${"b".repeat(12)}`, tail)).toBe(false);
    expect(endsWithTail(`x sh other ${"?? ".repeat(20_000)}`, tail)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("takes no time for a long literal next to a wide window: the literal is found in one pass, not compared at each position", () => {
    // 45000 letters, a run of 20000 two-byte characters (a window wider than
    // the command), then a letter. Every position is reachable at the literal,
    // and comparing it there is 45000 steps each.
    const literal = "a".repeat(45_000);
    const tail = `${literal}${"\u00e9".repeat(20_000)}a`;
    const command = "a".repeat(100_000);
    let started = performance.now();
    expect(endsWithTail(command, tail)).toBe(true);
    expect(endsWithTail(`${"a".repeat(30_000)}`, tail)).toBe(false);
    expect(endsWithTail(`${"a".repeat(99_999)}b`, tail)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    // The same with a literal that has to back off at nearly every step.
    const hard = `${"a".repeat(44_999)}b`;
    started = performance.now();
    expect(
      endsWithTail("a".repeat(100_000), `${hard}${"\u00e9".repeat(20_000)}a`),
    ).toBe(false);
    expect(
      endsWithTail(
        `${"a".repeat(54_000)}${hard}${"a".repeat(500)}`,
        `${hard}${"\u00e9".repeat(100)}a`,
      ),
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
