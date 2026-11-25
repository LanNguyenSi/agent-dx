import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope } from "../src/envelope.js";
import { execCommand } from "../src/exec.js";
import { guard } from "../src/guard/index.js";
import { beginInplace } from "../src/probe/isolation.js";
import { computeMutant, listPatchTouchedPaths } from "../src/probe/mutant.js";
import { beginPyCacheIsolation } from "../src/probe/pycache.js";
import { runArgv } from "../src/probe/run.js";
import {
  defaultLogParent,
  ensurePrivateDir,
  PrivateDirError,
} from "../src/private-dir.js";
import { buildSpawnEnv, CLI_PATH } from "./helpers/spawn-cli.js";

const posix = process.platform !== "win32";
const maybe = posix ? describe : describe.skip;

const roots: string[] = [];
function temp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "private-dir-test-")),
  );
  roots.push(d);
  return d;
}

const savedTmpdir = process.env.TMPDIR;
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

/** Every entry under `dir` (not `dir` itself), recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    out.push(p);
    if (fs.lstatSync(p).isDirectory()) out.push(...walk(p));
  }
  return out;
}

/** Nothing under `dir` is reachable by group or other. */
function expectPrivateTree(dir: string): void {
  const entries = walk(dir);
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(mode(entry) & 0o077, `${entry} is ${mode(entry).toString(8)}`).toBe(
      0,
    );
  }
}

/** A fresh `TMPDIR` for this process, so `os.tmpdir()` (and with it the
 * default log location) is a directory of this test's own. */
function useTmpdir(): string {
  const t = temp();
  process.env.TMPDIR = t;
  return t;
}

maybe("ensurePrivateDir", () => {
  it("creates every missing level with mode 0700", () => {
    const t = useTmpdir();
    const leaf = path.join(t, "agent-primitives", "run-1");
    ensurePrivateDir(leaf);
    expect(mode(path.join(t, "agent-primitives"))).toBe(0o700);
    expect(mode(leaf)).toBe(0o700);
  });

  it("creates the levels of a user-supplied directory with mode 0700", () => {
    const t = temp();
    const leaf = path.join(t, "mine", "deep", "logs");
    ensurePrivateDir(leaf);
    for (const level of ["mine", "mine/deep", "mine/deep/logs"]) {
      expect(mode(path.join(t, level))).toBe(0o700);
    }
  });

  it("accepts an existing default parent that is 0755 and owned by the user, and leaves its mode alone", () => {
    const t = useTmpdir();
    const parent = path.join(t, "agent-primitives");
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chmodSync(parent, 0o755);
    ensurePrivateDir(path.join(parent, "run-1"));
    expect(mode(parent)).toBe(0o755);
    expect(mode(path.join(parent, "run-1"))).toBe(0o700);
  });

  it("refuses a group-writable default parent, names -l, and does not chmod it", () => {
    const t = useTmpdir();
    const parent = path.join(t, "agent-primitives");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o775);
    const leaf = path.join(parent, "run-1");
    expect(() => ensurePrivateDir(leaf)).toThrow(PrivateDirError);
    expect(() => ensurePrivateDir(leaf)).toThrow(/group- or world-writable/);
    expect(() => ensurePrivateDir(leaf)).toThrow(/-l/);
    expect(mode(parent)).toBe(0o775);
  });

  it("refuses a world-writable default run directory", () => {
    const t = useTmpdir();
    const leaf = path.join(t, "agent-primitives", "run-1");
    fs.mkdirSync(leaf, { recursive: true });
    fs.chmodSync(leaf, 0o757);
    expect(() => ensurePrivateDir(leaf)).toThrow(/world-writable/);
  });

  it("refuses a default parent owned by another user (stat seam)", () => {
    const t = useTmpdir();
    const parent = path.join(t, "agent-primitives");
    fs.mkdirSync(parent, { mode: 0o700 });
    const leaf = path.join(parent, "run-1");
    const stat = (p: string): fs.Stats => {
      if (p === parent) {
        return {
          isDirectory: () => true,
          uid: (process.getuid?.() ?? 0) + 999_999,
          mode: 0o40700,
        } as fs.Stats;
      }
      return fs.statSync(p);
    };
    expect(() => ensurePrivateDir(leaf, { stat })).toThrow(
      /not owned by the current user/,
    );
  });

  it("refuses a default location that is not a directory", () => {
    const t = useTmpdir();
    fs.writeFileSync(path.join(t, "agent-primitives"), "x");
    expect(() =>
      ensurePrivateDir(path.join(t, "agent-primitives", "run-1")),
    ).toThrow();
  });

  it("uses an existing user-supplied directory as given: no check, no chmod", () => {
    const t = temp();
    const mine = path.join(t, "mine");
    fs.mkdirSync(mine);
    fs.chmodSync(mine, 0o775);
    expect(() => ensurePrivateDir(mine)).not.toThrow();
    expect(mode(mine)).toBe(0o775);
    fs.chmodSync(mine, 0o755);
    ensurePrivateDir(mine);
    expect(mode(mine)).toBe(0o755);
  });

  it("checks the levels it creates under a user-supplied directory (stat seam)", () => {
    const t = temp();
    const foreign = path.join(t, "fresh");
    const leaf = path.join(foreign, "logs");
    const stat = (p: string): fs.Stats => {
      if (p === foreign) {
        return {
          isDirectory: () => true,
          uid: (process.getuid?.() ?? 0) + 999_999,
          mode: 0o40700,
        } as fs.Stats;
      }
      return fs.statSync(p);
    };
    expect(() => ensurePrivateDir(leaf, { stat })).toThrow(
      /not owned by the current user/,
    );
  });

  it("treats a directory beside the default parent as user-supplied", () => {
    const t = useTmpdir();
    const sibling = path.join(t, "agent-primitives-other");
    fs.mkdirSync(sibling);
    fs.chmodSync(sibling, 0o775);
    expect(() => ensurePrivateDir(path.join(sibling, "run"))).not.toThrow();
    expect(defaultLogParent()).toBe(path.join(t, "agent-primitives"));
  });
});

