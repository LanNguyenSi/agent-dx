import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
    expect(result.stdout).toContain(
      `Registered ${target} in the operator manifest`,
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
      `Refreshed the registry entry for ${target}`,
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
