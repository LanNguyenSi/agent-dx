import { spawnSync } from "node:child_process";
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
