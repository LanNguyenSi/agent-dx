import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import { probe, type ProbeOptions } from "../src/probe/index.js";
import { readMarkerFor, writeMarker } from "../src/lock.js";
import { sha256File } from "../src/hash.js";
import { execCommand } from "../src/exec.js";
import { computeMutant } from "../src/probe/mutant.js";
import { beginInplace } from "../src/probe/isolation.js";

// Call-through partial mocks: every call runs the real implementation
// unless a test explicitly overrides it (and always restores the
// call-through default before it finishes). This is the only way to
// force a specific exec call to reject, or a specific computeMutant call
// to report a hash that does not match what it actually wrote, without
// relying on filesystem tricks that would also corrupt the very backup
// the restore needs to verify against (`vi.spyOn` cannot be used
// directly on an ESM named export; Vitest throws "Module namespace is
// not configurable").
vi.mock("../src/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/exec.js")>();
  return { ...actual, execCommand: vi.fn(actual.execCommand) };
});
vi.mock("../src/probe/mutant.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/mutant.js")>();
  return { ...actual, computeMutant: vi.fn(actual.computeMutant) };
});
vi.mock("../src/probe/isolation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/isolation.js")>();
  return { ...actual, beginInplace: vi.fn(actual.beginInplace) };
});

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

  it("baseline_failed with baseline.timedOut: true when --timeout is hit during the (still unmutated) baseline run", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(
      baseOptions(repo, { testCommand: "sleep 5", timeoutMs: 300 }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_failed");
    expect(result.baseline?.timedOut).toBe(true);
    expect(result.baseline?.exitCode).not.toBe(0);

    const after = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    expect(after).toBe(before);
  }, 10000);

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
    // `mutation_probe.result` stays within killed|survived|inconclusive;
    // the detail lives in the top-level `reason` above.
    expect(result.mutation_probe?.result).toBe("inconclusive");
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

    // The marker is left in place for a human, on purpose. Markers are
    // keyed by the resolved realpath, which can differ from the repo's
    // own display path (e.g. macOS's /var -> /private/var), so a test
    // reading a marker back has to key it the same way probe() does.
    const marker = readMarkerFor(
      fs.realpathSync(path.join(repo, "fixture.js")),
    );
    expect(marker).toBeDefined();

    // Cleanup: the lock dir is test-scoped, but the corrupted directory
    // under the repo (a mkdtemp path, not the real checkout) should still
    // be removed before the afterEach rmSync runs into it; rmSync with
    // force+recursive already handles a directory fine, so nothing extra
    // is required here. Referencing lockDir keeps the variable used.
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("patch-apply-failure site: marker survives when the real git apply fails and the emergency restore also fails", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const fixtureLines = FIXTURE_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "single-file.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/fixture.js b/fixture.js",
        "index 0000000..0000000 100644",
        "--- a/fixture.js",
        "+++ b/fixture.js",
        "@@ -1,3 +1,3 @@",
        ` ${fixtureLines[0]}`,
        `-${fixtureLines[1]}`,
        "+  return false;",
        ` ${fixtureLines[2]}`,
      ].join("\n") + "\n",
    );

    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const mockExec = vi.mocked(execCommand);
    let callCount = 0;
    mockExec.mockImplementation((...args: Parameters<typeof execCommand>) => {
      callCount += 1;
      // Call order for a -p probe with no --pre: 1) the dry-run apply,
      // 2) its --numstat check, 3) the baseline test, 4) the REAL apply
      // against `root`. Corrupting the target right as call 4 runs (so
      // the emergency restore it triggers also fails) and reporting
      // that apply as failed isolates exactly the patch-apply-failure
      // restore site.
      if (callCount === 4) {
        fs.rmSync(target, { force: true });
        fs.mkdirSync(target);
        return actualExec.execCommand("exit 1", {
          cwd: args[1].cwd,
          logDir: args[1].logDir,
        });
      }
      return actualExec.execCommand(...args);
    });

    try {
      const result = await probe(
        baseOptions(repo, { form: "patch", replaceText: undefined, patchPath }),
      );
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("restore_failed");
      expect(result.mutation_probe?.result).toBe("inconclusive");
      expect(result.mutation_probe?.restored_verified).toBe(false);
      const marker = readMarkerFor(fs.realpathSync(target));
      expect(marker).toBeDefined();
    } finally {
      mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
        actualExec.execCommand(...args),
      );
    }
  });

  it("hash-mismatch site: marker survives when the post-apply hash check fails and the resulting restore also fails (the backup vanished)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");

    const actualMutant = await vi.importActual<
      typeof import("../src/probe/mutant.js")
    >("../src/probe/mutant.js");
    const mockComputeMutant = vi.mocked(computeMutant);
    mockComputeMutant.mockImplementationOnce(async (spec, mutantOpts) => {
      const real = await actualMutant.computeMutant(spec, mutantOpts);
      if (!real.applicable) return real;
      // The backup was already taken (and verified) before this call, at
      // a deterministic path this test knows ahead of time; deleting it
      // here simulates it vanishing between being taken and being
      // needed, so the hash-mismatch site's own restore attempt fails
      // cleanly (copyFileSync from a backup that no longer exists).
      const backupPath = path.join(mutantOpts.logDir, "backup-fixture.js");
      fs.rmSync(backupPath, { force: true });
      return { ...real, mutatedHash: "0".repeat(64) };
    });

    try {
      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("restore_failed");
      expect(result.mutation_probe?.result).toBe("inconclusive");
      expect(result.mutation_probe?.restored_verified).toBe(false);
      const marker = readMarkerFor(fs.realpathSync(target));
      expect(marker).toBeDefined();
    } finally {
      mockComputeMutant.mockImplementation(
        (...args: Parameters<typeof computeMutant>) =>
          actualMutant.computeMutant(...args),
      );
    }
  });

  it("mutant-phase pre_failed site: marker survives when --pre fails in the mutant phase and the resulting restore also fails (the backup vanished)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();
    const backupPath = path.join(logDir, "backup-fixture.js");

    const result = await probe(
      baseOptions(repo, {
        logDir,
        replaceText: "  return n > 0 !!! syntax error;",
        preCommand: `node --check fixture.js || { rm -f ${JSON.stringify(backupPath)}; exit 1; }`,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("restore_failed");
    expect(result.mutation_probe?.result).toBe("inconclusive");
    expect(result.mutation_probe?.restored_verified).toBe(false);
    const marker = readMarkerFor(
      fs.realpathSync(path.join(repo, "fixture.js")),
    );
    expect(marker).toBeDefined();
  });
});

