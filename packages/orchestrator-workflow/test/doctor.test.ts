import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PACKAGE_VERSION } from "../src/assets.js";
import { runDoctor } from "../src/doctor.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS } from "../src/models.js";
import type { Profile } from "../src/models.js";
import {
  OPERATOR_HOME_ENV,
  createOperatorManifest,
  upsertOperatorTarget,
  writeOperatorManifest,
} from "../src/operator-manifest.js";
import type { OperatorManifestDefaults } from "../src/operator-manifest.js";
import { runUninstall } from "../src/uninstall.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let home: string;
const repos: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ow-doctor-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** Installs a fresh repo (via `runInit` directly, no CLI spawn) and returns
 * its realpath, matching how `upsertOperatorTarget` stores target paths. */
function makeRepo(options?: { profile?: Profile }): string {
  const dir = mkdtempSync(join(tmpdir(), "ow-doctor-repo-"));
  repos.push(dir);
  runInit({
    targetDir: dir,
    harnesses: ["claude"],
    models: { ...DEFAULT_MODELS },
    profile: options?.profile,
  });
  return realpathSync(dir);
}

function defaults(
  overrides?: Partial<OperatorManifestDefaults>,
): OperatorManifestDefaults {
  return {
    harnesses: ["claude"],
    profile: "full",
    tiers: false,
    models: {},
    ...overrides,
  };
}

/** Writes the operator manifest at `home` with `targetPaths` registered. */
function registerHome(
  operatorDefaults: OperatorManifestDefaults,
  targetPaths: string[],
): void {
  let manifest = createOperatorManifest(
    operatorDefaults,
    "2026-01-01T00:00:00.000Z",
  );
  for (const path of targetPaths) {
    manifest = upsertOperatorTarget(
      manifest,
      path,
      "0.0.0",
      "2026-01-01T00:00:00.000Z",
    );
  }
  writeOperatorManifest(home, manifest);
}

const REVIEWER_MD = join(".claude", "agents", "reviewer.md");

function tamper(repo: string): void {
  writeFileSync(join(repo, REVIEWER_MD), "tampered content\n", "utf8");
}

