import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import { readMarkerFor, writeMarker } from "../src/lock.js";
import { sha256File } from "../src/hash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-probe-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

let savedLockDir: string | undefined;
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (savedLockDir === undefined) delete process.env.AGENT_PRIMITIVES_LOCK_DIR;
  else process.env.AGENT_PRIMITIVES_LOCK_DIR = savedLockDir;
  savedLockDir = undefined;
});

/** Every test gets its own lock dir, so a leftover lock/marker from one
 * test can never be observed by another. */
function useLockDir(): string {
  savedLockDir = process.env.AGENT_PRIMITIVES_LOCK_DIR;
  const dir = makeTmpDir();
  process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

const FIXTURE_JS = [
  "function isPositive(n) {",
  "  return n > 0;",
  "}",
  "function unused(n) {",
  "  return n * 2;",
  "}",
  "module.exports = { isPositive };",
  "",
].join("\n");

const FIXTURE_TEST_JS = [
  "const assert = require('node:assert');",
  "const { isPositive } = require('./fixture.js');",
  "assert.strictEqual(isPositive(5), true);",
  "assert.strictEqual(isPositive(-5), false);",
  "",
].join("\n");

/** A fresh git repo (built in a mkdtemp dir, per the house rule against
 * depending on the checkout itself being a git work tree) with a
 * committed fixture.js and fixture.test.js. */
function initRepo(): { repo: string } {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), FIXTURE_JS);
  fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { repo };
}

function baseOptions(
  repo: string,
  overrides: Partial<ProbeOptions> = {},
): ProbeOptions {
  return {
    file: "fixture.js",
    line: 2,
    form: "replace",
    replaceText: "  return false;",
    testCommand: "node fixture.test.js",
    isolation: "inplace",
    expect: "fail",
    cwd: repo,
    logDir: makeTmpDir(),
    ...overrides,
  };
}

describe("probe(): killed and survived", () => {
  it("reports killed, exit-class ok, and restored_verified true when the mutant makes the test fail", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.result).toBe("killed");
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(result.mutant).toEqual({
      file: path.join(repo, "fixture.js"),
      line: 2,
      before: "  return n > 0;",
      after: "  return false;",
      form: "replace",
    });
    expect(result.mutation_probe?.mutant).toBe(
      `${path.join(repo, "fixture.js")}:2:   return n > 0; ->   return false;`,
    );
    expect(result.baseline?.exitCode).toBe(0);
    expect(result.test?.exitCode).not.toBe(0);
    expect(result.isolation).toEqual({
      mode: "inplace",
      path: null,
      linked: [],
      syncedTrackedFiles: [],
      syncedUntrackedFiles: [],
    });

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);
  });

  it("reports survived when the mutant does not affect the test outcome", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(
      baseOptions(repo, { line: 5, replaceText: "  return n * 3;" }),
    );

    expect(result.status).toBe("survived");
    expect(result.mutation_probe?.result).toBe("survived");
    expect(result.test?.exitCode).toBe(0);

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);
  });

  it("--expect pass inverts the verdict", async () => {
    useLockDir();
    const { repo } = initRepo();
    // Same mutant as the "killed" case (breaks the test), but with
    // --expect pass the verdict inverts: a broken test is now "survived".
    const result = await probe(baseOptions(repo, { expect: "pass" }));
    expect(result.status).toBe("survived");
  });
});

describe("probe(): inconclusive branches, hash unchanged afterward", () => {
  it("baseline_failed when the unmutated test already fails", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(baseOptions(repo, { testCommand: "exit 1" }));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_failed");
    expect(result.baseline?.exitCode).toBe(1);
    expect(result.mutant).toBeUndefined();

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);
  });

  it("mutant_not_applicable when -M's substring is not on the line", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(
      baseOptions(repo, {
        form: "match",
        replaceText: undefined,
        matchText: "not-on-this-line",
        withText: "x",
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_not_applicable");

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);
  });

  it("timeout when the mutant test exceeds --timeout", async () => {
    useLockDir();
    const { repo } = initRepo();
    // Sleeps only when the target's own content carries the mutation
    // marker, so the (unmutated) baseline run stays fast and only the
    // mutant run times out.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const { execSync } = require('node:child_process');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('SLOW_MARKER')) { execSync('sleep 5'); }",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "slow test",
    ]);
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(
      baseOptions(repo, {
        replaceText: "  return false; // SLOW_MARKER",
        timeoutMs: 500,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("timeout");
    expect(result.test?.timedOut).toBe(true);
    // The restore step (5)/(6) still runs before classification even on
    // a timeout, so the file is back to its pre-mutation content.
    expect(result.mutation_probe?.restored_verified).toBe(true);

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);
  }, 15000);

  it("file_outside_root when --file resolves outside the containment root, unless --allow-outside", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outsideDir = makeTmpDir();
    const outsideFile = path.join(outsideDir, "outside.js");
    fs.writeFileSync(outsideFile, "x");

    const result = await probe(
      baseOptions(repo, { file: outsideFile, line: 1, replaceText: "y" }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("file_outside_root");
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("x");
  });

  it("probe_in_progress when a second probe targets the same file while the first is still running", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const first = probe(
      baseOptions(repo, { testCommand: "sleep 1 && node fixture.test.js" }),
    );
    // Give the first call a moment to acquire the lock before the second
    // one starts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await probe(
      baseOptions(repo, { line: 5, replaceText: "  return n * 3;" }),
    );

    expect(second.status).toBe("inconclusive");
    expect(second.reason).toBe("probe_in_progress");

    const firstResult = await first;
    expect(firstResult.status).toBe("killed");

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);
  }, 15000);
});