describe("probe(): the target is backed up (and checked) before any mutation, not after", () => {
  it("target_changed_during_baseline when the baseline run itself rewrites the target: aborts before any mutation or marker, leaves the target exactly as the baseline wrote it (not restored)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");

    // The test command (run for the baseline, unmutated) rewrites the
    // target itself and exits 0, standing in for a formatter or codegen
    // step baked into the test command. A node one-liner, not `printf`
    // (whose escape handling is shell-dialect-dependent).
    const result = await probe(
      baseOptions(repo, {
        testCommand:
          "node -e \"require('fs').writeFileSync('fixture.js', 'REWRITTEN')\"",
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("target_changed_during_baseline");
    // The mutant was already computed (against the true original
    // content) before the baseline ran, so it is still reported.
    expect(result.mutant).toBeDefined();
    // Never restored: the baseline's own write stands, since it was not
    // this probe's mutation to undo.
    expect(fs.readFileSync(target, "utf8")).toBe("REWRITTEN");
    expect(fs.readFileSync(target, "utf8")).not.toBe(before);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  });
});

describe("probe(): the backup is verified before anything is mutated", () => {
  it("backup_verification_failed, target untouched and no marker written, when the backup does not match the target's pre-mutation hash", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");

    // Corrupt the backup in the one window that matters: after
    // `beginInplace` has taken it and before `probe` verifies it. Doing
    // it through the call-through mock (rather than racing the real
    // filesystem) is what makes the window deterministic.
    const actualIsolation = await vi.importActual<
      typeof import("../src/probe/isolation.js")
    >("../src/probe/isolation.js");
    const mockBeginInplace = vi.mocked(beginInplace);
    mockBeginInplace.mockImplementationOnce((targetPath, logDir) => {
      const session = actualIsolation.beginInplace(targetPath, logDir);
      fs.writeFileSync(session.backupPath, "truncated backup\n");
      return session;
    });

    try {
      const result = await probe(baseOptions(repo));

      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("backup_verification_failed");
      // Nothing was mutated: without a trustworthy backup there is no
      // way back, so the probe refuses before it starts.
      expect(fs.readFileSync(target, "utf8")).toBe(before);
      expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
      expect(result.mutant).toBeUndefined();
    } finally {
      mockBeginInplace.mockImplementation(
        (...args: Parameters<typeof beginInplace>) =>
          actualIsolation.beginInplace(...args),
      );
    }
  });
});

