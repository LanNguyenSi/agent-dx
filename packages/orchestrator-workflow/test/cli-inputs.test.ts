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

describe("resolveInitInputs: interactive re-run after a templates-only install (F4, reversed by D-002)", () => {
  // F4 originally pinned init's sticky-branch pre-check to whatever
  // `detectHarnesses(targetDir)` found on disk (init's call site omitted
  // `stickyPreChecked`, which defaulted to `detected`), deliberately
  // different from apply's fe834823 "pre-check nothing" semantics. D-002
  // (agent-dx 7669907c) reverses that: the weak-signal argument from
  // fe834823 (a stray harness config left on disk is not the recorded
  // intent, the manifest is) applies to init identically, and the earlier
  // fix's concern (ask instead of silently falling back to
  // templates-only) is preserved because the prompt still appears and
  // still annotates detection; only the pre-check now follows recorded
  // intent instead of on-disk detection. init and apply now share one
  // sticky-branch semantics (`stickyPreChecked ?? []`,
  // `stickyAnnotateDetected ?? detected`, both resolved once inside
  // `resolveInitInputs`).
  //
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

  it("still prompts instead of skipping straight to templates-only, with nothing pre-checked even though a harness is detected on disk (D-002)", async () => {
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    mockPrompts([]);

    const result = await resolveInitInputs({
      // init's own call site omits stickyPreChecked/stickyAnnotateDetected
      // entirely, exactly like this call: the defaults inside
      // resolveInitInputs (`stickyPreChecked ?? []`, `stickyAnnotateDetected
      // ?? detected`) must do the pre-check/annotate split on their own.
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
        choices: Array<{ value: string; name: string; checked: boolean }>;
      }>
    )[0].choices;
    // Nothing is pre-checked, regardless of what is detected on disk
    // (D-002: init now mirrors apply's fe834823 pre-check semantics).
    for (const choice of choices) {
      expect(choice.checked).toBe(false);
    }
    // The detected harness ("codex") is still labelled, so the operator
    // can see what is actually on disk even though it is not pre-checked.
    const codexChoice = choices.find((c) => c.value === "codex");
    expect(codexChoice?.name).toBe("codex (detected)");
    const claudeChoice = choices.find((c) => c.value === "claude");
    expect(claudeChoice?.name).toBe("claude");
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

describe("resolveInitInputs: apply's interactive templates-only re-run pre-checks nothing (agent-tasks fe834823, round 2)", () => {
  // `apply`'s call site hands the sticky branch a `detected` that is NOT
  // real on-disk detection: it is `resolveApplyHarnesses`'s fallback-chain
  // result (the target's recorded harnesses, else the operator manifest's
  // defaults, else detection, else `["claude"]`), which is never empty.
  // Before round 1's fix, the sticky branch read that value as its own
  // `detected` and pre-checked whatever `resolveApplyHarnesses` returned
  // regardless of `fallbackToClaude: false`, so a bare Enter re-widened a
  // deliberate `--harness none` install. Round 1 fixed that by pre-checking
  // real on-disk detection (`detectHarnesses(targetDir)`) instead, but that
  // re-opened the same gap for any target with a stray harness config on
  // disk (e.g. a `.claude/` directory) that was never a recorded install:
  // it is a weak signal next to the target's own recorded `harnesses: []`.
  // Round 2's decided behaviour (D-007) is that `apply`'s sticky prompt
  // pre-checks nothing at all -- `apply` always passes `stickyPreChecked:
  // []`, regardless of what `resolveApplyHarnesses` or on-disk detection
  // report -- so these tests pass a non-empty `detected` (simulating the
  // fallback-chain result) alongside `stickyPreChecked: []` to prove
  // neither drives the pre-check.
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

  it("nothing is pre-checked even when resolveInitInputs's own detected param is non-empty (the simulated fallback-chain result)", async () => {
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    mockPrompts([]);

    const result = await resolveInitInputs({
      // Simulates resolveApplyHarnesses falling back to the operator
      // manifest's default harnesses (never empty) or reporting a harness
      // actually detected on disk. Either way, this must NOT drive the
      // sticky branch's pre-check: apply's own `stickyPreChecked: []`
      // wins. `stickyAnnotateDetected` is deliberately omitted here too,
      // so it defaults to `stickyPreChecked ?? detected` (`[]`): the
      // checkbox's " (detected)" label is empty in this test, not driven
      // by this non-empty `detected` param either (see the dedicated
      // `stickyAnnotateDetected` describe block below for the label's own
      // coverage).
      detected: ["claude"],
      stickyPreChecked: [],
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
    // Bare Enter (operator deselected/confirmed nothing) keeps the target
    // templates-only, not re-widened to the fallback-chain's "claude".
    expect(result.harnesses).toEqual([]);
  });

  it("selecting claude in the prompt installs it, not stuck at []", async () => {
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    mockPrompts(["claude"]);

    const result = await resolveInitInputs({
      detected: ["claude"],
      stickyPreChecked: [],
      interactive: true,
      previous,
      opts: {},
      previousIsRecordedManifest: true,
    });

    expect(result.harnesses).toEqual(["claude"]);
  });

  it("a normal target (harnessesRecordedEmpty: false) is unaffected: the non-sticky branch still pre-checks detected as before, ignoring stickyPreChecked", async () => {
    const previous = fakeManifest({
      harnesses: ["claude"],
      harnessesRecordedEmpty: false,
    });
    mockPrompts([]);

    await resolveInitInputs({
      // Simulates resolveApplyHarnesses resolving to the target's own
      // recorded harnesses; stickyPreChecked deliberately disagrees, to
      // prove the non-sticky "else" branch never reads it.
      detected: ["claude"],
      stickyPreChecked: [],
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
    // "claude" is pre-checked (from detected/previous.harnesses, unchanged
    // apply behaviour); the non-sticky branch never reads
    // `stickyPreChecked` at all.
    for (const choice of choices) {
      expect(choice.checked).toBe(choice.value === "claude");
    }
  });
});

describe("resolveInitInputs: apply's sticky prompt still shows ' (detected)' via stickyAnnotateDetected, independent of the pre-check (agent-tasks fe834823, round 3)", () => {
  // Round 2 (D-007) made `apply`'s sticky prompt pre-check nothing, but
  // that also silently dropped the " (detected)" label an operator relied
  // on to see that a harness config already exists on disk. `apply`'s CLI
  // action now passes a separate `stickyAnnotateDetected` (a fresh
  // `detectHarnesses(targetDir)` call) purely to drive that label, leaving
  // `stickyPreChecked: []` untouched.
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

  it("labels the on-disk harness ' (detected)' while leaving every choice unchecked", async () => {
    const previous = fakeManifest({
      harnesses: [],
      harnessesRecordedEmpty: true,
    });
    mockPrompts([]);

    await resolveInitInputs({
      detected: ["codex"],
      stickyPreChecked: [],
      stickyAnnotateDetected: ["claude"],
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
        choices: Array<{ value: string; name: string; checked: boolean }>;
      }>
    )[0].choices;
    // Nothing is pre-checked, regardless of the label.
    for (const choice of choices) {
      expect(choice.checked).toBe(false);
    }
    // "claude" carries the " (detected)" suffix even though it is not the
    // `stickyPreChecked` value and not the `detected` param either.
    const claudeChoice = choices.find((c) => c.value === "claude");
    expect(claudeChoice?.name).toBe("claude (detected)");
    const codexChoice = choices.find((c) => c.value === "codex");
    expect(codexChoice?.name).toBe("codex");
  });
});

// `resolveInitInputs: interactive re-run after a templates-only install
// (F4, reversed by D-002)` above now pins `init`'s own sticky-branch
// pre-check to the same "pre-check nothing, still annotate detection"
// semantics as apply's round-2/round-3 fixes, rather than the on-disk
// detection F4 originally pinned: both call sites share one resolution
// inside `resolveInitInputs` now (`stickyPreChecked ?? []`,
// `stickyAnnotateDetected ?? detected`).
