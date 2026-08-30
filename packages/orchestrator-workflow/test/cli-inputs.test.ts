import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import inquirer from "inquirer";

import { resolveInitInputs } from "../src/cli-inputs.js";
import { MANIFEST_PATH, readInstalledManifest } from "../src/init.js";
import type { Manifest } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_PROFILE } from "../src/models.js";

/**
 * Unit coverage for `resolveInitInputs`, extracted from `init`'s CLI action
 * (agent-dx task T-003) so a later `apply --target` command can reuse the
 * same harness/profile/models/tiers/opencode-catalog resolution without
 * duplicating it. These tests call the function directly, in-process, with
 * `interactive: false` throughout (one dedicated describe block below is
 * the sole exception, see its own comment) so no TTY or inquirer prompt is
 * ever reached; the CLI-visible behaviour (stdout/stderr/exit codes/files
 * written) is instead covered end-to-end by `test/init.test.ts`'s
 * `spawnSync`-of-the-CLI smoke tests, unchanged by this extraction.
 */

// `inquirer.prompt` is mocked module-wide only for the "interactive
// re-run" describe block below (task agent-tasks 613316c9, F4): every
// other describe block in this file passes `interactive: false`, which
// never reaches this mock, so mocking it here does not change their
// behaviour.
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

function fakeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    kit: "orchestrator-workflow",
    version: "0.25.0",
    harnesses: ["claude"],
    // Matches what readInstalledManifest actually records for this default
    // shape: harnesses: ["claude"] is a non-empty recorded array, so the raw
    // field was NOT recorded empty. A test exercising the harnesses: []
    // stickiness gate overrides this explicitly to `true` (a real recorded
    // `--harness none` install); a test exercising a damaged/legacy or
    // all-unknown-names manifest (both also sanitize to harnesses: [], but
    // must NOT stick, review finding F1) overrides it to `false`.
    harnessesRecordedEmpty: false,
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

  it('"none,none" (a repeated "none", not a different entry) resolves the same as a plain "none" instead of throwing (F6)', async () => {
    const result = await resolveInitInputs({
      detected: [],
      interactive: false,
      previous: undefined,
      opts: { harness: "none,none" },
    });
    expect(result.harnesses).toEqual([]);
  });

  it("a plain re-run (no --harness flag) after a previous harnesses: [] install stays templates-only, even when a harness is detected on disk (previousIsRecordedManifest: true, init's own call)", async () => {
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
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
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
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
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    const result = await resolveInitInputs({
      detected: ["claude"],
      interactive: false,
      previous,
      opts: {},
      // previousIsRecordedManifest omitted (defaults to false/undefined)
    });
    expect(result.harnesses).toEqual(["claude"]);
  });

  it("a previous harnesses: [] with harnessesRecordedEmpty: false (a damaged/legacy manifest, not a real recorded --harness none) does NOT stick: falls back to detected instead", async () => {
    // readInstalledManifest sanitizes a missing/malformed harnesses field
    // (undefined, a string, an object) to harnesses: [] too, but marks
    // harnessesRecordedEmpty: false since the raw field was never actually
    // an array. previousIsRecordedManifest alone (init's own call) is not
    // enough to make this stick: both flags are required.
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: false,
    });
    const result = await resolveInitInputs({
      detected: ["claude"],
      interactive: false,
      previous,
      opts: {},
      previousIsRecordedManifest: true,
    });
    expect(result.harnesses).toEqual(["claude"]);
  });

  describe('a hand-written manifest with harnesses: ["cursor"] (all-unknown harness name)', () => {
    // readInstalledManifest sanitizes an array whose every entry fails the
    // known-harness filter (an unrecognized name like "cursor") down to
    // harnesses: [], the same shape as a deliberate --harness none install
    // -- but the raw field itself was a real, non-empty array, so
    // harnessesRecordedEmpty must be false, not true. Before the fix
    // (see CHANGELOG), the gate's signal was
    // `Array.isArray(candidate.harnesses)` captured BEFORE filtering, so
    // this exact shape set it to `true` and stuck a live claude install to
    // templates-only on a plain `init --yes`. Unlike the neighbouring
    // damaged/legacy cases above, this one writes a real manifest.json to
    // disk and runs it through `readInstalledManifest` itself, so the
    // sanitization this test relies on is the actual production code path,
    // not a hand-built `fakeManifest` standing in for it.
    let manifestDir: string;

    beforeEach(() => {
      manifestDir = mkdtempSync(join(tmpdir(), "cursor-manifest-unit-"));
      mkdirSync(join(manifestDir, ".ai", "workflow"), { recursive: true });
      const { harnessesRecordedEmpty: _unused, ...rest } = fakeManifest();
      const raw: Record<string, unknown> = { ...rest, harnesses: ["cursor"] };
      writeFileSync(
        join(manifestDir, MANIFEST_PATH),
        `${JSON.stringify(raw, null, 2)}\n`,
      );
    });

    afterEach(() => {
      rmSync(manifestDir, { recursive: true, force: true });
    });

    it("readInstalledManifest sanitizes it to harnesses: [] with harnessesRecordedEmpty: false", () => {
      const previous = readInstalledManifest(manifestDir);
      expect(previous?.harnesses).toEqual([]);
      expect(previous?.harnessesRecordedEmpty).toBe(false);
    });

    it("does NOT stick: resolveInitInputs falls back to detected instead", async () => {
      const previous = readInstalledManifest(manifestDir);
      const result = await resolveInitInputs({
        detected: ["claude"],
        interactive: false,
        previous,
        opts: {},
        previousIsRecordedManifest: true,
      });
      expect(result.harnesses).toEqual(["claude"]);
    });
  });
});

