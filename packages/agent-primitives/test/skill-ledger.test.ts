import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSkillLedger, sha256Hex } from "../src/init/ledger.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("skill digest ledger", () => {
  it("carries the digest of the asset actually in the tree (append on release)", () => {
    const assetPath = path.join(packageRoot, "assets", "skill", "SKILL.md");
    const current = fs.readFileSync(assetPath, "utf8");
    const currentDigest = sha256Hex(current);
    const ledger = readSkillLedger();
    const match = ledger.find((entry) => entry.sha256 === currentDigest);
    expect(
      match,
      "assets/skill-ledger.json has no entry for the current " +
        "assets/skill/SKILL.md digest; a release that changes that file " +
        "must append { version, sha256 } for the new tag (see " +
        "src/init/ledger.ts's readSkillLedger docblock) before publishing",
    ).toBeDefined();
  });

  it("every entry names a unique version with a 64-char lowercase-hex sha-256", () => {
    const ledger = readSkillLedger();
    expect(ledger.length).toBeGreaterThan(0);
    const versions = new Set<string>();
    for (const entry of ledger) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(versions.has(entry.version)).toBe(false);
      versions.add(entry.version);
    }
  });
});
