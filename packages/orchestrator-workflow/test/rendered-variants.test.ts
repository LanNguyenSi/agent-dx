import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@iarna/toml";
import { afterEach, describe, expect, it } from "vitest";

import { readAgentAsset } from "../src/assets.js";
import { runInit } from "../src/init.js";
import {
  DEFAULT_MODELS,
  DEFAULT_TIER,
  ROLES,
  ROLE_TIERS,
} from "../src/models.js";

/**
 * Generation parity: every rendered variant of a role prompt (every harness,
 * every effort tier) carries the installed asset's prompt body verbatim. The
 * sentences inside a prompt are not pinned here; a single canonical body per
 * role is, so an edit to a prompt reaches all variants without a per-variant
 * assertion.
 */
describe("rendered role prompts carry the asset body in every harness and tier", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["claude", ".claude", ".md"],
    ["opencode", ".opencode", ".md"],
    ["codex", ".codex", ".toml"],
  ] as const)(
    "%s: every role and tier file contains the body of its asset",
    (harness, dir, extension) => {
      const target = mkdtempSync(join(tmpdir(), "ow-rendered-variants-"));
      dirs.push(target);
      runInit({
        targetDir: target,
        harnesses: [harness],
        models: { ...DEFAULT_MODELS },
        profile: "full",
        tiers: true,
        // opencode writes a tier variant only for a resolved class model, so
        // the opencode case resolves all three classes; without them no
        // variant file exists and the composer would go unexercised.
        opencodeClassModels: {
          small: "anthropic/claude-haiku-4-5",
          medium: "anthropic/claude-sonnet-4-6",
          large: "anthropic/claude-opus-4-8",
        },
      });
      const agentsDir = join(target, dir, "agents");
      const files = readdirSync(agentsDir);
      let checked = 0;
      let expectedCount = 0;
      for (const role of ROLES) {
        const body = readAgentAsset(role).body.trimEnd();
        const expected = [
          `${role}${extension}`,
          ...ROLE_TIERS[role]
            .filter((tier) => tier !== DEFAULT_TIER[role])
            .map((tier) => `${role}-${tier}${extension}`),
        ].sort();
        expectedCount += expected.length;
        const variants = files
          .filter(
            (file) =>
              file === `${role}${extension}` ||
              ROLE_TIERS[role].some(
                (tier) => file === `${role}-${tier}${extension}`,
              ),
          )
          .sort();
        // One default file plus one file per non-default tier of the role.
        expect(variants, `${harness}: ${role} variants`).toEqual(expected);
        expect(variants.length).toBe(
          1 +
            ROLE_TIERS[role].filter((tier) => tier !== DEFAULT_TIER[role])
              .length,
        );
        for (const file of variants) {
          const text = readFileSync(join(agentsDir, file), "utf8");
          const rendered =
            extension === ".toml"
              ? String(parse(text).developer_instructions)
              : text;
          expect(rendered, `${harness}/${file}`).toContain(body);
          checked += 1;
        }
      }
      expect(checked).toBe(expectedCount);
      expect(checked).toBeGreaterThan(ROLES.length);
    },
  );
});
