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
  "const options = JSON.parse(json);",
  // A variable too big for any exec: git cannot be started, a spawn error.
  'if (options.hugeEnv) process.env.HUGE = "x".repeat(options.hugeEnv);',
  "process.stdout.write(JSON.stringify(patch(options)));",
].join("\n");

interface ChildPatchRun {
  out: {
    status?: string;
    reason?: string;
    warnings?: string[];
    branchGuard?: {
      status?: string;
      reason?: string;
      repos?: {
        status?: string;
        branch?: string;
        protected?: string[];
        sources?: string[];
      }[];
    };
    edits?: { status?: string; detail?: string }[];
  };
  ms: number;
}

/** A plan for the `a.txt` every case writes. */
const EDIT = [{ file: "a.txt", old: "a", new: "b" }];

interface PatchChildOptions {
  cwd: string;
  edits: readonly unknown[];
  dryRun?: boolean;
  allowProtected?: boolean;
  gitTimeoutMs?: number;
  hugeEnv?: number;
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

/** Not hanging at all: the stand-in exits 0 at once while a background
 * child keeps the inherited pipes open. The trampoline then ends, stops
 * its watcher and exits; `spawnSync` waits for the pipes until the bound
 * and only returns with its timeout error; nothing but
 * `endGroupIfAbnormal` ends the child. */
const EXITS_ZERO_HOLDING_PIPES =
  'echo $$ >> "$PIDS"\n/bin/sleep 300 &\necho $! >> "$PIDS"\nexit 0';

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