function setManifestField(repo: string, patch: Record<string, unknown>): void {
  const manifestPath = join(repo, ".ai", "workflow", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`,
    "utf8",
  );
}

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "doctor", ...args],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, [OPERATOR_HOME_ENV]: home },
    },
  );
}

describe("runDoctor: per-target status", () => {
  it("(1) clean: a fresh install matching operator defaults", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    const report = runDoctor(home, {});
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0].status).toBe("clean");
    expect(report.targets[0].driftFiles).toBeNull();
    expect(report.targets[0].divergence).toEqual({
      profile: false,
      tiers: false,
      models: false,
    });
    expect(report.targets[0].pin).toBeNull();
    expect(report.targets[0].installedVersion).toBe(PACKAGE_VERSION);
    expect(report.exitCode).toBe(0);
  });

  it("(2) drift: a kit-owned file edited after install", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    tamper(repo);
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("drift");
    expect(report.targets[0].driftFiles).toContain(REVIEWER_MD);
    expect(report.exitCode).toBe(1);
  });

  it("(3) missing: a registered target directory that no longer exists", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    rmSync(repo, { recursive: true, force: true });
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("missing");
    expect(report.targets[0].installedVersion).toBeNull();
    expect(report.exitCode).toBe(1);
  });

  it("(4) no-manifest: an uninstalled target still present on disk", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    runUninstall({ targetDir: repo, force: true });
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("no-manifest");
    expect(report.exitCode).toBe(1);
  });

  it("(5) divergent: repo profile minimal vs operator profile full", () => {
    const repo = makeRepo({ profile: "minimal" });
    registerHome(defaults({ profile: "full" }), [repo]);
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("divergent");
    expect(report.targets[0].divergence).toEqual({
      profile: true,
      tiers: false,
      models: false,
    });
    expect(report.exitCode).toBe(0);
  });

  it("(6) version-lag: hand-edited version, no pin", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    setManifestField(repo, { version: "0.0.1" });
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("version-lag");
    expect(report.targets[0].installedVersion).toBe("0.0.1");
    expect(report.exitCode).toBe(0);
  });

  it("(7) a pin equal to the repo's own version is clean, not version-lag", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    setManifestField(repo, { version: "0.0.1", pin: "0.0.1" });
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("clean");
    expect(report.targets[0].pin).toBe("0.0.1");
    expect(report.exitCode).toBe(0);
  });

  it("(11) models divergence: operator default implementer differs from the repo's installed model", () => {
    const repo = makeRepo();
    registerHome(defaults({ models: { implementer: "haiku" } }), [repo]);
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("divergent");
    expect(report.targets[0].divergence).toEqual({
      profile: false,
      tiers: false,
      models: true,
    });
    expect(report.exitCode).toBe(0);
  });

  it("(mutation-probe b) drift takes precedence over divergent when a target is both", () => {
    const repo = makeRepo({ profile: "minimal" });
    registerHome(defaults({ profile: "full" }), [repo]);
    tamper(repo);
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("drift");
    expect(report.targets[0].divergence?.profile).toBe(true);
    expect(report.exitCode).toBe(1);
  });
});

describe("(8) exit-code contract", () => {
  it("no operator manifest exits 2 with the error set and no targets evaluated", () => {
    const report = runDoctor(home, {});
    expect(report.exitCode).toBe(2);
    expect(report.error).toBe("no-operator-manifest");
    expect(report.targets).toEqual([]);
  });

  it("a mixed registry (clean + drift) exits 1", () => {
    const cleanRepo = makeRepo();
    const driftRepo = makeRepo();
    tamper(driftRepo);
    registerHome(defaults(), [cleanRepo, driftRepo]);
    const report = runDoctor(home, {});
    expect(report.exitCode).toBe(1);
  });

  it("a mixed registry (clean + missing) exits 1", () => {
    const cleanRepo = makeRepo();
    const missingRepo = makeRepo();
    // Register while missingRepo still exists (upsert realpaths its
    // argument), then delete it to produce the "missing" case.
    registerHome(defaults(), [cleanRepo, missingRepo]);
    rmSync(missingRepo, { recursive: true, force: true });
    const report = runDoctor(home, {});
    expect(report.exitCode).toBe(1);
  });

  it("an all-clean registry exits 0", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    const report = runDoctor(home, {});
    expect(report.exitCode).toBe(0);
  });

  it("a divergent-only and version-lag-only registry still exits 0", () => {
    const divergentRepo = makeRepo({ profile: "minimal" });
    const lagRepo = makeRepo();
    setManifestField(lagRepo, { version: "0.0.1" });
    registerHome(defaults({ profile: "full" }), [divergentRepo, lagRepo]);
    const report = runDoctor(home, {});
    expect(report.exitCode).toBe(0);
  });
});

describe("(10) --prune", () => {
  it("removes exactly missing/no-manifest targets, keeps the rest, and persists the registry", () => {
    const cleanRepo = makeRepo();
    const driftRepo = makeRepo();
    tamper(driftRepo);
    const divergentRepo = makeRepo({ profile: "minimal" });
    const lagRepo = makeRepo();
    setManifestField(lagRepo, { version: "0.0.1" });
    const missingRepo = makeRepo();
    const noManifestRepo = makeRepo();
    runUninstall({ targetDir: noManifestRepo, force: true });

    // Register while every target directory still exists (upsert realpaths
    // its argument, which throws for a path that is already gone), then
    // delete `missingRepo`'s directory to produce the "missing" case.
    registerHome(defaults({ profile: "full" }), [
      cleanRepo,
      driftRepo,
      divergentRepo,
      lagRepo,
      missingRepo,
      noManifestRepo,
    ]);
    rmSync(missingRepo, { recursive: true, force: true });

    const report = runDoctor(home, { prune: true });

    const remaining = report.targets.map((t) => t.path).sort();
    expect(remaining).toEqual(
      [cleanRepo, driftRepo, divergentRepo, lagRepo].sort(),
    );
    expect(report.pruned.sort()).toEqual([missingRepo, noManifestRepo].sort());
    // driftRepo remains -> still exit 1 after prune.
    expect(report.exitCode).toBe(1);

    const onDisk = JSON.parse(
      readFileSync(join(home, "manifest.json"), "utf8"),
    );
    const onDiskPaths = (onDisk.targets as { path: string }[])
      .map((t) => t.path)
      .sort();
    expect(onDiskPaths).toEqual(
      [cleanRepo, driftRepo, divergentRepo, lagRepo].sort(),
    );
  });

  it("no-op (no write, nothing pruned) when nothing qualifies", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    const before = readFileSync(join(home, "manifest.json"), "utf8");
    const report = runDoctor(home, { prune: true });
    expect(report.pruned).toEqual([]);
    const after = readFileSync(join(home, "manifest.json"), "utf8");
    expect(after).toBe(before);
  });
});

describe("(9) CLI --json", () => {
  it("prints one JSON object whose exitCode matches the process exit status", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    const result = runCli("--json");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.exitCode).toBe(result.status);
    expect(parsed.operatorHome).toBe(resolve(home));
    expect(parsed.operatorVersion).toBe(PACKAGE_VERSION);
    expect(parsed.targets).toEqual([
      {
        path: repo,
        status: "clean",
        installedVersion: PACKAGE_VERSION,
        pin: null,
        divergence: { profile: false, tiers: false, models: false },
        driftFiles: null,
      },
    ]);
    expect(parsed.pruned).toEqual([]);
  });

  it("on a missing operator manifest, prints the no-operator-manifest error object and exits 2", () => {
    const result = runCli("--json");
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      operatorHome: resolve(home),
      operatorVersion: PACKAGE_VERSION,
      targets: [],
      pruned: [],
      exitCode: 2,
      error: "no-operator-manifest",
    });
    expect(result.status).toBe(2);
  });
});

describe("CLI human output", () => {
  it("prints the setup hint to stderr and exits 2 when no operator manifest exists", () => {
    const result = runCli();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "No operator setup found; run `orchestrator-workflow setup` first.",
    );
    expect(result.stdout).toBe("");
  });

  it("prints one line per target and a summary line (no --prune)", () => {
    const cleanRepo = makeRepo();
    const missingRepo = makeRepo();
    // Register while missingRepo still exists (upsert realpaths its
    // argument), then delete it to produce the "missing" case.
    registerHome(defaults(), [cleanRepo, missingRepo]);
    rmSync(missingRepo, { recursive: true, force: true });

    const result = runCli();
    expect(result.stdout).toContain(`clean  ${cleanRepo}`);
    expect(result.stdout).toContain(`missing  ${missingRepo}`);
    expect(result.stdout).toMatch(/\d+ targets:/);
    // missingRepo is present -> exit 1.
    expect(result.status).toBe(1);
  });

  it("prints a pruned line with --prune, and drops the pruned target's own status line", () => {
    const cleanRepo = makeRepo();
    const missingRepo = makeRepo();
    registerHome(defaults(), [cleanRepo, missingRepo]);
    rmSync(missingRepo, { recursive: true, force: true });

    const result = runCli("--prune");
    expect(result.stdout).toContain(`clean  ${cleanRepo}`);
    expect(result.stdout).not.toContain(`missing  ${missingRepo}`);
    expect(result.stdout).toMatch(/\d+ targets:/);
    expect(result.stdout).toContain(`pruned: ${missingRepo}`);
    // missingRepo pruned away, only the clean target remains -> exit 0.
    expect(result.status).toBe(0);
  });

  it("prints divergence, version-lag, and pin detail lines", () => {
    const repo = makeRepo({ profile: "minimal" });
    setManifestField(repo, { pin: "0.0.1" });
    registerHome(defaults({ profile: "full" }), [repo]);

    const result = runCli();
    expect(result.stdout).toContain(`divergent  ${repo}`);
    expect(result.stdout).toContain("profile: repo=minimal, operator=full");
    expect(result.stdout).toContain("pinned at 0.0.1");
  });
});
