import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_PATH } from "./helpers/spawn-cli.js";

/**
 * The bound of `patch`'s git identity lookup (`gitDirIdentities` in
 * `src/patch/index.ts`), run through the shared wrapper of
 * `src/bounded-spawn.ts` like the worktree and drift commands do: a git
 * that hangs is stopped at the bound together with its whole process
 * group, and - the part the plain `spawnSync` timeout cannot do - the
 * group ends when the patch process itself is killed while git hangs,
 * through the watcher the `/bin/sh` trampoline starts inside it. A case
 * that only checked the warning would not see the wrapper being dropped;
 * every case here checks the stand-in's recorded processes too.
 *
 * The stand-in, PATH and leftover-process patterns follow
 * `test/worktree-git-bounds.test.ts` and the "with a git that misbehaves"
 * block of `test/patch.test.ts`; `patch` is driven through the built
 * module in a child process for its `gitTimeoutMs` seam.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-patch-bounds-")),
  );
  tmpDirs.push(dir);
  return dir;
}

/** The built `patch` module, run by `runPatchChild`. */
const DIST_PATCH_URL = pathToFileURL(
  path.join(path.dirname(CLI_PATH), "patch", "index.js"),
).href;

const CHILD_PATCH_SCRIPT = [
  "const [url, json] = process.argv.slice(1);",
  "const { patch } = await import(url);",
  "process.stdout.write(JSON.stringify(patch(JSON.parse(json))));",
].join("\n");

interface ChildPatchRun {
  out: { status?: string; warnings?: string[] };
  ms: number;
}

/** A plan for the `a.txt` every case writes. */
const EDIT = [{ file: "a.txt", old: "a", new: "b" }];

interface PatchChildOptions {
  cwd: string;
  edits: readonly unknown[];
  dryRun?: boolean;
  gitTimeoutMs?: number;
}

/** The built `patch` module in a child process with a group of its own;
 * a run still going after `limitMs` is ended and fails the test. */
async function runPatchChild(
  options: PatchChildOptions,
  env: NodeJS.ProcessEnv,
  limitMs = 30_000,
): Promise<ChildPatchRun> {
  const child = startPatchChild(options, env);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  let stalled = false;
  const timer = setTimeout(() => {
    stalled = true;
    killGroup(child.pid);
  }, limitMs);
  await child.closed;
  clearTimeout(timer);
  if (stalled)
    throw new Error(`patch did not return within ${String(limitMs)} ms`);
  if (stdout === "") throw new Error(`patch printed nothing: ${stderr}`);
  return {
    out: JSON.parse(stdout) as ChildPatchRun["out"],
    ms: Date.now() - child.startedMs,
  };
}

interface LivePatchChild {
  pid: number;
  startedMs: number;
  stdout: Readable;
  stderr: Readable;
  closed: Promise<void>;
}

/** The same child, left running (detached, group of its own) so that a
 * case can signal it. */
function startPatchChild(
  options: PatchChildOptions,
  env: NodeJS.ProcessEnv,
): LivePatchChild {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      CHILD_PATCH_SCRIPT,
      DIST_PATCH_URL,
      JSON.stringify(options),
    ],
    { env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("the patch child never started");
  const closed = new Promise<void>((resolve) =>
    child.on("close", () => resolve()),
  );
  return {
    pid: child.pid,
    startedMs: Date.now(),
    stdout: child.stdout,
    stderr: child.stderr,
    closed,
  };
}

/** A directory with a `git` that records its own pid and a background
 * `sleep`'s pid and then runs `body`. */
function fakeGit(body: string): {
  env: NodeJS.ProcessEnv;
  pids: () => number[];
  pidFile: string;
} {
  const bin = tmpDir();
  const pidFile = path.join(bin, "pids");
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nPIDS='${pidFile}'\n${body}\n`,
    { mode: 0o755 },
  );
  return {
    env: { PATH: bin },
    pidFile,
    pids: () =>
      fs.existsSync(pidFile)
        ? fs
            .readFileSync(pidFile, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map(Number)
        : [],
  };
}

/** Running: signal 0 reaches it and it is no zombie (a killed process can
 * stay a zombie for a moment until it is reaped). When neither /proc nor
 * `ps` can tell, it counts as running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    // No /proc (macOS): ask ps.
  }
  try {
    const ps = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return !ps.trim().startsWith("Z");
  } catch {
    return true;
  }
}

/** Waits until the stand-in has hung (it recorded both pids). */
async function untilHung(
  pids: () => number[],
  withinMs = 30_000,
): Promise<number[]> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    const recorded = pids();
    if (recorded.length === 2) return recorded;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the git call never hung");
}

/** Expects every pid to be gone soon; one that is not is killed here (it
 * was alive a moment ago, so it is still ours) before the test fails. */
async function expectGone(pids: number[], withinMs = 10_000): Promise<void> {
  const left: number[] = [];
  for (const pid of pids) {
    const until = Date.now() + withinMs;
    for (;;) {
      if (!alive(pid)) break;
      if (Date.now() >= until) {
        left.push(pid);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  for (const pid of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It ended by itself in the meantime.
    }
  }
  expect(left, "processes that outlived the run").toEqual([]);
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

const HANGING =
  'echo $$ >> "$PIDS"\n/bin/sleep 300 &\necho $! >> "$PIDS"\nwait';

describe.skipIf(process.platform === "win32")(
  "patch: the bounded git identity lookup (bounded-spawn)",
  () => {
    it("stops a hanging stand-in git at the bound and leaves nothing of it running", async () => {
      const hung = fakeGit(HANGING);
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      try {
        const { out, ms } = await runPatchChild(
          { cwd: dir, edits: EDIT, dryRun: true, gitTimeoutMs: 1000 },
          hung.env,
        );
        expect(out.status).toBe("would_write");
        expect((out.warnings ?? []).join("\n")).toContain(
          "git rev-parse did not finish within 1000 ms and was stopped",
        );
        // Ended at the bound, not by the stand-in's sleep ending.
        expect(ms).toBeGreaterThanOrEqual(900);
        expect(ms).toBeLessThan(20_000);
        const recorded = hung.pids();
        expect(recorded).toHaveLength(2);
        await expectGone(recorded);
      } finally {
        for (const pid of hung.pids()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Gone.
          }
        }
      }
    }, 60_000);

    it("a patch process killed while git hangs leaves no stand-in git behind", async () => {
      // The watcher the trampoline starts inside git's group is what ends
      // git here: the bound (far above) never fires, the stand-in is in a
      // group of its own that a signal to the patch process does not
      // reach, and the kernel closes the fd 3 pipe the watcher waits on
      // only when the patch process dies. Drop the trampoline from the
      // wiring and this is the case that fails: both recorded processes
      // sleep on for their 300 seconds.
      const hung = fakeGit(HANGING);
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      const live = startPatchChild(
        { cwd: dir, edits: EDIT, dryRun: true, gitTimeoutMs: 120_000 },
        hung.env,
      );
      let pids: number[] = [];
      try {
        pids = await untilHung(hung.pids);
        // The stand-in hung; the patch process is waiting on it.
        expect(alive(live.pid)).toBe(true);
        // Kill only the patch process: git runs in a group of its own,
        // so nothing about this kill can reach it other than the watcher.
        try {
          process.kill(live.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        await live.closed;
        await expectGone(pids);
      } finally {
        killGroup(live.pid);
        for (const pid of hung.pids()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Gone.
          }
        }
      }
    }, 60_000);
  },
);