    it("ends a stand-in git that exits 0 while a descendant holds the pipes and leaves nothing of it running", async () => {
      // The only case where `endGroupIfAbnormal` matters: the run ends
      // normally as far as the direct child goes, so the watcher is
      // already stopped and the kill at the bound finds a dead child;
      // just the group kill after `spawnSync` returns ends the
      // descendant that holds the pipes. Drop that call and the
      // recorded child sleeps on for its 300 seconds while every
      // warning stays as expected.
      const held = fakeGit(EXITS_ZERO_HOLDING_PIPES);
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      try {
        const { out, ms } = await runPatchChild(
          { cwd: dir, edits: EDIT, dryRun: true, gitTimeoutMs: 1000 },
          held.env,
        );
        expect(out.status).toBe("would_write");
        expect((out.warnings ?? []).join("\n")).toContain(
          "did not finish within",
        );
        // Ended at the bound (the pipe never drained), not by the
        // stand-in's sleep ending.
        expect(ms).toBeGreaterThanOrEqual(900);
        expect(ms).toBeLessThan(20_000);
        const recorded = held.pids();
        expect(recorded).toHaveLength(2);
        await expectGone(recorded);
      } finally {
        for (const pid of held.pids()) {
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

/** The stand-in answers like a git on a feature branch: `rev-parse` (the
 * identity lookup) has no answer, `symbolic-ref HEAD` names a task branch,
 * `symbolic-ref refs/remotes/origin/HEAD` is unset. Every `symbolic-ref`
 * call writes the environment it got to `<dir of PIDS>/<pid>.env`. */
const ANSWERS_AND_RECORDS_ENV = [
  'case "$1" in',
  "  symbolic-ref)",
  '    /usr/bin/env > "${PIDS%/*}/$$.env"',
  '    if [ "$3" = HEAD ]; then echo refs/heads/task/x; exit 0; fi',
  "    exit 1 ;;",
  "  *) exit 128 ;;",
  "esac",
].join("\n");

describe.skipIf(process.platform === "win32")(
  "patch: the branch guard's git calls (bounded-spawn)",
  () => {
    it("runs two symbolic-ref calls and gives them none of the variables that steer git, with prompts off", async () => {
      const stand = fakeGit(ANSWERS_AND_RECORDS_ENV);
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      const steering = {
        GIT_DIR: "/nonexistent",
        GIT_WORK_TREE: "/nonexistent",
        GIT_COMMON_DIR: "/nonexistent",
        GIT_INDEX_FILE: "/nonexistent",
        GIT_OBJECT_DIRECTORY: "/nonexistent",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/nonexistent",
        GIT_NAMESPACE: "elsewhere",
        GIT_PREFIX: "sub/",
        GIT_CEILING_DIRECTORIES: "/",
        GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
        GIT_REF_STORAGE_FORMAT: "reftable",
        GIT_REFERENCE_BACKEND: "reftable",
        GIT_CONFIG_PARAMETERS: "'core.bare=true'",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
        GIT_TERMINAL_PROMPT: "1",
      };
      const { out } = await runPatchChild(
        { cwd: dir, edits: EDIT },
        { ...stand.env, ...steering, KEEP_ME: "yes" },
      );
      expect(out.status).toBe("written");
      expect(out.branchGuard?.status).toBe("allowed");
      const dumps = fs
        .readdirSync(path.dirname(stand.pidFile))
        .filter((f) => f.endsWith(".env"));
      // HEAD and origin/HEAD.
      expect(dumps).toHaveLength(2);
      for (const f of dumps) {
        const lines = fs
          .readFileSync(path.join(path.dirname(stand.pidFile), f), "utf8")
          .split("\n");
        const names = lines.map((l) => l.split("=")[0]);
        for (const name of Object.keys(steering)) {
          if (name === "GIT_TERMINAL_PROMPT") continue;
          expect(names, `${name} reached git`).not.toContain(name);
        }
        expect(lines).toContain("GIT_TERMINAL_PROMPT=0");
        expect(lines).toContain("KEEP_ME=yes");
      }
    }, 60_000);

    for (const [label, hangsOn] of [
      ["HEAD", "HEAD"],
      ["origin/HEAD", "refs/remotes/origin/HEAD"],
    ] as const) {
      it(`stops a symbolic-ref of ${label} that hangs at the bound, refuses with protected_branch_unresolved and leaves nothing running`, async () => {
        const hung = fakeGit(
          [
            'case "$1" in',
            "  rev-parse) exit 128 ;;",
            "esac",
            `if [ "$3" != '${hangsOn}' ]; then`,
            '  if [ "$3" = HEAD ]; then echo refs/heads/task/x; exit 0; fi',
            "  exit 1",
            "fi",
            HANGING,
          ].join("\n"),
        );
        const dir = tmpDir();
        fs.mkdirSync(path.join(dir, ".git"));
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        try {
          const { out, ms } = await runPatchChild(
            { cwd: dir, edits: EDIT, gitTimeoutMs: 2000 },
            hung.env,
          );
          expect(out.status).toBe("usage_error");
          expect(out.reason).toBe("protected_branch_unresolved");
          expect(out.branchGuard?.status).toBe("refused");
          expect(out.edits?.[0].detail).toContain(
            "did not finish within 2000 ms",
          );
          expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a\n");
          expect(ms).toBeGreaterThanOrEqual(1900);
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
    }

    // Every way the answer of one of the guard's two git calls is no
    // answer, enumerated from `runGit`, `headBranch` and the exit-status
    // arms of `evaluateBranchGuard`. Each is refused as unresolved, with
    // nothing written. A mutant that lets one arm through reads a bad
    // answer as an unprotected branch or as a detached HEAD and writes.
    const GOOD_HEAD = "echo refs/heads/task/x; exit 0";
    const UNSET = "exit 1";
    const BAD_ANSWERS: [string, string, string][] = [
      // [label, shell for the failing call, text the edit's detail has]
      ["exit status 2", "exit 2", "exit code 2"],
      ["exit status 3", "exit 3", "exit code 3"],
      ["exit status 128 (git's own fatal)", "exit 128", "exit code 128"],
      ["exit status 126 (not runnable)", "exit 126", "no runnable git"],
      ["exit status 127 (not found)", "exit 127", "no runnable git"],
      ["a status above 128 (ended by a signal)", "exit 137", "ended by"],
      ["a kill of its own process", "kill -KILL $$", "ended by"],
      [
        "output over the 64 KiB bound",
        "/usr/bin/head -c 70000 /dev/zero; exit 0",
        "more than 65536 bytes",
      ],
    ];
    const BAD_HEADS: [string, string, string][] = [
      ...BAD_ANSWERS,
      // `--quiet` prints nothing for a detached HEAD; an exit 1 that
      // prints something is no such answer.
      ["exit 1 that prints something", "echo junk; exit 1", "exit code 1"],
      ["exit 0 with no output", "exit 0", "not a branch under refs/heads/"],
      [
        "exit 0 with two lines (read as one name it matches nothing)",
        'printf "refs/heads/task\\nrefs/heads/main\\n"; exit 0',
        "not a branch under refs/heads/",
      ],
      [
        "exit 0 with an empty branch name",
        "echo refs/heads/; exit 0",
        "not a branch under refs/heads/",
      ],
      [
        "exit 0 with a tag",
        "echo refs/tags/main; exit 0",
        "not a branch under refs/heads/",
      ],
      [
        "exit 0 with a remote-tracking ref",
        "echo refs/remotes/origin/main; exit 0",
        "not a branch under refs/heads/",
      ],
      [
        // As long as `refs/heads/`, so cutting it off blindly leaves `main`.
        "exit 0 with a ref that only looks like refs/heads/",
        "echo refs/heaps/main; exit 0",
        "not a branch under refs/heads/",
      ],
    ];
    const standIn = (head: string, origin: string): string =>
      [
        'case "$1" in',
        "  rev-parse) exit 128 ;;",
        "esac",
        `if [ "$3" = HEAD ]; then ${head}; fi`,
        origin,
      ].join("\n");
    const CASES: [string, string][] = [
      ...BAD_HEADS.map(
        ([label, body]) =>
          [`HEAD: ${label}`, standIn(body, UNSET)] as [string, string],
      ),
      ...BAD_ANSWERS.map(
        ([label, body]) =>
          [`origin/HEAD: ${label}`, standIn(GOOD_HEAD, body)] as [
            string,
            string,
          ],
      ),
    ];
    const DETAILS = [
      ...BAD_HEADS.map(([, , detail]) => detail),
      ...BAD_ANSWERS.map(([, , detail]) => detail),
    ];
    for (const [n, [label, script]] of CASES.entries()) {
      it(`refuses as unresolved when the git call answers: ${label}`, async () => {
        const stand = fakeGit(script);
        const dir = tmpDir();
        fs.mkdirSync(path.join(dir, ".git"));
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        const { out } = await runPatchChild(
          { cwd: dir, edits: EDIT },
          stand.env,
        );
        expect(out.status).toBe("usage_error");
        expect(out.reason).toBe("protected_branch_unresolved");
        expect(out.branchGuard?.status).toBe("refused");
        expect(out.edits?.[0].detail).toContain(DETAILS[n]);
        expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a\n");
      }, 60_000);
    }

    it("refuses as unresolved when git cannot be started at all (a spawn error, not an exit status)", async () => {
      const stand = fakeGit(standIn(GOOD_HEAD, UNSET));
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      const { out } = await runPatchChild(
        { cwd: dir, edits: EDIT, hugeEnv: 4 * 1024 * 1024 },
        stand.env,
      );
      expect(out.status).toBe("usage_error");
      expect(out.reason).toBe("protected_branch_unresolved");
      expect(out.edits?.[0].detail).toContain("git could not be run");
      expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a\n");
    }, 60_000);

    // `origin/HEAD` that names anything but a plain
    // `refs/remotes/origin/<name>` adds no name: the call is no failure,
    // and the HEAD branch stays unprotected. Each of these, read by a
    // mutant that lets the arm through, would list a name of its own.
    const IGNORED_ORIGINS: [string, string][] = [
      ["a remote that is not origin", "refs/remotes/upstream/trunk"],
      ["a local branch", "refs/heads/trunk"],
      ["a ref as long as the origin prefix", "refs/remotes/oriXin/trunk"],
      ["the origin prefix with no name", "refs/remotes/origin/"],
      ["origin/HEAD itself", "refs/remotes/origin/HEAD"],
      ["two lines", "refs/remotes/origin/trunk\\nrefs/remotes/origin/x"],
      ["nothing", ""],
    ];
    for (const [label, answer] of IGNORED_ORIGINS) {
      it(`adds no protected name when origin/HEAD names ${label}`, async () => {
        const stand = fakeGit(
          standIn(
            "echo refs/heads/trunk; exit 0",
            `printf '${answer}\\n'; exit 0`,
          ),
        );
        const dir = tmpDir();
        fs.mkdirSync(path.join(dir, ".git"));
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        const { out } = await runPatchChild(
          { cwd: dir, edits: EDIT },
          stand.env,
        );
        expect(out.status).toBe("written");
        expect(out.branchGuard?.repos?.[0]).toMatchObject({
          status: "allowed",
          branch: "trunk",
          protected: ["main", "master"],
          sources: ["builtin"],
        });
        expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("b\n");
      }, 60_000);
    }

    it("protects the branch origin/HEAD names when it is a plain refs/remotes/origin/<name>", async () => {
      const stand = fakeGit(
        standIn(
          "echo refs/heads/trunk; exit 0",
          "echo refs/remotes/origin/trunk; exit 0",
        ),
      );
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      const { out } = await runPatchChild({ cwd: dir, edits: EDIT }, stand.env);
      expect(out.status).toBe("usage_error");
      expect(out.reason).toBe("protected_branch");
      expect(out.branchGuard?.repos?.[0]).toMatchObject({
        status: "refused",
        protected: ["trunk", "main", "master"],
        sources: ["origin-head", "builtin"],
      });
      expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a\n");
    }, 60_000);

    it("--allow-protected writes past a symbolic-ref that hangs, after the bound", async () => {
      const hung = fakeGit(
        ['case "$1" in', "  rev-parse) exit 128 ;;", "esac", HANGING].join(
          "\n",
        ),
      );
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      try {
        const { out } = await runPatchChild(
          { cwd: dir, edits: EDIT, gitTimeoutMs: 2000, allowProtected: true },
          hung.env,
        );
        expect(out.status).toBe("written");
        expect(out.branchGuard?.status).toBe("allowed_protected");
        expect(out.branchGuard?.reason).toBe("protected_branch_unresolved");
        expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("b\n");
        await expectGone(hung.pids());
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
  },
);
