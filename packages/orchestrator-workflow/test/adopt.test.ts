import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PACKAGE_VERSION } from "../src/assets.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS } from "../src/models.js";
import type { Profile } from "../src/models.js";
import {
  OPERATOR_HOME_ENV,
  createOperatorManifest,
  updateOperatorManifest,
  upsertOperatorTarget,
} from "../src/operator-manifest.js";
import type { OperatorManifestDefaults } from "../src/operator-manifest.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let home: string;
let target: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "adopt-operator-home-"));
  target = mkdtempSync(join(tmpdir(), "adopt-target-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

const operatorManifestPath = () => join(home, "manifest.json");
const repoManifestPath = (dir: string) =>
  join(dir, ".ai", "workflow", "manifest.json");

function runAdopt(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "adopt", ...args],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, [OPERATOR_HOME_ENV]: home },
    },
  );
}

function readOperatorManifest() {
  return JSON.parse(readFileSync(operatorManifestPath(), "utf8"));
}

function readRepoManifest(dir: string) {
  return JSON.parse(readFileSync(repoManifestPath(dir), "utf8"));
}

function setRepoManifestField(
  dir: string,
  patch: Record<string, unknown>,
): void {
  const manifest = readRepoManifest(dir);
  writeFileSync(
    repoManifestPath(dir),
    `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`,
    "utf8",
  );
}

/** Installs a fresh repo via `runInit` directly (no CLI spawn), mirroring
 * doctor.test.ts's `makeRepo`. */
function initRepo(options?: {
  profile?: Profile;
  tiers?: boolean;
  models?: Partial<Record<string, string>>;
}): void {
  runInit({
    targetDir: target,
    harnesses: ["claude"],
    models: { ...DEFAULT_MODELS, ...options?.models },
    profile: options?.profile,
    tiers: options?.tiers,
  });
}

/** Seeds a pre-existing operator manifest at `home` through the module's
 * sole write path, mirroring doctor.test.ts's `registerHome`/
 * `writeOperatorManifest` helpers, so a test can register a target against
 * operator defaults that differ from what the target itself was installed
 * with (the `divergent` case). */
