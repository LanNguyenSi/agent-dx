import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSkillLedger, sha256Hex } from "../src/init/ledger.js";
import { compareSemver } from "./helpers/ledger-tag.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("skill digest ledger", () => {
  it("carries the digest of the asset actually in the tree as the LAST entry (append-or-replace on release)", () => {
    const assetPath = path.join(packageRoot, "assets", "skill", "SKILL.md");
    const current = fs.readFileSync(assetPath, "utf8");
    const currentDigest = sha256Hex(current);
    const ledger = readSkillLedger();
    expect(ledger.length).toBeGreaterThan(0);
    const last = ledger[ledger.length - 1];
    expect(
      last?.sha256,
      "assets/skill-ledger.json's LAST entry does not carry the current " +
        "assets/skill/SKILL.md digest; the same change that edits that " +
        "file must append (or, for an unreleased pending entry, replace) " +
        "the last entry with { version, sha256 } for the version being " +
        "prepared (see src/init/ledger.ts's readSkillLedger docblock) " +
        "before publishing",
    ).toBe(currentDigest);
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

  it("versions are strictly ascending by semver, and adjacent entries' digests differ", () => {
    const ledger = readSkillLedger();
    for (let i = 1; i < ledger.length; i++) {
      const prev = ledger[i - 1]!;
      const curr = ledger[i]!;
      expect(
        compareSemver(curr.version, prev.version),
        `ledger entry ${curr.version} does not sort strictly after ` +
          `${prev.version}`,
      ).toBeGreaterThan(0);
      expect(
        curr.sha256,
        `ledger entries ${prev.version} and ${curr.version} carry the ` +
          "same digest; an append with an unchanged asset is a mistake " +
          "(replace the pending entry instead, see readSkillLedger's " +
          "docblock)",
      ).not.toBe(prev.sha256);
    }
  });
});
