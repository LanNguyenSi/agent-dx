import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { guard, type GuardOptions } from "../src/guard/index.js";
import { isZombie, readProcesses } from "../src/guard/ps.js";
import { CLI_PATH } from "./helpers/spawn-cli.js";

/**
 * `guard` runs real children, so every case here is bounded twice: by the
 * limits it passes to `guard` and by the test timeout, and each marker a case
 * starts (a distinctive `sleep` length or an extra argument) is searched for
 * in the process table afterwards and killed if it is still there, so a
 * failing case cannot leave a runaway behind.
 */
vi.setConfig({ testTimeout: 60_000 });

const tmpDirs: string[] = [];
const markers: string[] = [];

/** Part of every fixture's command line, so two suite runs at the same time
 * (another checkout, a second worker) never see each other's fixtures. */
const NONCE = String(process.pid);

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-guard-"));
  tmpDirs.push(dir);
  return dir;
}

/** A `sleep` fixture: short but distinctive (`sleep 60.<id><nonce>`), and
 * registered for cleanup HERE, before anything starts it, so an assertion
 * that fails early still has its fixture killed afterwards. */
function fx(id: number): { arg: string; cmd: string } {
  const arg = `60.${id}${NONCE}`;
  const cmd = `sleep ${arg}`;
  markers.push(cmd);
  return { arg, cmd };
}

/** A distinctive last argument for a node child (`<name>-<nonce>`), also
 * registered up front. */
function tag(name: string): string {
  const value = `${name}-${NONCE}`;
  markers.push(value);
  return value;
}

/** Registers a whole command line that a fixture will show. */
function register(command: string): string {
  markers.push(command);
  return command;
}

/** Processes whose command line IS `marker` (a `sleep` with a distinctive
 * length) or ENDS with it (a node child given a distinctive last argument).
 * A match anywhere in the line would also catch the shell or runner that
 * started this suite when its own command text mentions the marker. The
 * marker must have been registered (`fx`, `tag`, `register`). */
function marked(marker: string): { pid: number; command: string }[] {
  return (readProcesses() ?? []).filter(
    (p) =>
      !isZombie(p) &&
      (p.command === marker || p.command.endsWith(` ${marker}`)),
  );
}

/** Processes whose whole command line is exactly `command`. */
function exactly(command: string): { pid: number }[] {
  return (readProcesses() ?? []).filter(
    (p) => !isZombie(p) && p.command === command,
  );
}

