import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplyInitInputs } from "../src/cli-apply.js";
import type { Manifest } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_PROFILE } from "../src/models.js";

/**
 * Unit coverage for `buildApplyInitInputs`, extracted from `apply`'s CLI
 * action so the sticky-branch wiring it produces
 * (`stickyPreChecked: []`, never `chosenHarnesses`) is pinned by a direct,
 * targeted test rather than only indirectly through the much larger
 * `resolveInitInputs`/interactive-prompt suite (agent-tasks fe834823, fix
 * round 3, review finding 1).
 */

function fakePrevious(overrides: Partial<Manifest> = {}): Manifest {
  return {
    kit: "orchestrator-workflow",
    version: "0.26.0",
    harnesses: [],
    harnessesRecordedEmpty: true,
    models: { ...DEFAULT_MODELS },
    profile: DEFAULT_PROFILE,
    tiers: false,
    files: {},
    installedAt: "",
    ...overrides,
  };
}

let targetDir: string;

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), "cli-apply-build-"));
});

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

describe("buildApplyInitInputs", () => {
  it("always pins stickyPreChecked to [], never chosenHarnesses or detected", () => {
    const previous = fakePrevious();
    const result = buildApplyInitInputs(
      targetDir,
      ["claude", "codex"],
      previous,
      true,
      {},
      true,
    );

    expect(result.stickyPreChecked).toEqual([]);
    // `detected` still carries the fallback-chain result through, used by
    // the normal (non-sticky) branch and printed as-is; only the sticky
    // branch's own pre-check must ignore it.
    expect(result.detected).toEqual(["claude", "codex"]);
  });

  it("passes interactive, previous, opts, and previousIsRecordedManifest through unchanged", () => {
    const previous = fakePrevious({ profile: "minimal" });
    const opts = { harness: "codex" };
    const result = buildApplyInitInputs(
      targetDir,
      ["claude"],
      previous,
      false,
      opts,
      false,
    );

    expect(result.interactive).toBe(false);
    expect(result.previous).toBe(previous);
    expect(result.opts).toBe(opts);
    expect(result.previousIsRecordedManifest).toBe(false);
  });

  it("stickyAnnotateDetected reflects real on-disk detection, independent of chosenHarnesses", () => {
    mkdirSync(join(targetDir, ".claude"));
    const previous = fakePrevious();
    const result = buildApplyInitInputs(
      targetDir,
      // Deliberately disagrees with what is on disk, to prove
      // `stickyAnnotateDetected` is not derived from `chosenHarnesses`.
      ["codex"],
      previous,
      true,
      {},
      true,
    );

    expect(result.stickyAnnotateDetected).toEqual(["claude"]);
  });

  it("stickyAnnotateDetected is empty on a target with no harness files on disk", () => {
    const previous = fakePrevious();
    const result = buildApplyInitInputs(
      targetDir,
      ["claude"],
      previous,
      true,
      {},
      true,
    );

    expect(result.stickyAnnotateDetected).toEqual([]);
  });
});

describe("apply's CLI action hands buildApplyInitInputs's result straight to resolveInitInputs", () => {
  // See `buildApplyInitInputs`'s doc comment for the sticky-branch invariant.
  const cliSource = readFileSync(
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "utf8",
  );

  it("calls resolveInitInputs with the bare builder result, no spread and no adjacent sticky override", () => {
    const direct =
      /resolveInitInputs\(\s*(?:\/\/[^\n]*\n\s*)*buildApplyInitInputs\(\s*targetDir,\s*chosenHarnesses,\s*previous,\s*interactive,\s*opts,\s*Boolean\(repoManifest\),?\s*\),?\s*\)/;
    expect(direct.test(cliSource)).toBe(true);
    expect(cliSource).not.toMatch(/\.\.\.buildApplyInitInputs\(/);
    expect(cliSource).not.toMatch(
      /buildApplyInitInputs\([\s\S]*?\)\s*,\s*sticky/,
    );
    expect(cliSource).not.toMatch(/\{\s*\.\.\.\s*buildApplyInitInputs/);
  });
});
