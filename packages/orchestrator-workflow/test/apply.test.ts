import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PACKAGE_VERSION } from "../src/assets.js";
import { OPERATOR_HOME_ENV } from "../src/operator-manifest.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let home: string;
let target: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "apply-operator-home-"));
  target = mkdtempSync(join(tmpdir(), "apply-target-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

const operatorManifestPath = () => join(home, "manifest.json");
const repoManifestPath = (dir: string) =>
  join(dir, ".ai", "workflow", "manifest.json");

function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, [OPERATOR_HOME_ENV]: home },
    },
  );
}

function runSetup(...args: string[]) {
  return run("setup", ...args);
}

function runApply(...args: string[]) {
  return run("apply", ...args);
}

function runInitCli(dir: string, ...args: string[]) {
  return run("init", dir, ...args);
}

/** Async counterpart of `runApply`, needed by the concurrency tests below:
 * `spawnSync` blocks this process until the child exits, so two calls can
 * never overlap in wall-clock time no matter how they are sequenced. `spawn`
 * lets several `apply` invocations (or an `apply` and a raw manifest write)
 * genuinely run at the same time. */
function runApplyAsync(
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "apply", ...args],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, [OPERATOR_HOME_ENV]: home },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({ status: code, stdout, stderr }),
    );
  });
}

function readOperatorManifest() {
  return JSON.parse(readFileSync(operatorManifestPath(), "utf8"));
}

function readRepoManifest(dir: string) {
  return JSON.parse(readFileSync(repoManifestPath(dir), "utf8"));
}

