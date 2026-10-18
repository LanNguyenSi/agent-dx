import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@iarna/toml";
import { afterEach, describe, expect, it } from "vitest";

import { readAgentAsset } from "../src/assets.js";
import { runInit } from "../src/init.js";
import { DEFAULT_MODELS, ROLES, ROLE_TIERS } from "../src/models.js";

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
      });
      const agentsDir = join(target, dir, "agents");
      const files = readdirSync(agentsDir);
      let checked = 0;
      for (const role of ROLES) {
        const body = readAgentAsset(role).body.trimEnd();
        const variants = files.filter(
          (file) =>
            file === `${role}${extension}` ||
            ROLE_TIERS[role].some(
              (tier) => file === `${role}-${tier}${extension}`,
            ),
        );
        expect(variants.length, `${harness}: ${role} variants`).toBeGreaterThan(
          0,
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
      expect(checked).toBeGreaterThanOrEqual(ROLES.length);
    },
  );
});