function killMarked(): void {
  for (const marker of markers) {
    for (const p of marked(marker)) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
}

afterEach(killMarked);
afterAll(() => {
  killMarked();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function run(
  command: string,
  args: string[],
  over: Partial<GuardOptions> = {},
) {
  const dir = tmp();
  return guard({
    command,
    args,
    timeoutMs: 20_000,
    maxRssMiB: 4096,
    pollMs: 100,
    cwd: dir,
    logDir: dir,
    runId: "t",
    ...over,
  });
}

async function waitFor(
  ready: () => boolean,
  limitMs: number,
): Promise<boolean> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (ready()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return ready();
}

describe("guard: no limit fires", () => {
  it("passes a command that succeeds, with its output in the log", async () => {
    const r = await run("sh", ["-c", "echo hello; exit 0"]);
    expect(r.status).toBe("pass");
    expect(r.reason).toBe("none");
    expect(r.exitCode).toBe(0);
    expect(r.outputTail).toContain("hello");
    expect(r.leftoverCount).toBe(0);
    expect(r.survivorCount).toBe(0);
    expect(r.leftoverCheckFailed).toBe(false);
  });

  it("passes the command's own exit code through", async () => {
    const r = await run("sh", ["-c", "exit 7"]);
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("child_exit");
    expect(r.childExitCode).toBe(7);
    expect(r.exitCode).toBe(7);
  });

  it("reports a command that does not exist as the shell does, 127", async () => {
    const r = await run("agent-primitives-no-such-command", []);
    expect(r.reason).toBe("child_exit");
    expect(r.exitCode).toBe(127);
  });
});

describe("guard: wall-clock timeout", () => {
  it("kills a sleeping child at the timeout, exit 124", async () => {
    const s = fx(7101);
    const t0 = Date.now();
    const r = await run("sleep", [s.arg], { timeoutMs: 1000 });
    const took = Date.now() - t0;
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("timeout");
    expect(r.exitCode).toBe(124);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(15_000);
    expect(r.killed.map((p) => p.command)).toContain(s.cmd);
    // The trampoline and its watcher are in the group but are not the
    // caller's processes: they are not reported.
    expect(r.killed.some((p) => p.command.includes("set +aemvx"))).toBe(false);
    expect(marked(s.cmd)).toEqual([]);
  });

  it("kills the whole group: a child's own children die with it", async () => {
    const a = fx(7102);
    const b = fx(7103);
    const r = await run(
      "sh",
      ["-c", `sleep ${a.arg} & sleep ${b.arg} & wait`],
      {
        timeoutMs: 1000,
      },
    );
    expect(r.reason).toBe("timeout");
    expect(r.exitCode).toBe(124);
    expect(r.killedCount).toBeGreaterThanOrEqual(2);
    expect(marked(a.cmd)).toEqual([]);
    expect(marked(b.cmd)).toEqual([]);
  });
});

describe("guard: memory cap", () => {
  const hog = "const a=[];setInterval(()=>{a.push(Buffer.alloc(8<<20,1))},20)";

  it("kills a memory-hungry child at the cap, exit 123", async () => {
    const t = tag("hog-7110");
    const r = await run(process.execPath, ["-e", hog, t], {
      maxRssMiB: 128,
      timeoutMs: 30_000,
      pollMs: 50,
    });
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("rss_cap");
    expect(r.exitCode).toBe(123);
    expect(r.peakRssMiB).toBeGreaterThan(128);
    expect(r.durationMs).toBeLessThan(25_000);
    expect(r.killed.some((p) => p.command.includes(t))).toBe(true);
    expect(marked(t)).toEqual([]);
  });

  it("caps the SUM over the tree: two children each under the cap are still over it", async () => {
    // Each worker holds about 60 MiB on top of node's own ~40; the cap is
    // 150, above either alone and below both together.
    const t = tag("sum-7111");
    const worker =
      "const a=Buffer.alloc(60<<20,1);setInterval(()=>{a[0]=1},1000)";
    const script = `${JSON.stringify(process.execPath)} -e '${worker}' ${t} & ${JSON.stringify(process.execPath)} -e '${worker}' ${t} & wait`;
    const r = await run("sh", ["-c", script], {
      maxRssMiB: 150,
      timeoutMs: 30_000,
      pollMs: 50,
    });
    expect(r.reason).toBe("rss_cap");
    expect(r.exitCode).toBe(123);
    expect(r.peakProcessRssMiB).toBeLessThan(150);
    expect(r.peakRssMiB).toBeGreaterThan(150);
    expect(marked(t)).toEqual([]);
  });
});

describe("guard: leftovers", () => {
  it("finds, kills and reports a background child left in the group, exit 122", async () => {
    const s = fx(7104);
    const r = await run("sh", ["-c", `sleep ${s.arg} & exit 0`]);
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("leftover");
    expect(r.exitCode).toBe(122);
    expect(r.childExitCode).toBe(0);
    const entry = r.leftovers.find((p) => p.command === s.cmd);
    expect(entry).toBeDefined();
    expect(entry?.inGroup).toBe(true);
    expect(r.survivorCount).toBe(0);
    // Only the caller's process is a leftover: the trampoline and its
    // watcher are not reported.
    expect(r.leftovers.some((p) => p.command.includes("set +aemvx"))).toBe(
      false,
    );
    expect(marked(s.cmd)).toEqual([]);
  });

  it("a leftover wins over the command's own failure code", async () => {
    const s = fx(7112);
    const r = await run("sh", ["-c", `sleep ${s.arg} & exit 5`]);
    expect(r.reason).toBe("leftover");
    expect(r.childExitCode).toBe(5);
    expect(r.exitCode).toBe(122);
    expect(marked(s.cmd)).toEqual([]);
  });

  it("finds a grandchild that called setsid and left the group, while its parent was sampled", async () => {
    // node's `detached: true` is setsid. The parent stays 1.5 s so a poll
    // sees the chain; then it exits and the child is orphaned, outside the
    // group.
    const s = fx(7105);
    const script =
      "const {spawn}=require('child_process');" +
      `spawn('sleep',['${s.arg}'],{detached:true,stdio:'ignore'}).unref();` +
      "setTimeout(()=>process.exit(0),1500)";
    const r = await run(process.execPath, ["-e", script], { pollMs: 50 });
    expect(r.reason).toBe("leftover");
    expect(r.exitCode).toBe(122);
    const entry = r.leftovers.find((p) => p.command === s.cmd);
    expect(entry).toBeDefined();
    expect(entry?.inGroup).toBe(false);
    expect(marked(s.cmd)).toEqual([]);
  });

  it("kills an escaped (setsid) descendant at a limit too", async () => {
    const s = fx(7113);
    const script =
      "const {spawn}=require('child_process');" +
      `spawn('sleep',['${s.arg}'],{detached:true,stdio:'ignore'});` +
      "setInterval(()=>{},1000)";
    const r = await run(process.execPath, ["-e", script], {
      timeoutMs: 2000,
      pollMs: 50,
    });
    expect(r.reason).toBe("timeout");
    expect(r.killed.some((p) => p.command === s.cmd && !p.inGroup)).toBe(true);
    expect(marked(s.cmd)).toEqual([]);
  });

  it("reports a process that only LOOKS like the trampoline (same command text, not its leader or watcher)", async () => {
    // A decoy in the group whose command line starts with the trampoline's
    // text: identified by position (the group leader, or its direct child in
    // the leader's group), not by the text, so it is a leftover like any
    // other.
    const decoy = register(
      `/bin/sh -c { set +aemvx; } decoy-${NONCE} 60.7130${NONCE}`,
    );
    const script =
      "const {spawn}=require('child_process');" +
      `spawn('sleep',['60.7130${NONCE}'],{argv0:'/bin/sh -c { set +aemvx; } decoy-${NONCE}',stdio:'ignore'}).unref();` +
      "setTimeout(()=>process.exit(0),700)";
    const r = await run(process.execPath, ["-e", script]);
    expect(r.reason).toBe("leftover");
    expect(r.exitCode).toBe(122);
    expect(r.leftovers.map((p) => p.command)).toContain(decoy);
    expect(exactly(decoy)).toEqual([]);
  });

  it("still finds the leftovers when the command killed the trampoline, its parent, on the way out", async () => {
    // The trampoline's watcher outlives the trampoline and ends the group as
    // soon as guard lets go of the pipe. That must happen after the leftovers
    // were listed, not before.
    const s = fx(7131);
    const r = await run("sh", [
      "-c",
      `sleep ${s.arg} & kill -9 $PPID; sleep 0.3; exit 0`,
    ]);
    expect(r.reason).toBe("leftover");
    expect(r.exitCode).toBe(122);
    expect(r.leftovers.map((p) => p.command)).toContain(s.cmd);
    expect(marked(s.cmd)).toEqual([]);
    // Once guard has let go of the pipe the surviving watcher (it has the
    // trampoline's command line) ends the group and itself: none is left.
    const watchers = () =>
      (readProcesses() ?? []).filter(
        (p) => !isZombie(p) && p.command.includes(`sleep ${s.arg} &`),
      );
    expect(await waitFor(() => watchers().length === 0, 5000)).toBe(true);
  });
});

describe("guard: runs that cannot start", () => {
  it("refuses before running anything when ps is unavailable, exit 2", async () => {
    const s = fx(7115);
    const saved = process.env.PATH;
    process.env.PATH = tmp();
    try {
      const r = await run("sleep", [s.arg]);
      expect(r.status).toBe("error");
      expect(r.reason).toBe("ps_unavailable");
      expect(r.exitCode).toBe(2);
    } finally {
      process.env.PATH = saved;
    }
    expect(marked(s.cmd)).toEqual([]);
  });

  it("reports a working directory that does not exist as spawn_failed, exit 2", async () => {
    const s = fx(7116);
    const r = await run("sleep", [s.arg], {
      cwd: path.join(tmp(), "no-such-dir"),
    });
    expect(r.status).toBe("error");
    expect(r.reason).toBe("spawn_failed");
    expect(r.exitCode).toBe(2);
    expect(r.warnings.join(" ")).toContain("could not start");
    expect(marked(s.cmd)).toEqual([]);
  });
});

/**
 * A stand-in `ps` first on PATH that answers like the real one until the file
 * `flag` exists, then fails (exit 1, no output), the way `ps` fails under
 * fork pressure: for `fails` calls after the first `skip` calls made once the
 * flag exists. With `watch` it also appends, on each failing call, how many
 * live processes end their command line with `watch` to `observed` (one line
 * per call), so a test can see what was alive at the moment of a failed read.
 */
function installFakePs(options: {
  flag: string;
  skip?: number;
  fails: number;
  watch?: string;
  observed?: string;
}): { restore: () => void } {
  const real = spawnSync("sh", ["-c", "command -v ps"], {
    encoding: "utf8",
  }).stdout.trim();
  const dir = tmp();
  const quote = (v: string | undefined): string =>
    `'${(v ?? "").replace(/'/g, "'\\''")}'`;
  const skip = options.skip ?? 0;
  const script = `#!/bin/sh
REAL=${quote(real)}
FLAG=${quote(options.flag)}
export WATCH=${quote(options.watch)}
OBSERVED=${quote(options.observed)}
COUNT=${quote(path.join(dir, "count"))}
if [ -e "$FLAG" ]; then
  n=$(cat "$COUNT" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$COUNT"
  if [ "$n" -gt ${skip} ] && [ "$n" -le ${skip + options.fails} ]; then
    if [ -n "$WATCH" ] && [ -n "$OBSERVED" ]; then
      "$REAL" -A -o stat=,command= | awk 'BEGIN { w = ENVIRON["WATCH"] } $1 !~ /^Z/ && substr($0, length($0) - length(w) + 1) == w' | wc -l | tr -d ' ' >> "$OBSERVED"
    fi
    exit 1
  fi
fi
exec "$REAL" "$@"
`;
  fs.writeFileSync(path.join(dir, "ps"), script, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  return {
    restore: () => {
      process.env.PATH = saved;
    },
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("guard: a process table that cannot be read", () => {
  /** Runs a shell command that leaves a background `sleep` in its group and
   * exits 0.8 s after starting. The stand-in `ps` is armed once the `sleep`
   * is seen and the first poll (made at the start) is certainly over, so every
   * read after that fails or not as `ps` says. The poll interval is longer
   * than the command, so no poll falls between arming and the exit: only the
   * reads after the exit are counted. */
  async function leaveAndExit(
    s: { arg: string; cmd: string },
    ps: { skip?: number; fails: number },
  ) {
    const flag = path.join(tmp(), "flag");
    const fake = installFakePs({ flag, ...ps });
    try {
      const pending = run("sh", ["-c", `sleep ${s.arg} & sleep 0.8; exit 0`], {
        pollMs: 1500,
      });
      expect(await waitFor(() => marked(s.cmd).length > 0, 10_000)).toBe(true);
      await sleepMs(250);
      fs.writeFileSync(flag, "");
      return await pending;
    } finally {
      fake.restore();
    }
  }

  it("after the command exited: ends the group anyway, and is an error, not a pass", async () => {
    const s = fx(7120);
    const r = await leaveAndExit(s, { fails: 10_000 });
    expect(r.status).toBe("error");
    expect(r.reason).toBe("leftover_check_failed");
    expect(r.exitCode).toBe(2);
    expect(r.childExitCode).toBe(0);
    expect(r.leftoverCheckFailed).toBe(true);
    expect(r.warnings.join(" ")).toContain("could not be read after");
    expect(marked(s.cmd)).toEqual([]);
  });

  it("a read that fails once is tried again and the leftover is reported as usual", async () => {
    const s = fx(7121);
    const r = await leaveAndExit(s, { fails: 1 });
    expect(r.reason).toBe("leftover");
    expect(r.exitCode).toBe(122);
    expect(r.leftoverCheckFailed).toBe(false);
    expect(r.leftovers.map((p) => p.command)).toContain(s.cmd);
    expect(marked(s.cmd)).toEqual([]);
  });

  it("a table that stops answering during the kill sweeps is not a clean result", async () => {
    const s = fx(7123);
    // The first read after the exit works and finds the leftover; the reads
    // that should show it gone fail.
    const r = await leaveAndExit(s, { skip: 1, fails: 10_000 });
    expect(r.reason).toBe("leftover");
    expect(r.leftoverCheckFailed).toBe(true);
    expect(r.warnings.join(" ")).toContain("during the kill sweeps");
    expect(marked(s.cmd)).toEqual([]);
  });

  /** An abort with a failing `ps` from the abort on. The flag is written and
   * the abort follows in the same tick, so the limit's first read is the
   * first failure. An escapee is tracked first (polls every 50 ms). */
  async function abortWithFailingPs(id: number, fails: number) {
    const esc = fx(id);
    const grp = fx(id + 1);
    const dir = tmp();
    const flag = path.join(dir, "flag");
    const observed = path.join(dir, "observed");
    const ps = installFakePs({ flag, fails, watch: grp.cmd, observed });
    const script =
      "const {spawn}=require('child_process');" +
      `spawn('sleep',['${esc.arg}'],{detached:true,stdio:'ignore'});` +
      `spawn('sleep',['${grp.arg}'],{stdio:'ignore'});` +
      "setInterval(()=>{},1000)";
    const controller = new AbortController();
    try {
      const pending = run(process.execPath, ["-e", script], {
        pollMs: 50,
        signal: controller.signal,
      });
      expect(
        await waitFor(
          () => marked(esc.cmd).length > 0 && marked(grp.cmd).length > 0,
          10_000,
        ),
      ).toBe(true);
      await sleepMs(600);
      fs.writeFileSync(flag, "");
      controller.abort();
      const r = await pending;
      const watched = fs.existsSync(observed)
        ? fs.readFileSync(observed, "utf8").trim().split("\n")
        : [];
      return { r, esc, grp, watched };
    } finally {
      ps.restore();
    }
  }

  it("at a limit: the group is ended before the table is tried again, and the escapee is found once it answers", async () => {
    const { r, esc, grp, watched } = await abortWithFailingPs(7124, 2);
    expect(r.reason).toBe("aborted");
    expect(r.leftoverCheckFailed).toBe(false);
    expect(r.killed.some((p) => p.command === esc.cmd && !p.inGroup)).toBe(
      true,
    );
    // The first failing read saw the group alive; at the retry it was gone.
    expect(watched.slice(0, 2)).toEqual(["1", "0"]);
    expect(marked(esc.cmd)).toEqual([]);
    expect(marked(grp.cmd)).toEqual([]);
  });

  it("at a limit, with no table for the limit and the read after the exit: the group is ended, and a second look finds the escapee", async () => {
    // Eight failures: the limit's read and its three retries, then the four
    // reads after the exit; the one after the group was ended without a table
    // works.
    const { r, esc, grp } = await abortWithFailingPs(7126, 8);
    expect(r.reason).toBe("aborted");
    expect(r.leftoverCheckFailed).toBe(true);
    expect(r.warnings.join(" ")).toContain("at the limit");
    expect(r.warnings.join(" ")).toContain("after the command ended");
    expect(marked(grp.cmd)).toEqual([]);
    expect(marked(esc.cmd)).toEqual([]);
  });

  it("at a limit, with a table that never answers: the group is ended and the run says it could not check", async () => {
    const { r, grp } = await abortWithFailingPs(7128, 10_000);
    expect(r.reason).toBe("aborted");
    expect(r.leftoverCheckFailed).toBe(true);
    expect(marked(grp.cmd)).toEqual([]);
  });
});

describe("guard: abort and parent death", () => {
  it("an abort signal kills the group at once", async () => {
    const s = fx(7114);
    const controller = new AbortController();
    const pending = run("sleep", [s.arg], { signal: controller.signal });
    expect(await waitFor(() => marked(s.cmd).length > 0, 10_000)).toBe(true);
    controller.abort();
    const r = await pending;
    expect(r.reason).toBe("aborted");
    expect(r.exitCode).toBe(130);
    expect(marked(s.cmd)).toEqual([]);
  });

  it("killing guard itself with SIGKILL still ends the command (parent-death watcher)", async () => {
    const dir = tmp();
    const s = fx(7106);
    const cli = spawn(
      process.execPath,
      [CLI_PATH, "guard", "60", "4096", "--", "sleep", s.arg],
      {
        env: { ...process.env, AGENT_PRIMITIVES_LOG_DIR: dir },
        stdio: "ignore",
      },
    );
    try {
      expect(await waitFor(() => exactly(s.cmd).length > 0, 15_000)).toBe(true);
      cli.kill("SIGKILL");
      expect(await waitFor(() => exactly(s.cmd).length === 0, 15_000)).toBe(
        true,
      );
    } finally {
      cli.kill("SIGKILL");
    }
  });
});

describe("guard CLI", () => {
  function cli(args: string[]) {
    const dir = tmp();
    const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, AGENT_PRIMITIVES_LOG_DIR: dir },
      timeout: 40_000,
      killSignal: "SIGKILL",
    });
    return {
      status: r.status,
      stdout: r.stdout,
      json: r.stdout.trim().startsWith("{")
        ? (JSON.parse(r.stdout) as Record<string, unknown>)
        : undefined,
    };
  }

  it("a timeout is exit 124 with an envelope naming it", () => {
    const s = fx(7107);
    const r = cli(["guard", "1", "4096", "--", "sleep", s.arg]);
    expect(r.status).toBe(124);
    expect(r.json).toMatchObject({
      command: "guard",
      status: "fail",
      reason: "timeout",
      exitCode: 124,
    });
    expect(marked(s.cmd)).toEqual([]);
  });

  it("a command that succeeds is exit 0, status pass", () => {
    const r = cli(["guard", "10", "4096", "--", "sh", "-c", "exit 0"]);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ status: "pass", reason: "none" });
    expect(r.json?.leftoverCheckFailed).toBe(false);
  });

  it("the command's own code passes through, and arguments after -- are not read as options", () => {
    const r = cli(["guard", "10", "4096", "--", "sh", "-c", "exit 3"]);
    expect(r.status).toBe(3);
    expect(r.json).toMatchObject({ status: "fail", reason: "child_exit" });
  });

  it("a leftover is exit 122", () => {
    const s = fx(7108);
    const r = cli([
      "guard",
      "10",
      "4096",
      "--",
      "sh",
      "-c",
      `sleep ${s.arg} & exit 0`,
    ]);
    expect(r.status).toBe(122);
    expect(r.json).toMatchObject({ reason: "leftover", leftoverCount: 1 });
    expect(marked(s.cmd)).toEqual([]);
  });

  it("a bad limit or a missing command is a usage error, exit 2, nothing run", () => {
    for (const args of [
      ["guard", "abc", "100", "--", "true"],
      ["guard", "0", "100", "--", "true"],
      ["guard", "5", "-3", "--", "true"],
      ["guard", "5", "100"],
      ["guard", "5", "100", "--poll-ms", "5", "--", "true"],
    ]) {
      const r = cli(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.json?.status, args.join(" ")).toBe("usage_error");
    }
  });

  it("-f text renders the outcome", () => {
    const s = fx(7109);
    const r = cli(["-f", "text", "guard", "1", "4096", "--", "sleep", s.arg]);
    expect(r.status).toBe(124);
    expect(r.stdout).toContain("guard fail: timeout (exit 124)");
    expect(r.stdout).toContain(s.cmd);
    expect(marked(s.cmd)).toEqual([]);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "%s ends the CLI with exit %i and no output, after killing the group and a tracked escapee",
    async (signal, code) => {
      const esc = fx(code === 130 ? 7150 : 7151);
      const grp = fx(code === 130 ? 7152 : 7153);
      const dir = tmp();
      const script =
        "const {spawn}=require('child_process');" +
        `spawn('sleep',['${esc.arg}'],{detached:true,stdio:'ignore'});` +
        `spawn('sleep',['${grp.arg}'],{stdio:'ignore'});` +
        "setInterval(()=>{},1000)";
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          "guard",
          "60",
          "4096",
          "--poll-ms",
          "50",
          "--",
          process.execPath,
          "-e",
          script,
        ],
        {
          env: { ...process.env, AGENT_PRIMITIVES_LOG_DIR: dir },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", (c) => resolve(c)),
      );
      try {
        expect(
          await waitFor(
            () => marked(esc.cmd).length > 0 && marked(grp.cmd).length > 0,
            15_000,
          ),
        ).toBe(true);
        // Polls every 50 ms: the escapee is tracked well before this.
        await sleepMs(600);
        child.kill(signal);
        expect(await exited).toBe(code);
      } finally {
        child.kill("SIGKILL");
      }
      expect(out).toBe("");
      expect(marked(grp.cmd)).toEqual([]);
      expect(marked(esc.cmd)).toEqual([]);
    },
  );
});