function seedOperatorManifest(
  defaults: OperatorManifestDefaults,
  targetPaths: string[] = [],
): void {
  let manifest = createOperatorManifest(defaults, "2026-01-01T00:00:00.000Z");
  for (const path of targetPaths) {
    manifest = upsertOperatorTarget(
      manifest,
      path,
      "0.0.0",
      "2026-01-01T00:00:00.000Z",
    ).manifest;
  }
  const result = updateOperatorManifest(home, () => manifest);
  if (!result.written) {
    throw new Error("seedOperatorManifest: unexpectedly a no-op");
  }
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

const REVIEWER_MD = join(".claude", "agents", "reviewer.md");

function tamper(dir: string): void {
  writeFileSync(join(dir, REVIEWER_MD), "tampered content\n", "utf8");
}

/** Snapshot of every file's mtime and content under `dir`, for a
 * byte-for-byte, mtime-for-mtime before/after comparison: a write that
 * only touches a file's mtime without changing its bytes must still show
 * up as a difference here, which a content-only snapshot (as in
 * apply.test.ts) would miss. */
function snapshotTree(
  dir: string,
): Map<string, { mtimeMs: number; content: string }> {
  const files = new Map<string, { mtimeMs: number; content: string }>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.set(full, {
          mtimeMs: statSync(full).mtimeMs,
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(dir);
  return files;
}

describe("adopt", () => {
  it("no repo manifest: exits 2 with a distinct message, operator home untouched", () => {
    const result = runAdopt(target);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `No orchestrator-workflow install found in ${target}`,
    );
    expect(result.stderr).toContain("orchestrator-workflow init");
    expect(result.stderr).toContain(
      `orchestrator-workflow apply --target ${target}`,
    );
    expect(existsSync(operatorManifestPath())).toBe(false);
  });

  it("--json: no repo manifest reports the no-repo-manifest error object and exits 2", () => {
    const result = runAdopt(target, "--json");
    expect(result.status).toBe(2);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toBe("no-repo-manifest");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.target).toBeNull();
    expect(existsSync(operatorManifestPath())).toBe(false);
  });

  it("an unreadable (but present) repo manifest is reported distinctly from a missing one", () => {
    initRepo();
    writeFileSync(repoManifestPath(target), "{ not valid json", "utf8");
    const result = runAdopt(target);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `Unreadable repository manifest at ${repoManifestPath(target)}`,
    );
    expect(existsSync(operatorManifestPath())).toBe(false);
  });

  it("clean target, no operator manifest yet: bootstraps operator defaults from the repo's own settings and registers it", () => {
    initRepo({
      profile: "minimal",
      tiers: true,
      models: { implementer: "haiku" },
    });
    const repoManifest = readRepoManifest(target);

    const result = runAdopt(target);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Adopted ${realpathSync(target)} (registered: new; operator defaults bootstrapped from this repository)`,
    );
    expect(result.stdout).toContain("clean");

    const operatorManifest = readOperatorManifest();
    expect(operatorManifest.defaults.harnesses).toEqual(repoManifest.harnesses);
    expect(operatorManifest.defaults.profile).toBe(repoManifest.profile);
    expect(operatorManifest.defaults.tiers).toBe(repoManifest.tiers);
    expect(operatorManifest.defaults.models).toEqual(repoManifest.models);

    expect(operatorManifest.targets).toHaveLength(1);
    expect(operatorManifest.targets[0].path).toBe(realpathSync(target));
    expect(operatorManifest.targets[0].lastAppliedVersion).toBe(
      repoManifest.version,
    );
  });

  it("drifted target: a kit-owned file edited after install reports drift and exits 1", () => {
    initRepo();
    tamper(target);
    const result = runAdopt(target);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`drift  ${realpathSync(target)}`);
    expect(result.stdout).toContain(REVIEWER_MD);
  });

  it("--json: drift is reported with driftFiles and exitCode 1", () => {
    initRepo();
    tamper(target);
    const result = runAdopt(target, "--json");
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.target.status).toBe("drift");
    expect(parsed.target.driftFiles).toContain(REVIEWER_MD);
    expect(parsed.exitCode).toBe(1);
  });

  it("divergent target against an existing operator manifest: registers it, reports divergent, exits 0", () => {
    initRepo({ profile: "minimal" });
    seedOperatorManifest(defaults({ profile: "full" }));

    const result = runAdopt(target);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Adopted ${realpathSync(target)} (registered: new; operator defaults kept)`,
    );
    expect(result.stdout).toContain(`divergent  ${realpathSync(target)}`);

    const operatorManifest = readOperatorManifest();
    // Bootstrapping did not happen: the pre-existing defaults survive
    // unchanged, and only the `targets` array grew.
    expect(operatorManifest.defaults.profile).toBe("full");
    expect(operatorManifest.targets).toHaveLength(1);
    expect(operatorManifest.targets[0].path).toBe(realpathSync(target));
  });

  it("contrast with apply: a target init'ed at an older version registers that version, not PACKAGE_VERSION", () => {
    initRepo();
    setRepoManifestField(target, { version: "0.0.1" });

    const result = runAdopt(target);
    expect(result.status, result.stderr).not.toBe(2);

    const operatorManifest = readOperatorManifest();
    expect(operatorManifest.targets[0].lastAppliedVersion).toBe("0.0.1");
    expect(operatorManifest.targets[0].lastAppliedVersion).not.toBe(
      PACKAGE_VERSION,
    );
  });

  it("adopting twice registers refreshed, with exactly one registry entry", () => {
    initRepo();
    const first = runAdopt(target);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("registered: new");

    const second = runAdopt(target);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("registered: refreshed");
    expect(second.stdout).toContain("operator defaults kept");

    const operatorManifest = readOperatorManifest();
    expect(operatorManifest.targets).toHaveLength(1);
  });

  it("unreadable operator manifest: exits 2 with a repair message, file left untouched", () => {
    initRepo();
    writeFileSync(operatorManifestPath(), "{not valid json", "utf8");
    const before = readFileSync(operatorManifestPath(), "utf8");

    const result = runAdopt(target);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `Operator manifest at ${operatorManifestPath()} is unreadable`,
    );
    expect(result.stderr).toContain("orchestrator-workflow setup");
    expect(readFileSync(operatorManifestPath(), "utf8")).toBe(before);
  });

  it("--json: unreadable operator manifest reports the error object and exits 2", () => {
    initRepo();
    writeFileSync(operatorManifestPath(), "{not valid json", "utf8");
    const result = runAdopt(target, "--json");
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toBe("operator-manifest-unreadable");
    expect(parsed.exitCode).toBe(2);
  });

  it("--json shape parses and exitCode matches the process exit status", () => {
    initRepo();
    const result = runAdopt(target, "--json");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.exitCode).toBe(result.status);
    expect(parsed).toEqual({
      operatorHome: home,
      operatorVersion: PACKAGE_VERSION,
      target: {
        path: realpathSync(target),
        status: "clean",
        installedVersion: PACKAGE_VERSION,
        pin: null,
        divergence: { profile: false, tiers: false, models: false },
        driftFiles: null,
        versionLag: false,
        reason: null,
      },
      registered: "new",
      bootstrapped: true,
      exitCode: 0,
    });
  });

  it("the target directory is never written to", () => {
    initRepo();
    const before = snapshotTree(target);

    const result = runAdopt(target);
    expect(result.status, result.stderr).toBe(0);

    const after = snapshotTree(target);
    expect(after).toEqual(before);
  });
});
