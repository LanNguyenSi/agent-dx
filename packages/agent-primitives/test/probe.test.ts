import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  probe,
  installCrashHandlers,
  signalSettleBoundMs,
  type ProbeOptions,
  type ProbeResult,
} from "../src/probe/index.js";
import { readMarkerFor, writeMarker } from "../src/lock.js";
import { sha256File } from "../src/hash.js";
import { stdioWatchBoundMs } from "../src/exec.js";
import { execCommand } from "../src/exec.js";
import {
  applyPatchForReal,
  computeMutant,
  DEFAULT_GIT_APPLY_TIMEOUT_MS,
  PATCH_MAX_BYTES,
} from "../src/probe/mutant.js";
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
  return {
    ...actual,
    computeMutant: vi.fn(actual.computeMutant),
    applyPatchForReal: vi.fn(actual.applyPatchForReal),
  };
});
vi.mock("../src/probe/isolation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/probe/isolation.js")>();
  return { ...actual, beginInplace: vi.fn(actual.beginInplace) };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "dist", "cli.js");
/** The built library entry point, imported by the spawned script the
 * signal test below uses: that script has to be a library caller in a
 * process of its own, not this one. */
const DIST_INDEX = path.join(__dirname, "..", "dist", "index.js");

/** Every path under `dir` whose basename is `name`, recursively. Used to
 * prove a shell payload did NOT run: the payload can only write a
 * relative name (a filename cannot contain a path separator), so the
 * only honest assertion is that the name appears nowhere under the
 * directories the probe ran commands in. */
function findByName(dir: string, name: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...findByName(full, name));
    else if (entry.name === name) hits.push(full);
  }
  return hits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** Same as `git`, but returns stdout -- used to capture a real `git
 * diff` as a test fixture patch, rather than hand-writing a hunk
 * header. */
