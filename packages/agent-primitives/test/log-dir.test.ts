import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSpawnEnv, CLI_PATH } from "./helpers/spawn-cli.js";

const roots: string[] = [];
/** Realpath like `snapshot.test.ts`: the child's own `process.cwd()` is
 * the symlink-resolved path, so the prefix assertions below only hold
 * against a resolved temp root. */
function temp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "log-dir-test-")),
  );
  roots.push(d);
  return d;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** `verify -c '' -x mycheck=exit 0`: one check that always passes, from
 * the same shape the verify wiring tests in `cli.test.ts` use. */
const PASSING_VERIFY = ["verify", "-c", "", "-x", "mycheck=exit 0"];

function runAt(
  invocationDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: invocationDir,
    env: buildSpawnEnv(env),
    encoding: "utf8",
  });
}

/** `logDir` exists, holds at least one file, and every path in the
 * envelope's `logs` is absolute and sits inside it. */
function expectLogsUnder(logDir: string, logs: string[]): void {
  expect(logs.length).toBeGreaterThan(0);
  for (const logPath of logs) {
    expect(path.isAbsolute(logPath)).toBe(true);
    expect(logPath.startsWith(logDir + path.sep)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
  }
  expect(fs.readdirSync(logDir).length).toBeGreaterThan(0);
}

describe("relative -l / AGENT_PRIMITIVES_LOG_DIR resolve against the invocation directory", () => {
  it("verify -l some/dir from an invocation dir: logs land under <invocation>/some/dir and the envelope logs paths are absolute under it", () => {
    const invocation = temp();
    const res = runAt(invocation, ["-l", "some/dir", ...PASSING_VERIFY]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.status).toBe("pass");
    const logDir = path.join(invocation, "some", "dir");
    expectLogsUnder(logDir, envelope.logs);
  });

  it("AGENT_PRIMITIVES_LOG_DIR=some/dir resolves the same way", () => {
    const invocation = temp();
    const res = runAt(invocation, PASSING_VERIFY, {
      AGENT_PRIMITIVES_LOG_DIR: "some/dir",
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.status).toBe("pass");
    const logDir = path.join(invocation, "some", "dir");
    expectLogsUnder(logDir, envelope.logs);
  });

  it("with -C <other dir> the relative log dir still resolves against the invocation directory, not --cwd", () => {
    const invocation = temp();
    const work = temp();
    const res = runAt(invocation, [
      "-C",
      work,
      "-l",
      "some/dir",
      ...PASSING_VERIFY,
    ]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.status).toBe("pass");
    const logDir = path.join(invocation, "some", "dir");
    expectLogsUnder(logDir, envelope.logs);
    expect(fs.existsSync(path.join(work, "some"))).toBe(false);
  });
});

describe("an empty -l / AGENT_PRIMITIVES_LOG_DIR means unset", () => {
  /** The default log root the child computes for `TMPDIR=tmp`:
   * `<tmpdir>/agent-primitives/<run-id>`. */
  function defaultRoot(tmp: string): string {
    return path.join(tmp, "agent-primitives");
  }

  it("-l '' from an invocation dir: logs land under the tmpdir default and the invocation dir holds nothing", () => {
    const invocation = temp();
    const tmp = temp();
    const res = runAt(invocation, ["-l", "", ...PASSING_VERIFY], {
      TMPDIR: tmp,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.status).toBe("pass");
    expectLogsUnder(defaultRoot(tmp), envelope.logs);
    expect(fs.readdirSync(invocation)).toEqual([]);
  });

  it("AGENT_PRIMITIVES_LOG_DIR='' resolves to the tmpdir default and the invocation dir holds nothing", () => {
    const invocation = temp();
    const tmp = temp();
    const res = runAt(invocation, PASSING_VERIFY, {
      AGENT_PRIMITIVES_LOG_DIR: "",
      TMPDIR: tmp,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.status).toBe("pass");
    expectLogsUnder(defaultRoot(tmp), envelope.logs);
    expect(fs.readdirSync(invocation)).toEqual([]);
  });

  it("-l '' with AGENT_PRIMITIVES_LOG_DIR set: the empty flag is unset, so the env directory wins", () => {
    const invocation = temp();
    const tmp = temp();
    const envDir = temp();
    const res = runAt(invocation, ["-l", "", ...PASSING_VERIFY], {
      AGENT_PRIMITIVES_LOG_DIR: envDir,
      TMPDIR: tmp,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.status).toBe("pass");
    expectLogsUnder(envDir, envelope.logs);
    expect(fs.readdirSync(invocation)).toEqual([]);
  });
});

/** A committed `fixture.js` whose test command fails once the probe
 * mutates it to export `false`: one killed run, so its logs are written. */
function probeRepo(): string {
  const dir = temp();
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, "fixture.js"), "module.exports = true;\n");
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  return dir;
}

describe("probe -C <dir> with a relative -l", () => {
  it("probe -C <repo> -l rel/logs from an invocation dir: logs land under <invocation>/rel/logs, not under the -C directory", () => {
    const invocation = temp();
    const repoDir = probeRepo();
    const res = runAt(invocation, [
      "-C",
      repoDir,
      "-l",
      "rel/logs",
      "probe",
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-r",
      "module.exports = false;",
      "-t",
      "node -e \"if (!require('./fixture.js')) process.exit(1)\"",
    ]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.status).toBe("killed");
    const logDir = path.join(invocation, "rel", "logs");
    expectLogsUnder(logDir, envelope.logs);
    expect(fs.existsSync(path.join(repoDir, "rel"))).toBe(false);
  }, 60000);
});