describe("resolveInitInputs: interactive plain first run (no previous manifest)", () => {
  // This is the "else" branch, not the templates-only-re-run branch below:
  // no previous manifest at all, so `promptHarnesses` is called with its
  // default `fallbackToClaude` (`true`), not the explicit `false` the
  // templates-only re-run passes. Nothing else in this file exercises that
  // default; a test only covering the templates-only branch's explicit
  // `false` would stay green even if the default flipped.
  function mockHarnessesPrompt() {
    vi.mocked(inquirer.prompt).mockImplementation(async (questions) => {
      const q = (questions as Array<Record<string, unknown>>)[0];
      if (q.name === "harnesses") return { harnesses: [] };
      if (q.name === "profile") return { profile: q.default };
      if (q.name === "choice") return { choice: q.default };
      throw new Error(`unmocked prompt: ${String(q.name)}`);
    });
  }

  afterEach(() => {
    vi.mocked(inquirer.prompt).mockReset();
  });

  it("pre-checks claude (fallbackToClaude's default true) when nothing is detected and there is no previous manifest", async () => {
    mockHarnessesPrompt();

    await resolveInitInputs({
      detected: [],
      interactive: true,
      previous: undefined,
      opts: {},
    });

    const harnessesCall = vi
      .mocked(inquirer.prompt)
      .mock.calls.find(
        ([questions]) =>
          (questions as Array<Record<string, unknown>>)[0].name === "harnesses",
      );
    expect(harnessesCall).toBeDefined();
    const choices = (
      harnessesCall![0] as Array<{
        choices: Array<{ value: string; checked: boolean }>;
      }>
    )[0].choices;
    for (const choice of choices) {
      expect(choice.checked).toBe(choice.value === "claude");
    }
  });
});

describe("resolveInitInputs: interactive re-run after a templates-only install (F4)", () => {
  // resolveInitInputs prompts for more than just harnesses when
  // interactive and the corresponding opts.* flag is absent (profile,
  // then one models prompt per role): answer every prompt generically by
  // its `name`/`default` except "harnesses", which the harnessesAnswer
  // parameter controls, so these tests can assert on the harnesses prompt
  // specifically without hardcoding the total prompt count.
  function mockPrompts(harnessesAnswer: string[]) {
    vi.mocked(inquirer.prompt).mockImplementation(async (questions) => {
      const q = (questions as Array<Record<string, unknown>>)[0];
      if (q.name === "harnesses") return { harnesses: harnessesAnswer };
      if (q.name === "profile") return { profile: q.default };
      if (q.name === "choice") return { choice: q.default };
      throw new Error(`unmocked prompt: ${String(q.name)}`);
    });
  }

  afterEach(() => {
    vi.mocked(inquirer.prompt).mockReset();
  });

  it("still prompts instead of skipping straight to templates-only, with nothing pre-checked except what is detected", async () => {
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    mockPrompts([]);

    const result = await resolveInitInputs({
      detected: ["codex"],
      interactive: true,
      previous,
      opts: {},
      previousIsRecordedManifest: true,
    });

    // The stickiness gate did not short-circuit straight to []: the
    // harnesses prompt was actually invoked.
    const harnessesCall = vi
      .mocked(inquirer.prompt)
      .mock.calls.find(
        ([questions]) =>
          (questions as Array<Record<string, unknown>>)[0].name === "harnesses",
      );
    expect(harnessesCall).toBeDefined();
    const choices = (
      harnessesCall![0] as Array<{
        choices: Array<{ value: string; checked: boolean }>;
      }>
    )[0].choices;
    // Only the detected harness ("codex") is pre-checked; the previous
    // install's own recorded harnesses ([]) contribute nothing, so
    // "claude"/"opencode" are unchecked rather than carried forward.
    for (const choice of choices) {
      expect(choice.checked).toBe(choice.value === "codex");
    }
    // The mocked answer (operator deselected everything) flows through.
    expect(result.harnesses).toEqual([]);
  });

  it("with nothing detected either, no choice is pre-checked (F2): the readme/comment promise 'nothing forced pre-selected' holds even when detected is empty too", async () => {
    // Before the fix (review finding F2, agent-tasks 613316c9 round 2),
    // promptHarnesses's own "nothing known" fallback pre-checked "claude"
    // unconditionally; since a templates-only repo has no harness files by
    // construction, `detected` is always empty here too, so a bare Enter on
    // this prompt silently re-widened the install.
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    mockPrompts([]);

    const result = await resolveInitInputs({
      detected: [],
      interactive: true,
      previous,
      opts: {},
      previousIsRecordedManifest: true,
    });

    const harnessesCall = vi
      .mocked(inquirer.prompt)
      .mock.calls.find(
        ([questions]) =>
          (questions as Array<Record<string, unknown>>)[0].name === "harnesses",
      );
    expect(harnessesCall).toBeDefined();
    const choices = (
      harnessesCall![0] as Array<{
        choices: Array<{ value: string; checked: boolean }>;
      }>
    )[0].choices;
    for (const choice of choices) {
      expect(choice.checked).toBe(false);
    }
    expect(result.harnesses).toEqual([]);
  });

  it("an operator who selects a harness in the prompt gets it installed, not stuck at []", async () => {
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    mockPrompts(["claude"]);

    const result = await resolveInitInputs({
      detected: [],
      interactive: true,
      previous,
      opts: {},
      previousIsRecordedManifest: true,
    });

    expect(result.harnesses).toEqual(["claude"]);
  });
});