function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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
  // Pin the config the real-`git diff` fixture below depends on
  // (headers with a `a/`/`b/` prefix, LF line endings) against whatever
  // the ambient global git config on the machine running these tests
  // happens to be: measured failures under a global `diff.noprefix =
  // true` (drops the `a/`/`b/` prefix `git apply`/this repo's own
  // fixtures assume) and `core.autocrlf = true` (rewrites LF to CRLF on
  // checkout, so the diff no longer matches what was written).
  git(repo, ["config", "diff.noprefix", "false"]);
  git(repo, ["config", "diff.mnemonicPrefix", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
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
      syncedTrackedFiles: 0,
      syncedUntrackedFiles: 0,
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

    const actualMutant = await vi.importActual<
      typeof import("../src/probe/mutant.js")
    >("../src/probe/mutant.js");
    // The real apply against the real target (not the dry run against
    // the scratch copy) is the site under test: corrupting the target
    // exactly as it runs makes the emergency restore it triggers fail
    // too, and a genuine `git apply` of a patch that is not there
    // reports the failure without a hand-built result object.
    vi.mocked(applyPatchForReal).mockImplementationOnce(
      (_patchPath, root, logDir) => {
        fs.rmSync(target, { force: true });
        fs.mkdirSync(target);
        return actualMutant.applyPatchForReal(
          path.join(root, "no-such-file.patch"),
          root,
          logDir,
        );
      },
    );

    const result = await probe(
      baseOptions(repo, { form: "patch", replaceText: undefined, patchPath }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("restore_failed");
    expect(result.mutation_probe?.result).toBe("inconclusive");
    expect(result.mutation_probe?.restored_verified).toBe(false);
    const marker = readMarkerFor(fs.realpathSync(target));
    expect(marker).toBeDefined();
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

describe("probe(): -p derives --file and -n when neither is given", () => {
  it("derives --file (the single path the patch touches) and -n (the first hunk's changed line, header start plus its one leading context line), mirroring the explicit --file end-to-end patch test", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const fixtureLines = FIXTURE_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "derive-single-file.patch");
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
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("killed");
    expect(result.mutant).toMatchObject({
      file: path.join(repo, "fixture.js"),
      line: 2,
      form: "patch",
    });
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("derives the hunk's changed line, not the header's own start line, for a hunk with leading context that does not start at line 1; mutation_probe.mutant quotes that line's content", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const fixtureLines = FIXTURE_JS.split("\n");
    // A real `git diff`, not a hand-written header: edit the committed
    // fixture in place, capture the diff (git's default 3 lines of
    // context, and -- since the file "looks like" source -- its own
    // function-context hint after the second `@@`), then put the
    // working tree back so `probe`'s own read of the file sees the
    // original (unmutated) content, same as every other test here.
    fs.writeFileSync(
      path.join(repo, "fixture.js"),
      before.replace(fixtureLines[4], "  return 999;"),
    );
    const diff = gitOutput(repo, ["diff", "--", "fixture.js"]);
    git(repo, ["checkout", "--", "fixture.js"]);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
    const patchPath = path.join(makeTmpDir(), "derive-mid-file.patch");
    fs.writeFileSync(patchPath, diff);

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.mutant).toMatchObject({
      file: path.join(repo, "fixture.js"),
      line: 5,
      form: "patch",
    });
    expect(result.mutation_probe?.mutant).toContain(fixtureLines[4].trim());
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("runs end to end under -i inplace: the real file is mutated for real, then restored", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const fixtureLines = FIXTURE_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "derive-inplace.patch");
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
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
        isolation: "inplace",
      }),
    );

    expect(result.isolation.mode).toBe("inplace");
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("file_outside_root when the derived path is an in-repo symlink resolving outside the containment root, target untouched", async () => {
    useLockDir();
    const { repo } = initRepo();
    const outsideDir = makeTmpDir();
    const outsideFile = path.join(outsideDir, "outside.js");
    fs.writeFileSync(outsideFile, "module.exports = {};\n");
    const linkPath = path.join(repo, "link-to-outside.js");
    fs.symlinkSync(outsideFile, linkPath);
    const patchPath = path.join(makeTmpDir(), "derive-symlink.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/link-to-outside.js b/link-to-outside.js",
        "index 0000000..1111111 100644",
        "--- a/link-to-outside.js",
        "+++ b/link-to-outside.js",
        "@@ -1 +1 @@",
        "-module.exports = {};",
        "+module.exports = { mutated: true };",
      ].join("\n") + "\n",
    );

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("file_outside_root");
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("module.exports = {};\n");
    // The `-p`-derived `--file` still carries its numstat log path
    // through this early return (dryRunLogPaths: [] would silently
    // drop the caller's ability to inspect why derivation ran).
    expect(result.dryRunLogPaths).toBeDefined();
    expect(result.dryRunLogPaths?.length).toBeGreaterThan(0);
    for (const logPath of result.dryRunLogPaths ?? []) {
      expect(fs.existsSync(logPath)).toBe(true);
    }
  });

  it("usage_error/file_not_found, nothing created, for a new-file patch whose path does not exist yet", async () => {
    useLockDir();
    const { repo } = initRepo();
    const newFilePath = path.join(repo, "brand-new.js");
    const patchPath = path.join(makeTmpDir(), "new-file.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/brand-new.js b/brand-new.js",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/brand-new.js",
        "@@ -0,0 +1,2 @@",
        "+module.exports = {};",
        "+// new",
      ].join("\n") + "\n",
    );

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("file_not_found");
    expect(fs.existsSync(newFilePath)).toBe(false);
  });

  it("resolves the derived path against the containment root, not cwd, when run from a subdirectory of the repo", async () => {
    useLockDir();
    const { repo } = initRepo();
    const workdir = path.join(repo, "workdir");
    fs.mkdirSync(workdir);
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const fixtureLines = FIXTURE_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "derive-from-subdir.patch");
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
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
        cwd: workdir,
        testCommand: `node ${JSON.stringify(path.join(repo, "fixture.test.js"))}`,
      }),
    );

    expect(result.status).toBe("killed");
    expect(result.mutant?.file).toBe(path.join(repo, "fixture.js"));
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("usage_error/patch_file_ambiguous, with the touched paths in a warning and nothing applied, when the patch touches two or more paths and --file is not given", async () => {
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
    const patchPath = path.join(makeTmpDir(), "ambiguous.patch");
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
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("patch_file_ambiguous");
    expect(
      result.warnings.some(
        (w) => w.includes("fixture.js") && w.includes("fixture.test.js"),
      ),
    ).toBe(true);
    // The `git apply --numstat` listing's own log path (used to derive
    // the ambiguity) is carried into the result's logs, not dropped.
    expect(result.dryRunLogPaths?.length).toBeGreaterThan(0);
    expect(result.dryRunLogPaths?.some((p) => fs.existsSync(p))).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      beforeFixture,
    );
    expect(fs.readFileSync(path.join(repo, "fixture.test.js"), "utf8")).toBe(
      beforeTest,
    );
  });

  it("with --file naming one of two touched paths, the existing extra-path refusal is unchanged", async () => {
    useLockDir();
    const { repo } = initRepo();
    const beforeFixture = fs.readFileSync(
      path.join(repo, "fixture.js"),
      "utf8",
    );
    const fixtureLines = FIXTURE_JS.split("\n");
    const testLines = FIXTURE_TEST_JS.split("\n");
    const patchPath = path.join(makeTmpDir(), "two-files-explicit.patch");
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
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: "fixture.js",
        line: undefined,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_not_applicable");
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
  });

  it("inconclusive/mutant_not_applicable when the patch has no hunk header to derive -n from", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const patchPath = path.join(makeTmpDir(), "no-hunk.patch");
    // A rename-only patch: touches exactly one path (so derivation of
    // --file succeeds) but has no `@@` hunk header to derive -n from.
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/fixture.js b/renamed.js",
        "similarity index 100%",
        "rename from fixture.js",
        "rename to renamed.js",
        "",
      ].join("\n"),
    );

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("mutant_not_applicable");
    expect(result.warnings.some((w) => w.includes("no hunk header"))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("usage_error/patch_not_readable, not inconclusive/mutant_not_applicable, for a nonexistent -p/--patch and no --file", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const patchPath = path.join(makeTmpDir(), "does-not-exist.patch");

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("patch_not_readable");
    expect(result.warnings.some((w) => w.includes(patchPath))).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("usage_error/patch_not_readable for a directory passed as -p/--patch and no --file", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const patchPath = makeTmpDir();

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("patch_not_readable");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it.skipIf(os.platform() === "win32")(
    "usage_error/patch_not_readable, never opening it, for a FIFO passed as -p/--patch and no --file",
    async () => {
      // No writer is ever opened against the FIFO. If the upfront stat
      // ever regressed back to reading the patch directly,
      // `fs.readFileSync` on a FIFO with no writer blocks forever (this
      // was measured: it survives `SIGTERM` and needs `SIGKILL`), so
      // this test would hang until the timeout below rather than fail
      // fast -- the timeout is what turns that regression into a
      // reported failure instead of a stuck run.
      useLockDir();
      const { repo } = initRepo();
      const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
      const patchPath = path.join(makeTmpDir(), "patch.fifo");
      execFileSync("mkfifo", [patchPath]);

      const result = await probe(
        baseOptions(repo, {
          form: "patch",
          replaceText: undefined,
          patchPath,
          file: undefined,
          line: undefined,
        }),
      );

      expect(result.status).toBe("usage_error");
      expect(result.reason).toBe("patch_not_readable");
      expect(
        result.warnings.some((w) => w.includes("not a regular file")),
      ).toBe(true);
      expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
        before,
      );
    },
    15_000,
  );

  it("usage_error/patch_not_readable naming the size and the cap, for a -p/--patch over PATCH_MAX_BYTES", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const patchPath = path.join(makeTmpDir(), "oversized.patch");
    fs.writeFileSync(patchPath, "@@ -1 +1 @@\n-old\n+new\n");
    const oversizedBytes = PATCH_MAX_BYTES + 1;
    fs.truncateSync(patchPath, oversizedBytes);

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("patch_not_readable");
    expect(
      result.warnings.some(
        (w) =>
          w.includes(String(oversizedBytes)) &&
          w.includes(String(PATCH_MAX_BYTES)),
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("usage_error/patch_not_readable for a nonexistent -p/--patch even with an explicit --file", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const patchPath = path.join(makeTmpDir(), "does-not-exist.patch");

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: "fixture.js",
        line: undefined,
      }),
    );

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("patch_not_readable");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  });

  it("file_outside_root inconclusive, never applied, when the patch's single derived path resolves outside the containment root", async () => {
    useLockDir();
    const { repo } = initRepo();
    const patchPath = path.join(makeTmpDir(), "outside.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/../outside.txt b/../outside.txt",
        "index 0000000..1111111 100644",
        "--- a/../outside.txt",
        "+++ b/../outside.txt",
        "@@ -1 +1 @@",
        "-original",
        "+mutated",
      ].join("\n") + "\n",
    );

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        file: undefined,
        line: undefined,
      }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("file_outside_root");
    expect(result.warnings.some((w) => w.includes("outside.txt"))).toBe(true);
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

describe("probe(): -p patch paths reach git apply without a shell", () => {
  it("applies a patch whose own filename carries $(...) and a backtick, and executes neither", async () => {
    useLockDir();
    const { repo } = initRepo();
    const before = fs.readFileSync(path.join(repo, "fixture.js"), "utf8");
    const logDir = makeTmpDir();
    const patchDir = makeTmpDir();
    const fixtureLines = FIXTURE_JS.split("\n");

    // Both shell substitution forms, in the patch file's own name. `sh
    // -c` expands both even inside double quotes, so any scheme that
    // quotes this path into a shell command runs them; handing git an
    // argv array leaves no shell to expand anything. The payloads write
    // relative names because a filename cannot contain a path
    // separator, so the assertions below search every directory the
    // probe ran a command in.
    const patchPath = path.join(
      patchDir,
      "mutant$(touch injected-by-dollar.txt)`touch injected-by-backtick.txt`.patch",
    );
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
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        logDir,
      }),
    );

    // The security claim first, so a regression is reported as "the
    // payload ran" rather than as whatever the mangled path did next.
    for (const name of ["injected-by-dollar.txt", "injected-by-backtick.txt"]) {
      expect(findByName(logDir, name)).toEqual([]);
      expect(findByName(repo, name)).toEqual([]);
      expect(findByName(patchDir, name)).toEqual([]);
    }

    // And the patch itself still works: the path is passed through
    // intact, not sanitized into something git cannot open.
    expect(result.status).toBe("killed");
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(before);
  }, 20000);
});

