import { describe, expect, it } from "vitest";

import { buildInitInitInputs } from "../src/cli-init.js";
import type { Manifest } from "../src/init.js";
import { DEFAULT_MODELS, DEFAULT_PROFILE } from "../src/models.js";

/**
 * Unit coverage for `buildInitInitInputs`, extracted from `init`'s CLI
 * action so a future edit to the call site cannot silently reintroduce a
 * `stickyPreChecked` (or `stickyAnnotateDetected`) override without a
 * targeted test catching it, mirroring `test/cli-apply.test.ts`'s coverage
 * of `buildApplyInitInputs` (agent-tasks 7669907c, fix round 2, review
 * finding 1).
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

describe("buildInitInitInputs", () => {
  it("never overrides stickyPreChecked or stickyAnnotateDetected, so resolveInitInputs's own defaults apply", () => {
    const previous = fakePrevious();
    const result = buildInitInitInputs(["claude", "codex"], previous, true, {});

    expect("stickyPreChecked" in result).toBe(false);
    expect("stickyAnnotateDetected" in result).toBe(false);
  });

  it("passes detected, interactive, previous, and opts through unchanged, and pins previousIsRecordedManifest to true", () => {
    const previous = fakePrevious({ profile: "minimal" });
    const opts = { harness: "codex" };
    const result = buildInitInitInputs(["claude"], previous, false, opts);

    expect(result.detected).toEqual(["claude"]);
    expect(result.interactive).toBe(false);
    expect(result.previous).toBe(previous);
    expect(result.opts).toBe(opts);
    expect(result.previousIsRecordedManifest).toBe(true);
  });

  it("passes previous through as undefined for a target with no prior install", () => {
    const result = buildInitInitInputs([], undefined, true, {});

    expect(result.previous).toBeUndefined();
    expect(result.previousIsRecordedManifest).toBe(true);
  });
});