describe("probe(): a failing baseline that also rewrote the target", () => {
  it("keeps the backup and names it in a warning instead of discarding it silently", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const originalContent = fs.readFileSync(target, "utf8");
    const logDir = makeTmpDir();

    // A baseline that rewrites the target and then fails: a formatter or
    // codegen step that also reports an error. The pre-baseline content
    // now exists nowhere except in the backup this probe took.
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync('fixture.js', 'rewritten by the baseline\\n');",
        "process.exit(1);",
        "",
      ].join("\n"),
    );

    const result = await probe(baseOptions(repo, { logDir }));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("baseline_failed");
    // Left exactly as the baseline wrote it: that write was not this
    // probe's own, so it is not this probe's to undo.
    expect(fs.readFileSync(target, "utf8")).toBe("rewritten by the baseline\n");
    // The backup survives and still holds the pre-baseline content...
    const backupPath = path.join(logDir, "backup-fixture.js");
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf8")).toBe(originalContent);
    // ...and the caller is told where it is and why it is there.
    expect(
      result.warnings.some(
        (w) => w.includes(backupPath) && w.includes("rewrote the target"),
      ),
    ).toBe(true);
  });

  it("discards the backup for a failing baseline that left the target alone", async () => {
    useLockDir();
    const { repo } = initRepo();
    const logDir = makeTmpDir();

    const result = await probe(
      baseOptions(repo, { logDir, testCommand: "exit 1" }),
    );

    expect(result.reason).toBe("baseline_failed");
    // Nothing to preserve, so no orphaned backup and no warning about one.
    expect(fs.existsSync(path.join(logDir, "backup-fixture.js"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("rewrote the target"))).toBe(
      false,
    );
  });
});