describe("probe(): a signal while a library-mode probe is running", () => {
  it("resolves inconclusive/aborted with the target restored, and leaves the calling process alive (the exitOnSignal default)", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const logDir = makeTmpDir();
    const ready = path.join(repo, "ready.txt");

    // The baseline (unmutated) finishes instantly; only the mutant run
    // signals readiness and then stays alive long enough to be
    // interrupted (self-terminating, so a run that never gets the signal
    // cannot hang the suite).
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('SLOW_MARKER')) {",
        "  fs.writeFileSync('ready.txt', 'go');",
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
      "slow test",
    ]);

    // A library caller: `probe()` with no `exitOnSignal`, so the SIGTERM
    // below must not end the process that called it. It runs in a
    // process of its own only so the signal can be aimed at exactly one
    // probe without touching the test runner.
    const scriptPath = path.join(makeTmpDir(), "library-probe.mjs");
    fs.writeFileSync(
      scriptPath,
      [
        `import { probe } from ${JSON.stringify(pathToFileURL(DIST_INDEX).href)};`,
        "const result = await probe({",
        '  file: "fixture.js",',
        "  line: 2,",
        '  form: "replace",',
        '  replaceText: "  return false; // SLOW_MARKER",',
        '  testCommand: "node fixture.test.js",',
        '  isolation: "inplace",',
        '  expect: "fail",',
        `  cwd: ${JSON.stringify(repo)},`,
        `  logDir: ${JSON.stringify(logDir)},`,
        "});",
        "process.stdout.write(JSON.stringify(result));",
        "",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [scriptPath], {
      cwd: repo,
      env: { ...process.env, AGENT_PRIMITIVES_LOCK_DIR: lockDir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const deadline = Date.now() + 20000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("the mutant-phase test never signalled readiness");
      }
      await sleep(50);
    }

    child.kill("SIGTERM");
    const [code, signal] = await new Promise<
      [number | null, NodeJS.Signals | null]
    >((resolve) => {
      child.on("close", (c, sig) => resolve([c, sig]));
    });

    // The default is `exitOnSignal: false`: the process that called
    // probe() finished normally and printed its result. With the default
    // flipped it would be gone with 143 and an empty stdout instead.
    expect(signal).toBeNull();
    expect(code).toBe(0);

    const result = JSON.parse(stdout) as ProbeResult;
    // Never killed: the interrupted test child exits non-zero, which
    // under --expect fail reads exactly like a mutant the suite caught.
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.mutation_probe?.result).toBe("inconclusive");
    expect(result.mutation_probe?.restored_verified).toBe(true);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 60000);
});

