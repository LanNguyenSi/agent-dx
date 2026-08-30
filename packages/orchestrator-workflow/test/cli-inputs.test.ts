import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInitInputs } from "../src/cli-inputs.js";
import type { Manifest } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_PROFILE } from "../src/models.js";

/**
 * Unit coverage for `resolveInitInputs`, extracted from `init`'s CLI action
 * (agent-dx task T-003) so a later `apply --target` command can reuse the
 * same harness/profile/models/tiers/opencode-catalog resolution without
 * duplicating it. These tests call the function directly, in-process, with
 * `interactive: false` throughout so no TTY or inquirer prompt is ever
 * reached; the CLI-visible behaviour (stdout/stderr/exit codes/files
 * written) is instead covered end-to-end by `test/init.test.ts`'s
 * `spawnSync`-of-the-CLI smoke tests, unchanged by this extraction.
 */

function fakeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    kit: "orchestrator-workflow",
    version: "0.25.0",
    harnesses: ["claude"],
    models: { ...DEFAULT_MODELS },
    profile: DEFAULT_PROFILE,
    tiers: false,
    files: {},
    installedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveInitInputs: defaults with no flags and no previous manifest", () => {
  it("falls back to detected-or-claude harnesses, DEFAULT_PROFILE, DEFAULT_MODELS, and tiers: false", async () => {
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous: undefined,
      opts: {},
    });
    expect(result.harnesses).toEqual(["claude"]);
    expect(result.profile).toBe(DEFAULT_PROFILE);
    expect(result.models).toEqual(DEFAULT_MODELS);
    expect(result.tiers).toBe(false);
    expect(result.opencodeModels).toBeUndefined();
    expect(result.opencodeClassModels).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("uses detected harnesses (deduplicated) when no --harness flag and no previous manifest", async () => {
    const result = await resolveInitInputs({
      detected: ["claude", "opencode", "claude"],
      interactive: false,
      previous: undefined,
      opts: {},
    });
    expect(result.harnesses).toEqual(["claude", "opencode"]);
  });
});

describe("resolveInitInputs: previous manifest values persist on a flag-less call", () => {
  it("keeps the previous harnesses, profile, models, and tiers when no flags are passed", async () => {
    const previous = fakeManifest({
      harnesses: ["codex"],
      profile: "minimal",
      models: { ...DEFAULT_MODELS, implementer: "haiku" },
      tiers: true,
    });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: {},
    });
    expect(result.harnesses).toEqual(["codex"]);
    expect(result.profile).toBe("minimal");
    expect(result.models.implementer).toBe("haiku");
    expect(result.tiers).toBe(true);
  });

  it("merges detected harnesses with the previous install's harnesses when no --harness flag is passed", async () => {
    const previous = fakeManifest({ harnesses: ["claude"] });
    const result = await resolveInitInputs({
      detected: ["codex"],
      interactive: false,
      previous,
      opts: {},
    });
    expect(result.harnesses).toEqual(["codex", "claude"]);
  });
});

describe("resolveInitInputs: explicit flags override previous values", () => {
  it("--harness overrides the previous install's harnesses", async () => {
    const previous = fakeManifest({ harnesses: ["claude"] });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: { harness: "codex" },
    });
    expect(result.harnesses).toEqual(["codex"]);
  });

  it("--profile overrides the previous install's profile", async () => {
    const previous = fakeManifest({ profile: "minimal" });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: { profile: "full" },
    });
    expect(result.profile).toBe("full");
  });

  it("an unknown --profile value throws (parseProfile validation reachable through resolveInitInputs)", async () => {
    await expect(
      resolveInitInputs({
        detected: [],
        interactive: false,
        previous: undefined,
        opts: { profile: "bogus" },
      }),
    ).rejects.toThrow(/Unknown --profile "bogus"/);
  });

  it("--models overrides the previous install's models", async () => {
    const previous = fakeManifest({
      models: { ...DEFAULT_MODELS, reviewer: "haiku" },
    });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: { models: "reviewer=opus" },
    });
    expect(result.models.reviewer).toBe("opus");
  });
});

describe("resolveInitInputs: tiers on/off/carry", () => {
  it("tiers: true is carried forward from the previous install when no --tiers/--no-tiers flag is passed", async () => {
    const previous = fakeManifest({ tiers: true });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: {},
    });
    expect(result.tiers).toBe(true);
  });

  it("--tiers turns tiers on regardless of the previous value", async () => {
    const previous = fakeManifest({ tiers: false });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: { tiers: true },
    });
    expect(result.tiers).toBe(true);
  });

  it("--no-tiers (opts.tiers === false) turns tiers off even when the previous install had it on", async () => {
    const previous = fakeManifest({ tiers: true });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: { tiers: false },
    });
    expect(result.tiers).toBe(false);
  });

  it("defaults to false with no previous manifest and no flag", async () => {
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous: undefined,
      opts: {},
    });
    expect(result.tiers).toBe(false);
  });
});

