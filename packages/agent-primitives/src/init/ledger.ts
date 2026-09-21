import fs from "node:fs";
import crypto from "node:crypto";

/** One released version of the packaged skill asset
 * (`assets/skill/SKILL.md`), named by the `agent-primitives/v<version>`
 * tag that shipped it, alongside the SHA-256 content digest of the file at
 * that tag. */
export interface SkillLedgerEntry {
  version: string;
  sha256: string;
}

interface SkillLedgerFile {
  asset: string;
  digests: SkillLedgerEntry[];
}

/**
 * SHA-256 hex digest of `content`, read as UTF-8 text (the same encoding
 * `init` itself reads and writes the skill file with), so a digest
 * computed here always matches one computed by `shasum -a 256` against
 * the same file's bytes for a UTF-8-clean text file.
 */
export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Reads the checked-in ledger of every `assets/skill/SKILL.md` digest this
 * package has released (`assets/skill-ledger.json`). Resolved relative to
 * this module's own compiled location the same way `readPackagedSkill`
 * (`../index.ts`) resolves the asset itself
 * (`dist/init/ledger.js` -> `../../assets/skill-ledger.json`, two levels
 * up to the package root), so the same relative path resolves correctly
 * whether this file is running from `dist/` or, via `tsx`, from `src/`
 * directly.
 *
 * Maintaining the ledger: whenever a release changes
 * `assets/skill/SKILL.md`, the release step appends one
 * `{ version, sha256 }` entry for the new tag to this file before
 * publishing, computed with `git show
 * agent-primitives/v<x>:packages/agent-primitives/assets/skill/SKILL.md |
 * shasum -a 256`. The ledger-completeness test
 * (`test/skill-ledger.test.ts`) fails the moment the digest of the asset
 * actually in the tree is missing from this file, so a release that
 * changes the asset without appending is caught before it ships.
 */
export function readSkillLedger(): SkillLedgerEntry[] {
  const url = new URL("../../assets/skill-ledger.json", import.meta.url);
  const raw = fs.readFileSync(url, "utf8");
  const parsed = JSON.parse(raw) as SkillLedgerFile;
  return parsed.digests;
}

/**
 * Looks up `existing`'s content digest in `ledger`. Called only for a
 * target whose bytes already differ from the content that would be
 * installed, so a match here always names a version other than the one
 * about to be installed: an existing target byte-identical to the
 * current asset is `unchanged` and never reaches this lookup at all.
 * `undefined` means the digest matches no known release: the target
 * holds either a local edit or content from before the ledger's own
 * coverage began, and is never treated as safe to upgrade automatically.
 */
export function findLedgerMatch(
  existing: string,
  ledger: readonly SkillLedgerEntry[],
): SkillLedgerEntry | undefined {
  const digest = sha256Hex(existing);
  return ledger.find((entry) => entry.sha256 === digest);
}
