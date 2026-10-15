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

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-guard-"));
  tmpDirs.push(dir);
  return dir;
}

function marked(marker: string): { pid: number; command: string }[] {
  if (!markers.includes(marker)) markers.push(marker);
  return (readProcesses() ?? []).filter(
    (p) => !isZombie(p) && p.command.includes(marker),
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
    const t0 = Date.now();
    const r = await run("sleep", ["7101"], { timeoutMs: 1000 });
    const took = Date.now() - t0;
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("timeout");
    expect(r.exitCode).toBe(124);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(15_000);
    expect(r.killed.map((p) => p.command)).toContain("sleep 7101");
    expect(marked("sleep 7101")).toEqual([]);
  });

  it("kills the whole group: a child's own children die with it", async () => {
    const r = await run("sh", ["-c", "sleep 7102 & sleep 7103 & wait"], {
      timeoutMs: 1000,
    });
    expect(r.reason).toBe("timeout");
    expect(r.exitCode).toBe(124);
    expect(r.killedCount).toBeGreaterThanOrEqual(2);
    expect(marked("sleep 7102")).toEqual([]);
    expect(marked("sleep 7103")).toEqual([]);
  });
});

describe("guard: memory cap", () => {
  const hog = "const a=[];setInterval(()=>{a.push(Buffer.alloc(8<<20,1))},20)";

  it("kills a memory-hungry child at the cap, exit 123", async () => {
    const r = await run(process.execPath, ["-e", hog, "hog-7110"], {
      maxRssMiB: 128,
      timeoutMs: 30_000,
      pollMs: 50,
    });
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("rss_cap");
    expect(r.exitCode).toBe(123);
    expect(r.peakRssMiB).toBeGreaterThan(128);
    expect(r.durationMs).toBeLessThan(25_000);
    expect(r.killed.some((p) => p.command.includes("hog-7110"))).toBe(true);
    expect(marked("hog-7110")).toEqual([]);
  });

  it("caps the SUM over the tree: two children each under the cap are still over it", async () => {
    // Each worker holds about 60 MiB on top of node's own ~40; the cap is
    // 150, above either alone and below both together.
    const worker =
      "const a=Buffer.alloc(60<<20,1);setInterval(()=>{a[0]=1},1000)";
    const script = `${JSON.stringify(process.execPath)} -e '${worker}' sum-7111 & ${JSON.stringify(process.execPath)} -e '${worker}' sum-7111 & wait`;
    const r = await run("sh", ["-c", script], {
      maxRssMiB: 150,
      timeoutMs: 30_000,
      pollMs: 50,
    });
    expect(r.reason).toBe("rss_cap");
    expect(r.exitCode).toBe(123);
    expect(r.peakProcessRssMiB).toBeLessThan(150);
    expect(r.peakRssMiB).toBeGreaterThan(150);
    expect(marked("sum-7111")).toEqual([]);
  });
});

