import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MODELS } from "../src/models.js";
import { OPERATOR_HOME_ENV } from "../src/operator-manifest.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "operator-setup-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const manifestPath = () => join(home, "manifest.json");

function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "setup", ...args],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, [OPERATOR_HOME_ENV]: home },
    },
  );
}

describe("setup", () => {
  it("a fresh run with --yes writes the fallback defaults", () => {
    const result = run("--yes");
    expect(result.status, result.stderr).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
    expect(manifest.kit).toBe("orchestrator-workflow");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.defaults).toEqual({
      harnesses: ["claude"],
      profile: "full",
      tiers: false,
      models: DEFAULT_MODELS,
    });
    expect(manifest.targets).toEqual([]);
    expect(manifest.createdAt).toBeTruthy();
    expect(manifest.createdAt).toBe(manifest.updatedAt);
  });

  it("explicit --harness/--profile write exactly those values", () => {
    const result = run("--harness", "codex", "--profile", "minimal", "--yes");
    expect(result.status, result.stderr).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
    expect(manifest.defaults.harnesses).toEqual(["codex"]);
    expect(manifest.defaults.profile).toBe("minimal");
  });

  it("a second --yes run with no flags is a no-op", () => {
    const first = run("--yes");
    expect(first.status, first.stderr).toBe(0);
    const before = readFileSync(manifestPath(), "utf8");

    const second = run("--yes");
    expect(second.status, second.stderr).toBe(0);
    const after = readFileSync(manifestPath(), "utf8");

    expect(after).toBe(before);
    expect(second.stdout).toContain("Unchanged.");
  });

  it("--tiers on a re-run changes only tiers and updatedAt, preserving createdAt and existing targets", () => {
    const first = run("--yes");
    expect(first.status, first.stderr).toBe(0);
    const beforeManifest = JSON.parse(readFileSync(manifestPath(), "utf8"));

    // Seed a target by hand, as the CLI itself never writes targets.
    const seededTarget = {
      path: "/some/repo",
      lastAppliedVersion: "1.2.3",
      lastAppliedAt: "2026-01-01T00:00:00.000Z",
    };
    const seeded = { ...beforeManifest, targets: [seededTarget] };
    writeFileSync(manifestPath(), `${JSON.stringify(seeded, null, 2)}\n`);

    const third = run("--tiers", "--yes");
    expect(third.status, third.stderr).toBe(0);

    const after = JSON.parse(readFileSync(manifestPath(), "utf8"));
    expect(after.defaults.harnesses).toEqual(seeded.defaults.harnesses);
    expect(after.defaults.profile).toBe(seeded.defaults.profile);
    expect(after.defaults.models).toEqual(seeded.defaults.models);
    expect(after.defaults.tiers).toBe(true);
    expect(after.createdAt).toBe(seeded.createdAt);
    expect(after.updatedAt).not.toBe(seeded.updatedAt);
    expect(after.targets).toEqual([seededTarget]);
  });

  it("a codex-only stored default is not widened back to claude on a flag-less re-run", () => {
    const first = run("--harness", "codex", "--yes");
    expect(first.status, first.stderr).toBe(0);
    const second = run("--yes");
    expect(second.status, second.stderr).toBe(0);
    const after = JSON.parse(readFileSync(manifestPath(), "utf8"));
    expect(after.defaults.harnesses).toEqual(["codex"]);
    expect(second.stdout).toContain("Unchanged.");
  });

  it("rejects an unknown harness, exits non-zero, and writes nothing", () => {
    const result = run("--harness", "bogus", "--yes");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown harness");
    expect(() => readFileSync(manifestPath(), "utf8")).toThrow();
  });

  it("--models sets per-role model overrides", () => {
    const result = run("--models", "implementer=haiku,reviewer=opus", "--yes");
    expect(result.status, result.stderr).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
    expect(manifest.defaults.models.implementer).toBe("haiku");
    expect(manifest.defaults.models.reviewer).toBe("opus");
  });
});