describe("probe(): SIGKILL-left marker is recovered by the next invocation", () => {
  it("recovers a marker whose recorded pid is dead and whose mutated hash matches the current file, then proceeds with the requested probe", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    // Markers are keyed by the resolved realpath, which can differ from
    // the repo's own display path (e.g. macOS's /var -> /private/var):
    // a test simulating a leftover marker has to key it exactly as a
    // real probe() run would.
    const markerKey = fs.realpathSync(absFile);
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

    writeMarker(markerKey, {
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
    expect(readMarkerFor(markerKey)).toBeUndefined();
  });

  it("recovers a marker whose recorded pid is alive (a live foreign process), since under the lock every marker is treated as an unfinished probe regardless of pid", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const markerKey = fs.realpathSync(absFile);
    const originalContent = fs.readFileSync(absFile, "utf8");
    const preHash = await sha256File(absFile);

    const backupDir = makeTmpDir();
    const backupPath = path.join(backupDir, "backup-fixture.js");
    fs.writeFileSync(backupPath, originalContent);
    const mutatedContent = originalContent.replace(
      "return n > 0;",
      "return false; // left-behind",
    );
    fs.writeFileSync(absFile, mutatedContent);
    const mutatedHash = await sha256File(absFile);

    // This process's own pid: genuinely alive, standing in for "a
    // foreign process that happens to still be running". The lock
    // already excludes a second live probe on this target, so the
    // marker's own pid must not gate recovery.
    writeMarker(markerKey, {
      targetPath: absFile,
      backupPath,
      preHash,
      mutatedHash,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });

    const result = await probe(
      baseOptions(repo, { line: 5, replaceText: "  return n * 3;" }),
    );

    expect(result.warnings).toContain("recovered_stale_probe");
    expect(result.status).toBe("survived");
    expect(fs.readFileSync(absFile, "utf8")).toBe(originalContent);
    expect(readMarkerFor(markerKey)).toBeUndefined();
  });

  it("clears a marker whose target already matches its recorded pre-mutation hash, with a warning, and proceeds", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const markerKey = fs.realpathSync(absFile);
    const originalContent = fs.readFileSync(absFile, "utf8");
    const preHash = await sha256File(absFile);

    const backupDir = makeTmpDir();
    const backupPath = path.join(backupDir, "backup-fixture.js");
    fs.writeFileSync(backupPath, originalContent);

    // The target is already back at its pre-mutation content (e.g. a
    // previous probe restored successfully but crashed before removing
    // its own marker): mutatedHash matches nothing on disk, but preHash
    // does.
    writeMarker(markerKey, {
      targetPath: absFile,
      backupPath,
      preHash,
      mutatedHash: "f".repeat(64),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });

    const result = await probe(baseOptions(repo));

    expect(result.warnings.some((w) => w.includes("already matched"))).toBe(
      true,
    );
    expect(result.status).toBe("killed");
    expect(readMarkerFor(markerKey)).toBeUndefined();
    expect(fs.readFileSync(absFile, "utf8")).toBe(originalContent);
  });

  it("refuses with stale_probe_marker when the marker's dead-pid content matches neither the pre nor the mutated hash", async () => {
    useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const markerKey = fs.realpathSync(absFile);
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

    writeMarker(markerKey, {
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
    expect(readMarkerFor(markerKey)).toBeDefined();
  });

  it("stale_probe_marker naming the missing backup and the marker file (not a generic restore failure) when the marker's backup file is gone", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const markerKey = fs.realpathSync(absFile);
    const originalContent = fs.readFileSync(absFile, "utf8");
    const preHash = await sha256File(absFile);

    // Never created on disk: simulates a backup that did not survive.
    const missingBackupPath = path.join(makeTmpDir(), "backup-fixture.js-gone");
    const mutatedContent = originalContent.replace(
      "return n > 0;",
      "return false; // left-behind",
    );
    fs.writeFileSync(absFile, mutatedContent);
    const mutatedHash = await sha256File(absFile);

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");

    writeMarker(markerKey, {
      targetPath: absFile,
      backupPath: missingBackupPath,
      preHash,
      mutatedHash,
      pid: deadPid,
      timestamp: new Date().toISOString(),
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_probe_marker");
    expect(
      result.warnings.some(
        (w) => w.includes(missingBackupPath) && w.includes("missing"),
      ),
    ).toBe(true);
    expect(result.warnings.some((w) => w.includes(`${lockDir}`))).toBe(true);
    // Refused, not silently recovered or mutated further.
    expect(fs.readFileSync(absFile, "utf8")).toBe(mutatedContent);
    expect(readMarkerFor(markerKey)).toBeDefined();
  });

  it("refuses with stale_probe_marker and leaves the target's mutated content in place when the recorded backup does not match the marker's pre-mutation hash", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const markerKey = fs.realpathSync(absFile);
    const originalContent = fs.readFileSync(absFile, "utf8");
    const preHash = await sha256File(absFile);

    // A backup that exists but holds neither the recorded pre-mutation
    // content nor anything else this target ever had: truncated by the
    // crash that left the marker, half-written, or simply the wrong
    // file. Copying it over the target would destroy the only remaining
    // copy of the mutated content, and the mutated content is what a
    // human needs in order to understand what the killed probe did.
    const corruptBackup = path.join(makeTmpDir(), "backup-fixture.js");
    fs.writeFileSync(corruptBackup, "corrupt: not this target's content\n");

    const mutatedContent = originalContent.replace(
      "return n > 0;",
      "return false; // left-by-sigkill",
    );
    fs.writeFileSync(absFile, mutatedContent);
    const mutatedHash = await sha256File(absFile);

    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (!deadPid) throw new Error("failed to obtain a dead pid for the test");

    writeMarker(markerKey, {
      targetPath: absFile,
      backupPath: corruptBackup,
      preHash,
      mutatedHash,
      pid: deadPid,
      timestamp: new Date().toISOString(),
    });

    const result = await probe(baseOptions(repo));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("stale_probe_marker");
    // The load-bearing assertion: the target still holds exactly the
    // mutated content, so the corrupt backup was never written over it.
    expect(fs.readFileSync(absFile, "utf8")).toBe(mutatedContent);
    expect(result.warnings.some((w) => w.includes(corruptBackup))).toBe(true);
    // The marker file itself is named, since clearing this needs a human.
    expect(result.warnings.some((w) => w.includes(lockDir))).toBe(true);
    expect(readMarkerFor(markerKey)).toBeDefined();
  });
});

describe("probe(): restore on SIGTERM", () => {
  it("a SIGTERM sent to a child probe process during a slow mutant test run still restores the target, leaves no marker, and kills the in-flight test child instead of leaving it running", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const heartbeat = path.join(repo, "heartbeat.txt");

    // The baseline (unmutated) finishes instantly; only once the test
    // observes the mutation does it spawn a worker of its own and keep
    // running for up to 10s (self-terminating so a test that never gets
    // SIGTERM would not hang the suite). The worker is a GRANDCHILD of
    // the probe process: it inherits the test command's stdout and
    // stderr, so a signal that reaches only the direct child leaves it
    // running and holding those pipes. It writes a heartbeat file every
    // 100ms; a still-running worker keeps incrementing it, a killed one
    // does not, and that is the actual proof the whole process group is
    // gone rather than a guess about process trees under `sh -c`.
    fs.writeFileSync(
      path.join(repo, "heartbeat-worker.js"),
      [
        "const fs = require('node:fs');",
        "let n = 0;",
        "const tick = () => {",
        "  n += 1;",
        "  fs.writeFileSync('heartbeat.txt', String(n));",
        "};",
        "tick();",
        "const id = setInterval(tick, 100);",
        "setTimeout(() => { clearInterval(id); process.exit(0); }, 10000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('SLOW_MARKER')) {",
        "  spawn(process.execPath, ['heartbeat-worker.js'], {",
        "    stdio: 'inherit',",
        "  });",
        "  setTimeout(() => { process.exit(0); }, 10000);",
        "} else { process.exit(0); }",
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
      "heartbeat test",
    ]);

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
        "  return false; // SLOW_MARKER",
        "-t",
        "node fixture.test.js",
        "-i",
        "inplace",
      ],
      {
        cwd: repo,
        env: { ...process.env, AGENT_PRIMITIVES_LOCK_DIR: lockDir },
        stdio: "ignore",
      },
    );

    // Readiness signal: wait for the heartbeat file to actually appear,
    // meaning the mutant-phase test is running (not merely scheduled),
    // instead of guessing at a fixed baseline duration.
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(heartbeat)) {
      if (Date.now() > deadline) {
        throw new Error("heartbeat.txt never appeared before the deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // One more tick so there is a non-zero count to compare against.
    await new Promise((resolve) => setTimeout(resolve, 150));

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const after = fs.readFileSync(absFile, "utf8");
    expect(after).toBe(before);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );

    // The actual descendant-is-gone proof: the grandchild worker's
    // heartbeat must have stopped incrementing once the probe process
    // exited. A worker that only lost its parent keeps counting.
    const countAtExit = fs.readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const countAfterSettling = fs.readFileSync(heartbeat, "utf8");
    expect(countAfterSettling).toBe(countAtExit);
  }, 20000);
});