describe("probe(): the lock is keyed on the repository", () => {
  it("probe_in_progress when a second probe targets a different file in the same repository while the first is still running", async () => {
    useLockDir();
    const { repo } = initRepo();
    const otherFile = path.join(repo, "other.js");
    fs.writeFileSync(otherFile, "const x = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "other"]);
    const beforeFixture = fs.readFileSync(
      path.join(repo, "fixture.js"),
      "utf8",
    );
    const beforeOther = fs.readFileSync(otherFile, "utf8");

    const first = probe(
      baseOptions(repo, { testCommand: "sleep 1 && node fixture.test.js" }),
    );
    // Give the first call a moment to acquire the lock before the second
    // one starts.
    await sleep(200);
    const second = await probe(
      baseOptions(repo, {
        file: "other.js",
        line: 1,
        replaceText: "const x = 2;",
      }),
    );

    // Two files, one working tree: the second probe would have built and
    // tested a tree carrying the first probe's mutation.
    expect(second.status).toBe("inconclusive");
    expect(second.reason).toBe("probe_in_progress");

    const firstResult = await first;
    expect(firstResult.status).toBe("killed");
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      beforeFixture,
    );
    expect(fs.readFileSync(otherFile, "utf8")).toBe(beforeOther);
  }, 20000);

  it("keys the lock on the target file outside a repository: a second probe on a different file proceeds", async () => {
    useLockDir();
    // No `git init`: there is no shared working tree to serialize on, so
    // the target file itself is the lock's identity.
    const dir = makeTmpDir();
    for (const name of ["a", "b"]) {
      fs.writeFileSync(
        path.join(dir, `${name}.js`),
        [
          "function value() {",
          "  return 1;",
          "}",
          `module.exports = { value };`,
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(dir, `${name}.test.js`),
        [
          "const assert = require('node:assert');",
          `const { value } = require('./${name}.js');`,
          "assert.strictEqual(value(), 1);",
          "",
        ].join("\n"),
      );
    }

    const first = probe({
      ...baseOptions(dir),
      file: "a.js",
      line: 2,
      replaceText: "  return 2;",
      testCommand: "sleep 1 && node a.test.js",
    });
    await sleep(200);
    const second = await probe({
      ...baseOptions(dir),
      file: "b.js",
      line: 2,
      replaceText: "  return 2;",
      testCommand: "node b.test.js",
    });

    expect(second.reason).not.toBe("probe_in_progress");
    expect(second.status).toBe("killed");
    expect((await first).status).toBe("killed");
  }, 20000);
});

describe("probe(): output that may be incomplete", () => {
  it("warns, naming the phase, when a run settled on exec's flush grace with a descendant still holding its pipes", async () => {
    useLockDir();
    const { repo } = initRepo();

    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const mockExec = vi.mocked(execCommand);
    let callCount = 0;
    mockExec.mockImplementation(
      async (...args: Parameters<typeof execCommand>) => {
        callCount += 1;
        const result = await actualExec.execCommand(...args);
        // Call 1 is the baseline test, call 2 the mutant-phase test:
        // marking only the second means the warning below can only have
        // come from the mutant run.
        return callCount === 2
          ? { ...result, outputMayBeIncomplete: true }
          : result;
      },
    );

    try {
      const result = await probe(baseOptions(repo));
      expect(result.status).toBe("killed");
      expect(
        result.warnings.some(
          (w) => w.startsWith("mutant:") && w.includes("may be incomplete"),
        ),
      ).toBe(true);
    } finally {
      mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
        actualExec.execCommand(...args),
      );
    }
  }, 20000);
});

describe("probe(): an aborted run in the baseline phase and on --pre", () => {
  /** Runs `probe` with the nth `execCommand` call reported as aborted
   * (the shape `exec.ts` returns once its `signal` fired: killed child,
   * no exit code of its own), every other call running for real. */
  async function probeWithAbortedCall(
    nth: number,
    overrides: Partial<ProbeOptions>,
  ): Promise<ProbeResult> {
    const actualExec =
      await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const mockExec = vi.mocked(execCommand);
    let callCount = 0;
    mockExec.mockImplementation(
      async (...args: Parameters<typeof execCommand>) => {
        callCount += 1;
        const result = await actualExec.execCommand(...args);
        return callCount === nth
          ? { ...result, aborted: true, exitCode: null }
          : result;
      },
    );
    try {
      const { repo } = initRepo();
      return await probe(baseOptions(repo, overrides));
    } finally {
      mockExec.mockImplementation((...args: Parameters<typeof execCommand>) =>
        actualExec.execCommand(...args),
      );
    }
  }

  it("an aborted baseline is inconclusive/aborted, not baseline_failed: nothing was learned about the test", async () => {
    useLockDir();
    // Call 1 with no --pre is the baseline test itself.
    const result = await probeWithAbortedCall(1, {});
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.reason).not.toBe("baseline_failed");
  }, 20000);

  it("an aborted --pre in the baseline phase is inconclusive/aborted, not pre_failed", async () => {
    useLockDir();
    // With a --pre, call 1 is that --pre in the baseline phase.
    const result = await probeWithAbortedCall(1, { preCommand: "true" });
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.reason).not.toBe("pre_failed");
  }, 20000);

  it("an aborted --pre in the mutant phase is inconclusive/aborted, and the target is restored", async () => {
    useLockDir();
    // Call order with a --pre: 1) baseline --pre, 2) baseline test,
    // 3) mutant --pre.
    const result = await probeWithAbortedCall(3, { preCommand: "true" });
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("aborted");
    expect(result.mutation_probe?.restored_verified).toBe(true);
  }, 20000);
});

