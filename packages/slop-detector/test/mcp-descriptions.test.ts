/**
 * Parity tests for the MCP `slop_check` tool descriptions
 * (src/mcp-descriptions.ts) against the pack registry and the pack
 * defaults. The strings live in their own importable module so this file
 * can pin them without touching the MCP transport or mocking registerTool:
 * every registered pack must be named in the tool description, and the
 * `packs` argument must list exactly the off-by-default packs, derived
 * from the same source the engine resolves defaults from.
 */

import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import {
  OFF_BY_DEFAULT_PACK_LIST,
  SLOP_CHECK_PACKS_DESCRIPTION,
  SLOP_CHECK_TOOL_DESCRIPTION,
} from "../src/mcp-descriptions.js";
import { allPacks } from "../src/packs/registry.js";

describe("slop_check tool description vs the pack registry", () => {
  it("names every registered pack id in the tool description", () => {
    for (const pack of allPacks) {
      expect(SLOP_CHECK_TOOL_DESCRIPTION).toContain(pack.id);
    }
  });

  it("names ui-slop and review-slop in the tool description (the two that once drifted out)", () => {
    expect(SLOP_CHECK_TOOL_DESCRIPTION).toContain("ui-slop");
    expect(SLOP_CHECK_TOOL_DESCRIPTION).toContain("review-slop");
  });

  it("lists exactly the packs whose default is off in the packs argument description", () => {
    // Ground truth: `defaultConfig()` (a spread of DEFAULT_PACKS), NOT the
    // module's own derivation, so flipping the derivation's filter (or
    // replacing the generated list with a stale literal) fails here even
    // though the derivation stays self-consistent.
    const offByDefault = new Set(
      Object.entries(defaultConfig().packs)
        .filter(([, enabled]) => !enabled)
        .map(([id]) => id),
    );
    expect(new Set(OFF_BY_DEFAULT_PACK_LIST.split(", "))).toEqual(offByDefault);
    expect(SLOP_CHECK_PACKS_DESCRIPTION).toContain(
      `(${OFF_BY_DEFAULT_PACK_LIST})`,
    );
  });

  it("keeps the registry ids and the pack-default keys the same set", () => {
    expect(new Set(allPacks.map((p) => p.id))).toEqual(
      new Set(Object.keys(defaultConfig().packs)),
    );
  });
});