describe("probe(): restore in the pipeline's finally", () => {
  it("restores via the pipeline's finally and leaves the target hash equal to the pre-mutation hash when the mutant-phase exec call rejects", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");
    const preHash = await sha256File(target);

    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const mockExec = vi.mocked(execCommand);
    let callCount = 0;
    mockExec.mockImplementation((...args: Parameters<typeof execCommand>) => {
      callCount += 1;
      // Call 1 is the baseline test (must succeed for the pipeline to
      // reach the mutant phase at all); call 2 is the mutant-phase test,
      // forced to reject the way a genuine exec-level failure would
      // (e.g. a log dir that turned out to be a file).
      if (callCount === 2) {
        return Promise.reject(
          new Error(
            "forced rejection: simulated exec failure during the mutant-phase run",
          ),
        );
      }
      return actualExec.execCommand(...args);
    });

    try {
      await expect(probe(baseOptions(repo))).rejects.toThrow(
        /forced rejection/,
      );
      expect(fs.readFileSync(target, "utf8")).toBe(before);
      expect(await sha256File(target)).toBe(preHash);
      expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
    } finally {
      mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
        actualExec.execCommand(...args),
      );
    }
  });

  it("resolves inconclusive/restore_failed (never rejects) and leaves the marker in place when the finally's own emergency restore also fails", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");

    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const mockExec = vi.mocked(execCommand);
    let callCount = 0;
    mockExec.mockImplementation((...args: Parameters<typeof execCommand>) => {
      callCount += 1;
      // Same forced rejection as above, but this time the target is
      // also corrupted (turned into a directory) right before the
      // rejection, so the finally's own emergency restore fails too.
      if (callCount === 2) {
        fs.rmSync(target, { force: true });
        fs.mkdirSync(target);
        return Promise.reject(
          new Error(
            "forced rejection: simulated exec failure during the mutant-phase run",
          ),
        );
      }
      return actualExec.execCommand(...args);
    });

    try {
      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("restore_failed");
      expect(result.warnings.some((w) => w.includes("forced rejection"))).toBe(
        true,
      );
      const marker = readMarkerFor(fs.realpathSync(target));
      expect(marker).toBeDefined();
    } finally {
      mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
        actualExec.execCommand(...args),
      );
    }
  });
});