/** The single-file patch every `-p` fixture below uses: it replaces
 * `fixture.js`'s line 2, exactly as the `replace` form would. */
function writeSingleLinePatch(patchPath: string): void {
  const fixtureLines = FIXTURE_JS.split("\n");
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
}

describe("probe(): the emergency restore is the last write to the target", () => {
  it("a signalled CLI probe whose test command traps SIGTERM and SIGINT leaves no descendant alive and leaves the target at its original content, even against a writer that outruns the restore", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const ready = path.join(repo, "ready.txt");
    const heartbeat = path.join(repo, "heartbeat.txt");

    // Two writers, each aimed at one half of the guarantee.
    //
    // The test command itself TRAPS SIGTERM and SIGINT, so only SIGKILL
    // can end it, and it writes the target 3s in. A signal path that
    // sends SIGTERM and exits leaves it running (the escalation timer
    // dies with the process that scheduled it), and it then writes over
    // the restored file. Its heartbeat is the descendant-is-gone proof.
    //
    // The watcher is spawned INTO A PROCESS GROUP OF ITS OWN, so the
    // group kill cannot reach it, and it holds the test command's
    // inherited stdout/stderr. Its stdin is a pipe from the test
    // command: when that command dies, the pipe closes, the watcher
    // wakes on EOF and writes the target at once, then exits, which is
    // what finally lets the run settle. A restore that does not wait for
    // the run to settle therefore lands BEFORE that write and loses the
    // file; one that waits lands after it and wins.
    fs.writeFileSync(
      path.join(repo, "watcher.js"),
      [
        "const fs = require('node:fs');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync('fixture.js', 'POISON_FROM_WATCHER\\n');",
        "  process.exit(0);",
        "});",
        "setTimeout(() => { process.exit(0); }, 15000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (!content.includes('SLOW_MARKER')) { process.exit(0); }",
        "process.on('SIGTERM', () => {});",
        "process.on('SIGINT', () => {});",
        "spawn(process.execPath, ['watcher.js'], {",
        "  detached: true,",
        "  stdio: ['pipe', 'inherit', 'inherit'],",
        "});",
        "let n = 0;",
        "const tick = () => {",
        "  n += 1;",
        "  fs.writeFileSync('heartbeat.txt', String(n));",
        "};",
        "tick();",
        "setInterval(tick, 100);",
        "fs.writeFileSync('ready.txt', 'running');",
        "setTimeout(() => {",
        "  fs.writeFileSync('fixture.js', 'POISON_FROM_TEST_CHILD\\n');",
        "  process.exit(0);",
        "}, 3000);",
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
      "trapping test command",
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

    // Readiness: the mutant-phase test is really running (and its
    // watcher spawned), not merely scheduled.
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("ready.txt never appeared before the deadline");
      }
      await sleep(50);
    }
    await sleep(150);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    // The restore was the last write: neither the out-of-group watcher's
    // write (which lands while the run is settling) nor anything else is
    // sitting on the target when the process is gone.
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );

    // No descendant survived the exit: the trapping test command's
    // heartbeat has stopped, and its own delayed write never happens.
    const countAtExit = fs.existsSync(heartbeat)
      ? fs.readFileSync(heartbeat, "utf8")
      : "";
    await sleep(4000);
    expect(
      fs.existsSync(heartbeat) ? fs.readFileSync(heartbeat, "utf8") : "",
    ).toBe(countAtExit);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  }, 40000);

  it("a CLI probe whose out-of-group descendant writes the target 500-800ms after EOF (past exec's 250ms flush grace) still has that write land before the restore: exit 143, empty stdout, target at its original content well past the delay, marker and lock gone", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const ready = path.join(repo, "ready.txt");

    // The watcher holds the test command's inherited stdout/stderr (so
    // exec.ts cannot settle on `close`) and is spawned into a process
    // group of its own (so the SIGKILL group-kill this probe's signal
    // handler sends cannot reach it). It waits on its own stdin for EOF
    // (delivered once the test command dies) and only then, after a
    // delay comfortably past exec.ts's 250ms flush grace but well under
    // the 2000ms default settle bound, writes the target and exits --
    // which is what finally lets the run's stdio truly close. Before
    // round 6's fix, the signal handler awaited the run's own promise
    // (settled early by the flush grace) instead of true closure, so
    // this write landed AFTER the restore and the marker was already
    // gone.
    fs.writeFileSync(
      path.join(repo, "watcher.js"),
      [
        "const fs = require('node:fs');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync('fixture.js', 'POISON_FROM_DELAYED_WATCHER\\n');",
        "    process.exit(0);",
        "  }, 650);",
        "});",
        "setTimeout(() => { process.exit(0); }, 15000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (!content.includes('SLOW_MARKER')) { process.exit(0); }",
        "spawn(process.execPath, ['watcher.js'], {",
        "  detached: true,",
        "  stdio: ['pipe', 'inherit', 'inherit'],",
        "});",
        "fs.writeFileSync('ready.txt', 'running');",
        "setTimeout(() => { process.exit(0); }, 10000);",
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
      "delayed watcher",
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
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("ready.txt never appeared before the deadline");
      }
      await sleep(50);
    }
    await sleep(150);

    const signalledAt = Date.now();
    child.kill("SIGTERM");
    const [code] = await new Promise<[number | null]>((resolve) => {
      child.on("close", (c) => resolve([c]));
    });

    expect(code).toBe(143);
    expect(stdout).toBe("");
    // The CLI process itself exiting proves nothing about the watcher,
    // which is a fully independent (detached) process the exit does not
    // touch: a broken wait would let the CLI restore and exit around the
    // 250ms flush grace, well before the watcher's own 650ms write, and
    // reading the file immediately after `close` would then pass by
    // coincidence (the poison simply had not landed yet), not because
    // the fix held. Waiting out the watcher's own delay from the moment
    // of the signal (not from `close`) is what makes this assertion
    // discriminate: if the poison writer ever gets to run at all, it is
    // done well before this point either way.
    const elapsedSinceSignal = Date.now() - signalledAt;
    if (elapsedSinceSignal < 1200) {
      await sleep(1200 - elapsedSinceSignal);
    }
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 20000);

  it("a CLI probe whose out-of-group descendant holds stdio past the signal-settle bound still restores the target at exit, but keeps the marker and backup (a recovery trail), which doctor reports and the next probe recovers from", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const ready = path.join(repo, "ready.txt");

    // AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS shortens the bound this
    // probe's signal handler waits for true stdio closure, purely so
    // this test proves the past-the-bound path in milliseconds instead
    // of the real 2000ms default. The watcher holds stdio for 3000ms --
    // comfortably past the shortened 250ms bound -- so the handler is
    // guaranteed to give up before it closes.
    const shortBoundMs = 250;
    fs.writeFileSync(
      path.join(repo, "watcher.js"),
      ["setTimeout(() => { process.exit(0); }, 3000);", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (!content.includes('SLOW_MARKER')) { process.exit(0); }",
        "spawn(process.execPath, ['watcher.js'], {",
        "  detached: true,",
        "  stdio: ['ignore', 'inherit', 'inherit'],",
        "});",
        "fs.writeFileSync('ready.txt', 'running');",
        "setTimeout(() => { process.exit(0); }, 10000);",
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
      "past the bound",
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
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS: String(shortBoundMs),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("ready.txt never appeared before the deadline");
      }
      await sleep(50);
    }
    await sleep(150);

    child.kill("SIGTERM");
    const [code] = await new Promise<[number | null]>((resolve) => {
      child.on("close", (c) => resolve([c]));
    });

    // Even though the marker is kept, the CLI still ends deterministically
    // (mutual exclusion, the round-6 finding this closes) rather than
    // racing its own return against the handler's exit.
    expect(code).toBe(143);
    expect(stdout).toBe("");
    // The restore itself still succeeded (the watcher never touched the
    // target in this test; only its holding stdio open matters).
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);

    const marker = readMarkerFor(fs.realpathSync(absFile));
    expect(marker).toBeDefined();
    expect(fs.existsSync(marker!.backupPath)).toBe(true);
    // The lock itself is still released regardless: only the marker and
    // backup are the deliberate exception.
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );

    const doctorRun = await new Promise<{
      code: number | null;
      stdout: string;
    }>((resolve) => {
      const doctorChild = spawn("node", [CLI_PATH, "-C", repo, "doctor"], {
        env: { ...process.env, AGENT_PRIMITIVES_LOCK_DIR: lockDir },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      doctorChild.stdout.setEncoding("utf8");
      doctorChild.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      doctorChild.on("close", (c) => resolve({ code: c, stdout: out }));
    });
    const doctorEnvelope = JSON.parse(doctorRun.stdout);
    const staleMarkerCheck = (
      doctorEnvelope.checks as Array<{
        name: string;
        ok: boolean;
        detail: string;
      }>
    ).find((c) => c.name === "stale-probe-marker");
    expect(staleMarkerCheck?.ok).toBe(false);
    expect(staleMarkerCheck?.detail).toContain("auto-recover");

    // The next probe on the same file recovers: the target already
    // matches the marker's own pre-mutation hash, so this is the
    // "already correct" recovery branch (no backup copy needed), not a
    // hash mismatch. Restore the real test file first: the past-the-bound
    // probe above overwrote it with the never-passing SLOW_MARKER
    // fixture, and this run needs a baseline that actually passes.
    fs.writeFileSync(path.join(repo, "fixture.test.js"), FIXTURE_TEST_JS);
    const recoveryRun = await new Promise<{
      code: number | null;
      stdout: string;
    }>((resolve) => {
      const recoveryChild = spawn(
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
          "node fixture.test.js",
          "-i",
          "inplace",
        ],
        {
          cwd: repo,
          env: { ...process.env, AGENT_PRIMITIVES_LOCK_DIR: lockDir },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let out = "";
      recoveryChild.stdout.setEncoding("utf8");
      recoveryChild.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      recoveryChild.on("close", (c) => resolve({ code: c, stdout: out }));
    });
    const recoveryEnvelope = JSON.parse(recoveryRun.stdout);
    expect(recoveryEnvelope.status).toBe("killed");
    expect(
      (recoveryEnvelope.warnings as string[]).some((w) =>
        w.includes("stale probe marker"),
      ),
    ).toBe(true);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
  }, 30000);

  it("a SIGTERM during the baseline phase of a plain, non-trapping test command exits 143 with empty stdout, even when the signal handler's own restore-then-exit is forced to be slower than the normal control flow's own return path", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");

    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      ["setTimeout(() => {}, 30000);", ""].join("\n"),
    );
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "plain slow baseline",
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
        "  return false;",
        "-t",
        "node fixture.test.js",
        "-i",
        "inplace",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          // Same seam as the mutant-test-phase case below: without the
          // mutual-exclusion gate at this site, isHandling() being
          // deterministically true by the time either path reacts is
          // NOT by itself enough to make the exit code deterministic --
          // it only guarantees the gate CAN check the right thing, not
          // that the underlying process.exit race resolves the same way
          // every time. Artificially slowing the handler this way is
          // what actually proves the gate holds regardless of that
          // race, and reproduces the round-6 bug when it does not.
          AGENT_PRIMITIVES_TEST_HANDLER_DELAY_MS: "300",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    // The baseline phase has no readiness file of its own (it is the
    // very first thing the probe runs); this fixed wait just gives the
    // spawned node process time to actually start the test command
    // before the signal lands.
    await sleep(800);

    child.kill("SIGTERM");
    const [code] = await new Promise<[number | null]>((resolve) => {
      child.on("close", (c) => resolve([c]));
    });

    expect(code).toBe(143);
    expect(stdout).toBe("");
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 15000);

  it("a SIGTERM during the mutant-test phase of a plain, non-trapping test command exits 143 with empty stdout, and the target is restored, even when the signal handler's own restore-then-exit is forced to be slower than the normal control flow's own return path", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const ready = path.join(repo, "ready.txt");

    fs.writeFileSync(
      path.join(repo, "fixture.test.js"),
      [
        "const fs = require('node:fs');",
        "const content = fs.readFileSync('fixture.js', 'utf8');",
        "if (content.includes('SLOW_MARKER')) {",
        "  fs.writeFileSync('ready.txt', 'go');",
        "  setTimeout(() => {}, 30000);",
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
      "plain slow mutant test",
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
        env: {
          ...process.env,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
          // Seam only: proves the mutual exclusion is a hard gate
          // (the normal flow never returns while the handler is
          // active), not a race this test happens to win by timing.
          // Without the gate, artificially slowing the handler this
          // way is exactly what lets the normal flow's own return
          // path finish first and print an envelope instead of
          // hanging, which is the round-6 bug this closes.
          AGENT_PRIMITIVES_TEST_HANDLER_DELAY_MS: "300",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) {
        throw new Error("ready.txt never appeared before the deadline");
      }
      await sleep(50);
    }
    await sleep(150);

    child.kill("SIGTERM");
    const [code] = await new Promise<[number | null]>((resolve) => {
      child.on("close", (c) => resolve([c]));
    });

    expect(code).toBe(143);
    expect(stdout).toBe("");
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 20000);

  it("a signal during the real git apply leaves the target unmutated, and the apply never lands after the restore", async () => {
    const lockDir = useLockDir();
    const { repo } = initRepo();
    const absFile = path.join(repo, "fixture.js");
    const before = fs.readFileSync(absFile, "utf8");
    const patchPath = path.join(makeTmpDir(), "single-line.patch");
    writeSingleLinePatch(patchPath);

    // A PATH shim that widens the real apply's window: it delays only
    // when it is run from a git work tree (the real apply's cwd is the
    // repository root; the dry run's is a scratch directory with no
    // .git), so the dry run stays fast and only the one apply that
    // writes the real target sits in a signal's way.
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    const shimDir = makeTmpDir();
    const applyStarted = path.join(repo, "apply-started.txt");
    fs.writeFileSync(
      path.join(shimDir, "git"),
      [
        "#!/bin/sh",
        "if [ -d .git ]; then",
        `  printf running > ${JSON.stringify(applyStarted)}`,
        "  sleep 3",
        "fi",
        `exec ${JSON.stringify(realGit)} "$@"`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(shimDir, "git"), 0o755);

    const child = spawn(
      "node",
      [
        CLI_PATH,
        "probe",
        "--file",
        "fixture.js",
        "-n",
        "2",
        "-p",
        patchPath,
        "-t",
        "node fixture.test.js",
        "-i",
        "inplace",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
          AGENT_PRIMITIVES_LOCK_DIR: lockDir,
        },
        stdio: "ignore",
      },
    );

    // Readiness: the real apply is in flight (the shim is sleeping).
    const deadline = Date.now() + 25000;
    while (!fs.existsSync(applyStarted)) {
      if (Date.now() > deadline) {
        throw new Error("the real git apply never started before the deadline");
      }
      await sleep(50);
    }
    // The marker is up while the apply is in flight, and must not be
    // removed until the apply has settled and the restore is verified.
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeDefined();

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    // Past the shim's own delay: an apply that was not killed with the
    // process would run to completion here and mutate the target with
    // nothing left to restore it.
    await sleep(4000);
    expect(fs.readFileSync(absFile, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(absFile))).toBeUndefined();
    expect(fs.readdirSync(lockDir).filter((f) => f.endsWith(".lock"))).toEqual(
      [],
    );
  }, 60000);
});