describe("guard: leftovers", () => {
  it("finds, kills and reports a background child left in the group, exit 122", async () => {
    const r = await run("sh", ["-c", "sleep 7104 & exit 0"]);
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("leftover");
    expect(r.exitCode).toBe(122);
    expect(r.childExitCode).toBe(0);
    const entry = r.leftovers.find((p) => p.command === "sleep 7104");
    expect(entry).toBeDefined();
    expect(entry?.inGroup).toBe(true);
    expect(r.survivorCount).toBe(0);
    expect(marked("sleep 7104")).toEqual([]);
  });

  it("a leftover wins over the command's own failure code", async () => {
    const r = await run("sh", ["-c", "sleep 7112 & exit 5"]);
    expect(r.reason).toBe("leftover");
    expect(r.childExitCode).toBe(5);
    expect(r.exitCode).toBe(122);
    expect(marked("sleep 7112")).toEqual([]);
  });

  it("finds a grandchild that called setsid and left the group, while its parent was sampled", async () => {
    // node's `detached: true` is setsid. The parent stays 1.5 s so a poll
    // sees the chain; then it exits and the child is orphaned, outside the
    // group.
    const script =
      "const {spawn}=require('child_process');" +
      "spawn('sleep',['7105'],{detached:true,stdio:'ignore'}).unref();" +
      "setTimeout(()=>process.exit(0),1500)";
    const r = await run(process.execPath, ["-e", script], { pollMs: 50 });
    expect(r.reason).toBe("leftover");
    expect(r.exitCode).toBe(122);
    const entry = r.leftovers.find((p) => p.command === "sleep 7105");
    expect(entry).toBeDefined();
    expect(entry?.inGroup).toBe(false);
    expect(marked("sleep 7105")).toEqual([]);
  });

  it("kills an escaped (setsid) descendant at a limit too", async () => {
    const script =
      "const {spawn}=require('child_process');" +
      "spawn('sleep',['7113'],{detached:true,stdio:'ignore'});" +
      "setInterval(()=>{},1000)";
    const r = await run(process.execPath, ["-e", script], {
      timeoutMs: 2000,
      pollMs: 50,
    });
    expect(r.reason).toBe("timeout");
    expect(r.killed.some((p) => p.command === "sleep 7113" && !p.inGroup)).toBe(
      true,
    );
    expect(marked("sleep 7113")).toEqual([]);
  });
});

describe("guard: abort and parent death", () => {
  it("an abort signal kills the group at once", async () => {
    const controller = new AbortController();
    const pending = run("sleep", ["7114"], { signal: controller.signal });
    expect(await waitFor(() => marked("sleep 7114").length > 0, 10_000)).toBe(
      true,
    );
    controller.abort();
    const r = await pending;
    expect(r.reason).toBe("aborted");
    expect(r.exitCode).toBe(130);
    expect(marked("sleep 7114")).toEqual([]);
  });

  it("killing guard itself with SIGKILL still ends the command (parent-death watcher)", async () => {
    const dir = tmp();
    const cli = spawn(
      process.execPath,
      [CLI_PATH, "guard", "60", "4096", "--", "sleep", "7106"],
      {
        env: { ...process.env, AGENT_PRIMITIVES_LOG_DIR: dir },
        stdio: "ignore",
      },
    );
    try {
      expect(await waitFor(() => marked("sleep 7106").length > 0, 15_000)).toBe(
        true,
      );
      cli.kill("SIGKILL");
      expect(
        await waitFor(() => marked("sleep 7106").length === 0, 15_000),
      ).toBe(true);
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
    const r = cli(["guard", "1", "4096", "--", "sleep", "7107"]);
    expect(r.status).toBe(124);
    expect(r.json).toMatchObject({
      command: "guard",
      status: "fail",
      reason: "timeout",
      exitCode: 124,
    });
    expect(marked("sleep 7107")).toEqual([]);
  });

  it("a command that succeeds is exit 0, status pass", () => {
    const r = cli(["guard", "10", "4096", "--", "sh", "-c", "exit 0"]);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ status: "pass", reason: "none" });
  });

  it("the command's own code passes through, and arguments after -- are not read as options", () => {
    const r = cli(["guard", "10", "4096", "--", "sh", "-c", "exit 3"]);
    expect(r.status).toBe(3);
    expect(r.json).toMatchObject({ status: "fail", reason: "child_exit" });
  });

  it("a leftover is exit 122", () => {
    const r = cli([
      "guard",
      "10",
      "4096",
      "--",
      "sh",
      "-c",
      "sleep 7108 & exit 0",
    ]);
    expect(r.status).toBe(122);
    expect(r.json).toMatchObject({ reason: "leftover", leftoverCount: 1 });
    expect(marked("sleep 7108")).toEqual([]);
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
    const r = cli(["-f", "text", "guard", "1", "4096", "--", "sleep", "7109"]);
    expect(r.status).toBe(124);
    expect(r.stdout).toContain("guard fail: timeout (exit 124)");
    expect(r.stdout).toContain("sleep 7109");
    expect(marked("sleep 7109")).toEqual([]);
  });
});