describe("probe(): --pre/-t run in the invocation cwd, not the containment root", () => {
  it("a probe from a subdirectory of a monorepo with -t 'npm test' picks up that subdirectory's own test script and yields killed", async () => {
    useLockDir();
    const repo = makeTmpDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "test"]);
    // The root package's own "test" script is deliberately mutation-blind
    // (always exits 0): if the probe wrongly runs commands from the
    // containment root instead of the invocation cwd, `npm test` picks
    // up THIS script instead of the subpackage's own, and the mutant
    // looks "survived" no matter what it does.
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "root",
        version: "1.0.0",
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
    );
    const subDir = path.join(repo, "packages", "sub");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "package.json"),
      JSON.stringify({
        name: "sub",
        version: "1.0.0",
        scripts: { test: "node fixture.test.js" },
      }),
    );
    fs.writeFileSync(path.join(subDir, "fixture.js"), FIXTURE_JS);
    fs.writeFileSync(path.join(subDir, "fixture.test.js"), FIXTURE_TEST_JS);
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    const before = fs.readFileSync(path.join(subDir, "fixture.js"), "utf8");

    const result = await probe(
      baseOptions(subDir, { testCommand: "npm test" }),
    );

    expect(result.status).toBe("killed");
    expect(fs.readFileSync(path.join(subDir, "fixture.js"), "utf8")).toBe(
      before,
    );
  }, 30000);
});