describe("probe(): a git apply stopped by its own bound", () => {
  it("reports git_apply_timeout, not mutant_not_applicable, when the real apply is killed by its timeout", async () => {
    useLockDir();
    const { repo } = initRepo();
    const target = path.join(repo, "fixture.js");
    const before = fs.readFileSync(target, "utf8");
    const patchPath = path.join(makeTmpDir(), "single-line.patch");
    writeSingleLinePatch(patchPath);

    // The apply that hit its bound and was killed: a non-zero exit with
    // `timedOut`, which is exactly what run.ts reports for one.
    vi.mocked(applyPatchForReal).mockImplementationOnce(
      async (_patchPath, _root, logDir) => ({
        exitCode: null,
        durationMs: 10,
        stdout: "",
        stderr: "",
        logPath: path.join(logDir, "apply.log"),
        timedOut: true,
        aborted: false,
        outputTruncated: false,
        logWriteFailed: false,
        stdioClosed: true,
      }),
    );

    const result = await probe(
      baseOptions(repo, { form: "patch", replaceText: undefined, patchPath }),
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("git_apply_timeout");
    expect(result.reason).not.toBe("mutant_not_applicable");
    expect(result.warnings.some((w) => w.includes("timeout"))).toBe(true);
    // Nothing was mutated, and the marker was cleared by the verified
    // restore the timeout path runs.
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(readMarkerFor(fs.realpathSync(target))).toBeUndefined();
  }, 20000);
});

describe("probe(): gitApplyTimeoutMs derivation at the probe entry", () => {
  it("threads --timeout through to both computeMutant's dry run and the real apply", async () => {
    useLockDir();
    const { repo } = initRepo();
    const patchPath = path.join(makeTmpDir(), "single-line.patch");
    writeSingleLinePatch(patchPath);
    const timeoutMs = 4321;

    const result = await probe(
      baseOptions(repo, {
        form: "patch",
        replaceText: undefined,
        patchPath,
        timeoutMs,
      }),
    );

    expect(result.status).toBe("killed");
    expect(vi.mocked(computeMutant)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs }),
    );
    expect(vi.mocked(applyPatchForReal)).toHaveBeenCalledWith(
      patchPath,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ timeoutMs }),
    );
  }, 20000);

  it("falls back to DEFAULT_GIT_APPLY_TIMEOUT_MS for both calls when no --timeout is given", async () => {
    useLockDir();
    const { repo } = initRepo();
    const patchPath = path.join(makeTmpDir(), "single-line.patch");
    writeSingleLinePatch(patchPath);

    const result = await probe(
      baseOptions(repo, { form: "patch", replaceText: undefined, patchPath }),
    );

    expect(result.status).toBe("killed");
    expect(vi.mocked(computeMutant)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: DEFAULT_GIT_APPLY_TIMEOUT_MS }),
    );
    expect(vi.mocked(applyPatchForReal)).toHaveBeenCalledWith(
      patchPath,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ timeoutMs: DEFAULT_GIT_APPLY_TIMEOUT_MS }),
    );
  }, 20000);
});

