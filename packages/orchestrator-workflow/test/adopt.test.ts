import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PACKAGE_VERSION } from "../src/assets.js";
import {
  adoptExitCodeForStatus,
  adoptJsonExtras,
  suppressSuccessLine,
} from "../src/doctor.js";
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

/** `true` when running as root: `chmod`-based precondition tests below
 * (an unreadable directory, a read-only operator home) are meaningless for
 * root, which ignores permission bits entirely on most systems. */
const isRoot = process.getuid ? process.getuid() === 0 : false;

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

/** Only used by the "adopt then apply" test below, mirroring `apply.test.ts`'s
 * own `runApply` helper (not imported from there: each command test file
 * keeps its own copy rather than sharing test infrastructure across files). */
function runApply(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "apply", ...args],
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

  // --- fix-round tests (M1) ---------------------------------------------

  it("--json: a missing target directory reports target-not-a-directory and exits 2 (M1)", () => {
    const missing = join(target, "does-not-exist");
    const result = runAdopt(missing, "--json");
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toBe("target-not-a-directory");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.target).toBeNull();
    expect(existsSync(operatorManifestPath())).toBe(false);
  });

  it("--json: a regular file as the target reports target-not-a-directory and exits 2 (M1)", () => {
    const filePath = join(target, "not-a-dir");
    writeFileSync(filePath, "x", "utf8");
    const result = runAdopt(filePath, "--json");
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toBe("target-not-a-directory");
    expect(parsed.exitCode).toBe(2);
  });

  it("human mode: a regular file as the target keeps the existing wording, at exit 2 (M1)", () => {
    const filePath = join(target, "not-a-dir");
    writeFileSync(filePath, "x", "utf8");
    const result = runAdopt(filePath);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Target is not a directory: ${filePath}`);
  });

  // --- fix-round tests (M2) -----------------------------------------------

  it.skipIf(isRoot)(
    "an inaccessible .ai/workflow directory reports unverifiable-repo-manifest, not no-repo-manifest, and does not advise init/apply (M2)",
    () => {
      initRepo();
      const workflowDir = join(target, ".ai", "workflow");
      chmodSync(workflowDir, 0o000);
      try {
        const result = runAdopt(target, "--json");
        expect(result.status).toBe(2);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.error).toBe("unverifiable-repo-manifest");
        expect(parsed.exitCode).toBe(2);
        expect(parsed.message).not.toContain("orchestrator-workflow init");
        expect(parsed.message).not.toContain("orchestrator-workflow apply");
        expect(existsSync(operatorManifestPath())).toBe(false);
      } finally {
        chmodSync(workflowDir, 0o755);
      }
    },
  );

  it.skipIf(isRoot)(
    "an inaccessible manifest.json FILE (directory still accessible) reports unverifiable-repo-manifest, not unreadable-repo-manifest, and gives no repair/reinstall advice (fix-round-2)",
    () => {
      initRepo();
      const manifestFile = repoManifestPath(target);
      chmodSync(manifestFile, 0o000);
      try {
        const result = runAdopt(target, "--json");
        expect(result.status).toBe(2);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.error).toBe("unverifiable-repo-manifest");
        expect(parsed.exitCode).toBe(2);
        expect(parsed.message).not.toContain("repair it");
        expect(parsed.message).not.toContain("orchestrator-workflow apply");
        expect(existsSync(operatorManifestPath())).toBe(false);
      } finally {
        chmodSync(manifestFile, 0o644);
      }
    },
  );

  // --- fix-round tests (L8) -----------------------------------------------

  it("--json: a foreign kit's manifest at the same path is reported distinctly from unreadable (L8)", () => {
    mkdirSync(join(target, ".ai", "workflow"), { recursive: true });
    writeFileSync(
      repoManifestPath(target),
      JSON.stringify({ kit: "some-other-tool", version: "1.0.0" }),
      "utf8",
    );
    const result = runAdopt(target, "--json");
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toBe("foreign-manifest");
    expect(parsed.message).toContain("not an orchestrator-workflow manifest");
    expect(existsSync(operatorManifestPath())).toBe(false);
  });

  // --- fix-round tests (L6) -----------------------------------------------

  it.skipIf(isRoot)(
    "a read-only operator home exits 2 with operator-manifest-write-failed and creates no manifest (L6)",
    () => {
      initRepo();
      chmodSync(home, 0o500);
      try {
        const result = runAdopt(target, "--json");
        expect(result.status).toBe(2);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.error).toBe("operator-manifest-write-failed");
        expect(parsed.exitCode).toBe(2);
        expect(existsSync(operatorManifestPath())).toBe(false);
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );
  // A lock-timeout counterpart (mirroring doctor.ts's
  // OW_DOCTOR_TEST_LOCK_TIMEOUT_MS hatch) is not added here: that hatch is
  // wired only into `doctor`'s own `--prune` lock-options plumbing in
  // cli.ts, and `adopt`'s `updateOperatorManifest` call takes no lock
  // options at all today. Reusing it generically would mean threading a
  // second, adopt-scoped env-var-to-lockOptions hatch through `adopt`'s
  // action, a production-code change beyond this test-coverage finding's
  // scope; the write-failure branch above already exercises the same
  // catch block's non-timeout arm.

  // --- fix-round tests (L10) -----------------------------------------------

  it("adopting an already-registered target advances the operator manifest's updatedAt (L10)", () => {
    initRepo();
    const first = runAdopt(target);
    expect(first.status, first.stderr).toBe(0);
    const afterFirst = readOperatorManifest().updatedAt;

    const second = runAdopt(target);
    expect(second.status, second.stderr).toBe(0);
    const afterSecond = readOperatorManifest().updatedAt;

    expect(afterSecond).not.toBe(afterFirst);
  });

  // --- fix-round tests (reviewer-listed, unpinned) -------------------------

  it("adopting through a symlink then through the real path yields exactly one entry", () => {
    initRepo();
    const linkedTarget = join(tmpdir(), `adopt-symlink-${process.pid}`);
    symlinkSync(target, linkedTarget);
    try {
      const first = runAdopt(linkedTarget);
      expect(first.status, first.stderr).toBe(0);

      const second = runAdopt(target);
      expect(second.status, second.stderr).toBe(0);

      const operatorManifest = readOperatorManifest();
      expect(operatorManifest.targets).toHaveLength(1);
      expect(operatorManifest.targets[0].path).toBe(realpathSync(target));
    } finally {
      rmSync(linkedTarget, { force: true });
    }
  });

  it("adopt then apply --target: one entry, lastAppliedVersion advances to PACKAGE_VERSION", () => {
    initRepo();
    setRepoManifestField(target, { version: "0.0.1" });

    const adopted = runAdopt(target);
    expect(adopted.status, adopted.stderr).not.toBe(2);
    expect(readOperatorManifest().targets).toHaveLength(1);
    expect(readOperatorManifest().targets[0].lastAppliedVersion).toBe("0.0.1");

    const applied = runApply("--target", target, "--yes");
    expect(applied.status, applied.stderr).toBe(0);

    const operatorManifest = readOperatorManifest();
    expect(operatorManifest.targets).toHaveLength(1);
    expect(operatorManifest.targets[0].lastAppliedVersion).toBe(
      PACKAGE_VERSION,
    );
  });
});

describe("adoptExitCodeForStatus (M3/L5)", () => {
  it("maps all seven TargetStatus values to adopt's exit-code contract", () => {
    expect(adoptExitCodeForStatus("clean")).toBe(0);
    expect(adoptExitCodeForStatus("divergent")).toBe(0);
    expect(adoptExitCodeForStatus("version-lag")).toBe(0);
    expect(adoptExitCodeForStatus("drift")).toBe(1);
    expect(adoptExitCodeForStatus("missing")).toBe(2);
    expect(adoptExitCodeForStatus("no-manifest")).toBe(2);
    expect(adoptExitCodeForStatus("unverifiable")).toBe(2);
  });

  it("adds the error key only for the three exit-2 statuses (M3)", () => {
    expect(adoptJsonExtras("clean")).toEqual({});
    expect(adoptJsonExtras("divergent")).toEqual({});
    expect(adoptJsonExtras("version-lag")).toEqual({});
    expect(adoptJsonExtras("drift")).toEqual({});
    expect(adoptJsonExtras("missing")).toEqual({
      error: "unexpected-target-status",
    });
    expect(adoptJsonExtras("no-manifest")).toEqual({
      error: "unexpected-target-status",
    });
    expect(adoptJsonExtras("unverifiable")).toEqual({
      error: "unexpected-target-status",
    });
  });
});

describe("suppressSuccessLine (fix-round-2)", () => {
  it("suppresses the success line only for the three exit-2 statuses, all seven values covered", () => {
    expect(suppressSuccessLine("clean")).toBe(false);
    expect(suppressSuccessLine("divergent")).toBe(false);
    expect(suppressSuccessLine("version-lag")).toBe(false);
    expect(suppressSuccessLine("drift")).toBe(false);
    expect(suppressSuccessLine("missing")).toBe(true);
    expect(suppressSuccessLine("no-manifest")).toBe(true);
    expect(suppressSuccessLine("unverifiable")).toBe(true);
  });
});