describe("probe(): a non-zero --pre is pre_failed, never a verdict", () => {
  it("pre_failed when --pre fails specifically in the mutant phase (a rebuild refusing to build broken output)", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");

    const result = await probe(
      baseOptions(repo, {
        // Syntactically invalid: stands in for "the mutation broke the
        // build" -- `--pre`'s syntax check (a stand-in for a rebuild)
        // passes against the unmutated baseline and fails against this.
        replaceText: "  return n > 0 !!! syntax error;",
        preCommand: "node --check fixture.js",
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("pre_failed");
    expect(["killed", "survived"]).not.toContain(result.status);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("pre_failed during the baseline run when --pre already fails unmutated", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");

    const result = await probe(baseOptions(repo, { preCommand: "exit 1" }));

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("pre_failed");
    expect(result.baseline).toBeUndefined();
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });
});

describe("probe(): the post-apply hash-changed check", () => {
  it("reports inconclusive/apply_hash_mismatch with a real restored_verified when the applied content's hash does not match what was predicted, and never leaves the mutant behind", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");
    const preHash = await sha256File(target);

    // The real file write still uses the real (correct) `newContent`,
    // so the mutation genuinely applies -- only the predicted
    // `mutatedHash` this one call reports back is deliberately wrong.
    // Everything else about the pipeline (the backup, the baseline run)
    // stays completely real, so this isolates exactly the post-apply
    // hash comparison, not restore's own verification.
    const actualMutant = await vi.importActual<
      typeof import("../src/probe/mutant.js")
    >("../src/probe/mutant.js");
    const mockComputeMutant = vi.mocked(computeMutant);
    mockComputeMutant.mockImplementationOnce(async (spec, mutantOpts) => {
      const real = await actualMutant.computeMutant(spec, mutantOpts);
      if (!real.applicable) return real;
      return { ...real, mutatedHash: "0".repeat(64) };
    });

    try {
      const result = await probe(baseOptions(repo));

      // A structured verdict the caller can act on, not an exception:
      // thrown, this would reach the CLI as `status: "error"` under an
      // unknown command, losing both the reason and the evidence that
      // the target really is back at its pre-mutation content.
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("apply_hash_mismatch");
      expect(result.mutation_probe?.result).toBe("inconclusive");
      expect(result.mutation_probe?.restored_verified).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe(before);
      expect(await sha256File(target)).toBe(preHash);
      expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
    } finally {
      mockComputeMutant.mockImplementation(
        (...args: Parameters<typeof computeMutant>) =>
          actualMutant.computeMutant(...args),
      );
    }
  });
});

describe("probe(): a missing --file is a usage_error, not an uncaught filesystem error", () => {
  it("usage_error/file_not_found, naming the resolved path in a warning, exit-class cannot-conclude", async () => {
    useLockDir();
    const { repo } = initRepo();
    const missing = path.join(repo, "does-not-exist.js");

    const result = await probe(
      baseOptions(repo, { file: "does-not-exist.js" }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("file_not_found");
    expect(result.warnings.some((w) => w.includes(missing))).toBe(true);
  });
});

describe("probe(): containment resolves symlinks before checking", () => {
  it("file_outside_root when --file is an in-repo symlink resolving outside the containment root", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outsideDir = makeTmpDir();
    const outsideFile = path.join(outsideDir, "outside.js");
    fs.writeFileSync(outsideFile, "module.exports = {};\n");
    const linkPath = path.join(repo, "link-to-outside.js");
    fs.symlinkSync(outsideFile, linkPath);

    const result = await probe(
      baseOptions(repo, {
        file: "link-to-outside.js",
        line: 1,
        replaceText: "x",
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("file_outside_root");
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("module.exports = {};\n");
  });
});

describe("probe(): -p patches touching paths other than --file", () => {
  it("mutant_not_applicable when the patch also touches a second file, and neither file is left mutated", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const fixtureLines = FIXTURE_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "two-file.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/fixture.js b/fixture.js",
        "index 0000000..0000000 100644",
        "--- a/fixture.js",
        "+++ b/fixture.js",
        "@@ -2,6 +2,6 @@",
        ` ${fixtureLines[1]}`,
        ` ${fixtureLines[2]}`,
        ` ${fixtureLines[3]}`,
        `-${fixtureLines[4]}`,
        "+  return n * 3;",
        ` ${fixtureLines[5]}`,
        ` ${fixtureLines[6]}`,
        "diff --git a/extra.js b/extra.js",
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        "+++ b/extra.js",
        "@@ -0,0 +1 @@",
        "+extra file content",
      ].join("\n") + "\n",
    );

    const result = await probe(
      baseOptions(repo, { form: "patch", replaceText: undefined, patchPath }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_not_applicable");
    expect(result.warnings.some((w) => w.includes("extra.js"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "extra.js"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("mutant_not_applicable naming the extra path, not a generic did-not-apply, when the second file the patch touches already exists in the repository", async () => {
    useLockDir();
    const { repo } = initRepo();
    const beforeFixture = fs.readFileSync(
      path.join(repo, "fixture.js"),
      "utf8",
    );
    const beforeTest = fs.readFileSync(
      path.join(repo, "fixture.test.js"),
      "utf8",
    );
    const fixtureLines = FIXTURE_JS.split("\n");
    const testLines = FIXTURE_TEST_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "two-existing-files.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/fixture.js b/fixture.js",
        "index 0000000..0000000 100644",
        "--- a/fixture.js",
        "+++ b/fixture.js",
        "@@ -1,3 +1,3 @@",
        ` ${fixtureLines[0]}`,
        `-${fixtureLines[1]}`,
        "+  return false;",
        ` ${fixtureLines[2]}`,
        "diff --git a/fixture.test.js b/fixture.test.js",
        "index 0000000..0000000 100644",
        "--- a/fixture.test.js",
        "+++ b/fixture.test.js",
        "@@ -1,3 +1,3 @@",
        ` ${testLines[0]}`,
        `-${testLines[1]}`,
        "+const { isPositive } = require('./fixture.js'); // touched",
        ` ${testLines[2]}`,
      ].join("\n") + "\n",
    );

    const result = await probe(
      baseOptions(repo, { form: "patch", replaceText: undefined, patchPath }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_not_applicable");
    // The specific diagnosis, not "the patch did not apply cleanly": the
    // scratch dry run is seeded with --file alone, so a second file that
    // exists in the repository but not in the scratch copy would fail
    // that dry run for a reason that has nothing to do with the patch.
    expect(
      result.warnings.some(
        (w) =>
          w.includes("touches paths other than --file") &&
          w.includes("fixture.test.js"),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      beforeFixture,
    );
    expect(fs.readFileSync(path.join(repo, "fixture.test.js"), "utf8")).toBe(
      beforeTest,
    );
  });
});

describe("probe(): -p integration through probe(), and --pre in both phases", () => {
  it("runs a -p patch mutant end to end: applies for real, tests, restores", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const fixtureLines = FIXTURE_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "single-file.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/fixture.js b/fixture.js",
        "index 0000000..0000000 100644",
        "--- a/fixture.js",
        "+++ b/fixture.js",
        "@@ -1,3 +1,3 @@",
        ` ${fixtureLines[0]}`,
        `-${fixtureLines[1]}`,
        "+  return false;",
        ` ${fixtureLines[2]}`,
      ].join("\n") + "\n",
    );

    const result = await probe(
      baseOptions(repo, { form: "patch", replaceText: undefined, patchPath }),
    );

    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("runs --pre in both the baseline and mutant phases", async () => {
    useLockDir();
    const { repo } = initRepo();
    const counterFile = path.join(makeTmpDir(), "counter.txt");
    fs.writeFileSync(counterFile, "0");
    const preScript = path.join(makeTmpDir(), "count.js");
    fs.writeFileSync(
      preScript,
      [
        "const fs = require('fs');",
        `const n = Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8')) + 1;`,
        `fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));`,
        "",
      ].join("\n"),
    );

    const result = await probe(
      baseOptions(repo, { preCommand: `node ${JSON.stringify(preScript)}` }),
    );

    expect(result.status).toBe("killed");
    expect(fs.readFileSync(counterFile, "utf8")).toBe("2");
  });
});

describe("probe(): -p combined with --allow-outside", () => {
  it("usage_error when -p is combined with --allow-outside", async () => {
    useLockDir();
    const { repo } = initRepo();
    const patchPath = path.join(makeTmpDir(), "unused.patch");
    fs.writeFileSync(patchPath, "");

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        allowOutside: true,
      }),
    );

    expect(result.status).toBe("usage_error");
  });
});