describe("resolveInitInputs: opencode branch", () => {
  // Force loadOpencodeCatalog's `opencode models` shell-out to fail (binary
  // not found) so the catalog is hermetically empty regardless of the host
  // environment, the same technique test/init.test.ts's opencode CLI-smoke
  // tests use for the spawned CLI process, applied here to the in-process
  // PATH `resolveInitInputs` itself resolves `execFileSync` against.
  let emptyBinDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    emptyBinDir = mkdtempSync(join(tmpdir(), "no-opencode-unit-"));
    originalPath = process.env.PATH;
    process.env.PATH = emptyBinDir;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(emptyBinDir, { recursive: true, force: true });
  });

  it("with an empty catalog (opencode binary unavailable), opencodeModels is all-undefined with one combined warning, and no opencodeClassModels when tiers is off", async () => {
    const result = await resolveInitInputs({
      detected: ["opencode"],
      interactive: false,
      previous: undefined,
      opts: { harness: "opencode" },
    });
    expect(result.opencodeModels).toBeDefined();
    for (const v of Object.values(result.opencodeModels ?? {})) {
      expect(v).toBeUndefined();
    }
    expect(result.opencodeClassModels).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("--opencode-provider");
  });

  it("with an empty catalog and --tiers, returns one warning per unresolved model class, stating the real effect and scope", async () => {
    const result = await resolveInitInputs({
      detected: ["opencode"],
      interactive: false,
      previous: undefined,
      opts: { harness: "opencode", tiers: true },
    });
    expect(result.tiers).toBe(true);
    // 1 combined per-role warning + 3 per-class warnings (small/medium/large).
    expect(result.warnings).toHaveLength(4);
    for (const modelClass of ["small", "medium", "large"]) {
      expect(
        result.warnings.some(
          (w) =>
            w.includes(`Tier model class "${modelClass}"`) &&
            w.includes(
              "no opencode effort-tier variant files will be rendered",
            ) &&
            w.includes("Claude Code variants are unaffected"),
        ),
        `expected a warning for model class "${modelClass}"`,
      ).toBe(true);
      expect(
        result.opencodeClassModels?.[modelClass as "small"],
      ).toBeUndefined();
    }
  });

  it("does not touch the opencode catalog at all when the opencode harness is not selected", async () => {
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous: undefined,
      opts: { harness: "claude" },
    });
    expect(result.opencodeModels).toBeUndefined();
    expect(result.opencodeClassModels).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

describe("resolveInitInputs: --harness none (templates-only mode)", () => {
  it("--harness none resolves to an empty harnesses array on a fresh install", async () => {
    const result = await resolveInitInputs({
      detected: ["claude"],
      interactive: false,
      previous: undefined,
      opts: { harness: "none" },
    });
    expect(result.harnesses).toEqual([]);
  });

  it("--harness none overrides a previous install's non-empty harnesses", async () => {
    const previous = fakeManifest({ harnesses: ["claude", "codex"] });
    const result = await resolveInitInputs({
      detected: ["claude"],
      interactive: false,
      previous,
      opts: { harness: "none" },
    });
    expect(result.harnesses).toEqual([]);
  });

  it('"none" combined with a real harness (none,claude) throws a clear usage error', async () => {
    await expect(
      resolveInitInputs({
        detected: [],
        interactive: false,
        previous: undefined,
        opts: { harness: "none,claude" },
      }),
    ).rejects.toThrow(/templates-only mode and cannot be combined/);
  });

  it('"claude,none" (either order) also throws', async () => {
    await expect(
      resolveInitInputs({
        detected: [],
        interactive: false,
        previous: undefined,
        opts: { harness: "claude,none" },
      }),
    ).rejects.toThrow(/templates-only mode and cannot be combined/);
  });

  it("a plain re-run (no --harness flag) after a previous harnesses: [] install stays templates-only, even when a harness is detected on disk (previousIsRecordedManifest: true, init's own call)", async () => {
    const previous = fakeManifest({ harnesses: [] });
    const result = await resolveInitInputs({
      detected: ["claude"],
      interactive: false,
      previous,
      opts: {},
      previousIsRecordedManifest: true,
    });
    expect(result.harnesses).toEqual([]);
  });

  it("an explicit --harness claude after a previous harnesses: [] install adds the harness back", async () => {
    const previous = fakeManifest({ harnesses: [] });
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous,
      opts: { harness: "claude" },
      previousIsRecordedManifest: true,
    });
    expect(result.harnesses).toEqual(["claude"]);
  });

  it("without previousIsRecordedManifest (e.g. apply's synthetic operator-defaults previous), a previous harnesses: [] does NOT stick: falls back to detected instead", async () => {
    const previous = fakeManifest({ harnesses: [] });
    const result = await resolveInitInputs({
      detected: ["claude"],
      interactive: false,
      previous,
      opts: {},
      // previousIsRecordedManifest omitted (defaults to false/undefined)
    });
    expect(result.harnesses).toEqual(["claude"]);
  });
});