maybe("files written under the default location", () => {
  it("exec: log file 0600 in a 0700 run directory", async () => {
    const t = useTmpdir();
    const logDir = path.join(t, "agent-primitives", "run-x");
    const result = await execCommand("echo hi", { logDir });
    expect(mode(result.logPath)).toBe(0o600);
    expect(mode(logDir)).toBe(0o700);
    expect(mode(path.join(t, "agent-primitives"))).toBe(0o700);
  });

  it("exec: appending to an existing log keeps the mode it has", async () => {
    const t = useTmpdir();
    const logDir = path.join(t, "agent-primitives", "run-x");
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const existing = path.join(logDir, "keep.log");
    fs.writeFileSync(existing, "", { mode: 0o644 });
    fs.chmodSync(existing, 0o644);
    await execCommand("echo hi", { logDir, logFileName: "keep.log" });
    expect(mode(existing)).toBe(0o644);
  });

  it("exec: refuses a group-writable default parent without running the command", async () => {
    const t = useTmpdir();
    const parent = path.join(t, "agent-primitives");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o775);
    const marker = path.join(t, "ran");
    await expect(
      execCommand(`touch ${marker}`, { logDir: path.join(parent, "run-x") }),
    ).rejects.toThrow(/-l/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("argv run: log file 0600", async () => {
    const t = useTmpdir();
    const logDir = path.join(t, "agent-primitives", "run-x");
    const result = await runArgv(process.execPath, ["-e", "0"], { logDir });
    expect(mode(result.logPath)).toBe(0o600);
    expect(mode(logDir)).toBe(0o700);
  });

  it("guard: log file 0600", async () => {
    const t = useTmpdir();
    const logDir = path.join(t, "agent-primitives", "run-x");
    const result = await guard({
      command: process.execPath,
      args: ["-e", "0"],
      timeoutMs: 20_000,
      maxRssMiB: 4096,
      pollMs: 100,
      cwd: t,
      logDir,
      runId: "t",
    });
    expect(fs.existsSync(logDir)).toBe(true);
    expectPrivateTree(logDir);
    expect(result.logPath).toBeDefined();
  });

  it("envelope: the full-result file is 0600", () => {
    const t = useTmpdir();
    const logDir = path.join(t, "agent-primitives", "run-x");
    const { envelope } = buildEnvelope({
      version: "0.0.0",
      command: "x",
      status: "pass",
      durationMs: 1,
      cwd: t,
      persistFullResult: true,
      logDir,
      extra: { value: "v" },
    });
    const logs = envelope.logs as string[];
    expect(logs.length).toBeGreaterThan(0);
    for (const logPath of logs) expect(mode(logPath)).toBe(0o600);
    expect(mode(logDir)).toBe(0o700);
  });

  it("inplace backup of the target: file 0600 even for a 0644 target", () => {
    const t = useTmpdir();
    const work = temp();
    const target = path.join(work, ".env");
    fs.writeFileSync(target, "SECRET=1\n");
    fs.chmodSync(target, 0o644);
    const logDir = path.join(t, "agent-primitives", "run-x");
    const session = beginInplace(target, logDir, work);
    expect(mode(session.backupPath)).toBe(0o600);
    expect(mode(logDir)).toBe(0o700);
  });

  it("python cache isolation: the log directory and the cache directory are 0700", () => {
    const t = useTmpdir();
    const logDir = path.join(t, "agent-primitives", "run-x");
    const result = beginPyCacheIsolation(logDir);
    expect(result.ok).toBe(true);
    expect(mode(logDir)).toBe(0o700);
    expectPrivateTree(logDir);
  });

  it("patch path listing: the log directory is created 0700", async () => {
    const t = useTmpdir();
    const root = temp();
    const patchPath = path.join(root, "m.patch");
    fs.writeFileSync(patchPath, "");
    const logDir = path.join(t, "agent-primitives", "run-x");
    await listPatchTouchedPaths(patchPath, logDir, { timeoutMs: 20_000 });
    expect(mode(logDir)).toBe(0o700);
    expect(mode(path.join(t, "agent-primitives"))).toBe(0o700);
  });

  it("patch mutant: the dry-run scratch and every log under the log dir are private", async () => {
    const t = useTmpdir();
    const root = temp();
    const rel = "a.js";
    const abs = path.join(root, rel);
    const original = "function f(n) {\n  const a = 1;\n  return n > a;\n}\n";
    fs.writeFileSync(abs, original);
    const run = (args: string[]): void => {
      const res = spawnSync("git", args, { cwd: root });
      expect(res.status).toBe(0);
    };
    run(["init", "-q"]);
    run(["add", "-A"]);
    run([
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    const patchPath = path.join(root, "m.patch");
    fs.writeFileSync(
      patchPath,
      [
        `diff --git a/${rel} b/${rel}`,
        "index 0000000..0000000 100644",
        `--- a/${rel}`,
        `+++ b/${rel}`,
        "@@ -1,4 +1,3 @@",
        " function f(n) {",
        "-  const a = 1;",
        "-  return n > a;",
        "+  return false;",
        " }",
      ].join("\n") + "\n",
    );
    const logDir = path.join(t, "agent-primitives", "run-x");
    // Files written and later removed (the before/after copies) or
    // replaced by git (the dry-run scratch) cannot be seen on disk
    // afterwards: record the mode asked for at every write under logDir.
    const realWrite = fs.writeFileSync;
    const asked: Array<{ file: string; mode: number | undefined }> = [];
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      file: unknown,
      data: unknown,
      opts: unknown,
    ) => {
      if (typeof file === "string" && file.startsWith(logDir + path.sep)) {
        const o = opts as { mode?: number } | undefined;
        asked.push({ file, mode: o?.mode });
      }
      return realWrite(file as string, data as string, opts as object);
    }) as typeof fs.writeFileSync);
    let result;
    try {
      result = await computeMutant(
        { form: "patch", file: abs, patchPath },
        { root, logDir, originalContent: original },
      );
    } finally {
      spy.mockRestore();
    }
    expect(result.applicable).toBe(true);
    const names = asked.map((w) => path.relative(logDir, w.file));
    expect(names.some((n) => n.startsWith("mutant-dry-run-"))).toBe(true);
    expect(names.some((n) => n.endsWith("mutant-diff.patch"))).toBe(true);
    expect(names.some((n) => n.includes(`before${path.sep}`))).toBe(true);
    expect(names.some((n) => n.includes(`after${path.sep}`))).toBe(true);
    for (const w of asked) expect(w.mode, w.file).toBe(0o600);
    if (result.applicable && result.diff?.path !== undefined) {
      expect(mode(result.diff.path)).toBe(0o600);
    }
    // Every directory is private; every file git or this tool left behind
    // outside the dry-run scratch (itself a 0700 directory) is 0600.
    for (const entry of walk(logDir)) {
      if (fs.lstatSync(entry).isDirectory()) {
        expect(mode(entry), entry).toBe(0o700);
      } else if (!path.relative(logDir, entry).startsWith("mutant-dry-run-")) {
        expect(mode(entry), entry).toBe(0o600);
      }
    }
  });
});

maybe("the CLI default log location", () => {
  function runVerify(
    umask: string,
    tmp: string,
    extra: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(
      "/bin/sh",
      [
        "-c",
        `umask ${umask}; exec "$0" "$@"`,
        process.execPath,
        CLI_PATH,
        "verify",
        "-c",
        "",
        "-x",
        "mycheck=exit 0",
        ...extra,
      ],
      {
        cwd: tmp,
        env: buildSpawnEnv({ TMPDIR: tmp, ...env }),
        encoding: "utf8",
      },
    );
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  for (const umask of ["022", "002"]) {
    it(`verify under umask ${umask}: directories 0700, log files 0600`, () => {
      const t = temp();
      const res = runVerify(umask, t);
      expect(res.status, res.stdout + res.stderr).toBe(0);
      const envelope = JSON.parse(res.stdout);
      expect(envelope.logs.length).toBeGreaterThan(0);
      const parent = path.join(t, "agent-primitives");
      expect(mode(parent)).toBe(0o700);
      for (const logPath of envelope.logs) {
        expect(mode(logPath)).toBe(0o600);
        expect(mode(path.dirname(logPath))).toBe(0o700);
      }
      expectPrivateTree(parent);
    });
  }

  it("verify with a full-result file (--repeat): the file is 0600", () => {
    const t = temp();
    const res = runVerify("022", t, ["--repeat", "2"]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    const full = (envelope.logs as string[]).filter((p) =>
      path.basename(p).startsWith("verify-full-"),
    );
    expect(full.length).toBe(1);
    expect(mode(full[0]!)).toBe(0o600);
  });

  it("verify with a group-writable <tmpdir>/agent-primitives is refused and the directory is not chmod-ed", () => {
    const t = temp();
    const parent = path.join(t, "agent-primitives");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o775);
    const res = runVerify("022", t);
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/group- or world-writable/);
    expect(res.stdout + res.stderr).toMatch(/-l/);
    expect(mode(parent)).toBe(0o775);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("verify with a user -l directory: an existing 0755 directory stays 0755, its log file is 0600", () => {
    const t = temp();
    const mine = path.join(t, "mine");
    fs.mkdirSync(mine);
    fs.chmodSync(mine, 0o755);
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "-l", mine, "verify", "-c", "", "-x", "mycheck=exit 0"],
      { cwd: t, env: buildSpawnEnv({ TMPDIR: t }), encoding: "utf8" },
    );
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(mode(mine)).toBe(0o755);
    expect(envelope.logs.length).toBeGreaterThan(0);
    for (const logPath of envelope.logs) {
      expect(logPath.startsWith(mine + path.sep)).toBe(true);
      expect(mode(logPath)).toBe(0o600);
    }
    // The default location was not touched.
    expect(fs.existsSync(path.join(t, "agent-primitives"))).toBe(false);
  });

  it("a group-writable default parent does not block an explicit -l", () => {
    const t = temp();
    const parent = path.join(t, "agent-primitives");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o775);
    const mine = path.join(t, "mine");
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "-l", mine, "verify", "-c", "", "-x", "mycheck=exit 0"],
      { cwd: t, env: buildSpawnEnv({ TMPDIR: t }), encoding: "utf8" },
    );
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(mode(mine)).toBe(0o700);
  });
});

beforeEach(() => {
  // Each test starts from the saved value; `useTmpdir` overrides per test.
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
});
