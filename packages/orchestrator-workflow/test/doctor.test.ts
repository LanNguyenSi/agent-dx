import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

  it("(3b) missing-file drift: a kit-owned file deleted, manifest.json intact", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    rmSync(join(repo, REVIEWER_MD));
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("drift");
    expect(report.targets[0].driftFiles).toContain(REVIEWER_MD);
    expect(report.exitCode).toBe(1);
  });

  it("(mutation-probe a) an unreadable kit-owned file counts as drift for that path, the rest of the registry still reports", () => {
    if (process.getuid?.() === 0) return; // root can read anything; skip.
    const cleanRepo = makeRepo();
    const unreadableRepo = makeRepo();
    registerHome(defaults(), [cleanRepo, unreadableRepo]);
    const filePath = join(unreadableRepo, REVIEWER_MD);
    chmodSync(filePath, 0o000);
    try {
      const report = runDoctor(home, {});
      const unreadableTarget = report.targets.find(
        (t) => t.path === unreadableRepo,
      );
      expect(unreadableTarget?.status).toBe("drift");
      expect(unreadableTarget?.driftFiles).toContain(REVIEWER_MD);
      const cleanTarget = report.targets.find((t) => t.path === cleanRepo);
      expect(cleanTarget?.status).toBe("clean");
      expect(report.exitCode).toBe(1);
    } finally {
      chmodSync(filePath, 0o644);
    }
  });

  it("(4b) tiers divergence: repo tiers true vs operator tiers false", () => {
    const repo = makeRepo();
    setManifestField(repo, { tiers: true });
    registerHome(defaults({ tiers: false }), [repo]);
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("divergent");
    expect(report.targets[0].divergence).toEqual({
      profile: false,
      tiers: true,
      models: false,
    });
    expect(report.exitCode).toBe(0);
  });

  it("(6b) version-lag: a pin that no longer matches the installed version", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    setManifestField(repo, { version: "0.0.1", pin: "9.9.9" });
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("version-lag");
    expect(report.targets[0].installedVersion).toBe("0.0.1");
    expect(report.targets[0].pin).toBe("9.9.9");
    expect(report.exitCode).toBe(0);
  });

  it("(6c) version-lag: installed matches the running kit, but not the pin", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    setManifestField(repo, { version: PACKAGE_VERSION, pin: "9.9.9" });
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("version-lag");
    expect(report.targets[0].installedVersion).toBe(PACKAGE_VERSION);
    expect(report.targets[0].pin).toBe("9.9.9");
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

  it("drift takes precedence over version-lag when a target is both", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    setManifestField(repo, { version: "0.0.1" });
    tamper(repo);
    const report = runDoctor(home, {});
    expect(report.targets[0].status).toBe("drift");
    expect(report.targets[0].versionLag).toBe(true);
    expect(report.targets[0].driftFiles).toContain(REVIEWER_MD);
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

  it("(mutation-probe c) a manifest.json present but unparseable exits 2 with operator-manifest-unreadable, not no-operator-manifest", () => {
    writeFileSync(join(home, "manifest.json"), "{ not valid json", "utf8");
    const report = runDoctor(home, {});
    expect(report.exitCode).toBe(2);
    expect(report.error).toBe("operator-manifest-unreadable");
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

  it("prints a divergence line and a matching-pin detail line (pin equals the installed version, no version-lag)", () => {
    const repo = makeRepo({ profile: "minimal" });
    setManifestField(repo, { version: "0.0.1", pin: "0.0.1" });
    registerHome(defaults({ profile: "full" }), [repo]);

    const result = runCli();
    expect(result.stdout).toContain(`divergent  ${repo}`);
    expect(result.stdout).toContain("profile: repo=minimal, operator=full");
    expect(result.stdout).toContain("pinned at 0.0.1");
    // Pin matches the installed version, so this is not version-lag: no
    // "installed X, ..." detail line.
    expect(result.stdout).not.toMatch(/installed 0\.0\.1,/);
  });

  it("prints the 'installed X, operator Y' line under a divergent status line, plus the models detail line", () => {
    const repo = makeRepo({ profile: "minimal" });
    setManifestField(repo, { version: "0.0.1" });
    registerHome(
      defaults({ profile: "full", models: { implementer: "haiku" } }),
      [repo],
    );

    const result = runCli();
    expect(result.stdout).toContain(`divergent  ${repo}`);
    expect(result.stdout).toContain("profile: repo=minimal, operator=full");
    expect(result.stdout).toContain("models: implementer");
    expect(result.stdout).toContain(
      `installed 0.0.1, operator ${PACKAGE_VERSION}`,
    );
  });

  it("prints the 'installed X, pinned at Y' line when a pin no longer matches the installed version", () => {
    const repo = makeRepo();
    registerHome(defaults(), [repo]);
    setManifestField(repo, { version: "0.0.1", pin: "9.9.9" });

    const result = runCli();
    expect(result.stdout).toContain(`version-lag  ${repo}`);
    expect(result.stdout).toContain("installed 0.0.1, pinned at 9.9.9");
    // The standalone pin line is folded into the detail line above, not
    // printed a second time.
    expect(result.stdout.match(/pinned at 9\.9\.9/g)?.length).toBe(1);
  });
});

describe("CLI --json combined with --prune", () => {
  it("reflects the post-prune registry in the JSON report", () => {
    const cleanRepo = makeRepo();
    const missingRepo = makeRepo();
    registerHome(defaults(), [cleanRepo, missingRepo]);
    rmSync(missingRepo, { recursive: true, force: true });

    const result = runCli("--json", "--prune");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.targets.map((t: { path: string }) => t.path)).toEqual([
      cleanRepo,
    ]);
    expect(parsed.pruned).toEqual([missingRepo]);
    expect(parsed.exitCode).toBe(0);
    expect(result.status).toBe(0);

    const onDisk = JSON.parse(
      readFileSync(join(home, "manifest.json"), "utf8"),
    );
    expect((onDisk.targets as { path: string }[]).map((t) => t.path)).toEqual([
      cleanRepo,
    ]);
  });
});

describe("operator-manifest-unreadable", () => {
  it("(9) --json emits the operator-manifest-unreadable error object and exits 2", () => {
    writeFileSync(join(home, "manifest.json"), "{ not valid json", "utf8");
    const result = runCli("--json");
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      operatorHome: resolve(home),
      operatorVersion: PACKAGE_VERSION,
      targets: [],
      pruned: [],
      exitCode: 2,
      error: "operator-manifest-unreadable",
    });
    expect(result.status).toBe(2);
  });

  it("prints the repair hint to stderr, distinct from the no-operator-manifest hint, and exits 2", () => {
    writeFileSync(join(home, "manifest.json"), "{ not valid json", "utf8");
    const result = runCli();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(join(resolve(home), "manifest.json"));
    expect(result.stderr).toContain("is unreadable; back it up and repair it");
    expect(result.stderr).not.toContain("No operator setup found");
    expect(result.stdout).toBe("");
  });
});