/** Snapshot of every file under `dir`, keyed by absolute path, for a
 * byte-for-byte before/after comparison of the target's installed files. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full, readFileSync(full, "utf8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

describe("apply", () => {
  it("exits 1 and touches nothing when no operator setup exists", () => {
    const before = existsSync(target) ? readdirSync(target) : [];
    const result = runApply("--target", target, "--yes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "No operator setup found; run `orchestrator-workflow setup` first.",
    );
    expect(existsSync(operatorManifestPath())).toBe(false);
    expect(readdirSync(target)).toEqual(before);
  });

  it("errors and writes nothing when the target directory does not exist", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const beforeManifest = readFileSync(operatorManifestPath(), "utf8");

    const missing = join(target, "does-not-exist");
    const result = runApply("--target", missing, "--yes");
    expect(result.status).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(readFileSync(operatorManifestPath(), "utf8")).toBe(beforeManifest);
  });

  it("a fresh target installs with operator defaults and registers it", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    // The printed path is the realpath (L10 review finding), not the raw
    // --target argument, so this matches even on a platform whose temp
    // directory is itself reached through a symlink (e.g. macOS's
    // /var -> /private/var).
    expect(result.stdout).toContain(
      `Registered ${realpathSync(target)} in the operator manifest`,
    );

    const repoManifest = readRepoManifest(target);
    expect(repoManifest.harnesses).toEqual(["claude"]);
    expect(repoManifest.profile).toBe("full");
    expect(repoManifest.tiers).toBe(false);

    const operatorManifest = readOperatorManifest();
    expect(operatorManifest.targets).toHaveLength(1);
    expect(operatorManifest.targets[0].lastAppliedVersion).toBe(
      PACKAGE_VERSION,
    );
    expect(operatorManifest.targets[0].lastAppliedAt).toBeTruthy();
  });

  it("a second identical apply is a byte-for-byte no-op on target files, updating only the registry entry's lastAppliedAt", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const before = snapshot(target);
    const beforeTarget = readOperatorManifest().targets[0];

    // A microtask tick is not enough to guarantee a distinct ISO timestamp;
    // the assertion below only requires the version and target set to stay
    // put, not that the timestamp necessarily changed.
    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);

    const after = snapshot(target);
    expect(after).toEqual(before);

    const afterManifest = readOperatorManifest();
    expect(afterManifest.targets).toHaveLength(1);
    expect(afterManifest.targets[0].lastAppliedVersion).toBe(
      beforeTarget.lastAppliedVersion,
    );

    const refreshed = runApply("--target", target, "--yes");
    expect(refreshed.stdout).toContain(
      `Refreshed the registry entry for ${realpathSync(target)}`,
    );
  });

  it("advances lastAppliedAt on a no-op re-apply from a deliberately old seeded timestamp", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const oldTimestamp = "2000-01-01T00:00:00.000Z";
    const manifest = readOperatorManifest();
    manifest.targets[0].lastAppliedAt = oldTimestamp;
    writeFileSync(
      operatorManifestPath(),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);

    const after = readOperatorManifest();
    expect(after.targets).toHaveLength(1);
    expect(after.targets[0].lastAppliedAt).not.toBe(oldTimestamp);
    expect(new Date(after.targets[0].lastAppliedAt).getTime()).toBeGreaterThan(
      new Date(oldTimestamp).getTime(),
    );
  });

  it("a plain apply keeps a target's own recorded profile when it diverges from the operator default, and --sync moves it to the operator default", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--profile", "minimal", "--yes");
    expect(init.status, init.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("minimal");

    const plain = runApply("--target", target, "--yes");
    expect(plain.status, plain.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("minimal");

    const synced = runApply("--target", target, "--sync", "--yes");
    expect(synced.status, synced.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("full");
  });

  it("an explicit --profile wins over both the recorded value and --sync", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--profile", "minimal", "--yes");
    expect(init.status, init.stderr).toBe(0);

    // Operator default is "full" (setup's fallback); --sync alone would move
    // the target to "full", but an explicit --profile minimal must still win.
    const result = runApply(
      "--target",
      target,
      "--sync",
      "--profile",
      "minimal",
      "--yes",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readRepoManifest(target).profile).toBe("minimal");
  });

  it("a plain apply keeps the target's own recorded model, --sync moves it to the operator default, and --models wins over both", () => {
    const setup = runSetup("--models", "implementer=opus", "--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--models", "implementer=haiku", "--yes");
    expect(init.status, init.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("haiku");

    const plain = runApply("--target", target, "--yes");
    expect(plain.status, plain.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("haiku");

    const synced = runApply("--target", target, "--sync", "--yes");
    expect(synced.status, synced.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("opus");

    const overridden = runApply(
      "--target",
      target,
      "--sync",
      "--models",
      "implementer=haiku",
      "--yes",
    );
    expect(overridden.status, overridden.stderr).toBe(0);
    expect(readRepoManifest(target).models.implementer).toBe("haiku");
  });

  it("--sync leaves the target's own recorded harnesses alone (repo codex, operator claude), and an explicit --harness wins over --sync", () => {
    const setup = runSetup("--harness", "claude", "--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const init = runInitCli(target, "--harness", "codex", "--yes");
    expect(init.status, init.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual(["codex"]);

    const synced = runApply("--target", target, "--sync", "--yes");
    expect(synced.status, synced.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual(["codex"]);

    const overridden = runApply(
      "--target",
      target,
      "--sync",
      "--harness",
      "claude",
      "--yes",
    );
    expect(overridden.status, overridden.stderr).toBe(0);
    expect(readRepoManifest(target).harnesses).toEqual(["claude"]);
  });

  it("--pin trims surrounding whitespace and applies", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--pin", "  1.2.3  ", "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(readRepoManifest(target).pin).toBe("1.2.3");
  });

  it("rejects a --pin value containing internal whitespace, writing nothing", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--pin", "1 2", "--yes");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --pin value");
    expect(existsSync(repoManifestPath(target))).toBe(false);
  });

  it("registers the target and records PACKAGE_VERSION even when local edits conflict (the apply ran; edits were kept)", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const skillPath = join(
      target,
      ".claude",
      "skills",
      "orchestrator-workflow",
      "SKILL.md",
    );
    const original = readFileSync(skillPath, "utf8");
    writeFileSync(skillPath, `${original}\nlocal edit\n`, "utf8");

    const second = runApply("--target", target, "--yes");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Conflicts");

    const manifest = readOperatorManifest();
    expect(manifest.targets).toHaveLength(1);
    expect(manifest.targets[0].lastAppliedVersion).toBe(PACKAGE_VERSION);
  });

  it("prints a git-root note for a target that is not a git repository root, matching init's wording", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Note: the target is not a git repository root.",
    );
  });

  it("does not print 'Installing into' or the git-root note when the pin gate skips the run", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const seeded = runApply("--target", target, "--pin", "0.0.1", "--yes");
    expect(seeded.status, seeded.stderr).toBe(0);

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Skipping");
    expect(result.stdout).not.toContain("Installing into");
    expect(result.stdout).not.toContain(
      "Note: the target is not a git repository root.",
    );
  });

  it("warns and proceeds when the repo manifest's raw pin is malformed (non-string), and the pin gate does not run against it", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);
    const first = runApply("--target", target, "--yes");
    expect(first.status, first.stderr).toBe(0);

    const manifestPath = repoManifestPath(target);
    const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    rawManifest.pin = 42;
    writeFileSync(
      manifestPath,
      `${JSON.stringify(rawManifest, null, 2)}\n`,
      "utf8",
    );

    const result = runApply("--target", target, "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ignoring a malformed pin in");
    expect(result.stderr).toContain("the pin gate did not run");
  });

  it("registers a target reached through a symlink under its realpath, and the printed line matches the stored path", () => {
    const setup = runSetup("--yes");
    expect(setup.status, setup.stderr).toBe(0);

    const link = join(tmpdir(), `apply-target-link-${process.pid}`);
    symlinkSync(target, link);
    try {
      const result = runApply("--target", link, "--yes");
      expect(result.status, result.stderr).toBe(0);

      const realTarget = realpathSync(target);
      expect(result.stdout).toContain(
        `Registered ${realTarget} in the operator manifest`,
      );

      const manifest = readOperatorManifest();
      expect(manifest.targets).toHaveLength(1);
      expect(manifest.targets[0].path).toBe(realTarget);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("reports an unreadable operator manifest distinctly from an absent one, and touches nothing", () => {
    writeFileSync(operatorManifestPath(), "{not valid json", "utf8");
    const before = existsSync(target) ? readdirSync(target) : [];

    const result = runApply("--target", target, "--yes");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Operator manifest at ${operatorManifestPath()} is unreadable; back it up and repair it, or remove it and run \`orchestrator-workflow setup\` again.`,
    );
    expect(readdirSync(target)).toEqual(before);
  });

  describe("concurrent applies against the same operator home", () => {
    // The two tests below are deliberately narrower than what H1's fix
    // ("re-read the operator manifest immediately before the upsert")
    // would ideally get covered by. A genuinely discriminating regression
    // test needs an external write to land inside the gap between one
    // apply's re-read and its own write; two fully sequential, non-
    // overlapping `apply` invocations (this test's own two `runApply`
    // calls each run to completion before the next starts) cannot produce
    // that gap, since nothing changes the manifest file while either
    // process is running: whatever a process reads for its final upsert,
    // early or late, is the same on-disk content its own first read
    // already saw. This test was run against a deliberately re-introduced
    // version of the bug (the re-read line reverted to reuse the early
    // copy) and it passed identically either way, confirming it does not
    // discriminate that specific mutation; it still protects a different,
    // real regression (the upsert path silently dropping an unrelated,
    // already-registered target), so it stays.
    //
    // A manual, non-committed timing probe against a truly interleaved
    // write (an external process racing an in-flight `apply`, landing
    // ~50ms into its run) did discriminate: across 10 runs each, the fixed
    // code kept the interleaved target registered 9/10 times and the
    // reverted code only 4/10 times. Both process node startup and `tsx`
    // transpilation dominate a bare `apply` invocation's ~120ms wall
    // time (a `--target` pointing at a nonexistent operator home, which
    // does almost no work before exiting, still takes ~130ms), so the
    // actual read-to-write gap this fix narrows is a small, timing-
    // dependent slice of that; a delay-based CLI-subprocess test tuned to
    // hit it reliably enough for CI was not achievable in the time
    // available (see the log entry for this round and the risk noted in
    // the implementer report). A truly parallel run (three `apply`
    // invocations started at the same instant against three different
    // targets, same operator home) reliably lost two of the three
    // registrations even with the fix applied: process-startup overhead
    // swamps the internal logic timing enough that near-simultaneous
    // starts still race past each other's re-read. The fix narrows the
    // window for staggered concurrent applies (the realistic case: two
    // operators, or one operator's two terminals, rarely start within
    // single-digit milliseconds of each other); it does not close the
    // window for truly simultaneous starts. That residual risk is
    // accepted, not hidden: see the log entry.
    it("a target registered directly in the manifest between two sequential applies is not clobbered by the second apply's own registration", () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);
      const first = runApply("--target", target, "--yes");
      expect(first.status, first.stderr).toBe(0);

      const other = mkdtempSync(join(tmpdir(), "apply-target-other-"));
      try {
        const manifest = readOperatorManifest();
        manifest.targets.push({
          path: realpathSync(other),
          lastAppliedVersion: "9.9.9",
          lastAppliedAt: "2020-01-01T00:00:00.000Z",
        });
        writeFileSync(
          operatorManifestPath(),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );

        const second = runApply("--target", target, "--yes");
        expect(second.status, second.stderr).toBe(0);

        const after = readOperatorManifest();
        const paths = after.targets.map((t: { path: string }) => t.path);
        expect(paths).toContain(realpathSync(target));
        expect(paths).toContain(realpathSync(other));
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("the operator manifest stays valid JSON, with at least one applied target registered, after several concurrent applies", async () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);

      const targetB = mkdtempSync(join(tmpdir(), "apply-target-b-"));
      const targetC = mkdtempSync(join(tmpdir(), "apply-target-c-"));
      try {
        const results = await Promise.all([
          runApplyAsync("--target", target, "--yes"),
          runApplyAsync("--target", targetB, "--yes"),
          runApplyAsync("--target", targetC, "--yes"),
        ]);
        for (const result of results) {
          expect(result.status, result.stderr).toBe(0);
        }

        // Not "all three registered" (see the comment above this describe
        // block): the atomic rename (H1b) guarantees the file itself is
        // never left half-written or corrupt, which is what this asserts.
        const manifest = readOperatorManifest();
        expect(manifest.kit).toBe("orchestrator-workflow");
        expect(manifest.targets.length).toBeGreaterThanOrEqual(1);
        for (const t of manifest.targets) {
          expect(t.lastAppliedVersion).toBe(PACKAGE_VERSION);
        }
      } finally {
        rmSync(targetB, { recursive: true, force: true });
        rmSync(targetC, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("pin gate", () => {
    function seedPinnedTarget(pin: string) {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);
      const seeded = runApply("--target", target, "--pin", pin, "--yes");
      expect(seeded.status, seeded.stderr).toBe(0);
      expect(readRepoManifest(target).pin).toBe(pin);
    }

    it("skips a target pinned to a different version, leaving files and the registry untouched", () => {
      seedPinnedTarget("0.0.1");
      const before = snapshot(target);
      const beforeTarget = readOperatorManifest().targets[0];

      const result = runApply("--target", target, "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Skipping");

      expect(snapshot(target)).toEqual(before);
      expect(readOperatorManifest().targets[0]).toEqual(beforeTarget);
    });

    it("--force-pin proceeds and advances the pin to PACKAGE_VERSION", () => {
      seedPinnedTarget("0.0.1");

      const result = runApply("--target", target, "--force-pin", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBe(PACKAGE_VERSION);
    });

    it("--force-pin on an unpinned target proceeds normally and does not create a pin", () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);

      const result = runApply("--target", target, "--force-pin", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBeUndefined();
    });

    it("--pin <version> proceeds and sets the pin to that version", () => {
      seedPinnedTarget("0.0.1");

      const result = runApply("--target", target, "--pin", "1.2.3", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBe("1.2.3");
    });

    it("--unpin proceeds and clears the pin", () => {
      seedPinnedTarget("0.0.1");

      const result = runApply("--target", target, "--unpin", "--yes");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("Skipping");
      expect(readRepoManifest(target).pin).toBeUndefined();
    });

    it("rejects --pin combined with --unpin as a usage error", () => {
      const setup = runSetup("--yes");
      expect(setup.status, setup.stderr).toBe(0);

      const result = runApply(
        "--target",
        target,
        "--pin",
        "1.2.3",
        "--unpin",
        "--yes",
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "--pin and --unpin cannot be used together",
      );
      expect(existsSync(repoManifestPath(target))).toBe(false);
    });
  });
});