describe("installCrashHandlers(): re-entrancy", () => {
  it("a second signal arriving within a few ms of the first, while it is still being handled, is ignored: exactly one abort, one wait, one restore attempt, one release, and one exit", async () => {
    let abortCount = 0;
    let waitCount = 0;
    let restoreCount = 0;
    let releaseCount = 0;
    const exitCalls: number[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      exitCalls.push(code ?? 0);
      return undefined as never;
    }) as never);

    const crashHandlers = installCrashHandlers(
      () => ({
        restore: () => {
          restoreCount += 1;
          return true;
        },
        targetPath: "/dev/null",
        markerKey: "re-entrancy-test",
        backupPath: "/dev/null",
        preHash: "irrelevant-since-restore-is-stubbed",
      }),
      () => {
        releaseCount += 1;
      },
      () => {
        abortCount += 1;
      },
      async () => {
        waitCount += 1;
        return true;
      },
      true,
      async () => {
        // No worktree session in this test; a no-op cleanup mirrors what
        // `probe()` itself passes when `wtWorktreePath` was never set.
      },
    );
    try {
      // Both signals land in the same tick, before the handler's own
      // async body has run past its first `await`: exactly the window
      // `handling` guards.
      process.emit("SIGTERM" as never);
      process.emit("SIGTERM" as never);
      await crashHandlers.handled;
      // The handler's own restore is stubbed to succeed synchronously,
      // but `sha256File` against a real path still runs (`/dev/null`
      // hashes to a fixed value, never `preHash`), so `verified` is
      // false and the marker is deliberately kept -- irrelevant to this
      // test, which only counts how many times each step ran.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(abortCount).toBe(1);
      expect(waitCount).toBe(1);
      expect(restoreCount).toBe(1);
      expect(releaseCount).toBe(1);
      expect(exitCalls).toEqual([143]);
    } finally {
      crashHandlers.remove();
      exitSpy.mockRestore();
    }
  });
});