describe("probe(): restore failure is terminal", () => {
  it("restore_failed when the target cannot be restored, exit-class cannot-conclude, warning names the backup path, marker persists", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    // The test command replaces the target with a directory only once it
    // observes the mutation, so the baseline run (unmutated) is a no-op
    // and only the restore step (which tries to copy the backup back
    // into that now-directory path) fails.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('CORRUPT_MARKER')) {",
        "  fs.rmSync('fixture.js', { force: true });",
        "  fs.mkdirSync('fixture.js');",
        "} else {",
        "  const { isPositive } = require('./fixture.js');",
        "  if (isPositive(5) !== true) process.exit(1);",
        "}",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "corrupting test",
    ]);

    const result = await probe(
      baseOptions(repo, { replaceText: "  return false; // CORRUPT_MARKER" }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("restore_failed");
    expect(result.mutation_probe?.result).toBe("restore_failed");
    expect(result.mutation_probe?.restored_verified).toBe(false);
    const backupWarning = result.warnings.find((w) =>
      w.includes("backup path"),
    );
    expect(backupWarning).toBeDefined();
    const backupPathMatch = backupWarning?.match(/backup path (\S+)/);
    expect(backupPathMatch).toBeTruthy();
    if (backupPathMatch) {
      expect(fs.existsSync(backupPathMatch[1])).toBe(true);
    }

    // Never a "killed"/"survived" (exit 0/1) verdict.
    expect(["killed", "survived"]).not.toContain(result.status);

    // The marker is left in place for a human, on purpose.
    const marker = readMarkerFor(path.join(repo, "fixture.js"));
    expect(marker).toBeDefined();

    // Cleanup: the lock dir is test-scoped, but the corrupted directory
    // under the repo (a mkdtemp path, not the real checkout) should still
    // be removed before the afterEach rmSync runs into it; rmSync with
    // force+recursive already handles a directory fine, so nothing extra
    // is required here. Referencing lockDir keeps the variable used.
    expect(fs.existsSync(lockDir)).toBe(true);
  });
});

describe("probe(): SIGKILL-left marker is recovered by the next invocation", () => {
  it("recovers a marker whose recorded pid is dead and whose mutated hash matches the current file, then proceeds with the requested probe", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const originalContent = fs.readFileSync(absFile, "utf8");
    const preHash = await sha256File(absFile);

    // Simulate exactly what a SIGKILL mid-mutation leaves behind: the
    // file already mutated on disk, a backup holding the original, and a
    // marker naming both plus the pid of a process that is now dead.
    const backupDir = makeTmpDir();
    const backupPath = path.join(backupDir, "backup-fixture.js");
    fs.writeFileSync(backupPath, originalContent);
    const mutatedContent = originalContent.replace(
      "return n > 0;",
      "return false; // left-by-sigkill",
    );
    fs.writeFileSync(absFile, mutatedContent);
    const mutatedHash = await sha256File(absFile);

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");

    writeMarker(absFile, {
      targetPath: absFile,
      backupPath,
      preHash,
      mutatedHash,
      pid: deadPid,
      timestamp: new Date().toISOString(),
    });

    const result = await probe(
      baseOptions(repo, { line: 5, replaceText: "  return n * 3;" }),
    );

    expect(result.warnings).toContain("recovered_stale_probe");
    // The recovery restores the original before the requested probe's
    // own (separate) mutation runs, and that mutation is itself restored
    // by the normal flow, so the file ends up back at its true original.
    expect(result.status).toBe("survived");
    expect(fs.readFileSync(absFile, "utf8")).toBe(originalContent);
    expect(readMarkerFor(absFile)).toBeUndefined();
  });

  it("refuses with stale_probe_marker when the marker's dead-pid content matches neither the pre nor the mutated hash", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const originalContent = fs.readFileSync(absFile, "utf8");

    const backupDir = makeTmpDir();
    const backupPath = path.join(backupDir, "backup-fixture.js");
    fs.writeFileSync(backupPath, originalContent);

    // Foreign content: neither the recorded pre-hash nor the recorded
    // "mutated" hash matches what is actually on disk right now.
    fs.writeFileSync(
      absFile,
      "totally unrelated content, not what was mutated\n",
    );

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");

    writeMarker(absFile, {
      targetPath: absFile,
      backupPath,
      preHash: "a".repeat(64),
      mutatedHash: "b".repeat(64),
      pid: deadPid,
      timestamp: new Date().toISOString(),
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_probe_marker");
    // Refused: nothing is touched, the marker stays exactly as it was.
    expect(readMarkerFor(absFile)).toBeDefined();
  });
});

describe("probe(): restore on SIGTERM", () => {
  it("a SIGTERM sent to a child probe process during a slow mutant test run still restores the target and leaves no marker", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");

    const child = spawn(
      "node",
      [
        CLI_PATH,
        "probe",
        "--file",
        "fixture.js",
        "-n",
        "2",
        "-r",
        "  return false;",
        "-t",
        "sleep 3",
        "-i",
        "inplace",
      ],
      {
        cwd: repo,
        env: { ...process.env, AGENT_PRIMITIVES_LOCK_DIR: lockDir },
        stdio: "ignore",
      },
    );

    // Baseline ("sleep 3") finishes around t=3s, the mutation is applied
    // almost instantly, and the mutant run (also "sleep 3") then runs
    // from ~3s to ~6s. Sending SIGTERM at 4.5s lands inside that window,
    // after the marker/backup exist and before restore has happened.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const after = fs.readFileSync(absFile, "utf8");
    expect(after).toBe(before);
    expect(readMarkerFor(absFile)).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 15000);
});