describe("signalSettleBoundMs(): clamped below exec's stdio watch bound", () => {
  const SETTLE = "AGENT_PRIMITIVES_SIGNAL_SETTLE_BOUND_MS";
  const WATCH = "AGENT_PRIMITIVES_STDIO_WATCH_BOUND_MS";
  const saved: Record<string, string | undefined> = {};

  function setEnv(name: string, value: string | undefined): void {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const name of Object.keys(saved)) delete saved[name];
  });

  it("defaults to 2000ms, below the default 10s watch bound", () => {
    setEnv(SETTLE, undefined);
    setEnv(WATCH, undefined);
    expect(signalSettleBoundMs()).toBe(2000);
    expect(signalSettleBoundMs()).toBeLessThan(stdioWatchBoundMs());
  });

  it("honours a shorter override as given", () => {
    setEnv(SETTLE, "150");
    setEnv(WATCH, undefined);
    expect(signalSettleBoundMs()).toBe(150);
  });

  it("clamps an override at or above the watch bound to just below it, so a settle wait can never outlast exec's give-up", () => {
    setEnv(WATCH, undefined);
    setEnv(SETTLE, "10000");
    expect(signalSettleBoundMs()).toBe(stdioWatchBoundMs() - 1);
    setEnv(SETTLE, "600000");
    expect(signalSettleBoundMs()).toBe(stdioWatchBoundMs() - 1);
  });

  it("clamps the default too when the watch bound itself is shortened", () => {
    setEnv(SETTLE, undefined);
    setEnv(WATCH, "300");
    expect(signalSettleBoundMs()).toBe(299);
  });

  it("falls back to the default for a garbage override", () => {
    setEnv(WATCH, undefined);
    for (const garbage of ["", "abc", "-5", "0", "NaN", "Infinity"]) {
      setEnv(SETTLE, garbage);
      expect(signalSettleBoundMs()).toBe(2000);
    }
  });
});
